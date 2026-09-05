const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("SET ROLE gateway_role");
        const crypto = require('crypto');
        const sig = crypto.createHmac('sha256', 'stage2-secret-key-12345').update('00000000-0000-0000-0000-000000000001').digest('hex');
        await client.query(`SET app.tenant_token = '00000000-0000-0000-0000-000000000001.${sig}'`);
        
        await client.query("SELECT reserve_request('toolX', 'idemX', 'hashX', '{}')");
        
        await client.query("RESET ROLE");
        const res = await client.query("SELECT actor_role FROM audit_log ORDER BY seq DESC LIMIT 1");
        console.log("Audit Actor:", res.rows[0].actor_role);
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
