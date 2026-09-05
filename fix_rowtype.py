with open('src/db/triggers.sql', 'r') as f:
    sql = f.read()

sql = sql.replace("v_req requests%ROWTYPE;", "v_req public.requests%ROWTYPE;")

with open('src/db/triggers.sql', 'w') as f:
    f.write(sql)
