import { Pool, PoolClient } from 'pg';
import crypto from 'crypto';

export enum DbRole {
    GATEWAY = 'gateway_role',
    POLICY = 'policy_role',
    WORKER = 'worker_role',
    GC = 'gc_role',
    AUDIT = 'audit_role',
    MASTER = 'u0_a338' // Default user in termux
}

const pool = new Pool({
    user: process.env.PGUSER || 'u0_a338',
    host: '127.0.0.1',
    database: 'postgres',
    port: 5432,
    max: 20
});

const TENANT_SECRET = 'stage2-secret-key-12345';

export async function getClient(role: DbRole, tenantId?: string): Promise<PoolClient> {
    const client = await pool.connect();
    try {
        await client.query(`SET ROLE ${role}`);
        if (tenantId) {
            const hmac = crypto.createHmac('sha256', TENANT_SECRET);
            hmac.update(tenantId);
            const signature = hmac.digest('hex');
            const token = `${tenantId}.${signature}`;
            await client.query(`SET app.tenant_token = '${token}'`);
            // Set old GUC too, in case some non-RLS logic reads it, but remove it from RLS
            await client.query(`SET app.current_tenant = '${tenantId}'`);
        }
    } catch (e: any) {
        client.release();
        throw e;
    }
    return client;
}

export function releaseClient(client: PoolClient): void {
    client.query('DISCARD ALL;')
          .then(() => client.release())
          .catch((err: any) => {
              console.error('Failed to reset connection:', err);
              client.release(err);
          });
}

