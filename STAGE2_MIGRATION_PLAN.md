# STAGE 2 MIGRATION PLAN

## 17. MIGRATION FROM STAGE 1.3

### 1. Adapter/Interface Boundary
Stage 1.3 defined the `ExternalAuthorizationProvider` interface. The `LocalEscrowAdapter` currently implements this interface using in-memory maps.
Stage 2 will introduce `DistributedEscrowAdapter` which implements the exact same interface but uses PostgreSQL as its backing store. The interface contract guarantees that the HTTP Orchestrator (`index.ts`) and `McpGateway` do not need architectural rewrites.

### 2. Compatibility Strategy
- Both `LocalEscrowAdapter` and `DistributedEscrowAdapter` will remain in the codebase.
- A feature flag (e.g., `ESCROW_STORE_TYPE=postgres`) will dictate which adapter is instantiated at startup.
- This ensures that local testing can still use the in-memory adapter without requiring a database, while production deployments use PostgreSQL.

### 3. State Migration
**Constraint:** The in-memory state of `LocalEscrowAdapter` is transient and short-lived (5-minute TTL). 
**Decision:** We will **NOT** migrate active state from memory to PostgreSQL.
**Rationale:** The operational risk and complexity of synchronizing milliseconds-old in-memory state into a new database schema is unjustified for data that expires in 5 minutes.
**Cutover Strategy:** A "drain and flip" approach.
1. Spin up the Stage 2 infrastructure (Gateway + Postgres).
2. Route new traffic to Stage 2.
3. Allow the Stage 1.3 instances to drain for 5 minutes (TTL expiry).
4. Terminate Stage 1.3 instances.

### 4. Verification Gates
Before production traffic is shifted, the following gates must pass in staging:
- **Gate 1:** Database Schema verification (Indexes, Unlogged tables for rate limiting, Partitions).
- **Gate 2:** Stage 2 Adversarial Test Suite passes 100% against the `DistributedEscrowAdapter`.
- **Gate 3:** Chaos tests (Kill Postgres primary, Kill Worker during execution) resolve as defined in the Threat Model.

### 5. Rollback Procedure
If the PostgreSQL integration exhibits catastrophic latency, connection exhaustion, or deadlocks:
1. Revert the load balancer configuration to point back to the `LocalEscrowAdapter` instances.
2. Any `PENDING` requests in PostgreSQL will be abandoned (they will natively expire).
3. Agents will automatically retry failed requests, which will hit the in-memory adapter.
**State inconsistency risk:** None. The two stores do not synchronize. An approval in Postgres cannot trigger an execution in the local memory adapter.

### 6. Emergency Abort Procedure
If a vulnerability is discovered where tenant isolation is failing at the database level:
1. Issue an immediate `SIGTERM` to all Gateways.
2. Drop all connections to PostgreSQL.
3. Deny all traffic at the external Load Balancer (Fail Closed).
4. Do not restart until the SQL queries are patched.
