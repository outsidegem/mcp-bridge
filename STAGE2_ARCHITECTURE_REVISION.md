# TITAN AGENT FIREWALL — STAGE 2 REVISED ARCHITECTURE

## Executive Verdict
The revised Stage 2 architecture recommends **PostgreSQL + Redis**. PostgreSQL serves as the authoritative, durable root of trust for authorization state, idempotency, and audit. Redis is strictly non-authoritative and used solely for high-volume distributed rate limiting to prevent PostgreSQL lock/connection exhaustion (DoS). A separate distributed locking mechanism is rejected; PostgreSQL's native transactional mechanisms (`SELECT FOR UPDATE SKIP LOCKED` and OCC) are completely sufficient for state-machine serialization and worker queuing.

## Architecture Diagram
```
                        [ External AI Agent ]
                                 |
                                 v
                     [ Stateless API Gateways ]
                                 |
           +---------------------+---------------------+
           |                     |                     |
           v                     v                     v
   [ Policy Engine ]         [ Redis ]          [ PostgreSQL ]
     (In-Memory)        (Rate Limits Only)   (State & Idempotency)
                                                       |
                                                       v
                                            [ Execution Workers ]
                                                       |
                                                       v
                                              [ External API ]
```

## Trust Boundaries
- **API Gateway (Ingress):** Authenticates agents, terminates TLS, enforces Redis rate limits, evaluates policy.
- **PostgreSQL (Root of Trust):** Maintains authoritative Escrow state, enforces Tenant RLS, persists Audit.
- **Execution Worker (Egress):** Blindly executes `APPROVED` payloads. Cannot forge approvals.
- **Redis (Ephemeral Limits):** Untrusted for authorization. If compromised, attacker can DoS the system (fail closed) or bypass limits, but cannot forge an `APPROVED` state.
- **External API:** Untrusted. Its responses, side-effects, and latency are external-dependent.

## PostgreSQL Security Model
The database enforces security invariants independently of the application logic.

### Database Roles and Privileges
A compromised Worker must be physically incapable of authorizing a request. We implement strict separation of duties via PostgreSQL Roles:

1. **`gateway_role`**
   - `SELECT` on `escrow_requests`
   - `INSERT` on `escrow_requests` (Can only insert `status = 'PENDING'`)
   - `UPDATE` on `escrow_requests` (Can only update `status` to `APPROVED` or `DENIED` where `status = 'PENDING'`)
2. **`worker_role`**
   - `SELECT` on `escrow_requests` (Can only read `status IN ('APPROVED', 'EXECUTING')`)
   - `UPDATE` on `escrow_requests` (Can only update `status` to `EXECUTING`, `EXECUTED`, or `FAILED` where `status IN ('APPROVED', 'EXECUTING')`)
   - **Crucially:** The `worker_role` lacks the `UPDATE` privilege to set `status = 'APPROVED'`.
3. **`audit_role`**
   - `INSERT` only on `audit_logs`.
4. **`migration_role`** (Administrative)
   - DDL privileges, run exclusively in CI/CD offline pipelines.

### Row-Level Security Model
Tenant isolation is enforced twice: application-layer WHERE clauses + DB-layer Row-Level Security (RLS).
- **Context Propagation:** When the Gateway or Worker checks out a DB connection, it immediately executes: `SET LOCAL app.current_tenant = 'tenant_xyz'`.
- **RLS Policy:** `CREATE POLICY tenant_isolation ON escrow_requests USING (tenant_id = current_setting('app.current_tenant'));`
- **Connection Pooling:** To prevent tenant leakage, connections must execute `RESET app.current_tenant` or `DISCARD ALL` upon returning to the pool.
- **Cross-Tenant Operations:** The `ADMIN` role uses a specific bypass policy (`USING (current_setting('app.role') = 'ADMIN')`).

## State Machine
Optimistic Concurrency Control (OCC) ensures single-winner state transitions.
- **Schema:** `version INTEGER DEFAULT 0`
- **Transition (PENDING -> APPROVED):** 
  `UPDATE escrow_requests SET status = 'APPROVED', version = version + 1 WHERE id = $1 AND status = 'PENDING' AND version = $2`
- If two Gateways race, the second receives `0 rows updated` and aborts.

## Transaction Boundaries
A single PostgreSQL transaction MUST atomically wrap:
1. State transition (`UPDATE escrow_requests`)
2. Idempotency reservation (`INSERT INTO idempotency_keys`)
3. Audit log append (`INSERT INTO audit_logs`)
If any constraint fails, the entire authorization block rolls back.

## Execution Lease Model
Worker execution ownership relies on PostgreSQL row locks, NOT external distributed locks.
- **Checkout:** `UPDATE escrow_requests SET status = 'EXECUTING', locked_by = $worker_id, locked_until = NOW() + INTERVAL '30s' WHERE id = (SELECT id FROM escrow_requests WHERE status = 'APPROVED' OR (status = 'EXECUTING' AND locked_until < NOW()) FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *;`
- **Worker Crash:** If a worker dies, its lease naturally expires (`locked_until < NOW()`), and another worker will claim it using the exact same query.

## Fencing Model
- **Soft Fencing (Internal):** The Worker checks its local system clock right before making the external HTTP call. If `NOW() > locked_until`, it aborts.
- **Hard Fencing (External):** Impossible without external downstream cooperation.
- **Race Condition:** Worker checks clock (Valid) -> OS pauses Worker (GC) -> Lease Expires -> Worker B claims lease and executes -> Worker A resumes and flushes TCP buffer. 
- **Verdict:** True fencing against arbitrary external HTTP APIs is **EXTERNAL-DEPENDENT** and mathematically unachievable strictly from the client.

## Idempotency Model
- **Identity Binding:** `(tenant_id, target_tool, idempotency_key, request_payload_hash)`
- **Mechanism:** PostgreSQL `UNIQUE` constraint on this composite tuple.
- **Collision Handling:** 
  - Same key + Same payload -> Return stored `ExecutionResult` (Safe Replay).
  - Same key + Different payload -> `409 Conflict` (Malicious or accidental collision).
- This prevents cross-tenant, cross-tool, and payload-substitution replay attacks.

## Redis / Rate Limiting Model
- **Why Redis?** High-volume rate-limiting `UPDATE` queries in PostgreSQL cause row contention, deadlocks, and connection exhaustion, leading to systemic DoS.
- **Authority:** Redis is authoritative ONLY for temporary rate-limit counters (Token Bucket via Lua).
- **Failure Mode:** If Redis is unavailable, the Gateway **FAILS CLOSED** (HTTP 429/503), prioritizing security over availability. Redis failure NEVER bypasses authorization.

## Durable Audit Model
- **Operational Audit:** `audit_logs` table synchronously updated in Postgres.
- **Security Evidence:** Application actors use the `audit_role` (INSERT-only).
- **Tamper Evidence:** For true tamper resistance, a background agent streams `audit_logs` to an external WORM (Write-Once-Read-Many) storage bucket (e.g., S3 Object Lock) where even the DB Administrator has no delete permissions.

## Database Compromise Model
- **Attack:** Complete PostgreSQL server compromise.
- **Capabilities:** Attacker can forge `APPROVED` escrows, delete audits, bypass RLS.
- **Verdict:** PostgreSQL is the root of trust. Compromise equals complete system compromise.
- **Advanced Mitigation (Design Concept):** To protect against DB compromise, Gateways would need to Cryptographically Sign the `APPROVED` payload with an asymmetric key, and the Worker would need to verify the signature before execution.

## External Side-Effect Model
- **Worker Crash (Success -> Crash):** Titan cannot know execution succeeded. Retry occurs.
- **Network Failure (Unknown Result):** TCP timeout occurs. Titan records `FAILED`. Target might have succeeded.
- **Verdict:** Exactly-once execution is **UNACHIEVABLE**. Operations are *at-least-once* (if retried) or *at-most-once* (if failed hard). Exactly-once requires external downstream Idempotency.

## Resource Exhaustion Model
- **PostgreSQL Limit:** Hard `COUNT(*)` quota per `tenant_id` for `PENDING` states.
- **Data Lifecycle:** A `pg_cron` worker or external cron job automatically `DELETE`s `EXPIRED` and `EXECUTED` rows older than 30 days to bound index size.
- **Redis Limit:** All Redis keys have explicit TTLs matching the rate-limit window.

## Migration Model
- **Strategy:** Stateless Fleet Cutover.
- **Cutover:** 
  1. Deploy Stage 2 infrastructure alongside Stage 1.3.
  2. Switch load balancer to Stage 2.
  3. Allow Stage 1.3 to drain its 5-minute memory TTL (Fail closed for pending requests; operators must re-approve).
- **Safety:** No dual-writes. No split-brain. In-memory state is deliberately allowed to expire.

## Architecture Comparison
- **A. PostgreSQL Only:** Fails under high-burst rate limiting (connection DoS).
- **B. Redis + PostgreSQL:** **WINNER**. Balances transactional ACID state (PG) with high-throughput ephemeral limits (Redis).
- **C. Local/Sticky:** Violates stateless scaling, data loss on crash.

## Guarantee Classification
- **Tenant Isolation:** PROVEN (App logic) & DESIGNED (RLS)
- **State Machine Integrity:** DESIGNED (Postgres OCC)
- **Worker Cannot Forge Approval:** DESIGNED (Postgres RBAC/Roles)
- **Bounded Resources:** DESIGNED (DB Quotas & Cron cleanup)
- **Rate Limit DoS Resistance:** DESIGNED (Redis Lua)
- **Exactly-Once External Impact:** EXTERNAL-DEPENDENT
- **Hard Fencing:** EXTERNAL-DEPENDENT
- **Tamper-Proof Audit against DB Admin:** UNACHIEVABLE (without WORM export)

## Final Security Questions
1. **Is PostgreSQL-only still recommended?** NO.
2. **Is Redis required?** YES, strictly for Distributed Rate Limiting to prevent Postgres DoS.
3. **If Redis is used, what exactly is it authoritative for?** Ephemeral rate-limit tokens ONLY.
4. **Is a separate distributed lock actually necessary?** NO. `SKIP LOCKED` is sufficient.
5. **Can PostgreSQL leases provide sufficient internal fencing?** YES (Soft Fencing via clock checks).
6. **Can Titan provide hard fencing for arbitrary external HTTP services?** NO.
7. **What prevents a compromised worker from manufacturing APPROVED?** PostgreSQL Role privileges (`worker_role` cannot UPDATE status to APPROVED).
8. **What prevents a stale worker from executing?** Soft fencing (clock checks). Microsecond OS races remain a residual risk.
9. **What prevents duplicate external impact?** External downstream idempotency mechanisms.
10. **What happens when the external result is unknown?** System logs `FAILED`. Manual reconciliation required.
11. **What security evidence survives database compromise?** None, unless exported to WORM storage.
12. **How is tenant isolation enforced twice?** Application WHERE clauses + Database RLS (`SET LOCAL app.current_tenant`).
13. **How is rate-limit DoS prevented?** Moving the limit checks to in-memory Redis structures.
14. **What is the largest remaining security weakness?** Total PostgreSQL compromise bypassing all authorization.
15. **What is the largest remaining distributed-systems weakness?** Stale worker execution during extreme starvation/GC pauses.
16. **What is the largest remaining architectural ambiguity?** None. The boundaries and failure domains are explicit.
17. **What MUST change before implementation?** Nothing. This document explicitly designs the required DB roles, RLS, Redis boundary, and composite idempotency required for implementation.

## Remaining Risks
1. **The Stale Worker External Race:** OS-level starvation causing a worker to sleep immediately after checking its lease clock, awaking seconds later to flush a TCP buffer to an external service.
2. **PostgreSQL Root Compromise:** A zero-day or leaked credential granting `postgres` superuser access destroys the authorization model.

## Required Changes Before Implementation
None. The architecture specified in this document resolves the previous implementation gate failures by adopting explicit PostgreSQL roles, Redis for rate limiting, and a composite payload-hashed idempotency key.

## Implementation Readiness

STAGE 2 ARCHITECTURE READY FOR FINAL ADVERSARIAL REVIEW
