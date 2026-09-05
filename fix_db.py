with open('src/core/db.ts', 'r') as f:
    ts = f.read()

ts = ts.replace("client.query('RESET ROLE; RESET app.tenant_token; RESET app.current_tenant;')", "client.query('DISCARD ALL;')")

with open('src/core/db.ts', 'w') as f:
    f.write(ts)
