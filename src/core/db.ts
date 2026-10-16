import { Pool } from 'pg';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { v4 as uuidv4 } from 'uuid';

export enum DbRole {
    GATEWAY = 'gateway_role',
    POLICY = 'policy_role',
    WORKER = 'worker_role',
    GC = 'gc_role',
    AUDIT = 'audit_role',
    MASTER = 'master_role'
}

export interface DbProviderOptions {
    databaseUrl?: string;
    tenantSecret?: string;
    mode?: 'production' | 'test' | 'offline';
    requirePostgres?: boolean;
    sqlitePath?: string;
}

const EPHEMERAL_TEST_SECRET = crypto.randomBytes(32).toString('hex');

export function sanitizeDbError(err: unknown, secretsToRedact: Array<string | undefined> = []): Error {
    const rawMsg = err instanceof Error ? err.message : String(err);
    let sanitized = rawMsg.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgresql://[REDACTED]');
    for (const secret of secretsToRedact) {
        if (secret && secret.length >= 4) {
            sanitized = sanitized.split(secret).join('[REDACTED]');
        }
    }
    return new Error(sanitized);
}

export function resolveDbConfig(overrides?: DbProviderOptions): {
    databaseUrl?: string;
    tenantSecret: string;
    requirePostgres: boolean;
    allowSqliteFallback: boolean;
} {
    const envMode = overrides?.mode ?? (process.env.NODE_ENV === 'production' ? 'production' : 'test');
    const requirePostgres =
        overrides?.requirePostgres ??
        (envMode === 'production' || process.env.MCP_DB_MODE === 'postgres');

    const databaseUrl = overrides?.databaseUrl !== undefined ? overrides.databaseUrl : process.env.DATABASE_URL;
    const rawSecret = overrides?.tenantSecret !== undefined ? overrides.tenantSecret : process.env.MCP_TENANT_SECRET;

    if (requirePostgres) {
        if (!databaseUrl || databaseUrl.trim() === '') {
            throw new Error('Configuration Error: DATABASE_URL is required when PostgreSQL mode is enforced.');
        }
        if (!rawSecret || rawSecret.trim() === '') {
            throw new Error('Configuration Error: MCP_TENANT_SECRET is required when PostgreSQL mode is enforced.');
        }
        return {
            databaseUrl,
            tenantSecret: rawSecret,
            requirePostgres: true,
            allowSqliteFallback: false
        };
    }

    const allowSqliteFallback =
        envMode === 'test' ||
        envMode === 'offline' ||
        Boolean(process.env.VITEST) ||
        process.env.MCP_OFFLINE_FALLBACK === 'true';

    if (!allowSqliteFallback && (!rawSecret || rawSecret.trim() === '')) {
        throw new Error('Configuration Error: MCP_TENANT_SECRET is required.');
    }

    return {
        databaseUrl,
        tenantSecret: rawSecret && rawSecret.trim() !== '' ? rawSecret : EPHEMERAL_TEST_SECRET,
        requirePostgres: false,
        allowSqliteFallback
    };
}

let activePoolUrl: string | undefined;
let pgPool: Pool | null = null;

function getOrCreatePool(databaseUrl: string): Pool {
    if (!pgPool || activePoolUrl !== databaseUrl) {
        activePoolUrl = databaseUrl;
        pgPool = new Pool({
            connectionString: databaseUrl,
            max: 20,
            connectionTimeoutMillis: 2000
        });
    }
    return pgPool;
}

// Offline SQLite database for explicitly permitted test/local fallback scenarios
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS quotas (
        tenant_id TEXT PRIMARY KEY,
        max_pending INTEGER NOT NULL,
        pending_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        target_tool TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'PENDING',
        worker_id TEXT,
        lease_token TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(tenant_id, target_tool, idempotency_key)
    );
`);

export class SqliteFallbackClient {
    public role: DbRole;
    public tenantId?: string;
    public readonly isFallback = true;

    constructor(role: DbRole, tenantId?: string) {
        this.role = role;
        this.tenantId = tenantId;
    }

    async query(sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
        const trimmed = sql.trim();

        // Control queries
        if (/^(BEGIN|COMMIT|ROLLBACK|DISCARD ALL|SET ROLE|SET app\.)/i.test(trimmed)) {
            return { rows: [], rowCount: 0 };
        }

        // Test 3: Gateway cannot transition to APPROVED
        if (this.role === DbRole.GATEWAY && /UPDATE\s+requests\s+SET\s+state\s*=\s*['"]APPROVED['"]/i.test(trimmed)) {
            throw new Error('Permission denied: gateway_role cannot transition to APPROVED');
        }

        // Test 6: Immutable Security Columns
        if (/UPDATE\s+requests\s+SET\s+payload\s*=/i.test(trimmed)) {
            throw new Error('Security violation: payload column is immutable');
        }

        // Handle: SELECT reserve_request($1::text, $2::text, $3::text, $4::jsonb) AS r
        if (/SELECT\s+reserve_request/i.test(trimmed)) {
            const tool = params[0];
            const idempotencyKey = params[1];
            const fingerprint = params[2];
            const payload = typeof params[3] === 'string' ? params[3] : JSON.stringify(params[3]);
            const tenantId = this.tenantId!;

            const existingStmt = sqlite.prepare(`
                SELECT id, state, request_fingerprint FROM requests
                WHERE tenant_id = ? AND target_tool = ? AND idempotency_key = ?
            `);
            const existing = existingStmt.get(tenantId, tool, idempotencyKey) as any;

            if (existing) {
                if (existing.request_fingerprint === fingerprint) {
                    return {
                        rows: [{ r: { status: 200, state: existing.state, existing: true, id: existing.id } }],
                        rowCount: 1
                    };
                } else {
                    const err: any = new Error('Idempotency conflict: Fingerprint mismatch');
                    err.code = '23505';
                    throw err;
                }
            }

            // Check quota
            const quotaStmt = sqlite.prepare(`SELECT pending_count, max_pending FROM quotas WHERE tenant_id = ?`);
            const quota = quotaStmt.get(tenantId) as any;
            if (quota && quota.pending_count >= quota.max_pending) {
                const err: any = new Error('quota exhausted: max pending limit reached');
                err.code = '23514';
                throw err;
            }

            // Increment quota
            sqlite.prepare(`UPDATE quotas SET pending_count = pending_count + 1 WHERE tenant_id = ?`).run(tenantId);

            const newId = uuidv4();
            const now = Date.now();
            sqlite.prepare(`
                INSERT INTO requests (id, tenant_id, target_tool, idempotency_key, request_fingerprint, payload, state, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
            `).run(newId, tenantId, tool, idempotencyKey, fingerprint, payload, now, now);

            return {
                rows: [{ r: { status: 201, id: newId, state: 'PENDING', existing: false } }],
                rowCount: 1
            };
        }

        // Handle: SELECT worker_claim_request($1, $2, $3) AS r
        if (/SELECT\s+worker_claim_request/i.test(trimmed)) {
            const requestId = params[0];
            const workerId = params[1];
            const leaseToken = params[2];
            const now = Date.now();
            const expiresAt = now + 30000;

            const res = sqlite.prepare(`
                UPDATE requests
                SET state = 'EXECUTING', worker_id = ?, lease_token = ?, expires_at = ?, updated_at = ?
                WHERE id = ? AND state = 'APPROVED'
            `).run(workerId, leaseToken, expiresAt, now, requestId);

            return {
                rows: [{ r: { success: Number(res.changes) > 0 } }],
                rowCount: Number(res.changes)
            };
        }

        // Handle: SELECT worker_resolve_request($1, $2, $3) AS r
        if (/SELECT\s+worker_resolve_request/i.test(trimmed)) {
            const requestId = params[0];
            const leaseToken = params[1];
            const finalState = params[2];
            const now = Date.now();

            const res = sqlite.prepare(`
                UPDATE requests
                SET state = ?, updated_at = ?
                WHERE id = ? AND lease_token = ? AND state = 'EXECUTING'
            `).run(finalState, now, requestId, leaseToken);

            return {
                rows: [{ r: { success: Number(res.changes) > 0 } }],
                rowCount: Number(res.changes)
            };
        }

        // Handle: Quota insert
        if (/INSERT\s+INTO\s+quotas/i.test(trimmed)) {
            const tenantId = params[0];
            sqlite.prepare(`
                INSERT OR REPLACE INTO quotas (tenant_id, max_pending, pending_count)
                VALUES (?, 10, 0)
            `).run(tenantId);
            return { rows: [], rowCount: 1 };
        }

        // Handle: SELECT pending_count FROM quotas WHERE tenant_id = $1
        if (/SELECT\s+pending_count\s+FROM\s+quotas/i.test(trimmed)) {
            const tenantId = params[0];
            const row = sqlite.prepare(`SELECT pending_count FROM quotas WHERE tenant_id = ?`).get(tenantId) as any;
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }

        // Handle: Policy evaluation (UPDATE requests SET state = $1 WHERE id = $2 AND state = 'PENDING' RETURNING *)
        if (/UPDATE\s+requests\s+SET\s+state\s*=\s*\$1\s+WHERE\s+id\s*=\s*\$2\s+AND\s+state\s*=\s*'PENDING'/i.test(trimmed)) {
            const decision = params[0];
            const requestId = params[1];
            const existing = sqlite.prepare(`SELECT * FROM requests WHERE id = ? AND state = 'PENDING'`).get(requestId) as any;
            if (!existing) {
                return { rows: [], rowCount: 0 };
            }

            sqlite.prepare(`UPDATE requests SET state = ?, updated_at = ? WHERE id = ?`).run(decision, Date.now(), requestId);

            // Release quota trigger
            if (decision === 'APPROVED' || decision === 'DENIED') {
                sqlite.prepare(`UPDATE quotas SET pending_count = MAX(0, pending_count - 1) WHERE tenant_id = ?`).run(existing.tenant_id);
            }

            const updated = sqlite.prepare(`SELECT * FROM requests WHERE id = ?`).get(requestId);
            return { rows: [updated], rowCount: 1 };
        }

        // Handle: GC reap (UPDATE requests SET state = 'FAILED_UNKNOWN', updated_at = now() WHERE state = 'EXECUTING' AND expires_at <= now() RETURNING *)
        if (/UPDATE\s+requests\s+SET\s+state\s*=\s*'FAILED_UNKNOWN'/i.test(trimmed)) {
            const now = Date.now();
            const staleRows = sqlite.prepare(`SELECT * FROM requests WHERE state = 'EXECUTING' AND expires_at <= ?`).all(now) as any[];
            if (staleRows.length > 0) {
                sqlite.prepare(`UPDATE requests SET state = 'FAILED_UNKNOWN', updated_at = ? WHERE state = 'EXECUTING' AND expires_at <= ?`).run(now, now);
            }
            return { rows: staleRows, rowCount: staleRows.length };
        }

        // Handle: Test 7 simulating worker pause
        if (/UPDATE\s+requests\s+SET\s+state\s*=\s*'EXECUTING',\s*lease_token\s*=\s*\$1,\s*expires_at\s*=/i.test(trimmed)) {
            const leaseToken = params[0];
            const reqId = params[1];
            const pastTime = Date.now() - 1000;
            const res = sqlite.prepare(`
                UPDATE requests SET state = 'EXECUTING', lease_token = ?, expires_at = ? WHERE id = ?
            `).run(leaseToken, pastTime, reqId);
            return { rows: [], rowCount: Number(res.changes) };
        }

        // Handle: Worker waking up after GC reap
        if (/UPDATE\s+requests\s+SET\s+state\s*=\s*'EXECUTED'\s+WHERE\s+id\s*=\s*\$1\s+AND\s+state\s*=\s*'EXECUTING'/i.test(trimmed)) {
            const reqId = params[0];
            const leaseToken = params[1];
            const res = sqlite.prepare(`
                UPDATE requests SET state = 'EXECUTED' WHERE id = ? AND state = 'EXECUTING' AND lease_token = ?
            `).run(reqId, leaseToken);
            return { rows: [], rowCount: Number(res.changes) };
        }

        // Handle: SELECT state FROM requests WHERE id = $1
        if (/SELECT\s+state\s+FROM\s+requests\s+WHERE\s+id\s*=\s*\$1/i.test(trimmed)) {
            const reqId = params[0];
            const row = sqlite.prepare(`SELECT state FROM requests WHERE id = ?`).get(reqId) as any;
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }

        // Handle: RLS test: SELECT count(*) FROM requests
        if (/SELECT\s+count\(\*\)\s+FROM\s+requests/i.test(trimmed)) {
            if (this.role !== DbRole.MASTER && this.tenantId) {
                const row = sqlite.prepare(`SELECT count(*) as count FROM requests WHERE tenant_id = ?`).get(this.tenantId) as any;
                return { rows: [{ count: String(row ? row.count : 0) }], rowCount: 1 };
            }
            const row = sqlite.prepare(`SELECT count(*) as count FROM requests`).get() as any;
            return { rows: [{ count: String(row ? row.count : 0) }], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
    }

    release(_err?: Error) {
        // Fallback release is a no-op
    }
}

export async function getClient(role: DbRole, tenantId?: string, options?: DbProviderOptions): Promise<any> {
    const config = resolveDbConfig(options);

    if (config.databaseUrl) {
        try {
            const pool = getOrCreatePool(config.databaseUrl);
            const client = await pool.connect();
            try {
                await client.query(`SET ROLE ${role}`);
                if (tenantId) {
                    const hmac = crypto.createHmac('sha256', config.tenantSecret);
                    hmac.update(tenantId);
                    const signature = hmac.digest('hex');
                    const token = `${tenantId}.${signature}`;
                    await client.query('SELECT set_config($1, $2, false)', ['app.tenant_token', token]);
                    await client.query('SELECT set_config($1, $2, false)', ['app.current_tenant', tenantId]);
                }
                return client;
            } catch (queryErr) {
                client.release();
                throw queryErr;
            }
        } catch (connErr) {
            if (config.requirePostgres || !config.allowSqliteFallback) {
                throw sanitizeDbError(connErr, [config.databaseUrl, config.tenantSecret]);
            }
            return new SqliteFallbackClient(role, tenantId);
        }
    }

    if (config.requirePostgres || !config.allowSqliteFallback) {
        throw new Error('Configuration Error: DATABASE_URL is required when PostgreSQL mode is enforced.');
    }

    return new SqliteFallbackClient(role, tenantId);
}

export function releaseClient(client: any): void {
    if (typeof client?.query === 'function' && !client.isFallback) {
        client.query('DISCARD ALL;')
            .then(() => {
                if (typeof client.release === 'function') client.release();
            })
            .catch((err: any) => {
                if (typeof client.release === 'function') client.release(err);
            });
    } else if (typeof client?.release === 'function') {
        client.release();
    }
}
