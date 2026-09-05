# STAGE 1.1 SECURITY HARDENING REPORT

## 1. Findings
During the initial Stage-1 implementation review, several structural authorization and concurrency weaknesses were identified within the Escrow subsystem:
- **Check-Then-Act Concurrency:** The orchestrator evaluated `status === 'PENDING'` and subsequently updated it. Simultaneous network requests could bypass this, both seeing `PENDING` and proceeding to execute the request twice.
- **Leaked Read Access:** Operators could retrieve `EscrowRecord` objects from the registry without validating their tenant bounds.
- **Tenant Mismatches:** Approvals did not cryptographically verify that the operator approving the request belonged to the originating agent's tenant.
- **Information Disclosure:** Internal stack traces from the `McpGateway` or downstream executors could leak directly in the HTTP 500 response body.

## 2. Fixes
To resolve these findings safely without breaking the recovered legacy architecture, the following hardening was applied:
- Replaced the direct `getRecord()` and `updateRecord()` modifications with explicit domain transition methods in `adapter.ts` (e.g. `approveAndBeginExecution`, `denyRequest`). 
- Centralized `authorizeAccess` guards that assert `operator.tenantId === record.tenantId` for all actions, explicitly factoring in `ADMIN` roles.
- Sanitized `catch (e)` paths within the `server/index.ts` handler to emit generic `"Internal server error"` while deferring precise strings to the `AuditLogger`.
- Updated test suites to reflect actual Promise-based concurrency and rigorous tenant boundaries.

## 3. State Machine
The implemented atomic lifecycle exists synchronously within `adapter.ts`:
```
PENDING
   │
   ├──→ DENIED
   │
   ├──→ EXPIRED
   │
   └──→ EXECUTING
          │
          ├──→ EXECUTED (On Success)
          │
          └──→ FAILED (On Thrown Execution Exception)
```
Invalid transitions (such as executing a FAILED record, or approving a DENIED record) immediately throw generic `Invalid state transition` exceptions.

## 4. Tenant Model
Escrow boundaries are implicitly aligned with the Tenant of the Agent that initially generated the execution request. 
- Validation: `operator.tenantId === record.request.agent.tenantId`.
- The `ADMIN` role is globally authorized to manage cross-tenant Escrow actions for auditing and centralized administration. 
- Attempting to inspect or operate on a record belonging to another tenant securely throws `Tenant mismatch` resulting in HTTP 403.

## 5. Concurrency Model
JavaScript event-loop properties execute map lookups and reassignments sequentially. Because `approveAndBeginExecution` operates directly inside the `LocalEscrowAdapter`, any `Promise.all` attempts to approve the exact same record immediately race. The first frame atomically alters `status` to `EXECUTING`, causing the subsequent frame to hit `if (record.status !== 'PENDING') throw new Error('Invalid state transition');` returning HTTP 400. Thus, concurrent requests produce exactly one authenticated downstream execution.

## 6. Tests
- **Total Tests Run:** 23 tests total (18 integration tests + 5 unit tests).
- **Tests Passed:** 23 / 23
- **Tests Failed:** 0 / 23
- All tests pass strictly without timing fluctuations or warnings.

## 7. Adversarial Results
- **Simultaneous Approvals:** `Promise.all([approve, approve])` evaluated. Outcome: 200 and 400 responses. Exactly one execution tracked. 
- **Cross-tenant Approvals:** Attempted approval using operator out-of-tenant. Outcome: HTTP 403 `Tenant mismatch`.
- **Cross-tenant Escrow Reads:** Attempted retrieval using operator out-of-tenant. Outcome: HTTP 403 `Tenant mismatch`.
- **Approval After Denial:** Attempted execution on previously denied Escrow. Outcome: HTTP 400 `Invalid state transition`.
- **Execution After Failed Execution:** Attempted to re-approve a record that threw exceptions downstream. Outcome: HTTP 400 `Invalid state transition`.
- **Direct State Manipulation:** Attempted to artificially patch Escrow map structure manually via unknown REST methods (`PATCH`). Outcome: HTTP 404.
- **Sensitive Error Disclosure:** Forced an exception downstream inside `McpGateway`. Outcome: HTTP 500 emitted purely `"Internal server error"` while `FAILED` was properly recorded locally.

## 8. Remaining Production Gaps
Stage 1.1 achieves strict correctness under local runtime assumptions, but is not considered production-ready.
- **In-Memory State:** Restarting the Node process completely purges active Escrows and rate limits.
- **Static Policies:** Gateway routes and access policies are strictly hardcoded.
- **Mock Authentication:** Authorization is driven by dummy tokens rather than verifiable asymmetric identities (OIDC/JWT).
- **Incomplete Schema Validation:** The JSON-schema evaluator is merely a stub.
- **Lack of Distributed Persistence:** Running a secondary HTTP Orchestrator node breaks atomicity since the Event Loop boundary is crossed.
- **No Agent Pay/Burn Bouncer integrations.**

## 9. Stage 2 Recommendation
Now that the atomic state-transition boundaries are precisely defined and tested, **moving to Redis is definitively the correct next engineering step**. 

By replacing the in-memory Maps with Redis hashes and Redlock (distributed locks), we can safely migrate this proven concurrency model across multiple Node instances in preparation for Kubernetes deployment. Extending the system prematurely to React or WebSockets would be counterproductive until horizontal state distribution is established.
