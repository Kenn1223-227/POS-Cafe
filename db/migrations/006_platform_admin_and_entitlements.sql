-- Migration 006: Tách riêng Platform Super Admin khỏi Tenant 'DEFAULT' & hỗ trợ Feature Flags / Quota Enforcement
-- Bảng Platform_Admins hoàn toàn độc lập với NhanVien & Tenants (không có TenantId, không chịu Tenant RLS).

CREATE TABLE IF NOT EXISTS Platform_Admins (
    Id           BIGSERIAL PRIMARY KEY,
    Username     VARCHAR(64) NOT NULL UNIQUE,
    FullName     VARCHAR(120) NOT NULL,
    PasswordHash TEXT NOT NULL,
    Role         VARCHAR(32) NOT NULL DEFAULT 'SUPER_ADMIN',
    IsActive     BOOLEAN NOT NULL DEFAULT TRUE,
    LastLoginAt  TIMESTAMPTZ,
    CreatedAt    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index hỗ trợ đếm nhanh số đơn hàng theo tháng của từng Tenant (Quota Enforcement cho gói STARTER)
CREATE INDEX IF NOT EXISTS idx_hoadon_tenant_created_quota
    ON HoaDon (TenantId, ThoiGianTao DESC);
