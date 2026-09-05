import { getClient, releaseClient, DbRole } from './db.js';
import { v4 as uuidv4 } from 'uuid';

export class Stage2Worker {
    async execute(requestId: string, tenantId: string) {
        const client = await getClient(DbRole.WORKER, tenantId);
        const leaseToken = uuidv4();
        const workerId = uuidv4();

        try {
            await client.query('BEGIN');
            const claimRes = await client.query(`
                SELECT worker_claim_request($1, $2, $3) AS r
            `, [requestId, workerId, leaseToken]);
            const claim = claimRes.rows[0].r;

            if (!claim.success) {
                await client.query('ROLLBACK');
                releaseClient(client);
                return { success: false, error: 'Could not claim request' };
            }
            await client.query('COMMIT');
            
            // SIMULATE EXTERNAL EXECUTION
            const isSuccess = Math.random() > 0.5;
            
            await client.query('BEGIN');
            const resolveRes = await client.query(`
                SELECT worker_resolve_request($1, $2, $3) AS r
            `, [requestId, leaseToken, isSuccess ? 'EXECUTED' : 'FAILED']);
            const resolve = resolveRes.rows[0].r;

            if (!resolve.success) {
                await client.query('ROLLBACK');
                releaseClient(client);
                return { success: false, error: 'Failed to resolve (stale worker)' };
            }
            await client.query('COMMIT');
            releaseClient(client);
            return { success: true, state: isSuccess ? 'EXECUTED' : 'FAILED' };
        } catch (e: any) {
            await client.query('ROLLBACK');
            releaseClient(client);
            return { success: false, error: e.message };
        }
    }
}
