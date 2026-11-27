// Module: Đổi điểm Loyalty + Promotion Engine (Happy Hour / Mã giảm giá) + Chuyển đổi nhân viên nhanh bằng mã PIN
const VND_MOI_DIEM_DOI = 1000; // 1 điểm tích lũy = 1.000đ khi đổi trừ trực tiếp hóa đơn
const PIN_SWITCH_MAX_FAIL = 5;
const PIN_SWITCH_WINDOW_MS = 5 * 60 * 1000;

const pinSwitchFailMap = new Map(); // key: `${tenantId}:${maNV}:${ip}` -> { count, resetAt }

function kiemTraGioiHanPinSwitch(key) {
    const rec = pinSwitchFailMap.get(key);
    if (!rec) return { blocked: false };
    if (Date.now() > rec.resetAt) {
        pinSwitchFailMap.delete(key);
        return { blocked: false };
    }
    if (rec.count >= PIN_SWITCH_MAX_FAIL) {
        const mins = Math.max(1, Math.ceil((rec.resetAt - Date.now()) / 60000));
        return { blocked: true, mins };
    }
    return { blocked: false };
}

function ghiNhanSaiPinSwitch(key) {
    const now = Date.now();
    const rec = pinSwitchFailMap.get(key);
    if (!rec || now > rec.resetAt) {
        pinSwitchFailMap.set(key, { count: 1, resetAt: now + PIN_SWITCH_WINDOW_MS });
    } else {
        rec.count += 1;
    }
}

function xoaSaiPinSwitch(key) {
    pinSwitchFailMap.delete(key);
}

// Lấy ngày giờ Việt Nam (Asia/Ho_Chi_Minh) chuẩn để so khung giờ Happy Hour
function layGioHienTaiVN(nowDate = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
        hour12: false,
    }).formatToParts(nowDate);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const hh = map.hour === '24' ? '00' : map.hour;
    return {
        dateStr: `${map.year}-${map.month}-${map.day}`,
        hhmm: `${hh}:${map.minute}`,
        dayOfWeek: weekdayMap[map.weekday] ?? 0,
    };
}

function namTrongKhungGio(hhmm, tu, den) {
    if (!tu || !den) return true;
    if (tu <= den) return hhmm >= tu && hhmm <= den;
    // Khung giờ qua nửa đêm (VD: 22:00 -> 02:00)
    return hhmm >= tu || hhmm <= den;
}

function dinhDangNgaySql(val) {
    if (!val) return null;
    if (typeof val === 'string') return val.slice(0, 10);
    if (val instanceof Date && !Number.isNaN(val.getTime())) {
        return val.toISOString().slice(0, 10);
    }
    return null;
}

// Pure evaluator cho Promotion Engine (dễ unit-test & tái sử dụng)
function kiemTraHopLeKhuyenMai(km, tongTamTinh, nowVn = layGioHienTaiVN()) {
    const tong = Math.max(0, Number(tongTamTinh || 0));
    if (!km || km.danghoatdong === false || km.dangHoatDong === false) {
        return { hopLe: false, lyDo: 'Chương trình khuyến mãi đang tạm ngưng!' };
    }
    const tuNgay = dinhDangNgaySql(km.tungay ?? km.tuNgay);
    const denNgay = dinhDangNgaySql(km.denngay ?? km.denNgay);
    if (tuNgay && nowVn.dateStr < tuNgay) {
        return { hopLe: false, lyDo: `Chương trình chỉ bắt đầu từ ngày ${tuNgay}!` };
    }
    if (denNgay && nowVn.dateStr > denNgay) {
        return { hopLe: false, lyDo: `Chương trình đã hết hạn vào ngày ${denNgay}!` };
    }
    const gioiHan = km.gioihanluotdung ?? km.gioiHanLuotDung;
    const daDung = Number(km.soluotdadung ?? km.soLuotDaDung ?? 0);
    if (gioiHan !== null && gioiHan !== undefined && daDung >= Number(gioiHan)) {
        return { hopLe: false, lyDo: 'Mã khuyến mãi đã hết lượt sử dụng!' };
    }
    const donToiThieu = Number(km.dontoithieu ?? km.donToiThieu ?? 0);
    if (tong < donToiThieu) {
        return {
            hopLe: false,
            lyDo: `Đơn tối thiểu ${donToiThieu.toLocaleString('vi-VN')}đ mới áp dụng được khuyến mãi này!`,
        };
    }

    const ngayTrongTuan = km.ngaytrongtuan ?? km.ngayTrongTuan;
    if (ngayTrongTuan && String(ngayTrongTuan).trim()) {
        const allowed = String(ngayTrongTuan)
            .split(',')
            .map((x) => Number(x.trim()))
            .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
        if (allowed.length > 0 && !allowed.includes(nowVn.dayOfWeek)) {
            return { hopLe: false, lyDo: 'Khuyến mãi không áp dụng cho thứ hôm nay!' };
        }
    }

    const gioTu = km.khunggiotu ?? km.khungGioTu;
    const gioDen = km.khunggioden ?? km.khungGioDen;
    if (gioTu && gioDen && !namTrongKhungGio(nowVn.hhmm, gioTu, gioDen)) {
        return { hopLe: false, lyDo: `Chỉ áp dụng trong khung giờ ${gioTu}–${gioDen}!` };
    }

    const kieuGiam = String(km.kieugiam ?? km.kieuGiam ?? 'FIXED').toUpperCase();
    const giaTri = Number(km.giatrigiam ?? km.giaTriGiam ?? 0);
    const giamToiDa = km.giamtoida ?? km.giamToiDa;

    let tienGiam = 0;
    if (kieuGiam === 'PERCENT') {
        tienGiam = Math.round((tong * giaTri) / 100);
        if (giamToiDa !== null && giamToiDa !== undefined && Number(giamToiDa) > 0) {
            tienGiam = Math.min(tienGiam, Number(giamToiDa));
        }
    } else {
        tienGiam = Math.round(giaTri);
    }
    tienGiam = Math.max(0, Math.min(tong, tienGiam));

    return {
        hopLe: true,
        tienGiam,
        maCode: km.macode ?? km.maCode ?? null,
        tenChuongTrinh: km.tenchuongtrinh ?? km.tenChuongTrinh ?? '',
        loaiKM: km.loaikm ?? km.loaiKM ?? 'CODE',
        id: km.id ?? null,
    };
}

function mapKhuyenMaiRow(r) {
    return {
        id: Number(r.id),
        maCode: r.macode || null,
        tenChuongTrinh: r.tenchuongtrinh,
        loaiKM: r.loaikm,
        kieuGiam: r.kieugiam,
        giaTriGiam: Number(r.giatrigiam),
        giamToiDa: r.giamtoida !== null && r.giamtoida !== undefined ? Number(r.giamtoida) : null,
        donToiThieu: Number(r.dontoithieu || 0),
        khungGioTu: r.khunggiotu || null,
        khungGioDen: r.khunggioden || null,
        ngayTrongTuan: r.ngaytrongtuan || null,
        tuNgay: dinhDangNgaySql(r.tungay),
        denNgay: dinhDangNgaySql(r.denngay),
        gioiHanLuotDung: r.gioihanluotdung !== null && r.gioihanluotdung !== undefined ? Number(r.gioihanluotdung) : null,
        soLuotDaDung: Number(r.soluotdadung || 0),
        dangHoatDong: Boolean(r.danghoatdong),
        thoiGianTao: r.thoigiantao,
    };
}

async function khoiTaoKhuyenMaiSchema(pool) {
    if (process.env.SKIP_AUTO_DDL === 'true') return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.khuyenmai (
                Id              BIGSERIAL PRIMARY KEY,
                TenantId        VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
                MaCode          VARCHAR(40),
                TenChuongTrinh  VARCHAR(120) NOT NULL,
                LoaiKM          VARCHAR(24) NOT NULL CHECK (LoaiKM IN ('CODE', 'HAPPY_HOUR')),
                KieuGiam        VARCHAR(16) NOT NULL CHECK (KieuGiam IN ('PERCENT', 'FIXED')),
                GiaTriGiam      NUMERIC(15, 2) NOT NULL CHECK (GiaTriGiam > 0),
                GiamToiDa       NUMERIC(15, 2),
                DonToiThieu     NUMERIC(15, 2) NOT NULL DEFAULT 0,
                KhungGioTu      VARCHAR(5),
                KhungGioDen     VARCHAR(5),
                NgayTrongTuan   VARCHAR(32),
                TuNgay          DATE,
                DenNgay         DATE,
                GioiHanLuotDung INT,
                SoLuotDaDung    INT NOT NULL DEFAULT 0,
                DangHoatDong    BOOLEAN NOT NULL DEFAULT TRUE,
                ThoiGianTao     TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uq_khuyenmai_tenant_code
                ON public.khuyenmai (TenantId, UPPER(MaCode))
                WHERE MaCode IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_khuyenmai_tenant_active
                ON public.khuyenmai (TenantId, DangHoatDong, LoaiKM);

            ALTER TABLE IF EXISTS public.hoadon ADD COLUMN IF NOT EXISTS MaKhuyenMai VARCHAR(40);
            ALTER TABLE IF EXISTS public.hoadon ADD COLUMN IF NOT EXISTS TenKhuyenMai VARCHAR(120);
            ALTER TABLE IF EXISTS public.hoadon ADD COLUMN IF NOT EXISTS TienGiamKM NUMERIC(15, 2) NOT NULL DEFAULT 0;
            ALTER TABLE IF EXISTS public.hoadon ADD COLUMN IF NOT EXISTS DiemSuDung INT NOT NULL DEFAULT 0;
            ALTER TABLE IF EXISTS public.hoadon ADD COLUMN IF NOT EXISTS TienGiamDiem NUMERIC(15, 2) NOT NULL DEFAULT 0;
        `);
    } catch (error) {
        console.warn('⚠️ Bỏ qua khởi tạo schema KhuyenMai / Loyalty:', error.message);
    }
}

// Tính toán (và tùy chọn khóa/cập nhật DB) Khuyến mãi + Đổi điểm Loyalty trong transaction
async function tinhUuDaiVaDiemTrongGiaoDich(
    client,
    {
        tenantId = 'DEFAULT',
        tongTamTinh = 0,
        maKhuyenMai = null,
        maKH = null,
        diemSuDung = 0,
        tuDongHappyHour = true,
        khoaCapNhat = false,
        LoiNghiepVu,
    }
) {
    const tId = String(tenantId || 'DEFAULT');
    const tong = Math.max(0, Math.round(Number(tongTamTinh || 0)));
    const codeClean = maKhuyenMai ? String(maKhuyenMai).trim().toUpperCase() : '';
    const diemMuonDung = Math.max(0, Math.floor(Number(diemSuDung || 0)));
    const nowVn = layGioHienTaiVN();

    let kmChon = null;
    let tienGiamKM = 0;

    // 1. Khuyến mãi (Mã giảm giá ưu tiên; nếu không nhập mã -> tự động quét Happy Hour đang chạy)
    if (codeClean) {
        let kmRow = null;
        try {
            const r = await client.query(
                `SELECT * FROM KhuyenMai
                  WHERE TenantId = $1 AND UPPER(MaCode) = $2
                  LIMIT 1${khoaCapNhat ? ' FOR UPDATE' : ''}`,
                [tId, codeClean]
            );
            kmRow = r.rows[0] || null;
        } catch {
            kmRow = null;
        }
        if (!kmRow) {
            throw new LoiNghiepVu(400, `Mã giảm giá "${codeClean}" không tồn tại!`);
        }
        const evalRes = kiemTraHopLeKhuyenMai(kmRow, tong, nowVn);
        if (!evalRes.hopLe) {
            throw new LoiNghiepVu(400, evalRes.lyDo);
        }
        kmChon = {
            id: Number(kmRow.id),
            maCode: kmRow.macode,
            tenChuongTrinh: kmRow.tenchuongtrinh,
            loaiKM: kmRow.loaikm,
        };
        tienGiamKM = evalRes.tienGiam;
    } else if (tuDongHappyHour && tong > 0) {
        try {
            const r = await client.query(
                `SELECT * FROM KhuyenMai
                  WHERE TenantId = $1 AND LoaiKM = 'HAPPY_HOUR' AND DangHoatDong = TRUE`,
                [tId]
            );
            let best = null;
            for (const row of r.rows) {
                const evalRes = kiemTraHopLeKhuyenMai(row, tong, nowVn);
                if (evalRes.hopLe && evalRes.tienGiam > (best ? best.tienGiam : 0)) {
                    best = { row, tienGiam: evalRes.tienGiam };
                }
            }
            if (best) {
                if (khoaCapNhat) {
                    const locked = await client.query(
                        `SELECT * FROM KhuyenMai WHERE Id = $1 FOR UPDATE`,
                        [best.row.id]
                    );
                    const evalAgain = kiemTraHopLeKhuyenMai(locked.rows[0], tong, nowVn);
                    if (evalAgain.hopLe) {
                        kmChon = {
                            id: Number(best.row.id),
                            maCode: best.row.macode || 'HAPPY_HOUR',
                            tenChuongTrinh: best.row.tenchuongtrinh,
                            loaiKM: 'HAPPY_HOUR',
                        };
                        tienGiamKM = evalAgain.tienGiam;
                    }
                } else {
                    kmChon = {
                        id: Number(best.row.id),
                        maCode: best.row.macode || 'HAPPY_HOUR',
                        tenChuongTrinh: best.row.tenchuongtrinh,
                        loaiKM: 'HAPPY_HOUR',
                    };
                    tienGiamKM = best.tienGiam;
                }
            }
        } catch {
            // Bảng KhuyenMai chưa tạo -> bỏ qua an toàn
        }
    }

    const tongSauKM = Math.max(0, tong - tienGiamKM);

    // 2. Đổi điểm Loyalty (1 điểm = 1.000đ)
    let diemThucTru = 0;
    let tienGiamDiem = 0;
    let diemHienCo = 0;

    if (diemMuonDung > 0) {
        if (!maKH) {
            throw new LoiNghiepVu(400, 'Vui lòng chọn Khách hàng thành viên trước khi đổi điểm Loyalty!');
        }
        const khRes = await client.query(
            `SELECT MaKH, COALESCE(to_jsonb(KhachHang)->>'tenkh', to_jsonb(KhachHang)->>'hoten') AS TenKH, COALESCE(DiemTichLuy, 0) AS DiemTichLuy
               FROM KhachHang
              WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $2${khoaCapNhat ? ' FOR UPDATE' : ''}`,
            [maKH, tId]
        );
        if (khRes.rows.length === 0) {
            throw new LoiNghiepVu(404, 'Không tìm thấy khách hàng để đổi điểm!');
        }
        diemHienCo = Math.floor(Number(khRes.rows[0].diemtichluy || 0));
        if (diemMuonDung > diemHienCo) {
            throw new LoiNghiepVu(
                400,
                `Khách hàng chỉ còn ${diemHienCo} điểm (không đủ ${diemMuonDung} điểm để đổi)!`
            );
        }
        const maxDiemChoDon = Math.floor(tongSauKM / VND_MOI_DIEM_DOI);
        diemThucTru = Math.min(diemMuonDung, maxDiemChoDon);
        tienGiamDiem = Math.min(tongSauKM, diemThucTru * VND_MOI_DIEM_DOI);
    }

    if (khoaCapNhat) {
        if (kmChon && kmChon.id) {
            await client.query(
                `UPDATE KhuyenMai SET SoLuotDaDung = COALESCE(SoLuotDaDung, 0) + 1 WHERE Id = $1`,
                [kmChon.id]
            );
        }
        if (diemThucTru > 0 && maKH) {
            await client.query(
                `UPDATE KhachHang
                    SET DiemTichLuy = GREATEST(0, COALESCE(DiemTichLuy, 0) - $1)
                  WHERE MaKH = $2 AND COALESCE(TenantId, 'DEFAULT') = $3`,
                [diemThucTru, maKH, tId]
            );
        }
    }

    const tongGiamGia = tienGiamKM + tienGiamDiem;
    const tongSauGiam = Math.max(0, tong - tongGiamGia);

    return {
        kmApDung: kmChon,
        maKhuyenMai: kmChon ? kmChon.maCode : null,
        tenKhuyenMai: kmChon ? kmChon.tenChuongTrinh : null,
        tienGiamKM,
        diemSuDung: diemThucTru,
        tienGiamDiem,
        diemHienCo,
        tongGiamGia,
        tongSauGiam,
        vndMoiDiemDoi: VND_MOI_DIEM_DOI,
    };
}

function registerPromotionAndPinRoutes(
    app,
    {
        pool,
        chayGiaoDich,
        layHoaDonChiTiet,
        kiemTraToken,
        choPhepVaiTro,
        coQuyenHan = null,
        xacThucPinQuanLy = null,
        verifyPassword,
        jwt,
        JWT_VERIFY_OPTIONS = { algorithms: ['HS256'] },
        ACCESS_TOKEN_TTL = '30m',
        getRefreshCookie = null,
        hashRefreshToken = null,
        xoayVongRefreshTokenCookie = null,
        taoVaGanRefreshTokenCookie = null,
        danhGiaTrangThaiGoi,
        layEntitlementTenant,
        ghiAuditLog,
        guiLoi,
        LoiNghiepVu,
    }
) {
    const layTenantId = (req) => String(req.user?.tenantId || 'DEFAULT');

    // ==================== PROMOTION ENGINE ====================

    // Danh sách tất cả chương trình khuyến mãi (Quản lý)
    app.get('/api/khuyenmai', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const rows = await pool.withTenant(tenantId, async (client) => {
                const r = await client.query(
                    `SELECT * FROM KhuyenMai WHERE TenantId = $1 ORDER BY DangHoatDong DESC, Id DESC`,
                    [tenantId]
                );
                return r.rows;
            });
            res.json(rows.map(mapKhuyenMaiRow));
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Danh sách khuyến mãi:');
        }
    });

    // Chương trình đang chạy tại thời điểm hiện tại (POS xem Happy Hour + danh sách mã đang bật)
    app.get('/api/khuyenmai/dangchay', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const nowVn = layGioHienTaiVN();
        try {
            const rows = await pool.withTenant(tenantId, async (client) => {
                const r = await client.query(
                    `SELECT * FROM KhuyenMai WHERE TenantId = $1 AND DangHoatDong = TRUE ORDER BY LoaiKM DESC, Id DESC`,
                    [tenantId]
                );
                return r.rows;
            });
            const mapped = rows.map(mapKhuyenMaiRow);
            const happyHoursActive = mapped.filter((km) => {
                if (km.loaiKM !== 'HAPPY_HOUR') return false;
                return kiemTraHopLeKhuyenMai(km, Math.max(km.donToiThieu, 1000000), nowVn).hopLe;
            });
            const codesActive = mapped.filter((km) => km.loaiKM === 'CODE');
            res.json({
                nowVn,
                vndMoiDiemDoi: VND_MOI_DIEM_DOI,
                happyHours: happyHoursActive,
                codes: codesActive,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Khuyến mãi đang chạy:');
        }
    });

    // Tạo chương trình khuyến mãi mới (Mã giảm giá hoặc Happy Hour)
    app.post('/api/khuyenmai', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const {
            maCode,
            tenChuongTrinh,
            loaiKM = 'CODE',
            kieuGiam = 'PERCENT',
            giaTriGiam,
            giamToiDa = null,
            donToiThieu = 0,
            khungGioTu = null,
            khungGioDen = null,
            ngayTrongTuan = null,
            tuNgay = null,
            denNgay = null,
            gioiHanLuotDung = null,
        } = req.body || {};

        const loai = String(loaiKM).toUpperCase();
        const kieu = String(kieuGiam).toUpperCase();
        const ten = String(tenChuongTrinh || '').trim();
        const giaTri = Number(giaTriGiam);
        const codeSach = loai === 'CODE' ? String(maCode || '').trim().toUpperCase().replace(/\s+/g, '') : null;

        if (!ten || ten.length < 2) {
            return res.status(400).json({ message: 'Vui lòng nhập tên chương trình khuyến mãi!' });
        }
        if (!['CODE', 'HAPPY_HOUR'].includes(loai)) {
            return res.status(400).json({ message: 'loaiKM phải là CODE hoặc HAPPY_HOUR!' });
        }
        if (loai === 'CODE' && (!codeSach || !/^[A-Z0-9_-]{3,32}$/.test(codeSach))) {
            return res.status(400).json({ message: 'Mã giảm giá phải gồm 3–32 ký tự chữ hoa, số, _ hoặc -!' });
        }
        if (!['PERCENT', 'FIXED'].includes(kieu)) {
            return res.status(400).json({ message: 'kieuGiam phải là PERCENT hoặc FIXED!' });
        }
        if (!(giaTri > 0) || (kieu === 'PERCENT' && giaTri > 100)) {
            return res.status(400).json({ message: kieu === 'PERCENT' ? 'Phần trăm giảm phải từ 1 đến 100!' : 'Số tiền giảm phải > 0!' });
        }
        if (loai === 'HAPPY_HOUR' && (!/^\d{2}:\d{2}$/.test(String(khungGioTu || '')) || !/^\d{2}:\d{2}$/.test(String(khungGioDen || '')))) {
            return res.status(400).json({ message: 'Happy Hour cần chọn đầy đủ khung giờ (HH:MM — VD: 14:00 đến 17:00)!' });
        }

        try {
            const created = await pool.withTenant(tenantId, async (client) => {
                const r = await client.query(
                    `INSERT INTO KhuyenMai
                        (TenantId, MaCode, TenChuongTrinh, LoaiKM, KieuGiam, GiaTriGiam, GiamToiDa,
                         DonToiThieu, KhungGioTu, KhungGioDen, NgayTrongTuan, TuNgay, DenNgay, GioiHanLuotDung, DangHoatDong)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE)
                     RETURNING *`,
                    [
                        tenantId,
                        codeSach,
                        ten.slice(0, 120),
                        loai,
                        kieu,
                        giaTri,
                        giamToiDa !== null && giamToiDa !== '' && Number(giamToiDa) > 0 ? Number(giamToiDa) : null,
                        Math.max(0, Number(donToiThieu || 0)),
                        khungGioTu ? String(khungGioTu).slice(0, 5) : null,
                        khungGioDen ? String(khungGioDen).slice(0, 5) : null,
                        ngayTrongTuan ? String(ngayTrongTuan).trim().slice(0, 32) : null,
                        tuNgay || null,
                        denNgay || null,
                        gioiHanLuotDung !== null && gioiHanLuotDung !== '' && Number(gioiHanLuotDung) > 0
                            ? Math.floor(Number(gioiHanLuotDung))
                            : null,
                    ]
                );
                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'PROMOTION_CREATED',
                    doiTuong: 'KHUYENMAI',
                    maDoiTuong: r.rows[0].id,
                    giaTriMoi: { maCode: codeSach, tenChuongTrinh: ten, loaiKM: loai, kieuGiam: kieu, giaTriGiam: giaTri },
                    ip: req.ip,
                });
                return mapKhuyenMaiRow(r.rows[0]);
            });
            res.status(201).json({ message: 'Đã tạo chương trình khuyến mãi thành công!', khuyenMai: created });
        } catch (error) {
            if (error.code === '23505') {
                return res.status(409).json({ message: `Mã giảm giá "${codeSach}" đã tồn tại trong quán!` });
            }
            guiLoi(res, error, 'Lỗi API Tạo khuyến mãi:');
        }
    });

    // Bật / Tắt khuyến mãi
    app.put('/api/khuyenmai/:id/trangthai', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const id = Number(req.params.id);
        const dangHoatDong = Boolean(req.body?.dangHoatDong);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID khuyến mãi không hợp lệ!' });
        try {
            const updated = await pool.withTenant(tenantId, async (client) => {
                const r = await client.query(
                    `UPDATE KhuyenMai SET DangHoatDong = $3 WHERE Id = $1 AND TenantId = $2 RETURNING *`,
                    [id, tenantId, dangHoatDong]
                );
                return r.rows[0] ? mapKhuyenMaiRow(r.rows[0]) : null;
            });
            if (!updated) return res.status(404).json({ message: 'Không tìm thấy chương trình khuyến mãi!' });
            res.json({
                message: dangHoatDong ? 'Đã bật chương trình khuyến mãi!' : 'Đã tạm ngưng chương trình khuyến mãi!',
                khuyenMai: updated,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Đổi trạng thái khuyến mãi:');
        }
    });

    // Xóa chương trình khuyến mãi
    app.delete('/api/khuyenmai/:id', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID khuyến mãi không hợp lệ!' });
        try {
            const ok = await pool.withTenant(tenantId, async (client) => {
                const r = await client.query(`DELETE FROM KhuyenMai WHERE Id = $1 AND TenantId = $2 RETURNING Id`, [id, tenantId]);
                return r.rows.length > 0;
            });
            if (!ok) return res.status(404).json({ message: 'Không tìm thấy chương trình khuyến mãi!' });
            res.json({ message: 'Đã xóa chương trình khuyến mãi!' });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Xóa khuyến mãi:');
        }
    });

    // Kiểm tra & xem trước số tiền giảm (Khuyến mãi + Đổi điểm Loyalty) tại quầy POS
    app.post('/api/khuyenmai/kiemtra', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const { tongTamTinh = 0, maKhuyenMai = null, maKH = null, diemSuDung = 0, tuDongHappyHour = true } = req.body || {};
        try {
            const preview = await pool.withTenant(tenantId, (client) =>
                tinhUuDaiVaDiemTrongGiaoDich(client, {
                    tenantId,
                    tongTamTinh,
                    maKhuyenMai,
                    maKH,
                    diemSuDung,
                    tuDongHappyHour: Boolean(tuDongHappyHour),
                    khoaCapNhat: false,
                    LoiNghiepVu,
                })
            );
            res.json(preview);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Kiểm tra khuyến mãi / điểm Loyalty:');
        }
    });

    // [P0 FIX] Khóa / Lưu trực tiếp Khuyến mãi & Đổi điểm Loyalty xuống HoaDon trên DB trước khi sinh VietQR
    // Giúp VietQR Webhook SePay/PayOS luôn khớp chính xác 100% số tiền sau giảm, không bao giờ kẹt PARTIAL_PAID!
    app.post('/api/order/:maHoaDon/ap-uu-dai', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const { maHoaDon } = req.params;
        const {
            maKhuyenMai = null,
            diemSuDung = 0,
            maKH = null,
            tuDongHappyHour = true,
            goBo = false,
            managerPin = null,
            maNVDuyet = null,
            lyDo = null,
        } = req.body || {};
        const tenantId = layTenantId(req);

        try {
            const result = await chayGiaoDich(async (client) => {
                let hdRow;
                await client.query('SAVEPOINT sp_sel_hd_ap_uudai');
                try {
                    const r = await client.query(
                        `SELECT MaHoaDon, TrangThaiTT, MaKH, MaKhuyenMai, TenKhuyenMai,
                                COALESCE(DaInTamTinh, FALSE) AS DaInTamTinh,
                                COALESCE(TienGiamKM, 0) AS TienGiamKM,
                                COALESCE(DiemSuDung, 0) AS DiemSuDung,
                                COALESCE(TienGiamDiem, 0) AS TienGiamDiem
                           FROM HoaDon
                          WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                          FOR UPDATE`,
                        [maHoaDon, tenantId]
                    );
                    await client.query('RELEASE SAVEPOINT sp_sel_hd_ap_uudai');
                    hdRow = r.rows[0] || null;
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_sel_hd_ap_uudai').catch(() => {});
                    throw new LoiNghiepVu(500, 'Cơ sở dữ liệu chưa chạy Migration 011 (cột khuyến mãi trên HoaDon)!');
                }
                if (!hdRow) throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn!');
                if (hdRow.trangthaitt !== 0) {
                    throw new LoiNghiepVu(409, 'Chỉ có thể áp hoặc gỡ ưu đãi cho hóa đơn chưa thanh toán!');
                }

                const chiTiet = await layHoaDonChiTiet(client, maHoaDon);
                if (chiTiet.soMonHopLe === 0) {
                    throw new LoiNghiepVu(400, 'Hóa đơn không còn món hợp lệ để áp ưu đãi!');
                }
                if (chiTiet.daThanhToan > 0) {
                    throw new LoiNghiepVu(409, 'Hóa đơn đã ghi nhận thanh toán 1 phần, không thể thay đổi ưu đãi!');
                }

                // [P0-3] Chặn lách Pre-bill: nếu đã in tạm tính (DaInTamTinh = TRUE), bắt buộc quyền Quản lý hoặc managerPin
                const daInTamTinh = Boolean(hdRow.daintamtinh);
                let prebillApprover = null;
                if (daInTamTinh) {
                    const hasPerm =
                        Number(req.user?.vaiTro) === 1 ||
                        (typeof coQuyenHan === 'function' && coQuyenHan(req.user, 'order.discount.apply'));
                    if (hasPerm) {
                        prebillApprover = req.user.maNV;
                    } else {
                        const mgr =
                            managerPin && typeof xacThucPinQuanLy === 'function'
                                ? await xacThucPinQuanLy(client, tenantId, managerPin, req.ip, maNVDuyet, 'order.discount.apply')
                                : null;
                        if (!mgr) {
                            throw new LoiNghiepVu(
                                403,
                                'Hóa đơn đã in tạm tính (Pre-bill)! Cần quyền Quản lý hoặc mã PIN Quản lý hợp lệ để áp/gỡ ưu đãi.',
                                { maLoi: 'CAN_PIN_QUAN_LY', code: 'PREBILL_DISCOUNT_FORBIDDEN' }
                            );
                        }
                        prebillApprover = mgr.maNV;
                    }
                }

                // 1. Hoàn tác ưu đãi cũ (nếu hóa đơn đã từng lưu trước đó) trước khi áp mới hoặc gỡ bỏ
                const oldDiem = Math.max(0, Number(hdRow.diemsudung || 0));
                const oldCode = hdRow.makhuyenmai || null;
                if (oldDiem > 0 && hdRow.makh) {
                    await client.query(
                        `UPDATE KhachHang
                            SET DiemTichLuy = COALESCE(DiemTichLuy, 0) + $1
                          WHERE MaKH = $2 AND COALESCE(TenantId, 'DEFAULT') = $3`,
                        [oldDiem, hdRow.makh, tenantId]
                    );
                }
                if (oldCode) {
                    await client.query(
                        `UPDATE KhuyenMai
                            SET SoLuotDaDung = GREATEST(0, COALESCE(SoLuotDaDung, 0) - 1)
                          WHERE TenantId = $1 AND UPPER(MaCode) = UPPER($2)`,
                        [tenantId, oldCode]
                    ).catch(() => {});
                }

                if (goBo) {
                    await client.query(
                        `UPDATE HoaDon
                            SET MaKhuyenMai = NULL, TenKhuyenMai = NULL, TienGiamKM = 0, DiemSuDung = 0, TienGiamDiem = 0
                          WHERE MaHoaDon = $1`,
                        [maHoaDon]
                    );
                    if (daInTamTinh && typeof ghiAuditLog === 'function') {
                        await ghiAuditLog(client, {
                            tenantId,
                            maNV: req.user.maNV,
                            vaiTro: req.user.vaiTro,
                            nguoiDuyet: prebillApprover,
                            hanhDong: 'PREBILL_PROMO_REMOVED',
                            doiTuong: 'HOADON',
                            maDoiTuong: maHoaDon,
                            giaTriMoi: { goBo: true },
                            lyDo: lyDo ? String(lyDo).trim().slice(0, 255) : 'Gỡ ưu đãi sau khi in tạm tính',
                            ip: req.ip,
                            batBuoc: true,
                        });
                    }
                    return {
                        goBo: true,
                        uuDai: null,
                        hoaDon: await layHoaDonChiTiet(client, maHoaDon),
                    };
                }

                // 2. Gắn khách hàng nếu thu ngân vừa chọn mới
                let khFinal = hdRow.makh || null;
                if (maKH && maKH !== hdRow.makh) {
                    const khCheck = await client.query(
                        `SELECT 1 FROM KhachHang WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
                        [maKH, tenantId]
                    );
                    if (khCheck.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy khách hàng!');
                    await client.query(`UPDATE HoaDon SET MaKH = $1 WHERE MaHoaDon = $2`, [maKH, maHoaDon]);
                    khFinal = maKH;
                }

                // 3. Tính & khóa ưu đãi mới + trừ điểm / tăng lượt dùng ngay trong DB
                const uuDai = await tinhUuDaiVaDiemTrongGiaoDich(client, {
                    tenantId,
                    tongTamTinh: chiTiet.tongTamTinh,
                    maKhuyenMai,
                    maKH: khFinal,
                    diemSuDung,
                    tuDongHappyHour: Boolean(tuDongHappyHour),
                    khoaCapNhat: true,
                    LoiNghiepVu,
                });

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

                if (daInTamTinh && typeof ghiAuditLog === 'function') {
                    await ghiAuditLog(client, {
                        tenantId,
                        maNV: req.user.maNV,
                        vaiTro: req.user.vaiTro,
                        nguoiDuyet: prebillApprover,
                        hanhDong: 'PREBILL_PROMO_APPLIED',
                        doiTuong: 'HOADON',
                        maDoiTuong: maHoaDon,
                        giaTriMoi: {
                            maKhuyenMai: uuDai.maKhuyenMai,
                            tienGiamKM: uuDai.tienGiamKM,
                            diemSuDung: uuDai.diemSuDung,
                            tienGiamDiem: uuDai.tienGiamDiem,
                        },
                        lyDo: lyDo ? String(lyDo).trim().slice(0, 255) : 'Áp ưu đãi sau khi in tạm tính',
                        ip: req.ip,
                        batBuoc: true,
                    });
                }

                return {
                    goBo: false,
                    uuDai,
                    hoaDon: await layHoaDonChiTiet(client, maHoaDon),
                };
            }, tenantId);

            res.json({
                message: result.goBo
                    ? 'Đã gỡ ưu đãi & hoàn trả điểm tạm giữ trên hóa đơn!'
                    : result.uuDai?.tongGiamGia > 0
                    ? `Đã áp ưu đãi giảm ${result.uuDai.tongGiamGia.toLocaleString('vi-VN')}đ lên hóa đơn!`
                    : 'Không có ưu đãi giảm giá nào được áp dụng cho hóa đơn này.',
                ...result,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Áp ưu đãi lên hóa đơn:');
        }
    });

    // ==================== CHUYỂN ĐỔI NHÂN VIÊN NHANH BẰNG MÃ PIN ====================

    // Danh sách nhân viên đang làm việc trong cùng quán (chỉ trả metadata, không lộ mật khẩu/PIN, kèm cờ coQuyenDuyetPin O(1))
    app.get('/api/auth/staff-quick-list', kiemTraToken, async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const rows = await pool.withTenant(tenantId, async (client) => {
                const r = await client.query(
                    `SELECT MaNV, TenNV, VaiTro,
                            (PinHash IS NOT NULL AND PinHash <> '') AS DaDatPin,
                            COALESCE((to_jsonb(NhanVien)->'permissionsoverride')::jsonb, '{}'::jsonb) AS PermissionsOverride
                       FROM NhanVien
                      WHERE COALESCE(TenantId, 'DEFAULT') = $1
                        AND TrangThaiLamViec = TRUE
                      ORDER BY VaiTro ASC, TenNV ASC`,
                    [tenantId]
                );
                return r.rows;
            });
            res.json(
                rows.map((nv) => {
                    const vaiTro = Number(nv.vaitro);
                    const perms = nv.permissionsoverride && typeof nv.permissionsoverride === 'object' ? nv.permissionsoverride : {};
                    const laCaTruong = Boolean(
                        perms.isShiftSupervisor ||
                            perms['order.item.void_approve'] ||
                            perms['order.refund.approve']
                    );
                    return {
                        maNV: nv.manv,
                        tenNV: nv.tennv,
                        vaiTro,
                        laCaTruong,
                        coQuyenDuyetPin: vaiTro === 1 || laCaTruong,
                        daDatPin: Boolean(nv.dadatpin),
                        permissionsOverride: perms,
                    };
                })
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Danh sách chuyển đổi nhân viên:');
        }
    });

    // Chuyển ca / đổi nhân viên nhanh bằng mã PIN 4–6 số:
    // - Hỗ trợ cả Bearer Access Token hiện tại LẪN Fast Store Device Session (HttpOnly Refresh Cookie)
    // - Tự động cấp Access Token ngắn hạn (15–30p) + xoay vòng Refresh Cookie sang nhân viên mới!
    const xacThucPinSwitchContext = async (req, res, next) => {
        const authHeader = req.headers['authorization'];
        const bearerToken = authHeader && authHeader.split(' ')[1];
        if (bearerToken) {
            try {
                const decoded = jwt.verify(bearerToken, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS);
                if (decoded && decoded.type !== 'PLATFORM_ADMIN') {
                    req.user = decoded;
                    req.rawRefreshForSwitch = getRefreshCookie ? getRefreshCookie(req) : null;
                    return next();
                }
            } catch {
                // Access Token hết hạn -> fallback sang HttpOnly Store Device Session Cookie bên dưới
            }
        }
        const rawRefresh = getRefreshCookie ? getRefreshCookie(req) : null;
        if (!rawRefresh || !hashRefreshToken) {
            return res.status(401).json({ message: 'Vui lòng đăng nhập máy quầy trước khi chuyển ca bằng PIN!' });
        }
        try {
            const lookup = await pool.query('SELECT * FROM public.fn_lookup_refresh_token($1)', [hashRefreshToken(rawRefresh)]);
            const row = lookup.rows[0];
            if (!row || row.revokedat || new Date(row.expiresat).getTime() <= Date.now()) {
                return res.status(401).json({ message: 'Phiên thiết bị đã hết hạn — vui lòng đăng nhập lại bằng tài khoản Quản lý!' });
            }
            req.user = {
                maNV: row.manv,
                vaiTro: Number(row.vaitro),
                tenantId: row.tenantid || 'DEFAULT',
            };
            req.rawRefreshForSwitch = rawRefresh;
            req.isStoreDeviceForSwitch = Boolean(row.isstoredevicesession);
            return next();
        } catch {
            return res.status(401).json({ message: 'Không thể xác thực phiên thiết bị, vui lòng đăng nhập lại!' });
        }
    };

    app.post('/api/auth/pin-switch', xacThucPinSwitchContext, async (req, res) => {
        const tenantId = layTenantId(req);
        const maNVMucTieu = String(req.body?.maNV || '').trim();
        const pin = String(req.body?.pin || '').trim();
        if (!maNVMucTieu || !/^\d{4,6}$/.test(pin)) {
            return res.status(400).json({ message: 'Vui lòng chọn nhân viên và nhập đúng mã PIN (4–6 chữ số)!' });
        }

        const rateKey = `${tenantId}:${maNVMucTieu}:${req.ip}`;
        const limitCheck = kiemTraGioiHanPinSwitch(rateKey);
        if (limitCheck.blocked) {
            return res.status(429).json({
                message: `Bạn đã nhập sai mã PIN quá ${PIN_SWITCH_MAX_FAIL} lần! Vui lòng thử lại sau ${limitCheck.mins} phút.`,
            });
        }

        try {
            const nv = await pool.withTenant(tenantId, async (client) => {
                const r = await client.query(
                    `SELECT nv.MaNV, nv.TenNV, nv.VaiTro, nv.PinHash, nv.TrangThaiLamViec,
                            COALESCE((to_jsonb(nv)->'permissionsoverride')::jsonb, '{}'::jsonb) AS PermissionsOverride,
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
                      WHERE nv.MaNV = $1
                        AND COALESCE(nv.TenantId, 'DEFAULT') = $2
                        AND nv.TrangThaiLamViec = TRUE
                      LIMIT 1`,
                    [maNVMucTieu, tenantId]
                );
                return r.rows[0] || null;
            });

            if (!nv) {
                return res.status(404).json({ message: 'Không tìm thấy nhân viên đang hoạt động trong quán!' });
            }
            if (!nv.pinhash) {
                return res.status(400).json({
                    message: `Nhân viên "${nv.tennv}" chưa được thiết lập mã PIN! Vào Admin → Nhân sự → Đặt PIN trước.`,
                });
            }

            const { ok } = await verifyPassword(pin, nv.pinhash);
            if (!ok) {
                ghiNhanSaiPinSwitch(rateKey);
                return res.status(401).json({ message: 'Mã PIN không chính xác!' });
            }
            xoaSaiPinSwitch(rateKey);

            const subscription = danhGiaTrangThaiGoi({
                tenantId,
                trangThai: nv.trangthaigoi || 'ACTIVE',
                trialEndsAt: nv.trialendsat || null,
                subscriptionEndsAt: nv.subscriptionendsat || null,
            });
            const ent = await layEntitlementTenant(pool, tenantId);

            const perms = nv.permissionsoverride && typeof nv.permissionsoverride === 'object' ? nv.permissionsoverride : {};
            const token = jwt.sign(
                {
                    maNV: nv.manv,
                    vaiTro: Number(nv.vaitro),
                    permissionsOverride: perms,
                    tenantId,
                    maTienTo: nv.matiento || 'DEF',
                    tenQuan: nv.tenquan || 'Quán Cà Phê POS',
                    goiCuoc: ent.goiCuoc || nv.goicuoc || 'PRO',
                    trangThaiGoi: subscription.trangThai,
                },
                process.env.JWT_SECRET,
                { expiresIn: ACCESS_TOKEN_TTL }
            );

            // Xoay vòng Refresh Token HttpOnly Cookie sang nhân viên vừa đổi ca bằng PIN
            try {
                if (req.rawRefreshForSwitch && xoayVongRefreshTokenCookie) {
                    const rot = await xoayVongRefreshTokenCookie({
                        req,
                        res,
                        oldRawToken: req.rawRefreshForSwitch,
                        newMaNV: nv.manv,
                        isStoreDevice: Boolean(req.isStoreDeviceForSwitch),
                    });
                    if (!rot.ok && taoVaGanRefreshTokenCookie) {
                        await taoVaGanRefreshTokenCookie({ req, res, tenantId, maNV: nv.manv, rememberDevice: true });
                    }
                } else if (taoVaGanRefreshTokenCookie) {
                    await taoVaGanRefreshTokenCookie({ req, res, tenantId, maNV: nv.manv, rememberDevice: true });
                }
            } catch {
                // Không làm gián đoạn chuyển ca PIN nếu DB chưa migrate bảng Refresh_Tokens
            }

            await pool.withTenant(tenantId, (client) =>
                ghiAuditLog(client, {
                    tenantId,
                    maNV: nv.manv,
                    vaiTro: Number(nv.vaitro),
                    hanhDong: 'STAFF_PIN_SWITCH',
                    doiTuong: 'NHANVIEN',
                    maDoiTuong: nv.manv,
                    giaTriCu: { tuMaNV: req.user.maNV, tuVaiTro: req.user.vaiTro },
                    giaTriMoi: { sangMaNV: nv.manv, sangTenNV: nv.tennv, sangVaiTro: Number(nv.vaitro) },
                    lyDo: `Đổi phiên làm việc nhanh bằng PIN từ ${req.user.maNV} → ${nv.tennv}`,
                    ip: req.ip,
                })
            );

            res.json({
                message: `Đã chuyển sang nhân viên ${nv.tennv}!`,
                token,
                accessTokenExpiresIn: ACCESS_TOKEN_TTL,
                user: {
                    maNV: nv.manv,
                    tenNV: nv.tennv,
                    vaiTro: Number(nv.vaitro),
                    laCaTruong: Boolean(perms?.isShiftSupervisor),
                    permissionsOverride: perms,
                    tenantId,
                    maTienTo: nv.matiento || 'DEF',
                    tenQuan: nv.tenquan || 'Quán Cà Phê POS',
                    tenantSlug: nv.tenantslug || null,
                    goiCuoc: ent.goiCuoc || nv.goicuoc || 'PRO',
                    featureFlags: ent.flags || ent.featureFlags,
                    hanMucDonThang: ent.hanMucDonThang,
                    subscription,
                },
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Chuyển đổi nhân viên bằng PIN:');
        }
    });
}

module.exports = {
    VND_MOI_DIEM_DOI,
    layGioHienTaiVN,
    kiemTraHopLeKhuyenMai,
    khoiTaoKhuyenMaiSchema,
    tinhUuDaiVaDiemTrongGiaoDich,
    registerPromotionAndPinRoutes,
};
