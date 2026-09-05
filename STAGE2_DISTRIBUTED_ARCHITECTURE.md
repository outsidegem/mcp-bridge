# STAGE 2 DISTRIBUTED ARCHITECTURE

## 1. INSPECT THE FROZEN STAGE 1.3 BASELINE
Based on the frozen Stage 1.3 implementation, the security guarantees are classified as follows:

### PROVEN FROM STAGE 1.3
- **Authorization Integrity:** Execution is impossible without explicit approval.
- **Tenant Isolation:** Cross-tenant reads and approvals are strictly blocked.
- **SSRF Protection:** Network validation blocks internal routing.
- **Error Sanitization:** Raw downstream errors do not leak to HTTP callers.
- **Schema Validation:** Strictly typed JSON schemas block malformed arguments.
- **Immutability:** Internal state objects are mutation-protected via deep cloning.

### DEPENDENT ON SINGLE-PROCESS EXECUTION
- **Escrow State-Machine Integrity:** Relies on synchronous Node.js event-loop memory maps to prevent double-approval race conditions.
- **Bounded Resource Usage:** `MAX_PENDING` (1000) and 5-minute TTL are enforced in process memory maps.
- **Concurrency Safety:** Synchronous memory access ensures only one HTTP request transitions state.
- **Rate Limiting:** Managed in memory per instance.

### NOT PROVEN
- Exactly-once external execution across network ambiguity, process crashes, and retries.
- Durable audit logging (currently ephemeral/stdout).
- System behavior under horizontal scaling (multiple Gateway instances).

---

## 2. DEFINE THE STAGE 2 OBJECTIVE
Design the smallest defensible architecture capable of horizontally scaling the API Gateway, Policy Engine, and Execution Workers while strictly preserving authorization integrity, tenant isolation, concurrency safety, and resource bounds. The system must fail closed during infrastructure degradation and produce a cryptographically sound or durable audit trail.

---

## 3. REDIS EVALUATION
Redis is highly performant but introduces specific distributed systems risks.
- **Atomic Operations/Lua:** Excellent for distributed rate limiting and lightweight fencing.
- **Persistence:** AOF/RDB can lose milliseconds to seconds of data during abrupt crashes, which is unacceptable for strict security audit trails.
- **Failover/Split-Brain:** Redis Sentinel or Cluster can experience split-brain conditions where two master nodes briefly accept writes, leading to duplicate authorization grants (lost writes).
- **Eviction:** If configured improperly, memory exhaustion leads to key eviction, potentially deleting active leases or rate-limit counters prematurely.

**Is Redis required?** NO (CONDITIONAL)
**Why?** Redis cannot securely serve as the single source of truth for the Escrow state machine or Audit log due to durability and split-brain risks. While excellent for rate-limiting, introducing it alongside a durable store violates the "smallest defensible architecture" principle unless performance explicitly mandates it.

---

## 4. POSTGRESQL EVALUATION
PostgreSQL provides strict ACID transactions and durable storage.
- **Durable Escrow State:** ACID guarantees prevent split-brain authorization duplicate approvals.
- **State Transitions:** Optimistic concurrency control (`version` column) or row-level locking (`SELECT FOR UPDATE`) mathematically guarantees single-winner state transitions.
- **Audit Records:** Immutable, durable, and easily queryable for compliance evidence.
- **Idempotency:** `UNIQUE` constraints natively enforce cross-tenant idempotency boundaries.

**Is PostgreSQL required?** YES
**Why?** The Firewall's core value is strict authorization and auditable security. A strongly consistent, durable, relational data store is mandatory to prevent double-execution, persist compliance logs safely, and survive node crashes without state loss.

---

## 5. COMPARE ARCHITECTURES
- **Architecture A (Redis Only):** High performance, but unacceptable risk of data loss on crash and split-brain dual-approvals. Fails audit durability requirements.
- **Architecture C (Redis + PostgreSQL):** Best performance and durability, but high operational complexity. Requires two-phase commits or saga patterns to keep Redis (rate limits/locks) synchronized with Postgres (audit/state).
- **Architecture D (Local State + Sticky Sessions):** Violates cloud-native elasticity; node failure results in permanent loss of pending escrows and audit logs.
- **Architecture B (PostgreSQL Only):** Smallest defensible architecture. Postgres handles durable state, audit, idempotency, and (using unlogged tables or optimized queries) rate-limiting. Ensures strict serialization of Escrow transitions.

**Recommendation:** Architecture B (PostgreSQL Only).

---

## 6. DISTRIBUTED ESCROW STATE MACHINE
The Escrow state machine moves to a PostgreSQL table `escrow_requests`.
**Legal Transitions:** PENDING -> APPROVED | DENIED | EXPIRED. APPROVED -> EXECUTING. EXECUTING -> EXECUTED | FAILED.
**Atomicity / Concurrency:**
Optimistic Concurrency Control (OCC) is used.
```sql
UPDATE escrow_requests 
SET status = 'APPROVED', version = version + 1 
WHERE id = $1 AND status = 'PENDING' AND version = $2;
```
If Gateway A and Gateway B attempt simultaneous approvals, only the first transaction commits. The second transaction observes `0 rows affected` and rejects the request safely, guaranteeing single-winner transition.

---

## 7. EXECUTION OWNERSHIP
Execution ownership is managed via database leases.
- When transitioning `APPROVED` -> `EXECUTING`, the worker sets `locked_by = $worker_id` and `locked_until = NOW() + INTERVAL '30 seconds'`.
- **Worker Crash:** If a worker crashes, the lease expires. Another worker (or a reaper process) can safely identify records where `locked_until < NOW()` and status is `EXECUTING`.
- **Stale Workers:** A worker must check its local clock before making the external HTTP request. If the lease is expired, it must abort.

---

## 8. CRITICAL EXTERNAL SIDE-EFFECT FAILURE
**Scenario:** Worker executes external API (SUCCESS) -> Worker crashes before recording `EXECUTED`.
**Analysis:** Titan *cannot know* if the external side-effect occurred. A new worker claiming the expired lease will retry the execution.
**Limitation:** Exactly-once execution is **impossible** without external cooperation. 
**Resolution:** Titan provides *at-least-once* execution if the system is designed to retry, or *at-most-once* if designed to fail the escrow on crash. To achieve exactly-once, the external service MUST support Idempotency Keys (e.g., passing `EscrowId` as `Idempotency-Key` header). If the external service does not support this, Titan explicitly yields the guarantee.

---

## 9. IDEMPOTENCY MODEL
**Idempotency Key Structure:** A composite unique index on `(tenant_id, target_tool, idempotency_key)`.
This prevents cross-tenant or cross-tool idempotency collisions.
The idempotency record points to the final `ExecutionResult`. If a request is replayed with the same key, Titan returns the stored outcome rather than re-executing.

---

## 10. EXECUTION LEASES AND FENCING
If Worker A experiences a severe garbage-collection pause, its lease may expire, and Worker B may take over. Worker A wakes up and executes.
- **Soft Fencing:** Worker A checks local clock before HTTP execution. Vulnerable to NTP drift and microsecond scheduling races.
- **Hard Fencing (External-Dependent):** Worker A passes its `lease_version` to the External API. The External API rejects requests with older lease versions.
*Limitation explicitly stated:* Fencing against arbitrary external HTTP endpoints relies entirely on Soft Fencing. The risk of duplicate execution during profound worker starvation exists.

---

## 11. DISTRIBUTED RATE LIMITING
Migrate from local memory to PostgreSQL (e.g., sliding window or token bucket via row-level locks on a `rate_limits` table).
**Failure Behavior:** If the database is unreachable, the system **FAILS CLOSED** (denies all requests). Security boundaries must not be bypassed due to telemetry or quota store outages.

---

## 12. DISTRIBUTED RESOURCE EXHAUSTION
**Attack:** 10,000,000 unique request IDs.
**Mitigation:** 
- Strict `COUNT(*)` quotas per `tenant_id` where `status = 'PENDING'`. 
- Postgres table partitioning by date.
- Asynchronous `pg_cron` or reaper worker physically deleting `EXPIRED` rows older than 7 days to prevent index growth.
- Hard limits on request payload sizes at the Ingress/API Gateway layer.

---

## 13. SHARED-STATE FAILURE MODEL
- **DB Unavailable:** API Gateway returns `503 Service Unavailable`. Fails closed. No executions proceed.
- **DB Partition (Read-Only replica reachable):** Read-only audit is available, but state transitions (approvals/executions) fail closed.

---

## 14. DURABLE AUDIT
Audit records are synchronously written to an append-only `audit_logs` table within the same PostgreSQL transaction as the state transition.
- **Durability:** Gateway crash after DB commit = safe (data persisted).
- **No loss:** Because state transitions and audit logs share an ACID transaction, it is impossible to transition state without leaving an audit trail.

---

## 20. ARCHITECTURAL DECISION TABLE

| Question | Decision | Rationale |
| :--- | :--- | :--- |
| Redis required? | NO | Split-brain risk, durability concerns. Unnecessary operational burden. |
| PostgreSQL required? | YES | Strict ACID transactions are mandatory for secure state transitions and durable audit. |
| Distributed locking required? | YES | Row-level locking (`SELECT FOR UPDATE`) prevents concurrent execution. |
| Execution leases required? | YES | Required to recover from worker crashes during execution. |
| Fencing required? | YES | Required to prevent stale workers from executing (Soft fencing guaranteed, Hard fencing external-dependent). |
| Idempotency required? | YES | Composite `(tenant, tool, key)` required for safe retries. |
| Durable audit required? | YES | Must be persisted synchronously with state changes via ACID DB. |
| Distributed rate limiting required? | YES | Must fail closed if unavailable to prevent exhaustion attacks. |
| External idempotency cooperation required? | YES | Mandatory for strict exactly-once execution guarantees. |

---

## 21. GUARANTEE CLASSIFICATION

- **Authorization Integrity:** PROVEN (Single-node), DESIGNED (Distributed OCC)
- **Tenant Isolation:** PROVEN
- **State Machine Transitions:** DESIGNED (OCC via PostgreSQL)
- **Bounded Resources:** DESIGNED (Per-tenant DB limits & Reaper processes)
- **SSRF Protection:** PROVEN
- **Durable Audit:** DESIGNED (Synchronous DB transactions)
- **Exactly-Once External Execution:** EXTERNAL-DEPENDENT
- **Hard Fencing:** EXTERNAL-DEPENDENT

---

## 22. IDENTIFY THE HARDEST PROBLEM

1. **Hardest Stage 2 security problem:** Enforcing hard fencing on execution workers connecting to legacy/external APIs that do not support fencing tokens.
2. **Hardest distributed-systems problem:** Distinguishing between a slow/paused worker and a permanently crashed worker, leading to lease expiration races.
3. **Largest new attack surface:** The PostgreSQL database. If compromised, an attacker can manually forge `APPROVED` records, bypassing the Policy Engine entirely.
4. **Most dangerous failure mode:** The "Unknown External Result" where Titan times out waiting for the external API, leaving the system fundamentally uncertain if the side-effect occurred.
5. **Most important Stage 2 invariant:** Authorization state transitions MUST be strictly serialized and single-winner.
6. **Cannot be guaranteed without external cooperation:** Exactly-Once External Execution.
