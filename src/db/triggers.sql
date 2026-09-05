-- PHASE B — RLS and database roles
ALTER TABLE requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE global_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION get_current_tenant() RETURNS UUID AS $$
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

    SELECT value INTO secret FROM public._internal_secrets WHERE key = 'tenant_mac_key';
    expected_sig := encode(hmac(payload::bytea, secret::bytea, 'sha256'), 'hex');

    IF sig = expected_sig THEN
        RETURN payload::UUID;
    ELSE
        RETURN NULL;
    END IF;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE POLICY tenant_isolation_requests ON public.requests
    FOR ALL
    USING (tenant_id = get_current_tenant())
    WITH CHECK (tenant_id = get_current_tenant());

CREATE POLICY tenant_isolation_quotas ON public.quotas
    FOR ALL
    USING (tenant_id = get_current_tenant())
    WITH CHECK (tenant_id = get_current_tenant());

CREATE POLICY global_quota_policy ON public.global_quota
    FOR ALL
    USING (true)
    WITH CHECK (true);

CREATE POLICY tenant_isolation_audit ON public.audit_log
    FOR ALL
    USING (tenant_id = get_current_tenant())
    WITH CHECK (tenant_id = get_current_tenant());

GRANT SELECT, UPDATE ON public.global_quota TO policy_role;
GRANT SELECT ON public.global_quota TO gateway_role, worker_role;
GRANT SELECT ON public.quotas TO gateway_role, worker_role, policy_role;
GRANT SELECT ON public.requests TO gateway_role;
GRANT SELECT, UPDATE (state, updated_at) ON public.requests TO policy_role;
GRANT SELECT (id, tenant_id, target_tool, idempotency_key, request_fingerprint, payload, state, expires_at, created_at, updated_at, worker_id, lease_token) ON public.requests TO worker_role;
GRANT UPDATE (state, updated_at) ON public.requests TO worker_role;
-- gc_role needs SELECT and UPDATE state for EXPIRED/FAILED_UNKNOWN
GRANT SELECT, UPDATE (state, updated_at) ON public.requests TO gc_role;
-- NOTE: gateway_role has NO INSERT/UPDATE on requests/quotas, worker_role has NO UPDATE on requests!

GRANT SELECT, INSERT ON public.audit_log TO audit_role;
-- To write audit, roles might need usage on sequence
GRANT USAGE, SELECT ON SEQUENCE audit_log_seq_seq TO audit_role;

-- Also let gateway/worker/policy invoke audit implicitly if we use trigger running as SECURITY DEFINER or granting them INSERT
-- Actually, the audit trigger is typically SECURITY DEFINER so it can run as audit_role.

-- PHASE C — State machine enforcement

CREATE OR REPLACE FUNCTION enforce_state_machine()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.state != 'PENDING' THEN
            RAISE EXCEPTION 'Initial state must be PENDING';
        END IF;
    END IF;

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
        IF COALESCE(NULLIF(current_setting('role', true), 'none'), session_user) = 'gateway_role' THEN
            IF NOT (OLD.state = 'PENDING' AND NEW.state = 'EXPIRED') THEN
                RAISE EXCEPTION 'gateway_role can only transition PENDING -> EXPIRED';
            END IF;
        ELSIF COALESCE(NULLIF(current_setting('role', true), 'none'), session_user) = 'policy_role' THEN
            IF NOT (OLD.state = 'PENDING' AND NEW.state IN ('APPROVED', 'DENIED')) THEN
                RAISE EXCEPTION 'policy_role can only transition PENDING -> APPROVED or DENIED';
            END IF;
        ELSIF COALESCE(NULLIF(current_setting('role', true), 'none'), session_user) = 'worker_role' THEN
            IF NOT ((OLD.state = 'APPROVED' AND NEW.state = 'EXECUTING') OR
                    (OLD.state = 'EXECUTING' AND NEW.state IN ('EXECUTED', 'FAILED', 'FAILED_UNKNOWN'))) THEN
                RAISE EXCEPTION 'worker_role transition not allowed: % -> %', OLD.state, NEW.state;
            END IF;

            IF OLD.state = 'EXECUTING' AND NEW.state IN ('EXECUTED', 'FAILED') THEN
                IF OLD.expires_at < now() THEN
                    RETURN NULL; -- Stale worker receives 0 rows
                END IF;
            END IF;
        ELSIF COALESCE(NULLIF(current_setting('role', true), 'none'), session_user) = 'gc_role' THEN
            IF NOT ((OLD.state = 'EXECUTING' AND NEW.state = 'FAILED_UNKNOWN') OR
                    (OLD.state = 'PENDING' AND NEW.state = 'EXPIRED')) THEN
                RAISE EXCEPTION 'gc_role transition not allowed: % -> %', OLD.state, NEW.state;
            END IF;
        END IF;
        
        NEW.updated_at = now();
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER enforce_state_machine_trigger
    BEFORE INSERT OR UPDATE ON public.requests
    FOR EACH ROW
    EXECUTE FUNCTION enforce_state_machine();


-- PHASE E — Quota Release Trigger

CREATE OR REPLACE FUNCTION release_quota_on_state_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.state = 'PENDING' AND NEW.state != 'PENDING' THEN
        UPDATE public.quotas SET pending_count = pending_count - 1 WHERE tenant_id = OLD.tenant_id;
        UPDATE public.global_quota SET pending_count = pending_count - 1 WHERE id = 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER release_quota_trigger
    AFTER UPDATE ON public.requests
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
    SELECT curr_hash INTO prev_hash_val FROM public.audit_log ORDER BY seq DESC LIMIT 1;
    
    curr_hash_val := encode(digest(COALESCE(prev_hash_val, '') || NEW.id::text || NEW.state || now()::text, 'sha256'), 'hex');

    INSERT INTO public.audit_log (request_id, tenant_id, state, actor_role, prev_hash, curr_hash)
    VALUES (NEW.id, NEW.tenant_id, NEW.state, COALESCE(NULLIF(current_setting('role', true), 'none'), session_user), prev_hash_val, curr_hash_val);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- create extension for pgcrypto to use digest
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TRIGGER audit_request_insert_trigger
    AFTER INSERT ON public.requests
    FOR EACH ROW
    EXECUTE FUNCTION audit_request_changes();

CREATE TRIGGER audit_request_update_trigger
    AFTER UPDATE ON public.requests
    FOR EACH ROW
    WHEN (OLD.state IS DISTINCT FROM NEW.state)
    EXECUTE FUNCTION audit_request_changes();


-- PHASE X — DB Enforced Operations

-- Reserve Request Atomically (Gateway)
CREATE OR REPLACE FUNCTION reserve_request(
    p_tool TEXT, p_idem TEXT, p_fingerprint TEXT, p_payload JSONB
) RETURNS jsonb AS $$
DECLARE
    v_tenant_id UUID;
    v_req public.requests%ROWTYPE;
BEGIN
    v_tenant_id := get_current_tenant();
    IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    LOOP
        INSERT INTO public.requests (tenant_id, target_tool, idempotency_key, request_fingerprint, payload)
        VALUES (v_tenant_id, p_tool, p_idem, p_fingerprint, p_payload)
        ON CONFLICT (tenant_id, target_tool, idempotency_key) DO NOTHING
        RETURNING * INTO v_req;

        IF FOUND THEN
            -- Reserved successfully
            UPDATE public.global_quota SET pending_count = pending_count + 1 WHERE id = 1 AND pending_count < max_pending;
            IF NOT FOUND THEN RAISE EXCEPTION 'Global quota exhausted' USING ERRCODE = 'check_violation'; END IF;

            UPDATE public.quotas SET pending_count = pending_count + 1 WHERE tenant_id = v_tenant_id AND pending_count < max_pending;
            IF NOT FOUND THEN RAISE EXCEPTION 'Tenant quota exhausted' USING ERRCODE = 'check_violation'; END IF;
            
            RETURN jsonb_build_object('status', 201, 'id', v_req.id, 'state', v_req.state);
        END IF;

        -- Conflict means it exists, fetch it
        SELECT * INTO v_req FROM public.requests 
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION reserve_request FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_request TO gateway_role;

-- Worker Claim
CREATE OR REPLACE FUNCTION worker_claim_request(p_req_id UUID, p_worker_id UUID, p_lease_token UUID) RETURNS jsonb AS $$
DECLARE
    v_req public.requests%ROWTYPE;
BEGIN


    UPDATE public.requests
    SET state = 'EXECUTING',
        worker_id = p_worker_id,
        lease_token = p_lease_token,
        expires_at = now() + interval '30 seconds',
        updated_at = now()
    WHERE id = p_req_id AND state = 'APPROVED' AND tenant_id = get_current_tenant()
    RETURNING * INTO v_req;

    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'id', v_req.id);
    ELSE
        RETURN jsonb_build_object('success', false, 'error', 'Could not claim request');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION worker_claim_request FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker_claim_request TO worker_role;

-- Worker Resolve
CREATE OR REPLACE FUNCTION worker_resolve_request(p_req_id UUID, p_lease_token UUID, p_state TEXT) RETURNS jsonb AS $$
DECLARE
    v_req public.requests%ROWTYPE;
BEGIN


    UPDATE public.requests
    SET state = p_state,
        updated_at = now()
    WHERE id = p_req_id 
      AND state = 'EXECUTING' 
      AND tenant_id = get_current_tenant() 
      AND lease_token = p_lease_token 
      AND expires_at >= now()
    RETURNING * INTO v_req;

    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'state', v_req.state);
    ELSE
        RETURN jsonb_build_object('success', false, 'error', 'Failed to resolve (stale worker)');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION worker_resolve_request FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker_resolve_request TO worker_role;
