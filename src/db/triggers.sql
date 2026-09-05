-- PHASE B — RLS and database roles
ALTER TABLE requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE global_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION get_current_tenant() RETURNS UUID AS $$
BEGIN
    RETURN current_setting('app.current_tenant', true)::UUID;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE POLICY tenant_isolation_requests ON requests
    FOR ALL
    USING (tenant_id = get_current_tenant())
    WITH CHECK (tenant_id = get_current_tenant());

CREATE POLICY tenant_isolation_quotas ON quotas
    FOR ALL
    USING (tenant_id = get_current_tenant())
    WITH CHECK (tenant_id = get_current_tenant());

CREATE POLICY global_quota_policy ON global_quota
    FOR ALL
    USING (true)
    WITH CHECK (true);

CREATE POLICY tenant_isolation_audit ON audit_log
    FOR ALL
    USING (tenant_id = get_current_tenant())
    WITH CHECK (tenant_id = get_current_tenant());

GRANT SELECT, UPDATE ON global_quota TO gateway_role, worker_role, policy_role;
GRANT SELECT, UPDATE, INSERT ON quotas TO gateway_role;
GRANT SELECT ON quotas TO worker_role, policy_role;
GRANT SELECT, INSERT ON requests TO gateway_role;
GRANT UPDATE (state, updated_at) ON requests TO gateway_role; -- Gateway only updates to EXPIRED
GRANT SELECT, UPDATE (state, updated_at) ON requests TO policy_role;
GRANT SELECT, UPDATE (state, worker_id, lease_token, expires_at, updated_at) ON requests TO worker_role;
GRANT SELECT, UPDATE (state, updated_at) ON requests TO gc_role;
GRANT SELECT, INSERT ON audit_log TO audit_role;
-- To write audit, roles might need usage on sequence
GRANT USAGE, SELECT ON SEQUENCE audit_log_seq_seq TO audit_role;

-- Also let gateway/worker/policy invoke audit implicitly if we use trigger running as SECURITY DEFINER or granting them INSERT
-- Actually, the audit trigger is typically SECURITY DEFINER so it can run as audit_role.

-- PHASE C — State machine enforcement

CREATE OR REPLACE FUNCTION enforce_state_machine()
RETURNS TRIGGER AS $$
BEGIN
    -- Immutable security columns
    IF TG_OP = 'UPDATE' THEN
        IF NEW.tenant_id != OLD.tenant_id OR
           NEW.target_tool != OLD.target_tool OR
           NEW.idempotency_key != OLD.idempotency_key OR
           NEW.request_fingerprint != OLD.request_fingerprint OR
           NEW.payload::text != OLD.payload::text THEN
            RAISE EXCEPTION 'Immutable security columns cannot be modified';
        END IF;

        IF OLD.state IN ('DENIED', 'EXPIRED', 'EXECUTED', 'FAILED', 'FAILED_UNKNOWN') THEN
            RAISE EXCEPTION 'Cannot transition from a terminal state';
        END IF;

        -- Explicit allow-list by role
        IF current_user = 'gateway_role' THEN
            IF NOT (OLD.state = 'PENDING' AND NEW.state = 'EXPIRED') THEN
                RAISE EXCEPTION 'gateway_role can only transition PENDING -> EXPIRED';
            END IF;
        ELSIF current_user = 'policy_role' THEN
            IF NOT (OLD.state = 'PENDING' AND NEW.state IN ('APPROVED', 'DENIED')) THEN
                RAISE EXCEPTION 'policy_role can only transition PENDING -> APPROVED or DENIED';
            END IF;
        ELSIF current_user = 'worker_role' THEN
            IF NOT ((OLD.state = 'APPROVED' AND NEW.state = 'EXECUTING') OR
                    (OLD.state = 'EXECUTING' AND NEW.state IN ('EXECUTED', 'FAILED', 'FAILED_UNKNOWN'))) THEN
                RAISE EXCEPTION 'worker_role transition not allowed: % -> %', OLD.state, NEW.state;
            END IF;
        ELSIF current_user = 'gc_role' THEN
            IF NOT ((OLD.state = 'EXECUTING' AND NEW.state = 'FAILED_UNKNOWN') OR
                    (OLD.state = 'PENDING' AND NEW.state = 'EXPIRED')) THEN
                RAISE EXCEPTION 'gc_role transition not allowed: % -> %', OLD.state, NEW.state;
            END IF;
        END IF;
        
        NEW.updated_at = now();
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER enforce_state_machine_trigger
    BEFORE UPDATE ON requests
    FOR EACH ROW
    EXECUTE FUNCTION enforce_state_machine();


-- PHASE E — Quota Release Trigger

CREATE OR REPLACE FUNCTION release_quota_on_state_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.state = 'PENDING' AND NEW.state != 'PENDING' THEN
        UPDATE quotas SET pending_count = pending_count - 1 WHERE tenant_id = OLD.tenant_id;
        UPDATE global_quota SET pending_count = pending_count - 1 WHERE id = 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER release_quota_trigger
    AFTER UPDATE ON requests
    FOR EACH ROW
    EXECUTE FUNCTION release_quota_on_state_change();


-- PHASE I — Operational Audit Trigger

CREATE OR REPLACE FUNCTION audit_request_changes()
RETURNS TRIGGER AS $$
DECLARE
    prev_hash_val TEXT;
    curr_hash_val TEXT;
BEGIN
    -- get previous hash from the sequence of this request if needed, or global
    SELECT curr_hash INTO prev_hash_val FROM audit_log ORDER BY seq DESC LIMIT 1;
    
    curr_hash_val := encode(digest(COALESCE(prev_hash_val, '') || NEW.id::text || NEW.state || now()::text, 'sha256'), 'hex');

    INSERT INTO audit_log (request_id, tenant_id, state, actor_role, prev_hash, curr_hash)
    VALUES (NEW.id, NEW.tenant_id, NEW.state, current_user, prev_hash_val, curr_hash_val);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- create extension for pgcrypto to use digest
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TRIGGER audit_request_insert_trigger
    AFTER INSERT ON requests
    FOR EACH ROW
    EXECUTE FUNCTION audit_request_changes();

CREATE TRIGGER audit_request_update_trigger
    AFTER UPDATE ON requests
    FOR EACH ROW
    WHEN (OLD.state IS DISTINCT FROM NEW.state)
    EXECUTE FUNCTION audit_request_changes();
