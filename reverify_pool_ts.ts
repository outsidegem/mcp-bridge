import { getClient, DbRole, releaseClient } from './src/core/db.js';

async function run() {
    const c1 = await getClient(DbRole.WORKER);
    await c1.query("CREATE TEMP TABLE requests (id UUID)");
    releaseClient(c1);
    
    // Wait for release
    await new Promise(r => setTimeout(r, 100));
    
    const c2 = await getClient(DbRole.WORKER);
    try {
        const res = await c2.query("SELECT count(*) FROM requests");
        console.log("Rows:", res.rows[0].count);
    } catch(e) {
        console.log("Error:", e.message);
    }
    releaseClient(c2);
    process.exit(0);
}
run();
