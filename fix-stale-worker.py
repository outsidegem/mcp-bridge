with open('src/db/triggers.sql', 'r') as f:
    c = f.read()

old_logic = """        ELSIF current_user = 'worker_role' THEN
            IF NOT ((OLD.state = 'APPROVED' AND NEW.state = 'EXECUTING') OR
                    (OLD.state = 'EXECUTING' AND NEW.state IN ('EXECUTED', 'FAILED', 'FAILED_UNKNOWN'))) THEN
                RAISE EXCEPTION 'worker_role transition not allowed: % -> %', OLD.state, NEW.state;
            END IF;
        ELSIF"""

new_logic = """        ELSIF current_user = 'worker_role' THEN
            IF NOT ((OLD.state = 'APPROVED' AND NEW.state = 'EXECUTING') OR
                    (OLD.state = 'EXECUTING' AND NEW.state IN ('EXECUTED', 'FAILED', 'FAILED_UNKNOWN'))) THEN
                RAISE EXCEPTION 'worker_role transition not allowed: % -> %', OLD.state, NEW.state;
            END IF;

            IF OLD.state = 'EXECUTING' AND NEW.state IN ('EXECUTED', 'FAILED') THEN
                IF OLD.expires_at < now() THEN
                    RETURN NULL; -- Stale worker receives 0 rows
                END IF;
            END IF;
        ELSIF"""

c = c.replace(old_logic, new_logic)

with open('src/db/triggers.sql', 'w') as f:
    f.write(c)
