const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("DELETE FROM quotas WHERE tenant_id = '00000000-0000-0000-0000-000000000001'");
        await client.query("INSERT INTO quotas (tenant_id, max_pending, pending_count) VALUES ('00000000-0000-0000-0000-000000000001', 5, 5)");

        await client.query("SET ROLE gateway_role");
        await client.query("SET app.current_tenant = '00000000-0000-0000-0000-000000000001'");
        
        await client.query("UPDATE quotas SET pending_count = pending_count + 1 WHERE tenant_id = '00000000-0000-0000-0000-000000000001'");
        
        const res = await client.query("SELECT pending_count, max_pending FROM quotas WHERE tenant_id = '00000000-0000-0000-0000-000000000001'");
        console.log("Quota exceeded:", res.rows[0]);
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
