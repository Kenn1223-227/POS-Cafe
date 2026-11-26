const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const { createRateLimitStore } = require('./modules/redisCluster');
require('dotenv').config();

// Chỉ chấp nhận đúng thuật toán đã dùng để ký (chặn "alg confusion").
const JWT_VERIFY_OPTIONS = { algorithms: ['HS256'] };
const ACCESS_TOKEN_TTL = process.env.JWT_ACCESS_EXPIRES_IN || '30m';
const REFRESH_COOKIE_NAME = 'pos_refresh_token';
const REFRESH_TTL_STANDARD_DAYS = Math.max(1, Number(process.env.JWT_REFRESH_DAYS || 7));
const REFRESH_TTL_DEVICE_DAYS = Math.max(7, Number(process.env.JWT_DEVICE_SESSION_DAYS || 30));

// Cache ngắn 30 giây kiểm tra trạng thái nhân viên đang hoạt động (key theo ${tenantId}:${maNV} tránh đụng cross-tenant)
const STAFF_STATUS_TTL_MS = 30 * 1000;
const staffStatusCache = new Map(); // `${tenantId}:${maNV}` -> { active: boolean, expiresAt: number }

const buildStaffCacheKey = (maNV, tenantId = 'DEFAULT') => `${String(tenantId || 'DEFAULT')}:${String(maNV)}`;

const xoaCacheTrangThaiNV = (maNV, tenantId = null) => {
    if (!maNV) return;
    if (tenantId) {
        staffStatusCache.delete(buildStaffCacheKey(maNV, tenantId));
        return;
    }
    const suffix = `:${String(maNV)}`;
    for (const k of staffStatusCache.keys()) {
        if (k.endsWith(suffix)) staffStatusCache.delete(k);
    }
};

// ==========================================
// TIỆN ÍCH COOKIE HTTPONLY & REFRESH TOKEN (0 thư viện ngoài)
// ==========================================
function parseCookies(req) {
    const header = req?.headers?.cookie;
    const out = {};
    if (!header || typeof header !== 'string') return out;
    const parts = header.split(';');
    for (const part of parts) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const name = part.slice(0, idx).trim();
        const rawVal = part.slice(idx + 1).trim();
        if (!name) continue;
        try {
            out[name] = decodeURIComponent(rawVal);
        } catch {
            out[name] = rawVal;
        }
    }
    return out;
}

function getRefreshCookie(req) {
    const cookies = parseCookies(req);
    const token = cookies[REFRESH_COOKIE_NAME];
    return typeof token === 'string' && token.length >= 32 ? token : null;
}

function getCookieSameSite() {
    const configured = String(process.env.COOKIE_SAMESITE || '').trim();
    if (configured) {
        if (/^none$/i.test(configured)) return 'None';
        if (/^strict$/i.test(configured)) return 'Strict';
        if (/^lax$/i.test(configured)) return 'Lax';
        return configured;
    }
    // Production cross-domain frontend (Vercel) -> backend (Fly/Railway/Render) có thể cần SameSite=None; Secure; mặc định Lax an toàn
    return 'Lax';
}

function shouldUseSecureCookie(req, sameSite) {
    // Khi cấu hình SameSite=None, bắt buộc tự động ép Secure=true theo chuẩn RFC 6265bis
    if (/^none$/i.test(sameSite || '')) {
        return true;
    }
    if (process.env.COOKIE_SECURE === 'true') return true;
    if (process.env.COOKIE_SECURE === 'false') return false;
    const proto = String(req?.headers?.['x-forwarded-proto'] || '').toLowerCase();
    return Boolean(req?.secure || proto === 'https' || process.env.NODE_ENV === 'production');
}

function setRefreshCookie(res, req, rawToken, maxAgeSeconds) {
    const sameSite = getCookieSameSite();
    const isSecure = shouldUseSecureCookie(req, sameSite);
    const parts = [
        `${REFRESH_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
        'HttpOnly',
        `SameSite=${sameSite}`,
        'Path=/api/auth',
        `Max-Age=${Math.max(60, Math.floor(Number(maxAgeSeconds) || 7 * 86400))}`,
    ];
    if (isSecure) parts.push('Secure');
    res.append ? res.append('Set-Cookie', parts.join('; ')) : res.setHeader('Set-Cookie', parts.join('; '));
}

function clearRefreshCookie(res, req) {
    const sameSite = getCookieSameSite();
    const isSecure = shouldUseSecureCookie(req, sameSite);
    const parts = [
        `${REFRESH_COOKIE_NAME}=`,
        'HttpOnly',
        `SameSite=${sameSite}`,
        'Path=/api/auth',
        'Max-Age=0',
    ];
    if (isSecure) parts.push('Secure');
    res.append ? res.append('Set-Cookie', parts.join('; ')) : res.setHeader('Set-Cookie', parts.join('; '));
}

function generateRefreshToken() {
    return crypto.randomBytes(48).toString('base64url');
}

function hashRefreshToken(rawToken) {
    return crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
}

async function kiemTraNhanVienConHoatDong(maNV, tenantId = 'DEFAULT') {
    const rawId = String(maNV || '');
    if (!rawId) return false;
    const cacheKey = buildStaffCacheKey(rawId, tenantId);
    const cached = staffStatusCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.active;
    }
    try {
        let active;
        try {
            // Ưu tiên hàm SECURITY DEFINER phạm vi hẹp (chạy được với app_runtime NOBYPASSRLS + Fail-Closed RLS)
            const fnRes = await pool.query('SELECT public.fn_check_staff_active($1) AS active', [rawId]);
            active = fnRes.rows[0]?.active === true;
        } catch {
            // Fallback tương thích ngược nếu Migration 007 chưa được chạy
            const r = await pool.query('SELECT TrangThaiLamViec FROM NhanVien WHERE MaNV = $1', [rawId]);
            active = r.rows.length > 0 && r.rows[0].trangthailamviec === true;
        }
        staffStatusCache.set(cacheKey, { active, expiresAt: Date.now() + STAFF_STATUS_TTL_MS });
        return active;
    } catch {
        // [P0/P1 FIX] Không mở cửa mù (Fail-Open) cho token chưa từng xác thực!
        // Chỉ dùng lại trạng thái cache gần nhất nếu nhân viên đó đã được xác nhận active trước đó; ngược lại chặn Fail-Closed.
        return cached ? Boolean(cached.active) : false;
    }
}

const kiemTraToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Lấy token sau chữ "Bearer "

    if (!token) return res.status(401).json({ message: 'Vui lòng cung cấp Token!' });

    jwt.verify(token, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS, async (err, user) => {
        if (err) return res.status(403).json({ message: 'Token không hợp lệ hoặc đã hết hạn!' });
        if (user?.type === 'PLATFORM_ADMIN') {
            return res.status(403).json({
                message: 'Token Platform Admin không dùng trực tiếp cho API bán hàng của quán! Hãy dùng chức năng Hỗ trợ giả lập (Impersonate).',
            });
        }
        const conHoatDong = await kiemTraNhanVienConHoatDong(user.maNV, user.tenantId || 'DEFAULT');
        if (!conHoatDong) {
            return res.status(401).json({ message: 'Tài khoản nhân viên đã bị khóa hoặc ngừng làm việc!' });
        }
        req.user = user;
        next();
    });
};

// ==========================================
// GIỚI HẠN ĐĂNG NHẬP SAI PHÂN TÁN (chống dò mật khẩu)
// Tự động dùng Redis khi cấu hình REDIS_URL; fallback RAM khi chạy đơn lẻ.
// ==========================================
const CUA_SO_MS = 15 * 60 * 1000;
const TOI_DA_MOI_TAI_KHOAN = 5; // theo cặp (IP + tên đăng nhập)
const TOI_DA_MOI_IP = 30;       // toàn bộ tài khoản từ cùng 1 IP

const loginRateStore = createRateLimitStore('login_fail');

const khoaTaiKhoan = (req, ten) => `tk:${req.ip}|${String(ten || '').toLowerCase().slice(0, 64)}`;
const khoaIP = (req) => `ip:${req.ip}`;

const gioiHanDangNhap = async (req, res, next) => {
    try {
        const ten = req.body && typeof req.body.tenDangNhap === 'string' ? req.body.tenDangNhap : '';
        const [tk, ip] = await Promise.all([
            loginRateStore.get(khoaTaiKhoan(req, ten)),
            loginRateStore.get(khoaIP(req)),
        ]);
        const biChan = tk && tk.dem >= TOI_DA_MOI_TAI_KHOAN ? tk : ip && ip.dem >= TOI_DA_MOI_IP ? ip : null;

        if (biChan) {
            const giay = Math.max(1, Math.ceil((biChan.hetHan - Date.now()) / 1000));
            res.set('Retry-After', String(giay));
            return res.status(429).json({
                message: `Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau ${Math.ceil(giay / 60)} phút.`,
            });
        }
        next();
    } catch {
        next();
    }
};

const ghiNhanDangNhapSai = (req, ten) => {
    void loginRateStore.increment(khoaTaiKhoan(req, ten), CUA_SO_MS);
    void loginRateStore.increment(khoaIP(req), CUA_SO_MS);
};

const xoaDangNhapSai = (req, ten) => {
    void loginRateStore.reset(khoaTaiKhoan(req, ten));
};

setInterval(() => {
    const now = Date.now();
    loginRateStore.cleanup();
    for (const [k, v] of staffStatusCache) if (v.expiresAt <= now) staffStatusCache.delete(k);
}, 5 * 60 * 1000).unref();

module.exports = {
    kiemTraToken,
    kiemTraNhanVienConHoatDong,
    xoaCacheTrangThaiNV,
    gioiHanDangNhap,
    ghiNhanDangNhapSai,
    xoaDangNhapSai,
    JWT_VERIFY_OPTIONS,
    ACCESS_TOKEN_TTL,
    REFRESH_COOKIE_NAME,
    REFRESH_TTL_STANDARD_DAYS,
    REFRESH_TTL_DEVICE_DAYS,
    parseCookies,
    getRefreshCookie,
    setRefreshCookie,
    clearRefreshCookie,
    generateRefreshToken,
    hashRefreshToken,
};
