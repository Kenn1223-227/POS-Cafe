const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();
const pool = require('./db');
const { kiemTraToken } = require('./middleware');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors({
    origin: '*', // Hoặc thay bằng ['https://cafe-pos-frontend-iota.vercel.app', 'http://localhost:5173']
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Token']
}));
app.use(express.json());

// ==========================================
// [v2] TIỆN ÍCH DÙNG CHUNG
// ==========================================
const TEN_VAI_TRO = { 1: 'Quản lý', 2: 'Pha chế', 3: 'Phục vụ', 4: 'Thu ngân' };
const SIZE_HOP_LE = ['S', 'M', 'L'];
const PHUONG_THUC_TT = ['TIEN_MAT', 'CHUYEN_KHOAN', 'THE'];
const LOAI_GD_TIEU_HAO = 6; // PhieuGiaoDichKho.LoaiGD = 6: tiêu hao nguyên liệu do bán hàng

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

async function chayGiaoDich(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
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

// Ca thu ngân đang mở của toàn hệ thống (kieuKhoa: 'SHARE' | 'UPDATE' | undefined)
const KIEU_KHOA = { UPDATE: ' FOR UPDATE', SHARE: ' FOR SHARE' };
async function layCaDangMo(db, kieuKhoa) {
    const r = await db.query(
        `SELECT MaCaThuNgan, MaNV, ThoiGianMoCa, TienMatDauCa
           FROM CaThuNgan
          WHERE TrangThaiCa = 1
          ORDER BY ThoiGianMoCa DESC
          LIMIT 1${KIEU_KHOA[kieuKhoa] || ''}`
    );
    return r.rows[0] || null;
}

const loiChuaMoCa = () =>
    new LoiNghiepVu(409, 'Hệ thống chưa mở ca! Vui lòng mở ca thu ngân trước khi thực hiện thao tác này.', { maLoi: 'CHUA_MO_CA' });

// ---- Món cho màn hình Barista / Phục vụ -------------------------------------
const SQL_MON_PHA_CHE = `
    SELECT cthd.MaCTHD, cthd.MaHoaDon, cthd.MaMon, sp.TenMon, cthd.KichThuoc, cthd.SoLuong,
           cthd.GhiChu, cthd.TrangThaiPhaChe, cthd.ThoiGianGoi,
           (SELECT MIN(hb.MaBan) FROM HoaDon_Ban hb WHERE hb.MaHoaDon = cthd.MaHoaDon) AS MaBan,
           (SELECT string_agg(b.TenBan, ', ' ORDER BY b.TenBan)
              FROM HoaDon_Ban hb JOIN Ban b ON b.MaBan = hb.MaBan
             WHERE hb.MaHoaDon = cthd.MaHoaDon) AS TenBan,
           COALESCE((SELECT json_agg(json_build_object('maTopping', t.MaTopping, 'tenTopping', tp.TenTopping, 'soLuong', t.SoLuong)
                                     ORDER BY tp.TenTopping)
                       FROM ChiTietHoaDon_Topping t JOIN Topping tp ON tp.MaTopping = t.MaTopping
                      WHERE t.MaCTHD = cthd.MaCTHD), '[]'::json) AS Toppings
      FROM ChiTietHoaDon cthd
      JOIN SanPham sp ON sp.MaMon = cthd.MaMon`;

const mapMonPhaChe = (r) => ({
    maCTHD: r.macthd,
    maHoaDon: r.mahoadon,
    maMon: r.mamon,
    tenMon: r.tenmon,
    kichThuoc: r.kichthuoc,
    soLuong: r.soluong,
    ghiChu: r.ghichu,
    trangThaiPhaChe: r.trangthaiphache,
    thoiGianGoi: r.thoigiangoi,
    maBan: r.maban || null,
    tenBan: r.tenban || null,
    mangDi: !r.maban,
    toppings: r.toppings,
});

async function layMonTheoMa(db, dsMaCTHD) {
    const r = await db.query(
        `${SQL_MON_PHA_CHE} WHERE cthd.MaCTHD = ANY($1::varchar[]) ORDER BY cthd.ThoiGianGoi, cthd.MaCTHD`,
        [dsMaCTHD]
    );
    return r.rows.map(mapMonPhaChe);
}

async function layMonTheoTrangThai(db, dsTrangThai) {
    const r = await db.query(
        `${SQL_MON_PHA_CHE} WHERE cthd.TrangThaiPhaChe = ANY($1::varchar[]) ORDER BY cthd.ThoiGianGoi, cthd.MaCTHD`,
        [dsTrangThai]
    );
    return r.rows.map(mapMonPhaChe);
}

// ---- Hóa đơn chi tiết (dùng cho xem bàn, thanh toán, in bill) ----------------
async function layHoaDonChiTiet(db, maHoaDon) {
    const hdRes = await db.query(
        `SELECT hd.MaHoaDon, hd.MaKH, kh.TenKH, kh.SoDienThoai, kh.DiemTichLuy,
                hd.TrangThaiTT, hd.PhuongThucTT, hd.TongTienThanhToan, hd.ThoiGianTao, hd.ThoiGianThanhToan
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
        `SELECT c.MaCTHD, c.MaMon, sp.TenMon, c.KichThuoc, c.SoLuong, c.DonGia,
                COALESCE(c.GiaGiam, 0) AS GiaGiam, c.GhiChu, c.TrangThaiPhaChe,
                COALESCE((SELECT json_agg(json_build_object('maTopping', t.MaTopping, 'tenTopping', tp.TenTopping,
                                                            'soLuong', t.SoLuong, 'donGia', t.DonGia)
                                          ORDER BY tp.TenTopping)
                            FROM ChiTietHoaDon_Topping t JOIN Topping tp ON tp.MaTopping = t.MaTopping
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
        const tienTopping = r.toppings.reduce((s, t) => s + Number(t.soLuong) * Number(t.donGia), 0);
        return {
            maCTHD: r.macthd,
            maMon: r.mamon,
            tenMon: r.tenmon,
            kichThuoc: r.kichthuoc,
            soLuong: r.soluong,
            donGia,
            giaGiam,
            ghiChu: r.ghichu,
            trangThaiPhaChe: r.trangthaiphache,
            toppings: r.toppings,
            thanhTien: r.soluong * donGia + tienTopping - giaGiam,
        };
    });

    return {
        maHoaDon: hd.mahoadon,
        khachHang: hd.makh
            ? { maKH: hd.makh, tenKH: hd.tenkh, soDienThoai: hd.sodienthoai, diemTichLuy: hd.diemtichluy }
            : null,
        trangThaiTT: hd.trangthaitt,
        phuongThucTT: hd.phuongthuctt,
        thoiGianTao: hd.thoigiantao,
        thoiGianThanhToan: hd.thoigianthanhtoan,
        ban: banRes.rows.map((b) => ({ maBan: b.maban, tenBan: b.tenban })),
        danhSachMon,
        tongTamTinh: danhSachMon.reduce((s, m) => s + m.thanhTien, 0),
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

// ---- Đối soát tiền mặt của 1 ca thu ngân ------------------------------------
async function tinhDoiSoatCa(db, maCaThuNgan, tienMatThucTe) {
    const caRes = await db.query(
        `SELECT ca.MaCaThuNgan, ca.MaNV, nv.TenNV, ca.ThoiGianMoCa, ca.ThoiGianDongCa, ca.TienMatDauCa, ca.TrangThaiCa
           FROM CaThuNgan ca JOIN NhanVien nv ON nv.MaNV = ca.MaNV
          WHERE ca.MaCaThuNgan = $1`,
        [maCaThuNgan]
    );
    if (caRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy ca thu ngân!');
    const ca = caRes.rows[0];

    const ttRes = await db.query(
        `SELECT PhuongThucTT, COUNT(*) AS SoHoaDon, COALESCE(SUM(TongTienThanhToan), 0) AS TongTien
           FROM HoaDon
          WHERE MaCaThuNgan = $1 AND TrangThaiTT = 1
          GROUP BY PhuongThucTT`,
        [maCaThuNgan]
    );
    const doanhThu = { tienMat: 0, chuyenKhoan: 0, the: 0, tong: 0, soHoaDon: 0 };
    for (const r of ttRes.rows) {
        const tien = Number(r.tongtien);
        if (r.phuongthuctt === 'CHUYEN_KHOAN') doanhThu.chuyenKhoan += tien;
        else if (r.phuongthuctt === 'THE') doanhThu.the += tien;
        else doanhThu.tienMat += tien;
        doanhThu.tong += tien;
        doanhThu.soHoaDon += Number(r.sohoadon);
    }

    const tcRes = await db.query(
        `SELECT LoaiPhieu, COALESCE(SUM(SoTien), 0) AS Tong
           FROM PhieuThuChiLatVat WHERE MaCaThuNgan = $1 GROUP BY LoaiPhieu`,
        [maCaThuNgan]
    );
    let thuLatVat = 0;
    let chiLatVat = 0;
    for (const r of tcRes.rows) {
        if (r.loaiphieu === 1) thuLatVat = Number(r.tong);
        else chiLatVat = Number(r.tong);
    }

    const tienMatDauCa = Number(ca.tienmatdauca);
    const tienMatLyThuyet = tienMatDauCa + doanhThu.tienMat + thuLatVat - chiLatVat;
    const thucTe = tienMatThucTe === undefined || tienMatThucTe === null ? null : Number(tienMatThucTe);
    const chenhLech = thucTe === null ? null : thucTe - tienMatLyThuyet;

    let trangThai = null;
    if (chenhLech !== null) {
        trangThai = 'Khớp quỹ chính xác';
        if (chenhLech > 0) trangThai = 'Thừa tiền mặt (Dư quỹ)';
        if (chenhLech < 0) trangThai = 'Thiếu tiền mặt (Hụt quỹ)';
    }

    return {
        maCaThuNgan: ca.macathungan,
        maNV: ca.manv,
        tenNV: ca.tennv,
        thoiGianMoCa: ca.thoigianmoca,
        thoiGianDongCa: ca.thoigiandongca,
        trangThaiCa: ca.trangthaica, // 1 đang mở, 2 đã chốt
        tienMatDauCa,
        doanhThu,
        thuLatVat,
        chiLatVat,
        tienMatLyThuyet,
        tienMatThucTe: thucTe,
        chenhLech,
        trangThai,
    };
}

// ==========================================
// CẤU HÌNH SOCKET.IO CHO BARISTA & PHỤC VỤ
// ==========================================
io.use((socket, next) => {
    const token = socket.handshake.query?.token 
               || socket.handshake.auth?.token 
               || (socket.handshake.headers['authorization'] ? socket.handshake.headers['authorization'].split(' ')[1] : null)
               || socket.handshake.headers['token'];

    if (!token) return next(new Error('Từ chối kết nối: Thiếu Token!'));

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return next(new Error('Từ chối kết nối: Token sai hoặc đã hết hạn!'));
        socket.user = user;
        next();
    });
});

io.on('connection', (socket) => {
    console.log('Client kết nối Socket:', socket.id);
    const { vaiTro } = socket.user;
    if (vaiTro === 2) {
        socket.join('room_barista');
    } else if (vaiTro === 3) {
        socket.join('room_phucvu');
    } else if (vaiTro === 1 || vaiTro === 4) {
        socket.join('room_thungan');
    }
});

// ==========================================
// PHÂN HỆ: XÁC THỰC (AUTH)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    const { tenDangNhap, matKhau } = req.body;
    try {
        const result = await pool.query(
            'SELECT MaNV, TenNV, VaiTro FROM NhanVien WHERE TenDangNhap = $1 AND MatKhauHash = $2 AND TrangThaiLamViec = TRUE',
            [tenDangNhap, matKhau]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ message: 'Sai tài khoản, mật khẩu hoặc tài khoản đã bị khóa!' });
        }

        const user = result.rows[0];
        const token = jwt.sign(
            { maNV: user.manv, vaiTro: user.vaitro },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.json({
            message: 'Đăng nhập thành công',
            token,
            user: { maNV: user.manv, tenNV: user.tennv, vaiTro: user.vaitro }
        });
    } catch (error) {
        console.error('Lỗi API Login:', error);
        res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
    }
});

// ==========================================
// PHÂN HỆ: BÁN HÀNG & THU NGÂN (POS)
// ==========================================
app.get('/api/ban', kiemTraToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT MaBan, TenBan, TrangThai, KhuVuc, ToaDoX, ToaDoY FROM Ban WHERE DaXoa = FALSE');
        res.json(result.rows);
    } catch (error) {
        console.error('Lỗi API Lấy danh sách Bàn:', error);
        res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
    }
});

app.get('/api/sanpham', kiemTraToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT sp.MaMon, sp.TenMon, sp.NhomMon, sz.KichThuoc, sz.GiaBan 
            FROM SanPham sp 
            JOIN SanPham_Size sz ON sp.MaMon = sz.MaMon 
            WHERE sp.DangKinhDoanh = TRUE
            ORDER BY sp.NhomMon, sp.TenMon, sz.GiaBan
        `);

        const menu = [];
        const map = new Map();
        result.rows.forEach(row => {
            if (!map.has(row.mamon)) {
                const newItem = { maMon: row.mamon, tenMon: row.tenmon, nhomMon: row.nhommon, sizes: [] };
                map.set(row.mamon, newItem);
                menu.push(newItem);
            }
            map.get(row.mamon).sizes.push({ kichThuoc: row.kichthuoc, giaBan: parseFloat(row.giaban) });
        });
        res.json(menu);
    } catch (error) {
        console.error('Lỗi API Lấy Thực đơn:', error);
        res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
    }
});

// [v2] Tạo order / gọi thêm món.
app.post('/api/order', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const { maBan, maKH, danhSachMon } = req.body || {};
    const maNV = req.user.maNV;

    if (!Array.isArray(danhSachMon) || danhSachMon.length === 0) {
        return res.status(400).json({ message: 'Danh sách món không được để trống!' });
    }
    for (const mon of danhSachMon) {
        if (!mon || !mon.maMon || !SIZE_HOP_LE.includes(mon.kichThuoc) || !Number.isInteger(mon.soLuong) || mon.soLuong <= 0) {
            return res.status(400).json({ message: 'Mỗi món cần có maMon, kichThuoc (S/M/L) và soLuong là số nguyên > 0!' });
        }
        for (const tp of mon.toppings || []) {
            const sl = tp && tp.soLuong === undefined ? 1 : tp && tp.soLuong;
            if (!tp || !tp.maTopping || !Number.isInteger(sl) || sl <= 0) {
                return res.status(400).json({ message: 'Mỗi topping cần có maTopping và soLuong là số nguyên > 0!' });
            }
        }
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            // 1. Phải đang mở ca chung
            const ca = await layCaDangMo(client, 'SHARE');
            if (!ca) throw loiChuaMoCa();

            // 2. Giá món & topping lấy từ CSDL
            const cacMon = [...new Set(danhSachMon.map((m) => m.maMon))];
            const giaRes = await client.query(
                `SELECT sz.MaMon, sz.KichThuoc, sz.GiaBan
                   FROM SanPham_Size sz JOIN SanPham sp ON sp.MaMon = sz.MaMon
                  WHERE sp.DangKinhDoanh = TRUE AND sz.MaMon = ANY($1::varchar[])`,
                [cacMon]
            );
            const bangGia = new Map(giaRes.rows.map((r) => [`${r.mamon}|${r.kichthuoc}`, Number(r.giaban)]));

            const cacTopping = [...new Set(danhSachMon.flatMap((m) => (m.toppings || []).map((t) => t.maTopping)))];
            const bangTopping = new Map();
            if (cacTopping.length > 0) {
                const tpRes = await client.query(
                    `SELECT MaTopping, TenTopping, GiaTopping, MaNL, KhoiLuongTieuHao
                       FROM Topping WHERE DangKinhDoanh = TRUE AND MaTopping = ANY($1::varchar[])`,
                    [cacTopping]
                );
                for (const r of tpRes.rows) {
                    bangTopping.set(r.matopping, {
                        giaTopping: Number(r.giatopping),
                        maNL: r.manl,
                        khoiLuong: Number(r.khoiluongtieuhao),
                    });
                }
            }

            const congThucRes = await client.query(
                'SELECT MaMon, KichThuoc, MaNL, KhoiLuongTieuHao FROM CongThuc WHERE MaMon = ANY($1::varchar[])',
                [cacMon]
            );
            const bangCongThuc = new Map();
            for (const r of congThucRes.rows) {
                const key = `${r.mamon}|${r.kichthuoc}`;
                if (!bangCongThuc.has(key)) bangCongThuc.set(key, []);
                bangCongThuc.get(key).push({ maNL: r.manl, khoiLuong: Number(r.khoiluongtieuhao) });
            }

            // 3. Chuẩn hóa từng dòng + tính nguyên liệu tiêu hao
            const tieuHao = new Map();
            const congDon = (maNL, sl) => tieuHao.set(maNL, (tieuHao.get(maNL) || 0) + sl);
            const dongMon = danhSachMon.map((mon) => {
                const donGia = bangGia.get(`${mon.maMon}|${mon.kichThuoc}`);
                if (donGia === undefined) {
                    throw new LoiNghiepVu(400, `Món ${mon.maMon} (size ${mon.kichThuoc}) không tồn tại hoặc đã ngừng kinh doanh!`);
                }
                for (const ct of bangCongThuc.get(`${mon.maMon}|${mon.kichThuoc}`) || []) {
                    congDon(ct.maNL, ct.khoiLuong * mon.soLuong);
                }

                const gopTopping = new Map();
                for (const tp of mon.toppings || []) {
                    const info = bangTopping.get(tp.maTopping);
                    if (!info) throw new LoiNghiepVu(400, `Topping ${tp.maTopping} không tồn tại hoặc đã ngừng kinh doanh!`);
                    const tongSL = mon.soLuong * (tp.soLuong === undefined ? 1 : tp.soLuong);
                    gopTopping.set(tp.maTopping, (gopTopping.get(tp.maTopping) || 0) + tongSL);
                }
                const toppings = [...gopTopping].map(([maTopping, soLuong]) => {
                    const info = bangTopping.get(maTopping);
                    congDon(info.maNL, info.khoiLuong * soLuong);
                    return { maTopping, soLuong, donGia: info.giaTopping };
                });

                return {
                    maMon: mon.maMon,
                    kichThuoc: mon.kichThuoc,
                    soLuong: mon.soLuong,
                    donGia,
                    ghiChu: mon.ghiChu ? String(mon.ghiChu).slice(0, 255) : null,
                    toppings,
                };
            });

            // 4. Bàn & hóa đơn
            if (maKH) {
                const kh = await client.query('SELECT 1 FROM KhachHang WHERE MaKH = $1', [maKH]);
                if (kh.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy khách hàng!');
            }

            let maHoaDon = null;
            let laHoaDonMoi = false;
            if (maBan) {
                const ban = await client.query('SELECT MaBan FROM Ban WHERE MaBan = $1 AND DaXoa = FALSE FOR UPDATE', [maBan]);
                if (ban.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy bàn!');
                maHoaDon = await layHoaDonMoCuaBan(client, maBan, true);
            }
            if (!maHoaDon) {
                const hd = await client.query('INSERT INTO HoaDon (MaNV, TrangThaiTT) VALUES ($1, 0) RETURNING MaHoaDon', [maNV]);
                maHoaDon = hd.rows[0].mahoadon;
                laHoaDonMoi = true;
                if (maBan) {
                    await client.query('INSERT INTO HoaDon_Ban (MaHoaDon, MaBan) VALUES ($1, $2)', [maHoaDon, maBan]);
                    await client.query('UPDATE Ban SET TrangThai = 2 WHERE MaBan = $1', [maBan]);
                }
            }
            if (maKH) await client.query('UPDATE HoaDon SET MaKH = $1 WHERE MaHoaDon = $2', [maKH, maHoaDon]);

            // 5. Kiểm tra & trừ kho
            if (tieuHao.size > 0) {
                const dsNL = [...tieuHao.keys()];
                const tonRes = await client.query(
                    `SELECT MaNL, TenNL, DonViTinh, SoLuongTon FROM NguyenLieu
                      WHERE MaNL = ANY($1::varchar[]) ORDER BY MaNL FOR UPDATE`,
                    [dsNL]
                );
                const thieu = tonRes.rows
                    .filter((r) => Number(r.soluongton) + 1e-9 < tieuHao.get(r.manl))
                    .map((r) => ({
                        maNL: r.manl,
                        tenNL: r.tennl,
                        donViTinh: r.donvitinh,
                        canDung: lam3(tieuHao.get(r.manl)),
                        conLai: Number(r.soluongton),
                    }));
                if (thieu.length > 0) {
                    const ten = thieu.map((t) => `${t.tenNL} (cần ${t.canDung}, còn ${t.conLai} ${t.donViTinh})`).join('; ');
                    throw new LoiNghiepVu(409, `Không đủ nguyên liệu: ${ten}`, { maLoi: 'HET_NGUYEN_LIEU', nguyenLieuThieu: thieu });
                }

                const phieu = await client.query(
                    'INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu) VALUES ($1, $2, $3) RETURNING MaGiaoDich',
                    [maNV, LOAI_GD_TIEU_HAO, `Tiêu hao bán hàng - HĐ ${maHoaDon}`]
                );
                const maGiaoDich = phieu.rows[0].magiaodich;
                for (const [maNL, sl] of [...tieuHao].sort((a, b) => a[0].localeCompare(b[0]))) {
                    const soLuong = lam3(sl);
                    await client.query(
                        `INSERT INTO ChiTietGiaoDichKho (MaGiaoDich, MaNL, SoLuong, DonGiaNhap, TinhTrang)
                         VALUES ($1, $2, $3, 0, 'Tiêu hao bán hàng')`,
                        [maGiaoDich, maNL, soLuong]
                    );
                    await client.query('UPDATE NguyenLieu SET SoLuongTon = SoLuongTon - $1 WHERE MaNL = $2', [soLuong, maNL]);
                }
            }

            // 6. Ghi chi tiết hóa đơn
            const dsMaCTHD = [];
            for (const dong of dongMon) {
                const cthd = await client.query(
                    `INSERT INTO ChiTietHoaDon (MaHoaDon, MaMon, KichThuoc, SoLuong, DonGia, GhiChu, TrangThaiPhaChe)
                     VALUES ($1, $2, $3, $4, $5, $6, 'ChoPhaChe') RETURNING MaCTHD`,
                    [maHoaDon, dong.maMon, dong.kichThuoc, dong.soLuong, dong.donGia, dong.ghiChu]
                );
                const maCTHD = cthd.rows[0].macthd;
                dsMaCTHD.push(maCTHD);
                for (const tp of dong.toppings) {
                    await client.query(
                        'INSERT INTO ChiTietHoaDon_Topping (MaCTHD, MaTopping, SoLuong, DonGia) VALUES ($1, $2, $3, $4)',
                        [maCTHD, tp.maTopping, tp.soLuong, tp.donGia]
                    );
                }
            }

            return {
                maHoaDon,
                laHoaDonMoi,
                monMoi: await layMonTheoMa(client, dsMaCTHD),
                hoaDon: await layHoaDonChiTiet(client, maHoaDon),
            };
        });

        const { maHoaDon, laHoaDonMoi, monMoi, hoaDon } = ketQua;
        io.to('room_barista').emit('CO_DON_MOI', {
            maHoaDon,
            maBan: maBan || null,
            tenBan: monMoi[0] ? monMoi[0].tenBan : null,
            mangDi: !maBan,
            themMon: !laHoaDonMoi,
            danhSachMon: monMoi,
        });
        if (maBan) io.to('room_thungan').emit('BAN_THAY_DOI', { maBan, trangThai: 2 });

        res.status(201).json({
            message: laHoaDonMoi ? 'Tạo order thành công!' : 'Đã thêm món vào hóa đơn đang mở của bàn!',
            maHoaDon,
            laHoaDonMoi,
            danhSachMon: monMoi,
            hoaDon,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Tạo Order:');
    }
});

// [v2] Hóa đơn đang mở của 1 bàn
app.get('/api/ban/:maBan/hoadon', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    try {
        const maHoaDon = await layHoaDonMoCuaBan(pool, req.params.maBan);
        res.json({ hoaDon: maHoaDon ? await layHoaDonChiTiet(pool, maHoaDon) : null });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Hóa đơn theo bàn:');
    }
});

// [v2] Chi tiết 1 hóa đơn
app.get('/api/hoadon/:maHoaDon', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
    try {
        const hoaDon = await layHoaDonChiTiet(pool, req.params.maHoaDon);
        if (!hoaDon) return res.status(404).json({ message: 'Không tìm thấy hóa đơn!' });
        res.json({ hoaDon });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Chi tiết hóa đơn:');
    }
});

// [v2] Thanh toán: chốt tổng tiền, gắn vào ca chung
app.post('/api/order/thanhtoan', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const { maHoaDon, phuongThucTT = 'TIEN_MAT', maKH, tienKhachDua } = req.body || {};
    if (!maHoaDon) return res.status(400).json({ message: 'Thiếu mã hóa đơn (maHoaDon)!' });
    if (!PHUONG_THUC_TT.includes(phuongThucTT)) {
        return res.status(400).json({ message: `phuongThucTT phải là một trong: ${PHUONG_THUC_TT.join(', ')}` });
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const ca = await layCaDangMo(client, 'SHARE');
            if (!ca) throw loiChuaMoCa();

            await client.query(
                `SELECT MaBan FROM Ban
                  WHERE MaBan IN (SELECT MaBan FROM HoaDon_Ban WHERE MaHoaDon = $1)
                  ORDER BY MaBan FOR UPDATE`,
                [maHoaDon]
            );
            const hdRes = await client.query('SELECT TrangThaiTT FROM HoaDon WHERE MaHoaDon = $1 FOR UPDATE', [maHoaDon]);
            if (hdRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn!');
            if (hdRes.rows[0].trangthaitt === 1) throw new LoiNghiepVu(409, 'Hóa đơn này đã được thanh toán trước đó!');

            if (maKH) {
                const kh = await client.query('SELECT 1 FROM KhachHang WHERE MaKH = $1', [maKH]);
                if (kh.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy khách hàng!');
            }

            const chiTiet = await layHoaDonChiTiet(client, maHoaDon);
            if (chiTiet.danhSachMon.length === 0) throw new LoiNghiepVu(400, 'Hóa đơn chưa có món nào để thanh toán!');
            const tongTien = chiTiet.tongTamTinh;

            let tienThua = null;
            if (phuongThucTT === 'TIEN_MAT' && tienKhachDua !== undefined && tienKhachDua !== null) {
                const khachDua = Number(tienKhachDua);
                if (!(khachDua >= tongTien)) {
                    throw new LoiNghiepVu(400, 'Số tiền khách đưa chưa đủ!', { tongTien });
                }
                tienThua = khachDua - tongTien;
            }

            await client.query(
                `UPDATE HoaDon
                    SET TrangThaiTT = 1, TongTienThanhToan = $2, ThoiGianThanhToan = CURRENT_TIMESTAMP,
                        PhuongThucTT = $3, MaCaThuNgan = $4, MaKH = COALESCE($5, MaKH)
                  WHERE MaHoaDon = $1`,
                [maHoaDon, tongTien, phuongThucTT, ca.macathungan, maKH || null]
            );

            const banGiai = await client.query(
                `UPDATE Ban b SET TrangThai = 1
                  WHERE b.MaBan IN (SELECT MaBan FROM HoaDon_Ban WHERE MaHoaDon = $1)
                    AND NOT EXISTS (SELECT 1 FROM HoaDon_Ban hb2 JOIN HoaDon h2 ON h2.MaHoaDon = hb2.MaHoaDon
                                     WHERE hb2.MaBan = b.MaBan AND h2.TrangThaiTT = 0 AND h2.MaHoaDon <> $1)
                  RETURNING b.MaBan`,
                [maHoaDon]
            );

            return {
                hoaDon: await layHoaDonChiTiet(client, maHoaDon),
                tienThua,
                banDaTrong: banGiai.rows.map((r) => r.maban),
            };
        });

        for (const maBan of ketQua.banDaTrong) {
            io.to('room_thungan').emit('BAN_THAY_DOI', { maBan, trangThai: 1 });
        }
        res.json({ message: 'Thanh toán thành công!', hoaDon: ketQua.hoaDon, tienThua: ketQua.tienThua });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Thanh toán:');
    }
});

app.get('/api/topping', kiemTraToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT MaTopping, TenTopping, GiaTopping FROM Topping WHERE DangKinhDoanh = TRUE ORDER BY TenTopping'
        );
        res.json(result.rows.map((r) => ({ maTopping: r.matopping, tenTopping: r.tentopping, giaTopping: Number(r.giatopping) })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Topping:');
    }
});

app.get('/api/khachhang', kiemTraToken, async (req, res) => {
    const soDienThoai = String(req.query.soDienThoai || '').trim();
    if (!soDienThoai) return res.status(400).json({ message: 'Vui lòng cung cấp soDienThoai!' });
    try {
        const r = await pool.query(
            'SELECT MaKH, TenKH, SoDienThoai, DiemTichLuy FROM KhachHang WHERE SoDienThoai = $1',
            [soDienThoai]
        );
        const k = r.rows[0];
        res.json({
            khachHang: k ? { maKH: k.makh, tenKH: k.tenkh, soDienThoai: k.sodienthoai, diemTichLuy: k.diemtichluy } : null,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Tra cứu khách hàng:');
    }
});

app.post('/api/khachhang', kiemTraToken, async (req, res) => {
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const { soDienThoai, tenKH } = req.body;

    if (!soDienThoai || !tenKH) {
        return res.status(400).json({ message: 'Vui lòng cung cấp số điện thoại và tên khách hàng!' });
    }

    try {
        let result = await pool.query('SELECT MaKH, TenKH, SoDienThoai, DiemTichLuy FROM KhachHang WHERE SoDienThoai = $1', [soDienThoai]);
        if (result.rows.length > 0) {
            return res.json({ message: 'Tìm thấy thông tin khách hàng!', khachHang: result.rows[0] });
        }

        const maKH = 'KH' + Date.now().toString().slice(-6);
        const insertResult = await pool.query(
            'INSERT INTO KhachHang (MaKH, TenKH, SoDienThoai, DiemTichLuy) VALUES ($1, $2, $3, 0) RETURNING MaKH, TenKH, SoDienThoai, DiemTichLuy',
            [maKH, tenKH, soDienThoai]
        );
        res.json({ message: 'Đăng ký khách hàng thành công!', khachHang: insertResult.rows[0] });
    } catch (error) {
        console.error('Lỗi API Khách hàng:', error);
        res.status(500).json({ message: 'Lỗi máy chủ khi xử lý thông tin khách hàng', chiTietLoi: error.message });
    }
});

// ==========================================
// CA THU NGÂN TOÀN CỤC
// ==========================================

// Mở ca: nhập tiền mặt đầu ca
app.post('/api/ca/mo', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const tienMatDauCa = req.body && req.body.tienMatDauCa !== undefined ? Number(req.body.tienMatDauCa) : 0;
    if (!(tienMatDauCa >= 0)) return res.status(400).json({ message: 'tienMatDauCa phải là số >= 0!' });

    try {
        const daMo = await layCaDangMo(pool);
        if (daMo) {
            throw new LoiNghiepVu(409, 'Hệ thống đang có một ca chưa chốt!', { maLoi: 'DA_MO_CA', maCaThuNgan: daMo.macathungan });
        }
        const r = await pool.query(
            `INSERT INTO CaThuNgan (MaNV, TienMatDauCa) VALUES ($1, $2)
             RETURNING MaCaThuNgan, ThoiGianMoCa, TienMatDauCa`,
            [req.user.maNV, tienMatDauCa]
        );
        const ca = r.rows[0];
        res.status(201).json({
            message: 'Mở ca thành công!',
            ca: { maCaThuNgan: ca.macathungan, thoiGianMoCa: ca.thoigianmoca, tienMatDauCa: Number(ca.tienmatdauca) },
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Mở ca:');
    }
});

// Ca đang mở toàn quán kèm số liệu tạm tính
app.get('/api/ca/hientai', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    try {
        const ca = await layCaDangMo(pool);
        res.json({ caHienTai: ca ? await tinhDoiSoatCa(pool, ca.macathungan) : null });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Ca hiện tại:');
    }
});

// Ghi nhận thu/chi lặt vặt vào ca chung
app.post('/api/ca/thuchi', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const { loaiThuChi, soTien, lyDo } = req.body || {};
    const tien = Number(soTien);
    if (!['THU', 'CHI'].includes(loaiThuChi) || !(tien > 0)) {
        return res.status(400).json({ message: 'Vui lòng cung cấp đúng loaiThuChi (THU/CHI) và soTien > 0!' });
    }
    if (!lyDo || !String(lyDo).trim()) {
        return res.status(400).json({ message: 'Vui lòng nhập lý do thu/chi!' });
    }

    try {
        const phieu = await chayGiaoDich(async (client) => {
            const ca = await layCaDangMo(client, 'SHARE');
            if (!ca) throw loiChuaMoCa();
            const r = await client.query(
                `INSERT INTO PhieuThuChiLatVat (MaCaThuNgan, LoaiPhieu, SoTien, LyDo)
                 VALUES ($1, $2, $3, $4) RETURNING MaPhieuTC, ThoiGianTao`,
                [ca.macathungan, loaiThuChi === 'THU' ? 1 : 2, tien, String(lyDo).trim().slice(0, 255)]
            );
            return { ...r.rows[0], maCaThuNgan: ca.macathungan };
        });
        res.status(201).json({
            message: `Ghi nhận khoản ${loaiThuChi} lặt vặt thành công!`,
            maPhieuTC: phieu.maphieutc,
            maCaThuNgan: phieu.maCaThuNgan,
            thoiGianTao: phieu.thoigiantao,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Thu Chi lặt vặt:');
    }
});

// Danh sách phiếu thu/chi
app.get('/api/ca/thuchi', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    try {
        let maCa = req.query.maCaThuNgan;
        if (!maCa) {
            const ca = await layCaDangMo(pool);
            if (!ca) throw loiChuaMoCa();
            maCa = ca.macathungan;
        }
        const r = await pool.query(
            `SELECT MaPhieuTC, LoaiPhieu, SoTien, LyDo, ThoiGianTao
               FROM PhieuThuChiLatVat WHERE MaCaThuNgan = $1 ORDER BY ThoiGianTao DESC`,
            [maCa]
        );
        res.json(r.rows.map((p) => ({
            maPhieuTC: p.maphieutc,
            loaiThuChi: p.loaiphieu === 1 ? 'THU' : 'CHI',
            soTien: Number(p.sotien),
            lyDo: p.lydo,
            thoiGianTao: p.thoigiantao,
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách thu chi:');
    }
});

// Đối soát 
app.get('/api/ca/doisoat', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const { maCaThuNgan, tienMatThucTe } = req.query;
    if (tienMatThucTe !== undefined && !(Number(tienMatThucTe) >= 0)) {
        return res.status(400).json({ message: 'tienMatThucTe phải là số >= 0!' });
    }
    try {
        let maCa = maCaThuNgan;
        if (maCa) {
            const ca = await pool.query('SELECT MaNV FROM CaThuNgan WHERE MaCaThuNgan = $1', [maCa]);
            if (ca.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy ca thu ngân!');
        } else {
            const ca = await layCaDangMo(pool);
            if (!ca) throw loiChuaMoCa();
            maCa = ca.macathungan;
        }
        res.json({ doiSoat: await tinhDoiSoatCa(pool, maCa, tienMatThucTe) });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Đối soát cuối ca:');
    }
});

// Chốt ca chung
app.post('/api/ca/dong', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const { tienMatThucTe } = req.body || {};
    if (tienMatThucTe === undefined || tienMatThucTe === null || !(Number(tienMatThucTe) >= 0)) {
        return res.status(400).json({ message: 'Vui lòng cung cấp tienMatThucTe (số >= 0)!' });
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const ca = await layCaDangMo(client, 'UPDATE');
            if (!ca) throw new LoiNghiepVu(409, 'Hệ thống không có ca nào đang mở!', { maLoi: 'CHUA_MO_CA' });

            const ds = await tinhDoiSoatCa(client, ca.macathungan, tienMatThucTe);
            await client.query(
                `UPDATE CaThuNgan
                    SET ThoiGianDongCa = CURRENT_TIMESTAMP, TongThuHoaDon = $2, TongThuLatVat = $3, TongChiLatVat = $4,
                        TienMatThucTe = $5, ChenhLech = $6, TrangThaiCa = 2
                  WHERE MaCaThuNgan = $1`,
                [ca.macathungan, ds.doanhThu.tong, ds.thuLatVat, ds.chiLatVat, ds.tienMatThucTe, ds.chenhLech]
            );
            const mo = await client.query('SELECT COUNT(*) AS n FROM HoaDon WHERE TrangThaiTT = 0');
            return { doiSoat: await tinhDoiSoatCa(client, ca.macathungan, tienMatThucTe), soHoaDonDangMo: Number(mo.rows[0].n) };
        });
        res.json({ message: 'Đã chốt ca thành công!', ...ketQua });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Chốt ca:');
    }
});

// Lịch sử các ca thu ngân (Quản lý): ?tuNgay=YYYY-MM-DD&denNgay=YYYY-MM-DD
app.get('/api/ca/danhsach', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { tuNgay, denNgay } = req.query;
    if (!tuNgay || !denNgay) return res.status(400).json({ message: 'Vui lòng cung cấp tham số tuNgay và denNgay (YYYY-MM-DD)!' });
    try {
        const r = await pool.query(
            `SELECT ca.MaCaThuNgan, ca.MaNV, nv.TenNV, ca.ThoiGianMoCa, ca.ThoiGianDongCa, ca.TienMatDauCa,
                    ca.TongThuHoaDon, ca.TongThuLatVat, ca.TongChiLatVat, ca.TienMatThucTe, ca.ChenhLech, ca.TrangThaiCa
               FROM CaThuNgan ca JOIN NhanVien nv ON nv.MaNV = ca.MaNV
              WHERE DATE(ca.ThoiGianMoCa) BETWEEN $1 AND $2
              ORDER BY ca.ThoiGianMoCa DESC`,
            [tuNgay, denNgay]
        );
        const so = (v) => (v === null ? null : Number(v));
        res.json(r.rows.map((c) => ({
            maCaThuNgan: c.macathungan,
            maNV: c.manv,
            tenNV: c.tennv,
            thoiGianMoCa: c.thoigianmoca,
            thoiGianDongCa: c.thoigiandongca,
            tienMatDauCa: so(c.tienmatdauca),
            tongThuHoaDon: so(c.tongthuhoadon),
            tongThuLatVat: so(c.tongthulatvat),
            tongChiLatVat: so(c.tongchilatvat),
            tienMatThucTe: so(c.tienmatthucte),
            chenhLech: so(c.chenhlech),
            trangThaiCa: c.trangthaica,
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách ca:');
    }
});

// ==========================================
// PHÂN HỆ: PHA CHẾ (BARISTA)
// ==========================================
async function doiTrangThaiMon(maCTHD, tuTrangThai, denTrangThai) {
    const r = await pool.query(
        `UPDATE ChiTietHoaDon SET TrangThaiPhaChe = $2
          WHERE MaCTHD = $1 AND TrangThaiPhaChe = ANY($3::varchar[])
          RETURNING MaCTHD`,
        [maCTHD, denTrangThai, tuTrangThai]
    );
    if (r.rows.length === 0) {
        const t = await pool.query('SELECT TrangThaiPhaChe FROM ChiTietHoaDon WHERE MaCTHD = $1', [maCTHD]);
        if (t.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy món này!');
        throw new LoiNghiepVu(
            409,
            `Món này đang ở trạng thái "${t.rows[0].trangthaiphache}", không thể chuyển sang "${denTrangThai}"!`,
            { trangThaiHienTai: t.rows[0].trangthaiphache }
        );
    }
    const [mon] = await layMonTheoMa(pool, [maCTHD]);
    return mon;
}

app.get('/api/order/dangcho', kiemTraToken, choPhepVaiTro(2, 1), async (req, res) => {
    try {
        res.json(await layMonTheoTrangThai(pool, ['ChoPhaChe', 'DangLam']));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Món đang chờ:');
    }
});

app.put('/api/order/banglam', kiemTraToken, choPhepVaiTro(2, 1), async (req, res) => {
    const { maCTHD } = req.body || {};
    if (!maCTHD) return res.status(400).json({ message: 'Thiếu mã chi tiết hóa đơn (maCTHD)!' });
    try {
        const mon = await doiTrangThaiMon(maCTHD, ['ChoPhaChe'], 'DangLam');
        io.to('room_barista').emit('MON_DANG_LAM', mon);
        res.json({ message: 'Đã nhận làm món!', mon });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Nhận làm món:');
    }
});

app.put('/api/order/tramon', kiemTraToken, choPhepVaiTro(2, 1), async (req, res) => {
    const { maCTHD } = req.body || {};
    if (!maCTHD) return res.status(400).json({ message: 'Thiếu mã chi tiết hóa đơn (maCTHD)!' });
    try {
        const mon = await doiTrangThaiMon(maCTHD, ['ChoPhaChe', 'DangLam'], 'DaXong');
        io.to('room_phucvu').to('room_barista').emit('MON_DA_XONG', mon);
        res.json({ message: 'Đã báo trả món thành công!', maHoaDon: mon.maHoaDon, mon });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Trả món:');
    }
});

app.get('/api/order/chophucvu', kiemTraToken, choPhepVaiTro(3, 1), async (req, res) => {
    try {
        res.json(await layMonTheoTrangThai(pool, ['DaXong']));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Món chờ phục vụ:');
    }
});

app.put('/api/order/phucvu', kiemTraToken, choPhepVaiTro(3, 1), async (req, res) => {
    const { maCTHD } = req.body || {};
    if (!maCTHD) return res.status(400).json({ message: 'Thiếu mã chi tiết hóa đơn (maCTHD)!' });
    try {
        const mon = await doiTrangThaiMon(maCTHD, ['DaXong'], 'DaPhucVu');
        io.to('room_phucvu').emit('MON_DA_PHUC_VU', mon);
        res.json({ message: 'Đã xác nhận phục vụ món!', mon });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Phục vụ món:');
    }
});

// ==========================================
// PHÂN HỆ: QUẢN TRỊ & KHO BÃI
// ==========================================
app.post('/api/kho/nhap', kiemTraToken, async (req, res) => {
    if (req.user.vaiTro !== 1) {
        return res.status(403).json({ message: 'Từ chối truy cập! Chỉ Quản lý mới được lập phiếu nhập kho.' });
    }

    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const { ghiChu, danhSachNguyenLieu } = req.body;
    const maNV = req.user.maNV;

    if (!danhSachNguyenLieu || danhSachNguyenLieu.length === 0) {
        return res.status(400).json({ message: 'Danh sách nguyên liệu nhập không được để trống!' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const phieuResult = await client.query(
            'INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu) VALUES ($1, 1, $2) RETURNING MaGiaoDich',
            [maNV, ghiChu || 'Nhập kho nguyên liệu']
        );
        const maGiaoDich = phieuResult.rows[0].magiaodich;

        for (const item of danhSachNguyenLieu) {
            await client.query(
                'INSERT INTO ChiTietGiaoDichKho (MaGiaoDich, MaNL, SoLuong, DonGiaNhap, TinhTrang) VALUES ($1, $2, $3, $4, $5)',
                [maGiaoDich, item.maNL, item.soLuong, item.donGiaNhap, item.tinhTrang || 'Tốt']
            );
            await client.query('UPDATE NguyenLieu SET SoLuongTon = SoLuongTon + $1 WHERE MaNL = $2', [item.soLuong, item.maNL]);
        }

        await client.query('COMMIT');
        res.json({ message: 'Nhập kho và cập nhật tồn kho thành công!', maGiaoDich });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Lỗi API Nhập kho:', error);
        res.status(500).json({ message: 'Lỗi máy chủ khi lập phiếu nhập kho' });
    } finally {
        client.release();
    }
});

app.get('/api/kho/canhbao', kiemTraToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT MaNL, TenNL, DonViTinh, SoLuongTon, HanMucCanhBao FROM NguyenLieu WHERE SoLuongTon <= HanMucCanhBao ORDER BY SoLuongTon ASC');
        res.json(result.rows);
    } catch (error) {
        console.error('Lỗi API Cảnh báo kho:', error);
        res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
    }
});

app.post('/api/congthuc', kiemTraToken, async (req, res) => {
    if (req.user.vaiTro !== 1) return res.status(403).json({ message: 'Từ chối truy cập! Chỉ Quản lý mới được thiết lập công thức.' });
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });

    const { maMon, kichThuoc, dinhMuc } = req.body;
    if (!maMon || !kichThuoc || !Array.isArray(dinhMuc) || dinhMuc.length === 0) {
        return res.status(400).json({ message: 'Dữ liệu đầu vào không hợp lệ!' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM CongThuc WHERE MaMon = $1 AND KichThuoc = $2', [maMon, kichThuoc]);
        for (const item of dinhMuc) {
            await client.query('INSERT INTO CongThuc (MaMon, KichThuoc, MaNL, KhoiLuongTieuHao) VALUES ($1, $2, $3, $4)', [maMon, kichThuoc, item.maNL, item.khoiLuongTieuHao]);
        }
        await client.query('COMMIT');
        res.json({ message: `Cập nhật công thức cho món ${maMon} (Size ${kichThuoc}) thành công!` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Lỗi API Thiết lập công thức:', error);
        res.status(500).json({ message: 'Lỗi máy chủ khi lưu công thức' });
    } finally {
        client.release();
    }
});

app.post('/api/nhansu/phanca', kiemTraToken, async (req, res) => {
    if (req.user.vaiTro !== 1) return res.status(403).json({ message: 'Từ chối truy cập! Chỉ Quản lý mới được xếp lịch phân ca.' });
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });

    const { maNV, maCa, ngayLam } = req.body;
    if (!maNV || !maCa || !ngayLam) return res.status(400).json({ message: 'Vui lòng cung cấp đủ maNV, maCa và ngayLam!' });

    try {
        const result = await pool.query('INSERT INTO PhanCa (MaNV, MaCa, NgayLam, TrangThai) VALUES ($1, $2, $3, 1) RETURNING MaPhanCa', [maNV, maCa, ngayLam]);
        res.json({ message: 'Xếp lịch phân ca thành công!', maPhanCa: result.rows[0].maphanca });
    } catch (error) {
        console.error('Lỗi API Phân ca:', error);
        res.status(500).json({ message: 'Lỗi máy chủ khi xếp lịch phân ca', chiTietLoi: error.message });
    }
});

app.post('/api/nhansu/chamcong', kiemTraToken, async (req, res) => {
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const { maPhanCa } = req.body;
    const maNV = req.user.maNV;
    if (!maPhanCa) return res.status(400).json({ message: 'Thiếu mã phân ca (maPhanCa)!' });

    try {
        const caResult = await pool.query(`
            SELECT pc.MaPhanCa, clv.GioBatDau,
                   CASE WHEN CURRENT_TIME > clv.GioBatDau THEN 'Đi trễ' ELSE 'Đúng giờ' END AS TinhTrang
            FROM PhanCa pc
            JOIN CaLamViec clv ON pc.MaCa = clv.MaCa
            WHERE pc.MaPhanCa = $1 AND pc.MaNV = $2
        `, [maPhanCa, maNV]);

        if (caResult.rows.length === 0) return res.status(404).json({ message: 'Không tìm thấy lịch phân ca hợp lệ của bạn!' });

        const ghiChu = caResult.rows[0].tinhtrang;
        const checkInResult = await pool.query(
            'INSERT INTO ChamCong (MaPhanCa, ThoiGianCheckIn, GhiChu) VALUES ($1, CURRENT_TIMESTAMP, $2) RETURNING MaChamCong, ThoiGianCheckIn, GhiChu',
            [maPhanCa, ghiChu]
        );
        res.json({ message: 'Check-in vào ca thành công!', chamCong: checkInResult.rows[0] });
    } catch (error) {
        console.error('Lỗi API Check-in:', error);
        res.status(500).json({ message: 'Lỗi máy chủ khi Check-in' });
    }
});

app.put('/api/nhansu/chamcong', kiemTraToken, async (req, res) => {
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const { maPhanCa } = req.body;
    const maNV = req.user.maNV;
    if (!maPhanCa) return res.status(400).json({ message: 'Thiếu mã phân ca (maPhanCa)!' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const caResult = await client.query(`
            SELECT clv.GioKetThuc,
                   CASE WHEN CURRENT_TIME < clv.GioKetThuc THEN ' - Về sớm' ELSE ' - Đủ giờ' END AS TinhTrangRa
            FROM PhanCa pc
            JOIN CaLamViec clv ON pc.MaCa = clv.MaCa
            WHERE pc.MaPhanCa = $1 AND pc.MaNV = $2
        `, [maPhanCa, maNV]);

        if (caResult.rows.length === 0) throw new Error('Không tìm thấy ca làm việc hợp lệ!');

        const tinhTrangRa = caResult.rows[0].tinhtrangra;
        const updateChamCong = await client.query(`
            UPDATE ChamCong 
            SET ThoiGianCheckOut = CURRENT_TIMESTAMP, GhiChu = COALESCE(GhiChu, '') || $1
            WHERE MaPhanCa = $2 AND ThoiGianCheckOut IS NULL
            RETURNING MaChamCong, ThoiGianCheckIn, ThoiGianCheckOut, GhiChu
        `, [tinhTrangRa, maPhanCa]);

        if (updateChamCong.rows.length === 0) throw new Error('Chưa Check-in hoặc ca này đã được Check-out từ trước!');

        await client.query('UPDATE PhanCa SET TrangThai = 2 WHERE MaPhanCa = $1', [maPhanCa]);
        await client.query('COMMIT');
        res.json({ message: 'Check-out tan ca thành công!', chamCong: updateChamCong.rows[0] });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Lỗi API Check-out:', error);
        res.status(400).json({ message: error.message || 'Lỗi máy chủ khi Check-out' });
    } finally {
        client.release();
    }
});

app.get('/api/nhansu/tinhluong', kiemTraToken, async (req, res) => {
    if (req.user.vaiTro !== 1) return res.status(403).json({ message: 'Từ chối truy cập! Chỉ Quản lý mới được xem bảng lương.' });
    const { tuNgay, denNgay, luongTheoGio } = req.query;
    const donGiaGio = parseFloat(luongTheoGio) || 25000;

    if (!tuNgay || !denNgay) return res.status(400).json({ message: 'Vui lòng cung cấp tham số tuNgay và denNgay (YYYY-MM-DD)!' });

    try {
        const result = await pool.query(`
            SELECT nv.MaNV, nv.TenNV, nv.VaiTro,
                   COUNT(cc.MaChamCong) AS SoCaHoanThanh,
                   ROUND(COALESCE(SUM(EXTRACT(EPOCH FROM (cc.ThoiGianCheckOut - cc.ThoiGianCheckIn)) / 3600), 0)::numeric, 2) AS TongSoGio
            FROM NhanVien nv
            LEFT JOIN PhanCa pc ON nv.MaNV = pc.MaNV AND pc.NgayLam BETWEEN $1 AND $2
            LEFT JOIN ChamCong cc ON pc.MaPhanCa = cc.MaPhanCa AND cc.ThoiGianCheckIn IS NOT NULL AND cc.ThoiGianCheckOut IS NOT NULL
            WHERE nv.TrangThaiLamViec = TRUE
            GROUP BY nv.MaNV, nv.TenNV, nv.VaiTro
            ORDER BY nv.MaNV ASC
        `, [tuNgay, denNgay]);

        const bangLuong = result.rows.map(row => {
            const tongGio = parseFloat(row.tongsogio);
            return {
                maNV: row.manv,
                tenNV: row.tennv,
                vaiTro: row.vaitro,
                soCaHoanThanh: parseInt(row.socahoanthanh),
                tongSoGio: tongGio,
                luongTheoGio: donGiaGio,
                tongLuong: Math.round(tongGio * donGiaGio)
            };
        });

        res.json({ tuNgay, denNgay, bangLuong });
    } catch (error) {
        console.error('Lỗi API Tính lương:', error);
        res.status(500).json({ message: 'Lỗi máy chủ khi tính lương', chiTietLoi: error.message });
    }
});

app.get('/api/nhansu/phancacuatoi', kiemTraToken, async (req, res) => {
    const maNV = req.user.maNV;
    const { ngayLam } = req.query;
    try {
        const ngayTruyVan = ngayLam || new Date().toLocaleDateString('en-CA');
        const result = await pool.query(`
            SELECT pc.MaPhanCa, pc.MaCa, clv.TenCa, clv.GioBatDau, clv.GioKetThuc, TO_CHAR(pc.NgayLam, 'YYYY-MM-DD') AS NgayLam, pc.TrangThai
            FROM PhanCa pc
            JOIN CaLamViec clv ON pc.MaCa = clv.MaCa
            WHERE pc.MaNV = $1 AND pc.NgayLam = $2
        `, [maNV, ngayTruyVan]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: `Không tìm thấy lịch phân ca nào cho nhân viên ${maNV} vào ngày ${ngayTruyVan}` });
        }
        res.json({ ngayLam: ngayTruyVan, danhSachPhanCa: result.rows });
    } catch (error) {
        console.error('Lỗi API Tra cứu phân ca:', error);
        res.status(500).json({ message: 'Lỗi máy chủ khi tra cứu phân ca', chiTietLoi: error.message });
    }
});

app.post('/api/sanpham', kiemTraToken, async (req, res) => {
    if (req.user.vaiTro !== 1) return res.status(403).json({ message: 'Từ chối truy cập! Chỉ Quản lý mới được thêm món.' });
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });

    const { maMon, tenMon, nhomMon, giaGoc, sizes } = req.body;
    if (!maMon || !tenMon || !nhomMon || !Array.isArray(sizes) || sizes.length === 0) {
        return res.status(400).json({ message: 'Vui lòng cung cấp đủ thông tin sản phẩm và sizes!' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('INSERT INTO SanPham (MaMon, TenMon, NhomMon, GiaGoc, DangKinhDoanh) VALUES ($1, $2, $3, $4, TRUE)', [maMon, tenMon, nhomMon, giaGoc || 0]);
        for (const sz of sizes) {
            await client.query('INSERT INTO SanPham_Size (MaMon, KichThuoc, GiaBan) VALUES ($1, $2, $3)', [maMon, sz.kichThuoc, sz.giaBan]);
        }
        await client.query('COMMIT');
        res.json({ message: 'Thêm món mới thành công!', maMon });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Lỗi API Thêm món:', error);
        res.status(500).json({ message: 'Lỗi máy chủ khi thêm món', chiTietLoi: error.message });
    } finally {
        client.release();
    }
});

app.put('/api/sanpham/:maMon', kiemTraToken, async (req, res) => {
    if (req.user.vaiTro !== 1) return res.status(403).json({ message: 'Từ chối truy cập! Chỉ Quản lý mới được sửa món.' });
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });

    const { maMon } = req.params;
    const { tenMon, nhomMon, giaGoc, sizes } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const updateSP = await client.query(
            'UPDATE SanPham SET TenMon = $1, NhomMon = $2, GiaGoc = $3, DangKinhDoanh = TRUE WHERE MaMon = $4 RETURNING MaMon',
            [tenMon, nhomMon, giaGoc || 0, maMon]
        );
        if (updateSP.rows.length === 0) throw new Error('Không tìm thấy mã món cần sửa!');

        await client.query('DELETE FROM SanPham_Size WHERE MaMon = $1', [maMon]);
        for (const sz of sizes) {
            await client.query('INSERT INTO SanPham_Size (MaMon, KichThuoc, GiaBan) VALUES ($1, $2, $3)', [maMon, sz.kichThuoc, sz.giaBan]);
        }
        await client.query('COMMIT');
        res.json({ message: 'Cập nhật thông tin món thành công!', maMon });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Lỗi API Sửa món:', error);
        res.status(400).json({ message: error.message || 'Lỗi máy chủ khi cập nhật món' });
    } finally {
        client.release();
    }
});

app.delete('/api/sanpham/:maMon', kiemTraToken, async (req, res) => {
    if (req.user.vaiTro !== 1) return res.status(403).json({ message: 'Từ chối truy cập! Chỉ Quản lý mới được xóa món.' });
    const { maMon } = req.params;
    try {
        const result = await pool.query('UPDATE SanPham SET DangKinhDoanh = FALSE WHERE MaMon = $1 RETURNING MaMon', [maMon]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'Không tìm thấy mã món này!' });
        res.json({ message: `Đã ngừng kinh doanh món ${maMon} thành công!` });
    } catch (error) {
        console.error('Lỗi API Xóa món:', error);
        res.status(500).json({ message: 'Lỗi máy chủ khi xóa món', chiTietLoi: error.message });
    }
});

app.get('/api/baocao/dashboard', kiemTraToken, async (req, res) => {
    if (req.user.vaiTro !== 1) return res.status(403).json({ message: 'Từ chối truy cập! Chỉ Quản lý mới được xem báo cáo Dashboard.' });
    const { tuNgay, denNgay } = req.query;
    if (!tuNgay || !denNgay) return res.status(400).json({ message: 'Vui lòng cung cấp tham số tuNgay và denNgay (YYYY-MM-DD)!' });

    try {
        const doanhThuNgayResult = await pool.query(`
            WITH DoanhThuMon AS (
                SELECT 
                    hd.MaHoaDon,
                    DATE(hd.ThoiGianThanhToan) AS Ngay,
                    SUM(cthd.SoLuong * cthd.DonGia - COALESCE(cthd.GiaGiam, 0)) AS TienMon,
                    COALESCE(SUM(tp.TienTopping), 0) AS TienTopping
                FROM HoaDon hd
                JOIN ChiTietHoaDon cthd ON hd.MaHoaDon = cthd.MaHoaDon
                LEFT JOIN (
                    SELECT MaCTHD, SUM(SoLuong * DonGia) AS TienTopping
                    FROM ChiTietHoaDon_Topping
                    GROUP BY MaCTHD
                ) tp ON cthd.MaCTHD = tp.MaCTHD
                WHERE hd.TrangThaiTT = 1 AND DATE(hd.ThoiGianThanhToan) BETWEEN $1 AND $2
                GROUP BY hd.MaHoaDon, DATE(hd.ThoiGianThanhToan)
            )
            SELECT TO_CHAR(Ngay, 'YYYY-MM-DD') AS Ngay, COUNT(MaHoaDon) AS SoDon, SUM(TienMon + TienTopping) AS DoanhThu
            FROM DoanhThuMon
            GROUP BY Ngay
            ORDER BY Ngay ASC
        `, [tuNgay, denNgay]);

        const chiPhiResult = await pool.query(`
            SELECT COALESCE(SUM(ct.SoLuong * ct.DonGiaNhap), 0) AS TongChiPhiNhap
            FROM PhieuGiaoDichKho pgd
            JOIN ChiTietGiaoDichKho ct ON pgd.MaGiaoDich = ct.MaGiaoDich
            WHERE pgd.LoaiGD = 1 AND DATE(pgd.ThoiGianTao) BETWEEN $1 AND $2
        `, [tuNgay, denNgay]);

        let tongSoDon = 0;
        let tongDoanhThu = 0;
        const bieuDoDoanhThu = doanhThuNgayResult.rows.map(row => {
            const soDon = parseInt(row.sodon);
            const doanhThu = parseFloat(row.doanhthu);
            tongSoDon += soDon;
            tongDoanhThu += doanhThu;
            return { ngay: row.ngay, soDon, doanhThu };
        });

        const tongChiPhiNhapKho = parseFloat(chiPhiResult.rows[0].tongchiphinhap);
        const loiNhuanTamTinh = tongDoanhThu - tongChiPhiNhapKho;

        res.json({
            kyBaoCao: { tuNgay, denNgay },
            tongQuan: { tongSoDon, tongDoanhThu, tongChiPhiNhapKho, loiNhuanTamTinh },
            bieuDoDoanhThu
        });
    } catch (error) {
        console.error('Lỗi API Dashboard:', error);
        res.status(500).json({ message: 'Lỗi máy chủ khi xuất báo cáo Dashboard', chiTietLoi: error.message });
    }
});

app.post('/api/kho/kiemke', kiemTraToken, async (req, res) => {
    if (req.user.vaiTro !== 1) return res.status(403).json({ message: 'Từ chối truy cập! Chỉ Quản lý mới được lập phiếu xuất hủy/kiểm kê.' });
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });

    const { loaiGD, ghiChu, danhSachNguyenLieu } = req.body;
    if (![2, 3].includes(loaiGD) || !Array.isArray(danhSachNguyenLieu) || danhSachNguyenLieu.length === 0) {
        return res.status(400).json({ message: 'Loại giao dịch không hợp lệ hoặc danh sách nguyên liệu trống!' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const phieuResult = await client.query(
            'INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu) VALUES ($1, $2, $3) RETURNING MaGiaoDich',
            [req.user.maNV, loaiGD, ghiChu || (loaiGD === 2 ? 'Xuất hủy nguyên liệu' : 'Kiểm kê kho định kỳ')]
        );
        const maGiaoDich = phieuResult.rows[0].magiaodich;

        for (const item of danhSachNguyenLieu) {
            if (loaiGD === 2) {
                await client.query(
                    'INSERT INTO ChiTietGiaoDichKho (MaGiaoDich, MaNL, SoLuong, DonGiaNhap, TinhTrang) VALUES ($1, $2, $3, 0, $4)',
                    [maGiaoDich, item.maNL, item.soLuong, item.tinhTrang || 'Hủy do hư hỏng']
                );
                await client.query('UPDATE NguyenLieu SET SoLuongTon = SoLuongTon - $1 WHERE MaNL = $2', [item.soLuong, item.maNL]);
            } else if (loaiGD === 3) {
                const currentNL = await client.query('SELECT SoLuongTon FROM NguyenLieu WHERE MaNL = $1', [item.maNL]);
                if (currentNL.rows.length === 0) continue;
                
                const tonKhoCu = parseFloat(currentNL.rows[0].soluongton);
                const soLuongThucTe = parseFloat(item.soLuong);
                const doLech = soLuongThucTe - tonKhoCu;

                await client.query(
                    'INSERT INTO ChiTietGiaoDichKho (MaGiaoDich, MaNL, SoLuong, DonGiaNhap, TinhTrang) VALUES ($1, $2, $3, 0, $4)',
                    [maGiaoDich, item.maNL, doLech, `Kiểm kê thực tế: ${soLuongThucTe}`]
                );
                await client.query('UPDATE NguyenLieu SET SoLuongTon = $1 WHERE MaNL = $2', [soLuongThucTe, item.maNL]);
            }
        }

        await client.query('COMMIT');
        res.json({ message: loaiGD === 2 ? 'Lập phiếu xuất hủy thành công!' : 'Cập nhật kiểm kê kho thành công!', maGiaoDich });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Lỗi API Xuất hủy/Kiểm kê:', error);
        res.status(500).json({ message: 'Lỗi máy chủ khi xử lý kho', chiTietLoi: error.message });
    } finally {
        client.release();
    }
});

app.get('/api/kho/candoi', kiemTraToken, async (req, res) => {
    if (req.user.vaiTro !== 1) return res.status(403).json({ message: 'Từ chối truy cập! Chỉ Quản lý mới được xem báo cáo cân đối kho.' });
    const { tuNgay, denNgay } = req.query;
    if (!tuNgay || !denNgay) return res.status(400).json({ message: 'Vui lòng cung cấp tham số tuNgay và denNgay (YYYY-MM-DD)!' });

    try {
        const result = await pool.query(`
            SELECT nl.MaNL, nl.TenNL, nl.DonViTinh, nl.SoLuongTon AS TonKhoHienTai,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 1 THEN ct.SoLuong ELSE 0 END), 0) AS TongNhap,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 2 THEN ct.SoLuong ELSE 0 END), 0) AS TongXuatHuy,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 3 THEN ct.SoLuong ELSE 0 END), 0) AS TongChenhLechKiemKe,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 6 THEN ct.SoLuong ELSE 0 END), 0) AS TongTieuHaoBanHang
            FROM NguyenLieu nl
            LEFT JOIN ChiTietGiaoDichKho ct ON nl.MaNL = ct.MaNL
            LEFT JOIN PhieuGiaoDichKho pgd ON ct.MaGiaoDich = pgd.MaGiaoDich AND DATE(pgd.ThoiGianTao) BETWEEN $1 AND $2
            GROUP BY nl.MaNL, nl.TenNL, nl.DonViTinh, nl.SoLuongTon
            ORDER BY nl.MaNL ASC
        `, [tuNgay, denNgay]);

        res.json({ kyBaoCao: { tuNgay, denNgay }, canDoiKho: result.rows });
    } catch (error) {
        console.error('Lỗi API Cân đối kho:', error);
        res.status(500).json({ message: 'Lỗi máy chủ khi xuất báo cáo cân đối kho', chiTietLoi: error.message });
    }
});

// ==========================================
// [v2] DANH MỤC CHO TRANG QUẢN TRỊ
// ==========================================
app.get('/api/nhansu/nhanvien', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT MaNV, TenNV, VaiTro, MucLuongTheoGio, TrangThaiLamViec FROM NhanVien ORDER BY MaNV`
        );
        res.json(r.rows.map((n) => ({
            maNV: n.manv,
            tenNV: n.tennv,
            vaiTro: n.vaitro,
            mucLuongTheoGio: Number(n.mucluongtheogio),
            trangThaiLamViec: n.trangthailamviec,
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách nhân viên:');
    }
});

app.get('/api/nhansu/ca', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    try {
        const r = await pool.query('SELECT MaCa, TenCa, GioBatDau, GioKetThuc FROM CaLamViec ORDER BY GioBatDau, MaCa');
        res.json(r.rows.map((c) => ({ maCa: c.maca, tenCa: c.tenca, gioBatDau: c.giobatdau, gioKetThuc: c.gioketthuc })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách ca làm việc:');
    }
});

// Lịch phân ca + trạng thái chấm công: ?tuNgay=YYYY-MM-DD&denNgay=YYYY-MM-DD
app.get('/api/nhansu/phanca', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { tuNgay, denNgay } = req.query;
    if (!tuNgay || !denNgay) return res.status(400).json({ message: 'Vui lòng cung cấp tham số tuNgay và denNgay (YYYY-MM-DD)!' });
    try {
        const r = await pool.query(
            `SELECT pc.MaPhanCa, pc.MaNV, nv.TenNV, nv.VaiTro, pc.MaCa, clv.TenCa, clv.GioBatDau, clv.GioKetThuc,
                    TO_CHAR(pc.NgayLam, 'YYYY-MM-DD') AS NgayLam, pc.TrangThai, cc.ThoiGianCheckIn, cc.ThoiGianCheckOut
               FROM PhanCa pc
               JOIN NhanVien nv ON nv.MaNV = pc.MaNV
               JOIN CaLamViec clv ON clv.MaCa = pc.MaCa
               LEFT JOIN ChamCong cc ON cc.MaPhanCa = pc.MaPhanCa
              WHERE pc.NgayLam BETWEEN $1 AND $2
              ORDER BY pc.NgayLam, clv.GioBatDau, nv.TenNV`,
            [tuNgay, denNgay]
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

app.get('/api/kho/nguyenlieu', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT MaNL, TenNL, DonViTinh, SoLuongTon, HanMucCanhBao, GiaVonDonVi
               FROM NguyenLieu WHERE DaXoa = FALSE ORDER BY TenNL`
        );
        res.json(r.rows.map((n) => ({
            maNL: n.manl,
            tenNL: n.tennl,
            donViTinh: n.donvitinh,
            soLuongTon: Number(n.soluongton),
            hanMucCanhBao: Number(n.hanmuccanhbao),
            giaVonDonVi: Number(n.giavondonvi),
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách nguyên liệu:');
    }
});

// Thực đơn dành cho Quản lý: gồm cả món đã ngừng kinh doanh
app.get('/api/sanpham/quanly', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT sp.MaMon, sp.TenMon, sp.NhomMon, sp.GiaGoc, sp.DangKinhDoanh, sz.KichThuoc, sz.GiaBan
               FROM SanPham sp LEFT JOIN SanPham_Size sz ON sz.MaMon = sp.MaMon
              ORDER BY sp.NhomMon, sp.TenMon, sz.GiaBan`
        );
        const ds = [];
        const map = new Map();
        for (const row of r.rows) {
            if (!map.has(row.mamon)) {
                const item = {
                    maMon: row.mamon,
                    tenMon: row.tenmon,
                    nhomMon: row.nhommon,
                    giaGoc: Number(row.giagoc),
                    dangKinhDoanh: row.dangkinhdoanh,
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
app.get('/', (req, res) => {
    res.json({ 
        status: 'success', 
        message: '☕ POS Cafe API Server đang hoạt động bình thường!',
        version: '1.0.0'
    });
});

// Route kiểm tra sức khỏe hệ thống có tiền tố /api
app.get('/api', (req, res) => {
    res.json({ 
        status: 'success', 
        message: '☕ POS Cafe API Endpoint đã sẵn sàng!'
    });
});

// Bắt lỗi các route không tồn tại
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
        console.error('Lỗi không bắt được:', err);
        return res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
    }
    res.status(status).json({ message: 'Dữ liệu gửi lên không hợp lệ!' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server Backend & Socket.IO đang chạy tại http://localhost:${PORT}`);
});