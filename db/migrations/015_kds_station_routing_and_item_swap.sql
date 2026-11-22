-- =============================================================================
-- Migration 015: Phân hệ 2 (Real-Time Engine & BDS / KDS)
-- 1. Bổ sung cột TramCheBien ('BAR_CHINH' | 'BAR_LANH' | 'BEP_BANH') trên SanPham
--    phục vụ Multi-Station KDS Routing (Quầy Espresso/Bar chính, Quầy Trà/Bar lạnh, Bếp/Bánh).
-- 2. Tự động phân loại thông minh các món hiện có theo NhomMon / TenMon.
-- =============================================================================

BEGIN;

ALTER TABLE public.sanpham
    ADD COLUMN IF NOT EXISTS tramchebien VARCHAR(20) NOT NULL DEFAULT 'BAR_CHINH';

DO $$
BEGIN
    ALTER TABLE public.sanpham DROP CONSTRAINT IF EXISTS sanpham_tramchebien_check;
    ALTER TABLE public.sanpham
        ADD CONSTRAINT sanpham_tramchebien_check
        CHECK (tramchebien IN ('BAR_CHINH', 'BAR_LANH', 'BEP_BANH'));
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;

-- Tự động gán trạm pha chế phù hợp cho các món hiện có nếu đang ở mặc định BAR_CHINH
UPDATE public.sanpham
   SET tramchebien = CASE
       WHEN COALESCE(nhommon, '') ILIKE ANY (ARRAY['%bánh%', '%bếp%', '%snack%', '%ăn vặt%', '%đồ ăn%'])
         OR COALESCE(tenmon, '')  ILIKE ANY (ARRAY['%bánh%', '%croissant%', '%tiramisu%', '%toast%', '%mousse%', '%cookie%'])
       THEN 'BEP_BANH'
       WHEN COALESCE(nhommon, '') ILIKE ANY (ARRAY['%trà%', '%đá xay%', '%sinh tố%', '%nước ép%', '%freeze%', '%soda%'])
         OR COALESCE(tenmon, '')  ILIKE ANY (ARRAY['%trà%', '%đá xay%', '%sinh tố%', '%matcha%', '%freeze%', '%soda%', '%yogurt%'])
       THEN 'BAR_LANH'
       ELSE 'BAR_CHINH'
   END
 WHERE tramchebien = 'BAR_CHINH';

CREATE INDEX IF NOT EXISTS idx_sanpham_tenant_tram
    ON public.sanpham (COALESCE(tenantid, 'DEFAULT'), tramchebien);

COMMIT;
