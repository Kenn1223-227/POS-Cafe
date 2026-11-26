const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const { buildZReportK80 } = require('../../local-print-bridge/escposBuilder');

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
                    // non-json response (e.g. 204)
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

function createSampleDoiSoat() {
    return {
        maCaThuNgan: 'CA-20261125-01',
        soZReport: 42,
        maZReport: 'Z-0042',
        tenNV: 'Nguyễn Thị Lan',
        thoiGianMoCa: '2026-11-25T07:00:00.000Z',
        thoiGianDongCa: '2026-11-25T15:00:00.000Z',
        tienMatDauCa: 500000,
        doanhThu: {
            tienMat: 1250000,
            chuyenKhoan: 850000,
            the: 250000,
            voucher: 100000,
            viKhach: 50000,
            tong: 2500000,
            soHoaDon: 38,
        },
        hoanTien: {
            tienMat: 40000,
            chuyenKhoan: 35000,
            the: 0,
            voucher: 0,
            viKhach: 0,
            tong: 75000,
            soLuot: 2,
        },
        thuLatVat: 100000,
        chiLatVat: 60000,
        rutKet: 500000,
        thoiCkDu: 10000,
        tienMatLyThuyet: 1240000,
        tienMatThucTe: 1290000,
        chenhLech: 50000,
        trangThai: 'Thừa tiền mặt (Dư quỹ)',
        tienGiuLaiKet: 500000,
        tienNopVeChuQuan: 790000,
        ghiChuChenhLech: 'Đã đếm lại lần 2, dư 50k tiền lẻ khách không lấy',
        chiTietMenhGia: {
            500000: 1,
            200000: 3,
            100000: 1,
            50000: 1,
            20000: 2,
        },
    };
}

function loadIsolatedBridge({ configData, envOverrides = {} }) {
    const tmpBase = path.join(ROOT, 'node_modules', '.cache', 'batch5-bridge');
    fs.mkdirSync(tmpBase, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'inst-'));
    const cfgPath = path.join(tmpDir, 'bridge-config.json');
    const spoolPath = path.join(tmpDir, 'spool-queue.json');
    fs.writeFileSync(cfgPath, JSON.stringify(configData, null, 2), 'utf8');

    const keys = [
        'PRINT_BRIDGE_CONFIG_PATH',
        'PRINT_SPOOL_PATH',
        'PRINT_BRIDGE_TOKEN',
        'PRINT_BRIDGE_ALLOWED_ORIGINS',
    ];
    const prevEnv = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

    process.env.PRINT_BRIDGE_CONFIG_PATH = cfgPath;
    process.env.PRINT_SPOOL_PATH = spoolPath;
    for (const [k, v] of Object.entries(envOverrides)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }

    const bridgeModulePath = require.resolve('../../local-print-bridge/bridge-server.js');
    delete require.cache[bridgeModulePath];
    const mod = require('../../local-print-bridge/bridge-server.js');

    const cleanup = () => {
        for (const k of keys) {
            if (prevEnv[k] === undefined) delete process.env[k];
            else process.env[k] = prevEnv[k];
        }
        delete require.cache[bridgeModulePath];
        fs.rmSync(tmpDir, { recursive: true, force: true });
        try {
            if (fs.existsSync(tmpBase) && fs.readdirSync(tmpBase).length === 0) {
                fs.rmdirSync(tmpBase);
            }
        } catch (_) {}
    };

    return { mod, cleanup };
}

describe('Batch 5 Unit — Phân hệ 6: Print Bridge CORS, Z-Report, Vietnamese Raster ESC/POS & POS Hotkey Guard', () => {
    it('1. buildZReportK80 dựng buffer ESC/POS chứa đúng các con số doanh thu, đối soát két & chênh lệch khác 0', () => {
        const doiSoat = createSampleDoiSoat();
        const built = buildZReportK80({
            doiSoat,
            tenQuan: 'Cà Phê Sáng Sài Gòn',
            diaChi: '123 Nguyễn Huệ, Q1',
            nguoiIn: 'Quản lý Hùng',
            laBanSao: false,
            autoCut: true,
            kickDrawer: false,
        });

        assert.ok(Buffer.isBuffer(built.buffer) && built.buffer.length > 200, 'Buffer ESC/POS Z-Report phải khác rỗng');
        const asciiText = built.buffer.toString('ascii');

        assert.ok(asciiText.includes('Z-0042'), 'Phải in mã Z-Report');
        assert.ok(asciiText.includes('CA-20261125-01'), 'Phải in mã ca thu ngân');
        assert.ok(asciiText.includes('Nguyen Thi Lan'), 'Phải in tên thu ngân');
        assert.ok(asciiText.includes('38 don'), 'Phải in đúng số hóa đơn đã thu');
        assert.ok(asciiText.includes('1,250,000d'), 'Phải in doanh thu tiền mặt 1,250,000d');
        assert.ok(asciiText.includes('850,000d'), 'Phải in doanh thu chuyển khoản 850,000d');
        assert.ok(asciiText.includes('250,000d'), 'Phải in doanh thu thẻ 250,000d');
        assert.ok(asciiText.includes('100,000d'), 'Phải in doanh thu voucher / thu lặt vặt');
        assert.ok(asciiText.includes('50,000d'), 'Phải in ví thành viên / chênh lệch');
        assert.ok(asciiText.includes('2,500,000d'), 'Phải in tổng doanh thu 2,500,000d');
        assert.ok(asciiText.includes('-75,000d'), 'Phải in tổng hoàn tiền sau TT');
        assert.ok(asciiText.includes('-40,000d'), 'Phải in hoàn tiền mặt');
        assert.ok(asciiText.includes('-35,000d'), 'Phải in hoàn CK/Thẻ');
        assert.ok(asciiText.includes('500,000d'), 'Phải in tiền mặt đầu ca & Safe Drop');
        assert.ok(asciiText.includes('-60,000d'), 'Phải in chi lặt vặt');
        assert.ok(asciiText.includes('-10,000d'), 'Phải in thối CK dư bằng tiền mặt');
        assert.ok(asciiText.includes('1,240,000d'), 'Phải in quỹ lý thuyết tại két 1,240,000d');
        assert.ok(asciiText.includes('1,290,000d'), 'Phải in tiền mặt thực đếm 1,290,000d');
        assert.ok(asciiText.includes('+50,000d'), 'Phải in chênh lệch có dấu +50,000d');
        assert.ok(asciiText.includes('790,000d'), 'Phải in tiền nộp về chủ quán');
        assert.ok(asciiText.includes('BANG DEM MENH GIA'), 'Phải in bảng đếm mệnh giá Blind Drop');
        assert.equal(built.previewText.includes('TONG DOANH THU:                              0d'), false, 'Không được in tổng doanh thu 0đ');
    });

    it('2. POST /print/z-report qua bridge-server.js truyền đúng body.doiSoat (không in ra toàn 0đ)', async () => {
        const testToken = 'batch5_zreport_test_token_0123456789abcdef0123456789abcdef';
        const { mod, cleanup } = loadIsolatedBridge({
            configData: {
                receiptPrinter: { mode: 'SIMULATOR', autoCut: true },
                security: { apiToken: '', allowedOrigins: ['https://*.vercel.app'] },
            },
            envOverrides: {
                PRINT_BRIDGE_TOKEN: testToken,
                PRINT_BRIDGE_ALLOWED_ORIGINS: '',
            },
        });

        try {
            const doiSoat = createSampleDoiSoat();
            const res = await invokeBridgeHandler(mod.handleBridgeRequest, {
                method: 'POST',
                url: '/print/z-report',
                headers: {
                    origin: 'https://my-cafe-pos.vercel.app',
                    'content-type': 'application/json',
                    'x-print-bridge-token': testToken,
                },
                body: {
                    sync: true,
                    doiSoat,
                    tenQuan: 'Cà Phê Batch 5',
                    diaChi: 'Q1, TP.HCM',
                    nguoiIn: 'Thu ngân Lan',
                    laBanSao: true,
                },
            });

            assert.ok(
                [200, 202].includes(res.statusCode),
                `Z-Report sync phải trả 200/202, nhận ${res.statusCode}: ${res.body}`
            );
            assert.equal(res.json?.ok, true);
            assert.equal(res.json?.job?.maHoaDon, 'CA-20261125-01');
            const preview = String(res.json?.job?.previewText || '');
            assert.ok(preview.includes('2,500,000d'), `previewText phải có tổng doanh thu 2,500,000d:\n${preview}`);
            assert.ok(preview.includes('1,250,000d'), 'previewText phải có tiền mặt 1,250,000d');
            assert.ok(preview.includes('850,000d'), 'previewText phải có chuyển khoản 850,000d');
            assert.ok(preview.includes('1,240,000d'), 'previewText phải có quỹ lý thuyết 1,240,000d');
            assert.ok(preview.includes('+50,000d'), 'previewText phải có chênh lệch +50,000d');
            assert.ok(preview.includes('BAN SAO - REPRINT'), 'Phải giữ cờ laBanSao từ payload');
        } finally {
            cleanup();
        }
    });

    it('3. CORS middleware bridge-server.js trả 200/204 cho origin hợp lệ (localhost, Vercel HTTPS, custom domain) và 403 cho origin lạ', async () => {
        // Kiểm tra file config gốc trong repo không còn allowedOrigins: [] và có file example
        const repoCfg = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'local-print-bridge', 'bridge-config.json'), 'utf8')
        );
        assert.ok(
            Array.isArray(repoCfg.security?.allowedOrigins) && repoCfg.security.allowedOrigins.length > 0,
            'bridge-config.json không được để allowedOrigins rỗng []'
        );
        assert.equal(String(repoCfg.security?.apiToken || '').trim(), '', 'Không hardcode apiToken trong repo');
        assert.ok(
            fs.existsSync(path.join(ROOT, 'local-print-bridge', 'bridge-config.example.json')),
            'Phải có bridge-config.example.json làm tài liệu cấu hình'
        );

        const testToken = 'batch5_cors_test_token_0123456789abcdef0123456789abcdef';
        const { mod, cleanup } = loadIsolatedBridge({
            configData: {
                security: {
                    apiToken: '',
                    allowedOrigins: ['https://*.vercel.app', 'https://cafepos.vn'],
                },
            },
            envOverrides: {
                PRINT_BRIDGE_TOKEN: testToken,
                PRINT_BRIDGE_ALLOWED_ORIGINS: 'https://pos.quancuaban.vn',
            },
        });

        try {
            // Không bao giờ cho phép wildcard '*'
            assert.equal(mod.matchOriginPattern('https://evil.example.com', '*'), false);

            // (a) Preflight OPTIONS từ Vercel HTTPS -> 204 + headers CORS + PNA
            const optVercel = await invokeBridgeHandler(mod.handleBridgeRequest, {
                method: 'OPTIONS',
                url: '/print/receipt',
                headers: { origin: 'https://cafe-pos-demo.vercel.app' },
            });
            assert.equal(optVercel.statusCode, 204);
            assert.equal(optVercel.headers['Access-Control-Allow-Origin'], 'https://cafe-pos-demo.vercel.app');
            assert.equal(optVercel.headers['Access-Control-Allow-Private-Network'], 'true');

            // (b) GET /health từ Custom HTTPS Domain cấu hình qua env PRINT_BRIDGE_ALLOWED_ORIGINS -> 200
            const customDomain = await invokeBridgeHandler(mod.handleBridgeRequest, {
                method: 'GET',
                url: '/health',
                headers: { origin: 'https://pos.quancuaban.vn' },
            });
            assert.equal(customDomain.statusCode, 200);
            assert.equal(customDomain.headers['Access-Control-Allow-Origin'], 'https://pos.quancuaban.vn');

            // (c) GET /health từ localhost -> 200
            const localhostRes = await invokeBridgeHandler(mod.handleBridgeRequest, {
                method: 'GET',
                url: '/health',
                headers: { origin: 'http://localhost:5173' },
            });
            assert.equal(localhostRes.statusCode, 200);
            assert.equal(localhostRes.headers['Access-Control-Allow-Origin'], 'http://localhost:5173');

            // (d) Origin lạ / giả mạo -> 403 Forbidden (không gắn Access-Control-Allow-Origin)
            for (const badOrigin of [
                'https://evil-attacker.com',
                'https://fakevercel.app',
                'http://cafe-pos-demo.vercel.app', // HTTP downgrade không khớp https://*.vercel.app
            ]) {
                const blockedOpt = await invokeBridgeHandler(mod.handleBridgeRequest, {
                    method: 'OPTIONS',
                    url: '/print/receipt',
                    headers: { origin: badOrigin },
                });
                assert.equal(blockedOpt.statusCode, 403, `Origin lạ ${badOrigin} (OPTIONS) phải bị chặn 403`);
                assert.equal(blockedOpt.headers['Access-Control-Allow-Origin'], undefined);

                const blockedGet = await invokeBridgeHandler(mod.handleBridgeRequest, {
                    method: 'GET',
                    url: '/health',
                    headers: { origin: badOrigin },
                });
                assert.equal(blockedGet.statusCode, 403, `Origin lạ ${badOrigin} (GET) phải bị chặn 403`);
                assert.equal(blockedGet.headers['Access-Control-Allow-Origin'], undefined);
            }
        } finally {
            cleanup();
        }
    });

    it('4. escposRaster.js đã được import & gọi thật trong printHelper.js (hỗ trợ bật/tắt & K80/K58) và printBridge.js', async () => {
        const printHelperSrc = fs.readFileSync(
            path.join(ROOT, 'frontend', 'src', 'utils', 'printHelper.js'),
            'utf8'
        );
        const printBridgeSrc = fs.readFileSync(
            path.join(ROOT, 'frontend', 'src', 'utils', 'printBridge.js'),
            'utf8'
        );

        assert.match(printHelperSrc, /from\s+['"]\.\/escposRaster['"]/, 'printHelper.js phải import từ ./escposRaster');
        assert.ok(
            printHelperSrc.includes('renderVietnameseReceiptToCanvas'),
            'printHelper.js phải kết nối renderVietnameseReceiptToCanvas'
        );
        assert.ok(
            printHelperSrc.includes('buildReceiptRasterPayload('),
            'printReceiptK80 phải gọi buildReceiptRasterPayload để tạo rasterBase64'
        );
        assert.match(printBridgeSrc, /from\s+['"]\.\/escposRaster['"]/, 'printBridge.js phải hỗ trợ rasterBytes/rasterBase64');
        assert.ok(printBridgeSrc.includes('vietnameseRaster'), 'printBridge settings phải có cờ vietnameseRaster');
        assert.ok(printBridgeSrc.includes('paperWidth'), 'printBridge settings phải có cấu hình paperWidth K80/K58');

        // Kiểm thử runtime trực tiếp escposRaster.js
        const rasterUrl = pathToFileURL(path.join(ROOT, 'frontend', 'src', 'utils', 'escposRaster.js')).href;
        const {
            rgbaToEscPosRasterGsV0,
            uint8ToBase64,
            base64ToUint8,
            wrapEscPosRasterReceiptBytes,
            resolvePaperWidthPx,
        } = await import(rasterUrl);

        assert.equal(resolvePaperWidthPx('K80'), 576);
        assert.equal(resolvePaperWidthPx('K58'), 384);

        const sampleRgba = new Uint8ClampedArray(16 * 16 * 4).fill(255);
        sampleRgba[0] = 0; sampleRgba[1] = 0; sampleRgba[2] = 0; sampleRgba[3] = 255;
        const gsV0 = rgbaToEscPosRasterGsV0(sampleRgba, 16, 16);
        assert.deepEqual([...gsV0.slice(0, 4)], [0x1d, 0x76, 0x30, 0x00], 'Header phải bắt đầu bằng GS v 0 0');

        const b64 = uint8ToBase64(gsV0);
        assert.deepEqual([...base64ToUint8(b64)], [...gsV0], 'uint8ToBase64/base64ToUint8 phải round-trip chính xác');

        const wrapped = wrapEscPosRasterReceiptBytes(gsV0, { kickDrawer: true, autoCut: true });
        assert.deepEqual([...wrapped.slice(0, 2)], [0x1b, 0x40], 'Bắt đầu bằng ESC @');
        assert.deepEqual([...wrapped.slice(2, 7)], [0x1b, 0x70, 0x00, 0x19, 0xfa], 'Có xung mở két RJ11 ESC p 0 25 250');
        assert.deepEqual([...wrapped.slice(wrapped.length - 4)], [0x1d, 0x56, 0x42, 0x00], 'Kết thúc bằng lệnh cắt giấy GS V 66 0');

        // Kiểm tra hàm buildReceiptRasterPayload trực tiếp từ printHelper.js?
        // Lưu ý printHelper.js import các module browser-only (axios/indexedDB) nên ta kiểm tra hợp đồng call-site + raster payload
        assert.ok(
            printHelperSrc.includes("const useVietnameseRaster ="),
            'printReceiptK80 phải đọc cờ cấu hình vietnameseRaster'
        );
        assert.ok(
            printHelperSrc.includes("const effectivePaperWidth ="),
            'printReceiptK80 phải đọc cấu hình khổ giấy paperWidth K80/K58'
        );
    });

    it('5. Hotkey [F9] / [F10] / [F4] bị chặn tuyệt đối khi có Modal/Dialog mở hoặc đang focus Input/Textarea/Select', async () => {
        const hotkeysUrl = pathToFileURL(path.join(ROOT, 'frontend', 'src', 'utils', 'posHotkeys.js')).href;
        const { shouldBlockPosHotkey, isEditableElement, hasDomOpenModal } = await import(hotkeysUrl);

        // Chặn khi có bất kỳ modal React state nào mở
        for (const key of ['F1', 'F2', 'F4', 'F8', 'F9', 'F10']) {
            assert.equal(
                shouldBlockPosHotkey({ key, hasOpenModal: true }),
                true,
                `Phím ${key} phải bị chặn khi hasOpenModal=true`
            );
            assert.equal(
                shouldBlockPosHotkey({ key, hasDomModal: true }),
                true,
                `Phím ${key} phải bị chặn khi có modal DOM (role="dialog" / aria-modal)`
            );
        }

        // Chặn khi đang focus INPUT / TEXTAREA / SELECT / contentEditable
        assert.equal(isEditableElement({ tagName: 'INPUT' }), true);
        assert.equal(isEditableElement({ tagName: 'TEXTAREA' }), true);
        assert.equal(isEditableElement({ tagName: 'SELECT' }), true);
        assert.equal(isEditableElement({ tagName: 'DIV', isContentEditable: true }), true);
        assert.equal(isEditableElement({ tagName: 'BUTTON' }), false);

        assert.equal(
            shouldBlockPosHotkey({ key: 'F9', target: { tagName: 'INPUT' } }),
            true,
            '[F9] phải bị chặn khi target là INPUT'
        );
        assert.equal(
            shouldBlockPosHotkey({ key: 'F9', activeElement: { tagName: 'TEXTAREA' } }),
            true,
            '[F9] phải bị chặn khi activeElement là TEXTAREA'
        );
        assert.equal(
            shouldBlockPosHotkey({ key: 'F10', activeElement: { tagName: 'SELECT' } }),
            true,
            '[F10] phải bị chặn khi activeElement là SELECT'
        );

        // Cho phép [F9] khi không có modal & không focus input
        assert.equal(
            shouldBlockPosHotkey({
                key: 'F9',
                hasOpenModal: false,
                hasDomModal: false,
                target: { tagName: 'BODY' },
                activeElement: { tagName: 'BODY' },
            }),
            false,
            '[F9] phải hoạt động bình thường trên POS khi không có modal/input focus'
        );

        // Escape luôn được cho phép để đóng modal
        assert.equal(shouldBlockPosHotkey({ key: 'Escape', hasOpenModal: true }), false);
        assert.equal(shouldBlockPosHotkey({ key: 'Escape', activeElement: { tagName: 'INPUT' } }), false);

        // hasDomOpenModal phát hiện dialog mở
        assert.equal(
            hasDomOpenModal({ querySelector: (sel) => (sel.includes('role="dialog"') ? {} : null) }),
            true
        );
        assert.equal(hasDomOpenModal({ querySelector: () => null }), false);

        // Kiểm tra PosPage.jsx & useBarcodeScanner.js đã gắn guard thật
        const posSrc = fs.readFileSync(
            path.join(ROOT, 'frontend', 'src', 'pages', 'pos', 'PosPage.jsx'),
            'utf8'
        );
        const barcodeSrc = fs.readFileSync(
            path.join(ROOT, 'frontend', 'src', 'hooks', 'useBarcodeScanner.js'),
            'utf8'
        );
        assert.ok(posSrc.includes('shouldBlockPosHotkey('), 'PosPage.jsx phải gọi shouldBlockPosHotkey trong listener keydown');
        assert.ok(posSrc.includes('hasDomOpenModal()'), 'PosPage.jsx phải kiểm tra hasDomOpenModal()');
        assert.ok(posSrc.includes('enabled: !hasOpenModal'), 'PosPage.jsx phải tắt useBarcodeScanner khi có modal mở');
        assert.ok(posSrc.includes('setPickingCombo(null)'), 'Escape trên PosPage.jsx phải đóng cả pickingCombo');
        assert.ok(posSrc.includes('setReprintPrompt(null)'), 'Escape trên PosPage.jsx phải đóng cả reprintPrompt');
        assert.ok(posSrc.includes('setShowPinSwitchModal(false)'), 'Escape trên PosPage.jsx phải đóng cả showPinSwitchModal');
        assert.ok(barcodeSrc.includes('hasDomOpenModal()'), 'useBarcodeScanner.js phải chặn khi có dialog mở trên DOM');
    });
});
