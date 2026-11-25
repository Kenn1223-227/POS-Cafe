-- =============================================================================
-- MIGRATION 038 (WAVE 4B — P2-01):
--   Kiến trúc Scale 500 Quán:
--   1. Mở rộng tenants & chinhanh: business_day_cutoff_hour (mặc định 04:00) & timezone.
--   2. Hàm thuần PostgreSQL public.fn_compute_business_date(p_ts, p_cutoff_hour, p_tz).
--   3. Bảng tổng hợp tài chính vật hóa theo ngày kinh doanh:
--      public.daily_branch_financial_summary + composite indexes + FORCE RLS.
--   Idempotent 100% & tương thích Supabase production.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Mở rộng cấu hình Business Day Cutoff (04:00) & Timezone cho tenants / chinhanh
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF to_regclass('public.tenants') IS NOT NULL THEN
        ALTER TABLE public.tenants
            ADD COLUMN IF NOT EXISTS business_day_cutoff_hour INT NOT NULL DEFAULT 4;
        ALTER TABLE public.tenants
            ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh';

        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conname = 'chk_tenants_business_day_cutoff_hour'
               AND conrelid = 'public.tenants'::regclass
        ) THEN
            ALTER TABLE public.tenants
                ADD CONSTRAINT chk_tenants_business_day_cutoff_hour
                CHECK (business_day_cutoff_hour BETWEEN 0 AND 12);
        END IF;
    END IF;

    IF to_regclass('public.chinhanh') IS NOT NULL THEN
        ALTER TABLE public.chinhanh
            ADD COLUMN IF NOT EXISTS business_day_cutoff_hour INT NOT NULL DEFAULT 4;
        ALTER TABLE public.chinhanh
            ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh';

        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conname = 'chk_chinhanh_business_day_cutoff_hour'
               AND conrelid = 'public.chinhanh'::regclass
        ) THEN
            ALTER TABLE public.chinhanh
                ADD CONSTRAINT chk_chinhanh_business_day_cutoff_hour
                CHECK (business_day_cutoff_hour BETWEEN 0 AND 12);
        END IF;
    END IF;

    IF to_regclass('public.hoadon') IS NOT NULL THEN
        ALTER TABLE public.hoadon
            ADD COLUMN IF NOT EXISTS business_date DATE;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Hàm PostgreSQL tính Ngày Kinh Doanh (Business Date Cutoff, mặc định 04:00)
--    Ví dụ: 2026-11-25 02:15+07 với cutoff = 4 -> 2026-11-24
--           2026-11-25 04:00+07 với cutoff = 4 -> 2026-11-25
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_compute_business_date(
    p_ts          TIMESTAMPTZ,
    p_cutoff_hour INT DEFAULT 4,
    p_tz          TEXT DEFAULT 'Asia/Ho_Chi_Minh'
)
RETURNS DATE
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
    v_cutoff INT;
    v_tz     TEXT;
BEGIN
    IF p_ts IS NULL THEN
        RETURN NULL;
    END IF;
    v_cutoff := GREATEST(0, LEAST(12, COALESCE(p_cutoff_hour, 4)));
    v_tz := COALESCE(NULLIF(BTRIM(p_tz), ''), 'Asia/Ho_Chi_Minh');
    RETURN ((p_ts AT TIME ZONE v_tz) - make_interval(hours => v_cutoff))::DATE;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Bảng tổng hợp tài chính vật hóa theo ngày kinh doanh & chi nhánh
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_branch_financial_summary (
    tenant_id              VARCHAR(64) NOT NULL,
    branch_id              VARCHAR(64) NOT NULL,
    business_date          DATE NOT NULL,
    orders_count           INT NOT NULL DEFAULT 0,
    paid_orders_count      INT NOT NULL DEFAULT 0,
    voided_orders_count    INT NOT NULL DEFAULT 0,
    gross_sales            NUMERIC(15, 2) NOT NULL DEFAULT 0,
    discount_total         NUMERIC(15, 2) NOT NULL DEFAULT 0,
    net_sales              NUMERIC(15, 2) NOT NULL DEFAULT 0,
    tax_total              NUMERIC(15, 2) NOT NULL DEFAULT 0,
    service_charge_total   NUMERIC(15, 2) NOT NULL DEFAULT 0,
    cogs_total             NUMERIC(15, 2) NOT NULL DEFAULT 0,
    cogs_adjustment_total  NUMERIC(15, 2) NOT NULL DEFAULT 0,
    labor_cost_total       NUMERIC(15, 2) NOT NULL DEFAULT 0,
    gross_profit           NUMERIC(15, 2) NOT NULL DEFAULT 0,
    net_profit             NUMERIC(15, 2) NOT NULL DEFAULT 0,
    payment_breakdown_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, branch_id, business_date)
);

CREATE INDEX IF NOT EXISTS idx_dbfs_tenant_business_date
    ON public.daily_branch_financial_summary (tenant_id, business_date DESC);

CREATE INDEX IF NOT EXISTS idx_dbfs_tenant_branch_business_date
    ON public.daily_branch_financial_summary (tenant_id, branch_id, business_date DESC);

-- Index phụ trợ cho HoaDon khi tồn tại đủ cột (an toàn với mọi phiên bản DB)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'hoadon' AND column_name = 'tenantid'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'hoadon' AND column_name = 'branchid'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'hoadon' AND column_name = 'business_date'
    ) THEN
        CREATE INDEX IF NOT EXISTS idx_hoadon_tenant_branch_business_date
            ON public.hoadon (tenantid, branchid, business_date DESC);
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Bật ENABLE + FORCE ROW LEVEL SECURITY & GRANT tối thiểu cho app_runtime
-- -----------------------------------------------------------------------------
ALTER TABLE public.daily_branch_financial_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_branch_financial_summary FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_daily_branch_financial_summary
    ON public.daily_branch_financial_summary;

CREATE POLICY tenant_isolation_daily_branch_financial_summary
    ON public.daily_branch_financial_summary
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE
            ON public.daily_branch_financial_summary TO app_runtime;
        GRANT EXECUTE ON FUNCTION public.fn_compute_business_date(TIMESTAMPTZ, INT, TEXT)
            TO app_runtime;
    END IF;
END $$;

COMMIT;
