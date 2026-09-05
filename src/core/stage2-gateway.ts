import { getClient, releaseClient, DbRole } from './db.js';
import { checkRateLimit } from './redis.js';
import crypto from 'crypto';

export class Stage2Gateway {
    async handleRequest(req: any) {
        // 1. Redis Rate Limit
        const allowed = await checkRateLimit(req.tenantId, 10, 60);
        if (!allowed) {
            return { status: 503, error: 'Rate limit exceeded or Redis down' };
        }

        // 2. Fingerprint
        const fingerprint = crypto.createHash('sha256')
            .update(JSON.stringify({
                tenant: req.tenantId,
                tool: req.targetTool,
                payload: req.payload
            }))
            .digest('hex');

        let client;
        try {
            client = await getClient(DbRole.GATEWAY, req.tenantId);
            await client.query('BEGIN');

            // 3. Idempotency & Escrow creation
            const insertQuery = `
                WITH inserted AS (
                    INSERT INTO requests (tenant_id, target_tool, idempotency_key, request_fingerprint, payload)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (tenant_id, target_tool, idempotency_key) DO NOTHING
                    RETURNING *
                )
                SELECT *, 'inserted' as _source FROM inserted
                UNION ALL
                SELECT *, 'existing' as _source FROM requests 
                WHERE tenant_id = $1 AND target_tool = $2 AND idempotency_key = $3
            `;
            const res = await client.query(insertQuery, [
                req.tenantId, req.targetTool, req.idempotencyKey, fingerprint, req.payload
            ]);

            const row = res.rows[0];
            if (row._source === 'existing') {
                await client.query('ROLLBACK');
                releaseClient(client);
                if (row.request_fingerprint === fingerprint) {
                    return { status: 200, result: row.state, existing: true }; // Idempotent replay
                } else {
                    return { status: 409, error: 'Idempotency conflict' }; // Conflict
                }
            }

            // 4. Atomic Quota Reservation
            // Global first
            const globalQuotaRes = await client.query(`
                UPDATE global_quota
                SET pending_count = pending_count + 1
                WHERE id = 1 AND pending_count < max_pending
                RETURNING pending_count
            `);
            if (globalQuotaRes.rowCount === 0) {
                await client.query('ROLLBACK');
                releaseClient(client);
                return { status: 429, error: 'Global quota exhausted' };
            }

            // Tenant second
            const tenantQuotaRes = await client.query(`
                UPDATE quotas
                SET pending_count = pending_count + 1
                WHERE tenant_id = $1 AND pending_count < max_pending
                RETURNING pending_count
            `, [req.tenantId]);
            if (tenantQuotaRes.rowCount === 0) {
                await client.query('ROLLBACK');
                releaseClient(client);
                return { status: 429, error: 'Tenant quota exhausted' };
            }

            await client.query('COMMIT');
            releaseClient(client);
            return { status: 201, id: row.id, state: row.state };
        } catch (e) {
            if (client) {
                await client.query('ROLLBACK');
                releaseClient(client);
            }
            console.error("DB Error: ", e); return { status: 503, error: 'Database error' };
        }
    }
}
