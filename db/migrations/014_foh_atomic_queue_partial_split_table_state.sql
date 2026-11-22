-- ============================================================================
-- MIGRATION 014: BỘ ĐẾM SỐ THỨ TỰ NGUYÊN TỬ (ATOMIC DAILY COUNTER 01->99),
--                TÁCH LẺ SỐ LƯỢNG DÒNG MÓN & TRẠNG THÁI BÀN 3 = CHỜ DỌN (CHO_DON)
-- Mục đích:
--   1. Vá lỗi P0 sập bộ đếm SoThuTuNgay từ đơn thứ 100 trở đi (khi MAX(SoThuTuNgay)
--      đạt 99) bằng bảng nguyên tử Tenant_Daily_Counter (UPSERT row-level lock).
--   2. Khởi tạo giá trị LastSeq ban đầu khớp số đơn đã tạo trong ngày để không
--      trùng số khi nâng cấp giữa ca.
--   3. Nới lỏng CHECK constraint (nếu có) trên Ban.TrangThai để hỗ trợ:
--      1 = Trống, 2 = Đang phục vụ, 3 = Chờ dọn (CHO_DON), 4 = Đã đặt trước.
-- An toàn chạy lặp lại nhiều lần (Idempotent).
-- ============================================================================

-- 1. Bảng bộ đếm số thứ tự nguyên tử theo từng (TenantId, NgayVN)
CREATE TABLE IF NOT EXISTS public.tenant_daily_counter (
    TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    NgayVN   DATE NOT NULL,
    LastSeq  INT NOT NULL DEFAULT 0,
    PRIMARY KEY (TenantId, NgayVN)
);

ALTER TABLE public.tenant_daily_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_daily_counter FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_daily_counter ON public.tenant_daily_counter;
CREATE POLICY tenant_isolation_daily_counter ON public.tenant_daily_counter
    USING (TenantId = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (TenantId = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- Cấp quyền DML trên tenant_daily_counter cho app_runtime
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_daily_counter TO app_runtime';
    END IF;
END $$;

-- 2. Đồng bộ LastSeq cho các đơn đã phát sinh trong ngày hôm nay (tránh quay về #01 khi chạy migration giữa ngày)
INSERT INTO public.tenant_daily_counter (TenantId, NgayVN, LastSeq)
SELECT COALESCE(hd.TenantId, 'DEFAULT') AS TenantId,
       (hd.ThoiGianTao AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS NgayVN,
       GREATEST(COUNT(*)::int, COALESCE(MAX(hd.SoThuTuNgay), 0)) AS LastSeq
  FROM public.HoaDon hd
 WHERE hd.ThoiGianTao >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'
 GROUP BY COALESCE(hd.TenantId, 'DEFAULT'), (hd.ThoiGianTao AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
ON CONFLICT (TenantId, NgayVN)
DO UPDATE SET LastSeq = GREATEST(public.tenant_daily_counter.LastSeq, EXCLUDED.LastSeq);

-- 3. Nới lỏng CHECK constraint trên Ban.TrangThai (nếu schema gốc giới hạn IN (1, 2)) để cho phép 3 = Chờ dọn, 4 = Đặt trước
DO $$
DECLARE
    con_name text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ban') THEN
        FOR con_name IN
            SELECT c.conname
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE n.nspname = 'public'
               AND t.relname = 'ban'
               AND c.contype = 'c'
               AND pg_get_constraintdef(c.oid) ILIKE '%trangthai%'
        LOOP
            EXECUTE format('ALTER TABLE public.ban DROP CONSTRAINT IF EXISTS %I', con_name);
        END LOOP;

        ALTER TABLE public.ban
            ADD CONSTRAINT chk_ban_trangthai CHECK (TrangThai IN (1, 2, 3, 4));
    END IF;
END $$;
