'use strict';

/**
 * Batch 7 — Real Integration E2E Test Suite (P0 Regression Guard)
 *
 * Chạy THẬT 100% xuyên suốt toàn bộ kiến trúc:
 *   HTTP Client (fetch) -> Express App (server.js) -> PostgreSQL role `app_runtime` (NOBYPASSRLS + FORCE RLS)
 *   + Socket.IO Server -> Real `socket.io-client` (JWT handshake + 3-tier `room:subscribe`)
 *
 * KHÔNG mock DB, KHÔNG skip âm thầm.
 */

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');

// -----------------------------------------------------------------------------
// 1. NẠP .env.test & ÉP server.js DÙNG ĐÚNG ROLE app_runtime TRƯỚC KHI REQUIRE
// -----------------------------------------------------------------------------
const BACKEND_ROOT = path.resolve(__dirname, '../..');
const envTestPath = path.join(BACKEND_ROOT, '.env.test');
if (fs.existsSync(envTestPath)) {
    dotenv.config({ path: envTestPath, override: true, quiet: true });
} else {
    dotenv.config({ quiet: true });
}

const RUNTIME_DB_URL = String(process.env.TEST_APP_RUNTIME_URL || process.env.APP_RUNTIME_DATABASE_URL || '').trim();
const MIGRATION_DB_URL = String(process.env.MIGRATION_DATABASE_URL || '').trim();

if (!RUNTIME_DB_URL) {
    throw new Error(
        '[P0-E2E] Thiếu TEST_APP_RUNTIME_URL (role app_runtime NOBYPASSRLS). Không được phép skip âm thầm!'
    );
}
if (!MIGRATION_DB_URL) {
    throw new Error('[P0-E2E] Thiếu MIGRATION_DATABASE_URL để seed/cleanup dữ liệu test!');
}

process.env.NODE_ENV = 'test';
process.env.SKIP_AUTO_DDL = 'true';
process.env.DATABASE_URL = RUNTIME_DB_URL;
delete process.env.REPORT_DATABASE_URL;
// Chạy Socket.IO trực tiếp trên HTTP server test (không phụ thuộc Redis daemon bên ngoài)
delete process.env.REDIS_URL;
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    process.env.JWT_SECRET = 'test_jwt_secret_minimum_64_chars_for_automated_p0_e2e_suite_0001';
}
if (!process.env.SEPAY_API_KEY) {
    process.env.SEPAY_API_KEY = 'test_sepay_webhook_key_p0_e2e';
}

let ioClient;
try {
    ({ io: ioClient } = require('socket.io-client'));
} catch {
    ({ io: ioClient } = require(path.join(BACKEND_ROOT, 'frontend', 'node_modules', 'socket.io-client')));
}

const { createMigrationPool, assertAppRuntimeNoBypassRls } = require('../helpers/dbHarness');
const { hashPassword } = require('../../password');
const { PLAN_FEATURES } = require('../../modules/industryTemplates');
const serverMod = require('../../server');

const { server, io, pool, runStartupBootstrap } = serverMod;

// -----------------------------------------------------------------------------
// 2. HÀM TIỆN ÍCH HTTP / SOCKET / AUTH CHO E2E
// -----------------------------------------------------------------------------
const RUN_TAG = `${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const TENANT_A = `T_E2E_A_${RUN_TAG}`;
const TENANT_B = `T_E2E_B_${RUN_TAG}`;
const SLUG_A = `e2e-a-${RUN_TAG.toLowerCase()}`;
const SLUG_B = `e2e-b-${RUN_TAG.toLowerCase()}`;
const BRANCH_A = `CN_E2E_${RUN_TAG}`;
const BRANCH_B = `CN_E2EB_${RUN_TAG}`;
const BANK_ACC_A = '9876543210';

const IDS = {
    mgrA: `NV_MGR_A_${RUN_TAG}`,
    cashierA: `NV_CSH_A_${RUN_TAG}`,
    baristaA: `NV_BAR_A_${RUN_TAG}`,
    mgrB: `NV_MGR_B_${RUN_TAG}`,
    banSrc: `B_SRC_${RUN_TAG}`,
    banDst: `B_DST_${RUN_TAG}`,
    banQr: `B_QR_${RUN_TAG}`,
    qrToken: `QRTOK_${RUN_TAG}`,
    nlCf: `NL_CF_${RUN_TAG}`,
    nlTra: `NL_TRA_${RUN_TAG}`,
    nlExp: `NL_EXP_${RUN_TAG}`,
    spCf8: `SP_CF8_${RUN_TAG}`,
    spTra10: `SP_TRA10_${RUN_TAG}`,
    spVat8: `SP_V8_${RUN_TAG}`,
    spVat10: `SP_V10_${RUN_TAG}`,
    spB: `SP_B_${RUN_TAG}`,
    comboCode: `CMB_${RUN_TAG}`,
    khPii: `KH_PII_${RUN_TAG}`,
    managerPin: '8899',
};

let baseUrl = '';
let migPool = null;
let tokens = {};
let seeded = {};
const activeSockets = [];

function signStaffToken({ maNV, tenNV, vaiTro, tenantId, branchId }) {
    return jwt.sign(
        { maNV, tenNV, vaiTro, tenantId, branchId },
        process.env.JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '2h' }
    );
}

async function apiReq(urlPath, { method = 'GET', token = null, headers = {}, body = undefined } = {}) {
    const hdrs = { ...headers };
    if (token) hdrs.Authorization = `Bearer ${token}`;
    let payloadStr;
    if (body !== undefined) {
        hdrs['Content-Type'] = 'application/json';
        payloadStr = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: hdrs,
        body: payloadStr,
    });
    const text = await res.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = { rawText: text };
    }
    return { status: res.status, ok: res.ok, headers: res.headers, json, text };
}

function connectSocket(token) {
    return new Promise((resolve, reject) => {
        const sock = ioClient(baseUrl, {
            transports: ['websocket'],
            auth: { token },
            reconnection: false,
            forceNew: true,
        });
        activeSockets.push(sock);
        const timer = setTimeout(() => reject(new Error('Timeout kết nối Socket.IO client')), 5000);
        sock.once('connect', () => {
            clearTimeout(timer);
            resolve(sock);
        });
        sock.once('connect_error', (err) => {
            clearTimeout(timer);
            reject(new Error(`Socket connect_error: ${err?.message || err}`));
        });
    });
}

function subscribeRoom(sock, opts) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout room:subscribe ack')), 4000);
        sock.emit('room:subscribe', opts, (ack) => {
            clearTimeout(timer);
            resolve(ack);
        });
    });
}

function waitForSocketEvent(sock, eventName, predicate = null, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            sock.off(eventName, handler);
            reject(new Error(`Quá ${timeoutMs}ms không nhận được sự kiện Socket "${eventName}"`));
        }, timeoutMs);
        function handler(payload) {
            if (!predicate || predicate(payload)) {
                clearTimeout(timer);
                sock.off(eventName, handler);
                resolve(payload);
            }
        }
        sock.on(eventName, handler);
    });
}

async function seedTestData(ownerPool) {
    const pwHash = await hashPassword('TestPass@123');
    const pinHash = await hashPassword(IDS.managerPin);
    const futureDate = new Date(Date.now() + 60 * 86400 * 1000).toISOString();
    const proFlags = JSON.stringify(PLAN_FEATURES.PRO);
    const bankInfoA = JSON.stringify({
        bankId: '970422',
        accountNo: BANK_ACC_A,
        accountName: 'CAFE E2E A',
    });

    const client = await ownerPool.connect();
    try {
        await client.query('BEGIN');

        // 1. Tenants A & B (PRO plan để mở khóa vietqr_webhook, einvoice, qr_order, inventory_bom)
        await client.query(
            `INSERT INTO public.Tenants
                (TenantId, MaTienTo, TenQuan, Slug, MoHinh, GoiCuoc, TrangThai, TrialEndsAt, SubscriptionEndsAt, FeatureFlags, ThongTinNganHang)
             VALUES
                ($1, $2, 'Quán E2E Tenant A', $3, 'CAFE', 'PRO', 'ACTIVE', $4, $4, $5::jsonb, $6::jsonb),
                ($7, $8, 'Quán E2E Tenant B', $9, 'CAFE', 'PRO', 'ACTIVE', $4, $4, $5::jsonb, '{}'::jsonb)`,
            [
                TENANT_A,
                `EA${RUN_TAG.slice(-4)}`,
                SLUG_A,
                futureDate,
                proFlags,
                bankInfoA,
                TENANT_B,
                `EB${RUN_TAG.slice(-4)}`,
                SLUG_B,
            ]
        );

        // 2. ChiNhanh
        await client.query(
            `INSERT INTO public.ChiNhanh (BranchId, TenantId, MaChiNhanh, TenChiNhanh, KhuVucGia, TrangThai)
             VALUES
                ($1, $2, 'CN01', 'Chi nhánh E2E A', 'DEFAULT', 'ACTIVE'),
                ($3, $4, 'CN01', 'Chi nhánh E2E B', 'DEFAULT', 'ACTIVE')`,
            [BRANCH_A, TENANT_A, BRANCH_B, TENANT_B]
        );

        // 3. NhanVien (vaiTro: 1=Quản lý, 2=Barista, 4=Thu ngân)
        await client.query(
            `INSERT INTO public.NhanVien
                (MaNV, TenNV, TenDangNhap, MatKhauHash, VaiTro, TrangThaiLamViec, PinHash, TenantId, BranchId)
             VALUES
                ($1, 'Quản Lý A', $2, $3, 1, TRUE, $4, $5, $6),
                ($7, 'Thu Ngân A', $8, $3, 4, TRUE, NULL, $5, $6),
                ($9, 'Barista A', $10, $3, 2, TRUE, NULL, $5, $6),
                ($11, 'Quản Lý B', $12, $3, 1, TRUE, $4, $13, $14)`,
            [
                IDS.mgrA,
                `mgr_a_${RUN_TAG.toLowerCase()}`,
                pwHash,
                pinHash,
                TENANT_A,
                BRANCH_A,
                IDS.cashierA,
                `csh_a_${RUN_TAG.toLowerCase()}`,
                IDS.baristaA,
                `bar_a_${RUN_TAG.toLowerCase()}`,
                IDS.mgrB,
                `mgr_b_${RUN_TAG.toLowerCase()}`,
                TENANT_B,
                BRANCH_B,
            ]
        );

        // 4. CaThuNgan đang mở cho cả Tenant A và Tenant B
        await client.query(
            `INSERT INTO public.CaThuNgan (MaNV, TienMatDauCa, TienDauCa, TrangThaiCa, TenantId, BranchId, TerminalId)
             VALUES
                ($1, 1000000, 1000000, 1, $2, $3, 'POS-01'),
                ($4, 1000000, 1000000, 1, $5, $6, 'POS-01')`,
            [IDS.cashierA, TENANT_A, BRANCH_A, IDS.mgrB, TENANT_B, BRANCH_B]
        );

        // 5. Ban (bàn nguồn, bàn đích chuyển món, bàn QR)
        await client.query(
            `INSERT INTO public.Ban (MaBan, TenBan, KhuVuc, SucChua, TrangThai, QrToken, DaXoa, TenantId, BranchId, QrYeuCauMoBan, QrBatBuocVietQr)
             VALUES
                ($1, 'Bàn Nguồn E2E', 'Tầng 1', 4, 1, $2, FALSE, $3, $4, FALSE, FALSE),
                ($5, 'Bàn Đích E2E', 'Tầng 1', 4, 1, $6, FALSE, $3, $4, FALSE, FALSE),
                ($7, 'Bàn QR E2E', 'Tầng 1', 4, 2, $8, FALSE, $3, $4, FALSE, FALSE)`,
            [
                IDS.banSrc,
                `TOK_SRC_${RUN_TAG}`,
                TENANT_A,
                BRANCH_A,
                IDS.banDst,
                `TOK_DST_${RUN_TAG}`,
                IDS.banQr,
                IDS.qrToken,
            ]
        );

        // 6. NguyenLieu & TonKhoChiNhanh
        await client.query(
            `INSERT INTO public.NguyenLieu
                (MaNL, TenNL, DonViTinh, SoLuongTon, TonKhoHienTai, HanMucCanhBao, NguongCanhBao, GiaVonDonVi, DaXoa, TenantId, LaBanThanhPham, HanSuDungGio, TheoDoiHanDung)
             VALUES
                ($1, 'Hạt Cafe E2E', 'g', 1000, 1000, 50, 50, 250, FALSE, $2, FALSE, NULL, FALSE),
                ($3, 'Trà Đen E2E', 'g', 1000, 1000, 50, 50, 180, FALSE, $2, FALSE, NULL, FALSE),
                ($4, 'Trân Châu Đen (Bán TP)', 'g', 500, 500, 50, 50, 120, FALSE, $2, TRUE, 4, TRUE)`,
            [IDS.nlCf, TENANT_A, IDS.nlTra, IDS.nlExp]
        );

        await client.query(
            `INSERT INTO public.TonKhoChiNhanh (TenantId, BranchId, MaNL, SoLuongTon, HanMucCanhBao, GiaVonDonVi)
             VALUES
                ($1, $2, $3, 1000, 50, 250),
                ($1, $2, $4, 1000, 50, 180),
                ($1, $2, $5, 500, 50, 120)`,
            [TENANT_A, BRANCH_A, IDS.nlCf, IDS.nlTra, IDS.nlExp]
        );

        // 7. Lô bán thành phẩm đã hết hạn cho kịch bản #5 (discard-expired)
        const lotRes = await client.query(
            `INSERT INTO public.lo_tonkho
                (tenantid, branchid, manl, malo, nguonlo, soluongbandau, soluongconlai, giavonlo, ngaysanxuat, thoigianhethan, trangthai)
             VALUES
                ($1, $2, $3, $4, 'SUBRECIPE', 200, 200, 120, now() - interval '6 hours', now() - interval '2 hours', 'ACTIVE')
             RETURNING id`,
            [TENANT_A, BRANCH_A, IDS.nlExp, `LOT_EXP_${RUN_TAG}`]
        );
        const expiredLotId = Number(lotRes.rows[0].id);

        // 8. SanPham + SanPham_Size + CongThuc (gồm món VAT 8% và VAT 10%)
        await client.query(
            `INSERT INTO public.SanPham
                (MaMon, TenMon, NhomMon, DanhMuc, DangKinhDoanh, LaHangDongGoi, TramCheBien, InTemCoc, TamHet, TenantId, tax_category_code)
             VALUES
                ($1, 'Cà Phê Sữa E2E', 'Cà phê', 'Cà phê', TRUE, FALSE, 'BAR_CHINH', TRUE, FALSE, $2, 'VAT_8_FB'),
                ($3, 'Trà Đào E2E', 'Trà', 'Trà', TRUE, FALSE, 'BAR_LANH', TRUE, FALSE, $2, 'VAT_10_STD'),
                ($4, 'Latte 8% E2E', 'Cà phê', 'Cà phê', TRUE, FALSE, 'BAR_CHINH', TRUE, FALSE, $2, 'VAT_8_FB'),
                ($5, 'Bia Craft 10% E2E', 'Đồ uống có cồn', 'Bia', TRUE, FALSE, 'BAR_LANH', TRUE, FALSE, $2, 'VAT_10_STD'),
                ($6, 'Cà Phê Tenant B', 'Cà phê', 'Cà phê', TRUE, FALSE, 'BAR_CHINH', TRUE, FALSE, $7, 'VAT_8_FB')`,
            [IDS.spCf8, TENANT_A, IDS.spTra10, IDS.spVat8, IDS.spVat10, IDS.spB, TENANT_B]
        );

        await client.query(
            `INSERT INTO public.SanPham_Size (MaMon, KichThuoc, GiaBan)
             VALUES
                ($1, 'M', 50000),
                ($2, 'M', 40000),
                ($3, 'M', 100000),
                ($4, 'M', 100000),
                ($5, 'M', 50000)`,
            [IDS.spCf8, IDS.spTra10, IDS.spVat8, IDS.spVat10, IDS.spB]
        );

        await client.query(
            `INSERT INTO public.CongThuc (MaMon, KichThuoc, MaNL, KhoiLuongTieuHao)
             VALUES
                ($1, 'M', $2, 20),
                ($3, 'M', $4, 15)`,
            [IDS.spCf8, IDS.nlCf, IDS.spTra10, IDS.nlTra]
        );

        // 9. Modifiers gắn cho SP_CF_8 (kịch bản #4 QR Order + Modifiers)
        const mgRes = await client.query(
            `INSERT INTO public.modifier_groups
                (tenantid, tengroup, loai, batbuoc, chontoithieu, chontoida, soluongmienphi, thutuhienthi, danghoatdong)
             VALUES ($1, 'Tùy chọn Espresso E2E', 'MULTI', FALSE, 0, 2, 0, 1, TRUE)
             RETURNING id`,
            [TENANT_A]
        );
        const modGroupId = Number(mgRes.rows[0].id);

        const moRes = await client.query(
            `INSERT INTO public.modifier_options
                (tenantid, groupid, tenoption, teninngan, lamacdinh, giacongthem, toidasoluong, tamhet, thutuhienthi)
             VALUES
                ($1, $2, 'Thêm 1 Shot Espresso', '+1 SHOT', FALSE, 10000, 2, FALSE, 1),
                ($1, $2, 'Ít đường 50%', '50% DUONG', FALSE, 0, 1, FALSE, 2)
             RETURNING id, tenoption`,
            [TENANT_A, modGroupId]
        );
        const optShotId = Number(moRes.rows[0].id);
        const optSugarId = Number(moRes.rows[1].id);

        await client.query(
            `INSERT INTO public.sanpham_modifier_groups (tenantid, mamon, groupid, thutuhienthi)
             VALUES ($1, $2, $3, 1)`,
            [TENANT_A, IDS.spCf8, modGroupId]
        );

        // 10. KhachHang cho kiểm chứng che SĐT theo NĐ 13/2023 (kịch bản #7)
        await client.query(
            `INSERT INTO public.KhachHang (MaKH, HoTen, SoDienThoai, DiemTichLuy, SoDuVi, HangThanhVien, TenantId)
             VALUES ($1, 'Nguyễn Văn Khách E2E', '0912345789', 50, 0, 'MEMBER', $2)`,
            [IDS.khPii, TENANT_A]
        );

        await client.query('COMMIT');
        return { expiredLotId, modGroupId, optShotId, optSugarId };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function cleanupTestData(ownerPool) {
    if (!ownerPool) return;
    const client = await ownerPool.connect();
    try {
        await client.query('BEGIN');
        const tenants = [TENANT_A, TENANT_B];

        // Tạm bỏ trigger immutable của Audit_Logs chỉ trong phạm vi cleanup không cần thiết — giữ nguyên audit log hoặc bỏ qua bảng append-only
        const safeDeletes = [
            [`DELETE FROM public.einvoices WHERE tenant_id = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.tax_categories WHERE tenant_id = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.kds_event_log WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.vietqr_webhook_events WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.order_payments WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.donqrchoduyet WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.hoadon WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.combo_slot_items WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.combo_slots WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.combo WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.sanpham_modifier_groups WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.modifier_options WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.modifier_groups WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.lo_tonkho WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.phieugiaodichkho WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.tonkhochinhanh WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.congthuc WHERE mamon = ANY($1::text[])`, [[IDS.spCf8, IDS.spTra10, IDS.spVat8, IDS.spVat10, IDS.spB]]],
            [`DELETE FROM public.sanpham WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.nguyenlieu WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.ban WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.cathungan WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.khachhang WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.nhanvien WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.chinhanh WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.branch_daily_counter WHERE tenantid = ANY($1::text[])`, [tenants]],
            [`DELETE FROM public.tenants WHERE tenantid = ANY($1::text[])`, [tenants]],
        ];

        for (const [sql, params] of safeDeletes) {
            await client.query('SAVEPOINT sp_clean');
            try {
                await client.query(sql, params);
                await client.query('RELEASE SAVEPOINT sp_clean');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_clean').catch(() => {});
            }
        }
        await client.query('COMMIT');
    } catch {
        await client.query('ROLLBACK').catch(() => {});
    } finally {
        client.release();
    }
}

// -----------------------------------------------------------------------------
// 3. BỘ KIỂM THỬ TÍCH HỢP E2E 8 LUỒNG P0 (LIVE EXPRESS + app_runtime + SOCKET)
// -----------------------------------------------------------------------------
describe('Batch 7 — P0 Integration E2E Suite (Express + PostgreSQL app_runtime FORCE RLS + Socket.IO)', () => {
    before(async () => {
        // Bắt buộc xác nhận pool của Express app chạy dưới role app_runtime (NOBYPASSRLS, NOSUPERUSER)
        const runtimeRole = await assertAppRuntimeNoBypassRls(pool);
        assert.equal(runtimeRole.role_name, 'app_runtime', 'Express server pool bắt buộc kết nối bằng role app_runtime');

        await runStartupBootstrap();

        migPool = createMigrationPool();
        seeded = await seedTestData(migPool);

        await new Promise((resolve) => {
            server.listen(0, '127.0.0.1', resolve);
        });
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;

        tokens = {
            mgrA: signStaffToken({
                maNV: IDS.mgrA,
                tenNV: 'Quản Lý A',
                vaiTro: 1,
                tenantId: TENANT_A,
                branchId: BRANCH_A,
            }),
            cashierA: signStaffToken({
                maNV: IDS.cashierA,
                tenNV: 'Thu Ngân A',
                vaiTro: 4,
                tenantId: TENANT_A,
                branchId: BRANCH_A,
            }),
            baristaA: signStaffToken({
                maNV: IDS.baristaA,
                tenNV: 'Barista A',
                vaiTro: 2,
                tenantId: TENANT_A,
                branchId: BRANCH_A,
            }),
            mgrB: signStaffToken({
                maNV: IDS.mgrB,
                tenNV: 'Quản Lý B',
                vaiTro: 1,
                tenantId: TENANT_B,
                branchId: BRANCH_B,
            }),
        };
    });

    after(async () => {
        for (const s of activeSockets) {
            try {
                s.disconnect();
            } catch {}
        }
        await cleanupTestData(migPool);
        await Promise.allSettled([
            new Promise((resolve) => io.close(() => resolve())),
            new Promise((resolve) => server.close(() => resolve())),
            migPool ? migPool.end() : Promise.resolve(),
            pool.end(),
        ]);
    });

    // =========================================================================
    // LUỒNG 1: Counter VietQR E2E (choThanhToanTruoc -> Webhook -> Socket 3 tầng -> BOM LoaiGD = 6)
    // =========================================================================
    it('1. Counter VietQR E2E: choThanhToanTruoc=true -> SePay Webhook -> room 3 tầng nhận VIETQR_DA_NHAN & KDS order:new -> kho trừ với LoaiGD = 6 (không phải 3)', async () => {
        const cashierSock = await connectSocket(tokens.cashierA);
        const baristaSock = await connectSocket(tokens.baristaA);

        const posSub = await subscribeRoom(cashierSock, { role: 'POS', branchId: BRANCH_A });
        assert.equal(posSub.ok, true, 'Thu ngân phải room:subscribe phòng 3 tầng POS thành công');
        assert.ok(
            posSub.rooms.includes(`t:${TENANT_A}:b:${BRANCH_A}:pos`),
            `Phòng 3 tầng POS phải chứa t:${TENANT_A}:b:${BRANCH_A}:pos`
        );

        const kdsSub = await subscribeRoom(baristaSock, {
            role: 'KDS',
            branchId: BRANCH_A,
            station: 'BAR_CHINH',
        });
        assert.equal(kdsSub.ok, true, 'Barista phải room:subscribe phòng 3 tầng KDS thành công');

        // 1a. Tạo đơn Counter VietQR trả trước (AWAITING_PAYMENT -> chưa trừ kho, chưa bắn KDS)
        const stockBeforeRes = await migPool.query(
            `SELECT soluongton FROM public.tonkhochinhanh WHERE tenantid = $1 AND branchid = $2 AND manl = $3`,
            [TENANT_A, BRANCH_A, IDS.nlCf]
        );
        const stockBefore = Number(stockBeforeRes.rows[0].soluongton);

        const createRes = await apiReq('/api/order', {
            method: 'POST',
            token: tokens.cashierA,
            body: {
                branchId: BRANCH_A,
                loaiDonHang: 'MANG_DI',
                choThanhToanTruoc: true,
                phuongThucDuKien: 'VIETQR_PREPAID',
                cachTinhThue: 'INCLUDED',
                thueVATPhanTram: 8,
                danhSachMon: [{ maMon: IDS.spCf8, kichThuoc: 'M', soLuong: 2 }],
            },
        });
        assert.equal(createRes.status, 201, `Tạo đơn VietQR trả trước thất bại: ${createRes.text}`);
        const maHoaDon = createRes.json.maHoaDon;
        assert.ok(maHoaDon, 'Phải trả về maHoaDon');

        const cthdBefore = await migPool.query(
            `SELECT firestatus FROM public.chitiethoadon WHERE mahoadon = $1`,
            [maHoaDon]
        );
        assert.equal(cthdBefore.rows[0].firestatus, 'AWAITING_PAYMENT', 'Đơn trả trước phải ở FireStatus=AWAITING_PAYMENT');

        const stockWhileWaitingRes = await migPool.query(
            `SELECT soluongton FROM public.tonkhochinhanh WHERE tenantid = $1 AND branchid = $2 AND manl = $3`,
            [TENANT_A, BRANCH_A, IDS.nlCf]
        );
        assert.equal(
            Number(stockWhileWaitingRes.rows[0].soluongton),
            stockBefore,
            'Chưa được trừ kho khi khách chưa quét thanh toán VietQR'
        );

        // 1b. Bật listener trên Socket 3 tầng TRƯỚC khi bắn SePay webhook
        const vietQrEventPromise = waitForSocketEvent(
            cashierSock,
            'VIETQR_DA_NHAN',
            (p) => String(p?.maHoaDon) === String(maHoaDon),
            5000
        );
        const kdsOrderNewPromise = waitForSocketEvent(
            baristaSock,
            'order:new',
            (p) => String(p?.maHoaDon) === String(maHoaDon),
            5000
        );
        vietQrEventPromise.catch(() => {});
        kdsOrderNewPromise.catch(() => {});

        // 1c. Bắn webhook thanh toán SePay thật
        const webhookRes = await apiReq(`/api/webhooks/sepay/${SLUG_A}`, {
            method: 'POST',
            headers: { Authorization: `Apikey ${process.env.SEPAY_API_KEY}` },
            body: {
                id: `E2E_SEPAY_${Date.now()}`,
                transferType: 'in',
                transferAmount: 100000,
                content: `POSHD${maHoaDon}`,
                accountNumber: BANK_ACC_A,
            },
        });
        assert.equal(webhookRes.status, 200, `Webhook SePay thất bại: ${webhookRes.text}`);
        assert.equal(webhookRes.json.daHoanTat, true, `Webhook SePay phải chốt thanh toán thành công: ${webhookRes.text}`);

        // 1d. Xác nhận client 3 tầng nhận VIETQR_DA_NHAN và KDS nhận order:new (kdsEmitPlan.flush())
        const [vietQrEvt, kdsEvt] = await Promise.all([vietQrEventPromise, kdsOrderNewPromise]);
        assert.equal(String(vietQrEvt.maHoaDon), String(maHoaDon));
        assert.equal(vietQrEvt.daHoanTat, true);
        assert.equal(Number(vietQrEvt.soTienNhan), 100000);
        assert.equal(String(kdsEvt.maHoaDon), String(maHoaDon));

        // 1e. Xác nhận kho trừ đúng 2 * 20g = 40g với LoaiGD = 6 (KHÔNG phải 3 = Kiểm kê)
        const stockAfterRes = await migPool.query(
            `SELECT soluongton FROM public.tonkhochinhanh WHERE tenantid = $1 AND branchid = $2 AND manl = $3`,
            [TENANT_A, BRANCH_A, IDS.nlCf]
        );
        assert.equal(
            Number(stockAfterRes.rows[0].soluongton),
            stockBefore - 40,
            'Tồn kho chi nhánh phải giảm đúng 40g (2 ly * 20g)'
        );

        const gdKhoRes = await migPool.query(
            `SELECT pg.magiaodich, pg.loaigd, pg.ghichu, ct.manl, ct.soluong
               FROM public.phieugiaodichkho pg
               JOIN public.chitietgiaodichkho ct ON ct.magiaodich = pg.magiaodich
              WHERE pg.tenantid = $1
                AND pg.ghichu LIKE $2
              ORDER BY pg.magiaodich DESC
              LIMIT 1`,
            [TENANT_A, `%${maHoaDon}%`]
        );
        assert.equal(gdKhoRes.rows.length, 1, 'Phải sinh đúng 1 phiếu trừ kho BOM sau khi VietQR PAID');
        assert.equal(
            Number(gdKhoRes.rows[0].loaigd),
            6,
            `Trừ kho bán hàng VietQR phải ghi LoaiGD = 6 (không được là 3), thực tế: ${gdKhoRes.rows[0].loaigd}`
        );
        assert.notEqual(Number(gdKhoRes.rows[0].loaigd), 3);
        assert.equal(Number(gdKhoRes.rows[0].soluong), 40);

        const cthdAfter = await migPool.query(
            `SELECT firestatus FROM public.chitiethoadon WHERE mahoadon = $1`,
            [maHoaDon]
        );
        assert.equal(cthdAfter.rows[0].firestatus, 'FIRED', 'Sau khi thanh toán VietQR, FireStatus phải chuyển sang FIRED');

        cashierSock.disconnect();
        baristaSock.disconnect();
    });

    // =========================================================================
    // LUỒNG 2: Hủy món đơn trả 1 phần (Partial Payment -> POST /api/order/huy-mon -> 200, không 409)
    // =========================================================================
    it('2. Hủy món đơn trả 1 phần: trả trước 30k trên đơn 90k -> hủy món 40k trả 200 (không dính 409) và cập nhật đúng tổng tiền/công nợ', async () => {
        const ordRes = await apiReq('/api/order', {
            method: 'POST',
            token: tokens.mgrA,
            body: {
                branchId: BRANCH_A,
                loaiDonHang: 'MANG_DI',
                cachTinhThue: 'INCLUDED',
                thueVATPhanTram: 8,
                danhSachMon: [
                    { maMon: IDS.spCf8, kichThuoc: 'M', soLuong: 1 }, // 50,000đ
                    { maMon: IDS.spTra10, kichThuoc: 'M', soLuong: 1 }, // 40,000đ
                ],
            },
        });
        assert.equal(ordRes.status, 201, `Tạo đơn thất bại: ${ordRes.text}`);
        const maHoaDon = ordRes.json.maHoaDon;
        const monList = ordRes.json.hoaDon.danhSachMon;
        const itemTra = monList.find((m) => m.maMon === IDS.spTra10);
        const itemCf = monList.find((m) => m.maMon === IDS.spCf8);
        assert.ok(itemTra && itemCf);
        assert.equal(Number(ordRes.json.hoaDon.tongPhaiTra), 90000);

        // Thanh toán 1 phần 30,000đ
        const partialPayRes = await apiReq('/api/order/thanhtoan', {
            method: 'POST',
            token: tokens.cashierA,
            body: {
                maHoaDon,
                branchId: BRANCH_A,
                choPhepThuMotPhan: true,
                expectedVersion: Number(ordRes.json.hoaDon.version || 1),
                payments: [{ phuongThucTT: 'TIEN_MAT', soTien: 30000, tienKhachDua: 30000 }],
            },
        });
        assert.equal(partialPayRes.status, 200, `Thanh toán 1 phần thất bại: ${partialPayRes.text}`);
        assert.equal(partialPayRes.json.daHoanTat, false);
        assert.equal(Number(partialPayRes.json.hoaDon.daThanhToan), 30000);
        assert.equal(Number(partialPayRes.json.hoaDon.conLaiCanThu), 60000);

        // Hủy món Trà Đào 40,000đ -> tổng còn 50,000đ >= 30,000đ đã trả -> BẮT BUỘC trả 200 (không dính 409!)
        const voidRes = await apiReq('/api/order/huy-mon', {
            method: 'POST',
            token: tokens.mgrA,
            body: {
                maCTHD: itemTra.maCTHD,
                expectedVersion: Number(partialPayRes.json.hoaDon.version),
                lyDo: 'Khách đổi ý bỏ món Trà Đào sau khi cọc',
                hoanKho: true,
            },
        });
        assert.equal(voidRes.status, 200, `Hủy món trên đơn trả 1 phần bị chặn sai: ${voidRes.status} ${voidRes.text}`);

        // Xác nhận tổng tiền & công nợ cập nhật đúng (50k tổng, 30k đã trả, 20k còn lại)
        const detailRes = await apiReq(`/api/hoadon/${maHoaDon}`, {
            method: 'GET',
            token: tokens.mgrA,
        });
        assert.equal(detailRes.status, 200);
        const hd = detailRes.json.hoaDon;
        assert.equal(Number(hd.tongPhaiTra), 50000, 'Tổng phải trả mới phải là 50,000đ');
        assert.equal(Number(hd.daThanhToan), 30000, 'Số tiền đã thanh toán phải giữ nguyên 30,000đ');
        assert.equal(Number(hd.conLaiCanThu), 20000, 'Công nợ còn lại phải cập nhật đúng 20,000đ');

        // Biên âm (guard thật): cố hủy nốt món 50k còn lại (tổng về 0 < 30k đã trả) PHẢI bị chặn 409!
        const overVoidRes = await apiReq('/api/order/huy-mon', {
            method: 'POST',
            token: tokens.mgrA,
            body: {
                maCTHD: itemCf.maCTHD,
                expectedVersion: Number(hd.version),
                lyDo: 'Thử hủy vượt số đã thanh toán',
                hoanKho: true,
            },
        });
        assert.equal(overVoidRes.status, 409, 'Hủy làm tổng tụt dưới số đã thanh toán phải trả 409');
        assert.equal(overVoidRes.json.code, 'VOID_EXCEEDS_UNPAID_BALANCE');
    });

    // =========================================================================
    // LUỒNG 3: Combo & Chuyển món (POST /api/combos không 42P10 -> bán combo -> POST /api/order/chuyen-mon không 428)
    // =========================================================================
    it('3. Combo & Chuyển món: tạo + upsert combo qua POST /api/combos (không 42P10) -> bán combo -> chuyển món không dính 428', async () => {
        // 3a. Tạo combo lần 1
        const comboPayload = {
            maCombo: IDS.comboCode,
            tenCombo: 'Combo Sáng E2E',
            giaBanCombo: 75000,
            dangKinhDoanh: true,
            slots: [
                {
                    tenSlot: 'Chọn Cà Phê',
                    soLuongChon: 1,
                    thuTuHienThi: 0,
                    items: [{ maMon: IDS.spCf8, kichThuocMacDinh: 'M', choPhepDoiKichThuoc: true, phuThu: 0 }],
                },
                {
                    tenSlot: 'Chọn Trà',
                    soLuongChon: 1,
                    thuTuHienThi: 1,
                    items: [{ maMon: IDS.spTra10, kichThuocMacDinh: 'M', choPhepDoiKichThuoc: true, phuThu: 0 }],
                },
            ],
        };
        const c1 = await apiReq('/api/combos', {
            method: 'POST',
            token: tokens.mgrA,
            body: comboPayload,
        });
        assert.ok([200, 201].includes(c1.status), `Tạo combo lần 1 thất bại (nghi dính 42P10): ${c1.status} ${c1.text}`);

        // 3b. Upsert lại cùng maCombo để kiểm chứng thật ON CONFLICT (tenantid, macombo) DO UPDATE
        const c2 = await apiReq('/api/combos', {
            method: 'POST',
            token: tokens.mgrA,
            body: { ...comboPayload, giaBanCombo: 70000 },
        });
        assert.ok([200, 201].includes(c2.status), `Upsert combo lần 2 thất bại (42P10): ${c2.status} ${c2.text}`);
        const savedCombo = c2.json.combo;
        assert.equal(Number(savedCombo.giaBanCombo), 70000);
        assert.equal(savedCombo.slots.length, 2);

        // 3c. Bán combo trên bàn nguồn B_SRC + 1 món lẻ để kiểm chứng chuyển món
        const sellRes = await apiReq('/api/order', {
            method: 'POST',
            token: tokens.cashierA,
            body: {
                branchId: BRANCH_A,
                maBan: IDS.banSrc,
                loaiDonHang: 'TAI_QUAN',
                cachTinhThue: 'INCLUDED',
                thueVATPhanTram: 8,
                combos: [
                    {
                        maCombo: IDS.comboCode,
                        soLuong: 1,
                        selections: [
                            { slotId: savedCombo.slots[0].id, maMon: IDS.spCf8, kichThuoc: 'M' },
                            { slotId: savedCombo.slots[1].id, maMon: IDS.spTra10, kichThuoc: 'M' },
                        ],
                    },
                ],
                danhSachMon: [{ maMon: IDS.spCf8, kichThuoc: 'M', soLuong: 1 }],
            },
        });
        assert.equal(sellRes.status, 201, `Bán combo thất bại: ${sellRes.text}`);
        const srcHd = sellRes.json.hoaDon;
        assert.equal(Number(srcHd.tongPhaiTra), 120000, 'Tổng tiền phải đúng 70,000 (Combo) + 50,000 (Món lẻ) = 120,000đ');

        const comboLines = srcHd.danhSachMon.filter((m) => m.maCombo === IDS.comboCode);
        const standaloneLine = srcHd.danhSachMon.find((m) => !m.maCombo);
        assert.equal(comboLines.length, 2, 'Combo phải bung đủ 2 dòng món con có maCombo và comboGroupUid');
        assert.ok(standaloneLine, 'Phải có 1 dòng món lẻ');

        // 3d. Chuyển món sang bàn đích trống (B_DST) KHÔNG truyền destExpectedVersion -> không được nổ 428!
        const xfer1 = await apiReq('/api/order/chuyen-mon', {
            method: 'POST',
            token: tokens.cashierA,
            body: {
                fromMaHoaDon: srcHd.maHoaDon,
                toMaBan: IDS.banDst,
                expectedVersion: Number(srcHd.version || 1),
                items: [{ maCTHD: standaloneLine.maCTHD, soLuongChuyen: 1 }],
            },
        });
        assert.equal(xfer1.status, 200, `Chuyển món sang bàn trống bị lỗi (nghi dính 428): ${xfer1.status} ${xfer1.text}`);
        const destMaHoaDon = xfer1.json.toMaHoaDon || xfer1.json.hoaDonDich?.maHoaDon;
        assert.ok(destMaHoaDon, 'Phải mở hóa đơn đích khi chuyển sang bàn trống');

        // 3e. Chuyển tiếp 1 món nữa sang hóa đơn đích đang mở (vẫn không truyền destExpectedVersion) -> vẫn 200, không 428!
        const srcRefresh = await apiReq(`/api/hoadon/${srcHd.maHoaDon}`, { method: 'GET', token: tokens.cashierA });
        const xfer2 = await apiReq('/api/order/chuyen-mon', {
            method: 'POST',
            token: tokens.cashierA,
            body: {
                fromMaHoaDon: srcHd.maHoaDon,
                toMaHoaDon: destMaHoaDon,
                expectedVersion: Number(srcRefresh.json.hoaDon.version),
                items: [{ maCTHD: comboLines[0].maCTHD, soLuongChuyen: 1 }],
            },
        });
        assert.equal(xfer2.status, 200, `Chuyển món sang hóa đơn đích đang mở bị lỗi 428: ${xfer2.status} ${xfer2.text}`);

        const dstRefresh = await apiReq(`/api/hoadon/${destMaHoaDon}`, { method: 'GET', token: tokens.cashierA });
        assert.equal(dstRefresh.status, 200);
        assert.equal(dstRefresh.json.hoaDon.danhSachMon.length, 2, 'Hóa đơn đích phải nhận đủ 2 món đã chuyển');
    });

    // =========================================================================
    // LUỒNG 4: QR Order + Modifiers (tạo & duyệt đơn QR -> POS giữ nguyên modifiers & phòng 3 tầng KDS nhận sự kiện)
    // =========================================================================
    it('4. QR Order + Modifiers: tạo & duyệt đơn QR có modifiers -> đơn POS giữ nguyên modifiersSnapshot/giaModifiers và KDS 3 tầng nhận order:new', async () => {
        const baristaSock = await connectSocket(tokens.baristaA);
        const kdsSub = await subscribeRoom(baristaSock, {
            role: 'KDS',
            branchId: BRANCH_A,
            station: 'BAR_CHINH',
        });
        assert.equal(kdsSub.ok, true);

        // 4a. Khách quét QR gửi đơn kèm modifier "+1 Shot Espresso (+10,000đ)" & "Ít đường 50% (+0đ)"
        const qrCreateRes = await apiReq(`/api/public/qr-order/${SLUG_A}/${IDS.qrToken}`, {
            method: 'POST',
            body: {
                tenKhach: 'Khách QR E2E',
                soDienThoai: '0909888777',
                ghiChu: 'Ít đá giùm em',
                danhSachMon: [
                    {
                        maMon: IDS.spCf8,
                        kichThuoc: 'M',
                        soLuong: 1,
                        modifiers: [
                            { optionId: seeded.optShotId, qty: 1 },
                            { optionId: seeded.optSugarId, qty: 1 },
                        ],
                    },
                ],
            },
        });
        assert.equal(qrCreateRes.status, 201, `Gửi đơn QR thất bại: ${qrCreateRes.text}`);
        const maDonQr = qrCreateRes.json.order.maDonQr;
        assert.ok(maDonQr);
        assert.equal(qrCreateRes.json.order.danhSachMon[0].modifiers.length, 2);
        assert.equal(Number(qrCreateRes.json.order.danhSachMon[0].giaModifiers), 10000);

        // 4b. Lắng nghe sự kiện KDS phòng 3 tầng trước khi Thu ngân duyệt đơn QR
        const kdsOrderPromise = waitForSocketEvent(
            baristaSock,
            'order:new',
            (p) => Boolean(p?.maHoaDon),
            5000
        );

        const approveRes = await apiReq(`/api/qr-orders/${maDonQr}/approve`, {
            method: 'POST',
            token: tokens.cashierA,
            body: { allowNegativeStock: true },
        });
        assert.equal(approveRes.status, 200, `Duyệt đơn QR thất bại: ${approveRes.text}`);
        const maHoaDon = approveRes.json.maHoaDon;
        assert.ok(maHoaDon, 'Duyệt đơn QR phải sinh maHoaDon POS');

        // 4c. Xác nhận phòng 3 tầng KDS nhận đúng sự kiện order:new cho hóa đơn vừa duyệt
        const kdsEvt = await kdsOrderPromise;
        assert.equal(String(kdsEvt.maHoaDon), String(maHoaDon), 'KDS 3 tầng phải nhận đúng maHoaDon từ đơn QR');

        // 4d. Xác nhận đơn POS trong DB bảo toàn nguyên vẹn modifiersSnapshot & giaModifiers
        const posDetail = await apiReq(`/api/hoadon/${maHoaDon}`, { method: 'GET', token: tokens.mgrA });
        assert.equal(posDetail.status, 200);
        const line = posDetail.json.hoaDon.danhSachMon[0];
        assert.equal(Number(line.giaModifiers), 10000, 'Đơn POS phải bảo toàn giaModifiers = 10,000đ');
        assert.ok(Array.isArray(line.modifiersSnapshot), 'modifiersSnapshot phải là mảng');
        assert.equal(line.modifiersSnapshot.length, 2, 'Đơn POS phải giữ đủ 2 modifiers từ đơn QR');
        const shotMod = line.modifiersSnapshot.find((m) => Number(m.optionId) === seeded.optShotId);
        assert.ok(shotMod, 'Phải giữ nguyên option Thêm 1 Shot Espresso trong modifiersSnapshot');
        assert.equal(Number(posDetail.json.hoaDon.tongPhaiTra), 60000, 'Tổng đơn phải gồm 50,000đ + 10,000đ modifier = 60,000đ');

        baristaSock.disconnect();
    });

    // =========================================================================
    // LUỒNG 5: discard-expired (POST /api/kds/batches/:lotId/discard-expired)
    // =========================================================================
    it('5. discard-expired: hủy lô hết hạn trên KDS trừ tồn kho đúng, không crash SQL/JS, ghi LoaiGD = 2 (Xuất hủy)', async () => {
        const res = await apiReq(`/api/kds/batches/${seeded.expiredLotId}/discard-expired`, {
            method: 'POST',
            token: tokens.baristaA,
            body: { lyDo: 'Hết hạn dùng 4 giờ - xuất hủy E2E' },
        });
        assert.equal(res.status, 200, `discard-expired bị lỗi: ${res.status} ${res.text}`);
        assert.equal(Number(res.json.soLuongHuy), 200);
        assert.ok(res.json.maGiaoDich, 'Phải trả về maGiaoDich kho');

        // Kiểm tra DB thật: lo_tonkho -> DISPOSED & soluongconlai = 0
        const lotRow = await migPool.query(
            `SELECT soluongconlai, trangthai FROM public.lo_tonkho WHERE id = $1`,
            [seeded.expiredLotId]
        );
        assert.equal(Number(lotRow.rows[0].soluongconlai), 0);
        assert.equal(lotRow.rows[0].trangthai, 'DISPOSED');

        // Kiểm tra tồn kho chi nhánh giảm từ 500 -> 300
        const tkRow = await migPool.query(
            `SELECT soluongton FROM public.tonkhochinhanh WHERE tenantid = $1 AND branchid = $2 AND manl = $3`,
            [TENANT_A, BRANCH_A, IDS.nlExp]
        );
        assert.equal(Number(tkRow.rows[0].soluongton), 300, 'Tồn kho chi nhánh phải giảm từ 500 xuống 300');

        // Kiểm tra PhieuGiaoDichKho: LoaiGD = 2 (Xuất hủy, KHÔNG phải 4) và MaLyDoHuy = 'EXPIRED_BATCH'
        const gdRow = await migPool.query(
            `SELECT loaigd, malydohuy, trangthaiduyet FROM public.phieugiaodichkho WHERE magiaodich = $1`,
            [res.json.maGiaoDich]
        );
        assert.equal(gdRow.rows.length, 1);
        assert.equal(Number(gdRow.rows[0].loaigd), 2, 'discard-expired bắt buộc ghi LoaiGD = 2 (Xuất hủy)');
        assert.equal(gdRow.rows[0].malydohuy, 'EXPIRED_BATCH');
        assert.equal(gdRow.rows[0].trangthaiduyet, 'POSTED');
    });

    // =========================================================================
    // LUỒNG 6: Einvoice & RLS Isolation (chạy dưới app_runtime, không 42501, cô lập Tenant A/B)
    // =========================================================================
    it('6. Einvoice & RLS Isolation: toàn bộ route einvoiceRoutes.js chạy thành công dưới app_runtime (không 42501) và cô lập tuyệt đối Tenant A <-> Tenant B', async () => {
        // 6a. Tenant A & Tenant B cùng tạo tax category -> không được lỗi 42501 RLS!
        const taxA = await apiReq('/api/tax/categories', {
            method: 'POST',
            token: tokens.mgrA,
            body: { code: 'VAT_8_E2E_A', name: 'Thuế 8% Riêng A', vatRate: 8, isDefault: false },
        });
        assert.equal(taxA.status, 201, `Tenant A POST /api/tax/categories lỗi (nghi 42501 RLS): ${taxA.status} ${taxA.text}`);

        const taxB = await apiReq('/api/tax/categories', {
            method: 'POST',
            token: tokens.mgrB,
            body: { code: 'VAT_10_E2E_B', name: 'Thuế 10% Riêng B', vatRate: 10, isDefault: false },
        });
        assert.equal(taxB.status, 201, `Tenant B POST /api/tax/categories lỗi: ${taxB.status} ${taxB.text}`);

        // Tenant A đọc GET /api/tax/categories -> thấy VAT_8_E2E_A, KHÔNG thấy VAT_10_E2E_B
        const listTaxA = await apiReq('/api/tax/categories', { method: 'GET', token: tokens.mgrA });
        assert.equal(listTaxA.status, 200, `GET /api/tax/categories lỗi: ${listTaxA.text}`);
        const codesA = (listTaxA.json.categories || []).map((c) => c.code);
        assert.ok(codesA.includes('VAT_8_E2E_A'), 'Tenant A phải đọc được danh mục thuế của chính mình');
        assert.equal(codesA.includes('VAT_10_E2E_B'), false, 'RLS VI PHẠM: Tenant A đọc được tax_category của Tenant B!');

        // 6b. Tạo & thanh toán hóa đơn thật cho cả Tenant A và Tenant B
        const ordA = await apiReq('/api/order', {
            method: 'POST',
            token: tokens.mgrA,
            body: {
                branchId: BRANCH_A,
                loaiDonHang: 'MANG_DI',
                danhSachMon: [{ maMon: IDS.spCf8, kichThuoc: 'M', soLuong: 1 }],
            },
        });
        assert.equal(ordA.status, 201);
        const payA = await apiReq('/api/order/thanhtoan', {
            method: 'POST',
            token: tokens.mgrA,
            body: {
                maHoaDon: ordA.json.maHoaDon,
                branchId: BRANCH_A,
                phuongThucTT: 'TIEN_MAT',
                tienKhachDua: 50000,
                expectedVersion: Number(ordA.json.hoaDon.version || 1),
            },
        });
        assert.equal(payA.status, 200);

        const ordB = await apiReq('/api/order', {
            method: 'POST',
            token: tokens.mgrB,
            body: {
                branchId: BRANCH_B,
                loaiDonHang: 'MANG_DI',
                danhSachMon: [{ maMon: IDS.spB, kichThuoc: 'M', soLuong: 1 }],
            },
        });
        assert.equal(ordB.status, 201);
        const payB = await apiReq('/api/order/thanhtoan', {
            method: 'POST',
            token: tokens.mgrB,
            body: {
                maHoaDon: ordB.json.maHoaDon,
                branchId: BRANCH_B,
                phuongThucTT: 'TIEN_MAT',
                tienKhachDua: 50000,
                expectedVersion: Number(ordB.json.hoaDon.version || 1),
            },
        });
        assert.equal(payB.status, 200);

        // 6c. Phát hành HĐĐT cho Tenant A (immediate: false -> kiểm chứng cả process-queue) & Tenant B (immediate: true)
        const issueA = await apiReq(`/api/einvoices/${ordA.json.maHoaDon}/issue`, {
            method: 'POST',
            token: tokens.mgrA,
            body: {
                buyerTaxCode: '0101234567',
                buyerCompanyName: 'Công Ty Khách A',
                buyerEmail: 'a@example.com',
                immediate: false,
            },
        });
        assert.equal(issueA.status, 200, `Tenant A issue HĐĐT lỗi (nghi 42501 RLS): ${issueA.status} ${issueA.text}`);

        const queueA = await apiReq('/api/einvoices/process-queue', {
            method: 'POST',
            token: tokens.mgrA,
            body: { limit: 10 },
        });
        assert.equal(queueA.status, 200, `Tenant A process-queue lỗi (nghi 42501 RLS): ${queueA.status} ${queueA.text}`);
        assert.ok(queueA.json.count >= 1, 'process-queue phải xử lý được ít nhất 1 HĐĐT đang chờ của Tenant A');

        const issueB = await apiReq(`/api/einvoices/${ordB.json.maHoaDon}/issue`, {
            method: 'POST',
            token: tokens.mgrB,
            body: {
                buyerTaxCode: '0309999999',
                buyerCompanyName: 'Công Ty Bí Mật B',
                buyerEmail: 'b@example.com',
                immediate: true,
            },
        });
        assert.equal(issueB.status, 200, `Tenant B issue HĐĐT lỗi: ${issueB.status} ${issueB.text}`);

        // 6d. Kiểm chứng cô lập chéo tenant trên GET /api/einvoices & POST /api/einvoices/:hdB/issue
        const listEinvA = await apiReq('/api/einvoices', { method: 'GET', token: tokens.mgrA });
        assert.equal(listEinvA.status, 200, `GET /api/einvoices lỗi: ${listEinvA.text}`);
        const maHdsInA = (listEinvA.json.einvoices || []).map((e) => String(e.ma_hoa_don));
        assert.ok(maHdsInA.includes(String(ordA.json.maHoaDon)), 'Tenant A phải thấy HĐĐT của chính mình');
        assert.equal(
            maHdsInA.includes(String(ordB.json.maHoaDon)),
            false,
            'RLS VI PHẠM: Tenant A đọc được HĐĐT của Tenant B!'
        );

        const crossIssue = await apiReq(`/api/einvoices/${ordB.json.maHoaDon}/issue`, {
            method: 'POST',
            token: tokens.mgrA,
            body: { buyerCompanyName: 'Attack Cross Tenant' },
        });
        assert.ok(
            [400, 403, 404].includes(crossIssue.status),
            `Tenant A không được phép phát hành HĐĐT cho hóa đơn của Tenant B, nhận status=${crossIssue.status}`
        );
    });

    // =========================================================================
    // LUỒNG 7: Security & Anti-Fraud
    //   - Quản lý quán (role=1) gọi POST /api/saas/dunning/run -> 403
    //   - Thu ngân đọc layHoaDonChiTiet -> nhận SĐT đã che *******789
    //   - item-swap sau DaInTamTinh -> bị chặn 403 khi không có PIN Quản lý
    // =========================================================================
    it('7. Security & Anti-Fraud: role=1 gọi /api/saas/dunning/run bị chặn 403; Thu ngân đọc hóa đơn nhận SĐT đã che; item-swap sau DaInTamTinh bị chặn 403', async () => {
        // 7a. Quản lý quán (role=1) gọi POST /api/saas/dunning/run -> BẮT BUỘC 403
        const dunningRes = await apiReq('/api/saas/dunning/run', {
            method: 'POST',
            token: tokens.mgrA,
            body: {},
        });
        assert.equal(
            dunningRes.status,
            403,
            `Quản lý quán (role=1) gọi /api/saas/dunning/run phải bị chặn 403, thực tế: ${dunningRes.status} ${dunningRes.text}`
        );

        // 7b. Tạo đơn gắn khách hàng KH_PII (SĐT: 0912345789) -> Thu ngân đọc GET /api/hoadon/:id phải thấy SĐT đã che
        const ordRes = await apiReq('/api/order', {
            method: 'POST',
            token: tokens.cashierA,
            body: {
                branchId: BRANCH_A,
                loaiDonHang: 'MANG_DI',
                maKH: IDS.khPii,
                danhSachMon: [{ maMon: IDS.spCf8, kichThuoc: 'M', soLuong: 1 }],
            },
        });
        assert.equal(ordRes.status, 201);
        const maHoaDon = ordRes.json.maHoaDon;
        const maCTHD = ordRes.json.hoaDon.danhSachMon[0].maCTHD;

        const cashierRead = await apiReq(`/api/hoadon/${maHoaDon}`, {
            method: 'GET',
            token: tokens.cashierA,
        });
        assert.equal(cashierRead.status, 200);
        assert.equal(
            cashierRead.json.hoaDon.khachHang.soDienThoai,
            '*******789',
            'Thu ngân đọc hóa đơn phải nhận SĐT đã che theo NĐ 13/2023 (*******789)'
        );

        const managerRead = await apiReq(`/api/hoadon/${maHoaDon}`, {
            method: 'GET',
            token: tokens.mgrA,
        });
        assert.equal(managerRead.status, 200);
        assert.equal(managerRead.json.hoaDon.khachHang.soDienThoai, '0912345789', 'Quản lý được đọc SĐT đầy đủ');

        // 7c. In tạm tính (set DaInTamTinh = TRUE) -> Thu ngân gọi item-swap không PIN phải bị chặn 403 PREBILL_SWAP_FORBIDDEN
        const printTokenRes = await apiReq(`/api/order/${maHoaDon}/print-token`, {
            method: 'POST',
            token: tokens.cashierA,
            body: {},
        });
        assert.equal(printTokenRes.status, 200, `In tạm tính thất bại: ${printTokenRes.text}`);
        assert.equal(printTokenRes.json.laTamTinh, true);

        const blockedSwap = await apiReq('/api/order/item-swap', {
            method: 'POST',
            token: tokens.cashierA,
            body: {
                maCTHD,
                newItem: { maMon: IDS.spTra10, kichThuoc: 'M', soLuong: 1 },
                lyDo: 'Thử đổi món lách tạm tính không PIN',
            },
        });
        assert.equal(
            blockedSwap.status,
            403,
            `item-swap sau DaInTamTinh không có PIN Quản lý phải bị chặn 403, thực tế: ${blockedSwap.status} ${blockedSwap.text}`
        );
        assert.equal(blockedSwap.json.code, 'PREBILL_SWAP_FORBIDDEN');

        // Có PIN Quản lý hợp lệ -> cho phép đổi món & ghi Audit Log ITEM_SWAP_AFTER_PREBILL
        const approvedSwap = await apiReq('/api/order/item-swap', {
            method: 'POST',
            token: tokens.cashierA,
            body: {
                maCTHD,
                newItem: { maMon: IDS.spTra10, kichThuoc: 'M', soLuong: 1 },
                managerPin: IDS.managerPin,
                lyDo: 'Khách đổi món sau tạm tính có Quản lý duyệt',
            },
        });
        assert.equal(approvedSwap.status, 200, `item-swap có PIN Quản lý phải thành công: ${approvedSwap.text}`);
    });

    // =========================================================================
    // LUỒNG 8: VAT đa mức lúc Checkout (8% + 10% và taxMode='NONE')
    // =========================================================================
    it('8. VAT đa mức lúc Checkout: đơn gồm món 8% + 10% và đơn taxMode=NONE lưu đúng HoaDon.TienThueVAT, không bị ghi đè', async () => {
        // 8a. Đơn hỗn hợp: 100,000đ (VAT 8% -> 8,000đ) + 100,000đ (VAT 10% -> 10,000đ) với cachTinhThue='EXCLUDED'
        // Nếu bị ghi đè về thuế phẳng 8% sẽ ra sai 16,000đ thay vì đúng 18,000đ!
        const ordMixed = await apiReq('/api/order', {
            method: 'POST',
            token: tokens.cashierA,
            body: {
                branchId: BRANCH_A,
                loaiDonHang: 'MANG_DI',
                cachTinhThue: 'EXCLUDED',
                thueVATPhanTram: 8,
                danhSachMon: [
                    { maMon: IDS.spVat8, kichThuoc: 'M', soLuong: 1 }, // 100,000đ @ 8%
                    { maMon: IDS.spVat10, kichThuoc: 'M', soLuong: 1 }, // 100,000đ @ 10%
                ],
            },
        });
        assert.equal(ordMixed.status, 201, `Tạo đơn VAT đa mức thất bại: ${ordMixed.text}`);
        const hdMixedId = ordMixed.json.maHoaDon;

        const payMixed = await apiReq('/api/order/thanhtoan', {
            method: 'POST',
            token: tokens.cashierA,
            body: {
                maHoaDon: hdMixedId,
                branchId: BRANCH_A,
                phuongThucTT: 'TIEN_MAT',
                tienKhachDua: 250000,
                expectedVersion: Number(ordMixed.json.hoaDon.version || 1),
            },
        });
        assert.equal(payMixed.status, 200, `Thanh toán đơn VAT đa mức thất bại: ${payMixed.text}`);

        const dbMixed = await migPool.query(
            `SELECT tienthuevat, cachtinhthue, tax_breakdown_json FROM public.hoadon WHERE mahoadon = $1`,
            [hdMixedId]
        );
        assert.equal(
            Number(dbMixed.rows[0].tienthuevat),
            18000,
            `HoaDon.TienThueVAT cho đơn 100k(8%) + 100k(10%) EXCLUDED phải là 18,000đ (không bị ghi đè về 16,000đ), thực tế: ${dbMixed.rows[0].tienthuevat}`
        );
        const breakdown = dbMixed.rows[0].tax_breakdown_json || [];
        const b8 = breakdown.find((b) => Number(b.vatRate) === 8);
        const b10 = breakdown.find((b) => Number(b.vatRate) === 10);
        assert.equal(Number(b8?.vatAmount), 8000, 'Bucket 8% phải tính đúng 8,000đ');
        assert.equal(Number(b10?.vatAmount), 10000, 'Bucket 10% phải tính đúng 10,000đ');

        // 8b. Đơn taxMode='NONE' (cấu hình không tính thuế) -> HoaDon.TienThueVAT bắt buộc lưu đúng 0đ
        const ordNone = await apiReq('/api/order', {
            method: 'POST',
            token: tokens.cashierA,
            body: {
                branchId: BRANCH_A,
                loaiDonHang: 'MANG_DI',
                cachTinhThue: 'NONE',
                thueVATPhanTram: 8,
                danhSachMon: [
                    { maMon: IDS.spVat8, kichThuoc: 'M', soLuong: 1 },
                    { maMon: IDS.spVat10, kichThuoc: 'M', soLuong: 1 },
                ],
            },
        });
        assert.equal(ordNone.status, 201, `Tạo đơn taxMode=NONE thất bại: ${ordNone.text}`);
        const hdNoneId = ordNone.json.maHoaDon;

        const payNone = await apiReq('/api/order/thanhtoan', {
            method: 'POST',
            token: tokens.cashierA,
            body: {
                maHoaDon: hdNoneId,
                branchId: BRANCH_A,
                phuongThucTT: 'TIEN_MAT',
                tienKhachDua: 200000,
                expectedVersion: Number(ordNone.json.hoaDon.version || 1),
            },
        });
        assert.equal(payNone.status, 200, `Thanh toán đơn taxMode=NONE thất bại: ${payNone.text}`);

        const dbNone = await migPool.query(
            `SELECT tienthuevat, cachtinhthue, tongtienthanhtoan FROM public.hoadon WHERE mahoadon = $1`,
            [hdNoneId]
        );
        assert.equal(dbNone.rows[0].cachtinhthue, 'NONE');
        assert.equal(
            Number(dbNone.rows[0].tienthuevat),
            0,
            `Đơn taxMode=NONE phải lưu HoaDon.TienThueVAT = 0đ, thực tế: ${dbNone.rows[0].tienthuevat}`
        );
        assert.equal(Number(dbNone.rows[0].tongtienthanhtoan), 200000);
    });
});
