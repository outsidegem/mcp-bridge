# STAGE 2 THREAT MODEL

## 15. TRUST BOUNDARIES

### Trust Boundary Model

```
[ Agent ]  (Untrusted)
    | (1) HTTP / Auth Token
    v
[ API Gateway ] (Trusted Enclave)
    | (2) Local Function Call
    v
[ Policy Engine ] (Trusted Enclave)
    | (3) SQL / TCP
    v
[ PostgreSQL Shared State ] (Trusted Core)
    | (4) SQL / TCP
    v
[ Execution Worker ] (Trusted Enclave)
    | (5) HTTPS / Network
    v
[ External Service ] (Untrusted / Partner)
```

### Boundary Definitions

1. **Agent -> Gateway**: 
   - Authentication: Bearer tokens/JWT.
   - Authorization: None initially, gateway handles identity context.
   - Integrity: TLS.
   - Replay Protection: Idempotency keys required on mutating endpoints.
   - Tenant Binding: Gateway enforces token tenant-ID against request.
   - Failure: Gateway fails closed (401/403) on auth failure.
   - Attacker Capability: Fully adversarial. Can fuzz, spam, replay, mutate headers.

2. **Gateway -> Policy Engine**:
   - Internal boundary (same process). Memory boundary only.
   - Attacker Capability: Cannot bypass Gateway to hit Policy Engine directly.

3. **Gateway -> Shared State (PostgreSQL)**:
   - Authentication: DB Credentials (IAM / Password).
   - Integrity: TLS.
   - Failure: Gateway fails closed (503) if DB is down.
   - Attacker Capability: An attacker on the internal network could try to intercept or inject DB queries.

4. **Worker -> Shared State (PostgreSQL)**:
   - Identical to Gateway -> Shared State.

5. **Worker -> External Service**:
   - Authentication: Outbound credentials fetched from CredentialProvider.
   - Integrity: TLS.
   - Replay Protection: External-dependent (idempotency headers).
   - Failure: Worker records `FAILED` or times out (Unknown Result).
   - Attacker Capability: The target service might be malicious (SSRF target, DNS rebinding, malformed response payload).

---

## 16. THREAT MODEL

### 1. External Attacker
- **Attack:** Floods the Gateway with unauthenticated requests.
- **Affected Invariant:** Resource bounds, Availability.
- **Mitigation:** API Gateway rate limiting drops unauthenticated traffic before hitting PostgreSQL.
- **Residual Risk:** Volumetric DDoS.

### 2. Malicious Agent
- **Attack:** Submits 1,000,000 requests to exhaust tenant quota and DB connections.
- **Affected Invariant:** Resource Exhaustion.
- **Mitigation:** DB limits maximum `PENDING` states per tenant to 1,000. Subsequent requests fail closed.
- **Residual Risk:** The agent can DoS its own tenant (noisy neighbor isolated).

### 3. Compromised Gateway
- **Attack:** RCE on a Gateway instance bypasses the Policy Engine.
- **Affected Invariant:** Authorization Integrity.
- **Mitigation:** Network isolation. Principle of least privilege for the DB role (Gateway can only `INSERT` PENDING escrows and `UPDATE` APPROVED escrows, it cannot `EXECUTE`).
- **Residual Risk:** Attacker can spoof approvals if DB roles are not sufficiently split.

### 4. Compromised Worker
- **Attack:** RCE on an execution worker.
- **Affected Invariant:** Execution Isolation, Audit Integrity.
- **Mitigation:** Execution workers run in isolated sandboxes. They only pull `APPROVED` requests.
- **Residual Risk:** Worker could exfiltrate outbound credentials.

### 5. Stale Worker
- **Attack:** Worker pauses for 60 seconds (GC pause), its lease expires, Worker B executes the job. Worker A wakes up and executes the job again.
- **Affected Invariant:** Duplicate Execution.
- **Mitigation:** Soft fencing (Worker checks clock). Hard fencing (fencing tokens to external API).
- **Residual Risk:** If external API ignores fencing tokens, duplicate side-effects occur.

### 6. Malicious Tenant
- **Attack:** Attempts to guess approval IDs or idempotency keys of another tenant.
- **Affected Invariant:** Tenant Isolation.
- **Mitigation:** Composite indexes and strict `WHERE tenant_id = $X` on all SQL queries. UUIDv4 for escrow IDs.
- **Residual Risk:** Negligible.

### 7. Database Compromise
- **Attack:** Attacker gains write access to PostgreSQL.
- **Affected Invariant:** ALL invariants.
- **Mitigation:** DB requires strong IAM auth, VPC isolation, and KMS encryption.
- **Residual Risk:** Complete system compromise. Database is the root of trust.

### 8. Network Attacker
- **Attack:** DNS Rebinding during execution.
- **Affected Invariant:** SSRF Protection.
- **Mitigation:** NetworkValidator re-verifies IPs on every redirect.
- **Residual Risk:** Zero-day vulnerabilities in Node.js URL parser.

### 9. External Service Failure
- **Attack:** External service times out after 29.9 seconds.
- **Affected Invariant:** Deterministic Execution State.
- **Mitigation:** Worker records `FAILED` with generic timeout.
- **Residual Risk:** The external service may have actually committed the transaction. "Unknown Result" state is unavoidable.

### 10. Replay Attacker
- **Attack:** Intercepts and replays an authorized execution payload.
- **Affected Invariant:** Authorization Integrity.
- **Mitigation:** TLS on all boundaries. Idempotency keys prevent duplicate logic execution on the Gateway.
- **Residual Risk:** External replay (outside Titan's boundary) is external-dependent.

### 11. Race-Condition Attacker
- **Attack:** Sends `approve` and `deny` at the exact same millisecond across two Gateways.
- **Affected Invariant:** State Machine Integrity.
- **Mitigation:** Optimistic Concurrency Control (`UPDATE ... WHERE version = X`). Only one wins.
- **Residual Risk:** None. PostgreSQL serializes the transaction.

### 12. Resource-Exhaustion Attacker
- **Attack:** Forces the database to store massive JSON argument payloads in `escrow_requests`.
- **Affected Invariant:** Disk/Memory bounds.
- **Mitigation:** Gateway enforces 2MB payload limit. PostgreSQL quotas can further restrict disk usage.
- **Residual Risk:** Database performance degradation under heavy load.
