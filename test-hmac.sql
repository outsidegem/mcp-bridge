CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE _internal_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO _internal_secrets VALUES ('mac', 'secret');
CREATE OR REPLACE FUNCTION verify_hmac(token TEXT) RETURNS UUID AS $$
DECLARE
    payload TEXT;
    sig TEXT;
    expected_sig TEXT;
    secret TEXT;
BEGIN
    payload := split_part(token, '.', 1);
    sig := split_part(token, '.', 2);
    SELECT value INTO secret FROM _internal_secrets WHERE key = 'mac';
    expected_sig := encode(hmac(payload::bytea, secret::bytea, 'sha256'), 'hex');
    IF sig = expected_sig THEN RETURN payload::UUID; ELSE RETURN NULL; END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
