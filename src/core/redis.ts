import Redis from 'ioredis';

export const redis = new Redis({
    host: '127.0.0.1',
    port: 6379,
    enableOfflineQueue: false, // Fail fast if Redis is down
    commandTimeout: 1000 // 1s timeout
});

// Redis is authoritative for NOTHING. Used only for rate limiting.
const RATE_LIMIT_SCRIPT = `
    local current = redis.call('get', KEYS[1])
    if current and tonumber(current) >= tonumber(ARGV[1]) then
        return 0
    end
    redis.call('incr', KEYS[1])
    if tonumber(current or 0) == 0 then
        redis.call('expire', KEYS[1], tonumber(ARGV[2]))
    end
    return 1
`;

export async function checkRateLimit(tenantId: string, limit: number, windowSeconds: number): Promise<boolean> {
    try {
        const result = await redis.eval(RATE_LIMIT_SCRIPT, 1, `rl:${tenantId}`, limit, windowSeconds);
        return result === 1;
    } catch (e: any) {
        // Redis failure must fail closed
        return false;
    }
}
