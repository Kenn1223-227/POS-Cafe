-- ============================================================================
-- Migration 007: Hoàn thiện Fail-Closed RLS (kèm hàm auth cho NOBYPASSRLS),
--                cột TienChuyenThua (VietQR Overpayment), và Post-Payment Refund
-- ============================================================================

-- 1. Hàm SECURITY DEFINER phạm vi hẹp cho middleware kiểm tra nhân viên đang hoạt động
--    (tránh fail 401 hàng loạt khi kết nối DB dùng role app_runtime NOBYPASSRLS + Fail-Closed RLS)
CREATE OR REPLACE FUNCTION public.fn_check_staff_active(p_manv TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT TrangThaiLamViec FROM public.NhanVien WHERE MaNV = p_manv LIMIT 1),
        FALSE
    );
$$;

-- 2. Bổ sung cột ghi nhận phần khách chuyển khoản VietQR dư (Overpayment Ledger Separation)
ALTER TABLE public.Order_Payments
    ADD COLUMN IF NOT EXISTS TienChuyenThua NUMERIC(15, 2) NOT NULL DEFAULT 0;

-- 3. Nâng cấp chính sách RLS của 4 bảng chi tiết + 2 bảng Migration 005 sang FAIL-CLOSED
--    (loại bỏ fallback COALESCE(..., 'DEFAULT') để tuyệt đối không rò rỉ khi quên set app.current_tenant_id)
DO $$
BEGIN
    IF to_regclass('public.sanpham_size') IS NOT NULL THEN
        ALTER TABLE public.SanPham_Size ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.SanPham_Size FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation_policy ON public.SanPham_Size;
        CREATE POLICY tenant_isolation_policy ON public.SanPham_Size
            USING (EXISTS (
                SELECT 1 FROM public.SanPham sp
                 WHERE sp.MaMon = SanPham_Size.MaMon
                   AND sp.TenantId = NULLIF(current_setting('app.current_tenant_id', true), '')
            ))
            WITH CHECK (EXISTS (
                SELECT 1 FROM public.SanPham sp
                 WHERE sp.MaMon = SanPham_Size.MaMon
                   AND sp.TenantId = NULLIF(current_setting('app.current_tenant_id', true), '')
            ));
    END IF;

    IF to_regclass('public.congthuc') IS NOT NULL THEN
        ALTER TABLE public.CongThuc ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.CongThuc FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation_policy ON public.CongThuc;
        CREATE POLICY tenant_isolation_policy ON public.CongThuc
            USING (EXISTS (
                SELECT 1 FROM public.SanPham sp
                 WHERE sp.MaMon = CongThuc.MaMon
                   AND sp.TenantId = NULLIF(current_setting('app.current_tenant_id', true), '')
            ))
            WITH CHECK (EXISTS (
                SELECT 1 FROM public.SanPham sp
                 WHERE sp.MaMon = CongThuc.MaMon
                   AND sp.TenantId = NULLIF(current_setting('app.current_tenant_id', true), '')
            ));
    END IF;

    IF to_regclass('public.chitiethoadon') IS NOT NULL THEN
        ALTER TABLE public.ChiTietHoaDon ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.ChiTietHoaDon FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation_policy ON public.ChiTietHoaDon;
        CREATE POLICY tenant_isolation_policy ON public.ChiTietHoaDon
            USING (EXISTS (
                SELECT 1 FROM public.HoaDon hd
                 WHERE hd.MaHoaDon = ChiTietHoaDon.MaHoaDon
                   AND hd.TenantId = NULLIF(current_setting('app.current_tenant_id', true), '')
            ))
            WITH CHECK (EXISTS (
                SELECT 1 FROM public.HoaDon hd
                 WHERE hd.MaHoaDon = ChiTietHoaDon.MaHoaDon
                   AND hd.TenantId = NULLIF(current_setting('app.current_tenant_id', true), '')
            ));
    END IF;

    IF to_regclass('public.hoadon_ban') IS NOT NULL THEN
        ALTER TABLE public.HoaDon_Ban ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.HoaDon_Ban FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation_policy ON public.HoaDon_Ban;
        CREATE POLICY tenant_isolation_policy ON public.HoaDon_Ban
            USING (EXISTS (
                SELECT 1 FROM public.HoaDon hd
                 WHERE hd.MaHoaDon = HoaDon_Ban.MaHoaDon
                   AND hd.TenantId = NULLIF(current_setting('app.current_tenant_id', true), '')
            ))
            WITH CHECK (EXISTS (
                SELECT 1 FROM public.HoaDon hd
                 WHERE hd.MaHoaDon = HoaDon_Ban.MaHoaDon
                   AND hd.TenantId = NULLIF(current_setting('app.current_tenant_id', true), '')
            ));
    END IF;

    IF to_regclass('public.nguyenlieu_donviquydoi') IS NOT NULL THEN
        ALTER TABLE public.NguyenLieu_DonViQuyDoi ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.NguyenLieu_DonViQuyDoi FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation_policy ON public.NguyenLieu_DonViQuyDoi;
        CREATE POLICY tenant_isolation_policy ON public.NguyenLieu_DonViQuyDoi
            USING (TenantId = NULLIF(current_setting('app.current_tenant_id', true), ''))
            WITH CHECK (TenantId = NULLIF(current_setting('app.current_tenant_id', true), ''));
    END IF;

    IF to_regclass('public.topping_congthuc') IS NOT NULL THEN
        ALTER TABLE public.Topping_CongThuc ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.Topping_CongThuc FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation_policy ON public.Topping_CongThuc;
        CREATE POLICY tenant_isolation_policy ON public.Topping_CongThuc
            USING (TenantId = NULLIF(current_setting('app.current_tenant_id', true), ''))
            WITH CHECK (TenantId = NULLIF(current_setting('app.current_tenant_id', true), ''));
    END IF;
END $$;
