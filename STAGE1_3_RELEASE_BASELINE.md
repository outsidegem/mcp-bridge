# STAGE 1.3 RELEASE BASELINE

- **Date**: 2026-09-05T05:31:00Z
- **Branch**: main
- **HEAD Commit**: 8fbf09d1bed98547793b3dd76b95464629a5e5c2

## Test Results
- **Test Count**: 34 tests
- **Test Result**: PASS (34 passed, 0 failed)

## Security Findings
- **Critical**: 0
- **High**: 0
- **Medium**: 0
- **Low**: 0

## Resource Limits
- **TTL**: 300,000ms (5 minutes)
- **Capacity**: MAX_PENDING = 1,000 records
- **Store Bounding**: The `store` map is strictly bounded and actively cleaned up.
- **Secondary Index Bounding**: The `requestToEscrowId` map is strictly bounded and cleaned up synchronously alongside the primary store.

## Known Limitations
Stage 1.3 establishes security properties within the tested single-process execution model. It does not establish exactly-once external side effects across process crashes, network ambiguity, retries, or external-service behavior.
The `LocalEscrowAdapter` does not scale horizontally across multiple instances.

## Exact Security Claims (PROVEN)
- **Authorization**: Unauthorized users cannot approve, deny, execute, or inspect protected Escrow records.
- **Tenant Isolation**: Cross-tenant access is explicitly denied unless authorized by the ADMIN role.
- **State Machine**: Terminal states (`EXECUTED`, `DENIED`, `FAILED`, `EXPIRED`) strictly prohibit reopening or accidental duplicate execution.
- **Concurrency**: Simultaneous approvals, denials, and reads execute safely under Node.js single-thread boundaries, emitting exactly one valid state transition.
- **Resource Bounds**: Both `store` and `requestToEscrowId` maps are bound by a maximum pending capacity limit, failing closed to prevent resource exhaustion attacks.
- **TTL**: Expired records cannot be approved, executed, or resurrected.
- **Schema Validation**: Recursive JSON schema validation blocks malformed, missing, type-confused, or unexpected arguments from reaching the executor.
- **Error Isolation**: Raw downstream `fetch`, DNS, or generic Javascript errors are safely scrubbed into generic messages, avoiding internal diagnostic leakage.
- **SSRF**: Explicit SSRF guards accurately prevent local network targeting (localhost, 127.0.0.1, 0.0.0.0, cloud metadata).
- **Immutability**: Record state returned from adapters is isolated from source mutations via strict deep-copy clones.

## Explicit Non-Claims (NOT PROVEN)
- Exact-once external impact when the outbound execution encounters unpredictable network timeouts or target application retries.
- Cluster, cross-process, or horizontal scaling consistency.
