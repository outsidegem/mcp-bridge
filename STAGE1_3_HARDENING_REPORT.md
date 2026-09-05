# STAGE 1.3 HARDENING REPORT

## 1. Executive Summary
This report documents the remediation and architectural enhancements implemented during Stage 1.3 of the Agent Firewall project. Based on the Stage 1.2 Adversarial Audit, we successfully resolved critical gaps in resource exhaustion, downstream error leakage, and schema validation. The security invariants established in prior stages were rigorously preserved, and 34 adversarial tests now prove the resilience of the single-node execution boundary.

## 2. Stage 1.2 Findings Addressed
- **HIGH:** Escrow Memory Resource Exhaustion. Unbounded growth in the `LocalEscrowAdapter` Map and secondary indexes has been completely mitigated via deterministic TTLs and capacity limits.
- **MEDIUM:** Downstream Error Leakage. `McpGateway` was leaking raw `fetch` and DNS error stack strings to the HTTP response. It now consistently sanitizes underlying executor errors into generic safe responses.
- **LOW:** Placeholder Schema Validation. The stub `validateSchema` was replaced with a robust JSON Schema recursive validator supporting `required`, `enum`, `additionalProperties: false`, and type checking.
- **INFORMATIONAL:** Object Mutability. Returned objects from `LocalEscrowAdapter` were thoroughly validated to ensure `deepCopy` immutability is maintained at all boundary layers.

## 3. Resource-Bounding Design
The `LocalEscrowAdapter` implements strict resource bounding across both internal data structures (`store` and `requestToEscrowId`). 
- **Capacity Limit:** A hard capacity limit (`MAX_PENDING = 1000`) acts as a safeguard. If a malicious agent generates randomized `requestId` values at scale, the adapter fails closed, protecting process memory.
- **TTL / Expiration Model:** A deterministic `5-minute` TTL is applied to all records. The `cleanupExpired()` routine is invoked synchronously upon any state access, purging both the primary `store` and secondary index safely.
- **Terminal States:** Terminal states (`EXECUTED`, `FAILED`, `DENIED`) do not persist beyond the TTL, maintaining memory hygiene while preventing identical `requestId` replays from bypassing the human-approval requirement.

## 4. Error Disclosure Controls
The `McpGateway` executor wrapper was modified to actively scrub exceptions originating from the `SecureHttpExecutor` or `NetworkValidator`.
- If an execution fails due to a network timeout (`Request Timeout`) or an upstream service failure (`HTTP Error:`), these safe, generalized messages are returned.
- If DNS rebinding fails, sockets close prematurely, or internal JS engine exceptions occur (e.g., `ENOTFOUND internal-db.local`), the error is scrubbed to a generic `"Internal execution error"`. Internal logs maintain the full diagnostic trace.

## 5. Schema Validation
The `PolicyEngine` now benefits from actual schema validation before protected evaluation:
- Type checking (`object`, `array`, `string`, `number`, `boolean`, `null`).
- Structural enforcement (`required`, `additionalProperties`).
- Value constraints (`enum`).
Invalid arguments immediately return HTTP `403 Malformed arguments`, failing cleanly before interacting with execution or escrow pipelines.

## 6. Mutability Protection
All state returned by the `LocalEscrowAdapter` is passed through a deep-copy clone. We verified via adversarial test (`Hardening 22`) that fetching a record, deeply modifying nested properties (e.g. `record.status`, `record.request.agent.tenantId`), and subsequently interacting with the adapter does not alter the underlying source of truth.

## 7. Concurrency & Isolation
- **Concurrency Behavior:** Tests confirm the Node.js event loop atomicity successfully protects simultaneous HTTP approvals (`Promise.all` up to 20 concurrent requests), resulting in exactly one `APPROVED` state.
- **Tenant Isolation:** Cross-tenant reads and approvals natively fail closed (`403 Tenant mismatch`). 
- **SSRF Preservation:** The `NetworkValidator` remains intact and correctly blocks local IPs, IPv6 local, decimal encodings, and Cloud Metadata IPs.

## 8. Resource Measurements
During adversarial stress testing (`Hardening 24`), a simulated attack generated 1,100 unique Escrow requests:
- **Initial Escrow records:** 0
- **Final Escrow records:** 1000
- **Maximum observed store size:** 1000
- **Maximum observed requestToEscrowId size:** 1000
- **TTL:** 300,000ms (5 minutes)
- **Configured maximum:** 1000
- **Requests generated:** 1100
- **Records retained:** 1000
- **Records reclaimed:** 0 (Testing capacity limit explicitly without TTL wait)
- **Outcome:** Retained state remains bounded. The final 100 requests were successfully rejected with `500 Maximum pending escrows reached`.

## 9. Security Claims
### PROVEN
- An Escrow record cannot be approved if the state is not `PENDING`.
- Double-approvals are atomically blocked, enforcing at-most-once transition into `EXECUTING`.
- Cross-tenant access is blocked unless possessing the explicit `ADMIN` role.
- SSRF protections reject all tested variations of internal targeting.
- Malformed downstream exceptions are scrubbed from external observability.
- The `LocalEscrowAdapter` cannot exceed `1000` concurrent pending records.
- TTL expiration deterministic race logic safely yields `404 Not Found` when competing with a simultaneous approval.

### NOT PROVEN
- *Stage 1.3 does not establish exactly-once execution of an external side effect across process crashes, network ambiguity, or external service retries.*
- System behavior in a horizontally scaled, multi-process environment (requires Stage 2).

## 10. Remaining Limitations
The current `LocalEscrowAdapter` and `RateLimiter` are explicitly limited to a single Node.js process memory scope. They are vulnerable to data loss upon process restart and do not synchronize state across multiple instances. Stage 2 must introduce a distributed datastore (e.g. Redis) to uphold these security models in a cloud-native architecture.
