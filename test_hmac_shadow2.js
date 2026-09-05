const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("CREATE FUNCTION pg_temp.hmac(bytea, bytea, text) RETURNS bytea AS $$ BEGIN RETURN '\\x0000'::bytea; END; $$ LANGUAGE plpgsql;");
        
        // Expected sig is encode(hmac(...), 'hex') => '0000'
        await client.query("SET app.tenant_token = '00000000-0000-0000-0000-000000000001.0000'");
        
        const res = await client.query("SELECT get_current_tenant()");
        console.log("Tenant:", res.rows[0].get_current_tenant);
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
