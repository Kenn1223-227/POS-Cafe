-- =============================================================================
-- MIGRATION 034 (WAVE 3B — P1-02, P1-04, P1-05):
--   1. P1-02: Mở rộng ChiTietHoaDon.FireStatus cho phép 'AWAITING_PAYMENT'
--             (Counter VietQR trả trước không trừ kho / không fire KDS sớm).
--   2. P1-04: Chấm công 3 lớp (Kiosk QR HMAC 30s + GPS Geofencing 50m / IP tĩnh)
--             trên public.chinhanh & public.chamcong.
--   3. P1-04: Object Storage S3/R2/Supabase/Local trên public.receipt_photo_uploads
--             (thêm storage_provider, storage_key, storage_url; cho phép dataurl NULL).
--   4. P1-05: Bảng nhật ký nhắc gia hạn idempotent public.tenant_dunning_logs
--             với FORCE RLS + GRANT tối thiểu cho app_runtime.
-- Expand-and-Contract & Idempotent 100%.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Mở rộng ChiTietHoaDon.FireStatus hỗ trợ 'AWAITING_PAYMENT'
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'chitiethoadon'
           AND column_name = 'firestatus'
    ) THEN
        ALTER TABLE public.chitiethoadon
            ALTER COLUMN firestatus TYPE VARCHAR(24);
    ELSE
        ALTER TABLE public.chitiethoadon
            ADD COLUMN firestatus VARCHAR(24) NOT NULL DEFAULT 'FIRED';
    END IF;
END $$;

ALTER TABLE public.chitiethoadon
    DROP CONSTRAINT IF EXISTS chk_cthd_firestatus;

ALTER TABLE public.chitiethoadon
    ADD CONSTRAINT chk_cthd_firestatus
    CHECK (firestatus IN ('HELD', 'FIRED', 'AWAITING_PAYMENT'));

-- -----------------------------------------------------------------------------
-- 2. Mở rộng public.chinhanh cho Chấm công 3 lớp (Kiosk QR + GPS + IP tĩnh)
-- -----------------------------------------------------------------------------
ALTER TABLE public.chinhanh
    ADD COLUMN IF NOT EXISTS kiosk_hmac_secret VARCHAR(128),
    ADD COLUMN IF NOT EXISTS geo_lat           DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS geo_lng           DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS geofence_radius_m INT NOT NULL DEFAULT 50,
    ADD COLUMN IF NOT EXISTS allowed_public_ips TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_chinhanh_geofence_radius'
           AND conrelid = 'public.chinhanh'::regclass
    ) THEN
        ALTER TABLE public.chinhanh
            ADD CONSTRAINT chk_chinhanh_geofence_radius
            CHECK (geofence_radius_m BETWEEN 15 AND 500);
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Mở rộng public.chamcong lưu phương thức xác thực, tọa độ & phút đi trễ
-- -----------------------------------------------------------------------------
ALTER TABLE public.chamcong
    ADD COLUMN IF NOT EXISTS verify_method VARCHAR(24) NOT NULL DEFAULT 'KIOSK_QR',
    ADD COLUMN IF NOT EXISTS checkin_lat   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS checkin_lng   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS late_minutes  INT NOT NULL DEFAULT 0;

-- -----------------------------------------------------------------------------
-- 4. Mở rộng public.receipt_photo_uploads cho Object Storage (S3/R2/Supabase/Local)
-- -----------------------------------------------------------------------------
ALTER TABLE public.receipt_photo_uploads
    ADD COLUMN IF NOT EXISTS storage_provider VARCHAR(24) NOT NULL DEFAULT 'LOCAL',
    ADD COLUMN IF NOT EXISTS storage_key      TEXT,
    ADD COLUMN IF NOT EXISTS storage_url      TEXT;

ALTER TABLE public.receipt_photo_uploads
    ALTER COLUMN dataurl DROP NOT NULL;

-- -----------------------------------------------------------------------------
-- 5. Bảng nhật ký nhắc gia hạn SaaS idempotent (D-7, D-3, D-1, EXPIRED)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_dunning_logs (
    id                   BIGSERIAL PRIMARY KEY,
    tenant_id            VARCHAR(64) NOT NULL,
    stage                VARCHAR(16) NOT NULL CHECK (stage IN ('D-7', 'D-3', 'D-1', 'EXPIRED')),
    subscription_ends_at TIMESTAMPTZ,
    sent_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, stage, subscription_ends_at)
);

CREATE INDEX IF NOT EXISTS idx_tenant_dunning_logs_tenant_sent
    ON public.tenant_dunning_logs (tenant_id, sent_at DESC);

ALTER TABLE public.tenant_dunning_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_dunning_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_tenant_dunning_logs ON public.tenant_dunning_logs;
CREATE POLICY tenant_isolation_tenant_dunning_logs ON public.tenant_dunning_logs
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- -----------------------------------------------------------------------------
-- 6. Cấp quyền tối thiểu cho app_runtime (NOBYPASSRLS)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_dunning_logs TO app_runtime;
        GRANT USAGE, SELECT ON SEQUENCE public.tenant_dunning_logs_id_seq TO app_runtime;
    END IF;
END $$;

COMMIT;
