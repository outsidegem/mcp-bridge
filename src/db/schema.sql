-- PHASE A — Database schema and security primitives

-- Roles
CREATE ROLE gateway_role NOLOGIN;
CREATE ROLE policy_role NOLOGIN;
CREATE ROLE worker_role NOLOGIN;
CREATE ROLE gc_role NOLOGIN;
CREATE ROLE audit_role NOLOGIN;
CREATE ROLE migration_role NOLOGIN;

-- Secrets
CREATE TABLE _internal_secrets (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Populate tenant_mac_key from environment/session configuration during provisioning (never hardcode in SQL)
INSERT INTO _internal_secrets (key, value)
SELECT 'tenant_mac_key', current_setting('app.mcp_tenant_secret')
WHERE current_setting('app.mcp_tenant_secret', true) IS NOT NULL
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
REVOKE ALL ON _internal_secrets FROM PUBLIC, gateway_role, policy_role, worker_role, gc_role, audit_role;
GRANT SELECT ON _internal_secrets TO CURRENT_USER;


-- Global Quota Table
CREATE TABLE global_quota (
    id INT PRIMARY KEY CHECK (id = 1),
    max_pending INT NOT NULL,
    pending_count INT NOT NULL DEFAULT 0,
    CHECK (pending_count >= 0),
    CHECK (pending_count <= max_pending)
);

INSERT INTO global_quota (id, max_pending, pending_count) VALUES (1, 1000, 0) ON CONFLICT DO NOTHING;

-- Tenant Quotas Table
CREATE TABLE quotas (
    tenant_id UUID PRIMARY KEY,
    max_pending INT NOT NULL,
    pending_count INT NOT NULL DEFAULT 0,
    CHECK (pending_count >= 0),
    CHECK (pending_count <= max_pending)
);

INSERT INTO global_quota (id, max_pending, pending_count) VALUES (1, 1000, 0) ON CONFLICT DO NOTHING;

-- Requests Table
CREATE TABLE requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    target_tool TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    payload JSONB NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING',
    worker_id UUID,
    lease_token UUID,
    fencing_token BIGSERIAL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT req_idempotency_idx UNIQUE (tenant_id, target_tool, idempotency_key),
    CONSTRAINT valid_states CHECK (state IN ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'EXECUTING', 'EXECUTED', 'FAILED', 'FAILED_UNKNOWN'))
);

-- Audit Tables
CREATE TABLE audit_log (
    seq BIGSERIAL PRIMARY KEY,
    request_id UUID NOT NULL,
    tenant_id UUID NOT NULL,
    state TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_role TEXT NOT NULL,
    prev_hash TEXT,
    curr_hash TEXT
);

