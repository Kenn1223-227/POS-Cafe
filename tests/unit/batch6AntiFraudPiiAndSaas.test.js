'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const EventEmitter = require('events');
const express = require('express');

const ROOT_DIR = path.resolve(__dirname, '../..');

const { createOrderHelpers, maskPhoneForInvoice } = require('../../src/core/orderHelpers');
const { registerKdsPhase2Routes } = require('../../modules/kdsPhase2Routes');
const { registerSystemDomain } = require('../../src/domains/system');
const { registerHrDomain } = require('../../src/domains/hr');
const { registerEcosystemPhase8Routes } = require('../../modules/ecosystemPhase8Routes');
const { registerEInvoiceRoutes } = require('../../modules/einvoiceRoutes');
const { registerPriceBookAndZnsRoutes } = require('../../modules/priceBookAndZnsRoutes');
const { registerChainFinanceOpsRoutes } = require('../../modules/chainFinanceOpsRoutes');
const { registerHrPayrollTipsRoutes } = require('../../modules/hrPayrollTipsRoutes');
const { registerSaasRoutes, tinhTienGoi } = require('../../modules/saasRoutes');
const {
    taoMiddlewareTinhNang,
    layEntitlementTenant,
    xoaCacheEntitlement,
} = require('../../modules/platformAdminRoutes');
const { PLAN_FEATURES } = require('../../modules/industryTemplates');
const { LoiNghiepVu, guiLoi, choPhepVaiTro } = require('../../src/core/auditAndSecurity');

function createExpressHarness(setupFn, { trustProxy = false } = {}) {
    const app = express();
    if (trustProxy !== false) {
        app.set('trust proxy', trustProxy);
    }
    setupFn(app);

    const request = (urlPath, { method = 'GET', headers = {}, body = undefined, remoteAddress = '127.0.0.1' } = {}) =>
        new Promise((resolve, reject) => {
            const req = new Readable({
                read() {
                    this.push(null);
                },
            });
            req.method = method.toUpperCase();
            req.url = urlPath;
            req.httpVersion = '1.1';
            req.httpVersionMajor = 1;
            req.httpVersionMinor = 1;
            req.headers = {};
            for (const [k, v] of Object.entries(headers || {})) {
                req.headers[k.toLowerCase()] = String(v);
            }
            if (body !== undefined) {
                req.body = typeof body === 'string' ? JSON.parse(body) : body;
                if (!req.headers['content-type']) req.headers['content-type'] = 'application/json';
            } else {
                req.body = {};
            }
            req.socket = Object.assign(new EventEmitter(), {
                remoteAddress,
                encrypted: false,
                destroy() {},
                resume() {},
                pause() {},
            });
            req.connection = req.socket;
            req.complete = true;

            const res = new EventEmitter();
            const chunks = [];
            const resHeaders = {};
            res.statusCode = 200;
            res.headersSent = false;
            res.locals = {};
            res.setHeader = (name, val) => {
                resHeaders[String(name).toLowerCase()] = val;
            };
            res.getHeader = (name) => resHeaders[String(name).toLowerCase()];
            res.getHeaders = () => ({ ...resHeaders });
            res.hasHeader = (name) => Object.prototype.hasOwnProperty.call(resHeaders, String(name).toLowerCase());
            res.removeHeader = (name) => {
                delete resHeaders[String(name).toLowerCase()];
            };
            res.writeHead = (code, hdrs) => {
                res.statusCode = code;
                if (hdrs && typeof hdrs === 'object') {
                    for (const [k, v] of Object.entries(hdrs)) res.setHeader(k, v);
                }
                return res;
            };
            res.write = (chunk) => {
                if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
                return true;
            };
            res.end = (chunk) => {
                if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
                res.headersSent = true;
                const text = Buffer.concat(chunks).toString('utf8');
                res.emit('finish');
                resolve({
                    status: res.statusCode,
                    headers: resHeaders,
                    text: async () => text,
                    json: async () => (text ? JSON.parse(text) : {}),
                });
            };

            app(req, res, (err) => {
                if (err) reject(err);
                else if (!res.headersSent) {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ message: 'Not Found' }));
                }
            });
        });

    return { app, request };
}

describe('Batch 6 — Counter Anti-Fraud, HR IP Anti-Spoof, NĐ 13/2023 PII & SaaS Feature Gating', () => {
    it('1a. item-swap sau DaInTamTinh: chặn 403 nếu thu ngân không có quyền / thiếu PIN, cho phép + ghi Audit Log đầy đủ khi có PIN Quản lý', async () => {
        const auditLogs = [];
        const mockClient = {
            query: async (sql) => {
                const s = String(sql).replace(/\s+/g, ' ').trim();
                if (s.includes('FROM ChiTietHoaDon c JOIN HoaDon hd')) {
                    return {
                        rows: [
                            {
                                macthd: 101,
                                mahoadon: 500,
                                mamon: 'MATCHA01',
                                kichthuoc: 'M',
                                soluong: 1,
                                dongia: 65000,
                                giamodifiers: 0,
                                giagiam: 0,
                                trangthaiphache: 'ChoPhaChe',
                                dotgoi: 1,
                                tramchebiencu: 'BAR_CHINH',
                                tenmoncu: 'Matcha Latte',
                                nhommoncu: 'Matcha',
                                lahangdonggoicu: false,
                                trangthaitt: 0,
                                makh: null,
                                tongtienthanhtoan: 65000,
                                macathungan: 1,
                                daintamtinh: true,
                                branchid: 'CN01',
                            },
                        ],
                    };
                }
                if (s.includes('FROM ChiTietHoaDon_Topping')) {
                    return { rows: [{ tong_tp: 0 }] };
                }
                if (s.includes('FROM SanPham sp JOIN SanPham_Size sz')) {
                    return {
                        rows: [
                            {
                                mamon: 'TRADA01',
                                tenmon: 'Trà đá',
                                nhommon: 'Trà',
                                tamhet: false,
                                tramchebien: 'BAR_LANH',
                                giaban: 10000,
                            },
                        ],
                    };
                }
                if (s.includes('FROM CongThuc')) {
                    return { rows: [] };
                }
                if (s.includes('INSERT INTO ChiTietHoaDon')) {
                    return { rows: [{ macthd: 202 }] };
                }
                if (s.includes('INSERT INTO public.kds_event_log')) {
                    return { rows: [{ seq: 1 }] };
                }
                return { rows: [] };
            },
        };

        const srv = createExpressHarness((app) => {
            registerKdsPhase2Routes(app, {
                pool: mockClient,
                chayGiaoDich: async (fn) => fn(mockClient),
                qTenant: async (_req, sql, params) => mockClient.query(sql, params),
                layTenantId: () => 'TENANT_B6',
                kiemTraToken: (req, _res, next) => {
                    req.user = { maNV: 'NV_THUNGAN', vaiTro: 4, tenantId: 'TENANT_B6', branchId: 'CN01' };
                    next();
                },
                choPhepVaiTro,
                coQuyenHan: (user) => Number(user?.vaiTro) === 1,
                xacThucPinQuanLy: async (_client, _tenantId, pin) =>
                    pin === '8899' ? { maNV: 'NV_MANAGER', tenNV: 'Quản Lý A', vaiTro: 1 } : null,
                ghiAuditLog: async (_client, entry) => {
                    auditLogs.push(entry);
                },
                guiLoi,
                LoiNghiepVu,
                io: null,
                roomTen: (t, r) => `t:${t}:${r}`,
                suyLuanTramCheBien: () => 'BAR_CHINH',
                layMonTheoMa: async (_c, ids) => ids.map((id) => ({ maCTHD: id, tramCheBien: 'BAR_LANH' })),
                layHoaDonChiTiet: async (_c, id) => ({ maHoaDon: id, daInTamTinh: true }),
                congDinhLuongNguyenLieuDongMon: async () => {},
                layMapGiaVonNguyenLieu: async () => new Map(),
                layCaDangMo: async () => ({ macathungan: 1 }),
            });
        });

        // (1) Thu ngân không có PIN -> BỊ CHẶN 403 dù món vẫn đang ChoPhaChe
        const blockedRes = await srv.request('/api/order/item-swap', {
            method: 'POST',
            body: {
                maCTHD: 101,
                newItem: { maMon: 'TRADA01', kichThuoc: 'M', soLuong: 1 },
                lyDo: 'Đổi món sau tạm tính không PIN',
            },
        });
        assert.equal(blockedRes.status, 403);
        const blockedBody = await blockedRes.json();
        assert.equal(blockedBody.code, 'PREBILL_SWAP_FORBIDDEN');
        assert.equal(blockedBody.maLoi, 'CAN_PIN_QUAN_LY');
        assert.equal(auditLogs.length, 0, 'Không được ghi nhận đổi món thành công khi bị chặn 403');

        // (2) Thu ngân gửi PIN sai -> VẪN BỊ CHẶN 403
        const badPinRes = await srv.request('/api/order/item-swap', {
            method: 'POST',
            body: {
                maCTHD: 101,
                newItem: { maMon: 'TRADA01', kichThuoc: 'M', soLuong: 1 },
                managerPin: '0000',
                lyDo: 'PIN sai',
            },
        });
        assert.equal(badPinRes.status, 403);

        // (3) Thu ngân có PIN Quản lý hợp lệ ('8899') -> ĐƯỢC PHÉP + GHI AUDIT LOG ĐẦY ĐỦ
        const okRes = await srv.request('/api/order/item-swap', {
            method: 'POST',
            body: {
                maCTHD: 101,
                newItem: { maMon: 'TRADA01', kichThuoc: 'M', soLuong: 1 },
                managerPin: '8899',
                lyDo: 'Khách đổi ý có quản lý duyệt',
            },
        });
        assert.equal(okRes.status, 200);
        assert.equal(auditLogs.length, 1);
        assert.equal(auditLogs[0].hanhDong, 'ITEM_SWAP_AFTER_PREBILL');
        assert.equal(auditLogs[0].nguoiDuyet, 'NV_MANAGER');
        assert.equal(auditLogs[0].giaTriCu.daInTamTinh, true);
        assert.equal(auditLogs[0].giaTriMoi.daInTamTinh, true);
        assert.equal(auditLogs[0].batBuoc, true);
    });

    it('1b. Xóa Offline Queue trên FE bắt buộc xác thực PIN Quản lý + API /api/pos/verify-manager-pin ghi Audit Log', async () => {
        const modalCode = fs.readFileSync(
            path.join(ROOT_DIR, 'frontend/src/pages/pos/components/OfflineQueueModal.jsx'),
            'utf8'
        );
        assert.match(modalCode, /mode="pin"/, 'OfflineQueueModal phải dùng ConfirmPinModal mode="pin"');
        assert.match(modalCode, /verifyManagerPin/, 'OfflineQueueModal phải gọi API xác thực PIN Quản lý');
        assert.doesNotMatch(modalCode, /mode="confirm"/, 'Không được cho phép xóa Offline Queue chỉ bằng mode="confirm"');

        const auditLogs = [];
        const mockPool = { withTenant: async (_t, fn) => fn({}) };
        const srv = createExpressHarness((app) => {
            registerSystemDomain(app, {
                pool: mockPool,
                io: null,
                runtimeFlags: {},
                chayGiaoDich: async (fn) => fn({}),
                qTenant: async () => ({ rows: [] }),
                kiemTraToken: (req, _res, next) => {
                    req.user = { maNV: 'NV_TN', vaiTro: 4, tenantId: 'T_OFF', branchId: 'CN01' };
                    next();
                },
                yeuCauTinhNang: () => (_req, _res, next) => next(),
                xoaCacheEntitlement: () => {},
                ghiAuditLog: async (_c, entry) => auditLogs.push(entry),
                dispatchFraudAlertFromAudit: () => {},
                kiemTraCanhBaoTanSuatGianLan: () => {},
                xacThucPinQuanLy: async (_c, _t, pin) =>
                    pin === '2468' ? { maNV: 'NV_QL', tenNV: 'Quản Lý B', vaiTro: 1 } : null,
            });
        });

        const failRes = await srv.request('/api/pos/verify-manager-pin', {
            method: 'POST',
            body: { managerPin: '1111', action: 'OFFLINE_QUEUE_ITEM_DELETED' },
        });
        assert.equal(failRes.status, 403);
        assert.equal(auditLogs.length, 0);

        const okRes = await srv.request('/api/pos/verify-manager-pin', {
            method: 'POST',
            body: {
                managerPin: '2468',
                action: 'OFFLINE_QUEUE_ITEM_DELETED',
                lyDo: 'Xóa đơn offline bị trùng',
                details: { offlineClientId: 'OFF-DEV1-001', totalAmount: 45000 },
            },
        });
        assert.equal(okRes.status, 200);
        assert.equal(auditLogs.length, 1);
        assert.equal(auditLogs[0].hanhDong, 'OFFLINE_QUEUE_ITEM_DELETED');
        assert.equal(auditLogs[0].nguoiDuyet, 'NV_QL');
        assert.equal(auditLogs[0].batBuoc, true);
    });

    it('1c. print-relay/dispatch: bắt buộc ghi Audit Log khi mở két tiền (userId, branchId, reason, timestamp), chặn role 2/3 & che SĐT trên payload in', async () => {
        const auditLogs = [];
        const mockPool = {
            withTenant: async (_t, fn) =>
                fn({
                    query: async () => ({ rows: [{ mahoadon: '900', solanin: 1 }] }),
                }),
        };
        let currentRole = 4;

        const srv = createExpressHarness((app) => {
            registerSystemDomain(app, {
                pool: mockPool,
                io: null,
                runtimeFlags: {},
                chayGiaoDich: async (fn) => fn({}),
                qTenant: async () => ({ rows: [] }),
                kiemTraToken: (req, _res, next) => {
                    req.user = { maNV: 'NV_CASHIER_01', vaiTro: currentRole, tenantId: 'T_RELAY', branchId: 'CN02' };
                    next();
                },
                yeuCauTinhNang: () => (_req, _res, next) => next(),
                xoaCacheEntitlement: () => {},
                ghiAuditLog: async (_c, entry) => auditLogs.push(entry),
                dispatchFraudAlertFromAudit: () => {},
                kiemTraCanhBaoTanSuatGianLan: () => {},
                xacThucPinQuanLy: async () => null,
            });
        });

        // (1) Barista (role 2) không được phép gửi lệnh mở két tiền
        currentRole = 2;
        const baristaRes = await srv.request('/api/print-relay/dispatch', {
            method: 'POST',
            body: { kind: 'DRAWER_KICK', payload: { reason: 'Mở két tự ý' } },
        });
        assert.equal(baristaRes.status, 403);
        assert.equal(auditLogs.length, 0);

        // (2) Thu ngân (role 4) gửi DRAWER_KICK -> 201 + BẮT BUỘC sinh bản ghi Audit Log đủ userId, branchId, reason, timestamp
        currentRole = 4;
        const kickRes = await srv.request('/api/print-relay/dispatch', {
            method: 'POST',
            headers: { 'X-Branch-Id': 'CN02' },
            body: {
                kind: 'DRAWER_KICK',
                payload: { reason: 'Đổi tiền lẻ trả khách' },
            },
        });
        assert.equal(kickRes.status, 201);
        const kickBody = await kickRes.json();
        assert.equal(kickBody.auditLogged, true);
        assert.equal(auditLogs.length, 1);
        assert.equal(auditLogs[0].hanhDong, 'DRAWER_NO_SALE_KICK');
        assert.equal(auditLogs[0].maNV, 'NV_CASHIER_01');
        assert.equal(auditLogs[0].giaTriMoi.userId, 'NV_CASHIER_01');
        assert.equal(auditLogs[0].giaTriMoi.branchId, 'CN02');
        assert.equal(auditLogs[0].giaTriMoi.reason, 'Đổi tiền lẻ trả khách');
        assert.ok(Date.parse(auditLogs[0].giaTriMoi.timestamp) > 0, 'Audit Log phải ghi nhận thời điểm hợp lệ');
        assert.equal(auditLogs[0].batBuoc, true);

        // (3) Gửi RECEIPT có SĐT thô -> payload lưu trong hàng đợi Relay phải bị che giữ 3 số cuối *******789
        const receiptRes = await srv.request('/api/print-relay/dispatch', {
            method: 'POST',
            body: {
                kind: 'RECEIPT',
                printToken: 'PRT-900-1-1700000000000',
                payload: {
                    hoaDon: {
                        maHoaDon: 900,
                        khachHang: { maKH: 'KH1', tenKH: 'Nguyễn A', soDienThoai: '0912345789' },
                    },
                },
            },
        });
        assert.equal(receiptRes.status, 201);
        const pullRes = await srv.request('/api/print-relay/pull');
        const pullBody = await pullRes.json();
        const receiptJob = pullBody.jobs.find((j) => j.kind === 'RECEIPT');
        assert.ok(receiptJob, 'Phải kéo được lệnh in RECEIPT từ Relay');
        assert.equal(receiptJob.payload.hoaDon.khachHang.soDienThoai, '*******789');
    });

    it('2. HR chấm công: không tin header X-Forwarded-For giả mạo từ client khi dùng req.ip + trust proxy chuẩn', async () => {
        const hrCode = fs.readFileSync(path.join(ROOT_DIR, 'src/domains/hr/index.js'), 'utf8');
        assert.doesNotMatch(
            hrCode,
            /req\.headers\['x-forwarded-for'\]/,
            'hr/index.js tuyệt đối không được đọc trực tiếp req.headers["x-forwarded-for"]'
        );

        const auditLogs = [];
        const mockClient = {
            query: async (sql) => {
                const s = String(sql).replace(/\s+/g, ' ').trim();
                if (s.includes('FROM public.chinhanh')) {
                    return {
                        rows: [
                            {
                                branchid: 'CN01',
                                machinhanh: 'CN01',
                                kiosk_hmac_secret: null,
                                geo_lat: 10.7769,
                                geo_lng: 106.7009,
                                geofence_radius_m: 50,
                                allowed_public_ips: ['203.113.150.10'],
                            },
                        ],
                    };
                }
                return { rows: [] };
            },
        };
        const mockPool = { withTenant: async (_t, fn) => fn(mockClient) };

        // (a) trust proxy = false (direct): X-Forwarded-For giả mạo bị bỏ qua hoàn toàn
        const srvDirect = createExpressHarness(
            (app) => {
                registerHrDomain(app, {
                    pool: mockPool,
                    io: null,
                    chayGiaoDich: async (fn) => fn(mockClient),
                    qTenant: async (_r, sql, params) => mockClient.query(sql, params),
                    kiemTraToken: (req, _res, next) => {
                        req.user = { maNV: 'NV_FAKE_IP', vaiTro: 4, tenantId: 'T_HR', maChiNhanh: 'CN01' };
                        next();
                    },
                    hashPassword: async (p) => p,
                    xoaCacheTrangThaiNV: () => {},
                    layEntitlementTenant: async () => ({}),
                    ghiAuditLog: async (_c, entry) => auditLogs.push(entry),
                });
            },
            { trustProxy: false }
        );

        const spoofRes = await srvDirect.request('/api/nhansu/chamcong', {
            method: 'POST',
            headers: { 'X-Forwarded-For': '203.113.150.10' },
            remoteAddress: '198.51.100.77',
            body: {
                maPhanCa: 77,
                checkinLat: 21.0285, // Ở Hà Nội (cách quán TP.HCM > 1.000km)
                checkinLng: 105.8542,
            },
        });
        assert.equal(spoofRes.status, 403, 'Giả mạo X-Forwarded-For (direct) phải bị chặn 403 OUT_OF_GEOFENCE');
        const body = await spoofRes.json();
        assert.equal(body.code, 'OUT_OF_GEOFENCE');
        assert.ok(auditLogs.some((a) => a.hanhDong === 'HR_CHECKIN_REJECTED_LOCATION'));

        // (b) trust proxy = 1 (sau 1 reverse proxy chuẩn): client cố chèn IP quán vào đầu X-Forwarded-For
        // Proxy nối IP thật 198.51.100.77 vào cuối -> Express req.ip lấy đúng 198.51.100.77 và vẫn chặn 403!
        const srvProxy = createExpressHarness(
            (app) => {
                registerHrDomain(app, {
                    pool: mockPool,
                    io: null,
                    chayGiaoDich: async (fn) => fn(mockClient),
                    qTenant: async (_r, sql, params) => mockClient.query(sql, params),
                    kiemTraToken: (req, _res, next) => {
                        req.user = { maNV: 'NV_FAKE_IP', vaiTro: 4, tenantId: 'T_HR', maChiNhanh: 'CN01' };
                        next();
                    },
                    hashPassword: async (p) => p,
                    xoaCacheTrangThaiNV: () => {},
                    layEntitlementTenant: async () => ({}),
                    ghiAuditLog: async (_c, entry) => auditLogs.push(entry),
                });
            },
            { trustProxy: 1 }
        );
        const spoofBehindProxy = await srvProxy.request('/api/nhansu/chamcong', {
            method: 'POST',
            headers: { 'X-Forwarded-For': '203.113.150.10, 198.51.100.77' },
            remoteAddress: '10.0.0.1',
            body: { maPhanCa: 77, checkinLat: 21.0285, checkinLng: 105.8542 },
        });
        assert.equal(spoofBehindProxy.status, 403, 'Giả mạo X-Forwarded-For sau 1 hop proxy vẫn phải bị chặn 403');
    });

    it('3. NĐ 13/2023 (layHoaDonChiTiet): che SĐT giữ 3 số cuối (*******789) cho Thu ngân/Phục vụ/Print Bridge; trả đầy đủ cho Quản lý hoặc HĐĐT/CSKH', async () => {
        const helpers = createOrderHelpers({
            pool: {},
            io: null,
            runtimeFlags: { paymentsSanSang: false },
            chayGiaoDich: async (fn) => fn({}),
            ghiAuditLog: async () => {},
            dispatchFraudAlertFromAudit: () => {},
            kiemTraCanhBaoTanSuatGianLan: () => {},
        });

        const mockDb = {
            query: async (sql) => {
                const s = String(sql).replace(/\s+/g, ' ').trim();
                if (s.includes('FROM HoaDon hd')) {
                    return {
                        rows: [
                            {
                                mahoadon: 888,
                                makh: 'KH_01',
                                tenkh: 'Trần Minh Khách',
                                sodienthoai: '0912345789',
                                diemtichluy: 120,
                                trangthaitt: 0,
                                phuongthuctt: 'TIEN_MAT',
                                tongtienthanhtoan: null,
                                thoigiantao: new Date().toISOString(),
                                thoigianthanhtoan: null,
                                solanin: 0,
                                daintamtinh: false,
                                sothutungay: 12,
                                version: 1,
                                loaidonhang: 'TAI_QUAN',
                                cachtinhthue: 'INCLUDED',
                                thuevatphantram: 8,
                                tienthuevat: 0,
                                phiphucvuphantram: 0,
                                tienphiphucvu: 0,
                                phidonggoi: 0,
                                tienlamtron: 0,
                                branchid: 'CN01',
                                tenantid: 'T_PII',
                            },
                        ],
                    };
                }
                if (s.includes('FROM HoaDon_Ban')) {
                    return { rows: [{ maban: 'B01', tenban: 'Bàn 1' }] };
                }
                if (s.includes('FROM ChiTietHoaDon c')) {
                    return { rows: [] };
                }
                return { rows: [] };
            },
        };

        const forCashier = await helpers.layHoaDonChiTiet(mockDb, 888, { vaiTro: 4 });
        const forWaiter = await helpers.layHoaDonChiTiet(mockDb, 888, { vaiTro: 3 });
        const forBarista = await helpers.layHoaDonChiTiet(mockDb, 888, { vaiTro: 2 });
        const defaultFailClosed = await helpers.layHoaDonChiTiet(mockDb, 888);
        const forPrintBridge = await helpers.layHoaDonChiTiet(mockDb, 888, { vaiTro: 1, forPrint: true });
        const forManager = await helpers.layHoaDonChiTiet(mockDb, 888, { vaiTro: 1 });
        const forEInvoice = await helpers.layHoaDonChiTiet(mockDb, 888, { vaiTro: 4, purpose: 'EINVOICE' });
        const forCskh = await helpers.layHoaDonChiTiet(mockDb, 888, { vaiTro: 4, purpose: 'CSKH_AUTHORIZED' });

        assert.equal(forCashier.khachHang.soDienThoai, '*******789', 'Thu ngân phải nhận SĐT đã che *******789');
        assert.equal(forWaiter.khachHang.soDienThoai, '*******789', 'Phục vụ phải nhận SĐT đã che *******789');
        assert.equal(forBarista.khachHang.soDienThoai, '*******789', 'Pha chế phải nhận SĐT đã che *******789');
        assert.equal(defaultFailClosed.khachHang.soDienThoai, '*******789', 'Không truyền vaiTro phải fail-closed che SĐT');
        assert.equal(forPrintBridge.khachHang.soDienThoai, '*******789', 'Payload Print Bridge luôn phải che SĐT kể cả khi Quản lý in');
        assert.equal(forManager.khachHang.soDienThoai, '0912345789', 'Quản lý (vaiTro = 1) được xem SĐT đầy đủ');
        assert.equal(forEInvoice.khachHang.soDienThoai, '0912345789', 'Mục đích xuất HĐĐT được phép đọc SĐT đầy đủ');
        assert.equal(forCskh.khachHang.soDienThoai, '0912345789', 'Mục đích CSKH được cấp phép đọc SĐT đầy đủ');
        assert.equal(maskPhoneForInvoice('0905123892', { vaiTro: 4 }), '*******892');
    });

    it('4a. SaaS Feature Gating: gói FREE & STARTER bị trả 403 trên các nhóm API trả phí, đồng thời kiểm tra maxBranches & CHAIN tối thiểu 3 chi nhánh', async () => {
        const tenantPlans = {
            T_FREE: { goicuoc: 'FREE', trangthai: 'ACTIVE', featureflags: PLAN_FEATURES.FREE },
            T_STARTER: { goicuoc: 'STARTER', trangthai: 'ACTIVE', featureflags: PLAN_FEATURES.STARTER },
            T_PRO: { goicuoc: 'PRO', trangthai: 'ACTIVE', featureflags: PLAN_FEATURES.PRO },
            T_CHAIN: { goicuoc: 'CHAIN', trangthai: 'ACTIVE', featureflags: PLAN_FEATURES.CHAIN },
        };
        const branchCounts = { T_FREE: 1, T_STARTER: 1, T_PRO: 1, T_CHAIN: 1 };

        const mockPool = {
            query: async (sql, params) => {
                const s = String(sql);
                if (s.includes('FROM Tenants WHERE TenantId = $1')) {
                    const row = tenantPlans[params[0]];
                    return { rows: row ? [row] : [] };
                }
                if (s.includes('FROM ChiNhanh')) {
                    return { rows: [{ cnt: branchCounts[params[0]] ?? 0 }] };
                }
                return { rows: [] };
            },
            queryTenant: async (tenantId, sql, params) => mockPool.query(sql, params || [tenantId]),
        };

        xoaCacheEntitlement();
        const yeuCauTinhNang = taoMiddlewareTinhNang(mockPool);

        const mockTxClient = {
            query: async (sql) => {
                const s = String(sql);
                if (s.includes('INSERT INTO ChiNhanh')) {
                    return {
                        rows: [
                            {
                                branchid: 'T_CHAIN_CN02',
                                machinhanh: 'CN02',
                                tenchinhanh: 'Chi nhánh 02',
                                khuvucgia: 'DEFAULT',
                                lakhotong: false,
                                tylephinhuongquyen: 0,
                            },
                        ],
                    };
                }
                return { rows: [] };
            },
        };

        const srv = createExpressHarness((app) => {
            const kiemTraToken = (req, _res, next) => {
                req.user = {
                    maNV: 'NV_OWNER',
                    vaiTro: 1,
                    tenantId: req.headers['x-test-tenant'] || 'T_FREE',
                };
                next();
            };
            const shared = {
                pool: mockPool,
                reportPool: mockPool,
                chayGiaoDich: async (fn) => fn(mockTxClient),
                chayTruyVanBaoCao: async (_t, fn) => fn(mockTxClient),
                qTenant: async (req, sql, params) => mockPool.query(sql, params || [req.user.tenantId]),
                layTenantId: (req) => req.user.tenantId,
                layChiNhanhHienTai: () => 'CN01',
                kiemTraToken,
                choPhepVaiTro,
                yeuCauTinhNang,
                layEntitlementTenant,
                ghiAuditLog: async () => {},
                guiLoi,
                LoiNghiepVu,
                io: null,
                roomTen: (t, r) => `t:${t}:${r}`,
                taoDonHangTrongGiaoDich: async () => ({}),
                kiemTraPlatformAdmin: (_req, _res, next) => next(),
                gioiHanDangNhap: (_req, _res, next) => next(),
                hashPassword: async (p) => p,
                jwt: { sign: () => 'tok' },
                xoaCacheEntitlement,
            };

            registerEcosystemPhase8Routes(app, shared);
            registerEInvoiceRoutes(app, shared);
            registerPriceBookAndZnsRoutes(app, shared);
            registerChainFinanceOpsRoutes(app, shared);
            registerHrPayrollTipsRoutes(app, shared);
            registerSaasRoutes(app, shared);
        });

        // (1) Gói FREE gọi các nhóm API trả phí -> ĐỀU TRẢ 403 FEATURE_NOT_IN_PLAN
        const paidEndpoints = [
            { method: 'GET', path: '/api/qr-orders', expectedFeature: 'qr_order' },
            { method: 'GET', path: '/api/crm/customers', expectedFeature: 'crm_tiers' },
            { method: 'GET', path: '/api/branches/consolidated-report', expectedFeature: 'multi_branch' },
            { method: 'GET', path: '/api/aggregators/orders', expectedFeature: 'aggregator_hub' },
            { method: 'GET', path: '/api/ai/demand-forecast', expectedFeature: 'ai_forecast_upsell' },
            { method: 'GET', path: '/api/einvoices', expectedFeature: 'einvoice' },
            { method: 'GET', path: '/api/zns/outbox', expectedFeature: 'crm_tiers' },
            { method: 'GET', path: '/api/price-books', expectedFeature: 'aggregator_hub' },
            { method: 'GET', path: '/api/finance/house-accounts', expectedFeature: 'crm_tiers' },
            { method: 'GET', path: '/api/finance/supplier-ap', expectedFeature: 'inventory_bom' },
            { method: 'GET', path: '/api/analytics/hourly-sales-vs-labor', expectedFeature: 'ai_forecast_upsell' },
            { method: 'POST', path: '/api/saas/import-menu-sheet', expectedFeature: 'ai_menu_importer' },
        ];

        for (const ep of paidEndpoints) {
            const res = await srv.request(ep.path, {
                method: ep.method,
                headers: { 'x-test-tenant': 'T_FREE' },
                body: ep.method === 'POST' ? { csvText: 'ten,gia\nCafe,25000' } : undefined,
            });
            assert.equal(res.status, 403, `FREE gọi ${ep.method} ${ep.path} phải bị chặn 403, nhận được ${res.status}`);
            const body = await res.json();
            assert.equal(body.code, 'FEATURE_NOT_IN_PLAN');
            assert.equal(body.feature, ep.expectedFeature);
        }

        // (2) Gói STARTER gọi nhóm tính năng PRO/CHAIN -> vẫn trả 403
        for (const epPath of ['/api/qr-orders', '/api/einvoices', '/api/zns/outbox', '/api/ai/demand-forecast', '/api/branches/consolidated-report']) {
            const res = await srv.request(epPath, {
                headers: { 'x-test-tenant': 'T_STARTER' },
            });
            assert.equal(res.status, 403, `STARTER gọi ${epPath} phải bị chặn 403`);
        }

        // (3) Gói PRO được phép vào các tính năng PRO (/api/einvoices) nhưng vẫn bị chặn 403 ở multi_branch
        const proEinvRes = await srv.request('/api/einvoices', {
            headers: { 'x-test-tenant': 'T_PRO' },
        });
        assert.equal(proEinvRes.status, 200, 'Gói PRO phải được phép gọi /api/einvoices');

        const proMultiRes = await srv.request('/api/branches/consolidated-report', {
            headers: { 'x-test-tenant': 'T_PRO' },
        });
        assert.equal(proMultiRes.status, 403, 'Gói PRO không có multi_branch phải bị chặn 403');

        // (4) Không thể tạo vượt maxBranches (FREE/STARTER/PRO có maxBranches = 1, hiện đã có 1 CN)
        for (const tenantId of ['T_FREE', 'T_STARTER', 'T_PRO']) {
            const brRes = await srv.request('/api/branches', {
                method: 'POST',
                headers: { 'x-test-tenant': tenantId },
                body: { maChiNhanh: 'CN02', tenChiNhanh: 'Chi nhánh 02' },
            });
            assert.equal(brRes.status, 403, `${tenantId} không được tạo vượt maxBranches=1`);
            const brBody = await brRes.json();
            assert.equal(brBody.code, 'MAX_BRANCHES_EXCEEDED');
            assert.equal(brBody.maxBranches, 1);
        }

        // (5) Gói CHAIN (maxBranches = -1, multi_branch = true) được tạo chi nhánh mới thành công
        const chainBrRes = await srv.request('/api/branches', {
            method: 'POST',
            headers: { 'x-test-tenant': 'T_CHAIN' },
            body: { maChiNhanh: 'CN02', tenChiNhanh: 'Chi nhánh 02' },
        });
        assert.equal(chainBrRes.status, 201, 'Gói CHAIN phải được tạo thêm chi nhánh mới');

        // (6) Ràng buộc gói CHAIN tối thiểu 3 chi nhánh trên BE (tinhTienGoi + POST /api/saas/billing/create-order)
        assert.deepEqual(tinhTienGoi('CHAIN', 1, 0, 2), {
            error: 'CHAIN_MIN_BRANCHES_REQUIRED',
            minBranches: 3,
        });
        const chainCalc3 = tinhTienGoi('CHAIN', 1);
        assert.equal(chainCalc3.branchCount, 3);
        assert.equal(chainCalc3.monthlyUnit, 1497000);
        assert.equal(chainCalc3.soTien, 1497000);

        const chainCalc5 = tinhTienGoi('CHAIN', 1, 0, 5);
        assert.equal(chainCalc5.branchCount, 5);
        assert.equal(chainCalc5.monthlyUnit, 2495000);

        const badChainOrderRes = await srv.request('/api/saas/billing/create-order', {
            method: 'POST',
            headers: { 'x-test-tenant': 'T_PRO' },
            body: { goiCuoc: 'CHAIN', soThang: 1, soChiNhanh: 2 },
        });
        assert.equal(badChainOrderRes.status, 400, 'Đăng ký gói CHAIN dưới 3 chi nhánh phải bị chặn 400');
        const badChainBody = await badChainOrderRes.json();
        assert.equal(badChainBody.code, 'CHAIN_MIN_BRANCHES_REQUIRED');
        assert.equal(badChainBody.minBranches, 3);

        const goodChainOrderRes = await srv.request('/api/saas/billing/create-order', {
            method: 'POST',
            headers: { 'x-test-tenant': 'T_PRO' },
            body: { goiCuoc: 'CHAIN', soThang: 1, soChiNhanh: 3 },
        });
        assert.equal(goodChainOrderRes.status, 201);
        const goodChainBody = await goodChainOrderRes.json();
        assert.equal(goodChainBody.order.soTien, 1497000);
        assert.equal(goodChainBody.order.branchCount, 3);
    });

    it('4b. Đồng bộ bảng giá toàn repo: không còn mốc giá/hạn mức cũ (149k, 149000, 399k, 399000, 400 đơn, 990k, +250k)', () => {
        const scanRoots = ['modules', 'src', 'frontend/src', 'local-print-bridge', 'server.js'];
        const oldPriceRegex = /149k|149\.000|149,000|149000|399k|399\.000|399,000|399000|400 đơn|400 don|990k|\+250k|250k\/CN/i;
        const violations = [];

        const walk = (targetPath) => {
            const full = path.join(ROOT_DIR, targetPath);
            if (!fs.existsSync(full)) return;
            const stat = fs.statSync(full);
            if (stat.isFile()) {
                if (!/\.(js|jsx|ts|tsx|json)$/.test(full)) return;
                const content = fs.readFileSync(full, 'utf8');
                const lines = content.split(/\r?\n/);
                lines.forEach((line, idx) => {
                    if (oldPriceRegex.test(line)) {
                        violations.push(`${targetPath}:${idx + 1}: ${line.trim()}`);
                    }
                });
                return;
            }
            for (const entry of fs.readdirSync(full)) {
                if (entry === 'node_modules' || entry === 'dist') continue;
                walk(path.join(targetPath, entry));
            }
        };

        for (const root of scanRoots) walk(root);
        assert.deepEqual(violations, [], `Phát hiện chuỗi giá/hạn mức cũ còn sót:\n${violations.join('\n')}`);
    });
});
