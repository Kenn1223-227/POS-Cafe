-- =============================================================================
-- MIGRATION 028 (WAVE 1 — P0-07):
--   Chặn chấm công trùng ca (UNIQUE INDEX uq_chamcong_single_per_phanca)
--   & Hỗ trợ phát hiện MISSED_CLOCK_OUT (quá 2h sau giờ kết thúc ca).
-- Expand-and-Contract & Idempotent 100%.
-- =============================================================================

BEGIN;

-- 1. Làm sạch bản ghi trùng MaPhanCa (nếu có từ dữ liệu cũ), giữ bản ghi sớm nhất
DELETE FROM public.chamcong c
 USING (
     SELECT machamcong,
            ROW_NUMBER() OVER (PARTITION BY maphanca ORDER BY machamcong ASC) AS rn
       FROM public.chamcong
      WHERE maphanca IS NOT NULL
 ) dup
 WHERE c.machamcong = dup.machamcong
   AND dup.rn > 1;

-- 2. Unique Index đảm bảo mỗi phân ca chỉ có tối đa 1 dòng chấm công (chống race condition)
CREATE UNIQUE INDEX IF NOT EXISTS uq_chamcong_single_per_phanca
    ON public.chamcong (maphanca)
    WHERE maphanca IS NOT NULL;

-- 3. Cột trạng thái chấm công & cờ MISSED_CLOCK_OUT
ALTER TABLE public.chamcong
    ADD COLUMN IF NOT EXISTS trangthai_chamcong VARCHAR(32) NOT NULL DEFAULT 'NORMAL',
    ADD COLUMN IF NOT EXISTS auto_flagged_at    TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_chamcong_trangthai'
           AND conrelid = 'public.chamcong'::regclass
    ) THEN
        ALTER TABLE public.chamcong
            ADD CONSTRAINT chk_chamcong_trangthai CHECK (
                trangthai_chamcong IN ('NORMAL', 'MISSED_CLOCK_OUT', 'MANUAL_ADJUSTED')
            );
    END IF;
END $$;

COMMIT;
