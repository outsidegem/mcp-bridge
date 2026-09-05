const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });
const { v4: uuidv4 } = require('uuid');

async function run() {
    const client = await pool.connect();
    try {
        const tid = '00000000-0000-0000-0000-000000000001';
        
        // create a valid request in EXECUTING state
        const reqId = '00000000-0000-0000-0000-000000000099';
        const leaseToken = uuidv4();
        await client.query("DELETE FROM requests WHERE id = $1", [reqId]);
        
        // Bypass trigger using replica trigger or just SET session_replication_role
        await client.query("SET session_replication_role = replica;");
        await client.query("INSERT INTO requests (id, tenant_id, target_tool, idempotency_key, request_fingerprint, payload, state, lease_token, expires_at) VALUES ($1, $2, 't', 'k99', 'h99', '{}', 'EXECUTING', $3, now() + interval '10 minutes')", [reqId, tid, leaseToken]);
        await client.query("SET session_replication_role = DEFAULT;");

        await client.query("SET ROLE worker_role");
        const crypto = require('crypto');
        const sig = crypto.createHmac('sha256', 'stage2-secret-key-12345').update(tid).digest('hex');
        await client.query(`SET app.tenant_token = '${tid}.${sig}'`);
        
        // Attack 1: Try to resolve without the correct lease token
        const res = await client.query("SELECT worker_resolve_request($1, $2, 'EXECUTED')", [reqId, uuidv4()]);
        console.log("Wrong Token Result:", res.rows[0].worker_resolve_request);

        // Attack 2: Try to resolve WITH NULL lease token
        const resNull = await client.query("SELECT worker_resolve_request($1, NULL, 'EXECUTED')", [reqId]);
        console.log("Null Token Result:", resNull.rows[0].worker_resolve_request);

        // Attack 3: Hijack search path!
        await client.query("CREATE TEMP TABLE requests (id UUID, state TEXT, tenant_id UUID, lease_token UUID, expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)");
        await client.query("INSERT INTO requests VALUES ($1, 'EXECUTING', $2, $3, now() + interval '10 minutes', now())", [reqId, tid, leaseToken]);
        const resHijack = await client.query("SELECT worker_resolve_request($1, $2, 'EXECUTED')", [reqId, leaseToken]);
        console.log("Hijacked Result:", resHijack.rows[0].worker_resolve_request);
        
        // Did the real table get updated?
        await client.query("RESET ROLE");
        const real = await client.query("SELECT state FROM public.requests WHERE id = $1", [reqId]);
        console.log("Real DB State:", real.rows[0].state);

    } catch(e) {
        console.log("Worker Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
