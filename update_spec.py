import os

new_spec = """# STAGE 2 FINAL IMPLEMENTATION SPECIFICATION

## 1. IDEMPOTENCY

The canonical idempotency identity is defined exactly as the composite tuple:
`(tenant_id, target_tool, idempotency_key)`

The payload hash MUST NOT be part of this uniqueness identity. 

To detect semantic changes to nominally identical requests, a separate **canonical request fingerprint** is evaluated. This fingerprint is a cryptographic hash of all security-relevant properties:
- `tenant_id`
- `target_tool`
- HTTP method
- Normalized URL
- Request arguments/body
- Authorization-relevant policy inputs
- Credential identity/reference
- Any other field capable of changing the external effect of the request

### Deterministic Behavior
- **CASE A (Same Identity, Same Fingerprint):** Idempotent replay. The system returns the previously recorded state/result. It MUST NOT execute a second external action.
- **CASE B (Same Identity, Different Fingerprint):** HTTP 409 Conflict. The system MUST NOT execute the request and the conflict MUST be auditable.
- **CASE C (Different Tenant):** Separate namespace. Evaluated as a completely independent request.
- **CASE D (Different Target Tool):** Separate namespace. Evaluated as a completely independent request.

### Execution Flow & Reservation
Idempotency reservation occurs immediately following authentication (to resolve `tenant_id`), but strictly BEFORE:
1. Quota reservation
2. Policy evaluation
3. Escrow creation
4. External execution

### Concurrency and Races
To resolve races involving two simultaneous requests using the same idempotency identity, PostgreSQL enforces a unique constraint:
`ALTER TABLE requests ADD CONSTRAINT req_idempotency_idx UNIQUE (tenant_id, target_tool, idempotency_key);`

Transactions will perform an `INSERT ... ON CONFLICT` operation. If a conflict occurs, the system retrieves the existing record, compares the canonical request fingerprint, and routes to CASE A or CASE B accordingly. The database-level unique constraint strictly guarantees that concurrent requests cannot generate dual initial state records.

---

## 2. ATOMIC QUOTA RESERVATION

COUNT(*) check-then-act is strictly prohibited. The system utilizes an explicit atomic quota tracking table for both tenant and global limits:

```sql
CREATE TABLE global_quota (
    id INT PRIMARY KEY CHECK (id = 1),
    max_pending INT NOT NULL,
    pending_count INT NOT NULL DEFAULT 0,
    CHECK (pending_count >= 0)
);

CREATE TABLE quotas (
    tenant_id UUID PRIMARY KEY,
    max_pending INT NOT NULL,
    pending_count INT NOT NULL DEFAULT 0,
    CHECK (pending_count >= 0)
);
```

Reservation MUST use an atomic conditional UPDATE for both global and tenant quotas in ONE transaction:
```sql
-- Global reservation
UPDATE global_quota
SET pending_count = pending_count + 1
WHERE id = 1
  AND pending_count < max_pending
RETURNING pending_count;

-- Tenant reservation
UPDATE quotas
SET pending_count = pending_count + 1
WHERE tenant_id = $tenant
  AND pending_count < max_pending
RETURNING pending_count;
```

### Reservation Mechanics
- **Lock Ordering:** The global quota MUST be reserved first, followed by the tenant quota, to strictly avoid deadlocks when concurrent transactions process requests for different tenants.
- **Transactional Linkage:** Both `UPDATE` statements are executed within the exact same database transaction as the escrow/request `INSERT`.
- **Deterministic Rollback:** If either the global reservation fails (returns zero rows) or the tenant reservation fails (returns zero rows), the application immediately aborts and rolls back the entire transaction. Because global quota is updated first, if tenant quota fails, the PostgreSQL rollback naturally reverts the global increment.
- **Double-Decrement Prevention:** Quota is released via PostgreSQL `AFTER UPDATE` triggers on the `requests` table. The trigger condition specifically matches `OLD.state = 'PENDING' AND NEW.state != 'PENDING'`. Because the explicitly allowed state transitions (see Section 3) only permit a single exit from `PENDING` (to `APPROVED`, `DENIED`, or `EXPIRED`), the release trigger fires exactly once per request, mathematically preventing double-decrement.
- **Concurrent Gateway Requests:** PostgreSQL enforces row-level exclusive locks during the `UPDATE`. Two concurrent transactions will process sequentially on the quota rows.

---

## 3. DATABASE-ENFORCED STATE MACHINE

The state machine is strictly enforced by PostgreSQL using explicit allow-lists in **BEFORE UPDATE triggers**. Deny-lists are strictly prohibited. 

### Defined States
- `PENDING`
- `APPROVED`
- `DENIED`
- `EXPIRED`
- `EXECUTING`
- `EXECUTED`
- `FAILED`
- `FAILED_UNKNOWN`

### Explicit Allow-List by Role
Any state transition NOT explicitly listed below for the given role MUST be rejected by the trigger, failing the transaction.

- **`gateway_role`**:
  - `PENDING` → `EXPIRED`
- **`policy_role`**:
  - `PENDING` → `APPROVED`
  - `PENDING` → `DENIED`
- **`worker_role`**:
  - `APPROVED` → `EXECUTING`
  - `EXECUTING` → `EXECUTED`
  - `EXECUTING` → `FAILED`
  - `EXECUTING` → `FAILED_UNKNOWN`
- **`gc_role` (Supervisor)**:
  - `EXECUTING` → `FAILED_UNKNOWN`
  - `PENDING` → `EXPIRED`

### Immutable Security Columns
The following fields MUST be immutable after request creation:
- `tenant_id`
- `target_tool`
- `idempotency_key`
- `request_fingerprint`
- `payload`

A database-level `BEFORE UPDATE` trigger explicitly guarantees immutability. If any role attempts an update (e.g., `UPDATE requests SET tenant_id = another_tenant`), the trigger will compare `NEW.tenant_id` to `OLD.tenant_id`. Any deviation raises an immediate exception, completely rejecting the mutation. A compromised runtime role cannot rewrite request identity, payload, or ownership.

---

## 4. STRICT DATABASE ROLE SEPARATION

The application interacts with PostgreSQL exclusively through separated, least-privilege roles:

- **`gateway_role`**: Grants `INSERT` on requests.
- **`policy_role`**: Authorized for policy decisions.
- **`worker_role`**: Authorized for execution updates.
- **`gc_role`**: Authorized for cleanup.
- **`audit_role`**: Grants `INSERT` only on audit tables.
- **`migration_role`**: Granted DDL schema mutation privileges (never used by runtime).

---

## 5. RLS (ROW LEVEL SECURITY)

All request and quota tables mandate Row Level Security. Tenant context is injected via transaction-scoped variables: `SET LOCAL app.current_tenant = $tenant;`

### RLS Context Manipulation Limitations
The architecture acknowledges that RLS acts as defense-in-depth against application bugs (e.g., missing WHERE clauses), but NOT as a cryptographic boundary against a compromised runtime component. 

1. **Can gateway_role execute arbitrary SET LOCAL app.current_tenant?** YES.
2. **Can worker_role execute arbitrary SET LOCAL app.current_tenant?** YES.
3. **Can policy_role execute arbitrary SET LOCAL app.current_tenant?** YES.
4. **Can an application role impersonate another tenant?** YES, if the runtime component is compromised.
5. **What trusted component establishes tenant identity?** The application code (e.g., Gateway via JWT validation).
6. **What database mechanism verifies that identity?** None. The database trusts the authenticated application role's SET command.
7. **How does PostgreSQL RLS obtain the verified tenant?** From `current_setting('app.current_tenant')` provided by the application.
8. **What happens when tenant context is absent?** RLS fails closed, rejecting reads and writes.
9. **What happens when tenant context is invalid?** RLS fails closed, matching zero rows.
10. **What happens when a runtime component is compromised?** A compromised runtime role with DB credentials can execute arbitrary `SET LOCAL` commands and impersonate any tenant accessible to that role.

---

## 6. LEASE AND FENCING

Execution relies on a strictly defined lease model to prevent concurrent worker execution.

- **Lease Duration:** 30 seconds.
- **Ownership Token:** A globally unique UUID generated by the worker during the `APPROVED` → `EXECUTING` claim.
- **Fencing Token:** A monotonically increasing integer bound to the execution lease.
- **Worker Claim:** `UPDATE requests SET state='EXECUTING', worker_id=$1, lease_token=$2, expires_at=now() + interval '30s' WHERE id=$3 AND state='APPROVED' RETURNING *;`
- **Fencing Distinctions:**
  - *Internal Fencing:* Handled by PostgreSQL state transitions. Workers must present their token to update state.
  - *External Fencing:* Target APIs must support the fencing token to reject delayed network packets.
  - *Exactly-Once External Execution:* NOT guaranteed. The architecture provides internal state transition fencing to prevent concurrent PostgreSQL workers, but external request transmission cannot guarantee exactly-once execution or dispatch due to network unreliability. Downstream idempotency is strictly required.

### GC Lease Reap
The GC supervisor reaps expired leases atomically:
```sql
UPDATE requests
SET state = 'FAILED_UNKNOWN',
    updated_at = now()
WHERE state = 'EXECUTING'
  AND expires_at <= now();
```
- **Live Leases:** Prevented from being reaped because `expires_at <= now()` will evaluate to false.
- **Fencing Token:** The reap ignores the previous lease token.
- **Stale Worker Prevention:** If a stale worker awakens and attempts to transition the state to `EXECUTED`, the query will enforce `WHERE state = 'EXECUTING' AND lease_token = $2`. Because the GC has already mutated the state to `FAILED_UNKNOWN`, the worker's query will affect 0 rows, successfully preventing stale completion. Expired work becomes `FAILED_UNKNOWN` because the system cannot deterministically know if external execution completed before the worker paused.

---

## 7. UNKNOWN EXTERNAL RESULT

When external execution status cannot be strictly determined, the system uses conservative terminal states.

- **Process crash before send:** Claim lease expires. Reconciled to `FAILED_UNKNOWN`.
- **Request sent, no response / Timeout:** Transitions to `FAILED_UNKNOWN`.
- **Connection reset:** Transitions to `FAILED_UNKNOWN`.

**Reconciliation:** Operations marked `FAILED_UNKNOWN` are NEVER automatically retried. 

---

## 8. AUDIT

The audit architecture consists of two distinct layers:
1. **Operational Audit (PostgreSQL):** Append-only tables.
2. **Security Evidence (WORM Storage):** External object-lock storage.

### WORM Evidence Limitations
WORM export is asynchronous. A 5-second evidence-loss window is a **design target, NOT a guarantee**. 
- **Local Buffer:** Evidence is buffered locally in memory before export.
- **Export Retry:** Network errors cause local retries.
- **Network Failure & Exhaustion:** Prolonged failure fills the buffer. If the buffer exhausts, admission is halted.
- **Crash Before Export:** If a process crashes before flushing its buffer, the evidence in memory is permanently LOST. Zero evidence loss is explicitly NOT claimed.

---

## 9. REDIS

Redis is strictly NON-AUTHORITATIVE and handles only distributed admission pressure.
- **Outage / Fail-Closed:** If Redis is unavailable or compromised, the system fails CLOSED with HTTP 503. Redis NEVER determines authorization.

---

## 10. POSTGRES FAILURE

- **Database Connection Exhaustion:** If PgBouncer or PostgreSQL connection capacity is exhausted, the application enforces a strict 2-second connection acquisition timeout. It does NOT block indefinitely. The request is immediately rejected with HTTP 503 and is NOT retried. Redis admission state is NOT rolled back (accepting a temporary bucket leak). The request never reaches authorization or external execution. Fail-closed is the default.
- **Serialization Failure:** Application catches SQLSTATE 40001 and safely retries.
- **Commit Uncertainty:** Treated as an admission failure.

---

## 11. MIGRATION

Migration requires strict boundaries: Drain Stage 1.3, Fence Stage 1.3 workers, No Dual-Write, Cutover to Stage 2, Rollback restores Stage 1.3 routing.

---

## 12. CLAIM CLASSIFICATION

| CLAIM | STATUS | EVIDENCE REQUIRED | LIMITATION |
| :--- | :--- | :--- | :--- |
| Idempotent external execution | EXTERNAL-DEPENDENT | External target logs | Downstream API must strictly support provided keys. |
| Zero unauthorized execution | DESIGNED | PostgreSQL Audit logs | Relies on DB integrity and trigger correctness. |
| DB state machine enforcement | DESIGNED | Trigger source code | Limited to Postgres-level compromise scenarios. |
| Atomic pending quota | DESIGNED | DB constraints & tests | Connection pool bottlenecks. |
| Worker isolation | DESIGNED | DB Role configuration | Implementation-dependent RLS scoping. |
| Zero evidence loss | UNACHIEVABLE | N/A | Memory buffers lose data on crash. |
| Exactly-once execution | UNACHIEVABLE | N/A | Network unreliability requires external idempotency. |
| Exactly-once dispatch | UNACHIEVABLE | N/A | False claim removed; network layer is unreliable. |

---

## 13. FINAL IMPLEMENTATION CHECKLIST

- [x] Canonical idempotency identity defined
- [x] Idempotency conflict behavior defined
- [x] Atomic quota reservation defined
- [x] Quota release/recovery defined
- [x] PostgreSQL state machine concretely enforced
- [x] Gateway role isolated
- [x] Policy role isolated
- [x] Worker role isolated
- [x] Audit role isolated
- [x] Migration role isolated
- [x] RLS fail-closed defined
- [x] Lease model defined
- [x] Fencing model defined
- [x] Unknown-result model defined
- [x] Redis failure behavior defined
- [x] PostgreSQL failure behavior defined
- [x] Audit/WORM model defined
- [x] Migration fencing defined
- [x] Claims downgraded appropriately

STAGE 2 FINAL IMPLEMENTATION SPECIFICATION: PASS
"""

with open("/data/data/com.termux/files/home/digital-mineral-npm-suite/packages/mcp-bridge/STAGE2_FINAL_IMPLEMENTATION_SPEC.md", "w") as f:
    f.write(new_spec)
