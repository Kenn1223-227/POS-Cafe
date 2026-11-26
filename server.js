'use strict';

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();
const pool = require('./db');
const {
    reportPool,
    platformPool,
    isReadReplicaConfigured,
    chayTruyVanBaoCao,
    shouldRunAutoDdl,
} = pool;
const { kiemTraCauHinh } = require('./config');
const { hashPassword, verifyPassword } = require('./password');
const {
    khoiTaoMultiTenantSaaS,
    kiemTraMultiTenantSanSang,
    registerSaasRoutes,
    danhGiaTrangThaiGoi,
    taoMiddlewareKiemTraHanSuDung,
} = require('./modules/saasRoutes');
const {
    khoiTaoPlatformAdmins,
    registerPlatformAdminRoutes,
    taoMiddlewareTinhNang,
    taoMiddlewareHanMucDonThang,
    layEntitlementTenant,
    xoaCacheEntitlement,
    taoMiddlewarePlatformAdmin,
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
    registerPromotionAndPinRoutes,
} = require('./modules/promotionAndPinService');
const { kiemTraVaTangVersionHoaDon } = require('./modules/fohEngineService');
const { registerFohPhase1Routes } = require('./modules/fohPhase1Routes');
const { autoUn86OnRestock, recordAndEmitOrderNewByStation } = require('./modules/kdsPhase2Engine');
const { registerKdsPhase2Routes } = require('./modules/kdsPhase2Routes');
const { registerPaymentShiftPhase3Routes } = require('./modules/paymentShiftPhase3Routes');
const { registerInventoryCogsPhase4Routes } = require('./modules/inventoryCogsPhase4Routes');
const {
    xoayQrTokenChoCacBan,
    registerEcosystemPhase8Routes,
} = require('./modules/ecosystemPhase8Routes');
const { registerEInvoiceRoutes } = require('./modules/einvoiceRoutes');
const { registerChainFinanceOpsRoutes } = require('./modules/chainFinanceOpsRoutes');
const { registerPriceBookAndZnsRoutes } = require('./modules/priceBookAndZnsRoutes');
const { registerHrPayrollTipsRoutes } = require('./modules/hrPayrollTipsRoutes');
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

// [Wave 4B — P2-01] Modular Core & Domain Strangler Architecture (Zero circular requires)
const {
    coQuyenHan,
    suyLuanTramCheBien,
    ngayHomNayVN,
    LoiNghiepVu,
    guiLoi,
    choPhepVaiTro,
    layTenantId,
    roomTen,
    detectOfflineClockDrift,
    createCoreRuntime,
} = require('./src/core/auditAndSecurity');
const {
    registerSocketHandlers,
    emitToBranch,
    emitToRole,
    emitToTenant,
} = require('./src/core/socketRooms');
const { createOrderHelpers } = require('./src/core/orderHelpers');
const { registerAuthDomain } = require('./src/domains/auth');
const { registerMenuDomain } = require('./src/domains/menu');
const { registerOrdersDomain } = require('./src/domains/orders');
const { registerInventoryDomain } = require('./src/domains/inventory');
const { registerHrDomain } = require('./src/domains/hr');
const { registerCrmDomain } = require('./src/domains/crm');
const {
    registerReportsDomain,
    computeBusinessDate,
    refreshDailyBranchFinancialSummary,
} = require('./src/domains/reports');
const { registerSystemDomain } = require('./src/domains/system');

if (require.main === module) {
    kiemTraCauHinh(); // dừng ngay nếu thiếu/yếu JWT_SECRET hoặc thiếu DATABASE_URL
}

const app = express();
// Chạy sau reverse proxy (Render / Fly / Railway / Vercel / Nginx):
// Cần 'trust proxy' để req.secure và req.ip nhận diện đúng giao thức HTTPS và IP khách thật.
const trustProxyConfig = process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY : (process.env.NODE_ENV === 'production' ? 1 : false);
if (trustProxyConfig) {
    const v = String(trustProxyConfig);
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
        return res.status(503).json({
            status: 'DRAINING',
            message: 'Hệ thống đang bảo trì/khởi động lại, vui lòng thử lại sau vài giây.',
        });
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
    allowedHeaders: ['Content-Type', 'Authorization', 'Token', 'Idempotency-Key', 'X-Offline-Sync', 'X-Request-Id', 'X-Device-Id', 'X-Branch-Id'],
    exposedHeaders: ['X-Request-Id', 'Date'],
}));
// Chỉ mở body limit 8mb riêng cho /api/ai/parse-menu; toàn cục siết còn 512kb chống Memory DoS
app.use('/api/ai/parse-menu', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '512kb' }));

// ============================================================================
// COMPOSITION ROOT: DỰNG CORE RUNTIME, SOCKET.IO & DEPENDENCY INJECTION CONTEXT
// ============================================================================
const coreRuntime = createCoreRuntime({
    pool,
    shouldRunAutoDdl,
    dispatchFraudAlertFromAudit,
    kiemTraCanhBaoTanSuatGianLan,
    verifyPassword,
    logger,
});

const {
    runtimeFlags,
    qTenant,
    chayGiaoDich,
    khoiTaoIdempotency,
    khoiTaoMoRongSchema,
    ghiAuditLog,
    donDepIdempotency,
    xacThucPinQuanLy,
} = coreRuntime;

registerSocketHandlers(io, {
    pool,
    JWT_VERIFY_OPTIONS,
    kiemTraNhanVienConHoatDong,
});

const orderHelpers = createOrderHelpers({
    pool,
    io,
    runtimeFlags,
    chayGiaoDich,
    ghiAuditLog,
    dispatchFraudAlertFromAudit,
    kiemTraCanhBaoTanSuatGianLan,
    xacThucPinQuanLy,
    coQuyenHan,
});

const layChiNhanhHienTai = (req) =>
    String(req.headers['x-branch-id'] || req.query?.branchId || req.body?.branchId || 'CN01').trim();

const sharedDeps = {
    pool,
    reportPool,
    isReadReplicaConfigured,
    io,
    runtimeFlags,
    chayGiaoDich,
    chayTruyVanBaoCao,
    qTenant,
    layTenantId,
    layChiNhanhHienTai,
    kiemTraToken,
    choPhepVaiTro,
    coQuyenHan,
    kiemTraHanSuDung,
    yeuCauTinhNang,
    kiemTraHanMucDonThang,
    gioiHanDangNhap,
    ghiNhanDangNhapSai,
    xoaDangNhapSai,
    hashPassword,
    verifyPassword,
    xoaCacheTrangThaiNV,
    JWT_VERIFY_OPTIONS,
    ACCESS_TOKEN_TTL,
    REFRESH_TTL_STANDARD_DAYS,
    REFRESH_TTL_DEVICE_DAYS,
    getRefreshCookie,
    setRefreshCookie,
    clearRefreshCookie,
    generateRefreshToken,
    hashRefreshToken,
    danhGiaTrangThaiGoi,
    layEntitlementTenant,
    xoaCacheEntitlement,
    ghiAuditLog,
    dispatchFraudAlertFromAudit,
    kiemTraCanhBaoTanSuatGianLan,
    xacThucPinQuanLy,
    guiLoi,
    LoiNghiepVu,
    roomTen,
    emitToBranch,
    emitToRole,
    emitToTenant,
    ngayHomNayVN,
    ...orderHelpers,
};

// ============================================================================
// ĐĂNG KÝ TOÀN BỘ 8 DOMAIN CHÍNH TRONG src/domains/ (STRANGLER PATTERN)
// ============================================================================
const authDomain = registerAuthDomain(app, sharedDeps);
registerMenuDomain(app, sharedDeps);
const ordersDomain = registerOrdersDomain(app, sharedDeps);
const inventoryDomain = registerInventoryDomain(app, sharedDeps);
registerHrDomain(app, sharedDeps);
registerCrmDomain(app, sharedDeps);
const reportsDomain = registerReportsDomain(app, sharedDeps);
registerSystemDomain(app, sharedDeps);

// ============================================================================
// ĐĂNG KÝ CÁC MODULE CHUYÊN BIỆT HIỆN HỮU (modules/*Routes.js)
// ============================================================================
const kiemTraPlatformAdmin = taoMiddlewarePlatformAdmin(pool, jwt, JWT_VERIFY_OPTIONS);

registerSaasRoutes(app, {
    pool,
    chayGiaoDich,
    kiemTraToken,
    choPhepVaiTro,
    kiemTraPlatformAdmin,
    gioiHanDangNhap,
    hashPassword,
    jwt,
    ghiAuditLog,
    guiLoi,
    LoiNghiepVu,
    yeuCauTinhNang,
    xoaCacheEntitlement,
});

registerFraudAlertRoutes(app, {
    pool,
    kiemTraToken,
    choPhepVaiTro,
    yeuCauTinhNang,
    ghiAuditLog,
    guiLoi,
});

registerPromotionAndPinRoutes(app, {
    pool,
    chayGiaoDich,
    layHoaDonChiTiet: orderHelpers.layHoaDonChiTiet,
    kiemTraToken,
    choPhepVaiTro,
    coQuyenHan,
    xacThucPinQuanLy,
    verifyPassword,
    jwt,
    JWT_VERIFY_OPTIONS,
    ACCESS_TOKEN_TTL,
    getRefreshCookie,
    hashRefreshToken,
    xoayVongRefreshTokenCookie: authDomain.xoayVongRefreshTokenCookie,
    taoVaGanRefreshTokenCookie: authDomain.taoVaGanRefreshTokenCookie,
    danhGiaTrangThaiGoi,
    layEntitlementTenant,
    ghiAuditLog,
    guiLoi,
    LoiNghiepVu,
});

registerPlatformAdminRoutes(app, {
    pool,
    platformPool,
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

registerFohPhase1Routes(app, {
    pool,
    chayGiaoDich,
    qTenant,
    layTenantId,
    kiemTraToken,
    choPhepVaiTro,
    coQuyenHan,
    xacThucPinQuanLy,
    ghiAuditLog,
    guiLoi,
    LoiNghiepVu,
    io,
    roomTen,
    emitToBranch,
    emitToRole,
    emitToTenant,
    layHoaDonChiTiet: orderHelpers.layHoaDonChiTiet,
    layHoaDonMoCuaBan: orderHelpers.layHoaDonMoCuaBan,
    layMonTheoMa: orderHelpers.layMonTheoMa,
    xoayQrTokenChoCacBan,
    kiemTraHopLeKhuyenMai,
    paymentsSanSangRef: () => runtimeFlags.paymentsSanSang,
    handleSplitOrder: ordersDomain.handleSplitOrder,
});

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
    emitToBranch,
    emitToRole,
    emitToTenant,
    SQL_MON_PHA_CHE: orderHelpers.SQL_MON_PHA_CHE,
    mapMonPhaChe: orderHelpers.mapMonPhaChe,
    layMonTheoMa: orderHelpers.layMonTheoMa,
    layHoaDonChiTiet: orderHelpers.layHoaDonChiTiet,
    layCaDangMo: orderHelpers.layCaDangMo,
    layMapGiaVonNguyenLieu: orderHelpers.layMapGiaVonNguyenLieu,
    congDinhLuongNguyenLieuDongMon: orderHelpers.congDinhLuongNguyenLieuDongMon,
    doiTrangThaiMon: orderHelpers.doiTrangThaiMon,
    kiemTraVaPhatAllStationsReady: orderHelpers.kiemTraVaPhatAllStationsReady,
    suyLuanTramCheBien,
});

registerPaymentShiftPhase3Routes(app, {
    pool,
    chayGiaoDich,
    qTenant,
    layTenantId,
    kiemTraToken,
    choPhepVaiTro,
    coQuyenHan,
    kiemTraHanSuDung,
    ghiAuditLog,
    ghiCanhBaoGianLan: dispatchFraudAlertFromAudit,
    guiLoi,
    LoiNghiepVu,
    io,
    roomTen,
    emitToBranch,
    emitToRole,
    emitToTenant,
    layCaDangMo: orderHelpers.layCaDangMo,
    loiChuaMoCa: orderHelpers.loiChuaMoCa,
    ghiNhanThanhToanTrongGiaoDich: orderHelpers.ghiNhanThanhToanTrongGiaoDich,
    ngayHomNayVN,
    handlers: {
        handleMoCa: reportsDomain.handleMoCa,
        handleDoiSoatCa: reportsDomain.handleDoiSoatCa,
        handleDongCa: reportsDomain.handleDongCa,
        handleThuChiCa: reportsDomain.handleThuChiCa,
    },
});

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
    layCaDangMo: orderHelpers.layCaDangMo,
    io,
    roomTen,
    emitToBranch,
    emitToRole,
    emitToTenant,
    autoUn86OnRestock,
});

registerEcosystemPhase8Routes(app, {
    pool,
    chayGiaoDich,
    qTenant,
    layTenantId,
    kiemTraToken,
    choPhepVaiTro,
    yeuCauTinhNang,
    layEntitlementTenant,
    ghiAuditLog,
    guiLoi,
    LoiNghiepVu,
    io,
    roomTen,
    emitToBranch,
    emitToRole,
    emitToTenant,
    taoDonHangTrongGiaoDich: async (client, opts) => {
        const kq = await orderHelpers.taoOrderTrongGiaoDich(client, opts);
        const hoaDon = await orderHelpers.layHoaDonChiTiet(client, kq.maHoaDon);
        const monMoiFired = Array.isArray(kq.dsMaCTHDFired) && kq.dsMaCTHDFired.length > 0
            ? await orderHelpers.layMonTheoMa(client, kq.dsMaCTHDFired)
            : [];
        const kdsEmitPlan = monMoiFired.length > 0
            ? await recordAndEmitOrderNewByStation(client, io, {
                  tenantId: opts.tenantId || 'DEFAULT',
                  branchId: kq.branchId || opts.branchId || 'DEFAULT',
                  maHoaDon: kq.maHoaDon,
                  maBan: opts.maBan || null,
                  tenBan: monMoiFired[0]?.tenBan || hoaDon?.ban?.[0]?.tenBan || null,
                  mangDi: !opts.maBan,
                  themMon: !kq.laHoaDonMoi,
                  dotGoi: kq.dotGoi || 1,
                  monMoiFired,
              })
            : null;
        return {
            ...kq,
            soMonMoi: Array.isArray(kq.dsMaCTHD) ? kq.dsMaCTHD.length : 0,
            hoaDon,
            kdsEmitPlan,
        };
    },
});

registerEInvoiceRoutes(app, {
    pool,
    chayGiaoDich,
    kiemTraToken,
    choPhepVaiTro,
    yeuCauTinhNang,
    layTenantId,
    layChiNhanhHienTai,
});

const wave4aRouteDeps = {
    pool,
    reportPool,
    chayGiaoDich,
    chayTruyVanBaoCao,
    kiemTraToken,
    choPhepVaiTro,
    yeuCauTinhNang,
    layTenantId,
    layChiNhanhHienTai,
    ghiAuditLog,
};
registerChainFinanceOpsRoutes(app, wave4aRouteDeps);
registerPriceBookAndZnsRoutes(app, wave4aRouteDeps);
registerHrPayrollTipsRoutes(app, wave4aRouteDeps);

// ============================================================================
// HEALTH / READY / 404 / GLOBAL ERROR HANDLER
// ============================================================================
app.get('/', (req, res) => {
    res.json({
        status: 'success',
        message: '☕ POS Cafe Multi-Tenant SaaS API Server đang hoạt động bình thường!',
        version: '3.0.0',
    });
});

app.get('/api', (req, res) => {
    res.json({
        status: 'success',
        message: '☕ POS Cafe API Endpoint đã sẵn sàng!',
        version: '3.1.0',
    });
});

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
        db: { ok: dbOk, pingMs: dbPingMs, readReplicaConfigured: isReadReplicaConfigured },
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
        message: 'Endpoint không tồn tại',
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

async function runStartupBootstrap() {
    attachSocketIoRedisAdapter(io).catch(() => {});
    // Kiểm tra kết nối DB trước khi bootstrap (fail-fast nếu DB không phản hồi)
    await pool.query('SELECT 1');

    if (!shouldRunAutoDdl()) {
        logger.info('Auto-DDL đã bị khóa (NODE_ENV=production hoặc SKIP_AUTO_DDL=true). Chỉ kiểm tra sự tồn tại của bảng.', {
            event: 'AUTO_DDL_DISABLED_IN_PRODUCTION',
            nodeEnv: process.env.NODE_ENV || null,
            skipAutoDdl: process.env.SKIP_AUTO_DDL || null,
        });
        await Promise.all([
            khoiTaoMoRongSchema(),
            khoiTaoIdempotency(),
            kiemTraMultiTenantSanSang(pool),
        ]);
        await donDepIdempotency();
    } else {
        await khoiTaoMoRongSchema()
            .then(() => khoiTaoMultiTenantSaaS(pool))
            .then(() => khoiTaoCanhBaoGianLan(pool))
            .then(() => khoiTaoKhuyenMaiSchema(pool))
            .then(() => khoiTaoPlatformAdmins(pool, hashPassword));
        await khoiTaoIdempotency().then(donDepIdempotency);
    }

    if (!runtimeFlags.idemSanSang || !runtimeFlags.auditSanSang) {
        throw new Error(
            `Bootstrap bảng nền thất bại: idemSanSang=${runtimeFlags.idemSanSang}, auditSanSang=${runtimeFlags.auditSanSang}`
        );
    }

    setInterval(donDepIdempotency, 6 * 60 * 60 * 1000).unref();
    setInterval(donDepRefreshTokens, 12 * 60 * 60 * 1000).unref();
}

const PORT = process.env.PORT || 3000;
if (require.main === module) {
    (async () => {
        try {
            await runStartupBootstrap();
            server.listen(PORT, () => {
                logger.info(`Server Backend & Socket.IO (Multi-Tenant SaaS v3.1) đang chạy tại http://localhost:${PORT}`, {
                    event: 'SERVER_STARTED',
                    port: PORT,
                    accessTokenTtl: ACCESS_TOKEN_TTL,
                    readReplicaConfigured: isReadReplicaConfigured,
                });
            });
        } catch (err) {
            logger.error('Lỗi nghiêm trọng khi khởi động bootstrap schema/DB — dừng server (fail-fast)', {
                event: 'BOOTSTRAP_ERROR',
                error: err.message,
            });
            process.exit(1);
        }
    })();
}

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
        if (platformPool && platformPool !== pool) {
            await platformPool.end().catch(() => {});
        }
        if (reportPool && reportPool !== pool) {
            await reportPool.end().catch(() => {});
        }
        await pool.end().catch(() => {});
        logger.info('Graceful Shutdown hoàn tất sạch sẽ.', { event: 'SHUTDOWN_COMPLETE', signal });
        process.exit(0);
    })();
    return shutdownPromise;
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Re-export các helper cốt lõi cho Unit / Integration Tests (Zero Breaking Changes)
module.exports = {
    app,
    server,
    io,
    pool,
    reportPool,
    isReadReplicaConfigured,
    chayTruyVanBaoCao,
    shouldRunAutoDdl,
    kiemTraVaTangVersionHoaDon,
    suyLuanTramCheBien,
    detectOfflineClockDrift,
    computeBusinessDate,
    refreshDailyBranchFinancialSummary,
    checkExpiringBatchesAndEmitKds: inventoryDomain.checkExpiringBatchesAndEmitKds,
    runStartupBootstrap,
    gracefulShutdown,
};
