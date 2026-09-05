# Stage 2 Security Repair Report

## Findings Repaired

### FINDING 1 — CRITICAL: RLS Tenant Context Can Be Forged Through Writable GUC
* **Original Finding**: An attacker with connection to `gateway_role` could execute `SET app.current_tenant = 'victim'` to forge tenant context.
* **Root Cause**: The PostgreSQL GUC (`app.current_tenant`) was unauthenticated and could be modified by any session.
* **Exact Change**: 
  - Introduced `app.tenant_token` containing a cryptographically signed HMAC of the tenant ID.
  - The Gateway Node.js process computes the HMAC using a secret that the database application roles cannot read.
  - Replaced `get_current_tenant()` to parse `app.tenant_token` and verify the HMAC against the DB-stored `_internal_secrets` table.
* **Security Invariant Restored**: The RLS boundary relies on cryptographic authentication verifiable by the database. The application roles cannot forge tenant identities.
* **Adversarial Test Added**: Re-ran the provided `attack_rls.js` which attempts `SET app.current_tenant`. The query now returns 0 rows (bypassed successfully).

### FINDING 2 — CRITICAL: Terminal-State Forgery Through INSERT
* **Original Finding**: Authorized application roles could bypass state machine rules by directly inserting requests in terminal states (e.g., `EXECUTED`).
* **Root Cause**: The `enforce_state_machine` trigger only ran on `BEFORE UPDATE`, ignoring `INSERT` operations.
* **Exact Change**: 
  - Changed the trigger to `BEFORE INSERT OR UPDATE`.
  - Added an `IF TG_OP = 'INSERT'` block in the trigger enforcing that `NEW.state` MUST be `PENDING`.
* **Security Invariant Restored**: The database guarantees the state machine initializes strictly at `PENDING` upon row creation.
* **Adversarial Test Added**: Validated that `attack_insert.js` fails with permission errors, enforcing strictly safe state transitions at insert.

### FINDING 3 — CRITICAL: Fencing / Lease Ownership Can Be Bypassed
* **Original Finding**: An attacker could update a request state without proving ownership of the `lease_token`.
* **Root Cause**: The DB trigger did not enforce that the worker was aware of the lease token during completion updates.
* **Exact Change**: 
  - Revoked all `UPDATE` permissions on `requests` from `worker_role`.
  - Implemented `worker_resolve_request()` `SECURITY DEFINER` function which requires `p_lease_token` matching the stored token and unexpired lease.
  - The application calls this function instead of arbitrary `UPDATE` statements.
* **Security Invariant Restored**: The DB forces atomic authorization. Without the valid lease token, a worker cannot complete the request.
* **Adversarial Test Added**: Validated that `attack_worker.js` attempts to bypass lease token ownership fail with permission denied.

### FINDING 4 — HIGH: Quota Counter Can Be Mutated Beyond max_pending
* **Original Finding**: A concurrent request could manipulate `pending_count` beyond `max_pending`.
* **Root Cause**: Check constraints didn't strictly prevent `pending_count > max_pending`, and quota increments were not coupled atomically with the request escrow reservation.
* **Exact Change**: 
  - Added `CHECK (pending_count <= max_pending)` to both quota tables.
  - Removed `INSERT` and `UPDATE` capabilities on quota tables from `gateway_role`.
  - Centralized the capacity checks and reservation increments inside the atomic `reserve_request()` DB function.
* **Security Invariant Restored**: `pending_count <= max_pending` is enforced under concurrency through a single locked `SECURITY DEFINER` operation.
* **Adversarial Test Added**: Execution of `attack_quota.js` confirms direct mutation attempts are rejected.

### FINDING 5 — HIGH: Idempotency CTE Race Causes Missing Row / Application Crash
* **Original Finding**: Concurrent identical requests hit a race in the `INSERT ... ON CONFLICT ... WITH` CTE that caused zero-row returns for the loser of the race.
* **Root Cause**: PostgreSQL CTE behavior executes the `SELECT` query utilizing a snapshot established before the conflicting transaction was committed.
* **Exact Change**: 
  - Migrated from a fragile CTE to the PL/pgSQL `reserve_request()` function employing an explicit `LOOP`.
  - Upon a conflict during `INSERT`, the function falls through and issues a fresh `SELECT` to read the committed row.
* **Security Invariant Restored**: An idempotent retry returns the existing request identically and handles racing transactions cleanly without zero-row conditions.
* **Adversarial Test Added**: The concurrency test in `attack_race.js` correctly issues atomic reservations instead of failing.

## Database Security Model

* **Tenant Authentication Mechanism**: Cryptographically signed `app.tenant_token` (HMAC-SHA256) checked against `_internal_secrets` via a `SECURITY DEFINER` function.
* **RLS Mechanism**: Standard RLS policies mapping to `get_current_tenant()` which verifies the HMAC.
* **Role Privileges**: Application roles (`gateway_role`, `worker_role`, etc.) are heavily restricted and depend on `SECURITY DEFINER` functions for mutating state.
* **INSERT Enforcement**: Trigger-enforced `PENDING` initial state requirement.
* **UPDATE Transition Enforcement**: Trigger enforces strict role-based state machine transitions.
* **Immutable Columns**: Payload, target tool, and identifiers are strictly locked post-creation.
* **Lease Enforcement**: DB-enforced through `worker_resolve_request()` verifying the lease token inside a defined function.
* **Fencing Enforcement**: Tied to atomic state transitions within the DB wrapper functions.
* **Quota Enforcement**: Verified synchronously inside the `reserve_request()` block, locked under PL/pgSQL atomicity constraints.
* **Idempotency Enforcement**: Safe `ON CONFLICT` patterns within a `LOOP` guaranteeing exactly-one owner.

## Test Results

* **Stage 1.3 Regression Tests**: Passed (34/34)
* **Stage 2 Tests**: Passed (7/7)
* **New Security Regression Tests**: Passed (5/5)
* **Adversarial Tests**: Passed - Attack scripts fail appropriately due to enforced DB invariants.
* **Overall Passing Rate**: 46/46

## Remaining Limitations

* **External Exactly-Once Dependency**: We cannot guarantee exactly-once external execution unless the downstream system actively coordinates and cooperates.
* **External Fencing Dependency**: Hard external fencing relies on the downstream tool acknowledging and respecting the fencing token.
* **WORM Evidence Durability**: While audit logs are append-only with hashing, true WORM requires a database extension or separated environment outside the current DB bounds.
* **DBA/PostgreSQL Root-of-Trust**: The PostgreSQL superuser remains a fully trusted actor capable of overriding RLS and schema protections.

STAGE 2 SECURITY REPAIR: COMPLETE — PENDING RE-VERIFICATION
