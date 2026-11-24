const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('Wave 1 Unit — Local Print Bridge Security (P0-04)', () => {
    it('bridge-config.json trong repo KHÔNG chứa apiToken hardcode', () => {
        const cfgPath = path.join(__dirname, '..', '..', 'local-print-bridge', 'bridge-config.json');
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.equal(
            String(cfg?.security?.apiToken || '').trim(),
            '',
            'bridge-config.json không được chứa apiToken hardcode!'
        );
    });

    it('tự sinh 32-byte random token (64 hex chars) khi khởi chạy lần đầu và từ chối HTTP 401 khi sai token', async () => {
        const tmpBase = path.join(__dirname, '..', '.tmp');
        fs.mkdirSync(tmpBase, { recursive: true });
        const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'print-bridge-test-'));
        const tmpCfg = path.join(tmpDir, 'bridge-config.json');
        const tmpSpool = path.join(tmpDir, 'spool-queue.json');
        fs.writeFileSync(tmpCfg, JSON.stringify({ security: { apiToken: '' } }), 'utf8');

        const prevCfg = process.env.PRINT_BRIDGE_CONFIG_PATH;
        const prevSpool = process.env.PRINT_SPOOL_PATH;
        const prevToken = process.env.PRINT_BRIDGE_TOKEN;
        delete process.env.PRINT_BRIDGE_TOKEN;
        process.env.PRINT_BRIDGE_CONFIG_PATH = tmpCfg;
        process.env.PRINT_SPOOL_PATH = tmpSpool;

        const bridgeModulePath = require.resolve('../../local-print-bridge/bridge-server.js');
        delete require.cache[bridgeModulePath];

        try {
            const { handleBridgeRequest } = require('../../local-print-bridge/bridge-server.js');
            const generated = JSON.parse(fs.readFileSync(tmpCfg, 'utf8')).security?.apiToken || '';
            assert.match(generated, /^[0-9a-f]{64}$/, 'apiToken tự sinh phải là 32-byte random hex (64 ký tự)');

            // Giả lập request không có token -> phải trả 401
            let statusCode = null;
            let responseBody = '';
            const fakeReq = {
                method: 'POST',
                url: '/print/receipt',
                headers: { host: '127.0.0.1:9100' },
                on: () => {},
            };
            const fakeRes = {
                writeHead(code) {
                    statusCode = code;
                },
                end(chunk) {
                    responseBody = String(chunk || '');
                },
            };
            await handleBridgeRequest(fakeReq, fakeRes);
            assert.equal(statusCode, 401, `Phải trả 401 khi thiếu token, nhận được ${statusCode}: ${responseBody}`);
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
