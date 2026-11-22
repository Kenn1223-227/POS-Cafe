-- ============================================================================
-- Migration 001: P0 & P1 Production Hardening Enhancements for Cafe POS
-- Tương thích ngược 100% với schema PostgreSQL hiện tại (IF NOT EXISTS).
-- ============================================================================

-- 1. Nhật ký Kiểm toán bất biến (Append-only Audit Trail - Anti-Fraud)
CREATE TABLE IF NOT EXISTS Audit_Logs (
    Id           BIGSERIAL PRIMARY KEY,
    MaNV         TEXT NOT NULL,
    VaiTro       INT,
    NguoiDuyet   TEXT,
    HanhDong     VARCHAR(64) NOT NULL, -- ORDER_VOID, ITEM_CANCEL, PREBILL_PRINT, REPRINT, SHIFT_CLOSE, CASH_PAYOUT, MENU_86, TABLE_MOVE
    DoiTuong     VARCHAR(32) NOT NULL, -- HOADON, CHITIETHOADON, CATHUNGAN, SANPHAM, BAN, KHO
    MaDoiTuong   TEXT,
    GiaTriCu     JSONB,
    GiaTriMoi    JSONB,
    LyDo         TEXT,
    DiaChiIP     TEXT,
    ThoiGianTao  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_thoigian ON Audit_Logs (ThoiGianTao DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_hanhdong ON Audit_Logs (HanhDong, ThoiGianTao DESC);

-- 2. Historical Snapshot & Void tracking trên ChiTietHoaDon
ALTER TABLE ChiTietHoaDon ADD COLUMN IF NOT EXISTS TenMonSnapshot TEXT;
ALTER TABLE ChiTietHoaDon ADD COLUMN IF NOT EXISTS GiaVonSnapshot NUMERIC(15, 2) DEFAULT 0;
ALTER TABLE ChiTietHoaDon ADD COLUMN IF NOT EXISTS LyDoHuy TEXT;

-- 3. Chống gian lận in tạm tính / in lại nhiều lần trên HoaDon
ALTER TABLE HoaDon ADD COLUMN IF NOT EXISTS SoLanIn INT NOT NULL DEFAULT 0;
ALTER TABLE HoaDon ADD COLUMN IF NOT EXISTS DaInTamTinh BOOLEAN NOT NULL DEFAULT FALSE;

-- 4. Khóa tạm hết món nhanh từ quầy Bar (86'ing)
ALTER TABLE SanPham ADD COLUMN IF NOT EXISTS TamHet BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE Topping ADD COLUMN IF NOT EXISTS TamHet BOOLEAN NOT NULL DEFAULT FALSE;

-- 5. Bảng ghi nhận ghi chú chênh lệch ca
ALTER TABLE CaThuNgan ADD COLUMN IF NOT EXISTS GhiChuChenhLech TEXT;

-- 6. Index tối ưu báo cáo theo múi giờ & truy vấn mở bàn/đơn
CREATE INDEX IF NOT EXISTS idx_hoadon_tt_thoigian ON HoaDon (TrangThaiTT, ThoiGianThanhToan DESC);
CREATE INDEX IF NOT EXISTS idx_cathungan_trangthai ON CaThuNgan (TrangThaiCa, ThoiGianMoCa DESC);
CREATE INDEX IF NOT EXISTS idx_cthd_trangthai ON ChiTietHoaDon (TrangThaiPhaChe, ThoiGianGoi);
