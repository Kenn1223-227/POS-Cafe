#!/usr/bin/env node
/**
 * Unit & Local Integration Tests cho Phân hệ 7 (chạy độc lập không cần Internet / Remote DB):
 * 1. Xác minh Migration 019 vá xung đột overload fn_lookup_open_invoice_by_codes & có FORCE RLS cho Refresh_Tokens
 * 2. Xác minh sinh mã Offline OFF-${deviceId}-${YYYYMMDD}-${ULID_SHORT} không trùng trên 5.000 mẫu liên tiếp trong cùng 1 giây
 * 3. Xác minh bộ tính Khuyến mãi & Điểm Loyalty Offline (evaluateOfflinePromo)
 * 4. Xác minh Cookie HttpOnly parser / builder & Refresh Token SHA-256 hashing trong middleware.js
 * 5. Xác minh Observability (Slow Query Telemetry, p95 metrics) & Redis fallback Rate Limit Store
 * 6. Xác minh bộ lọc đóng gói sạch scripts/pack-clean.js (loại bỏ node_modules, .env, *.zip)
 * 7. Kiểm thử thực tế Local Print Bridge & POS LAN Hub (POST /lan/orders -> GET /lan/orders -> PUT status -> POST synced)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function testMigration019Sql() {
    const sqlPath = path.join(__dirname, '..', 'db', 'migrations', '019_fix_webhook_overload_and_offline_ulid.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    assert(
        /DROP FUNCTION IF EXISTS public\.fn_lookup_open_invoice_by_codes\(text\[\]\);/i.test(sql),
        'Migration 019 phải DROP bản 1 tham số fn_lookup_open_invoice_by_codes(text[])'
    );
    assert(
        /CREATE OR REPLACE FUNCTION public\.fn_lookup_open_invoice_by_codes\(\s*p_codes TEXT\[\],\s*p_tenant_id TEXT DEFAULT NULL/i.test(sql),
        'Migration 019 phải giữ duy nhất bản 2 tham số fn_lookup_open_invoice_by_codes(p_codes TEXT[], p_tenant_id TEXT DEFAULT NULL)'
    );
    assert(
        /ALTER TABLE public\.Refresh_Tokens FORCE ROW LEVEL SECURITY/i.test(sql),
        'Migration 019 phải bật FORCE ROW LEVEL SECURITY trên bảng Refresh_Tokens'
    );
    assert(
        /REVOKE ALL ON FUNCTION %s FROM PUBLIC/i.test(sql),
        'Migration 019 phải REVOKE ALL FROM PUBLIC cho các hàm SECURITY DEFINER'
    );
    console.log('✅ PASS: Migration 019 SQL structure & P0 overload drop verified');
}

async function testOfflineUlidAndPromoEngine() {
    // Load ESM module offlineDb.js bằng dynamic import
    const offlineDbUrl = 'file:///' + path.join(__dirname, '..', 'frontend', 'src', 'offline', 'offlineDb.js').replace(/\\/g, '/');
    const offlineDb = await import(offlineDbUrl);

    const fixedNow = new Date('2026-11-22T08:30:45.123Z');
    const seen = new Set();
    for (let i = 0; i < 5000; i++) {
        const id = offlineDb.generateOfflineClientId(fixedNow);
        assert(
            /^OFF-[A-Z0-9]{4}-\d{8}-[A-Z0-9]{8}$/.test(id),
            `Offline Client ID phải khớp định dạng OFF-DEV4-YYYYMMDD-ULID8 (got ${id})`
        );
        assert(!seen.has(id), `Phát hiện trùng Offline Client ID tại vòng ${i}: ${id}`);
        seen.add(id);
    }
    console.log('✅ PASS: 5.000 mã Offline OFF-DEV-YYYYMMDD-ULID sinh trong cùng 1ms có 0 xung đột');

    // Kiểm tra evaluateOfflinePromo (Mã giảm % có trần + đổi điểm Loyalty)
    const promotions = {
        vndMoiDiemDoi: 1000,
        happyHours: [
            { id: 1, loaiKM: 'HAPPY_HOUR', tenChuongTrinh: 'Giờ vàng -10%', kieuGiam: 'PERCENT', giaTriGiam: 10, donToiThieu: 0 },
        ],
        codes: [
            {
                id: 2,
                loaiKM: 'CODE',
                maCode: 'CAFE20',
                tenChuongTrinh: 'Giảm 20% tối đa 30k',
                kieuGiam: 'PERCENT',
                giaTriGiam: 20,
                giamToiDa: 30000,
                donToiThieu: 50000,
            },
        ],
    };

    const resCode = offlineDb.evaluateOfflinePromo({
        promotions,
        tongTamTinh: 200000,
        maKhuyenMai: 'cafe20',
        customer: { maKH: 'KH1', diemTichLuy: 25 },
        diemSuDung: 20,
    });
    assert.strictEqual(resCode.tienGiamKM, 30000, 'Mã CAFE20 giảm 20% của 200k phải bị chặn trần 30k');
    assert.strictEqual(resCode.tienGiamDiem, 20000, 'Đổi 20 điểm phải giảm 20.000đ');
    assert.strictEqual(resCode.tongSauGiam, 150000, 'Tổng sau giảm phải bằng 150.000đ');

    const resHH = offlineDb.evaluateOfflinePromo({
        promotions,
        tongTamTinh: 100000,
        maKhuyenMai: null,
        customer: null,
        diemSuDung: 0,
        tuDongHappyHour: true,
    });
    assert.strictEqual(resHH.tienGiamKM, 10000, 'Tự động Happy Hour -10% của 100k phải bằng 10k');
    console.log('✅ PASS: Offline Promotion & Loyalty Point Engine tính chính xác 100%');
}

async function testMiddlewareCookiesAndObservability() {
    const mw = require('../middleware');
    const obs = require('../modules/observability');
    const redisCluster = require('../modules/redisCluster');

    const rawTok = mw.generateRefreshToken();
    assert(rawTok.length >= 48, 'Refresh token ngẫu nhiên phải >= 48 ký tự');
    const h1 = mw.hashRefreshToken(rawTok);
    const h2 = mw.hashRefreshToken(rawTok);
    assert.strictEqual(h1, h2, 'hashRefreshToken phải deterministic');
    assert.strictEqual(h1.length, 64, 'SHA-256 hex digest phải dài 64 ký tự');

    const parsed = mw.parseCookies({ headers: { cookie: `foo=bar; ${mw.REFRESH_COOKIE_NAME}=${encodeURIComponent(rawTok)}; x=1` } });
    assert.strictEqual(parsed[mw.REFRESH_COOKIE_NAME], rawTok, 'parseCookies phải đọc đúng pos_refresh_token');

    const capturedHeaders = [];
    const mockRes = { append: (k, v) => capturedHeaders.push([k, v]) };
    mw.setRefreshCookie(mockRes, { secure: true, headers: {} }, rawTok, 3600);
    assert(capturedHeaders.length === 1 && /HttpOnly/.test(capturedHeaders[0][1]) && /Secure/.test(capturedHeaders[0][1]), 'Set-Cookie phải có HttpOnly và Secure');

    obs.recordDbQueryMetric({ durationMs: 12, sql: 'SELECT 1', tenantId: 'T1' });
    obs.recordDbQueryMetric({ durationMs: 650, sql: 'SELECT * FROM HoaDon', tenantId: 'T1' });
    const snap = obs.getDbMetricsSnapshot();
    assert(snap.totalQueries >= 2 && snap.slowQueries >= 1 && snap.maxDurationMs >= 650, 'DB Slow Query Telemetry phải ghi nhận truy vấn chậm');

    const rl = redisCluster.createRateLimitStore('unit_test');
    const s1 = await rl.increment('ip1', 60000);
    const s2 = await rl.increment('ip1', 60000);
    assert.strictEqual(s1.dem, 1);
    assert.strictEqual(s2.dem, 2);
    await rl.reset('ip1');
    const s3 = await rl.get('ip1');
    assert.strictEqual(s3, null);
    console.log('✅ PASS: HttpOnly Cookie helpers, Observability Slow-Query Telemetry & Rate Limit Store verified');
}

async function testCleanPackFilter() {
    const { shouldSkip } = require('./pack-clean');
    assert.strictEqual(shouldSkip('node_modules', true), true);
    assert.strictEqual(shouldSkip('dist', true), true);
    assert.strictEqual(shouldSkip('.env', false), true);
    assert.strictEqual(shouldSkip('.env.example', false), false);
    assert.strictEqual(shouldSkip('cafe-pos-backend.zip', false), true);
    assert.strictEqual(shouldSkip('server.js', false), false);
    console.log('✅ PASS: Clean packager excludes node_modules, dist, .env, *.zip while keeping .env.example & source');
}

async function testLocalLanPosHub() {
    const { EventEmitter } = require('events');
    const os = require('os');
    const bridgeToken = 'unit-test-bridge-token-12345';
    process.env.PRINT_BRIDGE_TOKEN = bridgeToken;
    process.env.PRINT_BRIDGE_CONFIG_PATH = path.join(os.tmpdir(), `pos-unit-bridge-cfg-${Date.now()}.json`);
    const { handleBridgeRequest } = require('../local-print-bridge/bridge-server');

    const invoke = (method, urlPath, bodyObj = null, extraHeaders = {}) =>
        new Promise((resolve) => {
            const req = new EventEmitter();
            req.method = method;
            req.url = urlPath;
            req.headers = {
                origin: 'http://localhost:5173',
                'x-print-bridge-token': bridgeToken,
                ...extraHeaders,
            };
            let statusCode = 200;
            let rawBody = '';
            const res = {
                writeHead: (code) => {
                    statusCode = code;
                },
                write: (chunk) => {
                    rawBody += String(chunk);
                },
                end: (chunk) => {
                    if (chunk) rawBody += String(chunk);
                    let json = null;
                    try {
                        json = JSON.parse(rawBody);
                    } catch {
                        json = rawBody;
                    }
                    resolve({ status: statusCode, data: json });
                },
            };
            void handleBridgeRequest(req, res);
            if (bodyObj !== null) {
                req.emit('data', JSON.stringify(bodyObj));
            }
            req.emit('end');
        });

    try {
        const health = await invoke('GET', '/health');
        assert(health.status === 200 && health.data?.ok === true && health.data?.lanHub?.enabled === true, 'Bridge /health phải bật lanHub');

        // Bảo mật L2.3: Thiếu token -> 401; Origin lạ -> 403
        const noAuthRes = await invoke('GET', '/lan/orders?tenantId=TN_UNIT', null, { 'x-print-bridge-token': '' });
        assert.strictEqual(noAuthRes.status, 401, 'GET /lan/orders không token phải trả 401');
        const evilOriginRes = await invoke('GET', '/health', null, { origin: 'https://evil.example' });
        assert.strictEqual(evilOriginRes.status, 403, 'Origin lạ phải bị chặn 403');

        // 1. Thu ngân bắn đơn Offline lên LAN Hub
        const offId = 'OFF-UNIT-20261122-ABCDE123';
        const createRes = await invoke('POST', '/lan/orders', {
            tenantId: 'TN_UNIT',
            offlineClientId: offId,
            tableName: 'Bàn 05',
            type: 'ORDER_CREATE',
            totalAmount: 95000,
            localInvoice: {
                maHoaDon: offId,
                danhSachMon: [
                    { maCTHD: `${offId}-1`, maMon: 'CF01', tenMon: 'Bạc Xỉu', kichThuoc: 'M', soLuong: 2 },
                ],
            },
        });
        assert.strictEqual(createRes.status, 201, 'POST /lan/orders phải trả về 201');

        // 2. Barista Tablet đọc đơn LAN của đúng Tenant (và Tenant khác không thấy!)
        const listRes = await invoke('GET', '/lan/orders?tenantId=TN_UNIT');
        assert(listRes.data.orders.some((o) => o.offlineClientId === offId), 'Barista phải thấy đơn Offline qua LAN Hub');
        const listOther = await invoke('GET', '/lan/orders?tenantId=TN_OTHER');
        assert(!listOther.data.orders.some((o) => o.offlineClientId === offId), 'Tenant khác không được thấy đơn LAN của TN_UNIT');

        // 3. Barista cập nhật trạng thái món -> DaXong
        const updRes = await invoke(
            'PUT',
            `/lan/orders/${encodeURIComponent(offId)}/items/${encodeURIComponent(`${offId}-1`)}/status`,
            { trangThaiPhaChe: 'DaXong' }
        );
        assert(updRes.status === 200 && updRes.data?.item?.trangThaiPhaChe === 'DaXong', 'PUT LAN item status phải cập nhật thành DaXong');

        // 4. Khi có mạng lại, Thu ngân đánh dấu đơn đã sync lên Cloud -> dọn khỏi hàng đợi LAN active
        const syncRes = await invoke('POST', `/lan/orders/${encodeURIComponent(offId)}/synced`, {});
        assert.strictEqual(syncRes.status, 200);

        const afterSync = await invoke('GET', '/lan/orders?tenantId=TN_UNIT');
        assert(!afterSync.data.orders.some((o) => o.offlineClientId === offId), 'Đơn đã sync Cloud phải biến mất khỏi hàng đợi LAN active');

        console.log('✅ PASS: Local-LAN POS Hub (Thu ngân -> Barista LAN Fallback, Tenant Isolation & Cloud Sync Ack) verified');
    } finally {
        const tmpLanFile = path.join(__dirname, '..', 'local-print-bridge', 'lan-orders.json');
        if (fs.existsSync(tmpLanFile)) fs.unlinkSync(tmpLanFile);
    }
}

async function main() {
    console.log('🧪 Chạy bộ Unit & Local Integration Tests cho Phân hệ 7...\n');
    await testMigration019Sql();
    await testOfflineUlidAndPromoEngine();
    await testMiddlewareCookiesAndObservability();
    await testCleanPackFilter();
    await testLocalLanPosHub();
    console.log('\n🎉 TOÀN BỘ UNIT TESTS PHÂN HỆ 7 ĐỀU ĐẠT 100%!');
}

main().catch((err) => {
    console.error('❌ UNIT TEST FAILED:', err);
    process.exit(1);
});
