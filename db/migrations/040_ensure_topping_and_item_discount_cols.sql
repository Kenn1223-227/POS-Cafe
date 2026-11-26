-- =============================================================================
-- Migration 040: Đảm bảo cột nền Topping.GiaTopping và ChiTietHoaDon.GiaGiam
-- Mục đích:
--   - Đồng bộ DB Staging/Production cũ chưa chạy lại db/schema_base.sql bản mới.
--   - An toàn chạy lặp lại nhiều lần (Idempotent 100%).
--   - Backfill an toàn Topping.GiaTopping từ Topping.GiaThem khi cột GiaThem tồn tại
--     và có giá trị > 0 (chỉ ghi khi GiaTopping IS NULL OR GiaTopping = 0) để không
--     làm lệch giá topping trên DB hiện hữu.
-- =============================================================================

-- 1. Bổ sung cột Topping.GiaTopping khớp db/schema_base.sql (NUMERIC(15, 2) NOT NULL DEFAULT 0)
ALTER TABLE public.Topping
    ADD COLUMN IF NOT EXISTS GiaTopping NUMERIC(15, 2) NOT NULL DEFAULT 0;

-- Backfill an toàn từ GiaThem nếu cột GiaThem tồn tại trên bảng public.topping
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'topping'
           AND column_name = 'giathem'
    ) THEN
        UPDATE public.Topping
           SET GiaTopping = GiaThem
         WHERE (GiaTopping IS NULL OR GiaTopping = 0)
           AND GiaThem IS NOT NULL
           AND GiaThem > 0;
    END IF;
END $$;

UPDATE public.Topping
   SET GiaTopping = 0
 WHERE GiaTopping IS NULL;

ALTER TABLE public.Topping
    ALTER COLUMN GiaTopping SET DEFAULT 0,
    ALTER COLUMN GiaTopping SET NOT NULL;

-- 2. Bổ sung cột ChiTietHoaDon.GiaGiam khớp db/schema_base.sql (NUMERIC(15, 2) NOT NULL DEFAULT 0)
ALTER TABLE public.ChiTietHoaDon
    ADD COLUMN IF NOT EXISTS GiaGiam NUMERIC(15, 2) NOT NULL DEFAULT 0;

UPDATE public.ChiTietHoaDon
   SET GiaGiam = 0
 WHERE GiaGiam IS NULL;

ALTER TABLE public.ChiTietHoaDon
    ALTER COLUMN GiaGiam SET DEFAULT 0,
    ALTER COLUMN GiaGiam SET NOT NULL;
