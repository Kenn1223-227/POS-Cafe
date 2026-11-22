-- ============================================================================
-- MIGRATION 010: CẤU HÌNH CẢNH BÁO GIAN LẬN TỨC THỜI (TELEGRAM / WEBHOOK)
-- Mục đích:
--   Lưu cấu hình kênh nhận cảnh báo gian lận (Telegram Bot, Custom Webhook,
--   ngưỡng lệch ca, danh sách sự kiện bật/tắt) cô lập theo từng quán trên Tenants.
-- An toàn chạy lặp lại nhiều lần (Idempotent).
-- ============================================================================

ALTER TABLE IF EXISTS public.tenants
    ADD COLUMN IF NOT EXISTS CauHinhCanhBao JSONB NOT NULL DEFAULT '{}'::jsonb;
