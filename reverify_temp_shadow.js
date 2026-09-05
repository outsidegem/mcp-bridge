const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("CREATE OR REPLACE FUNCTION test_search_path() RETURNS text AS $$ BEGIN RETURN (SELECT value FROM _internal_secrets LIMIT 1); END; $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;");
        
        await client.query("CREATE TEMP TABLE _internal_secrets (value TEXT)");
        await client.query("INSERT INTO _internal_secrets VALUES ('hijacked')");
        
        const res = await client.query("SELECT test_search_path()");
        console.log("Result:", res.rows[0].test_search_path);
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
