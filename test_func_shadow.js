const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("CREATE FUNCTION public.my_func() RETURNS text AS $$ BEGIN RETURN 'real'; END; $$ LANGUAGE plpgsql;");
        await client.query("CREATE FUNCTION pg_temp.my_func() RETURNS text AS $$ BEGIN RETURN 'shadow'; END; $$ LANGUAGE plpgsql;");
        
        await client.query("SET search_path = public");
        const res = await client.query("SELECT my_func()");
        console.log("Result:", res.rows[0].my_func);
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
