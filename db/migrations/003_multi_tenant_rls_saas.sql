-- ============================================================================
-- Migration 003: Multi-Tenant SaaS (TenantId + PostgreSQL Row-Level Security)
-- Tương thích ngược 100% với dữ liệu Single-Store cũ (gán mặc định 'DEFAULT').
-- ============================================================================

-- 1. Bảng Quản lý Tenant (Mỗi quán / thương hiệu đăng ký SaaS — Dùng thử 30 ngày -> Bản chính thức)
CREATE TABLE IF NOT EXISTS Tenants (
    TenantId           VARCHAR(64) PRIMARY KEY,
    MaTienTo           VARCHAR(12) NOT NULL UNIQUE, -- Tiền tố ngắn tránh đụng PK trên bảng dùng chung
    TenQuan            VARCHAR(150) NOT NULL,
    Slug               VARCHAR(100) NOT NULL UNIQUE,
    MoHinh             VARCHAR(32) NOT NULL DEFAULT 'CAFE_TAKEAWAY', -- CAFE_TAKEAWAY | CAFE_SAN_VUON | TRA_SUA | TIEM_BANH
    GoiCuoc            VARCHAR(24) NOT NULL DEFAULT 'STARTER',       -- STARTER | PRO | ENTERPRISE
    TrangThai          VARCHAR(24) NOT NULL DEFAULT 'TRIAL',         -- TRIAL | ACTIVE | EXPIRED | SUSPENDED
    TrialEndsAt        TIMESTAMPTZ,
    SubscriptionEndsAt TIMESTAMPTZ,
    LastPaymentAt      TIMESTAMPTZ,
    FeatureFlags       JSONB NOT NULL DEFAULT '{}'::jsonb,
    ThongTinNganHang   JSONB NOT NULL DEFAULT '{}'::jsonb,
    ThoiGianTao        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS Tenant_Billing_Orders (
    Id                 BIGSERIAL PRIMARY KEY,
    MaDonThanhToan     VARCHAR(64) NOT NULL UNIQUE,
    TenantId           VARCHAR(64) NOT NULL REFERENCES Tenants(TenantId) ON DELETE CASCADE,
    GoiCuoc            VARCHAR(24) NOT NULL,
    SoThang            INT NOT NULL DEFAULT 1,
    SoTien             NUMERIC(15, 2) NOT NULL CHECK (SoTien > 0),
    TrangThai          VARCHAR(24) NOT NULL DEFAULT 'PENDING', -- PENDING | PAID | CANCELLED
    PhuongThucTT       VARCHAR(32) NOT NULL DEFAULT 'VIETQR',
    MaGiaoDichNgoai    VARCHAR(128),
    GhiChu             TEXT,
    ThoiGianTao        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ThoiGianThanhToan  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tenant_billing_tenant ON Tenant_Billing_Orders (TenantId, ThoiGianTao DESC);

INSERT INTO Tenants (TenantId, MaTienTo, TenQuan, Slug, MoHinh, GoiCuoc, TrangThai, FeatureFlags)
VALUES (
    'DEFAULT',
    'DEF',
    'Quán Cà Phê Mặc Định',
    'default-cafe',
    'CAFE_SAN_VUON',
    'PRO',
    'ACTIVE',
    '{"inventory_bom": true, "vietqr_webhook": true, "offline_pwa": true, "ai_menu_importer": true, "audit_logs": true}'::jsonb
)
ON CONFLICT (TenantId) DO NOTHING;

-- 2. Gắn cột TenantId vào toàn bộ bảng nghiệp vụ cốt lõi
ALTER TABLE NhanVien            ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE Ban                 ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE SanPham             ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE Topping             ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE NguyenLieu          ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE HoaDon              ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE CaThuNgan           ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE KhachHang           ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE PhieuGiaoDichKho    ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE PhanCa              ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE CaLamViec           ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE Audit_Logs          ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE Order_Payments      ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE VietQR_Webhook_Events ADD COLUMN IF NOT EXISTS TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT';

-- 3. Index theo TenantId đảm bảo hiệu năng khi scale lên 1.000+ quán
CREATE INDEX IF NOT EXISTS idx_nhanvien_tenant   ON NhanVien (TenantId);
CREATE INDEX IF NOT EXISTS idx_ban_tenant        ON Ban (TenantId, DaXoa);
CREATE INDEX IF NOT EXISTS idx_sanpham_tenant    ON SanPham (TenantId, DangKinhDoanh);
CREATE INDEX IF NOT EXISTS idx_topping_tenant    ON Topping (TenantId, DangKinhDoanh);
CREATE INDEX IF NOT EXISTS idx_nguyenlieu_tenant ON NguyenLieu (TenantId, DaXoa);
CREATE INDEX IF NOT EXISTS idx_hoadon_tenant     ON HoaDon (TenantId, TrangThaiTT, ThoiGianThanhToan DESC);
CREATE INDEX IF NOT EXISTS idx_cathungan_tenant  ON CaThuNgan (TenantId, TrangThaiCa);
CREATE INDEX IF NOT EXISTS idx_khachhang_tenant  ON KhachHang (TenantId, SoDienThoai);
CREATE INDEX IF NOT EXISTS idx_audit_tenant      ON Audit_Logs (TenantId, ThoiGianTao DESC);
CREATE INDEX IF NOT EXISTS idx_payments_tenant   ON Order_Payments (TenantId, MaCaThuNgan, TrangThai);

-- 4. Bật PostgreSQL Row-Level Security (RLS) cô lập dữ liệu tuyệt đối ở tầng DB Engine
--    (Mọi transaction của ứng dụng chạy: SET LOCAL app.current_tenant_id = '<tenantId>')
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'nhanvien', 'ban', 'sanpham', 'topping', 'nguyenlieu', 'hoadon',
        'cathungan', 'khachhang', 'phieugiaodichkho', 'phanca', 'calamviec',
        'audit_logs', 'order_payments', 'vietqr_webhook_events'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON %I', tbl);
        EXECUTE format(
            'CREATE POLICY tenant_isolation_policy ON %I USING (tenantid = COALESCE(NULLIF(current_setting(''app.current_tenant_id'', true), ''''), ''DEFAULT'')) WITH CHECK (tenantid = COALESCE(NULLIF(current_setting(''app.current_tenant_id'', true), ''''), ''DEFAULT''))',
            tbl
        );
    END LOOP;
END $$;
