const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function checkEscalation(role, target) {
    const client = await pool.connect();
    try {
        await client.query(`SET ROLE ${role}`);
        try {
            await client.query(`SET ROLE ${target}`);
            console.log(`FAIL: ${role} can assume ${target}`);
        } catch(e) {
            console.log(`PASS: ${role} cannot assume ${target}`);
        }
        try {
            await client.query(`GRANT ${target} TO ${role}`);
            console.log(`FAIL: ${role} can GRANT ${target}`);
        } catch(e) {}
    } catch(e) {
    } finally {
        await client.query("RESET ROLE").catch(e=>e);
        client.release();
    }
}

async function run() {
    const roles = ['gateway_role', 'policy_role', 'worker_role', 'gc_role'];
    for(const r of roles) {
        for(const t of [...roles, 'migration_role', 'audit_role', 'u0_a338']) {
            if(r !== t) await checkEscalation(r, t);
        }
    }
    pool.end();
}
run();
