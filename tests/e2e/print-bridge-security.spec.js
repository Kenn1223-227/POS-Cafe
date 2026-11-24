const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { encodeBitmapToEscPosGsV0 } = require('../../local-print-bridge/escposBuilder');

function invokeBridgeHandler(handleBridgeRequest, { method, url, headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        req.method = method;
        req.url = url;
        req.headers = { host: '127.0.0.1:9100', ...headers };

        let statusCode = 200;
        let responseHeaders = {};
        let responseBody = '';

        const res = {
            writeHead(code, hdrs = {}) {
                statusCode = code;
                responseHeaders = hdrs;
            },
            end(chunk = '') {
                responseBody += String(chunk || '');
                let json = null;
                try {
                    json = JSON.parse(responseBody);
                } catch {
                    // non-json
                }
                resolve({ statusCode, headers: responseHeaders, body: responseBody, json });
            },
        };

        Promise.resolve(handleBridgeRequest(req, res)).catch(reject);

        if (body !== null) {
            const payload = typeof body === 'string' ? body : JSON.stringify(body);
            process.nextTick(() => {
                req.emit('data', Buffer.from(payload, 'utf8'));
                req.emit('end');
            });
        } else {
            process.nextTick(() => req.emit('end'));
        }
    });
}

describe('Wave 2 E2E [Tầng 4] — TC-W2-05: Local Print Bridge Security (401 khi sai token) & Raster GS v 0', () => {
    it('Local Print Bridge trả 401 khi sai token và chấp nhận 202 khi đúng token kèm rasterBase64 GS v 0', async () => {
        const tmpBase = path.join(__dirname, '..', '.tmp');
        fs.mkdirSync(tmpBase, { recursive: true });
        const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'w2-print-bridge-'));
        const cfgPath = path.join(tmpDir, 'bridge-config.json');
        const spoolPath = path.join(tmpDir, 'spool-queue.json');
        const testToken = 'wave2_test_secret_token_64chars_0123456789abcdef0123456789abcdef';

        fs.writeFileSync(cfgPath, JSON.stringify({ security: { apiToken: '' } }), 'utf8');

        const prevCfg = process.env.PRINT_BRIDGE_CONFIG_PATH;
        const prevSpool = process.env.PRINT_SPOOL_PATH;
        const prevToken = process.env.PRINT_BRIDGE_TOKEN;
        process.env.PRINT_BRIDGE_CONFIG_PATH = cfgPath;
        process.env.PRINT_SPOOL_PATH = spoolPath;
        process.env.PRINT_BRIDGE_TOKEN = testToken;

        const bridgeModulePath = require.resolve('../../local-print-bridge/bridge-server.js');
        delete require.cache[bridgeModulePath];

        try {
            const { handleBridgeRequest } = require('../../local-print-bridge/bridge-server.js');

            // 1. Sai token -> bắt buộc trả 401 Unauthorized
            const badRes = await invokeBridgeHandler(handleBridgeRequest, {
                method: 'POST',
                url: '/print/receipt',
                headers: {
                    'content-type': 'application/json',
                    'x-print-bridge-token': 'wrong-token-xyz',
                },
                body: { hoaDon: { maHoaDon: 'HD-UNAUTH' } },
            });
            assert.equal(badRes.statusCode, 401, 'Local Print Bridge bắt buộc trả 401 khi sai token');

            // 2. Đúng token kèm rasterBase64 (GS v 0 1-bit) -> trả 200/202 Accepted
            const rgba = new Uint8ClampedArray(16 * 16 * 4).fill(255);
            const gsV0Buf = encodeBitmapToEscPosGsV0(rgba, 16, 16);
            const okRes = await invokeBridgeHandler(handleBridgeRequest, {
                method: 'POST',
                url: '/print/receipt',
                headers: {
                    'content-type': 'application/json',
                    'x-print-bridge-token': testToken,
                },
                body: {
                    hoaDon: { maHoaDon: 'HD-RASTER-OK', danhSachMon: [] },
                    rasterBase64: gsV0Buf.toString('base64'),
                },
            });
            assert.ok(
                [200, 202].includes(okRes.statusCode),
                `Đúng token phải trả 200/202, nhận được ${okRes.statusCode}: ${okRes.body}`
            );
        } finally {
            if (prevCfg === undefined) delete process.env.PRINT_BRIDGE_CONFIG_PATH;
            else process.env.PRINT_BRIDGE_CONFIG_PATH = prevCfg;
            if (prevSpool === undefined) delete process.env.PRINT_SPOOL_PATH;
            else process.env.PRINT_SPOOL_PATH = prevSpool;
            if (prevToken === undefined) delete process.env.PRINT_BRIDGE_TOKEN;
            else process.env.PRINT_BRIDGE_TOKEN = prevToken;
            delete require.cache[bridgeModulePath];
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
