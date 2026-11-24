const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

describe('Wave 2 Realtime [Tầng 3] — Graceful Shutdown SIGTERM / 503 DRAINING (P0-06)', () => {
    it('server.js đăng ký handler SIGTERM/SIGINT và trả 503 DRAINING tại /api/ready khi đang tắt', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
        assert.ok(src.includes("process.on('SIGTERM'"), 'server.js phải bắt tín hiệu SIGTERM');
        assert.ok(src.includes("process.on('SIGINT'"), 'server.js phải bắt tín hiệu SIGINT');
        assert.ok(src.includes("status: 'DRAINING'"), '/api/ready phải trả 503 { status: "DRAINING" }');
        assert.ok(src.includes('closeRedisClients()'), 'Graceful shutdown phải đóng Redis clients');
        assert.ok(src.includes('pool.end()'), 'Graceful shutdown phải đóng pg pool');
    });

    it('khi kích hoạt Graceful Shutdown giữa request chậm 500ms: /api/ready trả 503 DRAINING, request đang chạy vẫn xong 200 OK và thoát sạch code 0', async () => {
        let isShuttingDown = false;
        let inFlightRequests = 0;

        function createMockRes() {
            const res = new EventEmitter();
            res.statusCode = 200;
            res.body = null;
            res.headers = {};
            res.setHeader = (k, v) => { res.headers[k] = v; };
            res.status = (code) => {
                res.statusCode = code;
                return res;
            };
            res.json = (obj) => {
                res.body = obj;
                res.emit('finish');
                return res;
            };
            return res;
        }

        function drainMiddleware(req, res, next) {
            if (req.path === '/api/ready' || req.path === '/api/health') return next();
            if (isShuttingDown) {
                res.setHeader('Connection', 'close');
                return res.status(503).json({ status: 'DRAINING' });
            }
            inFlightRequests += 1;
            let done = false;
            const finish = () => {
                if (!done) {
                    done = true;
                    inFlightRequests = Math.max(0, inFlightRequests - 1);
                }
            };
            res.on('finish', finish);
            res.on('close', finish);
            return next();
        }

        function readyHandler(_req, res) {
            if (isShuttingDown) return res.status(503).json({ ready: false, status: 'DRAINING' });
            return res.status(200).json({ ready: true, status: 'READY' });
        }

        // 1. Trước khi shutdown -> /api/ready trả 200 READY
        const readyBefore = createMockRes();
        readyHandler({ path: '/api/ready' }, readyBefore);
        assert.equal(readyBefore.statusCode, 200);
        assert.equal(readyBefore.body.status, 'READY');

        // 2. Bắt đầu 1 request chậm 500ms
        const slowRes = createMockRes();
        const slowDone = new Promise((resolve) => {
            slowRes.on('finish', () => resolve(slowRes));
        });
        drainMiddleware({ path: '/api/slow-tx' }, slowRes, () => {
            setTimeout(() => {
                slowRes.status(200).json({ ok: true, completed: true });
            }, 500);
        });
        assert.equal(inFlightRequests, 1);

        // 3. Kích hoạt Graceful Shutdown (giống SIGTERM)
        isShuttingDown = true;

        // /api/ready lập tức trả 503 DRAINING
        const readyDuring = createMockRes();
        readyHandler({ path: '/api/ready' }, readyDuring);
        assert.equal(readyDuring.statusCode, 503);
        assert.equal(readyDuring.body.status, 'DRAINING');

        // Request mới đến trong lúc draining bị từ chối 503 DRAINING
        const newReqRes = createMockRes();
        drainMiddleware({ path: '/api/order' }, newReqRes, () => {
            assert.fail('Request mới không được đi tiếp khi server đang DRAINING');
        });
        assert.equal(newReqRes.statusCode, 503);
        assert.equal(newReqRes.body.status, 'DRAINING');

        // 4. Chờ request in-flight hoàn tất (timeout 15s) rồi thoát sạch code 0
        let exitCode = null;
        const shutdownPromise = (async () => {
            const deadline = Date.now() + 15000;
            while (inFlightRequests > 0 && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 25));
            }
            exitCode = 0;
        })();

        const completedSlow = await slowDone;
        assert.equal(completedSlow.statusCode, 200);
        assert.equal(completedSlow.body.completed, true);

        await shutdownPromise;
        assert.equal(exitCode, 0);
        assert.equal(inFlightRequests, 0);
    });
});
