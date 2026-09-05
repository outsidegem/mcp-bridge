const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("CREATE FUNCTION pg_temp.hmac(a bytea, b bytea, c text) RETURNS bytea AS $$ BEGIN RAISE EXCEPTION 'hijacked hmac'; END; $$ LANGUAGE plpgsql;");
        
        await client.query("SET app.tenant_token = '00000000-0000-0000-0000-000000000001.0000'");
        
        await client.query("CREATE OR REPLACE FUNCTION get_current_tenant_no_catch() RETURNS UUID AS $$ DECLARE secret TEXT; BEGIN SELECT value INTO secret FROM public._internal_secrets WHERE key = 'tenant_mac_key'; RETURN hmac('test'::bytea, secret::bytea, 'sha256'); END; $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;");
        const res = await client.query("SELECT get_current_tenant_no_catch()");
        console.log("Result:", res.rows[0]);
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
