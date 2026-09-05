# Stage 2 Security Repair V2 Report

## Findings Addressed

### 1. RLS Bypass via `search_path` Hijacking (CRITICAL)
- **Vulnerability**: `get_current_tenant()` SECURITY DEFINER function referenced `_internal_secrets` without schema qualification or a locked `search_path`.
- **Root Cause**: PostgreSQL resolves unqualified relations in `pg_temp` before `public`, allowing attackers to shadow security-critical tables via temp tables.
- **Exact Repair**: Added `SET search_path = public` to the function definition, and explicitly schema-qualified the target table to `public._internal_secrets`.
- **Security Invariant Established**: The function now deterministicly queries the authenticated, authoritative `_internal_secrets` table, ignoring session-level path manipulation or temp tables.
- **Adversarial Test**: `reverify_rls_all2.js` created a temp `_internal_secrets` table and forged a token.
- **Result**: **FIXED**. The function correctly queried the real table, the forged token failed validation, and RLS returned 0 rows.

### 2. Connection Pool Poisoning via `SECURITY DEFINER` Functions (CRITICAL)
- **Vulnerability**: `reserve_request`, `worker_claim_request`, and `worker_resolve_request` lacked schema qualification, allowing `requests` and `quotas` to be shadowed by temp tables in reused pool connections.
- **Root Cause**: Shared connection state (temp tables) leaked across pool checkouts without explicit reset, combined with unqualified table references.
- **Exact Repair**: 
  1. Updated all DB queries within `SECURITY DEFINER` functions to explicitly reference `public.requests`, `public.quotas`, etc., and `v_req public.requests%ROWTYPE`.
  2. Implemented connection session reset by adding `client.query('DISCARD ALL;')` inside `releaseClient()` in `db.ts` to actively purge temp tables and session state upon pool checkin.
- **Security Invariant Established**: "No attacker-controlled session state may influence the object resolution... of a later legitimate request using the same physical connection."
- **Adversarial Test**: `reverify_pool.js` poisoned a connection with a temp `requests` table, released it, and a legitimate worker checked it out.
- **Result**: **FIXED**. Legitimate workers interact strictly with authoritative tables; poisoned temp state is dropped via `DISCARD ALL` and bypassed via schema qualification.

### 3. Audit Accountability Loss (HIGH)
- **Vulnerability**: The `audit_request_changes` trigger recorded `current_user`, which evaluated to the `SECURITY DEFINER` function owner (`u0_a338`) rather than the originating role.
- **Root Cause**: `current_user` inside a SECURITY DEFINER block assumes the privileges and identity of the definer.
- **Exact Repair**: Replaced `current_user` with `COALESCE(NULLIF(current_setting('role', true), 'none'), session_user)` in the audit trigger to dynamically resolve the authenticated application principal set via `SET ROLE`.
- **Security Invariant Established**: Audit logs irrefutably record the effective PostgreSQL execution identity (`gateway_role`, `worker_role`, etc.) bypassing the definer mask.
- **Adversarial Test**: `reverify_audit2.js` executed an action as `gateway_role`.
- **Result**: **FIXED**. Audit log accurately attributed the action to `gateway_role` instead of `u0_a338`.

## SECURITY-DEFINER INVENTORY

| Function Name | Schema | Owner | SECURITY DEFINER | search_path | Referenced Objects | Hardened |
|---|---|---|---|---|---|---|
| `get_current_tenant` | `public` | `u0_a338` | YES | `public` | `public._internal_secrets` | YES |
| `enforce_state_machine` | `public` | `u0_a338` | YES | `public` | None (inspects `NEW/OLD`) | YES |
| `release_quota_on_state_change` | `public` | `u0_a338` | YES | `public` | `public.quotas`, `public.global_quota` | YES |
| `audit_request_changes` | `public` | `u0_a338` | YES | `public` | `public.audit_log`, `pgcrypto` functions | YES |
| `reserve_request` | `public` | `u0_a338` | YES | `public` | `public.requests`, `public.global_quota`, `public.quotas`, `get_current_tenant()` | YES |
| `worker_claim_request` | `public` | `u0_a338` | YES | `public` | `public.requests`, `get_current_tenant()` | YES |
| `worker_resolve_request` | `public` | `u0_a338` | YES | `public` | `public.requests`, `get_current_tenant()` | YES |

## SEARCH_PATH SECURITY
- **Schema Qualification**: All table references inside functions strictly use `public.<table_name>`.
- **Locked search_path**: Function definitions append `SET search_path = public`.
- **Temp Shadowing Resistance**: Successfully proven that `pg_temp` does not supersede `public.requests` when explicitly qualified.

## CONNECTION POOL SECURITY
- **Pool Behavior**: The application utilizes Node `pg.Pool`.
- **Connection Reset Behavior**: `releaseClient()` explicitly invokes `DISCARD ALL;`, aggressively dropping temporary tables, prepared statements, and session properties (`role`, `app.tenant_token`) before returning to the pool.
- **Attacker → Pool → Legitimate Worker**: Validated. A poisoned connection returning to the pool will be thoroughly scrubbed before legitimate reuse.

## AUDIT PROVENANCE
- Originating principals (`gateway_role`, `worker_role`, etc.) remain attributable because the audit trigger actively queries `current_setting('role', true)` avoiding the `SECURITY DEFINER` identity mask.

## REGRESSION RESULTS

- **Stage 1.3**: 34/34
- **Stage 2**: 7/7
- **Gateway**: 5/5
- **New Adversarial Tests**: 4/4 (RLS Shadowing, Pool Poisoning, Audit Provenance, Worker Hijack)
- **Total**: 50/50

## FINDINGS

- **CRITICAL**: 0
- **HIGH**: 0
- **MEDIUM**: 0
- **LOW**: 0
- **INFORMATIONAL**: 0

## CLAIM DISCIPLINE

- **PROVEN BY TEST**: INSERT/UPDATE transition enforcement, Idempotency race prevention, Atomic Quota enforcement, Immutable column enforcement, Temp-table shadowing resistance, Pool-poisoning mitigation, Audit provenance.
- **IMPLEMENTED BUT NOT FULLY PROVEN**: N/A
- **DEPENDENT ON EXTERNAL SYSTEMS**: Exactly-once external execution, Hard external fencing.

## FINAL VERDICT

STAGE 2 SECURITY REPAIR V2: PASS
