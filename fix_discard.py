with open('src/core/db.ts', 'r') as f:
    ts = f.read()

old_code = """export function releaseClient(client: PoolClient): void {
    // Reset role and tenant before returning to pool
    client.query('DISCARD ALL;')
          .catch(console.error)
          .finally(() => client.release());
}"""

new_code = """export function releaseClient(client: PoolClient): void {
    client.query('DISCARD ALL;')
          .then(() => client.release())
          .catch((err: any) => {
              console.error('Failed to reset connection:', err);
              client.release(err);
          });
}"""

ts = ts.replace(old_code, new_code)
with open('src/core/db.ts', 'w') as f:
    f.write(ts)
