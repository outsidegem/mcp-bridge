with open('src/db/triggers.sql', 'r') as f:
    c = f.read()

c = c.replace("    -- Only workers should claim\n    IF current_user != 'worker_role' THEN RAISE EXCEPTION 'Permission denied'; END IF;", "")
c = c.replace("    IF current_user != 'worker_role' THEN RAISE EXCEPTION 'Permission denied'; END IF;", "")

c = c.replace("GRANT EXECUTE ON FUNCTION reserve_request TO gateway_role;", "REVOKE EXECUTE ON FUNCTION reserve_request FROM PUBLIC;\nGRANT EXECUTE ON FUNCTION reserve_request TO gateway_role;")
c = c.replace("GRANT EXECUTE ON FUNCTION worker_claim_request TO worker_role;", "REVOKE EXECUTE ON FUNCTION worker_claim_request FROM PUBLIC;\nGRANT EXECUTE ON FUNCTION worker_claim_request TO worker_role;")
c = c.replace("GRANT EXECUTE ON FUNCTION worker_resolve_request TO worker_role;", "REVOKE EXECUTE ON FUNCTION worker_resolve_request FROM PUBLIC;\nGRANT EXECUTE ON FUNCTION worker_resolve_request TO worker_role;")

with open('src/db/triggers.sql', 'w') as f:
    f.write(c)
