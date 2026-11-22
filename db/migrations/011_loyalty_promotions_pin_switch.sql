-- ============================================================================
-- MIGRATION 011: ĐỔI ĐIỂM LOYALTY + PROMOTION ENGINE (HAPPY HOUR / MÃ GIẢM GIÁ)
-- Mục đích:
--   1. Tạo bảng KhuyenMai (cô lập theo TenantId + Fail-Closed RLS) hỗ trợ
--      Mã giảm giá (CODE) và Tự động theo khung giờ (HAPPY_HOUR).
--   2. Bổ sung các cột lưu vết giảm giá khuyến mãi & đổi điểm Loyalty trên HoaDon.
--   (Tính năng chuyển đổi nhân viên nhanh bằng PIN tái sử dụng cột NhanVien.PinHash.)
-- An toàn chạy lặp lại nhiều lần (Idempotent).
-- ============================================================================

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

-- Fail-Closed Row-Level Security cho KhuyenMai (đồng bộ biến GUC app.current_tenant_id toàn hệ thống)
ALTER TABLE public.khuyenmai ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.khuyenmai FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_khuyenmai ON public.khuyenmai;
CREATE POLICY tenant_isolation_khuyenmai ON public.khuyenmai
    USING (TenantId = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (TenantId = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- Các cột lưu vết Giảm giá Khuyến mãi & Đổi điểm Loyalty trên HoaDon
ALTER TABLE IF EXISTS public.hoadon ADD COLUMN IF NOT EXISTS MaKhuyenMai VARCHAR(40);
ALTER TABLE IF EXISTS public.hoadon ADD COLUMN IF NOT EXISTS TenKhuyenMai VARCHAR(120);
ALTER TABLE IF EXISTS public.hoadon ADD COLUMN IF NOT EXISTS TienGiamKM NUMERIC(15, 2) NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS public.hoadon ADD COLUMN IF NOT EXISTS DiemSuDung INT NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS public.hoadon ADD COLUMN IF NOT EXISTS TienGiamDiem NUMERIC(15, 2) NOT NULL DEFAULT 0;
