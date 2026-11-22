-- ============================================================================
-- Migration 008: Số thứ tự đơn theo ngày / Thẻ rung (SoThuTuNgay 01->99)
--                & Thời gian trả món cho KDS Recall 15 phút (ThoiGianXong)
-- ============================================================================

-- 1. Số thứ tự đơn theo ngày / số thẻ rung (reset mỗi ngày VN, quay vòng 01 -> 99)
ALTER TABLE public.HoaDon
    ADD COLUMN IF NOT EXISTS SoThuTuNgay INT;

CREATE INDEX IF NOT EXISTS idx_hd_tenant_queue_day
    ON public.HoaDon (TenantId, ThoiGianTao DESC, SoThuTuNgay);

-- 2. Thời điểm Barista bấm trả món (phục vụ KDS Recall 15 phút gần nhất)
ALTER TABLE public.ChiTietHoaDon
    ADD COLUMN IF NOT EXISTS ThoiGianXong TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_cthd_recall
    ON public.ChiTietHoaDon (TrangThaiPhaChe, ThoiGianXong DESC);
