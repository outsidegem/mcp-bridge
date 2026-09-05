import { getClient, releaseClient, DbRole } from './db.js';

export class Stage2GC {
    async reapStale(tenantId: string) {
        const client = await getClient(DbRole.GC, tenantId);
        try {
            await client.query('BEGIN');
            const res = await client.query(`
                UPDATE requests
                SET state = 'FAILED_UNKNOWN',
                    updated_at = now()
                WHERE state = 'EXECUTING' AND expires_at <= now()
                RETURNING *
            `);
            await client.query('COMMIT');
            releaseClient(client);
            return { success: true, reaped: res.rowCount };
        } catch (e) {
            await client.query('ROLLBACK');
            releaseClient(client);
            return { success: false, error: e.message };
        }
    }
}
