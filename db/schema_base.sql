-- =============================================================================
-- Schema nền (Base Schema trước Migration 001) dùng để khởi tạo DB Test trắng
-- (docker-compose.test.yml). Mọi bảng dùng CREATE TABLE IF NOT EXISTS nên an toàn
-- 100%, không bao giờ ghi đè hay phá dữ liệu DB dev hiện có.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.NhanVien (
    MaNV              VARCHAR(64) PRIMARY KEY,
    TenNV             VARCHAR(150) NOT NULL,
    TenDangNhap       VARCHAR(100) NOT NULL UNIQUE,
    MatKhauHash       TEXT NOT NULL,
    VaiTro            INT NOT NULL DEFAULT 2, -- 1=Admin/Manager, 2=Cashier, 3=Barista, 4=Waiter
    TrangThaiLamViec  BOOLEAN NOT NULL DEFAULT TRUE,
    MucLuongGio       NUMERIC(15, 2) NOT NULL DEFAULT 0,
    SoDienThoai       VARCHAR(30),
    PinHash           TEXT,
    ThoiGianTao       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.Ban (
    MaBan       VARCHAR(64) PRIMARY KEY,
    TenBan      VARCHAR(100) NOT NULL,
    KhuVuc      VARCHAR(100) NOT NULL DEFAULT 'Tang 1',
    SucChua     INT NOT NULL DEFAULT 4,
    TrangThai   INT NOT NULL DEFAULT 1, -- 1=Trong, 2=DangPhucVu, 3=ChoDon
    QrToken     VARCHAR(128),
    DaXoa       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS public.SanPham (
    MaMon          VARCHAR(64) PRIMARY KEY,
    TenMon         VARCHAR(150) NOT NULL,
    DanhMuc        VARCHAR(100) NOT NULL DEFAULT 'Ca phe',
    MoTa           TEXT,
    HinhAnh        TEXT,
    DangKinhDoanh  BOOLEAN NOT NULL DEFAULT TRUE,
    LaHangDongGoi  BOOLEAN NOT NULL DEFAULT FALSE,
    TramCheBien    VARCHAR(32) DEFAULT 'BAR_CHINH',
    InTemCoc       BOOLEAN NOT NULL DEFAULT TRUE,
    ThoiGianTao    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.SanPham_Size (
    MaMon      VARCHAR(64) NOT NULL REFERENCES public.SanPham(MaMon) ON DELETE CASCADE,
    KichThuoc  VARCHAR(20) NOT NULL,
    GiaBan     NUMERIC(15, 2) NOT NULL DEFAULT 0,
    PRIMARY KEY (MaMon, KichThuoc)
);

CREATE TABLE IF NOT EXISTS public.Topping (
    MaTopping      VARCHAR(64) PRIMARY KEY,
    TenTopping     VARCHAR(120) NOT NULL,
    GiaThem        NUMERIC(15, 2) NOT NULL DEFAULT 0,
    DangKinhDoanh  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS public.NguyenLieu (
    MaNL           VARCHAR(64) PRIMARY KEY,
    TenNL          VARCHAR(150) NOT NULL,
    DonViTinh      VARCHAR(32) NOT NULL DEFAULT 'g',
    TonKhoHienTai  NUMERIC(15, 3) NOT NULL DEFAULT 0,
    NguongCanhBao  NUMERIC(15, 3) NOT NULL DEFAULT 0,
    GiaVonDonVi    NUMERIC(15, 4) NOT NULL DEFAULT 0,
    DaXoa          BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS public.CongThuc (
    MaMon          VARCHAR(64) NOT NULL,
    KichThuoc      VARCHAR(20) NOT NULL DEFAULT 'M',
    MaNL           VARCHAR(64) NOT NULL,
    KhoiLuongTieuHao NUMERIC(15, 3) NOT NULL DEFAULT 0,
    PRIMARY KEY (MaMon, KichThuoc, MaNL)
);

CREATE TABLE IF NOT EXISTS public.KhachHang (
    MaKH           VARCHAR(64) PRIMARY KEY,
    HoTen          VARCHAR(150) NOT NULL,
    SoDienThoai    VARCHAR(30),
    DiemTichLuy    INT NOT NULL DEFAULT 0,
    SoDuVi         NUMERIC(15, 2) NOT NULL DEFAULT 0,
    HangThanhVien  VARCHAR(32) NOT NULL DEFAULT 'MEMBER',
    ThoiGianTao    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.CaThuNgan (
    MaCaThuNgan      BIGSERIAL PRIMARY KEY,
    MaNV             VARCHAR(64) NOT NULL,
    ThoiGianMoCa     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ThoiGianDongCa   TIMESTAMPTZ,
    TienDauCa        NUMERIC(15, 2) NOT NULL DEFAULT 0,
    TienCuoiCaThucTe NUMERIC(15, 2),
    TrangThaiCa      INT NOT NULL DEFAULT 1 -- 1=DangMo, 0=DaDong
);

CREATE TABLE IF NOT EXISTS public.HoaDon (
    MaHoaDon          VARCHAR(64) PRIMARY KEY,
    MaNV              VARCHAR(64),
    MaKH              VARCHAR(64),
    MaCaThuNgan       BIGINT,
    TongTien          NUMERIC(15, 2) NOT NULL DEFAULT 0,
    GiamGia           NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ThanhTien         NUMERIC(15, 2) NOT NULL DEFAULT 0,
    TongTienThanhToan NUMERIC(15, 2) NOT NULL DEFAULT 0,
    DaThanhToan       NUMERIC(15, 2) NOT NULL DEFAULT 0,
    PhuongThucTT      VARCHAR(32),
    TrangThaiTT       INT NOT NULL DEFAULT 0, -- -1=PARKED, 0=OPEN, 1=PAID, 2=REFUNDED, 3=MERGED
    GhiChu            TEXT,
    ThoiGianTao       TIMESTAMPTZ NOT NULL DEFAULT now(),
    ThoiGianThanhToan TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.HoaDon_Ban (
    MaHoaDon VARCHAR(64) NOT NULL REFERENCES public.HoaDon(MaHoaDon) ON DELETE CASCADE,
    MaBan    VARCHAR(64) NOT NULL REFERENCES public.Ban(MaBan) ON DELETE CASCADE,
    PRIMARY KEY (MaHoaDon, MaBan)
);

CREATE TABLE IF NOT EXISTS public.ChiTietHoaDon (
    MaCTHD           BIGSERIAL PRIMARY KEY,
    MaHoaDon         VARCHAR(64) NOT NULL REFERENCES public.HoaDon(MaHoaDon) ON DELETE CASCADE,
    MaMon            VARCHAR(64) NOT NULL,
    KichThuoc        VARCHAR(20) NOT NULL DEFAULT 'M',
    SoLuong          INT NOT NULL DEFAULT 1,
    DonGia           NUMERIC(15, 2) NOT NULL DEFAULT 0,
    GhiChu           TEXT,
    TrangThaiPhaChe  VARCHAR(32) NOT NULL DEFAULT 'ChoPha',
    ThoiGianGoi      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ThoiGianHoanThanh TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.ChiTietHoaDon_Topping (
    Id         BIGSERIAL PRIMARY KEY,
    MaCTHD     BIGINT NOT NULL REFERENCES public.ChiTietHoaDon(MaCTHD) ON DELETE CASCADE,
    MaTopping  VARCHAR(64) NOT NULL,
    SoLuong    INT NOT NULL DEFAULT 1,
    DonGia     NUMERIC(15, 2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.PhieuGiaoDichKho (
    MaGD        BIGSERIAL PRIMARY KEY,
    LoaiGD      INT NOT NULL DEFAULT 1, -- 1=Nhap, 2=XuatBan, 3=KiemKe, 4=HuyHaoHut, 9=DaoPhieuNhap
    MaNV        VARCHAR(64),
    GhiChu      TEXT,
    TongGiaTri  NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ThoiGianGD  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ChiTietGiaoDichKho (
    Id          BIGSERIAL PRIMARY KEY,
    MaGD        BIGINT NOT NULL REFERENCES public.PhieuGiaoDichKho(MaGD) ON DELETE CASCADE,
    MaNL        VARCHAR(64) NOT NULL,
    SoLuong     NUMERIC(15, 3) NOT NULL DEFAULT 0,
    DonGia      NUMERIC(15, 4) NOT NULL DEFAULT 0,
    GiaVonSau   NUMERIC(15, 4) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.PhieuThuChiLatVat (
    Id           BIGSERIAL PRIMARY KEY,
    MaCaThuNgan  BIGINT,
    MaNV         VARCHAR(64),
    LoaiPhieu    VARCHAR(16) NOT NULL, -- THU | CHI
    SoTien       NUMERIC(15, 2) NOT NULL DEFAULT 0,
    LyDo         TEXT,
    ThoiGianTao  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.CaLamViec (
    MaCaLam     VARCHAR(64) PRIMARY KEY,
    TenCa       VARCHAR(100) NOT NULL,
    GioBatDau   TIME NOT NULL,
    GioKetThuc  TIME NOT NULL
);

CREATE TABLE IF NOT EXISTS public.PhanCa (
    MaPhanCa    BIGSERIAL PRIMARY KEY,
    MaNV        VARCHAR(64) NOT NULL,
    MaCaLam     VARCHAR(64) NOT NULL,
    NgayLam     DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ChamCong (
    MaChamCong   BIGSERIAL PRIMARY KEY,
    MaPhanCa     BIGINT REFERENCES public.PhanCa(MaPhanCa) ON DELETE CASCADE,
    MaNV         VARCHAR(64) NOT NULL,
    GioVaoThucTe TIMESTAMPTZ,
    GioRaThucTe  TIMESTAMPTZ,
    GhiChu       TEXT
);

CREATE TABLE IF NOT EXISTS public.KhuyenMai (
    MaKM          VARCHAR(64) PRIMARY KEY,
    TenKM         VARCHAR(150) NOT NULL,
    LoaiGiam      VARCHAR(24) NOT NULL DEFAULT 'PERCENT',
    GiaTriGiam    NUMERIC(15, 2) NOT NULL DEFAULT 0,
    DonToiThieu   NUMERIC(15, 2) NOT NULL DEFAULT 0,
    GiamToiDa     NUMERIC(15, 2),
    NgayBatDau    TIMESTAMPTZ,
    NgayKetThuc   TIMESTAMPTZ,
    DangHoatDong  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS public.DonHang_Idempotency (
    KhoaIdem     VARCHAR(128) PRIMARY KEY,
    MaHoaDon     VARCHAR(64),
    TrangThai    VARCHAR(24) NOT NULL DEFAULT 'PROCESSING',
    KetQuaJson   JSONB,
    ThoiGianTao  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.Order_Payments (
    Id              BIGSERIAL PRIMARY KEY,
    MaHoaDon        VARCHAR(64) NOT NULL,
    MaCaThuNgan     BIGINT,
    PhuongThuc      VARCHAR(32) NOT NULL,
    SoTien          NUMERIC(15, 2) NOT NULL,
    TrangThai       VARCHAR(32) NOT NULL DEFAULT 'SUCCESS',
    MaGiaoDichNgoai VARCHAR(128),
    GhiChu          TEXT,
    ThoiGianTao     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.VietQR_Webhook_Events (
    Id              BIGSERIAL PRIMARY KEY,
    NhaCungCap      VARCHAR(32) NOT NULL DEFAULT 'SEPAY',
    MaGiaoDichNgoai VARCHAR(128) NOT NULL UNIQUE,
    SoTien          NUMERIC(15, 2) NOT NULL DEFAULT 0,
    NoiDungCK       TEXT,
    TrangThaiXuLy   VARCHAR(32) NOT NULL DEFAULT 'PROCESSING',
    MaHoaDonKhop    VARCHAR(64),
    PayloadGoc      JSONB NOT NULL DEFAULT '{}'::jsonb,
    ThoiGianNhan    TIMESTAMPTZ NOT NULL DEFAULT now()
);
