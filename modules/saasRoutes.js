const crypto = require('crypto');
const { PLAN_FEATURES, INDUSTRY_TEMPLATES } = require('./industryTemplates');
const { parseMenuUniversal, chuanHoaDanhSachMon } = require('./aiMenuImporter');
const { createRateLimitStore } = require('./redisCluster');

const REGISTER_RATE_LIMIT_MAX = 5;
const REGISTER_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 giờ

function createRegisterRateLimiter(store = createRateLimitStore('saas_register'), max = REGISTER_RATE_LIMIT_MAX, windowMs = REGISTER_RATE_LIMIT_WINDOW_MS) {
    return async (req, res, next) => {
        const ip = String(req.ip || req.socket?.remoteAddress || 'unknown').trim();
        try {
            const { dem, hetHan } = await store.increment(ip, windowMs);
            if (dem > max) {
                const retryAfterSec = Math.max(1, Math.ceil((hetHan - Date.now()) / 1000));
                res.set('Retry-After', String(retryAfterSec));
                return res.status(429).json({
                    code: 'REGISTER_RATE_LIMITED',
                    message: 'Bạn đã gửi quá nhiều yêu cầu đăng ký quán mới từ IP này. Vui lòng thử lại sau 1 giờ!',
                });
            }
        } catch {
            // Fail-open nếu store lỗi đột ngột
        }
        next();
    };
}

const TRIAL_DAYS = 30;
const GRACE_DAYS = 5; // 5 ngày ân hạn (Grace Period) sau khi hết hạn: vẫn cho bán hàng kèm banner nhắc gia hạn, tránh cắt ngang giờ cao điểm!
const BILLING_DISCOUNT = { 1: 0, 6: 0.1, 12: 0.2 };
const SAAS_BANK_CONFIG = {
    bankId: process.env.SAAS_BILLING_BANK_ID || 'MB',
    accountNo: process.env.SAAS_BILLING_ACCOUNT_NO || '0123456789',
    accountName: process.env.SAAS_BILLING_ACCOUNT_NAME || 'CONG TY POS CAFE SAAS',
};

let multiTenantSanSang = false;

function danhGiaTrangThaiGoi(row) {
    const tenantId = String(row?.tenantid || row?.tenantId || 'DEFAULT');
    const goiCuoc = String(row?.goicuoc || row?.goiCuoc || '').toUpperCase();
    // Tài khoản quán gốc DEFAULT (chủ sở hữu hệ thống) luôn hoạt động bản chính thức vĩnh viễn
    if (tenantId === 'DEFAULT') {
        return {
            trangThai: 'ACTIVE',
            laDungThu: false,
            isFreeForever: false,
            hetHan: false,
            soNgayConLai: null,
            trialEndsAt: null,
            subscriptionEndsAt: null,
        };
    }

    const rawStatus = String(row?.trangthai || row?.trangThai || 'TRIAL').toUpperCase();
    const trialEndsAt = row?.trialendsat || row?.trialEndsAt || null;
    const subscriptionEndsAt = row?.subscriptionendsat || row?.subscriptionEndsAt || null;
    const now = Date.now();

    if (rawStatus === 'SUSPENDED') {
        return {
            trangThai: 'SUSPENDED',
            laDungThu: false,
            isFreeForever: false,
            hetHan: true,
            soNgayConLai: 0,
            trialEndsAt,
            subscriptionEndsAt,
        };
    }

    // [PHÂN HỆ 9] Gói FREE Vĩnh viễn (Acquisition Wedge): Không bị khóa HTTP 402 theo thời gian, chỉ giới hạn 350 đơn/tháng & báo cáo 7 ngày
    if (goiCuoc === 'FREE' && rawStatus === 'ACTIVE') {
        return {
            trangThai: 'ACTIVE',
            laDungThu: false,
            isFreeForever: true,
            trongAnHan: false,
            soNgayAnHanConLai: 0,
            hetHan: false,
            soNgayConLai: null,
            trialEndsAt: null,
            subscriptionEndsAt: null,
        };
    }

    if (rawStatus === 'TRIAL') {
        const endMs = trialEndsAt ? new Date(trialEndsAt).getTime() : now + TRIAL_DAYS * 86400000;
        const diffMs = endMs - now;
        const graceEndMs = endMs + GRACE_DAYS * 86400000;
        const soNgayConLai = Math.max(0, Math.ceil(diffMs / 86400000));
        const trongAnHan = diffMs <= 0 && now < graceEndMs;
        const soNgayAnHanConLai = trongAnHan ? Math.max(1, Math.ceil((graceEndMs - now) / 86400000)) : 0;
        const hetHan = now >= graceEndMs;
        return {
            trangThai: hetHan ? 'EXPIRED' : trongAnHan ? 'GRACE_PERIOD' : 'TRIAL',
            laDungThu: true,
            trongAnHan,
            soNgayAnHanConLai,
            hetHan,
            soNgayConLai,
            trialEndsAt: new Date(endMs).toISOString(),
            subscriptionEndsAt: null,
        };
    }

    if (rawStatus === 'EXPIRED') {
        return {
            trangThai: 'EXPIRED',
            laDungThu: false,
            trongAnHan: false,
            soNgayAnHanConLai: 0,
            hetHan: true,
            soNgayConLai: 0,
            trialEndsAt,
            subscriptionEndsAt,
        };
    }

    // ACTIVE (Bản chính thức trả phí)
    if (subscriptionEndsAt) {
        const endMs = new Date(subscriptionEndsAt).getTime();
        const diffMs = endMs - now;
        const graceEndMs = endMs + GRACE_DAYS * 86400000;
        const soNgayConLai = Math.max(0, Math.ceil(diffMs / 86400000));
        const trongAnHan = diffMs <= 0 && now < graceEndMs;
        const soNgayAnHanConLai = trongAnHan ? Math.max(1, Math.ceil((graceEndMs - now) / 86400000)) : 0;
        const hetHan = now >= graceEndMs;
        return {
            trangThai: hetHan ? 'EXPIRED' : trongAnHan ? 'GRACE_PERIOD' : 'ACTIVE',
            laDungThu: false,
            trongAnHan,
            soNgayAnHanConLai,
            hetHan,
            soNgayConLai,
            trialEndsAt,
            subscriptionEndsAt: new Date(endMs).toISOString(),
        };
    }

    return {
        trangThai: 'ACTIVE',
        laDungThu: false,
        hetHan: false,
        soNgayConLai: null,
        trialEndsAt,
        subscriptionEndsAt: null,
    };
}

async function khoiTaoMultiTenantSaaS(pool) {
    if (process.env.SKIP_AUTO_DDL === 'true') {
        try {
            const chk = await pool.query("SELECT to_regclass('public.tenants') IS NOT NULL AS ok");
            multiTenantSanSang = chk.rows[0]?.ok === true;
        } catch {
            multiTenantSanSang = false;
        }
        return;
    }
    try {
        // QUAN TRỌNG: Tách riêng từng câu lệnh SQL (node-postgres cấm truyền $1 vào multi-statement query!)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS Tenants (
                TenantId           VARCHAR(64) PRIMARY KEY,
                MaTienTo           VARCHAR(12) NOT NULL UNIQUE,
                TenQuan            VARCHAR(150) NOT NULL,
                Slug               VARCHAR(100) NOT NULL UNIQUE,
                MoHinh             VARCHAR(32) NOT NULL DEFAULT 'CAFE_TAKEAWAY',
                GoiCuoc            VARCHAR(24) NOT NULL DEFAULT 'STARTER',
                TrangThai          VARCHAR(24) NOT NULL DEFAULT 'TRIAL',
                TrialEndsAt        TIMESTAMPTZ,
                SubscriptionEndsAt TIMESTAMPTZ,
                LastPaymentAt      TIMESTAMPTZ,
                FeatureFlags       JSONB NOT NULL DEFAULT '{}'::jsonb,
                ThongTinNganHang   JSONB NOT NULL DEFAULT '{}'::jsonb,
                ThoiGianTao        TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        // Đảm bảo các cột bản quyền/dùng thử 30 ngày tồn tại nếu bảng Tenants đã được tạo từ trước
        const tenantAlters = [
            'ALTER TABLE Tenants ADD COLUMN IF NOT EXISTS TrialEndsAt TIMESTAMPTZ',
            'ALTER TABLE Tenants ADD COLUMN IF NOT EXISTS SubscriptionEndsAt TIMESTAMPTZ',
            'ALTER TABLE Tenants ADD COLUMN IF NOT EXISTS LastPaymentAt TIMESTAMPTZ',
        ];
        for (const sql of tenantAlters) {
            try {
                await pool.query(sql);
            } catch (e) {
                console.warn('⚠️ Bỏ qua nâng cấp cột Tenants:', e.message);
            }
        }

        await pool.query(
            `INSERT INTO Tenants (TenantId, MaTienTo, TenQuan, Slug, MoHinh, GoiCuoc, TrangThai, FeatureFlags)
             VALUES (
                 'DEFAULT', 'DEF', 'Quán Cà Phê Mặc Định', 'default-cafe',
                 'CAFE_SAN_VUON', 'PRO', 'ACTIVE', $1::jsonb
             )
             ON CONFLICT (TenantId) DO NOTHING`,
            [JSON.stringify(PLAN_FEATURES.PRO)]
        );

        await pool.query(`
            CREATE TABLE IF NOT EXISTS Tenant_Billing_Orders (
                Id                BIGSERIAL PRIMARY KEY,
                MaDonThanhToan    VARCHAR(64) NOT NULL UNIQUE,
                TenantId          VARCHAR(64) NOT NULL REFERENCES Tenants(TenantId) ON DELETE CASCADE,
                GoiCuoc           VARCHAR(24) NOT NULL,
                SoThang           INT NOT NULL DEFAULT 1,
                SoTien            NUMERIC(15, 2) NOT NULL CHECK (SoTien > 0),
                TrangThai         VARCHAR(24) NOT NULL DEFAULT 'PENDING',
                PhuongThucTT      VARCHAR(32) NOT NULL DEFAULT 'VIETQR',
                MaGiaoDichNgoai   VARCHAR(128),
                GhiChu            TEXT,
                ThoiGianTao       TIMESTAMPTZ NOT NULL DEFAULT now(),
                ThoiGianThanhToan TIMESTAMPTZ
            )
        `);
        await pool.query(
            'CREATE INDEX IF NOT EXISTS idx_tenant_billing_tenant ON Tenant_Billing_Orders (TenantId, ThoiGianTao DESC)'
        );

        const tables = [
            'NhanVien', 'Ban', 'SanPham', 'Topping', 'NguyenLieu', 'HoaDon',
            'CaThuNgan', 'KhachHang', 'PhieuGiaoDichKho', 'PhanCa', 'CaLamViec',
            'Audit_Logs', 'Order_Payments', 'VietQR_Webhook_Events',
        ];
        for (const tbl of tables) {
            try {
                await pool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT'`);
            } catch (e) {
                console.warn(`⚠️ Bỏ qua gắn TenantId vào ${tbl}:`, e.message);
            }
        }

        // Bật PostgreSQL Row-Level Security (RLS) FAIL-CLOSED cô lập dữ liệu ở tầng DB engine
        // Tuyệt đối KHÔNG ghi đè DROP POLICY nếu Migration 004/007 đã cài chính sách Fail-Closed!
        for (const tbl of tables) {
            try {
                await pool.query(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY`);
                await pool.query(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY`).catch(() => {});
                const pol = await pool.query(
                    `SELECT 1 FROM pg_policies
                      WHERE schemaname = 'public'
                        AND tablename = LOWER($1)
                        AND policyname = 'tenant_isolation_policy'
                      LIMIT 1`,
                    [tbl]
                );
                if (pol.rows.length === 0) {
                    await pool.query(
                        `CREATE POLICY tenant_isolation_policy ON ${tbl}
                         USING (TenantId = NULLIF(current_setting('app.current_tenant_id', true), ''))
                         WITH CHECK (TenantId = NULLIF(current_setting('app.current_tenant_id', true), ''))`
                    );
                }
            } catch (e) {
                console.warn(`⚠️ Bỏ qua bật RLS trên ${tbl}:`, e.message);
            }
        }

        multiTenantSanSang = true;
    } catch (error) {
        console.warn('⚠️ Bỏ qua auto-DDL Multi-Tenant SaaS (kiểm tra bảng hiện có):', error.message);
        try {
            const chk = await pool.query("SELECT to_regclass('public.tenants') IS NOT NULL AS ok");
            if (chk.rows[0]?.ok === true) {
                multiTenantSanSang = true;
            }
        } catch {
            // ignore
        }
    }
}

async function kiemTraMultiTenantSanSang(pool) {
    const chk = await pool.query("SELECT to_regclass('public.tenants') IS NOT NULL AS ok");
    multiTenantSanSang = chk.rows[0]?.ok === true;
    return multiTenantSanSang;
}

// Middleware chặn bán hàng khi bản dùng thử 30 ngày đã hết hạn (hoặc gói trả phí đã hết hạn)
function taoMiddlewareKiemTraHanSuDung(pool) {
    return async (req, res, next) => {
        const tenantId = String(req?.user?.tenantId || 'DEFAULT');
        if (tenantId === 'DEFAULT' || !multiTenantSanSang) return next();

        try {
            const r = await pool.query(
                'SELECT TenantId, GoiCuoc, TrangThai, TrialEndsAt, SubscriptionEndsAt FROM Tenants WHERE TenantId = $1',
                [tenantId]
            );
            if (r.rows.length === 0) return next();
            const sub = danhGiaTrangThaiGoi(r.rows[0]);
            if (sub.hetHan) {
                return res.status(402).json({
                    code: sub.laDungThu ? 'TRIAL_EXPIRED' : 'SUBSCRIPTION_EXPIRED',
                    message: sub.laDungThu
                        ? 'Bản dùng thử miễn phí 30 ngày đã kết thúc! Bạn có thể nâng cấp gói STARTER/PRO hoặc chuyển sang gói FREE vĩnh viễn (350 đơn/tháng) tại Quản trị → Bản quyền & Gói cước.'
                        : 'Gói bản quyền của quán đã hết hạn hoặc bị tạm khóa. Vui lòng gia hạn hoặc chuyển về gói FREE để tiếp tục sử dụng.',
                    subscription: sub,
                });
            }
            next();
        } catch (err) {
            console.warn('⚠️ Không kiểm tra được hạn dùng thử:', err.message);
            next();
        }
    };
}

const taoSlug = (text) => {
    const base = String(text || 'quan-cafe')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'quan-cafe';
    return `${base}-${crypto.randomBytes(2).toString('hex')}`;
};

function tinhTienGoi(goiCuoc, soThang, extraBranches = 0, branchCount = null) {
    const planKey = String(goiCuoc || '').trim().toUpperCase();
    const plan = PLAN_FEATURES[planKey];
    if (!plan || Number(plan.priceVnd) <= 0) return null;
    const months = [1, 6, 12].includes(Number(soThang)) ? Number(soThang) : 1;
    const discount = BILLING_DISCOUNT[months] || 0;
    const isChainPlan = planKey === 'CHAIN' || planKey === 'ENTERPRISE';
    const minBranches = isChainPlan ? Number(plan.minBranches || 3) : 1;

    let totalBranches = 1;
    let extra = 0;
    if (isChainPlan) {
        if (branchCount !== null && branchCount !== undefined && branchCount !== '') {
            const parsedCount = Number(branchCount);
            if (!Number.isInteger(parsedCount) || parsedCount < minBranches) {
                return { error: 'CHAIN_MIN_BRANCHES_REQUIRED', minBranches };
            }
            totalBranches = Math.min(200, parsedCount);
            extra = Math.max(0, totalBranches - minBranches);
        } else {
            extra = Math.min(100, Math.max(0, parseInt(extraBranches, 10) || 0));
            totalBranches = minBranches + extra;
        }
    }

    const monthlyUnit = isChainPlan
        ? Number(plan.priceVnd) * totalBranches
        : Number(plan.priceVnd);
    const goc = monthlyUnit * months;
    const soTien = Math.round(goc * (1 - discount));
    return {
        goiCuoc: planKey,
        months,
        discount,
        goc,
        soTien,
        extraBranches: extra,
        branchCount: totalBranches,
        minBranches,
        monthlyUnit,
    };
}

function registerSaasRoutes(
    app,
    { pool, chayGiaoDich, kiemTraToken, choPhepVaiTro, kiemTraPlatformAdmin, gioiHanDangNhap, hashPassword, jwt, ghiAuditLog, guiLoi, yeuCauTinhNang, xoaCacheEntitlement }
) {
    const checkAiMenu = typeof yeuCauTinhNang === 'function' ? yeuCauTinhNang('ai_menu_importer') : (req, res, next) => next();
    // 1. Danh sách mô hình mẫu & gói cước (Public cho trang Đăng ký Dùng thử 30 ngày)
    app.get('/api/saas/templates', (req, res) => {
        const templates = Object.values(INDUSTRY_TEMPLATES).map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            productCount: t.products.length,
            ingredientCount: t.ingredients.length,
            toppingCount: t.toppings.length,
            sampleProducts: t.products.slice(0, 4).map((p) => p.name),
        }));
        res.json({
            trialDays: TRIAL_DAYS,
            templates,
            plans: PLAN_FEATURES,
            billingDiscounts: BILLING_DISCOUNT,
        });
    });

    const gioiHanDangKySaas = createRegisterRateLimiter();

    // 2. Đăng ký Quán mới: hỗ trợ Gói FREE vĩnh viễn (350 đơn/tháng) hoặc Dùng thử 30 ngày (STARTER/PRO)
    //    + Tách định danh đăng nhập: Chủ quán dùng Email/SĐT toàn hệ thống, nhân viên dùng /login?shop=<slug>
    app.post('/api/saas/register', gioiHanDangKySaas, async (req, res) => {
        const {
            tenQuan,
            moHinh = 'CAFE_TAKEAWAY',
            soBan = 8,
            tenChuQuan,
            tenDangNhap,
            email = '',
            soDienThoai = '',
            matKhau,
            goiCuoc = 'PRO',
            referredBy = '',
        } = req.body || {};

        const cleanQuan = String(tenQuan || '').trim();
        const cleanChu = String(tenChuQuan || '').trim();
        const cleanUser = String(tenDangNhap || '').trim().toLowerCase();
        const cleanEmail = String(email || '').trim().toLowerCase();
        const cleanPhone = String(soDienThoai || '').replace(/[^0-9+]/g, '').trim();
        const cleanPhoneDigits = cleanPhone.replace(/[^0-9]/g, '');
        const cleanPass = String(matKhau || '');
        const cleanRef = String(referredBy || '').trim().slice(0, 100) || null;

        if (cleanQuan.length < 2 || cleanChu.length < 2) {
            return res.status(400).json({ message: 'Vui lòng nhập Tên quán và Tên chủ quán (tối thiểu 2 ký tự)!' });
        }
        if (!/^[a-z0-9_.-]{3,32}$/.test(cleanUser)) {
            return res.status(400).json({ message: 'Tên đăng nhập dài 3–32 ký tự (chỉ chữ thường, số, ., _, -)!' });
        }
        if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
            return res.status(400).json({ message: 'Địa chỉ Email chủ quán không hợp lệ!' });
        }
        if (cleanPhone && (cleanPhoneDigits.length < 9 || cleanPhoneDigits.length > 15)) {
            return res.status(400).json({ message: 'Số điện thoại chủ quán phải gồm 9–15 chữ số!' });
        }
        if (cleanPass.length < 6 || cleanPass.length > 128) {
            return res.status(400).json({ message: 'Mật khẩu phải từ 6 ký tự trở lên!' });
        }

        const template = INDUSTRY_TEMPLATES[moHinh] || INDUSTRY_TEMPLATES.CAFE_TAKEAWAY;
        const plan = PLAN_FEATURES[goiCuoc] ? goiCuoc : 'PRO';
        const isFreePlan = plan === 'FREE';
        const tableCount = Math.min(30, Math.max(0, parseInt(soBan, 10) || 0));

        try {
            if (!multiTenantSanSang) {
                await khoiTaoMultiTenantSaaS(pool);
            }

            // Kiểm tra trùng Email / SĐT toàn hệ thống (định danh duy nhất cho Chủ quán)
            if (cleanEmail || cleanPhoneDigits.length >= 9) {
                try {
                    const cRes = await pool.query(
                        'SELECT email_exists, phone_exists FROM public.fn_contact_exists($1, $2)',
                        [cleanEmail || null, cleanPhoneDigits || null]
                    );
                    if (cRes.rows[0]?.email_exists) {
                        return res.status(409).json({ message: `Email "${cleanEmail}" đã được sử dụng cho một quán khác!` });
                    }
                    if (cRes.rows[0]?.phone_exists) {
                        return res.status(409).json({ message: `Số điện thoại "${cleanPhone}" đã được sử dụng cho một quán khác!` });
                    }
                } catch {
                    // Fallback nếu migration 020 chưa chạy
                }
            }

            const tenantId = `TN_${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
            // [Wave 1 — P0-04] Sinh MaTienTo bằng 4 bytes ngẫu nhiên (Q + 8 hex = 9 ký tự <= VARCHAR(12)) kèm vòng lặp kiểm tra UNIQUE
            let maTienTo = '';
            for (let attempt = 0; attempt < 8; attempt += 1) {
                const candidate = `Q${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
                const dupCheck = await pool.query('SELECT 1 FROM Tenants WHERE MaTienTo = $1 LIMIT 1', [candidate]);
                if (dupCheck.rows.length === 0) {
                    maTienTo = candidate;
                    break;
                }
            }
            if (!maTienTo) {
                throw new Error('Không thể sinh MaTienTo duy nhất sau nhiều lần thử!');
            }
            const slug = taoSlug(cleanQuan);
            const hashedPass = await hashPassword(cleanPass);
            const initialStatus = isFreePlan ? 'ACTIVE' : 'TRIAL';
            const trialEndsAt = isFreePlan ? null : new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();
            const ownerContact = [cleanEmail, cleanPhone].filter(Boolean).join(' | ') || null;

            const ketQua = await chayGiaoDich(async (client) => {
                // a. Tạo Tenant (FREE -> ACTIVE vĩnh viễn; STARTER/PRO -> TRIAL 30 ngày)
                await client.query('SAVEPOINT sp_ins_tenant_ext');
                try {
                    await client.query(
                        `INSERT INTO Tenants
                            (TenantId, MaTienTo, TenQuan, Slug, MoHinh, GoiCuoc, TrangThai, TrialEndsAt, FeatureFlags, OwnerContact, ReferredBy, LastLoginAt)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb, $10, $11, now())`,
                        [tenantId, maTienTo, cleanQuan, slug, template.id, plan, initialStatus, trialEndsAt, JSON.stringify(PLAN_FEATURES[plan]), ownerContact, cleanRef]
                    );
                    await client.query('RELEASE SAVEPOINT sp_ins_tenant_ext');
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_ins_tenant_ext');
                    await client.query(
                        `INSERT INTO Tenants
                            (TenantId, MaTienTo, TenQuan, Slug, MoHinh, GoiCuoc, TrangThai, TrialEndsAt, FeatureFlags)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb)`,
                        [tenantId, maTienTo, cleanQuan, slug, template.id, plan, initialStatus, trialEndsAt, JSON.stringify(PLAN_FEATURES[plan])]
                    );
                }

                // b. Tạo 3 tài khoản (Chủ quán/Quản lý + Thu ngân mẫu + Barista mẫu)
                //    Với Migration 020: username chỉ cần duy nhất trong phạm vi 1 quán!
                const maNVQuanLy = `${maTienTo}_QL1`;
                const maNVThuNgan = `${maTienTo}_TN1`;
                const maNVBarista = `${maTienTo}_BR1`;
                let userThuNgan = cleanUser === 'thungan' ? `${cleanUser}_1` : 'thungan';
                let userBarista = cleanUser === 'barista' ? `${cleanUser}_1` : 'barista';

                await client.query('SAVEPOINT sp_ins_staff_ext');
                try {
                    await client.query(
                        `INSERT INTO NhanVien (MaNV, TenNV, VaiTro, TenDangNhap, Email, SoDienThoai, MatKhauHash, MucLuongTheoGio, TrangThaiLamViec, LastLoginAt, TenantId)
                         VALUES
                           ($1, $2, 1, $3, $4, $5, $6, 45000, TRUE, now(), $11),
                           ($7, 'Thu ngân Mẫu', 4, $8, NULL, NULL, $6, 28000, TRUE, NULL, $11),
                           ($9, 'Barista Mẫu', 2, $10, NULL, NULL, $6, 30000, TRUE, NULL, $11)`,
                        [
                            maNVQuanLy,
                            cleanChu,
                            cleanUser,
                            cleanEmail || null,
                            cleanPhone || null,
                            hashedPass,
                            maNVThuNgan,
                            userThuNgan,
                            maNVBarista,
                            userBarista,
                            tenantId,
                        ]
                    );
                    await client.query('RELEASE SAVEPOINT sp_ins_staff_ext');
                } catch (staffErr) {
                    await client.query('ROLLBACK TO SAVEPOINT sp_ins_staff_ext');
                    if (staffErr.code === '23505' && /email|phone|sodienthoai/i.test(String(staffErr.constraint || staffErr.message))) {
                        throw staffErr;
                    }
                    // Fallback nếu DB cũ chưa chạy Migration 020 (vẫn còn UNIQUE toàn cục trên TenDangNhap)
                    userThuNgan = `${cleanUser}_${maTienTo.toLowerCase()}_tn`;
                    userBarista = `${cleanUser}_${maTienTo.toLowerCase()}_bar`;
                    await client.query(
                        `INSERT INTO NhanVien (MaNV, TenNV, VaiTro, TenDangNhap, MatKhauHash, MucLuongTheoGio, TrangThaiLamViec, TenantId)
                         VALUES
                           ($1, $2, 1, $3, $4, 45000, TRUE, $9),
                           ($5, 'Thu ngân Mẫu', 4, $6, $4, 28000, TRUE, $9),
                           ($7, 'Barista Mẫu', 2, $8, $4, 30000, TRUE, $9)`,
                        [maNVQuanLy, cleanChu, cleanUser, hashedPass, maNVThuNgan, userThuNgan, maNVBarista, userBarista, tenantId]
                    );
                }

                // c. Seed Ca làm việc chuẩn
                await client.query(
                    `INSERT INTO CaLamViec (MaCa, TenCa, GioBatDau, GioKetThuc, TenantId)
                     VALUES ($1, 'Ca Sáng', '07:00:00', '14:00:00', $3),
                            ($2, 'Ca Chiều', '14:00:00', '22:00:00', $3)
                     ON CONFLICT DO NOTHING`,
                    [`${maTienTo}_CA1`, `${maTienTo}_CA2`, tenantId]
                );

                // d. Seed Sơ đồ bàn theo quy mô chủ quán chọn
                const areas = template.defaultAreas;
                for (let i = 1; i <= tableCount; i++) {
                    const maBan = `${maTienTo}_B${String(i).padStart(2, '0')}`;
                    const tenBan = `Bàn ${String(i).padStart(2, '0')}`;
                    const khuVuc = areas[i <= Math.ceil(tableCount / 2) ? 0 : Math.min(1, areas.length - 1)];
                    await client.query(
                        `INSERT INTO Ban (MaBan, TenBan, TrangThai, KhuVuc, ToaDoX, ToaDoY, DaXoa, TenantId)
                         VALUES ($1, $2, 1, $3, $4, $5, FALSE, $6)`,
                        [maBan, tenBan, khuVuc, ((i - 1) % 4) * 120, Math.floor((i - 1) / 4) * 100, tenantId]
                    );
                }

                // e. Seed Nguyên liệu kho kèm Giá vốn WAC chuẩn
                const nlIdMap = new Map();
                for (const nl of template.ingredients) {
                    const maNL = `${maTienTo}_${nl.code}`;
                    nlIdMap.set(nl.code, maNL);
                    await client.query(
                        `INSERT INTO NguyenLieu (MaNL, TenNL, DonViTinh, SoLuongTon, HanMucCanhBao, GiaVonDonVi, DaXoa, TenantId)
                         VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7)`,
                        [maNL, nl.name, nl.unit, nl.stock, nl.warn, nl.cost, tenantId]
                    );
                }

                // f. Seed Topping
                for (const tp of template.toppings) {
                    const maTP = `${maTienTo}_${tp.code}`;
                    const maNL = nlIdMap.get(tp.nlCode) || null;
                    await client.query(
                        `INSERT INTO Topping (MaTopping, TenTopping, GiaTopping, MaNL, KhoiLuongTieuHao, DangKinhDoanh, TenantId)
                         VALUES ($1, $2, $3, $4, $5, TRUE, $6)`,
                        [maTP, tp.name, tp.price, maNL, tp.qty, tenantId]
                    );
                }

                // g. Seed Thực đơn + Giá Size S/M/L + Công thức BOM tự động theo hệ số Size
                const sizeFactor = { S: 0.85, M: 1.0, L: 1.25 };
                for (const p of template.products) {
                    const maMon = `${maTienTo}_${p.code}`;
                    await client.query(
                        `INSERT INTO SanPham (MaMon, TenMon, NhomMon, GiaGoc, DangKinhDoanh, TamHet, TenantId)
                         VALUES ($1, $2, $3, $4, TRUE, FALSE, $5)`,
                        [maMon, p.name, p.group, p.s, tenantId]
                    );
                    for (const [sz, gia] of [['S', p.s], ['M', p.m], ['L', p.l]]) {
                        await client.query(
                            'INSERT INTO SanPham_Size (MaMon, KichThuoc, GiaBan) VALUES ($1, $2, $3)',
                            [maMon, sz, gia]
                        );
                        for (const b of p.bom || []) {
                            const maNL = nlIdMap.get(b.nl);
                            if (!maNL) continue;
                            const qty = Math.round(b.qty * sizeFactor[sz] * 100) / 100;
                            await client.query(
                                'INSERT INTO CongThuc (MaMon, KichThuoc, MaNL, KhoiLuongTieuHao) VALUES ($1, $2, $3, $4)',
                                [maMon, sz, maNL, qty]
                            );
                        }
                    }
                }

                // h. Tự mở sẵn Ca đầu tiên (500k đầu ca)
                await client.query(
                    'INSERT INTO CaThuNgan (MaNV, TienMatDauCa, TenantId) VALUES ($1, 500000, $2)',
                    [maNVQuanLy, tenantId]
                );

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: maNVQuanLy,
                    vaiTro: 1,
                    hanhDong: 'TENANT_REGISTERED',
                    doiTuong: 'TENANT',
                    maDoiTuong: tenantId,
                    giaTriMoi: {
                        tenQuan: cleanQuan,
                        moHinh: template.id,
                        goiCuoc: plan,
                        soBan: tableCount,
                        isFreePlan,
                        trialDays: isFreePlan ? 0 : TRIAL_DAYS,
                        trialEndsAt,
                        referredBy: cleanRef,
                    },
                    ip: req.ip,
                });

                return {
                    maNVQuanLy,
                    demoAccounts: [
                        { role: 'Quản lý', username: cleanUser },
                        { role: 'Thu ngân', username: userThuNgan },
                        { role: 'Barista KDS', username: userBarista },
                    ],
                };
            }, tenantId);

            const subscription = danhGiaTrangThaiGoi({
                tenantId,
                goiCuoc: plan,
                trangThai: initialStatus,
                trialEndsAt,
            });

            const token = jwt.sign(
                {
                    maNV: ketQua.maNVQuanLy,
                    vaiTro: 1,
                    tenantId,
                    maTienTo,
                    slug,
                    tenQuan: cleanQuan,
                    goiCuoc: plan,
                    trangThaiGoi: subscription.trangThai,
                },
                process.env.JWT_SECRET,
                { expiresIn: '8h' }
            );

            res.status(201).json({
                message: isFreePlan
                    ? `Chào mừng "${cleanQuan}"! Gói FREE vĩnh viễn (350 đơn/tháng) đã sẵn sàng bán hàng ngay.`
                    : `Chào mừng "${cleanQuan}"! Bạn đang dùng thử miễn phí ${TRIAL_DAYS} ngày (đến ${new Date(trialEndsAt).toLocaleDateString('vi-VN')}).`,
                token,
                user: {
                    maNV: ketQua.maNVQuanLy,
                    tenNV: cleanChu,
                    vaiTro: 1,
                    email: cleanEmail || null,
                    soDienThoai: cleanPhone || null,
                    tenantId,
                    maTienTo,
                    slug,
                    tenQuan: cleanQuan,
                    goiCuoc: plan,
                    featureFlags: PLAN_FEATURES[plan],
                    subscription,
                },
                shopLoginUrl: `/login?shop=${slug}`,
                demoAccounts: ketQua.demoAccounts,
                seededSummary: {
                    moHinh: template.name,
                    soMon: template.products.length,
                    soNguyenLieu: template.ingredients.length,
                    soTopping: template.toppings.length,
                    soBan: tableCount,
                    isFreePlan,
                    trialDays: isFreePlan ? 0 : TRIAL_DAYS,
                    trialEndsAt,
                    slug,
                    maTienTo,
                },
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Đăng ký Dùng thử 30 ngày:');
        }
    });

    // 3. Thông tin Tenant hiện tại + Trạng thái Dùng thử 30 ngày / Bản chính thức + Checklist + Lịch sử thanh toán
    app.get('/api/saas/tenant', kiemTraToken, async (req, res) => {
        const tenantId = req.user.tenantId || 'DEFAULT';
        try {
            const [tRes, statsRes, ordersRes] = await Promise.all([
                pool.query(
                    `SELECT TenantId, MaTienTo, TenQuan, Slug, MoHinh, GoiCuoc, TrangThai,
                            TrialEndsAt, SubscriptionEndsAt, LastPaymentAt, FeatureFlags, ThoiGianTao
                       FROM Tenants WHERE TenantId = $1`,
                    [tenantId]
                ),
                pool.withTenant(tenantId, (client) =>
                    client.query(
                        `SELECT
                            (SELECT COUNT(*) FROM SanPham WHERE COALESCE(TenantId, 'DEFAULT') = $1 AND DangKinhDoanh = TRUE) AS so_mon,
                            (SELECT COUNT(*) FROM CongThuc ct JOIN SanPham sp ON sp.MaMon = ct.MaMon WHERE COALESCE(sp.TenantId, 'DEFAULT') = $1) AS so_bom,
                            (SELECT COUNT(*) FROM Ban WHERE COALESCE(TenantId, 'DEFAULT') = $1 AND DaXoa = FALSE) AS so_ban,
                            (SELECT COUNT(*) FROM NhanVien WHERE COALESCE(TenantId, 'DEFAULT') = $1 AND TrangThaiLamViec = TRUE) AS so_nv,
                            (SELECT COUNT(*) FROM HoaDon WHERE COALESCE(TenantId, 'DEFAULT') = $1 AND TrangThaiTT = 1) AS so_don_da_ban,
                            (SELECT COUNT(*) FROM HoaDon WHERE COALESCE(TenantId, 'DEFAULT') = $1
                                AND date_trunc('month', ThoiGianTao::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')
                                    = date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')) AS so_don_thang_nay,
                            (SELECT COUNT(*) FROM CaThuNgan WHERE COALESCE(TenantId, 'DEFAULT') = $1 AND TrangThaiCa = 1) AS ca_dang_mo`,
                        [tenantId]
                    )
                ),
                pool.withTenant(tenantId, (client) =>
                    client.query(
                        `SELECT MaDonThanhToan, GoiCuoc, SoThang, SoTien, TrangThai, PhuongThucTT, ThoiGianTao, ThoiGianThanhToan
                           FROM Tenant_Billing_Orders
                          WHERE TenantId = $1
                          ORDER BY ThoiGianTao DESC
                          LIMIT 20`,
                        [tenantId]
                    )
                ).catch(() => ({ rows: [] })),
            ]);

            const t = tRes.rows[0] || {
                tenantid: tenantId,
                matiento: 'DEF',
                tenquan: 'Quán Cà Phê Mặc Định',
                mohinh: 'CAFE_SAN_VUON',
                goicuoc: 'PRO',
                trangthai: 'ACTIVE',
                featureflags: PLAN_FEATURES.PRO,
            };
            const subscription = danhGiaTrangThaiGoi(t);
            const st = statsRes.rows[0] || {};
            const soMon = Number(st.so_mon || 0);
            const soBom = Number(st.so_bom || 0);
            const soBan = Number(st.so_ban || 0);
            const soNV = Number(st.so_nv || 0);
            const soDon = Number(st.so_don_da_ban || 0);
            const soDonThangNay = Number(st.so_don_thang_nay || 0);
            const caDangMo = Number(st.ca_dang_mo || 0) > 0;
            const planDefaults = PLAN_FEATURES[t.goicuoc] || PLAN_FEATURES.PRO;
            const mergedFlags = {
                ...planDefaults,
                ...(t.featureflags && typeof t.featureflags === 'object' ? t.featureflags : {}),
            };

            const checklist = [
                { id: 'menu', label: 'Thiết lập Thực đơn & Bảng giá Size', done: soMon > 0, link: '/admin/thucdon' },
                { id: 'bom', label: 'Cấu hình Công thức Định lượng (BOM)', done: soBom > 0, link: '/admin/thucdon' },
                { id: 'shift', label: 'Mở ca thu ngân sẵn sàng bán hàng', done: caDangMo || soDon > 0, link: '/pos' },
                { id: 'first_order', label: 'Hoàn tất đơn hàng đầu tiên trên POS', done: soDon > 0, link: '/pos' },
                { id: 'team', label: 'Có đội ngũ nhân viên (Thu ngân / Barista)', done: soNV >= 2, link: '/admin/nhansu' },
            ];

            res.json({
                tenant: {
                    tenantId: t.tenantid,
                    maTienTo: t.matiento,
                    tenQuan: t.tenquan,
                    slug: t.slug || 'default',
                    moHinh: t.mohinh,
                    goiCuoc: t.goicuoc,
                    trangThai: subscription.trangThai,
                    featureFlags: mergedFlags,
                    thoiGianTao: t.thoigiantao,
                    lastPaymentAt: t.lastpaymentat || null,
                    subscription,
                },
                shopLoginUrl: `/login?shop=${t.slug || 'default-cafe'}`,
                usage: { soMon, soBom, soBan, soNV, soDon, soDonThangNay },
                checklist,
                plans: PLAN_FEATURES,
                billingDiscounts: BILLING_DISCOUNT,
                billingBank: SAAS_BANK_CONFIG,
                billingHistory: ordersRes.rows.map((o) => ({
                    maDonThanhToan: o.madonthanhtoan,
                    goiCuoc: o.goicuoc,
                    soThang: Number(o.sothang),
                    soTien: Number(o.sotien),
                    trangThai: o.trangthai,
                    phuongThucTT: o.phuongthuctt,
                    thoiGianTao: o.thoigiantao,
                    thoiGianThanhToan: o.thoigianthanhtoan,
                })),
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Thông tin Tenant:');
        }
    });

    // 4. Tạo đơn thanh toán VietQR nâng cấp từ Dùng thử 30 ngày / FREE -> Bản chính thức (hoặc gia hạn)
    app.post('/api/saas/billing/create-order', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = req.user.tenantId || 'DEFAULT';
        const { goiCuoc = 'PRO', soThang = 1, extraBranches = 0, soChiNhanh, branchCount } = req.body || {};
        const planKey = String(goiCuoc || '').trim().toUpperCase();
        if (planKey === 'FREE') {
            return res.status(400).json({
                message: 'Gói FREE (0đ/tháng) không cần thanh toán! Hãy dùng nút "Chuyển sang gói FREE vĩnh viễn".',
            });
        }
        const explicitBranchCount = soChiNhanh !== undefined ? soChiNhanh : branchCount;
        const calc = tinhTienGoi(planKey, soThang, extraBranches, explicitBranchCount);
        if (!calc) {
            return res.status(400).json({ message: 'Gói cước không hợp lệ (STARTER | PRO | CHAIN | ENTERPRISE)!' });
        }
        if (calc.error === 'CHAIN_MIN_BRANCHES_REQUIRED') {
            return res.status(400).json({
                code: 'CHAIN_MIN_BRANCHES_REQUIRED',
                minBranches: calc.minBranches,
                message: `Gói ${planKey} yêu cầu đăng ký tối thiểu ${calc.minBranches} chi nhánh (499.000đ/điểm bán/tháng)!`,
            });
        }

        try {
            const maDonThanhToan = `SUB${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            const ghiChu =
                calc.branchCount > 1
                    ? `${calc.branchCount} chi nhánh (${calc.extraBranches > 0 ? `+${calc.extraBranches} CN thêm` : `tối thiểu ${calc.minBranches} CN`})`
                    : null;
            await pool.queryTenant(
                tenantId,
                `INSERT INTO Tenant_Billing_Orders (MaDonThanhToan, TenantId, GoiCuoc, SoThang, SoTien, TrangThai, PhuongThucTT, GhiChu)
                 VALUES ($1, $2, $3, $4, $5, 'PENDING', 'VIETQR', $6)`,
                [maDonThanhToan, tenantId, planKey, calc.months, calc.soTien, ghiChu]
            );

            const noiDungCK = `${maDonThanhToan} ${planKey} ${calc.months}T`;
            const vietQrUrl = `https://img.vietqr.io/image/${SAAS_BANK_CONFIG.bankId}-${SAAS_BANK_CONFIG.accountNo}-compact2.png?amount=${calc.soTien}&addInfo=${encodeURIComponent(noiDungCK)}&accountName=${encodeURIComponent(SAAS_BANK_CONFIG.accountName)}`;

            res.status(201).json({
                message: 'Đã tạo đơn thanh toán nâng cấp bản chính thức!',
                order: {
                    maDonThanhToan,
                    goiCuoc: planKey,
                    tenGoi: PLAN_FEATURES[planKey].label,
                    soThang: calc.months,
                    branchCount: calc.branchCount,
                    extraBranches: calc.extraBranches,
                    giamGiaPhanTram: Math.round(calc.discount * 100),
                    soTienGoc: calc.goc,
                    soTien: calc.soTien,
                    noiDungCK,
                    vietQrUrl,
                    bank: SAAS_BANK_CONFIG,
                    trangThai: 'PENDING',
                },
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Tạo đơn thanh toán SaaS:');
        }
    });

    // 4b. Chuyển sang gói FREE Vĩnh viễn (0đ/tháng — 350 đơn/tháng, báo cáo 7 ngày, có watermark + QR trên bill)
    app.post('/api/saas/downgrade-free', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = req.user.tenantId || 'DEFAULT';
        if (tenantId === 'DEFAULT') {
            return res.status(400).json({ message: 'Quán gốc DEFAULT luôn sử dụng bản PRO chính thức.' });
        }
        try {
            const flags = PLAN_FEATURES.FREE;
            // Kiểm tra số chi nhánh hiện có không vượt quá hạn mức gói FREE (maxBranches = 1)
            const maxFreeBranches = Number(flags.maxBranches || 1);
            try {
                const brCnt = await pool.queryTenant(
                    tenantId,
                    `SELECT COUNT(*) AS cnt FROM ChiNhanh WHERE TenantId = $1 AND COALESCE(TrangThai, 'ACTIVE') <> 'DELETED'`,
                    [tenantId]
                );
                const activeBranches = Number(brCnt.rows[0]?.cnt || 0);
                if (maxFreeBranches > 0 && activeBranches > maxFreeBranches) {
                    return res.status(409).json({
                        code: 'MAX_BRANCHES_EXCEEDED',
                        currentBranches: activeBranches,
                        maxBranches: maxFreeBranches,
                        message: `Quán hiện có ${activeBranches} chi nhánh đang hoạt động, vượt quá giới hạn gói FREE (${maxFreeBranches} chi nhánh). Vui lòng tắt bớt chi nhánh trước khi hạ gói!`,
                    });
                }
            } catch {
                // Bỏ qua nếu bảng ChiNhanh chưa khởi tạo ở môi trường cũ
            }
            await chayGiaoDich(async (client) => {
                await client.query(
                    `UPDATE Tenants
                        SET GoiCuoc = 'FREE',
                            TrangThai = 'ACTIVE',
                            FeatureFlags = $2::jsonb,
                            TrialEndsAt = NULL,
                            SubscriptionEndsAt = NULL
                      WHERE TenantId = $1`,
                    [tenantId, JSON.stringify(flags)]
                );
                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'SUBSCRIPTION_SWITCHED_FREE',
                    doiTuong: 'TENANT',
                    maDoiTuong: tenantId,
                    giaTriMoi: { goiCuoc: 'FREE', trangThai: 'ACTIVE', maxOrdersPerMonth: flags.maxOrdersPerMonth },
                    ip: req.ip,
                    batBuoc: true,
                });
            }, tenantId);

            if (typeof xoaCacheEntitlement === 'function') {
                xoaCacheEntitlement(tenantId);
            }

            const subscription = danhGiaTrangThaiGoi({
                tenantId,
                goiCuoc: 'FREE',
                trangThai: 'ACTIVE',
            });

            res.json({
                message: '✅ Đã chuyển sang gói FREE Vĩnh viễn (350 đơn/tháng, báo cáo 7 ngày). Bạn có thể bán hàng tiếp ngay lập tức!',
                goiCuoc: 'FREE',
                featureFlags: flags,
                subscription,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Chuyển gói FREE:');
        }
    });

    // 4c. Telemetry Offline Queue nhẹ từ PWA (phục vụ Churn Radar / Tenant Health Score trên SuperAdminPage)
    app.post('/api/saas/telemetry/offline-queue', kiemTraToken, async (req, res) => {
        const tenantId = req.user.tenantId || 'DEFAULT';
        const failedCount = Math.max(0, Math.min(10000, parseInt(req.body?.failedCount, 10) || 0));
        const syncedDelta = Math.max(0, Math.min(1000, parseInt(req.body?.syncedDelta, 10) || 0));
        try {
            await pool.query(
                `UPDATE Tenants
                    SET OfflineFailedCount = $2,
                        OfflineTotalSyncCount = COALESCE(OfflineTotalSyncCount, 0) + $3,
                        OfflineTelemetryAt = now()
                  WHERE TenantId = $1`,
                [tenantId, failedCount, syncedDelta]
            );
            res.json({ ok: true });
        } catch {
            // Bỏ qua êm nếu cột Migration 020 chưa được chạy
            res.json({ ok: false });
        }
    });

    // 4d. Đăng ký gói Mở rộng doanh thu (Combo Phần cứng Cắm-là-Chạy / Zalo ZNS Credits / Fintech Soundbox)
    app.post('/api/saas/expansion/inquiry', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = req.user.tenantId || 'DEFAULT';
        const loaiDichVu = String(req.body?.loaiDichVu || '').trim().toUpperCase();
        const goiQuanTam = String(req.body?.goiQuanTam || '').trim().slice(0, 120);
        const soLuong = Math.max(1, Math.min(500, parseInt(req.body?.soLuong, 10) || 1));
        const lienHe = String(req.body?.lienHe || '').trim().slice(0, 160);
        const ghiChu = String(req.body?.ghiChu || '').trim().slice(0, 400);

        const allowedTypes = ['HARDWARE_BUNDLE', 'ZALO_ZNS_CREDITS', 'FINTECH_SOUNDBOX'];
        if (!allowedTypes.includes(loaiDichVu) || !goiQuanTam) {
            return res.status(400).json({ message: 'Vui lòng chọn gói phần cứng / dịch vụ mở rộng hợp lệ!' });
        }

        try {
            let reqId = null;
            await chayGiaoDich(async (client) => {
                await client.query('SAVEPOINT sp_expansion_req');
                try {
                    const ins = await client.query(
                        `INSERT INTO Tenant_Expansion_Requests
                            (TenantId, MaNV, LoaiDichVu, GoiQuanTam, SoLuong, LienHe, GhiChu, TrangThai)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, 'NEW')
                         RETURNING Id`,
                        [tenantId, req.user.maNV, loaiDichVu, goiQuanTam, soLuong, lienHe || null, ghiChu || null]
                    );
                    reqId = ins.rows[0]?.id || null;
                    await client.query('RELEASE SAVEPOINT sp_expansion_req');
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_expansion_req');
                }
                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'EXPANSION_INQUIRY_SUBMITTED',
                    doiTuong: 'TENANT',
                    maDoiTuong: `${loaiDichVu}:${reqId || 'LOG'}`,
                    giaTriMoi: { loaiDichVu, goiQuanTam, soLuong, lienHe, ghiChu },
                    ip: req.ip,
                });
            }, tenantId);

            res.status(201).json({
                message: `🎉 Đã ghi nhận yêu cầu "${goiQuanTam}"! Chuyên viên triển khai sẽ liên hệ cài đặt & bàn giao trong vòng 2 giờ.`,
                id: reqId,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Ghi nhận yêu cầu mở rộng:');
        }
    });

    // 5. Xác nhận thanh toán & Kích hoạt Bản chính thức
    // [P0 ARCHITECTURE FIX] Đã tách hẳn quyền duyệt thủ công sang Platform Super Admin (/api/platform/billing/manual-approve).
    // Tài khoản quán (kể cả Tenant 'DEFAULT') KHÔNG còn quyền tự duyệt gói qua endpoint này (chỉ mở khi ALLOW_DEMO_BILLING_CONFIRM=true lúc QA cục bộ).
    app.post('/api/saas/billing/confirm', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const callerTenantId = req.user.tenantId || 'DEFAULT';
        const allowDemoSelfConfirm = process.env.ALLOW_DEMO_BILLING_CONFIRM === 'true';
        if (!allowDemoSelfConfirm) {
            return res.status(403).json({
                code: 'PLATFORM_ADMIN_REQUIRED',
                message: 'Đơn thanh toán gói bản quyền sẽ tự động kích hoạt qua Webhook VietQR hoặc do Platform Super Admin duyệt tại cổng /super-admin.',
            });
        }

        const { maDonThanhToan, maGiaoDichNgoai = null } = req.body || {};
        if (!maDonThanhToan) {
            return res.status(400).json({ message: 'Thiếu mã đơn thanh toán (maDonThanhToan)!' });
        }

        try {
            const result = await chayGiaoDich(async (client) => {
                const oRes = await client.query(
                    `SELECT Id, TenantId, GoiCuoc, SoThang, SoTien, TrangThai
                       FROM Tenant_Billing_Orders
                      WHERE MaDonThanhToan = $1
                        AND ($2 = 'DEFAULT' OR TenantId = $2)
                      FOR UPDATE`,
                    [maDonThanhToan, callerTenantId]
                );
                if (oRes.rows.length === 0) {
                    return { notFound: true };
                }
                const order = oRes.rows[0];
                if (order.trangthai === 'PAID') {
                    return { alreadyPaid: true, order };
                }

                const targetTenantId = order.tenantid;
                const tRes = await client.query(
                    'SELECT TenantId, MaTienTo, TenQuan, TrangThai, SubscriptionEndsAt FROM Tenants WHERE TenantId = $1 FOR UPDATE',
                    [targetTenantId]
                );
                const t = tRes.rows[0];
                const baseMs = t?.subscriptionendsat && new Date(t.subscriptionendsat).getTime() > Date.now()
                    ? new Date(t.subscriptionendsat).getTime()
                    : Date.now();
                const newEnd = new Date(baseMs + Number(order.sothang) * 30 * 86400000).toISOString();
                const flags = PLAN_FEATURES[order.goicuoc] || PLAN_FEATURES.PRO;

                await client.query(
                    `UPDATE Tenant_Billing_Orders
                        SET TrangThai = 'PAID',
                            MaGiaoDichNgoai = COALESCE($2, MaGiaoDichNgoai),
                            ThoiGianThanhToan = now()
                      WHERE Id = $1`,
                    [order.id, maGiaoDichNgoai]
                );

                await client.query(
                    `UPDATE Tenants
                        SET GoiCuoc = $2,
                            FeatureFlags = $3::jsonb,
                            TrangThai = 'ACTIVE',
                            SubscriptionEndsAt = $4::timestamptz,
                            LastPaymentAt = now()
                      WHERE TenantId = $1`,
                    [targetTenantId, order.goicuoc, JSON.stringify(flags), newEnd]
                );

                await ghiAuditLog(client, {
                    tenantId: targetTenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    nguoiDuyet: req.user.maNV,
                    hanhDong: 'SUBSCRIPTION_ACTIVATED',
                    doiTuong: 'TENANT',
                    maDoiTuong: maDonThanhToan,
                    giaTriMoi: {
                        goiCuoc: order.goicuoc,
                        soThang: Number(order.sothang),
                        soTien: Number(order.sotien),
                        subscriptionEndsAt: newEnd,
                    },
                    ip: req.ip,
                    batBuoc: true,
                });

                return {
                    alreadyPaid: false,
                    targetTenantId,
                    goiCuoc: order.goicuoc,
                    soThang: Number(order.sothang),
                    soTien: Number(order.sotien),
                    subscriptionEndsAt: newEnd,
                    subscription: danhGiaTrangThaiGoi({
                        tenantId: targetTenantId,
                        trangThai: 'ACTIVE',
                        subscriptionEndsAt: newEnd,
                    }),
                };
            }, callerTenantId);

            if (result.notFound) {
                return res.status(404).json({ message: 'Không tìm thấy đơn thanh toán!' });
            }
            if (result.alreadyPaid) {
                return res.json({ message: 'Đơn thanh toán này đã được kích hoạt trước đó!' });
            }
            if (typeof xoaCacheEntitlement === 'function') {
                xoaCacheEntitlement(result.targetTenantId);
            }

            res.json({
                message: `🎉 Đã duyệt & kích hoạt Bản chính thức gói ${result.goiCuoc} (${result.soThang} tháng) đến ${new Date(result.subscriptionEndsAt).toLocaleDateString('vi-VN')}!`,
                goiCuoc: result.goiCuoc,
                subscription: result.subscription,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Xác nhận thanh toán SaaS:');
        }
    });

    // 5b. Đã tách sang Platform Super Admin độc lập (/api/platform/billing/orders)
    app.get('/api/saas/billing/pending', kiemTraToken, choPhepVaiTro(1), (req, res) => {
        return res.status(403).json({
            code: 'PLATFORM_ADMIN_REQUIRED',
            message: 'Quản trị đơn thanh toán toàn nền tảng đã được tách sang cổng /super-admin (/api/platform/billing/orders).',
        });
    });

    // 5c. Cấu hình Ngân hàng VietQR + Khóa Webhook SePay/PayOS riêng của từng Tenant (mã hóa AES-256-GCM)
    app.get('/api/settings/bank', kiemTraToken, async (req, res) => {
        const tenantId = req.user.tenantId || 'DEFAULT';
        try {
            const r = await pool.query(
                'SELECT TenantId, Slug, TenQuan, ThongTinNganHang FROM Tenants WHERE TenantId = $1',
                [tenantId]
            );
            const row = r.rows[0] || {};
            const bank = row.thongtinnganhang || {};
            const slug = row.slug || tenantId.toLowerCase();
            res.json({
                tenantId,
                slug,
                bankId: bank.bankId || 'MB',
                accountNo: bank.accountNo || '',
                accountName: bank.accountName || row.tenquan || 'QUAN CAFE POS',
                hasSepayKey: Boolean(bank.sepay_api_key_enc),
                hasPayosKey: Boolean(bank.payos_checksum_key_enc),
                sepayWebhookPath: `/api/webhooks/sepay/${slug}`,
                payosWebhookPath: `/api/webhooks/payos/${slug}`,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Đọc cấu hình ngân hàng:');
        }
    });

    app.put('/api/settings/bank', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = req.user.tenantId || 'DEFAULT';
        const bankId = String(req.body?.bankId || 'MB').trim().toUpperCase().slice(0, 16);
        const accountNo = String(req.body?.accountNo || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 32);
        const accountName = String(req.body?.accountName || '').trim().toUpperCase().slice(0, 100);
        const rawSepayKey = req.body?.sepayApiKey;
        const rawPayosKey = req.body?.payosChecksumKey;

        if (!bankId || !accountNo) {
            return res.status(400).json({ message: 'Vui lòng nhập đầy đủ mã ngân hàng và số tài khoản!' });
        }

        try {
            const prevRes = await pool.query(
                'SELECT Slug, ThongTinNganHang FROM Tenants WHERE TenantId = $1',
                [tenantId]
            );
            const slug = prevRes.rows[0]?.slug || tenantId.toLowerCase();
            const giaTriCu = prevRes.rows[0]?.thongtinnganhang || {};

            let sepayEnc = giaTriCu.sepay_api_key_enc || null;
            if (typeof rawSepayKey === 'string') {
                const trimmed = rawSepayKey.trim();
                if (!trimmed) {
                    sepayEnc = null;
                } else if (!/^\*+$/.test(trimmed)) {
                    sepayEnc = maHoaKhoaWebhook(trimmed);
                }
            }

            let payosEnc = giaTriCu.payos_checksum_key_enc || null;
            if (typeof rawPayosKey === 'string') {
                const trimmed = rawPayosKey.trim();
                if (!trimmed) {
                    payosEnc = null;
                } else if (!/^\*+$/.test(trimmed)) {
                    payosEnc = maHoaKhoaWebhook(trimmed);
                }
            }

            const storedBank = {
                bankId,
                accountNo,
                accountName,
                ...(sepayEnc ? { sepay_api_key_enc: sepayEnc } : {}),
                ...(payosEnc ? { payos_checksum_key_enc: payosEnc } : {}),
            };

            await pool.query(
                'UPDATE Tenants SET ThongTinNganHang = $2::jsonb WHERE TenantId = $1',
                [tenantId, JSON.stringify(storedBank)]
            );
            await pool.withTenant(tenantId, async (client) => {
                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'BANK_SETTINGS_UPDATED',
                    doiTuong: 'TENANT',
                    maDoiTuong: tenantId,
                    giaTriCu: {
                        bankId: giaTriCu.bankId || null,
                        accountNo: giaTriCu.accountNo || null,
                        accountName: giaTriCu.accountName || null,
                        hasSepayKey: Boolean(giaTriCu.sepay_api_key_enc),
                        hasPayosKey: Boolean(giaTriCu.payos_checksum_key_enc),
                    },
                    giaTriMoi: {
                        bankId,
                        accountNo,
                        accountName,
                        hasSepayKey: Boolean(sepayEnc),
                        hasPayosKey: Boolean(payosEnc),
                    },
                    ip: req.ip,
                    batBuoc: true,
                });
            });
            res.json({
                message: 'Đã lưu cấu hình VietQR & khóa Webhook riêng của quán trên máy chủ!',
                bank: {
                    tenantId,
                    slug,
                    bankId,
                    accountNo,
                    accountName,
                    hasSepayKey: Boolean(sepayEnc),
                    hasPayosKey: Boolean(payosEnc),
                    sepayWebhookPath: `/api/webhooks/sepay/${slug}`,
                    payosWebhookPath: `/api/webhooks/payos/${slug}`,
                },
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Lưu cấu hình ngân hàng:');
        }
    });

    // 6. Đổi gói cước trực tiếp — Không cho phép bất kỳ quán nào tự đổi gói miễn phí (kể cả DEFAULT)
    // Muốn đổi gói: thanh toán qua VietQR (/api/saas/billing/create-order) hoặc Platform Super Admin chỉnh tại /super-admin
    app.put('/api/saas/plan', kiemTraToken, choPhepVaiTro(1), (req, res) => {
        return res.status(402).json({
            code: 'PAYMENT_REQUIRED',
            message: 'Để đổi hoặc nâng cấp gói bản quyền, vui lòng tạo đơn thanh toán VietQR chính thức (hoặc liên hệ Platform Super Admin tại /super-admin)!',
        });
    });

    // 7. Danh sách toàn bộ Tenants — Đã tách hoàn toàn sang Platform Super Admin (/api/platform/tenants)
    app.get('/api/saas/tenants', kiemTraToken, choPhepVaiTro(1), (req, res) => {
        return res.status(403).json({
            code: 'PLATFORM_ADMIN_REQUIRED',
            message: 'Danh sách toàn bộ quán đã được tách khỏi tài khoản quán DEFAULT sang cổng Platform Super Admin (/super-admin -> /api/platform/tenants).',
        });
    });

    // 8. AI Menu Importer — Bước 1: Bóc tách từ Ảnh chụp Menu giấy (Gemini Vision) hoặc Văn bản/CSV
    app.post('/api/ai/parse-menu', kiemTraToken, choPhepVaiTro(1), checkAiMenu, async (req, res) => {
        const { imageBase64, mimeType, rawText } = req.body || {};
        if (!imageBase64 && (!rawText || !String(rawText).trim())) {
            return res.status(400).json({ message: 'Vui lòng tải lên ảnh tờ menu hoặc dán danh sách món!' });
        }
        try {
            const result = await parseMenuUniversal({ imageBase64, mimeType, rawText });
            res.json(result);
        } catch (error) {
            guiLoi(res, error, 'Lỗi AI Menu Parser:');
        }
    });

    // 9. AI Menu Importer — Bước 2: Nhập hàng loạt món đã rà soát vào CSDL (ACID, scoped theo TenantId)
    app.post('/api/ai/import-menu', kiemTraToken, choPhepVaiTro(1), checkAiMenu, async (req, res) => {
        const { items } = req.body || {};
        const tenantId = req.user.tenantId || 'DEFAULT';
        const prefix = req.user.maTienTo && tenantId !== 'DEFAULT' ? `${req.user.maTienTo}_` : '';

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ message: 'Danh sách món cần nhập không được trống!' });
        }

        const normalized = chuanHoaDanhSachMon(items).slice(0, 100);
        if (normalized.length === 0) {
            return res.status(400).json({ message: 'Không có món hợp lệ nào để nhập!' });
        }

        try {
            const imported = await chayGiaoDich(async (client) => {
                let count = 0;
                for (const item of normalized) {
                    const maMon = item.maMon.startsWith(prefix) ? item.maMon : `${prefix}${item.maMon}`;
                    await client.query(
                        `INSERT INTO SanPham (MaMon, TenMon, NhomMon, GiaGoc, DangKinhDoanh, TamHet, TenantId)
                         VALUES ($1, $2, $3, $4, TRUE, FALSE, $5)
                         ON CONFLICT (MaMon) DO UPDATE
                           SET TenMon = EXCLUDED.TenMon,
                               NhomMon = EXCLUDED.NhomMon,
                               GiaGoc = EXCLUDED.GiaGoc,
                               DangKinhDoanh = TRUE
                         WHERE SanPham.TenantId = $5`,
                        [maMon, item.tenMon, item.nhomMon, item.giaS, tenantId]
                    );
                    await client.query('DELETE FROM SanPham_Size WHERE MaMon = $1', [maMon]);
                    for (const [sz, gia] of [['S', item.giaS], ['M', item.giaM], ['L', item.giaL]]) {
                        await client.query(
                            'INSERT INTO SanPham_Size (MaMon, KichThuoc, GiaBan) VALUES ($1, $2, $3)',
                            [maMon, sz, gia]
                        );
                    }
                    count += 1;
                }

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'AI_MENU_IMPORTED',
                    doiTuong: 'SANPHAM',
                    maDoiTuong: `${count}_ITEMS`,
                    giaTriMoi: { soMonNhap: count },
                    ip: req.ip,
                });
                return count;
            }, tenantId);

            res.status(201).json({
                message: `✨ Đã nhập thành công ${imported} món vào thực đơn quán!`,
                importedCount: imported,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Nhập thực đơn AI:');
        }
    });

    // [Wave 3B — P1-05] Migration Toolkit 1 phút: Nhập thực đơn từ CSV / Excel xuất từ KiotViet hoặc Sapo
    app.post('/api/saas/import-menu-sheet', kiemTraToken, choPhepVaiTro(1), checkAiMenu, async (req, res) => {
        const tenantId = layTenantId(req);
        const { rows = null, csvText = null } = req.body || {};
        if (!Array.isArray(rows) && !String(csvText || '').trim()) {
            return res.status(400).json({ message: 'Vui lòng cung cấp danh sách dòng (rows) hoặc nội dung CSV (csvText)!' });
        }

        const parsed = parseMenuSheetRows({ rows, csvText });
        if (parsed.items.length === 0 && parsed.errors.length > 0) {
            return res.status(400).json({
                message: 'Không đọc được món hợp lệ nào từ file bảng tính!',
                imported: 0,
                skipped: parsed.skipped,
                errors: parsed.errors,
                detectedSource: parsed.detectedSource,
            });
        }

        try {
            const summary = await chayGiaoDich(async (client) => {
                let imported = 0;
                let skipped = parsed.skipped;
                const errors = [...parsed.errors];
                const prefix = tenantId === 'DEFAULT' ? 'IMP' : `${tenantId.slice(-4).toUpperCase()}I`;

                for (let i = 0; i < parsed.items.length; i++) {
                    const item = parsed.items[i];
                    try {
                        const maMon = item.maMon
                            ? `${tenantId === 'DEFAULT' ? '' : `${tenantId.slice(-4).toUpperCase()}_`}${item.maMon}`.slice(0, 32)
                            : `${prefix}_${Date.now().toString(36).toUpperCase().slice(-4)}_${i + 1}`;

                        await client.query(
                            `INSERT INTO SanPham (MaMon, TenMon, NhomMon, GiaGoc, DangKinhDoanh, TamHet, TenantId)
                             VALUES ($1, $2, $3, $4, TRUE, FALSE, $5)
                             ON CONFLICT (MaMon) DO UPDATE
                               SET TenMon = EXCLUDED.TenMon,
                                   NhomMon = EXCLUDED.NhomMon,
                                   GiaGoc = EXCLUDED.GiaGoc,
                                   DangKinhDoanh = TRUE
                             WHERE SanPham.TenantId = $5`,
                            [maMon, item.tenMon, item.nhomMon, item.giaBan, tenantId]
                        );

                        const sizeCode = ['S', 'M', 'L'].includes(item.size) ? item.size : 'M';
                        await client.query(
                            `INSERT INTO SanPham_Size (MaMon, KichThuoc, GiaBan)
                             VALUES ($1, $2, $3)
                             ON CONFLICT (MaMon, KichThuoc) DO UPDATE
                               SET GiaBan = EXCLUDED.GiaBan`,
                            [maMon, sizeCode, item.giaBan]
                        );
                        imported += 1;
                    } catch (rowErr) {
                        skipped += 1;
                        errors.push({ row: item.rowIndex, reason: rowErr.message });
                    }
                }

                if (ghiAuditLog) {
                    await ghiAuditLog(client, {
                        tenantId,
                        maNV: req.user.maNV,
                        vaiTro: req.user.vaiTro,
                        hanhDong: 'MENU_SHEET_IMPORTED',
                        doiTuong: 'SANPHAM',
                        maDoiTuong: `${imported}_ITEMS`,
                        giaTriMoi: { imported, skipped, detectedSource: parsed.detectedSource },
                        ip: req.ip,
                    });
                }

                return { imported, skipped, errors };
            }, tenantId);

            res.status(201).json({
                message: `📥 Đã nhập thành công ${summary.imported} món từ ${parsed.detectedSource}!`,
                detectedSource: parsed.detectedSource,
                imported: summary.imported,
                skipped: summary.skipped,
                errors: summary.errors,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Import thực đơn KiotViet/Sapo:');
        }
    });

    // [Wave 3B — P1-05] Chạy quét Dunning nhắc gia hạn (D-7, D-3, D-1, EXPIRED) & Tenant Health Score
    // [Batch 1 Vá P0-09] Thay choPhepVaiTro(1) bằng kiemTraPlatformAdmin để bảo vệ tuyệt đối dữ liệu, chặn rò rỉ chéo tenant
    const authDunning = kiemTraPlatformAdmin || ((req, res) => res.status(403).json({ message: 'Chỉ Platform Super Admin mới có quyền chạy Dunning!' }));
    app.post('/api/saas/dunning/run', authDunning, async (req, res) => {
        try {
            const report = await runDunningCheck(pool, { platformPool: pool.platformPool || pool });
            res.json(report);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Chạy Dunning Check:');
        }
    });
}

// Tự động kích hoạt gói bản quyền chính thức khi Webhook SePay/PayOS báo nhận đúng số tiền & mã đơn SUB...
async function xuLyThanhToanGoiTuWebhook(client, { noiDungCK, soTien, maGiaoDichNgoai, nhaCungCap, ghiAuditLog, ip }) {
    const raw = String(noiDungCK || '').toUpperCase();
    const match = raw.match(/\b(SUB[A-Z0-9]{6,16})\b/);
    if (!match) return null;
    const maDon = match[1];

    // [P0 FIX NOBYPASSRLS] Tra cứu TenantId của đơn gói cước bằng hàm SECURITY DEFINER trước khi vào bảng RLS
    let preOrder = null;
    await client.query('SAVEPOINT sp_lookup_billing_order');
    try {
        const preRes = await client.query('SELECT * FROM public.fn_lookup_billing_order($1)', [maDon]);
        await client.query('RELEASE SAVEPOINT sp_lookup_billing_order');
        preOrder = preRes.rows[0] || null;
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_lookup_billing_order').catch(() => {});
    }
    if (preOrder?.tenantid) {
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [String(preOrder.tenantid)]);
    }

    const oRes = await client.query(
        `SELECT Id, TenantId, GoiCuoc, SoThang, SoTien, TrangThai
           FROM Tenant_Billing_Orders
          WHERE MaDonThanhToan = $1
          FOR UPDATE`,
        [maDon]
    );
    if (oRes.rows.length === 0) return null;
    const order = oRes.rows[0];
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [String(order.tenantid)]);
    if (order.trangthai === 'PAID') return { matched: true, alreadyPaid: true, maDon, tenantId: order.tenantid };
    if (Number(soTien) + 0.01 < Number(order.sotien)) {
        return { matched: true, insufficient: true, maDon, tenantId: order.tenantid, expected: Number(order.sotien), received: Number(soTien) };
    }

    const tRes = await client.query(
        'SELECT SubscriptionEndsAt FROM Tenants WHERE TenantId = $1 FOR UPDATE',
        [order.tenantid]
    );
    const baseMs = tRes.rows[0]?.subscriptionendsat && new Date(tRes.rows[0].subscriptionendsat).getTime() > Date.now()
        ? new Date(tRes.rows[0].subscriptionendsat).getTime()
        : Date.now();
    const newEnd = new Date(baseMs + Number(order.sothang) * 30 * 86400000).toISOString();
    const flags = PLAN_FEATURES[order.goicuoc] || PLAN_FEATURES.PRO;

    await client.query(
        `UPDATE Tenant_Billing_Orders
            SET TrangThai = 'PAID', MaGiaoDichNgoai = $2, ThoiGianThanhToan = now()
          WHERE Id = $1`,
        [order.id, maGiaoDichNgoai]
    );
    await client.query(
        `UPDATE Tenants
            SET GoiCuoc = $2, FeatureFlags = $3::jsonb, TrangThai = 'ACTIVE',
                SubscriptionEndsAt = $4::timestamptz, LastPaymentAt = now()
          WHERE TenantId = $1`,
        [order.tenantid, order.goicuoc, JSON.stringify(flags), newEnd]
    );
    if (ghiAuditLog) {
        await ghiAuditLog(client, {
            tenantId: order.tenantid,
            maNV: 'VIETQR_BOT',
            nguoiDuyet: nhaCungCap,
            hanhDong: 'SUBSCRIPTION_ACTIVATED',
            doiTuong: 'TENANT',
            maDoiTuong: maDon,
            giaTriMoi: { goiCuoc: order.goicuoc, soThang: Number(order.sothang), soTien: Number(soTien), subscriptionEndsAt: newEnd },
            ip,
            batBuoc: true,
        });
    }
    return { matched: true, activated: true, maDon, tenantId: order.tenantid, goiCuoc: order.goicuoc, subscriptionEndsAt: newEnd };
}

// ==========================================
// MÃ HÓA AES-256-GCM CHO KHÓA WEBHOOK SEPAY / PAYOS RIÊNG CỦA TỪNG TENANT
// ==========================================
function layKhoaMaHoaAes256() {
    const rawKey = String(process.env.DATA_ENCRYPTION_KEY || process.env.JWT_SECRET || 'cafe_pos_default_enc_key');
    return crypto.createHash('sha256').update(rawKey, 'utf8').digest();
}

function maHoaKhoaWebhook(plainText) {
    const text = String(plainText || '').trim();
    if (!text) return null;
    const key = layKhoaMaHoaAes256();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function giaiMaKhoaWebhook(cipherText) {
    const raw = String(cipherText || '').trim();
    if (!raw) return null;
    if (!raw.startsWith('enc:v1:')) return raw;
    try {
        const [, , ivHex, tagHex, dataHex] = raw.split(':');
        if (!ivHex || !tagHex || !dataHex) return null;
        const key = layKhoaMaHoaAes256();
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
        return decrypted.toString('utf8');
    } catch {
        return null;
    }
}

async function timTenantWebhookConfig(pool, slugOrId) {
    const clean = String(slugOrId || '').trim();
    if (!clean) return null;
    let row = null;
    try {
        const r = await pool.query('SELECT * FROM public.fn_lookup_tenant_webhook_config($1)', [clean]);
        row = r.rows[0] || null;
    } catch {
        const r = await pool.query(
            `SELECT TenantId, Slug, MaTienTo, TenQuan, COALESCE(ThongTinNganHang, '{}'::jsonb) AS ThongTinNganHang
               FROM Tenants
              WHERE LOWER(COALESCE(Slug, '')) = LOWER($1)
                 OR UPPER(TenantId) = UPPER($1)
                 OR UPPER(COALESCE(MaTienTo, '')) = UPPER($1)
              LIMIT 1`,
            [clean]
        );
        row = r.rows[0] || null;
    }
    if (!row) return null;
    const bank = row.thongtinnganhang || {};
    return {
        tenantId: row.tenantid,
        slug: row.slug || row.tenantid,
        maTienTo: row.matiento || 'DEF',
        tenQuan: row.tenquan || '',
        bankId: bank.bankId || '',
        accountNo: bank.accountNo || '',
        accountName: bank.accountName || '',
        sepayApiKey: bank.sepay_api_key_enc ? giaiMaKhoaWebhook(bank.sepay_api_key_enc) : null,
        payosChecksumKey: bank.payos_checksum_key_enc ? giaiMaKhoaWebhook(bank.payos_checksum_key_enc) : null,
    };
}

// ==========================================
// [Wave 3B — P1-05] MIGRATION TOOLKIT PARSER (KIOTVIET & SAPO) + DUNNING CRON
// ==========================================
function normalizeHeaderKey(key) {
    return String(key || '')
        .replace(/^\uFEFF/, '')
        .replace(/[đĐ]/g, 'd')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function parseCsvLine(line, delimiter = ',') {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === delimiter && !inQuotes) {
            out.push(cur.trim());
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur.trim());
    return out;
}

function parseCsvToRows(csvText) {
    const lines = String(csvText || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .filter((l) => l.trim().length > 0);
    if (lines.length < 2) return [];
    const headerLine = lines[0];
    const delimiter = (headerLine.match(/;/g) || []).length > (headerLine.match(/,/g) || []).length ? ';' : ',';
    const headers = parseCsvLine(headerLine, delimiter);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i], delimiter);
        const obj = {};
        for (let c = 0; c < headers.length; c++) {
            obj[headers[c]] = cols[c] ?? '';
        }
        rows.push(obj);
    }
    return rows;
}

function parseMoneyNumber(val) {
    if (typeof val === 'number' && Number.isFinite(val)) return Math.round(val);
    const cleaned = String(val || '').replace(/[^\d.-]/g, '');
    const num = Number(cleaned);
    return Number.isFinite(num) ? Math.round(num) : NaN;
}

function parseMenuSheetRows({ rows = null, csvText = null } = {}) {
    const rawRows = Array.isArray(rows) ? rows : parseCsvToRows(csvText);
    const items = [];
    const errors = [];
    let skipped = 0;
    let detectedSource = 'GENERIC';

    if (rawRows.length === 0) {
        return { detectedSource, items, skipped: 0, errors: [{ row: 0, reason: 'Không có dữ liệu dòng nào trong bảng tính' }] };
    }

    const sampleKeys = Object.keys(rawRows[0] || {}).map(normalizeHeaderKey);
    if (sampleKeys.some((k) => k.includes('ma hang') || k.includes('ten hang') || k.includes('nhom hang 3 cap'))) {
        detectedSource = 'KIOTVIET';
    } else if (sampleKeys.some((k) => k.includes('ten san pham') || k.includes('ma sku') || k.includes('ten phien ban') || k.includes('sapo'))) {
        detectedSource = 'SAPO';
    }

    const pickField = (row, aliases) => {
        for (const [k, v] of Object.entries(row || {})) {
            const nk = normalizeHeaderKey(k);
            if (aliases.some((a) => nk === a || nk.includes(a))) {
                if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
            }
        }
        return '';
    };

    rawRows.forEach((row, idx) => {
        const rowIndex = idx + 2;
        const tenMon = pickField(row, ['ten hang', 'ten mon', 'ten san pham', 'product name', 'name']);
        const nhomMon = pickField(row, ['nhom hang', 'nhom mon', 'danh muc', 'loai san pham', 'category']) || 'Đồ uống';
        const giaStr = pickField(row, ['gia ban', 'don gia', 'gia', 'price', 'gia niem yet']);
        const maMonRaw = pickField(row, ['ma hang', 'ma mon', 'ma sku', 'sku', 'code']);
        const sizeRaw = pickField(row, ['size', 'kich thuoc', 'ten phien ban', 'dvt', 'don vi tinh']);

        if (!tenMon) {
            skipped += 1;
            errors.push({ row: rowIndex, reason: 'Thiếu tên món/tên hàng' });
            return;
        }
        const giaBan = parseMoneyNumber(giaStr);
        if (!Number.isFinite(giaBan) || giaBan < 0) {
            skipped += 1;
            errors.push({ row: rowIndex, reason: `Giá bán không hợp lệ ("${giaStr}") cho món "${tenMon}"` });
            return;
        }

        const sizeUpper = sizeRaw.toUpperCase();
        let size = 'M';
        if (['S', 'SMALL', 'NHO', 'NHỎ'].includes(sizeUpper)) size = 'S';
        else if (['L', 'LARGE', 'LON', 'LỚN'].includes(sizeUpper)) size = 'L';
        else if (['M', 'MEDIUM', 'VUA', 'VỪA'].includes(sizeUpper)) size = 'M';

        const maMonClean = maMonRaw
            ? maMonRaw.replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase().slice(0, 24)
            : '';

        items.push({
            rowIndex,
            maMon: maMonClean || null,
            tenMon: tenMon.slice(0, 120),
            nhomMon: nhomMon.slice(0, 80),
            giaBan,
            size,
        });
    });

    return { detectedSource, items, skipped, errors };
}

/**
 * [Wave 3B — P1-05] Dunning Cron & Tenant Health Score:
 * - Quét các tenant sắp hết hạn ở mốc D-7, D-3, D-1, EXPIRED
 * - Ghi nhận idempotent vào public.tenant_dunning_logs (UNIQUE (tenant_id, stage, subscription_ends_at))
 * - Gắn cờ rủi ro rời bỏ (churnRisk = true) khi số đơn 3 ngày giảm > 50% so với trung bình 3 ngày tuần trước
 */
async function runDunningCheck(pool, { nowMs = Date.now(), platformPool = null } = {}) {
    const adminPool = platformPool || pool.platformPool || pool;
    const res = await adminPool.query('SELECT * FROM public.fn_platform_overview_tenants()');
    const tenants = res.rows || [];
    const logged = [];
    const skippedDuplicate = [];
    const churnRiskTenants = [];

    for (const t of tenants) {
        const tenantId = t.tenantid;
        if (!tenantId || tenantId === 'DEFAULT') continue;
        const goiCuoc = String(t.goicuoc || '').toUpperCase();
        const trangThai = String(t.trangthai || '').toUpperCase();

        // Tính Tenant Health Score: cảnh báo khi đơn 3 ngày giảm > 50% so với nhịp trung bình 3 ngày trước đó
        const orders3d = Number(t.so_don_3_ngay || 0);
        const ordersPrev7d = Number(t.so_don_7_14_ngay || 0);
        const baseline3d = (ordersPrev7d / 7) * 3;
        const dropPct = baseline3d >= 3 ? Math.round(((baseline3d - orders3d) / baseline3d) * 100) : 0;
        const churnRisk = baseline3d >= 3 && orders3d < baseline3d * 0.5;
        if (churnRisk) {
            churnRiskTenants.push({
                tenantId,
                tenQuan: t.tenquan,
                orders3d,
                baseline3d: Math.round(baseline3d * 10) / 10,
                dropPct,
            });
        }

        if (goiCuoc === 'FREE' && trangThai === 'ACTIVE') continue;
        const endsAtRaw = t.subscriptionendsat || t.trialendsat;
        if (!endsAtRaw) continue;

        const endsAtMs = new Date(endsAtRaw).getTime();
        if (!Number.isFinite(endsAtMs)) continue;

        const daysLeft = Math.ceil((endsAtMs - nowMs) / 86400000);
        let stage = null;
        if (daysLeft <= 0) stage = 'EXPIRED';
        else if (daysLeft <= 1) stage = 'D-1';
        else if (daysLeft <= 3) stage = 'D-3';
        else if (daysLeft <= 7) stage = 'D-7';

        if (!stage) continue;

        const insertedId = await pool.withTenant(tenantId, async (client) => {
            const ins = await client.query(
                `INSERT INTO public.tenant_dunning_logs (tenant_id, stage, subscription_ends_at)
                 VALUES ($1, $2, $3::timestamptz)
                 ON CONFLICT (tenant_id, stage, subscription_ends_at) DO NOTHING
                 RETURNING id`,
                [tenantId, stage, new Date(endsAtMs).toISOString()]
            );
            return ins.rows[0]?.id || null;
        });

        if (insertedId) {
            logged.push({ id: Number(insertedId), tenantId, stage, daysLeft, subscriptionEndsAt: new Date(endsAtMs).toISOString() });
        } else {
            skippedDuplicate.push({ tenantId, stage, daysLeft });
        }
    }

    return {
        checkedTenants: tenants.length,
        logged,
        skippedDuplicate,
        churnRiskTenants,
        checkedAt: new Date(nowMs).toISOString(),
    };
}

module.exports = {
    TRIAL_DAYS,
    BILLING_DISCOUNT,
    SAAS_BANK_CONFIG,
    tinhTienGoi,
    danhGiaTrangThaiGoi,
    khoiTaoMultiTenantSaaS,
    kiemTraMultiTenantSanSang,
    taoMiddlewareKiemTraHanSuDung,
    xuLyThanhToanGoiTuWebhook,
    registerSaasRoutes,
    createRegisterRateLimiter,
    maHoaKhoaWebhook,
    giaiMaKhoaWebhook,
    timTenantWebhookConfig,
    parseMenuSheetRows,
    runDunningCheck,
    isMultiTenantReady: () => multiTenantSanSang,
};
