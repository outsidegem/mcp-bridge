const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432, max: 20 });

async function run() {
    // Clear out
    const c0 = await pool.connect();
    await c0.query("DELETE FROM requests WHERE idempotency_key = 'race1'");
    await c0.query("INSERT INTO quotas (tenant_id, max_pending) VALUES ('00000000-0000-0000-0000-000000000001', 10) ON CONFLICT DO NOTHING");
    c0.release();

    const p1 = pool.connect();
    const p2 = pool.connect();
    const [c1, c2] = await Promise.all([p1, p2]);

    try {
        await c1.query("BEGIN");
        await c1.query("SET ROLE gateway_role");
        await c1.query("SET app.tenant_token = '00000000-0000-0000-0000-000000000001.d59059329c02a494d5b7e2748be82fae200fcf121110567e90f8ba1efde7a077'");
        await c2.query("BEGIN");
        await c2.query("SET ROLE gateway_role");
        await c2.query("SET app.tenant_token = '00000000-0000-0000-0000-000000000001.d59059329c02a494d5b7e2748be82fae200fcf121110567e90f8ba1efde7a077'");

        const q = `SELECT reserve_request($1::text, $2::text, $3::text, $4::jsonb) as r`;
        const args = ['tool1', 'race1', 'hash', '{}'];

        // Start c1
        const res1Promise = c1.query(q, args);
        // Wait a bit to ensure c1 starts inserting
        await new Promise(r => setTimeout(r, 50));
        // Start c2
        const res2Promise = c2.query(q, args);
        
        await new Promise(r => setTimeout(r, 50));
        await c1.query("COMMIT");
        await c2.query("COMMIT");

        const res1 = await res1Promise.catch(e => e);
        const res2 = await res2Promise.catch(e => e);
        
        console.log("Res1 rows:", res1.rows.length, res1.rows[0]?._source);
        console.log("Res2 rows:", res2.rows.length, res2.rows[0]?._source);
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        c1.release();
        c2.release();
        pool.end();
    }
}
run();
