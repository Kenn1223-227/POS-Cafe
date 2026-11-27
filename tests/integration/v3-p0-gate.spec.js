'use strict';

/**
 * Batch 12 — V3 P0 Release Gate E2E Suite
 *
 * Chạy THẬT 100% trên Express App (server.js) + PostgreSQL role `app_runtime` (NOBYPASSRLS + FORCE RLS).
 * KHÔNG mock DB, KHÔNG skip âm thầm.
 */

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');

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
    throw new Error('[V3-GATE] Thiếu TEST_APP_RUNTIME_URL (role app_runtime NOBYPASSRLS).');
}
if (!MIGRATION_DB_URL) {
    throw new Error('[V3-GATE] Thiếu MIGRATION_DATABASE_URL.');
}

process.env.NODE_ENV = 'test';
process.env.SKIP_AUTO_DDL = 'true';
process.env.DATABASE_URL = RUNTIME_DB_URL;
delete process.env.REPORT_DATABASE_URL;
delete process.env.REDIS_URL;
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    process.env.JWT_SECRET = 'test_jwt_secret_minimum_64_chars_for_automated_v3_gate_suite_0001';
}
if (!process.env.SEPAY_API_KEY) {
    process.env.SEPAY_API_KEY = 'test_sepay_webhook_key_v3_gate_global';
}

const { createMigrationPool, assertAppRuntimeNoBypassRls, withTenantTx } = require('../helpers/dbHarness');
const { hashPassword } = require('../../password');
const { PLAN_FEATURES } = require('../../modules/industryTemplates');
const { isMultiTenantReady } = require('../../modules/saasRoutes');
const {
    computeBusinessDate,
    refreshDailyBranchFinancialSummary,
} = require('../../src/domains/reports/businessDaySummaryService');

const serverMod = require('../../server');
const { server, io, pool, runStartupBootstrap } = serverMod;

const RUN_TAG = `${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const TENANT_MAIN = `T_V3_MAIN_${RUN_TAG}`;
const TENANT_EXP = `T_V3_EXP_${RUN_TAG}`;
const TENANT_NOKEY = `T_V3_NK_${RUN_TAG}`;
const SLUG_MAIN = `v3-main-${RUN_TAG.toLowerCase()}`;
const SLUG_EXP = `v3-exp-${RUN_TAG.toLowerCase()}`;
const SLUG_NOKEY = `v3-nokey-${RUN_TAG.toLowerCase()}`;
const BRANCH_MAIN = `CN_V3_${RUN_TAG}`;
const BRANCH_EXP = `CN_V3E_${RUN_TAG}`;
const BRANCH_NK = `CN_V3N_${RUN_TAG}`;

const IDS = {
    mgrMain: `MGR_V3_${RUN_TAG}`,
    cashierMain: `CSH_V3_${RUN_TAG}`,
    mgrExp: `MGRE_V3_${RUN_TAG}`,
    managerPin: '246810',
    ban1: `B1_V3_${RUN_TAG}`,
    ban2: `B2_V3_${RUN_TAG}`,
    banExp: `BE_V3_${RUN_TAG}`,
    nlWac: `NL_WAC_${RUN_TAG}`,
    nlBom: `NL_BOM_${RUN_TAG}`,
    mon60: `MON60_${RUN_TAG}`,
    mon40: `MON40_${RUN_TAG}`,
    mon100Vat: `MON100V_${RUN_TAG}`,
    monBom: `MONBOM_${RUN_TAG}`,
    monExp: `MONEXP_${RUN_TAG}`,
    kmCode: `KM_V3_${RUN_TAG}`,
};

let baseUrl = '';
let ownerPool = null;
let mgrToken = '';
let cashierToken = '';
let expToken = '';

function signToken(payload) {
    return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '2h' });
}

async function apiReq(urlPath, { method = 'GET', token = null, headers = {}, body = undefined } = {}) {
    const reqHeaders = { ...headers };
    if (token) reqHeaders.Authorization = `Bearer ${token}`;
    if (body !== undefined && !reqHeaders['Content-Type']) {
        reqHeaders['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: reqHeaders,
        body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = { raw: text };
    }
    return { status: res.status, ok: res.ok, data: json };
}

async function seedAll(dbPool) {
    const pwHash = await hashPassword('TestPass@123');
    const pinHash = await hashPassword(IDS.managerPin);
    const futureDate = new Date(Date.now() + 60 * 86400 * 1000).toISOString();
    const pastDate = new Date(Date.now() - 5 * 86400 * 1000).toISOString();
    const proFlags = JSON.stringify(PLAN_FEATURES.PRO);
    const proFlagsMisa = JSON.stringify({ ...PLAN_FEATURES.PRO, einvoice_provider: 'MISA' });

    const client = await dbPool.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            `INSERT INTO public.Tenants
                (TenantId, MaTienTo, TenQuan, Slug, MoHinh, GoiCuoc, TrangThai, TrialEndsAt, SubscriptionEndsAt, FeatureFlags, ThongTinNganHang, einvoice_provider)
             VALUES
                ($1, $2, 'Quan V3 Gate Main', $3, 'CAFE', 'PRO', 'ACTIVE', $4, $4, $5::jsonb, '{}'::jsonb, 'MISA'),
                ($6, $7, 'Quan V3 Gate Expired', $8, 'CAFE', 'TRIAL', 'TRIAL', $9, NULL, $10::jsonb, '{}'::jsonb, 'MOCK'),
                ($11, $12, 'Quan V3 Gate NoKey', $13, 'CAFE', 'PRO', 'ACTIVE', $4, $4, $10::jsonb, '{"bankId":"970422","accountNo":"1122334455","accountName":"NOKEY"}'::jsonb, 'MOCK')`,
            [
                TENANT_MAIN, `V3M${RUN_TAG.slice(-4)}`, SLUG_MAIN, futureDate, proFlagsMisa,
                TENANT_EXP, `V3E${RUN_TAG.slice(-4)}`, SLUG_EXP, pastDate, proFlags,
                TENANT_NOKEY, `V3N${RUN_TAG.slice(-4)}`, SLUG_NOKEY,
            ]
        );

        await client.query(
            `INSERT INTO public.ChiNhanh (BranchId, TenantId, MaChiNhanh, TenChiNhanh, KhuVucGia, TrangThai)
             VALUES
                ($1, $2, 'CN01', 'CN V3 Main', 'DEFAULT', 'ACTIVE'),
                ($3, $4, 'CN01', 'CN V3 Exp', 'DEFAULT', 'ACTIVE'),
                ($5, $6, 'CN01', 'CN V3 NK', 'DEFAULT', 'ACTIVE')`,
            [BRANCH_MAIN, TENANT_MAIN, BRANCH_EXP, TENANT_EXP, BRANCH_NK, TENANT_NOKEY]
        );

        await client.query(
            `INSERT INTO public.NhanVien
                (MaNV, TenNV, TenDangNhap, MatKhauHash, VaiTro, TrangThaiLamViec, MaPinHash, TenantId, BranchId, LuongCoBan, LoaiLuong)
             VALUES
                ($1, 'Manager V3', $2, $3, 1, 1, $4, $5, $6, 12000000, 'THANG'),
                ($7, 'Cashier V3', $8, $3, 4, 1, NULL, $5, $6, 7000000, 'THANG'),
                ($9, 'Manager Exp', $10, $3, 1, 1, $4, $11, $12, 12000000, 'THANG')`,
            [
                IDS.mgrMain, `mgr_v3_${RUN_TAG.toLowerCase()}`, pwHash, pinHash, TENANT_MAIN, BRANCH_MAIN,
                IDS.cashierMain, `csh_v3_${RUN_TAG.toLowerCase()}`,
                IDS.mgrExp, `mgre_v3_${RUN_TAG.toLowerCase()}`, TENANT_EXP, BRANCH_EXP,
            ]
        );

        await client.query(
            `INSERT INTO public.CaThuNgan (MaNV, TienMatDauCa, TienDauCa, TrangThaiCa, TenantId, BranchId, TerminalId)
             VALUES ($1, 1000000, 1000000, 1, $2, $3, 'POS-01')`,
            [IDS.cashierMain, TENANT_MAIN, BRANCH_MAIN]
        );

        await client.query(
            `INSERT INTO public.Ban (MaBan, TenBan, KhuVuc, SucChua, TrangThai, QrToken, DaXoa, TenantId, BranchId, QrYeuCauMoBan, QrBatBuocVietQr)
             VALUES
                ($1, 'Ban V3 1', 'T1', 4, 1, $2, FALSE, $3, $4, FALSE, FALSE),
                ($5, 'Ban V3 2', 'T1', 4, 1, $6, FALSE, $3, $4, FALSE, FALSE),
                ($7, 'Ban V3 Exp', 'T1', 4, 1, $8, FALSE, $9, $10, FALSE, FALSE)`,
            [
                IDS.ban1, `TOK1_${RUN_TAG}`, TENANT_MAIN, BRANCH_MAIN,
                IDS.ban2, `TOK2_${RUN_TAG}`,
                IDS.banExp, `TOKE_${RUN_TAG}`, TENANT_EXP, BRANCH_EXP,
            ]
        );

        await client.query(
            `INSERT INTO public.NguyenLieu
                (MaNL, TenNL, DonViTinh, SoLuongTon, TonKhoHienTai, HanMucCanhBao, NguongCanhBao, GiaVonDonVi, DaXoa, TenantId)
             VALUES
                ($1, 'NL Safe WAC', 'g', -100, -100, 10, 10, 50, FALSE, $2),
                ($3, 'NL Refund Restock', 'g', 1000, 1000, 10, 10, 100, FALSE, $2)`,
            [IDS.nlWac, TENANT_MAIN, IDS.nlBom]
        );

        await client.query(
            `INSERT INTO public.TonKhoChiNhanh (TenantId, BranchId, MaNL, SoLuongTon, HanMucCanhBao, GiaVonDonVi)
             VALUES
                ($1, $2, $3, -100, 10, 50),
                ($1, $2, $4, 1000, 10, 100)`,
            [TENANT_MAIN, BRANCH_MAIN, IDS.nlWac, IDS.nlBom]
        );

        await client.query(
            `INSERT INTO public.tax_categories (tenant_id, code, name, vat_rate, is_kct, is_default)
             VALUES
                ($1, 'VAT_8_FB', 'VAT 8% F&B', 8, FALSE, TRUE),
                ($1, 'VAT_0_FB', 'VAT 0%', 0, FALSE, FALSE)
             ON CONFLICT (tenant_id, code, effective_from) DO NOTHING`,
            [TENANT_MAIN]
        );

        await client.query(
            `INSERT INTO public.SanPham
                (MaMon, TenMon, NhomMon, DanhMuc, DangKinhDoanh, LaHangDongGoi, TramCheBien, InTemCoc, TamHet, TenantId, tax_category_code)
             VALUES
                ($1, 'Mon 60k', 'Cà phê', 'Cafe', TRUE, FALSE, 'BAR_CHINH', TRUE, FALSE, $2, 'VAT_0_FB'),
                ($3, 'Mon 40k', 'Cà phê', 'Cafe', TRUE, FALSE, 'BAR_CHINH', TRUE, FALSE, $2, 'VAT_0_FB'),
                ($4, 'Mon 100k VAT 8%', 'Cà phê', 'Cafe', TRUE, FALSE, 'BAR_CHINH', TRUE, FALSE, $2, 'VAT_8_FB'),
                ($5, 'Mon BOM Restock', 'Cà phê', 'Cafe', TRUE, FALSE, 'BAR_CHINH', TRUE, FALSE, $2, 'VAT_0_FB'),
                ($6, 'Mon Exp', 'Cà phê', 'Cafe', TRUE, FALSE, 'BAR_CHINH', TRUE, FALSE, $7, 'VAT_0_FB')`,
            [IDS.mon60, TENANT_MAIN, IDS.mon40, IDS.mon100Vat, IDS.monBom, IDS.monExp, TENANT_EXP]
        );

        await client.query(
            `INSERT INTO public.SanPham_Size (MaMon, KichThuoc, GiaBan)
             VALUES
                ($1, 'M', 60000),
                ($2, 'M', 40000),
                ($3, 'M', 100000),
                ($4, 'M', 50000),
                ($5, 'M', 50000)`,
            [IDS.mon60, IDS.mon40, IDS.mon100Vat, IDS.monBom, IDS.monExp]
        );

        await client.query(
            `INSERT INTO public.CongThuc (MaMon, KichThuoc, MaNL, KhoiLuongTieuHao)
             VALUES ($1, 'M', $2, 25)`,
            [IDS.monBom, IDS.nlBom]
        );

        await client.query(
            `INSERT INTO public.KhuyenMai (TenantId, MaCode, TenChuongTrinh, LoaiKM, KieuGiam, GiaTriGiam, GiamToiDa, DonToiThieu, DangHoatDong)
             VALUES ($1, $2, 'Giam 10k Test', 'CODE', 'FIXED', 10000, 10000, 0, TRUE)`,
            [TENANT_MAIN, IDS.kmCode]
        );

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function cleanupAll(dbPool) {
    const client = await dbPool.connect();
    try {
        const tenantIds = [TENANT_MAIN, TENANT_EXP, TENANT_NOKEY];
        await client.query('DELETE FROM public.einvoices WHERE tenant_id = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.cogs_adjustment_journal WHERE tenant_id = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.daily_branch_financial_summary WHERE tenant_id = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.order_refunds WHERE COALESCE(tenantid, \'DEFAULT\') = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.Audit_Logs WHERE COALESCE(TenantId, \'DEFAULT\') = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.ChiTietGiaoDichKho WHERE COALESCE(TenantId, \'DEFAULT\') = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.PhieuGiaoDichKho WHERE COALESCE(TenantId, \'DEFAULT\') = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.ChiTietHoaDon_Topping WHERE COALESCE(TenantId, \'DEFAULT\') = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.ChiTietHoaDon WHERE COALESCE(TenantId, \'DEFAULT\') = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.HoaDon WHERE COALESCE(TenantId, \'DEFAULT\') = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.CaThuNgan WHERE COALESCE(TenantId, \'DEFAULT\') = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.CongThuc WHERE MaMon = ANY($1::text[])', [[IDS.monBom]]).catch(() => {});
        await client.query('DELETE FROM public.TonKhoChiNhanh WHERE TenantId = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.KhuyenMai WHERE COALESCE(TenantId, \'DEFAULT\') = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.SanPham_Size WHERE MaMon = ANY($1::text[])', [[IDS.mon60, IDS.mon40, IDS.mon100Vat, IDS.monBom, IDS.monExp]]).catch(() => {});
        await client.query('DELETE FROM public.SanPham WHERE COALESCE(TenantId, \'DEFAULT\') = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.tax_categories WHERE tenant_id = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.NguyenLieu WHERE COALESCE(TenantId, \'DEFAULT\') = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.Ban WHERE COALESCE(TenantId, \'DEFAULT\') = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.NhanVien WHERE COALESCE(TenantId, \'DEFAULT\') = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.ChiNhanh WHERE TenantId = ANY($1::text[])', [tenantIds]).catch(() => {});
        await client.query('DELETE FROM public.Tenants WHERE TenantId = ANY($1::text[])', [tenantIds]).catch(() => {});
    } finally {
        client.release();
    }
}

describe('Batch 12 — V3 P0 Release Gate E2E Suite (Real Express + PostgreSQL app_runtime)', () => {
    before(async () => {
        await assertAppRuntimeNoBypassRls(pool);
        ownerPool = createMigrationPool();
        await runStartupBootstrap({ skipBackgroundJobs: true });
        await seedAll(ownerPool);

        await new Promise((resolve) => {
            server.listen(0, '127.0.0.1', resolve);
        });
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;

        mgrToken = signToken({
            maNV: IDS.mgrMain,
            tenNV: 'Manager V3',
            vaiTro: 1,
            tenantId: TENANT_MAIN,
            branchId: BRANCH_MAIN,
        });
        cashierToken = signToken({
            maNV: IDS.cashierMain,
            tenNV: 'Cashier V3',
            vaiTro: 4,
            tenantId: TENANT_MAIN,
            branchId: BRANCH_MAIN,
        });
        expToken = signToken({
            maNV: IDS.mgrExp,
            tenNV: 'Manager Exp',
            vaiTro: 1,
            tenantId: TENANT_EXP,
            branchId: BRANCH_EXP,
        });
    });

    after(async () => {
        try {
            if (ownerPool) await cleanupAll(ownerPool);
        } finally {
            if (io) io.close();
            if (server && server.listening) {
                await new Promise((resolve) => server.close(resolve));
            }
            if (ownerPool) await ownerPool.end().catch(() => {});
            await pool.end().catch(() => {});
        }
    });

    it('1. Production SaaS Lock: multiTenantSanSang=true với SKIP_AUTO_DDL=true & tenant hết hạn bị chặn 402/403 ở POST /api/order & POST /api/ca/mo-ca', async () => {
        assert.equal(isMultiTenantReady(), true, 'multiTenantSanSang phải = true ngay cả khi SKIP_AUTO_DDL=true');

        const orderRes = await apiReq('/api/order', {
            method: 'POST',
            token: expToken,
            body: {
                maBan: IDS.banExp,
                danhSachMon: [{ maMon: IDS.monExp, kichThuoc: 'M', soLuong: 1 }],
            },
        });
        assert.ok(
            [402, 403].includes(orderRes.status),
            `Tenant hết hạn gọi POST /api/order phải bị chặn 402/403, nhận ${orderRes.status}: ${JSON.stringify(orderRes.data)}`
        );

        const shiftRes = await apiReq('/api/ca/mo-ca', {
            method: 'POST',
            token: expToken,
            body: { tienMatDauCa: 500000, branchId: BRANCH_EXP },
        });
        assert.ok(
            [402, 403].includes(shiftRes.status),
            `Tenant hết hạn gọi POST /api/ca/mo-ca phải bị chặn 402/403, nhận ${shiftRes.status}: ${JSON.stringify(shiftRes.data)}`
        );
    });

    it('2. Anti-Fraud laMonTang / chietKhauMon & Pre-bill: Role 4 thiếu PIN bị chặn 403; có PIN hợp lệ thành công + sinh Audit_Logs; chuyen-mon & ap-uu-dai sau Pre-bill bị chặn 403 khi thiếu PIN', async () => {
        // 2a. laMonTang=true không PIN -> 403
        const noPinGift = await apiReq('/api/order', {
            method: 'POST',
            token: cashierToken,
            body: {
                maBan: IDS.ban1,
                danhSachMon: [{ maMon: IDS.mon60, kichThuoc: 'M', soLuong: 1, laMonTang: true, lyDoTang: 'Khach VIP' }],
            },
        });
        assert.equal(noPinGift.status, 403, `Role 4 gửi laMonTang không PIN phải bị 403, nhận ${noPinGift.status}`);

        // 2b. chietKhauMon=50000 không PIN -> 403
        const noPinDisc = await apiReq('/api/order', {
            method: 'POST',
            token: cashierToken,
            body: {
                maBan: IDS.ban1,
                danhSachMon: [{ maMon: IDS.mon60, kichThuoc: 'M', soLuong: 1, chietKhauMon: 50000, lyDoTang: 'Giam gia' }],
            },
        });
        assert.equal(noPinDisc.status, 403, `Role 4 gửi chietKhauMon không PIN phải bị 403, nhận ${noPinDisc.status}`);

        // 2c. Có PIN Quản lý hợp lệ -> thành công + sinh Audit_Logs
        const withPinGift = await apiReq('/api/order', {
            method: 'POST',
            token: cashierToken,
            body: {
                maBan: IDS.ban1,
                managerPin: IDS.managerPin,
                maNVDuyet: IDS.mgrMain,
                danhSachMon: [{ maMon: IDS.mon60, kichThuoc: 'M', soLuong: 1, laMonTang: true, lyDoTang: 'Sinh nhat khach' }],
            },
        });
        assert.ok(withPinGift.ok, `Role 4 gửi laMonTang kèm PIN hợp lệ phải thành công, nhận ${withPinGift.status}: ${JSON.stringify(withPinGift.data)}`);
        const maHoaDon1 = withPinGift.data?.maHoaDon;
        assert.ok(maHoaDon1);

        // Kiểm tra Audit_Logs
        const auditRes = await withTenantTx(pool, TENANT_MAIN, (client) =>
            client.query(
                `SELECT COUNT(*)::int AS cnt FROM public.Audit_Logs WHERE COALESCE(TenantId, 'DEFAULT') = $1`,
                [TENANT_MAIN]
            )
        );
        assert.ok(auditRes.rows[0].cnt >= 1, 'Phải sinh bản ghi Audit_Logs khi duyệt tặng/chiết khấu món');

        // Thêm 1 món thường vào bàn 1 để có món > 0đ rồi đánh dấu DaInTamTinh = TRUE
        const addNormal = await apiReq('/api/order', {
            method: 'POST',
            token: cashierToken,
            body: {
                maBan: IDS.ban1,
                expectedVersion: Number(withPinGift.data?.hoaDon?.version || 1),
                danhSachMon: [{ maMon: IDS.mon40, kichThuoc: 'M', soLuong: 1 }],
            },
        });
        assert.ok(addNormal.ok, `Thêm món thường vào bàn 1 thất bại: ${JSON.stringify(addNormal.data)}`);

        const cthdRes = await withTenantTx(pool, TENANT_MAIN, async (client) => {
            await client.query(`UPDATE public.HoaDon SET DaInTamTinh = TRUE WHERE MaHoaDon = $1`, [maHoaDon1]);
            return client.query(
                `SELECT MaCTHD FROM public.ChiTietHoaDon WHERE MaHoaDon = $1 AND MaMon = $2 LIMIT 1`,
                [maHoaDon1, IDS.mon40]
            );
        });
        const maCTHD = cthdRes.rows[0].macthd;

        // 2d. chuyen-mon trên hóa đơn DaInTamTinh=TRUE thiếu PIN -> 403
        const transferRes = await apiReq('/api/order/chuyen-mon', {
            method: 'POST',
            token: cashierToken,
            body: {
                fromMaHoaDon: maHoaDon1,
                toMaBan: IDS.ban2,
                items: [{ maCTHD, soLuongChuyen: 1 }],
            },
        });
        assert.equal(transferRes.status, 403, `chuyen-mon sau Pre-bill thiếu PIN phải bị 403, nhận ${transferRes.status}`);

        // 2e. ap-uu-dai trên hóa đơn DaInTamTinh=TRUE thiếu PIN -> 403
        const promoRes = await apiReq(`/api/order/${maHoaDon1}/ap-uu-dai`, {
            method: 'POST',
            token: cashierToken,
            body: { maKhuyenMai: IDS.kmCode },
        });
        assert.equal(promoRes.status, 403, `ap-uu-dai sau Pre-bill thiếu PIN phải bị 403, nhận ${promoRes.status}`);
    });

    it('3. P&L Single Refund Deduction: Tạo đơn 100k, thanh toán, hoàn 1 phần 40k -> dashboard & businessDaySummaryService đều cho doanh thu thuần = 60.000đ', async () => {
        // Tạo đơn mới mang đi (không đụng bàn 1) gồm 1 món 60k + 1 món 40k = 100k
        const createRes = await apiReq('/api/order', {
            method: 'POST',
            token: cashierToken,
            body: {
                loaiDonHang: 'MANG_DI',
                danhSachMon: [
                    { maMon: IDS.mon60, kichThuoc: 'M', soLuong: 1 },
                    { maMon: IDS.mon40, kichThuoc: 'M', soLuong: 1 },
                ],
            },
        });
        assert.ok(createRes.ok, `Tạo đơn 100k thất bại: ${JSON.stringify(createRes.data)}`);
        const maHoaDon = createRes.data.maHoaDon;

        const payRes = await apiReq('/api/order/thanhtoan', {
            method: 'POST',
            token: cashierToken,
            body: {
                maHoaDon,
                phuongThucTT: 'TIEN_MAT',
                tienKhachDua: 100000,
                expectedVersion: Number(createRes.data?.hoaDon?.version || 1),
            },
        });
        assert.ok(payRes.ok, `Thanh toán đơn 100k thất bại: ${JSON.stringify(payRes.data)}`);

        // Lấy MaCTHD của món 40k để hoàn tiền 1 phần 40.000đ
        const cthd40Res = await withTenantTx(pool, TENANT_MAIN, (client) =>
            client.query(
                `SELECT MaCTHD FROM public.ChiTietHoaDon WHERE MaHoaDon = $1 AND MaMon = $2 LIMIT 1`,
                [maHoaDon, IDS.mon40]
            )
        );
        const cthd40 = cthd40Res.rows[0].macthd;

        const refundRes = await apiReq(`/api/order/${maHoaDon}/hoan-tien`, {
            method: 'POST',
            token: cashierToken,
            body: {
                lyDo: 'Khach doi y tra 1 mon',
                phuongThucHoan: 'TIEN_MAT',
                hoanKho: false,
                managerPin: IDS.managerPin,
                maNVDuyet: IDS.mgrMain,
                dsMaCTHDHoan: [cthd40],
            },
        });
        assert.ok(refundRes.ok, `Hoàn tiền 1 phần 40k thất bại: ${JSON.stringify(refundRes.data)}`);

        const todayVn = computeBusinessDate(new Date(), 4, 420);
        const dashRes = await apiReq(`/api/baocao/dashboard?tuNgay=${todayVn}&denNgay=${todayVn}`, {
            method: 'GET',
            token: mgrToken,
        });
        assert.ok(dashRes.ok, `GET /api/baocao/dashboard thất bại: ${JSON.stringify(dashRes.data)}`);
        assert.equal(
            Number(dashRes.data?.tongQuan?.tongDoanhThu),
            60000,
            `Dashboard tongDoanhThu phải đúng 60.000đ (không bị trừ kép thành 20.000đ), nhận ${dashRes.data?.tongQuan?.tongDoanhThu}`
        );

        const summary = await withTenantTx(pool, TENANT_MAIN, (client) =>
            refreshDailyBranchFinancialSummary(client, {
                tenantId: TENANT_MAIN,
                branchId: BRANCH_MAIN,
                businessDate: todayVn,
            })
        );
        assert.equal(
            Number(summary.netSales),
            60000,
            `businessDaySummaryService netSales phải đúng 60.000đ, nhận ${summary.netSales}`
        );
    });

    it('4. Safe WAC & Refund Restock: Tồn -100@50đ, nhập +60@80đ rồi +100@90đ -> tổng cogs_adjustment_journal = 3.400đ; hoàn tiền trả kho cộng đúng vào TonKhoChiNhanh', async () => {
        const nhap1 = await apiReq('/api/kho/nhap', {
            method: 'POST',
            token: mgrToken,
            body: {
                branchId: BRANCH_MAIN,
                ghiChu: 'Nhap WAC dot 1',
                danhSachNguyenLieu: [{ maNL: IDS.nlWac, soLuong: 60, donGiaNhap: 80 }],
            },
        });
        assert.ok(nhap1.ok, `Nhập kho đợt 1 thất bại: ${JSON.stringify(nhap1.data)}`);

        const nhap2 = await apiReq('/api/kho/nhap', {
            method: 'POST',
            token: mgrToken,
            body: {
                branchId: BRANCH_MAIN,
                ghiChu: 'Nhap WAC dot 2',
                danhSachNguyenLieu: [{ maNL: IDS.nlWac, soLuong: 100, donGiaNhap: 90 }],
            },
        });
        assert.ok(nhap2.ok, `Nhập kho đợt 2 thất bại: ${JSON.stringify(nhap2.data)}`);

        const adjRes = await withTenantTx(pool, TENANT_MAIN, (client) =>
            client.query(
                `SELECT COALESCE(SUM(adjustment_amount), 0)::numeric AS total_adj
                   FROM public.cogs_adjustment_journal
                  WHERE tenant_id = $1 AND branch_id = $2 AND ma_nl = $3`,
                [TENANT_MAIN, BRANCH_MAIN, IDS.nlWac]
            )
        );
        assert.equal(
            Number(adjRes.rows[0].total_adj),
            3400,
            `Tổng cogs_adjustment_journal phải đúng 3.400đ, nhận ${adjRes.rows[0].total_adj}`
        );

        // Refund Restock: tạo đơn món BOM (25g nlBom), thanh toán, rồi hoàn tiền hoanKho=true
        const stockBeforeRes = await withTenantTx(pool, TENANT_MAIN, (client) =>
            client.query(
                `SELECT SoLuongTon FROM public.TonKhoChiNhanh WHERE TenantId = $1 AND BranchId = $2 AND MaNL = $3`,
                [TENANT_MAIN, BRANCH_MAIN, IDS.nlBom]
            )
        );
        const stockBefore = Number(stockBeforeRes.rows[0].soluongton);

        const bomOrder = await apiReq('/api/order', {
            method: 'POST',
            token: cashierToken,
            body: {
                loaiDonHang: 'MANG_DI',
                danhSachMon: [{ maMon: IDS.monBom, kichThuoc: 'M', soLuong: 1 }],
            },
        });
        assert.ok(bomOrder.ok);
        const maHdBom = bomOrder.data.maHoaDon;

        const payBom = await apiReq('/api/order/thanhtoan', {
            method: 'POST',
            token: cashierToken,
            body: {
                maHoaDon: maHdBom,
                phuongThucTT: 'TIEN_MAT',
                tienKhachDua: 50000,
                expectedVersion: Number(bomOrder.data?.hoaDon?.version || 1),
            },
        });
        assert.ok(payBom.ok);

        const stockAfterSaleRes = await withTenantTx(pool, TENANT_MAIN, (client) =>
            client.query(
                `SELECT SoLuongTon FROM public.TonKhoChiNhanh WHERE TenantId = $1 AND BranchId = $2 AND MaNL = $3`,
                [TENANT_MAIN, BRANCH_MAIN, IDS.nlBom]
            )
        );
        assert.equal(Number(stockAfterSaleRes.rows[0].soluongton), stockBefore - 25);

        const refundBom = await apiReq(`/api/order/${maHdBom}/hoan-tien`, {
            method: 'POST',
            token: cashierToken,
            body: {
                lyDo: 'Hoan kho kiem tra restock',
                phuongThucHoan: 'TIEN_MAT',
                hoanKho: true,
                managerPin: IDS.managerPin,
                maNVDuyet: IDS.mgrMain,
            },
        });
        assert.ok(refundBom.ok, `Hoàn tiền trả kho thất bại: ${JSON.stringify(refundBom.data)}`);

        const stockAfterRefundRes = await withTenantTx(pool, TENANT_MAIN, (client) =>
            client.query(
                `SELECT SoLuongTon FROM public.TonKhoChiNhanh WHERE TenantId = $1 AND BranchId = $2 AND MaNL = $3`,
                [TENANT_MAIN, BRANCH_MAIN, IDS.nlBom]
            )
        );
        assert.equal(
            Number(stockAfterRefundRes.rows[0].soluongton),
            stockBefore,
            'Hoàn tiền với hoanKho=true phải cộng trả đúng 25g vào TonKhoChiNhanh'
        );
    });

    it('5. VAT EXCLUDED & Migration 042: taxMode=EXCLUDED lưu tongPhaiTra=108000 & TienThueVAT=8000; fn_public_request_einvoice từ chối TrangThaiTT=0 và thành công TrangThaiTT=1 với provider != MOCK', async () => {
        // Đơn chưa thanh toán (TrangThaiTT = 0) với taxMode = EXCLUDED
        const unpaidRes = await apiReq('/api/order', {
            method: 'POST',
            token: cashierToken,
            body: {
                loaiDonHang: 'MANG_DI',
                cachTinhThue: 'EXCLUDED',
                danhSachMon: [{ maMon: IDS.mon100Vat, kichThuoc: 'M', soLuong: 1 }],
            },
        });
        assert.ok(unpaidRes.ok, `Tạo đơn VAT EXCLUDED thất bại: ${JSON.stringify(unpaidRes.data)}`);
        const maHdUnpaid = unpaidRes.data.maHoaDon;

        const detailUnpaid = await apiReq(`/api/hoadon/${maHdUnpaid}`, {
            method: 'GET',
            token: cashierToken,
        });
        assert.ok(detailUnpaid.ok, `GET /api/hoadon/${maHdUnpaid} thất bại: ${JSON.stringify(detailUnpaid.data)}`);
        assert.equal(Number(detailUnpaid.data?.hoaDon?.tongPhaiTra), 108000, 'tongPhaiTra phải = 108000 với VAT EXCLUDED 8%');
        assert.equal(Number(detailUnpaid.data?.hoaDon?.tienThueVAT), 8000, 'TienThueVAT phải = 8000 với VAT EXCLUDED 8%');

        const lookupUnpaid = `LK_U_${RUN_TAG}`;
        const lookupPaid = `LK_P_${RUN_TAG}`;

        const unpaidDb = await withTenantTx(pool, TENANT_MAIN, async (client) => {
            await client.query(`UPDATE public.HoaDon SET einvoice_lookup_code = $2 WHERE MaHoaDon = $1`, [
                maHdUnpaid,
                lookupUnpaid,
            ]);
            return client.query(
                `SELECT TienThueVAT, TrangThaiTT FROM public.HoaDon WHERE MaHoaDon = $1`,
                [maHdUnpaid]
            );
        });
        assert.equal(Number(unpaidDb.rows[0].tienthuevat), 8000, 'DB TienThueVAT phải = 8000 với VAT EXCLUDED 8%');
        assert.equal(Number(unpaidDb.rows[0].trangthaitt), 0);

        // fn_public_request_einvoice cho đơn TrangThaiTT = 0 phải bị từ chối
        await assert.rejects(
            () =>
                pool.query(`SELECT * FROM public.fn_public_request_einvoice($1, $2, $3, $4, $5)`, [
                    lookupUnpaid,
                    '0312345678',
                    'Cty Test Unpaid',
                    'HCM',
                    'unpaid@test.vn',
                ]),
            /chưa hoàn tất thanh toán|TrangThaiTT/i,
            'fn_public_request_einvoice phải từ chối hóa đơn chưa thanh toán (TrangThaiTT = 0)'
        );

        // Đơn thứ 2: tạo, thanh toán xong (TrangThaiTT = 1), rồi gọi fn_public_request_einvoice -> thành công và provider = MISA (không hardcode MOCK)
        const paidOrderRes = await apiReq('/api/order', {
            method: 'POST',
            token: cashierToken,
            body: {
                loaiDonHang: 'MANG_DI',
                cachTinhThue: 'EXCLUDED',
                danhSachMon: [{ maMon: IDS.mon100Vat, kichThuoc: 'M', soLuong: 1 }],
            },
        });
        assert.ok(paidOrderRes.ok);
        const maHdPaid = paidOrderRes.data.maHoaDon;

        const payPaidRes = await apiReq('/api/order/thanhtoan', {
            method: 'POST',
            token: cashierToken,
            body: {
                maHoaDon: maHdPaid,
                phuongThucTT: 'TIEN_MAT',
                tienKhachDua: 108000,
                expectedVersion: Number(paidOrderRes.data?.hoaDon?.version || 1),
            },
        });
        assert.ok(payPaidRes.ok);

        await withTenantTx(pool, TENANT_MAIN, (client) =>
            client.query(`UPDATE public.HoaDon SET einvoice_lookup_code = $2 WHERE MaHoaDon = $1`, [
                maHdPaid,
                lookupPaid,
            ])
        );

        const rpcRes = await pool.query(`SELECT * FROM public.fn_public_request_einvoice($1, $2, $3, $4, $5)`, [
            lookupPaid,
            '0312345679',
            'Cty Test Paid',
            'HCM',
            'paid@test.vn',
        ]);
        assert.equal(rpcRes.rows.length, 1);

        const einvRow = await withTenantTx(pool, TENANT_MAIN, (client) =>
            client.query(`SELECT provider, status FROM public.einvoices WHERE id = $1`, [rpcRes.rows[0].einvoice_id])
        );
        assert.equal(einvRow.rows[0].provider, 'MISA', 'fn_public_request_einvoice không được hardcode MOCK khi tenant cấu hình MISA');
    });

    it('6. Webhook Isolation: Bắn webhook /api/webhooks/sepay/:slug của quán chưa cấu hình khóa riêng (dù SEPAY_API_KEY global có giá trị) -> bị từ chối 401/403', async () => {
        assert.ok(process.env.SEPAY_API_KEY, 'SEPAY_API_KEY global phải có giá trị trong môi trường test');

        const res = await apiReq(`/api/webhooks/sepay/${SLUG_NOKEY}`, {
            method: 'POST',
            headers: { Authorization: `Apikey ${process.env.SEPAY_API_KEY}` },
            body: {
                id: `V3_SEPAY_ISOLATION_${Date.now()}`,
                transferType: 'in',
                transferAmount: 50000,
                content: 'TEST ISOLATION',
                accountNumber: '1122334455',
            },
        });
        assert.ok(
            [401, 403].includes(res.status),
            `Webhook vào tenant chưa có khóa riêng phải bị từ chối 401/403, nhận ${res.status}: ${JSON.stringify(res.data)}`
        );
    });
});
