import { getClient, releaseClient, DbRole } from './db.js';
import { v4 as uuidv4 } from 'uuid';

export class Stage2Worker {
    async execute(requestId: string, tenantId: string) {
        const client = await getClient(DbRole.WORKER, tenantId);
        const leaseToken = uuidv4();
        const workerId = uuidv4();

        try {
            await client.query('BEGIN');
            const claim = await client.query(`
                UPDATE requests
                SET state = 'EXECUTING',
                    worker_id = $1,
                    lease_token = $2,
                    expires_at = now() + interval '30 seconds'
                WHERE id = $3 AND state = 'APPROVED'
                RETURNING *
            `, [workerId, leaseToken, requestId]);

            if (claim.rowCount === 0) {
                await client.query('ROLLBACK');
                releaseClient(client);
                return { success: false, error: 'Could not claim request' };
            }
            await client.query('COMMIT');
            
            // SIMULATE EXTERNAL EXECUTION
            const isSuccess = Math.random() > 0.5;
            
            await client.query('BEGIN');
            const resolve = await client.query(`
                UPDATE requests
                SET state = $1
                WHERE id = $2 AND state = 'EXECUTING' AND lease_token = $3
                RETURNING *
            `, [isSuccess ? 'EXECUTED' : 'FAILED', requestId, leaseToken]);

            if (resolve.rowCount === 0) {
                await client.query('ROLLBACK');
                releaseClient(client);
                return { success: false, error: 'Failed to resolve (stale worker)' };
            }
            await client.query('COMMIT');
            releaseClient(client);
            return { success: true, state: isSuccess ? 'EXECUTED' : 'FAILED' };
        } catch (e) {
            await client.query('ROLLBACK');
            releaseClient(client);
            return { success: false, error: e.message };
        }
    }
}
