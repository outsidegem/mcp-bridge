import re

with open('src/core/stage2-gateway.ts', 'r') as f:
    content = f.read()

old_logic = """            // 3. Idempotency & Escrow creation
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
            return { status: 201, id: row.id, state: row.state };"""

new_logic = """            // DB Enforced Atomic Reservation & Idempotency
            const res = await client.query(`SELECT reserve_request($1, $2, $3, $4) AS r`, [
                req.targetTool, req.idempotencyKey, fingerprint, req.payload
            ]);
            await client.query('COMMIT');
            releaseClient(client);
            const result = res.rows[0].r;
            if (result.existing) {
                return { status: result.status, result: result.state, existing: true };
            }
            return { status: result.status, id: result.id, state: result.state };"""

content = content.replace(old_logic, new_logic)

# Replace the catch block to handle PG exceptions
old_catch = """            console.error("DB Error: ", e); return { status: 503, error: 'Database error' };"""
new_catch = """            if (e.code === '23514' || e.message.includes('quota exhausted')) {
                return { status: 429, error: 'Quota exhausted' };
            }
            if (e.code === '23505' || e.message.includes('Idempotency conflict')) {
                return { status: 409, error: 'Idempotency conflict' };
            }
            console.error("DB Error: ", e); return { status: 503, error: 'Database error' };"""
content = content.replace(old_catch, new_catch)

with open('src/core/stage2-gateway.ts', 'w') as f:
    f.write(content)
