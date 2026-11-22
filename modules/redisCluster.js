// =============================================================================
// Redis Cluster & Distributed Infrastructure Module (Phân hệ 7)
// - Tự động kích hoạt khi cấu hình REDIS_URL (Always-On multi-instance scaling)
// - Gắn @socket.io/redis-adapter cho Socket.IO khi cài gói `ioredis` + `@socket.io/redis-adapter`
// - Cung cấp bộ đếm Rate Limit phân tán (chia sẻ giữa nhiều instance) với fallback RAM tức thì
// =============================================================================
const { logger } = require('./observability');

const REDIS_URL = String(process.env.REDIS_URL || '').trim();

let redisClient = null;
let redisReady = false;
let socketAdapterMode = 'memory';

function tryCreateRedisClient(url) {
    if (!url) return null;
    try {
        // eslint-disable-next-line global-require
        const Redis = require('ioredis');
        const client = new Redis(url, {
            maxRetriesPerRequest: 2,
            enableReadyCheck: true,
            lazyConnect: true,
            retryStrategy: (times) => Math.min(times * 500, 10000),
        });
        client.on('ready', () => {
            redisReady = true;
            logger.info('Redis connected & ready for distributed rate-limiting / Socket.IO', {
                event: 'REDIS_READY',
            });
        });
        client.on('error', (err) => {
            redisReady = false;
            logger.warn('Redis error — falling back to in-memory store', {
                event: 'REDIS_ERROR',
                error: err?.message,
            });
        });
        client.on('close', () => {
            redisReady = false;
        });
        client.connect().catch(() => {
            redisReady = false;
        });
        return client;
    } catch {
        logger.info('REDIS_URL is configured but package `ioredis` is not installed — using in-memory mode', {
            event: 'REDIS_PACKAGE_MISSING',
        });
        return null;
    }
}

if (REDIS_URL) {
    redisClient = tryCreateRedisClient(REDIS_URL);
}

async function attachSocketIoRedisAdapter(io) {
    if (!REDIS_URL || !redisClient) {
        socketAdapterMode = 'memory';
        return { enabled: false, mode: 'memory' };
    }
    try {
        // eslint-disable-next-line global-require
        const { createAdapter } = require('@socket.io/redis-adapter');
        const pubClient = redisClient;
        const subClient = pubClient.duplicate();
        subClient.on('error', (err) => {
            logger.warn('Redis Socket.IO subClient error', { error: err?.message });
        });
        await subClient.connect().catch(() => {});
        io.adapter(createAdapter(pubClient, subClient));
        socketAdapterMode = 'redis';
        logger.info('Socket.IO Redis Adapter attached (multi-instance ready)', {
            event: 'SOCKET_REDIS_ADAPTER_READY',
        });
        return { enabled: true, mode: 'redis' };
    } catch (err) {
        socketAdapterMode = 'memory';
        logger.warn('Could not attach @socket.io/redis-adapter — keeping single-instance memory adapter', {
            error: err?.message,
        });
        return { enabled: false, mode: 'memory' };
    }
}

// =============================================================================
// Distributed Rate Limit Store (Redis INCR + PEXPIRE, fallback RAM Map an toàn)
// =============================================================================
function createRateLimitStore(prefix = 'rl') {
    const localMap = new Map(); // key -> { count, expiresAt }

    const getLocal = (key) => {
        const entry = localMap.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now()) {
            localMap.delete(key);
            return null;
        }
        return entry;
    };

    const get = async (key) => {
        const fullKey = `${prefix}:${key}`;
        if (redisClient && redisReady) {
            try {
                const [rawVal, ttlMs] = await Promise.all([
                    redisClient.get(fullKey),
                    redisClient.pttl(fullKey),
                ]);
                const count = Number(rawVal || 0);
                if (count > 0 && ttlMs > 0) {
                    return { dem: count, hetHan: Date.now() + ttlMs };
                }
                return null;
            } catch {
                // fallback RAM
            }
        }
        const entry = getLocal(fullKey);
        return entry ? { dem: entry.count, hetHan: entry.expiresAt } : null;
    };

    const increment = async (key, windowMs) => {
        const fullKey = `${prefix}:${key}`;
        if (redisClient && redisReady) {
            try {
                const count = await redisClient.incr(fullKey);
                if (count === 1) {
                    await redisClient.pexpire(fullKey, windowMs);
                }
                const ttlMs = await redisClient.pttl(fullKey);
                return { dem: count, hetHan: Date.now() + Math.max(1000, ttlMs) };
            } catch {
                // fallback RAM
            }
        }
        const existing = getLocal(fullKey);
        if (existing) {
            existing.count += 1;
            return { dem: existing.count, hetHan: existing.expiresAt };
        }
        const expiresAt = Date.now() + windowMs;
        localMap.set(fullKey, { count: 1, expiresAt });
        return { dem: 1, hetHan: expiresAt };
    };

    const reset = async (key) => {
        const fullKey = `${prefix}:${key}`;
        localMap.delete(fullKey);
        if (redisClient && redisReady) {
            try {
                await redisClient.del(fullKey);
            } catch {
                // ignore
            }
        }
    };

    const cleanup = () => {
        const now = Date.now();
        for (const [k, v] of localMap) {
            if (v.expiresAt <= now) localMap.delete(k);
        }
    };

    return { get, increment, reset, cleanup };
}

function getRedisStatus() {
    return {
        configured: Boolean(REDIS_URL),
        connected: Boolean(redisClient && redisReady),
        socketAdapter: socketAdapterMode,
        rateLimitStore: redisClient && redisReady ? 'redis' : 'memory',
    };
}

module.exports = {
    attachSocketIoRedisAdapter,
    createRateLimitStore,
    getRedisStatus,
};
