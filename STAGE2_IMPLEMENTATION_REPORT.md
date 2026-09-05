# STAGE 2 IMPLEMENTATION REPORT

## FILES CHANGED / CREATED
- `src/db/schema.sql` (New)
- `src/db/triggers.sql` (New)
- `src/core/db.ts` (New)
- `src/core/redis.ts` (New)
- `src/core/stage2-gateway.ts` (New)
- `src/core/stage2-policy.ts` (New)
- `src/core/stage2-worker.ts` (New)
- `src/core/stage2-gc.ts` (New)
- `tests/stage2.test.ts` (New)

## DATABASE OBJECTS CREATED
- **Tables:** `global_quota`, `quotas`, `requests`, `audit_log`
- **Roles:** `gateway_role`, `policy_role`, `worker_role`, `gc_role`, `audit_role`, `migration_role`
- **Triggers:** `enforce_state_machine_trigger`, `release_quota_trigger`, `audit_request_insert_trigger`, `audit_request_update_trigger`
- **Functions:** `get_current_tenant`, `enforce_state_machine`, `release_quota_on_state_change`, `audit_request_changes`

## RLS POLICIES
- RLS is enabled on `requests`, `quotas`, `global_quota`, and `audit_log`.
- Policies strictly enforce isolation using `tenant_id = get_current_tenant()`.
- `get_current_tenant()` extracts `current_setting('app.current_tenant', true)`.

## STATE-MACHINE ENFORCEMENT
- Enforced natively by PostgreSQL via a `BEFORE UPDATE` trigger on `requests`.
- Strict allow-list transitions based on `current_user`:
  - `gateway_role`: `PENDING` -> `EXPIRED`
  - `policy_role`: `PENDING` -> `APPROVED` | `DENIED`
  - `worker_role`: `APPROVED` -> `EXECUTING` | `EXECUTING` -> `EXECUTED` | `FAILED` | `FAILED_UNKNOWN`
  - `gc_role`: `EXECUTING` -> `FAILED_UNKNOWN` | `PENDING` -> `EXPIRED`

## IDEMPOTENCY MECHANISM
- PostgreSQL `UNIQUE` constraint on `(tenant_id, target_tool, idempotency_key)`.
- Gateway executes `INSERT ... ON CONFLICT DO NOTHING RETURNING *` (simulated via CTE) to determine row presence safely within a transaction.
- If existing record's `request_fingerprint` matches incoming request -> HTTP 200 Replay.
- If fingerprint differs -> HTTP 409 Conflict.

## QUOTA MECHANISM
- Atomic conditional `UPDATE` on both `global_quota` and `quotas` in a single transaction.
- Global quota updated first to prevent deadlocks.
- Check constraints `CHECK (pending_count >= 0)` prevent negative quotas.
- Release is handled securely via PostgreSQL `AFTER UPDATE` trigger when state transitions out of `PENDING`.

## REDIS ARCHITECTURE
- Uses `ioredis` to manage lightweight, non-authoritative distributed admission limits.
- Evaluates token decrement inside a Lua script.
- Fails closed (`enableOfflineQueue: false` and strict timeouts).

## LEASE / FENCING MECHANISM
- The `worker_role` claims a request atomically, setting `lease_token` (UUID) and `expires_at` (+30s).
- Execution finalization strictly requires matching `state = 'EXECUTING'` and `lease_token`.
- `gc_role` reaps leases by setting state to `FAILED_UNKNOWN` if `expires_at <= now()`.
- A stale worker awakening after GC reap will fail to update state (0 rows affected).

## AUDIT MECHANISM
- Uses PostgreSQL triggers to automatically insert into `audit_log` on `INSERT` and `UPDATE` (if state changes).
- Cryptographic hash chaining applies to previous records (`prev_hash` -> `curr_hash`).

## TESTS EXECUTED
7 comprehensive unit and integration tests covering:
1. Idempotency: Same identity + same fingerprint -> 200 replay
2. Idempotency: Same identity + diff fingerprint -> 409 conflict
3. State Machine: Gateway cannot transition to APPROVED
4. State Machine: Flow through Policy -> Worker -> GC
5. RLS: Cannot read other tenant data
6. Immutable Security Columns: Cannot modify payload
7. Stale worker prevention via GC reap

- **Test Counts:** 7 total tests
- **Failures:** 0

## KNOWN LIMITATIONS
- RLS context manipulation: The trust boundary remains at the application perimeter. If a runtime role's credentials are fundamentally compromised, they can execute arbitrary `SET app.current_tenant` to impersonate tenants.
- WORM Evidence Window: In a crash scenario prior to external WORM export, buffered evidence may be lost.

## CLAIMS SUPPORTED
- Zero unauthorized execution (PostgreSQL state machine and triggers correctly block out-of-order execution and unauthorized access by standard application logic).
- Atomic pending quota allocation and double-decrement prevention.
- Strict internal fencing via database constraints.

## CLAIMS EXPLICITLY NOT SUPPORTED
- Exactly-once external execution (network dispatch remains unreliable).
- Zero evidence loss (asynchronous buffering implies data loss upon process crash).
- Cryptographic immunity against completely compromised DB credentials.

STAGE 2 IMPLEMENTATION: COMPLETE — PENDING ADVERSARIAL VERIFICATION
