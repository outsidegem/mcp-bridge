const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("DELETE FROM requests");
        
        // Setup state
        await client.query("INSERT INTO requests (id, tenant_id, target_tool, idempotency_key, request_fingerprint, payload, state, lease_token) VALUES ('00000000-0000-0000-0000-000000000099', '00000000-0000-0000-0000-000000000001', 'tool1', 'key1', 'hash1', '{}', 'EXECUTING', '11111111-1111-1111-1111-111111111111')");

        await client.query("SET ROLE worker_role");
        await client.query("SET app.current_tenant = '00000000-0000-0000-0000-000000000001'");
        
        // Attacker worker completes the lease without knowing lease_token
        await client.query("UPDATE requests SET state = 'EXECUTED' WHERE id = '00000000-0000-0000-0000-000000000099'");
        const res = await client.query("SELECT state FROM requests WHERE id = '00000000-0000-0000-0000-000000000099'");
        console.log("State:", res.rows[0].state);
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
