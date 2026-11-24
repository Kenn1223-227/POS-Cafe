-- =============================================================================
-- MIGRATION 035 (WAVE 4A — P2-02):
--   Tài chính Chuỗi, Công nợ B2B (House Accounts & Ledger),
--   VietQR Payment Attempt TTL 5 phút, Bàn giao Ca 2 PIN (Dual-PIN Shift Handover),
--   Đối soát sàn giao đồ ăn (Aggregator Settlements) & Công nợ phải trả NCC (Supplier AP).
--   Bật ENABLE + FORCE ROW LEVEL SECURITY & GRANT tối thiểu cho app_runtime.
--   Idempotent 100% & tương thích Supabase production.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Tài khoản công nợ B2B / Khách quen (House Accounts)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.house_accounts (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         VARCHAR(64) NOT NULL,
    branch_id         VARCHAR(64),
    account_code      VARCHAR(64) NOT NULL,
    company_name      VARCHAR(200) NOT NULL,
    tax_code          VARCHAR(64),
    contact_phone     VARCHAR(32),
    credit_limit      NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
    current_balance   NUMERIC(15, 2) NOT NULL DEFAULT 0,
    payment_term_days INT NOT NULL DEFAULT 30 CHECK (payment_term_days >= 0),
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, account_code)
);

CREATE INDEX IF NOT EXISTS idx_house_accounts_tenant_active
    ON public.house_accounts (tenant_id, is_active, company_name);

-- -----------------------------------------------------------------------------
-- 2. Sổ cái công nợ B2B bất biến (House Account Ledger)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.house_account_ledger (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         VARCHAR(64) NOT NULL,
    house_account_id  BIGINT NOT NULL REFERENCES public.house_accounts(id) ON DELETE RESTRICT,
    entry_type        VARCHAR(24) NOT NULL CHECK (entry_type IN ('CHARGE', 'REPAYMENT', 'ADJUSTMENT')),
    ma_hoa_don        VARCHAR(64),
    amount            NUMERIC(15, 2) NOT NULL,
    balance_after     NUMERIC(15, 2) NOT NULL,
    note              TEXT,
    created_by        VARCHAR(64),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_house_account_ledger_tenant_acct_time
    ON public.house_account_ledger (tenant_id, house_account_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 3. VietQR Payment Attempts (TTL 5 phút + tối đa 1 attempt ACTIVE / hóa đơn)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vietqr_payment_attempts (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         VARCHAR(64) NOT NULL,
    branch_id         VARCHAR(64),
    ma_hoa_don        VARCHAR(64) NOT NULL,
    transfer_code     VARCHAR(64) NOT NULL UNIQUE,
    amount            NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
    status            VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE', 'PAID', 'EXPIRED', 'SUPERSEDED')),
    expires_at        TIMESTAMPTZ NOT NULL,
    paid_at           TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vietqr_attempts_single_active
    ON public.vietqr_payment_attempts (tenant_id, ma_hoa_don)
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_vietqr_attempts_tenant_status_exp
    ON public.vietqr_payment_attempts (tenant_id, status, expires_at);

-- -----------------------------------------------------------------------------
-- 4. Bàn giao ca 2 PIN (Dual-PIN Shift Handovers)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shift_handovers (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         VARCHAR(64) NOT NULL,
    branch_id         VARCHAR(64),
    ma_ca_thu_ngan    BIGINT NOT NULL,
    outgoing_staff_id VARCHAR(64) NOT NULL,
    incoming_staff_id VARCHAR(64) NOT NULL,
    expected_cash     NUMERIC(15, 2) NOT NULL DEFAULT 0,
    counted_cash      NUMERIC(15, 2) NOT NULL DEFAULT 0,
    variance_amount   NUMERIC(15, 2) NOT NULL DEFAULT 0,
    note              TEXT,
    handed_over_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (outgoing_staff_id <> incoming_staff_id)
);

CREATE INDEX IF NOT EXISTS idx_shift_handovers_tenant_ca_time
    ON public.shift_handovers (tenant_id, ma_ca_thu_ngan, handed_over_at DESC);

-- -----------------------------------------------------------------------------
-- 5. Đối soát sàn giao đồ ăn (Aggregator Settlements)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.aggregator_settlements (
    id                  BIGSERIAL PRIMARY KEY,
    tenant_id           VARCHAR(64) NOT NULL,
    branch_id           VARCHAR(64),
    platform            VARCHAR(24) NOT NULL
                        CHECK (platform IN ('GRABFOOD', 'SHOPEEFOOD', 'BEFOOD', 'XANHSM')),
    period_from         DATE NOT NULL,
    period_to           DATE NOT NULL,
    gross_sales         NUMERIC(15, 2) NOT NULL DEFAULT 0,
    commission_rate_pct NUMERIC(6, 2) NOT NULL DEFAULT 0,
    commission_fee      NUMERIC(15, 2) NOT NULL DEFAULT 0,
    promo_subsidy       NUMERIC(15, 2) NOT NULL DEFAULT 0,
    net_expected        NUMERIC(15, 2) NOT NULL DEFAULT 0,
    net_received        NUMERIC(15, 2) NOT NULL DEFAULT 0,
    variance_amount     NUMERIC(15, 2) NOT NULL DEFAULT 0,
    status              VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT', 'RECONCILED', 'DISPUTED')),
    note                TEXT,
    created_by          VARCHAR(64),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aggregator_settlements_tenant_period
    ON public.aggregator_settlements (tenant_id, platform, period_from DESC);

-- -----------------------------------------------------------------------------
-- 6. Công nợ phải trả nhà cung cấp (Supplier AP Invoices & Payments)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.supplier_ap_invoices (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         VARCHAR(64) NOT NULL,
    branch_id         VARCHAR(64),
    invoice_no        VARCHAR(64) NOT NULL,
    supplier_name     VARCHAR(200) NOT NULL,
    total_amount      NUMERIC(15, 2) NOT NULL CHECK (total_amount >= 0),
    paid_amount       NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
    due_date          DATE,
    status            VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN', 'PARTIAL', 'PAID', 'OVERDUE')),
    note              TEXT,
    created_by        VARCHAR(64),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, invoice_no)
);

CREATE INDEX IF NOT EXISTS idx_supplier_ap_invoices_tenant_status_due
    ON public.supplier_ap_invoices (tenant_id, status, due_date);

CREATE TABLE IF NOT EXISTS public.supplier_ap_payments (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         VARCHAR(64) NOT NULL,
    ap_invoice_id     BIGINT NOT NULL REFERENCES public.supplier_ap_invoices(id) ON DELETE CASCADE,
    amount            NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
    payment_method    VARCHAR(32) NOT NULL DEFAULT 'BANK_TRANSFER',
    reference_no      VARCHAR(64),
    note              TEXT,
    paid_by           VARCHAR(64),
    paid_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supplier_ap_payments_tenant_invoice
    ON public.supplier_ap_payments (tenant_id, ap_invoice_id, paid_at DESC);

-- -----------------------------------------------------------------------------
-- 7. Bật ENABLE + FORCE RLS & cấp quyền tối thiểu cho app_runtime (NOBYPASSRLS)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    tbl TEXT;
    wave4a_tables TEXT[] := ARRAY[
        'house_accounts',
        'house_account_ledger',
        'vietqr_payment_attempts',
        'shift_handovers',
        'aggregator_settlements',
        'supplier_ap_invoices',
        'supplier_ap_payments'
    ];
BEGIN
    FOREACH tbl IN ARRAY wave4a_tables LOOP
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
        FOREACH tbl IN ARRAY wave4a_tables LOOP
            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO app_runtime', tbl);
        END LOOP;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
    END IF;
END $$;

COMMIT;
