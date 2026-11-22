-- ============================================================================
-- Migration 002: Thanh toán hỗn hợp (Order_Payments 1-N) & Webhook VietQR tự động
-- Tương thích ngược 100% với dữ liệu HoaDon lịch sử.
-- ============================================================================

-- 1. Bảng Thanh toán chi tiết (Quan hệ 1-N với HoaDon, hỗ trợ Split Tender & Partial Pay)
CREATE TABLE IF NOT EXISTS Order_Payments (
    Id               BIGSERIAL PRIMARY KEY,
    MaHoaDon         TEXT NOT NULL,
    MaCaThuNgan      TEXT,
    PhuongThucTT     VARCHAR(32) NOT NULL, -- 'TIEN_MAT' | 'CHUYEN_KHOAN' | 'THE' | 'VOUCHER'
    SoTien           NUMERIC(15, 2) NOT NULL CHECK (SoTien > 0),
    TienKhachDua     NUMERIC(15, 2),
    TienThua         NUMERIC(15, 2) NOT NULL DEFAULT 0,
    TrangThai        VARCHAR(16) NOT NULL DEFAULT 'PAID', -- 'PENDING' | 'PAID' | 'REFUNDED'
    MaGiaoDichNgoai  VARCHAR(128) UNIQUE,  -- Mã GD ngân hàng (SePay id / PayOS ref) chống cộng trùng
    NoiDungCK        TEXT,
    NguonXacNhan     VARCHAR(32) NOT NULL DEFAULT 'POS_MANUAL', -- 'POS_MANUAL' | 'SEPAY_WEBHOOK' | 'PAYOS_WEBHOOK' | 'WEBHOOK_SIMULATOR'
    KhoaIdem         VARCHAR(64) UNIQUE,
    MaNV             TEXT,
    ThoiGianTao      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_payments_hd ON Order_Payments (MaHoaDon, TrangThai);
CREATE INDEX IF NOT EXISTS idx_order_payments_ca ON Order_Payments (MaCaThuNgan, TrangThai, PhuongThucTT);
CREATE INDEX IF NOT EXISTS idx_order_payments_thoigian ON Order_Payments (ThoiGianTao DESC);

-- 2. Bảng Nhật ký Webhook Biến động Số dư VietQR (SePay / PayOS) — Chống replay & đối soát CK nhầm
CREATE TABLE IF NOT EXISTS VietQR_Webhook_Events (
    Id               BIGSERIAL PRIMARY KEY,
    NhaCungCap       VARCHAR(32) NOT NULL, -- 'SEPAY' | 'PAYOS' | 'WEBHOOK_SIMULATOR'
    MaGiaoDichNgoai  VARCHAR(128) NOT NULL UNIQUE,
    SoTien           NUMERIC(15, 2) NOT NULL,
    NoiDungCK        TEXT,
    MaHoaDonKhop     TEXT,
    TrangThaiXuLy    VARCHAR(32) NOT NULL, -- 'MATCHED_PAID' | 'PARTIAL_PAID' | 'ALREADY_PAID' | 'UNMATCHED' | 'IGNORED'
    PayloadGoc       JSONB,
    ThoiGianNhan     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vietqr_events_thoigian ON VietQR_Webhook_Events (ThoiGianNhan DESC);
