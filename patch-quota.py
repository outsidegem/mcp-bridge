with open('attack_race.js', 'r') as f:
    c = f.read()

c = c.replace("await c0.query(\"DELETE FROM requests WHERE idempotency_key = 'race1'\");", "await c0.query(\"DELETE FROM requests WHERE idempotency_key = 'race1'\");\n    await c0.query(\"INSERT INTO quotas (tenant_id, max_pending) VALUES ('00000000-0000-0000-0000-000000000001', 10) ON CONFLICT DO NOTHING\");")
with open('attack_race.js', 'w') as f:
    f.write(c)
