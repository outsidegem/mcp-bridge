# STAGE 2 PRE-IMPLEMENTATION SECURITY REVIEW

## 1. CHALLENGE THE ARCHITECTURE
The initial recommendation of a "PostgreSQL-Only" architecture is conceptually sound for state transitions and durable audit but **flawed for distributed rate limiting**. 
Under high-concurrency adversarial load, PostgreSQL-backed rate limiting causes severe row-level lock contention ("hot rows"). This transaction pile-up exhausts connection pools, creating a denial-of-service bottleneck that cascades, taking down the authorization and execution state machine.
**Falsification Verdict:** PostgreSQL-only is NOT the smallest defensible architecture if high-volume rate limiting is required. 
**Revised Recommendation:** PostgreSQL + Redis. PostgreSQL for strict ACID state machine and durable audit; Redis for ephemeral distributed rate limiting and lightweight burst protection.

## 2. DATABASE AS ROOT OF TRUST
**Attack:** A compromised execution worker connects to the database and manually executes `UPDATE escrow SET status = 'APPROVED'`.
**Is this possible under the proposed architecture?** YES, if the Gateway and Worker share the same database credentials (a common default).
**Defense Mechanism:** Strict Database Role Separation.
- `gateway_role`: `INSERT` to escrow (PENDING), `UPDATE` to APPROVED/DENIED. Cannot read external credentials.
- `worker_role`: `SELECT` APPROVED, `UPDATE` to EXECUTING/EXECUTED/FAILED. **Cannot** `UPDATE` status to APPROVED.
- `audit_role`: `INSERT` only (Append-only) to `audit_logs`.
**Can an application worker directly manufacture an APPROVED Escrow state?** NO, provided PostgreSQL RBAC (Role-Based Access Control) or Row-Level Security (RLS) is strictly implemented to enforce these boundaries.

## 3. STATE TRANSITION SECURITY
Conceptual Transaction Behavior:
- **PENDING → APPROVED:** 
  - Authorized Actor: Operator (via Gateway).
  - Transaction: `UPDATE escrow SET status='APPROVED', version=version+1 WHERE id=$1 AND status='PENDING' AND version=$2 AND tenant_id=$3`.
  - Concurrency: Optimistic Concurrency Control (OCC).
- **APPROVED → EXECUTING:** 
  - Authorized Actor: Worker.
  - Transaction: `UPDATE escrow SET status='EXECUTING', locked_by=$worker_id, locked_until=NOW() + INTERVAL '30s' WHERE id = (SELECT id FROM escrow WHERE status='APPROVED' FOR UPDATE SKIP LOCKED LIMIT 1)`.
  - Concurrency: Pessimistic Row Lock.
- **EXECUTING → EXECUTED / FAILED:**
  - Authorized Actor: Worker (must match `locked_by`).
  - Transaction: `UPDATE escrow SET status=$new WHERE id=$1 AND locked_by=$worker_id`.

**Attack:** Gateway A approves, Gateway B approves, Gateway C denies, Worker D executes, Worker E executes.
**Result:** 
1. Gateway A's transaction commits first (`PENDING` -> `APPROVED`). 
2. Gateway B's transaction fails (0 rows affected due to OCC version/status mismatch).
3. Gateway C's transaction fails (0 rows affected).
4. Worker D acquires the row via `FOR UPDATE SKIP LOCKED`, setting state to `EXECUTING`.
5. Worker E finds no `APPROVED` rows and sleeps (or grabs a different job).
**Verdict:** Safe.

## 4. LEASE / FENCING FALSIFICATION
**Attack:** Worker A gets lease. Worker A pauses (OS context switch / heavy GC). Lease expires. Worker B gets lease and executes. Worker A resumes and executes.
**Can Worker A still perform an external action?** YES.
**Why:** A client-side clock check ("Soft Fencing") happens *before* the network call. If the worker pauses *after* the clock check (e.g., during DNS resolution or right before flushing the TCP buffer), the OS will eventually send the HTTP payload to the external service regardless of the expired lease.
**Conclusion:** Client-side fencing CANNOT protect an external side-effect from duplicate execution. Fencing is strictly **EXTERNAL-DEPENDENT**. The external API must accept and validate a fencing token (e.g., `If-Match: lease_version`). If the API lacks this, duplicate execution is a mathematically unpreventable residual risk under severe worker starvation.

## 5. EXTERNAL SIDE-EFFECT ANALYSIS
**Attack:** Worker A executes -> SUCCESS -> Worker A crashes before DB commit. Worker B retries.
**Duplicate Impact?** YES, unless the external service supports idempotency keys. 
**Attack:** Worker A executes -> Network timeout (UNKNOWN) -> Connection lost.
**Classification of Knowledge:**
- **Titan-controlled:** The lease, the DB state, the worker process.
- **Database-controlled:** The `FAILED` or `EXECUTING` state.
- **Worker-controlled:** The local timeout trigger.
- **External-service-controlled:** Whether the transaction actually committed on their end.
- **Fundamentally unknowable:** Without an external read-API to reconcile the state, Titan *cannot* know the true outcome.
**Verdict:** Exactly-once execution is unachievable without external idempotency and reconciliation APIs.

## 6. IDEMPOTENCY FALSIFICATION
**Attack:** Tenant A uses key `K`. Tenant B uses key `K`.
**Defense:** Canonical identity binding must be composite.
The idempotency identity MUST be bound to: `(tenant_id, target_tool, idempotency_key)`.
Binding to `agent_id` is insufficient if multiple agents in a tenant collaborate. Binding to `authorization` is insufficient if the external action needs to survive an authorization refresh.
If the unique DB constraint is `UNIQUE(tenant_id, tool_name, idempotency_key)`, cross-tenant and cross-tool collisions are strictly prevented.

## 7. RATE LIMITING FALSIFICATION
**Attack:** 10,000 concurrent requests for the same tenant.
**Analysis:** If backed by PostgreSQL, updating the same `tenant_id` rate-limit row 10,000 times per second creates a severe write lock bottleneck. Transactions queue up, exhausting `max_connections`, taking down the entire Gateway.
**Verdict:** PostgreSQL is fundamentally ill-suited for high-burst distributed rate limiting without complex asynchronous batching.
**Required Change:** Move distributed rate limiting to Redis (using Lua scripts for token bucket) or accept a "fail-open/degraded" localized memory rate-limiting strategy during bursts.

## 8. DATABASE FAILURE
- **Database unavailable:** Gateway cannot authenticate state. -> FAIL CLOSED (503).
- **Database timeout:** State transition unknown. -> FAIL CLOSED.
- **Replica lag:** If Gateway reads from a replica and attempts an approval based on stale `PENDING` state, OCC (`version = X`) on the Primary will reject it. -> SAFE (fails safely).
**Verdict:** The system safely fails closed, preserving the authorization invariant at the cost of availability.

## 9. AUDIT FALSIFICATION
**Attack:** Compromised Gateway rewrites audit history.
**Analysis:** If the Gateway connects with a database user that has `UPDATE` or `DELETE` privileges on the `audit_logs` table, the audit trail is forged.
**Defense:** The database user provisioned for the application MUST be restricted to `GRANT INSERT ON audit_logs`. True tamper-evident security requires exporting these logs to a separate WORM (Write Once Read Many) storage (e.g., AWS S3 Object Lock) asynchronously, as DB admins can always alter tables.

## 10. TENANT ISOLATION FALSIFICATION
**Attack:** Tenant B requests Escrow ID belonging to Tenant A.
**Defense:** The query MUST physically embed the tenant boundary: 
`SELECT * FROM escrow WHERE id = $1 AND tenant_id = $2`.
If tenant identity is merely a query filter, a missing `WHERE` clause in future code causes a breach. 
**Defense:** PostgreSQL Row-Level Security (RLS) can mathematically guarantee isolation by setting the current user context (e.g., `SET LOCAL app.current_tenant = 'tenant_a'`), completely neutralizing application-layer WHERE clause omissions.

## 11. COMPROMISED COMPONENT MODEL
- **Compromised Gateway:** Can forge new `PENDING` requests, can `APPROVE` existing requests (if policy engine is bypassed). CANNOT execute payloads (firewalled from target). Evidence survives in append-only audit.
- **Compromised Worker:** Can `EXECUTE` approved payloads. Can forge `EXECUTED` state. CANNOT forge `APPROVED` state (if DB roles are split).
- **Compromised Database:** Total failure. Attacker can forge all authorization and rewrite all history.

## 12. RESOURCE EXHAUSTION
**Attack:** 10,000,000 unique operations.
**Defense:** 
- A hard quota constraint per tenant limit active `PENDING` rows.
- Table partitioning by `created_at` (e.g., daily partitions).
- A background worker (`pg_cron`) that physically `DELETE`s `EXPIRED` and `EXECUTED` rows older than 30 days.

## 13. MIGRATION FALSIFICATION
**Attack:** Rolling deployment where Node A uses `LocalEscrowAdapter` and Node B uses `DistributedEscrowAdapter`.
**Analysis:** If Tenant A hits Node A, it gets a local `PENDING` record. If the Operator hits Node B to approve, Node B returns `404 Not Found` (record is in Node A's memory).
**Verdict:** Safe (fails closed). However, to prevent broken user experiences, sticky sessions MUST be enforced at the load balancer during the drain period, or a hard cutover (drop all active local escrows) must be used.

## 14. REQUIRED GUARANTEE CLASSIFICATION
- **State Machine Transitions:** DESIGNED
- **Single-Worker Execution:** IMPLEMENTATION-DEPENDENT (Requires strict `SKIP LOCKED` queries).
- **Audit Immutability:** DESIGNED (Requires strict DB Role separation).
- **Duplicate External Execution Protection:** EXTERNAL-DEPENDENT.
- **Exactly-Once Execution:** UNACHIEVABLE (Without external idempotency).

## 15. REQUIRED FINAL QUESTIONS
1. **Is PostgreSQL-only still the recommended architecture?** NO. Redis should be added specifically for rate limiting to prevent DB lock DoS.
2. **Is PostgreSQL actually sufficient for distributed coordination?** YES, for state transitions and leases.
3. **Is a separate distributed lock mechanism necessary?** NO, PostgreSQL `FOR UPDATE SKIP LOCKED` is sufficient.
4. **Can PostgreSQL leases safely provide fencing?** NO, they only provide soft fencing.
5. **Can fencing protect an external HTTP side effect?** NO, not without external API cooperation.
6. **What prevents a compromised worker from manufacturing APPROVED?** Strict separation of PostgreSQL credentials and table privileges (`GRANT UPDATE(status)` limited by role).
7. **What prevents a stale worker from executing?** Client-side clock checks (soft fencing) mitigate long pauses, but do not guarantee safety against microsecond scheduling races.
8. **What prevents duplicate external execution?** External service idempotency keys.
9. **What happens when the external result is unknown?** The system records `FAILED` or `UNKNOWN` and manual reconciliation is required.
10. **What security evidence survives a database compromise?** None, unless logs were asynchronously shipped to an immutable WORM ledger.
11. **What is the largest remaining Stage 2 architectural weakness?** The reliance on external services for true idempotency/fencing, leaving the system vulnerable to duplicate side-effects during hard crashes.
12. **What must be changed before implementation?** 
    - Database roles must be split (Gateway vs. Worker).
    - Rate limiting must be decoupled from PostgreSQL (use Redis or memory).
    - Append-only constraints must be applied to the audit table.

## 16. IMPLEMENTATION GATE
STAGE 2 IMPLEMENTATION GATE: FAIL

**Required Changes Before Implementation:**
1. Explicitly define distinct PostgreSQL roles (`gateway_role`, `worker_role`, `audit_role`) with strict least-privilege `GRANT` statements to prevent a compromised worker from forging approvals.
2. Remove Distributed Rate Limiting from the PostgreSQL critical path. Introduce Redis or accept a degraded memory-based rate limit to prevent connection-exhaustion DoS attacks.
3. Formally adopt `(tenant_id, target_tool, idempotency_key)` as the unique idempotency constraint.
4. Integrate PostgreSQL Row-Level Security (RLS) to enforce Tenant Isolation at the database layer, defending against application-level SQL omissions.
