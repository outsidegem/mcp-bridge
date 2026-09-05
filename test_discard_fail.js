const { getClient, releaseClient, DbRole } = require('./dist/core/db.js');
const { Pool } = require('pg');

async function run() {
    const c1 = await getClient(DbRole.GATEWAY);
    try {
        await c1.query("BEGIN");
        await c1.query("CREATE TEMP TABLE foo(a int)");
    } catch(e) {}
    
    // Release while in transaction! DISCARD ALL will fail.
    releaseClient(c1);
    
    // Wait a bit for async release
    await new Promise(r => setTimeout(r, 100));
    
    const c2 = await getClient(DbRole.GATEWAY);
    try {
        const res = await c2.query("SELECT * FROM foo");
        console.log("Foo exists!", res.rows);
    } catch(e) {
        console.log("Error:", e.message);
    }
    releaseClient(c2);
    process.exit(0);
}
run();
