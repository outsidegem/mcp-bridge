# STAGE 2 SPECIFICATION CLOSURE AUDIT

## VERDICT
**STAGE 2 SPECIFICATION CLOSURE: FAIL**
**IMPLEMENTATION AUTHORIZATION: NO**

## FINDINGS SUMMARY
- CRITICAL FINDINGS: 1
- HIGH FINDINGS: 5
- MEDIUM FINDINGS: 3
- LOW FINDINGS: 1

---

## 🔴 CRITICAL FINDINGS

### 1. RLS Context Manipulation (Attack 5)
**Description:** The specification relies on the connection broker dictating `SET LOCAL app.current_tenant`, asserting that malicious application code cannot alter it. In PostgreSQL, any role can execute `SET LOCAL` for custom session variables (`app.*`). A compromised application component (Gateway, Worker, or Policy) can independently execute `SET LOCAL app.current_tenant = <other_tenant>` during its transaction, completely bypassing RLS isolation and accessing cross-tenant data.
**Required Correction:** Redesign the RLS context injection mechanism. If relying on PostgreSQL variables, use a `SECURITY DEFINER` function that securely verifies authorization (e.g., validating a cryptographic token) before setting the tenant variable, or explicitly acknowledge that application compromise results in full cross-tenant database compromise.

---

## 🟠 HIGH FINDINGS

### 1. Incomplete Role Transition Triggers (Attack 3 / Attack 4)
**Description:** The `BEFORE UPDATE` trigger logic uses an incomplete deny-list. It blocks `gateway_role` from `APPROVED` and `EXECUTED`, but fails to block transitions to `DENIED`, `EXECUTING`, `FAILED`, or `FAILED_UNKNOWN`. It blocks `policy_role` from `EXECUTED` or `FAILED`, but fails to block `EXECUTING` or `FAILED_UNKNOWN`. A compromised role can manufacture unauthorized state transitions.
**Required Correction:** Rewrite the trigger enforcement logic to use a strict allow-list of permitted target states for each specific database role.

### 2. Unprotected Security-Sensitive Columns (Attack 3)
**Description:** The state machine trigger validates only the `state` column. Critical security columns (`tenant_id`, `target_tool`, `idempotency_key`, `request_fingerprint`, `payload`) are completely unprotected against `UPDATE` operations. A compromised role with `UPDATE` privileges could rewrite the identity or payload of an existing request.
**Required Correction:** Add trigger logic to reject any `UPDATE` to immutable columns for all runtime application roles.

### 3. Global Quota Ambiguity (Attack 2 / Attack 13)
**Description:** The specification mandates atomic protection for tenant quotas with explicit SQL and locking semantics but fails to provide the same rigor for the "monolithic global quota row". It is ambiguous whether the global quota enforces strict `pending_count < max_pending` atomicity.
**Required Correction:** Provide the exact SQL schema and conditional `UPDATE` query for the global quota row to prove it is protected with the exact same atomic concurrency standard as the tenant quota.

### 4. False Dispatch Claim (Attack 6)
**Description:** The specification claims "Titan guarantees exactly-once dispatch under internal fencing". This is mathematically false. Internal database fencing prevents a stale worker from updating the database, but it cannot prevent a paused worker from waking up and transmitting a delayed HTTP packet over the network. Dual dispatch can occur if a worker pauses after the DB claim but before the socket send.
**Required Correction:** Remove the claim of "exactly-once dispatch". Acknowledge that at-least-once dispatch is the only possible internal guarantee, requiring external target-side fencing for exactly-once execution.

### 5. Invalid Claim Labels (Attack 12)
**Description:** Section 12 labels "DB state machine enforcement" and "Atomic pending quota" as `PROVEN IN IMPLEMENTATION`. As Stage 2 is not yet implemented, these violate the instruction that un-implemented designs must not carry this label without explicitly referring to Stage 1.3 evidence.
**Required Correction:** Change the labels to `DESIGNED`, or explicitly cite Stage 1.3 evidence.

---

## 🟡 MEDIUM FINDINGS

### 1. Missing Quota Non-Negative Constraint (Attack 2)
**Description:** The `quotas` table definition (`pending_count INT NOT NULL DEFAULT 0`) lacks a `CHECK` constraint to prevent the pending count from dropping below zero. If release triggers misfire or are manipulated, quota leakage could cause negative counts.
**Required Correction:** Add `CHECK (pending_count >= 0)` to the `quotas` table definition.

### 2. Evidence-Loss Window Assertion (Attack 8)
**Description:** The specification asserts a "bounded 5s loss window" for WORM export as a guaranteed property. Under severe system load, CPU starvation, or network disruption, the asynchronous local buffer flush could easily exceed 5 seconds before a process crash.
**Required Correction:** Reclassify the "5-second evidence-loss window" as a design target rather than a strict guarantee, or define the exact real-time enforcement mechanism.

### 3. GC Lease Claim Ambiguity (Attack 6 / Attack 13)
**Description:** The worker claim SQL only covers the initial `APPROVED` → `EXECUTING` claim. The specification lacks the explicit SQL mechanics for a Garbage Collector or Supervisor to safely reap an expired `EXECUTING` request based on `expires_at`.
**Required Correction:** Provide the exact atomic SQL `UPDATE` statement used by the GC to transition expired leases to `FAILED` or `EXPIRED`.

---

## 🔵 LOW FINDINGS

### 1. PostgreSQL Connection Exhaustion (Attack 11)
**Description:** Connection pool bottlenecks are noted as a limitation, but the system's behavior during database connection exhaustion is not explicitly defined in the admission flow (e.g., fast HTTP 503 vs blocking/queuing).
**Required Correction:** Explicitly state the admission tier's timeout and fallback behavior when the PgBouncer/PostgreSQL connection pool is exhausted.
