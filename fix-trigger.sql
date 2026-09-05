CREATE OR REPLACE FUNCTION enforce_state_machine()
RETURNS TRIGGER AS $$
BEGIN
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
$$ LANGUAGE plpgsql; -- REMOVED SECURITY DEFINER
