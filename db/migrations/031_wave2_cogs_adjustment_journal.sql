-- =============================================================================
-- MIGRATION 031 (WAVE 2 — P0-05):
--   Tạo bảng sổ điều chỉnh giá vốn public.cogs_adjustment_journal
--   phục vụ Safe WAC khi bù tồn âm & hồi tố đảo phiếu nhập (replay WAC).
--   Bật ENABLE + FORCE ROW LEVEL SECURITY và GRANT tối thiểu cho app_runtime.
-- Expand-and-Contract & Idempotent 100%.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.cogs_adjustment_journal (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         VARCHAR(64) NOT NULL,
    branch_id         VARCHAR(64) NOT NULL,
    business_date     DATE NOT NULL,
    ma_nl             VARCHAR(64) NOT NULL,
    source_type       VARCHAR(32) NOT NULL CHECK (
        source_type IN ('NEGATIVE_STOCK_CATCHUP', 'RECEIPT_REVERSAL_REPLAY', 'MANUAL_AUDIT')
    ),
    ref_ma_giao_dich  VARCHAR(64),
    qty_affected      NUMERIC(15,3) NOT NULL DEFAULT 0,
    old_unit_cost     NUMERIC(15,4) NOT NULL DEFAULT 0,
    new_unit_cost     NUMERIC(15,4) NOT NULL DEFAULT 0,
    adjustment_amount NUMERIC(15,2) NOT NULL,
    created_by        VARCHAR(64) NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cogs_adjustment_journal_tenant_branch_date
    ON public.cogs_adjustment_journal (tenant_id, branch_id, business_date);

ALTER TABLE public.cogs_adjustment_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cogs_adjustment_journal FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_cogs_adjustment_journal ON public.cogs_adjustment_journal;
CREATE POLICY tenant_isolation_cogs_adjustment_journal ON public.cogs_adjustment_journal
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT ON public.cogs_adjustment_journal TO app_runtime;
        GRANT USAGE, SELECT ON SEQUENCE public.cogs_adjustment_journal_id_seq TO app_runtime;
    END IF;
END $$;

COMMIT;
