-- =============================================================================
-- MIGRATION 037 (WAVE 4A — P3-01):
--   Tip Pool (quỹ tip + phân bổ theo giờ/trọng số lệch 0đ),
--   Tăng ca OT chuẩn Bộ luật Lao động VN (150% / 200% / 300% + phụ cấp ca đêm).
--   Bật ENABLE + FORCE ROW LEVEL SECURITY & GRANT tối thiểu cho app_runtime.
--   Idempotent 100% & tương thích Supabase production.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Quỹ Tip theo ca / ngày (Tip Pool Entries)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tip_pool_entries (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         VARCHAR(64) NOT NULL,
    branch_id         VARCHAR(64),
    business_date     DATE NOT NULL,
    shift_code        VARCHAR(32),
    source            VARCHAR(24) NOT NULL
                      CHECK (source IN ('CASH_JAR', 'CARD_TIP', 'VIETQR_TIP')),
    total_amount      NUMERIC(15, 2) NOT NULL CHECK (total_amount >= 0),
    allocation_method VARCHAR(24) NOT NULL DEFAULT 'BY_HOURS'
                      CHECK (allocation_method IN ('BY_HOURS', 'BY_ROLE_WEIGHT', 'EQUAL')),
    status            VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN', 'DISTRIBUTED')),
    note              TEXT,
    created_by        VARCHAR(64),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tip_pool_entries_tenant_date
    ON public.tip_pool_entries (tenant_id, business_date DESC, status);

-- -----------------------------------------------------------------------------
-- 2. Chi tiết phân bổ Tip cho từng nhân viên (Tip Pool Distributions)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tip_pool_distributions (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         VARCHAR(64) NOT NULL,
    tip_pool_id       BIGINT NOT NULL REFERENCES public.tip_pool_entries(id) ON DELETE CASCADE,
    ma_nv             VARCHAR(64) NOT NULL,
    hours_worked      NUMERIC(8, 2) NOT NULL DEFAULT 0,
    weight            NUMERIC(6, 2) NOT NULL DEFAULT 1,
    allocated_amount  NUMERIC(15, 2) NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tip_pool_id, ma_nv)
);

CREATE INDEX IF NOT EXISTS idx_tip_pool_distributions_tenant_nv
    ON public.tip_pool_distributions (tenant_id, ma_nv);

-- -----------------------------------------------------------------------------
-- 3. Nhật ký tăng ca OT 150% / 200% / 300% + Phụ cấp làm đêm
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_ot_logs (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         VARCHAR(64) NOT NULL,
    branch_id         VARCHAR(64),
    ma_nv             VARCHAR(64) NOT NULL,
    work_date         DATE NOT NULL,
    day_type          VARCHAR(16) NOT NULL CHECK (day_type IN ('WEEKDAY', 'WEEKEND', 'HOLIDAY')),
    ot_hours          NUMERIC(6, 2) NOT NULL CHECK (ot_hours >= 0),
    night_hours       NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (night_hours >= 0),
    base_hourly_rate  NUMERIC(15, 2) NOT NULL CHECK (base_hourly_rate >= 0),
    ot_multiplier     NUMERIC(4, 2) NOT NULL,
    ot_pay            NUMERIC(15, 2) NOT NULL,
    night_allowance   NUMERIC(15, 2) NOT NULL DEFAULT 0,
    approved_by       VARCHAR(64),
    note              TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payroll_ot_logs_tenant_nv_date
    ON public.payroll_ot_logs (tenant_id, ma_nv, work_date DESC);

-- -----------------------------------------------------------------------------
-- 4. Bật ENABLE + FORCE RLS & cấp quyền tối thiểu cho app_runtime
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    tbl TEXT;
    hr_tables TEXT[] := ARRAY[
        'tip_pool_entries',
        'tip_pool_distributions',
        'payroll_ot_logs'
    ];
BEGIN
    FOREACH tbl IN ARRAY hr_tables LOOP
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

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        FOREACH tbl IN ARRAY hr_tables LOOP
            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO app_runtime', tbl);
        END LOOP;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
    END IF;
END $$;

COMMIT;
