const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("INSERT INTO quotas (tenant_id, max_pending) VALUES ('00000000-0000-0000-0000-000000000001', 10) ON CONFLICT DO NOTHING");
        await client.query("INSERT INTO requests (tenant_id, target_tool, idempotency_key, request_fingerprint, payload) VALUES ('00000000-0000-0000-0000-000000000001', 'tool1', 'key1', 'hash1', '{}') ON CONFLICT DO NOTHING");

        await client.query("SET ROLE gateway_role");
        await client.query("SET app.current_tenant = '00000000-0000-0000-0000-000000000002'");
        await client.query("SET app.current_tenant = '00000000-0000-0000-0000-000000000001'");
        
        const res = await client.query("SELECT * FROM requests");
        console.log("Gateway attacker retrieved rows:", res.rows.length);
        if (res.rows.length > 0) {
            console.log("CRITICAL RLS BYPASS SUCCESSFUL");
        }
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
