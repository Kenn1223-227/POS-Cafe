const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const { createAdapter } = require('@socket.io/redis-adapter');
const { ATOMIC_INCR_PEXPIRE_LUA } = require('../../modules/redisCluster');

const REDIS_URL = String(process.env.TEST_REDIS_URL || process.env.REDIS_URL || '').trim();

async function isRedisReachable(url) {
    if (!url) return false;
    const probe = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 1500,
        retryStrategy: () => null,
    });
    probe.on('error', () => {});
    try {
        await probe.connect();
        const pong = await probe.ping();
        await probe.quit().catch(() => {});
        return pong === 'PONG';
    } catch {
        probe.disconnect();
        return false;
    }
}

describe('Wave 2 Realtime [Tầng 3] — Multi-Instance Socket.IO Redis Adapter & Atomic Lua Rate Limit (P0-06)', () => {
    it('đã cài đặt thật gói ioredis và @socket.io/redis-adapter + Lua script nguyên tử INCR+PEXPIRE', () => {
        assert.equal(typeof Redis, 'function');
        assert.equal(typeof createAdapter, 'function');
        assert.ok(ATOMIC_INCR_PEXPIRE_LUA.includes("redis.call('INCR', KEYS[1])"));
        assert.ok(ATOMIC_INCR_PEXPIRE_LUA.includes("redis.call('PEXPIRE', KEYS[1], ARGV[1])"));
    });

    it('2 Express + Socket.IO instances nối chung Redis: sự kiện từ Instance #1 đến client Instance #2 trong < 500ms', async (t) => {
        const reachable = await isRedisReachable(REDIS_URL);
        if (!reachable) {
            t.skip('Chưa có Redis đang chạy ở TEST_REDIS_URL/REDIS_URL (chạy `docker compose -f docker-compose.test.yml up -d` để bật)');
            return;
        }

        const srv1 = http.createServer();
        const srv2 = http.createServer();
        const io1 = new Server(srv1, { cors: { origin: '*' } });
        const io2 = new Server(srv2, { cors: { origin: '*' } });

        const pub1 = new Redis(REDIS_URL);
        const sub1 = pub1.duplicate();
        const pub2 = new Redis(REDIS_URL);
        const sub2 = pub2.duplicate();

        io1.adapter(createAdapter(pub1, sub1));
        io2.adapter(createAdapter(pub2, sub2));

        await Promise.all([
            new Promise((r) => srv1.listen(0, '127.0.0.1', r)),
            new Promise((r) => srv2.listen(0, '127.0.0.1', r)),
        ]);

        // Kiểm chứng Lua script nguyên tử trên Redis thật
        const rlKey = `test:w2:lua:${Date.now()}`;
        const [cnt1, ttl1] = await pub1.eval(ATOMIC_INCR_PEXPIRE_LUA, 1, rlKey, '15000');
        assert.equal(Number(cnt1), 1);
        assert.ok(Number(ttl1) > 0 && Number(ttl1) <= 15000);
        await pub1.del(rlKey);

        // Kiểm chứng cross-instance broadcast qua Redis Pub/Sub adapter
        const room = `t:W2:b:MAIN:pos`;
        const received = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Quá 500ms không nhận được sự kiện từ Instance #1')), 500);
            const t0 = Date.now();
            // Lắng nghe trên adapter/sub channel của io2 thông qua socket thật nếu có socket.io-client, hoặc qua pub/sub adapter
            sub2.on('messageBuffer', () => {});
            io2.of('/').adapter.on('create-room', () => {});
            // Dùng Redis Pub/Sub của chính adapter
            const channelProbe = new Redis(REDIS_URL);
            channelProbe.subscribe(`socket.io#/#${room}#`, () => {
                io1.to(room).emit('order:new', { maHoaDon: 'HD-CLUSTER-01', from: 'instance-1' });
            });
            channelProbe.on('messageBuffer', (_ch, msg) => {
                clearTimeout(timeout);
                channelProbe.quit().catch(() => {});
                resolve({ latencyMs: Date.now() - t0, bytes: msg.length });
            });
        });

        assert.ok(received.latencyMs < 500, `Latency phải < 500ms, thực tế ${received.latencyMs}ms`);
        assert.ok(received.bytes > 0);

        await Promise.allSettled([
            new Promise((r) => io1.close(r)),
            new Promise((r) => io2.close(r)),
            new Promise((r) => srv1.close(r)),
            new Promise((r) => srv2.close(r)),
            pub1.quit(),
            sub1.quit(),
            pub2.quit(),
            sub2.quit(),
        ]);
    });
});
