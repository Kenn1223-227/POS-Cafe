-- =============================================================================
-- MIGRATION 033 (WAVE 3A — P1-03):
--   Cô lập trạng thái Tạm hết hàng (86'ing) theo từng Chi nhánh:
--   public.branch_availability_86 (tenant_id, branch_id, entity_type, entity_id).
--   Bật ENABLE + FORCE ROW LEVEL SECURITY & GRANT tối thiểu cho app_runtime.
--   Idempotent 100%.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.branch_availability_86 (
    tenant_id             VARCHAR(64) NOT NULL,
    branch_id             VARCHAR(64) NOT NULL,
    entity_type           VARCHAR(16) NOT NULL CHECK (
        entity_type IN ('INGREDIENT', 'PRODUCT', 'TOPPING', 'MODIFIER', 'COMBO')
    ),
    entity_id             VARCHAR(64) NOT NULL,
    is_sold_out           BOOLEAN NOT NULL DEFAULT TRUE,
    is_auto_cascaded      BOOLEAN NOT NULL DEFAULT FALSE,
    caused_by_ingredients TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    daily_remaining_qty   INT CHECK (daily_remaining_qty IS NULL OR daily_remaining_qty >= 0),
    updated_by            VARCHAR(64),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, branch_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_branch_availability_86_tenant_branch_soldout
    ON public.branch_availability_86 (tenant_id, branch_id, is_sold_out);

ALTER TABLE public.branch_availability_86 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branch_availability_86 FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_branch_availability_86 ON public.branch_availability_86;
CREATE POLICY tenant_isolation_branch_availability_86 ON public.branch_availability_86
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.branch_availability_86 TO app_runtime;
    END IF;
END $$;

COMMIT;
