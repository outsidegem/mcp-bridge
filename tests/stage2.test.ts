import { describe, it, expect, vi } from 'vitest';
import dns from 'node:dns/promises';
import { Stage2Gateway } from '../src/core/stage2-gateway.js';
import { Stage2PolicyEngine } from '../src/core/stage2-policy.js';
import { Stage2Worker } from '../src/core/stage2-worker.js';
import { Stage2GC } from '../src/core/stage2-gc.js';
import { getClient, DbRole, releaseClient, resolveDbConfig, sanitizeDbError } from '../src/core/db.js';
import { NetworkValidator, SecureHttpExecutor, EnvironmentCredentialProvider } from '../src/index.js';
import { v4 as uuidv4 } from 'uuid';

describe('Stage 2 Implementation', () => {
    let gateway = new Stage2Gateway();
    let policy = new Stage2PolicyEngine();
    let worker = new Stage2Worker();
    let gc = new Stage2GC();

    async function setupTenant() {
        let tid = uuidv4();
        const client = await getClient(DbRole.MASTER);
        await client.query('INSERT INTO quotas (tenant_id, max_pending, pending_count) VALUES ($1, 10, 0)', [tid]);
        releaseClient(client);
        return tid;
    }

    it('Idempotency: Same identity + same fingerprint -> 200 replay', async () => {
        let tenantId = await setupTenant();
        const req = {
            tenantId, targetTool: 'toolA', idempotencyKey: 'key1', payload: { a: 1 }
        };
        const r1 = await gateway.handleRequest(req);
        expect(r1.status).toBe(201);

        const r2 = await gateway.handleRequest(req);
        expect(r2.status).toBe(200);
        expect(r2.existing).toBe(true);
    });

    it('Idempotency: Same identity + diff fingerprint -> 409 conflict', async () => {
        let tenantId = await setupTenant();
        const req = {
            tenantId, targetTool: 'toolA', idempotencyKey: 'key2', payload: { a: 1 }
        };
        const r1 = await gateway.handleRequest(req);
        expect(r1.status).toBe(201);

        const reqDiff = { ...req, payload: { a: 2 } };
        const r2 = await gateway.handleRequest(reqDiff);
        expect(r2.status).toBe(409);
    });

    it('State Machine: Gateway cannot transition to APPROVED', async () => {
        let tenantId = await setupTenant();
        const req = { tenantId, targetTool: 'toolA', idempotencyKey: 'key1', payload: { a: 1 } };
        await gateway.handleRequest(req);

        const client = await getClient(DbRole.GATEWAY, tenantId);
        await expect(
            client.query("UPDATE requests SET state = 'APPROVED' WHERE target_tool = 'toolA' AND idempotency_key = 'key1'")
        ).rejects.toThrow();
        releaseClient(client);
    });

    it('State Machine: Flow through Policy -> Worker -> GC', async () => {
        let tenantId = await setupTenant();
        const req = { tenantId, targetTool: 'toolB', idempotencyKey: 'key3', payload: { b: 2 } };
        const res = await gateway.handleRequest(req);

        // Check pending_count is 1 for tenant
        const client = await getClient(DbRole.MASTER);
        let q = await client.query('SELECT pending_count FROM quotas WHERE tenant_id = $1', [tenantId]);
        expect(q.rows[0].pending_count).toBe(1);

        const pRes = await policy.evaluate(res.id, tenantId, 'APPROVED');
        expect(pRes.success).toBe(true);

        // Check quota released via trigger
        q = await client.query('SELECT pending_count FROM quotas WHERE tenant_id = $1', [tenantId]);
        expect(q.rows[0].pending_count).toBe(0);

        const wRes = await worker.execute(res.id, tenantId);
        expect(wRes.success).toBe(true);
        expect(['EXECUTED', 'FAILED']).toContain(wRes.state);
        releaseClient(client);
    });

    it('RLS: Cannot read other tenant data', async () => {
        let tenantId = await setupTenant();
        const otherTenant = uuidv4();
        const client = await getClient(DbRole.GATEWAY, otherTenant);
        const res = await client.query('SELECT count(*) FROM requests');
        expect(res.rows[0].count).toBe("0");
        releaseClient(client);
    });

    it('Immutable Security Columns: Cannot modify payload', async () => {
        let tenantId = await setupTenant();
        const req = { tenantId, targetTool: 'toolC', idempotencyKey: 'key4', payload: { c: 3 } };
        const r1 = await gateway.handleRequest(req);

        const client = await getClient(DbRole.GATEWAY, tenantId);
        await expect(
            client.query("UPDATE requests SET payload = '{\"c\":4}' WHERE id = $1", [r1.id])
        ).rejects.toThrow();
        releaseClient(client);
    });

    it('Stale worker prevention via GC reap', async () => {
        let tenantId = await setupTenant();
        const req = { tenantId, targetTool: 'toolD', idempotencyKey: 'key5', payload: { d: 4 } };
        const r1 = await gateway.handleRequest(req);
        await policy.evaluate(r1.id, tenantId, 'APPROVED');

        // manually simulate worker claiming and pausing
        const master = await getClient(DbRole.MASTER);
        const leaseToken = uuidv4();
        await master.query(`
            UPDATE requests SET state = 'EXECUTING', lease_token = $1, expires_at = now() - interval '1 second'
            WHERE id = $2
        `, [leaseToken, r1.id]);

        // GC runs
        const gcRes = await gc.reapStale(tenantId);
        expect(gcRes.reaped).toBe(1);

        // Worker wakes up and tries to complete
        const workerClient = await getClient(DbRole.WORKER, tenantId);
        const wRes = await workerClient.query(`
            UPDATE requests SET state = 'EXECUTED' WHERE id = $1 AND state = 'EXECUTING' AND lease_token = $2
        `, [r1.id, leaseToken]);
        expect(wRes.rowCount).toBe(0);

        const finalState = await master.query('SELECT state FROM requests WHERE id = $1', [r1.id]);
        expect(finalState.rows[0].state).toBe('FAILED_UNKNOWN');

        releaseClient(workerClient);
        releaseClient(master);
    });

    describe('Hardened SSRF & Executor Defenses', () => {
        it('blocks IPv4-mapped IPv6 addresses in both dotted-quad and URL hex forms', async () => {
            await expect(NetworkValidator.validateSafeTarget('https://[::ffff:127.0.0.1]/admin')).rejects.toThrow('SSRF Blocked');
            await expect(NetworkValidator.validateSafeTarget('https://[::ffff:10.0.0.1]/admin')).rejects.toThrow('SSRF Blocked');
            await expect(NetworkValidator.validateSafeTarget('https://[::ffff:172.16.0.1]/admin')).rejects.toThrow('SSRF Blocked');
            await expect(NetworkValidator.validateSafeTarget('https://[::ffff:192.168.1.1]/admin')).rejects.toThrow('SSRF Blocked');
            await expect(NetworkValidator.validateSafeTarget('https://[::ffff:169.254.169.254]/latest/meta-data')).rejects.toThrow('SSRF Blocked');
            await expect(NetworkValidator.validateSafeTarget('https://[::ffff:0.0.0.0]/')).rejects.toThrow('SSRF Blocked');
            expect(NetworkValidator.isBlockedIp('::ffff:127.0.0.1')).toBe(true);
            expect(NetworkValidator.isBlockedIp('::ffff:169.254.169.254')).toBe(true);
        });

        it('blocks IPv6 loopback, link-local, unique-local, and unspecified addresses', async () => {
            await expect(NetworkValidator.validateSafeTarget('https://[::1]/admin')).rejects.toThrow('SSRF Blocked');
            await expect(NetworkValidator.validateSafeTarget('https://[::]/admin')).rejects.toThrow('SSRF Blocked');
            await expect(NetworkValidator.validateSafeTarget('https://[fc00::1]/admin')).rejects.toThrow('SSRF Blocked');
            await expect(NetworkValidator.validateSafeTarget('https://[fd12:3456::1]/admin')).rejects.toThrow('SSRF Blocked');
            await expect(NetworkValidator.validateSafeTarget('https://[fe80::1]/admin')).rejects.toThrow('SSRF Blocked');
        });

        it('blocks URL credentials, non-HTTPS protocols, and DNS resolving to private IPs', async () => {
            await expect(NetworkValidator.validateSafeTarget('http://example.com/api')).rejects.toThrow('Only HTTPS is allowed');
            await expect(NetworkValidator.validateSafeTarget('https://user:pass@example.com/api')).rejects.toThrow('Credentials in URL');
            await expect(NetworkValidator.validateSafeTarget('https://metadata.google.internal/computeMetadata/v1/')).rejects.toThrow('SSRF Blocked');

            const dnsSpy = vi.spyOn(dns, 'resolve').mockResolvedValueOnce(['::ffff:169.254.169.254'] as any);
            await expect(NetworkValidator.validateSafeTarget('https://rebinding.attacker.example/api')).rejects.toThrow('SSRF Blocked');
            dnsSpy.mockRestore();
        });

        it('validates target URL at the top of SecureHttpExecutor.execute() before fetch', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch');
            const executor = new SecureHttpExecutor(new EnvironmentCredentialProvider());
            const res = await executor.execute(
                {
                    name: 'directTool',
                    description: 'Direct call',
                    method: 'GET',
                    targetUrl: 'https://[::ffff:127.0.0.1]/secret',
                    inputSchema: {}
                },
                {}
            );
            expect(res.success).toBe(false);
            expect(res.error).toContain('SSRF Blocked');
            expect(fetchSpy).not.toHaveBeenCalled();
            fetchSpy.mockRestore();
        });
    });

    describe('Database Configuration & Fail-Closed Production Semantics', () => {
        it('fails closed when DATABASE_URL or MCP_TENANT_SECRET is missing in production mode', async () => {
            expect(() =>
                resolveDbConfig({ mode: 'production', databaseUrl: '', tenantSecret: 'valid-secret-123456' })
            ).toThrow('DATABASE_URL is required');

            expect(() =>
                resolveDbConfig({ mode: 'production', databaseUrl: 'postgresql://db.internal:5432/app', tenantSecret: '' })
            ).toThrow('MCP_TENANT_SECRET is required');

            await expect(
                getClient(DbRole.GATEWAY, uuidv4(), {
                    mode: 'production',
                    databaseUrl: '',
                    tenantSecret: 'valid-secret'
                })
            ).rejects.toThrow('DATABASE_URL is required');
        });

        it('refuses silent SQLite fallback in production mode when PostgreSQL is unreachable and redacts secrets', async () => {
            const secretUrl = 'postgresql://prod_user:super_secret_pw_999@127.0.0.1:59999/proddb';
            const tenantSecret = 'top_secret_hmac_key_888';

            await expect(
                getClient(DbRole.GATEWAY, uuidv4(), {
                    mode: 'production',
                    requirePostgres: true,
                    databaseUrl: secretUrl,
                    tenantSecret
                })
            ).rejects.toThrow();

            const sanitized = sanitizeDbError(
                new Error(`Connection failed for ${secretUrl} using key ${tenantSecret}`),
                [secretUrl, tenantSecret]
            );
            expect(sanitized.message).not.toContain('super_secret_pw_999');
            expect(sanitized.message).not.toContain(tenantSecret);
            expect(sanitized.message).toContain('[REDACTED]');
        });
    });
});
