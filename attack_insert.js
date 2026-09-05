const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("DELETE FROM requests WHERE idempotency_key = 'hacked123'");

        await client.query("SET ROLE gateway_role");
        await client.query("SET app.current_tenant = '00000000-0000-0000-0000-000000000001'");
        
        await client.query("INSERT INTO requests (tenant_id, target_tool, idempotency_key, request_fingerprint, payload, state) VALUES ('00000000-0000-0000-0000-000000000001', 'tool1', 'hacked123', 'hash', '{}', 'EXECUTED')");
        
        const res = await client.query("SELECT state FROM requests WHERE idempotency_key = 'hacked123'");
        console.log("Forged state on insert:", res.rows[0].state);
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
