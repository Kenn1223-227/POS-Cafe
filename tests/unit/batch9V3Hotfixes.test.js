'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
if (!process.env.PRINT_BRIDGE_CONFIG_PATH) {
    process.env.PRINT_BRIDGE_CONFIG_PATH = path.join(os.tmpdir(), `bridge-config-b9-${process.pid}.json`);
}
const { createOrderHelpers } = require('../../src/core/orderHelpers');
const { registerSystemDomain } = require('../../src/domains/system');
const { createRegisterRateLimiter } = require('../../modules/saasRoutes');
const { createRateLimitStore } = require('../../modules/redisCluster');
const { dispatchRawBuffer } = require('../../local-print-bridge/printerTransport');
const { DEFAULT_ALLOWED_ORIGINS } = require('../../local-print-bridge/bridge-server');

function createMockOrderClient() {
    const queries = [];
    return {
        queries,
        async query(sql, params = []) {
            const q = String(sql || '');
            queries.push({ sql: q, params });
            if (q.includes('SAVEPOINT') || q.includes('RELEASE SAVEPOINT') || q.includes('ROLLBACK TO SAVEPOINT')) {
                return { rows: [] };
            }
            if (/FROM\s+SanPham\b/i.test(q) || /FROM\s+public\.sanpham\b/i.test(q)) {
                return {
                    rows: [
                        {
                            mamon: 'CF01',
                            tenmon: 'Cà phê sữa đá',
                            kichthuoc: 'M',
                            giaban: 35000,
                            tamhet: false,
                            lamonthoigia: false,
                            donvibanhang: 'LY',
                            nhommon: 'CAFE',
                            soluonggioihan86: null,
                        },
                    ],
                };
            }
            if (/FROM\s+SanPham_Size/i.test(q)) {
                return {
                    rows: [{ mamon: 'CF01', kichthuoc: 'M', giaban: 35000 }],
                };
            }
            if (/INSERT\s+INTO\s+HoaDon\b/i.test(q)) {
                return { rows: [{ mahoadon: 'HD_B9_01', sothutuhienthi: '001' }] };
            }
            if (/INSERT\s+INTO\s+ChiTietHoaDon\b/i.test(q)) {
                return { rows: [{ macthd: 901 }] };
            }
            if (/SELECT\s+COALESCE\(MAX\(DotGoi\)/i.test(q)) {
                return { rows: [{ max_dot: 0 }] };
            }
            if (/SELECT\s+Version/i.test(q)) {
                return { rows: [{ version: 1 }] };
            }
            if (/FROM\s+HoaDon\b/i.test(q)) {
                return {
                    rows: [
                        {
                            mahoadon: 'HD_B9_01',
                            trangthaitt: 0,
                            makh: null,
                            makhuyenmai: null,
                            tiengiamkm: 0,
                            diemsudung: 0,
                            tiengiamdiem: 0,
                            cachtinhthue: 'INCLUDED',
                            thuevatphantram: 0,
                            phiphucvuphantram: 0,
                            phidonggoi: 0,
                        },
                    ],
                };
            }
            return { rows: [] };
        },
    };
}

test('Batch 9 Unit — P0-2, P0-3, P0-7 Security & Hotfix Verification', async (t) => {
    await t.test('1. P0-3: laMonTang / chietKhauMon bởi Role 3/4 không PIN bị chặn 403; có PIN Quản lý hợp lệ thành công & ghi Audit Log', async () => {
        const auditLogs = [];
        const helpers = createOrderHelpers({
            pool: { query: async () => ({ rows: [] }) },
            io: null,
            runtimeFlags: { idemSanSang: false, auditSanSang: true, paymentsSanSang: false },
            chayGiaoDich: async (fn) => fn(createMockOrderClient()),
            ghiAuditLog: async (_client, entry) => {
                auditLogs.push(entry);
            },
            dispatchFraudAlertFromAudit: null,
            kiemTraCanhBaoTanSuatGianLan: null,
            coQuyenHan: () => false,
            xacThucPinQuanLy: async (_client, _tenantId, pin) => {
                if (pin === '9999') return { maNV: 'QL01', tenNV: 'Quản Lý 1' };
                return null;
            },
        });

        // 1a. Role 4 (Thu ngân) tặng món không PIN -> 403 COMP_DISCOUNT_FORBIDDEN
        await assert.rejects(
            () =>
                helpers.taoOrderTrongGiaoDich(createMockOrderClient(), {
                    tenantId: 'TENANT_A',
                    maNV: 'NV04',
                    vaiTro: 4,
                    danhSachMon: [
                        {
                            maMon: 'CF01',
                            kichThuoc: 'M',
                            soLuong: 1,
                            laMonTang: true,
                            lyDoTang: 'Khách quen',
                        },
                    ],
                }),
            (err) => err.status === 403 && err.chiTiet?.code === 'COMP_DISCOUNT_FORBIDDEN'
        );

        // 1b. Role 3 (Phục vụ) chiết khấu dòng món không PIN -> 403 COMP_DISCOUNT_FORBIDDEN
        await assert.rejects(
            () =>
                helpers.taoOrderTrongGiaoDich(createMockOrderClient(), {
                    tenantId: 'TENANT_A',
                    maNV: 'NV03',
                    vaiTro: 3,
                    danhSachMon: [
                        {
                            maMon: 'CF01',
                            kichThuoc: 'M',
                            soLuong: 1,
                            chietKhauMon: 5000,
                        },
                    ],
                }),
            (err) => err.status === 403 && err.chiTiet?.code === 'COMP_DISCOUNT_FORBIDDEN'
        );

        // 1c. Có PIN Quản lý hợp lệ -> thành công & ghi Audit Log ITEM_COMP_APPLIED + ITEM_LINE_DISCOUNT
        auditLogs.length = 0;
        const okRes = await helpers.taoOrderTrongGiaoDich(createMockOrderClient(), {
            tenantId: 'TENANT_A',
            maNV: 'NV04',
            vaiTro: 4,
            managerPin: '9999',
            danhSachMon: [
                { maMon: 'CF01', kichThuoc: 'M', soLuong: 1, laMonTang: true, lyDoTang: 'Đền món' },
                { maMon: 'CF01', kichThuoc: 'M', soLuong: 1, chietKhauMon: 10000, lyDo: 'Giảm 10k' },
            ],
        });
        assert.equal(okRes.maHoaDon, 'HD_B9_01');
        const compLog = auditLogs.find((a) => a.hanhDong === 'ITEM_COMP_APPLIED');
        const discLog = auditLogs.find((a) => a.hanhDong === 'ITEM_LINE_DISCOUNT');
        assert.ok(compLog, 'Phải ghi Audit Log ITEM_COMP_APPLIED');
        assert.ok(discLog, 'Phải ghi Audit Log ITEM_LINE_DISCOUNT');
        assert.equal(compLog.nguoiDuyet, 'QL01');
        assert.equal(discLog.giaTriMoi.soTienGiam, 10000);

        // 1d. Chặn cứng chietKhauMon > lineGross (35000) -> 400
        await assert.rejects(
            () =>
                helpers.taoOrderTrongGiaoDich(createMockOrderClient(), {
                    tenantId: 'TENANT_A',
                    maNV: 'QL01',
                    vaiTro: 1,
                    danhSachMon: [{ maMon: 'CF01', kichThuoc: 'M', soLuong: 1, chietKhauMon: 50000 }],
                }),
            (err) => err.status === 400 && err.chiTiet?.code === 'ITEM_DISCOUNT_EXCEEDS_LINE_TOTAL'
        );
    });

    await t.test('2. P0-7: Webhook /:tenantSlug từ chối 401/403 khi quán chưa cấu hình khóa riêng dù global SEPAY_API_KEY có giá trị', () => {
        const prevSepay = process.env.SEPAY_API_KEY;
        const prevPayos = process.env.PAYOS_CHECKSUM_KEY;
        process.env.SEPAY_API_KEY = 'GLOBAL_SECRET_KEY';
        process.env.PAYOS_CHECKSUM_KEY = 'GLOBAL_PAYOS_KEY';
        try {
            const fakeApp = { get() {}, post() {}, put() {}, delete() {} };
            const sys = registerSystemDomain(fakeApp, {
                pool: {},
                io: null,
                runtimeFlags: {},
                chayGiaoDich: async () => {},
                qTenant: async () => ({ rows: [] }),
                kiemTraToken: (_req, _res, next) => next(),
                yeuCauTinhNang: () => (_req, _res, next) => next(),
                xoaCacheEntitlement: () => {},
                ghiAuditLog: async () => {},
                dispatchFraudAlertFromAudit: null,
                kiemTraCanhBaoTanSuatGianLan: null,
                xacThucPinQuanLy: null,
                layCaDangMo: async () => null,
                layHoaDonChiTiet: async () => null,
                ghiNhanThanhToanTrongGiaoDich: async () => ({}),
            });

            // Với allowGlobalFallback: false (route có :tenantSlug) -> phải từ chối 401 dù gửi đúng global key!
            const sepayRes = sys.xacThucSePay(
                { headers: { authorization: 'Apikey GLOBAL_SECRET_KEY' } },
                null,
                { allowGlobalFallback: false }
            );
            assert.equal(sepayRes.ok, false);
            assert.ok([401, 403].includes(sepayRes.status));

            const payosRes = sys.xacThucPayOS(
                { data: { amount: 10000 }, signature: 'deadbeef' },
                null,
                { allowGlobalFallback: false }
            );
            assert.equal(payosRes.ok, false);
            assert.ok([401, 403].includes(payosRes.status));
        } finally {
            if (prevSepay === undefined) delete process.env.SEPAY_API_KEY;
            else process.env.SEPAY_API_KEY = prevSepay;
            if (prevPayos === undefined) delete process.env.PAYOS_CHECKSUM_KEY;
            else process.env.PAYOS_CHECKSUM_KEY = prevPayos;
        }
    });

    await t.test('3. P0-7: printerTransport từ chối shareName UNC từ xa & DEFAULT_ALLOWED_ORIGINS không chứa *.vercel.app', async () => {
        assert.equal(
            DEFAULT_ALLOWED_ORIGINS.includes('https://*.vercel.app'),
            false,
            'DEFAULT_ALLOWED_ORIGINS không được chứa wildcard https://*.vercel.app'
        );

        await assert.rejects(
            () =>
                dispatchRawBuffer(Buffer.from('TEST'), {
                    mode: 'WINDOWS_SHARE',
                    shareName: '\\\\evil-host\\share',
                }),
            /không hợp lệ|UNC/i
        );
    });

    await t.test('4. P0-7: POST /api/saas/register rate limiter chặn 429 khi gọi vượt ngưỡng liên tiếp', async () => {
        const limiter = createRegisterRateLimiter(createRateLimitStore('test_reg_b9'), 5, 60 * 60 * 1000);
        const statuses = [];
        for (let i = 0; i < 6; i += 1) {
            const req = { ip: '203.0.113.99' };
            let statusCode = 200;
            const res = {
                set() {},
                status(code) {
                    statusCode = code;
                    return this;
                },
                json() {
                    return this;
                },
            };
            let nextCalled = false;
            await limiter(req, res, () => {
                nextCalled = true;
            });
            statuses.push(nextCalled ? 200 : statusCode);
        }
        assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
    });

    await t.test('5. P0-3: print-relay/dispatch với kind=RECEIPT chặn thiếu printToken (403) & chặn tái sử dụng token (403)', async () => {
        const express = require('express');
        const http = require('http');
        const app = express();
        app.use(express.json());
        registerSystemDomain(app, {
            pool: {
                withTenant: async (_t, fn) =>
                    fn({
                        query: async () => ({ rows: [{ mahoadon: 'HD_PRT_1', solanin: 1 }] }),
                    }),
            },
            io: null,
            runtimeFlags: {},
            chayGiaoDich: async (fn) => fn({}),
            qTenant: async () => ({ rows: [] }),
            kiemTraToken: (req, _res, next) => {
                req.user = { maNV: 'NV04', vaiTro: 4, tenantId: 'T_PRT', branchId: 'CN01' };
                next();
            },
            yeuCauTinhNang: () => (_req, _res, next) => next(),
            xoaCacheEntitlement: () => {},
            ghiAuditLog: async () => {},
            dispatchFraudAlertFromAudit: null,
            kiemTraCanhBaoTanSuatGianLan: null,
            xacThucPinQuanLy: null,
            layCaDangMo: async () => null,
            layHoaDonChiTiet: async () => null,
            ghiNhanThanhToanTrongGiaoDich: async () => ({}),
        });

        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        try {
            const url = `http://127.0.0.1:${port}/api/print-relay/dispatch`;
            const noTokenRes = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: 'RECEIPT', payload: { maHoaDon: 'HD_PRT_1' } }),
            });
            assert.equal(noTokenRes.status, 403);

            const okRes = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind: 'RECEIPT',
                    printToken: 'PRT-HD_PRT_1-1-1700000000000',
                    payload: { maHoaDon: 'HD_PRT_1' },
                }),
            });
            assert.equal(okRes.status, 201);

            const replayRes = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind: 'RECEIPT',
                    printToken: 'PRT-HD_PRT_1-1-1700000000000',
                    payload: { maHoaDon: 'HD_PRT_1' },
                }),
            });
            assert.equal(replayRes.status, 403);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
