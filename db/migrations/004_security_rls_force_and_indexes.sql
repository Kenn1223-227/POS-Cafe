-- ============================================================================
-- Migration 004: Defense-in-Depth Multi-Tenant RLS Hardening, Audit Immutability
--                & High-Concurrency Composite Indexes (Chuẩn Đợt 3 - Phân hệ 7)
-- ============================================================================

-- 0. LỆNH KIỂM CHỨNG BẮT BUỘC TRÊN SUPABASE (Chạy trong SQL Editor để kiểm tra):
--    SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
--    SELECT relname, relrowsecurity, relforcerowsecurity
--      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--     WHERE n.nspname = 'public' AND relkind = 'r'
--       AND (NOT relrowsecurity OR NOT relforcerowsecurity);

-- 1. Mẫu tạo Role ứng dụng KHÔNG có quyền BYPASSRLS (bỏ comment và đổi mật khẩu mạnh trước khi chạy trên Supabase):
-- CREATE ROLE app_runtime LOGIN PASSWORD 'CHANGE_TO_STRONG_64_CHAR_PASSWORD' NOBYPASSRLS NOSUPERUSER;
-- GRANT USAGE ON SCHEMA public TO app_runtime;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;

-- 2. ÉP BUỘC FORCE ROW LEVEL SECURITY + Chính sách FAIL-CLOSED (bỏ fallback 'DEFAULT')
-- Lưu ý: Chỉ chuyển sang fail-closed khi toàn bộ truy vấn đã đi qua SET LOCAL app.current_tenant_id
-- hoặc dùng với app_runtime NOBYPASSRLS!
ALTER TABLE public.NhanVien ADD COLUMN IF NOT EXISTS PinHash TEXT;

DO $$
DECLARE
    tbl TEXT;
    tables TEXT[] := ARRAY[
        'nhanvien', 'ban', 'sanpham', 'topping', 'nguyenlieu', 'hoadon',
        'cathungan', 'khachhang', 'phieugiaodichkho', 'phanca', 'calamviec',
        'audit_logs', 'order_payments', 'vietqr_webhook_events', 'tenant_billing_orders'
    ];
BEGIN
    FOREACH tbl IN ARRAY tables LOOP
        IF to_regclass('public.' || tbl) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
            EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
            EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON public.%I', tbl);
            -- FAIL-CLOSED: Nếu quên set app.current_tenant_id -> NULLIF trả NULL -> 0 dòng (tuyệt đối không fallback 'DEFAULT'!)
            EXECUTE format(
                'CREATE POLICY tenant_isolation_policy ON public.%I
                 USING (TenantId = NULLIF(current_setting(''app.current_tenant_id'', true), ''''))
                 WITH CHECK (TenantId = NULLIF(current_setting(''app.current_tenant_id'', true), ''''))',
                tbl
            );
        END IF;
    END LOOP;
END $$;

-- 3. Bật RLS cho các bảng chi tiết (qua quan hệ cha)
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
                   AND sp.TenantId = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), 'DEFAULT')
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
                   AND sp.TenantId = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), 'DEFAULT')
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
                   AND hd.TenantId = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), 'DEFAULT')
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
                   AND hd.TenantId = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), 'DEFAULT')
            ));
    END IF;
END $$;

-- 3b. Các hàm SECURITY DEFINER phạm vi hẹp cho bước định tuyến ban đầu khi chạy Fail-Closed RLS với role NOBYPASSRLS
--     (Login chưa biết TenantId, Webhook VietQR chỉ có mã hóa đơn/mã đơn SUB trong nội dung chuyển khoản)
CREATE OR REPLACE FUNCTION public.fn_lookup_login_user(p_username TEXT)
RETURNS TABLE (
    MaNV VARCHAR,
    TenNV VARCHAR,
    VaiTro INT,
    MatKhauHash TEXT,
    TenantId VARCHAR,
    MaTienTo VARCHAR,
    TenQuan VARCHAR,
    GoiCuoc VARCHAR,
    TrangThaiGoi VARCHAR,
    TrialEndsAt TIMESTAMPTZ,
    SubscriptionEndsAt TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT nv.MaNV::varchar, nv.TenNV::varchar, nv.VaiTro, nv.MatKhauHash::text,
           COALESCE(nv.TenantId, 'DEFAULT')::varchar AS TenantId,
           COALESCE(t.MaTienTo, 'DEF')::varchar AS MaTienTo,
           COALESCE(t.TenQuan, 'Quán Cà Phê POS')::varchar AS TenQuan,
           COALESCE(t.GoiCuoc, 'PRO')::varchar AS GoiCuoc,
           COALESCE(t.TrangThai, 'ACTIVE')::varchar AS TrangThaiGoi,
           t.TrialEndsAt,
           t.SubscriptionEndsAt
      FROM public.NhanVien nv
      LEFT JOIN public.Tenants t ON t.TenantId = COALESCE(nv.TenantId, 'DEFAULT')
     WHERE nv.TenDangNhap = p_username
       AND nv.TrangThaiLamViec = TRUE
     LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.fn_lookup_open_invoice_by_codes(p_codes TEXT[])
RETURNS TABLE (MaHoaDon TEXT, TenantId VARCHAR)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT hd.MaHoaDon::text, COALESCE(hd.TenantId, 'DEFAULT')::varchar AS TenantId
      FROM public.HoaDon hd
     WHERE hd.TrangThaiTT = 0
       AND (
           UPPER(hd.MaHoaDon::text) = ANY(p_codes)
           OR REGEXP_REPLACE(UPPER(hd.MaHoaDon::text), '[^A-Z0-9]', '', 'g') = ANY(p_codes)
       )
     ORDER BY hd.ThoiGianTao DESC
     LIMIT 1;
$$;

-- 4. Nhật ký kiểm toán bất biến (Append-Only Trigger chặn mọi UPDATE/DELETE)
CREATE OR REPLACE FUNCTION public.audit_no_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Audit_Logs là nhật ký bất biến (append-only), cấm sửa hoặc xóa!';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_immutable ON public.Audit_Logs;
CREATE TRIGGER trg_audit_immutable
    BEFORE UPDATE OR DELETE ON public.Audit_Logs
    FOR EACH ROW EXECUTE FUNCTION public.audit_no_mutation();

-- 5. Composite Indexes tối ưu hiệu năng cho 500–1.000 quán chạy đồng thời giờ cao điểm
CREATE INDEX IF NOT EXISTS idx_hd_tenant_tt_time ON public.HoaDon (TenantId, TrangThaiTT, ThoiGianThanhToan DESC);
CREATE INDEX IF NOT EXISTS idx_hd_tenant_open ON public.HoaDon (TenantId, TrangThaiTT, ThoiGianTao DESC);
CREATE INDEX IF NOT EXISTS idx_cthd_hoadon_tt ON public.ChiTietHoaDon (MaHoaDon, TrangThaiPhaChe);
CREATE INDEX IF NOT EXISTS idx_kho_tenant_time ON public.PhieuGiaoDichKho (TenantId, ThoiGianTao DESC);
CREATE INDEX IF NOT EXISTS idx_nl_tenant_active ON public.NguyenLieu (TenantId, DaXoa, MaNL);
CREATE INDEX IF NOT EXISTS idx_sp_tenant_active ON public.SanPham (TenantId, DangKinhDoanh, NhomMon);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON public.Audit_Logs (TenantId, ThoiGianTao DESC);
CREATE INDEX IF NOT EXISTS idx_payments_tenant_ca ON public.Order_Payments (TenantId, MaCaThuNgan, TrangThai);
CREATE INDEX IF NOT EXISTS idx_nv_tenant_active ON public.NhanVien (TenantId, TrangThaiLamViec);
