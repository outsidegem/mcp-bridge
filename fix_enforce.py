with open('src/db/triggers.sql', 'r') as f:
    sql = f.read()

sql = sql.replace("IF current_user = 'gateway_role' THEN", "IF session_user = 'gateway_role' THEN")
sql = sql.replace("ELSIF current_user = 'policy_role' THEN", "ELSIF session_user = 'policy_role' THEN")
sql = sql.replace("ELSIF current_user = 'worker_role' THEN", "ELSIF session_user = 'worker_role' THEN")
sql = sql.replace("ELSIF current_user = 'gc_role' THEN", "ELSIF session_user = 'gc_role' THEN")

with open('src/db/triggers.sql', 'w') as f:
    f.write(sql)
