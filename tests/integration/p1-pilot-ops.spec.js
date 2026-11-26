'use strict';

/**
 * Batch 8 — Real Integration Test Suite (P1 Pre-Pilot Polish)
 *
 * Chạy THẬT 100% qua Express App (server.js) + PostgreSQL role `app_runtime`
 * (NOBYPASSRLS + FORCE RLS), KHÔNG mock DB, KHÔNG skip âm thầm.
 *
 * Bao phủ:
 *  1. Migration 040 idempotency (chạy 2 lần liên tiếp) + mô phỏng backfill trên DB cũ chưa có GiaTopping/GiaGiam.
 *  2. Kiểm tra .github/workflows/ci.yml không còn giới hạn cứng 039.
 *  3. Blind Stocktake cho nhân viên ca (role 2 Pha chế & role 4 Thu ngân):
 *     - Tải danh sách & gửi phiếu thành công, TUYỆT ĐỐI không lộ tồn hệ thống hay giá vốn.
 *     - Truy cập route quản trị kho tài chính bị chặn 403.
 *  4. Channel Packaging BOM:
 *     - Cấu hình qua POST /api/kho/vattu-mangdi (dùng payload FE `soLuongMoiLy` & `loaiDonHang`).
 *     - Trừ đúng định lượng bao bì theo kênh bán (MANG_DI / GIAO_HANG / APP_SAN) với LoaiGD = 6.
 *     - Đơn tại chỗ (TAI_QUAN) KHÔNG bị trừ nhầm bao bì mang về.
 *     - Đơn AWAITING_PAYMENT chỉ trừ 1 lần khi thanh toán xong, không trừ đúp.
 */

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');

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
    throw new Error('[P1-OPS] Thiếu TEST_APP_RUNTIME_URL (role app_runtime NOBYPASSRLS). Không được phép skip!');
}
if (!MIGRATION_DB_URL) {
    throw new Error('[P1-OPS] Thiếu MIGRATION_DATABASE_URL để seed/cleanup và test migration 040!');
}

process.env.NODE_ENV = 'test';
process.env.SKIP_AUTO_DDL = 'true';
process.env.DATABASE_URL = RUNTIME_DB_URL;
delete process.env.REPORT_DATABASE_URL;
delete process.env.REDIS_URL;
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    process.env.JWT_SECRET = 'test_jwt_secret_minimum_64_chars_for_automated_p1_ops_suite_0001';
}

const { createMigrationPool, assertAppRuntimeNoBypassRls } = require('../helpers/dbHarness');
const { hashPassword } = require('../../password');
const { PLAN_FEATURES } = require('../../modules/industryTemplates');
const serverMod = require('../../server');
const { server, io, pool, runStartupBootstrap } = serverMod;

const RUN_TAG = `${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const TENANT_ID = `T_P1_${RUN_TAG}`;
const SLUG = `p1-ops-${RUN_TAG.toLowerCase()}`;
const BRANCH_ID = `CN_P1_${RUN_TAG}`;

const IDS = {
    mgr: `NV_MGR_${RUN_TAG}`,
    barista: `NV_BAR_${RUN_TAG}`,
    cashier: `NV_CSH_${RUN_TAG}`,
    ban: `B_P1_${RUN_TAG}`,
    spLatte: `SP_LATTE_${RUN_TAG}`,
    nlCoffee: `NL_CF_${RUN_TAG}`,
    nlMilk: `NL_MILK_${RUN_TAG}`,
    nlCupM: `NL_CUPM_${RUN_TAG}`,
    nlStraw: `NL_STRAW_${RUN_TAG}`,
    nlBagGh: `NL_BAGGH_${RUN_TAG}`,
    nlBagApp: `NL_BAGAPP_${RUN_TAG}`,
};

let baseUrl = '';
let migPool = null;
let tokens = {};

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
    const res = await fetch(`${baseUrl}${urlPath}`, { method, headers: hdrs, body: payloadStr });
    const text = await res.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = { rawText: text };
    }
    return { status: res.status, ok: res.ok, headers: res.headers, json, text };
}

function assertNoForbiddenBlindFields(obj, label) {
    const forbidden = new Set([
        'tonHeThong',
        'tonhethong',
        'tonKhoHeThong',
        'tonkhohethong',
        'expectedQty',
        'soLuongTon',
        'soluongton',
        'tonDangChuyen',
        'giaVon',
        'giavon',
        'giaVonDonVi',
        'giavondonvi',
        'wac',
        'systemBefore',
        'systemNow',
        'diff',
        'absDiffVal',
        'totalAbsVarianceValue',
    ]);
    const stack = [{ val: obj, path: '$' }];
    while (stack.length > 0) {
        const cur = stack.pop();
        if (!cur.val || typeof cur.val !== 'object') continue;
        if (Array.isArray(cur.val)) {
            cur.val.forEach((el, idx) => stack.push({ val: el, path: `${cur.path}[${idx}]` }));
        } else {
            for (const [k, v] of Object.entries(cur.val)) {
                assert.ok(
                    !forbidden.has(k),
                    `[${label}] Rò rỉ trường nhạy cảm "${k}" tại ${cur.path}.${k} trong payload Blind Stocktake!`
                );
                if (v && typeof v === 'object') {
                    stack.push({ val: v, path: `${cur.path}.${k}` });
                }
            }
        }
    }
}

async function getBranchQty(maNL) {
    const r = await migPool.query(
        `SELECT soluongton FROM public.tonkhochinhanh WHERE tenantid = $1 AND branchid = $2 AND manl = $3`,
        [TENANT_ID, BRANCH_ID, maNL]
    );
    return r.rows.length > 0 ? Number(r.rows[0].soluongton) : null;
}

describe('Batch 8 — P1 Pre-Pilot Polish (Migration 040, CI, Blind Stocktake & Channel Packaging BOM)', () => {
    before(async () => {
        migPool = createMigrationPool();
        await assertAppRuntimeNoBypassRls(pool);
        await runStartupBootstrap();

        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address();
                baseUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });

        const pwHash = await hashPassword('PilotPass123!');
        const futureDate = new Date(Date.now() + 60 * 86400 * 1000).toISOString();
        const proFlags = JSON.stringify({ ...(PLAN_FEATURES?.PRO || {}), inventory_bom: true });

        await migPool.query(
            `INSERT INTO public.Tenants
                (TenantId, MaTienTo, TenQuan, Slug, MoHinh, GoiCuoc, TrangThai, TrialEndsAt, SubscriptionEndsAt, FeatureFlags, ThongTinNganHang)
             VALUES ($1, $2, 'P1 Pilot Cafe', $3, 'CAFE', 'PRO', 'ACTIVE', $4, $4, $5::jsonb, '{}'::jsonb)
             ON CONFLICT (TenantId) DO NOTHING`,
            [TENANT_ID, `P1${RUN_TAG.slice(-4)}`, SLUG, futureDate, proFlags]
        );
        await migPool.query(
            `INSERT INTO public.ChiNhanh (BranchId, TenantId, MaChiNhanh, TenChiNhanh, KhuVucGia, TrangThai)
             VALUES ($1, $2, 'CN01', 'Chi nhánh Pilot', 'DEFAULT', 'ACTIVE')
             ON CONFLICT (BranchId) DO NOTHING`,
            [BRANCH_ID, TENANT_ID]
        );
        await migPool.query(
            `INSERT INTO public.NhanVien
                (MaNV, TenNV, TenDangNhap, MatKhauHash, VaiTro, TrangThaiLamViec, TenantId, BranchId)
             VALUES
               ($1, 'Quản lý Pilot', $2, $3, 1, TRUE, $4, $5),
               ($6, 'Pha chế Pilot', $7, $3, 2, TRUE, $4, $5),
               ($8, 'Thu ngân Pilot', $9, $3, 4, TRUE, $4, $5)`,
            [
                IDS.mgr, `mgr_${RUN_TAG.toLowerCase()}`, pwHash, TENANT_ID, BRANCH_ID,
                IDS.barista, `bar_${RUN_TAG.toLowerCase()}`,
                IDS.cashier, `csh_${RUN_TAG.toLowerCase()}`,
            ]
        );
        await migPool.query(
            `INSERT INTO public.Ban (MaBan, TenBan, KhuVuc, SucChua, TrangThai, QrToken, DaXoa, TenantId, BranchId)
             VALUES ($1, 'Bàn 01 Pilot', 'Tầng 1', 4, 1, $2, FALSE, $3, $4)`,
            [IDS.ban, `QR_P1_${RUN_TAG}`, TENANT_ID, BRANCH_ID]
        );

        // Seed Nguyên liệu + Tồn kho chi nhánh
        const ingredients = [
            { maNL: IDS.nlCoffee, tenNL: 'Hạt Cà phê Arabica', dvt: 'g', qty: 5000, wac: 500, keyItem: true },
            { maNL: IDS.nlMilk, tenNL: 'Sữa tươi thanh trùng', dvt: 'ml', qty: 3000, wac: 400, keyItem: true },
            { maNL: IDS.nlCupM, tenNL: 'Ly nhựa Size M', dvt: 'cái', qty: 100, wac: 1200, keyItem: false },
            { maNL: IDS.nlStraw, tenNL: 'Ống hút mang đi', dvt: 'cái', qty: 200, wac: 200, keyItem: false },
            { maNL: IDS.nlBagGh, tenNL: 'Túi giao hàng chống tràn', dvt: 'cái', qty: 80, wac: 1500, keyItem: false },
            { maNL: IDS.nlBagApp, tenNL: 'Túi niêm phong App Sàn', dvt: 'cái', qty: 60, wac: 1800, keyItem: false },
        ];
        for (const ing of ingredients) {
            await migPool.query(
                `INSERT INTO public.NguyenLieu
                    (MaNL, TenNL, DonViTinh, SoLuongTon, TonKhoHienTai, HanMucCanhBao, NguongCanhBao, GiaVonDonVi, IsKeyItem, DaXoa, TenantId)
                 VALUES ($1, $2, $3, $4, $4, 10, 10, $5, $6, FALSE, $7)`,
                [ing.maNL, ing.tenNL, ing.dvt, ing.qty, ing.wac, ing.keyItem, TENANT_ID]
            );
            await migPool.query(
                `INSERT INTO public.TonKhoChiNhanh (TenantId, BranchId, MaNL, SoLuongTon, GiaVonDonVi, HanMucCanhBao)
                 VALUES ($1, $2, $3, $4, $5, 10)`,
                [TENANT_ID, BRANCH_ID, ing.maNL, ing.qty, ing.wac]
            );
        }

        // Seed Sản phẩm + Size M + Công thức nền (20g cà phê / ly M)
        await migPool.query(
            `INSERT INTO public.SanPham
                (MaMon, TenMon, NhomMon, DanhMuc, DangKinhDoanh, LaHangDongGoi, TramCheBien, InTemCoc, TamHet, TenantId, tax_category_code)
             VALUES ($1, 'Cà Phê Latte Pilot', 'Cà phê', 'Cà phê', TRUE, FALSE, 'BAR_CHINH', TRUE, FALSE, $2, 'VAT_8_FB')`,
            [IDS.spLatte, TENANT_ID]
        );
        await migPool.query(
            `INSERT INTO public.SanPham_Size (MaMon, KichThuoc, GiaBan)
             VALUES ($1, 'M', 45000)`,
            [IDS.spLatte]
        );
        await migPool.query(
            `INSERT INTO public.CongThuc (MaMon, KichThuoc, MaNL, KhoiLuongTieuHao)
             VALUES ($1, 'M', $2, 20)`,
            [IDS.spLatte, IDS.nlCoffee]
        );

        // Mở 1 ca thu ngân cho chi nhánh
        await migPool.query(
            `INSERT INTO public.CaThuNgan (MaNV, TienMatDauCa, TienDauCa, TrangThaiCa, TenantId, BranchId, TerminalId)
             VALUES ($1, 500000, 500000, 1, $2, $3, 'POS-01')`,
            [IDS.cashier, TENANT_ID, BRANCH_ID]
        );

        tokens = {
            mgr: signStaffToken({ maNV: IDS.mgr, tenNV: 'Quản lý Pilot', vaiTro: 1, tenantId: TENANT_ID, branchId: BRANCH_ID }),
            barista: signStaffToken({ maNV: IDS.barista, tenNV: 'Pha chế Pilot', vaiTro: 2, tenantId: TENANT_ID, branchId: BRANCH_ID }),
            cashier: signStaffToken({ maNV: IDS.cashier, tenNV: 'Thu ngân Pilot', vaiTro: 4, tenantId: TENANT_ID, branchId: BRANCH_ID }),
        };
    });

    after(async () => {
        if (migPool) {
            const tables = [
                'cauhinh_vattu_mangdi',
                'phien_kiemkho_mu',
                'chotton_ca',
                'chitietgiaodichkho',
                'phieugiaodichkho',
                'tonkhochinhanh',
                'chitiethoadon',
                'hoadon',
                'cathungan',
                'congthuc',
                'sanpham_size',
                'sanpham',
                'nguyenlieu',
                'ban',
                'nhanvien',
                'chinhanh',
                'tenants',
            ];
            for (const tbl of tables) {
                try {
                    if (tbl === 'chitietgiaodichkho') {
                        await migPool.query(
                            `DELETE FROM public.chitietgiaodichkho WHERE magiaodich IN (SELECT magiaodich FROM public.phieugiaodichkho WHERE tenantid = $1)`,
                            [TENANT_ID]
                        );
                    } else if (tbl === 'chitiethoadon') {
                        await migPool.query(
                            `DELETE FROM public.chitiethoadon WHERE mahoadon IN (SELECT mahoadon FROM public.hoadon WHERE tenantid = $1)`,
                            [TENANT_ID]
                        );
                    } else if (tbl === 'congthuc' || tbl === 'sanpham_size') {
                        await migPool.query(`DELETE FROM public.${tbl} WHERE mamon = $1`, [IDS.spLatte]);
                    } else {
                        await migPool.query(`DELETE FROM public.${tbl} WHERE tenantid = $1`, [TENANT_ID]);
                    }
                } catch {
                    // ignore optional cleanup errors
                }
            }
            await migPool.end();
        }
        await new Promise((resolve) => io.close(() => resolve()));
        if (server.listening) {
            await new Promise((resolve) => server.close(() => resolve()));
        }
        await pool.end();
    });

    it('1. Migration 040 chạy idempotent 2 lần liên tiếp & backfill an toàn trên DB cũ chưa có GiaTopping/GiaGiam', async () => {
        const mig040Path = path.join(BACKEND_ROOT, 'db', 'migrations', '040_ensure_topping_and_item_discount_cols.sql');
        assert.ok(fs.existsSync(mig040Path), 'Thiếu file db/migrations/040_ensure_topping_and_item_discount_cols.sql');
        const mig040Sql = fs.readFileSync(mig040Path, 'utf8');

        // Tạo DB tạm mô phỏng DB Staging/Production cũ chưa có Topping.GiaTopping & ChiTietHoaDon.GiaGiam
        const simDbName = `cafe_pos_sim040_${RUN_TAG.toLowerCase()}`;
        const baseUrlObj = new URL(MIGRATION_DB_URL);
        const adminUrl = new URL(MIGRATION_DB_URL);
        adminUrl.pathname = '/postgres';

        const adminClient = new Client({ connectionString: adminUrl.toString() });
        await adminClient.connect();
        try {
            await adminClient.query(`CREATE DATABASE "${simDbName}"`);
            const simUrl = new URL(baseUrlObj.toString());
            simUrl.pathname = `/${simDbName}`;
            const simClient = new Client({ connectionString: simUrl.toString() });
            await simClient.connect();
            try {
                // Schema cũ: Topping chỉ có GiaThem (chưa có GiaTopping), ChiTietHoaDon chưa có GiaGiam
                await simClient.query(`
                    CREATE TABLE public.Topping (
                        MaTopping VARCHAR(64) PRIMARY KEY,
                        TenTopping VARCHAR(120) NOT NULL,
                        GiaThem NUMERIC(15, 2) NOT NULL DEFAULT 0,
                        DangKinhDoanh BOOLEAN NOT NULL DEFAULT TRUE
                    );
                    INSERT INTO public.Topping (MaTopping, TenTopping, GiaThem) VALUES
                        ('TP_LEGACY_1', 'Trân châu đường đen', 12000),
                        ('TP_LEGACY_2', 'Thạch miễn phí', 0);

                    CREATE TABLE public.ChiTietHoaDon (
                        MaCTHD BIGSERIAL PRIMARY KEY,
                        MaHoaDon VARCHAR(64) NOT NULL,
                        MaMon VARCHAR(64) NOT NULL,
                        SoLuong INT NOT NULL DEFAULT 1,
                        DonGia NUMERIC(15, 2) NOT NULL DEFAULT 0
                    );
                    INSERT INTO public.ChiTietHoaDon (MaHoaDon, MaMon, SoLuong, DonGia) VALUES
                        ('HD_OLD_1', 'SP1', 1, 35000);
                `);

                // Lần chạy 1: bổ sung 2 cột & backfill GiaTopping từ GiaThem > 0
                await simClient.query(mig040Sql);

                const tpAfter1 = await simClient.query(`SELECT MaTopping, GiaTopping, GiaThem FROM public.Topping ORDER BY MaTopping`);
                assert.equal(Number(tpAfter1.rows[0].giatopping), 12000, 'Phải backfill GiaTopping = GiaThem (12000)');
                assert.equal(Number(tpAfter1.rows[1].giatopping), 0, 'GiaThem = 0 giữ nguyên GiaTopping = 0');

                const ctAfter1 = await simClient.query(`SELECT GiaGiam FROM public.ChiTietHoaDon WHERE MaHoaDon = 'HD_OLD_1'`);
                assert.equal(Number(ctAfter1.rows[0].giagiam), 0, 'ChiTietHoaDon.GiaGiam phải có default 0');

                // Cập nhật giá mới cho TP_LEGACY_1 để kiểm chứng lần chạy 2 KHÔNG ghi đè giá hiện hữu
                await simClient.query(`UPDATE public.Topping SET GiaTopping = 15000 WHERE MaTopping = 'TP_LEGACY_1'`);

                // Lần chạy 2: Idempotent 100%, không lỗi, không ghi đè giá đã chỉnh
                await simClient.query(mig040Sql);

                const tpAfter2 = await simClient.query(`SELECT GiaTopping FROM public.Topping WHERE MaTopping = 'TP_LEGACY_1'`);
                assert.equal(Number(tpAfter2.rows[0].giatopping), 15000, 'Lần chạy 2 KHÔNG được ghi đè GiaTopping > 0 hiện hữu');
            } finally {
                await simClient.end();
            }
        } finally {
            await adminClient.query(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
                [simDbName]
            ).catch(() => {});
            await adminClient.query(`DROP DATABASE IF EXISTS "${simDbName}"`);
            await adminClient.end();
        }
    });

    it('2. CI workflow (.github/workflows/ci.yml) không còn mốc cứng 039 và chạy tự động toàn bộ migrations', () => {
        const ciPath = path.join(BACKEND_ROOT, '.github', 'workflows', 'ci.yml');
        const ciContent = fs.readFileSync(ciPath, 'utf8');
        assert.ok(!ciContent.includes('039'), '.github/workflows/ci.yml không được còn mốc cứng 039');
        assert.ok(ciContent.includes('npm run db:migrate:test'), 'CI phải chạy npm run db:migrate:test');
        assert.ok(ciContent.includes('test:p1-ops'), 'CI phải chạy test:p1-ops');
        assert.ok(ciContent.includes('test:unit'), 'CI phải chạy test:unit');
    });

    it('3. Blind Stocktake cho nhân viên ca (Thu ngân 4 & Pha chế 2): trả 200, KHÔNG lộ tồn hệ thống/giá vốn, và chặn 403 route tài chính kho', async () => {
        // 3.1. Nhân viên ca tải danh sách kiểm kê mù qua GET /api/kho/kiem-ke/items -> 200 & tuyệt đối mù
        for (const [label, tok] of [['Cashier(4)', tokens.cashier], ['Barista(2)', tokens.barista]]) {
            const listRes = await apiReq(`/api/kho/kiem-ke/items?branchId=${encodeURIComponent(BRANCH_ID)}&keyOnly=1`, {
                token: tok,
            });
            assert.equal(listRes.status, 200, `${label} GET /api/kho/kiem-ke/items phải trả 200: ${listRes.text}`);
            assert.equal(listRes.json.isBlind, true, `${label} phải ở chế độ isBlind=true`);
            assert.ok(Array.isArray(listRes.json.items) && listRes.json.items.length >= 2, `${label} phải tải được Key Items`);
            assertNoForbiddenBlindFields(listRes.json, `${label} GET /api/kho/kiem-ke/items`);

            // Kiểm tra luôn GET /api/kho/nguyenlieu cũng không rò rỉ tồn/giá vốn cho nhân viên ca
            const nlRes = await apiReq(`/api/kho/nguyenlieu?branchId=${encodeURIComponent(BRANCH_ID)}`, { token: tok });
            assert.equal(nlRes.status, 200, `${label} GET /api/kho/nguyenlieu phải trả 200`);
            assertNoForbiddenBlindFields(nlRes.json, `${label} GET /api/kho/nguyenlieu`);
        }

        // 3.2. Thu ngân (role 4) mở phiên & nộp phiếu kiểm kê mù trong biên độ -> 200 POSTED, KHÔNG lộ tồn/lệch/giá vốn
        const startCsh = await apiReq('/api/kho/kiem-ke/start', {
            method: 'POST',
            token: tokens.cashier,
            body: { branchId: BRANCH_ID, keyOnly: true },
        });
        assert.equal(startCsh.status, 201, `Start blind stocktake lỗi: ${startCsh.text}`);
        assert.equal(startCsh.json.isBlind, true);
        assertNoForbiddenBlindFields(startCsh.json, 'Cashier POST /api/kho/kiem-ke/start');

        const subCsh = await apiReq('/api/kho/kiem-ke/submit', {
            method: 'POST',
            token: tokens.cashier,
            body: {
                sessionId: startCsh.json.sessionId,
                ghiChu: 'Thu ngân kiểm mù cuối ca',
                danhSachNguyenLieu: [{ maNL: IDS.nlCoffee, soLuong: 5000 }],
            },
        });
        assert.equal(subCsh.status, 200, `Cashier submit blind stocktake phải trả 200: ${subCsh.text}`);
        assert.equal(subCsh.json.trangThaiDuyet, 'POSTED');
        assertNoForbiddenBlindFields(subCsh.json, 'Cashier POST /api/kho/kiem-ke/submit');

        // 3.3. Pha chế (role 2) nộp phiếu lệch lớn (> 200.000đ): lần 1 -> 422 recount (không lộ số), lần 2 -> 200 PENDING_APPROVAL
        const startBar = await apiReq('/api/kho/kiem-ke/start', {
            method: 'POST',
            token: tokens.barista,
            body: { branchId: BRANCH_ID, keyOnly: true },
        });
        assert.equal(startBar.status, 201);
        assertNoForbiddenBlindFields(startBar.json, 'Barista POST /api/kho/kiem-ke/start');

        const subBar1 = await apiReq('/api/kho/kiem-ke/submit', {
            method: 'POST',
            token: tokens.barista,
            body: {
                sessionId: startBar.json.sessionId,
                danhSachNguyenLieu: [{ maNL: IDS.nlMilk, soLuong: 2000 }], // Lệch -1000ml * 400đ = 400.000đ
            },
        });
        assert.equal(subBar1.status, 422, `Lần 1 lệch lớn phải kích hoạt 422 BLIND_STOCK_RECOUNT: ${subBar1.text}`);
        assert.equal(subBar1.json.code, 'BLIND_STOCK_RECOUNT');
        assertNoForbiddenBlindFields(subBar1.json, 'Barista 422 recount');

        const subBar2 = await apiReq('/api/kho/kiem-ke/submit', {
            method: 'POST',
            token: tokens.barista,
            body: {
                sessionId: startBar.json.sessionId,
                recountConfirmed: true,
                danhSachNguyenLieu: [{ maNL: IDS.nlMilk, soLuong: 2000 }],
            },
        });
        assert.equal(subBar2.status, 200, `Lần 2 nộp kiểm kê mù phải trả 200: ${subBar2.text}`);
        assert.equal(subBar2.json.trangThaiDuyet, 'PENDING_APPROVAL');
        assertNoForbiddenBlindFields(subBar2.json, 'Barista POST /api/kho/kiem-ke/submit (PENDING_APPROVAL)');

        // Tồn kho chưa bị thay đổi khi chờ Quản lý duyệt
        assert.equal(await getBranchQty(IDS.nlMilk), 3000, 'Tồn kho chưa được đổi trước khi Quản lý duyệt');

        // 3.4. Chặn 403 nhân viên ca trên các route quản trị kho tài chính / duyệt / chỉnh thẳng kho
        const blockedChecks = [
            { method: 'GET', path: '/api/kho/candoi', label: 'Cân đối kho & WAC' },
            { method: 'GET', path: '/api/kho/dinh-gia', label: 'Định giá tồn kho' },
            { method: 'GET', path: '/api/kho/nhacungcap', label: 'Nhà cung cấp' },
            { method: 'GET', path: '/api/kho/kiem-ke/pending', label: 'Danh sách phiếu kiểm kê chờ duyệt' },
            {
                method: 'POST',
                path: `/api/kho/kiem-ke/${encodeURIComponent(subBar2.json.maGiaoDich)}/approve`,
                body: { approve: true },
                label: 'Duyệt phiếu kiểm kê',
            },
            {
                method: 'POST',
                path: '/api/kho/nhap',
                body: { danhSachNguyenLieu: [{ maNL: IDS.nlMilk, soLuong: 100, donGiaNhap: 400 }] },
                label: 'Nhập kho tài chính',
            },
            {
                method: 'POST',
                path: '/api/kho/kiemke',
                body: { loaiGD: 3, danhSachNguyenLieu: [{ maNL: IDS.nlMilk, soLuong: 2000 }] },
                label: 'Chỉnh thẳng tồn kho (loaiGD=3)',
            },
        ];
        for (const chk of blockedChecks) {
            for (const [roleName, tok] of [['Cashier(4)', tokens.cashier], ['Barista(2)', tokens.barista]]) {
                const r = await apiReq(chk.path, { method: chk.method, token: tok, body: chk.body });
                assert.equal(r.status, 403, `${roleName} truy cập ${chk.label} (${chk.method} ${chk.path}) PHẢI bị chặn 403, thực tế ${r.status}`);
            }
        }

        // 3.5. Quản lý (role 1) xem được chênh lệch trong /pending và duyệt phiếu -> cập nhật tồn kho thành 2000
        const pendMgr = await apiReq(`/api/kho/kiem-ke/pending?branchId=${encodeURIComponent(BRANCH_ID)}`, {
            token: tokens.mgr,
        });
        assert.equal(pendMgr.status, 200, `Manager GET /api/kho/kiem-ke/pending lỗi: ${pendMgr.text}`);
        const targetPending = pendMgr.json.find((p) => String(p.maGiaoDich) === String(subBar2.json.maGiaoDich));
        assert.ok(targetPending, 'Quản lý phải thấy phiếu PENDING_APPROVAL');
        assert.equal(targetPending.items[0].diff, -1000, 'Quản lý phải thấy đúng độ lệch -1000');

        const approveRes = await apiReq(`/api/kho/kiem-ke/${encodeURIComponent(subBar2.json.maGiaoDich)}/approve`, {
            method: 'POST',
            token: tokens.mgr,
            body: { approve: true },
        });
        assert.equal(approveRes.status, 200, `Manager approve lỗi: ${approveRes.text}`);
        assert.equal(await getBranchQty(IDS.nlMilk), 2000, 'Sau khi Quản lý duyệt, tồn chi nhánh phải cập nhật thành 2000');
    });

    it('4. Channel Packaging BOM: trừ đúng bao bì theo kênh bán (LoaiGD=6), tại chỗ không trừ nhầm, AWAITING_PAYMENT chỉ trừ 1 lần', async () => {
        // 4.1. Cấu hình bao bì theo kênh bán qua API dùng đúng format FE (loaiDonHang + soLuongMoiLy)
        const rulesToCreate = [
            { loaiDonHang: 'MANG_DI', kichThuoc: 'M', maNL: IDS.nlCupM, soLuongMoiLy: 1 },
            { loaiDonHang: 'ALL', kichThuoc: 'ALL', maNL: IDS.nlStraw, soLuongMoiLy: 1 },
            { loaiDonHang: 'GIAO_HANG', kichThuoc: 'ALL', maNL: IDS.nlBagGh, soLuongMoiLy: 2 },
            { loaiDonHang: 'APP', kichThuoc: 'ALL', maNL: IDS.nlBagApp, soLuongMoiLy: 1 }, // Kiểm chứng chuẩn hóa 'APP' -> 'APP_SAN'
        ];
        for (const rule of rulesToCreate) {
            const saveRes = await apiReq('/api/kho/vattu-mangdi', {
                method: 'POST',
                token: tokens.mgr,
                body: rule,
            });
            assert.equal(saveRes.status, 201, `Lưu cấu hình bao bì thất bại: ${saveRes.text}`);
            assert.equal(saveRes.json.savedCount, 1, 'Không được no-op, savedCount phải = 1');
        }

        const listPk = await apiReq('/api/kho/vattu-mangdi', { token: tokens.mgr });
        assert.equal(listPk.status, 200);
        assert.equal(listPk.json.length, 4, `Phải lưu đủ 4 dòng cấu hình bao bì theo kênh, thực tế: ${listPk.text}`);
        assert.ok(
            listPk.json.some((x) => x.kenhDung === 'APP_SAN' && x.maNL === IDS.nlBagApp && x.soLuongMoiLy === 1),
            'Kênh APP phải được chuẩn hóa thành APP_SAN'
        );

        const cf0 = await getBranchQty(IDS.nlCoffee);
        const cup0 = await getBranchQty(IDS.nlCupM);
        const straw0 = await getBranchQty(IDS.nlStraw);
        const bagGh0 = await getBranchQty(IDS.nlBagGh);
        const bagApp0 = await getBranchQty(IDS.nlBagApp);

        // 4.2. Đơn TẠI CHỖ (TAI_QUAN): 2 ly Latte M -> chỉ trừ 40g cà phê, TUYỆT ĐỐI KHÔNG trừ bao bì mang về!
        const dineInRes = await apiReq('/api/order', {
            method: 'POST',
            token: tokens.cashier,
            body: {
                branchId: BRANCH_ID,
                maBan: IDS.ban,
                loaiDonHang: 'TAI_QUAN',
                danhSachMon: [{ maMon: IDS.spLatte, kichThuoc: 'M', soLuong: 2 }],
            },
        });
        assert.equal(dineInRes.status, 201, `Tạo đơn tại chỗ lỗi: ${dineInRes.text}`);
        assert.equal(await getBranchQty(IDS.nlCoffee), cf0 - 40, 'Đơn tại chỗ phải trừ đúng 40g cà phê');
        assert.equal(await getBranchQty(IDS.nlCupM), cup0, 'Đơn tại chỗ KHÔNG ĐƯỢC trừ ly nhựa mang đi');
        assert.equal(await getBranchQty(IDS.nlStraw), straw0, 'Đơn tại chỗ KHÔNG ĐƯỢC trừ ống hút mang đi');
        assert.equal(await getBranchQty(IDS.nlBagGh), bagGh0, 'Đơn tại chỗ KHÔNG ĐƯỢC trừ túi giao hàng');
        assert.equal(await getBranchQty(IDS.nlBagApp), bagApp0, 'Đơn tại chỗ KHÔNG ĐƯỢC trừ túi App');

        // 4.3. Đơn MANG ĐI (MANG_DI): 2 ly Latte M -> trừ 40g cà phê + 2 ly nhựa M + 2 ống hút (KHÔNG trừ túi GH/App)
        const takeawayRes = await apiReq('/api/order', {
            method: 'POST',
            token: tokens.cashier,
            body: {
                branchId: BRANCH_ID,
                loaiDonHang: 'MANG_DI',
                danhSachMon: [{ maMon: IDS.spLatte, kichThuoc: 'M', soLuong: 2 }],
            },
        });
        assert.equal(takeawayRes.status, 201, `Tạo đơn mang đi lỗi: ${takeawayRes.text}`);
        const maHdTakeaway = takeawayRes.json.hoaDon.maHoaDon;
        assert.equal(await getBranchQty(IDS.nlCoffee), cf0 - 80);
        assert.equal(await getBranchQty(IDS.nlCupM), cup0 - 2, 'MANG_DI 2 ly M phải trừ 2 ly nhựa M');
        assert.equal(await getBranchQty(IDS.nlStraw), straw0 - 2, 'MANG_DI 2 ly phải trừ 2 ống hút (kênh ALL)');
        assert.equal(await getBranchQty(IDS.nlBagGh), bagGh0, 'MANG_DI không trừ túi GIAO_HANG');
        assert.equal(await getBranchQty(IDS.nlBagApp), bagApp0, 'MANG_DI không trừ túi APP_SAN');

        // Kiểm chứng sổ cái PhieuGiaoDichKho dùng đúng LoaiGD = 6 (Bán hàng) cho bao bì
        const ledgerTakeaway = await migPool.query(
            `SELECT p.loaigd, ct.manl, ct.soluong
               FROM public.phieugiaodichkho p
               JOIN public.chitietgiaodichkho ct ON ct.magiaodich = p.magiaodich
              WHERE p.tenantid = $1 AND p.branchid = $2 AND p.ghichu LIKE $3`,
            [TENANT_ID, BRANCH_ID, `%${maHdTakeaway}%`]
        );
        assert.ok(ledgerTakeaway.rows.length >= 3, 'Phải ghi đủ dòng sổ cái cho cà phê + ly nhựa + ống hút');
        for (const row of ledgerTakeaway.rows) {
            assert.equal(Number(row.loaigd), 6, 'Sổ cái tiêu hao bao bì phải dùng đúng LoaiGD = 6');
        }
        assert.equal(
            Number(ledgerTakeaway.rows.find((r) => r.manl === IDS.nlCupM)?.soluong),
            2,
            'Sổ cái LoaiGD=6 phải ghi nhận đúng 2 ly nhựa M'
        );

        // 4.4. Đơn GIAO HÀNG (GIAO_HANG): 1 ly Latte M -> trừ 20g cà phê + 1 ống hút + 2 túi GH (KHÔNG trừ ly MANG_DI hay túi APP)
        const deliveryRes = await apiReq('/api/order', {
            method: 'POST',
            token: tokens.cashier,
            body: {
                branchId: BRANCH_ID,
                loaiDonHang: 'GIAO_HANG',
                danhSachMon: [{ maMon: IDS.spLatte, kichThuoc: 'M', soLuong: 1 }],
            },
        });
        assert.equal(deliveryRes.status, 201, `Tạo đơn giao hàng lỗi: ${deliveryRes.text}`);
        assert.equal(await getBranchQty(IDS.nlCoffee), cf0 - 100);
        assert.equal(await getBranchQty(IDS.nlCupM), cup0 - 2, 'GIAO_HANG không trừ ly chỉ cấu hình cho MANG_DI');
        assert.equal(await getBranchQty(IDS.nlStraw), straw0 - 3, 'GIAO_HANG 1 ly trừ thêm 1 ống hút');
        assert.equal(await getBranchQty(IDS.nlBagGh), bagGh0 - 2, 'GIAO_HANG 1 ly trừ đúng 2 túi giao hàng');
        assert.equal(await getBranchQty(IDS.nlBagApp), bagApp0, 'GIAO_HANG không trừ túi APP_SAN');

        // 4.5. Đơn AWAITING_PAYMENT cho kênh APP_SAN: 2 ly Latte M -> tạo đơn CHƯA trừ kho; thanh toán trừ ĐÚNG 1 LẦN (LoaiGD=6), gọi lại không trừ đúp
        const awaitingRes = await apiReq('/api/order', {
            method: 'POST',
            token: tokens.cashier,
            body: {
                branchId: BRANCH_ID,
                loaiDonHang: 'APP_SAN',
                choThanhToanTruoc: true,
                danhSachMon: [{ maMon: IDS.spLatte, kichThuoc: 'M', soLuong: 2 }],
            },
        });
        assert.equal(awaitingRes.status, 201, `Tạo đơn AWAITING_PAYMENT lỗi: ${awaitingRes.text}`);
        const maHdApp = awaitingRes.json.hoaDon.maHoaDon;

        // Ngay sau khi tạo đơn AWAITING_PAYMENT: tồn kho KHÔNG đổi!
        assert.equal(await getBranchQty(IDS.nlCoffee), cf0 - 100, 'AWAITING_PAYMENT chưa được trừ cà phê trước khi thanh toán');
        assert.equal(await getBranchQty(IDS.nlStraw), straw0 - 3, 'AWAITING_PAYMENT chưa được trừ ống hút trước khi thanh toán');
        assert.equal(await getBranchQty(IDS.nlBagApp), bagApp0, 'AWAITING_PAYMENT chưa được trừ túi App trước khi thanh toán');

        // Chốt thanh toán đơn AWAITING_PAYMENT
        const expectedVer = Number(awaitingRes.json.hoaDon.version ?? 1);
        const payRes1 = await apiReq('/api/order/thanhtoan', {
            method: 'POST',
            token: tokens.cashier,
            headers: { 'Idempotency-Key': `IDEM_P1_PAY_${RUN_TAG}_1` },
            body: {
                maHoaDon: maHdApp,
                phuongThucTT: 'CHUYEN_KHOAN',
                branchId: BRANCH_ID,
                expectedVersion: expectedVer,
            },
        });
        assert.equal(payRes1.status, 200, `Thanh toán đơn AWAITING_PAYMENT lỗi: ${payRes1.text}`);
        assert.equal(await getBranchQty(IDS.nlCoffee), cf0 - 140, 'Sau thanh toán phải trừ đúng 40g cà phê');
        assert.equal(await getBranchQty(IDS.nlStraw), straw0 - 5, 'Sau thanh toán phải trừ đúng 2 ống hút');
        assert.equal(await getBranchQty(IDS.nlBagApp), bagApp0 - 2, 'Sau thanh toán phải trừ đúng 2 túi App');

        // Kiểm chứng đúng 1 phiếu LoaiGD = 6 cho đơn APP_SAN
        const ledgerApp = await migPool.query(
            `SELECT DISTINCT p.magiaodich, p.loaigd
               FROM public.phieugiaodichkho p
              WHERE p.tenantid = $1 AND p.branchid = $2 AND p.ghichu LIKE $3`,
            [TENANT_ID, BRANCH_ID, `%${maHdApp}%`]
        );
        assert.equal(ledgerApp.rows.length, 1, 'Đơn AWAITING_PAYMENT chỉ được tạo đúng 1 phiếu trừ kho');
        assert.equal(Number(ledgerApp.rows[0].loaigd), 6, 'Phiếu trừ kho AWAITING_PAYMENT phải dùng LoaiGD = 6');

        // Gọi thanh toán lần 2 (retry / duplicate request) -> TUYỆT ĐỐI không trừ đúp kho!
        const payRes2 = await apiReq('/api/order/thanhtoan', {
            method: 'POST',
            token: tokens.cashier,
            headers: { 'Idempotency-Key': `IDEM_P1_PAY_${RUN_TAG}_2` },
            body: {
                maHoaDon: maHdApp,
                phuongThucTT: 'CHUYEN_KHOAN',
                branchId: BRANCH_ID,
                expectedVersion: expectedVer + 1,
            },
        });
        assert.ok([400, 409].includes(payRes2.status), `Thanh toán lặp lại phải bị từ chối (400/409), thực tế ${payRes2.status}: ${payRes2.text}`);
        assert.equal(await getBranchQty(IDS.nlCoffee), cf0 - 140, 'Không được trừ đúp cà phê');
        assert.equal(await getBranchQty(IDS.nlStraw), straw0 - 5, 'Không được trừ đúp ống hút');
        assert.equal(await getBranchQty(IDS.nlBagApp), bagApp0 - 2, 'Không được trừ đúp túi App');
    });
});
