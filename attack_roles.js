const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("SET ROLE gateway_role");
        await client.query("SET app.current_tenant = '00000000-0000-0000-0000-000000000001'");
        
        // Attempt to change quota limits directly
        await client.query("UPDATE quotas SET max_pending = 9999 WHERE tenant_id = '00000000-0000-0000-0000-000000000001'");
        console.log("Gateway modified max_pending");
    } catch(e) {
        console.log("Gateway max_pending Error:", e.message);
    }
    try {
        // Attempt to insert quotas
        await client.query("INSERT INTO quotas (tenant_id, max_pending) VALUES ('00000000-0000-0000-0000-000000000002', 999)");
        console.log("Gateway inserted quotas");
    } catch(e) {
        console.log("Gateway insert quota Error:", e.message);
    }
    try {
        // Attempt to set APPROVED
        await client.query("UPDATE requests SET state = 'APPROVED' WHERE tenant_id = '00000000-0000-0000-0000-000000000001'");
        console.log("Gateway set APPROVED");
    } catch(e) {
        console.log("Gateway set APPROVED Error:", e.message);
    }
    
    await client.query("RESET ROLE");
    await client.query("SET ROLE policy_role");
    await client.query("SET app.current_tenant = '00000000-0000-0000-0000-000000000001'");
    try {
        await client.query("UPDATE requests SET state = 'EXECUTING' WHERE tenant_id = '00000000-0000-0000-0000-000000000001'");
        console.log("Policy set EXECUTING");
    } catch(e) {
        console.log("Policy set EXECUTING Error:", e.message);
    }
    try {
        // Attempt to modify payload
        await client.query("UPDATE requests SET payload = '{\"hacked\": true}' WHERE tenant_id = '00000000-0000-0000-0000-000000000001'");
        console.log("Policy modified payload");
    } catch(e) {
        console.log("Policy payload Error:", e.message);
    }

    client.release();
    pool.end();
}
run();
