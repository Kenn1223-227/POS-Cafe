-- ============================================================================
-- Migration 005: Quy đổi Đơn vị tính Kho (UoM Conversion: Thùng -> Lon -> ml/g)
--                & Định lượng Công thức đa nguyên liệu cho Topping (Topping_CongThuc)
-- ============================================================================

-- 1. Bảng Quy đổi Đơn vị nhập kho về Đơn vị pha chế cơ sở (base unit)
CREATE TABLE IF NOT EXISTS public.NguyenLieu_DonViQuyDoi (
    Id          BIGSERIAL PRIMARY KEY,
    TenantId    VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    MaNL        VARCHAR(64) NOT NULL,
    TenDonVi    VARCHAR(32) NOT NULL,         -- VD: 'Thùng', 'Hộp', 'Lon', 'Kg', 'Lít'
    HeSoQuyDoi  NUMERIC(15, 4) NOT NULL CHECK (HeSoQuyDoi > 0), -- VD: 1 Thùng = 12000 ml
    ThoiGianTao TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (TenantId, MaNL, TenDonVi)
);
CREATE INDEX IF NOT EXISTS idx_nl_quydoi_tenant ON public.NguyenLieu_DonViQuyDoi (TenantId, MaNL);

-- 2. Bảng Công thức Định lượng đa nguyên liệu cho Topping (VD: Kem Cheese = Kem béo + Sữa tươi + Bột phô mai)
CREATE TABLE IF NOT EXISTS public.Topping_CongThuc (
    TenantId          VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    MaTopping         VARCHAR(64) NOT NULL,
    MaNL              VARCHAR(64) NOT NULL,
    KhoiLuongTieuHao  NUMERIC(15, 4) NOT NULL CHECK (KhoiLuongTieuHao > 0),
    PRIMARY KEY (TenantId, MaTopping, MaNL)
);
CREATE INDEX IF NOT EXISTS idx_topping_ct_tenant ON public.Topping_CongThuc (TenantId, MaTopping);

-- 3. Bật RLS đồng bộ với chính sách Multi-Tenant
ALTER TABLE public.NguyenLieu_DonViQuyDoi ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.NguyenLieu_DonViQuyDoi FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON public.NguyenLieu_DonViQuyDoi;
CREATE POLICY tenant_isolation_policy ON public.NguyenLieu_DonViQuyDoi
    USING (TenantId = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), 'DEFAULT'))
    WITH CHECK (TenantId = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), 'DEFAULT'));

ALTER TABLE public.Topping_CongThuc ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.Topping_CongThuc FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON public.Topping_CongThuc;
CREATE POLICY tenant_isolation_policy ON public.Topping_CongThuc
    USING (TenantId = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), 'DEFAULT'))
    WITH CHECK (TenantId = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), 'DEFAULT'));
