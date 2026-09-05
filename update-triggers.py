import re

with open('src/db/triggers.sql', 'r') as f:
    content = f.read()

# Replace get_current_tenant()
old_tenant_func = """CREATE OR REPLACE FUNCTION get_current_tenant() RETURNS UUID AS $$
BEGIN
    RETURN current_setting('app.current_tenant', true)::UUID;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;"""

new_tenant_func = """CREATE OR REPLACE FUNCTION get_current_tenant() RETURNS UUID AS $$
DECLARE
    token TEXT;
    payload TEXT;
    sig TEXT;
    expected_sig TEXT;
    secret TEXT;
BEGIN
    token := current_setting('app.tenant_token', true);
    IF token IS NULL OR token = '' THEN RETURN NULL; END IF;

    payload := split_part(token, '.', 1);
    sig := split_part(token, '.', 2);

    SELECT value INTO secret FROM _internal_secrets WHERE key = 'tenant_mac_key';
    expected_sig := encode(hmac(payload::bytea, secret::bytea, 'sha256'), 'hex');

    IF sig = expected_sig THEN
        RETURN payload::UUID;
    ELSE
        RETURN NULL;
    END IF;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;"""

content = content.replace(old_tenant_func, new_tenant_func)

# Fix INSERT state enforcement in enforce_state_machine
old_enforce = """    -- Immutable security columns
    IF TG_OP = 'UPDATE' THEN"""

new_enforce = """    IF TG_OP = 'INSERT' THEN
        IF NEW.state != 'PENDING' THEN
            RAISE EXCEPTION 'Initial state must be PENDING';
        END IF;
    END IF;

    -- Immutable security columns
    IF TG_OP = 'UPDATE' THEN"""
    
content = content.replace(old_enforce, new_enforce)

# Change trigger to BEFORE INSERT OR UPDATE
old_trigger = """CREATE TRIGGER enforce_state_machine_trigger
    BEFORE UPDATE ON requests"""

new_trigger = """CREATE TRIGGER enforce_state_machine_trigger
    BEFORE INSERT OR UPDATE ON requests"""
content = content.replace(old_trigger, new_trigger)

# Revoke INSERT/UPDATE from gateway/worker to enforce using functions
old_grants = """GRANT SELECT, UPDATE ON global_quota TO gateway_role, worker_role, policy_role;
GRANT SELECT, UPDATE, INSERT ON quotas TO gateway_role;
GRANT SELECT ON quotas TO worker_role, policy_role;
GRANT SELECT, INSERT ON requests TO gateway_role;
GRANT UPDATE (state, updated_at) ON requests TO gateway_role; -- Gateway only updates to EXPIRED
GRANT SELECT, UPDATE (state, updated_at) ON requests TO policy_role;
GRANT SELECT, UPDATE (state, worker_id, lease_token, expires_at, updated_at) ON requests TO worker_role;
GRANT SELECT, UPDATE (state, updated_at) ON requests TO gc_role;"""

new_grants = """GRANT SELECT, UPDATE ON global_quota TO policy_role;
GRANT SELECT ON global_quota TO gateway_role, worker_role;
GRANT SELECT ON quotas TO gateway_role, worker_role, policy_role;
GRANT SELECT ON requests TO gateway_role;
GRANT SELECT, UPDATE (state, updated_at) ON requests TO policy_role;
GRANT SELECT (id, tenant_id, target_tool, idempotency_key, request_fingerprint, payload, state, expires_at, created_at, updated_at, worker_id) ON requests TO worker_role;
-- gc_role needs SELECT and UPDATE state for EXPIRED/FAILED_UNKNOWN
GRANT SELECT, UPDATE (state, updated_at) ON requests TO gc_role;
-- NOTE: gateway_role has NO INSERT/UPDATE on requests/quotas, worker_role has NO UPDATE on requests!
"""
content = content.replace(old_grants, new_grants)

# Append reservation and worker functions
functions = """

-- PHASE X — DB Enforced Operations

-- Reserve Request Atomically (Gateway)
CREATE OR REPLACE FUNCTION reserve_request(
    p_tool TEXT, p_idem TEXT, p_fingerprint TEXT, p_payload JSONB
) RETURNS jsonb AS $$
DECLARE
    v_tenant_id UUID;
    v_req requests%ROWTYPE;
BEGIN
    v_tenant_id := get_current_tenant();
    IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    LOOP
        INSERT INTO requests (tenant_id, target_tool, idempotency_key, request_fingerprint, payload)
        VALUES (v_tenant_id, p_tool, p_idem, p_fingerprint, p_payload)
        ON CONFLICT (tenant_id, target_tool, idempotency_key) DO NOTHING
        RETURNING * INTO v_req;

        IF FOUND THEN
            -- Reserved successfully
            UPDATE global_quota SET pending_count = pending_count + 1 WHERE id = 1 AND pending_count < max_pending;
            IF NOT FOUND THEN RAISE EXCEPTION 'Global quota exhausted' USING ERRCODE = 'check_violation'; END IF;

            UPDATE quotas SET pending_count = pending_count + 1 WHERE tenant_id = v_tenant_id AND pending_count < max_pending;
            IF NOT FOUND THEN RAISE EXCEPTION 'Tenant quota exhausted' USING ERRCODE = 'check_violation'; END IF;
            
            RETURN jsonb_build_object('status', 201, 'id', v_req.id, 'state', v_req.state);
        END IF;

        -- Conflict means it exists, fetch it
        SELECT * INTO v_req FROM requests 
        WHERE tenant_id = v_tenant_id AND target_tool = p_tool AND idempotency_key = p_idem;

        IF FOUND THEN
            IF v_req.request_fingerprint = p_fingerprint THEN
                RETURN jsonb_build_object('status', 200, 'state', v_req.state, 'existing', true);
            ELSE
                RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE = 'unique_violation';
            END IF;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION reserve_request TO gateway_role;

-- Worker Claim
CREATE OR REPLACE FUNCTION worker_claim_request(p_req_id UUID, p_worker_id UUID, p_lease_token UUID) RETURNS jsonb AS $$
DECLARE
    v_req requests%ROWTYPE;
BEGIN
    -- Only workers should claim
    IF current_user != 'worker_role' THEN RAISE EXCEPTION 'Permission denied'; END IF;

    UPDATE requests
    SET state = 'EXECUTING',
        worker_id = p_worker_id,
        lease_token = p_lease_token,
        expires_at = now() + interval '30 seconds',
        updated_at = now()
    WHERE id = p_req_id AND state = 'APPROVED'
    RETURNING * INTO v_req;

    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'id', v_req.id);
    ELSE
        RETURN jsonb_build_object('success', false, 'error', 'Could not claim request');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION worker_claim_request TO worker_role;

-- Worker Resolve
CREATE OR REPLACE FUNCTION worker_resolve_request(p_req_id UUID, p_lease_token UUID, p_state TEXT) RETURNS jsonb AS $$
DECLARE
    v_req requests%ROWTYPE;
BEGIN
    IF current_user != 'worker_role' THEN RAISE EXCEPTION 'Permission denied'; END IF;

    UPDATE requests
    SET state = p_state,
        updated_at = now()
    WHERE id = p_req_id 
      AND state = 'EXECUTING' 
      AND lease_token = p_lease_token 
      AND expires_at >= now()
    RETURNING * INTO v_req;

    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'state', v_req.state);
    ELSE
        RETURN jsonb_build_object('success', false, 'error', 'Failed to resolve (stale worker)');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION worker_resolve_request TO worker_role;
"""
content += functions

with open('src/db/triggers.sql', 'w') as f:
    f.write(content)
