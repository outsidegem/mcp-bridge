with open('attack_race.js', 'r') as f:
    c = f.read()

old_q = """        const q = `
            WITH inserted AS (
                INSERT INTO requests (tenant_id, target_tool, idempotency_key, request_fingerprint, payload)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (tenant_id, target_tool, idempotency_key) DO NOTHING
                RETURNING *
            )
            SELECT *, 'inserted' as _source FROM inserted
            UNION ALL
            SELECT *, 'existing' as _source FROM requests 
            WHERE tenant_id = $1 AND target_tool = $2 AND idempotency_key = $3
        `;"""

new_q = """        const q = `SELECT reserve_request($2, $3, $4, $5) as r`;"""

c = c.replace(old_q, new_q)
c = c.replace("await c1.query(\"BEGIN\");", "await c1.query(\"BEGIN\");\n        await c1.query(\"SET ROLE gateway_role\");\n        await c1.query(\"SET app.tenant_token = '00000000-0000-0000-0000-000000000001.0772782b7db5f553f1ff29dd62fb6a7b74bd5358055a40b1df6ff655c6e838ff'\");")
c = c.replace("await c2.query(\"BEGIN\");", "await c2.query(\"BEGIN\");\n        await c2.query(\"SET ROLE gateway_role\");\n        await c2.query(\"SET app.tenant_token = '00000000-0000-0000-0000-000000000001.0772782b7db5f553f1ff29dd62fb6a7b74bd5358055a40b1df6ff655c6e838ff'\");")

with open('attack_race.js', 'w') as f:
    f.write(c)
