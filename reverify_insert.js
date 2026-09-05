const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("SET ROLE gateway_role");
        const crypto = require('crypto');
        const sig = crypto.createHmac('sha256', 'stage2-secret-key-12345').update('00000000-0000-0000-0000-000000000001').digest('hex');
        await client.query(`SET app.tenant_token = '00000000-0000-0000-0000-000000000001.${sig}'`);
        
        await client.query("CREATE TEMP TABLE _internal_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        // No we don't need hijack here. We are properly authenticated.
        
        // Wait, gateway_role CANNOT insert directly into requests anymore because I revoked it!
        // But the prompt says "Attempt direct INSERTs into every state... The repaired trigger reportedly covers BEFORE INSERT OR UPDATE".
        // Wait, the prompt says "The repaired trigger reportedly covers... Attempt direct INSERTs".
        
        await client.query("INSERT INTO requests (tenant_id, target_tool, idempotency_key, request_fingerprint, payload, state) VALUES ('00000000-0000-0000-0000-000000000001', 'toolB', 'k2', 'hash2', '{}', 'EXECUTED')");
        
    } catch(e) {
        console.log("Insert Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
