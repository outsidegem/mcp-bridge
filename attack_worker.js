const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("SET ROLE worker_role");
        await client.query("SET app.current_tenant = '00000000-0000-0000-0000-000000000001'");
        
        try {
            await client.query("UPDATE requests SET state = 'APPROVED' WHERE tenant_id = '00000000-0000-0000-0000-000000000001'");
            console.log("Worker set APPROVED");
        } catch(e) {
            console.log("Worker set APPROVED Error:", e.message);
        }

        try {
            await client.query("UPDATE requests SET state = 'EXECUTED', lease_token = '00000000-0000-0000-0000-000000000003' WHERE tenant_id = '00000000-0000-0000-0000-000000000001'");
            console.log("Worker executed without valid lease");
        } catch(e) {
            console.log("Worker execute without lease Error:", e.message);
        }

    } finally {
        client.release();
        pool.end();
    }
}
run();
