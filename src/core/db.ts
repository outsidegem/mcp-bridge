import { Pool, PoolClient } from 'pg';

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

export async function getClient(role: DbRole, tenantId?: string): Promise<PoolClient> {
    const client = await pool.connect();
    try {
        await client.query(`SET ROLE ${role}`);
        if (tenantId) {
            await client.query(`SET app.current_tenant = '${tenantId}'`);
        }
    } catch (e) {
        client.release();
        throw e;
    }
    return client;
}

export function releaseClient(client: PoolClient): void {
    // Reset role and tenant before returning to pool
    client.query('RESET ROLE; RESET app.current_tenant;')
          .catch(console.error)
          .finally(() => client.release());
}

