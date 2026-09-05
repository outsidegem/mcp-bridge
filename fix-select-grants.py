with open('src/db/triggers.sql', 'r') as f:
    c = f.read()

c = c.replace("GRANT SELECT (id, tenant_id, target_tool, idempotency_key, request_fingerprint, payload, state, expires_at, created_at, updated_at, worker_id) ON requests TO worker_role;", "GRANT SELECT (id, tenant_id, target_tool, idempotency_key, request_fingerprint, payload, state, expires_at, created_at, updated_at, worker_id, lease_token) ON requests TO worker_role;\nGRANT UPDATE (state, updated_at) ON requests TO worker_role;")

with open('src/db/triggers.sql', 'w') as f:
    f.write(c)
