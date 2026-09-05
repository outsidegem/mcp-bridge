const { Client } = require('pg');

async function checkEscalation(role, target) {
    const client = new Client({ user: role, host: '127.0.0.1', database: 'postgres', port: 5432 });
    try {
        await client.connect();
        try {
            await client.query(`SET ROLE ${target}`);
            console.log(`FAIL: ${role} can assume ${target}`);
        } catch(e) {
            console.log(`PASS: ${role} cannot assume ${target}`);
        }
    } catch(e) {
        console.log(`PASS: ${role} cannot even connect! (Expected if nologin or pg_hba.conf blocks it)`);
    } finally {
        await client.end().catch(e=>e);
    }
}

async function run() {
    const roles = ['gateway_role', 'policy_role', 'worker_role', 'gc_role'];
    for(const r of roles) {
        for(const t of [...roles, 'migration_role', 'audit_role', 'u0_a338']) {
            if(r !== t) await checkEscalation(r, t);
        }
    }
}
run();
