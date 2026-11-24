const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();
const pool = require('./db');
const crypto = require('crypto');
const { kiemTraCauHinh } = require('./config');
const { hashPassword, verifyPassword } = require('./password');
const {
    khoiTaoMultiTenantSaaS,
    registerSaasRoutes,
    danhGiaTrangThaiGoi,
    taoMiddlewareKiemTraHanSuDung,
    xuLyThanhToanGoiTuWebhook,
    timTenantWebhookConfig,
} = require('./modules/saasRoutes');
const {
    khoiTaoPlatformAdmins,
    registerPlatformAdminRoutes,
    taoMiddlewareTinhNang,
    taoMiddlewareHanMucDonThang,
    layEntitlementTenant,
    xoaCacheEntitlement,
} = require('./modules/platformAdminRoutes');
const {
    khoiTaoCanhBaoGianLan,
    dispatchFraudAlertFromAudit,
    kiemTraCanhBaoTanSuatGianLan,
    registerFraudAlertRoutes,
} = require('./modules/fraudAlertService');
const {
    khoiTaoKhuyenMaiSchema,
    kiemTraHopLeKhuyenMai,
    tinhUuDaiVaDiemTrongGiaoDich,
    registerPromotionAndPinRoutes,
} = require('./modules/promotionAndPinService');
const {
    tinhGiaToppingBacThang,
    danhGiaModifiersChoMon,
    tinhBomMotLySauSubstitution,
    phanBoGiaComboProRata,
    chiaDeuTienVND,
    tinhTongKeToanHoaDon,
    capSoThuTuNgayKhongTrung,
    kiemTraVaTangVersionHoaDon,
    recalculateInvoiceTotals,
    phaVoComboKhiHuyMon,
    taoComboGroupUid,
} = require('./modules/fohEngineService');
const { registerFohPhase1Routes } = require('./modules/fohPhase1Routes');
const {
    VALID_STATIONS,
    normalizeBranchId,
    normalizeStation,
    roomBranchPos,
    roomBranchKds,
    roomBranchExpo,
    roomBranchWaiter,
    roomBranchQr,
    insertKdsEventLog,
    emitScopedKdsEvent,
    recordAndEmitOrderNewByStation,
    acquireIdempotencyLock,
    completeIdempotencyLock,
    failIdempotencyLock,
    cascadeIngredient86,
    autoUn86OnRestock,
    loadBranchAvailability86Map,
} = require('./modules/kdsPhase2Engine');
const { registerKdsPhase2Routes } = require('./modules/kdsPhase2Routes');
const {
    DEFAULT_SHIFT_POLICY,
    normalizeBranchForShift,
    normalizeTerminalId,
    computeDenominationTotal,
    getTenantShiftPolicy,
    nextAtomicZReportNumber,
    computePreCloseChecklist,
    buildImmutableZReportSnapshot,
} = require('./modules/paymentShiftPhase3Engine');
const { registerPaymentShiftPhase3Routes } = require('./modules/paymentShiftPhase3Routes');
const {
    WASTAGE_TAXONOMY,
    VALID_WASTAGE_CODES,
    lam4,
    lam2,
    normalizeInventoryBranch,
    todayDateVN,
    ensureBranchRecord,
    computeSafeWacOnStockIn,
    recordCogsAdjustment,
    allocateLandedCost,
    lockBranchStockOrdered,
    updateBranchStockRow,
    insertLedgerLine,
    assertPeriodNotLocked,
    createFefoLot,
    consumeFefoBatches,
    detectSubRecipeCycle,
    lookupHistoricalWac,
    detectPriceSpikeAndMarginImpact,
} = require('./modules/inventoryCogsPhase4Engine');
const { registerInventoryCogsPhase4Routes } = require('./modules/inventoryCogsPhase4Routes');
const {
    tinhHangThanhVien,
    xoayQrTokenChoCacBan,
    capNhatCrmVaZnsSauThanhToan,
    layBanDoGiamGiaLoBanhHomNay,
    registerEcosystemPhase8Routes,
} = require('./modules/ecosystemPhase8Routes');
const {
    applyMixedRateTaxToOrder,
    createAdjustmentDecreaseOnRefund,
    maskPhoneForRole,
} = require('./modules/vnTaxAndEInvoiceService');
const { registerEInvoiceRoutes } = require('./modules/einvoiceRoutes');
const {
    kiemTraToken,
    kiemTraNhanVienConHoatDong,
    xoaCacheTrangThaiNV,
    gioiHanDangNhap,
    ghiNhanDangNhapSai,
    xoaDangNhapSai,
    JWT_VERIFY_OPTIONS,
    ACCESS_TOKEN_TTL,
    REFRESH_TTL_STANDARD_DAYS,
    REFRESH_TTL_DEVICE_DAYS,
    getRefreshCookie,
    setRefreshCookie,
    clearRefreshCookie,
    generateRefreshToken,
    hashRefreshToken,
} = require('./middleware');
const {
    logger,
    requestContextMiddleware,
    captureException,
    getObservabilitySnapshot,
} = require('./modules/observability');
const {
    attachSocketIoRedisAdapter,
    getRedisStatus,
    closeRedisClients,
} = require('./modules/redisCluster');

kiemTraCauHinh(); // dừng ngay nếu thiếu/yếu JWT_SECRET hoặc thiếu DATABASE_URL

const app = express();
// Chạy sau proxy (Render...): đặt TRUST_PROXY=1 để req.ip là IP khách thật (giới hạn đăng nhập sai dựa vào đây)
if (process.env.TRUST_PROXY) {
    const v = process.env.TRUST_PROXY;
    app.set('trust proxy', /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v);
}
const server = http.createServer(app);
const allowedOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const isProdEnv = process.env.NODE_ENV === 'production';
if (isProdEnv && allowedOrigins.length === 0) {
    console.warn('⚠️ [SECURITY] NODE_ENV=production nhưng chưa cấu hình FRONTEND_URL — CORS sẽ từ chối mọi cross-origin request!');
}
const isLocalDevOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin || '');
const corsOrigin = isProdEnv
    ? (origin, callback) => {
          // Production: bắt buộc khớp FRONTEND_URL, TẮT hoàn toàn isLocalDevOrigin!
          if (!origin || allowedOrigins.includes(origin)) {
              return callback(null, true);
          }
          return callback(new Error(`Origin ${origin} không được phép bởi CORS Production`));
      }
    : allowedOrigins.length
    ? (origin, callback) => {
          if (!origin || allowedOrigins.includes(origin) || (process.env.STRICT_CORS !== 'true' && isLocalDevOrigin(origin))) {
              return callback(null, true);
          }
          return callback(new Error(`Origin ${origin} không được phép bởi CORS`));
      }
    : true; // Dev mode: phản hồi đúng Origin yêu cầu để hỗ trợ HttpOnly Cookie (credentials: true)

const io = new Server(server, {
    cors: { origin: corsOrigin, credentials: true },
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000, // Khôi phục gói tin rớt mạng trong 2 phút
        skipMiddlewares: false,
    },
});
const kiemTraHanSuDung = taoMiddlewareKiemTraHanSuDung(pool);
const yeuCauTinhNang = taoMiddlewareTinhNang(pool);
const kiemTraHanMucDonThang = taoMiddlewareHanMucDonThang(pool);

// [Wave 2 — P0-06] Trạng thái Graceful Shutdown & đếm in-flight request
let isShuttingDown = false;
let inFlightRequests = 0;

app.use((req, res, next) => {
    if (req.path === '/api/ready' || req.path === '/api/health') return next();
    if (isShuttingDown) {
        res.setHeader('Connection', 'close');
        return res.status(503).json({ status: 'DRAINING', message: 'Hệ thống đang bảo trì/khởi động lại, vui lòng thử lại sau vài giây.' });
    }
    inFlightRequests += 1;
    let decremented = false;
    const done = () => {
        if (!decremented) {
            decremented = true;
            inFlightRequests = Math.max(0, inFlightRequests - 1);
        }
    };
    res.on('finish', done);
    res.on('close', done);
    next();
});

app.use(requestContextMiddleware);
// [Wave 1 — P0-04] Security Headers bắt buộc
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (isProdEnv || req.secure || req.headers['x-forwarded-proto'] === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});
app.use(cors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Token', 'Idempotency-Key', 'X-Offline-Sync', 'X-Request-Id', 'X-Device-Id'],
    exposedHeaders: ['X-Request-Id'],
}));
// Chỉ mở body limit 8mb riêng cho /api/ai/parse-menu; toàn cục siết còn 512kb chống Memory DoS
app.use('/api/ai/parse-menu', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '512kb' }));

// ==========================================
// [v2] TIỆN ÍCH DÙNG CHUNG & MA TRẬN PHÂN QUYỀN CHI TIẾT (GRANULAR RBAC)
// ==========================================
const TEN_VAI_TRO = { 1: 'Quản lý', 2: 'Pha chế', 3: 'Phục vụ', 4: 'Thu ngân' };
const SHIFT_SUPERVISOR_PERMS = [
    'order.item.void_approve',
    'order.refund.approve',
    'shift.cash_payout.approve',
    'inventory.stocktake',
];

function coQuyenHan(user, permissionKey) {
    if (!user) return false;
    const perms =
        user.permissionsOverride && typeof user.permissionsOverride === 'object'
            ? user.permissionsOverride
            : {};
    if (perms[permissionKey] !== undefined) {
        return Boolean(perms[permissionKey]);
    }
    if (Number(user.vaiTro) === 1) return true;
    if (Boolean(perms.isShiftSupervisor) && SHIFT_SUPERVISOR_PERMS.includes(permissionKey)) {
        return true;
    }
    return false;
}
const SIZE_HOP_LE = ['S', 'M', 'L'];
const TRAM_CHE_BIEN_HOP_LE = ['BAR_CHINH', 'BAR_LANH', 'BEP_BANH'];

function suyLuanTramCheBien({ tramCheBien, nhomMon = '', tenMon = '' } = {}) {
    const clean = String(tramCheBien || '').trim().toUpperCase();
    // [Wave 3A — P1-03] Tôn trọng mọi trạm hợp lệ đã cấu hình rõ (bao gồm cả 'BAR_CHINH'), không ép nhảy trạm bằng regex!
    if (TRAM_CHE_BIEN_HOP_LE.includes(clean)) {
        return clean;
    }
    const text = `${nhomMon || ''} ${tenMon || ''}`.toLowerCase();
    if (/(bánh|bếp|snack|ăn vặt|đồ ăn|croissant|tiramisu|toast|mousse|cookie)/i.test(text)) {
        return 'BEP_BANH';
    }
    if (/(trà|đá xay|sinh tố|nước ép|matcha|freeze|soda|yogurt)/i.test(text)) {
        return 'BAR_LANH';
    }
    return 'BAR_CHINH';
}
const PHUONG_THUC_TT = ['TIEN_MAT', 'CHUYEN_KHOAN', 'THE', 'VOUCHER', 'VI_KHACH', 'VI_DIEN_TU', 'SAN_GIAO_HANG'];
const PHUONG_THUC_LEGACY = ['TIEN_MAT', 'CHUYEN_KHOAN', 'THE'];
const LOAI_GD_TIEU_HAO = 6; // PhieuGiaoDichKho.LoaiGD = 6: tiêu hao nguyên liệu do bán hàng
const LOAI_GD_HOAN_KHO = 7; // PhieuGiaoDichKho.LoaiGD = 7: hoàn kho do hủy món chưa pha chế
const LOAI_GD_HAO_HUT_HUY_MON = 8; // PhieuGiaoDichKho.LoaiGD = 8: hao hụt do hủy món đã pha (không cộng dồn trùng với LoaiGD=6)
const VN_TZ = 'Asia/Ho_Chi_Minh';
const ALLOW_NEGATIVE_STOCK = process.env.ALLOW_NEGATIVE_STOCK !== 'false'; // Mặc định cho phép bán khi chưa kịp nhập kho, kèm cảnh báo
const DIEM_MOI_VND = 10000; // 10.000đ = 1 điểm tích lũy
const CASH_PAYOUT_LIMIT_VND = Math.max(0, Number(process.env.CASH_PAYOUT_LIMIT_VND || 50000)); // Ngưỡng phiếu chi Thu ngân tự lập (vượt ngưỡng cần Quản lý)

const ngayHomNayVN = () => new Intl.DateTimeFormat('en-CA', { timeZone: VN_TZ }).format(new Date());

// Lỗi nghiệp vụ: ném ra trong handler/transaction, guiLoi() sẽ trả về đúng status
class LoiNghiepVu extends Error {
    constructor(status, message, chiTiet = {}) {
        super(message);
        this.status = status;
        this.chiTiet = chiTiet;
    }
}

function guiLoi(res, error, tieuDe) {
    if (error instanceof LoiNghiepVu) {
        return res.status(error.status).json({ message: error.message, ...error.chiTiet });
    }
    console.error(tieuDe, error);
    return res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
}

// Dùng sau kiemTraToken: choPhepVaiTro(1, 4)
const choPhepVaiTro = (...dsVaiTro) => (req, res, next) => {
    if (dsVaiTro.includes(req.user.vaiTro)) return next();
    const ten = dsVaiTro.map((v) => TEN_VAI_TRO[v]).join(', ');
    return res.status(403).json({ message: `Từ chối truy cập! Chức năng này chỉ dành cho: ${ten}.` });
};

const layTenantId = (req) => String(req?.user?.tenantId || 'DEFAULT');
const qTenant = (req, sql, params = []) => pool.queryTenant(layTenantId(req), sql, params);
const roomTen = (tenantId, role) => `t:${tenantId || 'DEFAULT'}:${role}`;

async function chayGiaoDich(fn, tenantId = null) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (tenantId) {
            // Kích hoạt PostgreSQL Row-Level Security (RLS) cho toàn bộ transaction hiện tại
            await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [String(tenantId)]);
        }
        const ketQua = await fn(client);
        await client.query('COMMIT');
        return ketQua;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

const lam3 = (x) => Math.round(x * 1000) / 1000; // khớp NUMERIC(18,3) của kho

// ---- Idempotency cho POST /api/order --------------------------------------------
// Client gửi header Idempotency-Key (UUID). Gửi lại cùng key + cùng nội dung => trả lại kết quả cũ,
// KHÔNG tạo thêm dòng món / không trừ kho lần nữa.
const IDEM_REGEX = /^[A-Za-z0-9_-]{8,64}$/;
let idemSanSang = false;

// null = client không gửi key | false = key sai định dạng | string = key hợp lệ
function docKhoaIdempotency(req) {
    const raw = req.get('Idempotency-Key');
    if (raw === undefined) return null;
    return IDEM_REGEX.test(raw) ? raw : false;
}

const SKIP_AUTO_DDL = process.env.SKIP_AUTO_DDL === 'true';

async function kiemTraBangTonTai(tableName) {
    try {
        const r = await pool.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${String(tableName).toLowerCase()}`]);
        return r.rows[0]?.ok === true;
    } catch {
        return false;
    }
}

async function khoiTaoIdempotency() {
    if (SKIP_AUTO_DDL) {
        idemSanSang = await kiemTraBangTonTai('donhang_idempotency');
        return;
    }
    try {
        await pool.query(
            `CREATE TABLE IF NOT EXISTS DonHang_Idempotency (
                KhoaIdem    VARCHAR(64) PRIMARY KEY,
                MaNV        TEXT NOT NULL,
                DauVanTay   CHAR(64) NOT NULL,
                MaHoaDon    TEXT,
                LaHoaDonMoi BOOLEAN,
                DsMaCTHD    JSONB,
                ThoiGianTao TIMESTAMPTZ NOT NULL DEFAULT now()
            )`
        );
        idemSanSang = true;
    } catch (error) {
        // Nếu app chạy bằng role app_runtime (không có quyền DDL) nhưng migration đã tạo sẵn bảng -> vẫn bật bình thường
        idemSanSang = await kiemTraBangTonTai('donhang_idempotency');
        if (!idemSanSang) {
            console.error('⚠️ Không tạo được bảng DonHang_Idempotency, tạm tắt chống đơn trùng:', error.message);
        }
    }
}

let auditSanSang = false;
let paymentsSanSang = false;
let vietQrLogSanSang = false;

async function khoiTaoMoRongSchema() {
    if (SKIP_AUTO_DDL) {
        [auditSanSang, paymentsSanSang, vietQrLogSanSang] = await Promise.all([
            kiemTraBangTonTai('audit_logs'),
            kiemTraBangTonTai('order_payments'),
            kiemTraBangTonTai('vietqr_webhook_events'),
        ]);
        return;
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS Audit_Logs (
                Id           BIGSERIAL PRIMARY KEY,
                MaNV         TEXT NOT NULL,
                VaiTro       INT,
                NguoiDuyet   TEXT,
                HanhDong     VARCHAR(64) NOT NULL,
                DoiTuong     VARCHAR(32) NOT NULL,
                MaDoiTuong   TEXT,
                GiaTriCu     JSONB,
                GiaTriMoi    JSONB,
                LyDo         TEXT,
                DiaChiIP     TEXT,
                ThoiGianTao  TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS idx_audit_logs_thoigian ON Audit_Logs (ThoiGianTao DESC);
        `);
        // Trigger chống sửa/xóa Nhật ký Kiểm toán (Append-only bất biến)
        try {
            await pool.query(`
                CREATE OR REPLACE FUNCTION audit_no_mutation() RETURNS trigger AS $$
                BEGIN
                    RAISE EXCEPTION 'Audit_Logs là nhật ký bất biến (append-only), cấm sửa hoặc xóa!';
                END;
                $$ LANGUAGE plpgsql;
                DROP TRIGGER IF EXISTS trg_audit_immutable ON Audit_Logs;
                CREATE TRIGGER trg_audit_immutable
                    BEFORE UPDATE OR DELETE ON Audit_Logs
                    FOR EACH ROW EXECUTE FUNCTION audit_no_mutation();
            `);
        } catch (trigErr) {
            console.warn('⚠️ Bỏ qua gắn trigger bất biến Audit_Logs:', trigErr.message);
        }
        auditSanSang = true;
    } catch (error) {
        auditSanSang = await kiemTraBangTonTai('audit_logs');
        if (!auditSanSang) console.warn('⚠️ Không tạo được bảng Audit_Logs:', error.message);
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS Order_Payments (
                Id               BIGSERIAL PRIMARY KEY,
                MaHoaDon         TEXT NOT NULL,
                MaCaThuNgan      TEXT,
                PhuongThucTT     VARCHAR(32) NOT NULL,
                SoTien           NUMERIC(15, 2) NOT NULL CHECK (SoTien > 0),
                TienKhachDua     NUMERIC(15, 2),
                TienThua         NUMERIC(15, 2) NOT NULL DEFAULT 0,
                TrangThai        VARCHAR(16) NOT NULL DEFAULT 'PAID',
                MaGiaoDichNgoai  VARCHAR(128) UNIQUE,
                NoiDungCK        TEXT,
                NguonXacNhan     VARCHAR(32) NOT NULL DEFAULT 'POS_MANUAL',
                KhoaIdem         VARCHAR(64) UNIQUE,
                MaNV             TEXT,
                ThoiGianTao      TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS idx_order_payments_hd ON Order_Payments (MaHoaDon, TrangThai);
            CREATE INDEX IF NOT EXISTS idx_order_payments_ca ON Order_Payments (MaCaThuNgan, TrangThai, PhuongThucTT);
            CREATE INDEX IF NOT EXISTS idx_order_payments_thoigian ON Order_Payments (ThoiGianTao DESC);
        `);
        paymentsSanSang = true;
    } catch (error) {
        paymentsSanSang = await kiemTraBangTonTai('order_payments');
        if (!paymentsSanSang) console.warn('⚠️ Không tạo được bảng Order_Payments:', error.message);
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS VietQR_Webhook_Events (
                Id               BIGSERIAL PRIMARY KEY,
                NhaCungCap       VARCHAR(32) NOT NULL,
                MaGiaoDichNgoai  VARCHAR(128) NOT NULL UNIQUE,
                SoTien           NUMERIC(15, 2) NOT NULL,
                NoiDungCK        TEXT,
                MaHoaDonKhop     TEXT,
                TrangThaiXuLy    VARCHAR(32) NOT NULL,
                PayloadGoc       JSONB,
                ThoiGianNhan     TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS idx_vietqr_events_thoigian ON VietQR_Webhook_Events (ThoiGianNhan DESC);
        `);
        vietQrLogSanSang = true;
    } catch (error) {
        vietQrLogSanSang = await kiemTraBangTonTai('vietqr_webhook_events');
        if (!vietQrLogSanSang) console.warn('⚠️ Không tạo được bảng VietQR_Webhook_Events:', error.message);
    }

    const alterStatements = [
        'ALTER TABLE ChiTietHoaDon ADD COLUMN IF NOT EXISTS TenMonSnapshot TEXT',
        'ALTER TABLE ChiTietHoaDon ADD COLUMN IF NOT EXISTS GiaVonSnapshot NUMERIC(15, 2) DEFAULT 0',
        'ALTER TABLE ChiTietHoaDon ADD COLUMN IF NOT EXISTS LyDoHuy TEXT',
        'ALTER TABLE HoaDon ADD COLUMN IF NOT EXISTS SoLanIn INT NOT NULL DEFAULT 0',
        'ALTER TABLE HoaDon ADD COLUMN IF NOT EXISTS DaInTamTinh BOOLEAN NOT NULL DEFAULT FALSE',
        'ALTER TABLE SanPham ADD COLUMN IF NOT EXISTS TamHet BOOLEAN NOT NULL DEFAULT FALSE',
        'ALTER TABLE Topping ADD COLUMN IF NOT EXISTS TamHet BOOLEAN NOT NULL DEFAULT FALSE',
        'ALTER TABLE CaThuNgan ADD COLUMN IF NOT EXISTS GhiChuChenhLech TEXT',
        'ALTER TABLE NhanVien ADD COLUMN IF NOT EXISTS PinHash TEXT',
        'ALTER TABLE Order_Payments ADD COLUMN IF NOT EXISTS TienChuyenThua NUMERIC(15, 2) NOT NULL DEFAULT 0',
        'ALTER TABLE HoaDon ADD COLUMN IF NOT EXISTS SoThuTuNgay INT',
        'ALTER TABLE ChiTietHoaDon ADD COLUMN IF NOT EXISTS ThoiGianXong TIMESTAMPTZ',
        'ALTER TABLE CaThuNgan ADD COLUMN IF NOT EXISTS TongRutKet NUMERIC(15, 2) NOT NULL DEFAULT 0',
        'ALTER TABLE CaThuNgan ADD COLUMN IF NOT EXISTS ChiTietMenhGia JSONB',
        'ALTER TABLE HoaDon ADD COLUMN IF NOT EXISTS MaOfflineClient VARCHAR(64)',
        "ALTER TABLE SanPham ADD COLUMN IF NOT EXISTS TramCheBien VARCHAR(20) NOT NULL DEFAULT 'BAR_CHINH'",
        'ALTER TABLE PhieuThuChiLatVat ADD COLUMN IF NOT EXISTS AnhChungTuUrl TEXT',
        'ALTER TABLE HoaDon ADD COLUMN IF NOT EXISTS SoTienHoan NUMERIC(15, 2) NOT NULL DEFAULT 0',
        'ALTER TABLE ChiTietHoaDon ADD COLUMN IF NOT EXISTS DaHoanTien BOOLEAN NOT NULL DEFAULT FALSE',
        'ALTER TABLE CaThuNgan ADD COLUMN IF NOT EXISTS SoZReport INT',
        'ALTER TABLE ChiTietHoaDon_Topping ADD COLUMN IF NOT EXISTS TenToppingSnapshot VARCHAR(120)',
        'ALTER TABLE ChiTietHoaDon_Topping ADD COLUMN IF NOT EXISTS GiaVonToppingSnapshot NUMERIC(15, 2) NOT NULL DEFAULT 0',
        'ALTER TABLE NguyenLieu ADD COLUMN IF NOT EXISTS LaBanThanhPham BOOLEAN NOT NULL DEFAULT FALSE',
        'ALTER TABLE NguyenLieu ADD COLUMN IF NOT EXISTS SanLuongMeMacDinh NUMERIC(15, 3) NOT NULL DEFAULT 1000',
        'ALTER TABLE NguyenLieu ADD COLUMN IF NOT EXISTS HanSuDungGio INT',
        'ALTER TABLE NguyenLieu ADD COLUMN IF NOT EXISTS IsKeyItem BOOLEAN NOT NULL DEFAULT FALSE',
        "ALTER TABLE NhanVien ADD COLUMN IF NOT EXISTS PermissionsOverride JSONB NOT NULL DEFAULT '{}'::jsonb",
    ];
    for (const sql of alterStatements) {
        try {
            await pool.query(sql);
        } catch (error) {
            console.warn(`⚠️ Bỏ qua nâng cấp cột (${sql.slice(0, 55)}...):`, error.message);
        }
    }

    // Nới lỏng CHECK constraint PhieuThuChiLatVat.LoaiPhieu để hỗ trợ loại 3 = RUT_KET (Safe Drop) & 4 = THOI_CK_DU
    try {
        await pool.query(`
            DO $$
            DECLARE
                con_name text;
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'phieuthuchilatvat') THEN
                    FOR con_name IN
                        SELECT c.conname
                          FROM pg_constraint c
                          JOIN pg_class t ON t.oid = c.conrelid
                          JOIN pg_namespace n ON n.oid = t.relnamespace
                         WHERE n.nspname = 'public'
                           AND t.relname = 'phieuthuchilatvat'
                           AND c.contype = 'c'
                           AND pg_get_constraintdef(c.oid) ILIKE '%loaiphieu%'
                    LOOP
                        EXECUTE format('ALTER TABLE public.phieuthuchilatvat DROP CONSTRAINT IF EXISTS %I', con_name);
                    END LOOP;
                    ALTER TABLE public.phieuthuchilatvat
                        ADD CONSTRAINT chk_phieuthuchi_loaiphieu CHECK (LoaiPhieu IN (1, 2, 3, 4));
                END IF;
            END $$;
        `);
    } catch (error) {
        console.warn('⚠️ Bỏ qua nâng cấp constraint LoaiPhieu (Safe Drop):', error.message);
    }

    // Tạo bảng Quy đổi Đơn vị Kho (UoM), Công thức Topping & Bộ đếm Số thứ tự nguyên tử (Tenant_Daily_Counter)
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS BanThanhPham_CongThuc (
                TenantId          VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
                MaNLThanhPham     VARCHAR(64) NOT NULL REFERENCES NguyenLieu(MaNL) ON DELETE CASCADE,
                MaNLThanhPhan     VARCHAR(64) NOT NULL REFERENCES NguyenLieu(MaNL) ON DELETE CASCADE,
                KhoiLuongTieuHao  NUMERIC(15, 3) NOT NULL CHECK (KhoiLuongTieuHao > 0),
                PRIMARY KEY (TenantId, MaNLThanhPham, MaNLThanhPhan),
                CHECK (MaNLThanhPham <> MaNLThanhPhan)
            );
        `).catch(() => {});
        await pool.query(`
            CREATE TABLE IF NOT EXISTS Tenant_Daily_Counter (
                TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
                NgayVN   DATE NOT NULL,
                LastSeq  INT NOT NULL DEFAULT 0,
                PRIMARY KEY (TenantId, NgayVN)
            );

            CREATE TABLE IF NOT EXISTS NguyenLieu_DonViQuyDoi (
                Id          BIGSERIAL PRIMARY KEY,
                TenantId    VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
                MaNL        VARCHAR(64) NOT NULL,
                TenDonVi    VARCHAR(32) NOT NULL,
                HeSoQuyDoi  NUMERIC(15, 4) NOT NULL CHECK (HeSoQuyDoi > 0),
                ThoiGianTao TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE (TenantId, MaNL, TenDonVi)
            );
            CREATE INDEX IF NOT EXISTS idx_nl_quydoi_tenant ON NguyenLieu_DonViQuyDoi (TenantId, MaNL);

            CREATE TABLE IF NOT EXISTS Topping_CongThuc (
                TenantId          VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
                MaTopping         VARCHAR(64) NOT NULL,
                MaNL              VARCHAR(64) NOT NULL,
                KhoiLuongTieuHao  NUMERIC(15, 4) NOT NULL CHECK (KhoiLuongTieuHao > 0),
                PRIMARY KEY (TenantId, MaTopping, MaNL)
            );
            CREATE INDEX IF NOT EXISTS idx_topping_ct_tenant ON Topping_CongThuc (TenantId, MaTopping);
        `);
    } catch (error) {
        console.warn('⚠️ Bỏ qua tạo bảng UoM / Topping_CongThuc:', error.message);
    }
}

async function ghiAuditLog(
    db,
    {
        tenantId = 'DEFAULT',
        maNV,
        vaiTro = null,
        nguoiDuyet = null,
        hanhDong,
        doiTuong,
        maDoiTuong = null,
        giaTriCu = null,
        giaTriMoi = null,
        lyDo = null,
        ip = null,
        batBuoc = false,
    }
) {
    if (!auditSanSang) return;
    try {
        await db.query(
            `INSERT INTO Audit_Logs (TenantId, MaNV, VaiTro, NguoiDuyet, HanhDong, DoiTuong, MaDoiTuong, GiaTriCu, GiaTriMoi, LyDo, DiaChiIP)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
            [
                String(tenantId || 'DEFAULT'),
                String(maNV || 'SYSTEM'),
                vaiTro !== null ? Number(vaiTro) : null,
                nguoiDuyet ? String(nguoiDuyet) : null,
                hanhDong,
                doiTuong,
                maDoiTuong !== null ? String(maDoiTuong) : null,
                giaTriCu !== null ? JSON.stringify(giaTriCu) : null,
                giaTriMoi !== null ? JSON.stringify(giaTriMoi) : null,
                lyDo ? String(lyDo).slice(0, 500) : null,
                ip ? String(ip).slice(0, 64) : null,
            ]
        );
        // [P1 Anti-Fraud] Bắn cảnh báo tức thời về Telegram / Webhook chủ quán (non-blocking, ngoài DB transaction)
        setImmediate(() => {
            void dispatchFraudAlertFromAudit(pool, {
                tenantId: String(tenantId || 'DEFAULT'),
                maNV: String(maNV || 'SYSTEM'),
                vaiTro: vaiTro !== null ? Number(vaiTro) : null,
                nguoiDuyet: nguoiDuyet ? String(nguoiDuyet) : null,
                hanhDong,
                doiTuong,
                maDoiTuong: maDoiTuong !== null ? String(maDoiTuong) : null,
                giaTriCu,
                giaTriMoi,
                lyDo: lyDo ? String(lyDo).slice(0, 500) : null,
                ip: ip ? String(ip).slice(0, 64) : null,
            });
        });
    } catch (error) {
        console.warn('⚠️ Không ghi được Audit_Logs:', error.message);
        if (batBuoc) throw error;
    }
}

async function donDepIdempotency() {
    try {
        try {
            // [P0 FIX NOBYPASSRLS] Dùng hàm SECURITY DEFINER để dọn rác DonHang_Idempotency dưới Fail-Closed RLS
            await pool.query(`SELECT public.fn_cleanup_old_idempotency()`);
        } catch {
            await pool.query(`DELETE FROM DonHang_Idempotency WHERE ThoiGianTao < now() - interval '2 days'`);
        }
    } catch (error) {
        console.error('Lỗi dọn bảng DonHang_Idempotency:', error.message);
    }
}

// [P0 Trap #1 FIX] Chặn gọi thêm món / hủy món / tách đơn / gộp bàn khi hóa đơn đang khóa Khuyến mãi hoặc Đổi điểm
// Tránh lệch điều kiện DonToiThieu, lệch số tiền giảm hoặc mất điểm khách hàng đã trừ tạm trên HoaDon!
async function chanSuaDonDangCoUuDai(client, maHoaDon, hanhDong = 'thay đổi món') {
    await client.query('SAVEPOINT sp_chk_uudai_lock');
    let row = null;
    try {
        const r = await client.query(
            `SELECT MaKhuyenMai, COALESCE(TienGiamKM, 0) AS TienGiamKM, COALESCE(DiemSuDung, 0) AS DiemSuDung
               FROM HoaDon WHERE MaHoaDon = $1`,
            [maHoaDon]
        );
        await client.query('RELEASE SAVEPOINT sp_chk_uudai_lock');
        row = r.rows[0] || null;
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_chk_uudai_lock').catch(() => {});
        return;
    }
    if (row && (Number(row.tiengiamkm || 0) > 0 || Number(row.diemsudung || 0) > 0 || Boolean(row.makhuyenmai))) {
        throw new LoiNghiepVu(
            409,
            `Hóa đơn #${maHoaDon} đang áp mã giảm giá / đổi điểm Loyalty! Vui lòng bấm "✕ Gỡ ưu đãi" trước khi ${hanhDong}.`,
            { maLoi: 'CO_UU_DAI_CHUA_GO' }
        );
    }
}

// Ca thu ngân đang mở theo từng Tenant (+ tùy chọn BranchId & TerminalId cho đa quầy POS)
const KIEU_KHOA = { UPDATE: ' FOR UPDATE', SHARE: ' FOR SHARE' };
async function layCaDangMo(db, kieuKhoa, tenantId = 'DEFAULT', { branchId = null, terminalId = null } = {}) {
    const tId = String(tenantId || 'DEFAULT');
    const bFilter = branchId ? normalizeBranchForShift(tId, branchId) : null;
    const termFilter = terminalId ? normalizeTerminalId(terminalId) : null;
    const r = await db.query(
        `SELECT MaCaThuNgan, MaNV, ThoiGianMoCa, TienMatDauCa,
                COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'branchid', ''), $1::text || '_MAIN') AS BranchId,
                COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'terminalid', ''), 'POS_01') AS TerminalId,
                COALESCE((to_jsonb(CaThuNgan)->>'solandemlai')::int, 0) AS SoLanDemLai
           FROM CaThuNgan
          WHERE TrangThaiCa = 1
            AND COALESCE(TenantId::text, 'DEFAULT') = $1::text
            AND ($2::text IS NULL OR COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'branchid', ''), $1::text || '_MAIN') = $2::text)
            AND ($3::text IS NULL OR COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'terminalid', ''), 'POS_01') = $3::text)
          ORDER BY ThoiGianMoCa DESC
          LIMIT 1${KIEU_KHOA[kieuKhoa] || ''}`,
        [tId, bFilter, termFilter]
    );
    return r.rows[0] || null;
}

const loiChuaMoCa = () =>
    new LoiNghiepVu(409, 'Hệ thống chưa mở ca! Vui lòng mở ca thu ngân trước khi thực hiện thao tác này.', { maLoi: 'CHUA_MO_CA' });

// Chính sách hạch toán ca thống nhất cho đơn Offline (Phân hệ 7 + Phân hệ 3):
// 1. Nếu Ca gốc (maCaThuNganGoc) vẫn đang mở -> gắn vào đúng Ca gốc.
// 2. Nếu Ca gốc đã đóng nhưng hiện có Ca mới (Ca 2) đang mở -> tự động hạch toán vào Ca hiện tại kèm cờ laOfflineLechCa=true (TUYỆT ĐỐI không sửa ngược ZReportSnapshot của ca cũ!).
// 3. Nếu hiện không có bất kỳ ca nào mở -> báo 409 CHUA_MO_CA để Outbox giữ PENDING.
async function layCaChoGiaoDichOffline(client, { tenantId, maCaGoc = null, laOfflineSync = false, branchId = null, terminalId = null }) {
    let ca = await layCaDangMo(client, 'SHARE', tenantId, { branchId, terminalId });
    if (!ca && (branchId || terminalId)) {
        ca = await layCaDangMo(client, 'SHARE', tenantId);
    }
    let caGocDaDong = false;

    if (laOfflineSync && maCaGoc) {
        const caGocRes = await client.query(
            `SELECT MaCaThuNgan, MaNV, ThoiGianMoCa, TienMatDauCa, TrangThaiCa,
                    COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'branchid', ''), $2::text || '_MAIN') AS BranchId,
                    COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'terminalid', ''), 'POS_01') AS TerminalId
               FROM CaThuNgan
              WHERE MaCaThuNgan = $1 AND COALESCE(TenantId::text, 'DEFAULT') = $2::text
              FOR SHARE`,
            [maCaGoc, tenantId]
        );
        const rowGoc = caGocRes.rows[0];
        if (rowGoc && Number(rowGoc.trangthaica) === 1) {
            ca = rowGoc;
        } else {
            caGocDaDong = true;
        }
    }

    if (!ca) {
        if (laOfflineSync) {
            throw new LoiNghiepVu(
                409,
                'Hiện chưa có ca thu ngân nào đang mở để tiếp nhận đơn Offline. Vui lòng mở ca mới, hệ thống sẽ tự động xả hàng đợi!',
                { maLoi: 'SHIFT_NOT_OPEN_FOR_SYNC' }
            );
        }
        throw loiChuaMoCa();
    }

    const lechCaDongBo = Boolean(laOfflineSync && maCaGoc && String(maCaGoc) !== String(ca.macathungan));
    const ghiChuLechCa = lechCaDongBo
        ? `Ca gốc #${maCaGoc} ${caGocDaDong ? 'đã đóng' : 'khác ca hiện tại'} — tự động hạch toán vào Ca #${ca.macathungan}`
        : null;

    return { ca, maCaGoc: maCaGoc || null, lechCaDongBo, caGocDaDong, ghiChuLechCa };
}

// ---- Món cho màn hình Barista / Phục vụ -------------------------------------
const SQL_MON_PHA_CHE = `
    SELECT cthd.MaCTHD, cthd.MaHoaDon, cthd.MaMon,
           COALESCE(to_jsonb(cthd)->>'tenmontuychinh', cthd.TenMonSnapshot, sp.TenMon) AS TenMon,
           to_jsonb(cthd)->>'tenmontuychinh' AS TenMonTuyChinh,
           sp.NhomMon, to_jsonb(sp)->>'tramchebien' AS TramCheBien,
           COALESCE((to_jsonb(sp)->>'lamonthoigia')::boolean, FALSE) AS LaMonThoiGia,
           COALESCE((to_jsonb(sp)->>'intemcoc')::boolean, TRUE) AS InTemCoc,
           cthd.KichThuoc, cthd.SoLuong,
           cthd.GhiChu, cthd.TrangThaiPhaChe, cthd.ThoiGianGoi, cthd.ThoiGianXong,
           to_jsonb(cthd)->>'thoigianbatdaulam' AS ThoiGianBatDauLam,
           to_jsonb(cthd)->>'thoigianphucvu' AS ThoiGianPhucVu,
           to_jsonb(cthd)->>'manvphache' AS MaNVPhaChe,
           COALESCE((to_jsonb(cthd)->>'mucdouutien')::int, 0) AS MucDoUuTien,
           to_jsonb(cthd)->>'remakeofcthd' AS RemakeOfCTHD,
           (to_jsonb(cthd)->>'trongluonggram')::numeric AS TrongLuongGram,
           COALESCE((to_jsonb(cthd)->>'dotgoi')::int, 1) AS DotGoi,
           COALESCE((to_jsonb(cthd)->>'istakeaway')::boolean, FALSE) AS IsTakeaway,
           COALESCE((to_jsonb(cthd)->>'courseno')::int, 1) AS CourseNo,
           COALESCE(to_jsonb(cthd)->>'firestatus', 'FIRED') AS FireStatus,
           to_jsonb(cthd)->>'firedat' AS FiredAt,
           COALESCE((to_jsonb(cthd)->'modifierssnapshot')::jsonb, '[]'::jsonb) AS ModifiersSnapshot,
           to_jsonb(cthd)->>'combogroupuid' AS ComboGroupUid,
           to_jsonb(cthd)->>'macombo' AS MaCombo,
           to_jsonb(cthd)->>'tencombosnapshot' AS TenComboSnapshot,
           (SELECT hdq.SoThuTuNgay FROM HoaDon hdq WHERE hdq.MaHoaDon = cthd.MaHoaDon) AS SoThuTuNgay,
           (SELECT to_jsonb(hdq)->>'sothutuhienthi' FROM HoaDon hdq WHERE hdq.MaHoaDon = cthd.MaHoaDon) AS SoThuTuHienThi,
           (SELECT to_jsonb(hdq)->>'sotherung' FROM HoaDon hdq WHERE hdq.MaHoaDon = cthd.MaHoaDon) AS SoTheRung,
           (SELECT to_jsonb(hdq)->>'tenkhachvanglai' FROM HoaDon hdq WHERE hdq.MaHoaDon = cthd.MaHoaDon) AS TenKhachVangLai,
           (SELECT to_jsonb(hdq)->>'clientorderuid' FROM HoaDon hdq WHERE hdq.MaHoaDon = cthd.MaHoaDon) AS ClientOrderUid,
           (SELECT COALESCE(NULLIF(to_jsonb(hdq)->>'branchid', ''), 'DEFAULT') FROM HoaDon hdq WHERE hdq.MaHoaDon = cthd.MaHoaDon) AS BranchId,
           (SELECT COALESCE(to_jsonb(hdq)->>'loaidonhang', 'TAI_QUAN') FROM HoaDon hdq WHERE hdq.MaHoaDon = cthd.MaHoaDon) AS LoaiDonHang,
           (SELECT MIN(hb.MaBan) FROM HoaDon_Ban hb WHERE hb.MaHoaDon = cthd.MaHoaDon) AS MaBan,
           (SELECT string_agg(b.TenBan, ', ' ORDER BY b.TenBan)
              FROM HoaDon_Ban hb JOIN Ban b ON b.MaBan = hb.MaBan
             WHERE hb.MaHoaDon = cthd.MaHoaDon) AS TenBan,
           COALESCE((SELECT json_agg(json_build_object(
                                'maTopping', t.MaTopping,
                                'tenTopping', COALESCE(to_jsonb(t)->>'tentoppingsnapshot', tp.TenTopping),
                                'soLuong', t.SoLuong,
                                'soLuongMoiLy', COALESCE((to_jsonb(t)->>'soluongmoily')::int, 1)
                            ) ORDER BY tp.TenTopping)
                       FROM ChiTietHoaDon_Topping t LEFT JOIN Topping tp ON tp.MaTopping = t.MaTopping
                      WHERE t.MaCTHD = cthd.MaCTHD), '[]'::json) AS Toppings
      FROM ChiTietHoaDon cthd
      JOIN SanPham sp ON sp.MaMon = cthd.MaMon`;

const mapMonPhaChe = (r) => ({
    maCTHD: r.macthd,
    maHoaDon: r.mahoadon,
    branchId: r.branchid || 'DEFAULT',
    clientOrderUid: r.clientorderuid || null,
    soThuTuNgay: r.sothutungay ? Number(r.sothutungay) : null,
    soThuTuHienThi: r.sothutuhienthi || (r.sothutungay ? String(r.sothutungay).padStart(3, '0') : null),
    soTheRung: r.sotherung || null,
    tenKhachVangLai: r.tenkhachvanglai || null,
    loaiDonHang: r.loaidonhang || (r.maban ? 'TAI_QUAN' : 'MANG_DI'),
    maMon: r.mamon,
    tenMon: r.tenmon,
    tenMonTuyChinh: r.tenmontuychinh || null,
    laMonThoiGia: Boolean(r.lamonthoigia),
    inTemCoc: r.intemcoc !== false,
    trongLuongGram: r.trongluonggram !== null && r.trongluonggram !== undefined ? Number(r.trongluonggram) : null,
    nhomMon: r.nhommon || null,
    tramCheBien: suyLuanTramCheBien({ tramCheBien: r.tramchebien, nhomMon: r.nhommon, tenMon: r.tenmon }),
    kichThuoc: r.kichthuoc,
    soLuong: r.soluong,
    ghiChu: r.ghichu,
    dotGoi: Number(r.dotgoi || 1),
    isTakeaway: Boolean(r.istakeaway) || !r.maban,
    courseNo: Number(r.courseno || 1),
    fireStatus: r.firestatus || 'FIRED',
    firedAt: r.firedat || null,
    mucDoUuTien: Number(r.mucdouutien || 0),
    remakeOfCTHD: r.remakeofcthd || null,
    modifiersSnapshot: Array.isArray(r.modifierssnapshot) ? r.modifierssnapshot : [],
    comboGroupUid: r.combogroupuid || null,
    maCombo: r.macombo || null,
    tenComboSnapshot: r.tencombosnapshot || null,
    trangThaiPhaChe: r.trangthaiphache,
    thoiGianGoi: r.thoigiangoi,
    thoiGianBatDauLam: r.thoigianbatdaulam || null,
    thoiGianXong: r.thoigianxong || null,
    thoiGianPhucVu: r.thoigianphucvu || null,
    maNVPhaChe: r.manvphache || null,
    maBan: r.maban || null,
    tenBan: r.tenban || null,
    mangDi: !r.maban || Boolean(r.istakeaway),
    toppings: r.toppings,
});

async function layMonTheoMa(db, dsMaCTHD) {
    if (!Array.isArray(dsMaCTHD) || dsMaCTHD.length === 0) return [];
    const r = await db.query(
        `${SQL_MON_PHA_CHE} WHERE cthd.MaCTHD = ANY($1::varchar[])
         ORDER BY COALESCE((to_jsonb(cthd)->>'mucdouutien')::int, 0) DESC, cthd.ThoiGianGoi ASC, cthd.MaCTHD ASC`,
        [dsMaCTHD]
    );
    return r.rows.map(mapMonPhaChe);
}

async function layMonTheoTrangThai(db, dsTrangThai, tenantId = 'DEFAULT', { includeHeld = false } = {}) {
    const heldFilter = includeHeld ? '' : `AND COALESCE(to_jsonb(cthd)->>'firestatus', 'FIRED') = 'FIRED'`;
    const r = await db.query(
        `${SQL_MON_PHA_CHE}
         JOIN HoaDon hd ON hd.MaHoaDon = cthd.MaHoaDon
         WHERE cthd.TrangThaiPhaChe = ANY($1::varchar[])
           AND hd.TrangThaiTT IN (0, 1)
           ${heldFilter}
           AND COALESCE(hd.TenantId, 'DEFAULT') = $2
         ORDER BY COALESCE((to_jsonb(cthd)->>'mucdouutien')::int, 0) DESC, cthd.ThoiGianGoi ASC, cthd.MaCTHD ASC`,
        [dsTrangThai, String(tenantId || 'DEFAULT')]
    );
    return r.rows.map(mapMonPhaChe);
}

// ---- Hóa đơn chi tiết (dùng cho xem bàn, thanh toán, in bill — Single Source of Truth) ----------------
async function layHoaDonChiTiet(db, maHoaDon) {
    const hdRes = await db.query(
        `SELECT hd.MaHoaDon, hd.MaKH, kh.TenKH, kh.SoDienThoai, kh.DiemTichLuy,
                hd.TrangThaiTT, hd.PhuongThucTT, hd.TongTienThanhToan, hd.ThoiGianTao, hd.ThoiGianThanhToan,
                COALESCE(hd.SoLanIn, 0) AS SoLanIn, COALESCE(hd.DaInTamTinh, FALSE) AS DaInTamTinh,
                hd.SoThuTuNgay,
                to_jsonb(hd)->>'makhuyenmai' AS MaKhuyenMai,
                to_jsonb(hd)->>'tenkhuyenmai' AS TenKhuyenMai,
                COALESCE((to_jsonb(hd)->>'tiengiamkm')::numeric, 0) AS TienGiamKM,
                COALESCE((to_jsonb(hd)->>'diemsudung')::int, 0) AS DiemSuDung,
                COALESCE((to_jsonb(hd)->>'tiengiamdiem')::numeric, 0) AS TienGiamDiem,
                COALESCE((to_jsonb(hd)->>'version')::int, 1) AS Version,
                COALESCE(to_jsonb(hd)->>'loaidonhang', 'TAI_QUAN') AS LoaiDonHang,
                to_jsonb(hd)->>'sotherung' AS SoTheRung,
                to_jsonb(hd)->>'sothutuhienthi' AS SoThuTuHienThi,
                COALESCE((to_jsonb(hd)->>'phidonggoi')::numeric, 0) AS PhiDongGoi,
                to_jsonb(hd)->>'diachigiao' AS DiaChiGiao,
                to_jsonb(hd)->>'tenkhachvanglai' AS TenKhachVangLai,
                COALESCE((to_jsonb(hd)->>'sokhach')::int, 1) AS SoKhach,
                COALESCE(to_jsonb(hd)->>'thoigianmoban', hd.ThoiGianTao::text) AS ThoiGianMoBan,
                to_jsonb(hd)->>'mergedintomahoadon' AS MergedIntoMaHoaDon,
                to_jsonb(hd)->>'parentmahoadon' AS ParentMaHoaDon,
                COALESCE(to_jsonb(hd)->>'cachtinhthue', 'INCLUDED') AS CachTinhThue,
                COALESCE((to_jsonb(hd)->>'thuevatphantram')::numeric, 0) AS ThueVATPhanTram,
                COALESCE((to_jsonb(hd)->>'tienthuevat')::numeric, 0) AS TienThueVAT,
                COALESCE((to_jsonb(hd)->>'phiphucvuphantram')::numeric, 0) AS PhiPhucVuPhanTram,
                COALESCE((to_jsonb(hd)->>'tienphiphucvu')::numeric, 0) AS TienPhiPhucVu,
                COALESCE((to_jsonb(hd)->>'tienlamtron')::numeric, 0) AS TienLamTron,
                COALESCE(hd.TenantId, 'DEFAULT') AS TenantId
           FROM HoaDon hd
           LEFT JOIN KhachHang kh ON kh.MaKH = hd.MaKH
          WHERE hd.MaHoaDon = $1`,
        [maHoaDon]
    );
    if (hdRes.rows.length === 0) return null;
    const hd = hdRes.rows[0];

    const banRes = await db.query(
        `SELECT b.MaBan, b.TenBan FROM HoaDon_Ban hb JOIN Ban b ON b.MaBan = hb.MaBan
          WHERE hb.MaHoaDon = $1 ORDER BY b.TenBan`,
        [maHoaDon]
    );

    const monRes = await db.query(
        `SELECT c.MaCTHD, c.MaMon,
                COALESCE(to_jsonb(c)->>'tenmontuychinh', c.TenMonSnapshot, sp.TenMon) AS TenMon,
                c.KichThuoc, c.SoLuong, c.DonGia,
                COALESCE(c.GiaGiam, 0) AS GiaGiam, COALESCE(c.GiaVonSnapshot, 0) AS GiaVonSnapshot,
                COALESCE((to_jsonb(c)->>'giamodifiers')::numeric, 0) AS GiaModifiers,
                COALESCE((to_jsonb(c)->'modifierssnapshot')::jsonb, '[]'::jsonb) AS ModifiersSnapshot,
                to_jsonb(c)->>'combogroupuid' AS ComboGroupUid,
                to_jsonb(c)->>'macombo' AS MaCombo,
                to_jsonb(c)->>'tencombosnapshot' AS TenComboSnapshot,
                COALESCE((to_jsonb(c)->>'giagocniemyet')::numeric, c.DonGia) AS GiaGocNiemYet,
                COALESCE((to_jsonb(c)->>'dotgoi')::int, 1) AS DotGoi,
                COALESCE((to_jsonb(c)->>'istakeaway')::boolean, FALSE) AS IsTakeaway,
                COALESCE((to_jsonb(c)->>'courseno')::int, 1) AS CourseNo,
                COALESCE(to_jsonb(c)->>'firestatus', 'FIRED') AS FireStatus,
                to_jsonb(c)->>'firedat' AS FiredAt,
                COALESCE((to_jsonb(c)->>'chietkhaumon')::numeric, 0) AS ChietKhauMon,
                COALESCE((to_jsonb(c)->>'lamontang')::boolean, FALSE) AS LaMonTang,
                to_jsonb(c)->>'lydotang' AS LyDoTang,
                (to_jsonb(c)->>'trongluonggram')::numeric AS TrongLuongGram,
                to_jsonb(c)->>'tenmontuychinh' AS TenMonTuyChinh,
                to_jsonb(sp)->>'tramchebien' AS TramCheBien,
                sp.NhomMon,
                c.GhiChu, c.TrangThaiPhaChe, c.LyDoHuy, c.ThoiGianGoi,
                COALESCE((SELECT json_agg(json_build_object(
                                    'maTopping', t.MaTopping,
                                    'tenTopping', COALESCE(to_jsonb(t)->>'tentoppingsnapshot', tp.TenTopping),
                                    'soLuong', t.SoLuong,
                                    'soLuongMoiLy', COALESCE((to_jsonb(t)->>'soluongmoily')::int, 1),
                                    'donGia', t.DonGia,
                                    'giaVonSnapshot', COALESCE((to_jsonb(t)->>'giavontoppingsnapshot')::numeric, 0)
                                ) ORDER BY COALESCE(to_jsonb(t)->>'tentoppingsnapshot', tp.TenTopping))
                            FROM ChiTietHoaDon_Topping t LEFT JOIN Topping tp ON tp.MaTopping = t.MaTopping
                           WHERE t.MaCTHD = c.MaCTHD), '[]'::json) AS Toppings
           FROM ChiTietHoaDon c
           JOIN SanPham sp ON sp.MaMon = c.MaMon
          WHERE c.MaHoaDon = $1
          ORDER BY c.ThoiGianGoi, c.MaCTHD`,
        [maHoaDon]
    );

    const danhSachMon = monRes.rows.map((r) => {
        const donGia = Number(r.dongia);
        const giaGiam = Number(r.giagiam);
        const giaModifiers = Number(r.giamodifiers || 0);
        const chietKhauMon = Number(r.chietkhaumon || 0);
        const laMonTang = Boolean(r.lamontang);
        const daHuy = r.trangthaiphache === 'DaHuy';
        const tienTopping = r.toppings.reduce((s, t) => s + Number(t.soLuong) * Number(t.donGia), 0);
        const thanhTien =
            daHuy || laMonTang
                ? 0
                : Math.max(0, r.soluong * (donGia + giaModifiers) + tienTopping - giaGiam - chietKhauMon);
        return {
            maCTHD: r.macthd,
            maMon: r.mamon,
            tenMon: r.tenmon,
            nhomMon: r.nhommon || null,
            tramCheBien: suyLuanTramCheBien({ tramCheBien: r.tramchebien, nhomMon: r.nhommon, tenMon: r.tenmon }),
            kichThuoc: r.kichthuoc,
            soLuong: r.soluong,
            donGia,
            giaGiam,
            giaModifiers,
            modifiersSnapshot: Array.isArray(r.modifierssnapshot) ? r.modifierssnapshot : [],
            chietKhauMon,
            laMonTang,
            lyDoTang: r.lydotang || null,
            trongLuongGram: r.trongluonggram !== null && r.trongluonggram !== undefined ? Number(r.trongluonggram) : null,
            tenMonTuyChinh: r.tenmontuychinh || null,
            comboGroupUid: r.combogroupuid || null,
            maCombo: r.macombo || null,
            tenComboSnapshot: r.tencombosnapshot || null,
            giaGocNiemYet: Number(r.giagocniemyet || donGia),
            dotGoi: Number(r.dotgoi || 1),
            isTakeaway: Boolean(r.istakeaway),
            courseNo: Number(r.courseno || 1),
            fireStatus: r.firestatus || 'FIRED',
            firedAt: r.firedat || null,
            giaVon: Number(r.giavonsnapshot || 0),
            ghiChu: r.ghichu,
            trangThaiPhaChe: r.trangthaiphache,
            daHuy,
            lyDoHuy: r.lydohuy || null,
            thoiGianGoi: r.thoigiangoi,
            toppings: r.toppings,
            thanhTien,
        };
    });

    const monHopLe = danhSachMon.filter((m) => !m.daHuy);

    let danhSachThanhToan = [];
    if (paymentsSanSang) {
        try {
            const pRes = await db.query(
                `SELECT Id, PhuongThucTT, SoTien, TienKhachDua, TienThua, TrangThai,
                        MaGiaoDichNgoai, NoiDungCK, NguonXacNhan, ThoiGianTao,
                        (to_jsonb(Order_Payments)->>'chiatienid')::bigint AS ChiaTienId
                   FROM Order_Payments
                  WHERE MaHoaDon = $1::text AND TrangThai = 'PAID'
                  ORDER BY Id ASC`,
                [String(maHoaDon)]
            );
            danhSachThanhToan = pRes.rows.map((p) => ({
                id: p.id,
                phuongThucTT: p.phuongthuctt,
                soTien: Number(p.sotien),
                tienKhachDua: p.tienkhachdua !== null ? Number(p.tienkhachdua) : null,
                tienThua: Number(p.tienthua || 0),
                trangThai: p.trangthai,
                maGiaoDichNgoai: p.magiaodichngoai || null,
                noiDungCK: p.noidungck || null,
                nguonXacNhan: p.nguonxacnhan || 'POS_MANUAL',
                chiaTienId: p.chiatienid ? Number(p.chiatienid) : null,
                thoiGianTao: p.thoigiantao,
            }));
        } catch {
            danhSachThanhToan = [];
        }
    }

    let danhSachChiaTien = [];
    try {
        await db.query('SAVEPOINT sp_sel_chiatien');
        const ctRes = await db.query(
            `SELECT id, nhanchia, sotienphaitra, sotiendatra, trangthai, thoigiantao
               FROM hoadon_chiatien
              WHERE mahoadon = $1::text AND trangthai <> 'CANCELLED'
              ORDER BY id ASC`,
            [String(maHoaDon)]
        );
        await db.query('RELEASE SAVEPOINT sp_sel_chiatien');
        danhSachChiaTien = ctRes.rows.map((x) => ({
            id: Number(x.id),
            nhanChia: x.nhanchia,
            soTienPhaiTra: Number(x.sotienphaitra),
            soTienDaTra: Number(x.sotiendatra || 0),
            trangThai: x.trangthai,
            thoiGianTao: x.thoigiantao,
        }));
    } catch {
        await db.query('ROLLBACK TO SAVEPOINT sp_sel_chiatien').catch(() => {});
    }

    const tienGiamKM = Number(hd.tiengiamkm || 0);
    const diemSuDung = Number(hd.diemsudung || 0);
    const tienGiamDiem = Number(hd.tiengiamdiem || 0);
    const loaiDonHang = hd.loaidonhang || (banRes.rows.length > 0 ? 'TAI_QUAN' : 'MANG_DI');

    const keToan = tinhTongKeToanHoaDon({
        danhSachMon,
        tienGiamKM,
        tienGiamDiem,
        loaiDonHang,
        phiPhucVuPhanTram: Number(hd.phiphucvuphantram || 0),
        phiDongGoi: Number(hd.phidonggoi || 0),
        cachTinhThue: hd.cachtinhthue || 'INCLUDED',
        thueVATPhanTram: Number(hd.thuevatphantram || 0),
    });

    const tongTamTinh = keToan.tamTinhMon;
    const tongGiamGia = keToan.tongGiamGia;
    const tongSauGiam = keToan.sauGiamGia;
    const tongPhaiTra = keToan.tongPhaiTra;

    const tongDaThuTuBang = danhSachThanhToan.reduce((s, p) => s + p.soTien, 0);
    const daThanhToan =
        hd.trangthaitt === 1 && danhSachThanhToan.length === 0
            ? Number(hd.tongtienthanhtoan ?? tongPhaiTra)
            : tongDaThuTuBang;
    const conLaiCanThu = hd.trangthaitt === 1 || hd.trangthaitt === 3
        ? 0
        : Math.max(0, Math.round((tongPhaiTra - daThanhToan) * 100) / 100);
    const distinctMethods = new Set(danhSachThanhToan.map((p) => p.phuongThucTT));

    return {
        maHoaDon: hd.mahoadon,
        version: Number(hd.version || 1),
        soThuTuNgay: hd.sothutungay ? Number(hd.sothutungay) : null,
        soThuTuHienThi: hd.sothutuhienthi || (hd.sothutungay ? String(hd.sothutungay).padStart(3, '0') : null),
        soTheRung: hd.sotherung || null,
        loaiDonHang,
        tenKhachVangLai: hd.tenkhachvanglai || null,
        diaChiGiao: hd.diachigiao || null,
        soKhach: Number(hd.sokhach || 1),
        thoiGianMoBan: hd.thoigianmoban || hd.thoigiantao,
        mergedIntoMaHoaDon: hd.mergedintomahoadon || null,
        parentMaHoaDon: hd.parentmahoadon || null,
        tenantId: hd.tenantid || 'DEFAULT',
        khachHang: hd.makh
            ? { maKH: hd.makh, tenKH: hd.tenkh, soDienThoai: hd.sodienthoai, diemTichLuy: hd.diemtichluy }
            : null,
        trangThaiTT: hd.trangthaitt,
        phuongThucTT: hd.phuongthuctt,
        laThanhToanHonHop: distinctMethods.size > 1,
        thoiGianTao: hd.thoigiantao,
        thoiGianThanhToan: hd.thoigianthanhtoan,
        soLanIn: Number(hd.solanin || 0),
        daInTamTinh: Boolean(hd.daintamtinh),
        ban: banRes.rows.map((b) => ({ maBan: b.maban, tenBan: b.tenban })),
        danhSachMon,
        danhSachThanhToan,
        danhSachChiaTien,
        soMonHopLe: monHopLe.length,
        tongTamTinh,
        maKhuyenMai: hd.makhuyenmai || null,
        tenKhuyenMai: hd.tenkhuyenmai || null,
        tienGiamKM,
        diemSuDung,
        tienGiamDiem,
        tongGiamGia,
        tongSauGiam,
        phiDongGoi: keToan.phiDongGoi,
        phiPhucVuPhanTram: Number(hd.phiphucvuphantram || 0),
        tienPhiPhucVu: keToan.tienPhiPhucVu,
        cachTinhThue: keToan.cachTinhThue,
        thueVATPhanTram: keToan.thueVATPhanTram,
        tienThueVAT: keToan.tienThueVAT,
        tienLamTron: Number(hd.tienlamtron || keToan.tienLamTron || 0),
        tongPhaiTra,
        daThanhToan,
        conLaiCanThu,
        tongTienThanhToan: hd.trangthaitt === 1 ? Number(hd.tongtienthanhtoan) : null,
    };
}

async function layHoaDonMoCuaBan(db, maBan, khoa = false) {
    const r = await db.query(
        `SELECT hd.MaHoaDon
           FROM HoaDon hd JOIN HoaDon_Ban hb ON hb.MaHoaDon = hd.MaHoaDon
          WHERE hb.MaBan = $1 AND hd.TrangThaiTT = 0
          ORDER BY hd.ThoiGianTao DESC
          LIMIT 1${khoa ? ' FOR UPDATE OF hd' : ''}`,
        [maBan]
    );
    return r.rows.length ? r.rows[0].mahoadon : null;
}

// ---- Đối soát tiền mặt của 1 ca thu ngân (Phân hệ 3: Sổ cái Order_Refunds độc lập, Thối CK dư Loại 4, ZReportSnapshot bất biến) ----
async function tinhDoiSoatCa(db, maCaThuNgan, tienMatThucTe) {
    let caRes;
    try {
        await db.query('SAVEPOINT sp_ca_zreport');
        caRes = await db.query(
            `SELECT ca.MaCaThuNgan, ca.MaNV, nv.TenNV, ca.ThoiGianMoCa, ca.ThoiGianDongCa,
                    ca.TienMatDauCa, ca.TienMatThucTe, ca.TrangThaiCa, ca.GhiChuChenhLech, ca.ChiTietMenhGia,
                    COALESCE(ca.TenantId, 'DEFAULT') AS TenantId,
                    to_jsonb(ca)->>'sozreport' AS SoZReport,
                    COALESCE(NULLIF(to_jsonb(ca)->>'branchid', ''), COALESCE(ca.TenantId, 'DEFAULT') || '_MAIN') AS BranchId,
                    COALESCE(NULLIF(to_jsonb(ca)->>'terminalid', ''), 'POS_01') AS TerminalId,
                    to_jsonb(ca)->'chitietmenhgiadauca' AS ChiTietMenhGiaDauCa,
                    COALESCE((to_jsonb(ca)->>'tiengiulaiket')::numeric, 0) AS TienGiuLaiKet,
                    COALESCE((to_jsonb(ca)->>'chenhlechbangiao')::numeric, 0) AS ChenhLechBanGiao,
                    to_jsonb(ca)->>'macatruoc' AS MaCaTruoc,
                    COALESCE((to_jsonb(ca)->>'solandemlai')::int, 0) AS SoLanDemLai,
                    to_jsonb(ca)->'zreportsnapshot' AS ZReportSnapshot,
                    (to_jsonb(ca)->>'tongchotloedc')::numeric AS TongChotLoEDC
               FROM CaThuNgan ca JOIN NhanVien nv ON nv.MaNV = ca.MaNV
              WHERE ca.MaCaThuNgan = $1`,
            [maCaThuNgan]
        );
        await db.query('RELEASE SAVEPOINT sp_ca_zreport');
    } catch {
        await db.query('ROLLBACK TO SAVEPOINT sp_ca_zreport').catch(() => {});
        caRes = await db.query(
            `SELECT ca.MaCaThuNgan, ca.MaNV, nv.TenNV, ca.ThoiGianMoCa, ca.ThoiGianDongCa,
                    ca.TienMatDauCa, ca.TienMatThucTe, ca.TrangThaiCa, ca.GhiChuChenhLech,
                    COALESCE(ca.TenantId, 'DEFAULT') AS TenantId
               FROM CaThuNgan ca JOIN NhanVien nv ON nv.MaNV = ca.MaNV
              WHERE ca.MaCaThuNgan = $1`,
            [maCaThuNgan]
        );
    }
    if (caRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy ca thu ngân!');
    const ca = caRes.rows[0];
    const soZReport = ca.sozreport ? Number(ca.sozreport) : null;

    // [Phân hệ 3 - Z-Report Bất biến] Nếu ca đã chốt (TrangThaiCa = 2) và đã đóng băng ZReportSnapshot -> trả số liệu đóng băng vĩnh viễn!
    if (Number(ca.trangthaica) === 2 && ca.zreportsnapshot && typeof ca.zreportsnapshot === 'object' && ca.zreportsnapshot.cashFlow) {
        const snap = ca.zreportsnapshot;
        const cf = snap.cashFlow;
        const pm = snap.paymentsByMethod || {};
        const rf = snap.refunds || {};
        const chenhLechSnap = Number(cf.variance || 0);
        const trangThaiSnap =
            chenhLechSnap > 0 ? 'Thừa tiền mặt (Dư quỹ)' : chenhLechSnap < 0 ? 'Thiếu tiền mặt (Hụt quỹ)' : 'Khớp quỹ chính xác';

        return {
            maCaThuNgan: ca.macathungan,
            branchId: snap.branchId || ca.branchid,
            terminalId: snap.terminalId || ca.terminalid,
            soZReport,
            maZReport: snap.zNumber || (soZReport ? `Z-${String(soZReport).padStart(4, '0')}` : null),
            maNV: ca.manv,
            tenNV: ca.tennv,
            thoiGianMoCa: ca.thoigianmoca,
            thoiGianDongCa: ca.thoigiandongca,
            trangThaiCa: ca.trangthaica,
            tienMatDauCa: Number(cf.openingFloat || 0),
            doanhThu: {
                tienMat: Number(pm.TIEN_MAT || 0),
                chuyenKhoan: Number(pm.CHUYEN_KHOAN_AUTO_WEBHOOK || 0) + Number(pm.CHUYEN_KHOAN_MANUAL || 0),
                the: Number(pm.THE || 0),
                voucher: Number(pm.VOUCHER || 0),
                viKhach: Number(pm.VI_KHACH || 0),
                viDienTu: Number(pm.VI_DIEN_TU || 0),
                sanGiaoHang: Number(pm.SAN_GIAO_HANG || 0),
                tong: Number(snap.sales?.netSales || 0),
                soHoaDon: Number(snap.sales?.orderCount || 0),
            },
            hoanTien: {
                tienMat: Number(rf.cash || 0),
                chuyenKhoan: Number(rf.bank || 0),
                the: Number(rf.card || 0),
                viKhach: Number(rf.wallet || 0),
                voucher: 0,
                tong: Number(rf.total || 0),
                soLuot: Number(rf.count || 0),
            },
            thuLatVat: Number(cf.payIn || 0),
            chiLatVat: Number(cf.payOut || 0),
            rutKet: Number(cf.safeDrop || 0),
            thoiCkDu: Number(cf.overpaymentCashChange || 0),
            soPhieuRutKet: 0,
            tienMatLyThuyet: Number(cf.expectedCash || 0),
            tienMatThucTe: Number(cf.actualCountedCash || 0),
            chenhLech: chenhLechSnap,
            trangThai: trangThaiSnap,
            tienGiuLaiKet: Number(cf.carryOverFloatNextShift || ca.tiengiulaiket || 0),
            tienNopVeChuQuan: Number(cf.netCashToOwner || 0),
            chenhLechBanGiao: Number(ca.chenhlechbangiao || 0),
            maCaTruoc: ca.macatruoc || null,
            soLanDemLai: Number(ca.solandemlai || 0),
            ghiChuChenhLech: ca.ghichuchenhlech || null,
            chiTietMenhGiaDauCa: ca.chitietmenhgiadauca || null,
            chiTietMenhGia: ca.chitietmenhgia || null,
            tongChotLoEDC: ca.tongchotloedc !== null && ca.tongchotloedc !== undefined ? Number(ca.tongchotloedc) : null,
            zReportSnapshot: snap,
            isFrozenSnapshot: true,
        };
    }

    const doanhThu = {
        tienMat: 0,
        chuyenKhoan: 0,
        the: 0,
        voucher: 0,
        viKhach: 0,
        viDienTu: 0,
        sanGiaoHang: 0,
        tong: 0,
        soHoaDon: 0,
    };
    const hoanTien = { tienMat: 0, chuyenKhoan: 0, the: 0, voucher: 0, viKhach: 0, tong: 0, soLuot: 0 };

    if (paymentsSanSang) {
        const [pRes, hdCountRes] = await Promise.all([
            db.query(
                `SELECT PhuongThucTT, COALESCE(SUM(SoTien), 0) AS TongTien
                   FROM (
                       SELECT op.PhuongThucTT, op.SoTien
                         FROM Order_Payments op
                        WHERE op.MaCaThuNgan = $1::text AND op.TrangThai = 'PAID'
                       UNION ALL
                       SELECT COALESCE(hd.PhuongThucTT, 'TIEN_MAT') AS PhuongThucTT, hd.TongTienThanhToan AS SoTien
                         FROM HoaDon hd
                        WHERE hd.MaCaThuNgan = $1 AND hd.TrangThaiTT = 1
                          AND NOT EXISTS (
                              SELECT 1 FROM Order_Payments op2
                               WHERE op2.MaHoaDon = hd.MaHoaDon::text AND op2.TrangThai = 'PAID'
                          )
                   ) combined
                  GROUP BY PhuongThucTT`,
                [maCaThuNgan]
            ),
            db.query(
                `SELECT COUNT(DISTINCT ma_hd) AS SoHoaDon
                   FROM (
                       SELECT MaHoaDon AS ma_hd FROM Order_Payments WHERE MaCaThuNgan = $1::text AND TrangThai = 'PAID'
                       UNION
                       SELECT MaHoaDon::text AS ma_hd FROM HoaDon WHERE MaCaThuNgan = $1 AND TrangThaiTT = 1
                   ) d`,
                [maCaThuNgan]
            ),
        ]);
        for (const r of pRes.rows) {
            const tien = Number(r.tongtien);
            if (r.phuongthuctt === 'CHUYEN_KHOAN') doanhThu.chuyenKhoan += tien;
            else if (r.phuongthuctt === 'THE') doanhThu.the += tien;
            else if (r.phuongthuctt === 'VOUCHER') doanhThu.voucher += tien;
            else if (r.phuongthuctt === 'VI_KHACH') doanhThu.viKhach += tien;
            else if (r.phuongthuctt === 'VI_DIEN_TU') doanhThu.viDienTu += tien;
            else if (r.phuongthuctt === 'SAN_GIAO_HANG') doanhThu.sanGiaoHang += tien;
            else doanhThu.tienMat += tien;
            doanhThu.tong += tien;
        }
        doanhThu.soHoaDon = Number(hdCountRes.rows[0]?.sohoadon || 0);

        // Đọc tổng Hoàn tiền của riêng Ca này từ Sổ cái Hoàn tiền Độc lập (public.order_refunds) + fallback legacy REFUNDED
        let gotLedgerRefunds = false;
        await db.query('SAVEPOINT sp_ds_order_refunds');
        try {
            const orRes = await db.query(
                `SELECT phuongthuchoan AS PhuongThucTT, COUNT(*) AS SoLuot, COALESCE(SUM(sotienhoan), 0) AS TongTien
                   FROM public.order_refunds
                  WHERE macathungan = $1::text
                  GROUP BY phuongthuchoan`,
                [String(maCaThuNgan)]
            );
            await db.query('RELEASE SAVEPOINT sp_ds_order_refunds');
            for (const r of orRes.rows) {
                const tien = Number(r.tongtien || 0);
                if (r.phuongthuctt === 'CHUYEN_KHOAN') hoanTien.chuyenKhoan += tien;
                else if (r.phuongthuctt === 'THE') hoanTien.the += tien;
                else if (r.phuongthuctt === 'VOUCHER') hoanTien.voucher += tien;
                else if (r.phuongthuctt === 'VI_KHACH') hoanTien.viKhach += tien;
                else hoanTien.tienMat += tien;
                hoanTien.tong += tien;
                hoanTien.soLuot += Number(r.soluot || 0);
            }
            gotLedgerRefunds = true;
        } catch {
            await db.query('ROLLBACK TO SAVEPOINT sp_ds_order_refunds').catch(() => {});
        }
        if (!gotLedgerRefunds) {
            const refundRes = await db.query(
                `SELECT PhuongThucTT, COUNT(*) AS SoLuot, COALESCE(SUM(SoTien), 0) AS TongTien
                   FROM Order_Payments
                  WHERE MaCaThuNgan = $1::text AND TrangThai = 'REFUNDED'
                  GROUP BY PhuongThucTT`,
                [maCaThuNgan]
            );
            for (const r of refundRes.rows) {
                const tien = Number(r.tongtien);
                if (r.phuongthuctt === 'CHUYEN_KHOAN') hoanTien.chuyenKhoan += tien;
                else if (r.phuongthuctt === 'THE') hoanTien.the += tien;
                else if (r.phuongthuctt === 'VOUCHER') hoanTien.voucher += tien;
                else hoanTien.tienMat += tien;
                hoanTien.tong += tien;
                hoanTien.soLuot += Number(r.soluot || 0);
            }
        }
    } else {
        const ttRes = await db.query(
            `SELECT PhuongThucTT, COUNT(*) AS SoHoaDon, COALESCE(SUM(TongTienThanhToan), 0) AS TongTien
               FROM HoaDon
              WHERE MaCaThuNgan = $1 AND TrangThaiTT = 1
              GROUP BY PhuongThucTT`,
            [maCaThuNgan]
        );
        for (const r of ttRes.rows) {
            const tien = Number(r.tongtien);
            if (r.phuongthuctt === 'CHUYEN_KHOAN') doanhThu.chuyenKhoan += tien;
            else if (r.phuongthuctt === 'THE') doanhThu.the += tien;
            else if (r.phuongthuctt === 'VOUCHER') doanhThu.voucher += tien;
            else doanhThu.tienMat += tien;
            doanhThu.tong += tien;
            doanhThu.soHoaDon += Number(r.sohoadon);
        }
    }

    const tcRes = await db.query(
        `SELECT LoaiPhieu, COUNT(*) AS SoPhieu, COALESCE(SUM(SoTien), 0) AS Tong
           FROM PhieuThuChiLatVat WHERE MaCaThuNgan = $1 GROUP BY LoaiPhieu`,
        [maCaThuNgan]
    );
    let thuLatVat = 0;
    let chiLatVat = 0;
    let rutKet = 0;
    let thoiCkDu = 0;
    let soPhieuRutKet = 0;
    for (const r of tcRes.rows) {
        const lp = Number(r.loaiphieu);
        if (lp === 1) thuLatVat = Number(r.tong);
        else if (lp === 3) {
            rutKet = Number(r.tong);
            soPhieuRutKet = Number(r.sophieu || 0);
        } else if (lp === 4) {
            thoiCkDu = Number(r.tong);
        } else {
            chiLatVat += Number(r.tong);
        }
    }

    const tienMatDauCa = Number(ca.tienmatdauca);
    // Công thức Sổ Quỹ Chuẩn 100%: DauCa + BanTienMat + Thu - Chi - RutKet - ThoiCKDu - HoanTienMat
    const tienMatLyThuyet =
        Math.round((tienMatDauCa + doanhThu.tienMat + thuLatVat - chiLatVat - rutKet - thoiCkDu - hoanTien.tienMat) * 100) / 100;
    const thucTe =
        tienMatThucTe !== undefined && tienMatThucTe !== null && tienMatThucTe !== ''
            ? Number(tienMatThucTe)
            : Number(ca.trangthaica) === 2 && ca.tienmatthucte !== null && ca.tienmatthucte !== undefined
            ? Number(ca.tienmatthucte)
            : null;
    const chenhLech = thucTe === null ? null : Math.round((thucTe - tienMatLyThuyet) * 100) / 100;

    let trangThai = null;
    if (chenhLech !== null) {
        trangThai = 'Khớp quỹ chính xác';
        if (chenhLech > 0) trangThai = 'Thừa tiền mặt (Dư quỹ)';
        if (chenhLech < 0) trangThai = 'Thiếu tiền mặt (Hụt quỹ)';
    }

    return {
        maCaThuNgan: ca.macathungan,
        branchId: ca.branchid || normalizeBranchForShift(ca.tenantid),
        terminalId: ca.terminalid || 'POS_01',
        soZReport,
        maZReport: soZReport ? `Z-${String(soZReport).padStart(4, '0')}` : null,
        maNV: ca.manv,
        tenNV: ca.tennv,
        thoiGianMoCa: ca.thoigianmoca,
        thoiGianDongCa: ca.thoigiandongca,
        trangThaiCa: ca.trangthaica, // 1 đang mở, 2 đã chốt
        tienMatDauCa,
        doanhThu,
        hoanTien,
        thuLatVat,
        chiLatVat,
        rutKet,
        thoiCkDu,
        soPhieuRutKet,
        tienMatLyThuyet,
        tienMatThucTe: thucTe,
        chenhLech,
        trangThai,
        tienGiuLaiKet: Number(ca.tiengiulaiket || 0),
        chenhLechBanGiao: Number(ca.chenhlechbangiao || 0),
        maCaTruoc: ca.macatruoc || null,
        soLanDemLai: Number(ca.solandemlai || 0),
        ghiChuChenhLech: ca.ghichuchenhlech || null,
        chiTietMenhGiaDauCa: ca.chitietmenhgiadauca || null,
        chiTietMenhGia: ca.chitietmenhgia || null,
        tongChotLoEDC: ca.tongchotloedc !== null && ca.tongchotloedc !== undefined ? Number(ca.tongchotloedc) : null,
        zReportSnapshot: ca.zreportsnapshot || null,
        isFrozenSnapshot: false,
    };
}

// ==========================================
// CẤU HÌNH SOCKET.IO CHO BARISTA & PHỤC VỤ
// ==========================================
io.use((socket, next) => {
    // Không đọc JWT từ query string để tránh lộ token vào access logs proxy/server
    const token = socket.handshake.auth?.token
               || (socket.handshake.headers['authorization'] ? socket.handshake.headers['authorization'].split(' ')[1] : null)
               || socket.handshake.headers['token'];

    if (!token) return next(new Error('Từ chối kết nối: Thiếu Token!'));

    jwt.verify(token, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS, async (err, user) => {
        if (err) return next(new Error('Từ chối kết nối: Token sai hoặc đã hết hạn!'));
        if (user?.type === 'PLATFORM_ADMIN') {
            return next(new Error('Từ chối kết nối: Token Platform Admin không dùng cho Socket quán!'));
        }
        // [P0 FIX] Kiểm tra trạng thái hoạt động của nhân viên ngay tại Socket handshake (chặn NV bị khóa kết nối lại!)
        const conHoatDong = await kiemTraNhanVienConHoatDong(user.maNV);
        if (!conHoatDong) {
            return next(new Error('Từ chối kết nối: Tài khoản nhân viên đã bị khóa hoặc ngừng làm việc!'));
        }
        // Tải branchId thẩm quyền từ DB (chống client giả mạo branchId khi room:subscribe)
        let resolvedBranchId = user.branchId ? String(user.branchId).trim() : null;
        if (!resolvedBranchId && user.maNV) {
            try {
                const tId = String(user.tenantId || 'DEFAULT');
                const brRes = await pool.withTenant(tId, (client) =>
                    client.query(
                        `SELECT NULLIF(TRIM(COALESCE(to_jsonb(NhanVien)->>'branchid', '')), '') AS branchid
                           FROM NhanVien
                          WHERE MaNV = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                          LIMIT 1`,
                        [user.maNV, tId]
                    )
                );
                resolvedBranchId = brRes.rows[0]?.branchid || null;
            } catch {
                // ignore if schema has no branchid column yet
            }
        }
        socket.user = { ...user, branchId: resolvedBranchId };
        next();
    });
});

io.on('connection', (socket) => {
    const vaiTro = Number(socket.user.vaiTro);
    const tenantId = String(socket.user.tenantId || 'DEFAULT');
    console.log(`Client kết nối Socket [${tenantId}]:`, socket.id);

    // [Wave 3A — P1-03] Phòng cá nhân cô lập đa tenant: t:{tenantId}:user:{maNV}
    if (socket.user.maNV) {
        socket.join(`t:${tenantId}:user:${socket.user.maNV}`);
    }

    if (vaiTro === 1) {
        socket.join([
            roomTen(tenantId, 'thungan'),
            roomTen(tenantId, 'phucvu'),
            roomTen(tenantId, 'barista'),
            ...TRAM_CHE_BIEN_HOP_LE.map((tr) => `t:${tenantId}:station:${tr}`),
        ]);
    } else if (vaiTro === 2) {
        socket.join(roomTen(tenantId, 'barista'));
    } else if (vaiTro === 3) {
        socket.join(roomTen(tenantId, 'phucvu'));
    } else if (vaiTro === 4) {
        socket.join(roomTen(tenantId, 'thungan'));
    }

    // [Phân hệ 2 - Topology Room 3 tầng] Đăng ký cô lập nghiêm ngặt theo Tenant -> Branch -> Station / Role
    // Bảo mật L2.1: Xác thực role & branchId theo socket.user (JWT + DB), tuyệt đối không tin mù quáng từ client!
    const ALLOWED_SOCKET_ROLES = {
        1: ['KDS', 'EXPO', 'WAITER', 'POS', 'QR'],
        2: ['KDS', 'EXPO'],
        3: ['WAITER', 'EXPO', 'QR'],
        4: ['POS', 'QR', 'EXPO'],
    };
    const DEFAULT_SOCKET_ROLE = { 1: 'KDS', 2: 'KDS', 3: 'WAITER', 4: 'POS' };

    // [Wave 1 — P0-01] Soft-Lock bàn đang mở modal thanh toán qua Socket (TTL 45s)
    if (!io._tableCheckoutLocks) io._tableCheckoutLocks = new Map();
    const broadcastTableLocks = () => {
        const now = Date.now();
        const active = [];
        for (const [key, entry] of io._tableCheckoutLocks.entries()) {
            if (entry.expiresAt <= now) {
                io._tableCheckoutLocks.delete(key);
                continue;
            }
            if (entry.tenantId === tenantId) active.push(entry);
        }
        io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('table:checkout_locks', active);
    };

    socket.on('table:checkout_lock', (payload = {}, ack) => {
        const maBan = String(payload?.maBan || '').trim();
        if (!maBan) return typeof ack === 'function' ? ack({ ok: false, message: 'Thiếu maBan' }) : undefined;
        const lockKey = `${tenantId}:${maBan}`;
        const now = Date.now();
        const existing = io._tableCheckoutLocks.get(lockKey);
        if (existing && existing.expiresAt > now && existing.socketId !== socket.id && existing.maNV !== socket.user.maNV) {
            const reply = {
                ok: false,
                code: 'TABLE_CHECKOUT_LOCKED',
                lockedBy: existing.tenNV || existing.maNV,
                expiresAt: existing.expiresAt,
            };
            if (typeof ack === 'function') ack(reply);
            return;
        }
        const entry = {
            tenantId,
            maBan,
            maNV: socket.user.maNV,
            tenNV: socket.user.tenNV || socket.user.maNV,
            socketId: socket.id,
            expiresAt: now + 45 * 1000,
        };
        io._tableCheckoutLocks.set(lockKey, entry);
        broadcastTableLocks();
        if (typeof ack === 'function') ack({ ok: true, lock: entry });
    });

    socket.on('table:checkout_unlock', (payload = {}) => {
        const maBan = String(payload?.maBan || '').trim();
        if (!maBan) return;
        const lockKey = `${tenantId}:${maBan}`;
        const existing = io._tableCheckoutLocks.get(lockKey);
        if (existing && (existing.socketId === socket.id || existing.maNV === socket.user.maNV)) {
            io._tableCheckoutLocks.delete(lockKey);
            broadcastTableLocks();
        }
    });

    socket.on('disconnect', () => {
        let changed = false;
        for (const [k, entry] of io._tableCheckoutLocks.entries()) {
            if (entry.socketId === socket.id) {
                io._tableCheckoutLocks.delete(k);
                changed = true;
            }
        }
        if (changed) broadcastTableLocks();
    });

    socket.on('room:subscribe', (opts = {}, ack) => {
        const allowedRoles = ALLOWED_SOCKET_ROLES[vaiTro] || [];
        const requestedRole = String(opts?.role || '').trim().toUpperCase();
        const role = requestedRole || DEFAULT_SOCKET_ROLE[vaiTro] || 'KDS';

        if (!allowedRoles.includes(role)) {
            const errReply = {
                ok: false,
                code: 'FORBIDDEN_ROOM_ROLE',
                error: `Vai trò của bạn không được phép đăng ký phòng ${role}!`,
            };
            socket.emit('room:subscribe_error', errReply);
            if (typeof ack === 'function') ack(errReply);
            return;
        }

        const assignedBranch = socket.user.branchId ? normalizeBranchId(socket.user.branchId) : null;
        const requestedBranch = opts?.branchId ? normalizeBranchId(opts.branchId) : null;
        const isHqManager = vaiTro === 1 && (!assignedBranch || assignedBranch === 'DEFAULT' || assignedBranch === 'ALL');

        let branchId;
        if (isHqManager) {
            branchId = requestedBranch || assignedBranch || 'DEFAULT';
        } else {
            const authoritativeBranch = assignedBranch || 'DEFAULT';
            if (requestedBranch && requestedBranch !== authoritativeBranch) {
                const errReply = {
                    ok: false,
                    code: 'FORBIDDEN_BRANCH',
                    error: `Bạn không có quyền đăng ký phòng của chi nhánh ${requestedBranch}!`,
                };
                socket.emit('room:subscribe_error', errReply);
                if (typeof ack === 'function') ack(errReply);
                return;
            }
            branchId = authoritativeBranch;
        }

        const station = normalizeStation(opts?.station || opts?.tram || 'ALL');

        // Rời toàn bộ các phòng legacy & phòng 3 tầng cũ để đảm bảo cô lập tuyệt đối theo Branch + Station!
        for (const room of [...socket.rooms]) {
            if (room === socket.id || room === `t:${tenantId}:user:${socket.user.maNV}`) continue;
            socket.leave(room);
        }

        const joinedRooms = [];
        const addRoom = (r) => {
            socket.join(r);
            joinedRooms.push(r);
        };

        if (role === 'EXPO') {
            addRoom(roomBranchExpo(tenantId, branchId));
        } else if (role === 'WAITER') {
            addRoom(roomBranchWaiter(tenantId, branchId));
        } else if (role === 'POS') {
            addRoom(roomBranchPos(tenantId, branchId));
        } else if (role === 'QR') {
            addRoom(roomBranchQr(tenantId, branchId));
        } else {
            // Mặc định KDS theo trạm pha chế cụ thể (hoặc ALL cho màn hình KDS tổng của đúng Chi nhánh)
            if (station === 'ALL') {
                for (const st of VALID_STATIONS) addRoom(roomBranchKds(tenantId, branchId, st));
                addRoom(roomBranchKds(tenantId, branchId, 'ALL'));
            } else {
                addRoom(roomBranchKds(tenantId, branchId, station));
            }
        }

        const reply = {
            ok: true,
            tenantId,
            branchId,
            station,
            role,
            rooms: joinedRooms,
            serverNowMs: Date.now(),
        };
        socket.emit('room:subscribed', reply);
        if (typeof ack === 'function') ack(reply);
    });

    // Cho phép màn hình KDS Barista đăng ký nhận thông báo theo Trạm pha chế / Bếp (legacy)
    socket.on('CHON_TRAM_KDS', (tram) => {
        if (vaiTro !== 1 && vaiTro !== 2) return;
        for (const tr of TRAM_CHE_BIEN_HOP_LE) {
            socket.leave(`t:${tenantId}:station:${tr}`);
        }
        const cleanTram = String(tram || '').trim().toUpperCase();
        if (TRAM_CHE_BIEN_HOP_LE.includes(cleanTram)) {
            socket.join(`t:${tenantId}:station:${cleanTram}`);
        } else {
            for (const tr of TRAM_CHE_BIEN_HOP_LE) {
                socket.join(`t:${tenantId}:station:${tr}`);
            }
        }
    });
});

// ==========================================
// PHÂN HỆ: XÁC THỰC (AUTH - MULTI-TENANT JWT + REFRESH TOKEN ROTATION + STORE DEVICE SESSION)
// ==========================================
function kyAccessToken({
    maNV,
    vaiTro,
    permissionsOverride = {},
    tenantId = 'DEFAULT',
    maTienTo = 'DEF',
    tenQuan = 'Quán Cà Phê POS',
    goiCuoc = 'PRO',
    trangThaiGoi = 'ACTIVE',
}) {
    return jwt.sign(
        {
            maNV,
            vaiTro: Number(vaiTro),
            permissionsOverride,
            tenantId,
            maTienTo,
            tenQuan,
            goiCuoc,
            trangThaiGoi,
        },
        process.env.JWT_SECRET,
        { expiresIn: ACCESS_TOKEN_TTL }
    );
}

async function taoVaGanRefreshTokenCookie({
    req,
    res,
    tenantId,
    maNV,
    deviceId = null,
    deviceLabel = null,
    rememberDevice = false,
}) {
    const rawRefresh = generateRefreshToken();
    const tokenHash = hashRefreshToken(rawRefresh);
    const familyId = `FAM_${crypto.randomBytes(12).toString('hex')}`;
    const ttlDays = rememberDevice ? REFRESH_TTL_DEVICE_DAYS : REFRESH_TTL_STANDARD_DAYS;
    const expiresAt = new Date(Date.now() + ttlDays * 86400 * 1000);
    const cleanDeviceId = String(deviceId || req.headers['x-device-id'] || '').trim().slice(0, 64) || null;
    const cleanDeviceLabel = String(deviceLabel || '').trim().slice(0, 120) || null;
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 300) || null;

    try {
        await pool.query(
            `SELECT public.fn_create_refresh_token($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10)`,
            [
                tokenHash,
                familyId,
                String(tenantId || 'DEFAULT'),
                String(maNV),
                cleanDeviceId,
                cleanDeviceLabel,
                Boolean(rememberDevice),
                expiresAt.toISOString(),
                userAgent,
                req.ip || null,
            ]
        );
        setRefreshCookie(res, req, rawRefresh, ttlDays * 86400);
        return { issued: true, expiresAt: expiresAt.toISOString(), isStoreDeviceSession: Boolean(rememberDevice) };
    } catch (err) {
        // Tương thích ngược nếu Migration 019 chưa được chạy trên môi trường DB cũ
        logger.warn('Chưa lưu được Refresh Token (có thể chưa chạy Migration 019)', {
            event: 'REFRESH_TOKEN_CREATE_FALLBACK',
            error: err?.message,
        });
        return { issued: false, expiresAt: null, isStoreDeviceSession: false };
    }
}

async function xoayVongRefreshTokenCookie({ req, res, oldRawToken, newMaNV = null, isStoreDevice = false }) {
    const oldHash = hashRefreshToken(oldRawToken);
    const newRaw = generateRefreshToken();
    const newHash = hashRefreshToken(newRaw);
    const ttlDays = isStoreDevice ? REFRESH_TTL_DEVICE_DAYS : REFRESH_TTL_STANDARD_DAYS;
    const newExpires = new Date(Date.now() + ttlDays * 86400 * 1000);
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 300) || null;

    const rotRes = await pool.query(
        `SELECT public.fn_rotate_refresh_token($1, $2, $3::timestamptz, $4, $5, $6) AS ok`,
        [oldHash, newHash, newExpires.toISOString(), newMaNV ? String(newMaNV) : null, userAgent, req.ip || null]
    );
    if (rotRes.rows[0]?.ok !== true) {
        return { ok: false };
    }
    setRefreshCookie(res, req, newRaw, ttlDays * 86400);
    return { ok: true, expiresAt: newExpires.toISOString() };
}

function phanTichDangNhapVaMaQuan(tenDangNhapRaw, maQuanRaw = '') {
    const cleanInput = String(tenDangNhapRaw || '').trim();
    let username = cleanInput;
    let tenantSlug = String(maQuanRaw || '').trim();

    // Hỗ trợ cú pháp nhanh: thungan1@slug-quan (khi không nhập ô Mã quán riêng)
    if (!tenantSlug && cleanInput.includes('@')) {
        const atIdx = cleanInput.lastIndexOf('@');
        const left = cleanInput.slice(0, atIdx).trim();
        const right = cleanInput.slice(atIdx + 1).trim();
        // Chỉ tách nếu không giống email domain có dấu chấm ở phần sau (vd .com/.vn)
        if (left && right && !right.includes('.')) {
            username = left;
            tenantSlug = right;
        }
    }
    return { username, tenantSlug: tenantSlug || null };
}

// [PHÂN HỆ 9] Tra cứu công khai thông tin quán cho trang đăng nhập riêng (/login?shop=<slug-hoac-ma-quan>)
app.get('/api/auth/shop/:shopCode', async (req, res) => {
    const shopCode = String(req.params.shopCode || '').trim().slice(0, 100);
    if (!shopCode) {
        return res.status(400).json({ message: 'Vui lòng cung cấp mã quán hoặc đường dẫn quán!' });
    }
    try {
        let row = null;
        try {
            const r = await pool.query('SELECT * FROM public.fn_lookup_tenant_public($1)', [shopCode]);
            row = r.rows[0] || null;
        } catch {
            const r = await pool.query(
                `SELECT TenantId, MaTienTo, TenQuan, Slug, GoiCuoc, TrangThai
                   FROM Tenants
                  WHERE LOWER(COALESCE(Slug, '')) = LOWER($1)
                     OR UPPER(COALESCE(MaTienTo, '')) = UPPER($1)
                     OR UPPER(TenantId) = UPPER($1)
                  LIMIT 1`,
                [shopCode]
            );
            row = r.rows[0] || null;
        }
        if (!row) {
            return res.status(404).json({ message: `Không tìm thấy quán với mã "${shopCode}"!` });
        }
        res.json({
            tenantId: row.tenantid,
            maTienTo: row.matiento || 'DEF',
            tenQuan: row.tenquan,
            slug: row.slug || shopCode.toLowerCase(),
            goiCuoc: row.goicuoc || 'PRO',
            trangThai: row.trangthai || 'ACTIVE',
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Tra cứu quán:');
    }
});

app.post('/api/auth/login', gioiHanDangNhap, async (req, res) => {
    const {
        tenDangNhap,
        matKhau,
        maQuan = '',
        tenantSlug: tenantSlugBody = '',
        deviceId = null,
        deviceLabel = null,
        rememberDevice = true,
    } = req.body || {};
    if (
        typeof tenDangNhap !== 'string' || typeof matKhau !== 'string' ||
        !tenDangNhap.trim() || !matKhau || tenDangNhap.length > 160 || matKhau.length > 128
    ) {
        return res.status(400).json({ message: 'Vui lòng nhập Email / SĐT / Tên đăng nhập và mật khẩu hợp lệ!' });
    }

    const { username, tenantSlug } = phanTichDangNhapVaMaQuan(tenDangNhap, maQuan || tenantSlugBody);

    try {
        let result;
        try {
            // Ưu tiên hàm SECURITY DEFINER V2 (Phân hệ 9: Chủ quán bằng Email/SĐT duy nhất toàn hệ thống; NV theo /login?shop=slug hoặc Mã quán)
            result = await pool.query('SELECT * FROM public.fn_lookup_login_user_v2($1, $2)', [username, tenantSlug]);
        } catch {
            try {
                // Fallback Phân hệ 7: 2 tham số
                result = await pool.query('SELECT * FROM public.fn_lookup_login_user($1, $2)', [username, tenantSlug]);
            } catch {
                try {
                    // Fallback tương thích bản Migration 004 (1 tham số)
                    result = await pool.query('SELECT * FROM public.fn_lookup_login_user($1)', [username]);
                } catch {
                    try {
                        result = await pool.query(
                            `SELECT nv.MaNV, nv.TenNV, nv.VaiTro, nv.MatKhauHash,
                                    COALESCE(nv.TenantId, 'DEFAULT') AS TenantId,
                                    COALESCE(t.MaTienTo, 'DEF') AS MaTienTo,
                                    COALESCE(t.TenQuan, 'Quán Cà Phê POS') AS TenQuan,
                                    COALESCE(t.Slug, 'default-cafe') AS TenantSlug,
                                    COALESCE(t.GoiCuoc, 'PRO') AS GoiCuoc,
                                    COALESCE(t.TrangThai, 'ACTIVE') AS TrangThaiGoi,
                                    t.TrialEndsAt,
                                    t.SubscriptionEndsAt
                               FROM NhanVien nv
                               LEFT JOIN Tenants t ON t.TenantId = COALESCE(nv.TenantId, 'DEFAULT')
                              WHERE LOWER(nv.TenDangNhap) = LOWER($1) AND nv.TrangThaiLamViec = TRUE
                                AND ($2::text IS NULL OR LOWER(COALESCE(t.Slug, '')) = LOWER($2) OR UPPER(COALESCE(t.MaTienTo, '')) = UPPER($2) OR UPPER(COALESCE(nv.TenantId, 'DEFAULT')) = UPPER($2))
                              LIMIT 2`,
                            [username, tenantSlug]
                        );
                    } catch (schemaErr) {
                        // Tương thích ngược nếu bảng Tenants / cột TenantId chưa kịp khởi tạo khi server vừa boot
                        logger.warn('Login fallback về schema gốc (chưa có Tenants/TenantId)', { error: schemaErr.message });
                        result = await pool.query(
                            `SELECT MaNV, TenNV, VaiTro, MatKhauHash
                               FROM NhanVien
                              WHERE LOWER(TenDangNhap) = LOWER($1) AND TrangThaiLamViec = TRUE
                              LIMIT 2`,
                            [username]
                        );
                    }
                }
            }
        }

        // Nếu có từ 2 quán trở lên dùng chung tên đăng nhập (vd: thungan) mà người dùng chưa nhập Mã quán -> yêu cầu nhập Mã quán / link riêng
        if (result.rows.length > 1 && !tenantSlug) {
            return res.status(409).json({
                code: 'AMBIGUOUS_TENANT_LOGIN',
                message: `Tên đăng nhập "${username}" tồn tại ở nhiều quán. Nhân viên vui lòng mở đường dẫn riêng (/login?shop=ma-quan) hoặc nhập thêm Mã quán; Chủ quán có thể đăng nhập bằng Email / SĐT!`,
            });
        }

        const user = result.rows[0];
        const { ok, canBamLai } = await verifyPassword(matKhau, user ? user.matkhauhash : null);

        if (!user || !ok) {
            ghiNhanDangNhapSai(req, tenDangNhap);
            return res.status(401).json({ message: 'Sai tài khoản, mật khẩu hoặc tài khoản đã bị khóa!' });
        }
        xoaDangNhapSai(req, tenDangNhap);

        if (canBamLai) {
            try {
                await pool.queryTenant(
                    user.tenantid || 'DEFAULT',
                    'UPDATE NhanVien SET MatKhauHash = $1 WHERE MaNV = $2 AND MatKhauHash = $3',
                    [await hashPassword(matKhau), user.manv, user.matkhauhash]
                );
            } catch (error) {
                logger.warn(`Chưa nâng cấp được hash mật khẩu cho NV ${user.manv}`, { error: error.message });
            }
        }

        const tenantId = user.tenantid || 'DEFAULT';
        let permissionsOverride = {};
        try {
            const permRes = await pool.withTenant(tenantId, (client) =>
                client.query(
                    `SELECT COALESCE((to_jsonb(NhanVien)->'permissionsoverride')::jsonb, '{}'::jsonb) AS Perms
                       FROM NhanVien WHERE MaNV = $1 LIMIT 1`,
                    [user.manv]
                )
            );
            if (permRes.rows[0]?.perms && typeof permRes.rows[0].perms === 'object') {
                permissionsOverride = permRes.rows[0].perms;
            }
        } catch {
            // ignore if column not yet migrated
        }
        const ent = await layEntitlementTenant(pool, tenantId);
        const subscription = danhGiaTrangThaiGoi({
            tenantId,
            goiCuoc: ent.goiCuoc || user.goicuoc || 'PRO',
            trangThai: user.trangthaigoi || 'ACTIVE',
            trialEndsAt: user.trialendsat || null,
            subscriptionEndsAt: user.subscriptionendsat || null,
        });
        const resolvedSlug = user.slug || user.tenantslug || null;

        // Cập nhật LastLoginAt (không chặn luồng đăng nhập nếu Migration 020 chưa chạy)
        pool.query('SELECT public.fn_touch_login_activity($1, $2)', [user.manv, tenantId]).catch(() => {});

        const token = kyAccessToken({
            maNV: user.manv,
            vaiTro: user.vaitro,
            permissionsOverride,
            tenantId,
            maTienTo: user.matiento || 'DEF',
            slug: resolvedSlug,
            tenQuan: user.tenquan || 'Quán Cà Phê POS',
            goiCuoc: ent.goiCuoc || user.goicuoc || 'PRO',
            trangThaiGoi: subscription.trangThai,
        });

        // Cấp Refresh Token Rotation trong HttpOnly Cookie (mặc định bật Store Device Session cho máy quầy POS)
        const refreshMeta = await taoVaGanRefreshTokenCookie({
            req,
            res,
            tenantId,
            maNV: user.manv,
            deviceId,
            deviceLabel,
            rememberDevice: Boolean(rememberDevice),
        });

        res.json({
            message: 'Đăng nhập thành công',
            token,
            accessTokenExpiresIn: ACCESS_TOKEN_TTL,
            deviceSession: refreshMeta,
            user: {
                maNV: user.manv,
                tenNV: user.tennv,
                vaiTro: user.vaitro,
                email: user.email || null,
                soDienThoai: user.sodienthoai || null,
                laCaTruong: Boolean(permissionsOverride?.isShiftSupervisor),
                permissionsOverride,
                tenantId,
                maTienTo: user.matiento || 'DEF',
                tenQuan: user.tenquan || 'Quán Cà Phê POS',
                slug: resolvedSlug,
                tenantSlug: resolvedSlug,
                goiCuoc: ent.goiCuoc || user.goicuoc || 'PRO',
                featureFlags: ent.flags,
                subscription,
            },
        });
    } catch (error) {
        captureException(error, { route: '/api/auth/login', requestId: req.requestId });
        res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
    }
});

// [Phân hệ 7] Refresh Token Rotation (HttpOnly Cookie -> cấp Access Token mới + xoay vòng cookie mới + phát hiện Reuse Token)
app.post('/api/auth/refresh', async (req, res) => {
    const rawRefresh = getRefreshCookie(req);
    if (!rawRefresh) {
        return res.status(401).json({ code: 'NO_REFRESH_COOKIE', message: 'Chưa có phiên thiết bị (Refresh Cookie)!' });
    }

    try {
        const tokenHash = hashRefreshToken(rawRefresh);
        const lookupRes = await pool.query('SELECT * FROM public.fn_lookup_refresh_token($1)', [tokenHash]);
        const row = lookupRes.rows[0];

        if (!row) {
            clearRefreshCookie(res, req);
            return res.status(401).json({ code: 'INVALID_REFRESH_TOKEN', message: 'Phiên đăng nhập không hợp lệ!' });
        }

        // Reuse Detection: Nếu token đã bị thu hồi trước đó mà vẫn được gửi lại -> thu hồi toàn bộ chuỗi FamilyId!
        if (row.revokedat) {
            await pool.query('SELECT public.fn_revoke_refresh_family($1)', [row.familyid]).catch(() => {});
            clearRefreshCookie(res, req);
            logger.warn('Phát hiện tái sử dụng Refresh Token đã thu hồi — đã khóa toàn bộ family', {
                event: 'REFRESH_TOKEN_REUSE_DETECTED',
                tenantId: row.tenantid,
                maNV: row.manv,
                familyId: row.familyid,
                ip: req.ip,
            });
            return res.status(401).json({
                code: 'REFRESH_TOKEN_REUSED',
                message: 'Phát hiện phiên bất thường! Vui lòng đăng nhập lại để đảm bảo an toàn.',
            });
        }

        if (new Date(row.expiresat).getTime() <= Date.now()) {
            clearRefreshCookie(res, req);
            return res.status(401).json({ code: 'REFRESH_TOKEN_EXPIRED', message: 'Phiên thiết bị đã hết hạn, vui lòng đăng nhập lại!' });
        }

        if (!row.trangthailamviec) {
            await pool.query('SELECT public.fn_revoke_refresh_family($1)', [row.familyid]).catch(() => {});
            clearRefreshCookie(res, req);
            return res.status(401).json({ code: 'STAFF_DISABLED', message: 'Tài khoản nhân viên đã bị khóa hoặc ngừng làm việc!' });
        }

        const rotated = await xoayVongRefreshTokenCookie({
            req,
            res,
            oldRawToken: rawRefresh,
            isStoreDevice: Boolean(row.isstoredevicesession),
        });
        if (!rotated.ok) {
            clearRefreshCookie(res, req);
            return res.status(401).json({ code: 'REFRESH_ROTATION_FAILED', message: 'Không thể gia hạn phiên, vui lòng đăng nhập lại!' });
        }

        const tenantId = row.tenantid || 'DEFAULT';
        const perms = row.permissionsoverride && typeof row.permissionsoverride === 'object' ? row.permissionsoverride : {};
        const subscription = danhGiaTrangThaiGoi({
            tenantId,
            trangThai: row.trangthaigoi || 'ACTIVE',
            trialEndsAt: row.trialendsat || null,
            subscriptionEndsAt: row.subscriptionendsat || null,
        });
        const ent = await layEntitlementTenant(pool, tenantId);
        const token = kyAccessToken({
            maNV: row.manv,
            vaiTro: row.vaitro,
            permissionsOverride: perms,
            tenantId,
            maTienTo: row.matiento || 'DEF',
            tenQuan: row.tenquan || 'Quán Cà Phê POS',
            goiCuoc: ent.goiCuoc || row.goicuoc || 'PRO',
            trangThaiGoi: subscription.trangThai,
        });

        res.json({
            message: 'Gia hạn phiên thành công',
            token,
            accessTokenExpiresIn: ACCESS_TOKEN_TTL,
            deviceSession: {
                active: true,
                isStoreDeviceSession: Boolean(row.isstoredevicesession),
                expiresAt: rotated.expiresAt,
            },
            user: {
                maNV: row.manv,
                tenNV: row.tennv,
                vaiTro: Number(row.vaitro),
                laCaTruong: Boolean(perms?.isShiftSupervisor),
                permissionsOverride: perms,
                tenantId,
                maTienTo: row.matiento || 'DEF',
                tenQuan: row.tenquan || 'Quán Cà Phê POS',
                tenantSlug: row.tenantslug || null,
                goiCuoc: ent.goiCuoc || row.goicuoc || 'PRO',
                featureFlags: ent.flags,
                subscription,
            },
        });
    } catch (error) {
        captureException(error, { route: '/api/auth/refresh', requestId: req.requestId });
        res.status(500).json({ message: 'Không thể gia hạn phiên đăng nhập!' });
    }
});

// [Phân hệ 7] Đăng xuất chuẩn: Thu hồi Refresh Token trên DB + Xóa HttpOnly Cookie
app.post('/api/auth/logout', async (req, res) => {
    const rawRefresh = getRefreshCookie(req);
    if (rawRefresh) {
        try {
            await pool.query('SELECT public.fn_revoke_refresh_token($1)', [hashRefreshToken(rawRefresh)]);
        } catch {
            // ignore if table not migrated yet
        }
    }
    clearRefreshCookie(res, req);
    res.json({ message: 'Đã đăng xuất an toàn!' });
});

// [Phân hệ 7] Fast Store Device Session: Kiểm tra máy quầy đã đăng nhập sẵn bằng HttpOnly Cookie để nhân viên mở khóa / chuyển ca nhanh bằng mã PIN
app.get('/api/auth/device-session', async (req, res) => {
    const rawRefresh = getRefreshCookie(req);
    if (!rawRefresh) {
        return res.json({ active: false, staff: [] });
    }
    try {
        const lookupRes = await pool.query('SELECT * FROM public.fn_lookup_refresh_token($1)', [hashRefreshToken(rawRefresh)]);
        const row = lookupRes.rows[0];
        if (!row || row.revokedat || new Date(row.expiresat).getTime() <= Date.now()) {
            return res.json({ active: false, staff: [] });
        }
        const tenantId = row.tenantid || 'DEFAULT';
        const staffRows = await pool.withTenant(tenantId, async (client) => {
            const r = await client.query(
                `SELECT MaNV, TenNV, VaiTro, (PinHash IS NOT NULL AND PinHash <> '') AS DaDatPin
                   FROM NhanVien
                  WHERE COALESCE(TenantId, 'DEFAULT') = $1
                    AND TrangThaiLamViec = TRUE
                  ORDER BY VaiTro ASC, TenNV ASC`,
                [tenantId]
            );
            return r.rows;
        });
        res.json({
            active: true,
            isStoreDeviceSession: Boolean(row.isstoredevicesession),
            tenantId,
            tenQuan: row.tenquan || 'Quán Cà Phê POS',
            maTienTo: row.matiento || 'DEF',
            tenantSlug: row.tenantslug || null,
            lastStaff: { maNV: row.manv, tenNV: row.tennv, vaiTro: Number(row.vaitro) },
            staff: staffRows.map((s) => ({
                maNV: s.manv,
                tenNV: s.tennv,
                vaiTro: Number(s.vaitro),
                daDatPin: Boolean(s.dadatpin),
            })),
        });
    } catch {
        res.json({ active: false, staff: [] });
    }
});

// ==========================================
// PHÂN HỆ: BÁN HÀNG & THU NGÂN (POS)
// ==========================================
app.get('/api/ban', kiemTraToken, async (req, res) => {
    const tenantId = layTenantId(req);
    const branchIdFilter = req.query.branchId ? String(req.query.branchId).trim() : null;
    try {
        const result = await pool.withTenant(tenantId, async (client) => {
            const banRes = await client.query(
                `SELECT b.MaBan, b.TenBan, b.TrangThai, b.KhuVuc, b.ToaDoX, b.ToaDoY,
                        to_jsonb(b)->>'branchid' AS BranchId,
                        to_jsonb(b)->>'qrtoken' AS QrToken,
                        COALESCE((to_jsonb(b)->>'qryeucaumoban')::boolean, TRUE) AS QrYeuCauMoBan,
                        COALESCE((to_jsonb(b)->>'qrbatbuocvietqr')::boolean, FALSE) AS QrBatBuocVietQR,
                        hd_open.MaHoaDon AS MaHoaDonMo,
                        hd_open.ThoiGianMoBan AS ThoiGianMoBan,
                        hd_open.SoKhach AS SoKhach,
                        hd_open.Version AS Version,
                        hd_open.LastOrderAt AS LastOrderAt,
                        COALESCE(hd_open.TongMonKds, 0) AS TongMonKds,
                        COALESCE(hd_open.MonDaXongKds, 0) AS MonDaXongKds,
                        COALESCE(hd_open.MonDaPhucVuKds, 0) AS MonDaPhucVuKds,
                        COALESCE(hd_open.TongTamTinh, 0) AS TongTamTinh
                   FROM Ban b
                   LEFT JOIN LATERAL (
                       SELECT h.MaHoaDon,
                              COALESCE((to_jsonb(h)->>'thoigianmoban')::timestamptz, h.ThoiGianTao) AS ThoiGianMoBan,
                              COALESCE((to_jsonb(h)->>'sokhach')::int, 1) AS SoKhach,
                              COALESCE((to_jsonb(h)->>'version')::int, 1) AS Version,
                              (SELECT MAX(c.ThoiGianGoi) FROM ChiTietHoaDon c WHERE c.MaHoaDon = h.MaHoaDon AND c.TrangThaiPhaChe <> 'DaHuy') AS LastOrderAt,
                              (SELECT COUNT(*)::int FROM ChiTietHoaDon c WHERE c.MaHoaDon = h.MaHoaDon AND c.TrangThaiPhaChe <> 'DaHuy') AS TongMonKds,
                              (SELECT COUNT(*)::int FROM ChiTietHoaDon c WHERE c.MaHoaDon = h.MaHoaDon AND c.TrangThaiPhaChe IN ('DaXong', 'DaPhucVu')) AS MonDaXongKds,
                              (SELECT COUNT(*)::int FROM ChiTietHoaDon c WHERE c.MaHoaDon = h.MaHoaDon AND c.TrangThaiPhaChe = 'DaPhucVu') AS MonDaPhucVuKds,
                              COALESCE((
                                  SELECT SUM(CASE WHEN COALESCE((to_jsonb(c)->>'lamontang')::boolean, FALSE) THEN 0
                                             ELSE GREATEST(0, c.SoLuong * (c.DonGia + COALESCE((to_jsonb(c)->>'giamodifiers')::numeric, 0)) - COALESCE(c.GiaGiam, 0) - COALESCE((to_jsonb(c)->>'chietkhaumon')::numeric, 0)) END)
                                    FROM ChiTietHoaDon c
                                   WHERE c.MaHoaDon = h.MaHoaDon AND c.TrangThaiPhaChe <> 'DaHuy'
                              ), 0) + COALESCE((
                                  SELECT SUM(ctp.SoLuong * ctp.DonGia)
                                    FROM ChiTietHoaDon c
                                    JOIN ChiTietHoaDon_Topping ctp ON ctp.MaCTHD = c.MaCTHD
                                   WHERE c.MaHoaDon = h.MaHoaDon
                                     AND c.TrangThaiPhaChe <> 'DaHuy'
                                     AND NOT COALESCE((to_jsonb(c)->>'lamontang')::boolean, FALSE)
                              ), 0) AS TongTamTinh
                         FROM HoaDon_Ban hb
                         JOIN HoaDon h ON h.MaHoaDon = hb.MaHoaDon
                        WHERE hb.MaBan = b.MaBan
                          AND h.TrangThaiTT = 0
                          AND COALESCE(h.TenantId, 'DEFAULT') = $1
                        ORDER BY h.ThoiGianTao DESC
                        LIMIT 1
                   ) hd_open ON TRUE
                  WHERE b.DaXoa = FALSE
                    AND COALESCE(b.TenantId, 'DEFAULT') = $1
                    AND ($2::text IS NULL OR to_jsonb(b)->>'branchid' = $2)
                  ORDER BY b.TenBan`,
                [tenantId, branchIdFilter]
            );

            // Ghép thông tin Đặt bàn sắp đến trong vòng 45 phút (hoặc trễ dưới 20 phút)
            const resMap = new Map();
            try {
                await client.query('SAVEPOINT sp_ban_datban');
                const dbRes = await client.query(
                    `SELECT madatban, maban, tenkhach, sodienthoai, sokhach, thoigianden, tiencoc, ghichu
                       FROM datban
                      WHERE tenantid = $1
                        AND trangthai = 'CONFIRMED'
                        AND thoigianden >= now() - interval '20 minutes'
                        AND thoigianden <= now() + interval '45 minutes'
                      ORDER BY thoigianden ASC`,
                    [tenantId]
                );
                await client.query('RELEASE SAVEPOINT sp_ban_datban');
                for (const d of dbRes.rows) {
                    if (!resMap.has(d.maban)) {
                        resMap.set(d.maban, {
                            maDatBan: d.madatban,
                            tenKhach: d.tenkhach,
                            soDienThoai: d.sodienthoai,
                            soKhach: Number(d.sokhach || 2),
                            thoiGianDen: d.thoigianden,
                            tienCoc: Number(d.tiencoc || 0),
                            ghiChu: d.ghichu || null,
                        });
                    }
                }
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_ban_datban').catch(() => {});
            }

            return banRes.rows.map((r) => ({
                ...r,
                sokhach: Number(r.sokhach || 1),
                kdsProgress: {
                    tongMon: Number(r.tongmonkds || 0),
                    daXong: Number(r.mondaxongkds || 0),
                    daPhucVu: Number(r.mondaphucvukds || 0),
                },
                upcomingReservation: resMap.get(r.maban) || null,
            }));
        });
        res.json(result);
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lấy danh sách Bàn:');
    }
});

app.get('/api/sanpham', kiemTraToken, async (req, res) => {
    const tenantId = layTenantId(req);
    const branchId = normalizeBranchId(req.query.branchId || req.headers['x-branch-id'] || req.user?.branchId || 'DEFAULT');
    try {
        const { rows, bakeryMap, regionalPriceMap, modGroupsByMon, branch86 } = await pool.withTenant(tenantId, async (client) => {
            const spRes = await client.query(`
                SELECT sp.MaMon, sp.TenMon, sp.NhomMon, COALESCE(sp.TamHet, FALSE) AS TamHet,
                       to_jsonb(sp)->>'tramchebien' AS TramCheBien,
                       COALESCE((to_jsonb(sp)->>'lamonthoigia')::boolean, FALSE) AS LaMonThoiGia,
                       COALESCE(to_jsonb(sp)->>'donvibanhang', 'LY') AS DonViBanHang,
                       (to_jsonb(sp)->>'soluonggioihan86')::int AS SoLuongGioiHan86,
                       COALESCE((to_jsonb(sp)->>'tamhettudong')::boolean, FALSE) AS TamHetTuDong,
                       COALESCE((to_jsonb(sp)->>'lahangdonggoi')::boolean, FALSE) AS LaHangDongGoi,
                       COALESCE((to_jsonb(sp)->>'intemcoc')::boolean, TRUE) AS InTemCoc,
                       COALESCE(to_jsonb(sp)->>'tax_category_code', 'VAT_8_FB') AS TaxCategoryCode,
                       sz.KichThuoc, sz.GiaBan
                FROM SanPham sp
                JOIN SanPham_Size sz ON sp.MaMon = sz.MaMon
                WHERE sp.DangKinhDoanh = TRUE AND COALESCE(sp.TenantId, 'DEFAULT') = $1
                ORDER BY sp.NhomMon, sp.TenMon, sz.GiaBan
            `, [tenantId]);
            const bMap = await layBanDoGiamGiaLoBanhHomNay(client, tenantId);
            const b86 = await loadBranchAvailability86Map(client, tenantId, branchId);

            // Giá vùng theo Chi nhánh (SanPham_GiaVung)
            const rpMap = new Map();
            if (branchId) {
                await client.query('SAVEPOINT sp_sp_giavung');
                try {
                    const brRes = await client.query(
                        `SELECT khuvucgia FROM chinhanh WHERE tenantid = $1 AND branchid = $2 LIMIT 1`,
                        [tenantId, branchId]
                    );
                    const kvg = brRes.rows[0]?.khuvucgia;
                    if (kvg && kvg !== 'DEFAULT') {
                        const gvRes = await client.query(
                            `SELECT mamon, kichthuoc, giaban FROM sanpham_giavung WHERE tenantid = $1 AND khuvucgia = $2`,
                            [tenantId, kvg]
                        );
                        for (const gv of gvRes.rows) {
                            rpMap.set(`${gv.mamon}|${gv.kichthuoc}`, Number(gv.giaban));
                        }
                    }
                    await client.query('RELEASE SAVEPOINT sp_sp_giavung');
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_sp_giavung').catch(() => {});
                }
            }

            // Modifiers gắn theo từng món (Forced Modifiers + Smart Defaults)
            const mgByMon = new Map();
            await client.query('SAVEPOINT sp_sp_mods');
            try {
                const linkRes = await client.query(
                    `SELECT smg.mamon, mg.id, mg.tengroup, mg.loai, mg.batbuoc,
                            mg.chontoithieu, mg.chontoida, mg.soluongmienphi, smg.thutuhienthi
                       FROM sanpham_modifier_groups smg
                       JOIN modifier_groups mg ON mg.id = smg.groupid
                      WHERE smg.tenantid = $1 AND mg.danghoatdong = TRUE
                      ORDER BY smg.mamon, smg.thutuhienthi ASC, mg.thutuhienthi ASC`,
                    [tenantId]
                );
                if (linkRes.rows.length > 0) {
                    const gIds = [...new Set(linkRes.rows.map((r) => Number(r.id)))];
                    const optRes = await client.query(
                        `SELECT id, groupid, tenoption, teninngan, lamacdinh, giacongthem, toidasoluong, tamhet, thutuhienthi
                           FROM modifier_options
                          WHERE tenantid = $1 AND groupid = ANY($2::bigint[])
                          ORDER BY thutuhienthi ASC, id ASC`,
                        [tenantId, gIds]
                    );
                    const optsByG = new Map();
                    for (const o of optRes.rows) {
                        const gid = Number(o.groupid);
                        if (!optsByG.has(gid)) optsByG.set(gid, []);
                        optsByG.get(gid).push({
                            id: Number(o.id),
                            groupId: gid,
                            tenOption: o.tenoption,
                            tenInNgan: o.teninngan || o.tenoption,
                            laMacDinh: Boolean(o.lamacdinh),
                            giaCongThem: Number(o.giacongthem || 0),
                            toiDaSoLuong: Number(o.toidasoluong || 1),
                            tamHet: Boolean(o.tamhet),
                        });
                    }
                    for (const r of linkRes.rows) {
                        if (!mgByMon.has(r.mamon)) mgByMon.set(r.mamon, []);
                        mgByMon.get(r.mamon).push({
                            id: Number(r.id),
                            tenGroup: r.tengroup,
                            loai: r.loai,
                            batBuoc: Boolean(r.batbuoc),
                            chonToiThieu: Number(r.chontoithieu || 0),
                            chonToiDa: Number(r.chontoida || 1),
                            soLuongMienPhi: Number(r.soluongmienphi || 0),
                            options: optsByG.get(Number(r.id)) || [],
                        });
                    }
                }
                await client.query('RELEASE SAVEPOINT sp_sp_mods');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_sp_mods').catch(() => {});
            }

            return { rows: spRes.rows, bakeryMap: bMap, regionalPriceMap: rpMap, modGroupsByMon: mgByMon, branch86: b86 };
        });

        const menu = [];
        const map = new Map();
        rows.forEach(row => {
            const md = bakeryMap.get(row.mamon);
            const bProd = branch86?.products?.get(String(row.mamon));
            if (!map.has(row.mamon)) {
                const modGroups = (modGroupsByMon.get(row.mamon) || []).map((g) => ({
                    ...g,
                    options: (g.options || []).map((o) => {
                        const bMod = branch86?.modifiers?.get(String(o.id));
                        return bMod ? { ...o, tamHet: Boolean(bMod.isSoldOut) } : o;
                    }),
                }));
                const newItem = {
                    maMon: row.mamon,
                    tenMon: row.tenmon,
                    nhomMon: row.nhommon,
                    tramCheBien: suyLuanTramCheBien({
                        tramCheBien: row.tramchebien,
                        nhomMon: row.nhommon,
                        tenMon: row.tenmon,
                    }),
                    tamHet: bProd !== undefined ? Boolean(bProd.isSoldOut) : Boolean(row.tamhet),
                    soLuongGioiHan86:
                        bProd && bProd.dailyRemainingQty !== null
                            ? bProd.dailyRemainingQty
                            : row.soluonggioihan86 !== null && row.soluonggioihan86 !== undefined
                              ? Number(row.soluonggioihan86)
                              : null,
                    tamHetTuDong: bProd !== undefined ? Boolean(bProd.isAutoCascaded) : Boolean(row.tamhettudong),
                    laHangDongGoi: Boolean(row.lahangdonggoi),
                    inTemCoc: row.intemcoc !== false,
                    laMonThoiGia: Boolean(row.lamonthoigia),
                    donViBanHang: row.donvibanhang || 'LY',
                    taxCategoryCode: row.taxcategorycode || 'VAT_8_FB',
                    modifierGroups: modGroups,
                    bakeryMarkdown: md?.dangGiamGia
                        ? {
                              phanTramGiam: md.phanTramGiam,
                              gioGiamGia: md.gioGiamGia,
                              soLuongConLai: md.soLuongConLai,
                              giaSauGiam: md.giaHienTai,
                          }
                        : null,
                    sizes: [],
                };
                map.set(row.mamon, newItem);
                menu.push(newItem);
            }
            const regionalPrice = regionalPriceMap.get(`${row.mamon}|${row.kichthuoc}`);
            const giaGoc = regionalPrice !== undefined ? regionalPrice : parseFloat(row.giaban);
            const giaHienTai = md?.dangGiamGia
                ? Math.round((giaGoc * (100 - md.phanTramGiam)) / 100 / 500) * 500
                : giaGoc;
            map.get(row.mamon).sizes.push({ kichThuoc: row.kichthuoc, giaBan: giaHienTai, giaGoc });
        });
        res.json(menu);
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lấy Thực đơn:');
    }
});

function validateDanhSachMon(danhSachMon, combos = []) {
    const hasMon = Array.isArray(danhSachMon) && danhSachMon.length > 0;
    const hasCombo = Array.isArray(combos) && combos.length > 0;
    if (!hasMon && !hasCombo) {
        return 'Danh sách món hoặc Combo không được để trống!';
    }
    for (const mon of danhSachMon || []) {
        if (!mon || !mon.maMon || !SIZE_HOP_LE.includes(mon.kichThuoc) || !Number.isInteger(mon.soLuong) || mon.soLuong <= 0) {
            return 'Mỗi món cần có maMon, kichThuoc (S/M/L) và soLuong là số nguyên > 0!';
        }
        for (const tp of mon.toppings || []) {
            const sl = tp && tp.soLuongMoiLy !== undefined ? tp.soLuongMoiLy : tp && tp.soLuong === undefined ? 1 : tp && tp.soLuong;
            if (!tp || !tp.maTopping || !Number.isInteger(sl) || sl <= 0) {
                return 'Mỗi topping cần có maTopping và soLuongMoiLy là số nguyên > 0!';
            }
        }
    }
    return null;
}

// [Phân hệ 1 - 100/100] Cấp số thứ tự theo ngày nguyên tử KHÔNG quay vòng ở 99 (001..999+)
async function capSoThuTuNgayNguyenTu(client, tenantId = 'DEFAULT') {
    const { seq } = await capSoThuTuNgayKhongTrung(client, tenantId);
    return seq;
}

async function taoOrderTrongGiaoDich(
    client,
    {
        tenantId = 'DEFAULT',
        branchId = null,
        maNV,
        vaiTro = null,
        maBan = null,
        maHoaDon: maHoaDonGoc = null,
        maKH = null,
        soTheRung = null,
        loaiDonHang = null,
        tenKhachVangLai = null,
        diaChiGiao = null,
        soKhach = 1,
        phiDongGoi = null,
        phiDongGoiMoiLy = 0,
        cachTinhThue = null,
        thueVATPhanTram = null,
        phiPhucVuPhanTram = null,
        expectedVersion = null,
        clientOrderUid = null,
        laOfflineSync = false,
        offlineCreatedAt = null,
        danhSachMon = [],
        combos = [],
        allowNegativeStock = ALLOW_NEGATIVE_STOCK,
        ip = null,
    }
) {
    const soldOutWarnings = [];
    const countdownUpdates = [];
    const openItemAuditRows = [];

    // 0. Xác định KhuVucGia theo Branch (ưu tiên giá vùng SanPham_GiaVung) & Lô bánh giảm giá (LoBanhNgay)
    let khuVucGia = 'DEFAULT';
    if (branchId) {
        await client.query('SAVEPOINT sp_ord_branch');
        try {
            const brRes = await client.query(
                `SELECT khuvucgia FROM chinhanh WHERE tenantid = $1 AND branchid = $2 LIMIT 1`,
                [tenantId, branchId]
            );
            khuVucGia = brRes.rows[0]?.khuvucgia || 'DEFAULT';
            await client.query('RELEASE SAVEPOINT sp_ord_branch');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_ord_branch').catch(() => {});
        }
    }
    const bakeryMap = await layBanDoGiamGiaLoBanhHomNay(client, tenantId);

    // 0.5. Mở rộng danh sách Combo (nếu có) thành các dòng món con kèm giá phân bổ Pro-rata 0đ sai số
    const expandedInputItems = [...(Array.isArray(danhSachMon) ? danhSachMon : [])];
    if (Array.isArray(combos) && combos.length > 0) {
        const comboCodes = [...new Set(combos.map((c) => String(c.maCombo || '').trim().toUpperCase()).filter(Boolean))];
        const cmbRes = await client.query(
            `SELECT macombo, tencombo, giabancombo, dangkinhdoanh,
                    COALESCE((to_jsonb(combo)->>'tamhet')::boolean, FALSE) AS tamhet
               FROM combo WHERE tenantid = $1 AND macombo = ANY($2::varchar[])`,
            [tenantId, comboCodes]
        );
        const comboMap = new Map(cmbRes.rows.map((r) => [r.macombo, r]));
        const slotRes = await client.query(
            `SELECT cs.id AS slotid, cs.macombo, cs.tenslot, cs.soluongchon,
                    csi.mamon, csi.kichthuocmacdinh, csi.chophepdoikichthuoc, csi.phuthu
               FROM combo_slots cs
               JOIN combo_slot_items csi ON csi.slotid = cs.id
              WHERE cs.tenantid = $1 AND cs.macombo = ANY($2::varchar[])`,
            [tenantId, comboCodes]
        );
        const slotItemLookup = new Map(); // `${maCombo}|${slotId}|${maMon}` -> row
        const slotItemByMon = new Map(); // `${maCombo}|${maMon}` -> row
        for (const r of slotRes.rows) {
            slotItemLookup.set(`${r.macombo}|${r.slotid}|${r.mamon}`, r);
            if (!slotItemByMon.has(`${r.macombo}|${r.mamon}`)) {
                slotItemByMon.set(`${r.macombo}|${r.mamon}`, r);
            }
        }

        // Tải bảng giá lẻ cho tất cả món trong combo để tính Pro-rata & phụ thu nâng size
        const comboMons = [...new Set(combos.flatMap((c) => (c.selections || c.items || []).map((s) => s.maMon)).filter(Boolean))];
        const cmbGiaRes = await client.query(
            `SELECT sz.MaMon, sz.KichThuoc, sz.GiaBan
               FROM SanPham_Size sz JOIN SanPham sp ON sp.MaMon = sz.MaMon
              WHERE COALESCE(sp.TenantId, 'DEFAULT') = $2 AND sz.MaMon = ANY($1::varchar[])`,
            [comboMons, tenantId]
        );
        const cmbGiaMap = new Map(cmbGiaRes.rows.map((r) => [`${r.mamon}|${r.kichthuoc}`, Number(r.giaban)]));

        for (const cmbReq of combos) {
            const code = String(cmbReq.maCombo || '').trim().toUpperCase();
            const cmbDef = comboMap.get(code);
            if (!cmbDef || !cmbDef.dangkinhdoanh) {
                throw new LoiNghiepVu(400, `Combo "${code}" không tồn tại hoặc đã ngừng kinh doanh!`);
            }
            if (cmbDef.tamhet && !laOfflineSync) {
                throw new LoiNghiepVu(409, `Combo "${cmbDef.tencombo}" hiện đang tạm hết (86'd do thiếu món con)!`, {
                    maLoi: 'COMBO_TAM_HET',
                });
            }
            const sels = Array.isArray(cmbReq.selections) ? cmbReq.selections : Array.isArray(cmbReq.items) ? cmbReq.items : [];
            if (sels.length === 0) {
                throw new LoiNghiepVu(400, `Combo "${cmbDef.tencombo}" chưa chọn món con nào!`);
            }
            const comboQty = Math.max(1, Math.floor(Number(cmbReq.soLuong || 1)));

            // Với mỗi bộ Combo, cấp 1 comboGroupUid duy nhất để phá vỡ độc lập nếu hủy 1 món con
            for (let copyIdx = 0; copyIdx < comboQty; copyIdx += 1) {
                const comboGroupUid = taoComboGroupUid();
                const proRataInput = sels.map((sel) => {
                    const rule =
                        (sel.slotId ? slotItemLookup.get(`${code}|${sel.slotId}|${sel.maMon}`) : null) ||
                        slotItemByMon.get(`${code}|${sel.maMon}`);
                    if (!rule) {
                        throw new LoiNghiepVu(400, `Món ${sel.maMon} không nằm trong danh sách hợp lệ của Combo "${cmbDef.tencombo}"!`);
                    }
                    const defaultSz = rule.kichthuocmacdinh || 'M';
                    const chosenSz = sel.kichThuoc && SIZE_HOP_LE.includes(sel.kichThuoc) ? sel.kichThuoc : defaultSz;
                    if (chosenSz !== defaultSz && !rule.chophepdoikichthuoc) {
                        throw new LoiNghiepVu(400, `Món ${sel.maMon} trong Combo "${cmbDef.tencombo}" không cho phép đổi kích thước!`);
                    }
                    const giaLeDefault = cmbGiaMap.get(`${sel.maMon}|${defaultSz}`) ?? 0;
                    const giaLeChosen = cmbGiaMap.get(`${sel.maMon}|${chosenSz}`) ?? giaLeDefault;
                    const phuThuNangSize = Math.max(0, giaLeChosen - giaLeDefault);
                    return {
                        ...sel,
                        maMon: sel.maMon,
                        kichThuoc: chosenSz,
                        soLuong: 1,
                        giaLeCoBan: giaLeDefault,
                        giaLeThucTe: giaLeChosen,
                        phuThuSlot: Number(rule.phuthu || 0),
                        phuThuNangSize,
                    };
                });

                const distributed = phanBoGiaComboProRata(Number(cmbDef.giabancombo), proRataInput);
                for (const child of distributed) {
                    expandedInputItems.push({
                        ...child,
                        _comboAllocatedPrice: child.donGia,
                        _comboRetailPrice: child.giaGocNiemYet,
                        comboGroupUid,
                        maCombo: code,
                        tenComboSnapshot: cmbDef.tencombo,
                        isTakeaway: Boolean(child.isTakeaway ?? cmbReq.isTakeaway),
                        courseNo: child.courseNo ?? cmbReq.courseNo ?? 1,
                        fireStatus: child.fireStatus ?? cmbReq.fireStatus ?? 'FIRED',
                    });
                }
            }
        }
    }

    const cacMon = [...new Set(expandedInputItems.map((m) => m.maMon))];
    const giaRes = await client.query(
        `SELECT sz.MaMon, sz.KichThuoc, sz.GiaBan, sp.TenMon,
                COALESCE(sp.TamHet, FALSE) AS TamHet,
                (to_jsonb(sp)->>'soluonggioihan86')::int AS SoLuongGioiHan86,
                COALESCE((to_jsonb(sp)->>'lamonthoigia')::boolean, FALSE) AS LaMonThoiGia,
                COALESCE(to_jsonb(sp)->>'donvibanhang', 'LY') AS DonViBanHang
           FROM SanPham_Size sz JOIN SanPham sp ON sp.MaMon = sz.MaMon
          WHERE sp.DangKinhDoanh = TRUE
            AND COALESCE(sp.TenantId, 'DEFAULT') = $2
            AND sz.MaMon = ANY($1::varchar[])`,
        [cacMon, tenantId]
    );
    const bangGia = new Map();
    const monCountdownMap = new Map();
    for (const r of giaRes.rows) {
        bangGia.set(`${r.mamon}|${r.kichthuoc}`, {
            giaBan: Number(r.giaban),
            tenMon: r.tenmon,
            tamHet: Boolean(r.tamhet),
            soLuongGioiHan86: r.soluonggioihan86 !== null && r.soluonggioihan86 !== undefined ? Number(r.soluonggioihan86) : null,
            laMonThoiGia: Boolean(r.lamonthoigia),
            donViBanHang: r.donvibanhang || 'LY',
        });
        if (r.soluonggioihan86 !== null && r.soluonggioihan86 !== undefined) {
            monCountdownMap.set(r.mamon, { tenMon: r.tenmon, limit: Number(r.soluonggioihan86) });
        }
    }

    // Ghi đè giá vùng (SanPham_GiaVung) nếu chi nhánh thuộc vùng giá riêng
    if (khuVucGia && khuVucGia !== 'DEFAULT' && cacMon.length > 0) {
        await client.query('SAVEPOINT sp_ord_giavung');
        try {
            const gvRes = await client.query(
                `SELECT mamon, kichthuoc, giaban FROM sanpham_giavung
                  WHERE tenantid = $1 AND khuvucgia = $2 AND mamon = ANY($3::varchar[])`,
                [tenantId, khuVucGia, cacMon]
            );
            for (const gv of gvRes.rows) {
                const hit = bangGia.get(`${gv.mamon}|${gv.kichthuoc}`);
                if (hit) hit.giaBan = Number(gv.giaban);
            }
            await client.query('RELEASE SAVEPOINT sp_ord_giavung');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_ord_giavung').catch(() => {});
        }
    }

    // Tải Modifiers & Substitution BOM cho các món có trong đơn
    const attachedGroupsByMon = new Map();
    const modGroupMap = new Map();
    const modOptionMap = new Map();
    const modOptionBomMap = new Map();
    if (cacMon.length > 0) {
        await client.query('SAVEPOINT sp_ord_load_mods');
        try {
            const linkRes = await client.query(
                `SELECT mamon, groupid FROM sanpham_modifier_groups
                  WHERE tenantid = $1 AND mamon = ANY($2::varchar[])`,
                [tenantId, cacMon]
            );
            for (const r of linkRes.rows) {
                if (!attachedGroupsByMon.has(r.mamon)) attachedGroupsByMon.set(r.mamon, []);
                attachedGroupsByMon.get(r.mamon).push(Number(r.groupid));
            }
            const reqOptIds = [
                ...new Set(
                    expandedInputItems
                        .flatMap((m) => (Array.isArray(m.modifiers) ? m.modifiers : []))
                        .map((x) => Number(x?.optionId ?? x?.id))
                        .filter((n) => Number.isInteger(n) && n > 0)
                ),
            ];
            const allGroupIds = [...new Set([...attachedGroupsByMon.values()].flat())];
            if (allGroupIds.length > 0 || reqOptIds.length > 0) {
                const gRes = await client.query(
                    `SELECT id, tengroup, loai, batbuoc, chontoithieu, chontoida, soluongmienphi, thutuhienthi, danghoatdong
                       FROM modifier_groups WHERE tenantid = $1`,
                    [tenantId]
                );
                for (const g of gRes.rows) {
                    modGroupMap.set(Number(g.id), {
                        id: Number(g.id),
                        tenGroup: g.tengroup,
                        loai: g.loai,
                        batBuoc: Boolean(g.batbuoc),
                        chonToiThieu: Number(g.chontoithieu || 0),
                        chonToiDa: Number(g.chontoida || 1),
                        soLuongMienPhi: Number(g.soluongmienphi || 0),
                        thuTuHienThi: Number(g.thutuhienthi || 0),
                        dangHoatDong: Boolean(g.danghoatdong),
                    });
                }
                const oRes = await client.query(
                    `SELECT id, groupid, tenoption, teninngan, lamacdinh, giacongthem, toidasoluong, tamhet, thutuhienthi
                       FROM modifier_options WHERE tenantid = $1`,
                    [tenantId]
                );
                for (const o of oRes.rows) {
                    modOptionMap.set(Number(o.id), {
                        id: Number(o.id),
                        groupId: Number(o.groupid),
                        tenOption: o.tenoption,
                        tenInNgan: o.teninngan || o.tenoption,
                        laMacDinh: Boolean(o.lamacdinh),
                        giaCongThem: Number(o.giacongthem || 0),
                        toiDaSoLuong: Number(o.toidasoluong || 1),
                        tamHet: Boolean(o.tamhet),
                        thuTuHienThi: Number(o.thutuhienthi || 0),
                    });
                }
                const bRes = await client.query(
                    `SELECT optionid, kichthuoc, manl, khoiluongdelta
                       FROM modifier_option_bom WHERE tenantid = $1`,
                    [tenantId]
                );
                for (const b of bRes.rows) {
                    const oid = Number(b.optionid);
                    if (!modOptionBomMap.has(oid)) modOptionBomMap.set(oid, []);
                    modOptionBomMap.get(oid).push({
                        kichThuoc: b.kichthuoc || null,
                        maNL: b.manl,
                        khoiLuongDelta: Number(b.khoiluongdelta),
                    });
                }
            }
            await client.query('RELEASE SAVEPOINT sp_ord_load_mods');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_ord_load_mods').catch(() => {});
        }
    }

    // Tải Cấu hình vật tư đóng gói mang đi (cauhinh_vattu_mangdi — hỗ trợ lọc theo kênh bán kenhdung)
    const packagingBySize = new Map(); // size -> [{ maNL, khoiLuong, giaVonDonVi, kenhDung }]
    await client.query('SAVEPOINT sp_ord_pack_bom');
    try {
        const pkRes = await client.query(
            `SELECT c.kichthuoc, c.manl, c.soluongtieuhao,
                    COALESCE(to_jsonb(c)->>'kenhdung', 'ALL') AS kenhdung,
                    COALESCE(nl.giavondonvi, 0) AS giavondonvi
               FROM cauhinh_vattu_mangdi c
               LEFT JOIN nguyenlieu nl ON nl.manl = c.manl
              WHERE c.tenantid = $1`,
            [tenantId]
        );
        for (const r of pkRes.rows) {
            const sz = String(r.kichthuoc || 'ALL').toUpperCase();
            if (!packagingBySize.has(sz)) packagingBySize.set(sz, []);
            packagingBySize.get(sz).push({
                maNL: r.manl,
                khoiLuong: Number(r.soluongtieuhao),
                giaVonDonVi: Number(r.giavondonvi || 0),
                kenhDung: String(r.kenhdung || 'ALL').toUpperCase(),
            });
        }
        await client.query('RELEASE SAVEPOINT sp_ord_pack_bom');
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_ord_pack_bom').catch(() => {});
    }

    const cacTopping = [...new Set(expandedInputItems.flatMap((m) => (m.toppings || []).map((t) => t.maTopping)))];
    const bangTopping = new Map();
    const bangToppingBom = new Map();
    if (cacTopping.length > 0) {
        const tpRes = await client.query(
            `SELECT tp.MaTopping, tp.TenTopping, tp.GiaTopping, tp.MaNL, tp.KhoiLuongTieuHao,
                    COALESCE(tp.TamHet, FALSE) AS TamHet,
                    COALESCE((to_jsonb(tp)->>'toidamoily')::int, 3) AS ToiDaMoiLy,
                    to_jsonb(tp)->'giabacthang' AS GiaBacThang,
                    COALESCE(nl.GiaVonDonVi, 0) AS GiaVonDonVi
               FROM Topping tp
               LEFT JOIN NguyenLieu nl ON nl.MaNL = tp.MaNL
              WHERE tp.DangKinhDoanh = TRUE
                AND COALESCE(tp.TenantId, 'DEFAULT') = $2
                AND tp.MaTopping = ANY($1::varchar[])`,
            [cacTopping, tenantId]
        );
        for (const r of tpRes.rows) {
            bangTopping.set(r.matopping, {
                tenTopping: r.tentopping,
                giaTopping: Number(r.giatopping),
                toiDaMoiLy: Number(r.toidamoily || 3),
                giaBacThang: Array.isArray(r.giabacthang) ? r.giabacthang : null,
                maNL: r.manl,
                khoiLuong: Number(r.khoiluongtieuhao),
                giaVonDonVi: Number(r.giavondonvi || 0),
                tamHet: Boolean(r.tamhet),
            });
        }
        try {
            await client.query('SAVEPOINT sp_tp_bom');
            const tpBomRes = await client.query(
                `SELECT tc.MaTopping, tc.MaNL, tc.KhoiLuongTieuHao, COALESCE(nl.GiaVonDonVi, 0) AS GiaVonDonVi
                   FROM Topping_CongThuc tc
                   LEFT JOIN NguyenLieu nl ON nl.MaNL = tc.MaNL
                  WHERE tc.TenantId = $2 AND tc.MaTopping = ANY($1::varchar[])`,
                [cacTopping, tenantId]
            );
            await client.query('RELEASE SAVEPOINT sp_tp_bom');
            for (const r of tpBomRes.rows) {
                if (!bangToppingBom.has(r.matopping)) bangToppingBom.set(r.matopping, []);
                bangToppingBom.get(r.matopping).push({
                    maNL: r.manl,
                    khoiLuong: Number(r.khoiluongtieuhao),
                    giaVonDonVi: Number(r.giavondonvi || 0),
                });
            }
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_tp_bom').catch(() => {});
        }
    }

    const congThucRes = await client.query(
        `SELECT ct.MaMon, ct.KichThuoc, ct.MaNL, ct.KhoiLuongTieuHao, COALESCE(nl.GiaVonDonVi, 0) AS GiaVonDonVi
           FROM CongThuc ct
           JOIN SanPham sp ON sp.MaMon = ct.MaMon AND COALESCE(sp.TenantId, 'DEFAULT') = $2
           LEFT JOIN NguyenLieu nl ON nl.MaNL = ct.MaNL
          WHERE ct.MaMon = ANY($1::varchar[])`,
        [cacMon, tenantId]
    );
    const bangCongThuc = new Map();
    for (const r of congThucRes.rows) {
        const key = `${r.mamon}|${r.kichthuoc}`;
        if (!bangCongThuc.has(key)) bangCongThuc.set(key, []);
        bangCongThuc.get(key).push({
            maNL: r.manl,
            khoiLuong: Number(r.khoiluongtieuhao),
            giaVonDonVi: Number(r.giavondonvi || 0),
        });
    }

    const loaiDonFinal =
        loaiDonHang && ['TAI_QUAN', 'MANG_DI', 'GIAO_HANG', 'APP_SAN'].includes(String(loaiDonHang).toUpperCase())
            ? String(loaiDonHang).toUpperCase()
            : maBan
            ? 'TAI_QUAN'
            : 'MANG_DI';

    // Chuẩn hóa từng dòng + Modifiers + Clamped Substitution BOM + Takeaway Packaging + Giá vốn snapshot
    const tieuHao = new Map();
    const congDon = (maNL, sl) => {
        if (!maNL || !(sl > 0)) return;
        tieuHao.set(maNL, lam3((tieuHao.get(maNL) || 0) + sl));
    };

    let takeawayCupsCount = 0;

    const dongMon = expandedInputItems.map((mon) => {
        const infoMon = bangGia.get(`${mon.maMon}|${mon.kichThuoc}`);
        if (!infoMon) {
            throw new LoiNghiepVu(400, `Món ${mon.maMon} (size ${mon.kichThuoc}) không tồn tại hoặc đã ngừng kinh doanh!`);
        }
        if (infoMon.tamHet) {
            if (laOfflineSync) {
                soldOutWarnings.push({
                    code: 'SYNC_SOLD_OUT_WARNING',
                    type: 'PRODUCT',
                    maMon: mon.maMon,
                    tenMon: infoMon.tenMon,
                });
            } else {
                throw new LoiNghiepVu(409, `Món "${infoMon.tenMon}" hiện đang tạm hết (quầy Bar đã khóa)!`, {
                    maLoi: 'MON_TAM_HET',
                });
            }
        }

        // Thứ tự ưu tiên giá bán chuẩn Server: Combo Pro-rata > Open Item (thời giá + RBAC) > Lô bánh giảm 50% > Giá vùng/Size
        let donGiaServer = infoMon.giaBan;
        let giaGocNiemYet = infoMon.giaBan;
        const mdBakery = bakeryMap.get(mon.maMon);
        if (mdBakery?.dangGiamGia && Number(mdBakery.soLuongConLai || 0) > 0) {
            donGiaServer = Math.round((infoMon.giaBan * (100 - mdBakery.phanTramGiam)) / 100 / 500) * 500;
            giaGocNiemYet = donGiaServer;
        }
        if (mon._comboAllocatedPrice !== undefined) {
            donGiaServer = Number(mon._comboAllocatedPrice);
            giaGocNiemYet = Number(mon._comboRetailPrice ?? infoMon.giaBan);
        } else if (infoMon.laMonThoiGia && mon.donGia !== undefined && mon.donGia !== null) {
            if (![1, 4].includes(Number(vaiTro || 1))) {
                throw new LoiNghiepVu(403, 'Chỉ Thu ngân / Quản lý mới được nhập giá cho món thời giá (Open Item)!');
            }
            const customPrice = Number(mon.donGia);
            if (!(customPrice >= 0)) throw new LoiNghiepVu(400, 'Giá món thời giá phải >= 0!');
            donGiaServer = customPrice;
            giaGocNiemYet = customPrice;
            openItemAuditRows.push({
                maMon: mon.maMon,
                tenMonTuyChinh: mon.tenMonTuyChinh || infoMon.tenMon,
                donGia: customPrice,
                soLuong: mon.soLuong,
                trongLuongGram: mon.trongLuongGram ? Number(mon.trongLuongGram) : null,
            });
        }

        // Nếu món bán theo cân ký (GRAM/KG) và có trongLuongGram -> tính giá theo gram (SanPham_Size.GiaBan = giá mỗi 1kg hoặc đơn vị chuẩn)
        let trongLuongGram = null;
        if (mon.trongLuongGram !== undefined && mon.trongLuongGram !== null && Number(mon.trongLuongGram) > 0) {
            trongLuongGram = Number(mon.trongLuongGram);
            if (infoMon.donViBanHang === 'KG') {
                donGiaServer = Math.round((donGiaServer * trongLuongGram) / 1000);
                giaGocNiemYet = donGiaServer;
            } else if (infoMon.donViBanHang === 'GRAM') {
                donGiaServer = Math.round(donGiaServer * trongLuongGram);
                giaGocNiemYet = donGiaServer;
            }
        }

        // Đánh giá Modifiers (Forced Modifiers + Smart Defaults + Free K + Substitution BOM Deltas)
        const modEval = danhGiaModifiersChoMon({
            selectedModifiers: mon.modifiers || [],
            attachedGroupIds: attachedGroupsByMon.get(mon.maMon) || [],
            groupMap: modGroupMap,
            optionMap: modOptionMap,
            optionBomMap: modOptionBomMap,
            kichThuoc: mon.kichThuoc,
            laOfflineSync,
            LoiNghiepVu,
        });
        if (modEval.soldOutWarnings.length > 0) {
            soldOutWarnings.push(...modEval.soldOutWarnings);
        }

        // Đánh giá Toppings theo đơn vị TRÊN 1 LY (SoLuongMoiLy) + Giới hạn toiDaMoiLy + Giá bậc thang
        const gopToppingPerCup = new Map();
        for (const tp of mon.toppings || []) {
            const info = bangTopping.get(tp.maTopping);
            if (!info) throw new LoiNghiepVu(400, `Topping ${tp.maTopping} không tồn tại hoặc đã ngừng kinh doanh!`);
            if (info.tamHet) {
                if (laOfflineSync) {
                    soldOutWarnings.push({
                        code: 'SYNC_SOLD_OUT_WARNING',
                        type: 'TOPPING',
                        maTopping: tp.maTopping,
                        tenTopping: info.tenTopping,
                    });
                } else {
                    throw new LoiNghiepVu(409, `Topping "${info.tenTopping}" hiện đang tạm hết!`, {
                        maLoi: 'TOPPING_TAM_HET',
                    });
                }
            }
            const perCup = Math.max(1, Math.floor(Number(tp.soLuongMoiLy ?? tp.soLuong ?? 1)));
            const nextPerCup = (gopToppingPerCup.get(tp.maTopping) || 0) + perCup;
            if (nextPerCup > info.toiDaMoiLy) {
                throw new LoiNghiepVu(
                    400,
                    `Topping "${info.tenTopping}" chỉ cho phép tối đa ${info.toiDaMoiLy} phần mỗi ly!`
                );
            }
            gopToppingPerCup.set(tp.maTopping, nextPerCup);
        }

        const toppingBomPerCup = [];
        const toppings = [...gopToppingPerCup].map(([maTopping, soLuongMoiLy]) => {
            const info = bangTopping.get(maTopping);
            const tiered = tinhGiaToppingBacThang(info.giaTopping, info.giaBacThang, soLuongMoiLy);
            const multiBom = bangToppingBom.get(maTopping);
            let giaVonMotTp = 0;
            if (multiBom && multiBom.length > 0) {
                for (const b of multiBom) {
                    toppingBomPerCup.push({
                        maNL: b.maNL,
                        khoiLuong: b.khoiLuong * soLuongMoiLy,
                        giaVonDonVi: b.giaVonDonVi,
                    });
                    giaVonMotTp += b.khoiLuong * b.giaVonDonVi;
                }
            } else if (info.maNL && info.khoiLuong > 0) {
                toppingBomPerCup.push({
                    maNL: info.maNL,
                    khoiLuong: info.khoiLuong * soLuongMoiLy,
                    giaVonDonVi: info.giaVonDonVi,
                });
                giaVonMotTp += info.khoiLuong * info.giaVonDonVi;
            }
            const bomPerUnit =
                Array.isArray(info.bom) && info.bom.length > 0
                    ? info.bom.map((b) => ({ maNL: b.maNL, khoiLuong: b.khoiLuong, giaVonDonVi: b.giaVonDonVi }))
                    : info.maNL && info.khoiLuong > 0
                      ? [{ maNL: info.maNL, khoiLuong: info.khoiLuong, giaVonDonVi: info.giaVonDonVi }]
                      : [];
            return {
                maTopping,
                tenToppingSnapshot: info.tenTopping,
                soLuongMoiLy,
                soLuong: soLuongMoiLy * mon.soLuong,
                donGia: tiered.donGiaBinhQuan,
                giaVonToppingSnapshot: Math.round(giaVonMotTp * 100) / 100,
                bomPerUnit,
            };
        });

        // Vật tư đóng gói mang đi theo kênh bán (ALL / MANG_DI / GIAO_HANG / APP_SAN)
        const isItemTakeaway = loaiDonFinal !== 'TAI_QUAN' || Boolean(mon.isTakeaway);
        const packagingBomPerCup = [];
        if (isItemTakeaway) {
            takeawayCupsCount += mon.soLuong;
            const channelTarget = loaiDonFinal === 'TAI_QUAN' ? 'MANG_DI' : loaiDonFinal;
            const specificPack = (packagingBySize.get(String(mon.kichThuoc).toUpperCase()) || []).filter(
                (p) => p.kenhDung === 'ALL' || p.kenhDung === channelTarget
            );
            const allPack = (packagingBySize.get('ALL') || []).filter(
                (p) => p.kenhDung === 'ALL' || p.kenhDung === channelTarget
            );
            packagingBomPerCup.push(...specificPack, ...allPack);
        }

        // Tính BOM 5 lớp (Base Size + Modifier Substitution + Topping + Packaging) & lưu BomSnapshotJson!
        const baseBomRows = bangCongThuc.get(`${mon.maMon}|${mon.kichThuoc}`) || [];
        const bomPerCup = tinhBomMotLySauSubstitution({
            baseBomRows,
            modifierDeltas: modEval.bomDeltas,
            toppingBomRows: toppingBomPerCup,
            packagingBomRows: packagingBomPerCup,
        });

        const lineBomSnapshot = {};
        for (const [maNL, qtyPerCup] of bomPerCup.perCupMap.entries()) {
            const lineQty = lam3(qtyPerCup * mon.soLuong);
            if (lineQty > 0) {
                lineBomSnapshot[maNL] = lineQty;
                congDon(maNL, lineQty);
            }
        }

        const fireStatus = String(mon.fireStatus || 'FIRED').toUpperCase() === 'HELD' ? 'HELD' : 'FIRED';
        const courseNo = Math.max(1, Math.floor(Number(mon.courseNo || 1)));
        const laMonTang = Boolean(mon.laMonTang);
        const chietKhauMon = Math.max(0, Number(mon.chietKhauMon || 0));

        return {
            maMon: mon.maMon,
            tenMonSnapshot: mon.tenMonTuyChinh ? String(mon.tenMonTuyChinh).trim().slice(0, 150) : infoMon.tenMon,
            tenMonTuyChinh: mon.tenMonTuyChinh ? String(mon.tenMonTuyChinh).trim().slice(0, 150) : null,
            kichThuoc: mon.kichThuoc,
            soLuong: mon.soLuong,
            donGia: donGiaServer,
            giaGocNiemYet,
            giaModifiers: modEval.giaModifiers,
            modifiersSnapshot: modEval.modifiersSnapshot,
            giaVonSnapshot: bomPerCup.giaVonMotLy,
            bomPerCupMap: bomPerCup.perCupMap,
            bomSnapshotJson: lineBomSnapshot,
            chietKhauMon,
            laMonTang,
            lyDoTang: laMonTang && mon.lyDoTang ? String(mon.lyDoTang).trim().slice(0, 255) : null,
            trongLuongGram,
            comboGroupUid: mon.comboGroupUid || null,
            maCombo: mon.maCombo || null,
            tenComboSnapshot: mon.tenComboSnapshot || null,
            isTakeaway: isItemTakeaway,
            courseNo,
            fireStatus,
            ghiChu: mon.ghiChu ? String(mon.ghiChu).slice(0, 255) : null,
            toppings,
        };
    });

    if (maKH) {
        const kh = await client.query(
            "SELECT 1 FROM KhachHang WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
            [maKH, tenantId]
        );
        if (kh.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy khách hàng!');
    }

    let maHoaDon = null;
    let laHoaDonMoi = false;
    if (maBan) {
        const ban = await client.query(
            "SELECT MaBan FROM Ban WHERE MaBan = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2 FOR UPDATE",
            [maBan, tenantId]
        );
        if (ban.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy bàn!');
        maHoaDon = await layHoaDonMoCuaBan(client, maBan, true);
        if (!maHoaDon && expectedVersion !== null && expectedVersion !== undefined) {
            throw new LoiNghiepVu(
                409,
                `Bàn này vừa được thiết bị khác thanh toán hoặc chuyển bàn — vui lòng tải lại sơ đồ bàn!`,
                { maLoi: 'ORDER_CONCURRENT_MODIFIED', code: 'ORDER_CONCURRENT_MODIFIED' }
            );
        }
    } else if (maHoaDonGoc) {
        const hdExisting = await client.query(
            `SELECT MaHoaDon, TrangThaiTT FROM HoaDon
              WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
              FOR UPDATE`,
            [maHoaDonGoc, tenantId]
        );
        if (hdExisting.rows.length === 0) {
            throw new LoiNghiepVu(404, `Không tìm thấy hóa đơn #${maHoaDonGoc}!`);
        }
        if (Number(hdExisting.rows[0].trangthaitt) !== 0) {
            const latest = await layHoaDonChiTiet(client, maHoaDonGoc);
            throw new LoiNghiepVu(
                409,
                `Hóa đơn #${maHoaDonGoc} vừa được thanh toán hoặc đóng bởi thiết bị khác!`,
                {
                    maLoi: 'ORDER_CONCURRENT_MODIFIED',
                    code: 'ORDER_CONCURRENT_MODIFIED',
                    hoaDonMoiNhat: latest,
                }
            );
        }
        maHoaDon = hdExisting.rows[0].mahoadon;
    }

    // Nếu gọi thêm vào hóa đơn đang mở: kiểm tra Optimistic Locking & tính DotGoi mới
    let dotGoi = 1;
    if (maHoaDon) {
        await kiemTraVaTangVersionHoaDon(client, {
            maHoaDon,
            tenantId,
            expectedVersion,
            layHoaDonChiTiet,
            LoiNghiepVu,
        });
        await client.query('SAVEPOINT sp_sel_dotgoi');
        try {
            const dgRes = await client.query(
                `SELECT COALESCE(MAX(DotGoi), 0)::int + 1 AS next_dot FROM ChiTietHoaDon WHERE MaHoaDon = $1`,
                [maHoaDon]
            );
            dotGoi = Number(dgRes.rows[0]?.next_dot || 1);
            await client.query('RELEASE SAVEPOINT sp_sel_dotgoi');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_sel_dotgoi').catch(() => {});
        }
        // Cộng thêm phí đóng gói (nếu đợt gọi thêm có ly mang về)
        const addPackFee =
            phiDongGoi !== null && phiDongGoi !== undefined
                ? Math.max(0, Number(phiDongGoi))
                : Math.max(0, Number(phiDongGoiMoiLy || 0)) * takeawayCupsCount;
        if (addPackFee > 0) {
            await client.query('SAVEPOINT sp_upd_packfee');
            try {
                await client.query(`UPDATE HoaDon SET PhiDongGoi = COALESCE(PhiDongGoi, 0) + $2 WHERE MaHoaDon = $1`, [
                    maHoaDon,
                    addPackFee,
                ]);
                await client.query('RELEASE SAVEPOINT sp_upd_packfee');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_upd_packfee').catch(() => {});
            }
        }
    } else {
        // Hóa đơn mới: cấp SoThuTuNgay nguyên tử KHÔNG quay vòng 99 + giữ SoTheRung tách biệt hoàn toàn!
        const { seq: soThuTuNgay, soThuTuHienThi } = await capSoThuTuNgayKhongTrung(client, tenantId, normalizeBranchId(branchId || 'MAIN'));
        const soTheRungClean =
            soTheRung !== null && soTheRung !== undefined && String(soTheRung).trim() !== ''
                ? String(soTheRung).trim().slice(0, 16)
                : null;
        const initPackFee =
            phiDongGoi !== null && phiDongGoi !== undefined
                ? Math.max(0, Number(phiDongGoi))
                : Math.max(0, Number(phiDongGoiMoiLy || 0)) * takeawayCupsCount;

        let hd;
        await client.query('SAVEPOINT sp_ins_hd_v23');
        try {
            hd = await client.query(
                `INSERT INTO HoaDon
                    (MaNV, TrangThaiTT, TenantId, BranchId, ClientOrderUid, SoThuTuNgay, SoThuTuHienThi, SoTheRung,
                     LoaiDonHang, PhiDongGoi, DiaChiGiao, TenKhachVangLai, SoKhach, ThoiGianMoBan,
                     CachTinhThue, ThueVATPhanTram, PhiPhucVuPhanTram, Version)
                 VALUES ($1, 0, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP, $13, $14, $15, 1)
                 RETURNING MaHoaDon`,
                [
                    maNV,
                    tenantId,
                    branchId ? normalizeBranchId(branchId) : 'DEFAULT',
                    clientOrderUid ? String(clientOrderUid).trim().slice(0, 64) : null,
                    soThuTuNgay,
                    soThuTuHienThi,
                    soTheRungClean,
                    loaiDonFinal,
                    initPackFee,
                    diaChiGiao ? String(diaChiGiao).trim().slice(0, 500) : null,
                    tenKhachVangLai ? String(tenKhachVangLai).trim().slice(0, 100) : null,
                    Math.max(1, Math.floor(Number(soKhach || 1))),
                    cachTinhThue && ['INCLUDED', 'EXCLUDED', 'NONE'].includes(String(cachTinhThue).toUpperCase())
                        ? String(cachTinhThue).toUpperCase()
                        : 'INCLUDED',
                    Math.max(0, Number(thueVATPhanTram || 0)),
                    Math.max(0, Number(phiPhucVuPhanTram || 0)),
                ]
            );
            await client.query('RELEASE SAVEPOINT sp_ins_hd_v23');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_ins_hd_v23').catch(() => {});
            hd = await client.query(
                'INSERT INTO HoaDon (MaNV, TrangThaiTT, TenantId, SoThuTuNgay) VALUES ($1, 0, $2, $3) RETURNING MaHoaDon',
                [maNV, tenantId, soThuTuNgay]
            );
        }
        maHoaDon = hd.rows[0].mahoadon;
        laHoaDonMoi = true;
        if (maBan) {
            await client.query('INSERT INTO HoaDon_Ban (MaHoaDon, MaBan) VALUES ($1, $2)', [maHoaDon, maBan]);
            await client.query('UPDATE Ban SET TrangThai = 2 WHERE MaBan = $1', [maBan]);
        }
    }
    if (maKH) await client.query('UPDATE HoaDon SET MaKH = $1 WHERE MaHoaDon = $2', [maKH, maHoaDon]);

    // [Phân hệ 2 - Countdown 86 Stock] Trừ nguyên tử số lượng giới hạn trong ngày (chống 2 thu ngân bán vượt suất!)
    if (monCountdownMap.size > 0) {
        const qtyByCountdownMon = new Map();
        for (const d of dongMon) {
            if (monCountdownMap.has(d.maMon)) {
                qtyByCountdownMon.set(d.maMon, (qtyByCountdownMon.get(d.maMon) || 0) + Number(d.soLuong || 1));
            }
        }
        for (const [cdMaMon, needQty] of [...qtyByCountdownMon.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            const cdRes = await client.query(
                `UPDATE public.sanpham
                    SET soluonggioihan86 = soluonggioihan86 - $1,
                        tamhet = CASE WHEN soluonggioihan86 - $1 <= 0 THEN TRUE ELSE tamhet END,
                        tamhettudong = CASE WHEN soluonggioihan86 - $1 <= 0 THEN TRUE ELSE tamhettudong END
                  WHERE mamon = $2
                    AND COALESCE(tenantid, 'DEFAULT') = $3
                    AND soluonggioihan86 IS NOT NULL
                    AND soluonggioihan86 >= $1
                  RETURNING mamon, tenmon, soluonggioihan86, tamhet`,
                [needQty, cdMaMon, tenantId]
            );
            if (cdRes.rows.length === 0) {
                const info = monCountdownMap.get(cdMaMon);
                if (laOfflineSync) {
                    soldOutWarnings.push({
                        code: 'OUT_OF_COUNTDOWN_STOCK',
                        type: 'COUNTDOWN',
                        maMon: cdMaMon,
                        tenMon: info?.tenMon || cdMaMon,
                    });
                } else {
                    throw new LoiNghiepVu(
                        409,
                        `Món "${info?.tenMon || cdMaMon}" không đủ suất giới hạn trong ngày (Countdown 86)!`,
                        { code: 'OUT_OF_COUNTDOWN_STOCK', maLoi: 'OUT_OF_COUNTDOWN_STOCK', maMon: cdMaMon }
                    );
                }
            } else {
                const row = cdRes.rows[0];
                countdownUpdates.push({
                    maMon: row.mamon,
                    tenMon: row.tenmon,
                    soLuongGioiHan86: Number(row.soluonggioihan86),
                    tamHet: Boolean(row.tamhet),
                });
            }
        }
    }

    // [Phân hệ 4 - 100/100] Kiểm tra & trừ kho Single-Source TonKhoChiNhanh (ORDER BY MaNL ASC FOR UPDATE -> 0% Deadlock, FEFO & Historical Offline WAC)
    const canhBaoTonThap = [];
    const orderBranchId = normalizeInventoryBranch(tenantId, branchId);
    const branchWacUsedMap = new Map();
    if (tieuHao.size > 0) {
        const dsNL = [...tieuHao.keys()];
        const { branchId: lockedBranchId, stockMap } = await lockBranchStockOrdered(client, tenantId, orderBranchId, dsNL);

        const thieu = [];
        for (const maNL of dsNL.sort((a, b) => a.localeCompare(b))) {
            const st = stockMap.get(maNL);
            if (!st) continue;
            const need = tieuHao.get(maNL);
            if (st.soLuongTon + 1e-9 < need) {
                thieu.push({
                    maNL: st.maNL,
                    tenNL: st.tenNL,
                    donViTinh: st.donViTinh,
                    canDung: lam3(need),
                    conLai: st.soLuongTon,
                });
            }
            const conSauBan = lam3(st.soLuongTon - need);
            if (conSauBan <= st.hanMucCanhBao) {
                canhBaoTonThap.push({
                    maNL: st.maNL,
                    tenNL: st.tenNL,
                    donViTinh: st.donViTinh,
                    conLai: conSauBan,
                });
            }
        }

        if (thieu.length > 0 && !allowNegativeStock) {
            const ten = thieu.map((t) => `${t.tenNL} (cần ${t.canDung}, còn ${t.conLai} ${t.donViTinh})`).join('; ');
            throw new LoiNghiepVu(409, `Không đủ nguyên liệu: ${ten}`, { maLoi: 'HET_NGUYEN_LIEU', nguyenLieuThieu: thieu });
        }

        const caMo = await layCaDangMo(client, 'SHARE', tenantId, { branchId: lockedBranchId });
        const phieu = await client.query(
            `INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan, NgayChungTu, TrangThaiDuyet)
             VALUES ($1, $2, $3, $4, $5, $6, $7::date, 'POSTED')
             RETURNING MaGiaoDich`,
            [
                maNV,
                LOAI_GD_TIEU_HAO,
                `Tiêu hao bán hàng - HĐ ${maHoaDon}`,
                tenantId,
                lockedBranchId,
                caMo ? String(caMo.macathungan) : null,
                todayDateVN(),
            ]
        );
        const maGiaoDich = phieu.rows[0].magiaodich;

        for (const [maNL, sl] of [...tieuHao].sort((a, b) => a[0].localeCompare(b[0]))) {
            const st = stockMap.get(maNL);
            if (!st) continue;
            const soLuong = lam3(sl);
            let donGiaVonSnapshot = st.giaVonDonVi;
            if (laOfflineSync && offlineCreatedAt) {
                donGiaVonSnapshot = await lookupHistoricalWac(client, {
                    tenantId,
                    branchId: lockedBranchId,
                    maNL,
                    atTimestamp: offlineCreatedAt,
                    fallbackWac: st.giaVonDonVi,
                });
            }
            branchWacUsedMap.set(maNL, donGiaVonSnapshot);

            // Tiêu hao theo Lô FEFO tự động (nếu nguyên liệu có lô đang ACTIVE)
            await consumeFefoBatches(client, {
                tenantId,
                branchId: lockedBranchId,
                maNL,
                qty: soLuong,
            });

            const tonTruoc = st.soLuongTon;
            const tonSau = lam3(tonTruoc - soLuong);

            await insertLedgerLine(client, {
                maGiaoDich,
                maNL,
                soLuong,
                donGiaNhap: donGiaVonSnapshot,
                tinhTrang: 'Tiêu hao bán hàng',
                tonTruoc,
                tonSau,
                giaVonTruoc: st.giaVonDonVi,
                giaVonSau: st.giaVonDonVi,
            });

            await updateBranchStockRow(client, {
                tenantId,
                branchId: lockedBranchId,
                maNL,
                nextQty: tonSau,
            });
        }

        // [Wave 2 — P0-05] Cập nhật lại GiaVonSnapshot (bao gồm bao bì) & giaVonToppingSnapshot theo đúng branchWacUsedMap!
        for (const dong of dongMon) {
            if (dong.bomPerCupMap && dong.bomPerCupMap.size > 0) {
                let cogsCup = 0;
                for (const [mNl, qCup] of dong.bomPerCupMap.entries()) {
                    cogsCup += Number(qCup || 0) * Number(branchWacUsedMap.get(mNl) ?? stockMap.get(mNl)?.giaVonDonVi ?? 0);
                }
                dong.giaVonSnapshot = Math.round(cogsCup * 100) / 100;
            }
            if (Array.isArray(dong.toppings) && dong.toppings.length > 0) {
                for (const tp of dong.toppings) {
                    if (Array.isArray(tp.bomPerUnit) && tp.bomPerUnit.length > 0) {
                        let cogsTp = 0;
                        for (const b of tp.bomPerUnit) {
                            const wacNl = Number(
                                branchWacUsedMap.get(b.maNL) ?? stockMap.get(b.maNL)?.giaVonDonVi ?? b.giaVonDonVi ?? 0
                            );
                            cogsTp += Number(b.khoiLuong || 0) * wacNl;
                        }
                        tp.giaVonToppingSnapshot = Math.round(cogsTp * 100) / 100;
                    }
                }
            }
        }
    }

    const dsMaCTHD = [];
    const dsMaCTHDFired = [];
    for (const dong of dongMon) {
        let cthd;
        await client.query('SAVEPOINT sp_ins_cthd_v23');
        try {
            cthd = await client.query(
                `INSERT INTO ChiTietHoaDon
                    (MaHoaDon, MaMon, TenMonSnapshot, TenMonTuyChinh, KichThuoc, SoLuong, DonGia, GiaGocNiemYet,
                     GiaModifiers, ModifiersSnapshot, GiaVonSnapshot, ChietKhauMon, LaMonTang, LyDoTang, TrongLuongGram,
                     ComboGroupUid, MaCombo, TenComboSnapshot, DotGoi, IsTakeaway, CourseNo, FireStatus, FiredAt,
                     GhiChu, BomSnapshotJson, TrangThaiPhaChe)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,'ChoPhaChe')
                 RETURNING MaCTHD`,
                [
                    maHoaDon,
                    dong.maMon,
                    dong.tenMonSnapshot,
                    dong.tenMonTuyChinh,
                    dong.kichThuoc,
                    dong.soLuong,
                    dong.donGia,
                    dong.giaGocNiemYet,
                    dong.giaModifiers,
                    JSON.stringify(dong.modifiersSnapshot || []),
                    dong.giaVonSnapshot,
                    dong.chietKhauMon,
                    dong.laMonTang,
                    dong.lyDoTang,
                    dong.trongLuongGram,
                    dong.comboGroupUid,
                    dong.maCombo,
                    dong.tenComboSnapshot,
                    dotGoi,
                    dong.isTakeaway,
                    dong.courseNo,
                    dong.fireStatus,
                    dong.fireStatus === 'FIRED' ? new Date().toISOString() : null,
                    dong.ghiChu,
                    JSON.stringify(dong.bomSnapshotJson || {}),
                ]
            );
            await client.query('RELEASE SAVEPOINT sp_ins_cthd_v23');
        } catch (insErr) {
            console.warn('⚠️ Fallback INSERT ChiTietHoaDon (v23):', insErr.message);
            await client.query('ROLLBACK TO SAVEPOINT sp_ins_cthd_v23').catch(() => {});
            cthd = await client.query(
                `INSERT INTO ChiTietHoaDon (MaHoaDon, MaMon, TenMonSnapshot, KichThuoc, SoLuong, DonGia, GiaVonSnapshot, GhiChu, TrangThaiPhaChe)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ChoPhaChe') RETURNING MaCTHD`,
                [maHoaDon, dong.maMon, dong.tenMonSnapshot, dong.kichThuoc, dong.soLuong, dong.donGia, dong.giaVonSnapshot, dong.ghiChu]
            );
        }
        const maCTHD = cthd.rows[0].macthd;
        dsMaCTHD.push(maCTHD);
        if (dong.fireStatus === 'FIRED') dsMaCTHDFired.push(maCTHD);

        for (const tp of dong.toppings) {
            await client.query('SAVEPOINT sp_ins_cthd_tp_v23');
            try {
                await client.query(
                    `INSERT INTO ChiTietHoaDon_Topping
                        (MaCTHD, MaTopping, TenToppingSnapshot, SoLuong, SoLuongMoiLy, DonGia, GiaVonToppingSnapshot)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        maCTHD,
                        tp.maTopping,
                        tp.tenToppingSnapshot || null,
                        tp.soLuong,
                        tp.soLuongMoiLy || 1,
                        tp.donGia,
                        tp.giaVonToppingSnapshot || 0,
                    ]
                );
                await client.query('RELEASE SAVEPOINT sp_ins_cthd_tp_v23');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_ins_cthd_tp_v23').catch(() => {});
                await client.query(
                    'INSERT INTO ChiTietHoaDon_Topping (MaCTHD, MaTopping, SoLuong, DonGia) VALUES ($1, $2, $3, $4)',
                    [maCTHD, tp.maTopping, tp.soLuong, tp.donGia]
                );
            }
        }
    }

    // [Phân hệ 2 - Open Item Audit] Ghi nhận nhật ký bắt buộc khi Thu ngân/Quản lý tạo món thời giá / cân ký
    if (openItemAuditRows.length > 0) {
        for (const oi of openItemAuditRows) {
            await ghiAuditLog(client, {
                tenantId,
                maNV,
                vaiTro,
                hanhDong: 'OPEN_ITEM_CREATED',
                doiTuong: 'HOADON',
                maDoiTuong: maHoaDon,
                giaTriMoi: oi,
                ip,
                batBuoc: true,
            });
        }
    }

    // Tự động tính lại Tổng tiền, Thuế VAT, Phí phục vụ & Kiểm định lại Khuyến mãi trong cùng ACID Transaction
    const recalc = await recalculateInvoiceTotals(client, {
        tenantId,
        maHoaDon,
        maNV,
        vaiTro,
        ip,
        ghiAuditLog,
        kiemTraHopLeKhuyenMai,
    });

    return {
        maHoaDon,
        branchId: normalizeBranchId(branchId || 'DEFAULT'),
        laHoaDonMoi,
        dotGoi,
        dsMaCTHD,
        dsMaCTHDFired,
        canhBaoTonThap,
        soldOutWarnings,
        countdownUpdates,
        promoAdjusted: recalc.promoAdjusted,
        promoAdjustReasons: recalc.promoAdjustReasons,
    };
}

// [v3 - Phân hệ 1 100/100] Tạo order / gọi thêm món (hỗ trợ Modifiers, Combo, Course Firing, Takeaway, Optimistic Locking)
async function handleCreateOrAppendOrder(req, res) {
    const {
        maBan = null,
        maHoaDon: maHoaDonReq = null,
        maKH = null,
        soTheRung = null,
        loaiDonHang = null,
        tenKhachVangLai = null,
        diaChiGiao = null,
        soKhach = 1,
        phiDongGoi = null,
        phiDongGoiMoiLy = 0,
        cachTinhThue = null,
        thueVATPhanTram = null,
        phiPhucVuPhanTram = null,
        expectedVersion = null,
        branchId = null,
        danhSachMon = [],
        combos = [],
    } = req.body || {};
    const maNV = req.user.maNV;

    const loiMon = validateDanhSachMon(danhSachMon, combos);
    if (loiMon) return res.status(400).json({ message: loiMon });

    const khoaIdem = docKhoaIdempotency(req);
    if (khoaIdem === false) {
        return res.status(400).json({ message: 'Header Idempotency-Key không hợp lệ (8-64 ký tự: chữ, số, gạch ngang, gạch dưới)!' });
    }
    const dungIdem = Boolean(khoaIdem) && idemSanSang;
    const dauVanTay = dungIdem
        ? crypto
              .createHash('sha256')
              .update(JSON.stringify({ maBan: maBan || null, maHoaDon: maHoaDonReq || null, maKH: maKH || null, danhSachMon, combos }))
              .digest('hex')
        : null;

    const tId = layTenantId(req);
    const resolvedBranchId = normalizeBranchId(branchId || req.user.branchId || 'DEFAULT');
    const clientOrderUid = req.body?.clientOrderUid
        ? String(req.body.clientOrderUid).trim().slice(0, 64)
        : khoaIdem || null;

    // [Phân hệ 2 - Khóa Idempotency 2 pha] Chiếm khóa PROCESSING ngoài giao dịch chính để chặn bấm đúp 50ms!
    let idemLocked = false;
    if (dungIdem) {
        try {
            const lock = await acquireIdempotencyLock(pool, { tenantId: tId, khoaIdem, maNV, dauVanTay });
            if (!lock.acquired) {
                if (lock.state === 'KEY_REUSED') {
                    return res.status(422).json({
                        message: 'Idempotency-Key này đã được dùng cho một order khác!',
                        maLoi: 'IDEMPOTENCY_KEY_REUSED',
                    });
                }
                if (lock.state === 'IN_FLIGHT') {
                    return res.status(409).json({
                        message: 'Order này đang được xử lý (PROCESSING), vui lòng chờ kết quả!',
                        maLoi: 'IDEMPOTENCY_IN_FLIGHT',
                        code: 'IDEMPOTENCY_IN_FLIGHT',
                    });
                }
                if (lock.state === 'DONE' && lock.record) {
                    if (lock.record.responseJson) {
                        return res.status(200).json({ ...lock.record.responseJson, trungLap: true });
                    }
                    const cached = await pool.withTenant(tId, async (client) => ({
                        hoaDon: await layHoaDonChiTiet(client, lock.record.maHoaDon),
                        monMoi: await layMonTheoMa(client, lock.record.dsMaCTHD || []),
                    }));
                    return res.status(200).json({
                        message: `Order #${lock.record.maHoaDon} đã được ghi nhận trước đó, không tạo trùng.`,
                        maHoaDon: lock.record.maHoaDon,
                        laHoaDonMoi: lock.record.laHoaDonMoi,
                        danhSachMon: cached.monMoi,
                        hoaDon: cached.hoaDon,
                        trungLap: true,
                    });
                }
            }
            idemLocked = true;
        } catch (lockErr) {
            return guiLoi(res, lockErr, 'Lỗi khóa Idempotency:');
        }
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const laOfflineSync = req.get('X-Offline-Sync') === '1';
            const caInfo = await layCaChoGiaoDichOffline(client, {
                tenantId: tId,
                maCaGoc: req.body?.maCaThuNganGoc || null,
                laOfflineSync,
            });
            const ca = caInfo.ca;

            const ordRes = await taoOrderTrongGiaoDich(client, {
                tenantId: tId,
                branchId: resolvedBranchId,
                maNV,
                vaiTro: req.user.vaiTro,
                maBan,
                maHoaDon: maHoaDonReq,
                maKH,
                soTheRung,
                loaiDonHang,
                tenKhachVangLai,
                diaChiGiao,
                soKhach,
                phiDongGoi,
                phiDongGoiMoiLy,
                cachTinhThue,
                thueVATPhanTram,
                phiPhucVuPhanTram,
                expectedVersion,
                clientOrderUid,
                laOfflineSync,
                offlineCreatedAt: req.body?.offlineCreatedAt || null,
                danhSachMon,
                combos,
                ip: req.ip,
            });

            const {
                maHoaDon,
                laHoaDonMoi,
                dotGoi,
                dsMaCTHD,
                dsMaCTHDFired,
                canhBaoTonThap,
                soldOutWarnings,
                countdownUpdates,
                promoAdjusted,
            } = ordRes;

            const offlineClientId = req.body?.offlineClientId ? String(req.body.offlineClientId).trim().slice(0, 64) : null;
            if (offlineClientId) {
                await client.query('SAVEPOINT sp_ord_off_id');
                try {
                    await client.query(`UPDATE HoaDon SET MaOfflineClient = $2 WHERE MaHoaDon = $1`, [maHoaDon, offlineClientId]);
                    await client.query('RELEASE SAVEPOINT sp_ord_off_id');
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_ord_off_id').catch(() => {});
                }
            }

            if (laOfflineSync) {
                await ghiAuditLog(client, {
                    tenantId: tId,
                    maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'OFFLINE_ORDER_SYNCED',
                    doiTuong: 'HOADON',
                    maDoiTuong: maHoaDon,
                    giaTriMoi: {
                        khoaIdem,
                        offlineClientId,
                        offlineCreatedAt: req.body?.offlineCreatedAt || null,
                        maCaThuNganGoc: caInfo.maCaGoc,
                        maCaHachToan: ca.macathungan,
                        lechCaDongBo: caInfo.lechCaDongBo,
                        caGocDaDong: caInfo.caGocDaDong,
                        ghiChuLechCa: caInfo.ghiChuLechCa,
                        soldOutWarnings,
                    },
                    lyDo: offlineClientId
                        ? `Đồng bộ đơn Offline ${offlineClientId}${caInfo.ghiChuLechCa ? ` (${caInfo.ghiChuLechCa})` : ' từ hàng đợi Outbox'}`
                        : `Đồng bộ từ hàng đợi Offline Outbox Queue${caInfo.ghiChuLechCa ? ` (${caInfo.ghiChuLechCa})` : ''}`,
                    ip: req.ip,
                });
            }

            const monMoi = await layMonTheoMa(client, dsMaCTHD);
            const monMoiFired = await layMonTheoMa(client, dsMaCTHDFired);
            const hoaDon = await layHoaDonChiTiet(client, maHoaDon);

            // Ghi nhật ký sự kiện KDS theo từng Trạm & Chi nhánh ngay trong transaction để seq luôn nhất quán
            const kdsEmitPlan =
                monMoiFired.length > 0
                    ? await recordAndEmitOrderNewByStation(client, io, {
                          tenantId: tId,
                          branchId: resolvedBranchId,
                          maHoaDon,
                          maBan: maBan || null,
                          tenBan: monMoiFired[0]?.tenBan || null,
                          mangDi: !maBan,
                          themMon: !laHoaDonMoi,
                          dotGoi,
                          clientOrderUid,
                          monMoiFired,
                      })
                    : null;

            return {
                trungLap: false,
                maHoaDon,
                laHoaDonMoi,
                dotGoi,
                dsMaCTHD,
                monMoi,
                monMoiFired,
                hoaDon,
                canhBaoTonThap,
                soldOutWarnings,
                countdownUpdates,
                promoAdjusted,
                canhBaoLechCa: caInfo.ghiChuLechCa,
                kdsEmitPlan,
            };
        }, tId);

        const {
            maHoaDon,
            laHoaDonMoi,
            dotGoi,
            dsMaCTHD,
            monMoi,
            monMoiFired,
            hoaDon,
            canhBaoTonThap,
            soldOutWarnings,
            countdownUpdates,
            promoAdjusted,
            kdsEmitPlan,
        } = ketQua;

        const responsePayload = {
            message: laHoaDonMoi
                ? 'Tạo order thành công!'
                : `Đã thêm món (Đợt ${dotGoi}) vào hóa đơn đang mở!`,
            maHoaDon,
            branchId: resolvedBranchId,
            clientOrderUid,
            laHoaDonMoi,
            dotGoi,
            danhSachMon: monMoi,
            hoaDon,
            canhBaoTonThap,
            soldOutWarnings,
            countdownUpdates,
            promoAdjusted,
        };

        if (idemLocked) {
            await completeIdempotencyLock(pool, {
                tenantId: tId,
                khoaIdem,
                maHoaDon,
                laHoaDonMoi,
                dsMaCTHD,
                responseJson: responsePayload,
                httpStatus: 201,
            });
        }

        if (kdsEmitPlan && typeof kdsEmitPlan.flush === 'function') {
            kdsEmitPlan.flush();
        }
        if (Array.isArray(countdownUpdates) && countdownUpdates.length > 0) {
            for (const cd of countdownUpdates) {
                io.to(roomTen(tId, 'thungan')).to(roomTen(tId, 'phucvu')).to(roomTen(tId, 'barista')).emit('THUC_DON_THAY_DOI', cd);
                io.to(roomBranchPos(tId, resolvedBranchId)).emit('menu:86_updated', { type: 'COUNTDOWN', product: cd });
            }
        }
        if (maBan) io.to(roomTen(tId, 'thungan')).to(roomTen(tId, 'phucvu')).emit('BAN_THAY_DOI', { maBan, trangThai: 2 });

        res.status(201).json(responsePayload);
    } catch (error) {
        if (idemLocked) {
            await failIdempotencyLock(pool, { tenantId: tId, khoaIdem });
        }
        guiLoi(res, error, 'Lỗi API Tạo Order:');
    }
}

app.post('/api/order', kiemTraToken, choPhepVaiTro(1, 3, 4), kiemTraHanSuDung, kiemTraHanMucDonThang, handleCreateOrAppendOrder);
app.post('/api/order/them-mon', kiemTraToken, choPhepVaiTro(1, 3, 4), kiemTraHanSuDung, handleCreateOrAppendOrder);

// [P0] Counter 1-Tap Quick Checkout: Tạo đơn + Trừ kho + Thanh toán + Tích điểm trong 1 transaction duy nhất
app.post('/api/order/quick-checkout', kiemTraToken, choPhepVaiTro(1, 4), kiemTraHanSuDung, kiemTraHanMucDonThang, async (req, res) => {
    const {
        maBan = null,
        maKH = null,
        soTheRung = null,
        loaiDonHang = null,
        tenKhachVangLai = null,
        diaChiGiao = null,
        phiDongGoi = null,
        phiDongGoiMoiLy = 0,
        cachTinhThue = null,
        thueVATPhanTram = null,
        phiPhucVuPhanTram = null,
        branchId = null,
        maKhuyenMai = null,
        diemSuDung = 0,
        tuDongHappyHour = true,
        danhSachMon = [],
        combos = [],
        phuongThucTT = 'TIEN_MAT',
        tienKhachDua,
    } = req.body || {};
    const maNV = req.user.maNV;

    const loiMon = validateDanhSachMon(danhSachMon, combos);
    if (loiMon) return res.status(400).json({ message: loiMon });
    if (!PHUONG_THUC_TT.includes(phuongThucTT)) {
        return res.status(400).json({ message: `phuongThucTT phải là một trong: ${PHUONG_THUC_TT.join(', ')}` });
    }
    if (phuongThucTT === 'VOUCHER' && req.user.vaiTro !== 1) {
        return res.status(403).json({ message: 'Chỉ Quản lý mới có quyền xác nhận thanh toán bằng VOUCHER!' });
    }

    const khoaIdem = docKhoaIdempotency(req);
    if (khoaIdem === false) {
        return res.status(400).json({ message: 'Header Idempotency-Key không hợp lệ!' });
    }
    const dungIdem = Boolean(khoaIdem) && idemSanSang;
    const dauVanTay = dungIdem
        ? crypto.createHash('sha256').update(JSON.stringify({ quick: true, maBan, maKH, danhSachMon, combos, phuongThucTT })).digest('hex')
        : null;

    const tId = layTenantId(req);
    const resolvedBranchId = normalizeBranchId(branchId || req.user.branchId || 'DEFAULT');
    const clientOrderUid = req.body?.clientOrderUid
        ? String(req.body.clientOrderUid).trim().slice(0, 64)
        : khoaIdem || null;

    let idemLocked = false;
    if (dungIdem) {
        try {
            const lock = await acquireIdempotencyLock(pool, { tenantId: tId, khoaIdem, maNV, dauVanTay });
            if (!lock.acquired) {
                if (lock.state === 'KEY_REUSED') {
                    return res.status(422).json({ message: 'Idempotency-Key này đã được dùng cho đơn khác!', maLoi: 'IDEMPOTENCY_KEY_REUSED' });
                }
                if (lock.state === 'IN_FLIGHT') {
                    return res.status(409).json({
                        message: 'Đơn đang được xử lý (PROCESSING), vui lòng thử lại sau giây lát!',
                        maLoi: 'IDEMPOTENCY_IN_FLIGHT',
                        code: 'IDEMPOTENCY_IN_FLIGHT',
                    });
                }
                if (lock.state === 'DONE' && lock.record) {
                    if (lock.record.responseJson) {
                        return res.status(200).json({ ...lock.record.responseJson, trungLap: true });
                    }
                    const cached = await pool.withTenant(tId, async (client) => ({
                        hoaDon: await layHoaDonChiTiet(client, lock.record.maHoaDon),
                    }));
                    return res.status(200).json({
                        message: 'Thanh toán nhanh & chuyển pha chế thành công!',
                        maHoaDon: lock.record.maHoaDon,
                        hoaDon: cached.hoaDon,
                        trungLap: true,
                    });
                }
            }
            idemLocked = true;
        } catch (lockErr) {
            return guiLoi(res, lockErr, 'Lỗi khóa Idempotency (Quick Checkout):');
        }
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const laOfflineSync = req.get('X-Offline-Sync') === '1';
            const caInfo = await layCaChoGiaoDichOffline(client, {
                tenantId: tId,
                maCaGoc: req.body?.maCaThuNganGoc || null,
                laOfflineSync,
            });
            const ca = caInfo.ca;
            const maCaGoc = caInfo.maCaGoc;

            const { maHoaDon, laHoaDonMoi, dsMaCTHD, dsMaCTHDFired, canhBaoTonThap, soldOutWarnings, countdownUpdates } = await taoOrderTrongGiaoDich(client, {
                tenantId: tId,
                branchId: resolvedBranchId,
                maNV,
                vaiTro: req.user.vaiTro,
                maBan,
                maKH,
                soTheRung,
                loaiDonHang: loaiDonHang || (maBan ? 'TAI_QUAN' : 'MANG_DI'),
                tenKhachVangLai,
                diaChiGiao,
                phiDongGoi,
                phiDongGoiMoiLy,
                cachTinhThue,
                thueVATPhanTram,
                phiPhucVuPhanTram,
                clientOrderUid,
                laOfflineSync,
                offlineCreatedAt: req.body?.offlineCreatedAt || null,
                danhSachMon,
                combos,
                ip: req.ip,
            });

            // [P0 FIX] Lưu vết mã hóa đơn Offline (#OFF-HHMMSS) lên HoaDon
            const offlineClientId = req.body?.offlineClientId ? String(req.body.offlineClientId).trim().slice(0, 64) : null;
            if (offlineClientId) {
                await client.query('SAVEPOINT sp_qc_off_id');
                try {
                    await client.query(`UPDATE HoaDon SET MaOfflineClient = $2 WHERE MaHoaDon = $1`, [maHoaDon, offlineClientId]);
                    await client.query('RELEASE SAVEPOINT sp_qc_off_id');
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_qc_off_id').catch(() => {});
                }
            }

            // [Wave 1 — P0-03] Dùng chung ghiNhanThanhToanTrongGiaoDich để khóa FOR UPDATE & kiểm tra/trừ KhachHang.SoDuVi (chặn thanh toán 0đ qua Ví)
            const ttQc = await ghiNhanThanhToanTrongGiaoDich(client, {
                maHoaDon,
                expectedTenantId: tId,
                mandatoryVersion: false,
                ca,
                maNV,
                vaiTro: req.user.vaiTro,
                maKH: maKH || null,
                maKhuyenMai,
                diemSuDung,
                tuDongHappyHour: Boolean(tuDongHappyHour),
                autoFillSingleMethod: {
                    phuongThucTT,
                    tienKhachDua: tienKhachDua !== undefined && tienKhachDua !== null ? Number(tienKhachDua) : null,
                    nguonXacNhan: laOfflineSync ? 'POS_OFFLINE_SYNC' : 'POS_QUICK_CHECKOUT',
                },
                choPhepThuMotPhan: false,
                khoaIdem: dungIdem ? khoaIdem : null,
                laOfflineLechCa: Boolean(caInfo.lechCaDongBo),
                maCaThuNganGoc: caInfo.maCaGoc ? String(caInfo.maCaGoc) : null,
                branchId: normalizeBranchForShift(tId, branchId || ca.branchid),
                terminalId: normalizeTerminalId(req.body?.terminalId || ca.terminalid),
                ip: req.ip,
            });
            const tongTien = ttQc.tongTien;
            const tienThua = ttQc.tienThua;
            const diemCong = ttQc.diemCong || 0;
            const uuDai = ttQc.uuDai || {};

            if (laOfflineSync) {
                await ghiAuditLog(client, {
                    tenantId: tId,
                    maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'OFFLINE_ORDER_SYNCED',
                    doiTuong: 'HOADON',
                    maDoiTuong: maHoaDon,
                    giaTriMoi: {
                        khoaIdem,
                        offlineClientId,
                        offlineCreatedAt: req.body?.offlineCreatedAt || null,
                        maCaThuNganGoc: maCaGoc,
                        maCaHachToan: ca.macathungan,
                        lechCaDongBo: caInfo.lechCaDongBo,
                        caGocDaDong: caInfo.caGocDaDong,
                        ghiChuLechCa: caInfo.ghiChuLechCa,
                        soldOutWarnings,
                    },
                    lyDo: offlineClientId
                        ? `Đồng bộ Quick Checkout Offline ${offlineClientId}${caInfo.ghiChuLechCa ? ` (${caInfo.ghiChuLechCa})` : ''}`
                        : `Đồng bộ từ hàng đợi Offline Outbox Queue${caInfo.ghiChuLechCa ? ` (${caInfo.ghiChuLechCa})` : ''}`,
                    ip: req.ip,
                });
            }

            const monMoi = await layMonTheoMa(client, dsMaCTHDFired);
            const hoaDon = await layHoaDonChiTiet(client, maHoaDon);
            const kdsEmitPlan =
                monMoi.length > 0
                    ? await recordAndEmitOrderNewByStation(client, io, {
                          tenantId: tId,
                          branchId: resolvedBranchId,
                          maHoaDon,
                          maBan: maBan || null,
                          tenBan: monMoi[0]?.tenBan || null,
                          mangDi: !maBan,
                          themMon: false,
                          dotGoi: 1,
                          clientOrderUid,
                          monMoiFired: monMoi,
                      })
                    : null;

            return {
                trungLap: false,
                maHoaDon,
                laHoaDonMoi,
                dsMaCTHD,
                hoaDon,
                monMoi,
                tienThua,
                diemCong,
                canhBaoTonThap,
                soldOutWarnings,
                countdownUpdates,
                kdsEmitPlan,
            };
        }, tId);

        const qcResponse = {
            message: 'Thanh toán nhanh & chuyển pha chế thành công!',
            maHoaDon: ketQua.hoaDon?.maHoaDon || null,
            branchId: resolvedBranchId,
            clientOrderUid,
            hoaDon: ketQua.hoaDon,
            tienThua: ketQua.tienThua,
            diemCong: ketQua.diemCong,
            canhBaoTonThap: ketQua.canhBaoTonThap,
            soldOutWarnings: ketQua.soldOutWarnings,
            countdownUpdates: ketQua.countdownUpdates,
            trungLap: false,
        };

        if (idemLocked) {
            await completeIdempotencyLock(pool, {
                tenantId: tId,
                khoaIdem,
                maHoaDon: ketQua.maHoaDon,
                laHoaDonMoi: ketQua.laHoaDonMoi,
                dsMaCTHD: ketQua.dsMaCTHD,
                responseJson: qcResponse,
                httpStatus: 201,
            });
        }

        if (ketQua.kdsEmitPlan && typeof ketQua.kdsEmitPlan.flush === 'function') {
            ketQua.kdsEmitPlan.flush();
        }
        if (Array.isArray(ketQua.countdownUpdates) && ketQua.countdownUpdates.length > 0) {
            for (const cd of ketQua.countdownUpdates) {
                io.to(roomTen(tId, 'thungan')).to(roomTen(tId, 'phucvu')).to(roomTen(tId, 'barista')).emit('THUC_DON_THAY_DOI', cd);
            }
        }
        io.to(roomTen(tId, 'thungan')).emit('HOADON_DA_TT', { maHoaDon: ketQua.hoaDon.maHoaDon });
        void kiemTraCanhBaoTanSuatGianLan(pool, {
            tenantId: tId,
            maCaThuNgan: ketQua.hoaDon?.maCaThuNgan || null,
            maNV,
            vaiTro: req.user.vaiTro,
            maKH: maKH || null,
            phuongThucTT,
            coGiamGia: Number(ketQua.hoaDon?.tongGiamGia || 0) > 0,
            maHoaDon: ketQua.hoaDon?.maHoaDon,
            ghiAuditLog,
            ip: req.ip,
        });

        res.status(201).json(qcResponse);
    } catch (error) {
        if (idemLocked) {
            await failIdempotencyLock(pool, { tenantId: tId, khoaIdem });
        }
        guiLoi(res, error, 'Lỗi API Thanh toán nhanh:');
    }
});

// [P0] Danh sách tất cả hóa đơn đang mở (chưa thanh toán) — chống đơn Mang đi mồ côi
app.get('/api/hoadon/dangmo', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const r = await qTenant(req, `
            SELECT hd.MaHoaDon, hd.SoThuTuNgay, hd.ThoiGianTao, hd.MaKH, kh.TenKH,
                   (SELECT string_agg(b.TenBan, ', ' ORDER BY b.TenBan)
                      FROM HoaDon_Ban hb JOIN Ban b ON b.MaBan = hb.MaBan
                     WHERE hb.MaHoaDon = hd.MaHoaDon) AS TenBan,
                   COALESCE((SELECT SUM(c.SoLuong)
                               FROM ChiTietHoaDon c
                              WHERE c.MaHoaDon = hd.MaHoaDon AND c.TrangThaiPhaChe <> 'DaHuy'), 0) AS TongLy,
                   COALESCE((SELECT SUM(c.SoLuong * c.DonGia - COALESCE(c.GiaGiam, 0))
                               FROM ChiTietHoaDon c
                              WHERE c.MaHoaDon = hd.MaHoaDon AND c.TrangThaiPhaChe <> 'DaHuy'), 0)
                   + COALESCE((SELECT SUM(tp.SoLuong * tp.DonGia)
                                 FROM ChiTietHoaDon c2 JOIN ChiTietHoaDon_Topping tp ON tp.MaCTHD = c2.MaCTHD
                                WHERE c2.MaHoaDon = hd.MaHoaDon AND c2.TrangThaiPhaChe <> 'DaHuy'), 0) AS TongTamTinh
              FROM HoaDon hd
              LEFT JOIN KhachHang kh ON kh.MaKH = hd.MaKH
             WHERE hd.TrangThaiTT = 0 AND COALESCE(hd.TenantId, 'DEFAULT') = $1
             ORDER BY hd.ThoiGianTao DESC
             LIMIT 100
        `, [tenantId]);
        res.json(r.rows.map((row) => ({
            maHoaDon: row.mahoadon,
            soThuTuNgay: row.sothutungay ? Number(row.sothutungay) : null,
            thoiGianTao: row.thoigiantao,
            tenBan: row.tenban || null,
            mangDi: !row.tenban,
            tenKH: row.tenkh || null,
            tongLy: Number(row.tongly || 0),
            tongTamTinh: Number(row.tongtamtinh || 0),
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Hóa đơn đang mở:');
    }
});

// [P0] Lịch sử hóa đơn đã thanh toán / hoàn tiền trong ngày (phục vụ Đổi món / Hoàn tiền sau thanh toán)
app.get('/api/hoadon/lichsu', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    const isManager = Number(req.user?.vaiTro) === 1;
    const ngay = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.ngay || '')) ? req.query.ngay : ngayHomNayVN();
    try {
        const [r, openShiftRes] = await Promise.all([
            qTenant(req, `
                SELECT hd.MaHoaDon, hd.SoThuTuNgay, hd.TrangThaiTT, hd.PhuongThucTT, hd.TongTienThanhToan,
                       hd.ThoiGianTao, hd.ThoiGianThanhToan, hd.MaCaThuNgan,
                       kh.TenKH,
                       (SELECT string_agg(b.TenBan, ', ' ORDER BY b.TenBan)
                          FROM HoaDon_Ban hb JOIN Ban b ON b.MaBan = hb.MaBan
                         WHERE hb.MaHoaDon = hd.MaHoaDon) AS TenBan,
                       COALESCE((SELECT SUM(c.SoLuong) FROM ChiTietHoaDon c WHERE c.MaHoaDon = hd.MaHoaDon), 0) AS TongLy
                  FROM HoaDon hd
                  LEFT JOIN KhachHang kh ON kh.MaKH = hd.MaKH
                 WHERE COALESCE(hd.TenantId, 'DEFAULT') = $1
                   AND hd.TrangThaiTT IN (1, 2)
                   AND COALESCE(hd.ThoiGianThanhToan, hd.ThoiGianTao) >= ($2::timestamp AT TIME ZONE '${VN_TZ}')
                   AND COALESCE(hd.ThoiGianThanhToan, hd.ThoiGianTao) < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                 ORDER BY COALESCE(hd.ThoiGianThanhToan, hd.ThoiGianTao) DESC
                 LIMIT 50
            `, [tenantId, ngay]),
            isManager
                ? Promise.resolve({ rows: [] })
                : qTenant(
                      req,
                      `SELECT MaCaThuNgan FROM CaThuNgan WHERE COALESCE(TenantId, 'DEFAULT') = $1 AND TrangThaiCa = 1`,
                      [tenantId]
                  ),
        ]);
        const openShiftIds = new Set(openShiftRes.rows.map((s) => String(s.macathungan)));
        res.json(r.rows.map((row) => {
            // [Wave 1 — P0-07] Bịt rò rỉ Blind Drop: ẩn số tiền đơn TIỀN MẶT thuộc ca đang mở đối với vai trò Thu ngân
            const isMaskedCash =
                !isManager &&
                row.macathungan !== null &&
                openShiftIds.has(String(row.macathungan)) &&
                String(row.phuongthuctt || '').toUpperCase() === 'TIEN_MAT';
            return {
                maHoaDon: row.mahoadon,
                soThuTuNgay: row.sothutungay ? Number(row.sothutungay) : null,
                trangThaiTT: row.trangthaitt,
                daHoanTien: row.trangthaitt === 2,
                phuongThucTT: row.phuongthuctt,
                tongTienThanhToan: isMaskedCash ? null : Number(row.tongtienthanhtoan || 0),
                blindDropMasked: isMaskedCash,
                thoiGianTao: row.thoigiantao,
                thoiGianThanhToan: row.thoigianthanhtoan,
                maCaThuNgan: row.macathungan || null,
                tenBan: row.tenban || null,
                mangDi: !row.tenban,
                tenKH: row.tenkh || null,
                tongLy: Number(row.tongly || 0),
            };
        }));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lịch sử hóa đơn:');
    }
});

// Chống brute-force mã PIN Quản lý (4-6 chữ số): tối đa 5 lần nhập sai / 5 phút trên mỗi (tenant + IP)
const PIN_FAIL_WINDOW_MS = 5 * 60 * 1000;
const PIN_MAX_FAILS = 5;
const pinFailMap = new Map(); // key -> { count, resetAt }

function kiemTraGioiHanPin(tenantId, ip) {
    const key = `${tenantId}|${ip || 'unknown'}`;
    const entry = pinFailMap.get(key);
    if (!entry) return null;
    if (entry.resetAt <= Date.now()) {
        pinFailMap.delete(key);
        return null;
    }
    if (entry.count >= PIN_MAX_FAILS) {
        const secs = Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
        return `Nhập sai mã PIN Quản lý quá ${PIN_MAX_FAILS} lần! Vui lòng thử lại sau ${Math.ceil(secs / 60)} phút.`;
    }
    return null;
}

function ghiNhanPinSai(tenantId, ip) {
    const key = `${tenantId}|${ip || 'unknown'}`;
    const cur = pinFailMap.get(key);
    if (cur && cur.resetAt > Date.now()) cur.count += 1;
    else pinFailMap.set(key, { count: 1, resetAt: Date.now() + PIN_FAIL_WINDOW_MS });
}

function xoaDemPinSai(tenantId, ip) {
    pinFailMap.delete(`${tenantId}|${ip || 'unknown'}`);
}

// Helper xác thực Manager / Shift Supervisor Override PIN (4-6 chữ số) — Tối ưu O(1) khi truyền maNVDuyet!
async function xacThucPinQuanLy(
    db,
    tenantId,
    rawPin,
    ip = null,
    maNVDuyet = null,
    requiredPerm = 'order.item.void_approve'
) {
    const blockedMsg = kiemTraGioiHanPin(tenantId, ip);
    if (blockedMsg) {
        throw new LoiNghiepVu(429, blockedMsg, { maLoi: 'PIN_RATE_LIMITED' });
    }
    const pin = String(rawPin || '').trim();
    if (!/^\d{4,6}$/.test(pin)) {
        ghiNhanPinSai(tenantId, ip);
        return null;
    }
    const targetMaNV = typeof maNVDuyet === 'string' && maNVDuyet.trim() ? maNVDuyet.trim() : null;
    try {
        // [P1 O(1) Optimization] Khi POS gửi kèm maNVDuyet (chọn Quản lý / Ca trưởng từ danh sách) -> chỉ băm scrypt đúng 1 dòng O(1)!
        // Nếu không truyền maNVDuyet, giới hạn tối đa LIMIT 3 để chống DoS CPU/RAM khi nhập sai PIN.
        const managers = await db.query(
            `SELECT MaNV, TenNV, VaiTro, PinHash,
                    COALESCE((to_jsonb(NhanVien)->'permissionsoverride')::jsonb, '{}'::jsonb) AS PermissionsOverride
               FROM NhanVien
              WHERE TrangThaiLamViec = TRUE
                AND COALESCE(TenantId, 'DEFAULT') = $1
                AND PinHash IS NOT NULL
                AND ($2::text IS NULL OR MaNV = $2)
                AND (
                    VaiTro = 1
                    OR COALESCE((to_jsonb(NhanVien)->'permissionsoverride'->>'isShiftSupervisor')::boolean, FALSE) = TRUE
                    OR COALESCE((to_jsonb(NhanVien)->'permissionsoverride'->>$3)::boolean, FALSE) = TRUE
                )
              ORDER BY VaiTro ASC, MaNV ASC
              LIMIT $4`,
            [tenantId, targetMaNV, requiredPerm, targetMaNV ? 1 : 3]
        );
        for (const mgr of managers.rows) {
            const { ok } = await verifyPassword(pin, mgr.pinhash);
            if (ok) {
                xoaDemPinSai(tenantId, ip);
                return { maNV: mgr.manv, tenNV: mgr.tennv, vaiTro: Number(mgr.vaitro) };
            }
        }
    } catch {
        return null;
    }
    ghiNhanPinSai(tenantId, ip);
    return null;
}

// Helper dùng chung: đọc Map<MaNL, GiaVonDonVi> hiện tại để snapshot vào ChiTietGiaoDichKho.DonGiaNhap (chống ghi 0đ khi xuất hủy/tiêu hao/hoàn kho)
async function layMapGiaVonNguyenLieu(client, tenantId, dsMaNL) {
    const list = [...new Set((dsMaNL || []).filter(Boolean))];
    const map = new Map();
    if (list.length === 0) return map;
    const r = await client.query(
        `SELECT MaNL, COALESCE(GiaVonDonVi, 0) AS GiaVonDonVi
           FROM NguyenLieu
          WHERE MaNL = ANY($1::varchar[]) AND COALESCE(TenantId, 'DEFAULT') = $2`,
        [list, tenantId]
    );
    for (const row of r.rows) {
        map.set(row.manl, Number(row.giavondonvi || 0));
    }
    return map;
}

// Helper dùng chung: gom định lượng nguyên liệu (Món + Substitution BOM Modifiers + Topping đa NL + Vật tư mang đi)
async function congDinhLuongNguyenLieuDongMon(client, tenantId, { maCTHD, maMon, kichThuoc, soLuong }, tieuHaoMap) {
    const congNL = (maNL, sl) => {
        if (!maNL || !(sl > 0)) return;
        tieuHaoMap.set(maNL, lam3((tieuHaoMap.get(maNL) || 0) + sl));
    };

    // [Phân hệ 4 - 5-Layer BOM Snapshot] Nếu dòng ChiTietHoaDon đã lưu BomSnapshotJson lúc bán -> hoàn trả 100% chính xác từng ml/cái!
    await client.query('SAVEPOINT sp_bom_snap_read');
    try {
        const snapRes = await client.query(
            `SELECT (to_jsonb(c)->'bomsnapshotjson') AS snap FROM ChiTietHoaDon c WHERE c.MaCTHD = $1`,
            [maCTHD]
        );
        await client.query('RELEASE SAVEPOINT sp_bom_snap_read');
        const snap = snapRes.rows[0]?.snap;
        if (snap && typeof snap === 'object' && !Array.isArray(snap) && Object.keys(snap).length > 0) {
            for (const [maNL, qty] of Object.entries(snap)) {
                congNL(maNL, Number(qty));
            }
            return;
        }
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_bom_snap_read').catch(() => {});
    }

    const ctRes = await client.query(
        'SELECT MaNL, KhoiLuongTieuHao FROM CongThuc WHERE MaMon = $1 AND KichThuoc = $2',
        [maMon, kichThuoc]
    );
    const baseBomRows = ctRes.rows.map((ct) => ({
        maNL: ct.manl,
        khoiLuong: Number(ct.khoiluongtieuhao),
    }));

    // Đọc ModifiersSnapshot & IsTakeaway trên ChiTietHoaDon (nếu có) để hoàn/hủy đúng Substitution BOM & vật tư đóng gói
    let modifierDeltas = [];
    let isTakeaway = false;
    await client.query('SAVEPOINT sp_bom_cthd_meta');
    try {
        const metaRes = await client.query(
            `SELECT COALESCE((to_jsonb(c)->'modifierssnapshot')::jsonb, '[]'::jsonb) AS mods,
                    COALESCE((to_jsonb(c)->>'istakeaway')::boolean, FALSE) AS istakeaway
               FROM ChiTietHoaDon c WHERE c.MaCTHD = $1`,
            [maCTHD]
        );
        const mods = Array.isArray(metaRes.rows[0]?.mods) ? metaRes.rows[0].mods : [];
        isTakeaway = Boolean(metaRes.rows[0]?.istakeaway);
        const optIds = [...new Set(mods.map((m) => Number(m?.optionId)).filter((n) => Number.isInteger(n) && n > 0))];
        if (optIds.length > 0) {
            const mbRes = await client.query(
                `SELECT optionid, kichthuoc, manl, khoiluongdelta
                   FROM modifier_option_bom
                  WHERE tenantid = $1 AND optionid = ANY($2::bigint[])`,
                [tenantId, optIds]
            );
            const bomByOpt = new Map();
            for (const b of mbRes.rows) {
                const oid = Number(b.optionid);
                if (!bomByOpt.has(oid)) bomByOpt.set(oid, []);
                bomByOpt.get(oid).push(b);
            }
            for (const m of mods) {
                const oid = Number(m?.optionId);
                const qty = Math.max(1, Number(m?.qty || 1));
                const rows = bomByOpt.get(oid) || [];
                const spec = rows.filter((b) => b.kichthuoc && b.kichthuoc === kichThuoc);
                const univ = rows.filter((b) => !b.kichthuoc);
                for (const b of spec.length > 0 ? spec : univ) {
                    modifierDeltas.push({ maNL: b.manl, khoiLuongDelta: Number(b.khoiluongdelta) * qty });
                }
            }
        }
        await client.query('RELEASE SAVEPOINT sp_bom_cthd_meta');
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_bom_cthd_meta').catch(() => {});
    }

    const packagingBomRows = [];
    if (isTakeaway) {
        await client.query('SAVEPOINT sp_bom_pack_void');
        try {
            const pkRes = await client.query(
                `SELECT manl, soluongtieuhao FROM cauhinh_vattu_mangdi
                  WHERE tenantid = $1 AND kichthuoc IN ($2, 'ALL')`,
                [tenantId, String(kichThuoc || 'M').toUpperCase()]
            );
            for (const r of pkRes.rows) {
                packagingBomRows.push({ maNL: r.manl, khoiLuong: Number(r.soluongtieuhao) });
            }
            await client.query('RELEASE SAVEPOINT sp_bom_pack_void');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_bom_pack_void').catch(() => {});
        }
    }

    const perCupCalc = tinhBomMotLySauSubstitution({
        baseBomRows,
        modifierDeltas,
        toppingBomRows: [],
        packagingBomRows,
    });
    for (const [maNL, perCupQty] of perCupCalc.perCupMap.entries()) {
        congNL(maNL, perCupQty * Number(soLuong));
    }

    const tpRes = await client.query(
        `SELECT ctp.MaTopping, tp.MaNL, tp.KhoiLuongTieuHao, ctp.SoLuong
           FROM ChiTietHoaDon_Topping ctp JOIN Topping tp ON tp.MaTopping = ctp.MaTopping
          WHERE ctp.MaCTHD = $1`,
        [maCTHD]
    );
    for (const tp of tpRes.rows) {
        let usedMulti = false;
        try {
            await client.query('SAVEPOINT sp_bom_tp');
            const mRes = await client.query(
                'SELECT MaNL, KhoiLuongTieuHao FROM Topping_CongThuc WHERE TenantId = $1 AND MaTopping = $2',
                [tenantId, tp.matopping]
            );
            await client.query('RELEASE SAVEPOINT sp_bom_tp');
            if (mRes.rows.length > 0) {
                usedMulti = true;
                for (const b of mRes.rows) {
                    congNL(b.manl, Number(b.khoiluongtieuhao) * Number(tp.soluong));
                }
            }
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_bom_tp').catch(() => {});
        }
        if (!usedMulti) {
            congNL(tp.manl, Number(tp.khoiluongtieuhao) * Number(tp.soluong));
        }
    }
}

// [P0 + Phân hệ 1 100/100] Hủy món: Waste vs Return Stock + Manager PIN + Phá vỡ Combo + Tự động kiểm định lại KM + Optimistic Locking
app.post('/api/order/huy-mon', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
    const { maCTHD, lyDo, hoanKho = true, managerPin = null, maNVDuyet = null, expectedVersion = null } = req.body || {};
    const tenantId = layTenantId(req);
    if (!maCTHD) return res.status(400).json({ message: 'Thiếu mã chi tiết hóa đơn (maCTHD)!' });
    if (!lyDo || String(lyDo).trim().length < 3) {
        return res.status(400).json({ message: 'Vui lòng nhập lý do hủy món (tối thiểu 3 ký tự)!' });
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const cRes = await client.query(
                `SELECT c.MaCTHD, c.MaHoaDon, c.MaMon, c.KichThuoc, c.SoLuong, c.DonGia, c.TrangThaiPhaChe,
                        COALESCE(c.GiaVonSnapshot, 0) AS GiaVonSnapshot,
                        to_jsonb(c)->>'combogroupuid' AS ComboGroupUid,
                        sp.TenMon, sp.NhomMon, to_jsonb(sp)->>'tramchebien' AS TramCheBien,
                        COALESCE((to_jsonb(sp)->>'lahangdonggoi')::boolean, FALSE) AS LaHangDongGoi,
                        hd.TrangThaiTT, COALESCE(hd.DaInTamTinh, FALSE) AS DaInTamTinh,
                        COALESCE(NULLIF(to_jsonb(hd)->>'branchid', ''), 'DEFAULT') AS BranchId
                   FROM ChiTietHoaDon c
                   JOIN HoaDon hd ON hd.MaHoaDon = c.MaHoaDon
                   JOIN SanPham sp ON sp.MaMon = c.MaMon
                  WHERE c.MaCTHD = $1
                    AND COALESCE(hd.TenantId, 'DEFAULT') = $2
                  FOR UPDATE OF c, hd`,
                [maCTHD, tenantId]
            );
            if (cRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy món cần hủy!');
            const item = cRes.rows[0];
            if (item.trangthaiphache === 'DaHuy') throw new LoiNghiepVu(409, 'Món này đã được hủy trước đó!');
            if (item.trangthaitt === 1) throw new LoiNghiepVu(409, 'Hóa đơn đã thanh toán, vui lòng dùng chức năng Hoàn tiền sau thanh toán!');
            if (item.trangthaitt === 2) throw new LoiNghiepVu(409, 'Hóa đơn này đã được hoàn tiền!');

            await kiemTraVaTangVersionHoaDon(client, {
                maHoaDon: item.mahoadon,
                tenantId,
                expectedVersion,
                layHoaDonChiTiet,
                LoiNghiepVu,
            });

            const daPhaChe = item.trangthaiphache !== 'ChoPhaChe';
            const tuDuQuyenDuyet = coQuyenHan(req.user, 'order.item.void_approve');
            let nguoiDuyet = tuDuQuyenDuyet ? req.user.maNV : null;

            // Chống gian lận Pre-bill Scam & Hủy món đã pha: chỉ Quản lý / Ca trưởng được phân quyền HOẶC nhập đúng PIN O(1)
            if ((daPhaChe || item.daintamtinh) && !tuDuQuyenDuyet) {
                const mgr = managerPin
                    ? await xacThucPinQuanLy(client, tenantId, managerPin, req.ip, maNVDuyet, 'order.item.void_approve')
                    : null;
                if (!mgr) {
                    throw new LoiNghiepVu(
                        403,
                        managerPin
                            ? 'Mã PIN Quản lý / Ca trưởng không chính xác hoặc chưa được thiết lập!'
                            : item.daintamtinh
                            ? 'Hóa đơn đã in tạm tính! Cần nhập mã PIN Quản lý / Ca trưởng để phê duyệt hủy món.'
                            : 'Món đã nhận pha chế/hoàn thành! Cần nhập mã PIN Quản lý / Ca trưởng để xác nhận hủy hao hụt.',
                        { maLoi: 'CAN_PIN_QUAN_LY' }
                    );
                }
                nguoiDuyet = mgr.maNV;
            }

            // Tính định lượng nguyên liệu của dòng món (dùng để hoàn kho nếu chưa pha HOẶC lập phiếu hao hụt LoaiGD=8 nếu đã pha)
            const tieuHaoMon = new Map();
            await congDinhLuongNguyenLieuDongMon(
                client,
                tenantId,
                { maCTHD, maMon: item.mamon, kichThuoc: item.kichthuoc, soLuong: item.soluong },
                tieuHaoMon
            );

            const daPhucVu = item.trangthaiphache === 'DaPhucVu';
            // Cấm tuyệt đối hoàn kho món đã phục vụ (DaPhucVu) kể cả là hàng đóng gói (laHangDongGoi = true)
            const thucHienHoanKho = !daPhucVu && (!daPhaChe || Boolean(item.lahangdonggoi)) && Boolean(hoanKho);
            const trangThaiHuy = thucHienHoanKho ? 'CANCELLED_BEFORE_PREP' : 'WASTED_AFTER_PREP';
            const hdBrRes = await client.query(
                `SELECT COALESCE(NULLIF(NULLIF(to_jsonb(hd)->>'branchid', ''), 'DEFAULT'), $2::text || '_MAIN') AS branchid
                   FROM HoaDon hd WHERE hd.MaHoaDon = $1`,
                [item.mahoadon, tenantId]
            );
            const voidBranchId = normalizeInventoryBranch(tenantId, hdBrRes.rows[0]?.branchid);
            const caMoVoid = await layCaDangMo(client, 'SHARE', tenantId, { branchId: voidBranchId });
            const { stockMap: voidStockMap } =
                tieuHaoMon.size > 0
                    ? await lockBranchStockOrdered(client, tenantId, voidBranchId, [...tieuHaoMon.keys()])
                    : { stockMap: new Map() };
            const giaVonVoidMap = new Map([...voidStockMap.entries()].map(([k, v]) => [k, v.giaVonDonVi]));

            if (thucHienHoanKho && tieuHaoMon.size > 0) {
                const phieu = await client.query(
                    `INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan, NgayChungTu, TrangThaiDuyet)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::date, 'POSTED') RETURNING MaGiaoDich`,
                    [
                        req.user.maNV,
                        LOAI_GD_HOAN_KHO,
                        `Hoàn kho hủy món HĐ ${item.mahoadon}: ${String(lyDo).trim()}`,
                        tenantId,
                        voidBranchId,
                        caMoVoid ? String(caMoVoid.macathungan) : null,
                        todayDateVN(),
                    ]
                );
                const maGD = phieu.rows[0].magiaodich;
                for (const [maNL, sl] of [...tieuHaoMon].sort((a, b) => a[0].localeCompare(b[0]))) {
                    const st = voidStockMap.get(maNL);
                    if (!st) continue;
                    const qty = lam3(sl);
                    const tonTruoc = st.soLuongTon;
                    const tonSau = lam3(tonTruoc + qty);
                    await insertLedgerLine(client, {
                        maGiaoDich: maGD,
                        maNL,
                        soLuong: qty,
                        donGiaNhap: st.giaVonDonVi,
                        tinhTrang: 'Hoàn kho hủy món',
                        tonTruoc,
                        tonSau,
                        giaVonTruoc: st.giaVonDonVi,
                        giaVonSau: st.giaVonDonVi,
                    });
                    await updateBranchStockRow(client, { tenantId, branchId: voidBranchId, maNL, nextQty: tonSau });
                }
            } else if (!thucHienHoanKho && tieuHaoMon.size > 0) {
                const phieuWaste = await client.query(
                    `INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan, MaLyDoHuy, NgayChungTu, TrangThaiDuyet)
                     VALUES ($1, $2, $3, $4, $5, $6, 'CUSTOMER_REMAKE', $7::date, 'POSTED') RETURNING MaGiaoDich`,
                    [
                        req.user.maNV,
                        LOAI_GD_HAO_HUT_HUY_MON,
                        `Hao hụt hủy món đã pha HĐ ${item.mahoadon}: ${String(lyDo).trim()}`,
                        tenantId,
                        voidBranchId,
                        caMoVoid ? String(caMoVoid.macathungan) : null,
                        todayDateVN(),
                    ]
                );
                const maGDW = phieuWaste.rows[0].magiaodich;
                for (const [maNL, sl] of [...tieuHaoMon].sort((a, b) => a[0].localeCompare(b[0]))) {
                    const st = voidStockMap.get(maNL);
                    await insertLedgerLine(client, {
                        maGiaoDich: maGDW,
                        maNL,
                        soLuong: lam3(sl),
                        donGiaNhap: st?.giaVonDonVi || 0,
                        tinhTrang: 'Hao hụt - hủy món đã pha',
                        tonTruoc: st?.soLuongTon ?? null,
                        tonSau: st?.soLuongTon ?? null,
                        giaVonTruoc: st?.giaVonDonVi ?? null,
                        giaVonSau: st?.giaVonDonVi ?? null,
                    });
                }
            }

            await client.query(
                `UPDATE ChiTietHoaDon
                    SET TrangThaiPhaChe = 'DaHuy',
                        trang_thai_huy = $3,
                        LyDoHuy = $2
                  WHERE MaCTHD = $1`,
                [maCTHD, String(lyDo).trim().slice(0, 255), trangThaiHuy]
            );

            // Luật 2 Combo: Nếu hủy 1 món con trong Combo -> Phá vỡ Combo, chuyển các món còn lại về giá bán lẻ niêm yết + Audit Log!
            let comboBreakInfo = { comboBroken: false, updatedSiblings: [] };
            if (item.combogroupuid) {
                comboBreakInfo = await phaVoComboKhiHuyMon(client, {
                    tenantId,
                    maHoaDon: item.mahoadon,
                    comboGroupUid: item.combogroupuid,
                    maCTHDHuy: maCTHD,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    ip: req.ip,
                    ghiAuditLog,
                });
            }

            // Tự động kiểm định lại Khuyến mãi & Điểm Loyalty + Thuế/Phí ngay trong ACID transaction
            const recalc = await recalculateInvoiceTotals(client, {
                tenantId,
                maHoaDon: item.mahoadon,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                ip: req.ip,
                ghiAuditLog,
                kiemTraHopLeKhuyenMai,
            });

            // Kiểm tra: tổng tiền mới không được tụt thấp hơn số tiền khách đã thanh toán trước (Partial Payment)
            const hdPostVoid = await layHoaDonChiTiet(client, item.mahoadon);
            const daThanhToanMoi = Number(hdPostVoid?.daThanhToan || 0);
            const tongPhaiTraMoi = Number(recalc?.totals?.tongTienThanhToan ?? hdPostVoid?.tongTienThanhToan ?? 0);
            if (tongPhaiTraMoi < daThanhToanMoi) {
                throw new LoiNghiepVu(
                    409,
                    `Không thể hủy món vì tổng tiền còn lại (${tongPhaiTraMoi.toLocaleString('vi-VN')}đ) thấp hơn số tiền khách đã thanh toán (${daThanhToanMoi.toLocaleString('vi-VN')}đ)!`,
                    {
                        maLoi: 'VOID_EXCEEDS_UNPAID_BALANCE',
                        code: 'VOID_EXCEEDS_UNPAID_BALANCE',
                        tongPhaiTraMoi,
                        daThanhToan: daThanhToanMoi,
                    }
                );
            }

            // Chống Table Brick Deadlock: nếu số món hiệu lực về 0 và daThanhToan == 0 -> chuyển VOIDED + trả bàn trống + xoay QrToken!
            const activeCountRes = await client.query(
                `SELECT COUNT(*)::int AS cnt FROM ChiTietHoaDon WHERE MaHoaDon = $1 AND TrangThaiPhaChe <> 'DaHuy'`,
                [item.mahoadon]
            );
            const soMonHieuLuc = Number(activeCountRes.rows[0]?.cnt || 0);
            let autoVoidedOrder = false;
            let freedTables = [];
            if (soMonHieuLuc === 0 && daThanhToanMoi <= 0) {
                await client.query(
                    `UPDATE HoaDon SET lifecycle_status = 'VOIDED', TrangThaiTT = 0 WHERE MaHoaDon = $1`,
                    [item.mahoadon]
                );
                const banLinkRes = await client.query(
                    `SELECT MaBan FROM HoaDon_Ban WHERE MaHoaDon = $1`,
                    [item.mahoadon]
                );
                freedTables = banLinkRes.rows.map((r) => r.maban);
                await client.query(`DELETE FROM HoaDon_Ban WHERE MaHoaDon = $1`, [item.mahoadon]);
                if (freedTables.length > 0) {
                    await client.query(
                        `UPDATE Ban SET TrangThai = 1 WHERE MaBan = ANY($1::varchar[]) AND COALESCE(TenantId, 'DEFAULT') = $2`,
                        [freedTables, tenantId]
                    );
                    await xoayQrTokenChoCacBan(client, freedTables);
                }
                autoVoidedOrder = true;
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                nguoiDuyet,
                hanhDong: thucHienHoanKho ? 'ITEM_VOID_RETURN_STOCK' : 'ITEM_VOID_WASTE',
                doiTuong: 'CHITIETHOADON',
                maDoiTuong: maCTHD,
                giaTriCu: { maHoaDon: item.mahoadon, maMon: item.mamon, soLuong: item.soluong, trangThaiPhaChe: item.trangthaiphache, giaVonHaoHut: Number(item.giavonsnapshot) * Number(item.soluong) },
                giaTriMoi: { trangThaiPhaChe: 'DaHuy', hoanKho: thucHienHoanKho, comboBroken: comboBreakInfo.comboBroken, promoAdjusted: recalc.promoAdjusted },
                lyDo: String(lyDo).trim(),
                ip: req.ip,
                batBuoc: true,
            });

            const stationVoid = suyLuanTramCheBien({
                tramCheBien: item.tramchebien,
                nhomMon: item.nhommon,
                tenMon: item.tenmon,
            });
            const branchIdVoid = normalizeBranchId(item.branchid || 'DEFAULT');
            const voidPayload = {
                maCTHD,
                maHoaDon: item.mahoadon,
                maMon: item.mamon,
                tenMon: item.tenmon,
                soLuong: item.soluong,
                trangThaiCu: item.trangthaiphache,
                hoanKho: thucHienHoanKho,
                lyDo: String(lyDo).trim(),
                requiresAck: true,
            };
            const logVoid = await insertKdsEventLog(client, {
                tenantId,
                branchId: branchIdVoid,
                station: stationVoid,
                eventType: 'ITEM_VOID',
                maHoaDon: item.mahoadon,
                payload: voidPayload,
            });

            return {
                maHoaDon: item.mahoadon,
                hoanKho: thucHienHoanKho,
                trangThaiHuy,
                autoVoidedOrder,
                freedTables,
                comboBroken: comboBreakInfo.comboBroken,
                promoAdjusted: recalc.promoAdjusted,
                promoAdjustReasons: recalc.promoAdjustReasons,
                branchId: branchIdVoid,
                station: stationVoid,
                seq: logVoid.seq,
                voidPayload,
                hoaDon: await layHoaDonChiTiet(client, item.mahoadon),
            };
        }, tenantId);

        emitScopedKdsEvent(io, {
            tenantId,
            branchId: ketQua.branchId,
            station: ketQua.station,
            seq: ketQua.seq,
            eventType: 'ITEM_VOID',
            socketEvents: ['kds:item_voided', 'MON_BI_HUY'],
            payload: ketQua.voidPayload,
            includeExpo: true,
            includeWaiter: true,
            includePos: true,
            legacyBaristaEvent: 'kds:item_voided',
            legacyWaiterEvent: 'MON_BI_HUY',
            legacyPosEvent: 'MON_BI_HUY',
        });
        io.to(roomTen(tenantId, 'barista')).emit('MON_BI_HUY', ketQua.voidPayload);
        if (ketQua.autoVoidedOrder) {
            io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('BAN_THAY_DOI', {
                loai: 'ORDER_AUTO_VOIDED',
                maHoaDon: ketQua.maHoaDon,
                freedTables: ketQua.freedTables || [],
            });
        }

        res.json({
            message: ketQua.hoanKho ? 'Đã hủy món và hoàn trả nguyên liệu vào kho!' : 'Đã hủy món và ghi nhận phiếu hao hụt pha chế!',
            ...ketQua,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Hủy món:');
    }
});

// [L2.2] Đổi món (/api/order/:maHoaDon/doi-mon & /api/order/item-swap) đã được hợp nhất về modules/kdsPhase2Routes.js (emit 3 tầng + kds_event_log + FOR UPDATE).

// [P0/P1] Hoàn tiền sau thanh toán: Hỗ trợ cả Hoàn toàn bộ hóa đơn & Hoàn tiền một phần từng món (dsMaCTHDHoan)
app.post('/api/order/:maHoaDon/hoan-tien', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
    const { maHoaDon } = req.params;
    const {
        lyDo,
        phuongThucHoan = 'TIEN_MAT',
        hoanKho = false,
        managerPin = null,
        maNVDuyet = null,
        dsMaCTHDHoan = null,
    } = req.body || {};
    const tenantId = layTenantId(req);

    if (!lyDo || String(lyDo).trim().length < 3) {
        return res.status(400).json({ message: 'Vui lòng nhập lý do hoàn tiền / hủy đơn sau thanh toán (tối thiểu 3 ký tự)!' });
    }
    if (!PHUONG_THUC_TT.includes(phuongThucHoan)) {
        return res.status(400).json({ message: `phuongThucHoan phải thuộc: ${PHUONG_THUC_TT.join(', ')}` });
    }
    const cleanLyDo = String(lyDo).trim().slice(0, 255);
    const partialIdsSet =
        Array.isArray(dsMaCTHDHoan) && dsMaCTHDHoan.length > 0
            ? new Set(dsMaCTHDHoan.map((id) => String(id)))
            : null;

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const ca = await layCaDangMo(client, 'SHARE', tenantId);
            if (!ca) throw loiChuaMoCa();

            const tuDuQuyenHoan = coQuyenHan(req.user, 'order.refund.approve');
            let nguoiDuyet = tuDuQuyenHoan ? req.user.maNV : null;
            if (!tuDuQuyenHoan) {
                const mgr = managerPin
                    ? await xacThucPinQuanLy(client, tenantId, managerPin, req.ip, maNVDuyet, 'order.refund.approve')
                    : null;
                if (!mgr) {
                    throw new LoiNghiepVu(
                        403,
                        managerPin
                            ? 'Mã PIN Quản lý / Ca trưởng không chính xác hoặc chưa được thiết lập!'
                            : 'Hoàn tiền sau thanh toán bắt buộc phải có mã PIN Quản lý / Ca trưởng phê duyệt!',
                        { maLoi: 'CAN_PIN_QUAN_LY' }
                    );
                }
                nguoiDuyet = mgr.maNV;
            }

            let hdRes;
            await client.query('SAVEPOINT sp_refund_hd_sel');
            try {
                hdRes = await client.query(
                    `SELECT MaHoaDon, TrangThaiTT, TongTienThanhToan, MaKH, PhuongThucTT, MaCaThuNgan,
                            MaKhuyenMai, COALESCE(TienGiamKM, 0) AS TienGiamKM,
                            COALESCE(DiemSuDung, 0) AS DiemSuDung, COALESCE(TienGiamDiem, 0) AS TienGiamDiem
                       FROM HoaDon
                      WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                      FOR UPDATE`,
                    [maHoaDon, tenantId]
                );
                await client.query('RELEASE SAVEPOINT sp_refund_hd_sel');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_refund_hd_sel').catch(() => {});
                hdRes = await client.query(
                    `SELECT MaHoaDon, TrangThaiTT, TongTienThanhToan, MaKH, PhuongThucTT
                       FROM HoaDon
                      WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                      FOR UPDATE`,
                    [maHoaDon, tenantId]
                );
            }
            if (hdRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn!');
            const hd = hdRes.rows[0];
            if (hd.trangthaitt === 0) {
                throw new LoiNghiepVu(409, 'Hóa đơn chưa thanh toán, vui lòng hủy trực tiếp từng món trên đơn!');
            }
            if (hd.trangthaitt === 2) {
                throw new LoiNghiepVu(409, 'Hóa đơn này đã được hoàn tiền toàn bộ trước đó!');
            }

            const itemsRes = await client.query(
                `SELECT c.MaCTHD, c.MaMon, c.KichThuoc, c.SoLuong, c.DonGia, COALESCE(c.GiaGiam, 0) AS GiaGiam,
                        COALESCE((
                            SELECT SUM(ctp.SoLuong * ctp.DonGia)
                              FROM ChiTietHoaDon_Topping ctp
                             WHERE ctp.MaCTHD = c.MaCTHD
                        ), 0) AS TienTopping
                   FROM ChiTietHoaDon c
                  WHERE c.MaHoaDon = $1 AND c.TrangThaiPhaChe <> 'DaHuy'
                  FOR UPDATE OF c`,
                [maHoaDon]
            );
            const activeItems = itemsRes.rows.map((r) => ({
                ...r,
                thanhTien:
                    Number(r.soluong) * Number(r.dongia) -
                    Number(r.giagiam || 0) +
                    Number(r.tientopping || 0),
            }));
            if (activeItems.length === 0) {
                throw new LoiNghiepVu(409, 'Hóa đơn này không còn món hợp lệ nào để hoàn tiền!');
            }

            const targetItems = partialIdsSet
                ? activeItems.filter((r) => partialIdsSet.has(String(r.macthd)))
                : activeItems;
            if (targetItems.length === 0) {
                throw new LoiNghiepVu(400, 'Không tìm thấy dòng món hợp lệ cần hoàn trong dsMaCTHDHoan!');
            }
            const laHoanMotPhan = targetItems.length < activeItems.length;

            // [P0 FIX] Hoàn đúng số tiền khách thực thanh toán (hoặc phân bổ đúng tỷ lệ cho các món hoàn 1 phần)
            let soTienConCoTheHoan = Math.max(0, Number(hd.tongtienthanhtoan || 0));
            const diemHoanTra = laHoanMotPhan ? 0 : Math.max(0, Number(hd.diemsudung || 0));
            const maKmDaDung = laHoanMotPhan ? null : hd.makhuyenmai || null;

            if (paymentsSanSang && soTienConCoTheHoan === 0 && diemHoanTra === 0 && !laHoanMotPhan) {
                const paidRes = await client.query(
                    `SELECT COALESCE(SUM(CASE WHEN TrangThai = 'REFUNDED' THEN -SoTien ELSE SoTien END), 0) AS TongConLai
                       FROM Order_Payments
                      WHERE MaHoaDon = $1::text AND TrangThai IN ('PAID', 'REFUNDED')`,
                    [String(maHoaDon)]
                );
                soTienConCoTheHoan = Math.max(0, Number(paidRes.rows[0]?.tongconlai || 0));
            }

            let tongHoan = soTienConCoTheHoan;
            if (laHoanMotPhan) {
                const tongTamTinhConLai = activeItems.reduce((s, r) => s + r.thanhTien, 0);
                const tongTamTinhMonHoan = targetItems.reduce((s, r) => s + r.thanhTien, 0);
                if (tongTamTinhConLai <= soTienConCoTheHoan) {
                    tongHoan = Math.min(soTienConCoTheHoan, tongTamTinhMonHoan);
                } else if (tongTamTinhConLai > 0) {
                    tongHoan = Math.min(
                        soTienConCoTheHoan,
                        Math.round((soTienConCoTheHoan * tongTamTinhMonHoan) / tongTamTinhConLai)
                    );
                }
            }

            if (!(tongHoan > 0) && !(diemHoanTra > 0) && !maKmDaDung && !laHoanMotPhan) {
                throw new LoiNghiepVu(400, 'Hóa đơn không có giá trị tiền, điểm hoặc ưu đãi hợp lệ để hoàn!');
            }

            const khoaIdemRefund = docKhoaIdempotency(req) || null;
            let refundLedgerId = null;
            if (tongHoan > 0) {
                // [Phân hệ 3 - Immutable Order_Refunds] Ghi tách bạch vào Sổ cái Hoàn tiền Độc lập gắn đúng Ca thực hiện chi hoàn!
                // Tuyệt đối không sửa ngược Order_Payments hay ZReportSnapshot của Ca bán gốc!
                const rRef = await client.query(
                    `INSERT INTO public.order_refunds
                        (tenantid, branchid, terminalid, mahoadon, macathungan, macathunganbangoc,
                         phuongthuchoan, sotienhoan, danhsachmacthd, lydo, manv, manvthuchien, nguoiduyet, khoaidem)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::text, $12::varchar, $13, $14)
                     RETURNING id`,
                    [
                        tenantId,
                        normalizeBranchForShift(tenantId, ca.branchid),
                        normalizeTerminalId(ca.terminalid),
                        String(maHoaDon),
                        String(ca.macathungan),
                        hd.macathungan ? String(hd.macathungan) : null,
                        phuongThucHoan,
                        tongHoan,
                        JSON.stringify(laHoanMotPhan ? targetItems.map((i) => String(i.macthd)) : []),
                        cleanLyDo,
                        String(req.user.maNV),
                        String(req.user.maNV),
                        String(nguoiDuyet || req.user.maNV),
                        khoaIdemRefund,
                    ]
                );
                refundLedgerId = Number(rRef.rows[0].id);

                // Nếu hoàn tiền về Ví thành viên (VI_KHACH) -> cộng thẳng SoDuVi & ghi lịch sử ví
                if (phuongThucHoan === 'VI_KHACH' && hd.makh) {
                    const wRes = await client.query(
                        `UPDATE KhachHang SET SoDuVi = COALESCE(SoDuVi, 0) + $2
                          WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $3
                          RETURNING SoDuVi`,
                        [hd.makh, tongHoan, tenantId]
                    );
                    if (wRes.rows.length > 0) {
                        await client.query(
                            `INSERT INTO KhachHang_GiaoDichVi (TenantId, MaKH, LoaiGD, SoTien, SoDuSau, MaHoaDon, MaNV, GhiChu)
                             VALUES ($1, $2, 'REFUND_ORDER', $3, $4, $5, $6, $7)`,
                            [
                                tenantId,
                                hd.makh,
                                tongHoan,
                                Number(wRes.rows[0].soduvi),
                                maHoaDon,
                                req.user.maNV,
                                `Hoàn tiền vào ví HĐ ${maHoaDon}: ${cleanLyDo}`,
                            ]
                        );
                    }
                }
            }

            if (laHoanMotPhan) {
                const tongThanhToanConLai = Math.max(0, soTienConCoTheHoan - tongHoan);
                await client.query('SAVEPOINT sp_partial_ref_hd');
                try {
                    await client.query(
                        'UPDATE HoaDon SET TongTienThanhToan = $2, SoTienHoan = COALESCE(SoTienHoan, 0) + $3 WHERE MaHoaDon = $1',
                        [maHoaDon, tongThanhToanConLai, tongHoan]
                    );
                    await client.query('RELEASE SAVEPOINT sp_partial_ref_hd');
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_partial_ref_hd').catch(() => {});
                    await client.query(
                        'UPDATE HoaDon SET TongTienThanhToan = $2 WHERE MaHoaDon = $1',
                        [maHoaDon, tongThanhToanConLai]
                    );
                }
            } else {
                await client.query('UPDATE HoaDon SET TrangThaiTT = 2 WHERE MaHoaDon = $1', [maHoaDon]);
            }

            const tieuHaoMon = new Map();
            for (const row of targetItems) {
                await congDinhLuongNguyenLieuDongMon(
                    client,
                    tenantId,
                    { maCTHD: row.macthd, maMon: row.mamon, kichThuoc: row.kichthuoc, soLuong: row.soluong },
                    tieuHaoMon
                );
            }

            const thucHienHoanKho = Boolean(hoanKho);
            const giaVonRefundMap = await layMapGiaVonNguyenLieu(client, tenantId, [...tieuHaoMon.keys()]);
            if (thucHienHoanKho && tieuHaoMon.size > 0) {
                const phieu = await client.query(
                    'INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId) VALUES ($1, $2, $3, $4) RETURNING MaGiaoDich',
                    [req.user.maNV, LOAI_GD_HOAN_KHO, `Hoàn kho hoàn tiền HĐ ${maHoaDon}: ${cleanLyDo}`, tenantId]
                );
                const maGD = phieu.rows[0].magiaodich;
                for (const [maNL, sl] of [...tieuHaoMon].sort((a, b) => a[0].localeCompare(b[0]))) {
                    const qty = lam3(sl);
                    await client.query(
                        `INSERT INTO ChiTietGiaoDichKho (MaGiaoDich, MaNL, SoLuong, DonGiaNhap, TinhTrang)
                         VALUES ($1, $2, $3, $4, 'Hoàn kho sau hoàn tiền')`,
                        [maGD, maNL, qty, giaVonRefundMap.get(maNL) || 0]
                    );
                    await client.query(
                        "UPDATE NguyenLieu SET SoLuongTon = SoLuongTon + $1 WHERE MaNL = $2 AND COALESCE(TenantId, 'DEFAULT') = $3",
                        [qty, maNL, tenantId]
                    );
                }
            } else if (!thucHienHoanKho && tieuHaoMon.size > 0) {
                const phieuWaste = await client.query(
                    'INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId) VALUES ($1, $2, $3, $4) RETURNING MaGiaoDich',
                    [req.user.maNV, LOAI_GD_HAO_HUT_HUY_MON, `Hao hụt hoàn tiền HĐ ${maHoaDon}: ${cleanLyDo}`, tenantId]
                );
                const maGDW = phieuWaste.rows[0].magiaodich;
                for (const [maNL, sl] of [...tieuHaoMon].sort((a, b) => a[0].localeCompare(b[0]))) {
                    await client.query(
                        `INSERT INTO ChiTietGiaoDichKho (MaGiaoDich, MaNL, SoLuong, DonGiaNhap, TinhTrang)
                         VALUES ($1, $2, $3, $4, 'Hao hụt - hoàn tiền sau TT')`,
                        [maGDW, maNL, lam3(sl), giaVonRefundMap.get(maNL) || 0]
                    );
                }
            }

            const targetIds = targetItems.map((r) => String(r.macthd));
            await client.query(
                `UPDATE ChiTietHoaDon
                    SET TrangThaiPhaChe = 'DaHuy',
                        LyDoHuy = $2
                  WHERE MaHoaDon = $1 AND MaCTHD::text = ANY($3::text[])`,
                [
                    maHoaDon,
                    `[${laHoanMotPhan ? 'Hoàn tiền 1 phần' : 'Hoàn tiền'}] ${cleanLyDo}`.slice(0, 255),
                    targetIds,
                ]
            );

            let diemThuHoi = 0;
            if (hd.makh) {
                if (laHoanMotPhan) {
                    const diemCu = Math.floor(soTienConCoTheHoan / DIEM_MOI_VND);
                    const diemMoi = Math.floor(Math.max(0, soTienConCoTheHoan - tongHoan) / DIEM_MOI_VND);
                    diemThuHoi = Math.max(0, diemCu - diemMoi);
                } else if (tongHoan >= DIEM_MOI_VND) {
                    diemThuHoi = Math.floor(tongHoan / DIEM_MOI_VND);
                }
                const deltaDiem = diemHoanTra - diemThuHoi;
                if (deltaDiem !== 0) {
                    await client.query(
                        `UPDATE KhachHang
                            SET DiemTichLuy = GREATEST(0, COALESCE(DiemTichLuy, 0) + $1)
                          WHERE MaKH = $2 AND COALESCE(TenantId, 'DEFAULT') = $3`,
                        [deltaDiem, hd.makh, tenantId]
                    );
                }
            }

            if (maKmDaDung && !laHoanMotPhan) {
                await client.query('SAVEPOINT sp_refund_km_cnt');
                try {
                    await client.query(
                        `UPDATE KhuyenMai
                            SET SoLuotDaDung = GREATEST(0, COALESCE(SoLuotDaDung, 0) - 1)
                          WHERE TenantId = $1 AND UPPER(MaCode) = UPPER($2)`,
                        [tenantId, maKmDaDung]
                    );
                    await client.query('RELEASE SAVEPOINT sp_refund_km_cnt');
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_refund_km_cnt').catch(() => {});
                }
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                nguoiDuyet,
                hanhDong: laHoanMotPhan ? 'ORDER_PARTIAL_REFUND' : 'ORDER_POST_PAYMENT_REFUND',
                doiTuong: 'HOADON',
                maDoiTuong: maHoaDon,
                giaTriCu: {
                    tongTienThanhToan: soTienConCoTheHoan,
                    phuongThucTT: hd.phuongthuctt,
                    trangThaiTT: 1,
                    diemSuDung: diemHoanTra,
                    maKhuyenMai: maKmDaDung,
                },
                giaTriMoi: {
                    trangThaiTT: laHoanMotPhan ? 1 : 2,
                    laHoanMotPhan,
                    dsMaCTHDHoan: targetIds,
                    tongHoan,
                    phuongThucHoan,
                    hoanKho: thucHienHoanKho,
                    diemThuHoi,
                    diemHoanTra,
                },
                lyDo: cleanLyDo,
                ip: req.ip,
                batBuoc: true,
            });

            // [Wave 3A — P1-01] Nếu hóa đơn đã phát hành HĐĐT gốc (ISSUED), tự sinh HĐĐT điều chỉnh giảm (Credit Note) vào hàng đợi QUEUED
            let einvoiceAdjustment = null;
            await client.query('SAVEPOINT sp_refund_einvoice_adj');
            try {
                einvoiceAdjustment = await createAdjustmentDecreaseOnRefund(client, {
                    tenantId,
                    branchId: normalizeBranchForShift(tenantId, ca.branchid),
                    maHoaDon,
                    refundAmount: tongHoan,
                    reason: cleanLyDo,
                });
                await client.query('RELEASE SAVEPOINT sp_refund_einvoice_adj');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_refund_einvoice_adj').catch(() => {});
            }

            return {
                maHoaDon,
                laHoanMotPhan,
                soMonHoan: targetItems.length,
                tongHoan,
                phuongThucHoan,
                hoanKho: thucHienHoanKho,
                diemThuHoi,
                einvoiceAdjustmentId: einvoiceAdjustment ? einvoiceAdjustment.id : null,
            };
        }, tenantId);

        io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'barista')).to(roomTen(tenantId, 'phucvu')).emit('HOADON_DA_HOAN', {
            maHoaDon: ketQua.maHoaDon,
            laHoanMotPhan: ketQua.laHoanMotPhan,
            tongHoan: ketQua.tongHoan,
            phuongThucHoan: ketQua.phuongThucHoan,
        });
        io.to(roomTen(tenantId, 'thungan')).emit('CA_THAY_DOI', { trangThai: 'CAP_NHAT' });

        res.json({
            message: ketQua.laHoanMotPhan
                ? `Đã hoàn tiền 1 phần (${ketQua.soMonHoan} món — ${ketQua.tongHoan.toLocaleString('vi-VN')}đ qua ${ketQua.phuongThucHoan}) cho hóa đơn #${maHoaDon}!`
                : `Đã hoàn tiền ${ketQua.tongHoan.toLocaleString('vi-VN')}đ (${ketQua.phuongThucHoan}) cho hóa đơn #${maHoaDon}!`,
            ...ketQua,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Hoàn tiền sau thanh toán:');
    }
});

// [L3.4] Ghi nhận lượt in hóa đơn (/api/hoadon/:maHoaDon/in & /api/order/:maHoaDon/print-token) đã được hợp nhất về modules/kdsPhase2Routes.js (bắt buộc RBAC/PIN khi in lại lần 2+).

// [Phân hệ 1 - 100/100] Chuyển bàn chống Deadlock + Di chuyển PhienTinhGio & DonQrChoDuyet + Xoay QrToken + Chuyển bàn cũ sang 3=Chờ dọn + Emit kds:table_moved
app.post('/api/ban/chuyen', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const { fromMaBan, toMaBan, forceClean = false } = req.body || {};
    const tenantId = layTenantId(req);
    if (!fromMaBan || !toMaBan || fromMaBan === toMaBan) {
        return res.status(400).json({ message: 'Vui lòng chọn 2 bàn khác nhau để chuyển!' });
    }
    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const dsLock = [fromMaBan, toMaBan].sort();
            const banRes = await client.query(
                `SELECT MaBan, TenBan, TrangThai, to_jsonb(Ban)->>'qrtoken' AS QrToken
                   FROM Ban
                  WHERE MaBan = ANY($1::varchar[]) AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2
                  ORDER BY MaBan ASC FOR UPDATE`,
                [dsLock, tenantId]
            );
            const banCu = banRes.rows.find((b) => b.maban === fromMaBan);
            const banMoi = banRes.rows.find((b) => b.maban === toMaBan);
            if (!banCu || !banMoi) throw new LoiNghiepVu(404, 'Không tìm thấy bàn nguồn hoặc bàn đích!');

            const maHoaDon = await layHoaDonMoCuaBan(client, fromMaBan, true);
            if (!maHoaDon) throw new LoiNghiepVu(409, `${banCu.tenban} hiện không có hóa đơn đang mở!`);

            const hdBanMoi = await layHoaDonMoCuaBan(client, toMaBan, true);
            if (hdBanMoi || Number(banMoi.trangthai) === 2) {
                throw new LoiNghiepVu(409, `${banMoi.tenban} đang có khách! Đề xuất chuyển sang chức năng Gộp bàn.`, {
                    maLoi: 'DEST_TABLE_OCCUPIED',
                    suggestMerge: true,
                    destMaHoaDon: hdBanMoi,
                });
            }
            if (Number(banMoi.trangthai) === 3 && !forceClean) {
                throw new LoiNghiepVu(409, `${banMoi.tenban} đang ở trạng thái Chờ dọn! Xác nhận forceClean để nhận khách ngay.`, {
                    maLoi: 'DEST_TABLE_CLEANING',
                });
            }

            await client.query(
                'UPDATE HoaDon_Ban SET MaBan = $1 WHERE MaHoaDon = $2 AND MaBan = $3',
                [toMaBan, maHoaDon, fromMaBan]
            );

            // Chuyển phụ thuộc: PhienTinhGio (Bida/Boardgame) & DonQrChoDuyet sang bàn đích
            await client.query('SAVEPOINT sp_move_deps');
            try {
                await client.query(
                    `UPDATE phientinhgio SET maban = $1
                      WHERE tenantid = $2 AND maban = $3 AND trangthai IN ('RUNNING', 'PAUSED')`,
                    [toMaBan, tenantId, fromMaBan]
                );
                await client.query(
                    `UPDATE donqrchoduyet SET maban = $1, tenban = $2
                      WHERE tenantid = $3 AND maban = $4 AND trangthai = 'PENDING_APPROVAL'`,
                    [toMaBan, banMoi.tenban, tenantId, fromMaBan]
                );
                await client.query('RELEASE SAVEPOINT sp_move_deps');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_move_deps').catch(() => {});
            }

            // Đặt bàn cũ sang 3 = Chờ dọn & xoay mới QrToken để khách bàn cũ không quét nhầm vào đơn đã chuyển
            await client.query('UPDATE Ban SET TrangThai = 3 WHERE MaBan = $1', [fromMaBan]);
            await client.query('UPDATE Ban SET TrangThai = 2 WHERE MaBan = $1', [toMaBan]);
            await xoayQrTokenChoCacBan(client, [fromMaBan]);

            const rotatedRes = await client.query(`SELECT to_jsonb(Ban)->>'qrtoken' AS QrToken FROM Ban WHERE MaBan = $1`, [fromMaBan]);
            const movedAt = new Date().toISOString();

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'TABLE_MOVE',
                doiTuong: 'BAN',
                maDoiTuong: maHoaDon,
                giaTriCu: { maBan: fromMaBan, tenBan: banCu.tenban, qrToken: banCu.qrtoken || null },
                giaTriMoi: { maBan: toMaBan, tenBan: banMoi.tenban, newFromQrToken: rotatedRes.rows[0]?.qrtoken || null, fromTrangThai: 3 },
                ip: req.ip,
            });

            const hdBrRes = await client.query(
                `SELECT COALESCE(NULLIF(to_jsonb(HoaDon)->>'branchid', ''), 'DEFAULT') AS BranchId FROM HoaDon WHERE MaHoaDon = $1`,
                [maHoaDon]
            );
            const branchIdMove = normalizeBranchId(hdBrRes.rows[0]?.branchid || 'DEFAULT');
            const movePayload = {
                maHoaDon,
                fromMaBan,
                toMaBan,
                fromTenBan: banCu.tenban,
                toTenBan: banMoi.tenban,
                movedAt,
            };
            const logMove = await insertKdsEventLog(client, {
                tenantId,
                branchId: branchIdMove,
                station: 'ALL',
                eventType: 'TABLE_MOVE',
                maHoaDon,
                payload: movePayload,
            });

            return {
                maHoaDon,
                branchId: branchIdMove,
                seq: logMove.seq,
                fromMaBan,
                toMaBan,
                tenBanCu: banCu.tenban,
                tenBanMoi: banMoi.tenban,
                fromTenBan: banCu.tenban,
                toTenBan: banMoi.tenban,
                fromTrangThai: 3,
                newFromQrToken: rotatedRes.rows[0]?.qrtoken || null,
                movedAt,
            };
        }, tenantId);

        io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('BAN_THAY_DOI', { maBan: fromMaBan, trangThai: 3 });
        io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('BAN_THAY_DOI', { maBan: toMaBan, trangThai: 2 });
        io.to(roomTen(tenantId, 'barista')).to(roomTen(tenantId, 'phucvu')).to(roomTen(tenantId, 'thungan')).emit('BAN_CHUYEN', ketQua);
        emitScopedKdsEvent(io, {
            tenantId,
            branchId: ketQua.branchId,
            station: 'ALL',
            seq: ketQua.seq,
            eventType: 'TABLE_MOVE',
            socketEvents: ['kds:table_moved'],
            payload: {
                maHoaDon: ketQua.maHoaDon,
                fromMaBan: ketQua.fromMaBan,
                toMaBan: ketQua.toMaBan,
                fromTenBan: ketQua.fromTenBan,
                toTenBan: ketQua.toTenBan,
                movedAt: ketQua.movedAt,
            },
            includeExpo: true,
            includeWaiter: true,
            includePos: true,
            legacyBaristaEvent: 'kds:table_moved',
            legacyWaiterEvent: 'kds:table_moved',
            legacyPosEvent: 'kds:table_moved',
        });

        res.json({ message: `Đã chuyển từ ${ketQua.tenBanCu} sang ${ketQua.tenBanMoi}!`, ...ketQua });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Chuyển bàn:');
    }
});

// [Phân hệ 1 - 100/100] Gộp bàn (đủ cả 2 TH: Ghép thêm bàn trống mở rộng chỗ & Gộp 2 hóa đơn giữ trọn Order_Payments/PhienTinhGio, TrangThaiTT=3 MERGED!)
app.post('/api/ban/gop', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const { fromMaBan, toMaBan, expectedVersion = null, keepTable = false } = req.body || {};
    const tenantId = layTenantId(req);
    if (!fromMaBan || !toMaBan || fromMaBan === toMaBan) {
        return res.status(400).json({ message: 'Vui lòng chọn 2 bàn khác nhau để gộp!' });
    }
    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const dsLock = [fromMaBan, toMaBan].sort();
            const banRes = await client.query(
                `SELECT MaBan, TenBan, TrangThai FROM Ban
                  WHERE MaBan = ANY($1::varchar[]) AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2
                  ORDER BY MaBan ASC FOR UPDATE`,
                [dsLock, tenantId]
            );
            const banCu = banRes.rows.find((b) => b.maban === fromMaBan);
            const banDich = banRes.rows.find((b) => b.maban === toMaBan);
            if (!banCu || !banDich) throw new LoiNghiepVu(404, 'Không tìm thấy bàn nguồn hoặc bàn đích!');

            const hdNguon = await layHoaDonMoCuaBan(client, fromMaBan, false);
            const hdDich = await layHoaDonMoCuaBan(client, toMaBan, false);
            if (!hdNguon) throw new LoiNghiepVu(409, `${banCu.tenban} không có hóa đơn đang mở để gộp!`);

            // TRƯỜNG HỢP A: Bàn đích đang trống -> Ghép thêm bàn trống mở rộng chỗ ngồi cho hóa đơn hiện tại!
            if (!hdDich) {
                await client.query(`SELECT MaHoaDon FROM HoaDon WHERE MaHoaDon = $1 FOR UPDATE`, [hdNguon]);
                await client.query(
                    `INSERT INTO HoaDon_Ban (MaHoaDon, MaBan) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                    [hdNguon, toMaBan]
                );
                await client.query(`UPDATE Ban SET TrangThai = 2 WHERE MaBan = $1`, [toMaBan]);
                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'TABLE_EXPAND_SEATING',
                    doiTuong: 'HOADON',
                    maDoiTuong: hdNguon,
                    giaTriMoi: { fromMaBan, addedMaBan: toMaBan, tenBanThem: banDich.tenban },
                    ip: req.ip,
                });
                return {
                    mode: 'EXPAND_EMPTY_TABLE',
                    hdNguon,
                    hdDich: hdNguon,
                    fromMaBan,
                    toMaBan,
                    tenBanCu: banCu.tenban,
                    tenBanDich: banDich.tenban,
                    hoaDon: await layHoaDonChiTiet(client, hdNguon),
                };
            }

            if (String(hdNguon) === String(hdDich)) throw new LoiNghiepVu(409, 'Hai bàn này đã nằm chung một hóa đơn!');

            // TRƯỜNG HỢP B: Cả 2 bàn đều có hóa đơn chưa thanh toán -> Khóa theo ORDER BY MaHoaDon ASC FOR UPDATE chống Deadlock!
            const orderedIds = [String(hdNguon), String(hdDich)].sort();
            const lockedMergeRes = await client.query(
                `SELECT MaHoaDon, COALESCE(DaInTamTinh, FALSE) AS daintamtinh
                   FROM HoaDon
                  WHERE MaHoaDon::text = ANY($1::text[])
                  ORDER BY MaHoaDon ASC
                  FOR UPDATE`,
                [orderedIds]
            );
            const preservedDaInTamTinh = lockedMergeRes.rows.some((r) => Boolean(r.daintamtinh));

            await kiemTraVaTangVersionHoaDon(client, {
                maHoaDon: hdDich,
                tenantId,
                expectedVersion,
                layHoaDonChiTiet,
                LoiNghiepVu,
            });

            // Chuyển toàn bộ ChiTietHoaDon, HoaDon_Ban (không trùng), Order_Payments (giữ nguyên thanh toán 1 phần!), HoaDon_ChiaTien, PhienTinhGio & DonQrChoDuyet
            await client.query('UPDATE ChiTietHoaDon SET MaHoaDon = $1 WHERE MaHoaDon = $2', [hdDich, hdNguon]);
            if (paymentsSanSang) {
                await client.query('UPDATE Order_Payments SET MaHoaDon = $1 WHERE MaHoaDon = $2', [String(hdDich), String(hdNguon)]);
            }
            await client.query('SAVEPOINT sp_merge_deps');
            try {
                await client.query(`UPDATE hoadon_chiatien SET mahoadon = $1 WHERE tenantid = $2 AND mahoadon = $3`, [
                    String(hdDich),
                    tenantId,
                    String(hdNguon),
                ]);
                await client.query(
                    `UPDATE phientinhgio SET mahoadon = $1, maban = $2 WHERE tenantid = $3 AND (mahoadon = $4 OR maban = $5) AND trangthai IN ('RUNNING', 'PAUSED')`,
                    [String(hdDich), toMaBan, tenantId, String(hdNguon), fromMaBan]
                );
                await client.query(
                    `UPDATE donqrchoduyet SET maban = $1, tenban = $2 WHERE tenantid = $3 AND maban = $4 AND trangthai = 'PENDING_APPROVAL'`,
                    [toMaBan, banDich.tenban, tenantId, fromMaBan]
                );
                await client.query('RELEASE SAVEPOINT sp_merge_deps');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_merge_deps').catch(() => {});
            }

            if (keepTable) {
                await client.query(
                    `INSERT INTO HoaDon_Ban (MaHoaDon, MaBan)
                     SELECT $1, MaBan FROM HoaDon_Ban WHERE MaHoaDon = $2
                     ON CONFLICT DO NOTHING`,
                    [hdDich, hdNguon]
                );
            }
            await client.query('DELETE FROM HoaDon_Ban WHERE MaHoaDon = $1', [hdNguon]);

            // CẤM XÓA CỨNG hdNguon: Chuyển TrangThaiTT = 3 & lifecycle_status = 'MERGED' + ghi vết MergedIntoMaHoaDon!
            await client.query(
                `UPDATE HoaDon
                    SET TrangThaiTT = 3,
                        lifecycle_status = 'MERGED',
                        MergedIntoMaHoaDon = $2
                  WHERE MaHoaDon = $1 AND TrangThaiTT = 0`,
                [hdNguon, String(hdDich)]
            );
            // Bịt lỗ hổng Pre-bill Scam: BẮT BUỘC bảo toàn DaInTamTinh = (h1.DaInTamTinh OR h2.DaInTamTinh)
            await client.query(`UPDATE HoaDon SET DaInTamTinh = $2 WHERE MaHoaDon = $1`, [hdDich, preservedDaInTamTinh]);

            if (!keepTable) {
                await client.query('UPDATE Ban SET TrangThai = 1 WHERE MaBan = $1', [fromMaBan]);
                await xoayQrTokenChoCacBan(client, [fromMaBan]);
            }

            // Tự động tính lại Khuyến mãi, Điểm Loyalty & Thuế/Phí trên hóa đơn đích
            const recalc = await recalculateInvoiceTotals(client, {
                tenantId,
                maHoaDon: hdDich,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                ip: req.ip,
                ghiAuditLog,
                kiemTraHopLeKhuyenMai,
            });

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'TABLE_MERGE',
                doiTuong: 'HOADON',
                maDoiTuong: hdDich,
                giaTriCu: { fromMaBan, tenBanCu: banCu.tenban, hdNguon },
                giaTriMoi: { toMaBan, tenBanDich: banDich.tenban, hdDich, keepTable, promoAdjusted: recalc.promoAdjusted },
                ip: req.ip,
                batBuoc: true,
            });

            const hdBrRes = await client.query(
                `SELECT COALESCE(NULLIF(to_jsonb(HoaDon)->>'branchid', ''), 'DEFAULT') AS BranchId FROM HoaDon WHERE MaHoaDon = $1`,
                [hdDich]
            );
            const branchIdMerge = normalizeBranchId(hdBrRes.rows[0]?.branchid || 'DEFAULT');
            const logMerge = await insertKdsEventLog(client, {
                tenantId,
                branchId: branchIdMerge,
                station: 'ALL',
                eventType: 'ORDER_MERGE',
                maHoaDon: hdDich,
                payload: {
                    hdNguon,
                    hdDich,
                    fromMaBan,
                    toMaBan,
                    fromTenBan: banCu.tenban,
                    toTenBan: banDich.tenban,
                    mergedAt: new Date().toISOString(),
                },
            });

            return {
                mode: 'MERGE_INVOICES',
                branchId: branchIdMerge,
                seq: logMerge.seq,
                hdNguon,
                hdDich,
                fromMaBan,
                toMaBan,
                tenBanCu: banCu.tenban,
                tenBanDich: banDich.tenban,
                promoAdjusted: recalc.promoAdjusted,
                hoaDon: await layHoaDonChiTiet(client, hdDich),
            };
        }, tenantId);

        if (ketQua.mode === 'EXPAND_EMPTY_TABLE') {
            io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('BAN_THAY_DOI', { maBan: toMaBan, trangThai: 2 });
        } else {
            if (!keepTable) {
                io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('BAN_THAY_DOI', { maBan: fromMaBan, trangThai: 1 });
            }
            io.to(roomTen(tenantId, 'barista')).to(roomTen(tenantId, 'phucvu')).to(roomTen(tenantId, 'thungan')).emit('BAN_CHUYEN', {
                maHoaDon: ketQua.hdDich,
                fromMaBan,
                toMaBan,
                tenBanCu: ketQua.tenBanCu,
                tenBanMoi: ketQua.tenBanDich,
            });
            emitScopedKdsEvent(io, {
                tenantId,
                branchId: ketQua.branchId,
                station: 'ALL',
                seq: ketQua.seq,
                eventType: 'ORDER_MERGE',
                socketEvents: ['kds:orders_merged'],
                payload: {
                    hdNguon: ketQua.hdNguon,
                    hdDich: ketQua.hdDich,
                    fromMaBan,
                    toMaBan,
                    fromTenBan: ketQua.tenBanCu,
                    toTenBan: ketQua.tenBanDich,
                    mergedAt: new Date().toISOString(),
                },
                includeExpo: true,
                includeWaiter: true,
                includePos: true,
                legacyBaristaEvent: 'kds:orders_merged',
                legacyWaiterEvent: 'kds:orders_merged',
                legacyPosEvent: 'kds:orders_merged',
            });
        }

        res.json({
            message:
                ketQua.mode === 'EXPAND_EMPTY_TABLE'
                    ? `Đã ghép thêm ${ketQua.tenBanDich} vào ${ketQua.tenBanCu} (HĐ #${ketQua.hdDich})!`
                    : `Đã gộp ${ketQua.tenBanCu} vào ${ketQua.tenBanDich} (HĐ #${ketQua.hdDich})!`,
            ...ketQua,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Gộp bàn:');
    }
});

// [P1] Cập nhật trạng thái vận hành bàn: 1 = Trống sẵn sàng, 3 = Chờ dọn (CHO_DON), 4 = Đã đặt trước
app.put('/api/ban/:maBan/trangthai', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const { maBan } = req.params;
    const trangThai = Number(req.body?.trangThai);
    const tenantId = layTenantId(req);

    if (![1, 3, 4].includes(trangThai)) {
        return res.status(400).json({ message: 'trangThai bàn hợp lệ phải là 1 (Trống), 3 (Chờ dọn) hoặc 4 (Đặt trước)!' });
    }

    try {
        const ban = await chayGiaoDich(async (client) => {
            const bRes = await client.query(
                `SELECT MaBan, TenBan, TrangThai FROM Ban
                  WHERE MaBan = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2
                  FOR UPDATE`,
                [maBan, tenantId]
            );
            if (bRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy bàn!');
            const hdMo = await layHoaDonMoCuaBan(client, maBan, false);
            if (hdMo) {
                throw new LoiNghiepVu(
                    409,
                    `${bRes.rows[0].tenban} đang có hóa đơn chưa thanh toán (#${hdMo}), không thể đổi trạng thái bàn!`,
                    { code: 'BAN_DANG_CO_KHACH', maHoaDon: hdMo }
                );
            }
            const upd = await client.query(
                `UPDATE Ban SET TrangThai = $2 WHERE MaBan = $1 AND COALESCE(TenantId, 'DEFAULT') = $3 RETURNING MaBan, TenBan, TrangThai`,
                [maBan, trangThai, tenantId]
            );
            return upd.rows[0];
        }, tenantId);

        io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('BAN_THAY_DOI', {
            maBan: ban.maban,
            trangThai: Number(ban.trangthai),
        });

        const nhan = trangThai === 3 ? '🧹 Chờ dọn' : trangThai === 4 ? '📅 Đã đặt trước' : '✨ Trống sẵn sàng';
        res.json({
            message: `Đã chuyển ${ban.tenban} sang trạng thái "${nhan}"!`,
            ban: { maBan: ban.maban, tenBan: ban.tenban, trangThai: Number(ban.trangthai) },
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Đổi trạng thái bàn:');
    }
});

// [Phân hệ 1 - 100/100] Tách hóa đơn đủ 3 kiểu:
//   1. BY_ITEM / NEW_INVOICE / TRANSFER_TO_TABLE (Tách theo món/số lượng lẻ, giữ nguyên SoLuongMoiLy & ModifiersSnapshot)
//   2. SPLIT_EQUAL (Chia đều N người theo bội số 1.000đ vào HoaDon_ChiaTien — KHÔNG vỡ ChiTietHoaDon!)
//   3. SPLIT_AMOUNT (Chia theo số tiền tùy ý vào HoaDon_ChiaTien — kiểm tra tổng khớp tuyệt đối!)
async function handleSplitOrder(req, res) {
    const { maHoaDon } = req.params;
    const {
        dsMaCTHD = [],
        splitItems = [],
        toMaBan = null,
        mode = 'NEW_INVOICE', // 'BY_ITEM' | 'NEW_INVOICE' | 'TRANSFER_TO_TABLE' | 'SPLIT_EQUAL' | 'SPLIT_AMOUNT'
        soNguoi = null,
        shares = [],
        expectedVersion = null,
    } = req.body || {};
    const tenantId = layTenantId(req);
    const modeNorm = String(mode || 'NEW_INVOICE').toUpperCase();

    // ----- KIỂU 2 (SPLIT_EQUAL) & KIỂU 3 (SPLIT_AMOUNT) -> GHI VÀO HoaDon_ChiaTien -----
    if (modeNorm === 'SPLIT_EQUAL' || modeNorm === 'SPLIT_AMOUNT') {
        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const hdRes = await client.query(
                    `SELECT MaHoaDon, TrangThaiTT FROM HoaDon
                      WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2 FOR UPDATE`,
                    [maHoaDon, tenantId]
                );
                if (hdRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn gốc!');
                if (hdRes.rows[0].trangthaitt !== 0) throw new LoiNghiepVu(409, 'Chỉ có thể chia tiền cho hóa đơn đang mở!');

                await kiemTraVaTangVersionHoaDon(client, {
                    maHoaDon,
                    tenantId,
                    expectedVersion,
                    layHoaDonChiTiet,
                    LoiNghiepVu,
                });

                const detail = await layHoaDonChiTiet(client, maHoaDon);
                const conLai = Math.round(Number(detail.conLaiCanThu || 0));
                if (conLai <= 0) {
                    throw new LoiNghiepVu(400, 'Hóa đơn không còn số tiền cần thu để chia!');
                }

                // Kiểm tra không có phần chia cũ nào đã PAID mà chưa dọn
                const existingPaid = await client.query(
                    `SELECT 1 FROM hoadon_chiatien
                      WHERE tenantid = $1 AND mahoadon = $2::text AND trangthai = 'PAID' LIMIT 1`,
                    [tenantId, String(maHoaDon)]
                );
                if (existingPaid.rows.length > 0) {
                    throw new LoiNghiepVu(409, 'Hóa đơn đã có phần chia tiền được thanh toán, không thể chia lại!');
                }
                await client.query(
                    `UPDATE hoadon_chiatien SET trangthai = 'CANCELLED'
                      WHERE tenantid = $1 AND mahoadon = $2::text AND trangthai = 'UNPAID'`,
                    [tenantId, String(maHoaDon)]
                );

                let rowsToInsert = [];
                if (modeNorm === 'SPLIT_EQUAL') {
                    const n = Math.floor(Number(soNguoi || 0));
                    if (n < 2 || n > 50) {
                        throw new LoiNghiepVu(400, 'Số người chia đều (soNguoi) phải từ 2 đến 50!');
                    }
                    const amounts = chiaDeuTienVND(conLai, n);
                    rowsToInsert = amounts.map((amt, idx) => ({
                        nhan: `Phần ${idx + 1}/${n}`,
                        soTien: amt,
                    }));
                } else {
                    if (!Array.isArray(shares) || shares.length < 2) {
                        throw new LoiNghiepVu(400, 'Vui lòng nhập tối thiểu 2 phần chia (shares: [{ nhan, soTien }])!');
                    }
                    let sum = 0;
                    for (let idx = 0; idx < shares.length; idx += 1) {
                        const s = shares[idx];
                        const amt = Math.round(Number(s?.soTien || 0));
                        if (!(amt > 0)) {
                            throw new LoiNghiepVu(400, `Số tiền của phần chia thứ ${idx + 1} phải > 0!`);
                        }
                        sum += amt;
                        rowsToInsert.push({
                            nhan: String(s?.nhan || `Phần ${idx + 1}`).trim().slice(0, 40),
                            soTien: amt,
                        });
                    }
                    if (Math.abs(sum - conLai) > 0) {
                        throw new LoiNghiepVu(
                            400,
                            `Tổng các phần chia (${sum.toLocaleString('vi-VN')}đ) không khớp số tiền còn phải thu (${conLai.toLocaleString('vi-VN')}đ)!`
                        );
                    }
                }

                const inserted = [];
                for (const r of rowsToInsert) {
                    const ins = await client.query(
                        `INSERT INTO hoadon_chiatien (tenantid, mahoadon, nhanchia, sotienphaitra, sotiendatra, trangthai)
                         VALUES ($1, $2::text, $3, $4, 0, 'UNPAID')
                         RETURNING id, nhanchia, sotienphaitra, sotiendatra, trangthai, thoigiantao`,
                        [tenantId, String(maHoaDon), r.nhan, r.soTien]
                    );
                    inserted.push({
                        id: Number(ins.rows[0].id),
                        nhanChia: ins.rows[0].nhanchia,
                        soTienPhaiTra: Number(ins.rows[0].sotienphaitra),
                        soTienDaTra: 0,
                        trangThai: ins.rows[0].trangthai,
                        thoiGianTao: ins.rows[0].thoigiantao,
                    });
                }

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: modeNorm === 'SPLIT_EQUAL' ? 'ORDER_SPLIT_EQUAL' : 'ORDER_SPLIT_AMOUNT',
                    doiTuong: 'HOADON',
                    maDoiTuong: maHoaDon,
                    giaTriMoi: { mode: modeNorm, conLai, shares: inserted },
                    ip: req.ip,
                });

                return {
                    mode: modeNorm,
                    maHoaDon,
                    conLai,
                    danhSachChiaTien: inserted,
                    hoaDon: await layHoaDonChiTiet(client, maHoaDon),
                };
            }, tenantId);

            return res.status(201).json({
                message:
                    modeNorm === 'SPLIT_EQUAL'
                        ? `➗ Đã chia đều hóa đơn #${maHoaDon} thành ${ketQua.danhSachChiaTien.length} phần!`
                        : `💵 Đã chia hóa đơn #${maHoaDon} theo ${ketQua.danhSachChiaTien.length} mức tiền tùy ý!`,
                ...ketQua,
            });
        } catch (error) {
            return guiLoi(res, error, 'Lỗi API Chia tiền hóa đơn:');
        }
    }

    // ----- KIỂU 1: TÁCH THEO MÓN / SỐ LƯỢNG LẺ (BY_ITEM | NEW_INVOICE | TRANSFER_TO_TABLE) -----
    const reqMap = new Map();
    if (Array.isArray(splitItems) && splitItems.length > 0) {
        for (const it of splitItems) {
            const id = String(it?.maCTHD ?? '').trim();
            const sl = it?.soLuong !== undefined && it?.soLuong !== null ? Math.floor(Number(it.soLuong)) : null;
            if (!id) continue;
            if (sl !== null && !(sl >= 1)) {
                return res.status(400).json({ message: 'Số lượng tách của từng món phải >= 1!' });
            }
            reqMap.set(id, sl);
        }
    } else if (Array.isArray(dsMaCTHD) && dsMaCTHD.length > 0) {
        for (const rawId of dsMaCTHD) {
            const id = String(rawId ?? '').trim();
            if (id) reqMap.set(id, null);
        }
    }

    if (reqMap.size === 0) {
        return res.status(400).json({ message: 'Vui lòng chọn ít nhất 1 món để tách hóa đơn!' });
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const hdRes = await client.query(
                `SELECT MaHoaDon, TrangThaiTT, MaKH, COALESCE(DaInTamTinh, FALSE) AS DaInTamTinh
                   FROM HoaDon
                  WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2 FOR UPDATE`,
                [maHoaDon, tenantId]
            );
            if (hdRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn gốc!');
            if (hdRes.rows[0].trangthaitt !== 0) throw new LoiNghiepVu(409, 'Hóa đơn không ở trạng thái mở, không thể tách!');

            await kiemTraVaTangVersionHoaDon(client, {
                maHoaDon,
                tenantId,
                expectedVersion,
                layHoaDonChiTiet,
                LoiNghiepVu,
            });

            const daInTamTinhGoc = Boolean(hdRes.rows[0].daintamtinh);

            const itemsRes = await client.query(
                `SELECT MaCTHD, MaMon, TenMonSnapshot, KichThuoc, SoLuong, DonGia,
                        COALESCE(GiaGiam, 0) AS GiaGiam, COALESCE(GiaVonSnapshot, 0) AS GiaVonSnapshot,
                        COALESCE((to_jsonb(ChiTietHoaDon)->>'giamodifiers')::numeric, 0) AS GiaModifiers,
                        COALESCE((to_jsonb(ChiTietHoaDon)->'modifierssnapshot')::jsonb, '[]'::jsonb) AS ModifiersSnapshot,
                        COALESCE((to_jsonb(ChiTietHoaDon)->>'chietkhaumon')::numeric, 0) AS ChietKhauMon,
                        COALESCE((to_jsonb(ChiTietHoaDon)->>'lamontang')::boolean, FALSE) AS LaMonTang,
                        to_jsonb(ChiTietHoaDon)->>'lydotang' AS LyDoTang,
                        COALESCE((to_jsonb(ChiTietHoaDon)->>'dotgoi')::int, 1) AS DotGoi,
                        COALESCE((to_jsonb(ChiTietHoaDon)->>'istakeaway')::boolean, FALSE) AS IsTakeaway,
                        COALESCE((to_jsonb(ChiTietHoaDon)->>'courseno')::int, 1) AS CourseNo,
                        COALESCE(to_jsonb(ChiTietHoaDon)->>'firestatus', 'FIRED') AS FireStatus,
                        to_jsonb(ChiTietHoaDon)->>'firedat' AS FiredAt,
                        to_jsonb(ChiTietHoaDon)->>'combogroupuid' AS ComboGroupUid,
                        GhiChu, TrangThaiPhaChe, ThoiGianGoi
                   FROM ChiTietHoaDon
                  WHERE MaHoaDon = $1 AND TrangThaiPhaChe <> 'DaHuy'
                  ORDER BY MaCTHD
                  FOR UPDATE`,
                [maHoaDon]
            );

            let tongLyGoc = 0;
            let tongLyTach = 0;
            const plan = [];

            for (const row of itemsRes.rows) {
                const idStr = String(row.macthd);
                const origQty = Math.max(1, Number(row.soluong || 1));
                tongLyGoc += origQty;
                if (!reqMap.has(idStr)) continue;
                const reqQty = reqMap.get(idStr);
                const qtyToMove = reqQty === null ? origQty : Math.min(origQty, reqQty);
                if (qtyToMove <= 0) continue;
                tongLyTach += qtyToMove;
                plan.push({
                    row,
                    origQty,
                    qtyToMove,
                    isPartial: qtyToMove < origQty,
                });
            }

            if (plan.length === 0) throw new LoiNghiepVu(400, 'Không có món hợp lệ nào để tách!');

            // Chặn lách luật phá Combo qua tách đơn: nếu tách bất kỳ món con nào trong Combo, phải tách trọn bộ tất cả món cùng combogroupuid và không tách lẻ số lượng
            const touchedComboGroups = new Set(
                plan.map((p) => p.row.combogroupuid).filter((uid) => uid && String(uid).trim() !== '')
            );
            for (const comboUid of touchedComboGroups) {
                const allComboRows = itemsRes.rows.filter((r) => r.combogroupuid === comboUid);
                const planComboRows = plan.filter((p) => p.row.combogroupuid === comboUid);
                const hasPartialQty = planComboRows.some((p) => p.isPartial);
                if (hasPartialQty || planComboRows.length !== allComboRows.length) {
                    throw new LoiNghiepVu(
                        409,
                        'Không thể tách lẻ từng món trong cùng một Combo! Vui lòng tách trọn bộ tất cả món thuộc Combo đó.',
                        { maLoi: 'CANNOT_SPLIT_COMBO_PARTIAL', code: 'CANNOT_SPLIT_COMBO_PARTIAL', comboGroupUid: comboUid }
                    );
                }
            }

            if (tongLyTach >= tongLyGoc) {
                throw new LoiNghiepVu(
                    400,
                    'Phải giữ lại ít nhất 1 ly trên hóa đơn gốc khi tách! (Nếu muốn chuyển cả bàn, hãy dùng Chuyển bàn hoặc Chuyển món).'
                );
            }

            let maHoaDonMoi = null;
            let laChuyenGhepBan = false;

            if (toMaBan) {
                const b = await client.query(
                    "SELECT MaBan, TenBan FROM Ban WHERE MaBan = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2 FOR UPDATE",
                    [toMaBan, tenantId]
                );
                if (b.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy bàn đích!');
                const existHdDich = await layHoaDonMoCuaBan(client, toMaBan, true);
                if (existHdDich) {
                    if (String(existHdDich) === String(maHoaDon)) {
                        throw new LoiNghiepVu(409, 'Bàn đích chính là bàn của hóa đơn hiện tại!');
                    }
                    if (modeNorm !== 'TRANSFER_TO_TABLE') {
                        throw new LoiNghiepVu(
                            409,
                            'Bàn đích đang có khách! Hãy bật chế độ "Chuyển ghép món sang bàn đang mở" hoặc chọn bàn trống.'
                        );
                    }
                    if (daInTamTinhGoc) {
                        await client.query('UPDATE HoaDon SET DaInTamTinh = TRUE WHERE MaHoaDon = $1', [existHdDich]);
                    }
                    maHoaDonMoi = existHdDich;
                    laChuyenGhepBan = true;
                }
            }

            if (!maHoaDonMoi) {
                const { seq: sttMoi, soThuTuHienThi } = await capSoThuTuNgayKhongTrung(client, tenantId);
                let newHdRes;
                await client.query('SAVEPOINT sp_ins_split_hd_v23');
                try {
                    newHdRes = await client.query(
                        `INSERT INTO HoaDon (MaNV, TrangThaiTT, DaInTamTinh, TenantId, SoThuTuNgay, SoThuTuHienThi, ParentMaHoaDon, LoaiDonHang)
                         VALUES ($1, 0, $2, $3, $4, $5, $6, $7) RETURNING MaHoaDon`,
                        [req.user.maNV, daInTamTinhGoc, tenantId, sttMoi, soThuTuHienThi, String(maHoaDon), toMaBan ? 'TAI_QUAN' : 'MANG_DI']
                    );
                    await client.query('RELEASE SAVEPOINT sp_ins_split_hd_v23');
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_ins_split_hd_v23').catch(() => {});
                    newHdRes = await client.query(
                        'INSERT INTO HoaDon (MaNV, TrangThaiTT, DaInTamTinh, TenantId, SoThuTuNgay) VALUES ($1, 0, $2, $3, $4) RETURNING MaHoaDon',
                        [req.user.maNV, daInTamTinhGoc, tenantId, sttMoi]
                    );
                }
                maHoaDonMoi = newHdRes.rows[0].mahoadon;

                if (toMaBan) {
                    await client.query('INSERT INTO HoaDon_Ban (MaHoaDon, MaBan) VALUES ($1, $2)', [maHoaDonMoi, toMaBan]);
                    await client.query('UPDATE Ban SET TrangThai = 2 WHERE MaBan = $1', [toMaBan]);
                } else if (modeNorm === 'BY_ITEM') {
                    // Kiểu 1 BY_ITEM không đổi bàn: gắn hóa đơn con vào cùng bàn gốc (không chiếm bàn mới!)
                    await client.query(
                        `INSERT INTO HoaDon_Ban (MaHoaDon, MaBan)
                         SELECT $1, MaBan FROM HoaDon_Ban WHERE MaHoaDon = $2
                         ON CONFLICT DO NOTHING`,
                        [maHoaDonMoi, maHoaDon]
                    );
                }
            }

            // Thực hiện di chuyển nguyên dòng hoặc tách 1 phần số lượng — GIỮ NGUYÊN SoLuongMoiLy & ModifiersSnapshot!
            for (const item of plan) {
                const r = item.row;
                if (!item.isPartial) {
                    await client.query(
                        'UPDATE ChiTietHoaDon SET MaHoaDon = $1 WHERE MaHoaDon = $2 AND MaCTHD = $3',
                        [maHoaDonMoi, maHoaDon, r.macthd]
                    );
                } else {
                    const remainQty = item.origQty - item.qtyToMove;
                    const origDiscount = Number(r.giagiam || 0);
                    const splitDiscount = Math.round((origDiscount * item.qtyToMove) / item.origQty);
                    const remainDiscount = Math.max(0, origDiscount - splitDiscount);
                    const origCk = Number(r.chietkhaumon || 0);
                    const splitCk = Math.round((origCk * item.qtyToMove) / item.origQty);
                    const remainCk = Math.max(0, origCk - splitCk);

                    await client.query(
                        'UPDATE ChiTietHoaDon SET SoLuong = $2, GiaGiam = $3, ChietKhauMon = $4 WHERE MaCTHD = $1',
                        [r.macthd, remainQty, remainDiscount, remainCk]
                    );

                    let cloned;
                    await client.query('SAVEPOINT sp_clone_split_v23');
                    try {
                        cloned = await client.query(
                            `INSERT INTO ChiTietHoaDon
                                (MaHoaDon, MaMon, TenMonSnapshot, KichThuoc, SoLuong, DonGia, GiaGiam, GiaVonSnapshot,
                                 GiaModifiers, ModifiersSnapshot, ChietKhauMon, LaMonTang, LyDoTang,
                                 DotGoi, IsTakeaway, CourseNo, FireStatus, FiredAt, GhiChu, TrangThaiPhaChe, ThoiGianGoi)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,COALESCE($21, CURRENT_TIMESTAMP))
                             RETURNING MaCTHD`,
                            [
                                maHoaDonMoi,
                                r.mamon,
                                r.tenmonsnapshot,
                                r.kichthuoc,
                                item.qtyToMove,
                                Number(r.dongia),
                                splitDiscount,
                                Number(r.giavonsnapshot || 0),
                                Number(r.giamodifiers || 0),
                                JSON.stringify(r.modifierssnapshot || []),
                                splitCk,
                                Boolean(r.lamontang),
                                r.lydotang || null,
                                Number(r.dotgoi || 1),
                                Boolean(r.istakeaway),
                                Number(r.courseno || 1),
                                r.firestatus || 'FIRED',
                                r.firedat || null,
                                r.ghichu,
                                r.trangthaiphache,
                                r.thoigiangoi,
                            ]
                        );
                        await client.query('RELEASE SAVEPOINT sp_clone_split_v23');
                    } catch {
                        await client.query('ROLLBACK TO SAVEPOINT sp_clone_split_v23').catch(() => {});
                        cloned = await client.query(
                            `INSERT INTO ChiTietHoaDon
                                (MaHoaDon, MaMon, TenMonSnapshot, KichThuoc, SoLuong, DonGia, GiaGiam, GiaVonSnapshot, GhiChu, TrangThaiPhaChe, ThoiGianGoi)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, CURRENT_TIMESTAMP))
                             RETURNING MaCTHD`,
                            [
                                maHoaDonMoi,
                                r.mamon,
                                r.tenmonsnapshot,
                                r.kichthuoc,
                                item.qtyToMove,
                                Number(r.dongia),
                                splitDiscount,
                                Number(r.giavonsnapshot || 0),
                                r.ghichu,
                                r.trangthaiphache,
                                r.thoigiangoi,
                            ]
                        );
                    }
                    const newMaCTHD = cloned.rows[0].macthd;

                    // Chuẩn hóa Topping-per-Cup: giữ nguyên SoLuongMoiLy, KHÔNG chia lẻ thập phân!
                    const tpRes = await client.query(
                        `SELECT MaTopping, to_jsonb(ChiTietHoaDon_Topping)->>'tentoppingsnapshot' AS TenToppingSnapshot,
                                SoLuong, COALESCE((to_jsonb(ChiTietHoaDon_Topping)->>'soluongmoily')::int, 1) AS SoLuongMoiLy,
                                DonGia, COALESCE((to_jsonb(ChiTietHoaDon_Topping)->>'giavontoppingsnapshot')::numeric, 0) AS GiaVonToppingSnapshot
                           FROM ChiTietHoaDon_Topping WHERE MaCTHD = $1 FOR UPDATE`,
                        [r.macthd]
                    );
                    for (const tp of tpRes.rows) {
                        const perCup = Math.max(1, Number(tp.soluongmoily || 1));
                        const remainTpQty = perCup * remainQty;
                        const splitTpQty = perCup * item.qtyToMove;
                        await client.query(
                            `UPDATE ChiTietHoaDon_Topping SET SoLuong = $3 WHERE MaCTHD = $1 AND MaTopping = $2`,
                            [r.macthd, tp.matopping, remainTpQty]
                        );
                        await client.query('SAVEPOINT sp_ins_split_tp_v23');
                        try {
                            await client.query(
                                `INSERT INTO ChiTietHoaDon_Topping
                                    (MaCTHD, MaTopping, TenToppingSnapshot, SoLuong, SoLuongMoiLy, DonGia, GiaVonToppingSnapshot)
                                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                                [
                                    newMaCTHD,
                                    tp.matopping,
                                    tp.tentoppingsnapshot || null,
                                    splitTpQty,
                                    perCup,
                                    Number(tp.dongia),
                                    Number(tp.giavontoppingsnapshot || 0),
                                ]
                            );
                            await client.query('RELEASE SAVEPOINT sp_ins_split_tp_v23');
                        } catch {
                            await client.query('ROLLBACK TO SAVEPOINT sp_ins_split_tp_v23').catch(() => {});
                            await client.query(
                                `INSERT INTO ChiTietHoaDon_Topping (MaCTHD, MaTopping, SoLuong, DonGia) VALUES ($1, $2, $3, $4)`,
                                [newMaCTHD, tp.matopping, splitTpQty, Number(tp.dongia)]
                            );
                        }
                    }
                }
            }

            // Kiểm tra luật an toàn thanh toán 1 phần: Cấm tách nếu hóa đơn gốc đã thu vượt quá tổng tiền còn lại sau tách!
            const recalcGoc = await recalculateInvoiceTotals(client, {
                tenantId,
                maHoaDon,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                ip: req.ip,
                ghiAuditLog,
                kiemTraHopLeKhuyenMai,
            });
            await recalculateInvoiceTotals(client, {
                tenantId,
                maHoaDon: maHoaDonMoi,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                ip: req.ip,
                ghiAuditLog,
                kiemTraHopLeKhuyenMai,
            });

            const hoaDonGocAfter = await layHoaDonChiTiet(client, maHoaDon);
            if (Number(hoaDonGocAfter.daThanhToan || 0) > Number(hoaDonGocAfter.tongPhaiTra || 0) + 0.01) {
                throw new LoiNghiepVu(
                    400,
                    `Hóa đơn gốc đã thanh toán trước ${hoaDonGocAfter.daThanhToan.toLocaleString('vi-VN')}đ, vượt quá phần tiền còn lại sau tách (${hoaDonGocAfter.tongPhaiTra.toLocaleString('vi-VN')}đ)!`
                );
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'ORDER_SPLIT',
                doiTuong: 'HOADON',
                maDoiTuong: maHoaDon,
                giaTriMoi: {
                    mode: modeNorm,
                    maHoaDonMoi,
                    laChuyenGhepBan,
                    soDongTach: plan.length,
                    tongLyTach,
                    toMaBan: toMaBan || (modeNorm === 'BY_ITEM' ? 'SAME_TABLE' : 'MANG_DI'),
                    promoAdjusted: recalcGoc.promoAdjusted,
                },
                ip: req.ip,
                batBuoc: true,
            });

            return {
                mode: modeNorm,
                maHoaDonGoc: maHoaDon,
                maHoaDonMoi,
                laChuyenGhepBan,
                tongLyTach,
                promoAdjusted: recalcGoc.promoAdjusted,
                hoaDonGoc: hoaDonGocAfter,
                hoaDonMoi: await layHoaDonChiTiet(client, maHoaDonMoi),
            };
        }, tenantId);

        if (toMaBan) {
            io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('BAN_THAY_DOI', { maBan: toMaBan, trangThai: 2 });
        }
        io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'barista')).to(roomTen(tenantId, 'phucvu')).emit('BAN_CHUYEN', {
            maHoaDon: ketQua.maHoaDonMoi,
            maHoaDonGoc: ketQua.maHoaDonGoc,
            toMaBan,
            tenBanCu: ketQua.hoaDonGoc?.tenBan || `HĐ #${ketQua.maHoaDonGoc}`,
            tenBanMoi: ketQua.hoaDonMoi?.tenBan || (toMaBan || 'Đơn tách Mang đi'),
            laTachDon: true,
        });

        res.status(201).json({
            message: ketQua.laChuyenGhepBan
                ? `🔄 Đã chuyển ${ketQua.tongLyTach} ly sang Hóa đơn #${ketQua.maHoaDonMoi} (${toMaBan})!`
                : `✂️ Đã tách ${ketQua.tongLyTach} ly sang Hóa đơn mới #${ketQua.maHoaDonMoi}!`,
            ...ketQua,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Tách hóa đơn:');
    }
}

app.post('/api/order/:maHoaDon/tach', kiemTraToken, choPhepVaiTro(1, 4), handleSplitOrder);

// [Wave 3A — P1-03] Khóa/Mở nhanh món tạm hết (86'ing) cô lập theo Chi nhánh trong branch_availability_86
app.put('/api/sanpham/:maMon/tamhet', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
    const { maMon } = req.params;
    const tamHet = Boolean(req.body?.tamHet);
    const tenantId = layTenantId(req);
    const branchId = normalizeBranchId(req.body?.branchId || req.headers['x-branch-id'] || req.user?.branchId || 'DEFAULT');
    try {
        const mon = await pool.withTenant(tenantId, async (client) => {
            const r = await client.query(
                `SELECT MaMon, TenMon FROM SanPham WHERE MaMon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
                [maMon, tenantId]
            );
            if (r.rows.length === 0) return null;
            const row = r.rows[0];
            await client.query(
                `INSERT INTO public.branch_availability_86
                    (tenant_id, branch_id, entity_type, entity_id, is_sold_out, is_auto_cascaded, caused_by_ingredients, updated_by, updated_at)
                 VALUES ($1, $2, 'PRODUCT', $3, $4, FALSE, '{}'::text[], $5, now())
                 ON CONFLICT (tenant_id, branch_id, entity_type, entity_id) DO UPDATE
                     SET is_sold_out = EXCLUDED.is_sold_out,
                         is_auto_cascaded = FALSE,
                         caused_by_ingredients = CASE WHEN EXCLUDED.is_sold_out = FALSE THEN '{}'::text[] ELSE public.branch_availability_86.caused_by_ingredients END,
                         updated_by = EXCLUDED.updated_by,
                         updated_at = now()`,
                [tenantId, branchId, maMon, tamHet, req.user.maNV]
            );
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'MENU_86_TOGGLE',
                doiTuong: 'SANPHAM',
                maDoiTuong: maMon,
                giaTriMoi: { tenMon: row.tenmon, branchId, tamHet },
                ip: req.ip,
            });
            return { ...row, tamhet: tamHet };
        });
        if (!mon) return res.status(404).json({ message: 'Không tìm thấy món này!' });

        const payload = {
            branchId,
            maMon: mon.mamon,
            tenMon: mon.tenmon,
            tamHet: Boolean(mon.tamhet),
            affectedProducts: [{ maMon: mon.mamon, tenMon: mon.tenmon, branchId, tamHet: Boolean(mon.tamhet) }],
        };
        emitScopedKdsEvent(io, {
            tenantId,
            branchId,
            station: 'ALL',
            eventType: 'MENU_86_UPDATED',
            socketEvents: ['menu:86_updated', 'THUC_DON_THAY_DOI'],
            payload,
            includeExpo: true,
            includeWaiter: true,
            includePos: true,
            includeQr: true,
        });

        res.json({
            message: tamHet ? `Đã báo TẠM HẾT món "${mon.tenmon}" tại chi nhánh ${branchId}!` : `Đã mở bán lại món "${mon.tenmon}" tại chi nhánh ${branchId}!`,
            branchId,
            maMon: mon.mamon,
            tamHet: Boolean(mon.tamhet),
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Báo tạm hết món:');
    }
});

// [Wave 3A — P1-03] Khóa/Mở nhanh Topping tạm hết cô lập theo Chi nhánh
app.put('/api/topping/:maTopping/tamhet', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
    const { maTopping } = req.params;
    const tamHet = Boolean(req.body?.tamHet);
    const tenantId = layTenantId(req);
    const branchId = normalizeBranchId(req.body?.branchId || req.headers['x-branch-id'] || req.user?.branchId || 'DEFAULT');
    try {
        const tp = await pool.withTenant(tenantId, async (client) => {
            const r = await client.query(
                "SELECT MaTopping, TenTopping FROM Topping WHERE MaTopping = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
                [maTopping, tenantId]
            );
            if (r.rows.length === 0) return null;
            const row = r.rows[0];
            await client.query(
                `INSERT INTO public.branch_availability_86
                    (tenant_id, branch_id, entity_type, entity_id, is_sold_out, is_auto_cascaded, caused_by_ingredients, updated_by, updated_at)
                 VALUES ($1, $2, 'TOPPING', $3, $4, FALSE, '{}'::text[], $5, now())
                 ON CONFLICT (tenant_id, branch_id, entity_type, entity_id) DO UPDATE
                     SET is_sold_out = EXCLUDED.is_sold_out,
                         is_auto_cascaded = FALSE,
                         updated_by = EXCLUDED.updated_by,
                         updated_at = now()`,
                [tenantId, branchId, maTopping, tamHet, req.user.maNV]
            );
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'TOPPING_86_TOGGLE',
                doiTuong: 'TOPPING',
                maDoiTuong: maTopping,
                giaTriMoi: { tenTopping: row.tentopping, branchId, tamHet },
                ip: req.ip,
            });
            return { ...row, tamhet: tamHet };
        });
        if (!tp) return res.status(404).json({ message: 'Không tìm thấy topping này!' });

        const payload = {
            branchId,
            maTopping: tp.matopping,
            tenTopping: tp.tentopping,
            tamHet: Boolean(tp.tamhet),
            affectedToppings: [{ maTopping: tp.matopping, tenTopping: tp.tentopping, branchId, tamHet: Boolean(tp.tamhet) }],
        };
        emitScopedKdsEvent(io, {
            tenantId,
            branchId,
            station: 'ALL',
            eventType: 'MENU_86_UPDATED',
            socketEvents: ['menu:86_updated', 'TOPPING_THAY_DOI'],
            payload,
            includeExpo: true,
            includeWaiter: true,
            includePos: true,
            includeQr: true,
        });

        res.json({
            message: tamHet ? `Đã báo TẠM HẾT topping "${tp.tentopping}" tại chi nhánh ${branchId}!` : `Đã mở lại topping "${tp.tentopping}" tại chi nhánh ${branchId}!`,
            branchId,
            maTopping: tp.matopping,
            tamHet: Boolean(tp.tamhet),
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Báo tạm hết topping:');
    }
});

// [v2] Hóa đơn đang mở của 1 bàn (cô lập TenantId)
app.get('/api/ban/:maBan/hoadon', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const out = await pool.withTenant(tenantId, async (client) => {
            const ban = await client.query(
                "SELECT 1 FROM Ban WHERE MaBan = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2",
                [req.params.maBan, tenantId]
            );
            if (ban.rows.length === 0) return { notFound: true };
            const maHoaDon = await layHoaDonMoCuaBan(client, req.params.maBan);
            return { notFound: false, hoaDon: maHoaDon ? await layHoaDonChiTiet(client, maHoaDon) : null };
        });
        if (out.notFound) return res.status(404).json({ message: 'Không tìm thấy bàn!' });
        res.json({ hoaDon: out.hoaDon });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Hóa đơn theo bàn:');
    }
});

// [v2] Chi tiết 1 hóa đơn (cô lập TenantId)
app.get('/api/hoadon/:maHoaDon', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const hoaDon = await pool.withTenant(tenantId, async (client) => {
            const own = await client.query(
                "SELECT 1 FROM HoaDon WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
                [req.params.maHoaDon, tenantId]
            );
            if (own.rows.length === 0) return null;
            return layHoaDonChiTiet(client, req.params.maHoaDon);
        });
        if (!hoaDon) return res.status(404).json({ message: 'Không tìm thấy hóa đơn!' });
        res.json({ hoaDon });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Chi tiết hóa đơn:');
    }
});

// ============================================================================
// [PHÂN HỆ 6] CLOUD-TO-LOCAL PRINT RELAY (Giải quyết triệt để Mixed Content HTTPS & PNA cho iPad / Android Tablet)
// Thiết bị iPad / Android Tablet chạy trên HTTPS gửi lệnh in lên Backend (/api/print-relay/dispatch),
// Local Print Bridge Agent tại quán chủ động kéo outbound (/api/print-relay/pull) về in qua LAN/USB!
// ============================================================================
const printRelayTenants = new Map(); // tenantId -> { seq: 1, lastHeartbeatAt: null, jobs: [] }

function layPrintRelayState(tenantId) {
    const key = String(tenantId || 'DEFAULT');
    let st = printRelayTenants.get(key);
    if (!st) {
        st = { seq: 1, lastHeartbeatAt: null, jobs: [] };
        printRelayTenants.set(key, st);
    }
    return st;
}

app.post('/api/print-relay/dispatch', kiemTraToken, choPhepVaiTro(1, 2, 3, 4), (req, res) => {
    const tenantId = layTenantId(req);
    const { kind = 'RECEIPT', payload = {} } = req.body || {};
    const validKinds = ['RECEIPT', 'LABEL', 'Z_REPORT', 'DRAWER_KICK'];
    const cleanKind = String(kind).toUpperCase();
    if (!validKinds.includes(cleanKind)) {
        return res.status(400).json({ ok: false, message: 'Loại lệnh in Relay không hợp lệ!' });
    }
    const st = layPrintRelayState(tenantId);
    const job = {
        id: st.seq++,
        tenantId,
        kind: cleanKind,
        payload,
        status: 'PENDING',
        createdBy: req.user?.maNV || 'POS',
        createdAt: new Date().toISOString(),
        pulledAt: null,
        completedAt: null,
        error: null,
    };
    st.jobs.unshift(job);
    if (st.jobs.length > 50) st.jobs.pop();

    io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'barista')).emit('PRINT_RELAY_JOB', {
        id: job.id,
        kind: job.kind,
        createdAt: job.createdAt,
    });

    res.status(201).json({
        ok: true,
        mode: 'CLOUD_RELAY',
        message: 'Đã đẩy lệnh in qua Cloud Print Relay về máy in tại quán!',
        job: { id: job.id, kind: job.kind, status: job.status, createdAt: job.createdAt },
    });
});

app.get('/api/print-relay/pull', kiemTraToken, choPhepVaiTro(1, 2, 3, 4), (req, res) => {
    const tenantId = layTenantId(req);
    const st = layPrintRelayState(tenantId);
    st.lastHeartbeatAt = Date.now();
    const nowIso = new Date().toISOString();
    const pending = st.jobs
        .filter((j) => j.status === 'PENDING')
        .slice(0, 10)
        .reverse(); // In theo thứ tự FIFO
    for (const j of pending) {
        j.status = 'PULLED';
        j.pulledAt = nowIso;
    }
    res.json({ ok: true, jobs: pending });
});

app.post('/api/print-relay/ack', kiemTraToken, choPhepVaiTro(1, 2, 3, 4), (req, res) => {
    const tenantId = layTenantId(req);
    const { jobId, status = 'DONE', error = null, transport = null, bytes = 0 } = req.body || {};
    const st = layPrintRelayState(tenantId);
    st.lastHeartbeatAt = Date.now();
    const job = st.jobs.find((j) => Number(j.id) === Number(jobId));
    if (!job) {
        return res.status(404).json({ ok: false, message: 'Không tìm thấy lệnh in Relay!' });
    }
    job.status = status === 'FAILED' ? 'FAILED' : 'DONE';
    job.completedAt = new Date().toISOString();
    job.error = error || null;
    job.transport = transport || null;
    job.bytes = Number(bytes || 0);
    res.json({ ok: true, job: { id: job.id, kind: job.kind, status: job.status } });
});

app.get('/api/print-relay/status', kiemTraToken, choPhepVaiTro(1, 2, 3, 4), (req, res) => {
    const tenantId = layTenantId(req);
    const st = layPrintRelayState(tenantId);
    const bridgeActive = Boolean(st.lastHeartbeatAt && Date.now() - st.lastHeartbeatAt < 15000);
    res.json({
        ok: true,
        bridgeActive,
        lastHeartbeatAt: st.lastHeartbeatAt ? new Date(st.lastHeartbeatAt).toISOString() : null,
        pendingCount: st.jobs.filter((j) => j.status === 'PENDING').length,
        jobs: st.jobs.slice(0, 20).map(({ payload: _p, ...meta }) => meta),
    });
});

// ---- Tiện ích Thanh toán Hỗn hợp (Order_Payments 1-N) & Xác thực Webhook VietQR ----
function chonPhuongThucChinh(dsThanhToan) {
    // Tương thích ngược với constraint HoaDon.PhuongThucTT (TIEN_MAT | CHUYEN_KHOAN | THE)
    const tongTheoPttt = new Map();
    for (const p of dsThanhToan) {
        if (PHUONG_THUC_LEGACY.includes(p.phuongThucTT)) {
            tongTheoPttt.set(p.phuongThucTT, (tongTheoPttt.get(p.phuongThucTT) || 0) + Number(p.soTien));
        }
    }
    let best = 'TIEN_MAT';
    let maxVal = -1;
    for (const [k, v] of tongTheoPttt) {
        if (v > maxVal) {
            maxVal = v;
            best = k;
        }
    }
    return best;
}

// [P0] Chuẩn hóa & chặn lệch sổ cái khi thu vượt (Split Tender Overpayment + VietQR Chuyển thừa)
function chuanHoaKhoanThanhToanVaThuThua({
    cacKhoanTT,
    conLaiTruoc,
    vaiTro = null,
    voucherApprovedByManager = false,
    khoaIdem = null,
}) {
    const dongGhi = [];

    for (let i = 0; i < cacKhoanTT.length; i++) {
        const k = cacKhoanTT[i];
        const pt = k.phuongThucTT;
        if (!PHUONG_THUC_TT.includes(pt)) {
            throw new LoiNghiepVu(400, `Phương thức thanh toán "${pt}" không hợp lệ!`);
        }
        if (pt === 'VOUCHER' && vaiTro !== 1 && !voucherApprovedByManager) {
            throw new LoiNghiepVu(403, 'Chỉ Quản lý hoặc mã PIN Quản lý mới có quyền xác nhận thanh toán bằng VOUCHER!', {
                code: 'VOUCHER_PIN_REQUIRED',
                maLoi: 'CAN_PIN_QUAN_LY',
            });
        }
        const soTien = Math.round(Number(k.soTien) * 100) / 100;
        if (!(soTien > 0)) {
            throw new LoiNghiepVu(400, 'Số tiền mỗi khoản thanh toán phải > 0!');
        }

        let tienKhachDua = k.tienKhachDua !== undefined && k.tienKhachDua !== null ? Number(k.tienKhachDua) : null;
        let tienThua = 0;
        if (pt === 'TIEN_MAT' && tienKhachDua !== null) {
            if (!(tienKhachDua >= soTien)) {
                throw new LoiNghiepVu(400, 'Số tiền khách đưa cho khoản tiền mặt chưa đủ!', { canThu: soTien });
            }
            tienThua = Math.round((tienKhachDua - soTien) * 100) / 100;
        } else if (pt !== 'TIEN_MAT') {
            tienKhachDua = soTien;
        }

        dongGhi.push({
            phuongThucTT: pt,
            soTien,
            tienKhachDua: tienKhachDua !== null ? tienKhachDua : soTien,
            tienThua,
            tienChuyenThua: 0,
            maGiaoDichNgoai: k.maGiaoDichNgoai || null,
            noiDungCK: k.noiDungCK || null,
            maChuanChiEDC: k.maChuanChiEDC ? String(k.maChuanChiEDC).trim().slice(0, 64) : null,
            bonSoCuoiThe: k.bonSoCuoiThe ? String(k.bonSoCuoiThe).trim().slice(0, 8) : null,
            nguonXacNhan: k.nguonXacNhan || 'POS_MANUAL',
            khoaIdem: khoaIdem && i === 0 ? khoaIdem : null,
        });
    }

    const laWebhook =
        dongGhi.length > 0 &&
        dongGhi.every((d) => ['SEPAY_WEBHOOK', 'PAYOS_WEBHOOK', 'WEBHOOK_SIMULATOR', 'MANUAL_BANK_MATCH'].includes(d.nguonXacNhan));
    const tongRaw = Math.round(dongGhi.reduce((s, d) => s + d.soTien, 0) * 100) / 100;
    let tienChuyenThua = 0;

    if (!laWebhook) {
        const tongNonCash = Math.round(
            dongGhi.filter((d) => d.phuongThucTT !== 'TIEN_MAT').reduce((s, d) => s + d.soTien, 0) * 100
        ) / 100;
        if (tongNonCash > conLaiTruoc + 0.01) {
            throw new LoiNghiepVu(
                400,
                `Tổng Chuyển khoản/Thẻ/Voucher (${tongNonCash.toLocaleString('vi-VN')}đ) vượt quá số tiền còn lại của hóa đơn (${conLaiTruoc.toLocaleString('vi-VN')}đ)!`,
                { conLai: conLaiTruoc, tongNonCash }
            );
        }
        if (tongRaw > conLaiTruoc + 0.01) {
            if (tongNonCash >= conLaiTruoc - 0.01 && dongGhi.some((d) => d.phuongThucTT === 'TIEN_MAT')) {
                throw new LoiNghiepVu(
                    400,
                    'Các khoản Chuyển khoản/Thẻ đã đủ thanh toán hóa đơn, không cần thu thêm Tiền mặt!'
                );
            }
            let duCanCat = Math.round((tongRaw - conLaiTruoc) * 100) / 100;
            for (let i = dongGhi.length - 1; i >= 0 && duCanCat > 0; i--) {
                if (dongGhi[i].phuongThucTT !== 'TIEN_MAT') continue;
                const gocSoTien = dongGhi[i].soTien;
                const cat = Math.min(gocSoTien, duCanCat);
                const soTienMoi = Math.round((gocSoTien - cat) * 100) / 100;
                if (soTienMoi <= 0) {
                    throw new LoiNghiepVu(
                        400,
                        'Khoản tiền mặt nhập vào bị dư hoàn toàn so với phần còn lại cần thu!'
                    );
                }
                dongGhi[i].soTien = soTienMoi;
                dongGhi[i].tienThua = Math.round((dongGhi[i].tienKhachDua - soTienMoi) * 100) / 100;
                duCanCat = Math.round((duCanCat - cat) * 100) / 100;
            }
        }
    } else if (conLaiTruoc > 0 && tongRaw > conLaiTruoc + 0.01) {
        tienChuyenThua = Math.round((tongRaw - conLaiTruoc) * 100) / 100;
        dongGhi[0].tienKhachDua = dongGhi[0].soTien; // Giữ nguyên số tiền ngân hàng báo chuyển
        dongGhi[0].soTien = conLaiTruoc; // Sổ cái chỉ ghi nhận đúng phần thanh toán hóa đơn
        dongGhi[0].tienChuyenThua = tienChuyenThua;
    }

    const tongThuLanNay = Math.round(dongGhi.reduce((s, d) => s + d.soTien, 0) * 100) / 100;
    const tongTienThua = Math.round(dongGhi.reduce((s, d) => s + d.tienThua, 0) * 100) / 100;
    return { dongGhi, tongThuLanNay, tongTienThua, tienChuyenThua };
}

// Dùng chung cho POS Thanh toán (Đơn/Hỗn hợp/Thu 1 phần/Chia tiền/Khuyến mãi/Đổi điểm/Optimistic Locking) và Webhook VietQR tự động
async function ghiNhanThanhToanTrongGiaoDich(
    client,
    {
        maHoaDon,
        expectedTenantId = null,
        expectedVersion = null,
        mandatoryVersion = true,
        chiaTienId = null,
        ca,
        maNV,
        vaiTro = null,
        voucherApprovedByManager = false,
        maKH = null,
        maKhuyenMai = null,
        diemSuDung = 0,
        tuDongHappyHour = false,
        autoFillSingleMethod = null, // { phuongThucTT, tienKhachDua }
        cacKhoanTT, // [{ phuongThucTT, soTien, tienKhachDua, maGiaoDichNgoai, noiDungCK, nguonXacNhan }]
        choPhepThuMotPhan = false,
        khoaIdem = null,
        laOfflineLechCa = false,
        maCaThuNganGoc = null,
        branchId = null,
        terminalId = null,
        ip = null,
    }
) {
    await client.query(
        `SELECT MaBan FROM Ban
          WHERE MaBan IN (SELECT MaBan FROM HoaDon_Ban WHERE MaHoaDon = $1)
          ORDER BY MaBan FOR UPDATE`,
        [maHoaDon]
    );
    const hdRes = await client.query(
        `SELECT TrangThaiTT, COALESCE(to_jsonb(HoaDon)->>'lifecycle_status', 'OPEN') AS lifecycle_status,
                MaKH, COALESCE(TenantId, 'DEFAULT') AS TenantId
           FROM HoaDon WHERE MaHoaDon = $1 FOR UPDATE`,
        [maHoaDon]
    );
    if (hdRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn!');
    const hdTenantId = hdRes.rows[0].tenantid || 'DEFAULT';
    if (expectedTenantId && hdTenantId !== expectedTenantId) {
        throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn!');
    }
    if (hdRes.rows[0].lifecycle_status === 'VOIDED') {
        throw new LoiNghiepVu(409, 'Hóa đơn này đã bị hủy (VOIDED), không thể thanh toán!', {
            code: 'ORDER_VOIDED',
            maLoi: 'ORDER_VOIDED',
        });
    }
    if (hdRes.rows[0].trangthaitt === 2) throw new LoiNghiepVu(409, 'Hóa đơn này đã được hoàn tiền!');
    if (hdRes.rows[0].trangthaitt === 3 || hdRes.rows[0].lifecycle_status === 'MERGED') {
        throw new LoiNghiepVu(409, 'Hóa đơn này đã được gộp sang hóa đơn khác!');
    }
    if (hdRes.rows[0].trangthaitt !== 0) {
        throw new LoiNghiepVu(409, 'Hóa đơn này đã được thanh toán hoàn tất trước đó!', {
            code: 'ALREADY_PAID',
            maLoi: 'ALREADY_PAID',
        });
    }

    // [Phân hệ 1 - 100/100] Khóa lạc quan (Optimistic Locking) chống Phục vụ & Thu ngân ghi đè cùng 1 bàn!
    await kiemTraVaTangVersionHoaDon(client, {
        maHoaDon,
        tenantId: hdTenantId,
        expectedVersion,
        mandatory: mandatoryVersion,
        layHoaDonChiTiet,
        LoiNghiepVu,
    });

    if (maKH) {
        const kh = await client.query(
            "SELECT 1 FROM KhachHang WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
            [maKH, hdTenantId]
        );
        if (kh.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy khách hàng!');
        await client.query('UPDATE HoaDon SET MaKH = $1 WHERE MaHoaDon = $2', [maKH, maHoaDon]);
    }

    const chiTietTruoc = await layHoaDonChiTiet(client, maHoaDon);
    if (chiTietTruoc.soMonHopLe === 0) throw new LoiNghiepVu(400, 'Hóa đơn không còn món hợp lệ nào để thanh toán!');

    // Kiểm tra phần chia tiền (nếu thanh toán theo HoaDon_ChiaTien)
    let chiaTienRow = null;
    if (chiaTienId !== null && chiaTienId !== undefined) {
        const ctRes = await client.query(
            `SELECT id, mahoadon, nhanchia, sotienphaitra, sotiendatra, trangthai
               FROM hoadon_chiatien
              WHERE id = $1 AND tenantid = $2 AND mahoadon = $3::text
              FOR UPDATE`,
            [Number(chiaTienId), hdTenantId, String(maHoaDon)]
        );
        if (ctRes.rows.length === 0) {
            throw new LoiNghiepVu(404, 'Không tìm thấy phần chia tiền tương ứng của hóa đơn!');
        }
        chiaTienRow = ctRes.rows[0];
        if (chiaTienRow.trangthai !== 'UNPAID') {
            throw new LoiNghiepVu(409, `Phần chia "${chiaTienRow.nhanchia}" đã được thanh toán hoặc đã hủy!`);
        }
    }

    // Áp Khuyến mãi (Mã giảm giá / Happy Hour) & Đổi điểm Loyalty nếu hóa đơn chưa áp ưu đãi trước đó
    const khHienTai = maKH || hdRes.rows[0].makh || null;
    let tienGiamKMFinal = Number(chiTietTruoc.tienGiamKM || 0);
    let tienGiamDiemFinal = Number(chiTietTruoc.tienGiamDiem || 0);
    const chuaApUuDai =
        tienGiamKMFinal + tienGiamDiemFinal === 0 && !chiTietTruoc.maKhuyenMai && Number(chiTietTruoc.diemSuDung || 0) === 0;
    const muonApUuDai = Boolean(maKhuyenMai) || Number(diemSuDung || 0) > 0 || (tuDongHappyHour && chiTietTruoc.daThanhToan === 0);

    if (chuaApUuDai && muonApUuDai) {
        const uuDai = await tinhUuDaiVaDiemTrongGiaoDich(client, {
            tenantId: hdTenantId,
            tongTamTinh: chiTietTruoc.tongTamTinh,
            maKhuyenMai,
            maKH: khHienTai,
            diemSuDung,
            tuDongHappyHour: Boolean(tuDongHappyHour),
            khoaCapNhat: true,
            LoiNghiepVu,
        });
        tienGiamKMFinal = uuDai.tienGiamKM;
        tienGiamDiemFinal = uuDai.tienGiamDiem;
        if (uuDai.tongGiamGia > 0 || uuDai.maKhuyenMai) {
            await client.query('SAVEPOINT sp_tt_promo');
            try {
                await client.query(
                    `UPDATE HoaDon
                        SET MaKhuyenMai = $2, TenKhuyenMai = $3, TienGiamKM = $4, DiemSuDung = $5, TienGiamDiem = $6
                      WHERE MaHoaDon = $1`,
                    [
                        maHoaDon,
                        uuDai.maKhuyenMai,
                        uuDai.tenKhuyenMai,
                        uuDai.tienGiamKM,
                        uuDai.diemSuDung,
                        uuDai.tienGiamDiem,
                    ]
                );
                await client.query('RELEASE SAVEPOINT sp_tt_promo');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_tt_promo').catch(() => {});
            }
        }
    }

    const keToanPay = tinhTongKeToanHoaDon({
        danhSachMon: chiTietTruoc.danhSachMon,
        tienGiamKM: tienGiamKMFinal,
        tienGiamDiem: tienGiamDiemFinal,
        loaiDonHang: chiTietTruoc.loaiDonHang,
        phiPhucVuPhanTram: chiTietTruoc.phiPhucVuPhanTram,
        phiDongGoi: chiTietTruoc.phiDongGoi,
        cachTinhThue: chiTietTruoc.cachTinhThue,
        thueVATPhanTram: chiTietTruoc.thueVATPhanTram,
    });
    const tongTien = keToanPay.tongPhaiTra;
    const daThuTruoc = chiTietTruoc.daThanhToan;
    const conLaiTruoc = Math.max(0, Math.round((tongTien - daThuTruoc) * 100) / 100);
    const mucThuMucTieu = chiaTienRow
        ? Math.min(conLaiTruoc, Math.max(0, Number(chiaTienRow.sotienphaitra) - Number(chiaTienRow.sotiendatra || 0)))
        : conLaiTruoc;
    const allowPartial = Boolean(choPhepThuMotPhan || chiaTienRow);

    let dongGhi = [];
    let tongThuLanNay = 0;
    let tongTienThua = 0;
    let tienChuyenThua = 0;

    if (conLaiTruoc > 0) {
        const khoanTTThucTe =
            (!Array.isArray(cacKhoanTT) || cacKhoanTT.length === 0) && autoFillSingleMethod
                ? [
                      {
                          phuongThucTT: autoFillSingleMethod.phuongThucTT,
                          soTien: mucThuMucTieu,
                          tienKhachDua: autoFillSingleMethod.tienKhachDua,
                          noiDungCK: autoFillSingleMethod.noiDungCK || null,
                          nguonXacNhan: autoFillSingleMethod.nguonXacNhan || 'POS_MANUAL',
                      },
                  ]
                : cacKhoanTT;
        const norm = chuanHoaKhoanThanhToanVaThuThua({
            cacKhoanTT: khoanTTThucTe,
            conLaiTruoc: chiaTienRow ? mucThuMucTieu : conLaiTruoc,
            vaiTro,
            voucherApprovedByManager,
            khoaIdem,
        });
        dongGhi = norm.dongGhi;
        tongThuLanNay = norm.tongThuLanNay;
        tongTienThua = norm.tongTienThua;
        tienChuyenThua = norm.tienChuyenThua;
    } else if (daThuTruoc > 0 && tongTien > 0) {
        throw new LoiNghiepVu(409, 'Hóa đơn này đã thu đủ tiền trước đó!', {
            code: 'ALREADY_PAID',
            maLoi: 'ALREADY_PAID',
        });
    }

    const tongSauThu = Math.round((daThuTruoc + tongThuLanNay) * 100) / 100;

    if (!allowPartial && tongSauThu + 0.01 < tongTien) {
        throw new LoiNghiepVu(
            400,
            `Tổng tiền thanh toán (${tongSauThu.toLocaleString('vi-VN')}đ) chưa đủ cho hóa đơn (${tongTien.toLocaleString('vi-VN')}đ)!`,
            { tongTien, daThuTruoc, conLai: conLaiTruoc }
        );
    }

    // [Phân hệ 3 - Trụ cột 1] Trừ Ví trả trước thành viên (VI_KHACH) nguyên tử bằng FOR UPDATE trong cùng ACID Transaction
    const walletPayments = dongGhi.filter((d) => d.phuongThucTT === 'VI_KHACH');
    if (walletPayments.length > 0) {
        const walletTotal = Math.round(walletPayments.reduce((s, d) => s + Number(d.soTien), 0) * 100) / 100;
        const targetMaKH = khHienTai;
        if (!targetMaKH) {
            throw new LoiNghiepVu(400, 'Thanh toán bằng Ví thành viên (VI_KHACH) yêu cầu chọn khách hàng (maKH)!');
        }
        const khLock = await client.query(
            `SELECT MaKH, TenKH, COALESCE(SoDuVi, 0) AS SoDuVi
               FROM KhachHang
              WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
              FOR UPDATE`,
            [targetMaKH, hdTenantId]
        );
        if (khLock.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy khách hàng để trừ Ví!');
        const soDuHienTai = Number(khLock.rows[0].soduvi || 0);
        if (soDuHienTai + 0.01 < walletTotal) {
            throw new LoiNghiepVu(
                409,
                `Số dư Ví thành viên (${soDuHienTai.toLocaleString('vi-VN')}đ) không đủ để thanh toán ${walletTotal.toLocaleString('vi-VN')}đ!`,
                { code: 'INSUFFICIENT_WALLET_BALANCE', soDuVi: soDuHienTai, canTru: walletTotal }
            );
        }
        const soDuSau = Math.round((soDuHienTai - walletTotal) * 100) / 100;
        await client.query(`UPDATE KhachHang SET SoDuVi = $2 WHERE MaKH = $1`, [targetMaKH, soDuSau]);
        await client.query(
            `INSERT INTO KhachHang_GiaoDichVi (TenantId, MaKH, LoaiGD, SoTien, SoDuSau, MaHoaDon, MaNV, GhiChu)
             VALUES ($1, $2, 'PAYMENT', $3, $4, $5, $6, $7)`,
            [hdTenantId, targetMaKH, -walletTotal, soDuSau, maHoaDon, maNV ? String(maNV) : null, `Thanh toán hóa đơn #${maHoaDon}`]
        );
    }

    const payBranchId = normalizeBranchForShift(hdTenantId, branchId || ca?.branchid);
    const payTerminalId = normalizeTerminalId(terminalId || ca?.terminalid);

    if (paymentsSanSang) {
        for (const dong of dongGhi) {
            await client.query('SAVEPOINT sp_pay_chuyenthua');
            try {
                await client.query(
                    `INSERT INTO Order_Payments
                        (MaHoaDon, MaCaThuNgan, PhuongThucTT, SoTien, TienKhachDua, TienThua, TienChuyenThua, TrangThai,
                         MaGiaoDichNgoai, NoiDungCK, NguonXacNhan, KhoaIdem, MaNV, TenantId, ChiaTienId,
                         BranchId, TerminalId, MaChuanChiEDC, BonSoCuoiThe, LaOfflineLechCa, MaCaThuNganGoc)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PAID', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
                    [
                        String(maHoaDon),
                        ca ? String(ca.macathungan) : null,
                        dong.phuongThucTT,
                        dong.soTien,
                        dong.tienKhachDua,
                        dong.tienThua,
                        dong.tienChuyenThua || 0,
                        dong.maGiaoDichNgoai,
                        dong.noiDungCK,
                        dong.nguonXacNhan,
                        dong.khoaIdem,
                        maNV ? String(maNV) : null,
                        hdTenantId,
                        chiaTienRow ? Number(chiaTienRow.id) : null,
                        payBranchId,
                        payTerminalId,
                        dong.maChuanChiEDC || null,
                        dong.bonSoCuoiThe || null,
                        Boolean(laOfflineLechCa),
                        maCaThuNganGoc ? String(maCaThuNganGoc) : null,
                    ]
                );
                await client.query('RELEASE SAVEPOINT sp_pay_chuyenthua');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_pay_chuyenthua').catch(() => {});
                await client.query(
                    `INSERT INTO Order_Payments
                        (MaHoaDon, MaCaThuNgan, PhuongThucTT, SoTien, TienKhachDua, TienThua, TrangThai,
                         MaGiaoDichNgoai, NoiDungCK, NguonXacNhan, KhoaIdem, MaNV, TenantId)
                     VALUES ($1, $2, $3, $4, $5, $6, 'PAID', $7, $8, $9, $10, $11, $12)`,
                    [
                        String(maHoaDon),
                        ca ? String(ca.macathungan) : null,
                        dong.phuongThucTT,
                        dong.soTien,
                        dong.tienKhachDua,
                        dong.tienThua,
                        dong.maGiaoDichNgoai,
                        dong.noiDungCK,
                        dong.nguonXacNhan,
                        dong.khoaIdem,
                        maNV ? String(maNV) : null,
                        hdTenantId,
                    ]
                );
            }
        }
    }

    // Cập nhật trạng thái phần chia tiền trong HoaDon_ChiaTien (nếu có)
    if (chiaTienRow && tongThuLanNay > 0) {
        const newPaidShare = Math.round((Number(chiaTienRow.sotiendatra || 0) + tongThuLanNay) * 100) / 100;
        const shareDone = newPaidShare + 0.01 >= Number(chiaTienRow.sotienphaitra);
        await client.query(
            `UPDATE hoadon_chiatien
                SET sotiendatra = $2,
                    trangthai = CASE WHEN $3 THEN 'PAID' ELSE trangthai END
              WHERE id = $1`,
            [Number(chiaTienRow.id), newPaidShare, shareDone]
        );
    }

    const daHoanTat = tongSauThu + 0.01 >= tongTien;
    let diemCong = 0;
    let banDaTrong = [];

    if (daHoanTat) {
        const tatCaThanhToan = [
            ...(chiTietTruoc.danhSachThanhToan || []),
            ...dongGhi,
        ];
        const ptttChinh = chonPhuongThucChinh(tatCaThanhToan);

        await client.query('SAVEPOINT sp_pay_upd_hd');
        try {
            await client.query(
                `UPDATE HoaDon
                    SET TrangThaiTT = 1, TongTienThanhToan = $2, ThoiGianThanhToan = CURRENT_TIMESTAMP,
                        PhuongThucTT = $3, MaCaThuNgan = COALESCE($4, MaCaThuNgan), MaKH = COALESCE($5, MaKH),
                        TienPhiPhucVu = $6, TienThueVAT = $7, TienLamTron = $8
                  WHERE MaHoaDon = $1`,
                [
                    maHoaDon,
                    tongTien,
                    ptttChinh,
                    ca ? ca.macathungan : null,
                    maKH || null,
                    keToanPay.tienPhiPhucVu,
                    keToanPay.tienThueVAT,
                    keToanPay.tienLamTron,
                ]
            );
            await client.query('RELEASE SAVEPOINT sp_pay_upd_hd');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_pay_upd_hd').catch(() => {});
            await client.query(
                `UPDATE HoaDon
                    SET TrangThaiTT = 1, TongTienThanhToan = $2, ThoiGianThanhToan = CURRENT_TIMESTAMP,
                        PhuongThucTT = $3, MaCaThuNgan = COALESCE($4, MaCaThuNgan), MaKH = COALESCE($5, MaKH)
                  WHERE MaHoaDon = $1`,
                [maHoaDon, tongTien, ptttChinh, ca ? ca.macathungan : null, maKH || null]
            );
        }

        // Chốt toàn bộ các phần chia tiền (nếu còn) sang PAID khi hóa đơn hoàn tất
        await client.query('SAVEPOINT sp_close_chiatien');
        try {
            await client.query(
                `UPDATE hoadon_chiatien SET trangthai = 'PAID', sotiendatra = sotienphaitra
                  WHERE tenantid = $1 AND mahoadon = $2::text AND trangthai = 'UNPAID'`,
                [hdTenantId, String(maHoaDon)]
            );
            await client.query('RELEASE SAVEPOINT sp_close_chiatien');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_close_chiatien').catch(() => {});
        }

        const khFinal = maKH || hdRes.rows[0].makh || null;
        if (khFinal && tongTien >= DIEM_MOI_VND) {
            diemCong = Math.floor(tongTien / DIEM_MOI_VND);
            await client.query(
                'UPDATE KhachHang SET DiemTichLuy = COALESCE(DiemTichLuy, 0) + $1 WHERE MaKH = $2',
                [diemCong, khFinal]
            );
        }
        // [PHÂN HỆ 8] Cập nhật Hạng thành viên (Đồng/Bạc/Vàng/Kim Cương), Hoàn tiền Cashback vào Ví & xếp hàng Zalo ZNS
        if (khFinal && tongTien > 0) {
            await capNhatCrmVaZnsSauThanhToan(client, {
                tenantId: hdTenantId,
                maKH: khFinal,
                maHoaDon,
                tongTien,
                diemCong,
            });
        }

        // [Phân hệ 1 - 100/100] Sau khi thanh toán xong bàn -> tự chuyển sang 3 = Chờ dọn (CHO_DON) thay vì nhảy thẳng về Trống!
        const banGiai = await client.query(
            `UPDATE Ban b SET TrangThai = 3
              WHERE b.MaBan IN (SELECT MaBan FROM HoaDon_Ban WHERE MaHoaDon = $1)
                AND NOT EXISTS (SELECT 1 FROM HoaDon_Ban hb2 JOIN HoaDon h2 ON h2.MaHoaDon = hb2.MaHoaDon
                                 WHERE hb2.MaBan = b.MaBan AND h2.TrangThaiTT = 0 AND h2.MaHoaDon <> $1)
              RETURNING b.MaBan`,
            [maHoaDon]
        );
        banDaTrong = banGiai.rows.map((r) => r.maban);
        // [PHÂN HỆ 8 - Anti-Spam Lớp 2] Tự động xoay mã QrToken bàn sau khi thanh toán để vô hiệu hóa QR của khách cũ
        if (banDaTrong.length > 0) {
            await xoayQrTokenChoCacBan(client, banDaTrong);
        }
    }

    const coCkThuCong = dongGhi.some((d) => d.phuongThucTT === 'CHUYEN_KHOAN' && d.nguonXacNhan === 'POS_MANUAL');
    if (dongGhi.length > 1 || !daHoanTat || coCkThuCong || tienChuyenThua > 0 || chiaTienRow) {
        await ghiAuditLog(client, {
            tenantId: hdTenantId,
            maNV: maNV || 'WEBHOOK',
            vaiTro,
            hanhDong: coCkThuCong
                ? 'MANUAL_TRANSFER_CONFIRMED'
                : daHoanTat
                ? 'SPLIT_PAYMENT_SETTLED'
                : 'PARTIAL_PAYMENT_RECORDED',
            doiTuong: 'HOADON',
            maDoiTuong: maHoaDon,
            giaTriMoi: {
                daHoanTat,
                tongTien,
                tongSauThu,
                tienChuyenThua,
                chiaTienId: chiaTienRow ? Number(chiaTienRow.id) : null,
                cacKhoanTT: dongGhi.map((d) => ({ phuongThucTT: d.phuongThucTT, soTien: d.soTien, tienChuyenThua: d.tienChuyenThua || 0, nguon: d.nguonXacNhan })),
            },
            ip,
            batBuoc: true,
        });
    }

    return {
        tenantId: hdTenantId,
        maCaThuNgan: ca ? ca.macathungan : null,
        daHoanTat,
        tongTien,
        tongThuLanNay,
        tongSauThu,
        conLai: daHoanTat ? 0 : Math.max(0, Math.round((tongTien - tongSauThu) * 100) / 100),
        tienThua: tongTienThua > 0 ? tongTienThua : null,
        tienChuyenThua,
        diemCong,
        banDaTrong,
        hoaDon: await layHoaDonChiTiet(client, maHoaDon),
    };
}

// [v4 - Phân hệ 1 100/100] Thanh toán: 1 phương thức + Hỗn hợp + Thu 1 phần + Thanh toán theo Chia tiền (chiaTienId) + Optimistic Locking (expectedVersion)
app.post('/api/order/thanhtoan', kiemTraToken, choPhepVaiTro(1, 4), kiemTraHanSuDung, async (req, res) => {
    const {
        maHoaDon,
        phuongThucTT = 'TIEN_MAT',
        maKH = null,
        maKhuyenMai = null,
        diemSuDung = 0,
        tuDongHappyHour = true,
        tienKhachDua,
        thanhToan,
        payments,
        choPhepThuMotPhan = false,
        chiaTienId = null,
        expectedVersion = null,
        branchId = null,
        terminalId = null,
    } = req.body || {};

    if (!maHoaDon) return res.status(400).json({ message: 'Thiếu mã hóa đơn (maHoaDon)!' });

    const khoaIdem = docKhoaIdempotency(req);
    if (khoaIdem === false) return res.status(400).json({ message: 'Header Idempotency-Key không hợp lệ!' });

    const tenantId = layTenantId(req);
    try {
        const ketQua = await chayGiaoDich(async (client) => {
            if (khoaIdem && paymentsSanSang) {
                const daCo = await client.query(
                    `SELECT MaHoaDon FROM Order_Payments WHERE COALESCE(TenantId, 'DEFAULT') = $1 AND KhoaIdem = $2 LIMIT 1`,
                    [tenantId, khoaIdem]
                );
                if (daCo.rows.length > 0) {
                    const hd = await layHoaDonChiTiet(client, daCo.rows[0].mahoadon);
                    return {
                        trungLap: true,
                        daHoanTat: hd?.trangThaiTT === 1,
                        hoaDon: hd,
                        tienThua: null,
                        diemCong: 0,
                        banDaTrong: [],
                    };
                }
            }

            const laOfflineSync = req.get('X-Offline-Sync') === '1';
            const caInfo = await layCaChoGiaoDichOffline(client, {
                tenantId,
                maCaGoc: req.body?.maCaThuNganGoc || null,
                laOfflineSync,
                branchId: branchId || req.user.branchId || null,
                terminalId: terminalId || null,
            });
            const ca = caInfo.ca;

            const splitArr = Array.isArray(payments) && payments.length > 0 ? payments : thanhToan;
            const reqManagerPin = req.body?.managerPin || null;
            const reqMaNVDuyet = req.body?.maNVDuyet || null;
            const reqNguonXacNhan = req.body?.nguonXacNhan || null;
            const reqIdChungTu = req.body?.idChungTu ? String(req.body.idChungTu).trim().slice(0, 64) : null;
            let cacKhoanTT = null;
            let autoFillSingleMethod = null;
            let hasVoucherTender = false;
            if (Array.isArray(splitArr) && splitArr.length > 0) {
                cacKhoanTT = splitArr.map((t) => {
                    if (t.phuongThucTT === 'VOUCHER') hasVoucherTender = true;
                    return {
                        phuongThucTT: t.phuongThucTT,
                        soTien: t.soTien,
                        tienKhachDua: t.tienKhachDua,
                        maChuanChiEDC: t.maChuanChiEDC || null,
                        bonSoCuoiThe: t.bonSoCuoiThe || null,
                        noiDungCK: t.noiDungCK || (t.idChungTu || reqIdChungTu ? `RECEIPT:${t.idChungTu || reqIdChungTu}` : null),
                        nguonXacNhan: laOfflineSync
                            ? 'POS_OFFLINE_SYNC'
                            : t.nguonXacNhan || (t.phuongThucTT === 'CHUYEN_KHOAN' && (t.idChungTu || reqIdChungTu) ? 'POS_MANUAL_PROVISIONAL' : 'POS_MANUAL'),
                    };
                });
            } else {
                if (!PHUONG_THUC_TT.includes(phuongThucTT)) {
                    throw new LoiNghiepVu(400, `phuongThucTT phải là một trong: ${PHUONG_THUC_TT.join(', ')}`);
                }
                if (phuongThucTT === 'VOUCHER') hasVoucherTender = true;
                autoFillSingleMethod = {
                    phuongThucTT,
                    tienKhachDua,
                    ...(reqNguonXacNhan ? { nguonXacNhan: reqNguonXacNhan } : {}),
                    ...(reqIdChungTu ? { noiDungCK: `RECEIPT:${reqIdChungTu}` } : {}),
                };
            }

            let voucherApprovedByManager = Number(req.user.vaiTro) === 1;
            if (hasVoucherTender && !voucherApprovedByManager && reqManagerPin) {
                const mgr = await xacThucPinQuanLy(client, tenantId, reqManagerPin, req.ip, reqMaNVDuyet);
                if (!mgr) {
                    throw new LoiNghiepVu(403, 'Mã PIN Quản lý duyệt VOUCHER không đúng!', {
                        code: 'VOUCHER_PIN_INVALID',
                        maLoi: 'CAN_PIN_QUAN_LY',
                    });
                }
                voucherApprovedByManager = true;
            }

            const resTT = await ghiNhanThanhToanTrongGiaoDich(client, {
                maHoaDon,
                expectedTenantId: tenantId,
                expectedVersion,
                chiaTienId,
                ca,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                voucherApprovedByManager,
                maKH,
                maKhuyenMai,
                diemSuDung,
                tuDongHappyHour: Boolean(tuDongHappyHour),
                autoFillSingleMethod,
                cacKhoanTT,
                choPhepThuMotPhan: Boolean(choPhepThuMotPhan),
                khoaIdem,
                laOfflineLechCa: caInfo.lechCaDongBo,
                maCaThuNganGoc: caInfo.maCaGoc,
                branchId: branchId || ca.branchid,
                terminalId: terminalId || ca.terminalid,
                ip: req.ip,
            });

            if (laOfflineSync) {
                const offlineClientId = req.body?.offlineClientId ? String(req.body.offlineClientId).trim().slice(0, 64) : null;
                if (offlineClientId) {
                    await client.query('SAVEPOINT sp_pay_off_id');
                    try {
                        await client.query(
                            `UPDATE HoaDon SET MaOfflineClient = COALESCE(MaOfflineClient, $2) WHERE MaHoaDon = $1`,
                            [maHoaDon, offlineClientId]
                        );
                        await client.query('RELEASE SAVEPOINT sp_pay_off_id');
                    } catch {
                        await client.query('ROLLBACK TO SAVEPOINT sp_pay_off_id').catch(() => {});
                    }
                }
                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'OFFLINE_PAYMENT_SYNCED',
                    doiTuong: 'HOADON',
                    maDoiTuong: maHoaDon,
                    giaTriMoi: {
                        khoaIdem,
                        offlineClientId,
                        offlineCreatedAt: req.body?.offlineCreatedAt || null,
                        maCaThuNganGoc: caInfo.maCaGoc,
                        maCaHachToan: ca.macathungan,
                        lechCaDongBo: caInfo.lechCaDongBo,
                        caGocDaDong: caInfo.caGocDaDong,
                        ghiChuLechCa: caInfo.ghiChuLechCa,
                        phuongThucTT,
                    },
                    lyDo: `Đồng bộ thanh toán bàn Offline${offlineClientId ? ` ${offlineClientId}` : ''}${caInfo.ghiChuLechCa ? ` (${caInfo.ghiChuLechCa})` : ''}`,
                    ip: req.ip,
                });
            }

            return { trungLap: false, ...resTT, canhBaoLechCa: caInfo.ghiChuLechCa };
        }, tenantId);

        if (!ketQua.trungLap) {
            const tId = layTenantId(req);
            for (const maBan of ketQua.banDaTrong) {
                io.to(roomTen(tId, 'thungan')).to(roomTen(tId, 'phucvu')).emit('BAN_THAY_DOI', { maBan, trangThai: 3 });
            }
            if (ketQua.daHoanTat) {
                io.to(roomTen(tId, 'thungan')).emit('HOADON_DA_TT', { maHoaDon });
                void kiemTraCanhBaoTanSuatGianLan(pool, {
                    tenantId: tId,
                    maCaThuNgan: ketQua.maCaThuNgan || null,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    maKH: maKH || ketQua.hoaDon?.khachHang?.maKH || null,
                    phuongThucTT: ketQua.hoaDon?.phuongThucTT || phuongThucTT,
                    coGiamGia: Number(ketQua.hoaDon?.tongGiamGia || 0) > 0,
                    maHoaDon,
                    ghiAuditLog,
                    ip: req.ip,
                });
            }
            // [Phân hệ 3 - Trụ cột 4] Kiểm tra Cảnh báo Đầy Két Tiền Mặt (Cash Drawer Threshold Alert)
            if (ketQua.maCaThuNgan) {
                pool.withTenant(tId, async (cCheck) => {
                    const [pol, dsNow] = await Promise.all([
                        getTenantShiftPolicy(cCheck, tId),
                        tinhDoiSoatCa(cCheck, ketQua.maCaThuNgan),
                    ]);
                    if (pol.hanMucKetTienMat > 0 && dsNow.tienMatLyThuyet >= pol.hanMucKetTienMat) {
                        // [Wave 1 — P0-07] Bịt rò rỉ Blind Drop: TUYỆT ĐỐI không gửi tienMatLyThuyet/tienMatHienTai trong payload & message!
                        io.to(roomTen(tId, 'thungan')).emit('shift:drawer_limit_warning', {
                            maCaThuNgan: ketQua.maCaThuNgan,
                            hanMucKetTienMat: pol.hanMucKetTienMat,
                            thresholdExceeded: true,
                            message: `🏦 Két tiền mặt đã vượt ngưỡng an toàn (${pol.hanMucKetTienMat.toLocaleString('vi-VN')}đ) — vui lòng thực hiện Rút két (Safe Drop) ngay!`,
                        });
                    }
                }).catch(() => {});
            }
        }

        res.json({
            message: ketQua.daHoanTat
                ? 'Thanh toán hoàn tất!'
                : `Đã ghi nhận thu trước ${ketQua.tongThuLanNay.toLocaleString('vi-VN')}đ (còn lại ${ketQua.conLai.toLocaleString('vi-VN')}đ)!`,
            daHoanTat: ketQua.daHoanTat,
            conLai: ketQua.conLai ?? 0,
            hoaDon: ketQua.hoaDon,
            tienThua: ketQua.tienThua,
            diemCong: ketQua.diemCong,
            trungLap: ketQua.trungLap,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Thanh toán:');
    }
});

// ==========================================
// WEBHOOK VIETQR TỰ ĐỘNG (SEPAY & PAYOS) — XÁC NHẬN KHÔNG CẦN BẤM TAY
// ==========================================
function soSanhHangThoiGian(a, b) {
    const ba = Buffer.from(String(a || ''), 'utf8');
    const bb = Buffer.from(String(b || ''), 'utf8');
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

// Xác thực SePay: Header "Authorization: Apikey <SEPAY_API_KEY>" (ưu tiên khóa riêng của từng Tenant, fallback khóa hệ thống)
function xacThucSePay(req, expectedKeyOverride = null) {
    const expected = expectedKeyOverride || process.env.SEPAY_API_KEY;
    if (!expected) return { ok: false, status: 503, message: 'Chưa cấu hình SEPAY_API_KEY cho quán hoặc trên máy chủ!' };
    const auth = String(req.headers['authorization'] || '').trim();
    const match = auth.match(/^(?:Apikey|Bearer)\s+(.+)$/i);
    if (!match || !soSanhHangThoiGian(match[1].trim(), expected)) {
        return { ok: false, status: 401, message: 'SePay API Key không hợp lệ!' };
    }
    return { ok: true };
}

// Xác thực PayOS: HMAC-SHA256 của các trường data sắp xếp alphabet (ưu tiên khóa riêng của từng Tenant, fallback khóa hệ thống)
function xacThucPayOS(body, checksumKeyOverride = null) {
    const checksumKey = checksumKeyOverride || process.env.PAYOS_CHECKSUM_KEY;
    if (!checksumKey) return { ok: false, status: 503, message: 'Chưa cấu hình PAYOS_CHECKSUM_KEY cho quán hoặc trên máy chủ!' };
    if (!body || typeof body.data !== 'object' || !body.data || typeof body.signature !== 'string') {
        return { ok: false, status: 400, message: 'Thiếu data hoặc signature PayOS!' };
    }
    const sortedKeys = Object.keys(body.data).sort();
    const queryStr = sortedKeys
        .map((k) => {
            let v = body.data[k];
            if (v === null || v === undefined || v === 'null' || v === 'undefined') v = '';
            else if (typeof v === 'object') v = JSON.stringify(v);
            return `${k}=${v}`;
        })
        .join('&');
    const computed = crypto.createHmac('sha256', checksumKey).update(queryStr).digest('hex');
    if (!soSanhHangThoiGian(computed.toLowerCase(), body.signature.toLowerCase())) {
        return { ok: false, status: 401, message: 'Chữ ký HMAC-SHA256 PayOS không hợp lệ!' };
    }
    return { ok: true };
}

// Khớp hóa đơn đang mở (TrangThaiTT = 0) từ nội dung chuyển khoản (VD: "POSHD1024", "POS HD-1024", "HD1024"), có lọc cứng theo expectedTenantId
async function timHoaDonMoTuNoiDungCK(client, noiDungCK, fallbackOrderCode = null, expectedTenantId = null) {
    const raw = String(noiDungCK || '').toUpperCase();
    const candidates = new Set();

    const regexes = [
        /POS[\s\-_]*HD[\s\-_]*([A-Z0-9](?:[A-Z0-9\-]{0,35}[A-Z0-9])?)/g,
        /\bHD[\s\-_]*([A-Z0-9](?:[A-Z0-9\-]{0,35}[A-Z0-9])?)\b/g,
    ];
    for (const rx of regexes) {
        let m;
        while ((m = rx.exec(raw)) !== null) {
            if (m[1]) {
                candidates.add(m[1]);
                candidates.add(`HD${m[1]}`);
                const firstSeg = m[1].split('-')[0];
                if (firstSeg && firstSeg !== m[1]) {
                    candidates.add(firstSeg);
                    candidates.add(`HD${firstSeg}`);
                }
            }
        }
    }
    if (fallbackOrderCode !== null && fallbackOrderCode !== undefined && String(fallbackOrderCode).trim()) {
        candidates.add(String(fallbackOrderCode).trim().toUpperCase());
    }

    if (candidates.size === 0) return null;
    const normalizedList = [...candidates].map((c) => c.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
    if (normalizedList.length === 0) return null;

    if (expectedTenantId) {
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [String(expectedTenantId)]);
    }

    let r;
    try {
        await client.query('SAVEPOINT sp_lookup_inv');
        if (expectedTenantId) {
            r = await client.query(
                'SELECT MaHoaDon, TenantId FROM public.fn_lookup_open_invoice_by_codes($1::text[], $2::text)',
                [normalizedList, String(expectedTenantId)]
            );
        } else {
            // [P0 FIX Phân hệ 7] Truyền tường minh $2 = NULL::text để tuyệt đối không mơ hồ overload PostgreSQL
            r = await client.query(
                'SELECT MaHoaDon, TenantId FROM public.fn_lookup_open_invoice_by_codes($1::text[], NULL::text)',
                [normalizedList]
            );
        }
        await client.query('RELEASE SAVEPOINT sp_lookup_inv');
        if (r.rows.length && r.rows[0].tenantid) {
            await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [String(r.rows[0].tenantid)]);
        }
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_lookup_inv').catch(() => {});
        r = await client.query(
            `SELECT MaHoaDon
               FROM HoaDon
              WHERE TrangThaiTT = 0
                AND ($2::text IS NULL OR COALESCE(TenantId, 'DEFAULT') = $2)
                AND (
                    UPPER(MaHoaDon::text) = ANY($1::text[])
                    OR REGEXP_REPLACE(UPPER(MaHoaDon::text), '[^A-Z0-9]', '', 'g') = ANY($1::text[])
                )
              ORDER BY ThoiGianTao DESC
              LIMIT 1`,
            [normalizedList, expectedTenantId ? String(expectedTenantId) : null]
        );
    }
    return r.rows.length ? r.rows[0].mahoadon : null;
}

// Khớp hóa đơn bất kỳ (TrangThaiTT IN (0, 1)) từ nội dung CK để phân biệt chính xác ca Chuyển trùng (ALREADY_PAID) vs Chưa khớp (UNMATCHED)
async function timHoaDonBatKyTuNoiDungCK(client, noiDungCK, fallbackOrderCode = null, expectedTenantId = null) {
    const raw = String(noiDungCK || '').toUpperCase();
    const candidates = new Set();

    const regexes = [
        /(?:POS|TT)[\s\-_]*HD[\s\-_]*([A-Z0-9](?:[A-Z0-9\-]{0,35}[A-Z0-9])?)/g,
        /\bTT([A-Z0-9]{2,36})\b/g,
        /\bHD[\s\-_]*([A-Z0-9](?:[A-Z0-9\-]{0,35}[A-Z0-9])?)\b/g,
    ];
    for (const rx of regexes) {
        let m;
        while ((m = rx.exec(raw)) !== null) {
            if (m[1]) {
                candidates.add(m[1]);
                candidates.add(`HD${m[1]}`);
                const firstSeg = m[1].split('-')[0];
                if (firstSeg && firstSeg !== m[1]) {
                    candidates.add(firstSeg);
                    candidates.add(`HD${firstSeg}`);
                }
            }
        }
    }
    if (fallbackOrderCode !== null && fallbackOrderCode !== undefined && String(fallbackOrderCode).trim()) {
        candidates.add(String(fallbackOrderCode).trim().toUpperCase());
    }

    if (candidates.size === 0) return null;
    const normalizedList = [...candidates].map((c) => c.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
    if (normalizedList.length === 0) return null;

    if (expectedTenantId) {
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [String(expectedTenantId)]);
    }

    let r;
    try {
        await client.query('SAVEPOINT sp_lookup_any_inv');
        r = await client.query(
            'SELECT MaHoaDon, TenantId, TrangThaiTT, BranchId FROM public.fn_lookup_any_invoice_by_codes($1::text[], $2::text)',
            [normalizedList, expectedTenantId ? String(expectedTenantId) : null]
        );
        await client.query('RELEASE SAVEPOINT sp_lookup_any_inv');
        if (r.rows.length && r.rows[0].tenantid) {
            await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [String(r.rows[0].tenantid)]);
        }
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_lookup_any_inv').catch(() => {});
        const maHD = await timHoaDonMoTuNoiDungCK(client, noiDungCK, fallbackOrderCode, expectedTenantId);
        return maHD ? { maHoaDon: maHD, tenantId: expectedTenantId || 'DEFAULT', trangThaiTT: 0, branchId: null } : null;
    }
    if (!r.rows.length) return null;
    return {
        maHoaDon: r.rows[0].mahoadon,
        tenantId: r.rows[0].tenantid || expectedTenantId || 'DEFAULT',
        trangThaiTT: Number(r.rows[0].trangthaitt || 0),
        branchId: r.rows[0].branchid || null,
    };
}

// Bộ xử lý lõi biến động số dư VietQR (Phân hệ 3: Multi-Tenant STK + Đủ 5 ca biên Exact/Partial/Overpay/DoublePay/Unmatched)
async function xuLyBienDongSoDuVietQR({
    nhaCungCap,
    maGiaoDichNgoai,
    soTien,
    noiDungCK,
    soTaiKhoanNhan = null,
    fallbackOrderCode = null,
    expectedTenantId = null,
    expectedAccountNo = null,
    payloadGoc = null,
    maNV = 'VIETQR_BOT',
    ip = null,
}) {
    const extId = String(maGiaoDichNgoai || '').trim().slice(0, 128);
    const amount = Math.round(Number(soTien) * 100) / 100;
    const accNoKey = String(soTaiKhoanNhan || expectedAccountNo || expectedTenantId || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 64);
    if (!extId || !(amount > 0)) {
        throw new LoiNghiepVu(400, 'Thiếu mã giao dịch ngoài hoặc số tiền chuyển khoản không hợp lệ!');
    }

    const capNhatWebhookLog = async (
        client,
        eventId,
        trangThai,
        maHdKhop = null,
        tId = null,
        { soTienConLai = null, trangThaiXuLyDu = null } = {}
    ) => {
        if (!vietQrLogSanSang || !eventId) return;
        await client.query('SAVEPOINT sp_upd_wh_evt');
        try {
            await client.query(
                `SELECT public.fn_update_webhook_event_v2($1::bigint, $2::varchar, $3::text, $4::varchar, $5::numeric, $6::varchar)`,
                [
                    Number(eventId),
                    trangThai,
                    maHdKhop ? String(maHdKhop) : null,
                    tId ? String(tId) : null,
                    soTienConLai !== null ? Number(soTienConLai) : null,
                    trangThaiXuLyDu || null,
                ]
            );
            await client.query('RELEASE SAVEPOINT sp_upd_wh_evt');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_upd_wh_evt').catch(() => {});
            await client.query(
                `UPDATE VietQR_Webhook_Events
                    SET TrangThaiXuLy = $2,
                        MaHoaDonKhop = COALESCE($3, MaHoaDonKhop),
                        TenantId = COALESCE($4, TenantId),
                        SoTienConLai = COALESCE($5, SoTienConLai),
                        TrangThaiXuLyDu = COALESCE($6, TrangThaiXuLyDu)
                  WHERE Id = $1`,
                [
                    Number(eventId),
                    trangThai,
                    maHdKhop ? String(maHdKhop) : null,
                    tId ? String(tId) : null,
                    soTienConLai !== null ? Number(soTienConLai) : null,
                    trangThaiXuLyDu || null,
                ]
            ).catch(() => {});
        }
    };

    const ketQua = await chayGiaoDich(async (client) => {
        let webhookEventId = null;
        if (vietQrLogSanSang) {
            await client.query('SAVEPOINT sp_ins_wh_evt');
            try {
                // [Phân hệ 3 FIX] Chống trùng theo (NhaCungCap, SoTaiKhoanNhan, MaGiaoDichNgoai) — không bao giờ nuốt tiền quán khác!
                const fnIns = await client.query(
                    `SELECT public.fn_record_webhook_event_v2($1::varchar, $2::varchar, $3::varchar, $4::numeric, $5::text, $6::jsonb, $7::varchar, NULL::varchar) AS event_id`,
                    [
                        nhaCungCap,
                        accNoKey,
                        extId,
                        amount,
                        noiDungCK || '',
                        JSON.stringify(payloadGoc || {}),
                        expectedTenantId || 'SYSTEM_UNMATCHED',
                    ]
                );
                await client.query('RELEASE SAVEPOINT sp_ins_wh_evt');
                webhookEventId = fnIns.rows[0]?.event_id ? Number(fnIns.rows[0].event_id) : null;
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_ins_wh_evt').catch(() => {});
                const ins = await client.query(
                    `INSERT INTO VietQR_Webhook_Events
                        (NhaCungCap, SoTaiKhoanNhan, MaGiaoDichNgoai, SoTien, NoiDungCK, TrangThaiXuLy, PayloadGoc, TenantId)
                     VALUES ($1, $2, $3, $4, $5, 'PROCESSING', $6::jsonb, $7)
                     ON CONFLICT (nhacungcap, sotaikhoannhan, magiaodichngoai) DO NOTHING
                     RETURNING Id`,
                    [nhaCungCap, accNoKey, extId, amount, noiDungCK || '', JSON.stringify(payloadGoc || {}), expectedTenantId || 'SYSTEM_UNMATCHED']
                );
                webhookEventId = ins.rows[0]?.id ? Number(ins.rows[0].id) : null;
            }
            if (!webhookEventId) {
                return { duplicate: true, trangThaiXuLy: 'DUPLICATE_IGNORED' };
            }
        }

        // Kiểm tra khớp STK thụ hưởng nếu có cấu hình riêng cho quán
        if (expectedTenantId && expectedAccountNo && soTaiKhoanNhan) {
            const expAccClean = String(expectedAccountNo).replace(/[^0-9A-Za-z]/g, '');
            const incAccClean = String(soTaiKhoanNhan).replace(/[^0-9A-Za-z]/g, '');
            if (expAccClean && incAccClean && expAccClean !== incAccClean) {
                await capNhatWebhookLog(client, webhookEventId, 'ACCOUNT_MISMATCH', null, expectedTenantId);
                return {
                    duplicate: false,
                    matched: false,
                    webhookEventId,
                    trangThaiXuLy: 'ACCOUNT_MISMATCH',
                    message: 'Số tài khoản nhận tiền không khớp với cấu hình VietQR của quán!',
                };
            }
        }

        // Kiểm tra thanh toán nâng cấp gói SaaS (SUB...) nếu gọi qua webhook toàn cục
        if (!expectedTenantId) {
            const subPay = await xuLyThanhToanGoiTuWebhook(client, {
                noiDungCK,
                soTien: amount,
                maGiaoDichNgoai: extId,
                nhaCungCap,
                ghiAuditLog,
                ip,
            });
            if (subPay?.matched) {
                const st = subPay.activated ? 'SUBSCRIPTION_PAID' : subPay.insufficient ? 'SUBSCRIPTION_PARTIAL' : 'SUBSCRIPTION_DUP';
                await capNhatWebhookLog(client, webhookEventId, st, subPay.maDon, subPay.tenantId || 'DEFAULT');
                if (subPay.activated && subPay.tenantId) xoaCacheEntitlement(subPay.tenantId);
                return { duplicate: false, matched: true, webhookEventId, isSubscription: true, trangThaiXuLy: st, ...subPay };
            }
        }

        // Tra cứu hóa đơn bất kể trạng thái 0 hoặc 1 để bắt trúng ca Chuyển trùng giây thu Tiền mặt!
        const found = await timHoaDonBatKyTuNoiDungCK(client, noiDungCK, fallbackOrderCode, expectedTenantId);
        if (!found) {
            await capNhatWebhookLog(client, webhookEventId, 'UNMATCHED', null, expectedTenantId || 'SYSTEM_UNMATCHED', {
                soTienConLai: amount,
                trangThaiXuLyDu: 'NONE',
            });
            return {
                duplicate: false,
                matched: false,
                webhookEventId,
                tenantId: expectedTenantId || null,
                trangThaiXuLy: 'UNMATCHED',
                soTienNhan: amount,
                noiDungCK,
            };
        }

        const maHoaDon = found.maHoaDon;
        // [Wave 1 — P0-03] Dùng SECURITY DEFINER fn_resolve_invoice_for_webhook để đọc đúng tenantId & bankAccountNo dưới FORCE RLS
        let resolvedInv = null;
        await client.query('SAVEPOINT sp_resolve_wh_inv');
        try {
            const fnRes = await client.query(
                `SELECT tenant_id, ma_hoa_don, lifecycle_status, trang_thai_tt, tong_tien, da_thanh_toan, bank_account_no, bank_bin
                   FROM public.fn_resolve_invoice_for_webhook($1::varchar)`,
                [String(maHoaDon)]
            );
            await client.query('RELEASE SAVEPOINT sp_resolve_wh_inv');
            resolvedInv = fnRes.rows[0] || null;
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_resolve_wh_inv').catch(() => {});
            const fallbackRes = await client.query(
                `SELECT COALESCE(hd.TenantId, 'DEFAULT') AS tenant_id,
                        hd.MaHoaDon AS ma_hoa_don,
                        COALESCE(to_jsonb(hd)->>'lifecycle_status', 'OPEN') AS lifecycle_status,
                        hd.TrangThaiTT AS trang_thai_tt,
                        COALESCE(t.ThongTinNganHang->>'soTaiKhoan', t.ThongTinNganHang->>'accountNo', '') AS bank_account_no
                   FROM HoaDon hd
                   LEFT JOIN Tenants t ON t.TenantId = COALESCE(hd.TenantId, 'DEFAULT')
                  WHERE hd.MaHoaDon = $1`,
                [maHoaDon]
            );
            resolvedInv = fallbackRes.rows[0] || null;
        }

        const hdTenantId = resolvedInv?.tenant_id || found.tenantId || 'DEFAULT';
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [hdTenantId]);
        const expectedAcc = String(resolvedInv?.bank_account_no || '').replace(/[^0-9A-Za-z]/g, '');
        const incomingAcc = String(soTaiKhoanNhan || '').replace(/[^0-9A-Za-z]/g, '');
        if (expectedAcc && incomingAcc && expectedAcc !== incomingAcc) {
            await capNhatWebhookLog(client, webhookEventId, 'ACCOUNT_MISMATCH', maHoaDon, hdTenantId);
            return {
                duplicate: false,
                matched: false,
                webhookEventId,
                trangThaiXuLy: 'ACCOUNT_MISMATCH',
                message: 'Số tài khoản nhận tiền không khớp với cấu hình VietQR của quán sở hữu hóa đơn!',
            };
        }

        const handlePendingAction = async (trangThaiLog = 'PENDING_ACTION', lyDoCanhBao = null) => {
            await capNhatWebhookLog(client, webhookEventId, trangThaiLog, maHoaDon, hdTenantId, {
                soTienConLai: amount,
                trangThaiXuLyDu: 'PENDING_ACTION',
            });
            await ghiAuditLog(client, {
                tenantId: hdTenantId,
                maNV,
                hanhDong: trangThaiLog === 'ALREADY_PAID' ? 'VIETQR_DOUBLE_PAID_PENDING' : 'VIETQR_SETTLE_PENDING_ACTION',
                doiTuong: 'HOADON',
                maDoiTuong: maHoaDon,
                giaTriMoi: { webhookEventId, nhaCungCap, maGiaoDichNgoai: extId, soTienNhan: amount, trangThaiLog },
                lyDo: lyDoCanhBao || `Webhook VietQR cho HĐ #${maHoaDon} cần Thu ngân kiểm tra & xử lý (PENDING_ACTION)`,
                ip,
                batBuoc: true,
            });
            return {
                duplicate: false,
                matched: true,
                doublePaid: trangThaiLog === 'ALREADY_PAID',
                pendingAction: true,
                webhookEventId,
                tenantId: hdTenantId,
                trangThaiXuLy: trangThaiLog,
                trangThaiXuLyDu: 'PENDING_ACTION',
                nhaCungCap,
                maHoaDon,
                soTienNhan: amount,
                soTienConLai: amount,
                daHoanTat: trangThaiLog === 'ALREADY_PAID',
                lyDoCanhBao,
            };
        };

        // [Wave 1 — P0-03] Nếu hóa đơn đã chốt trước bằng POS_MANUAL_PROVISIONAL và khớp số tiền -> NÂNG CẤP thành WEBHOOK_VERIFIED!
        if (Number(resolvedInv?.trang_thai_tt) === 1 && paymentsSanSang) {
            const provRes = await client.query(
                `SELECT Id, SoTien
                   FROM Order_Payments
                  WHERE MaHoaDon = $1
                    AND COALESCE(TenantId, 'DEFAULT') = $2
                    AND NguonXacNhan = 'POS_MANUAL_PROVISIONAL'
                    AND ABS(COALESCE(SoTien, 0) - $3) <= 1000
                  ORDER BY Id ASC
                  LIMIT 1
                  FOR UPDATE`,
                [String(maHoaDon), hdTenantId, amount]
            );
            if (provRes.rows.length > 0) {
                const provRow = provRes.rows[0];
                await client.query(
                    `UPDATE Order_Payments
                        SET NguonXacNhan = 'WEBHOOK_VERIFIED',
                            MaGiaoDichNgoai = $2
                      WHERE Id = $1`,
                    [provRow.id, extId]
                );
                await capNhatWebhookLog(client, webhookEventId, 'MATCHED_PAID', maHoaDon, hdTenantId, {
                    soTienConLai: 0,
                    trangThaiXuLyDu: 'NONE',
                });
                await ghiAuditLog(client, {
                    tenantId: hdTenantId,
                    maNV,
                    hanhDong: 'VIETQR_PROVISIONAL_VERIFIED',
                    doiTuong: 'HOADON',
                    maDoiTuong: maHoaDon,
                    giaTriMoi: { paymentId: provRow.id, webhookEventId, maGiaoDichNgoai: extId, soTienNhan: amount },
                    lyDo: `Webhook ${nhaCungCap} về trễ đã đối soát nâng cấp dòng POS_MANUAL_PROVISIONAL -> WEBHOOK_VERIFIED`,
                    ip,
                });
                return {
                    duplicate: false,
                    matched: true,
                    upgradedProvisional: true,
                    webhookEventId,
                    tenantId: hdTenantId,
                    trangThaiXuLy: 'MATCHED_PAID',
                    trangThaiXuLyDu: 'NONE',
                    nhaCungCap,
                    maHoaDon,
                    soTienNhan: amount,
                    daHoanTat: true,
                };
            }
            return handlePendingAction('ALREADY_PAID', `Khách chuyển khoản trùng sau khi HĐ #${maHoaDon} đã thu tiền — chờ xử lý hoàn/thối/nạp ví`);
        }

        // Nếu hóa đơn đã VOIDED / MERGED / REFUNDED -> vẫn COMMIT dòng webhook với PENDING_ACTION (tuyệt đối không rollback mất log tiền vào!)
        if (['VOIDED', 'MERGED', 'REFUNDED'].includes(String(resolvedInv?.lifecycle_status || '').toUpperCase())) {
            return handlePendingAction(
                'PENDING_ACTION',
                `Tiền chuyển khoản ${amount.toLocaleString('vi-VN')}đ đổ vào HĐ #${maHoaDon} đang ở trạng thái ${resolvedInv.lifecycle_status}`
            );
        }

        const ca = await layCaDangMo(client, 'SHARE', hdTenantId);

        let ttRes;
        await client.query('SAVEPOINT sp_vietqr_settle');
        try {
            ttRes = await ghiNhanThanhToanTrongGiaoDich(client, {
                maHoaDon,
                expectedTenantId: hdTenantId,
                mandatoryVersion: false,
                ca,
                maNV,
                cacKhoanTT: [
                    {
                        phuongThucTT: 'CHUYEN_KHOAN',
                        soTien: amount,
                        maGiaoDichNgoai: extId,
                        noiDungCK: noiDungCK || '',
                        nguonXacNhan: nhaCungCap,
                    },
                ],
                choPhepThuMotPhan: true,
                ip,
            });
            await client.query('RELEASE SAVEPOINT sp_vietqr_settle');
        } catch (settleErr) {
            await client.query('ROLLBACK TO SAVEPOINT sp_vietqr_settle').catch(() => {});
            // Bắt mọi lỗi nghiệp vụ (400/404/409) & DB để COMMIT dòng vietqr_webhook_events với PENDING_ACTION + cảnh báo đỏ POS!
            const isAlreadyPaid = settleErr instanceof LoiNghiepVu && settleErr.details?.code === 'ALREADY_PAID';
            return handlePendingAction(
                isAlreadyPaid ? 'ALREADY_PAID' : 'PENDING_ACTION',
                settleErr?.message || `Lỗi đối soát tự động HĐ #${maHoaDon}`
            );
        }

        const overpay = Number(ttRes.tienChuyenThua || 0);
        const trangThaiXuLy = ttRes.daHoanTat ? 'MATCHED_PAID' : 'PARTIAL_PAID';
        const trangThaiXuLyDu = overpay > 0 ? 'PENDING_ACTION' : 'NONE';
        await capNhatWebhookLog(client, webhookEventId, trangThaiXuLy, maHoaDon, hdTenantId, {
            soTienConLai: overpay,
            trangThaiXuLyDu,
        });

        await ghiAuditLog(client, {
            tenantId: hdTenantId,
            maNV,
            hanhDong: ttRes.daHoanTat ? 'VIETQR_AUTO_SETTLED' : 'VIETQR_PARTIAL_RECEIVED',
            doiTuong: 'HOADON',
            maDoiTuong: maHoaDon,
            giaTriMoi: {
                webhookEventId,
                nhaCungCap,
                maGiaoDichNgoai: extId,
                soTienNhan: amount,
                tienChuyenThua: overpay,
                tongDaThu: ttRes.tongSauThu,
                conLai: ttRes.conLai,
                daHoanTat: ttRes.daHoanTat,
            },
            lyDo: noiDungCK || `Tự động đối soát ${nhaCungCap}`,
            ip,
        });

        return {
            duplicate: false,
            matched: true,
            webhookEventId,
            tenantId: hdTenantId,
            trangThaiXuLy,
            trangThaiXuLyDu,
            nhaCungCap,
            maHoaDon,
            soTienNhan: amount,
            ...ttRes,
        };
    });

    if (!ketQua.duplicate && !ketQua.isSubscription) {
        const tId = ketQua.tenantId || ketQua.hoaDon?.tenantId || expectedTenantId || 'DEFAULT';
        if (ketQua.doublePaid || ketQua.pendingAction) {
            io.to(roomTen(tId, 'thungan')).emit('payment:vietqr_double_paid', {
                webhookEventId: ketQua.webhookEventId,
                maHoaDon: ketQua.maHoaDon,
                soTienNhan: ketQua.soTienNhan,
                trangThaiXuLy: ketQua.trangThaiXuLy,
                trangThaiXuLyDu: 'PENDING_ACTION',
                message:
                    ketQua.lyDoCanhBao ||
                    `⚠️ Tiền chuyển khoản ${ketQua.soTienNhan.toLocaleString('vi-VN')}đ cho HĐ #${ketQua.maHoaDon} cần Thu ngân xử lý ngay!`,
            });
        } else if (ketQua.trangThaiXuLy === 'UNMATCHED' && tId && tId !== 'SYSTEM_UNMATCHED') {
            io.to(roomTen(tId, 'thungan')).emit('payment:vietqr_unmatched', {
                webhookEventId: ketQua.webhookEventId,
                soTienNhan: ketQua.soTienNhan,
                noiDungCK: ketQua.noiDungCK,
            });
        } else if (ketQua.matched) {
            for (const maBan of ketQua.banDaTrong || []) {
                io.to(roomTen(tId, 'thungan')).to(roomTen(tId, 'phucvu')).emit('BAN_THAY_DOI', { maBan, trangThai: 3 });
            }
            if (ketQua.daHoanTat) {
                io.to(roomTen(tId, 'thungan')).emit('HOADON_DA_TT', { maHoaDon: ketQua.maHoaDon });
            }
            const payloadEmit = {
                webhookEventId: ketQua.webhookEventId,
                nhaCungCap: ketQua.nhaCungCap,
                maHoaDon: ketQua.maHoaDon,
                tenBan: ketQua.hoaDon?.ban?.map((b) => b.tenBan).join(', ') || 'Mang đi',
                soTienNhan: ketQua.soTienNhan,
                tienChuyenThua: ketQua.tienChuyenThua || 0,
                trangThaiXuLyDu: ketQua.trangThaiXuLyDu || 'NONE',
                chuaGanCa: !ketQua.maCaThuNgan,
                tongDaThu: ketQua.tongSauThu,
                conLai: ketQua.conLai,
                daHoanTat: ketQua.daHoanTat,
                diemCong: ketQua.diemCong,
                hoaDon: ketQua.hoaDon,
            };
            io.to(roomTen(tId, 'thungan')).to(roomTen(tId, 'phucvu')).emit('VIETQR_DA_NHAN', payloadEmit);
            if (ketQua.tienChuyenThua > 0) {
                io.to(roomTen(tId, 'thungan')).emit('payment:vietqr_overpaid', payloadEmit);
            } else if (ketQua.daHoanTat) {
                io.to(roomTen(tId, 'thungan')).emit('payment:vietqr_settled', payloadEmit);
            } else {
                io.to(roomTen(tId, 'thungan')).emit('payment:vietqr_partial', payloadEmit);
            }
        }
    }

    return ketQua;
}

// Endpoint Webhook SePay (hỗ trợ cả /api/webhooks/sepay/:tenantSlug theo từng quán & /api/webhooks/sepay toàn cục)
app.post(['/api/webhooks/sepay', '/api/webhooks/sepay/:tenantSlug'], async (req, res) => {
    let tenantCfg = null;
    if (req.params.tenantSlug) {
        tenantCfg = await timTenantWebhookConfig(pool, req.params.tenantSlug);
        if (!tenantCfg) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy quán tương ứng với đường dẫn Webhook này!' });
        }
    }

    const auth = xacThucSePay(req, tenantCfg?.sepayApiKey || null);
    if (!auth.ok) return res.status(auth.status).json({ success: false, message: auth.message });

    const body = req.body || {};
    if (body.transferType && body.transferType !== 'in') {
        return res.status(200).json({ success: true, ignored: true, reason: 'OUTGOING_TRANSFER' });
    }

    const maGD = body.id ? `SEPAY_${body.id}` : body.referenceCode ? `SEPAY_${body.referenceCode}` : null;
    try {
        const result = await xuLyBienDongSoDuVietQR({
            nhaCungCap: 'SEPAY_WEBHOOK',
            maGiaoDichNgoai: maGD,
            soTien: body.transferAmount,
            noiDungCK: body.content || body.description || '',
            soTaiKhoanNhan: body.accountNumber || body.subAccount || null,
            fallbackOrderCode: body.code || null,
            expectedTenantId: tenantCfg?.tenantId || null,
            expectedAccountNo: tenantCfg?.accountNo || null,
            payloadGoc: body,
            ip: req.ip,
        });
        res.status(200).json({ success: true, ...result });
    } catch (error) {
        guiLoi(res, error, 'Lỗi Webhook SePay:');
    }
});

// Endpoint Webhook PayOS (hỗ trợ cả /api/webhooks/payos/:tenantSlug theo từng quán & /api/webhooks/payos toàn cục)
app.post(['/api/webhooks/payos', '/api/webhooks/payos/:tenantSlug'], async (req, res) => {
    const body = req.body || {};
    if (body.code === '00' && body.data && body.data.orderCode === 123 && body.data.description === 'VQRIO123') {
        return res.status(200).json({ success: true, message: 'PayOS webhook verified' });
    }

    let tenantCfg = null;
    if (req.params.tenantSlug) {
        tenantCfg = await timTenantWebhookConfig(pool, req.params.tenantSlug);
        if (!tenantCfg) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy quán tương ứng với đường dẫn Webhook này!' });
        }
    }

    const auth = xacThucPayOS(body, tenantCfg?.payosChecksumKey || null);
    if (!auth.ok) return res.status(auth.status).json({ success: false, message: auth.message });
    if (body.code !== '00' || body.success === false) {
        return res.status(200).json({ success: true, ignored: true });
    }

    const data = body.data || {};
    const maGD = `PAYOS_${data.reference || data.paymentLinkId || data.orderCode}_${data.amount}`;
    try {
        const result = await xuLyBienDongSoDuVietQR({
            nhaCungCap: 'PAYOS_WEBHOOK',
            maGiaoDichNgoai: maGD,
            soTien: data.amount,
            noiDungCK: data.description || '',
            soTaiKhoanNhan: data.accountNumber || null,
            fallbackOrderCode: data.orderCode || null,
            expectedTenantId: tenantCfg?.tenantId || null,
            expectedAccountNo: tenantCfg?.accountNo || null,
            payloadGoc: body,
            ip: req.ip,
        });
        res.status(200).json({ success: true, ...result });
    } catch (error) {
        guiLoi(res, error, 'Lỗi Webhook PayOS:');
    }
});

// [Demo/QA] Giả lập nhận biến động số dư VietQR — CHỈ QUẢN LÝ (cô lập TenantId)
app.post('/api/webhooks/vietqr/test-simulate', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('vietqr_webhook'), async (req, res) => {
    const { maHoaDon, soTien, nhaCungCap = 'SEPAY_WEBHOOK' } = req.body || {};
    const tenantId = layTenantId(req);
    if (!maHoaDon) return res.status(400).json({ message: 'Vui lòng cung cấp maHoaDon!' });

    try {
        const hd = await pool.withTenant(tenantId, async (client) => {
            const own = await client.query(
                "SELECT 1 FROM HoaDon WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
                [maHoaDon, tenantId]
            );
            if (own.rows.length === 0) return null;
            return layHoaDonChiTiet(client, maHoaDon);
        });
        if (!hd) return res.status(404).json({ message: 'Không tìm thấy hóa đơn!' });
        const amount = soTien !== undefined && Number(soTien) > 0 ? Number(soTien) : hd.conLaiCanThu;
        if (!(amount > 0)) return res.status(409).json({ message: 'Hóa đơn này đã thu đủ tiền!' });

        const result = await xuLyBienDongSoDuVietQR({
            nhaCungCap: ['SEPAY_WEBHOOK', 'PAYOS_WEBHOOK'].includes(nhaCungCap) ? nhaCungCap : 'WEBHOOK_SIMULATOR',
            maGiaoDichNgoai: `SIM_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
            soTien: amount,
            noiDungCK: `POSHD${maHoaDon}`,
            fallbackOrderCode: maHoaDon,
            payloadGoc: { simulatedBy: req.user.maNV, maHoaDon, amount },
            maNV: req.user.maNV,
            ip: req.ip,
        });
        res.json({
            message: result.daHoanTat
                ? `Đã giả lập nhận CK ${amount.toLocaleString('vi-VN')}đ & tự động chốt HĐ #${maHoaDon}!`
                : `Đã giả lập nhận CK 1 phần ${amount.toLocaleString('vi-VN')}đ (còn thiếu ${result.conLai.toLocaleString('vi-VN')}đ)!`,
            ...result,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi Giả lập Webhook VietQR:');
    }
});

// Danh sách log biến động số dư VietQR cho Quản lý đối soát (cô lập theo TenantId)
app.get('/api/webhooks/vietqr/logs', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('vietqr_webhook'), async (req, res) => {
    if (!vietQrLogSanSang) return res.json([]);
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    const tenantId = layTenantId(req);
    try {
        const r = await qTenant(
            req,
            `SELECT Id, NhaCungCap, MaGiaoDichNgoai, SoTien, NoiDungCK, MaHoaDonKhop, TrangThaiXuLy, ThoiGianNhan
               FROM VietQR_Webhook_Events
              WHERE COALESCE(TenantId, 'DEFAULT') = $2
              ORDER BY ThoiGianNhan DESC
              LIMIT $1`,
            [limit, tenantId]
        );
        res.json(r.rows.map((row) => ({
            id: row.id,
            nhaCungCap: row.nhacungcap,
            maGiaoDichNgoai: row.magiaodichngoai,
            soTien: Number(row.sotien),
            noiDungCK: row.noidungck,
            maHoaDonKhop: row.mahoadonkhop || null,
            trangThaiXuLy: row.trangthaixuly,
            thoiGianNhan: row.thoigiannhan,
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Log Webhook VietQR:');
    }
});

app.get('/api/topping', kiemTraToken, async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const result = await qTenant(
            req,
            `SELECT MaTopping, TenTopping, GiaTopping, COALESCE(TamHet, FALSE) AS TamHet,
                    COALESCE((to_jsonb(Topping)->>'toidamoily')::int, 3) AS ToiDaMoiLy,
                    to_jsonb(Topping)->'giabacthang' AS GiaBacThang
               FROM Topping
              WHERE DangKinhDoanh = TRUE AND COALESCE(TenantId, 'DEFAULT') = $1
              ORDER BY TenTopping`,
            [tenantId]
        );
        res.json(result.rows.map((r) => ({
            maTopping: r.matopping,
            tenTopping: r.tentopping,
            giaTopping: Number(r.giatopping),
            tamHet: Boolean(r.tamhet),
            toiDaMoiLy: Number(r.toidamoily || 3),
            giaBacThang: Array.isArray(r.giabacthang) ? r.giabacthang : null,
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Topping:');
    }
});

// [Phân hệ 7] Snapshot danh sách khách hàng thân thiết để POS cache xuống IndexedDB phục vụ tra cứu Offline
app.get('/api/khachhang/cache', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    const isManager = Number(req.user?.vaiTro) === 1;
    const limit = isManager ? Math.min(2000, Math.max(50, Number(req.query.limit) || 1000)) : 5;
    if (!isManager) {
        return res.status(403).json({
            message: 'Thu ngân không được phép tải toàn bộ tệp khách hàng (NĐ 13/2023/NĐ-CP)!',
            customers: [],
        });
    }
    try {
        const r = await qTenant(
            req,
            `SELECT MaKH, COALESCE(to_jsonb(KhachHang)->>'tenkh', to_jsonb(KhachHang)->>'hoten', '') AS TenKH,
                    SoDienThoai, DiemTichLuy
               FROM KhachHang
              WHERE COALESCE(TenantId, 'DEFAULT') = $1
              ORDER BY DiemTichLuy DESC NULLS LAST, TenKH ASC
              LIMIT $2`,
            [tenantId, limit]
        );
        res.json({
            updatedAt: new Date().toISOString(),
            total: r.rows.length,
            customers: r.rows.map((k) => ({
                maKH: k.makh,
                tenKH: k.tenkh,
                soDienThoai: maskPhoneForRole(k.sodienthoai, req.user?.vaiTro),
                diemTichLuy: Number(k.diemtichluy || 0),
            })),
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Cache khách hàng Offline:');
    }
});

app.get('/api/khachhang', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const rawQuery = String(req.query.soDienThoai || req.query.sdt || req.query.q || '').trim();
    const tenantId = layTenantId(req);
    const isManager = Number(req.user?.vaiTro) === 1;
    const rowLimit = isManager ? 10 : 5;
    if (!rawQuery) return res.status(400).json({ message: 'Vui lòng cung cấp soDienThoai (hoặc 4 số cuối SĐT)!' });
    const digitsOnly = rawQuery.replace(/[^0-9]/g, '');
    try {
        const selectCols = `
            MaKH,
            COALESCE(to_jsonb(KhachHang)->>'tenkh', to_jsonb(KhachHang)->>'hoten', '') AS TenKH,
            SoDienThoai, COALESCE(DiemTichLuy, 0) AS DiemTichLuy,
            COALESCE(to_jsonb(KhachHang)->>'hangthanhvien', 'DONG') AS HangThanhVien,
            COALESCE((to_jsonb(KhachHang)->>'tongchitieu')::numeric, 0) AS TongChiTieu,
            COALESCE((to_jsonb(KhachHang)->>'soduvi')::numeric, 0) AS SoDuVi
        `;
        let r;
        if (digitsOnly.length === 4 && /^\d{4}$/.test(rawQuery)) {
            // [PHÂN HỆ 8] Tra cứu 2 giây bằng 4 số cuối SĐT tận dụng functional index RIGHT(SoDienThoai, 4)
            r = await qTenant(
                req,
                `SELECT ${selectCols}
                   FROM KhachHang
                  WHERE COALESCE(TenantId, 'DEFAULT') = $2
                    AND (RIGHT(SoDienThoai, 4) = $1 OR RIGHT(REGEXP_REPLACE(COALESCE(SoDienThoai, ''), '[^0-9]', '', 'g'), 4) = $1)
                  ORDER BY DiemTichLuy DESC, TenKH ASC
                  LIMIT $3`,
                [digitsOnly, tenantId, rowLimit]
            );
        } else {
            r = await qTenant(
                req,
                `SELECT ${selectCols}
                   FROM KhachHang
                  WHERE COALESCE(TenantId, 'DEFAULT') = $2
                    AND (SoDienThoai = $1 OR ($3 <> '' AND RIGHT(SoDienThoai, 4) = $3))
                  ORDER BY CASE WHEN SoDienThoai = $1 THEN 0 ELSE 1 END, TenKH ASC
                  LIMIT $4`,
                [rawQuery, tenantId, digitsOnly.length === 4 ? digitsOnly : '', rowLimit]
            );
        }
        const danhSach = r.rows.map((k) => {
            const tier = tinhHangThanhVien(Number(k.tongchitieu || 0));
            return {
                maKH: k.makh,
                tenKH: k.tenkh,
                soDienThoai: maskPhoneForRole(k.sodienthoai, req.user?.vaiTro),
                diemTichLuy: Number(k.diemtichluy || 0),
                hangThanhVien: k.hangthanhvien || tier.hang,
                tenHang: tier.tenHang,
                cashbackPct: tier.cashbackPct,
                tongChiTieu: Number(k.tongchitieu || 0),
                soDuVi: Number(k.soduvi || 0),
            };
        });
        res.json({
            khachHang: danhSach[0] || null,
            danhSach,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Tra cứu khách hàng:');
    }
});

app.post('/api/khachhang', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const { soDienThoai, tenKH } = req.body;
    const tenantId = layTenantId(req);

    if (!soDienThoai || !tenKH) {
        return res.status(400).json({ message: 'Vui lòng cung cấp số điện thoại và tên khách hàng!' });
    }

    try {
        const out = await pool.withTenant(tenantId, async (client) => {
            const result = await client.query(
                "SELECT MaKH, TenKH, SoDienThoai, DiemTichLuy FROM KhachHang WHERE COALESCE(TenantId, 'DEFAULT') = $2 AND SoDienThoai = $1",
                [String(soDienThoai).trim(), tenantId]
            );
            if (result.rows.length > 0) {
                return { existing: true, khachHang: result.rows[0] };
            }

            const maKH = 'KH' + crypto.randomBytes(4).toString('hex').toUpperCase();
            const insertResult = await client.query(
                'INSERT INTO KhachHang (MaKH, TenKH, SoDienThoai, DiemTichLuy, TenantId) VALUES ($1, $2, $3, 0, $4) RETURNING MaKH, TenKH, SoDienThoai, DiemTichLuy',
                [maKH, String(tenKH).trim().slice(0, 100), String(soDienThoai).trim().slice(0, 20), tenantId]
            );
            return { existing: false, khachHang: insertResult.rows[0] };
        });
        res.json({
            message: out.existing ? 'Tìm thấy thông tin khách hàng!' : 'Đăng ký khách hàng thành công!',
            khachHang: out.khachHang,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Khách hàng:');
    }
});

// ==========================================
// CA THU NGÂN TOÀN CỤC — PHÂN HỆ 3 (100/100: BLIND DROP 1-LẦN ĐẾM LẠI, BÀN GIAO LIÊN CA, SAFE DROP 2 LỚP, Z-REPORT BẤT BIẾN)
// ==========================================

async function handleMoCa(req, res) {
    const tenantId = layTenantId(req);
    const {
        branchId = null,
        terminalId = null,
        chiTietMenhGiaDauCa = null,
    } = req.body || {};

    const denomInit = computeDenominationTotal(chiTietMenhGiaDauCa);
    const tienMatDauCa =
        denomInit.cleanMap && denomInit.total !== null
            ? denomInit.total
            : req.body && req.body.tienMatDauCa !== undefined
            ? Number(req.body.tienMatDauCa)
            : 0;
    if (!(tienMatDauCa >= 0)) return res.status(400).json({ message: 'tienMatDauCa phải là số >= 0!' });

    const normBranch = normalizeBranchForShift(tenantId, branchId || req.user.branchId || null);
    const normTerminal = normalizeTerminalId(terminalId);

    try {
        const ca = await chayGiaoDich(async (client) => {
            const daMo = await layCaDangMo(client, 'UPDATE', tenantId, {
                branchId: normBranch,
                terminalId: normTerminal,
            });
            if (daMo) {
                throw new LoiNghiepVu(409, `Quầy ${normTerminal} (${normBranch}) đang có một ca chưa chốt!`, {
                    maLoi: 'DA_MO_CA',
                    maCaThuNgan: daMo.macathungan,
                });
            }

            // Tìm ca vừa đóng gần nhất của cùng (BranchId, TerminalId) để kiểm tra Chênh lệch Bàn giao Liên ca!
            let maCaTruoc = null;
            let tienGiuLaiCaTruoc = null;
            let chenhLechBanGiao = 0;
            await client.query('SAVEPOINT sp_prev_shift_handover');
            try {
                const prevRes = await client.query(
                    `SELECT MaCaThuNgan, COALESCE(TienGiuLaiKet, 0) AS TienGiuLaiKet
                       FROM CaThuNgan
                      WHERE COALESCE(TenantId::text, 'DEFAULT') = $1::text
                        AND COALESCE(NULLIF(BranchId::text, ''), $1::text || '_MAIN') = $2::text
                        AND COALESCE(NULLIF(TerminalId::text, ''), 'POS_01') = $3::text
                        AND TrangThaiCa = 2
                      ORDER BY ThoiGianDongCa DESC NULLS LAST, ThoiGianMoCa DESC
                      LIMIT 1`,
                    [tenantId, normBranch, normTerminal]
                );
                if (prevRes.rows.length > 0) {
                    maCaTruoc = prevRes.rows[0].macathungan;
                    tienGiuLaiCaTruoc = Number(prevRes.rows[0].tiengiulaiket || 0);
                    chenhLechBanGiao = Math.round((tienMatDauCa - tienGiuLaiCaTruoc) * 100) / 100;
                }
                await client.query('RELEASE SAVEPOINT sp_prev_shift_handover');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_prev_shift_handover').catch(() => {});
            }

            let r;
            await client.query('SAVEPOINT sp_ins_ca_p3');
            try {
                r = await client.query(
                    `INSERT INTO CaThuNgan
                        (MaNV, TienMatDauCa, TenantId, BranchId, TerminalId, ChiTietMenhGiaDauCa, MaCaTruoc, ChenhLechBanGiao)
                     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
                     RETURNING MaCaThuNgan, ThoiGianMoCa, TienMatDauCa, BranchId, TerminalId, ChenhLechBanGiao, MaCaTruoc`,
                    [
                        req.user.maNV,
                        tienMatDauCa,
                        tenantId,
                        normBranch,
                        normTerminal,
                        denomInit.cleanMap ? JSON.stringify(denomInit.cleanMap) : null,
                        maCaTruoc,
                        chenhLechBanGiao,
                    ]
                );
                await client.query('RELEASE SAVEPOINT sp_ins_ca_p3');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_ins_ca_p3').catch(() => {});
                r = await client.query(
                    `INSERT INTO CaThuNgan (MaNV, TienMatDauCa, TenantId) VALUES ($1, $2, $3)
                     RETURNING MaCaThuNgan, ThoiGianMoCa, TienMatDauCa`,
                    [req.user.maNV, tienMatDauCa, tenantId]
                );
            }
            const row = r.rows[0];

            // Nếu lệch tiền bàn giao giữa Ca trước để lại vs Ca sau đếm nhận -> Audit Log + Cảnh báo Telegram ngay!
            if (maCaTruoc && Math.abs(chenhLechBanGiao) > 0) {
                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'SHIFT_HANDOVER_VARIANCE',
                    doiTuong: 'CATHUNGAN',
                    maDoiTuong: row.macathungan,
                    giaTriCu: { maCaTruoc, tienGiuLaiCaTruoc },
                    giaTriMoi: { tienMatDauCa, chenhLechBanGiao, branchId: normBranch, terminalId: normTerminal },
                    lyDo: `Lệch tiền bàn giao giữa Ca #${maCaTruoc} (để lại ${tienGiuLaiCaTruoc.toLocaleString('vi-VN')}đ) và Ca #${row.macathungan} (đếm nhận ${tienMatDauCa.toLocaleString('vi-VN')}đ): ${chenhLechBanGiao.toLocaleString('vi-VN')}đ`,
                    ip: req.ip,
                    batBuoc: true,
                });
                void dispatchFraudAlertFromAudit(pool, {
                    tenantId,
                    hanhDong: 'SHIFT_HANDOVER_VARIANCE',
                    maNV: req.user.maNV,
                    maDoiTuong: row.macathungan,
                    giaTriMoi: { maCaTruoc, tienGiuLaiCaTruoc, tienMatDauCa, chenhLechBanGiao },
                    lyDo: `⚠️ Lệch bàn giao két liên ca: ${chenhLechBanGiao.toLocaleString('vi-VN')}đ`,
                }).catch(() => {});
            }

            // Gắn tự động giao dịch VietQR ngoài giờ đóng ca (lọc đúng BranchId!)
            let soGiaoDichTuDongGanCa = 0;
            if (paymentsSanSang) {
                const orphanRes = await client.query(
                    `UPDATE Order_Payments
                        SET MaCaThuNgan = $2
                      WHERE MaCaThuNgan IS NULL
                        AND TrangThai = 'PAID'
                        AND COALESCE(TenantId, 'DEFAULT') = $1
                        AND (BranchId IS NULL OR BranchId = $3)
                      RETURNING Id, MaHoaDon, SoTien`,
                    [tenantId, String(row.macathungan), normBranch]
                );
                soGiaoDichTuDongGanCa = orphanRes.rows.length;
                if (soGiaoDichTuDongGanCa > 0) {
                    await client.query(
                        `UPDATE HoaDon
                            SET MaCaThuNgan = $2::int
                          WHERE MaCaThuNgan IS NULL
                            AND COALESCE(TenantId, 'DEFAULT') = $1
                            AND MaHoaDon::text IN (
                                SELECT DISTINCT MaHoaDon FROM Order_Payments WHERE MaCaThuNgan = $3::text
                            )`,
                        [tenantId, Number(row.macathungan), String(row.macathungan)]
                    );
                    const tongTienOrphan = orphanRes.rows.reduce((s, o) => s + Number(o.sotien || 0), 0);
                    await ghiAuditLog(client, {
                        tenantId,
                        maNV: req.user.maNV,
                        vaiTro: req.user.vaiTro,
                        hanhDong: 'ORPHAN_PAYMENTS_ATTACHED',
                        doiTuong: 'CATHUNGAN',
                        maDoiTuong: row.macathungan,
                        giaTriMoi: { soGiaoDich: soGiaoDichTuDongGanCa, tongTien: tongTienOrphan, branchId: normBranch },
                        lyDo: 'Tự động gắn giao dịch VietQR ngoài giờ đóng ca vào ca vừa mở',
                        ip: req.ip,
                        batBuoc: true,
                    });
                }
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'SHIFT_OPEN',
                doiTuong: 'CATHUNGAN',
                maDoiTuong: row.macathungan,
                giaTriMoi: {
                    tienMatDauCa: Number(row.tienmatdauca),
                    branchId: normBranch,
                    terminalId: normTerminal,
                    chiTietMenhGiaDauCa: denomInit.cleanMap,
                    maCaTruoc,
                    chenhLechBanGiao,
                    soGiaoDichTuDongGanCa,
                },
                ip: req.ip,
            });
            return { ...row, branchId: normBranch, terminalId: normTerminal, chenhLechBanGiao, maCaTruoc, soGiaoDichTuDongGanCa };
        }, tenantId);

        io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('CA_THAY_DOI', { trangThai: 'MO', maCaThuNgan: ca.macathungan });
        res.status(201).json({
            message: ca.soGiaoDichTuDongGanCa > 0
                ? `Mở ca thành công & đã tự động gắn ${ca.soGiaoDichTuDongGanCa} giao dịch chuyển khoản ngoài giờ vào ca!`
                : 'Mở ca thành công!',
            soGiaoDichTuDongGanCa: ca.soGiaoDichTuDongGanCa || 0,
            chenhLechBanGiao: Number(ca.chenhLechBanGiao || 0),
            ca: {
                maCaThuNgan: ca.macathungan,
                branchId: ca.branchId,
                terminalId: ca.terminalId,
                thoiGianMoCa: ca.thoigianmoca,
                tienMatDauCa: Number(ca.tienmatdauca),
                maCaTruoc: ca.maCaTruoc || null,
                chenhLechBanGiao: Number(ca.chenhLechBanGiao || 0),
            },
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Mở ca:');
    }
}

app.post('/api/ca/mo', kiemTraToken, choPhepVaiTro(1, 4), kiemTraHanSuDung, handleMoCa);

// Ca đang mở: Blind Mode cho Thu ngân/Phục vụ (cô lập theo TenantId + BranchId + TerminalId)
app.get('/api/ca/hientai', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const doiSoat = await pool.withTenant(tenantId, async (client) => {
            const ca = await layCaDangMo(client, undefined, tenantId, {
                branchId: req.query.branchId || null,
                terminalId: req.query.terminalId || null,
            });
            if (!ca) return null;
            return tinhDoiSoatCa(client, ca.macathungan);
        });
        if (!doiSoat) return res.json({ caHienTai: null });
        const canViewXReport = Number(req.user.vaiTro) === 1 || coQuyenHan(req.user, 'shift.view_x_report');
        if (!canViewXReport) {
            return res.json({
                caHienTai: {
                    maCaThuNgan: doiSoat.maCaThuNgan,
                    branchId: doiSoat.branchId,
                    terminalId: doiSoat.terminalId,
                    maNV: doiSoat.maNV,
                    tenNV: doiSoat.tenNV,
                    thoiGianMoCa: doiSoat.thoiGianMoCa,
                    trangThaiCa: doiSoat.trangThaiCa,
                    blindMode: true,
                },
            });
        }
        res.json({ caHienTai: { ...doiSoat, blindMode: false } });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Ca hiện tại:');
    }
});

// Ghi nhận Thu / Chi lặt vặt / Rút két an toàn 2 lớp (Safe Drop Two-Man Rule + Receipt Photo Gate + PIN duyệt vượt ngưỡng)
async function handleThuChiCa(req, res) {
    const {
        loaiThuChi: rawLoai,
        soTien,
        lyDo,
        danhMucChi = 'KHAC',
        anhChungTuUrl = null,
        idChungTu = null,
        managerPin = null,
        maNVDuyet = null,
        branchId = null,
        terminalId = null,
    } = req.body || {};
    const tenantId = layTenantId(req);
    const loaiThuChi = String(rawLoai || '').toUpperCase() === 'SAFE_DROP' ? 'RUT_KET' : String(rawLoai || '').toUpperCase();
    const tien = Number(soTien);
    if (!['THU', 'CHI', 'RUT_KET'].includes(loaiThuChi) || !(tien > 0)) {
        return res.status(400).json({ message: 'Vui lòng cung cấp đúng loaiThuChi (THU / CHI / RUT_KET) và soTien > 0!' });
    }
    const lyDoSach = String(lyDo || '').trim();
    if (lyDoSach.length < 3) {
        return res.status(400).json({
            message: loaiThuChi === 'RUT_KET'
                ? 'Vui lòng ghi rõ tên người nhận tiền rút két / lý do bàn giao (tối thiểu 3 ký tự)!'
                : 'Vui lòng nhập lý do thu/chi (tối thiểu 3 ký tự)!',
        });
    }
    const cleanAnhUrl =
        typeof anhChungTuUrl === 'string' && anhChungTuUrl.trim().length > 0
            ? anhChungTuUrl.trim().slice(0, 460000)
            : null;
    const cleanIdChungTu = typeof idChungTu === 'string' && idChungTu.trim() ? idChungTu.trim().slice(0, 64) : null;
    const cleanDanhMuc = ['MUA_DA', 'NGUYEN_LIEU_GAP', 'SHIP', 'VE_SINH', 'RUT_KET', 'THOI_CK_DU', 'KHAC'].includes(
        String(danhMucChi || '').toUpperCase()
    )
        ? String(danhMucChi).toUpperCase()
        : loaiThuChi === 'RUT_KET'
        ? 'RUT_KET'
        : 'KHAC';

    const loaiPhieuDb = loaiThuChi === 'THU' ? 1 : loaiThuChi === 'RUT_KET' ? 3 : 2;
    const auditAction =
        loaiThuChi === 'THU' ? 'CASH_PAYIN' : loaiThuChi === 'RUT_KET' ? 'CASH_SAFE_DROP' : 'CASH_PAYOUT';

    try {
        const phieu = await chayGiaoDich(async (client) => {
            const ca = await layCaDangMo(client, 'SHARE', tenantId, { branchId, terminalId });
            if (!ca) throw loiChuaMoCa();

            const policy = await getTenantShiftPolicy(client, tenantId);
            let nguoiDuyet = Number(req.user.vaiTro) === 1 ? req.user.maNV : null;
            let verifiedAnhUrl = cleanAnhUrl;

            // 1. Cổng Ảnh Chứng Từ Thật cho Phiếu Chi >= nguongBatBuocChungTu (mặc định 50.000đ)
            if (loaiThuChi === 'CHI' && tien >= Number(policy.nguongBatBuocChungTu || 50000)) {
                if (!cleanIdChungTu) {
                    throw new LoiNghiepVu(
                        400,
                        `Phiếu chi từ ${Number(policy.nguongBatBuocChungTu || 50000).toLocaleString('vi-VN')}đ trở lên bắt buộc tải lên ảnh chụp hóa đơn/biên nhận xác thực (idChungTu)!`,
                        { code: 'RECEIPT_PHOTO_REQUIRED', maLoi: 'RECEIPT_PHOTO_REQUIRED' }
                    );
                }
                const photoRes = await client.query(
                    `SELECT id FROM public.receipt_photo_uploads WHERE id = $1 AND tenantid = $2`,
                    [cleanIdChungTu, tenantId]
                );
                if (photoRes.rows.length === 0) {
                    throw new LoiNghiepVu(
                        400,
                        'Mã ảnh chứng từ (idChungTu) không hợp lệ hoặc không thuộc quán này!',
                        { code: 'INVALID_RECEIPT_PHOTO', maLoi: 'INVALID_RECEIPT_PHOTO' }
                    );
                }
                verifiedAnhUrl = `/api/uploads/receipt-photo/${cleanIdChungTu}`;
            }

            // 2. Cổng Manager PIN cho Phiếu Chi >= nguongPinPhieuChi (mặc định 200.000đ)
            if (loaiThuChi === 'CHI' && tien >= Number(policy.nguongPinPhieuChi || 200000)) {
                if (!coQuyenHan(req.user, 'shift.cash_payout.approve')) {
                    const mgr = managerPin
                        ? await xacThucPinQuanLy(client, tenantId, managerPin, req.ip, maNVDuyet, 'shift.cash_payout.approve')
                        : null;
                    if (!mgr) {
                        throw new LoiNghiepVu(
                            403,
                            `Phiếu chi từ ${Number(policy.nguongPinPhieuChi || 200000).toLocaleString('vi-VN')}đ cần quyền hoặc mã PIN Quản lý phê duyệt!`,
                            { code: 'PAYOUT_APPROVAL_REQUIRED', maLoi: 'CAN_PIN_QUAN_LY' }
                        );
                    }
                    nguoiDuyet = mgr.maNV;
                }
            }

            // 3. Safe Drop (RUT_KET) luôn khởi tạo ở trạng thái PENDING_RECEIPT chờ Chủ quán xác nhận đã cầm tiền (Two-Man Rule)
            const trangThaiXacNhan = loaiThuChi === 'RUT_KET' ? 'PENDING_RECEIPT' : 'CONFIRMED';

            let r;
            await client.query('SAVEPOINT sp_ins_thuchi_p3');
            try {
                r = await client.query(
                    `INSERT INTO PhieuThuChiLatVat
                        (MaCaThuNgan, LoaiPhieu, SoTien, LyDo, AnhChungTuUrl, DanhMucChi, NguoiDuyet, TrangThaiXacNhan, IdChungTu)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                     RETURNING MaPhieuTC, ThoiGianTao, AnhChungTuUrl, DanhMucChi, TrangThaiXacNhan, IdChungTu`,
                    [ca.macathungan, loaiPhieuDb, tien, lyDoSach.slice(0, 255), verifiedAnhUrl, cleanDanhMuc, nguoiDuyet, trangThaiXacNhan, cleanIdChungTu]
                );
                await client.query('RELEASE SAVEPOINT sp_ins_thuchi_p3');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_ins_thuchi_p3').catch(() => {});
                r = await client.query(
                    `INSERT INTO PhieuThuChiLatVat (MaCaThuNgan, LoaiPhieu, SoTien, LyDo, AnhChungTuUrl)
                     VALUES ($1, $2, $3, $4, $5) RETURNING MaPhieuTC, ThoiGianTao, AnhChungTuUrl`,
                    [ca.macathungan, loaiPhieuDb, tien, lyDoSach.slice(0, 255), verifiedAnhUrl]
                );
            }
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                nguoiDuyet,
                hanhDong: auditAction,
                doiTuong: 'CATHUNGAN',
                maDoiTuong: ca.macathungan,
                giaTriMoi: {
                    maPhieuTC: r.rows[0].maphieutc,
                    loaiThuChi,
                    danhMucChi: cleanDanhMuc,
                    soTien: tien,
                    trangThaiXacNhan,
                    idChungTu: cleanIdChungTu,
                    coAnhChungTu: Boolean(verifiedAnhUrl || cleanIdChungTu),
                },
                lyDo: lyDoSach,
                ip: req.ip,
                batBuoc: true,
            });
            return { ...r.rows[0], maCaThuNgan: ca.macathungan, trangThaiXacNhan };
        }, tenantId);

        if (loaiThuChi === 'RUT_KET') {
            void dispatchFraudAlertFromAudit(pool, {
                tenantId,
                hanhDong: 'CASH_SAFE_DROP',
                maNV: req.user.maNV,
                maDoiTuong: phieu.maphieutc,
                giaTriMoi: { maPhieuTC: phieu.maphieutc, soTien: tien, trangThaiXacNhan: 'PENDING_RECEIPT' },
                lyDo: `🏦 Phiếu Rút két an toàn #${phieu.maphieutc} (${tien.toLocaleString('vi-VN')}đ) đang chờ Chủ quán xác nhận đã nhận tiền!`,
            }).catch(() => {});
        }

        const msg =
            loaiThuChi === 'RUT_KET'
                ? `🏦 Đã lập phiếu Rút két an toàn #${phieu.maphieutc} (${tien.toLocaleString('vi-VN')}đ) — đang chờ Chủ quán xác nhận đã nhận tiền!`
                : `Ghi nhận khoản ${loaiThuChi} lặt vặt thành công!`;
        res.status(201).json({
            message: msg,
            loaiThuChi,
            danhMucChi: cleanDanhMuc,
            trangThaiXacNhan: phieu.trangThaiXacNhan,
            idChungTu: phieu.idchungtu || cleanIdChungTu,
            maPhieuTC: phieu.maphieutc,
            maCaThuNgan: phieu.maCaThuNgan,
            anhChungTuUrl: phieu.anhchungtuurl || cleanAnhUrl || null,
            thoiGianTao: phieu.thoigiantao,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Thu Chi / Rút két:');
    }
}

app.post('/api/ca/thuchi', kiemTraToken, choPhepVaiTro(1, 4), handleThuChiCa);

// Danh sách phiếu thu/chi/rút két/thối CK dư (kèm trạng thái Two-Man Rule & idChungTu)
app.get('/api/ca/thuchi', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const rows = await pool.withTenant(tenantId, async (client) => {
            let maCa = req.query.maCaThuNgan;
            if (!maCa) {
                const ca = await layCaDangMo(client, undefined, tenantId);
                if (!ca) throw loiChuaMoCa();
                maCa = ca.macathungan;
            } else {
                const own = await client.query(
                    `SELECT 1 FROM CaThuNgan WHERE MaCaThuNgan = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
                    [maCa, tenantId]
                );
                if (own.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy ca thu ngân!');
            }
            const r = await client.query(
                `SELECT MaPhieuTC, LoaiPhieu, SoTien, LyDo, ThoiGianTao,
                        to_jsonb(PhieuThuChiLatVat)->>'anhchungtuurl' AS AnhChungTuUrl,
                        COALESCE(to_jsonb(PhieuThuChiLatVat)->>'danhmucchi', 'KHAC') AS DanhMucChi,
                        COALESCE(to_jsonb(PhieuThuChiLatVat)->>'trangthaixacnhan', 'CONFIRMED') AS TrangThaiXacNhan,
                        to_jsonb(PhieuThuChiLatVat)->>'nguoinhanket' AS NguoiNhanKet,
                        to_jsonb(PhieuThuChiLatVat)->>'thoigiannhanket' AS ThoiGianNhanKet,
                        to_jsonb(PhieuThuChiLatVat)->>'idchungtu' AS IdChungTu
                   FROM PhieuThuChiLatVat WHERE MaCaThuNgan = $1 ORDER BY ThoiGianTao DESC`,
                [maCa]
            );
            return r.rows;
        });
        res.json(rows.map((p) => ({
            maPhieuTC: p.maphieutc,
            loaiThuChi:
                Number(p.loaiphieu) === 1
                    ? 'THU'
                    : Number(p.loaiphieu) === 3
                    ? 'RUT_KET'
                    : Number(p.loaiphieu) === 4
                    ? 'THOI_CK_DU'
                    : 'CHI',
            danhMucChi: p.danhmucchi || 'KHAC',
            soTien: Number(p.sotien),
            lyDo: p.lydo,
            trangThaiXacNhan: p.trangthaixacnhan || 'CONFIRMED',
            nguoiNhanKet: p.nguoinhanket || null,
            thoiGianNhanKet: p.thoigiannhanket || null,
            idChungTu: p.idchungtu || null,
            anhChungTuUrl: p.anhchungtuurl || null,
            thoiGianTao: p.thoigiantao,
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách thu chi:');
    }
});

// Đối soát xem trước (X-Report): Bắt buộc quyền RBAC shift.view_x_report (Thu ngân bị chặn 403 tuyệt đối để bảo vệ Blind Drop!)
async function handleDoiSoatCa(req, res) {
    const { maCaThuNgan, tienMatThucTe } = req.query;
    const tenantId = layTenantId(req);
    const hasXReportPerm = Number(req.user.vaiTro) === 1 || coQuyenHan(req.user, 'shift.view_x_report');
    if (!hasXReportPerm) {
        return res.status(403).json({
            code: 'X_REPORT_FORBIDDEN',
            message: 'Tài khoản Thu ngân không được xem quỹ lý thuyết (X-Report) để đảm bảo đối soát mù (Blind Drop)!',
        });
    }
    if (tienMatThucTe !== undefined && !(Number(tienMatThucTe) >= 0)) {
        return res.status(400).json({ message: 'tienMatThucTe phải là số >= 0!' });
    }
    try {
        const doiSoat = await pool.withTenant(tenantId, async (client) => {
            let maCa = maCaThuNgan;
            if (maCa) {
                const ca = await client.query(
                    `SELECT MaNV FROM CaThuNgan WHERE MaCaThuNgan = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
                    [maCa, tenantId]
                );
                if (ca.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy ca thu ngân!');
            } else {
                const ca = await layCaDangMo(client, undefined, tenantId);
                if (!ca) throw loiChuaMoCa();
                maCa = ca.macathungan;
            }
            return tinhDoiSoatCa(client, maCa, tienMatThucTe);
        });
        res.json({ doiSoat });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Đối soát cuối ca:');
    }
}

app.get('/api/ca/doisoat', kiemTraToken, choPhepVaiTro(1, 4), handleDoiSoatCa);

// Chốt ca (Phân hệ 3: Pre-Close Gate STRICT/CARRY_OVER + Blind Drop Recount Challenge 1 lần + Atomic Z-Report Counter + ZReportSnapshot bất biến!)
async function handleDongCa(req, res) {
    const {
        tienMatThucTe: rawActual,
        maCaThuNgan,
        ghiChuChenhLech,
        chiTietMenhGia,
        tienGiuLaiKet = 0,
        confirmRecount = false,
        outboxPendingCount = 0,
        branchId = null,
        terminalId = null,
    } = req.body || {};
    const tenantId = layTenantId(req);

    const denom = computeDenominationTotal(chiTietMenhGia);
    const menhGiaClean = denom.cleanMap;
    const tienMatThucTe =
        rawActual !== undefined && rawActual !== null && rawActual !== ''
            ? Number(rawActual)
            : denom.cleanMap
            ? denom.total
            : NaN;

    if (!Number.isFinite(tienMatThucTe) || tienMatThucTe < 0) {
        return res.status(400).json({ message: 'Vui lòng cung cấp tienMatThucTe hoặc chiTietMenhGia hợp lệ (>= 0)!' });
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            let ca = null;
            if (maCaThuNgan && Number(req.user.vaiTro) === 1) {
                const rCa = await client.query(
                    `SELECT MaCaThuNgan, MaNV, ThoiGianMoCa, TienMatDauCa,
                            COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'branchid', ''), $2::text || '_MAIN') AS BranchId,
                            COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'terminalid', ''), 'POS_01') AS TerminalId,
                            COALESCE((to_jsonb(CaThuNgan)->>'solandemlai')::int, 0) AS SoLanDemLai
                       FROM CaThuNgan
                      WHERE MaCaThuNgan = $1 AND TrangThaiCa = 1 AND COALESCE(TenantId::text, 'DEFAULT') = $2::text
                      FOR UPDATE`,
                    [maCaThuNgan, tenantId]
                );
                ca = rCa.rows[0] || null;
            } else {
                ca = await layCaDangMo(client, 'UPDATE', tenantId, {
                    branchId: branchId || req.user.branchId || null,
                    terminalId: terminalId || null,
                });
                if (!ca && (branchId || terminalId)) {
                    ca = await layCaDangMo(client, 'UPDATE', tenantId);
                }
            }
            if (!ca) throw new LoiNghiepVu(409, 'Hệ thống không có ca nào đang mở!', { maLoi: 'CHUA_MO_CA' });

            const caBranch = normalizeBranchForShift(tenantId, ca.branchid || branchId);
            const caTerminal = normalizeTerminalId(ca.terminalid || terminalId);
            const policy = await getTenantShiftPolicy(client, tenantId);

            if (policy.strictDenomination && !menhGiaClean) {
                throw new LoiNghiepVu(
                    400,
                    'Quán đang bật chế độ đếm mệnh giá bắt buộc (Strict Denomination) — vui lòng nhập chi tiết số tờ từng mệnh giá!',
                    { code: 'DENOMINATION_REQUIRED' }
                );
            }

            // 1. Cổng kiểm tra an toàn trước khi chốt ca (STRICT chặn 409 nếu còn bàn/outbox/VietQR treo; CARRY_OVER ghi bàn chuyển giao vào Z-Report)
            const preCheck = await computePreCloseChecklist(client, {
                tenantId,
                branchId: caBranch,
                maCaThuNgan: ca.macathungan,
                outboxPendingCount,
            });
            if (!preCheck.canClose) {
                throw new LoiNghiepVu(
                    409,
                    `Không thể chốt ca ở chế độ STRICT: ${preCheck.blockingReasons.join(' ')}`,
                    {
                        code: 'PRE_CLOSE_BLOCKED',
                        maLoi: 'PRE_CLOSE_BLOCKED',
                        checklist: preCheck,
                    }
                );
            }

            const ds = await tinhDoiSoatCa(client, ca.macathungan, tienMatThucTe);
            const absDiff = Math.abs(Number(ds.chenhLech || 0));
            const recountThreshold = Number(policy.nguongLechCaRecount ?? 10000);

            const currentRecountAttempts = Number(ca.solandemlai || 0);
            const hasCompletedFirstChallenge = currentRecountAttempts >= 1;

            // 2. True Blind Drop Recount Challenge (Server-enforced bằng CaThuNgan.SoLanDemLai!)
            // Bảo mật L3.1: Tuyệt đối KHÔNG cho client bỏ qua lần đếm lại bằng confirmRecount=true khi máy chủ chưa từng yêu cầu đếm lại (SoLanDemLai < 1)!
            if (absDiff > recountThreshold && (!hasCompletedFirstChallenge || !Boolean(confirmRecount))) {
                await client.query(
                    `UPDATE CaThuNgan SET SoLanDemLai = COALESCE(SoLanDemLai, 0) + 1 WHERE MaCaThuNgan = $1`,
                    [ca.macathungan]
                );
                return {
                    recountRequired: true,
                    maCaThuNgan: ca.macathungan,
                };
            }

            const ghiChu = ghiChuChenhLech ? String(ghiChuChenhLech).trim().slice(0, 500) : null;
            if (absDiff > recountThreshold && (!ghiChu || ghiChu.length < 10)) {
                throw new LoiNghiepVu(
                    400,
                    'Số tiền vẫn chênh lệch sau lần kiểm đếm thứ 2 — vui lòng nhập ghi chú giải trình chi tiết (tối thiểu 10 ký tự)!',
                    { code: 'VARIANCE_REASON_REQUIRED' }
                );
            }

            // 3. Đánh số Z-Report nguyên tử theo (TenantId, BranchId) & đóng băng ZReportSnapshot JSONB
            const { zInt, zNumber } = await nextAtomicZReportNumber(client, tenantId, caBranch);
            const carryFloat = Math.max(0, Math.min(tienMatThucTe, Number(tienGiuLaiKet || 0)));
            const recountRes = await client.query(
                `SELECT COALESCE((to_jsonb(CaThuNgan)->>'solandemlai')::int, 0) AS n FROM CaThuNgan WHERE MaCaThuNgan = $1`,
                [ca.macathungan]
            );
            const recountAttempts = Number(recountRes.rows[0]?.n || 0);

            const zReportSnapshot = await buildImmutableZReportSnapshot(client, {
                tenantId,
                maCaThuNgan: ca.macathungan,
                caRow: ca,
                ds,
                zNumber,
                branchId: caBranch,
                terminalId: caTerminal,
                closeByName: req.user.tenNV || req.user.maNV,
                carryOverFloatNextShift: carryFloat,
                carriedOverOpenTables: {
                    count: preCheck.openOrders.length,
                    estimatedTotal: preCheck.openTablesEstimatedTotal,
                    tables: preCheck.openOrders.slice(0, 20),
                },
                recountAttempts,
            });

            await client.query('SAVEPOINT sp_dong_ca_zreport_p3');
            try {
                await client.query(
                    `UPDATE CaThuNgan
                        SET ThoiGianDongCa = CURRENT_TIMESTAMP, TongThuHoaDon = $2, TongThuLatVat = $3, TongChiLatVat = $4,
                            TienMatThucTe = $5, ChenhLech = $6, TrangThaiCa = 2, GhiChuChenhLech = $7,
                            TongRutKet = $8, ChiTietMenhGia = $9::jsonb, SoZReport = $10,
                            TienGiuLaiKet = $11, ZReportSnapshot = $12::jsonb
                      WHERE MaCaThuNgan = $1`,
                    [
                        ca.macathungan,
                        ds.doanhThu.tong,
                        ds.thuLatVat,
                        ds.chiLatVat,
                        ds.tienMatThucTe,
                        ds.chenhLech,
                        ghiChu,
                        ds.rutKet || 0,
                        menhGiaClean ? JSON.stringify(menhGiaClean) : null,
                        zInt,
                        carryFloat,
                        JSON.stringify(zReportSnapshot),
                    ]
                );
                await client.query('RELEASE SAVEPOINT sp_dong_ca_zreport_p3');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_dong_ca_zreport_p3').catch(() => {});
                await client.query(
                    `UPDATE CaThuNgan
                        SET ThoiGianDongCa = CURRENT_TIMESTAMP, TongThuHoaDon = $2, TongThuLatVat = $3, TongChiLatVat = $4,
                            TienMatThucTe = $5, ChenhLech = $6, TrangThaiCa = 2, GhiChuChenhLech = $7
                      WHERE MaCaThuNgan = $1`,
                    [ca.macathungan, ds.doanhThu.tong, ds.thuLatVat, ds.chiLatVat, ds.tienMatThucTe, ds.chenhLech, ghiChu]
                );
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: absDiff > recountThreshold ? 'SHIFT_CLOSE_DIFF' : 'SHIFT_CLOSE',
                doiTuong: 'CATHUNGAN',
                maDoiTuong: ca.macathungan,
                giaTriMoi: {
                    zNumber,
                    branchId: caBranch,
                    terminalId: caTerminal,
                    tienMatLyThuyet: ds.tienMatLyThuyet,
                    tienMatThucTe: ds.tienMatThucTe,
                    chenhLech: ds.chenhLech,
                    tienGiuLaiKet: carryFloat,
                    rutKet: ds.rutKet || 0,
                    recountAttempts,
                    doanhThu: ds.doanhThu,
                    chiTietMenhGia: menhGiaClean,
                },
                lyDo: ghiChu || ds.trangThai,
                ip: req.ip,
                batBuoc: true,
            });

            const doiSoatCuoi = await tinhDoiSoatCa(client, ca.macathungan, tienMatThucTe);
            return {
                recountRequired: false,
                zNumber,
                zReportSnapshot,
                doiSoat: doiSoatCuoi,
                soHoaDonDangMo: preCheck.openOrders.length,
                absDiff,
                recountThreshold,
            };
        }, tenantId);

        // Chế độ Đếm lại Blind Drop: trả 422 KHÔNG chứa tienMatLyThuyet / chenhLech!
        if (ketQua.recountRequired) {
            return res.status(422).json({
                code: 'BLIND_RECOUNT_REQUIRED',
                maLoi: 'BLIND_RECOUNT_REQUIRED',
                message:
                    'Số tiền kiểm đếm đang chênh lệch so với sổ quỹ. Vui lòng kiểm tra lại ngăn kéo / tờ tiền kẹt và xác nhận lần 2 kèm lý do giải trình!',
            });
        }

        if (ketQua.absDiff > ketQua.recountThreshold) {
            void dispatchFraudAlertFromAudit(pool, {
                tenantId,
                hanhDong: 'SHIFT_CLOSE_DIFF',
                maNV: req.user.maNV,
                maDoiTuong: ketQua.doiSoat?.maCaThuNgan,
                giaTriMoi: {
                    zNumber: ketQua.zNumber,
                    tienMatLyThuyet: ketQua.doiSoat?.tienMatLyThuyet,
                    tienMatThucTe: ketQua.doiSoat?.tienMatThucTe,
                    chenhLech: ketQua.doiSoat?.chenhLech,
                },
                lyDo: `⚠️ Chốt ca ${ketQua.zNumber} lệch quỹ ${Number(ketQua.doiSoat?.chenhLech || 0).toLocaleString('vi-VN')}đ`,
            }).catch(() => {});
        }

        io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('CA_THAY_DOI', { trangThai: 'DONG' });
        res.json({
            message: `Đã chốt ca thành công (${ketQua.zNumber})!`,
            zNumber: ketQua.zNumber,
            zReportSnapshot: ketQua.zReportSnapshot,
            doiSoat: ketQua.doiSoat,
            soHoaDonDangMo: ketQua.soHoaDonDangMo,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Chốt ca:');
    }
}

app.post('/api/ca/dong', kiemTraToken, choPhepVaiTro(1, 4), handleDongCa);

// Lịch sử các ca thu ngân (Quản lý): lọc chuẩn múi giờ Asia/Ho_Chi_Minh + cô lập TenantId
app.get('/api/ca/danhsach', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { tuNgay, denNgay } = req.query;
    const tenantId = layTenantId(req);
    if (!tuNgay || !denNgay) return res.status(400).json({ message: 'Vui lòng cung cấp tham số tuNgay và denNgay (YYYY-MM-DD)!' });
    try {
        const rows = await pool.withTenant(tenantId, async (client) => {
            await client.query('SAVEPOINT sp_ds_ca_ext');
            try {
                const r = await client.query(
                    `SELECT ca.MaCaThuNgan, ca.MaNV, nv.TenNV, ca.ThoiGianMoCa, ca.ThoiGianDongCa, ca.TienMatDauCa,
                            ca.TongThuHoaDon, ca.TongThuLatVat, ca.TongChiLatVat, COALESCE(ca.TongRutKet, 0) AS TongRutKet,
                            ca.TienMatThucTe, ca.ChenhLech, ca.TrangThaiCa, ca.GhiChuChenhLech
                       FROM CaThuNgan ca JOIN NhanVien nv ON nv.MaNV = ca.MaNV
                      WHERE COALESCE(ca.TenantId, 'DEFAULT') = $3
                        AND ca.ThoiGianMoCa >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                        AND ca.ThoiGianMoCa < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                      ORDER BY ca.ThoiGianMoCa DESC`,
                    [tuNgay, denNgay, tenantId]
                );
                await client.query('RELEASE SAVEPOINT sp_ds_ca_ext');
                return r.rows;
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_ds_ca_ext').catch(() => {});
                const r = await client.query(
                    `SELECT ca.MaCaThuNgan, ca.MaNV, nv.TenNV, ca.ThoiGianMoCa, ca.ThoiGianDongCa, ca.TienMatDauCa,
                            ca.TongThuHoaDon, ca.TongThuLatVat, ca.TongChiLatVat, ca.TienMatThucTe, ca.ChenhLech,
                            ca.TrangThaiCa, ca.GhiChuChenhLech
                       FROM CaThuNgan ca JOIN NhanVien nv ON nv.MaNV = ca.MaNV
                      WHERE COALESCE(ca.TenantId, 'DEFAULT') = $3
                        AND ca.ThoiGianMoCa >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                        AND ca.ThoiGianMoCa < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                      ORDER BY ca.ThoiGianMoCa DESC`,
                    [tuNgay, denNgay, tenantId]
                );
                return r.rows;
            }
        });
        const so = (v) => (v === null || v === undefined ? null : Number(v));
        res.json(rows.map((c) => ({
            maCaThuNgan: c.macathungan,
            maNV: c.manv,
            tenNV: c.tennv,
            thoiGianMoCa: c.thoigianmoca,
            thoiGianDongCa: c.thoigiandongca,
            tienMatDauCa: so(c.tienmatdauca),
            tongThuHoaDon: so(c.tongthuhoadon),
            tongThuLatVat: so(c.tongthulatvat),
            tongChiLatVat: so(c.tongchilatvat),
            tongRutKet: so(c.tongrutket) || 0,
            tienMatThucTe: so(c.tienmatthucte),
            chenhLech: so(c.chenhlech),
            trangThaiCa: c.trangthaica,
            ghiChuChenhLech: c.ghichuchenhlech || null,
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách ca:');
    }
});

// ==========================================
// PHÂN HỆ: PHA CHẾ (BARISTA) — TELEMETRY 3 MỐC & EXPO ALL_STATIONS_READY
// ==========================================
async function doiTrangThaiMon(maCTHD, tuTrangThai, denTrangThai, tenantId = 'DEFAULT', maNV = null) {
    return pool.withTenant(tenantId, async (client) => {
        let r;
        await client.query('SAVEPOINT sp_doi_tt_mon');
        try {
            let setExtraSql = '';
            const params = [maCTHD, denTrangThai, tuTrangThai, tenantId];
            if (denTrangThai === 'DangLam') {
                params.push(maNV || null);
                setExtraSql = ', ThoiGianBatDauLam = COALESCE(ThoiGianBatDauLam, now()), MaNVPhaChe = COALESCE(MaNVPhaChe, $5), ThoiGianXong = NULL';
            } else if (denTrangThai === 'DaXong') {
                params.push(maNV || null);
                setExtraSql = ', ThoiGianBatDauLam = COALESCE(ThoiGianBatDauLam, now()), MaNVPhaChe = COALESCE(MaNVPhaChe, $5), ThoiGianXong = now()';
            } else if (denTrangThai === 'DaPhucVu') {
                setExtraSql = ', ThoiGianPhucVu = now()';
            }
            r = await client.query(
                `UPDATE ChiTietHoaDon c SET TrangThaiPhaChe = $2${setExtraSql}
                   FROM HoaDon hd
                  WHERE c.MaCTHD = $1
                    AND hd.MaHoaDon = c.MaHoaDon
                    AND COALESCE(hd.TenantId, 'DEFAULT') = $4
                    AND hd.TrangThaiTT IN (0, 1)
                    AND COALESCE(to_jsonb(c)->>'firestatus', 'FIRED') = 'FIRED'
                    AND c.TrangThaiPhaChe = ANY($3::varchar[])
                  RETURNING c.MaCTHD`,
                params
            );
            await client.query('RELEASE SAVEPOINT sp_doi_tt_mon');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_doi_tt_mon').catch(() => {});
            r = await client.query(
                `UPDATE ChiTietHoaDon c SET TrangThaiPhaChe = $2
                   FROM HoaDon hd
                  WHERE c.MaCTHD = $1
                    AND hd.MaHoaDon = c.MaHoaDon
                    AND COALESCE(hd.TenantId, 'DEFAULT') = $4
                    AND hd.TrangThaiTT IN (0, 1)
                    AND COALESCE(to_jsonb(c)->>'firestatus', 'FIRED') = 'FIRED'
                    AND c.TrangThaiPhaChe = ANY($3::varchar[])
                  RETURNING c.MaCTHD`,
                [maCTHD, denTrangThai, tuTrangThai, tenantId]
            );
        }
        if (r.rows.length === 0) {
            const t = await client.query(
                `SELECT c.TrangThaiPhaChe
                   FROM ChiTietHoaDon c
                   JOIN HoaDon hd ON hd.MaHoaDon = c.MaHoaDon
                  WHERE c.MaCTHD = $1 AND COALESCE(hd.TenantId, 'DEFAULT') = $2`,
                [maCTHD, tenantId]
            );
            if (t.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy món này!');
            throw new LoiNghiepVu(
                409,
                `Món này đang ở trạng thái "${t.rows[0].trangthaiphache}", không thể chuyển sang "${denTrangThai}"!`,
                { trangThaiHienTai: t.rows[0].trangthaiphache }
            );
        }
        const [mon] = await layMonTheoMa(client, [maCTHD]);
        return mon;
    });
}

// Kiểm tra xem 100% các món của (maHoaDon, dotGoi) trên tất cả các trạm đã xong chưa -> phát ORDER_ALL_READY tới Expo & Phục vụ!
async function kiemTraVaPhatAllStationsReady(mon, tenantId = 'DEFAULT') {
    if (!mon?.maHoaDon) return { allReady: false };
    const bId = normalizeBranchId(mon.branchId || 'DEFAULT');
    const dotGoi = Number(mon.dotGoi || 1);

    const check = await pool.withTenant(tenantId, async (client) => {
        const res = await client.query(
            `SELECT COUNT(*) FILTER (WHERE TrangThaiPhaChe <> 'DaHuy') AS total_cnt,
                    COUNT(*) FILTER (WHERE TrangThaiPhaChe IN ('DaXong', 'DaPhucVu')) AS done_cnt
               FROM ChiTietHoaDon
              WHERE MaHoaDon = $1
                AND COALESCE((to_jsonb(ChiTietHoaDon)->>'dotgoi')::int, 1) = $2
                AND COALESCE(to_jsonb(ChiTietHoaDon)->>'firestatus', 'FIRED') = 'FIRED'`,
            [mon.maHoaDon, dotGoi]
        );
        const totalCnt = Number(res.rows[0]?.total_cnt || 0);
        const doneCnt = Number(res.rows[0]?.done_cnt || 0);
        if (totalCnt > 0 && doneCnt === totalCnt) {
            const payload = {
                maHoaDon: mon.maHoaDon,
                dotGoi,
                soThuTuNgay: mon.soThuTuNgay,
                soThuTuHienThi: mon.soThuTuHienThi,
                soTheRung: mon.soTheRung,
                tenBan: mon.tenBan,
                mangDi: mon.mangDi,
                totalItems: totalCnt,
                allStationsReady: true,
                completedAt: new Date().toISOString(),
            };
            const logInfo = await insertKdsEventLog(client, {
                tenantId,
                branchId: bId,
                station: 'ALL',
                eventType: 'ORDER_ALL_READY',
                maHoaDon: mon.maHoaDon,
                payload,
            });
            return { allReady: true, seq: logInfo.seq, payload };
        }
        return { allReady: false };
    });

    if (check.allReady) {
        emitScopedKdsEvent(io, {
            tenantId,
            branchId: bId,
            station: 'ALL',
            seq: check.seq,
            eventType: 'ORDER_ALL_READY',
            socketEvents: ['ORDER_ALL_READY', 'expo:order_all_ready'],
            payload: check.payload,
            includeExpo: true,
            includeWaiter: true,
            includePos: true,
            legacyBaristaEvent: 'ORDER_ALL_READY',
            legacyWaiterEvent: 'ORDER_ALL_READY',
        });
    }
    return check;
}

app.get('/api/order/dangcho', kiemTraToken, choPhepVaiTro(2, 1), async (req, res) => {
    const tId = layTenantId(req);
    const tramFilter = String(req.query.tram || '').trim().toUpperCase();
    try {
        const list = await pool.withTenant(tId, (client) => layMonTheoTrangThai(client, ['ChoPhaChe', 'DangLam'], tId));
        if (TRAM_CHE_BIEN_HOP_LE.includes(tramFilter)) {
            return res.json(list.filter((m) => m.tramCheBien === tramFilter));
        }
        res.json(list);
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Món đang chờ:');
    }
});

// [P1 - KDS Recall] Danh sách món vừa trả trong 15 phút gần nhất để Barista hoàn tác khi lỡ bấm nhầm
app.get('/api/order/vua-tra', kiemTraToken, choPhepVaiTro(2, 1), async (req, res) => {
    const tId = layTenantId(req);
    try {
        const rows = await pool.withTenant(tId, async (client) => {
            const r = await client.query(
                `${SQL_MON_PHA_CHE}
                 JOIN HoaDon hd ON hd.MaHoaDon = cthd.MaHoaDon
                 WHERE cthd.TrangThaiPhaChe = 'DaXong'
                   AND COALESCE(hd.TenantId, 'DEFAULT') = $1
                   AND COALESCE(cthd.ThoiGianXong, cthd.ThoiGianGoi) >= now() - interval '15 minutes'
                 ORDER BY COALESCE(cthd.ThoiGianXong, cthd.ThoiGianGoi) DESC
                 LIMIT 40`,
                [tId]
            );
            return r.rows.map(mapMonPhaChe);
        });
        res.json(rows);
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lịch sử vừa trả (KDS Recall):');
    }
});

// [L2.2] KDS Recall (/api/kds/recall/:maCTHD & /api/order/hoantac-tramon) đã được hợp nhất về modules/kdsPhase2Routes.js (giới hạn 15 phút + kds_event_log + emit 3 tầng).

app.put('/api/order/danglam', kiemTraToken, choPhepVaiTro(2, 1), async (req, res) => {
    const { maCTHD } = req.body || {};
    const tId = layTenantId(req);
    if (!maCTHD) return res.status(400).json({ message: 'Thiếu mã chi tiết hóa đơn (maCTHD)!' });
    try {
        const mon = await doiTrangThaiMon(maCTHD, ['ChoPhaChe'], 'DangLam', tId, req.user.maNV);
        const bId = normalizeBranchId(mon.branchId || 'DEFAULT');
        const logInfo = await pool.withTenant(tId, (client) =>
            insertKdsEventLog(client, {
                tenantId: tId,
                branchId: bId,
                station: mon.tramCheBien,
                eventType: 'STATUS_CHANGE',
                maHoaDon: mon.maHoaDon,
                payload: { trangThai: 'DangLam', mon },
            })
        );
        emitScopedKdsEvent(io, {
            tenantId: tId,
            branchId: bId,
            station: mon.tramCheBien,
            seq: logInfo.seq,
            eventType: 'STATUS_CHANGE',
            socketEvents: ['MON_DANG_LAM'],
            payload: mon,
            includeExpo: true,
            legacyBaristaEvent: 'MON_DANG_LAM',
        });
        res.json({ message: 'Đã nhận làm món!', mon, seq: logInfo.seq });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Nhận làm món:');
    }
});

app.put('/api/order/tramon', kiemTraToken, choPhepVaiTro(2, 1), async (req, res) => {
    const { maCTHD } = req.body || {};
    const tId = layTenantId(req);
    if (!maCTHD) return res.status(400).json({ message: 'Thiếu mã chi tiết hóa đơn (maCTHD)!' });
    try {
        const mon = await doiTrangThaiMon(maCTHD, ['ChoPhaChe', 'DangLam'], 'DaXong', tId, req.user.maNV);
        const bId = normalizeBranchId(mon.branchId || 'DEFAULT');
        const logInfo = await pool.withTenant(tId, (client) =>
            insertKdsEventLog(client, {
                tenantId: tId,
                branchId: bId,
                station: mon.tramCheBien,
                eventType: 'STATUS_CHANGE',
                maHoaDon: mon.maHoaDon,
                payload: { trangThai: 'DaXong', mon },
            })
        );
        emitScopedKdsEvent(io, {
            tenantId: tId,
            branchId: bId,
            station: mon.tramCheBien,
            seq: logInfo.seq,
            eventType: 'STATUS_CHANGE',
            socketEvents: ['MON_DA_XONG'],
            payload: mon,
            includeExpo: true,
            includeWaiter: true,
            legacyBaristaEvent: 'MON_DA_XONG',
            legacyWaiterEvent: 'MON_DA_XONG',
        });
        const readyCheck = await kiemTraVaPhatAllStationsReady(mon, tId);
        res.json({
            message: 'Đã báo trả món thành công!',
            maHoaDon: mon.maHoaDon,
            mon,
            allStationsReady: Boolean(readyCheck.allReady),
            seq: logInfo.seq,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Trả món:');
    }
});

app.get('/api/order/chophucvu', kiemTraToken, choPhepVaiTro(3, 1), async (req, res) => {
    const tId = layTenantId(req);
    try {
        res.json(await pool.withTenant(tId, (client) => layMonTheoTrangThai(client, ['DaXong'], tId)));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Món chờ phục vụ:');
    }
});

app.put('/api/order/phucvu', kiemTraToken, choPhepVaiTro(3, 1), async (req, res) => {
    const { maCTHD } = req.body || {};
    const tId = layTenantId(req);
    if (!maCTHD) return res.status(400).json({ message: 'Thiếu mã chi tiết hóa đơn (maCTHD)!' });
    try {
        const mon = await doiTrangThaiMon(maCTHD, ['DaXong'], 'DaPhucVu', tId, req.user.maNV);
        const bId = normalizeBranchId(mon.branchId || 'DEFAULT');
        emitScopedKdsEvent(io, {
            tenantId: tId,
            branchId: bId,
            station: mon.tramCheBien,
            eventType: 'STATUS_CHANGE',
            socketEvents: ['MON_DA_PHUC_VU'],
            payload: mon,
            includeExpo: true,
            includeWaiter: true,
            legacyWaiterEvent: 'MON_DA_PHUC_VU',
        });
        res.json({ message: 'Đã xác nhận phục vụ món!', mon });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Phục vụ món:');
    }
});

// ==========================================
// PHÂN HỆ: QUẢN TRỊ & KHO BÃI (PHÂN HỆ 4 - 100/100: SINGLE-SOURCE TONKHOCHINHANH, SAFE WAC + LANDED COST, FEFO, PRICE SPIKE & PERIOD LOCK)
// ==========================================
app.post('/api/kho/nhap', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const {
        ghiChu,
        branchId: rawBranchId = null,
        ngayChungTu = null,
        chiPhiVanChuyen = 0,
        giamGiaNCC = 0,
        maNCC = null,
        maPO = null,
        danhSachNguyenLieu,
    } = req.body || {};
    const maNV = req.user.maNV;
    const tenantId = layTenantId(req);

    if (!Array.isArray(danhSachNguyenLieu) || danhSachNguyenLieu.length === 0) {
        return res.status(400).json({ message: 'Danh sách nguyên liệu nhập không được để trống!' });
    }
    for (const item of danhSachNguyenLieu) {
        if (!item || !item.maNL || !(Number(item.soLuong) > 0) || !(Number(item.donGiaNhap) >= 0)) {
            return res.status(400).json({ message: 'Mỗi dòng nhập kho phải có maNL, soLuong > 0 và donGiaNhap >= 0!' });
        }
    }

    try {
        const ketQuaNhap = await chayGiaoDich(async (client) => {
            const targetBranch = normalizeInventoryBranch(tenantId, rawBranchId || req.user.branchId || null);
            const docDate = await assertPeriodNotLocked(client, tenantId, targetBranch, ngayChungTu, LoiNghiepVu);

            const sorted = [...danhSachNguyenLieu].sort((a, b) => String(a.maNL).localeCompare(String(b.maNL)));
            const { branchId, stockMap } = await lockBranchStockOrdered(
                client,
                tenantId,
                targetBranch,
                sorted.map((x) => x.maNL)
            );

            // Chuẩn hóa tiền hàng & phân bổ Landed Cost (cước xe lạnh / phí ship / giảm giá NCC)
            const prepared = sorted.map((item) => {
                const heSo = Number(item.heSoQuyDoi) > 0 ? Number(item.heSoQuyDoi) : 1;
                const slNhapGoc = Number(item.soLuong);
                const donGiaGoc = Number(item.donGiaNhap);
                const soLuongBase = lam3(slNhapGoc * heSo);
                // Hỗ trợ cả 2 cách truyền: donGiaNhap là giá theo đơn vị nhập (VD: 360.000đ/Thùng)
                const tongTienHang = lam2(slNhapGoc * donGiaGoc);
                return { item, heSo, slNhapGoc, donGiaGoc, soLuongBase, tongTienHang };
            });
            const landedAlloc = allocateLandedCost(prepared, chiPhiVanChuyen, giamGiaNCC);

            const caMo = await layCaDangMo(client, 'SHARE', tenantId, { branchId });
            const phieuResult = await client.query(
                `INSERT INTO PhieuGiaoDichKho
                    (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan, ChiPhiVanChuyen, GiamGiaNhaCC, MaNCC, MaPO, NgayChungTu, TrangThaiDuyet)
                 VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, 'POSTED')
                 RETURNING MaGiaoDich`,
                [
                    maNV,
                    ghiChu || 'Nhập kho nguyên liệu',
                    tenantId,
                    branchId,
                    caMo ? String(caMo.macathungan) : null,
                    lam2(chiPhiVanChuyen),
                    lam2(giamGiaNCC),
                    maNCC || null,
                    maPO || null,
                    docDate,
                ]
            );
            const maGD = phieuResult.rows[0].magiaodich;

            let totalCogsAdjustment = 0;
            const lineResults = [];
            const priceSpikeAlerts = [];
            const createdLots = [];

            for (let i = 0; i < prepared.length; i++) {
                const { item, heSo, slNhapGoc, soLuongBase, tongTienHang } = prepared[i];
                const st = stockMap.get(item.maNL);
                if (!st) {
                    throw new LoiNghiepVu(404, `Không tìm thấy nguyên liệu ${item.maNL}!`);
                }

                const chiPhiPhanBo = item.chiPhiPhanBo !== undefined ? lam2(item.chiPhiPhanBo) : landedAlloc[i] || 0;
                const tonTruoc = st.soLuongTon;
                const giaVonTruoc = st.giaVonDonVi;

                // Safe WAC chống bùng nổ/âm khi tồn kho trước đó < 0 + tính cogsAdjustment!
                const wac = computeSafeWacOnStockIn({
                    tonCu: tonTruoc,
                    giaVonCu: giaVonTruoc,
                    slNhapBase: soLuongBase,
                    tongTienHang,
                    chiPhiPhanBo,
                });
                totalCogsAdjustment = lam2(totalCogsAdjustment + wac.cogsAdjustment);
                if (Math.abs(wac.cogsAdjustment) >= 0.01) {
                    await recordCogsAdjustment(client, {
                        tenantId,
                        branchId,
                        businessDate: ngayChungTu || todayDateVN(),
                        maNL: item.maNL,
                        sourceType: 'NEGATIVE_STOCK_CATCHUP',
                        refMaGiaoDich: maGD,
                        qtyAffected: Math.min(Math.abs(tonTruoc), soLuongBase),
                        oldUnitCost: giaVonTruoc,
                        newUnitCost: wac.donGiaNhapThucTe,
                        adjustmentAmount: wac.cogsAdjustment,
                        createdBy: req.user.maNV,
                    });
                }
                const tonSau = lam3(tonTruoc + soLuongBase);

                const moTaDonVi =
                    heSo !== 1 && item.donViNhap
                        ? `${slNhapGoc} ${item.donViNhap} (x${heSo} = ${soLuongBase} ${st.donViTinh}) • ${item.tinhTrang || 'Tốt'}`
                        : item.tinhTrang || 'Tốt';

                await insertLedgerLine(client, {
                    maGiaoDich: maGD,
                    maNL: item.maNL,
                    soLuong: soLuongBase,
                    donGiaNhap: wac.donGiaNhapThucTe,
                    tinhTrang: moTaDonVi,
                    tonTruoc,
                    tonSau,
                    giaVonTruoc,
                    giaVonSau: wac.giaVonMoi,
                    donViNhap: item.donViNhap || st.donViTinh,
                    heSoQuyDoi: heSo,
                    soLuongTheoDonVi: slNhapGoc,
                    chiPhiPhanBo,
                });

                await updateBranchStockRow(client, {
                    tenantId,
                    branchId,
                    maNL: item.maNL,
                    nextQty: tonSau,
                    nextWac: wac.giaVonMoi,
                });

                // Cập nhật stockMap trong bộ nhớ nếu cùng phiếu có 2 dòng trùng MaNL
                st.soLuongTon = tonSau;
                st.giaVonDonVi = wac.giaVonMoi;

                // Tạo Lô FEFO nếu có ngày hết hạn (hanSuDung / thoiGianHetHan) hoặc bật TheoDoiHanDung
                const expiryVal = item.thoiGianHetHan || item.hanSuDung || null;
                if (expiryVal || item.maLo || st.theoDoiHanDung) {
                    const lot = await createFefoLot(client, {
                        tenantId,
                        branchId,
                        maNL: item.maNL,
                        maLo: item.maLo || null,
                        nguonLo: 'PURCHASE',
                        maGiaoDichNguon: String(maGD),
                        soLuong: soLuongBase,
                        giaVonLo: wac.donGiaNhapThucTe,
                        thoiGianHetHan: expiryVal,
                    });
                    if (lot) createdLots.push(lot);
                }

                // Kiểm tra Cảnh báo Tăng giá nhập >= +5% & Xói mòn biên lợi nhuận món!
                const spike = await detectPriceSpikeAndMarginImpact(client, {
                    tenantId,
                    branchId,
                    maNL: item.maNL,
                    tenNL: st.tenNL,
                    donViTinh: st.donViTinh,
                    newUnitCost: wac.donGiaNhapThucTe,
                    excludeMaGD: maGD,
                });
                if (spike) priceSpikeAlerts.push(spike);

                lineResults.push({
                    maNL: item.maNL,
                    soLuongBase,
                    tonTruoc,
                    tonSau,
                    giaVonTruoc,
                    donGiaNhapThucTe: wac.donGiaNhapThucTe,
                    giaVonMoi: wac.giaVonMoi,
                    chiPhiPhanBo,
                    cogsAdjustment: wac.cogsAdjustment,
                });
            }

            if (totalCogsAdjustment !== 0) {
                await client.query(
                    `UPDATE public.phieugiaodichkho SET cogsadjustment = $2::numeric WHERE magiaodich = $1`,
                    [maGD, totalCogsAdjustment]
                );
            }

            // [Phân hệ 2 - Smart Auto Un-86] Tự mở khóa các món/topping/modifier/combo đã bị khóa tự động khi nhập đủ hàng!
            const autoUnlocked = await autoUn86OnRestock(client, {
                tenantId,
                maNLList: sorted.map((it) => it.maNL),
            });

            await ghiAuditLog(client, {
                tenantId,
                maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'INVENTORY_STOCK_IN',
                doiTuong: 'KHO',
                maDoiTuong: maGD,
                giaTriMoi: {
                    branchId,
                    soDong: sorted.length,
                    chiPhiVanChuyen: lam2(chiPhiVanChuyen),
                    giamGiaNCC: lam2(giamGiaNCC),
                    cogsAdjustment: totalCogsAdjustment,
                    priceSpikeAlertsCount: priceSpikeAlerts.length,
                    ghiChu,
                    autoUnlocked,
                },
                ip: req.ip,
                batBuoc: true,
            });
            return {
                maGiaoDich: maGD,
                branchId,
                cogsAdjustment: totalCogsAdjustment,
                lineResults,
                createdLots,
                priceSpikeAlerts,
                autoUnlocked,
            };
        }, tenantId);

        const { maGiaoDich, branchId, cogsAdjustment, lineResults, createdLots, priceSpikeAlerts, autoUnlocked } = ketQuaNhap;
        if (
            autoUnlocked &&
            (autoUnlocked.unlockedProducts.length > 0 ||
                autoUnlocked.unlockedToppings.length > 0 ||
                autoUnlocked.unlockedModifiers.length > 0 ||
                autoUnlocked.unlockedCombos.length > 0)
        ) {
            io.to(roomTen(tenantId, 'thungan'))
                .to(roomTen(tenantId, 'phucvu'))
                .to(roomTen(tenantId, 'barista'))
                .emit('menu:86_updated', { type: 'AUTO_UN86_RESTOCK', ...autoUnlocked });
            for (const p of autoUnlocked.unlockedProducts) {
                io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).to(roomTen(tenantId, 'barista')).emit('THUC_DON_THAY_DOI', p);
            }
        }

        res.json({
            message: 'Nhập kho & cập nhật giá vốn bình quân an toàn (Safe WAC) thành công!',
            maGiaoDich,
            branchId,
            cogsAdjustment,
            lineResults,
            createdLots,
            priceSpikeAlerts,
            autoUnlocked,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Nhập kho:');
    }
});

// [P1] Tạo nguyên liệu mới từ giao diện Admin (cô lập theo TenantId)
app.post('/api/kho/nguyenlieu', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { maNL, tenNL, donViTinh, hanMucCanhBao = 0, giaVonDonVi = 0 } = req.body || {};
    const tenantId = layTenantId(req);
    const prefix = req.user.maTienTo && tenantId !== 'DEFAULT' ? `${req.user.maTienTo}_` : '';
    const rawMa = String(maNL || '').trim().toUpperCase();
    const ma = rawMa.startsWith(prefix) ? rawMa : `${prefix}${rawMa}`;
    const ten = String(tenNL || '').trim();
    const dvt = String(donViTinh || '').trim();
    if (!rawMa || !ten || !dvt) {
        return res.status(400).json({ message: 'Vui lòng nhập đủ mã NL, tên nguyên liệu và đơn vị tính!' });
    }
    try {
        await qTenant(
            req,
            `INSERT INTO NguyenLieu (MaNL, TenNL, DonViTinh, SoLuongTon, HanMucCanhBao, GiaVonDonVi, DaXoa, TenantId)
             VALUES ($1, $2, $3, 0, $4, $5, FALSE, $6)`,
            [ma, ten, dvt, Math.max(0, Number(hanMucCanhBao) || 0), Math.max(0, Number(giaVonDonVi) || 0), tenantId]
        );
        res.status(201).json({ message: `Đã thêm nguyên liệu "${ten}" thành công!`, maNL: ma });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `Mã nguyên liệu ${ma} đã tồn tại!` });
        guiLoi(res, error, 'Lỗi API Tạo nguyên liệu:');
    }
});

// [P1 + P4 - UoM] Danh sách quy đổi đơn vị tính kho (Thùng -> Lon -> ml/g + Barcode) của Tenant
app.get('/api/kho/quydoi', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const r = await qTenant(
            req,
            `SELECT q.Id, q.MaNL, nl.TenNL, nl.DonViTinh AS DonViGoc, q.TenDonVi, q.HeSoQuyDoi,
                    to_jsonb(q)->>'mavachdonvi' AS MaVachDonVi,
                    COALESCE((to_jsonb(q)->>'lamacdinhnhap')::boolean, FALSE) AS LaMacDinhNhap,
                    COALESCE((to_jsonb(q)->>'lamacdinhkiem')::boolean, FALSE) AS LaMacDinhKiem
               FROM NguyenLieu_DonViQuyDoi q
               JOIN NguyenLieu nl ON nl.MaNL = q.MaNL AND COALESCE(nl.TenantId, 'DEFAULT') = $1
              WHERE q.TenantId = $1
              ORDER BY nl.TenNL, q.HeSoQuyDoi DESC`,
            [tenantId]
        );
        res.json(r.rows.map((row) => ({
            id: row.id,
            maNL: row.manl,
            tenNL: row.tennl,
            donViGoc: row.donvigoc,
            tenDonVi: row.tendonvi,
            heSoQuyDoi: Number(row.hesoquydoi),
            maVachDonVi: row.mavachdonvi || null,
            laMacDinhNhap: Boolean(row.lamacdinhnhap),
            laMacDinhKiem: Boolean(row.lamacdinhkiem),
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lấy quy đổi đơn vị kho:');
    }
});

// [P1 + P4 - UoM] Thêm/Cập nhật quy đổi đơn vị cho 1 nguyên liệu (VD: 1 Thùng = 12000 ml + Mã vạch riêng)
app.post('/api/kho/quydoi', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('inventory_bom'), async (req, res) => {
    const tenantId = layTenantId(req);
    const { maNL, tenDonVi, heSoQuyDoi, maVachDonVi = null, laMacDinhNhap = false, laMacDinhKiem = false } = req.body || {};
    const tenDV = String(tenDonVi || '').trim().slice(0, 32);
    const heSo = Number(heSoQuyDoi);
    const cleanBarcode = maVachDonVi && String(maVachDonVi).trim() ? String(maVachDonVi).trim().slice(0, 64) : null;
    if (!maNL || !tenDV || !(heSo > 0)) {
        return res.status(400).json({ message: 'Vui lòng nhập đủ nguyên liệu, tên đơn vị (VD: Thùng/Hộp/Kg) và hệ số quy đổi > 0!' });
    }
    try {
        const out = await pool.withTenant(tenantId, async (client) => {
            const own = await client.query(
                "SELECT TenNL, DonViTinh FROM NguyenLieu WHERE MaNL = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
                [maNL, tenantId]
            );
            if (own.rows.length === 0) return null;

            const r = await client.query(
                `INSERT INTO NguyenLieu_DonViQuyDoi (TenantId, MaNL, TenDonVi, HeSoQuyDoi, MaVachDonVi, LaMacDinhNhap, LaMacDinhKiem)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (TenantId, MaNL, TenDonVi)
                 DO UPDATE SET HeSoQuyDoi = EXCLUDED.HeSoQuyDoi,
                               MaVachDonVi = COALESCE(EXCLUDED.MaVachDonVi, NguyenLieu_DonViQuyDoi.MaVachDonVi),
                               LaMacDinhNhap = EXCLUDED.LaMacDinhNhap,
                               LaMacDinhKiem = EXCLUDED.LaMacDinhKiem
                 RETURNING Id`,
                [tenantId, maNL, tenDV, heSo, cleanBarcode, Boolean(laMacDinhNhap), Boolean(laMacDinhKiem)]
            );
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'UOM_UPDATED',
                doiTuong: 'NGUYENLIEU',
                maDoiTuong: maNL,
                giaTriMoi: { tenDonVi: tenDV, heSoQuyDoi: heSo, maVachDonVi: cleanBarcode, donViGoc: own.rows[0].donvitinh },
                ip: req.ip,
            });
            return { id: r.rows[0].id, nl: own.rows[0] };
        });
        if (!out) return res.status(404).json({ message: 'Không tìm thấy nguyên liệu thuộc quán này!' });
        res.status(201).json({
            message: `Đã lưu quy đổi: 1 ${tenDV} = ${heSo} ${out.nl.donvitinh} (${out.nl.tennl})!`,
            id: out.id,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lưu quy đổi đơn vị:');
    }
});

app.delete('/api/kho/quydoi/:id', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const r = await qTenant(
            req,
            'DELETE FROM NguyenLieu_DonViQuyDoi WHERE Id = $1 AND TenantId = $2 RETURNING Id',
            [req.params.id, tenantId]
        );
        if (r.rows.length === 0) return res.status(404).json({ message: 'Không tìm thấy quy đổi đơn vị!' });
        res.json({ message: 'Đã xóa quy đổi đơn vị tính!' });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Xóa quy đổi đơn vị:');
    }
});

// [P1 - Topping BOM] Quản lý danh sách Topping kèm Công thức đa nguyên liệu & Giá vốn
app.get('/api/topping/quanly', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const { tpRes, bomRes } = await pool.withTenant(tenantId, async (client) => {
            const tpR = await client.query(
                `SELECT tp.MaTopping, tp.TenTopping, tp.GiaTopping, tp.MaNL, tp.KhoiLuongTieuHao,
                        tp.DangKinhDoanh, COALESCE(tp.TamHet, FALSE) AS TamHet,
                        nl.TenNL AS LegacyTenNL, nl.DonViTinh AS LegacyDVT, COALESCE(nl.GiaVonDonVi, 0) AS LegacyGiaVon
                   FROM Topping tp
                   LEFT JOIN NguyenLieu nl ON nl.MaNL = tp.MaNL
                  WHERE COALESCE(tp.TenantId, 'DEFAULT') = $1
                  ORDER BY tp.TenTopping`,
                [tenantId]
            );
            let bomR = { rows: [] };
            try {
                await client.query('SAVEPOINT sp_tp_bom_list');
                bomR = await client.query(
                    `SELECT tc.MaTopping, tc.MaNL, nl.TenNL, nl.DonViTinh,
                            tc.KhoiLuongTieuHao, COALESCE(nl.GiaVonDonVi, 0) AS GiaVonDonVi
                       FROM Topping_CongThuc tc
                       JOIN NguyenLieu nl ON nl.MaNL = tc.MaNL
                      WHERE tc.TenantId = $1
                      ORDER BY nl.TenNL`,
                    [tenantId]
                );
                await client.query('RELEASE SAVEPOINT sp_tp_bom_list');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_tp_bom_list').catch(() => {});
            }
            return { tpRes: tpR, bomRes: bomR };
        });

        const bomMap = new Map();
        for (const r of bomRes.rows) {
            if (!bomMap.has(r.matopping)) bomMap.set(r.matopping, []);
            bomMap.get(r.matopping).push({
                maNL: r.manl,
                tenNL: r.tennl,
                donViTinh: r.donvitinh,
                khoiLuongTieuHao: Number(r.khoiluongtieuhao),
                giaVonDonVi: Number(r.giavondonvi),
            });
        }

        res.json(tpRes.rows.map((row) => {
            let congThuc = bomMap.get(row.matopping) || [];
            if (congThuc.length === 0 && row.manl && Number(row.khoiluongtieuhao) > 0) {
                congThuc = [{
                    maNL: row.manl,
                    tenNL: row.legacytennl || row.manl,
                    donViTinh: row.legacydvt || '',
                    khoiLuongTieuHao: Number(row.khoiluongtieuhao),
                    giaVonDonVi: Number(row.legacygiavon || 0),
                }];
            }
            const giaVon = Math.round(congThuc.reduce((s, c) => s + c.khoiLuongTieuHao * c.giaVonDonVi, 0));
            const giaBan = Number(row.giatopping || 0);
            const tySuat = giaBan > 0 ? Math.round(((giaBan - giaVon) / giaBan) * 1000) / 10 : 0;
            return {
                maTopping: row.matopping,
                tenTopping: row.tentopping,
                giaTopping: giaBan,
                dangKinhDoanh: row.dangkinhdoanh !== false,
                tamHet: Boolean(row.tamhet),
                giaVon,
                tySuatLoiNhuan: tySuat,
                congThuc,
            };
        }));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Quản lý Topping:');
    }
});

app.post('/api/topping', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    const {
        maTopping,
        tenTopping,
        giaTopping,
        maNL = null,
        khoiLuongTieuHao = 0,
        toiDaMoiLy = 3,
        giaBacThang = null,
    } = req.body || {};
    const prefix = req.user.maTienTo && tenantId !== 'DEFAULT' ? `${req.user.maTienTo}_` : '';
    const rawMa = String(maTopping || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const ma = rawMa.startsWith(prefix) ? rawMa : `${prefix}${rawMa}`;
    const ten = String(tenTopping || '').trim();
    const gia = Math.max(0, Number(giaTopping) || 0);
    if (!rawMa || ten.length < 2) {
        return res.status(400).json({ message: 'Vui lòng nhập mã topping và tên topping hợp lệ!' });
    }
    try {
        await qTenant(
            req,
            `INSERT INTO Topping (MaTopping, TenTopping, GiaTopping, MaNL, KhoiLuongTieuHao, DangKinhDoanh, TamHet, TenantId, ToiDaMoiLy, GiaBacThang)
             VALUES ($1, $2, $3, $4, $5, TRUE, FALSE, $6, $7, $8::jsonb)`,
            [
                ma,
                ten,
                gia,
                maNL ? String(maNL).trim() : null,
                Math.max(0, Number(khoiLuongTieuHao) || 0),
                tenantId,
                Math.max(1, Math.floor(Number(toiDaMoiLy || 3))),
                Array.isArray(giaBacThang) ? JSON.stringify(giaBacThang) : null,
            ]
        );
        io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'barista')).emit('TOPPING_THAY_DOI', {
            maTopping: ma,
            tenTopping: ten,
            tamHet: false,
        });
        res.status(201).json({ message: `Đã thêm topping "${ten}" thành công!`, maTopping: ma });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `Mã topping ${ma} đã tồn tại!` });
        guiLoi(res, error, 'Lỗi API Thêm Topping:');
    }
});

app.post('/api/topping/:maTopping/congthuc', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('inventory_bom'), async (req, res) => {
    const tenantId = layTenantId(req);
    const { maTopping } = req.params;
    const { dinhMuc = [] } = req.body || {};
    if (!Array.isArray(dinhMuc)) {
        return res.status(400).json({ message: 'dinhMuc phải là danh sách nguyên liệu!' });
    }
    try {
        await chayGiaoDich(async (client) => {
            const ownTp = await client.query(
                "SELECT MaTopping, TenTopping FROM Topping WHERE MaTopping = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
                [maTopping, tenantId]
            );
            if (ownTp.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy topping thuộc quán này!');

            const validRows = dinhMuc.filter((d) => d && d.maNL && Number(d.khoiLuongTieuHao) > 0);
            if (validRows.length > 0) {
                const nlIds = [...new Set(validRows.map((d) => d.maNL))];
                const ownNl = await client.query(
                    "SELECT MaNL FROM NguyenLieu WHERE MaNL = ANY($1::varchar[]) AND COALESCE(TenantId, 'DEFAULT') = $2",
                    [nlIds, tenantId]
                );
                if (ownNl.rows.length !== nlIds.length) {
                    throw new LoiNghiepVu(400, 'Có nguyên liệu không thuộc quán hiện tại!');
                }
            }

            await client.query('DELETE FROM Topping_CongThuc WHERE TenantId = $1 AND MaTopping = $2', [tenantId, maTopping]);
            for (const row of validRows) {
                await client.query(
                    `INSERT INTO Topping_CongThuc (TenantId, MaTopping, MaNL, KhoiLuongTieuHao)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (TenantId, MaTopping, MaNL)
                     DO UPDATE SET KhoiLuongTieuHao = EXCLUDED.KhoiLuongTieuHao`,
                    [tenantId, maTopping, row.maNL, Number(row.khoiLuongTieuHao)]
                );
            }

            // Đồng bộ luôn nguyên liệu đầu tiên vào cột legacy để tương thích hoàn toàn
            const first = validRows[0] || null;
            await client.query(
                'UPDATE Topping SET MaNL = $2, KhoiLuongTieuHao = $3 WHERE MaTopping = $1',
                [maTopping, first ? first.maNL : null, first ? Number(first.khoiLuongTieuHao) : 0]
            );

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'TOPPING_BOM_UPDATED',
                doiTuong: 'TOPPING',
                maDoiTuong: maTopping,
                giaTriMoi: validRows,
                ip: req.ip,
                batBuoc: true,
            });
        }, tenantId);

        res.json({ message: `Đã lưu định lượng BOM cho topping ${maTopping}!` });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lưu công thức Topping:');
    }
});

app.get('/api/kho/canhbao', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    const branchId = normalizeInventoryBranch(tenantId, req.query.branchId || req.user.branchId || null);
    const isMain = branchId === `${tenantId}_MAIN`;
    try {
        const result = await qTenant(
            req,
            `SELECT nl.MaNL, nl.TenNL, nl.DonViTinh,
                    COALESCE(tk.SoLuongTon, CASE WHEN $3::boolean THEN nl.SoLuongTon ELSE 0 END, 0) AS SoLuongTon,
                    COALESCE(tk.HanMucCanhBao, nl.HanMucCanhBao, 0) AS HanMucCanhBao
               FROM NguyenLieu nl
               LEFT JOIN public.tonkhochinhanh tk
                 ON tk.tenantid = $1::text AND tk.branchid = $2::text AND tk.manl = nl.manl
              WHERE nl.DaXoa = FALSE
                AND COALESCE(nl.TenantId::text, 'DEFAULT') = $1::text
                AND COALESCE(tk.SoLuongTon, CASE WHEN $3::boolean THEN nl.SoLuongTon ELSE 0 END, 0)
                    <= COALESCE(tk.HanMucCanhBao, nl.HanMucCanhBao, 0)
              ORDER BY SoLuongTon ASC`,
            [tenantId, branchId, isMain]
        );
        res.json(result.rows);
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Cảnh báo kho:');
    }
});

app.post('/api/congthuc', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('inventory_bom'), async (req, res) => {
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const tenantId = layTenantId(req);

    const { maMon, kichThuoc, dinhMuc } = req.body;
    if (!maMon || !kichThuoc || !Array.isArray(dinhMuc) || dinhMuc.length === 0) {
        return res.status(400).json({ message: 'Dữ liệu đầu vào không hợp lệ!' });
    }

    try {
        await chayGiaoDich(async (client) => {
            const ownMon = await client.query(
                "SELECT MaMon, TenMon FROM SanPham WHERE MaMon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
                [maMon, tenantId]
            );
            if (ownMon.rows.length === 0) {
                throw new LoiNghiepVu(404, 'Không tìm thấy món thuộc quán hiện tại!');
            }

            const nlIds = [...new Set(dinhMuc.map((d) => d.maNL))];
            const ownNl = await client.query(
                "SELECT MaNL FROM NguyenLieu WHERE MaNL = ANY($1::varchar[]) AND COALESCE(TenantId, 'DEFAULT') = $2",
                [nlIds, tenantId]
            );
            if (ownNl.rows.length !== nlIds.length) {
                throw new LoiNghiepVu(400, 'Có nguyên liệu không tồn tại hoặc không thuộc quán này!');
            }

            const prevRes = await client.query(
                'SELECT MaNL, KhoiLuongTieuHao FROM CongThuc WHERE MaMon = $1 AND KichThuoc = $2',
                [maMon, kichThuoc]
            );
            const giaTriCu = prevRes.rows.map((r) => ({ maNL: r.manl, khoiLuongTieuHao: Number(r.khoiluongtieuhao) }));

            await client.query('DELETE FROM CongThuc WHERE MaMon = $1 AND KichThuoc = $2', [maMon, kichThuoc]);
            for (const item of dinhMuc) {
                await client.query(
                    'INSERT INTO CongThuc (MaMon, KichThuoc, MaNL, KhoiLuongTieuHao) VALUES ($1, $2, $3, $4)',
                    [maMon, kichThuoc, item.maNL, item.khoiLuongTieuHao]
                );
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'RECIPE_UPDATED',
                doiTuong: 'CONGTHUC',
                maDoiTuong: `${maMon}|${kichThuoc}`,
                giaTriCu,
                giaTriMoi: dinhMuc,
                ip: req.ip,
                batBuoc: true,
            });
        }, tenantId);

        res.json({ message: `Cập nhật công thức cho món ${maMon} (Size ${kichThuoc}) thành công!` });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Thiết lập công thức:');
    }
});

app.post('/api/nhansu/phanca', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const tenantId = layTenantId(req);

    const { maNV, maCa, ngayLam } = req.body;
    if (!maNV || !maCa || !ngayLam) return res.status(400).json({ message: 'Vui lòng cung cấp đủ maNV, maCa và ngayLam!' });

    try {
        const maPhanCa = await pool.withTenant(tenantId, async (client) => {
            const [ownNV, ownCa] = await Promise.all([
                client.query("SELECT 1 FROM NhanVien WHERE MaNV = $1 AND COALESCE(TenantId, 'DEFAULT') = $2", [maNV, tenantId]),
                client.query("SELECT 1 FROM CaLamViec WHERE MaCa = $1 AND COALESCE(TenantId, 'DEFAULT') = $2", [maCa, tenantId]),
            ]);
            if (ownNV.rows.length === 0 || ownCa.rows.length === 0) return null;
            const result = await client.query(
                'INSERT INTO PhanCa (MaNV, MaCa, NgayLam, TrangThai, TenantId) VALUES ($1, $2, $3, 1, $4) RETURNING MaPhanCa',
                [maNV, maCa, ngayLam, tenantId]
            );
            return result.rows[0].maphanca;
        });
        if (!maPhanCa) {
            return res.status(404).json({ message: 'Nhân viên hoặc ca làm việc không thuộc quán hiện tại!' });
        }
        res.json({ message: 'Xếp lịch phân ca thành công!', maPhanCa });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Phân ca:');
    }
});

// [Wave 1 — P0-07] Phát hiện và gắn cờ MISSED_CLOCK_OUT cho ca đã qua giờ kết thúc > 2 giờ nhưng chưa Check-out
async function ganCoMissedClockOutChoTenant(client, tenantId) {
    await client.query('SAVEPOINT sp_missed_clockout');
    try {
        const res = await client.query(
            `UPDATE ChamCong cc
                SET trangthai_chamcong = 'MISSED_CLOCK_OUT',
                    auto_flagged_at = now(),
                    GhiChu = COALESCE(cc.GhiChu, '') || ' [MISSED_CLOCK_OUT]'
               FROM PhanCa pc
               JOIN CaLamViec clv ON pc.MaCa = clv.MaCa
              WHERE cc.MaPhanCa = pc.MaPhanCa
                AND COALESCE(pc.TenantId, 'DEFAULT') = $1
                AND cc.ThoiGianCheckOut IS NULL
                AND COALESCE(cc.trangthai_chamcong, 'NORMAL') = 'NORMAL'
                AND ((pc.NgayLam + clv.GioKetThuc)::timestamp AT TIME ZONE '${VN_TZ}') + interval '2 hours' < now()
              RETURNING cc.MaChamCong, cc.MaPhanCa`,
            [tenantId]
        );
        await client.query('RELEASE SAVEPOINT sp_missed_clockout');
        return res.rows;
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_missed_clockout').catch(() => {});
        return [];
    }
}

app.post('/api/nhansu/chamcong', kiemTraToken, async (req, res) => {
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const { maPhanCa } = req.body;
    const maNV = req.user.maNV;
    const tenantId = layTenantId(req);
    if (!maPhanCa) return res.status(400).json({ message: 'Thiếu mã phân ca (maPhanCa)!' });

    try {
        const todayVN = todayDateVN();
        const chamCong = await pool.withTenant(tenantId, async (client) => {
            await ganCoMissedClockOutChoTenant(client, tenantId);
            // [Wave 1 — P0-07] Bắt buộc phân ca phải thuộc đúng ngày hôm nay (pc.NgayLam = todayDateVN())
            const caResult = await client.query(`
                SELECT pc.MaPhanCa, pc.NgayLam, clv.GioBatDau,
                       CASE WHEN (CURRENT_TIMESTAMP AT TIME ZONE '${VN_TZ}')::time > clv.GioBatDau THEN 'Đi trễ' ELSE 'Đúng giờ' END AS TinhTrang
                FROM PhanCa pc
                JOIN CaLamViec clv ON pc.MaCa = clv.MaCa
                WHERE pc.MaPhanCa = $1
                  AND pc.MaNV = $2
                  AND COALESCE(pc.TenantId, 'DEFAULT') = $3
                  AND pc.NgayLam = $4::date
            `, [maPhanCa, maNV, tenantId, todayVN]);

            if (caResult.rows.length === 0) return null;

            const ghiChu = caResult.rows[0].tinhtrang;
            const checkInResult = await client.query(
                'INSERT INTO ChamCong (MaPhanCa, ThoiGianCheckIn, GhiChu) VALUES ($1, CURRENT_TIMESTAMP, $2) RETURNING MaChamCong, ThoiGianCheckIn, GhiChu',
                [maPhanCa, ghiChu]
            );
            return checkInResult.rows[0];
        });
        if (!chamCong) return res.status(404).json({ message: 'Không tìm thấy lịch phân ca hợp lệ của bạn trong ngày hôm nay!' });
        res.json({ message: 'Check-in vào ca thành công!', chamCong });
    } catch (error) {
        if (error && error.code === '23505') {
            return res.status(409).json({
                message: 'Bạn đã chấm công vào ca này rồi (không thể check-in trùng)!',
                maLoi: 'ALREADY_CLOCKED_IN',
                code: 'ALREADY_CLOCKED_IN',
            });
        }
        console.error('Lỗi API Check-in:', error);
        res.status(500).json({ message: 'Lỗi máy chủ khi Check-in' });
    }
});

app.put('/api/nhansu/chamcong', kiemTraToken, async (req, res) => {
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const { maPhanCa } = req.body;
    const maNV = req.user.maNV;
    const tenantId = layTenantId(req);
    if (!maPhanCa) return res.status(400).json({ message: 'Thiếu mã phân ca (maPhanCa)!' });

    try {
        const chamCong = await chayGiaoDich(async (client) => {
            const caResult = await client.query(`
                SELECT clv.GioKetThuc,
                       CASE WHEN (CURRENT_TIMESTAMP AT TIME ZONE '${VN_TZ}')::time < clv.GioKetThuc THEN ' - Về sớm' ELSE ' - Đủ giờ' END AS TinhTrangRa
                FROM PhanCa pc
                JOIN CaLamViec clv ON pc.MaCa = clv.MaCa
                WHERE pc.MaPhanCa = $1 AND pc.MaNV = $2 AND COALESCE(pc.TenantId, 'DEFAULT') = $3
            `, [maPhanCa, maNV, tenantId]);

            if (caResult.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy ca làm việc hợp lệ!');

            const tinhTrangRa = caResult.rows[0].tinhtrangra;
            const updateChamCong = await client.query(`
                UPDATE ChamCong 
                SET ThoiGianCheckOut = CURRENT_TIMESTAMP, GhiChu = COALESCE(GhiChu, '') || $1
                WHERE MaPhanCa = $2 AND ThoiGianCheckOut IS NULL
                RETURNING MaChamCong, ThoiGianCheckIn, ThoiGianCheckOut, GhiChu
            `, [tinhTrangRa, maPhanCa]);

            if (updateChamCong.rows.length === 0) throw new LoiNghiepVu(400, 'Chưa Check-in hoặc ca này đã được Check-out từ trước!');

            await client.query('UPDATE PhanCa SET TrangThai = 2 WHERE MaPhanCa = $1', [maPhanCa]);
            return updateChamCong.rows[0];
        }, tenantId);

        res.json({ message: 'Check-out tan ca thành công!', chamCong });
    } catch (error) {
        if (error instanceof LoiNghiepVu) {
            return res.status(error.status).json({ message: error.message });
        }
        console.error('Lỗi API Check-out:', error);
        res.status(400).json({ message: error.message || 'Lỗi máy chủ khi Check-out' });
    }
});

app.get('/api/nhansu/tinhluong', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    let { tuNgay, denNgay, thang, nam, luongTheoGio, donGiaGio } = req.query;
    const donGiaMacDinh = parseFloat(luongTheoGio ?? donGiaGio) || 25000;

    if ((!tuNgay || !denNgay) && thang && nam) {
        const y = Number(nam), m = Number(thang);
        const lastDay = new Date(y, m, 0).getDate();
        tuNgay = `${y}-${String(m).padStart(2, '0')}-01`;
        denNgay = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    }
    if (!tuNgay || !denNgay) {
        return res.status(400).json({ message: 'Vui lòng cung cấp tuNgay/denNgay hoặc thang/nam!' });
    }

    try {
        const result = await qTenant(req, `
            SELECT nv.MaNV, nv.TenNV, nv.VaiTro,
                   COALESCE(NULLIF(nv.MucLuongTheoGio, 0), $3) AS MucLuongApDung,
                   COUNT(cc.MaChamCong) AS SoCaHoanThanh,
                   ROUND(COALESCE(SUM(EXTRACT(EPOCH FROM (cc.ThoiGianCheckOut - cc.ThoiGianCheckIn)) / 3600), 0)::numeric, 2) AS TongSoGio
            FROM NhanVien nv
            LEFT JOIN PhanCa pc ON nv.MaNV = pc.MaNV
                 AND pc.NgayLam BETWEEN $1 AND $2
                 AND COALESCE(pc.TenantId, 'DEFAULT') = $4
            LEFT JOIN ChamCong cc ON pc.MaPhanCa = cc.MaPhanCa
                 AND cc.ThoiGianCheckIn IS NOT NULL AND cc.ThoiGianCheckOut IS NOT NULL
            WHERE COALESCE(nv.TenantId, 'DEFAULT') = $4
              AND (
                  nv.TrangThaiLamViec = TRUE
                  OR EXISTS (
                      SELECT 1 FROM PhanCa pc2
                       WHERE pc2.MaNV = nv.MaNV
                         AND pc2.NgayLam BETWEEN $1 AND $2
                         AND COALESCE(pc2.TenantId, 'DEFAULT') = $4
                  )
              )
            GROUP BY nv.MaNV, nv.TenNV, nv.VaiTro, nv.MucLuongTheoGio
            ORDER BY nv.MaNV ASC
        `, [tuNgay, denNgay, donGiaMacDinh, tenantId]);

        const bangLuong = result.rows.map((row) => {
            const tongGio = parseFloat(row.tongsogio);
            const mucLuong = parseFloat(row.mucluongapdung);
            return {
                maNV: row.manv,
                tenNV: row.tennv,
                vaiTro: row.vaitro,
                soCaHoanThanh: parseInt(row.socahoanthanh, 10),
                tongSoGio: tongGio,
                luongTheoGio: mucLuong,
                tongLuong: Math.round(tongGio * mucLuong),
            };
        });
        res.json({ tuNgay, denNgay, bangLuong });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Tính lương:');
    }
});

app.get('/api/nhansu/phancacuatoi', kiemTraToken, async (req, res) => {
    const maNV = req.user.maNV;
    const tenantId = layTenantId(req);
    const { ngayLam } = req.query;
    try {
        const ngayTruyVan = ngayLam || ngayHomNayVN();
        const result = await qTenant(req, `
            SELECT pc.MaPhanCa, pc.MaCa, clv.TenCa, clv.GioBatDau, clv.GioKetThuc, TO_CHAR(pc.NgayLam, 'YYYY-MM-DD') AS NgayLam, pc.TrangThai
            FROM PhanCa pc
            JOIN CaLamViec clv ON pc.MaCa = clv.MaCa
            WHERE pc.MaNV = $1 AND pc.NgayLam = $2 AND COALESCE(pc.TenantId, 'DEFAULT') = $3
        `, [maNV, ngayTruyVan, tenantId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: `Không tìm thấy lịch phân ca nào cho nhân viên ${maNV} vào ngày ${ngayTruyVan}` });
        }
        res.json({ ngayLam: ngayTruyVan, danhSachPhanCa: result.rows });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Tra cứu phân ca:');
    }
});

app.post('/api/sanpham', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const {
        maMon,
        tenMon,
        nhomMon,
        giaGoc,
        sizes,
        tramCheBien,
        laHangDongGoi = false,
        inTemCoc = true,
        laMonThoiGia = false,
        donViBanHang = 'LY',
        soLuongGioiHan86 = null,
    } = req.body || {};
    const tenantId = layTenantId(req);
    const prefix = req.user.maTienTo && tenantId !== 'DEFAULT' ? `${req.user.maTienTo}_` : '';
    if (!maMon || !tenMon || !nhomMon || !Array.isArray(sizes) || sizes.length === 0) {
        return res.status(400).json({ message: 'Vui lòng cung cấp đủ thông tin sản phẩm và sizes!' });
    }
    const rawMa = String(maMon).trim().toUpperCase();
    const maFinal = rawMa.startsWith(prefix) ? rawMa : `${prefix}${rawMa}`;
    const tramFinal = suyLuanTramCheBien({ tramCheBien, nhomMon, tenMon });
    const cdVal =
        soLuongGioiHan86 === null || soLuongGioiHan86 === undefined || soLuongGioiHan86 === ''
            ? null
            : Math.max(0, Math.floor(Number(soLuongGioiHan86)));

    try {
        await chayGiaoDich(async (client) => {
            await client.query('SAVEPOINT sp_ins_sp_tram');
            try {
                await client.query(
                    `INSERT INTO SanPham
                        (MaMon, TenMon, NhomMon, GiaGoc, DangKinhDoanh, TenantId, TramCheBien,
                         LaHangDongGoi, InTemCoc, LaMonThoiGia, DonViBanHang, SoLuongGioiHan86)
                     VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8, $9, $10, $11)`,
                    [
                        maFinal,
                        tenMon,
                        nhomMon,
                        giaGoc || 0,
                        tenantId,
                        tramFinal,
                        Boolean(laHangDongGoi),
                        inTemCoc !== false,
                        Boolean(laMonThoiGia),
                        String(donViBanHang || 'LY').toUpperCase(),
                        cdVal,
                    ]
                );
                await client.query('RELEASE SAVEPOINT sp_ins_sp_tram');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_ins_sp_tram').catch(() => {});
                await client.query(
                    'INSERT INTO SanPham (MaMon, TenMon, NhomMon, GiaGoc, DangKinhDoanh, TenantId) VALUES ($1, $2, $3, $4, TRUE, $5)',
                    [maFinal, tenMon, nhomMon, giaGoc || 0, tenantId]
                );
            }
            for (const sz of sizes) {
                await client.query('INSERT INTO SanPham_Size (MaMon, KichThuoc, GiaBan) VALUES ($1, $2, $3)', [maFinal, sz.kichThuoc, sz.giaBan]);
            }
        }, tenantId);
        res.json({ message: 'Thêm món mới thành công!', maMon: maFinal, tramCheBien: tramFinal });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Thêm món:');
    }
});

app.put('/api/sanpham/:maMon', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const tenantId = layTenantId(req);

    const { maMon } = req.params;
    const { tenMon, nhomMon, giaGoc, sizes, tramCheBien } = req.body;
    const tramFinal = suyLuanTramCheBien({ tramCheBien, nhomMon, tenMon });

    try {
        await chayGiaoDich(async (client) => {
            const oldSizes = await client.query('SELECT KichThuoc, GiaBan FROM SanPham_Size WHERE MaMon = $1', [maMon]);
            let updateSP;
            await client.query('SAVEPOINT sp_upd_sp_tram');
            try {
                updateSP = await client.query(
                    "UPDATE SanPham SET TenMon = $1, NhomMon = $2, GiaGoc = $3, TramCheBien = $6, DangKinhDoanh = TRUE WHERE MaMon = $4 AND COALESCE(TenantId, 'DEFAULT') = $5 RETURNING MaMon",
                    [tenMon, nhomMon, giaGoc || 0, maMon, tenantId, tramFinal]
                );
                await client.query('RELEASE SAVEPOINT sp_upd_sp_tram');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_upd_sp_tram').catch(() => {});
                updateSP = await client.query(
                    "UPDATE SanPham SET TenMon = $1, NhomMon = $2, GiaGoc = $3, DangKinhDoanh = TRUE WHERE MaMon = $4 AND COALESCE(TenantId, 'DEFAULT') = $5 RETURNING MaMon",
                    [tenMon, nhomMon, giaGoc || 0, maMon, tenantId]
                );
            }
            if (updateSP.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy mã món cần sửa!');

            await client.query('DELETE FROM SanPham_Size WHERE MaMon = $1', [maMon]);
            for (const sz of sizes) {
                await client.query('INSERT INTO SanPham_Size (MaMon, KichThuoc, GiaBan) VALUES ($1, $2, $3)', [maMon, sz.kichThuoc, sz.giaBan]);
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'PRICE_UPDATED',
                doiTuong: 'SANPHAM',
                maDoiTuong: maMon,
                giaTriCu: { sizes: oldSizes.rows },
                giaTriMoi: { tenMon, nhomMon, tramCheBien: tramFinal, sizes },
                ip: req.ip,
                batBuoc: true,
            });
        }, tenantId);
        res.json({ message: 'Cập nhật thông tin món thành công!', maMon, tramCheBien: tramFinal });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Sửa món:');
    }
});

app.delete('/api/sanpham/:maMon', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { maMon } = req.params;
    const tenantId = layTenantId(req);
    try {
        const deleted = await pool.withTenant(tenantId, async (client) => {
            const result = await client.query(
                "UPDATE SanPham SET DangKinhDoanh = FALSE WHERE MaMon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2 RETURNING MaMon, TenMon",
                [maMon, tenantId]
            );
            if (result.rows.length === 0) return null;
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'PRODUCT_DELETED',
                doiTuong: 'SANPHAM',
                maDoiTuong: maMon,
                giaTriCu: { tenMon: result.rows[0].tenmon },
                ip: req.ip,
            });
            return result.rows[0];
        });
        if (!deleted) return res.status(404).json({ message: 'Không tìm thấy mã món này!' });
        res.json({ message: `Đã ngừng kinh doanh món ${maMon} thành công!` });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Xóa món:');
    }
});

// [P1 - BCG Matrix] Ma trận Kỹ thuật Thực đơn (Menu Engineering: Stars / Plowhorses / Puzzles / Dogs)
app.get('/api/baocao/menu-engineering', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('inventory_bom'), async (req, res) => {
    const { tuNgay, denNgay } = req.query;
    const tenantId = layTenantId(req);
    if (!tuNgay || !denNgay) {
        return res.status(400).json({ message: 'Vui lòng cung cấp tham số tuNgay và denNgay (YYYY-MM-DD)!' });
    }
    try {
        const r = await qTenant(
            req,
            `SELECT cthd.MaMon,
                    COALESCE(MAX(cthd.TenMonSnapshot), MAX(sp.TenMon), cthd.MaMon) AS TenMon,
                    COALESCE(MAX(sp.NhomMon), 'Khác') AS NhomMon,
                    SUM(cthd.SoLuong) AS SoLyBan,
                    SUM(cthd.SoLuong * cthd.DonGia - COALESCE(cthd.GiaGiam, 0) + COALESCE(tp.TienTopping, 0)) AS DoanhThu,
                    SUM(cthd.SoLuong * COALESCE(cthd.GiaVonSnapshot, 0)) AS GiaVon
               FROM ChiTietHoaDon cthd
               JOIN HoaDon hd ON hd.MaHoaDon = cthd.MaHoaDon
               LEFT JOIN SanPham sp ON sp.MaMon = cthd.MaMon
               LEFT JOIN (
                   SELECT MaCTHD, SUM(SoLuong * DonGia) AS TienTopping
                     FROM ChiTietHoaDon_Topping
                    GROUP BY MaCTHD
               ) tp ON tp.MaCTHD = cthd.MaCTHD
              WHERE hd.TrangThaiTT = 1
                AND cthd.TrangThaiPhaChe <> 'DaHuy'
                AND COALESCE(hd.TenantId, 'DEFAULT') = $3
                AND hd.ThoiGianThanhToan >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                AND hd.ThoiGianThanhToan < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
              GROUP BY cthd.MaMon
              HAVING SUM(cthd.SoLuong) > 0
              ORDER BY DoanhThu DESC`,
            [tuNgay, denNgay, tenantId]
        );

        const rawItems = r.rows.map((row) => {
            const soLyBan = Number(row.solyban || 0);
            const doanhThu = Number(row.doanhthu || 0);
            const giaVon = Number(row.giavon || 0);
            const laiGop = doanhThu - giaVon;
            const laiGopMoiLy = soLyBan > 0 ? Math.round(laiGop / soLyBan) : 0;
            const bienLoiNhuanPct = doanhThu > 0 ? Math.round((laiGop / doanhThu) * 1000) / 10 : 0;
            return {
                maMon: row.mamon,
                tenMon: row.tenmon,
                nhomMon: row.nhommon,
                soLyBan,
                doanhThu,
                giaVon,
                laiGop,
                laiGopMoiLy,
                bienLoiNhuanPct,
            };
        });

        const totalQty = rawItems.reduce((s, i) => s + i.soLyBan, 0);
        const totalProfit = rawItems.reduce((s, i) => s + i.laiGop, 0);
        // Chuẩn Menu Engineering Kasavana & Smith: ngưỡng phổ biến = 70% trung bình, ngưỡng lãi gộp = trung bình gia quyền
        const avgQtyThreshold = rawItems.length > 0 ? (totalQty / rawItems.length) * 0.7 : 0;
        const avgUnitMargin = totalQty > 0 ? totalProfit / totalQty : 0;

        const ADVICE = {
            STAR: { label: '⭐ Ngôi sao (Star)', action: 'Giữ vững chất lượng, đẩy lên đầu menu & gợi ý upsell!' },
            PLOWHORSE: { label: '🐄 Bò sữa (Plowhorse)', action: 'Bán chạy nhưng lãi mỏng — tối ưu định lượng BOM hoặc tăng nhẹ 2–3k.' },
            PUZZLE: { label: '❓ Câu đố (Puzzle)', action: 'Lãi rất cao nhưng ít khách gọi — đẩy Combo, ảnh lớn hoặc khuyến mãi dùng thử.' },
            DOG: { label: '🐕 Chó mực (Dog)', action: 'Bán chậm & lãi thấp — cân nhắc lược bỏ khỏi menu để giảm tồn kho.' },
        };

        const items = rawItems.map((it) => {
            const highPop = it.soLyBan >= avgQtyThreshold;
            const highMargin = it.laiGopMoiLy >= avgUnitMargin;
            const category = highPop && highMargin
                ? 'STAR'
                : highPop && !highMargin
                ? 'PLOWHORSE'
                : !highPop && highMargin
                ? 'PUZZLE'
                : 'DOG';
            return {
                ...it,
                category,
                categoryLabel: ADVICE[category].label,
                advice: ADVICE[category].action,
            };
        });

        const summary = {
            STAR: items.filter((i) => i.category === 'STAR').length,
            PLOWHORSE: items.filter((i) => i.category === 'PLOWHORSE').length,
            PUZZLE: items.filter((i) => i.category === 'PUZZLE').length,
            DOG: items.filter((i) => i.category === 'DOG').length,
            avgQtyThreshold: Math.round(avgQtyThreshold * 10) / 10,
            avgUnitMargin: Math.round(avgUnitMargin),
        };

        res.json({ kyBaoCao: { tuNgay, denNgay }, summary, items });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Menu Engineering (BCG Matrix):');
    }
});

app.get('/api/baocao/dashboard', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    let { tuNgay, denNgay } = req.query;
    const tenantId = layTenantId(req);
    if (!tuNgay || !denNgay) return res.status(400).json({ message: 'Vui lòng cung cấp tham số tuNgay và denNgay (YYYY-MM-DD)!' });

    try {
        // [PHÂN HỆ 9] Gói FREE giới hạn xem lịch sử báo cáo 7 ngày gần nhất (reportHistoryDays = 7)
        let reportLimitDays = -1;
        let wasClamped = false;
        let currentPlan = req.user?.goiCuoc || 'PRO';
        if (tenantId !== 'DEFAULT') {
            const ent = await layEntitlementTenant(pool, tenantId);
            currentPlan = ent.goiCuoc || currentPlan;
            const limitDays = Number(ent.flags?.reportHistoryDays ?? -1);
            if (Number.isFinite(limitDays) && limitDays > 0) {
                reportLimitDays = limitDays;
                const vnNowMs = Date.now() + 7 * 3600000;
                const minAllowedIso = new Date(vnNowMs - (limitDays - 1) * 86400000).toISOString().slice(0, 10);
                if (String(tuNgay) < minAllowedIso) {
                    tuNgay = minAllowedIso;
                    wasClamped = true;
                }
                if (String(denNgay) < tuNgay) {
                    denNgay = tuNgay;
                }
            }
        }
        const [doanhThuNgayResult, chiPhiResult, ptttResult, topMonResult, refundNgayResult, cogsAdjNgayResult] = await Promise.all([
            pool.withTenant(tenantId, async (client) => {
                await client.query('SAVEPOINT sp_dash_net_rev');
                try {
                    // [Wave 2 — P0-05] Khớp 100% Z-Report: loại LaMonTang = TRUE khỏi doanh thu, cộng GiaModifiers, trừ ChietKhauMon + GiaGiam + KM/Điểm
                    const r = await client.query(`
                        WITH DoanhThuMon AS (
                            SELECT 
                                hd.MaHoaDon,
                                TO_CHAR(hd.ThoiGianThanhToan::timestamptz AT TIME ZONE '${VN_TZ}', 'YYYY-MM-DD') AS Ngay,
                                SUM(
                                    CASE
                                        WHEN COALESCE(cthd.LaMonTang, FALSE) = TRUE THEN 0
                                        ELSE GREATEST(
                                            0,
                                            cthd.SoLuong * (cthd.DonGia + COALESCE(cthd.GiaModifiers, 0))
                                            - COALESCE(cthd.GiaGiam, 0)
                                            - COALESCE(cthd.ChietKhauMon, 0)
                                        )
                                    END
                                ) AS TienMon,
                                COALESCE(
                                    SUM(CASE WHEN COALESCE(cthd.LaMonTang, FALSE) = TRUE THEN 0 ELSE COALESCE(tp.TienTopping, 0) END),
                                    0
                                ) AS TienTopping,
                                COALESCE(MAX(hd.TienGiamKM), 0) + COALESCE(MAX(hd.TienGiamDiem), 0) AS TienGiamHD,
                                COALESCE(SUM(cthd.SoLuong * COALESCE(cthd.GiaVonSnapshot, 0)), 0) AS GiaVon
                            FROM HoaDon hd
                            JOIN ChiTietHoaDon cthd ON hd.MaHoaDon = cthd.MaHoaDon AND cthd.TrangThaiPhaChe <> 'DaHuy'
                            LEFT JOIN (
                                SELECT MaCTHD, SUM(SoLuong * DonGia) AS TienTopping
                                FROM ChiTietHoaDon_Topping
                                GROUP BY MaCTHD
                            ) tp ON cthd.MaCTHD = tp.MaCTHD
                            WHERE hd.TrangThaiTT = 1
                              AND COALESCE(hd.TenantId, 'DEFAULT') = $3
                              AND hd.ThoiGianThanhToan >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                              AND hd.ThoiGianThanhToan < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                            GROUP BY hd.MaHoaDon, TO_CHAR(hd.ThoiGianThanhToan::timestamptz AT TIME ZONE '${VN_TZ}', 'YYYY-MM-DD')
                        )
                        SELECT Ngay,
                               COUNT(MaHoaDon) AS SoDon,
                               SUM(GREATEST(0, TienMon + TienTopping - TienGiamHD)) AS DoanhThu,
                               SUM(TienGiamHD) AS TongGiamGia,
                               SUM(GiaVon) AS GiaVon
                        FROM DoanhThuMon
                        GROUP BY Ngay
                        ORDER BY Ngay ASC
                    `, [tuNgay, denNgay, tenantId]);
                    await client.query('RELEASE SAVEPOINT sp_dash_net_rev');
                    return r;
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_dash_net_rev').catch(() => {});
                    return client.query(`
                        WITH DoanhThuMon AS (
                            SELECT 
                                hd.MaHoaDon,
                                TO_CHAR(hd.ThoiGianThanhToan::timestamptz AT TIME ZONE '${VN_TZ}', 'YYYY-MM-DD') AS Ngay,
                                SUM(cthd.SoLuong * cthd.DonGia - COALESCE(cthd.GiaGiam, 0)) AS TienMon,
                                COALESCE(SUM(tp.TienTopping), 0) AS TienTopping,
                                COALESCE(SUM(cthd.SoLuong * COALESCE(cthd.GiaVonSnapshot, 0)), 0) AS GiaVon
                            FROM HoaDon hd
                            JOIN ChiTietHoaDon cthd ON hd.MaHoaDon = cthd.MaHoaDon AND cthd.TrangThaiPhaChe <> 'DaHuy'
                            LEFT JOIN (
                                SELECT MaCTHD, SUM(SoLuong * DonGia) AS TienTopping
                                FROM ChiTietHoaDon_Topping
                                GROUP BY MaCTHD
                            ) tp ON cthd.MaCTHD = tp.MaCTHD
                            WHERE hd.TrangThaiTT = 1
                              AND COALESCE(hd.TenantId, 'DEFAULT') = $3
                              AND hd.ThoiGianThanhToan >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                              AND hd.ThoiGianThanhToan < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                            GROUP BY hd.MaHoaDon, TO_CHAR(hd.ThoiGianThanhToan::timestamptz AT TIME ZONE '${VN_TZ}', 'YYYY-MM-DD')
                        )
                        SELECT Ngay,
                               COUNT(MaHoaDon) AS SoDon,
                               SUM(TienMon + TienTopping) AS DoanhThu,
                               0 AS TongGiamGia,
                               SUM(GiaVon) AS GiaVon
                        FROM DoanhThuMon
                        GROUP BY Ngay
                        ORDER BY Ngay ASC
                    `, [tuNgay, denNgay, tenantId]);
                }
            }),

            // [Wave 2 — P0-05] Loại trừ phiếu nhập kho đã bị đảo (LoaiGD = 9 tham chiếu MaGDThamChieu)
            qTenant(req, `
                SELECT COALESCE(SUM(ct.SoLuong * ct.DonGiaNhap), 0) AS TongChiPhiNhap
                FROM PhieuGiaoDichKho pgd
                JOIN ChiTietGiaoDichKho ct ON pgd.MaGiaoDich = ct.MaGiaoDich
                WHERE pgd.LoaiGD = 1
                  AND COALESCE(pgd.TenantId, 'DEFAULT') = $3
                  AND pgd.ThoiGianTao >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                  AND pgd.ThoiGianTao < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                  AND NOT EXISTS (
                      SELECT 1
                        FROM PhieuGiaoDichKho rev
                       WHERE rev.LoaiGD = 9
                         AND COALESCE(rev.TenantId, 'DEFAULT') = $3
                         AND rev.MaGDThamChieu = pgd.MaGiaoDich::text
                  )
            `, [tuNgay, denNgay, tenantId]),

            paymentsSanSang
                ? qTenant(req, `
                    SELECT PhuongThucTT,
                           COUNT(DISTINCT CASE WHEN SoTien > 0 THEN MaHoaDon END) AS SoDon,
                           COALESCE(SUM(SoTien), 0) AS TongTien
                      FROM (
                          SELECT op.MaHoaDon,
                                 op.PhuongThucTT,
                                 CASE WHEN op.TrangThai = 'REFUNDED' THEN -op.SoTien ELSE op.SoTien END AS SoTien
                            FROM Order_Payments op
                           WHERE op.TrangThai IN ('PAID', 'REFUNDED')
                             AND COALESCE(op.TenantId, 'DEFAULT') = $3
                             AND op.ThoiGianTao >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                             AND op.ThoiGianTao < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                          UNION ALL
                          SELECT hd.MaHoaDon::text AS MaHoaDon,
                                 COALESCE(hd.PhuongThucTT, 'TIEN_MAT') AS PhuongThucTT,
                                 hd.TongTienThanhToan AS SoTien
                            FROM HoaDon hd
                           WHERE hd.TrangThaiTT = 1
                             AND COALESCE(hd.TenantId, 'DEFAULT') = $3
                             AND hd.ThoiGianThanhToan >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                             AND hd.ThoiGianThanhToan < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                             AND NOT EXISTS (
                                 SELECT 1 FROM Order_Payments op2
                                  WHERE op2.MaHoaDon = hd.MaHoaDon::text AND op2.TrangThai = 'PAID'
                             )
                      ) combined
                     GROUP BY PhuongThucTT
                `, [tuNgay, denNgay, tenantId])
                : qTenant(req, `
                    SELECT COALESCE(PhuongThucTT, 'TIEN_MAT') AS PhuongThucTT,
                           COUNT(*) AS SoDon,
                           COALESCE(SUM(TongTienThanhToan), 0) AS TongTien
                      FROM HoaDon
                     WHERE TrangThaiTT = 1
                       AND COALESCE(TenantId, 'DEFAULT') = $3
                       AND ThoiGianThanhToan >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                       AND ThoiGianThanhToan < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                     GROUP BY COALESCE(PhuongThucTT, 'TIEN_MAT')
                `, [tuNgay, denNgay, tenantId]),

            qTenant(req, `
                SELECT cthd.MaMon,
                       COALESCE(MAX(cthd.TenMonSnapshot), MAX(sp.TenMon)) AS TenMon,
                       SUM(cthd.SoLuong) AS TongLy,
                       SUM(
                           CASE
                               WHEN COALESCE(cthd.LaMonTang, FALSE) = TRUE THEN 0
                               ELSE GREATEST(
                                   0,
                                   cthd.SoLuong * (cthd.DonGia + COALESCE(cthd.GiaModifiers, 0))
                                   - COALESCE(cthd.GiaGiam, 0)
                                   - COALESCE(cthd.ChietKhauMon, 0)
                               ) + COALESCE(tp.TienTopping, 0)
                           END
                       ) AS DoanhThu,
                       SUM(cthd.SoLuong * COALESCE(cthd.GiaVonSnapshot, 0)) AS GiaVon
                  FROM HoaDon hd
                  JOIN ChiTietHoaDon cthd ON hd.MaHoaDon = cthd.MaHoaDon AND cthd.TrangThaiPhaChe <> 'DaHuy'
                  JOIN SanPham sp ON sp.MaMon = cthd.MaMon
                  LEFT JOIN (
                      SELECT MaCTHD, SUM(SoLuong * DonGia) AS TienTopping
                        FROM ChiTietHoaDon_Topping
                       GROUP BY MaCTHD
                  ) tp ON tp.MaCTHD = cthd.MaCTHD
                 WHERE hd.TrangThaiTT = 1
                   AND COALESCE(hd.TenantId, 'DEFAULT') = $3
                   AND hd.ThoiGianThanhToan >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                   AND hd.ThoiGianThanhToan < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                 GROUP BY cthd.MaMon
                 ORDER BY TongLy DESC, DoanhThu DESC
                 LIMIT 8
            `, [tuNgay, denNgay, tenantId]),

            // [Wave 2 — P0-05] Tổng hoàn tiền (order_refunds) theo ngày để trừ khỏi Doanh thu thuần
            pool.withTenant(tenantId, async (client) => {
                await client.query('SAVEPOINT sp_dash_refunds');
                try {
                    const r = await client.query(`
                        SELECT TO_CHAR(thoigiantao::timestamptz AT TIME ZONE '${VN_TZ}', 'YYYY-MM-DD') AS Ngay,
                               COALESCE(SUM(sotienhoan), 0) AS TongHoan
                          FROM public.order_refunds
                         WHERE COALESCE(tenantid, 'DEFAULT') = $3
                           AND thoigiantao >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                           AND thoigiantao < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                         GROUP BY TO_CHAR(thoigiantao::timestamptz AT TIME ZONE '${VN_TZ}', 'YYYY-MM-DD')
                    `, [tuNgay, denNgay, tenantId]);
                    await client.query('RELEASE SAVEPOINT sp_dash_refunds');
                    return r;
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_dash_refunds').catch(() => {});
                    return { rows: [] };
                }
            }),

            // [Wave 2 — P0-05] Tổng điều chỉnh giá vốn (cogs_adjustment_journal) theo business_date
            pool.withTenant(tenantId, async (client) => {
                await client.query('SAVEPOINT sp_dash_cogs_adj');
                try {
                    const r = await client.query(`
                        SELECT TO_CHAR(business_date, 'YYYY-MM-DD') AS Ngay,
                               COALESCE(SUM(adjustment_amount), 0) AS TongDieuChinhGiaVon
                          FROM public.cogs_adjustment_journal
                         WHERE tenant_id = $3
                           AND business_date >= $1::date
                           AND business_date <= $2::date
                         GROUP BY TO_CHAR(business_date, 'YYYY-MM-DD')
                    `, [tuNgay, denNgay, tenantId]);
                    await client.query('RELEASE SAVEPOINT sp_dash_cogs_adj');
                    return r;
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_dash_cogs_adj').catch(() => {});
                    return { rows: [] };
                }
            }),
        ]);

        const refundByDate = new Map(refundNgayResult.rows.map((r) => [r.ngay, parseFloat(r.tonghoan || 0)]));
        const cogsAdjByDate = new Map(cogsAdjNgayResult.rows.map((r) => [r.ngay, parseFloat(r.tongdieuchinhgiavon || 0)]));
        const allDates = new Set([
            ...doanhThuNgayResult.rows.map((r) => r.ngay),
            ...refundByDate.keys(),
            ...cogsAdjByDate.keys(),
        ]);
        const revRowByDate = new Map(doanhThuNgayResult.rows.map((r) => [r.ngay, r]));

        let tongSoDon = 0;
        let tongDoanhThu = 0;
        let tongGiaVon = 0;
        let tongGiamGia = 0;
        let tongHoanTien = 0;
        let tongDieuChinhGiaVon = 0;
        const bieuDoDoanhThu = [...allDates].sort().map((ngay) => {
            const row = revRowByDate.get(ngay);
            const soDon = row ? parseInt(row.sodon, 10) : 0;
            const doanhThuTruocHoan = row ? parseFloat(row.doanhthu || 0) : 0;
            const hoanTien = refundByDate.get(ngay) || 0;
            const doanhThu = Math.max(0, Math.round((doanhThuTruocHoan - hoanTien) * 100) / 100);
            const cogsAdj = cogsAdjByDate.get(ngay) || 0;
            const giaVon = Math.round(((row ? parseFloat(row.giavon || 0) : 0) + cogsAdj) * 100) / 100;
            const giamGia = row ? parseFloat(row.tonggiamgia || 0) : 0;
            tongSoDon += soDon;
            tongDoanhThu = Math.round((tongDoanhThu + doanhThu) * 100) / 100;
            tongGiaVon = Math.round((tongGiaVon + giaVon) * 100) / 100;
            tongGiamGia = Math.round((tongGiamGia + giamGia) * 100) / 100;
            tongHoanTien = Math.round((tongHoanTien + hoanTien) * 100) / 100;
            tongDieuChinhGiaVon = Math.round((tongDieuChinhGiaVon + cogsAdj) * 100) / 100;
            return { ngay, soDon, doanhThu, hoanTien, giamGia, giaVon, dieuChinhGiaVon: cogsAdj, loiNhuanGop: doanhThu - giaVon };
        });

        const tongChiPhiNhapKho = parseFloat(chiPhiResult.rows[0].tongchiphinhap);
        const loiNhuanGop = Math.round((tongDoanhThu - tongGiaVon) * 100) / 100;
        const tySuatLoiNhuan = tongDoanhThu > 0 ? Math.round((loiNhuanGop / tongDoanhThu) * 1000) / 10 : 0;
        const loiNhuanTamTinh = Math.round((tongDoanhThu - tongChiPhiNhapKho) * 100) / 100;

        const doanhThuTheoPhuongThuc = ptttResult.rows.map((r) => ({
            phuongThucTT: r.phuongthuctt,
            soDon: Number(r.sodon),
            tongTien: Number(r.tongtien),
        }));

        const topMonBanChay = topMonResult.rows.map((r) => {
            const dt = Number(r.doanhthu);
            const gv = Number(r.giavon || 0);
            return {
                maMon: r.mamon,
                tenMon: r.tenmon,
                tongLy: Number(r.tongly),
                doanhThu: dt,
                giaVon: gv,
                loiNhuanGop: dt - gv,
            };
        });

        res.json({
            kyBaoCao: { tuNgay, denNgay },
            reportLimitDays,
            wasClamped,
            currentPlan,
            tongQuan: {
                tongSoDon,
                tongDoanhThu,
                tongHoanTien,
                tongGiamGia,
                tongGiaVon,
                tongDieuChinhGiaVon,
                loiNhuanGop,
                tySuatLoiNhuan,
                tongChiPhiNhapKho,
                loiNhuanTamTinh,
            },
            bieuDoDoanhThu,
            doanhThuTheoPhuongThuc,
            topMonBanChay,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Dashboard:');
    }
});

app.post('/api/kho/kiemke', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
    const {
        loaiGD,
        ghiChu,
        branchId: rawBranchId = null,
        ngayChungTu = null,
        maLyDoHuy = null,
        danhSachNguyenLieu,
    } = req.body || {};
    const tenantId = layTenantId(req);
    if (![2, 3].includes(loaiGD) || !Array.isArray(danhSachNguyenLieu) || danhSachNguyenLieu.length === 0) {
        return res.status(400).json({ message: 'Loại giao dịch không hợp lệ hoặc danh sách nguyên liệu trống!' });
    }
    const cleanReasonCode =
        loaiGD === 2
            ? VALID_WASTAGE_CODES.includes(String(maLyDoHuy || '').toUpperCase())
                ? String(maLyDoHuy).toUpperCase()
                : 'BARISTA_SPILL'
            : null;

    // Quy đổi Tổ hợp Đơn vị tính (Compound UoM) hoặc hệ số quy đổi cho cả Xuất Hủy (2) và Kiểm Kê (3)!
    const parsedItems = [];
    for (const item of danhSachNguyenLieu) {
        if (!item?.maNL) {
            return res.status(400).json({ message: 'Mỗi dòng phải có maNL hợp lệ!' });
        }
        let slBase = 0;
        let descUnit = '';
        if (Array.isArray(item.chiTietDonVi) && item.chiTietDonVi.length > 0) {
            const parts = [];
            for (const u of item.chiTietDonVi) {
                const q = Number(u?.soLuong || 0);
                const hs = Number(u?.heSoQuyDoi || 1);
                if (q > 0 && hs > 0) {
                    slBase += q * hs;
                    parts.push(`${q} ${u.tenDonVi || 'đv'}(x${hs})`);
                }
            }
            slBase = lam3(slBase);
            descUnit = parts.join(' + ');
        } else {
            const slRaw = Number(item.soLuong);
            const hs = Number(item.heSoQuyDoi) > 0 ? Number(item.heSoQuyDoi) : 1;
            if (Number.isNaN(slRaw)) {
                return res.status(400).json({ message: `Số lượng của ${item.maNL} không hợp lệ!` });
            }
            slBase = lam3(slRaw * hs);
            descUnit = hs !== 1 && item.donViNhap ? `${slRaw} ${item.donViNhap}(x${hs})` : '';
        }

        if ((loaiGD === 2 && !(slBase > 0)) || (loaiGD === 3 && slBase < 0)) {
            return res.status(400).json({
                message: loaiGD === 2
                    ? 'Xuất hủy yêu cầu maNL và soLuong > 0!'
                    : 'Kiểm kê yêu cầu maNL và số lượng thực tế >= 0!',
            });
        }
        parsedItems.push({ ...item, slBase, descUnit });
    }

    try {
        const maGiaoDich = await chayGiaoDich(async (client) => {
            const targetBranch = normalizeInventoryBranch(tenantId, rawBranchId || req.user.branchId || null);
            const docDate = await assertPeriodNotLocked(client, tenantId, targetBranch, ngayChungTu, LoiNghiepVu);

            const sorted = [...parsedItems].sort((a, b) => String(a.maNL).localeCompare(String(b.maNL)));
            const { branchId, stockMap } = await lockBranchStockOrdered(
                client,
                tenantId,
                targetBranch,
                sorted.map((x) => x.maNL)
            );
            const caMo = await layCaDangMo(client, 'SHARE', tenantId, { branchId });

            const phieuResult = await client.query(
                `INSERT INTO PhieuGiaoDichKho
                    (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan, MaLyDoHuy, NgayChungTu, TrangThaiDuyet)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, 'POSTED')
                 RETURNING MaGiaoDich`,
                [
                    req.user.maNV,
                    loaiGD,
                    ghiChu || (loaiGD === 2 ? `Xuất hủy (${WASTAGE_TAXONOMY[cleanReasonCode] || cleanReasonCode})` : 'Kiểm kê kho định kỳ'),
                    tenantId,
                    branchId,
                    caMo ? String(caMo.macathungan) : null,
                    cleanReasonCode,
                    docDate,
                ]
            );
            const maGD = phieuResult.rows[0].magiaodich;

            for (const item of sorted) {
                const st = stockMap.get(item.maNL);
                if (!st) throw new LoiNghiepVu(404, `Không tìm thấy nguyên liệu ${item.maNL}!`);
                const sl = item.slBase;
                const tonTruoc = st.soLuongTon;
                const giaVonSnap = st.giaVonDonVi;

                if (loaiGD === 2) {
                    const fefoRes = await consumeFefoBatches(client, { tenantId, branchId, maNL: item.maNL, qty: sl });
                    const unitCost = fefoRes.weightedCost !== null ? fefoRes.weightedCost : giaVonSnap;
                    const tonSau = lam3(tonTruoc - sl);
                    const note = [item.tinhTrang || WASTAGE_TAXONOMY[cleanReasonCode] || 'Hủy do hư hỏng', item.descUnit]
                        .filter(Boolean)
                        .join(' • ');

                    await insertLedgerLine(client, {
                        maGiaoDich: maGD,
                        maNL: item.maNL,
                        soLuong: sl,
                        donGiaNhap: unitCost,
                        tinhTrang: note,
                        tonTruoc,
                        tonSau,
                        giaVonTruoc: giaVonSnap,
                        giaVonSau: giaVonSnap,
                        donViNhap: item.donViNhap || st.donViTinh,
                        heSoQuyDoi: Number(item.heSoQuyDoi) > 0 ? Number(item.heSoQuyDoi) : 1,
                    });
                    await updateBranchStockRow(client, { tenantId, branchId, maNL: item.maNL, nextQty: tonSau });
                } else {
                    const doLech = lam3(sl - tonTruoc);
                    const note = `Kiểm kê thực tế: ${sl}${item.descUnit ? ` (${item.descUnit})` : ''}`;

                    await insertLedgerLine(client, {
                        maGiaoDich: maGD,
                        maNL: item.maNL,
                        soLuong: doLech,
                        donGiaNhap: giaVonSnap,
                        tinhTrang: note,
                        tonTruoc,
                        tonSau: sl,
                        giaVonTruoc: giaVonSnap,
                        giaVonSau: giaVonSnap,
                        donViNhap: item.donViNhap || st.donViTinh,
                        heSoQuyDoi: Number(item.heSoQuyDoi) > 0 ? Number(item.heSoQuyDoi) : 1,
                    });
                    await updateBranchStockRow(client, { tenantId, branchId, maNL: item.maNL, nextQty: sl });

                    if (caMo) {
                        await client.query(
                            `INSERT INTO public.chotton_ca (tenantid, branchid, macathungan, manl, tondauca, toncuoica, giavonca)
                             VALUES ($1::varchar, $2::varchar, $3::text, $4::varchar, $5::numeric, $6::numeric, $7::numeric)
                             ON CONFLICT (tenantid, macathungan, manl)
                             DO UPDATE SET toncuoica = EXCLUDED.toncuoica, giavonca = EXCLUDED.giavonca, thoigianchot = now()`,
                            [tenantId, branchId, String(caMo.macathungan), item.maNL, tonTruoc, sl, giaVonSnap]
                        );
                    }
                }
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: loaiGD === 2 ? 'INVENTORY_WASTAGE' : 'INVENTORY_STOCKTAKE',
                doiTuong: 'KHO',
                maDoiTuong: maGD,
                giaTriMoi: { branchId, soDong: sorted.length, maLyDoHuy: cleanReasonCode, ghiChu },
                ip: req.ip,
                batBuoc: true,
            });
            return maGD;
        }, tenantId);

        res.json({
            message: loaiGD === 2 ? 'Lập phiếu xuất hủy thành công!' : 'Cập nhật kiểm kê kho thành công!',
            maGiaoDich,
            maLyDoHuy: cleanReasonCode,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Xuất hủy/Kiểm kê:');
    }
});

function tinhDongCanDoiKho(r) {
    const giaVon = Number(r.giavondonvi || 0);
    const tieuHaoGoc = Number(r.tongtieuhaobanhang || 0);
    const hoanKhoHuyMon = Number(r.tonghoankhohuymon || 0);
    const haoHutHuyMon = Number(r.tonghaohuthuymon || 0);
    // Loại trừ hoàn kho (LoaiGD=7) & hao hụt hủy món đã pha (LoaiGD=8) khỏi LoaiGD=6 để KHÔNG đếm trùng lượng hao hụt
    const tieuHao = Math.max(0, Math.round((tieuHaoGoc - hoanKhoHuyMon - haoHutHuyMon) * 1000) / 1000);
    const xuatHuy = Math.round((Number(r.tongxuathuy || 0) + haoHutHuyMon) * 1000) / 1000;
    const lechKiemKe = Number(r.tongchenhlechkiemke || 0);
    const luongThatThoat = Math.max(0, xuatHuy + Math.max(0, -lechKiemKe));
    // Ưu tiên tính giá trị thất thoát theo DonGiaNhap (GiaVonDonVi lịch sử đã snapshot lúc xuất hủy/kiểm kê)
    const giaTriXuatHuyLichSu = Number(r.giatrixuathuylichsu || 0);
    const giaTriLechKiemKeLichSu = Number(r.giatrilechkiemkelichsu || 0);
    const giaTriThatThoat =
        giaTriXuatHuyLichSu > 0 || giaTriLechKiemKeLichSu > 0
            ? Math.round(giaTriXuatHuyLichSu + giaTriLechKiemKeLichSu)
            : Math.round(luongThatThoat * giaVon);
    const mauSo = tieuHao + luongThatThoat;
    const tyLeThatThoatPct = mauSo > 0 ? Math.round((luongThatThoat / mauSo) * 1000) / 10 : 0;
    return {
        ...r,
        tongtieuhaobanhang: tieuHao,
        tongxuathuy: xuatHuy,
        tonghaohuthuymon: haoHutHuyMon,
        giaTriThatThoat,
        tyLeThatThoatPct,
    };
}

app.get('/api/kho/candoi', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { tuNgay, denNgay, branchId: rawBranchId = null } = req.query;
    const tenantId = layTenantId(req);
    if (!tuNgay || !denNgay) return res.status(400).json({ message: 'Vui lòng cung cấp tham số tuNgay và denNgay (YYYY-MM-DD)!' });
    const branchId = normalizeInventoryBranch(tenantId, rawBranchId || req.user.branchId || null);
    const isMain = branchId === `${tenantId}_MAIN`;

    try {
        const result = await qTenant(req, `
            SELECT nl.MaNL, nl.TenNL, nl.DonViTinh,
                   COALESCE(tk.SoLuongTon, CASE WHEN $5::boolean THEN nl.SoLuongTon ELSE 0 END, 0) AS TonKhoHienTai,
                   COALESCE(tk.GiaVonDonVi, nl.GiaVonDonVi, 0) AS GiaVonDonVi,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD IN (1, 10) THEN ct.SoLuong ELSE 0 END), 0) AS TongNhap,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 2 THEN ct.SoLuong ELSE 0 END), 0) AS TongXuatHuy,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 3 THEN ct.SoLuong ELSE 0 END), 0) AS TongChenhLechKiemKe,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 6 THEN ct.SoLuong ELSE 0 END), 0) AS TongTieuHaoBanHang,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 7 THEN ct.SoLuong ELSE 0 END), 0) AS TongHoanKhoHuyMon,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 8 THEN ct.SoLuong ELSE 0 END), 0) AS TongHaoHutHuyMon,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD IN (2, 8) THEN ct.SoLuong * CASE WHEN COALESCE(ct.DonGiaNhap, 0) > 0 THEN ct.DonGiaNhap ELSE COALESCE(tk.GiaVonDonVi, nl.GiaVonDonVi, 0) END ELSE 0 END), 0) AS GiaTriXuatHuyLichSu,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 3 AND ct.SoLuong < 0 THEN (-ct.SoLuong) * CASE WHEN COALESCE(ct.DonGiaNhap, 0) > 0 THEN ct.DonGiaNhap ELSE COALESCE(tk.GiaVonDonVi, nl.GiaVonDonVi, 0) END ELSE 0 END), 0) AS GiaTriLechKiemKeLichSu
            FROM NguyenLieu nl
            LEFT JOIN public.tonkhochinhanh tk
                 ON tk.tenantid = $3::text AND tk.branchid = $4::text AND tk.manl = nl.manl
            LEFT JOIN ChiTietGiaoDichKho ct ON nl.MaNL = ct.MaNL
            LEFT JOIN PhieuGiaoDichKho pgd ON ct.MaGiaoDich = pgd.MaGiaoDich
                 AND COALESCE(pgd.TrangThaiDuyet, 'POSTED') = 'POSTED'
                 AND COALESCE(NULLIF(NULLIF(pgd.BranchId::text, ''), 'DEFAULT'), $3::text || '_MAIN') = $4::text
                 AND pgd.ThoiGianTao >= ($1::text::timestamp AT TIME ZONE '${VN_TZ}')
                 AND pgd.ThoiGianTao < (($2::text::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
            WHERE nl.DaXoa = FALSE AND COALESCE(nl.TenantId::text, 'DEFAULT') = $3::text
            GROUP BY nl.MaNL, nl.TenNL, nl.DonViTinh, tk.SoLuongTon, nl.SoLuongTon, tk.GiaVonDonVi, nl.GiaVonDonVi
            ORDER BY nl.MaNL ASC
        `, [tuNgay, denNgay, tenantId, branchId, isMain]);

        const canDoiKho = result.rows.map(tinhDongCanDoiKho);

        res.json({ kyBaoCao: { tuNgay, denNgay, branchId }, canDoiKho });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Cân đối kho:');
    }
});

// ==========================================
// [v2] DANH MỤC CHO TRANG QUẢN TRỊ
// ==========================================
app.get('/api/nhansu/nhanvien', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const r = await qTenant(
            req,
            `SELECT MaNV, TenNV, TenDangNhap, VaiTro, MucLuongTheoGio, TrangThaiLamViec,
                    (PinHash IS NOT NULL AND PinHash <> '') AS DaDatPin,
                    to_jsonb(NhanVien)->>'email' AS Email,
                    to_jsonb(NhanVien)->>'sodienthoai' AS SoDienThoai,
                    to_jsonb(NhanVien)->>'lastloginat' AS LastLoginAt,
                    COALESCE((to_jsonb(NhanVien)->'permissionsoverride')::jsonb, '{}'::jsonb) AS PermissionsOverride
               FROM NhanVien WHERE COALESCE(TenantId, 'DEFAULT') = $1 ORDER BY MaNV`,
            [tenantId]
        );
        res.json(r.rows.map((n) => {
            const perms = n.permissionsoverride && typeof n.permissionsoverride === 'object' ? n.permissionsoverride : {};
            return {
                maNV: n.manv,
                tenNV: n.tennv,
                tenDangNhap: n.tendangnhap,
                email: n.email || null,
                soDienThoai: n.sodienthoai || null,
                lastLoginAt: n.lastloginat || null,
                vaiTro: n.vaitro,
                mucLuongTheoGio: Number(n.mucluongtheogio),
                trangThaiLamViec: n.trangthailamviec,
                daDatPin: Boolean(n.dadatpin),
                laCaTruong: Boolean(perms.isShiftSupervisor),
                permissionsOverride: perms,
            };
        }));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách nhân viên:');
    }
});

// [P1 - Granular RBAC & Shift Supervisor] Phong/Gỡ Ca trưởng hoặc tinh chỉnh quyền hạn chi tiết (PermissionsOverride)
app.put('/api/nhansu/nhanvien/:maNV/quyen', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    const { maNV } = req.params;
    const { isShiftSupervisor, permissionsOverride = {} } = req.body || {};

    try {
        const updated = await pool.withTenant(tenantId, async (client) => {
            const curRes = await client.query(
                `SELECT MaNV, TenNV, VaiTro,
                        COALESCE((to_jsonb(NhanVien)->'permissionsoverride')::jsonb, '{}'::jsonb) AS PermissionsOverride
                   FROM NhanVien
                  WHERE MaNV = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                  FOR UPDATE`,
                [maNV, tenantId]
            );
            if (curRes.rows.length === 0) return null;
            const cur = curRes.rows[0];
            const prevPerms = cur.permissionsoverride && typeof cur.permissionsoverride === 'object' ? cur.permissionsoverride : {};

            let nextPerms = {
                ...prevPerms,
                ...(permissionsOverride && typeof permissionsOverride === 'object' ? permissionsOverride : {}),
            };
            if (isShiftSupervisor !== undefined) {
                const flag = Boolean(isShiftSupervisor);
                nextPerms = {
                    ...nextPerms,
                    isShiftSupervisor: flag,
                    'order.item.void_approve': flag,
                    'order.refund.approve': flag,
                    'shift.cash_payout.approve': flag,
                    'inventory.stocktake': flag,
                    'report.view_profit': false,
                    'staff.manage_payroll': false,
                };
            }

            await client.query(
                `UPDATE NhanVien
                    SET PermissionsOverride = $2::jsonb
                  WHERE MaNV = $1 AND COALESCE(TenantId, 'DEFAULT') = $3`,
                [maNV, JSON.stringify(nextPerms), tenantId]
            );

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'STAFF_PERMISSIONS_UPDATED',
                doiTuong: 'NHANVIEN',
                maDoiTuong: maNV,
                giaTriCu: prevPerms,
                giaTriMoi: nextPerms,
                lyDo: nextPerms.isShiftSupervisor
                    ? `Phong Ca trưởng (Shift Supervisor) cho ${cur.tennv}`
                    : `Cập nhật quyền chi tiết cho ${cur.tennv}`,
                ip: req.ip,
                batBuoc: true,
            });

            return {
                maNV: cur.manv,
                tenNV: cur.tennv,
                vaiTro: Number(cur.vaitro),
                laCaTruong: Boolean(nextPerms.isShiftSupervisor),
                permissionsOverride: nextPerms,
            };
        });
        if (!updated) return res.status(404).json({ message: 'Không tìm thấy nhân viên thuộc quán này!' });
        res.json({
            message: updated.laCaTruong
                ? `🎖️ Đã phong Ca trưởng (Shift Supervisor) cho "${updated.tenNV}" (được duyệt PIN hủy món/hoàn tiền/chi >50k, ẩn báo cáo lãi lỗ)!`
                : `Đã cập nhật phân quyền chi tiết cho "${updated.tenNV}"!`,
            ...updated,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Cập nhật quyền nhân viên:');
    }
});

// [P0] Tạo nhân viên mới thuộc Tenant hiện tại (hỗ trợ username riêng theo từng quán + Email/SĐT tùy chọn)
app.post('/api/nhansu/nhanvien', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    const { tenNV, tenDangNhap, matKhau, vaiTro = 4, mucLuongTheoGio = 28000, email = '', soDienThoai = '' } = req.body || {};
    const cleanName = String(tenNV || '').trim();
    const cleanUser = String(tenDangNhap || '').trim().toLowerCase();
    const cleanPass = String(matKhau || '');
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPhone = String(soDienThoai || '').replace(/[^0-9+]/g, '').trim();
    const cleanPhoneDigits = cleanPhone.replace(/[^0-9]/g, '');
    const roleNum = Number(vaiTro);

    if (cleanName.length < 2) return res.status(400).json({ message: 'Vui lòng nhập họ tên nhân viên!' });
    if (!/^[a-z0-9_.-]{3,32}$/.test(cleanUser)) {
        return res.status(400).json({ message: 'Tên đăng nhập dài 3–32 ký tự (chỉ chữ thường, số, ., _, -)!' });
    }
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
        return res.status(400).json({ message: 'Email không đúng định dạng!' });
    }
    if (cleanPhone && (cleanPhoneDigits.length < 9 || cleanPhoneDigits.length > 15)) {
        return res.status(400).json({ message: 'Số điện thoại phải gồm 9–15 chữ số!' });
    }
    if (cleanPass.length < 6 || cleanPass.length > 128) {
        return res.status(400).json({ message: 'Mật khẩu nhân viên phải từ 6 ký tự trở lên!' });
    }
    if (![1, 2, 3, 4].includes(roleNum)) {
        return res.status(400).json({ message: 'Vai trò không hợp lệ (1 Quản lý | 2 Pha chế | 3 Phục vụ | 4 Thu ngân)!' });
    }

    try {
        // [Phân hệ 7/9] Kiểm tra trùng username theo PHẠM VI TỪNG TENANT (Quán A và Quán B đều tạo được "thungan1")
        let usernameDup = false;
        try {
            const fnDup = await pool.query('SELECT public.fn_tenant_username_exists($1, $2) AS exists', [tenantId, cleanUser]);
            usernameDup = fnDup.rows[0]?.exists === true;
        } catch {
            try {
                const fnDup2 = await pool.query('SELECT public.fn_username_exists($1, $2) AS exists', [cleanUser, tenantId]);
                usernameDup = fnDup2.rows[0]?.exists === true;
            } catch {
                const dup = await pool.queryTenant(
                    tenantId,
                    `SELECT 1 FROM NhanVien WHERE COALESCE(TenantId, 'DEFAULT') = $2 AND LOWER(TenDangNhap) = $1 LIMIT 1`,
                    [cleanUser, tenantId]
                );
                usernameDup = dup.rows.length > 0;
            }
        }
        if (usernameDup) {
            return res.status(409).json({ message: `Tên đăng nhập "${cleanUser}" đã tồn tại trong quán này!` });
        }

        if (cleanEmail || cleanPhoneDigits.length >= 9) {
            try {
                const cRes = await pool.query(
                    'SELECT email_exists, phone_exists FROM public.fn_contact_exists($1, $2)',
                    [cleanEmail || null, cleanPhoneDigits || null]
                );
                if (cRes.rows[0]?.email_exists) {
                    return res.status(409).json({ message: `Email "${cleanEmail}" đã được sử dụng!` });
                }
                if (cRes.rows[0]?.phone_exists) {
                    return res.status(409).json({ message: `Số điện thoại "${cleanPhone}" đã được sử dụng!` });
                }
            } catch {
                // ignore if Migration 020 not yet applied
            }
        }

        const prefix = req.user.maTienTo && tenantId !== 'DEFAULT' ? `${req.user.maTienTo}_` : '';
        const maNV = `${prefix}NV${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const hashed = await hashPassword(cleanPass);

        await pool.withTenant(tenantId, async (client) => {
            await client.query('SAVEPOINT sp_create_staff_ext');
            try {
                await client.query(
                    `INSERT INTO NhanVien (MaNV, TenNV, VaiTro, TenDangNhap, Email, SoDienThoai, MatKhauHash, MucLuongTheoGio, TrangThaiLamViec, TenantId)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9)`,
                    [maNV, cleanName, roleNum, cleanUser, cleanEmail || null, cleanPhone || null, hashed, Math.max(0, Number(mucLuongTheoGio) || 0), tenantId]
                );
                await client.query('RELEASE SAVEPOINT sp_create_staff_ext');
            } catch (insErr) {
                await client.query('ROLLBACK TO SAVEPOINT sp_create_staff_ext');
                if (insErr.code === '23505') throw insErr;
                await client.query(
                    `INSERT INTO NhanVien (MaNV, TenNV, VaiTro, TenDangNhap, MatKhauHash, MucLuongTheoGio, TrangThaiLamViec, TenantId)
                     VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)`,
                    [maNV, cleanName, roleNum, cleanUser, hashed, Math.max(0, Number(mucLuongTheoGio) || 0), tenantId]
                );
            }
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'STAFF_CREATED',
                doiTuong: 'NHANVIEN',
                maDoiTuong: maNV,
                giaTriMoi: { tenNV: cleanName, tenDangNhap: cleanUser, email: cleanEmail || null, soDienThoai: cleanPhone || null, vaiTro: roleNum },
                ip: req.ip,
                batBuoc: true,
            });
        });
        res.status(201).json({ message: `Đã tạo tài khoản nhân viên "${cleanName}" thành công!`, maNV });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `Tên đăng nhập, Email hoặc SĐT đã tồn tại!` });
        guiLoi(res, error, 'Lỗi API Tạo nhân viên:');
    }
});

// [P0] Khóa / Mở khóa nhân viên — thu hồi hiệu lực JWT ngay lập tức!
app.put('/api/nhansu/nhanvien/:maNV/trangthai', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    const { maNV } = req.params;
    const trangThaiLamViec = Boolean(req.body?.trangThaiLamViec);

    if (String(maNV) === String(req.user.maNV) && !trangThaiLamViec) {
        return res.status(400).json({ message: 'Không thể tự khóa tài khoản Quản lý đang đăng nhập!' });
    }
    try {
        const nvRow = await pool.withTenant(tenantId, async (client) => {
            const r = await client.query(
                `UPDATE NhanVien
                    SET TrangThaiLamViec = $2
                  WHERE MaNV = $1 AND COALESCE(TenantId, 'DEFAULT') = $3
                  RETURNING MaNV, TenNV, TrangThaiLamViec`,
                [maNV, trangThaiLamViec, tenantId]
            );
            if (r.rows.length === 0) return null;
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'STAFF_STATUS_CHANGED',
                doiTuong: 'NHANVIEN',
                maDoiTuong: maNV,
                giaTriMoi: { tenNV: r.rows[0].tennv, trangThaiLamViec },
                ip: req.ip,
                batBuoc: true,
            });
            return r.rows[0];
        });
        if (!nvRow) return res.status(404).json({ message: 'Không tìm thấy nhân viên thuộc quán này!' });

        xoaCacheTrangThaiNV(maNV, tenantId); // Thu hồi ngay phiên JWT đang hoạt động (không chờ hết hạn)
        if (!trangThaiLamViec) {
            // Thu hồi toàn bộ Refresh Token của nhân viên bị khóa ngay lập tức
            await pool.query('SELECT public.fn_revoke_staff_refresh_tokens($1, $2)', [tenantId, maNV]).catch(() => {});
            // [Wave 3A — P1-03] Đẩy ngay kết nối Socket.IO đúng tenant (t:{tenantId}:user:{maNV})
            io.in(`t:${tenantId}:user:${maNV}`).disconnectSockets(true);
        }
        res.json({
            message: trangThaiLamViec ? `Đã mở khóa tài khoản ${nvRow.tennv}!` : `Đã khóa ngay tài khoản ${nvRow.tennv}!`,
            maNV,
            trangThaiLamViec,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Khóa/Mở nhân viên:');
    }
});

// [P0] Đặt lại mật khẩu nhân viên (Quản lý)
app.put('/api/nhansu/nhanvien/:maNV/matkhau', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    const { maNV } = req.params;
    const matKhauMoi = String(req.body?.matKhauMoi || '');
    if (matKhauMoi.length < 6 || matKhauMoi.length > 128) {
        return res.status(400).json({ message: 'Mật khẩu mới phải từ 6 đến 128 ký tự!' });
    }
    try {
        const hashed = await hashPassword(matKhauMoi);
        const nvRow = await pool.withTenant(tenantId, async (client) => {
            const r = await client.query(
                "UPDATE NhanVien SET MatKhauHash = $2 WHERE MaNV = $1 AND COALESCE(TenantId, 'DEFAULT') = $3 RETURNING MaNV, TenNV",
                [maNV, hashed, tenantId]
            );
            if (r.rows.length === 0) return null;
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'STAFF_PASSWORD_RESET',
                doiTuong: 'NHANVIEN',
                maDoiTuong: maNV,
                ip: req.ip,
                batBuoc: true,
            });
            return r.rows[0];
        });
        if (!nvRow) return res.status(404).json({ message: 'Không tìm thấy nhân viên!' });
        res.json({ message: `Đã đặt lại mật khẩu cho ${nvRow.tennv}!` });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Đặt lại mật khẩu:');
    }
});

// [P0] Đặt mã PIN duyệt nhanh (4-6 chữ số) cho Quản lý để duyệt hủy món sau in tạm tính / hao hụt ngay tại quầy POS
app.put('/api/nhansu/nhanvien/:maNV/pin', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    const { maNV } = req.params;
    const pin = String(req.body?.pin || '').trim();
    if (!/^\d{4,6}$/.test(pin)) {
        return res.status(400).json({ message: 'Mã PIN Quản lý phải gồm từ 4 đến 6 chữ số!' });
    }
    try {
        const hashed = await hashPassword(pin);
        const nvRow = await pool.withTenant(tenantId, async (client) => {
            const r = await client.query(
                "UPDATE NhanVien SET PinHash = $2 WHERE MaNV = $1 AND COALESCE(TenantId, 'DEFAULT') = $3 RETURNING MaNV, TenNV",
                [maNV, hashed, tenantId]
            );
            if (r.rows.length === 0) return null;
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'MANAGER_PIN_UPDATED',
                doiTuong: 'NHANVIEN',
                maDoiTuong: maNV,
                ip: req.ip,
                batBuoc: true,
            });
            return r.rows[0];
        });
        if (!nvRow) return res.status(404).json({ message: 'Không tìm thấy nhân viên!' });
        res.json({ message: `Đã thiết lập mã PIN duyệt nhanh cho ${nvRow.tennv}!` });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Đặt mã PIN Quản lý:');
    }
});

app.get('/api/nhansu/ca', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const r = await qTenant(
            req,
            "SELECT MaCa, TenCa, GioBatDau, GioKetThuc FROM CaLamViec WHERE COALESCE(TenantId, 'DEFAULT') = $1 ORDER BY GioBatDau, MaCa",
            [tenantId]
        );
        res.json(r.rows.map((c) => ({ maCa: c.maca, tenCa: c.tenca, gioBatDau: c.giobatdau, gioKetThuc: c.gioketthuc })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách ca làm việc:');
    }
});

// Lịch phân ca + trạng thái chấm công: ?tuNgay=YYYY-MM-DD&denNgay=YYYY-MM-DD (cô lập TenantId)
app.get('/api/nhansu/phanca', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { tuNgay, denNgay } = req.query;
    const tenantId = layTenantId(req);
    if (!tuNgay || !denNgay) return res.status(400).json({ message: 'Vui lòng cung cấp tham số tuNgay và denNgay (YYYY-MM-DD)!' });
    try {
        const r = await qTenant(
            req,
            `SELECT pc.MaPhanCa, pc.MaNV, nv.TenNV, nv.VaiTro, pc.MaCa, clv.TenCa, clv.GioBatDau, clv.GioKetThuc,
                    TO_CHAR(pc.NgayLam, 'YYYY-MM-DD') AS NgayLam, pc.TrangThai, cc.ThoiGianCheckIn, cc.ThoiGianCheckOut
               FROM PhanCa pc
               JOIN NhanVien nv ON nv.MaNV = pc.MaNV
               JOIN CaLamViec clv ON clv.MaCa = pc.MaCa
               LEFT JOIN ChamCong cc ON cc.MaPhanCa = pc.MaPhanCa
              WHERE pc.NgayLam BETWEEN $1 AND $2
                AND COALESCE(nv.TenantId, 'DEFAULT') = $3
              ORDER BY pc.NgayLam, clv.GioBatDau, nv.TenNV`,
            [tuNgay, denNgay, tenantId]
        );
        res.json(r.rows.map((p) => ({
            maPhanCa: p.maphanca,
            maNV: p.manv,
            tenNV: p.tennv,
            vaiTro: p.vaitro,
            maCa: p.maca,
            tenCa: p.tenca,
            gioBatDau: p.giobatdau,
            gioKetThuc: p.gioketthuc,
            ngayLam: p.ngaylam,
            trangThai: p.trangthai, // 1 đã xếp, 2 hoàn thành, 3 vắng
            checkIn: p.thoigiancheckin,
            checkOut: p.thoigiancheckout,
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lịch phân ca:');
    }
});

app.get('/api/kho/nguyenlieu', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    const laQuanLy = req.user.vaiTro === 1;
    const branchId = normalizeInventoryBranch(tenantId, req.query.branchId || req.user.branchId || null);
    const isMain = branchId === `${tenantId}_MAIN`;
    const isBlind = String(req.query.blind || '') === '1' && !laQuanLy;
    try {
        const r = await qTenant(
            req,
            `SELECT nl.MaNL, nl.TenNL, nl.DonViTinh,
                    COALESCE(tk.SoLuongTon, CASE WHEN $3::boolean THEN nl.SoLuongTon ELSE 0 END, 0) AS SoLuongTon,
                    COALESCE(tk.TonDangChuyen, 0) AS TonDangChuyen,
                    COALESCE(tk.HanMucCanhBao, nl.HanMucCanhBao, 0) AS HanMucCanhBao,
                    COALESCE(tk.GiaVonDonVi, nl.GiaVonDonVi, 0) AS GiaVonDonVi,
                    COALESCE((to_jsonb(nl)->>'iskeyitem')::boolean, FALSE) AS IsKeyItem,
                    COALESCE((to_jsonb(nl)->>'labanthanhpham')::boolean, FALSE) AS LaBanThanhPham,
                    COALESCE((to_jsonb(nl)->>'sanluongmemacdinh')::numeric, 1000) AS SanLuongMeMacDinh,
                    (to_jsonb(nl)->>'hansudunggio')::int AS HanSuDungGio,
                    COALESCE((to_jsonb(nl)->>'theodoihandung')::boolean, FALSE) AS TheoDoiHanDung,
                    to_jsonb(nl)->>'manccmacdinh' AS MaNCCMacDinh
               FROM NguyenLieu nl
               LEFT JOIN public.tonkhochinhanh tk
                 ON tk.tenantid = $1::text AND tk.branchid = $2::text AND tk.manl = nl.manl
              WHERE nl.DaXoa = FALSE AND COALESCE(nl.TenantId::text, 'DEFAULT') = $1::text
              ORDER BY nl.TenNL`,
            [tenantId, branchId, isMain]
        );
        res.json(r.rows.map((n) => ({
            maNL: n.manl,
            tenNL: n.tennl,
            donViTinh: n.donvitinh,
            branchId,
            ...(!isBlind ? { soLuongTon: Number(n.soluongton), tonDangChuyen: Number(n.tondangchuyen || 0) } : {}),
            hanMucCanhBao: Number(n.hanmuccanhbao),
            isKeyItem: Boolean(n.iskeyitem),
            laBanThanhPham: Boolean(n.labanthanhpham),
            sanLuongMeMacDinh: Number(n.sanluongmemacdinh || 1000),
            hanSuDungGio: n.hansudunggio ? Number(n.hansudunggio) : null,
            theoDoiHanDung: Boolean(n.theodoihandung),
            maNCCMacDinh: n.manccmacdinh || null,
            ...(laQuanLy ? { giaVonDonVi: Number(n.giavondonvi) } : {}),
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách nguyên liệu:');
    }
});

// [P1 + P4] Cập nhật thuộc tính IsKeyItem / LaBanThanhPham / TheoDoiHanDung / MaNCCMacDinh trên Nguyên liệu
app.put('/api/kho/nguyenlieu/:maNL/thuoctinh', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { maNL } = req.params;
    const tenantId = layTenantId(req);
    const { isKeyItem, laBanThanhPham, sanLuongMeMacDinh, hanSuDungGio, theoDoiHanDung, maNCCMacDinh } = req.body || {};

    try {
        const updated = await pool.withTenant(tenantId, async (client) => {
            const curRes = await client.query(
                `SELECT MaNL, TenNL,
                        COALESCE((to_jsonb(NguyenLieu)->>'iskeyitem')::boolean, FALSE) AS IsKeyItem,
                        COALESCE((to_jsonb(NguyenLieu)->>'labanthanhpham')::boolean, FALSE) AS LaBanThanhPham,
                        COALESCE((to_jsonb(NguyenLieu)->>'sanluongmemacdinh')::numeric, 1000) AS SanLuongMeMacDinh,
                        (to_jsonb(NguyenLieu)->>'hansudunggio')::int AS HanSuDungGio,
                        COALESCE((to_jsonb(NguyenLieu)->>'theodoihandung')::boolean, FALSE) AS TheoDoiHanDung,
                        to_jsonb(NguyenLieu)->>'manccmacdinh' AS MaNCCMacDinh
                   FROM NguyenLieu
                  WHERE MaNL = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2
                  FOR UPDATE`,
                [maNL, tenantId]
            );
            if (curRes.rows.length === 0) return null;
            const cur = curRes.rows[0];
            const nextKey = isKeyItem !== undefined ? Boolean(isKeyItem) : Boolean(cur.iskeyitem);
            const nextBtp = laBanThanhPham !== undefined ? Boolean(laBanThanhPham) : Boolean(cur.labanthanhpham);
            const nextYield =
                Number(sanLuongMeMacDinh) > 0 ? Number(sanLuongMeMacDinh) : Number(cur.sanluongmemacdinh || 1000);
            const nextExpiry =
                hanSuDungGio === null || hanSuDungGio === ''
                    ? null
                    : Number(hanSuDungGio) > 0
                    ? Math.floor(Number(hanSuDungGio))
                    : cur.hansudunggio;
            const nextFefo = theoDoiHanDung !== undefined ? Boolean(theoDoiHanDung) : Boolean(cur.theodoihandung);
            const nextNcc = maNCCMacDinh !== undefined ? (maNCCMacDinh ? String(maNCCMacDinh).trim() : null) : cur.manccmacdinh;

            await client.query(
                `UPDATE NguyenLieu
                    SET IsKeyItem = $2,
                        LaBanThanhPham = $3,
                        SanLuongMeMacDinh = $4,
                        HanSuDungGio = $5,
                        TheoDoiHanDung = $6,
                        MaNCCMacDinh = $7
                  WHERE MaNL = $1 AND COALESCE(TenantId, 'DEFAULT') = $8`,
                [maNL, nextKey, nextBtp, nextYield, nextExpiry, nextFefo, nextNcc, tenantId]
            );
            return {
                maNL: cur.manl,
                tenNL: cur.tennl,
                isKeyItem: nextKey,
                laBanThanhPham: nextBtp,
                sanLuongMeMacDinh: nextYield,
                hanSuDungGio: nextExpiry,
                theoDoiHanDung: nextFefo,
                maNCCMacDinh: nextNcc,
            };
        });
        if (!updated) return res.status(404).json({ message: 'Không tìm thấy nguyên liệu thuộc quán này!' });
        res.json({
            message: `Đã cập nhật thuộc tính cho "${updated.tenNL}"!`,
            ...updated,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Cập nhật thuộc tính nguyên liệu:');
    }
});

// [P1 - Sub-Recipes / Batch Prep] Danh sách Bán thành phẩm & Công thức sơ chế theo mẻ (Công thức Cấp 2)
app.get('/api/kho/ban-thanh-pham', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const data = await pool.withTenant(tenantId, async (client) => {
            const nlRes = await client.query(
                `SELECT MaNL, TenNL, DonViTinh, SoLuongTon, HanMucCanhBao, COALESCE(GiaVonDonVi, 0) AS GiaVonDonVi,
                        COALESCE((to_jsonb(NguyenLieu)->>'labanthanhpham')::boolean, FALSE) AS LaBanThanhPham,
                        COALESCE((to_jsonb(NguyenLieu)->>'sanluongmemacdinh')::numeric, 1000) AS SanLuongMeMacDinh,
                        (to_jsonb(NguyenLieu)->>'hansudunggio')::int AS HanSuDungGio
                   FROM NguyenLieu
                  WHERE DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $1
                  ORDER BY TenNL`,
                [tenantId]
            );
            let ctRows = [];
            await client.query('SAVEPOINT sp_btp_ct_sel');
            try {
                const ctRes = await client.query(
                    `SELECT btp.MaNLThanhPham, btp.MaNLThanhPhan, nl.TenNL AS TenNLThanhPhan,
                            nl.DonViTinh AS DonViThanhPhan, btp.KhoiLuongTieuHao,
                            COALESCE(nl.GiaVonDonVi, 0) AS GiaVonThanhPhan
                       FROM BanThanhPham_CongThuc btp
                       JOIN NguyenLieu nl ON nl.MaNL = btp.MaNLThanhPhan
                      WHERE btp.TenantId = $1
                      ORDER BY nl.TenNL`,
                    [tenantId]
                );
                await client.query('RELEASE SAVEPOINT sp_btp_ct_sel');
                ctRows = ctRes.rows;
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_btp_ct_sel').catch(() => {});
            }
            return { nlRows: nlRes.rows, ctRows };
        });

        const ctMap = new Map();
        for (const r of data.ctRows) {
            if (!ctMap.has(r.manlthanhpham)) ctMap.set(r.manlthanhpham, []);
            ctMap.get(r.manlthanhpham).push({
                maNLThanhPhan: r.manlthanhphan,
                tenNLThanhPhan: r.tennlthanhphan,
                donViTinh: r.donvithanhphan,
                khoiLuongTieuHao: Number(r.khoiluongtieuhao),
                giaVonDonVi: Number(r.giavonthanhphan || 0),
            });
        }

        const list = data.nlRows
            .filter((n) => Boolean(n.labanthanhpham) || ctMap.has(n.manl))
            .map((n) => {
                const dinhMuc = ctMap.get(n.manl) || [];
                const sanLuongMe = Number(n.sanluongmemacdinh || 1000);
                const giaVonMeDuKien = Math.round(
                    dinhMuc.reduce((s, c) => s + c.khoiLuongTieuHao * c.giaVonDonVi, 0)
                );
                const giaVonDonViDuKien =
                    sanLuongMe > 0 ? Math.round((giaVonMeDuKien / sanLuongMe) * 10000) / 10000 : 0;
                return {
                    maNL: n.manl,
                    tenNL: n.tennl,
                    donViTinh: n.donvitinh,
                    soLuongTon: Number(n.soluongton),
                    giaVonDonViHienTai: Number(n.giavondonvi || 0),
                    sanLuongMeMacDinh: sanLuongMe,
                    hanSuDungGio: n.hansudunggio ? Number(n.hansudunggio) : null,
                    giaVonMeDuKien,
                    giaVonDonViDuKien,
                    dinhMuc,
                };
            });
        res.json(list);
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách Bán thành phẩm:');
    }
});

// [P1 - Sub-Recipes / Batch Prep] Thiết lập Công thức Cấp 2 cho Bán thành phẩm (VD: 1 mẻ 2000g Trân châu chín = 1000g Trân châu sống + 250g Đường đen)
app.post('/api/kho/ban-thanh-pham/:maNLThanhPham/congthuc', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('inventory_bom'), async (req, res) => {
    const { maNLThanhPham } = req.params;
    const tenantId = layTenantId(req);
    const { sanLuongMeMacDinh = 1000, hanSuDungGio = null, dinhMuc = [] } = req.body || {};

    if (!Array.isArray(dinhMuc)) {
        return res.status(400).json({ message: 'dinhMuc phải là danh sách nguyên liệu thành phần!' });
    }
    const rawCompIds = [...new Set(dinhMuc.map((d) => String(d?.maNLThanhPhan || '').trim()).filter(Boolean))];
    if (rawCompIds.includes(maNLThanhPham)) {
        return res.status(400).json({
            code: 'CIRCULAR_SUBRECIPE_DETECTED',
            maLoi: 'CIRCULAR_SUBRECIPE_DETECTED',
            message: `Phát hiện vòng lặp công thức: Bán thành phẩm "${maNLThanhPham}" không thể tự chứa chính nó!`,
        });
    }
    const validRows = dinhMuc.filter(
        (d) => d && d.maNLThanhPhan && d.maNLThanhPhan !== maNLThanhPham && Number(d.khoiLuongTieuHao) > 0
    );
    if (validRows.length === 0) {
        return res.status(400).json({ message: 'Cần ít nhất 1 nguyên liệu thành phần hợp lệ có định lượng > 0!' });
    }
    const sanLuong = Number(sanLuongMeMacDinh) > 0 ? Number(sanLuongMeMacDinh) : 1000;
    const hsd = Number(hanSuDungGio) > 0 ? Math.floor(Number(hanSuDungGio)) : null;

    try {
        const result = await chayGiaoDich(async (client) => {
            const tpRes = await client.query(
                "SELECT MaNL, TenNL, DonViTinh FROM NguyenLieu WHERE MaNL = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2 FOR UPDATE",
                [maNLThanhPham, tenantId]
            );
            if (tpRes.rows.length === 0) {
                throw new LoiNghiepVu(404, 'Không tìm thấy nguyên liệu bán thành phẩm thuộc quán này!');
            }

            const compIds = [...new Set(validRows.map((r) => r.maNLThanhPhan))];
            const ownComp = await client.query(
                "SELECT MaNL FROM NguyenLieu WHERE MaNL = ANY($1::varchar[]) AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2",
                [compIds, tenantId]
            );
            if (ownComp.rows.length !== compIds.length) {
                throw new LoiNghiepVu(400, 'Có nguyên liệu thành phần không thuộc quán hiện tại!');
            }

            // [Phân hệ 4 - Cycle Detection DAG] Chặn vòng lặp đa cấp A -> B -> C -> A (sâu tối đa 5 tầng)!
            await detectSubRecipeCycle(client, tenantId, maNLThanhPham, compIds, LoiNghiepVu);

            await client.query(
                `UPDATE NguyenLieu
                    SET LaBanThanhPham = TRUE,
                        SanLuongMeMacDinh = $2,
                        HanSuDungGio = $3
                  WHERE MaNL = $1 AND COALESCE(TenantId, 'DEFAULT') = $4`,
                [maNLThanhPham, sanLuong, hsd, tenantId]
            );

            await client.query(
                'DELETE FROM BanThanhPham_CongThuc WHERE TenantId = $1 AND MaNLThanhPham = $2',
                [tenantId, maNLThanhPham]
            );
            for (const row of validRows) {
                await client.query(
                    `INSERT INTO BanThanhPham_CongThuc (TenantId, MaNLThanhPham, MaNLThanhPhan, KhoiLuongTieuHao)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (TenantId, MaNLThanhPham, MaNLThanhPhan)
                     DO UPDATE SET KhoiLuongTieuHao = EXCLUDED.KhoiLuongTieuHao`,
                    [tenantId, maNLThanhPham, row.maNLThanhPhan, Number(row.khoiLuongTieuHao)]
                );
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'SUBRECIPE_BOM_UPDATED',
                doiTuong: 'NGUYENLIEU',
                maDoiTuong: maNLThanhPham,
                giaTriMoi: { sanLuongMeMacDinh: sanLuong, hanSuDungGio: hsd, dinhMuc: validRows },
                ip: req.ip,
                batBuoc: true,
            });

            return tpRes.rows[0];
        }, tenantId);

        res.json({
            message: `Đã lưu công thức sơ chế mẻ cho "${result.tennl}" (${sanLuong} ${result.donvitinh}/mẻ)!`,
            maNLThanhPham,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lưu công thức Bán thành phẩm:');
    }
});

// [P1 + P4 - Sub-Recipes / Flexible Batch + Yield Loss + FEFO Lot]
app.post('/api/kho/san-xuat-me', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
    const tenantId = layTenantId(req);
    const {
        branchId: rawBranchId = null,
        maNLThanhPham,
        soMe = 1,
        sanLuongThucTe = null,
        ghiChu = null,
        ngayChungTu = null,
    } = req.body || {};
    const numBatches = Number(soMe);
    if (!maNLThanhPham || !(numBatches > 0)) {
        return res.status(400).json({ message: 'Vui lòng cung cấp maNLThanhPham và số mẻ > 0!' });
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const targetBranch = normalizeInventoryBranch(tenantId, rawBranchId || req.user.branchId || null);
            const docDate = await assertPeriodNotLocked(client, tenantId, targetBranch, ngayChungTu, LoiNghiepVu);

            const ctRes = await client.query(
                `SELECT MaNLThanhPhan, KhoiLuongTieuHao
                   FROM BanThanhPham_CongThuc
                  WHERE TenantId = $1 AND MaNLThanhPham = $2
                  ORDER BY MaNLThanhPhan ASC`,
                [tenantId, maNLThanhPham]
            );
            if (ctRes.rows.length === 0) {
                throw new LoiNghiepVu(400, `Bán thành phẩm "${maNLThanhPham}" chưa được cấu hình công thức nguyên liệu thô!`);
            }

            // Khóa đồng thời cả Bán thành phẩm + toàn bộ nguyên liệu thô theo ORDER BY MaNL ASC -> 0% Deadlock!
            const allNlIds = [maNLThanhPham, ...ctRes.rows.map((r) => r.manlthanhphan)];
            const { branchId, stockMap } = await lockBranchStockOrdered(client, tenantId, targetBranch, allNlIds);
            const tp = stockMap.get(maNLThanhPham);
            if (!tp) {
                throw new LoiNghiepVu(404, 'Không tìm thấy bán thành phẩm cần nấu/ủ!');
            }

            const sanLuongLyThuyet = lam3(Number(tp.sanLuongMeMacDinh || 1000) * numBatches);
            const sanLuongMe =
                Number(sanLuongThucTe) > 0 ? lam3(Number(sanLuongThucTe)) : sanLuongLyThuyet;
            const yieldPct =
                sanLuongLyThuyet > 0 ? Math.round((sanLuongMe / sanLuongLyThuyet) * 1000) / 10 : 100;
            const prepLossPct = Math.round((100 - yieldPct) * 10) / 10;
            const highPrepLoss = prepLossPct > 15;

            const caMo = await layCaDangMo(client, 'SHARE', tenantId, { branchId });

            // 1. Trừ nguyên liệu thô (Single-Source TonKhoChiNhanh + FEFO) & tính tổng giá vốn của mẻ
            let tongGiaVonMe = 0;
            const phieuXuat = await client.query(
                `INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan, NgayChungTu, TrangThaiDuyet)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::date, 'POSTED') RETURNING MaGiaoDich`,
                [
                    req.user.maNV,
                    LOAI_GD_TIEU_HAO,
                    `Xuất nguyên liệu thô nấu ${numBatches} mẻ ${tp.tenNL} (thực thu ${sanLuongMe} ${tp.donViTinh}, Yield ${yieldPct}%)`,
                    tenantId,
                    branchId,
                    caMo ? String(caMo.macathungan) : null,
                    docDate,
                ]
            );
            const maGDXuat = phieuXuat.rows[0].magiaodich;

            const dsTieuHao = [];
            for (const row of ctRes.rows) {
                const comp = stockMap.get(row.manlthanhphan);
                if (!comp) {
                    throw new LoiNghiepVu(404, `Không tìm thấy nguyên liệu thành phần ${row.manlthanhphan}!`);
                }
                const klCan = lam3(Number(row.khoiluongtieuhao) * numBatches);
                const fefoRes = await consumeFefoBatches(client, { tenantId, branchId, maNL: comp.maNL, qty: klCan });
                const giaVonComp = fefoRes.weightedCost !== null ? fefoRes.weightedCost : comp.giaVonDonVi;
                tongGiaVonMe += klCan * giaVonComp;

                const compBefore = comp.soLuongTon;
                const compAfter = lam3(compBefore - klCan);
                await insertLedgerLine(client, {
                    maGiaoDich: maGDXuat,
                    maNL: comp.maNL,
                    soLuong: klCan,
                    donGiaNhap: giaVonComp,
                    tinhTrang: `Sơ chế ${numBatches} mẻ ${tp.tenNL}`,
                    tonTruoc: compBefore,
                    tonSau: compAfter,
                    giaVonTruoc: comp.giaVonDonVi,
                    giaVonSau: comp.giaVonDonVi,
                });
                await updateBranchStockRow(client, { tenantId, branchId, maNL: comp.maNL, nextQty: compAfter });
                dsTieuHao.push({
                    maNL: comp.maNL,
                    tenNL: comp.tenNL,
                    soLuong: klCan,
                    donViTinh: comp.donViTinh,
                    giaVonDonVi: giaVonComp,
                });
            }

            // 2. Tính Safe WAC theo Sản lượng Thực thu (sanLuongMe) & cộng tồn kho (LoaiGD = 10: SAN_XUAT_ME_BTP)
            const wacMe = computeSafeWacOnStockIn({
                tonCu: tp.soLuongTon,
                giaVonCu: tp.giaVonDonVi,
                slNhapBase: sanLuongMe,
                tongTienHang: tongGiaVonMe,
            });
            const donGiaVonMe = wacMe.donGiaNhapThucTe;
            const giaVonMoi = wacMe.giaVonMoi;
            const tpBefore = tp.soLuongTon;
            const tpAfter = lam3(tpBefore + sanLuongMe);
            if (Math.abs(wacMe.cogsAdjustment) >= 0.01) {
                await recordCogsAdjustment(client, {
                    tenantId,
                    branchId,
                    businessDate: todayDateVN(),
                    maNL: maNLThanhPham,
                    sourceType: 'NEGATIVE_STOCK_CATCHUP',
                    refMaGiaoDich: null,
                    qtyAffected: Math.min(Math.abs(tpBefore), sanLuongMe),
                    oldUnitCost: tp.giaVonDonVi,
                    newUnitCost: donGiaVonMe,
                    adjustmentAmount: wacMe.cogsAdjustment,
                    createdBy: req.user.maNV,
                });
            }

            const hanSuDungDen =
                tp.hanSuDungGio && Number(tp.hanSuDungGio) > 0
                    ? new Date(Date.now() + Number(tp.hanSuDungGio) * 3600000).toISOString()
                    : null;
            const gioNauStr = new Date(Date.now() + 7 * 3600000).toISOString().slice(11, 16);
            const gioHsdStr = hanSuDungDen
                ? new Date(new Date(hanSuDungDen).getTime() + 7 * 3600000).toISOString().slice(11, 16)
                : null;
            const maLoBtp = `BTP-${gioNauStr.replace(':', '')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

            const moTaMe = [
                `Nấu ${numBatches} mẻ (+${sanLuongMe}/${sanLuongLyThuyet} ${tp.donViTinh} • Yield ${yieldPct}%)`,
                gioHsdStr ? `HSD: ${gioHsdStr}` : null,
                highPrepLoss ? '⚠️ HIGH_PREP_LOSS' : null,
                ghiChu ? String(ghiChu).trim() : null,
            ]
                .filter(Boolean)
                .join(' • ');

            const phieuNhap = await client.query(
                `INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan, NgayChungTu, TrangThaiDuyet)
                 VALUES ($1, 10, $2, $3, $4, $5, $6::date, 'POSTED') RETURNING MaGiaoDich`,
                [
                    req.user.maNV,
                    `Sản xuất mẻ BTP: ${tp.tenNL} (${moTaMe})`.slice(0, 255),
                    tenantId,
                    branchId,
                    caMo ? String(caMo.macathungan) : null,
                    docDate,
                ]
            );
            const maGDNhap = phieuNhap.rows[0].magiaodich;

            await insertLedgerLine(client, {
                maGiaoDich: maGDNhap,
                maNL: maNLThanhPham,
                soLuong: sanLuongMe,
                donGiaNhap: donGiaVonMe,
                tinhTrang: moTaMe,
                tonTruoc: tpBefore,
                tonSau: tpAfter,
                giaVonTruoc: tp.giaVonDonVi,
                giaVonSau: giaVonMoi,
            });
            await updateBranchStockRow(client, {
                tenantId,
                branchId,
                maNL: maNLThanhPham,
                nextQty: tpAfter,
                nextWac: giaVonMoi,
            });

            // 3. Tự động sinh Lô Bán thành phẩm trong public.lo_tonkho (có đồng hồ HSD riêng!)
            const createdLot = await createFefoLot(client, {
                tenantId,
                branchId,
                maNL: maNLThanhPham,
                maLo: maLoBtp,
                nguonLo: 'SUBRECIPE',
                maGiaoDichNguon: String(maGDNhap),
                soLuong: sanLuongMe,
                giaVonLo: donGiaVonMe,
                thoiGianHetHan: hanSuDungDen,
            });

            // [Phân hệ 2 - Smart Auto Un-86] Khi nấu mẻ Bán thành phẩm mới -> tự mở khóa các món/topping/combo bị khóa!
            const autoUnlocked = await autoUn86OnRestock(client, {
                tenantId,
                maNLList: [maNLThanhPham],
            });

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: highPrepLoss ? 'HIGH_PREP_LOSS' : 'SUBRECIPE_BATCH_PRODUCED',
                doiTuong: 'NGUYENLIEU',
                maDoiTuong: maNLThanhPham,
                giaTriCu: { soLuongTon: tpBefore, giaVonDonVi: tp.giaVonDonVi },
                giaTriMoi: {
                    branchId,
                    soMe: numBatches,
                    sanLuongLyThuyet,
                    sanLuongMe,
                    yieldPct,
                    prepLossPct,
                    highPrepLoss,
                    tongGiaVonMe: Math.round(tongGiaVonMe),
                    donGiaVonMe,
                    giaVonDonViMoi: giaVonMoi,
                    hanSuDungDen,
                    lotId: createdLot?.id || null,
                    maLo: createdLot?.malo || maLoBtp,
                    dsTieuHao,
                    autoUnlocked,
                },
                lyDo: moTaMe,
                ip: req.ip,
                batBuoc: true,
            });

            if (highPrepLoss && typeof dispatchFraudAlertFromAudit === 'function') {
                void dispatchFraudAlertFromAudit(pool, {
                    tenantId,
                    hanhDong: 'HIGH_PREP_LOSS',
                    maNV: req.user.maNV,
                    maDoiTuong: maNLThanhPham,
                    giaTriMoi: { tenNL: tp.tenNL, sanLuongLyThuyet, sanLuongMe, prepLossPct },
                    lyDo: `⚠️ Hao hụt sơ chế bất thường (${prepLossPct}%): ${tp.tenNL} chỉ thu ${sanLuongMe}/${sanLuongLyThuyet} ${tp.donViTinh}!`,
                }).catch(() => {});
            }

            return {
                branchId,
                maNLThanhPham,
                tenNL: tp.tenNL,
                donViTinh: tp.donViTinh,
                soMe: numBatches,
                sanLuongLyThuyet,
                sanLuongMe,
                yieldPct,
                prepLossPct,
                highPrepLoss,
                tongGiaVonMe: Math.round(tongGiaVonMe),
                donGiaVonMe,
                giaVonDonViMoi: giaVonMoi,
                soLuongTonMoi: tpAfter,
                hanSuDungDen,
                lot: createdLot
                    ? {
                          id: Number(createdLot.id),
                          maLo: createdLot.malo,
                          soLuongConLai: Number(createdLot.soluongconlai),
                          thoiGianHetHan: createdLot.thoigianhethan,
                      }
                    : null,
                labelPayload: {
                    title: tp.tenNL.toUpperCase(),
                    cookedAt: gioNauStr,
                    expiresAt: gioHsdStr || 'Trong ngày',
                    staff: req.user.tenNV || req.user.maNV,
                    batchCode: maLoBtp,
                    qtyText: `${sanLuongMe} ${tp.donViTinh}`,
                },
                dsTieuHao,
                autoUnlocked,
            };
        }, tenantId);

        if (
            ketQua.autoUnlocked &&
            (ketQua.autoUnlocked.unlockedProducts.length > 0 ||
                ketQua.autoUnlocked.unlockedToppings.length > 0 ||
                ketQua.autoUnlocked.unlockedModifiers.length > 0 ||
                ketQua.autoUnlocked.unlockedCombos.length > 0)
        ) {
            io.to(roomTen(tenantId, 'thungan'))
                .to(roomTen(tenantId, 'phucvu'))
                .to(roomTen(tenantId, 'barista'))
                .emit('menu:86_updated', { type: 'AUTO_UN86_SUBRECIPE', ...ketQua.autoUnlocked });
            for (const p of ketQua.autoUnlocked.unlockedProducts) {
                io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).to(roomTen(tenantId, 'barista')).emit('THUC_DON_THAY_DOI', p);
            }
        }

        res.status(201).json({
            message: `🔥 Đã nấu/ủ xong ${ketQua.soMe} mẻ "${ketQua.tenNL}" (+${ketQua.sanLuongMe} ${ketQua.donViTinh} • Giá vốn WAC mới: ${ketQua.giaVonDonViMoi}đ/${ketQua.donViTinh})!`,
            ...ketQua,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Sản xuất mẻ Bán thành phẩm:');
    }
});

// [Phân hệ 2 - Cascade 86'ing 5 lớp] Khóa/Mở đệ quy theo Chi nhánh (branch_availability_86)
app.put('/api/kho/nguyenlieu/:maNL/tamhet', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
    const { maNL } = req.params;
    const tamHet = Boolean(req.body?.tamHet);
    const tenantId = layTenantId(req);
    const branchId = normalizeBranchId(req.body?.branchId || req.headers['x-branch-id'] || req.user?.branchId || 'DEFAULT');

    try {
        const result = await chayGiaoDich(async (client) => {
            const nlRes = await client.query(
                "SELECT MaNL, TenNL FROM NguyenLieu WHERE MaNL = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2",
                [maNL, tenantId]
            );
            if (nlRes.rows.length === 0) {
                throw new LoiNghiepVu(404, 'Không tìm thấy nguyên liệu thuộc quán này!');
            }
            const nl = nlRes.rows[0];
            const cascade = await cascadeIngredient86(client, {
                tenantId,
                branchId,
                maNL,
                action: tamHet ? 'LOCK' : 'UNLOCK',
                updatedBy: req.user.maNV,
            });

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'INGREDIENT_86_CASCADE',
                doiTuong: 'NGUYENLIEU',
                maDoiTuong: maNL,
                giaTriMoi: {
                    branchId,
                    tenNL: nl.tennl,
                    tamHet,
                    cascadedSubRecipes: cascade.cascadedSubRecipes,
                    soMonAnhHuong: cascade.affectedProducts.length,
                    soToppingAnhHuong: cascade.affectedToppings.length,
                    soModifierAnhHuong: cascade.affectedModifiers.length,
                    soComboAnhHuong: cascade.affectedCombos.length,
                    dsMon: cascade.affectedProducts.map((m) => m.maMon),
                    dsTopping: cascade.affectedToppings.map((t) => t.maTopping),
                },
                ip: req.ip,
                batBuoc: true,
            });

            return {
                branchId,
                maNL: nl.manl,
                tenNL: nl.tennl,
                tamHet,
                ...cascade,
            };
        }, tenantId);

        // [Wave 3A — P1-03] Phát Socket 3 tầng cô lập tuyệt đối theo đúng Chi nhánh (branchId)
        emitScopedKdsEvent(io, {
            tenantId,
            branchId,
            station: 'ALL',
            eventType: 'MENU_86_UPDATED',
            socketEvents: ['menu:86_updated'],
            payload: result,
            includeExpo: true,
            includeWaiter: true,
            includePos: true,
            includeQr: true,
        });
        for (const m of result.affectedProducts) {
            emitScopedKdsEvent(io, {
                tenantId,
                branchId,
                station: 'ALL',
                eventType: 'THUC_DON_THAY_DOI',
                socketEvents: ['THUC_DON_THAY_DOI'],
                payload: m,
                includeExpo: true,
                includeWaiter: true,
                includePos: true,
                includeQr: true,
            });
        }
        for (const t of result.affectedToppings) {
            emitScopedKdsEvent(io, {
                tenantId,
                branchId,
                station: 'ALL',
                eventType: 'TOPPING_THAY_DOI',
                socketEvents: ['TOPPING_THAY_DOI'],
                payload: t,
                includeExpo: true,
                includeWaiter: true,
                includePos: true,
                includeQr: true,
            });
        }

        const tongMon = result.affectedProducts.length;
        const tongTp = result.affectedToppings.length;
        res.json({
            message: tamHet
                ? `🚫 Đã khóa 86 theo "${result.tenNL}": tạm hết ${tongMon} món & ${tongTp} topping!`
                : `✅ Đã mở bán lại theo "${result.tenNL}": mở ${tongMon} món & ${tongTp} topping!`,
            ...result,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Khóa 86 theo nguyên liệu:');
    }
});

// Thực đơn dành cho Quản lý: gồm cả món đã ngừng kinh doanh & trạng thái tạm hết (86) — cô lập TenantId
app.get('/api/sanpham/quanly', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const r = await qTenant(
            req,
            `SELECT sp.MaMon, sp.TenMon, sp.NhomMon, sp.GiaGoc, sp.DangKinhDoanh,
                    to_jsonb(sp)->>'tramchebien' AS TramCheBien,
                    COALESCE(sp.TamHet, FALSE) AS TamHet, sz.KichThuoc, sz.GiaBan
               FROM SanPham sp LEFT JOIN SanPham_Size sz ON sz.MaMon = sp.MaMon
              WHERE COALESCE(sp.TenantId, 'DEFAULT') = $1
              ORDER BY sp.NhomMon, sp.TenMon, sz.GiaBan`,
            [tenantId]
        );
        const ds = [];
        const map = new Map();
        for (const row of r.rows) {
            if (!map.has(row.mamon)) {
                const item = {
                    maMon: row.mamon,
                    tenMon: row.tenmon,
                    nhomMon: row.nhommon,
                    tramCheBien: suyLuanTramCheBien({
                        tramCheBien: row.tramchebien,
                        nhomMon: row.nhommon,
                        tenMon: row.tenmon,
                    }),
                    giaGoc: Number(row.giagoc),
                    dangKinhDoanh: row.dangkinhdoanh,
                    tamHet: Boolean(row.tamhet),
                    sizes: [],
                };
                map.set(row.mamon, item);
                ds.push(item);
            }
            if (row.kichthuoc) map.get(row.mamon).sizes.push({ kichThuoc: row.kichthuoc, giaBan: Number(row.giaban) });
        }
        res.json(ds);
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Thực đơn quản lý:');
    }
});

// [P0] Tạo bàn mới (cô lập tuyệt đối theo TenantId — chống chiếm đoạt bàn đã xóa chéo Tenant)
app.post('/api/ban', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { maBan, tenBan, khuVuc = 'Khu chính', toadoX = 0, toadoY = 0 } = req.body || {};
    const tenantId = layTenantId(req);
    const prefix = req.user.maTienTo && tenantId !== 'DEFAULT' ? `${req.user.maTienTo}_` : '';
    const rawMa = String(maBan || '').trim().toUpperCase();
    const ma = rawMa.startsWith(prefix) ? rawMa : `${prefix}${rawMa}`;
    const ten = String(tenBan || '').trim();
    if (!rawMa || !ten) return res.status(400).json({ message: 'Vui lòng nhập đủ mã bàn và tên bàn!' });

    try {
        const outcome = await pool.withTenant(tenantId, async (client) => {
            const tonTai = await client.query(
                "SELECT DaXoa, COALESCE(TenantId, 'DEFAULT') AS TenantId FROM Ban WHERE MaBan = $1 FOR UPDATE",
                [ma]
            );
            if (tonTai.rows.length > 0) {
                if (tonTai.rows[0].tenantid !== tenantId || !tonTai.rows[0].daxoa) {
                    throw new LoiNghiepVu(409, `Mã bàn ${ma} đã tồn tại!`);
                }
                const upd = await client.query(
                    `UPDATE Ban
                        SET TenBan = $2, KhuVuc = $3, TrangThai = 1, DaXoa = FALSE
                      WHERE MaBan = $1 AND COALESCE(TenantId, 'DEFAULT') = $4
                      RETURNING MaBan`,
                    [ma, ten, String(khuVuc).trim(), tenantId]
                );
                if (upd.rows.length === 0) throw new LoiNghiepVu(409, `Mã bàn ${ma} đã tồn tại!`);
                return { restored: true };
            }

            await client.query(
                `INSERT INTO Ban (MaBan, TenBan, TrangThai, KhuVuc, ToaDoX, ToaDoY, DaXoa, TenantId)
                 VALUES ($1, $2, 1, $3, $4, $5, FALSE, $6)`,
                [ma, ten, String(khuVuc).trim(), Number(toadoX) || 0, Number(toadoY) || 0, tenantId]
            );
            return { restored: false };
        });

        if (outcome.restored) {
            return res.status(200).json({ message: `Đã khôi phục bàn ${ten}!`, maBan: ma });
        }
        res.status(201).json({ message: 'Thêm bàn mới thành công!', maBan: ma });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `Mã bàn ${ma} đã tồn tại!` });
        guiLoi(res, error, 'Lỗi API Tạo bàn:');
    }
});

// [P0] Lấy công thức định lượng theo Size kèm giá vốn hiện tại (cô lập TenantId)
app.get('/api/congthuc/:maMon', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const rows = await pool.withTenant(tenantId, async (client) => {
            const own = await client.query(
                "SELECT 1 FROM SanPham WHERE MaMon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
                [req.params.maMon, tenantId]
            );
            if (own.rows.length === 0) return null;
            const r = await client.query(
                `SELECT ct.MaMon, ct.KichThuoc, ct.MaNL, nl.TenNL, nl.DonViTinh,
                        ct.KhoiLuongTieuHao, COALESCE(nl.GiaVonDonVi, 0) AS GiaVonDonVi
                   FROM CongThuc ct
                   JOIN NguyenLieu nl ON nl.MaNL = ct.MaNL
                  WHERE ct.MaMon = $1
                  ORDER BY ct.KichThuoc, nl.TenNL`,
                [req.params.maMon]
            );
            return r.rows;
        });
        if (!rows) return res.status(404).json({ message: 'Không tìm thấy món!' });
        const theoSize = { S: [], M: [], L: [] };
        for (const row of rows) {
            if (!theoSize[row.kichthuoc]) theoSize[row.kichthuoc] = [];
            theoSize[row.kichthuoc].push({
                maNL: row.manl,
                tenNL: row.tennl,
                donViTinh: row.donvitinh,
                khoiLuongTieuHao: Number(row.khoiluongtieuhao),
                giaVonDonVi: Number(row.giavondonvi),
            });
        }
        res.json({ maMon: req.params.maMon, congThuc: theoSize });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lấy công thức:');
    }
});

// [P0 Hardware Anti-Fraud] Ghi nhận sự kiện Mở két tiền không bán hàng (No-Sale RJ11 Drawer Kick) vào Audit Log bất biến
app.post('/api/pos/drawer-kick', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    const lyDo = String(req.body?.lyDo || '').trim();
    if (lyDo.length < 3) {
        return res.status(400).json({ message: 'Vui lòng nhập lý do mở két tiền không bán hàng (tối thiểu 3 ký tự)!' });
    }
    try {
        await pool.withTenant(tenantId, (client) =>
            ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'DRAWER_NO_SALE_KICK',
                doiTuong: 'KET_TIEN',
                maDoiTuong: 'RJ11',
                giaTriMoi: { lyDo },
                lyDo,
                ip: req.ip,
                batBuoc: true,
            })
        );
        res.json({ ok: true, message: 'Đã ghi nhận nhật ký mở két tiền (No-Sale)!' });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Ghi nhận mở két tiền:');
    }
});

// [P0] Nhật ký Kiểm toán Anti-Fraud cho Quản lý (cô lập theo TenantId + kiểm soát theo gói cước)
app.get('/api/audit-logs', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('audit_logs'), async (req, res) => {
    if (!auditSanSang) return res.json([]);
    const tenantId = layTenantId(req);
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    try {
        const r = await qTenant(
            req,
            `SELECT a.Id, a.MaNV, nv.TenNV, a.VaiTro, a.HanhDong, a.DoiTuong, a.MaDoiTuong,
                    a.GiaTriCu, a.GiaTriMoi, a.LyDo, a.DiaChiIP, a.ThoiGianTao
               FROM Audit_Logs a
               LEFT JOIN NhanVien nv ON nv.MaNV = a.MaNV
              WHERE COALESCE(a.TenantId, 'DEFAULT') = $2
              ORDER BY a.ThoiGianTao DESC
              LIMIT $1`,
            [limit, tenantId]
        );
        res.json(r.rows.map((row) => ({
            id: row.id,
            maNV: row.manv,
            tenNV: row.tennv || row.manv,
            vaiTro: row.vaitro,
            hanhDong: row.hanhdong,
            doiTuong: row.doituong,
            maDoiTuong: row.madoituong,
            giaTriCu: row.giatricu,
            giaTriMoi: row.giatrimoi,
            lyDo: row.lydo,
            diaChiIP: row.diachiip,
            thoiGianTao: row.thoigiantao,
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Nhật ký kiểm toán:');
    }
});

// Đăng ký toàn bộ routes Multi-Tenant SaaS Onboarding & AI Menu Importer (TRƯỚC middleware 404!)
registerSaasRoutes(app, {
    pool,
    chayGiaoDich,
    kiemTraToken,
    choPhepVaiTro,
    gioiHanDangNhap,
    hashPassword,
    jwt,
    ghiAuditLog,
    guiLoi,
    LoiNghiepVu,
    yeuCauTinhNang,
    xoaCacheEntitlement,
});

// Đăng ký cấu hình & bắn thử Cảnh báo Gian lận Tức thời (Telegram / Webhook chủ quán)
registerFraudAlertRoutes(app, {
    pool,
    kiemTraToken,
    choPhepVaiTro,
    yeuCauTinhNang,
    ghiAuditLog,
    guiLoi,
});

// Đăng ký Promotion Engine (Happy Hour / Mã giảm giá) & Chuyển đổi nhân viên nhanh bằng mã PIN (hỗ trợ Fast Store Device Session)
registerPromotionAndPinRoutes(app, {
    pool,
    chayGiaoDich,
    layHoaDonChiTiet,
    kiemTraToken,
    choPhepVaiTro,
    verifyPassword,
    jwt,
    JWT_VERIFY_OPTIONS,
    ACCESS_TOKEN_TTL,
    getRefreshCookie,
    hashRefreshToken,
    xoayVongRefreshTokenCookie,
    taoVaGanRefreshTokenCookie,
    danhGiaTrangThaiGoi,
    layEntitlementTenant,
    ghiAuditLog,
    guiLoi,
    LoiNghiepVu,
});

// Đăng ký cổng Platform Super Admin độc lập (/api/platform/* — tách hoàn toàn khỏi Tenant 'DEFAULT')
registerPlatformAdminRoutes(app, {
    pool,
    chayGiaoDich,
    gioiHanDangNhap,
    ghiNhanDangNhapSai,
    xoaDangNhapSai,
    hashPassword,
    verifyPassword,
    jwt,
    JWT_VERIFY_OPTIONS,
    ghiAuditLog,
    guiLoi,
});

// [PHÂN HỆ 1 - 100/100] Đăng ký Modifiers/Substitution BOM, Combo Pro-rata, Đặt bàn, Course Firing, Lưu tạm đa thiết bị, Chuyển món & Thẻ rung
registerFohPhase1Routes(app, {
    pool,
    chayGiaoDich,
    qTenant,
    layTenantId,
    kiemTraToken,
    choPhepVaiTro,
    ghiAuditLog,
    guiLoi,
    LoiNghiepVu,
    io,
    roomTen,
    layHoaDonChiTiet,
    layHoaDonMoCuaBan,
    layMonTheoMa,
    xoayQrTokenChoCacBan,
    kiemTraHopLeKhuyenMai,
    paymentsSanSangRef: () => paymentsSanSang,
    handleSplitOrder,
});

// [PHÂN HỆ 2 - 100/100] Đăng ký KDS/BDS Sync Replay, Batch/Expo, Print Token, Item Swap, 5-Layer 86'ing, Countdown, Park/Resume, Remake & Telemetry
registerKdsPhase2Routes(app, {
    pool,
    chayGiaoDich,
    qTenant,
    layTenantId,
    kiemTraToken,
    choPhepVaiTro,
    coQuyenHan,
    xacThucPinQuanLy,
    ghiAuditLog,
    ghiCanhBaoGianLan: dispatchFraudAlertFromAudit,
    guiLoi,
    LoiNghiepVu,
    io,
    roomTen,
    SQL_MON_PHA_CHE,
    mapMonPhaChe,
    layMonTheoMa,
    layHoaDonChiTiet,
    layCaDangMo,
    layMapGiaVonNguyenLieu,
    congDinhLuongNguyenLieuDongMon,
    doiTrangThaiMon,
    kiemTraVaPhatAllStationsReady,
    suyLuanTramCheBien,
});

// [PHÂN HỆ 3 - 100/100] Đăng ký Sổ cái Thanh toán/Hoàn tiền, VietQR Manual Match/Overpayment, Blind Shift, Safe Drop 2 lớp & Đối soát 3 chiều
registerPaymentShiftPhase3Routes(app, {
    pool,
    chayGiaoDich,
    qTenant,
    layTenantId,
    kiemTraToken,
    choPhepVaiTro,
    coQuyenHan,
    ghiAuditLog,
    ghiCanhBaoGianLan: dispatchFraudAlertFromAudit,
    guiLoi,
    LoiNghiepVu,
    io,
    roomTen,
    layCaDangMo,
    loiChuaMoCa,
    ghiNhanThanhToanTrongGiaoDich,
    ngayHomNayVN,
    handlers: {
        handleMoCa,
        handleDoiSoatCa,
        handleDongCa,
        handleThuChiCa,
    },
});

// [PHÂN HỆ 4 - 100/100] Đăng ký Reversal Phiếu Nhập + WAC Replay, Định giá Điểm Thời Gian, Lô FEFO, Kiểm Kho Mù 60s, AvT Theo Ca, NCC/Auto-PO/GRN & Khóa Sổ Kho
registerInventoryCogsPhase4Routes(app, {
    pool,
    chayGiaoDich,
    qTenant,
    layTenantId,
    kiemTraToken,
    choPhepVaiTro,
    coQuyenHan,
    ghiAuditLog,
    dispatchFraudAlertFromAudit,
    guiLoi,
    LoiNghiepVu,
    layCaDangMo,
    io,
    roomTen,
    autoUn86OnRestock,
});

// [PHÂN HỆ 8] Đăng ký Hệ sinh thái Mở rộng: QR Order Anti-Spam 3 lớp, Multi-Branch HQ, CRM/Wallet/ZNS, Aggregator Hub, Bida/Bakery & AI Forecast/Upsell
registerEcosystemPhase8Routes(app, {
    pool,
    chayGiaoDich,
    qTenant,
    layTenantId,
    kiemTraToken,
    choPhepVaiTro,
    ghiAuditLog,
    guiLoi,
    LoiNghiepVu,
    io,
    roomTen,
    taoDonHangTrongGiaoDich: async (client, opts) => {
        const kq = await taoOrderTrongGiaoDich(client, opts);
        const hoaDon = await layHoaDonChiTiet(client, kq.maHoaDon);
        return {
            ...kq,
            soMonMoi: Array.isArray(kq.dsMaCTHD) ? kq.dsMaCTHD.length : 0,
            hoaDon,
        };
    },
});

// [Wave 3A — P1-01] Đăng ký nhóm API Thuế VAT Đa Mức & Hóa Đơn Điện Tử Máy Tính Tiền (nội bộ + công khai QR)
registerEInvoiceRoutes(app, {
    pool,
    chayGiaoDich,
    kiemTraToken,
    choPhepVaiTro,
    layTenantId,
    layChiNhanhHienTai: (req) => String(req.headers['x-branch-id'] || req.query?.branchId || req.body?.branchId || 'CN01').trim(),
});

app.get('/', (req, res) => {
    res.json({ 
        status: 'success', 
        message: '☕ POS Cafe Multi-Tenant SaaS API Server đang hoạt động bình thường!',
        version: '3.0.0'
    });
});

// Route kiểm tra sức khỏe hệ thống có tiền tố /api
app.get('/api', (req, res) => {
    res.json({ 
        status: 'success', 
        message: '☕ POS Cafe API Endpoint đã sẵn sàng!',
        version: '3.1.0',
    });
});

// [Phân hệ 7] Healthcheck & Observability Endpoint cho Always-On Cloud (Fly.io / Railway / DigitalOcean / Docker)
app.get('/api/health', async (req, res) => {
    const startNs = process.hrtime.bigint();
    let dbOk = false;
    let dbPingMs = null;
    try {
        await pool.query('SELECT 1 AS ok');
        dbOk = true;
        dbPingMs = Math.round((Number(process.hrtime.bigint() - startNs) / 1e6) * 100) / 100;
    } catch {
        dbOk = false;
    }

    const payload = {
        status: dbOk ? 'ok' : 'degraded',
        version: '3.1.0',
        timestamp: new Date().toISOString(),
        requestId: req.requestId,
        db: { ok: dbOk, pingMs: dbPingMs },
        redis: getRedisStatus(),
        observability: getObservabilitySnapshot(),
    };
    res.status(dbOk ? 200 : 503).json(payload);
});

app.get('/api/ready', async (req, res) => {
    if (isShuttingDown) {
        return res.status(503).json({ ready: false, status: 'DRAINING' });
    }
    try {
        await pool.query('SELECT 1');
        res.status(200).json({ ready: true, status: 'READY' });
    } catch {
        res.status(503).json({ ready: false, status: 'DEGRADED' });
    }
});

// Bắt lỗi các route không tồn tại (LUÔN đặt sau toàn bộ các route!)
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint không tồn tại'
    });
});

// Bắt lỗi chung (JSON sai cú pháp, lỗi không lường trước...)
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
        captureException(err, {
            requestId: req.requestId,
            tenantId: req.user?.tenantId || null,
            maNV: req.user?.maNV || null,
            method: req.method,
            path: req.originalUrl || req.path,
        });
        return res.status(500).json({ message: 'Lỗi máy chủ nội bộ', requestId: req.requestId });
    }
    res.status(status).json({ message: 'Dữ liệu gửi lên không hợp lệ!' });
});

const donDepRefreshTokens = () =>
    pool.query('SELECT public.fn_cleanup_expired_refresh_tokens()').catch(() => {});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logger.info(`Server Backend & Socket.IO (Multi-Tenant SaaS v3.1) đang chạy tại http://localhost:${PORT}`, {
        event: 'SERVER_STARTED',
        port: PORT,
        accessTokenTtl: ACCESS_TOKEN_TTL,
    });
    attachSocketIoRedisAdapter(io).catch(() => {});
    khoiTaoMoRongSchema()
        .then(() => khoiTaoMultiTenantSaaS(pool))
        .then(() => khoiTaoCanhBaoGianLan(pool))
        .then(() => khoiTaoKhuyenMaiSchema(pool))
        .then(() => khoiTaoPlatformAdmins(pool, hashPassword));
    khoiTaoIdempotency().then(donDepIdempotency);
    setInterval(donDepIdempotency, 6 * 60 * 60 * 1000).unref();
    setInterval(donDepRefreshTokens, 12 * 60 * 60 * 1000).unref();
});

// [Wave 2 — P0-06] Graceful Shutdown cho SIGTERM & SIGINT (Zero-downtime rolling deploy)
let shutdownPromise = null;
function gracefulShutdown(signal) {
    if (shutdownPromise) return shutdownPromise;
    isShuttingDown = true;
    logger.info(`Nhận tín hiệu ${signal} — bắt đầu Graceful Shutdown (DRAINING)...`, {
        event: 'SHUTDOWN_START',
        signal,
        inFlightRequests,
    });

    shutdownPromise = (async () => {
        const deadline = Date.now() + 15000;
        const serverClosePromise = new Promise((resolve) => {
            server.close(() => resolve());
        });

        // Chờ các request/transaction đang xử lý hoàn tất (tối đa 15s)
        while (inFlightRequests > 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
        }

        await Promise.race([
            serverClosePromise,
            new Promise((r) => setTimeout(r, Math.max(200, deadline - Date.now()))),
        ]);

        await new Promise((resolve) => {
            try {
                io.close(() => resolve());
            } catch {
                resolve();
            }
        });
        await closeRedisClients().catch(() => {});
        await pool.end().catch(() => {});
        logger.info('Graceful Shutdown hoàn tất sạch sẽ.', { event: 'SHUTDOWN_COMPLETE', signal });
        process.exit(0);
    })();
    return shutdownPromise;
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));