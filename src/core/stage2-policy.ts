import { getClient, releaseClient, DbRole } from './db.js';

export class Stage2PolicyEngine {
    async evaluate(requestId: string, tenantId: string, decision: 'APPROVED' | 'DENIED') {
        const client = await getClient(DbRole.POLICY, tenantId);
        try {
            await client.query('BEGIN');
            const res = await client.query(`
                UPDATE requests
                SET state = $1
                WHERE id = $2 AND state = 'PENDING'
                RETURNING *
            `, [decision, requestId]);
            
            if (res.rowCount === 0) {
                await client.query('ROLLBACK');
                releaseClient(client);
                return { success: false, error: 'Request not found or not in PENDING state' };
            }
            await client.query('COMMIT');
            releaseClient(client);
            return { success: true, state: decision };
        } catch (e) {
            await client.query('ROLLBACK');
            releaseClient(client);
            return { success: false, error: e.message };
        }
    }
}
