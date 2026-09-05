import re

with open('src/core/stage2-worker.ts', 'r') as f:
    content = f.read()

old_claim = """            const claim = await client.query(`
                UPDATE requests
                SET state = 'EXECUTING',
                    worker_id = $1,
                    lease_token = $2,
                    expires_at = now() + interval '30 seconds'
                WHERE id = $3 AND state = 'APPROVED'
                RETURNING *
            `, [workerId, leaseToken, requestId]);

            if (claim.rowCount === 0) {"""

new_claim = """            const claimRes = await client.query(`
                SELECT worker_claim_request($1, $2, $3) AS r
            `, [requestId, workerId, leaseToken]);
            const claim = claimRes.rows[0].r;

            if (!claim.success) {"""

content = content.replace(old_claim, new_claim)

old_resolve = """            const resolve = await client.query(`
                UPDATE requests
                SET state = $1
                WHERE id = $2 AND state = 'EXECUTING' AND lease_token = $3
                RETURNING *
            `, [isSuccess ? 'EXECUTED' : 'FAILED', requestId, leaseToken]);

            if (resolve.rowCount === 0) {"""

new_resolve = """            const resolveRes = await client.query(`
                SELECT worker_resolve_request($1, $2, $3) AS r
            `, [requestId, leaseToken, isSuccess ? 'EXECUTED' : 'FAILED']);
            const resolve = resolveRes.rows[0].r;

            if (!resolve.success) {"""

content = content.replace(old_resolve, new_resolve)

with open('src/core/stage2-worker.ts', 'w') as f:
    f.write(content)
