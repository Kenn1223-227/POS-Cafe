-- =============================================================================
-- Migration 018: Phân hệ 5 (Granular RBAC, O(1) PIN Approval & Fraud Velocity)
-- 1. Bổ sung cột NhanVien.PermissionsOverride JSONB NOT NULL DEFAULT '{}'::jsonb
--    hỗ trợ phân quyền chi tiết (Ca trưởng / Shift Supervisor duyệt hủy món,
--    hoàn tiền, phiếu chi > 50k, kiểm kê kho nhưng KHÔNG xem được báo cáo lãi lỗ
--    và KHÔNG sửa được bảng lương/giá vốn).
-- =============================================================================

BEGIN;

ALTER TABLE public.nhanvien
    ADD COLUMN IF NOT EXISTS permissionsoverride JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_nhanvien_tenant_role_active
    ON public.nhanvien (COALESCE(tenantid, 'DEFAULT'), vaitro, trangthailamviec);

COMMIT;
