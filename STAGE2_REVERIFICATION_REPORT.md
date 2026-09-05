# Stage 2 Security Re-Verification Report

## Executive Verdict

- **CRITICAL**: 2
- **HIGH**: 1
- **MEDIUM**: 0
- **LOW**: 0
- **INFORMATIONAL**: 0
- **VERDICT**: FAIL
- **PRODUCTION SECURITY AUTHORIZATION**: NO

## Previous Findings Review

### 1. RLS Tenant Context Can Be Forged Through Writable GUC (CRITICAL)
- **Previous Exploit**: `SET app.current_tenant = 'victim';`
- **Repaired Mechanism**: Introduced `app.tenant_token` (HMAC-SHA256) checked by `get_current_tenant()` SECURITY DEFINER function against `_internal_secrets`.
- **Re-Attack**: Created a temporary table `_internal_secrets` to shadow the real table and inject an attacker-controlled HMAC key.
- **Result**: **BYPASSED**. The function lacks schema qualification (`public._internal_secrets`) and a locked `search_path`. A temporary table successfully hijacks the verification, allowing complete forging of tenant identity.
- **Evidence**: `attackRole` bypassed RLS by forging a token using the injected key; visible rows returned from other tenants.

### 2. Terminal-State Forgery Through INSERT (CRITICAL)
- **Previous Exploit**: `INSERT INTO requests (state) VALUES ('EXECUTED');`
- **Repaired Mechanism**: Modified `enforce_state_machine` trigger to run `BEFORE INSERT OR UPDATE` and strictly require `PENDING`.
- **Re-Attack**: Attempted direct INSERT with `state='EXECUTED'`.
- **Result**: **FIXED**. Database strictly rejects inserts not explicitly set to `PENDING`.

### 3. Fencing / Lease Ownership Can Be Bypassed (CRITICAL)
- **Previous Exploit**: `UPDATE requests SET state = 'EXECUTED' WHERE id = 'target-id';` without verifying `lease_token`.
- **Repaired Mechanism**: Revoked `UPDATE` from `worker_role`, mandated usage of `worker_resolve_request()` SECURITY DEFINER function to atomically check `lease_token`.
- **Re-Attack**: Attempted calling the function with `NULL` or forged lease tokens.
- **Result**: **FIXED** (Base logic). The function successfully rejects requests without the exact active token. (See New Attack Surface for search_path vulnerabilities).

### 4. Quota Counter Can Be Mutated Beyond max_pending (HIGH)
- **Previous Exploit**: `UPDATE quotas SET pending_count = pending_count + 1;` bypassing limits.
- **Repaired Mechanism**: Centralized quota updates into the atomic `reserve_request()` function and added `CHECK` constraints.
- **Re-Attack**: Simulated concurrent requests and attempted direct mutation.
- **Result**: **FIXED**. Database properly locks rows and enforces limits atomically.

### 5. Idempotency CTE Race Causes Missing Row / Application Crash (HIGH)
- **Previous Exploit**: Concurrent identical requests raced the CTE snapshot, causing zero-row responses.
- **Repaired Mechanism**: Replaced CTE with a PL/pgSQL `LOOP` handling `ON CONFLICT` constraints and refetching.
- **Re-Attack**: Sent identical concurrent requests using parallel Postgres connections.
- **Result**: **FIXED**. One request wins the reservation, and all others safely resolve to the existing reservation with 200 OK.

## New Attack Surface

### 1. CRITICAL: RLS Bypass via `search_path` Hijacking in `get_current_tenant()`
- **Vulnerability**: The `get_current_tenant()` function queries `_internal_secrets` without schema qualification and without setting `search_path`.
- **Impact**: Any application role can create a temporary table `pg_temp._internal_secrets`, inject a known secret, and generate valid HMACs for any tenant. This defeats the entire RLS enforcement.

### 2. CRITICAL: Connection Pool Poisoning via `search_path` Hijacking in SECURITY DEFINER Functions
- **Vulnerability**: The `reserve_request`, `worker_claim_request`, and `worker_resolve_request` functions execute as SECURITY DEFINER without locking `search_path`.
- **Impact**: An attacker can execute `CREATE TEMP TABLE requests` on a connection. When the connection returns to the pool and is reused by a legitimate node worker, the worker operates on the temporary table. This allows the attacker to hide real requests, causing legitimate requests to remain `APPROVED` indefinitely or causing duplicate external execution, breaking the exactly-once/at-most-once guarantees.

### 3. HIGH: Audit Accountability Loss
- **Vulnerability**: The `audit_request_changes()` trigger function is declared `SECURITY DEFINER` and logs `current_user`.
- **Impact**: Because it runs as the function owner (e.g., `postgres` or `u0_a338`), the `audit_log` records the owner for every transaction, completely losing the actual actor identity (e.g., `gateway_role`, `worker_role`).

## Attack Matrix

| Threat Actor | Preconditions | Attack | Result | Severity |
|---|---|---|---|---|
| Gateway / Worker Role | SQL access | `CREATE TEMP TABLE _internal_secrets` to inject known HMAC key | Complete RLS bypass | CRITICAL |
| Gateway / Worker Role | Connection Pooling | `CREATE TEMP TABLE requests` to shadow tables | Connection pool poisoning, state machine desync | CRITICAL |
| Any Role | Trigger execution | Audit log trigger records `current_user` in SECURITY DEFINER | Loss of audit actor identity | HIGH |

## Guarantee Classification

- **Proven**: INSERT/UPDATE transition enforcement, Idempotency race prevention, Atomic Quota enforcement, Immutable column enforcement.
- **Designed (Failed Implementation)**: HMAC Tenant Authentication, Fencing/Lease Enforcement (broken by search_path vulnerabilities).
- **External-Dependent**: Exactly-once external execution, Hard external fencing.
- **Unresolved**: RLS bypass, Audit accountability.

## Most Important Residual Risk
The lack of `search_path` lock-down on `SECURITY DEFINER` functions completely undermines the database enforcement boundaries. It allows temporary tables to supersede authoritative tables, breaking RLS, state tracking, and quotas across connection pool sessions.

## Final Gate

The verification **FAILS** due to multiple critical vulnerabilities related to SECURITY DEFINER configurations allowing RLS bypass and state spoofing.

**STAGE 2 RE-VERIFICATION: COMPLETE — SEE REPORT**
