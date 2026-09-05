const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const { getClient, DbRole, releaseClient } = require('./dist/core/db.js');
const { Stage2Gateway } = require('./dist/core/stage2-gateway.js');
const { Stage2PolicyEngine } = require('./dist/core/stage2-policy.js');
const { Stage2Worker } = require('./dist/core/stage2-worker.js');

async function run() {
    const tid = uuidv4();
    const c = await getClient(DbRole.MASTER);
    await c.query("INSERT INTO quotas (tenant_id, max_pending, pending_count) VALUES ($1, 10, 0)", [tid]);
    releaseClient(c);
    
    const gw = new Stage2Gateway();
    const res = await gw.handleRequest({tenantId: tid, targetTool: 't', idempotencyKey: 'k', payload: {}});
    
    const pol = new Stage2PolicyEngine();
    await pol.evaluate(res.id, tid, 'APPROVED');
    
    const w = new Stage2Worker();
    const wRes = await w.execute(res.id, tid);
    console.log(wRes);
    process.exit(0);
}
run();
