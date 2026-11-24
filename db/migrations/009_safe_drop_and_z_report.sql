-- ============================================================================
-- MIGRATION 009: SAFE DROP (RÚT KÉT AN TOÀN) & Z-REPORT K80 (BẢNG ĐẾM MỆNH GIÁ)
-- Mục đích:
--   1. Tách loại phiếu 3 = RUT_KET (Safe Drop - Rút tiền cất két an toàn về chủ quán)
--      khỏi loại 2 = CHI (Chi phí vận hành lặt vặt như mua đá, đường, rác...).
--      Cả hai đều trừ khỏi tiền mặt kỳ vọng tại ngăn kéo, nhưng RUT_KET KHÔNG bị
--      tính nhầm vào chi phí vận hành quán.
--   2. Bổ sung CaThuNgan.TongRutKet & CaThuNgan.ChiTietMenhGia (JSONB) để lưu
--      bảng kiểm đếm tờ tiền Blind Drop, phục vụ in & in lại phiếu chốt ca Z-Report K80.
-- An toàn chạy lặp lại nhiều lần (Idempotent).
-- ============================================================================

-- 1. Nới lỏng CHECK constraint trên PhieuThuChiLatVat.LoaiPhieu để cho phép 1 (THU), 2 (CHI), 3 (RUT_KET)
DO $$
DECLARE
    con_name text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'phieuthuchilatvat') THEN
        FOR con_name IN
            SELECT c.conname
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE n.nspname = 'public'
               AND t.relname = 'phieuthuchilatvat'
               AND c.contype = 'c'
               AND pg_get_constraintdef(c.oid) ILIKE '%loaiphieu%'
        LOOP
            EXECUTE format('ALTER TABLE public.phieuthuchilatvat DROP CONSTRAINT IF EXISTS %I', con_name);
        END LOOP;

        -- Đảm bảo LoaiPhieu có kiểu INT nếu DB cũ đang để VARCHAR
        BEGIN
            ALTER TABLE public.phieuthuchilatvat
                ALTER COLUMN LoaiPhieu TYPE INT USING (
                    CASE
                        WHEN LoaiPhieu::text IN ('1', 'THU') THEN 1
                        WHEN LoaiPhieu::text IN ('2', 'CHI') THEN 2
                        WHEN LoaiPhieu::text IN ('3', 'RUT_KET') THEN 3
                        WHEN LoaiPhieu::text IN ('4', 'THOI_CK_DU') THEN 4
                        ELSE 1
                    END
                );
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;

        ALTER TABLE public.phieuthuchilatvat
            ADD CONSTRAINT chk_phieuthuchi_loaiphieu CHECK (LoaiPhieu IN (1, 2, 3));
    END IF;
END $$;

-- 2. Lưu tách bạch Tổng Rút Két & Chi tiết mệnh giá kiểm đếm cuối ca trên CaThuNgan
ALTER TABLE IF EXISTS public.cathungan
    ADD COLUMN IF NOT EXISTS TongRutKet NUMERIC(15, 2) NOT NULL DEFAULT 0;

ALTER TABLE IF EXISTS public.cathungan
    ADD COLUMN IF NOT EXISTS ChiTietMenhGia JSONB;
