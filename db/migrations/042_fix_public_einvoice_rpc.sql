-- =============================================================================
-- MIGRATION 042 (V3 HOTFIX P0-8):
--   Vá RPC Public Self-Service E-Invoice `public.fn_public_request_einvoice`:
--   1) Bắt buộc kiểm tra HoaDon.TrangThaiTT = 1 (chỉ đơn đã thanh toán xong mới
--      được yêu cầu xuất HĐĐT; đơn chưa trả/đã hủy/đã hoàn toàn phần bị từ chối).
--   2) Đọc `provider` thực tế từ cấu hình tenant (`tenants.einvoice_provider`
--      hoặc `tenants.featureflags->>'einvoice_provider'`) thay vì hardcode 'MOCK'.
--   Idempotent 100%.
-- =============================================================================

BEGIN;

ALTER TABLE IF EXISTS public.tenants
    ADD COLUMN IF NOT EXISTS einvoice_provider VARCHAR(24);

CREATE OR REPLACE FUNCTION public.fn_public_request_einvoice(
    p_lookup_code        TEXT,
    p_buyer_tax_code     TEXT,
    p_buyer_company_name TEXT,
    p_buyer_address      TEXT DEFAULT NULL,
    p_buyer_email        TEXT DEFAULT NULL
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
    v_provider  VARCHAR(24);
BEGIN
    IF v_code = '' THEN
        RAISE EXCEPTION 'Thiếu mã tra cứu hóa đơn (lookup_code)';
    END IF;
    IF v_company = '' AND v_tax_code = '' THEN
        RAISE EXCEPTION 'Cần cung cấp tối thiểu tên đơn vị hoặc mã số thuế người mua';
    END IF;

    SELECT h.tenantid,
           COALESCE(
               NULLIF(to_jsonb(h)->>'branchid', ''),
               NULLIF(to_jsonb(h)->>'machinhanh', ''),
               NULLIF(to_jsonb(h)->>'branch_id', ''),
               'CN01'
           ) AS branch_id,
           h.mahoadon,
           COALESCE((to_jsonb(h)->>'trangthaitt')::int, 0) AS trangthaitt,
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

    IF v_order.trangthaitt <> 1 THEN
        RAISE EXCEPTION 'Hóa đơn % chưa hoàn tất thanh toán (TrangThaiTT = %), không thể yêu cầu xuất hóa đơn điện tử',
            v_order.mahoadon, v_order.trangthaitt;
    END IF;

    SELECT UPPER(COALESCE(
               NULLIF(TRIM(to_jsonb(t)->>'einvoice_provider'), ''),
               NULLIF(TRIM(to_jsonb(t)->'featureflags'->>'einvoice_provider'), ''),
               NULLIF(TRIM(current_setting('app.einvoice_provider', true)), ''),
               'MOCK'
           ))
      INTO v_provider
      FROM public.tenants t
     WHERE t.tenantid = v_order.tenantid
     LIMIT 1;

    IF v_provider IS NULL OR v_provider NOT IN ('MISA', 'VIETTEL', 'VNPT', 'BKAV', 'FPT', 'MOCK') THEN
        v_provider := 'MOCK';
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
           SET provider = v_provider,
               buyer_tax_code = NULLIF(v_tax_code, ''),
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

    v_total  := ROUND(COALESCE(v_order.tong_tien, 0)::NUMERIC, 2);
    v_tax    := ROUND(COALESCE(v_order.thuevat, 0)::NUMERIC, 2);
    v_before := GREATEST(0, v_total - v_tax);

    INSERT INTO public.einvoices (
        tenant_id, branch_id, ma_hoa_don, lookup_code, provider, invoice_type,
        buyer_tax_code, buyer_company_name, buyer_address, buyer_email,
        tax_breakdown_json, total_before_tax, total_tax, total_amount,
        status, next_retry_at
    ) VALUES (
        v_order.tenantid, v_order.branch_id, v_order.mahoadon, v_code, v_provider, 'ORIGINAL',
        NULLIF(v_tax_code, ''), NULLIF(v_company, ''), v_address, v_email,
        v_order.tax_breakdown_json, v_before, v_tax, v_total,
        'QUEUED', now()
    )
    ON CONFLICT (lookup_code) DO UPDATE
        SET provider = EXCLUDED.provider,
            buyer_tax_code = EXCLUDED.buyer_tax_code,
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

REVOKE ALL ON FUNCTION public.fn_public_request_einvoice(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT EXECUTE ON FUNCTION public.fn_public_request_einvoice(TEXT, TEXT, TEXT, TEXT, TEXT) TO app_runtime;
    END IF;
END $$;

COMMIT;
