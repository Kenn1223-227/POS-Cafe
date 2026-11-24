-- =============================================================================
-- MIGRATION 036 (WAVE 4A — P2-03):
--   Price Books đa kênh (DINE_IN / TAKEAWAY / GRABFOOD / SHOPEEFOOD / BEFOOD / VIP),
--   Zalo ZNS Outbox Worker thật (tuân thủ NĐ 13/2023, tương thích ngược bảng 021),
--   và Bida Time-Billing Sessions (tách khung giờ cao điểm + pause + block làm tròn).
--   Bật ENABLE + FORCE ROW LEVEL SECURITY & GRANT tối thiểu cho app_runtime.
--   Idempotent 100% & tương thích Supabase production.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Bảng giá đa kênh (Price Books & Price Book Items)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.price_books (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       VARCHAR(64) NOT NULL,
    branch_id       VARCHAR(64),
    code            VARCHAR(64) NOT NULL,
    name            VARCHAR(160) NOT NULL,
    channel         VARCHAR(24) NOT NULL
                    CHECK (channel IN ('DINE_IN', 'TAKEAWAY', 'GRABFOOD', 'SHOPEEFOOD', 'BEFOOD', 'VIP')),
    priority        INT NOT NULL DEFAULT 10,
    effective_from  TIMESTAMPTZ,
    effective_to    TIMESTAMPTZ,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_price_books_tenant_channel_active
    ON public.price_books (tenant_id, channel, is_active, priority DESC);

CREATE TABLE IF NOT EXISTS public.price_book_items (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       VARCHAR(64) NOT NULL,
    price_book_id   BIGINT NOT NULL REFERENCES public.price_books(id) ON DELETE CASCADE,
    ma_sp           VARCHAR(64) NOT NULL,
    override_price  NUMERIC(15, 2) NOT NULL CHECK (override_price >= 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (price_book_id, ma_sp)
);

CREATE INDEX IF NOT EXISTS idx_price_book_items_tenant_sp
    ON public.price_book_items (tenant_id, ma_sp);

-- -----------------------------------------------------------------------------
-- 2. Mở rộng public.zalo_zns_outbox (Expand-and-Contract từ Migration 021)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.zalo_zns_outbox (
    id              BIGSERIAL PRIMARY KEY,
    tenantid        VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    makh            VARCHAR(50),
    sodienthoai     VARCHAR(32) NOT NULL DEFAULT '',
    loaitin         VARCHAR(32) NOT NULL DEFAULT 'ZNS_RECEIPT',
    noidung         JSONB NOT NULL DEFAULT '{}'::jsonb,
    trangthai       VARCHAR(24) NOT NULL DEFAULT 'QUEUED',
    thoigiantao     TIMESTAMPTZ NOT NULL DEFAULT now(),
    thoigiangui     TIMESTAMPTZ
);

ALTER TABLE public.zalo_zns_outbox
    ALTER COLUMN sodienthoai SET DEFAULT '',
    ALTER COLUMN loaitin SET DEFAULT 'ZNS_RECEIPT';

ALTER TABLE public.zalo_zns_outbox
    ADD COLUMN IF NOT EXISTS tenant_id       VARCHAR(64),
    ADD COLUMN IF NOT EXISTS ma_kh           VARCHAR(64),
    ADD COLUMN IF NOT EXISTS phone           VARCHAR(32),
    ADD COLUMN IF NOT EXISTS template_id     VARCHAR(64),
    ADD COLUMN IF NOT EXISTS template_data   JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS purpose         VARCHAR(48) NOT NULL DEFAULT 'ZNS_RECEIPT',
    ADD COLUMN IF NOT EXISTS status          VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
    ADD COLUMN IF NOT EXISTS retry_count     INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_retry_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS provider_msg_id TEXT,
    ADD COLUMN IF NOT EXISTS last_error      TEXT,
    ADD COLUMN IF NOT EXISTS sent_at         TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill an toàn dữ liệu cũ nếu có
UPDATE public.zalo_zns_outbox
   SET tenant_id     = COALESCE(NULLIF(tenant_id, ''), tenantid, 'DEFAULT'),
       ma_kh         = COALESCE(ma_kh, makh),
       phone         = COALESCE(NULLIF(phone, ''), sodienthoai),
       template_data = CASE WHEN template_data = '{}'::jsonb AND noidung <> '{}'::jsonb THEN noidung ELSE template_data END,
       status        = CASE
                         WHEN status IN ('QUEUED', 'SENT', 'SKIPPED_NO_CONSENT', 'FAILED') THEN status
                         WHEN trangthai IN ('QUEUED', 'SENT', 'SKIPPED_NO_CONSENT', 'FAILED') THEN trangthai
                         ELSE 'QUEUED'
                       END,
       sent_at       = COALESCE(sent_at, thoigiangui),
       created_at    = COALESCE(created_at, thoigiantao, now())
 WHERE tenant_id IS NULL OR phone IS NULL;

ALTER TABLE public.zalo_zns_outbox
    DROP CONSTRAINT IF EXISTS chk_zalo_zns_outbox_status;

ALTER TABLE public.zalo_zns_outbox
    ADD CONSTRAINT chk_zalo_zns_outbox_status
    CHECK (status IN ('QUEUED', 'SENT', 'SKIPPED_NO_CONSENT', 'FAILED'));

-- Trigger đồng bộ 2 chiều giữa cột Wave 4A và cột cũ Migration 021 để không gãy API cũ
CREATE OR REPLACE FUNCTION public.fn_sync_zalo_zns_outbox_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.tenant_id := COALESCE(NULLIF(NEW.tenant_id, ''), NULLIF(NEW.tenantid, ''), 'DEFAULT');
    NEW.tenantid  := NEW.tenant_id;

    NEW.ma_kh := COALESCE(NEW.ma_kh, NEW.makh);
    NEW.makh  := NEW.ma_kh;

    NEW.phone       := COALESCE(NULLIF(NEW.phone, ''), NULLIF(NEW.sodienthoai, ''), '');
    NEW.sodienthoai := NEW.phone;

    IF NEW.template_data IS NULL THEN
        NEW.template_data := COALESCE(NEW.noidung, '{}'::jsonb);
    END IF;
    IF NEW.noidung IS NULL OR NEW.noidung = '{}'::jsonb THEN
        NEW.noidung := NEW.template_data;
    END IF;

    IF NEW.status IS NULL OR NEW.status = '' THEN
        NEW.status := COALESCE(NULLIF(NEW.trangthai, ''), 'QUEUED');
    END IF;
    NEW.trangthai := NEW.status;

    NEW.loaitin := COALESCE(NULLIF(NEW.loaitin, ''), NULLIF(NEW.purpose, ''), 'ZNS_RECEIPT');
    NEW.purpose := COALESCE(NULLIF(NEW.purpose, ''), 'ZNS_RECEIPT');

    NEW.sent_at     := COALESCE(NEW.sent_at, NEW.thoigiangui);
    NEW.thoigiangui := NEW.sent_at;

    NEW.created_at  := COALESCE(NEW.created_at, NEW.thoigiantao, now());
    NEW.thoigiantao := NEW.created_at;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_zalo_zns_outbox_columns ON public.zalo_zns_outbox;
CREATE TRIGGER trg_sync_zalo_zns_outbox_columns
    BEFORE INSERT OR UPDATE ON public.zalo_zns_outbox
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_sync_zalo_zns_outbox_columns();

CREATE INDEX IF NOT EXISTS idx_zalo_zns_outbox_worker_queue
    ON public.zalo_zns_outbox (tenant_id, status, next_retry_at, created_at);

-- -----------------------------------------------------------------------------
-- 3. Phiên tính giờ Bida chuẩn hóa (public.bida_sessions)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bida_sessions (
    id                    BIGSERIAL PRIMARY KEY,
    tenant_id             VARCHAR(64) NOT NULL,
    branch_id             VARCHAR(64),
    ma_ban                VARCHAR(64) NOT NULL,
    ma_hoa_don            VARCHAR(64),
    hourly_rate           NUMERIC(15, 2) NOT NULL CHECK (hourly_rate >= 0),
    peak_hourly_rate      NUMERIC(15, 2) CHECK (peak_hourly_rate IS NULL OR peak_hourly_rate >= 0),
    peak_start_hour       INT DEFAULT 18 CHECK (peak_start_hour BETWEEN 0 AND 23),
    peak_end_hour         INT DEFAULT 23 CHECK (peak_end_hour BETWEEN 0 AND 23),
    billing_block_minutes INT NOT NULL DEFAULT 15
                          CHECK (billing_block_minutes IN (1, 5, 10, 15, 30, 60)),
    started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    paused_at             TIMESTAMPTZ,
    total_paused_seconds  INT NOT NULL DEFAULT 0 CHECK (total_paused_seconds >= 0),
    ended_at              TIMESTAMPTZ,
    computed_amount       NUMERIC(15, 2) NOT NULL DEFAULT 0,
    status                VARCHAR(16) NOT NULL DEFAULT 'RUNNING'
                          CHECK (status IN ('RUNNING', 'PAUSED', 'CLOSED')),
    created_by            VARCHAR(64),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bida_sessions_tenant_ban_status
    ON public.bida_sessions (tenant_id, ma_ban, status);

-- -----------------------------------------------------------------------------
-- 4. Bật ENABLE + FORCE RLS & cấp quyền tối thiểu cho app_runtime
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    tbl TEXT;
    new_tables TEXT[] := ARRAY['price_books', 'price_book_items', 'bida_sessions'];
BEGIN
    FOREACH tbl IN ARRAY new_tables LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON public.%I', tbl, tbl);
        EXECUTE format(
            'CREATE POLICY tenant_isolation_%I ON public.%I
                USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), ''''))
                WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), ''''))',
            tbl, tbl
        );
    END LOOP;

    -- Đảm bảo RLS trên zalo_zns_outbox luôn khớp cả tenant_id và tenantid
    ALTER TABLE public.zalo_zns_outbox ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.zalo_zns_outbox FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_policy ON public.zalo_zns_outbox;
    DROP POLICY IF EXISTS tenant_isolation_zalo_zns_outbox ON public.zalo_zns_outbox;
    CREATE POLICY tenant_isolation_zalo_zns_outbox ON public.zalo_zns_outbox
        USING (COALESCE(NULLIF(tenant_id, ''), tenantid) = NULLIF(current_setting('app.current_tenant_id', true), ''))
        WITH CHECK (COALESCE(NULLIF(tenant_id, ''), tenantid) = NULLIF(current_setting('app.current_tenant_id', true), ''));

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.price_books TO app_runtime;
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.price_book_items TO app_runtime;
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.bida_sessions TO app_runtime;
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.zalo_zns_outbox TO app_runtime;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
    END IF;
END $$;

COMMIT;
