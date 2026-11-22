-- =============================================================================
-- Migration 016: Phân hệ 3 (Payment, Shift & Cash Reconciliation)
-- 1. Tách Webhook VietQR theo từng Tenant (/api/webhooks/sepay/:tenantSlug & /payos/:tenantSlug):
--    - Hàm SECURITY DEFINER fn_lookup_tenant_webhook_config(p_slug_or_id)
--    - Hàm SECURITY DEFINER fn_lookup_open_invoice_by_codes(p_codes, p_tenant_id)
-- 2. Hỗ trợ Hoàn tiền một phần từng món sau thanh toán (Partial Post-Payment Refund):
--    - Cột HoaDon.SoTienHoan & ChiTietHoaDon.DaHoanTien
-- 3. Bổ sung cột PhieuThuChiLatVat.AnhChungTuUrl (lưu ảnh chụp biên nhận/hóa đơn chi tại quầy)
-- 4. Bổ sung cột CaThuNgan.SoZReport (đánh số Z-Report tuần tự bất biến Z-0001, Z-0002...)
-- =============================================================================

BEGIN;

-- 1. Các cột mở rộng cho Hoàn tiền 1 phần, Ảnh chứng từ phiếu chi & Số thứ tự Z-Report
ALTER TABLE public.phieuthuchilatvat
    ADD COLUMN IF NOT EXISTS anhchungtuurl TEXT;

ALTER TABLE public.hoadon
    ADD COLUMN IF NOT EXISTS sotienhoan NUMERIC(15, 2) NOT NULL DEFAULT 0;

ALTER TABLE public.chitiethoadon
    ADD COLUMN IF NOT EXISTS dahoantien BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.cathungan
    ADD COLUMN IF NOT EXISTS sozreport INT;

-- 2. Hàm SECURITY DEFINER tra cứu cấu hình Ngân hàng & Khóa Webhook đã mã hóa AES-256-GCM theo tenantSlug / tenantId
CREATE OR REPLACE FUNCTION public.fn_lookup_tenant_webhook_config(p_slug_or_id TEXT)
RETURNS TABLE (
    TenantId VARCHAR,
    Slug VARCHAR,
    MaTienTo VARCHAR,
    TenQuan VARCHAR,
    ThongTinNganHang JSONB
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT t.TenantId,
           t.Slug,
           t.MaTienTo,
           t.TenQuan,
           COALESCE(t.ThongTinNganHang, '{}'::jsonb) AS ThongTinNganHang
      FROM public.Tenants t
     WHERE LOWER(COALESCE(t.Slug, '')) = LOWER(TRIM(p_slug_or_id))
        OR UPPER(t.TenantId) = UPPER(TRIM(p_slug_or_id))
        OR UPPER(COALESCE(t.MaTienTo, '')) = UPPER(TRIM(p_slug_or_id))
     LIMIT 1;
$$;

-- 3. Hàm SECURITY DEFINER tra cứu hóa đơn đang mở có lọc cứng theo p_tenant_id (chống khớp chéo hóa đơn giữa các quán)
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

-- 4. Khóa quyền tối thiểu (Least Privilege) trên 2 hàm SECURITY DEFINER mới
DO $$
DECLARE
    fn_sig TEXT;
    fn_list TEXT[] := ARRAY[
        'public.fn_lookup_tenant_webhook_config(text)',
        'public.fn_lookup_open_invoice_by_codes(text[], text)'
    ];
BEGIN
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
