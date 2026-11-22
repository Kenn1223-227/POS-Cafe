-- =============================================================================
-- Migration 017: Phân hệ 4 (Inventory, BOM, Sub-Recipes & Historical WAC COGS)
-- 1. Snapshot TenToppingSnapshot & GiaVonToppingSnapshot trên ChiTietHoaDon_Topping.
-- 2. Backfill GiaVonDonVi lịch sử vào ChiTietGiaoDichKho.DonGiaNhap cho các phiếu
--    tiêu hao / hoàn kho / xuất hủy cũ đang có DonGiaNhap = 0.
-- 3. Bổ sung Bán thành phẩm / Sơ chế theo mẻ (Sub-Recipe / Batch Production):
--    - Cột NguyenLieu.LaBanThanhPham, SanLuongMeMacDinh, HanSuDungGio
--    - Bảng BanThanhPham_CongThuc (TenantId, MaNLThanhPham, MaNLThanhPhan, KhoiLuongTieuHao)
--      bật Fail-Closed RLS (app.current_tenant_id) & cấp quyền cho app_runtime.
-- 4. Bổ sung cột NguyenLieu.IsKeyItem phục vụ Kiểm kho nhanh 60 giây cuối ca
--    (Quick Blind Stocktake cho nhóm mặt hàng nhạy cảm thất thoát cao).
-- =============================================================================

BEGIN;

-- 1. Snapshot tên & giá vốn Topping trên ChiTietHoaDon_Topping
ALTER TABLE public.chitiethoadon_topping
    ADD COLUMN IF NOT EXISTS tentoppingsnapshot VARCHAR(120),
    ADD COLUMN IF NOT EXISTS giavontoppingsnapshot NUMERIC(15, 2) NOT NULL DEFAULT 0;

UPDATE public.chitiethoadon_topping ctp
   SET tentoppingsnapshot = tp.tentopping
  FROM public.topping tp
 WHERE tp.matopping = ctp.matopping
   AND ctp.tentoppingsnapshot IS NULL;

-- 2. Mở rộng bảng NguyenLieu cho Bán thành phẩm (Sub-Recipe) & Kiểm kho nhanh 60s (IsKeyItem)
ALTER TABLE public.nguyenlieu
    ADD COLUMN IF NOT EXISTS labanthanhpham BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS sanluongmemacdinh NUMERIC(15, 3) NOT NULL DEFAULT 1000,
    ADD COLUMN IF NOT EXISTS hansudunggio INT,
    ADD COLUMN IF NOT EXISTS iskeyitem BOOLEAN NOT NULL DEFAULT FALSE;

-- Tự động đánh dấu nhóm mặt hàng nhạy cảm thất thoát cao (Key Items) để sẵn sàng kiểm kê 60s cuối ca
UPDATE public.nguyenlieu
   SET iskeyitem = TRUE
 WHERE iskeyitem = FALSE
   AND COALESCE(tennl, '') ILIKE ANY (ARRAY[
       '%cà phê%', '%cafe%', '%arabica%', '%robusta%',
       '%sữa tươi%', '%sữa đặc%', '%whipping%', '%kem béo%',
       '%trân châu%', '%cốt trà%', '%matcha%', '%ly%'
   ]);

-- 3. Backfill giá vốn lịch sử cho các dòng ChiTietGiaoDichKho trước đây bị ghi DonGiaNhap = 0
UPDATE public.chitietgiaodichkho ct
   SET dongianhap = COALESCE(nl.giavondonvi, 0)
  FROM public.nguyenlieu nl
 WHERE nl.manl = ct.manl
   AND COALESCE(ct.dongianhap, 0) = 0
   AND COALESCE(nl.giavondonvi, 0) > 0;

-- 4. Bảng Công thức Cấp 2 — Bán thành phẩm / Sơ chế theo mẻ (Sub-Recipe / Batch Prep)
CREATE TABLE IF NOT EXISTS public.banthanhpham_congthuc (
    tenantid          VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    manlthanhpham     VARCHAR(64) NOT NULL REFERENCES public.nguyenlieu(manl) ON DELETE CASCADE,
    manlthanhphan     VARCHAR(64) NOT NULL REFERENCES public.nguyenlieu(manl) ON DELETE CASCADE,
    khoiluongtieuhao  NUMERIC(15, 3) NOT NULL CHECK (khoiluongtieuhao > 0),
    PRIMARY KEY (tenantid, manlthanhpham, manlthanhphan),
    CHECK (manlthanhpham <> manlthanhphan)
);

CREATE INDEX IF NOT EXISTS idx_btp_congthuc_tenant
    ON public.banthanhpham_congthuc (tenantid, manlthanhpham);

ALTER TABLE public.banthanhpham_congthuc ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banthanhpham_congthuc FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_btp_congthuc ON public.banthanhpham_congthuc;
CREATE POLICY tenant_isolation_btp_congthuc
    ON public.banthanhpham_congthuc
    FOR ALL
    USING (tenantid = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (tenantid = NULLIF(current_setting('app.current_tenant_id', true), ''));

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.banthanhpham_congthuc TO app_runtime;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.banthanhpham_congthuc TO service_role;
    END IF;
END $$;

COMMIT;
