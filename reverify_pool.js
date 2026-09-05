const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432, max: 1 });

async function run() {
    // 1. Attacker poisons connection
    const c1 = await pool.connect();
    await c1.query("SET ROLE worker_role");
    await c1.query("CREATE TEMP TABLE requests (id UUID, tenant_id UUID, target_tool TEXT, idempotency_key TEXT, request_fingerprint TEXT, payload JSONB, state TEXT, worker_id UUID, lease_token UUID, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ, fencing_token BIGINT, updated_at TIMESTAMPTZ)");
    
    // Attacker resets role but temp table remains!
    await c1.query("RESET ROLE");
    c1.release();
    
    // 2. Real worker gets the same connection!
    const c2 = await pool.connect();
    try {
        await c2.query("SET ROLE worker_role");
        const res = await c2.query("SELECT count(*) FROM requests");
        console.log("Real worker sees rows in requests:", res.rows[0].count);
        // If it sees 0, it means the temp table is hiding the real requests!
    } catch(e) {
        console.log(e);
    } finally {
        c2.release();
    }
    pool.end();
}
run();
