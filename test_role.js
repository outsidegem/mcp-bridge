const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("CREATE OR REPLACE FUNCTION test_role() RETURNS text AS $$ BEGIN RETURN current_setting('role', true); END; $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;");
        
        await client.query("SET ROLE gateway_role");
        const res = await client.query("SELECT test_role()");
        console.log("Role:", res.rows[0].test_role);
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
