-- ============================================================================
-- MIGRATION 012: VÁ KHẨN CẤP P0 — FAIL-CLOSED RLS (KHUYENMAI / WEBHOOK / BILLING / 5 BẢNG CON)
--                & LƯU VẾT HÓA ĐƠN OFFLINE (MaOfflineClient)
-- An toàn chạy lặp lại nhiều lần (Idempotent).
-- ============================================================================

-- 1. Vá lỗi P0 #1: Sai tên biến GUC ở bảng KhuyenMai (app.current_tenant -> app.current_tenant_id)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'khuyenmai') THEN
        EXECUTE 'ALTER TABLE public.khuyenmai ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE public.khuyenmai FORCE ROW LEVEL SECURITY';
        EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_khuyenmai ON public.khuyenmai';
        EXECUTE $pol$
            CREATE POLICY tenant_isolation_khuyenmai ON public.khuyenmai
                USING (TenantId = NULLIF(current_setting('app.current_tenant_id', true), ''))
                WITH CHECK (TenantId = NULLIF(current_setting('app.current_tenant_id', true), ''))
        $pol$;
    END IF;
END $$;

-- 2. Vá lỗi P0 #2: Các hàm SECURITY DEFINER phạm vi hẹp cho Webhook VietQR, Billing SaaS & Register
--    (Đảm bảo 100% luồng Webhook & Đăng ký quán hoạt động ổn định dưới app_runtime NOBYPASSRLS)

CREATE OR REPLACE FUNCTION public.fn_lookup_billing_order(p_ma_don TEXT)
RETURNS TABLE (
    Id BIGINT,
    TenantId VARCHAR,
    GoiCuoc VARCHAR,
    SoThang INT,
    SoTien NUMERIC,
    TrangThai VARCHAR
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT o.Id, o.TenantId, o.GoiCuoc, o.SoThang, o.SoTien, o.TrangThai
      FROM public.Tenant_Billing_Orders o
     WHERE o.MaDonThanhToan = p_ma_don
     LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.fn_username_exists(p_username TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS(
        SELECT 1
          FROM public.NhanVien
         WHERE LOWER(TenDangNhap) = LOWER(p_username)
    );
$$;

-- Ghi nhận Webhook Event chống trùng lặp Idempotent (chạy an toàn trước khi biết TenantId)
CREATE OR REPLACE FUNCTION public.fn_record_webhook_event(
    p_nha_cung_cap VARCHAR,
    p_ma_gd_ngoai  VARCHAR,
    p_so_tien      NUMERIC,
    p_noi_dung_ck  TEXT,
    p_payload_goc  JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id BIGINT;
BEGIN
    INSERT INTO public.VietQR_Webhook_Events
        (NhaCungCap, MaGiaoDichNgoai, SoTien, NoiDungCK, TrangThaiXuLy, PayloadGoc, TenantId)
    VALUES
        (p_nha_cung_cap, p_ma_gd_ngoai, p_so_tien, COALESCE(p_noi_dung_ck, ''), 'PROCESSING', COALESCE(p_payload_goc, '{}'::jsonb), 'SYSTEM_UNMATCHED')
    ON CONFLICT (MaGiaoDichNgoai) DO NOTHING
    RETURNING Id INTO v_id;

    RETURN v_id IS NOT NULL;
END;
$$;

-- Cập nhật kết quả đối soát Webhook Event (gán đúng TenantId & MaHoaDonKhop sau khi khớp đơn)
CREATE OR REPLACE FUNCTION public.fn_update_webhook_event(
    p_ma_gd_ngoai    VARCHAR,
    p_trang_thai     VARCHAR,
    p_ma_hd_khop     TEXT DEFAULT NULL,
    p_tenant_id      VARCHAR DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE public.VietQR_Webhook_Events
       SET TrangThaiXuLy = p_trang_thai,
           MaHoaDonKhop  = COALESCE(p_ma_hd_khop, MaHoaDonKhop),
           TenantId      = COALESCE(p_tenant_id, TenantId)
     WHERE MaGiaoDichNgoai = p_ma_gd_ngoai;
$$;

-- 3. Vá lỗi P0 #3: Bật Fail-Closed RLS cho 5 bảng dữ liệu con còn thiếu
--    (ChiTietHoaDon_Topping, PhieuThuChiLatVat, ChiTietGiaoDichKho, ChamCong, DonHang_Idempotency)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'chitiethoadon_topping') THEN
        EXECUTE 'ALTER TABLE public.chitiethoadon_topping ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE public.chitiethoadon_topping FORCE ROW LEVEL SECURITY';
        EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_cthd_topping ON public.chitiethoadon_topping';
        EXECUTE $p1$
            CREATE POLICY tenant_isolation_cthd_topping ON public.chitiethoadon_topping
            USING (
                EXISTS (
                    SELECT 1
                      FROM public.ChiTietHoaDon c
                      JOIN public.HoaDon h ON h.MaHoaDon = c.MaHoaDon
                     WHERE c.MaCTHD = ChiTietHoaDon_Topping.MaCTHD
                       AND COALESCE(h.TenantId, 'DEFAULT') = NULLIF(current_setting('app.current_tenant_id', true), '')
                )
            )
            WITH CHECK (
                EXISTS (
                    SELECT 1
                      FROM public.ChiTietHoaDon c
                      JOIN public.HoaDon h ON h.MaHoaDon = c.MaHoaDon
                     WHERE c.MaCTHD = ChiTietHoaDon_Topping.MaCTHD
                       AND COALESCE(h.TenantId, 'DEFAULT') = NULLIF(current_setting('app.current_tenant_id', true), '')
                )
            )
        $p1$;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'phieuthuchilatvat') THEN
        EXECUTE 'ALTER TABLE public.phieuthuchilatvat ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE public.phieuthuchilatvat FORCE ROW LEVEL SECURITY';
        EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_phieuthuchi ON public.phieuthuchilatvat';
        EXECUTE $p2$
            CREATE POLICY tenant_isolation_phieuthuchi ON public.phieuthuchilatvat
            USING (
                EXISTS (
                    SELECT 1
                      FROM public.CaThuNgan ca
                     WHERE ca.MaCaThuNgan = PhieuThuChiLatVat.MaCaThuNgan
                       AND COALESCE(ca.TenantId, 'DEFAULT') = NULLIF(current_setting('app.current_tenant_id', true), '')
                )
            )
            WITH CHECK (
                EXISTS (
                    SELECT 1
                      FROM public.CaThuNgan ca
                     WHERE ca.MaCaThuNgan = PhieuThuChiLatVat.MaCaThuNgan
                       AND COALESCE(ca.TenantId, 'DEFAULT') = NULLIF(current_setting('app.current_tenant_id', true), '')
                )
            )
        $p2$;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'chitietgiaodichkho') THEN
        EXECUTE 'ALTER TABLE public.chitietgiaodichkho ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE public.chitietgiaodichkho FORCE ROW LEVEL SECURITY';
        EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_ct_gdkho ON public.chitietgiaodichkho';
        EXECUTE $p3$
            CREATE POLICY tenant_isolation_ct_gdkho ON public.chitietgiaodichkho
            USING (
                EXISTS (
                    SELECT 1
                      FROM public.PhieuGiaoDichKho p
                     WHERE p.MaGiaoDich = ChiTietGiaoDichKho.MaGiaoDich
                       AND COALESCE(p.TenantId, 'DEFAULT') = NULLIF(current_setting('app.current_tenant_id', true), '')
                )
            )
            WITH CHECK (
                EXISTS (
                    SELECT 1
                      FROM public.PhieuGiaoDichKho p
                     WHERE p.MaGiaoDich = ChiTietGiaoDichKho.MaGiaoDich
                       AND COALESCE(p.TenantId, 'DEFAULT') = NULLIF(current_setting('app.current_tenant_id', true), '')
                )
            )
        $p3$;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'chamcong') THEN
        EXECUTE 'ALTER TABLE public.chamcong ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE public.chamcong FORCE ROW LEVEL SECURITY';
        EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_chamcong ON public.chamcong';
        EXECUTE $p4$
            CREATE POLICY tenant_isolation_chamcong ON public.chamcong
            USING (
                EXISTS (
                    SELECT 1
                      FROM public.PhanCa pc
                      JOIN public.NhanVien nv ON nv.MaNV = pc.MaNV
                     WHERE pc.MaPhanCa = ChamCong.MaPhanCa
                       AND COALESCE(nv.TenantId, 'DEFAULT') = NULLIF(current_setting('app.current_tenant_id', true), '')
                )
            )
            WITH CHECK (
                EXISTS (
                    SELECT 1
                      FROM public.PhanCa pc
                      JOIN public.NhanVien nv ON nv.MaNV = pc.MaNV
                     WHERE pc.MaPhanCa = ChamCong.MaPhanCa
                       AND COALESCE(nv.TenantId, 'DEFAULT') = NULLIF(current_setting('app.current_tenant_id', true), '')
                )
            )
        $p4$;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'donhang_idempotency') THEN
        EXECUTE 'ALTER TABLE public.donhang_idempotency ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT ''DEFAULT''';
        EXECUTE $def$
            ALTER TABLE public.donhang_idempotency
                ALTER COLUMN TenantId SET DEFAULT COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), 'DEFAULT')
        $def$;
        EXECUTE 'ALTER TABLE public.donhang_idempotency ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE public.donhang_idempotency FORCE ROW LEVEL SECURITY';
        EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_idempotency ON public.donhang_idempotency';
        EXECUTE $p5$
            CREATE POLICY tenant_isolation_idempotency ON public.donhang_idempotency
            USING (COALESCE(TenantId, 'DEFAULT') = NULLIF(current_setting('app.current_tenant_id', true), ''))
            WITH CHECK (COALESCE(TenantId, 'DEFAULT') = NULLIF(current_setting('app.current_tenant_id', true), ''))
        $p5$;
    END IF;
END $$;

-- 4. Vá lỗi P0 #5: Lưu vết mã hóa đơn Offline (#OFF-HHMMSS) lên HoaDon để đối chiếu khiếu nại
ALTER TABLE IF EXISTS public.hoadon
    ADD COLUMN IF NOT EXISTS MaOfflineClient VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_hoadon_offline_client
    ON public.hoadon (TenantId, MaOfflineClient)
    WHERE MaOfflineClient IS NOT NULL;
