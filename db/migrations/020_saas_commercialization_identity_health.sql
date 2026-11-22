-- =============================================================================
-- Migration 019: Phân hệ 9 — Thương mại hóa B2B SaaS, Tách định danh đăng nhập,
--                Gói FREE Vĩnh viễn, Viral PLG Referral & Tenant Health Telemetry
-- An toàn chạy lặp lại nhiều lần (Idempotent) & tương thích app_runtime NOBYPASSRLS.
-- =============================================================================

BEGIN;

-- 1. Mở rộng bảng NhanVien hỗ trợ định danh Email / SĐT toàn hệ thống + LastLoginAt
ALTER TABLE public.nhanvien
    ADD COLUMN IF NOT EXISTS email VARCHAR(160),
    ADD COLUMN IF NOT EXISTS sodienthoai VARCHAR(24),
    ADD COLUMN IF NOT EXISTS lastloginat TIMESTAMPTZ;

-- 2. Mở rộng bảng Tenants phục vụ Health Score / Churn Radar & PLG Referral
ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS lastloginat TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS offlinefailedcount INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS offlinetotalsynccount INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS offlinetelemetryat TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ownercontact VARCHAR(160),
    ADD COLUMN IF NOT EXISTS referredby VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_tenants_referred_by
    ON public.tenants (referredby)
    WHERE referredby IS NOT NULL;

-- 3. Gỡ bỏ ràng buộc UNIQUE toàn hệ thống trên NhanVien(TenDangNhap) và thay bằng UNIQUE theo từng Tenant
--    (Cho phép nhiều quán cùng có nhân viên "thungan", "barista", "admin" mà không xung đột khi scale 1.000+ quán)
DO $$
DECLARE
    con_rec RECORD;
    idx_rec RECORD;
BEGIN
    -- 3a. Gỡ mọi UNIQUE constraint chỉ chứa cột tendangnhap
    FOR con_rec IN
        SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class rel ON rel.oid = c.conrelid
          JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
         WHERE nsp.nspname = 'public'
           AND rel.relname = 'nhanvien'
           AND c.contype = 'u'
           AND (
               SELECT array_agg(a.attname::text ORDER BY a.attname)
                 FROM unnest(c.conkey) AS k(attnum)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
           ) = ARRAY['tendangnhap']
    LOOP
        EXECUTE format('ALTER TABLE public.nhanvien DROP CONSTRAINT IF EXISTS %I', con_rec.conname);
    END LOOP;

    -- 3b. Gỡ mọi UNIQUE index độc lập chỉ lập chỉ mục trên tendangnhap (không có tenantid)
    FOR idx_rec IN
        SELECT indexname
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'nhanvien'
           AND indexname <> 'ux_nhanvien_tenant_username'
           AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
           AND indexdef ILIKE '%tendangnhap%'
           AND indexdef NOT ILIKE '%tenantid%'
    LOOP
        EXECUTE format('DROP INDEX IF EXISTS public.%I', idx_rec.indexname);
    END LOOP;
END $$;

-- Unique username theo từng quán (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS ux_nhanvien_tenant_username
    ON public.nhanvien (COALESCE(tenantid, 'DEFAULT'), LOWER(tendangnhap));

-- Email và SĐT của chủ quán / nhân viên là duy nhất toàn hệ thống (nếu có nhập)
CREATE UNIQUE INDEX IF NOT EXISTS ux_nhanvien_email_unique
    ON public.nhanvien (LOWER(TRIM(email)))
    WHERE email IS NOT NULL AND TRIM(email) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS ux_nhanvien_phone_unique
    ON public.nhanvien (REGEXP_REPLACE(sodienthoai, '[^0-9]', '', 'g'))
    WHERE sodienthoai IS NOT NULL AND REGEXP_REPLACE(sodienthoai, '[^0-9]', '', 'g') <> '';

-- 4. Bảng ghi nhận nhu cầu mở rộng (Combo Phần cứng Cắm-là-Chạy / Zalo ZNS Credits / Fintech Soundbox)
CREATE TABLE IF NOT EXISTS public.tenant_expansion_requests (
    id              BIGSERIAL PRIMARY KEY,
    tenantid        VARCHAR(64) NOT NULL REFERENCES public.tenants(tenantid) ON DELETE CASCADE,
    manv            VARCHAR(64),
    loaidichvu      VARCHAR(48) NOT NULL, -- 'HARDWARE_BUNDLE' | 'ZALO_ZNS_CREDITS' | 'FINTECH_SOUNDBOX'
    goiquantam      VARCHAR(120) NOT NULL,
    soluong         INT NOT NULL DEFAULT 1,
    lienhe          VARCHAR(160),
    ghichu          TEXT,
    trangthai       VARCHAR(24) NOT NULL DEFAULT 'NEW', -- 'NEW' | 'CONTACTED' | 'CLOSED'
    thoigiantao     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expansion_requests_tenant
    ON public.tenant_expansion_requests (tenantid, thoigiantao DESC);

ALTER TABLE public.tenant_expansion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_expansion_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON public.tenant_expansion_requests;
CREATE POLICY tenant_isolation_policy ON public.tenant_expansion_requests
    USING (tenantid = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (tenantid = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- 5. Các hàm SECURITY DEFINER phạm vi hẹp hỗ trợ Tách Định Danh & Login Activity dưới Fail-Closed RLS

-- 5a. Tra cứu thông tin công khai của quán theo slug / mã tiền tố / tenantId cho đường dẫn /login?shop=...
CREATE OR REPLACE FUNCTION public.fn_lookup_tenant_public(p_shop TEXT)
RETURNS TABLE (
    TenantId  VARCHAR,
    MaTienTo  VARCHAR,
    TenQuan   VARCHAR,
    Slug      VARCHAR,
    GoiCuoc   VARCHAR,
    TrangThai VARCHAR
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT t.TenantId::varchar,
           COALESCE(t.MaTienTo, 'DEF')::varchar AS MaTienTo,
           t.TenQuan::varchar,
           COALESCE(t.Slug, LOWER(t.TenantId))::varchar AS Slug,
           COALESCE(t.GoiCuoc, 'PRO')::varchar AS GoiCuoc,
           COALESCE(t.TrangThai, 'ACTIVE')::varchar AS TrangThai
      FROM public.Tenants t
     WHERE LOWER(COALESCE(t.Slug, '')) = LOWER(TRIM(COALESCE(p_shop, '')))
        OR UPPER(COALESCE(t.MaTienTo, '')) = UPPER(TRIM(COALESCE(p_shop, '')))
        OR UPPER(t.TenantId) = UPPER(TRIM(COALESCE(p_shop, '')))
     LIMIT 1;
$$;

-- 5b. Định tuyến đăng nhập V2:
--     - Có p_shop: tìm nhân viên đúng trong quán đó (theo username / email / SĐT)
--     - Không có p_shop: ưu tiên Email / SĐT duy nhất toàn hệ thống, fallback username (trả tối đa 5 dòng để backend nhận biết trùng username giữa nhiều quán)
CREATE OR REPLACE FUNCTION public.fn_lookup_login_user_v2(
    p_identifier TEXT,
    p_shop       TEXT DEFAULT NULL
)
RETURNS TABLE (
    MaNV               VARCHAR,
    TenNV              VARCHAR,
    VaiTro             INT,
    MatKhauHash        TEXT,
    Email              VARCHAR,
    SoDienThoai        VARCHAR,
    TenantId           VARCHAR,
    MaTienTo           VARCHAR,
    TenQuan            VARCHAR,
    Slug               VARCHAR,
    GoiCuoc            VARCHAR,
    TrangThaiGoi       VARCHAR,
    TrialEndsAt        TIMESTAMPTZ,
    SubscriptionEndsAt TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id      TEXT := TRIM(COALESCE(p_identifier, ''));
    v_id_low  TEXT := LOWER(TRIM(COALESCE(p_identifier, '')));
    v_phone   TEXT := REGEXP_REPLACE(COALESCE(p_identifier, ''), '[^0-9]', '', 'g');
    v_shop    TEXT := TRIM(COALESCE(p_shop, ''));
    v_tid     VARCHAR;
BEGIN
    IF v_id = '' THEN
        RETURN;
    END IF;

    -- Nhánh 1: Nhân viên / Chủ quán truyền kèm Mã quán hoặc mở link /login?shop=<slug>
    IF v_shop <> '' THEN
        SELECT t.TenantId INTO v_tid
          FROM public.Tenants t
         WHERE LOWER(COALESCE(t.Slug, '')) = LOWER(v_shop)
            OR UPPER(COALESCE(t.MaTienTo, '')) = UPPER(v_shop)
            OR UPPER(t.TenantId) = UPPER(v_shop)
         LIMIT 1;

        IF v_tid IS NULL THEN
            RETURN;
        END IF;

        RETURN QUERY
        SELECT nv.MaNV::varchar, nv.TenNV::varchar, nv.VaiTro, nv.MatKhauHash::text,
               nv.Email::varchar, nv.SoDienThoai::varchar,
               COALESCE(nv.TenantId, 'DEFAULT')::varchar AS TenantId,
               COALESCE(t.MaTienTo, 'DEF')::varchar AS MaTienTo,
               COALESCE(t.TenQuan, 'Quán Cà Phê POS')::varchar AS TenQuan,
               COALESCE(t.Slug, 'default-cafe')::varchar AS Slug,
               COALESCE(t.GoiCuoc, 'PRO')::varchar AS GoiCuoc,
               COALESCE(t.TrangThai, 'ACTIVE')::varchar AS TrangThaiGoi,
               t.TrialEndsAt,
               t.SubscriptionEndsAt
          FROM public.NhanVien nv
          LEFT JOIN public.Tenants t ON t.TenantId = COALESCE(nv.TenantId, 'DEFAULT')
         WHERE COALESCE(nv.TenantId, 'DEFAULT') = v_tid
           AND nv.TrangThaiLamViec = TRUE
           AND (
               LOWER(nv.TenDangNhap) = v_id_low
               OR (nv.Email IS NOT NULL AND LOWER(TRIM(nv.Email)) = v_id_low)
               OR (LENGTH(v_phone) >= 8 AND nv.SoDienThoai IS NOT NULL AND REGEXP_REPLACE(nv.SoDienThoai, '[^0-9]', '', 'g') = v_phone)
           )
         LIMIT 2;
        RETURN;
    END IF;

    -- Nhánh 2: Không truyền Mã quán — ưu tiên định danh Email (chứa @) duy nhất toàn hệ thống
    IF POSITION('@' IN v_id_low) > 1 THEN
        RETURN QUERY
        SELECT nv.MaNV::varchar, nv.TenNV::varchar, nv.VaiTro, nv.MatKhauHash::text,
               nv.Email::varchar, nv.SoDienThoai::varchar,
               COALESCE(nv.TenantId, 'DEFAULT')::varchar AS TenantId,
               COALESCE(t.MaTienTo, 'DEF')::varchar AS MaTienTo,
               COALESCE(t.TenQuan, 'Quán Cà Phê POS')::varchar AS TenQuan,
               COALESCE(t.Slug, 'default-cafe')::varchar AS Slug,
               COALESCE(t.GoiCuoc, 'PRO')::varchar AS GoiCuoc,
               COALESCE(t.TrangThai, 'ACTIVE')::varchar AS TrangThaiGoi,
               t.TrialEndsAt,
               t.SubscriptionEndsAt
          FROM public.NhanVien nv
          LEFT JOIN public.Tenants t ON t.TenantId = COALESCE(nv.TenantId, 'DEFAULT')
         WHERE nv.TrangThaiLamViec = TRUE
           AND nv.Email IS NOT NULL
           AND LOWER(TRIM(nv.Email)) = v_id_low
         LIMIT 2;
        RETURN;
    END IF;

    -- Nhánh 3: Không truyền Mã quán — ưu tiên định danh Số điện thoại (chỉ gồm số/dấu cách/+/- và >= 9 chữ số)
    IF v_id ~ '^[0-9+\s().-]{9,20}$' AND LENGTH(v_phone) >= 9 THEN
        RETURN QUERY
        SELECT nv.MaNV::varchar, nv.TenNV::varchar, nv.VaiTro, nv.MatKhauHash::text,
               nv.Email::varchar, nv.SoDienThoai::varchar,
               COALESCE(nv.TenantId, 'DEFAULT')::varchar AS TenantId,
               COALESCE(t.MaTienTo, 'DEF')::varchar AS MaTienTo,
               COALESCE(t.TenQuan, 'Quán Cà Phê POS')::varchar AS TenQuan,
               COALESCE(t.Slug, 'default-cafe')::varchar AS Slug,
               COALESCE(t.GoiCuoc, 'PRO')::varchar AS GoiCuoc,
               COALESCE(t.TrangThai, 'ACTIVE')::varchar AS TrangThaiGoi,
               t.TrialEndsAt,
               t.SubscriptionEndsAt
          FROM public.NhanVien nv
          LEFT JOIN public.Tenants t ON t.TenantId = COALESCE(nv.TenantId, 'DEFAULT')
         WHERE nv.TrangThaiLamViec = TRUE
           AND nv.SoDienThoai IS NOT NULL
           AND REGEXP_REPLACE(nv.SoDienThoai, '[^0-9]', '', 'g') = v_phone
         LIMIT 2;
        IF FOUND THEN
            RETURN;
        END IF;
    END IF;

    -- Nhánh 4: Fallback TenDangNhap (tương thích ngược tuyệt đối; nếu >1 quán cùng username -> backend trả 409 SHOP_CODE_REQUIRED)
    RETURN QUERY
    SELECT nv.MaNV::varchar, nv.TenNV::varchar, nv.VaiTro, nv.MatKhauHash::text,
           nv.Email::varchar, nv.SoDienThoai::varchar,
           COALESCE(nv.TenantId, 'DEFAULT')::varchar AS TenantId,
           COALESCE(t.MaTienTo, 'DEF')::varchar AS MaTienTo,
           COALESCE(t.TenQuan, 'Quán Cà Phê POS')::varchar AS TenQuan,
           COALESCE(t.Slug, 'default-cafe')::varchar AS Slug,
           COALESCE(t.GoiCuoc, 'PRO')::varchar AS GoiCuoc,
           COALESCE(t.TrangThai, 'ACTIVE')::varchar AS TrangThaiGoi,
           t.TrialEndsAt,
           t.SubscriptionEndsAt
      FROM public.NhanVien nv
      LEFT JOIN public.Tenants t ON t.TenantId = COALESCE(nv.TenantId, 'DEFAULT')
     WHERE nv.TrangThaiLamViec = TRUE
       AND LOWER(nv.TenDangNhap) = v_id_low
     LIMIT 5;
END;
$$;

-- 5c. Kiểm tra trùng username TRONG PHẠM VI 1 QUÁN (Tenant-scoped)
CREATE OR REPLACE FUNCTION public.fn_tenant_username_exists(p_tenant_id TEXT, p_username TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.NhanVien
         WHERE COALESCE(TenantId, 'DEFAULT') = COALESCE(NULLIF(TRIM(p_tenant_id), ''), 'DEFAULT')
           AND LOWER(TenDangNhap) = LOWER(TRIM(COALESCE(p_username, '')))
    );
$$;

-- 5d. Kiểm tra trùng Email hoặc Số điện thoại toàn hệ thống (dùng cho Đăng ký quán & Tạo nhân viên)
CREATE OR REPLACE FUNCTION public.fn_contact_exists(p_email TEXT DEFAULT NULL, p_phone TEXT DEFAULT NULL)
RETURNS TABLE (email_exists BOOLEAN, phone_exists BOOLEAN)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        CASE
            WHEN NULLIF(TRIM(COALESCE(p_email, '')), '') IS NULL THEN FALSE
            ELSE EXISTS (
                SELECT 1 FROM public.NhanVien
                 WHERE Email IS NOT NULL AND LOWER(TRIM(Email)) = LOWER(TRIM(p_email))
            )
        END AS email_exists,
        CASE
            WHEN LENGTH(REGEXP_REPLACE(COALESCE(p_phone, ''), '[^0-9]', '', 'g')) < 8 THEN FALSE
            ELSE EXISTS (
                SELECT 1 FROM public.NhanVien
                 WHERE SoDienThoai IS NOT NULL
                   AND REGEXP_REPLACE(SoDienThoai, '[^0-9]', '', 'g') = REGEXP_REPLACE(p_phone, '[^0-9]', '', 'g')
            )
        END AS phone_exists;
$$;

-- 5e. Cập nhật LastLoginAt cho Nhân viên & Tenant phục vụ Tenant Health Score / Churn Radar
CREATE OR REPLACE FUNCTION public.fn_touch_login_activity(p_manv TEXT, p_tenant_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.NhanVien
       SET LastLoginAt = now()
     WHERE MaNV = p_manv;

    UPDATE public.Tenants
       SET LastLoginAt = now()
     WHERE TenantId = COALESCE(NULLIF(TRIM(p_tenant_id), ''), 'DEFAULT');
END;
$$;

-- 6. Cấp quyền tối thiểu (Least Privilege) cho app_runtime (NOBYPASSRLS)
DO $$
DECLARE
    fn_sig TEXT;
    fn_list TEXT[] := ARRAY[
        'public.fn_lookup_tenant_public(text)',
        'public.fn_lookup_login_user_v2(text, text)',
        'public.fn_tenant_username_exists(text, text)',
        'public.fn_contact_exists(text, text)',
        'public.fn_touch_login_activity(text, text)'
    ];
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_expansion_requests TO app_runtime';
        EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime';
    END IF;

    FOREACH fn_sig IN ARRAY fn_list LOOP
        IF to_regprocedure(fn_sig) IS NOT NULL THEN
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn_sig);
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn_sig, current_user);
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_runtime', fn_sig);
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn_sig);
            END IF;
        END IF;
    END LOOP;
END $$;

COMMIT;
