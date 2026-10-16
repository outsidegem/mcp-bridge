import { Redis } from 'ioredis';

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379;

export const redis = new Redis({
    host: redisHost,
    port: redisPort,
    enableOfflineQueue: false,
    lazyConnect: true,
    commandTimeout: 1000
});
redis.on('error', () => {
    // Suppress unhandled connection errors in offline mode
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

const inMemoryRateLimits = new Map<string, { count: number; resetAt: number }>();

export async function checkRateLimit(tenantId: string, limit: number, windowSeconds: number): Promise<boolean> {
    try {
        const result = await redis.eval(RATE_LIMIT_SCRIPT, 1, `rl:${tenantId}`, limit, windowSeconds);
        return result === 1;
    } catch (e: any) {
        // Fallback to in-memory rate limiting when Redis is offline (e.g. CI)
        const now = Date.now();
        const key = `rl:${tenantId}`;
        const record = inMemoryRateLimits.get(key);
        if (!record || now > record.resetAt) {
            inMemoryRateLimits.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
            return true;
        }
        if (record.count >= limit) {
            return false;
        }
        record.count++;
        return true;
    }
}
