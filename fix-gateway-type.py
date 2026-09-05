with open('src/core/stage2-gateway.ts', 'r') as f:
    c = f.read()

c = c.replace("SELECT reserve_request($1, $2, $3, $4) AS r", "SELECT reserve_request($1::text, $2::text, $3::text, $4::jsonb) AS r")
with open('src/core/stage2-gateway.ts', 'w') as f:
    f.write(c)
