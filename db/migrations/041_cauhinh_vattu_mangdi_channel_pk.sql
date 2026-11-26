-- =============================================================================
-- Migration 041: Nâng cấp khóa chính cauhinh_vattu_mangdi theo Kênh bán (kenhdung)
-- Mục đích:
--   - Cho phép 1 tenant cấu hình định mức bao bì khác nhau theo từng kênh bán
--     (ALL / MANG_DI / GIAO_HANG / APP_SAN / TAI_QUAN) trên cùng (kichthuoc, manl).
--   - Chuẩn hóa giá trị cũ 'APP' -> 'APP_SAN'.
--   - An toàn chạy lặp lại nhiều lần (Idempotent 100%).
-- =============================================================================

ALTER TABLE public.cauhinh_vattu_mangdi
    ADD COLUMN IF NOT EXISTS kenhdung VARCHAR(24) NOT NULL DEFAULT 'ALL';

UPDATE public.cauhinh_vattu_mangdi
   SET kenhdung = CASE
       WHEN kenhdung IS NULL OR BTRIM(kenhdung) = '' THEN 'ALL'
       WHEN UPPER(BTRIM(kenhdung)) = 'APP' THEN 'APP_SAN'
       ELSE UPPER(BTRIM(kenhdung))
   END;

ALTER TABLE public.cauhinh_vattu_mangdi
    ALTER COLUMN kenhdung SET DEFAULT 'ALL',
    ALTER COLUMN kenhdung SET NOT NULL;

DO $$
DECLARE
    pk_name TEXT;
    pk_cols TEXT[];
BEGIN
    SELECT con.conname,
           ARRAY(
               SELECT att.attname::text
                 FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute att
                   ON att.attrelid = con.conrelid AND att.attnum = k.attnum
                ORDER BY k.ord
           )
      INTO pk_name, pk_cols
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND rel.relname = 'cauhinh_vattu_mangdi'
       AND con.contype = 'p'
     LIMIT 1;

    IF pk_cols IS DISTINCT FROM ARRAY['tenantid', 'kenhdung', 'kichthuoc', 'manl'] THEN
        IF pk_name IS NOT NULL THEN
            EXECUTE format('ALTER TABLE public.cauhinh_vattu_mangdi DROP CONSTRAINT %I', pk_name);
        END IF;
        ALTER TABLE public.cauhinh_vattu_mangdi
            ADD CONSTRAINT cauhinh_vattu_mangdi_pkey PRIMARY KEY (tenantid, kenhdung, kichthuoc, manl);
    END IF;
END $$;
