# STAGE 2 ADVERSARIAL TEST PLAN

## 18. STAGE 2 ADVERSARIAL TEST PLAN
This test plan explicitly targets the distributed failure modes introduced in Stage 2. Every Stage 1.3 invariant must be verified under concurrent, distributed conditions.

### Concurrency & State Machine

1. **Multi-Gateway Concurrency (Duplicate Approval):**
   - **Setup:** Spin up 3 separate Gateway instances pointing to the same PostgreSQL DB.
   - **Action:** Send `POST /approve` for the same Escrow ID simultaneously to Gateway A, Gateway B, and Gateway C.
   - **Expected:** Exactly one instance returns `200 OK`. The other two must return `400 Invalid state transition`. 

2. **Approval/Deny Race:**
   - **Action:** Send `POST /approve` and `POST /deny` simultaneously for the same Escrow ID.
   - **Expected:** The state resolves to either `APPROVED` or `DENIED`. It must never reach an invalid interleaved state.

3. **Execution Ownership Race:**
   - **Action:** Spawn 5 execution workers. Bypass the Orchestrator and manually insert an `APPROVED` record into the DB.
   - **Expected:** Only one worker successfully claims the lease (`locked_by`). The others gracefully continue polling.

### Fencing & Leases

4. **Lease Expiration & Worker Crash:**
   - **Action:** Worker A claims a lease but is violently terminated (`kill -9`) before making the external HTTP call.
   - **Expected:** The lease expires. Worker B successfully claims the lease and executes the request.

5. **Stale Worker (Soft Fencing):**
   - **Action:** Worker A claims a lease, but the test framework pauses the process for 60 seconds (simulating severe GC or CPU starvation). Worker B claims the expired lease and executes. Worker A is resumed.
   - **Expected:** Worker A checks its local clock, detects its lease has expired, and aborts the external request.

6. **Fencing Failure (External-Dependent):**
   - **Action:** Same as Test 5, but the external API does not support fencing tokens. Worker A is paused, Worker B executes, Worker A resumes *after* initiating the HTTP request.
   - **Expected:** Duplicate execution occurs. *This explicitly proves the architectural limitation that exact-once execution requires external cooperation.*

### Failures & Networking

7. **Database Failure (Fail Closed):**
   - **Action:** Terminate the PostgreSQL database during an active authorization request.
   - **Expected:** Gateway returns `503 Service Unavailable`. No execution occurs.

8. **Database Restart (Durability):**
   - **Action:** Approve a request, wait for `EXECUTED`, then restart PostgreSQL.
   - **Expected:** The `EXECUTED` state and its corresponding audit log are perfectly preserved.

9. **Network Partition (Gateway -> DB):**
   - **Action:** Drop packets between Gateway and DB.
   - **Expected:** Gateway times out and fails closed.

10. **External Success + Worker Crash:**
    - **Action:** Worker successfully calls external API. Before writing `EXECUTED` to DB, the worker is killed.
    - **Expected:** State remains `EXECUTING`. A new worker claims it and retries. (Proves at-least-once behavior).

11. **External Timeout + Unknown Result:**
    - **Action:** External API delays response by 30 seconds. Worker times out.
    - **Expected:** State transitions to `FAILED`. The system logs "Unknown Result".

### Limits & Idempotency

12. **Idempotency Replay:**
    - **Action:** Send the exact same HTTP request with the same `Idempotency-Key` twice.
    - **Expected:** First request executes. Second request returns the exact same `ExecutionResult` without hitting the external API.

13. **Cross-Tenant Idempotency Reuse:**
    - **Action:** Tenant A uses `Idempotency-Key: 123`. Tenant B attempts to use `Idempotency-Key: 123`.
    - **Expected:** Both requests process independently. The keys do not collide.

14. **Resource Exhaustion (DB Quota):**
    - **Action:** Generate 10,001 unique `PENDING` requests for a single tenant.
    - **Expected:** The 10,001st request is rejected with `500 Maximum pending escrows reached`, without affecting other tenants.

15. **Distributed Rate-Limit Race:**
    - **Action:** Send 1,000 requests simultaneously across 10 gateways where the limit is 100/min.
    - **Expected:** Exactly 100 requests succeed. 900 return `429 Too Many Requests`.

16. **Audit Durability:**
    - **Action:** Inspect the database transaction logs after a successful execution.
    - **Expected:** The `audit_logs` table contains the exact state transition, execution latency, and actor identity bound in the same transaction ID as the state update.
