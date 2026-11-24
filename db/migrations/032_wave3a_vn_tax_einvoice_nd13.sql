-- =============================================================================
-- MIGRATION 032 (WAVE 3A — P1-01):
--   Thuế VAT Đa Mức Việt Nam (8%/10%/5%/0%/KCT), Hóa Đơn Điện Tử Máy Tính Tiền
--   (E-Invoice MTT + Self-Service QR RPC SECURITY DEFINER) & Tuân thủ NĐ 13/2023.
--   Bảo toàn tuyệt đối FORCE ROW LEVEL SECURITY & NOBYPASSRLS cho app_runtime.
--   Idempotent 100% (Expand-and-Contract).
-- =============================================================================

BEGIN;

-- 1. Danh mục nhóm thuế VAT theo Tenant
CREATE TABLE IF NOT EXISTS public.tax_categories (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       VARCHAR(64) NOT NULL,
    code            VARCHAR(24) NOT NULL,
    name            VARCHAR(100) NOT NULL,
    vat_rate        NUMERIC(5,2) NOT NULL CHECK (vat_rate IN (0, 5, 8, 10)),
    is_kct          BOOLEAN NOT NULL DEFAULT FALSE,
    effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_to    DATE,
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (tenant_id, code, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_tax_categories_tenant_code
    ON public.tax_categories (tenant_id, code, effective_from DESC);

ALTER TABLE public.tax_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_categories FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_tax_categories ON public.tax_categories;
CREATE POLICY tenant_isolation_tax_categories ON public.tax_categories
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- 2. Mở rộng SanPham, ChiTietHoaDon, HoaDon (Expand-only)
ALTER TABLE public.sanpham
    ADD COLUMN IF NOT EXISTS tax_category_code VARCHAR(24) NOT NULL DEFAULT 'VAT_8_FB';

ALTER TABLE public.chitiethoadon
    ADD COLUMN IF NOT EXISTS tax_category_code VARCHAR(24) NOT NULL DEFAULT 'VAT_8_FB';
ALTER TABLE public.chitiethoadon
    ADD COLUMN IF NOT EXISTS tax_rate_snapshot NUMERIC(5,2) NOT NULL DEFAULT 8;
ALTER TABLE public.chitiethoadon
    ADD COLUMN IF NOT EXISTS taxable_base_amount NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE public.chitiethoadon
    ADD COLUMN IF NOT EXISTS vat_amount_snapshot NUMERIC(15,2) NOT NULL DEFAULT 0;

ALTER TABLE public.hoadon
    ADD COLUMN IF NOT EXISTS tax_breakdown_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.hoadon
    ADD COLUMN IF NOT EXISTS einvoice_lookup_code VARCHAR(32);

CREATE INDEX IF NOT EXISTS idx_hoadon_einvoice_lookup_code
    ON public.hoadon (einvoice_lookup_code)
    WHERE einvoice_lookup_code IS NOT NULL;

-- 3. Bảng quản lý phát hành & Outbox Hóa Đơn Điện Tử (MTT)
CREATE TABLE IF NOT EXISTS public.einvoices (
    id                      BIGSERIAL PRIMARY KEY,
    tenant_id               VARCHAR(64) NOT NULL,
    branch_id               VARCHAR(64),
    ma_hoa_don              VARCHAR(64) NOT NULL,
    lookup_code             VARCHAR(32) NOT NULL UNIQUE,
    provider                VARCHAR(24) NOT NULL DEFAULT 'MOCK'
                            CHECK (provider IN ('MISA', 'VIETTEL', 'VNPT', 'BKAV', 'FPT', 'MOCK')),
    invoice_type            VARCHAR(24) NOT NULL DEFAULT 'ORIGINAL'
                            CHECK (invoice_type IN ('ORIGINAL', 'ADJUSTMENT_DECREASE', 'REPLACEMENT', 'CANCELLED')),
    parent_einvoice_id      BIGINT REFERENCES public.einvoices(id),
    buyer_tax_code          VARCHAR(20),
    buyer_company_name      VARCHAR(255),
    buyer_address           TEXT,
    buyer_email             VARCHAR(150),
    tax_breakdown_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
    total_before_tax        NUMERIC(15,2) NOT NULL DEFAULT 0,
    total_tax               NUMERIC(15,2) NOT NULL DEFAULT 0,
    total_amount            NUMERIC(15,2) NOT NULL DEFAULT 0,
    invoice_series          VARCHAR(16),
    invoice_number          VARCHAR(16),
    tax_authority_code      VARCHAR(64),
    status                  VARCHAR(24) NOT NULL DEFAULT 'DRAFT'
                            CHECK (status IN ('DRAFT', 'QUEUED', 'ISSUED', 'FAILED', 'ADJUSTED', 'CANCELLED')),
    retry_count             INT NOT NULL DEFAULT 0,
    next_retry_at           TIMESTAMPTZ,
    provider_response_json  JSONB,
    last_error              TEXT,
    issued_at               TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_einvoices_original_per_order
    ON public.einvoices (tenant_id, ma_hoa_don)
    WHERE invoice_type = 'ORIGINAL' AND status <> 'CANCELLED';

CREATE INDEX IF NOT EXISTS idx_einvoices_tenant_status
    ON public.einvoices (tenant_id, status, next_retry_at);

ALTER TABLE public.einvoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.einvoices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_einvoices ON public.einvoices;
CREATE POLICY tenant_isolation_einvoices ON public.einvoices
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- 4. Hàm SECURITY DEFINER phạm vi hẹp cho Self-Service E-Invoice QR (không cần JWT)
CREATE OR REPLACE FUNCTION public.fn_public_lookup_einvoice(p_lookup_code TEXT)
RETURNS TABLE (
    einvoice_id         BIGINT,
    lookup_code         VARCHAR,
    ma_hoa_don          VARCHAR,
    tenant_name         VARCHAR,
    provider            VARCHAR,
    invoice_type        VARCHAR,
    status              VARCHAR,
    buyer_tax_code      VARCHAR,
    buyer_company_name  VARCHAR,
    buyer_address       TEXT,
    buyer_email         VARCHAR,
    tax_breakdown_json  JSONB,
    total_before_tax    NUMERIC,
    total_tax           NUMERIC,
    total_amount        NUMERIC,
    invoice_series      VARCHAR,
    invoice_number      VARCHAR,
    tax_authority_code  VARCHAR,
    issued_at           TIMESTAMPTZ,
    created_at          TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code TEXT := UPPER(TRIM(COALESCE(p_lookup_code, '')));
BEGIN
    IF v_code = '' THEN
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM public.einvoices e WHERE e.lookup_code = v_code) THEN
        RETURN QUERY
        SELECT
            e.id,
            e.lookup_code,
            e.ma_hoa_don,
            COALESCE(t.tenquan, 'POS Cafe')::VARCHAR AS tenant_name,
            e.provider,
            e.invoice_type,
            e.status,
            e.buyer_tax_code,
            e.buyer_company_name,
            e.buyer_address,
            e.buyer_email,
            e.tax_breakdown_json,
            e.total_before_tax,
            e.total_tax,
            e.total_amount,
            e.invoice_series,
            e.invoice_number,
            e.tax_authority_code,
            e.issued_at,
            e.created_at
        FROM public.einvoices e
        LEFT JOIN public.tenants t ON t.tenantid = e.tenant_id
        WHERE e.lookup_code = v_code
        LIMIT 1;
        RETURN;
    END IF;

    -- Fallback: hóa đơn đã sinh einvoice_lookup_code nhưng khách chưa gửi yêu cầu xuất HĐĐT
    RETURN QUERY
    SELECT
        NULL::BIGINT AS einvoice_id,
        h.einvoice_lookup_code AS lookup_code,
        h.mahoadon AS ma_hoa_don,
        COALESCE(t.tenquan, 'POS Cafe')::VARCHAR AS tenant_name,
        'MOCK'::VARCHAR AS provider,
        'ORIGINAL'::VARCHAR AS invoice_type,
        'DRAFT'::VARCHAR AS status,
        NULL::VARCHAR AS buyer_tax_code,
        NULL::VARCHAR AS buyer_company_name,
        NULL::TEXT AS buyer_address,
        NULL::VARCHAR AS buyer_email,
        COALESCE(NULLIF(to_jsonb(h)->'tax_breakdown_json', 'null'::jsonb), '[]'::jsonb) AS tax_breakdown_json,
        GREATEST(0,
            COALESCE(
                NULLIF(to_jsonb(h)->>'tongtienthanhtoan', '')::numeric,
                NULLIF(to_jsonb(h)->>'thanhtien', '')::numeric,
                NULLIF(to_jsonb(h)->>'tongtien', '')::numeric,
                0
            ) - COALESCE(
                NULLIF(to_jsonb(h)->>'tienthuevat', '')::numeric,
                NULLIF(to_jsonb(h)->>'thuevat', '')::numeric,
                0
            )
        )::NUMERIC AS total_before_tax,
        COALESCE(
            NULLIF(to_jsonb(h)->>'tienthuevat', '')::numeric,
            NULLIF(to_jsonb(h)->>'thuevat', '')::numeric,
            0
        )::NUMERIC AS total_tax,
        COALESCE(
            NULLIF(to_jsonb(h)->>'tongtienthanhtoan', '')::numeric,
            NULLIF(to_jsonb(h)->>'thanhtien', '')::numeric,
            NULLIF(to_jsonb(h)->>'tongtien', '')::numeric,
            0
        )::NUMERIC AS total_amount,
        NULL::VARCHAR AS invoice_series,
        NULL::VARCHAR AS invoice_number,
        NULL::VARCHAR AS tax_authority_code,
        NULL::TIMESTAMPTZ AS issued_at,
        h.thoigiantao AS created_at
    FROM public.hoadon h
    LEFT JOIN public.tenants t ON t.tenantid = h.tenantid
    WHERE h.einvoice_lookup_code = v_code
    LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_public_request_einvoice(
    p_lookup_code        TEXT,
    p_buyer_tax_code     TEXT,
    p_buyer_company_name TEXT,
    p_buyer_address      TEXT,
    p_buyer_email        TEXT
)
RETURNS TABLE (
    einvoice_id         BIGINT,
    lookup_code         VARCHAR,
    ma_hoa_don          VARCHAR,
    status              VARCHAR,
    buyer_tax_code      VARCHAR,
    buyer_company_name  VARCHAR,
    buyer_address       TEXT,
    buyer_email         VARCHAR,
    already_issued      BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code      TEXT := UPPER(TRIM(COALESCE(p_lookup_code, '')));
    v_tax_code  TEXT := TRIM(COALESCE(p_buyer_tax_code, ''));
    v_company   TEXT := TRIM(COALESCE(p_buyer_company_name, ''));
    v_address   TEXT := NULLIF(TRIM(COALESCE(p_buyer_address, '')), '');
    v_email     TEXT := NULLIF(TRIM(COALESCE(p_buyer_email, '')), '');
    v_existing  public.einvoices%ROWTYPE;
    v_order     RECORD;
    v_new_id    BIGINT;
    v_total     NUMERIC(15,2);
    v_tax       NUMERIC(15,2);
    v_before    NUMERIC(15,2);
BEGIN
    IF v_code = '' THEN
        RAISE EXCEPTION 'Thiếu mã tra cứu hóa đơn (lookup_code)';
    END IF;
    IF v_company = '' AND v_tax_code = '' THEN
        RAISE EXCEPTION 'Cần cung cấp tối thiểu tên đơn vị hoặc mã số thuế người mua';
    END IF;

    SELECT * INTO v_existing
      FROM public.einvoices e
     WHERE e.lookup_code = v_code
     FOR UPDATE;

    IF FOUND THEN
        IF v_existing.status = 'ISSUED' THEN
            UPDATE public.einvoices e_upd
               SET buyer_email = COALESCE(v_email, e_upd.buyer_email),
                   buyer_address = COALESCE(v_address, e_upd.buyer_address)
             WHERE e_upd.id = v_existing.id;

            RETURN QUERY
            SELECT v_existing.id, v_existing.lookup_code, v_existing.ma_hoa_don,
                   v_existing.status, v_existing.buyer_tax_code, v_existing.buyer_company_name,
                   COALESCE(v_address, v_existing.buyer_address),
                   COALESCE(v_email, v_existing.buyer_email)::VARCHAR,
                   TRUE;
            RETURN;
        END IF;

        UPDATE public.einvoices
           SET buyer_tax_code = NULLIF(v_tax_code, ''),
               buyer_company_name = NULLIF(v_company, ''),
               buyer_address = v_address,
               buyer_email = v_email,
               status = 'QUEUED',
               next_retry_at = now(),
               last_error = NULL
         WHERE id = v_existing.id;

        RETURN QUERY
        SELECT v_existing.id, v_existing.lookup_code, v_existing.ma_hoa_don,
               'QUEUED'::VARCHAR, NULLIF(v_tax_code, '')::VARCHAR, NULLIF(v_company, '')::VARCHAR,
               v_address, v_email::VARCHAR, FALSE;
        RETURN;
    END IF;

    SELECT h.tenantid,
           COALESCE(
               NULLIF(to_jsonb(h)->>'branchid', ''),
               NULLIF(to_jsonb(h)->>'machinhanh', ''),
               NULLIF(to_jsonb(h)->>'branch_id', ''),
               'CN01'
           ) AS branch_id,
           h.mahoadon,
           COALESCE(NULLIF(to_jsonb(h)->'tax_breakdown_json', 'null'::jsonb), '[]'::jsonb) AS tax_breakdown_json,
           COALESCE(
               NULLIF(to_jsonb(h)->>'tienthuevat', '')::numeric,
               NULLIF(to_jsonb(h)->>'thuevat', '')::numeric,
               0
           ) AS thuevat,
           COALESCE(
               NULLIF(to_jsonb(h)->>'tongtienthanhtoan', '')::numeric,
               NULLIF(to_jsonb(h)->>'thanhtien', '')::numeric,
               NULLIF(to_jsonb(h)->>'tongtien', '')::numeric,
               0
           ) AS tong_tien
      INTO v_order
      FROM public.hoadon h
     WHERE h.einvoice_lookup_code = v_code
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Không tìm thấy hóa đơn khớp mã tra cứu %', v_code;
    END IF;

    v_total  := ROUND(COALESCE(v_order.tong_tien, 0)::NUMERIC, 2);
    v_tax    := ROUND(COALESCE(v_order.thuevat, 0)::NUMERIC, 2);
    v_before := GREATEST(0, v_total - v_tax);

    INSERT INTO public.einvoices (
        tenant_id, branch_id, ma_hoa_don, lookup_code, provider, invoice_type,
        buyer_tax_code, buyer_company_name, buyer_address, buyer_email,
        tax_breakdown_json, total_before_tax, total_tax, total_amount,
        status, next_retry_at
    ) VALUES (
        v_order.tenantid, v_order.branch_id, v_order.mahoadon, v_code, 'MOCK', 'ORIGINAL',
        NULLIF(v_tax_code, ''), NULLIF(v_company, ''), v_address, v_email,
        v_order.tax_breakdown_json, v_before, v_tax, v_total,
        'QUEUED', now()
    )
    ON CONFLICT (lookup_code) DO UPDATE
        SET buyer_tax_code = EXCLUDED.buyer_tax_code,
            buyer_company_name = EXCLUDED.buyer_company_name,
            buyer_address = EXCLUDED.buyer_address,
            buyer_email = EXCLUDED.buyer_email,
            status = CASE WHEN public.einvoices.status = 'ISSUED' THEN 'ISSUED' ELSE 'QUEUED' END,
            next_retry_at = now()
    RETURNING id INTO v_new_id;

    RETURN QUERY
    SELECT e.id, e.lookup_code, e.ma_hoa_don, e.status,
           e.buyer_tax_code, e.buyer_company_name, e.buyer_address, e.buyer_email,
           (e.status = 'ISSUED')
      FROM public.einvoices e
     WHERE e.id = v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_public_lookup_einvoice(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_public_request_einvoice(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

-- 5. Tuân thủ Nghị định 13/2023/NĐ-CP: Nhật ký đồng thuận & Ẩn danh dữ liệu cá nhân
CREATE TABLE IF NOT EXISTS public.customer_consent_logs (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   VARCHAR(64) NOT NULL,
    ma_kh       VARCHAR(64) NOT NULL,
    channel     VARCHAR(24) NOT NULL CHECK (channel IN ('POS_COUNTER', 'QR_MENU', 'ZALO_MINIAPP')),
    purpose     VARCHAR(48) NOT NULL CHECK (purpose IN ('LOYALTY_POINTS', 'ZNS_RECEIPT', 'MARKETING_PROMO')),
    granted     BOOLEAN NOT NULL,
    ip_address  TEXT,
    recorded_by VARCHAR(64),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_consent_logs_tenant_kh
    ON public.customer_consent_logs (tenant_id, ma_kh, created_at DESC);

ALTER TABLE public.customer_consent_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_consent_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_customer_consent_logs ON public.customer_consent_logs;
CREATE POLICY tenant_isolation_customer_consent_logs ON public.customer_consent_logs
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

ALTER TABLE public.khachhang ADD COLUMN IF NOT EXISTS zalooptin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.khachhang ALTER COLUMN zalooptin SET DEFAULT FALSE;
ALTER TABLE public.khachhang ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
ALTER TABLE public.khachhang ADD COLUMN IF NOT EXISTS email VARCHAR(150);

-- 6. Cấp quyền tối thiểu cho app_runtime
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.tax_categories TO app_runtime;
        GRANT USAGE, SELECT ON SEQUENCE public.tax_categories_id_seq TO app_runtime;

        GRANT SELECT, INSERT, UPDATE ON public.einvoices TO app_runtime;
        GRANT USAGE, SELECT ON SEQUENCE public.einvoices_id_seq TO app_runtime;

        GRANT SELECT, INSERT ON public.customer_consent_logs TO app_runtime;
        GRANT USAGE, SELECT ON SEQUENCE public.customer_consent_logs_id_seq TO app_runtime;

        GRANT EXECUTE ON FUNCTION public.fn_public_lookup_einvoice(TEXT) TO app_runtime;
        GRANT EXECUTE ON FUNCTION public.fn_public_request_einvoice(TEXT, TEXT, TEXT, TEXT, TEXT) TO app_runtime;
    END IF;
END $$;

COMMIT;
