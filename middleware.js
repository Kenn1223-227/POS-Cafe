const jwt = require('jsonwebtoken');
require('dotenv').config();

// Chỉ chấp nhận đúng thuật toán đã dùng để ký (chặn "alg confusion").
const JWT_VERIFY_OPTIONS = { algorithms: ['HS256'] };

const kiemTraToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Lấy token sau chữ "Bearer "

    if (!token) return res.status(401).json({ message: 'Vui lòng cung cấp Token!' });

    jwt.verify(token, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS, (err, user) => {
        if (err) return res.status(403).json({ message: 'Token không hợp lệ hoặc đã hết hạn!' });
        req.user = user;
        next();
    });
};

// ==========================================
// GIỚI HẠN ĐĂNG NHẬP SAI (chống dò mật khẩu)
// Lưu trong RAM của tiến trình: đủ cho 1 instance; nhiều instance cần chuyển sang Redis.
// ==========================================
const CUA_SO_MS = 15 * 60 * 1000;
const TOI_DA_MOI_TAI_KHOAN = 5; // theo cặp (IP + tên đăng nhập)
const TOI_DA_MOI_IP = 30;       // toàn bộ tài khoản từ cùng 1 IP

const bangDem = new Map(); // key -> { dem, hetHan }

const laySoLan = (key) => {
    const m = bangDem.get(key);
    if (!m) return null;
    if (m.hetHan <= Date.now()) {
        bangDem.delete(key);
        return null;
    }
    return m;
};

const tang = (key) => {
    const m = laySoLan(key);
    if (m) m.dem += 1;
    else bangDem.set(key, { dem: 1, hetHan: Date.now() + CUA_SO_MS });
};

const khoaTaiKhoan = (req, ten) => `tk:${req.ip}|${String(ten || '').toLowerCase().slice(0, 64)}`;
const khoaIP = (req) => `ip:${req.ip}`;

const gioiHanDangNhap = (req, res, next) => {
    const ten = req.body && typeof req.body.tenDangNhap === 'string' ? req.body.tenDangNhap : '';
    const tk = laySoLan(khoaTaiKhoan(req, ten));
    const ip = laySoLan(khoaIP(req));
    const biChan = tk && tk.dem >= TOI_DA_MOI_TAI_KHOAN ? tk : ip && ip.dem >= TOI_DA_MOI_IP ? ip : null;

    if (biChan) {
        const giay = Math.max(1, Math.ceil((biChan.hetHan - Date.now()) / 1000));
        res.set('Retry-After', String(giay));
        return res.status(429).json({
            message: `Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau ${Math.ceil(giay / 60)} phút.`,
        });
    }
    next();
};

const ghiNhanDangNhapSai = (req, ten) => {
    tang(khoaTaiKhoan(req, ten));
    tang(khoaIP(req));
};

const xoaDangNhapSai = (req, ten) => {
    bangDem.delete(khoaTaiKhoan(req, ten));
};

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of bangDem) if (v.hetHan <= now) bangDem.delete(k);
}, 5 * 60 * 1000).unref();

module.exports = { kiemTraToken, gioiHanDangNhap, ghiNhanDangNhapSai, xoaDangNhapSai, JWT_VERIFY_OPTIONS };
