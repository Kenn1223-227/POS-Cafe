-- =============================================================================
-- Migration 019: Phân hệ 7 (Kiến trúc kỹ thuật, Hiệu năng, Bảo mật & Offline-First)
-- 1. [P0] Vá xung đột Overload hàm public.fn_lookup_open_invoice_by_codes:
--    - Xóa bản 1 tham số cũ từ Migration 004: fn_lookup_open_invoice_by_codes(text[])
--    - Giữ duy nhất bản 2 tham số (p_codes TEXT[], p_tenant_id TEXT DEFAULT NULL)
-- 2. [P0] Chỉ mục UNIQUE cho MaOfflineClient theo từng Tenant (chống trùng mã OFF-...)
-- 3. Phạm vi Tên đăng nhập theo Tenant (Per-Tenant Username):
--    - Gỡ ràng buộc UNIQUE toàn cục trên NhanVien(TenDangNhap)
--    - Tạo UNIQUE INDEX theo cặp (COALESCE(TenantId, 'DEFAULT'), LOWER(TenDangNhap))
--    - Chuẩn hóa fn_username_exists(p_username TEXT, p_tenant_id TEXT DEFAULT NULL)
--    - Chuẩn hóa fn_lookup_login_user(p_username TEXT, p_tenant_slug TEXT DEFAULT NULL)
-- 4. Bảng Refresh_Tokens (Refresh Token Rotation + Reuse Detection + Fast Store Device Session)
--    kèm FORCE ROW LEVEL SECURITY Fail-Closed & các hàm SECURITY DEFINER phạm vi hẹp
-- 5. Khóa quyền tối thiểu (REVOKE ALL FROM PUBLIC + GRANT EXECUTE cho app_runtime/service_role)
-- An toàn chạy lặp lại nhiều lần (Idempotent).
-- =============================================================================

BEGIN;

-- ============================================================================
-- 1. [P0] VÁ XUNG ĐỘT OVERLOAD fn_lookup_open_invoice_by_codes
-- ============================================================================
DROP FUNCTION IF EXISTS public.fn_lookup_open_invoice_by_codes(text[]);

CREATE OR REPLACE FUNCTION public.fn_lookup_open_invoice_by_codes(
    p_codes TEXT[],
    p_tenant_id TEXT DEFAULT NULL
)
RETURNS TABLE (
    MaHoaDon TEXT,
    TenantId VARCHAR
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT hd.MaHoaDon::text AS MaHoaDon,
           COALESCE(hd.TenantId, 'DEFAULT')::varchar AS TenantId
      FROM public.HoaDon hd
     WHERE hd.TrangThaiTT = 0
       AND (p_tenant_id IS NULL OR COALESCE(hd.TenantId, 'DEFAULT') = p_tenant_id)
       AND (
           UPPER(hd.MaHoaDon::text) = ANY(p_codes)
           OR REGEXP_REPLACE(UPPER(hd.MaHoaDon::text), '[^A-Z0-9]', '', 'g') = ANY(p_codes)
       )
     ORDER BY hd.ThoiGianTao DESC
     LIMIT 1;
$$;

-- ============================================================================
-- 2. [P0] ĐẢM BẢO MAOFFLINECLIENT DUY NHẤT TRONG TỪNG TENANT
-- ============================================================================
ALTER TABLE IF EXISTS public.hoadon
    ADD COLUMN IF NOT EXISTS maofflineclient VARCHAR(64);

-- Nếu dữ liệu cũ lỡ có MaOfflineClient trùng (do bug OFF-HHMMSS trước đây), nối thêm hậu tố MaHoaDon trước khi dựng UNIQUE INDEX
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'hoadon') THEN
        WITH dups AS (
            SELECT ctid, mahoadon, maofflineclient,
                   ROW_NUMBER() OVER (
                       PARTITION BY COALESCE(tenantid, 'DEFAULT'), maofflineclient
                       ORDER BY thoigiantao ASC, mahoadon ASC
                   ) AS rn
              FROM public.hoadon
             WHERE maofflineclient IS NOT NULL
        )
        UPDATE public.hoadon h
           SET maofflineclient = LEFT(d.maofflineclient || '-' || d.mahoadon::text, 64)
          FROM dups d
         WHERE h.ctid = d.ctid
           AND d.rn > 1;
    END IF;
END $$;

DROP INDEX IF EXISTS public.idx_hoadon_offline_client;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hoadon_tenant_offline_client
    ON public.hoadon (COALESCE(tenantid, 'DEFAULT'), maofflineclient)
    WHERE maofflineclient IS NOT NULL;

-- ============================================================================
-- 3. PER-TENANT USERNAME SCOPING (Quán A và Quán B đều tạo được "thungan1")
-- ============================================================================
DO $$
DECLARE
    con_rec RECORD;
    idx_rec RECORD;
BEGIN
    -- Gỡ mọi ràng buộc UNIQUE chỉ gồm 1 cột tendangnhap trên bảng public.nhanvien
    FOR con_rec IN
        SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND t.relname = 'nhanvien'
           AND c.contype = 'u'
           AND array_length(c.conkey, 1) = 1
           AND EXISTS (
               SELECT 1
                 FROM pg_attribute a
                WHERE a.attrelid = t.oid
                  AND a.attnum = c.conkey[1]
                  AND a.attname = 'tendangnhap'
           )
    LOOP
        EXECUTE format('ALTER TABLE public.nhanvien DROP CONSTRAINT IF EXISTS %I', con_rec.conname);
    END LOOP;

    -- Gỡ các UNIQUE INDEX độc lập chỉ khóa trên tendangnhap (không có tenantid)
    FOR idx_rec IN
        SELECT i.relname AS idx_name
          FROM pg_index ix
          JOIN pg_class t ON t.oid = ix.indrelid
          JOIN pg_class i ON i.oid = ix.indexrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND t.relname = 'nhanvien'
           AND ix.indisunique = TRUE
           AND ix.indisprimary = FALSE
           AND pg_get_indexdef(ix.indexrelid) ~* 'tendangnhap'
           AND pg_get_indexdef(ix.indexrelid) !~* 'tenantid'
    LOOP
        EXECUTE format('DROP INDEX IF EXISTS public.%I', idx_rec.idx_name);
    END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_nhanvien_tenant_username
    ON public.nhanvien (COALESCE(tenantid, 'DEFAULT'), LOWER(tendangnhap));

-- Xóa bản 1 tham số cũ để tránh xung đột overload
DROP FUNCTION IF EXISTS public.fn_username_exists(text);

CREATE OR REPLACE FUNCTION public.fn_username_exists(
    p_username TEXT,
    p_tenant_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS(
        SELECT 1
          FROM public.NhanVien
         WHERE LOWER(TenDangNhap) = LOWER(TRIM(p_username))
           AND (p_tenant_id IS NULL OR COALESCE(TenantId, 'DEFAULT') = p_tenant_id)
    );
$$;

-- Xóa bản 1 tham số cũ của fn_lookup_login_user và nâng cấp hỗ trợ tùy chọn p_tenant_slug / Mã quán
DROP FUNCTION IF EXISTS public.fn_lookup_login_user(text);

CREATE OR REPLACE FUNCTION public.fn_lookup_login_user(
    p_username TEXT,
    p_tenant_slug TEXT DEFAULT NULL
)
RETURNS TABLE (
    MaNV VARCHAR,
    TenNV VARCHAR,
    VaiTro INT,
    MatKhauHash TEXT,
    TenantId VARCHAR,
    MaTienTo VARCHAR,
    TenQuan VARCHAR,
    TenantSlug VARCHAR,
    GoiCuoc VARCHAR,
    TrangThaiGoi VARCHAR,
    TrialEndsAt TIMESTAMPTZ,
    SubscriptionEndsAt TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT nv.MaNV::varchar,
           nv.TenNV::varchar,
           nv.VaiTro,
           nv.MatKhauHash::text,
           COALESCE(nv.TenantId, 'DEFAULT')::varchar AS TenantId,
           COALESCE(t.MaTienTo, 'DEF')::varchar AS MaTienTo,
           COALESCE(t.TenQuan, 'Quán Cà Phê POS')::varchar AS TenQuan,
           COALESCE(t.Slug, 'default-cafe')::varchar AS TenantSlug,
           COALESCE(t.GoiCuoc, 'PRO')::varchar AS GoiCuoc,
           COALESCE(t.TrangThai, 'ACTIVE')::varchar AS TrangThaiGoi,
           t.TrialEndsAt,
           t.SubscriptionEndsAt
      FROM public.NhanVien nv
      LEFT JOIN public.Tenants t ON t.TenantId = COALESCE(nv.TenantId, 'DEFAULT')
     WHERE LOWER(nv.TenDangNhap) = LOWER(TRIM(p_username))
       AND nv.TrangThaiLamViec = TRUE
       AND (
           p_tenant_slug IS NULL
           OR TRIM(p_tenant_slug) = ''
           OR LOWER(COALESCE(t.Slug, '')) = LOWER(TRIM(p_tenant_slug))
           OR UPPER(COALESCE(t.MaTienTo, '')) = UPPER(TRIM(p_tenant_slug))
           OR UPPER(COALESCE(nv.TenantId, 'DEFAULT')) = UPPER(TRIM(p_tenant_slug))
       )
     ORDER BY nv.MaNV ASC
     LIMIT 2;
$$;

-- ============================================================================
-- 4. REFRESH TOKEN ROTATION & FAST STORE DEVICE SESSION (HttpOnly Cookie)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.Refresh_Tokens (
    Id                   BIGSERIAL PRIMARY KEY,
    TokenHash            VARCHAR(128) NOT NULL UNIQUE,
    FamilyId             VARCHAR(64) NOT NULL,
    TenantId             VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    MaNV                 VARCHAR(64) NOT NULL,
    DeviceId             VARCHAR(64),
    DeviceLabel          VARCHAR(120),
    IsStoreDeviceSession BOOLEAN NOT NULL DEFAULT FALSE,
    ExpiresAt            TIMESTAMPTZ NOT NULL,
    RevokedAt            TIMESTAMPTZ,
    ReplacedByHash       VARCHAR(128),
    UserAgent            TEXT,
    IpAddress            VARCHAR(64),
    CreatedAt            TIMESTAMPTZ NOT NULL DEFAULT now(),
    LastUsedAt           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON public.Refresh_Tokens (FamilyId);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_tenant_nv ON public.Refresh_Tokens (TenantId, MaNV, RevokedAt);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON public.Refresh_Tokens (ExpiresAt);

ALTER TABLE public.Refresh_Tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.Refresh_Tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_refresh_tokens ON public.Refresh_Tokens;
CREATE POLICY tenant_isolation_refresh_tokens ON public.Refresh_Tokens
    USING (TenantId = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (TenantId = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- Tạo Refresh Token mới (SECURITY DEFINER để chạy an toàn từ /api/auth/login dưới app_runtime NOBYPASSRLS)
CREATE OR REPLACE FUNCTION public.fn_create_refresh_token(
    p_token_hash TEXT,
    p_family_id TEXT,
    p_tenant_id TEXT,
    p_ma_nv TEXT,
    p_device_id TEXT DEFAULT NULL,
    p_device_label TEXT DEFAULT NULL,
    p_is_store_device BOOLEAN DEFAULT FALSE,
    p_expires_at TIMESTAMPTZ DEFAULT (now() + interval '7 days'),
    p_user_agent TEXT DEFAULT NULL,
    p_ip_address TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id BIGINT;
BEGIN
    INSERT INTO public.Refresh_Tokens (
        TokenHash, FamilyId, TenantId, MaNV, DeviceId, DeviceLabel,
        IsStoreDeviceSession, ExpiresAt, UserAgent, IpAddress
    )
    VALUES (
        p_token_hash, p_family_id, COALESCE(NULLIF(p_tenant_id, ''), 'DEFAULT'), p_ma_nv,
        p_device_id, p_device_label, COALESCE(p_is_store_device, FALSE),
        p_expires_at, p_user_agent, p_ip_address
    )
    RETURNING Id INTO v_id;
    RETURN v_id;
END;
$$;

-- Tra cứu Refresh Token theo SHA-256 hash kèm thông tin nhân viên & Tenant (không cần biết TenantId trước)
CREATE OR REPLACE FUNCTION public.fn_lookup_refresh_token(p_token_hash TEXT)
RETURNS TABLE (
    Id BIGINT,
    TokenHash VARCHAR,
    FamilyId VARCHAR,
    TenantId VARCHAR,
    MaNV VARCHAR,
    DeviceId VARCHAR,
    DeviceLabel VARCHAR,
    IsStoreDeviceSession BOOLEAN,
    ExpiresAt TIMESTAMPTZ,
    RevokedAt TIMESTAMPTZ,
    ReplacedByHash VARCHAR,
    TenNV VARCHAR,
    VaiTro INT,
    TrangThaiLamViec BOOLEAN,
    PermissionsOverride JSONB,
    MaTienTo VARCHAR,
    TenQuan VARCHAR,
    TenantSlug VARCHAR,
    GoiCuoc VARCHAR,
    TrangThaiGoi VARCHAR,
    TrialEndsAt TIMESTAMPTZ,
    SubscriptionEndsAt TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT rt.Id,
           rt.TokenHash,
           rt.FamilyId,
           COALESCE(rt.TenantId, 'DEFAULT')::varchar AS TenantId,
           rt.MaNV,
           rt.DeviceId,
           rt.DeviceLabel,
           rt.IsStoreDeviceSession,
           rt.ExpiresAt,
           rt.RevokedAt,
           rt.ReplacedByHash,
           nv.TenNV::varchar,
           nv.VaiTro,
           COALESCE(nv.TrangThaiLamViec, FALSE) AS TrangThaiLamViec,
           COALESCE((to_jsonb(nv)->'permissionsoverride')::jsonb, '{}'::jsonb) AS PermissionsOverride,
           COALESCE(t.MaTienTo, 'DEF')::varchar AS MaTienTo,
           COALESCE(t.TenQuan, 'Quán Cà Phê POS')::varchar AS TenQuan,
           COALESCE(t.Slug, 'default-cafe')::varchar AS TenantSlug,
           COALESCE(t.GoiCuoc, 'PRO')::varchar AS GoiCuoc,
           COALESCE(t.TrangThai, 'ACTIVE')::varchar AS TrangThaiGoi,
           t.TrialEndsAt,
           t.SubscriptionEndsAt
      FROM public.Refresh_Tokens rt
      LEFT JOIN public.NhanVien nv
        ON nv.MaNV = rt.MaNV
       AND COALESCE(nv.TenantId, 'DEFAULT') = COALESCE(rt.TenantId, 'DEFAULT')
      LEFT JOIN public.Tenants t
        ON t.TenantId = COALESCE(rt.TenantId, 'DEFAULT')
     WHERE rt.TokenHash = p_token_hash
     LIMIT 1;
$$;

-- Xoay vòng Refresh Token nguyên tử (đánh dấu token cũ đã thu hồi + cấp token mới cùng FamilyId)
CREATE OR REPLACE FUNCTION public.fn_rotate_refresh_token(
    p_old_hash TEXT,
    p_new_hash TEXT,
    p_new_expires TIMESTAMPTZ,
    p_new_ma_nv TEXT DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL,
    p_ip_address TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_old RECORD;
BEGIN
    SELECT *
      INTO v_old
      FROM public.Refresh_Tokens
     WHERE TokenHash = p_old_hash
       AND RevokedAt IS NULL
       AND ExpiresAt > now()
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    UPDATE public.Refresh_Tokens
       SET RevokedAt = now(),
           ReplacedByHash = p_new_hash,
           LastUsedAt = now()
     WHERE Id = v_old.Id;

    INSERT INTO public.Refresh_Tokens (
        TokenHash, FamilyId, TenantId, MaNV, DeviceId, DeviceLabel,
        IsStoreDeviceSession, ExpiresAt, UserAgent, IpAddress
    )
    VALUES (
        p_new_hash,
        v_old.FamilyId,
        v_old.TenantId,
        COALESCE(NULLIF(p_new_ma_nv, ''), v_old.MaNV),
        v_old.DeviceId,
        v_old.DeviceLabel,
        v_old.IsStoreDeviceSession,
        p_new_expires,
        COALESCE(p_user_agent, v_old.UserAgent),
        COALESCE(p_ip_address, v_old.IpAddress)
    );

    RETURN TRUE;
END;
$$;

-- Thu hồi toàn bộ chuỗi FamilyId khi phát hiện hành vi Reuse Token (trộm cookie)
CREATE OR REPLACE FUNCTION public.fn_revoke_refresh_family(p_family_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER := 0;
BEGIN
    UPDATE public.Refresh_Tokens
       SET RevokedAt = COALESCE(RevokedAt, now())
     WHERE FamilyId = p_family_id
       AND RevokedAt IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Thu hồi 1 Refresh Token khi người dùng đăng xuất
CREATE OR REPLACE FUNCTION public.fn_revoke_refresh_token(p_token_hash TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER := 0;
BEGIN
    UPDATE public.Refresh_Tokens
       SET RevokedAt = COALESCE(RevokedAt, now())
     WHERE TokenHash = p_token_hash
       AND RevokedAt IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count > 0;
END;
$$;

-- Thu hồi toàn bộ Refresh Token của 1 nhân viên khi bị khóa tài khoản
CREATE OR REPLACE FUNCTION public.fn_revoke_staff_refresh_tokens(p_tenant_id TEXT, p_ma_nv TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER := 0;
BEGIN
    UPDATE public.Refresh_Tokens
       SET RevokedAt = COALESCE(RevokedAt, now())
     WHERE COALESCE(TenantId, 'DEFAULT') = COALESCE(NULLIF(p_tenant_id, ''), 'DEFAULT')
       AND MaNV = p_ma_nv
       AND RevokedAt IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Dọn dẹp Refresh Token đã hết hạn quá 7 ngày (chạy định kỳ an toàn dưới app_runtime)
CREATE OR REPLACE FUNCTION public.fn_cleanup_expired_refresh_tokens()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_deleted INTEGER := 0;
BEGIN
    DELETE FROM public.Refresh_Tokens
     WHERE ExpiresAt < now() - interval '7 days'
        OR (RevokedAt IS NOT NULL AND RevokedAt < now() - interval '7 days');
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

-- ============================================================================
-- 5. KHÓA QUYỀN TỐI THIỂU (LEAST PRIVILEGE) CHO APP_RUNTIME & SERVICE_ROLE
-- ============================================================================
DO $$
DECLARE
    fn_sig TEXT;
    fn_list TEXT[] := ARRAY[
        'public.fn_lookup_open_invoice_by_codes(text[], text)',
        'public.fn_username_exists(text, text)',
        'public.fn_lookup_login_user(text, text)',
        'public.fn_create_refresh_token(text, text, text, text, text, text, boolean, timestamp with time zone, text, text)',
        'public.fn_lookup_refresh_token(text)',
        'public.fn_rotate_refresh_token(text, text, timestamp with time zone, text, text, text)',
        'public.fn_revoke_refresh_family(text)',
        'public.fn_revoke_refresh_token(text)',
        'public.fn_revoke_staff_refresh_tokens(text, text)',
        'public.fn_cleanup_expired_refresh_tokens()'
    ];
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.Refresh_Tokens TO app_runtime';
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
