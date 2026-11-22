-- ============================================================================
-- MIGRATION 022: NỚI LỎNG CHECK CONSTRAINTS CHO HOÀN TIỀN, HỦY MÓN & HOÀN KHO
-- Mục đích:
--   1. HoaDon.TrangThaiTT: bổ sung 2 = Đã hoàn tiền toàn bộ (bên cạnh 0, 1).
--   2. ChiTietHoaDon.TrangThaiPhaChe: bổ sung 'DaHuy' (bên cạnh ChoPhaChe,
--      DangLam, DaXong, DaPhucVu) cho luồng Hủy món & Hoàn tiền sau TT.
--   3. PhieuGiaoDichKho.LoaiGD: bổ sung 7 (LOAI_GD_HOAN_KHO) và
--      8 (LOAI_GD_HAO_HUT_HUY_MON) bên cạnh 1..6.
-- An toàn chạy lặp lại nhiều lần (Idempotent).
-- ============================================================================

BEGIN;

-- 1. HoaDon.TrangThaiTT: 0 = Chưa TT, 1 = Đã TT, 2 = Đã hoàn tiền toàn bộ
DO $$
DECLARE
    con_name text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'hoadon') THEN
        FOR con_name IN
            SELECT c.conname
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE n.nspname = 'public'
               AND t.relname = 'hoadon'
               AND c.contype = 'c'
               AND pg_get_constraintdef(c.oid) ILIKE '%trangthaitt%'
        LOOP
            EXECUTE format('ALTER TABLE public.hoadon DROP CONSTRAINT IF EXISTS %I', con_name);
        END LOOP;

        ALTER TABLE public.hoadon
            ADD CONSTRAINT chk_hoadon_trangthaitt CHECK (TrangThaiTT IN (0, 1, 2));
    END IF;
END $$;

-- 2. ChiTietHoaDon.TrangThaiPhaChe: thêm 'DaHuy'
DO $$
DECLARE
    con_name text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'chitiethoadon') THEN
        FOR con_name IN
            SELECT c.conname
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE n.nspname = 'public'
               AND t.relname = 'chitiethoadon'
               AND c.contype = 'c'
               AND pg_get_constraintdef(c.oid) ILIKE '%trangthaiphache%'
        LOOP
            EXECUTE format('ALTER TABLE public.chitiethoadon DROP CONSTRAINT IF EXISTS %I', con_name);
        END LOOP;

        ALTER TABLE public.chitiethoadon
            ADD CONSTRAINT chk_chitiethoadon_trangthaiphache
            CHECK (TrangThaiPhaChe IN ('ChoPhaChe', 'DangLam', 'DaXong', 'DaPhucVu', 'DaHuy'));
    END IF;
END $$;

-- 3. PhieuGiaoDichKho.LoaiGD: thêm 7 = Hoàn kho (hủy/đổi/hoàn món), 8 = Hao hụt hủy/hoàn món đã pha
DO $$
DECLARE
    con_name text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'phieugiaodichkho') THEN
        FOR con_name IN
            SELECT c.conname
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE n.nspname = 'public'
               AND t.relname = 'phieugiaodichkho'
               AND c.contype = 'c'
               AND pg_get_constraintdef(c.oid) ILIKE '%loaigd%'
        LOOP
            EXECUTE format('ALTER TABLE public.phieugiaodichkho DROP CONSTRAINT IF EXISTS %I', con_name);
        END LOOP;

        ALTER TABLE public.phieugiaodichkho
            ADD CONSTRAINT chk_phieugiaodichkho_loaigd
            CHECK (LoaiGD IN (1, 2, 3, 4, 5, 6, 7, 8));
    END IF;
END $$;

COMMIT;
