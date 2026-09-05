with open('src/db/triggers.sql', 'r') as f:
    c = f.read()

c = c.replace("WHERE id = p_req_id AND state = 'APPROVED'", "WHERE id = p_req_id AND state = 'APPROVED' AND tenant_id = get_current_tenant()")
c = c.replace("WHERE id = p_req_id \n      AND state = 'EXECUTING'", "WHERE id = p_req_id \n      AND state = 'EXECUTING' \n      AND tenant_id = get_current_tenant()")

with open('src/db/triggers.sql', 'w') as f:
    f.write(c)
