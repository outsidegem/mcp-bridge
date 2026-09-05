with open('src/db/triggers.sql', 'r') as f:
    sql = f.read()

expr = "COALESCE(NULLIF(current_setting('role', true), 'none'), session_user)"
sql = sql.replace("session_user = 'gateway_role'", f"{expr} = 'gateway_role'")
sql = sql.replace("session_user = 'policy_role'", f"{expr} = 'policy_role'")
sql = sql.replace("session_user = 'worker_role'", f"{expr} = 'worker_role'")
sql = sql.replace("session_user = 'gc_role'", f"{expr} = 'gc_role'")

sql = sql.replace("session_user, prev_hash_val, curr_hash_val", f"{expr}, prev_hash_val, curr_hash_val")

with open('src/db/triggers.sql', 'w') as f:
    f.write(sql)
