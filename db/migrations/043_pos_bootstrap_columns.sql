-- =============================================================================
-- Migration 043: Bổ sung cột tọa độ sơ đồ bàn (ToaDoX, ToaDoY) cho bảng public.ban
-- Đảm bảo GET /api/ban và POST /api/ban chạy ổn định dưới NODE_ENV=production
-- & SKIP_AUTO_DDL=true trên mọi DB sạch khởi tạo từ schema_base.sql + 001 -> 043.
-- Idempotent 100% — an toàn chạy lặp lại nhiều lần.
-- =============================================================================

BEGIN;

ALTER TABLE IF EXISTS public.ban
    ADD COLUMN IF NOT EXISTS toadox INT NOT NULL DEFAULT 0;

ALTER TABLE IF EXISTS public.ban
    ADD COLUMN IF NOT EXISTS toadoy INT NOT NULL DEFAULT 0;

COMMIT;
