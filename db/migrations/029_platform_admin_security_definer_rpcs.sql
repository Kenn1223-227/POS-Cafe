-- =============================================================================
-- MIGRATION 029 (WAVE 1 — P0-04):
--   Chuyển toàn bộ truy vấn cross-tenant của Super Admin (platformAdminRoutes)
--   sang PostgreSQL SECURITY DEFINER functions kèm SET search_path = public,
--   REVOKE FROM PUBLIC & GRANT EXECUTE chỉ cho app_runtime (NOBYPASSRLS).
--   Đảm bảo ghi Audit_Logs bắt buộc cho manual-approve & impersonate.
-- =============================================================================

BEGIN;

-- 1. KPI Overview toàn hệ thống cho Super Admin
CREATE OR REPLACE FUNCTION public.fn_platform_overview_tenants()
RETURNS TABLE (
    tenantid                  VARCHAR,
    tenquan                   VARCHAR,
    goicuoc                   VARCHAR,
    trangthai                 VARCHAR,
    trialendsat               TIMESTAMPTZ,
    subscriptionendsat        TIMESTAMPTZ,
    featureflags              JSONB,
    thoigiantao               TIMESTAMPTZ,
    last_login_at             TEXT,
    offline_failed_count      INT,
    offline_total_sync_count  INT,
    owner_contact             TEXT,
    referred_by               TEXT,
    so_don                    BIGINT,
    so_don_thang_nay          BIGINT,
    so_don_3_ngay             BIGINT,
    so_don_7_ngay             BIGINT,
    so_don_7_14_ngay          BIGINT,
    so_don_14_ngay            BIGINT,
    lan_ban_cuoi              TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT t.TenantId, t.TenQuan, t.GoiCuoc, t.TrangThai, t.TrialEndsAt, t.SubscriptionEndsAt,
           t.FeatureFlags, t.ThoiGianTao,
           to_jsonb(t)->>'lastloginat' AS last_login_at,
           COALESCE((to_jsonb(t)->>'offlinefailedcount')::int, 0) AS offline_failed_count,
           COALESCE((to_jsonb(t)->>'offlinetotalsynccount')::int, 0) AS offline_total_sync_count,
           to_jsonb(t)->>'ownercontact' AS owner_contact,
           to_jsonb(t)->>'referredby' AS referred_by,
           (SELECT COUNT(*) FROM public.HoaDon h WHERE h.TenantId = t.TenantId AND h.TrangThaiTT = 1) AS so_don,
           (SELECT COUNT(*) FROM public.HoaDon h WHERE h.TenantId = t.TenantId
               AND date_trunc('month', h.ThoiGianTao::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')
                   = date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')) AS so_don_thang_nay,
           (SELECT COUNT(*) FROM public.HoaDon h WHERE h.TenantId = t.TenantId AND h.TrangThaiTT = 1
               AND h.ThoiGianTao >= now() - interval '3 days') AS so_don_3_ngay,
           (SELECT COUNT(*) FROM public.HoaDon h WHERE h.TenantId = t.TenantId AND h.TrangThaiTT = 1
               AND h.ThoiGianTao >= now() - interval '7 days') AS so_don_7_ngay,
           (SELECT COUNT(*) FROM public.HoaDon h WHERE h.TenantId = t.TenantId AND h.TrangThaiTT = 1
               AND h.ThoiGianTao >= now() - interval '14 days'
               AND h.ThoiGianTao < now() - interval '7 days') AS so_don_7_14_ngay,
           (SELECT COUNT(*) FROM public.HoaDon h WHERE h.TenantId = t.TenantId AND h.TrangThaiTT = 1
               AND h.ThoiGianTao >= now() - interval '14 days') AS so_don_14_ngay,
           (SELECT MAX(h.ThoiGianTao) FROM public.HoaDon h WHERE h.TenantId = t.TenantId) AS lan_ban_cuoi
      FROM public.Tenants t;
$$;

CREATE OR REPLACE FUNCTION public.fn_platform_overview_billing()
RETURNS TABLE (
    don_cho_duyet  BIGINT,
    tien_cho_duyet NUMERIC,
    don_da_duyet   BIGINT,
    tong_thu_goi   NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        COUNT(*) FILTER (WHERE TrangThai = 'PENDING') AS don_cho_duyet,
        COALESCE(SUM(SoTien) FILTER (WHERE TrangThai = 'PENDING'), 0) AS tien_cho_duyet,
        COUNT(*) FILTER (WHERE TrangThai = 'PAID') AS don_da_duyet,
        COALESCE(SUM(SoTien) FILTER (WHERE TrangThai = 'PAID'), 0) AS tong_thu_goi
      FROM public.Tenant_Billing_Orders;
$$;

-- 2. Danh sách Tenants kèm chỉ số thực tế xuyên tenant
CREATE OR REPLACE FUNCTION public.fn_platform_list_tenants(p_limit INT DEFAULT 200)
RETURNS TABLE (
    tenantid                  VARCHAR,
    matiento                  VARCHAR,
    tenquan                   VARCHAR,
    slug                      VARCHAR,
    mohinh                    VARCHAR,
    goicuoc                   VARCHAR,
    trangthai                 VARCHAR,
    trialendsat               TIMESTAMPTZ,
    subscriptionendsat        TIMESTAMPTZ,
    lastpaymentat             TIMESTAMPTZ,
    featureflags              JSONB,
    thoigiantao               TIMESTAMPTZ,
    last_login_at             TEXT,
    offline_failed_count      INT,
    offline_total_sync_count  INT,
    owner_contact             TEXT,
    referred_by               TEXT,
    so_don                    BIGINT,
    so_don_thang_nay          BIGINT,
    so_don_3_ngay             BIGINT,
    so_don_7_ngay             BIGINT,
    so_don_7_14_ngay          BIGINT,
    so_don_14_ngay            BIGINT,
    tong_doanh_thu            NUMERIC,
    lan_ban_cuoi              TIMESTAMPTZ,
    so_mon                    BIGINT,
    so_nv                     BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT t.TenantId, t.MaTienTo, t.TenQuan, t.Slug, t.MoHinh, t.GoiCuoc, t.TrangThai,
           t.TrialEndsAt, t.SubscriptionEndsAt, t.LastPaymentAt, t.FeatureFlags, t.ThoiGianTao,
           to_jsonb(t)->>'lastloginat' AS last_login_at,
           COALESCE((to_jsonb(t)->>'offlinefailedcount')::int, 0) AS offline_failed_count,
           COALESCE((to_jsonb(t)->>'offlinetotalsynccount')::int, 0) AS offline_total_sync_count,
           to_jsonb(t)->>'ownercontact' AS owner_contact,
           to_jsonb(t)->>'referredby' AS referred_by,
           (SELECT COUNT(*) FROM public.HoaDon h WHERE h.TenantId = t.TenantId AND h.TrangThaiTT = 1) AS so_don,
           (SELECT COUNT(*) FROM public.HoaDon h WHERE h.TenantId = t.TenantId
               AND date_trunc('month', h.ThoiGianTao::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')
                   = date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')) AS so_don_thang_nay,
           (SELECT COUNT(*) FROM public.HoaDon h WHERE h.TenantId = t.TenantId AND h.TrangThaiTT = 1
               AND h.ThoiGianTao >= now() - interval '3 days') AS so_don_3_ngay,
           (SELECT COUNT(*) FROM public.HoaDon h WHERE h.TenantId = t.TenantId AND h.TrangThaiTT = 1
               AND h.ThoiGianTao >= now() - interval '7 days') AS so_don_7_ngay,
           (SELECT COUNT(*) FROM public.HoaDon h WHERE h.TenantId = t.TenantId AND h.TrangThaiTT = 1
               AND h.ThoiGianTao >= now() - interval '14 days'
               AND h.ThoiGianTao < now() - interval '7 days') AS so_don_7_14_ngay,
           (SELECT COUNT(*) FROM public.HoaDon h WHERE h.TenantId = t.TenantId AND h.TrangThaiTT = 1
               AND h.ThoiGianTao >= now() - interval '14 days') AS so_don_14_ngay,
           (SELECT COALESCE(SUM(COALESCE(h.TongTienThanhToan, h.ThanhTien, h.TongTien, 0)), 0)
              FROM public.HoaDon h WHERE h.TenantId = t.TenantId AND h.TrangThaiTT = 1) AS tong_doanh_thu,
           (SELECT MAX(h.ThoiGianTao) FROM public.HoaDon h WHERE h.TenantId = t.TenantId) AS lan_ban_cuoi,
           (SELECT COUNT(*) FROM public.SanPham s WHERE s.TenantId = t.TenantId AND s.DangKinhDoanh = TRUE) AS so_mon,
           (SELECT COUNT(*) FROM public.NhanVien n WHERE n.TenantId = t.TenantId AND n.TrangThaiLamViec = TRUE) AS so_nv
      FROM public.Tenants t
     ORDER BY t.ThoiGianTao DESC
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000));
$$;

-- 3. Danh sách đơn billing toàn sàn cho Super Admin
CREATE OR REPLACE FUNCTION public.fn_platform_list_billing_orders(p_status TEXT DEFAULT NULL, p_limit INT DEFAULT 100)
RETURNS TABLE (
    id                 BIGINT,
    madonthanhtoan     VARCHAR,
    tenantid           VARCHAR,
    tenquan            VARCHAR,
    goicuoc            VARCHAR,
    sothang            INT,
    sotien             NUMERIC,
    trangthai          VARCHAR,
    phuongthuctt       VARCHAR,
    magiaodichngoai    VARCHAR,
    ghichu             TEXT,
    thoigiantao        TIMESTAMPTZ,
    thoigianthanhtoan  TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT o.Id, o.MaDonThanhToan, o.TenantId, t.TenQuan, o.GoiCuoc, o.SoThang,
           o.SoTien, o.TrangThai, o.PhuongThucTT, o.MaGiaoDichNgoai, o.GhiChu,
           o.ThoiGianTao, o.ThoiGianThanhToan
      FROM public.Tenant_Billing_Orders o
      LEFT JOIN public.Tenants t ON t.TenantId = o.TenantId
     WHERE (p_status IS NULL OR p_status = '' OR o.TrangThai = p_status)
     ORDER BY o.ThoiGianTao DESC
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
$$;

-- 4. Duyệt tay đơn Billing SaaS xuyên tenant (có FOR UPDATE + ghi Audit_Logs bắt buộc)
CREATE OR REPLACE FUNCTION public.fn_platform_manual_approve_billing(
    p_ma_don          TEXT,
    p_bank_tx_ref     TEXT,
    p_ghi_chu         TEXT,
    p_feature_flags   JSONB,
    p_admin_username  TEXT,
    p_ip              TEXT DEFAULT NULL
)
RETURNS TABLE (
    status               TEXT,
    target_tenant_id     VARCHAR,
    ten_quan             VARCHAR,
    goi_cuoc             VARCHAR,
    so_thang             INT,
    so_tien              NUMERIC,
    subscription_ends_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order    RECORD;
    v_tenant   RECORD;
    v_base_ts  TIMESTAMPTZ;
    v_new_end  TIMESTAMPTZ;
BEGIN
    SELECT o.Id, o.TenantId, o.GoiCuoc, o.SoThang, o.SoTien, o.TrangThai
      INTO v_order
      FROM public.Tenant_Billing_Orders o
     WHERE o.MaDonThanhToan = p_ma_don
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, NULL::INT, NULL::NUMERIC, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_order.TrangThai = 'PAID' THEN
        RETURN QUERY SELECT 'ALREADY_PAID'::TEXT, v_order.TenantId::VARCHAR, NULL::VARCHAR, v_order.GoiCuoc::VARCHAR, v_order.SoThang::INT, v_order.SoTien::NUMERIC, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    SELECT t.TenantId, t.TenQuan, t.SubscriptionEndsAt
      INTO v_tenant
      FROM public.Tenants t
     WHERE t.TenantId = v_order.TenantId
       FOR UPDATE;

    v_base_ts := CASE
        WHEN v_tenant.SubscriptionEndsAt IS NOT NULL AND v_tenant.SubscriptionEndsAt > now()
            THEN v_tenant.SubscriptionEndsAt
        ELSE now()
    END;
    v_new_end := v_base_ts + make_interval(days => GREATEST(1, COALESCE(v_order.SoThang, 1)) * 30);

    UPDATE public.Tenant_Billing_Orders
       SET TrangThai = 'PAID',
           MaGiaoDichNgoai = p_bank_tx_ref,
           GhiChu = COALESCE(NULLIF(p_ghi_chu, ''), GhiChu),
           ThoiGianThanhToan = now()
     WHERE Id = v_order.Id;

    UPDATE public.Tenants
       SET GoiCuoc = v_order.GoiCuoc,
           FeatureFlags = COALESCE(p_feature_flags, FeatureFlags),
           TrangThai = 'ACTIVE',
           SubscriptionEndsAt = v_new_end,
           LastPaymentAt = now()
     WHERE TenantId = v_order.TenantId;

    INSERT INTO public.Audit_Logs
        (TenantId, MaNV, VaiTro, NguoiDuyet, HanhDong, DoiTuong, MaDoiTuong, GiaTriMoi, LyDo, DiaChiIP)
    VALUES (
        v_order.TenantId,
        'PLATFORM:' || COALESCE(p_admin_username, 'superadmin'),
        1,
        COALESCE(p_admin_username, 'superadmin'),
        'PLATFORM_BILLING_APPROVED',
        'TENANT',
        p_ma_don,
        jsonb_build_object(
            'goiCuoc', v_order.GoiCuoc,
            'soThang', v_order.SoThang,
            'soTien', v_order.SoTien,
            'bankTxRef', p_bank_tx_ref,
            'subscriptionEndsAt', v_new_end
        ),
        COALESCE(NULLIF(p_ghi_chu, ''), 'Super Admin doi soat sao ke ' || p_bank_tx_ref),
        p_ip
    );

    RETURN QUERY SELECT
        'APPROVED'::TEXT,
        v_order.TenantId::VARCHAR,
        COALESCE(v_tenant.TenQuan, v_order.TenantId)::VARCHAR,
        v_order.GoiCuoc::VARCHAR,
        v_order.SoThang::INT,
        v_order.SoTien::NUMERIC,
        v_new_end;
END;
$$;

-- 5. Lấy thông tin Impersonate + ghi Audit_Logs bắt buộc dưới SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.fn_platform_impersonate_prepare(
    p_tenant_id       TEXT,
    p_admin_username  TEXT,
    p_ly_do           TEXT,
    p_expires_at      TIMESTAMPTZ,
    p_ip              TEXT DEFAULT NULL
)
RETURNS TABLE (
    status             TEXT,
    tenantid           VARCHAR,
    matiento           VARCHAR,
    tenquan            VARCHAR,
    goicuoc            VARCHAR,
    trangthai          VARCHAR,
    trialendsat        TIMESTAMPTZ,
    subscriptionendsat TIMESTAMPTZ,
    featureflags       JSONB,
    manv               VARCHAR,
    tennv              VARCHAR,
    vaitro             INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_t  RECORD;
    v_nv RECORD;
BEGIN
    SELECT t.TenantId, t.MaTienTo, t.TenQuan, t.GoiCuoc, t.TrangThai,
           t.TrialEndsAt, t.SubscriptionEndsAt, t.FeatureFlags
      INTO v_t
      FROM public.Tenants t
     WHERE t.TenantId = p_tenant_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'TENANT_NOT_FOUND'::TEXT, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, NULL::JSONB, NULL::VARCHAR, NULL::VARCHAR, NULL::INT;
        RETURN;
    END IF;

    SELECT n.MaNV, n.TenNV, n.VaiTro
      INTO v_nv
      FROM public.NhanVien n
     WHERE COALESCE(n.TenantId, 'DEFAULT') = p_tenant_id
       AND n.TrangThaiLamViec = TRUE
     ORDER BY CASE WHEN n.VaiTro = 1 THEN 0 ELSE 1 END, n.MaNV ASC
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NO_ACTIVE_STAFF'::TEXT, v_t.TenantId::VARCHAR, v_t.MaTienTo::VARCHAR, v_t.TenQuan::VARCHAR, v_t.GoiCuoc::VARCHAR, v_t.TrangThai::VARCHAR, v_t.TrialEndsAt, v_t.SubscriptionEndsAt, v_t.FeatureFlags, NULL::VARCHAR, NULL::VARCHAR, NULL::INT;
        RETURN;
    END IF;

    INSERT INTO public.Audit_Logs
        (TenantId, MaNV, VaiTro, NguoiDuyet, HanhDong, DoiTuong, MaDoiTuong, GiaTriMoi, LyDo, DiaChiIP)
    VALUES (
        v_t.TenantId,
        v_nv.MaNV,
        1,
        COALESCE(p_admin_username, 'superadmin'),
        'PLATFORM_IMPERSONATION_STARTED',
        'TENANT',
        v_t.TenantId,
        jsonb_build_object(
            'impersonatedBy', COALESCE(p_admin_username, 'superadmin'),
            'asStaff', v_nv.MaNV,
            'expiresAt', p_expires_at
        ),
        COALESCE(NULLIF(p_ly_do, ''), 'Ho tro ky thuat truc tiep theo yeu cau chu quan'),
        p_ip
    );

    RETURN QUERY SELECT
        'OK'::TEXT,
        v_t.TenantId::VARCHAR,
        v_t.MaTienTo::VARCHAR,
        v_t.TenQuan::VARCHAR,
        v_t.GoiCuoc::VARCHAR,
        v_t.TrangThai::VARCHAR,
        v_t.TrialEndsAt,
        v_t.SubscriptionEndsAt,
        v_t.FeatureFlags,
        v_nv.MaNV::VARCHAR,
        v_nv.TenNV::VARCHAR,
        v_nv.VaiTro::INT;
END;
$$;

-- 6. Khóa quyền tối thiểu: REVOKE PUBLIC, chỉ GRANT EXECUTE cho app_runtime & current_user
DO $$
DECLARE
    fn_sig TEXT;
    fn_list TEXT[] := ARRAY[
        'public.fn_platform_overview_tenants()',
        'public.fn_platform_overview_billing()',
        'public.fn_platform_list_tenants(integer)',
        'public.fn_platform_list_billing_orders(text, integer)',
        'public.fn_platform_manual_approve_billing(text, text, text, jsonb, text, text)',
        'public.fn_platform_impersonate_prepare(text, text, text, timestamp with time zone, text)'
    ];
BEGIN
    FOREACH fn_sig IN ARRAY fn_list LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn_sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn_sig, current_user);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_runtime', fn_sig);
        END IF;
    END LOOP;
END $$;

COMMIT;
