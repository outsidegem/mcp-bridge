# Stage 1 Architecture Documentation

## Core Goal
The primary objective of Stage 1 is to demonstrate the fundamental security control loop of the Agent Firewall, ensuring that AI Agents cannot execute protected actions unless explicitly authorized by policy or human operators, and all attempts are logged auditable. 

## Architecture

```
[ HTTP Orchestrator ]
       │
       │ (1) POST /v1/execute
       ▼
[ McpGateway ] ─── (2) PolicyEngine (ALLOW, DENY, REQUIRE_APPROVAL)
       │
       ├─ (ALLOW) ──> [ SecureHttpExecutor ] (fetches URL safely via NetworkValidator)
       │
       ├─ (DENY) ──> Reject Request
       │
       └─ (REQUIRE_APPROVAL) ──> [ LocalEscrowAdapter (ExternalAuthorizationProvider) ]
                                    │
                                    └─> Throws EscrowPendingError
                                    │
<── (3) HTTP Orchestrator catches Error, responds 202 Accepted (PENDING)
```

## Escrow Adapter Pattern
The `ExternalAuthorizationProvider` interface is implemented by `LocalEscrowAdapter`. To prevent long-lived HTTP connections from blocking execution indefinitely while waiting for an operator, the adapter throws an `EscrowPendingError` when a new request is seen. The Orchestrator catches this exception and replies asynchronously with a `202 Accepted` status and an `approvalId`.

```
[ Operator ] 
       │ (4) POST /v1/escrow/:id/approve
       ▼
[ HTTP Orchestrator ]
       │
       │ (5) Calls escrowAdapter.approveRequest(id, operator)
       │ (6) Adapter atomically transitions PENDING -> APPROVED 
       ▼
[ McpGateway ]
       │
       │ (7) Re-evaluates REQUIRE_APPROVAL
       │ (8) LocalEscrowAdapter sees APPROVED state, transitions to EXECUTING, returns true
       ▼
[ SecureHttpExecutor ] ──> Executes Request
```

## Escrow State Machine (Stage 1.3)

To strictly enforce safe concurrency, the Escrow uses an atomic state machine contained entirely inside the `LocalEscrowAdapter`. The HTTP endpoints orchestrate logic using explicit domain actions rather than manipulating states manually.

### States
- `PENDING`: Initial state when approval is required.
- `APPROVED`: Authorization granted by an operator, pending execution in the Gateway.
- `DENIED`: Human operator permanently rejected the request.
- `EXECUTING`: Approval consumed, currently running via `McpGateway`.
- `EXECUTED`: Execution finished successfully.
- `FAILED`: Execution threw an error.
- `EXPIRED`: Request reached TTL before approval.

### Valid Transitions
- `PENDING` -> `APPROVED` (via `approveRequest`)
- `PENDING` -> `DENIED` (via `denyRequest`)
- `PENDING` -> `EXPIRED` (via TTL cleanup)
- `APPROVED` -> `EXECUTING` (via `requestApproval` in Gateway)
- `APPROVED` / `EXECUTING` -> `EXECUTED` (via `completeExecution`)
- `APPROVED` / `EXECUTING` -> `FAILED` (via `failExecution`)

### Invalid Transitions
- Any operation on `DENIED`, `EXECUTED`, or `FAILED` to transition back to `EXECUTING` or `APPROVED`.
- Double approval (`PENDING` -> `APPROVED` when it's already `APPROVED`). 

### Execution Authority and "Exactly-Once"
Execution is granted atomically by moving from `APPROVED` to `EXECUTING`. The Orchestrator is then bound to fulfill the request. If the execution errors (timeout, gateway error), the state resolves to `FAILED`, a terminal node in the state machine preventing accidental duplicate execution retries.

**Clarification on Exactly-Once Execution:** The current state machine proves "At-most-once authorization transition into EXECUTING within the current process." It does **NOT** prove absolute exactly-once external side effects across process crashes, network retries, external API ambiguity, worker restarts, or distributed execution. Distributed execution guarantees will require further architecture.

### Concurrency Behavior
Approval actions (`approveRequest` / `denyRequest`) are fully synchronous Map mutations in the Node.js event loop. Thus, race conditions created by simultaneous approval HTTP requests are safely avoided. Only one caller will observe `record.status === 'PENDING'`, transitioning the state immediately. The subsequent callers will be safely rejected with `Invalid state transition` (`400`). 

### Resource Bounding & Immutability (Stage 1.3)
- **TTL and Max Pending:** The in-memory store enforces a hard limit of `1000` pending records and a `5-minute` TTL, sweeping expired requests on every access to prevent unbounded memory growth.
- **Immutability:** Internal Escrow records are never exposed directly to external callers. Deep copies are used to prevent external mutation of internal adapter state.
- **Request Bounding:** HTTP request payloads are strictly limited to `2MB` to prevent memory exhaustion, and schemas are strictly validated recursively to reject malformed input.

### Tenant Ownership
Each `EscrowRecord` inherently tracks the `agent.tenantId` of the original `McpExecutionRequest`. 
- Operator approval or denial strictly demands that `operator.tenantId === record.request.agent.tenantId`.
- Reads via GET enforce the same isolation.
- `ADMIN` role is globally privileged and intentionally permitted to act cross-tenant.

## Reused Components (from Legacy MCP)
- **`McpGateway`:** Validates schema, rate limits, and routes to policy evaluation.
- **`PolicyEngine`:** Static rules for Tenant Isolation, RBAC, and Method-based approval logic.
- **`SecureHttpExecutor`:** Sandboxed HTTP client handling credentials and executing fetches.
- **`NetworkValidator`:** Advanced SSRF protection against Localhost and Cloud Metadata.
- **`AuditLogger`:** Redacts credentials and produces compliance-ready trails.
- **`CredentialProvider` / `RateLimiter`:** Standard utilities.

## Local Adaptations
- State is managed purely in-memory via simple Node Maps.
- A built-in NodeJS HTTP module functions as the HTTP Orchestrator to remain minimalist.
- Node `crypto.randomUUID()` generates unique IDs for Escrow records.
