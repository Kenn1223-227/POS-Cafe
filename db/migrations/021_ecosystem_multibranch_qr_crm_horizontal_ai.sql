-- =============================================================================
-- MIGRATION 021: PHÂN HỆ 8 — CHIẾN LƯỢC MỞ RỘNG TỆP KHÁCH HÀNG & HỆ SINH THÁI
--   1. Multi-Branch & Franchise HQ: Tenant -> ChiNhanh (Branch) -> QuayTerminal
--      + Cột BranchId trên HoaDon, Ban, NguyenLieu, CaThuNgan, NhanVien, PhieuGiaoDichKho
--      + SanPham_GiaVung (Đẩy menu theo vùng giá: Đà Nẵng 39k / TP.HCM 45k)
--      + TonKhoChiNhanh + PhieuDieuChuyenKho / ChiTietDieuChuyenKho (Kho tổng & Điều chuyển nội bộ)
--   2. QR Order tại bàn kèm Chống phá hoại 3 lớp (Anti-Spam):
--      + Ban.QrToken (xoay tự động sau mỗi lần thanh toán bàn), QrYeuCauMoBan, QrBatBuocVietQR
--      + DonQrChoDuyet (Hàng đợi duyệt 1 chạm trên POS hoặc bắt buộc VietQR trước)
--      + Hàm SECURITY DEFINER hẹp fn_resolve_qr_table(slug, token) tương thích Fail-Closed RLS
--   3. CRM 2 giây + Phân hạng (Đồng/Bạc/Vàng/Kim Cương) + Ví trả trước/Cashback + Zalo ZNS:
--      + Functional Index RIGHT(SoDienThoai, 4) & 4 số cuối chuẩn hóa trên KhachHang
--      + KhachHang_GiaoDichVi + Zalo_ZNS_Outbox
--   4. Aggregator Hub (GrabFood / ShopeeFood / BeFood): DonSanGiaoHang
--   5. Đa mô hình F&B ngang:
--      + PhienTinhGio (Time-based Billing cho Bida, Boardgame Cafe, Co-working Space)
--      + LoBanhNgay (Lô bánh giảm giá tự động 50% sau 19h cho Bakery)
--   6. Fail-Closed RLS + Least-Privilege GRANT cho app_runtime (NOBYPASSRLS)
-- An toàn chạy lặp lại nhiều lần (Idempotent).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. PHÂN CẤP TỔ CHỨC: TENANT (BRAND/HQ) -> CHINHANH (BRANCH) -> QUAYTERMINAL
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chinhanh (
    branchid             VARCHAR(64) PRIMARY KEY,
    tenantid             VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    machinhanh           VARCHAR(32) NOT NULL,
    tenchinhanh          VARCHAR(150) NOT NULL,
    khuvucgia            VARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    diachi               TEXT,
    sodienthoai          VARCHAR(32),
    lakhotong            BOOLEAN NOT NULL DEFAULT FALSE,
    tylephinhuongquyen   NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (tylephinhuongquyen >= 0 AND tylephinhuongquyen <= 100),
    trangthai            VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
    thoigiantao          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenantid, machinhanh)
);

CREATE INDEX IF NOT EXISTS idx_chinhanh_tenant ON public.chinhanh (tenantid, trangthai);

CREATE TABLE IF NOT EXISTS public.quayterminal (
    terminalid           VARCHAR(64) PRIMARY KEY,
    tenantid             VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    branchid             VARCHAR(64) NOT NULL REFERENCES public.chinhanh(branchid) ON DELETE CASCADE,
    tenquay              VARCHAR(100) NOT NULL,
    loaiquay             VARCHAR(32) NOT NULL DEFAULT 'POS',
    trangthai            VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
    thoigiantao          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quayterminal_branch ON public.quayterminal (tenantid, branchid);

-- Thêm cột BranchId vào các bảng cốt lõi
ALTER TABLE public.hoadon            ADD COLUMN IF NOT EXISTS branchid VARCHAR(64);
ALTER TABLE public.ban               ADD COLUMN IF NOT EXISTS branchid VARCHAR(64);
ALTER TABLE public.nguyenlieu        ADD COLUMN IF NOT EXISTS branchid VARCHAR(64);
ALTER TABLE public.cathungan         ADD COLUMN IF NOT EXISTS branchid VARCHAR(64);
ALTER TABLE public.nhanvien          ADD COLUMN IF NOT EXISTS branchid VARCHAR(64);
ALTER TABLE public.phieugiaodichkho  ADD COLUMN IF NOT EXISTS branchid VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_hoadon_tenant_branch     ON public.hoadon (COALESCE(tenantid, 'DEFAULT'), branchid, thoigiantao DESC);
CREATE INDEX IF NOT EXISTS idx_ban_tenant_branch        ON public.ban (COALESCE(tenantid, 'DEFAULT'), branchid);
CREATE INDEX IF NOT EXISTS idx_nguyenlieu_tenant_branch ON public.nguyenlieu (COALESCE(tenantid, 'DEFAULT'), branchid);
CREATE INDEX IF NOT EXISTS idx_cathungan_tenant_branch  ON public.cathungan (COALESCE(tenantid, 'DEFAULT'), branchid, trangthaica);

-- Bảng đẩy giá tập trung theo Vùng giá (VD: DA_NANG 39k / HCM 45k)
CREATE TABLE IF NOT EXISTS public.sanpham_giavung (
    id                   BIGSERIAL PRIMARY KEY,
    tenantid             VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    khuvucgia            VARCHAR(32) NOT NULL,
    mamon                VARCHAR(50) NOT NULL,
    kichthuoc            VARCHAR(10) NOT NULL,
    giaban               NUMERIC(15, 2) NOT NULL CHECK (giaban >= 0),
    capnhatluc           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenantid, khuvucgia, mamon, kichthuoc)
);

CREATE INDEX IF NOT EXISTS idx_sp_giavung_lookup ON public.sanpham_giavung (tenantid, khuvucgia, mamon);

-- Tồn kho chi tiết theo Chi nhánh & Phiếu điều chuyển Kho tổng <-> Chi nhánh
CREATE TABLE IF NOT EXISTS public.tonkhochinhanh (
    tenantid             VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    branchid             VARCHAR(64) NOT NULL REFERENCES public.chinhanh(branchid) ON DELETE CASCADE,
    manl                 VARCHAR(50) NOT NULL,
    soluongton           NUMERIC(15, 3) NOT NULL DEFAULT 0,
    hanmuccanhbao        NUMERIC(15, 3) NOT NULL DEFAULT 0,
    capnhatluc           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (branchid, manl)
);

CREATE INDEX IF NOT EXISTS idx_tonkhochinhanh_tenant ON public.tonkhochinhanh (tenantid, branchid);

CREATE TABLE IF NOT EXISTS public.phieudieuchuyenkho (
    maphieu              VARCHAR(64) PRIMARY KEY,
    tenantid             VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    tubranchid           VARCHAR(64) NOT NULL REFERENCES public.chinhanh(branchid) ON DELETE RESTRICT,
    denbranchid          VARCHAR(64) NOT NULL REFERENCES public.chinhanh(branchid) ON DELETE RESTRICT,
    manvtao              VARCHAR(50),
    manvnhan             VARCHAR(50),
    trangthai            VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    ghichu               TEXT,
    thoigiantao          TIMESTAMPTZ NOT NULL DEFAULT now(),
    thoigianhoantat      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dieuchuyen_tenant ON public.phieudieuchuyenkho (tenantid, thoigiantao DESC);

CREATE TABLE IF NOT EXISTS public.chitietdieuchuyenkho (
    id                   BIGSERIAL PRIMARY KEY,
    tenantid             VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    maphieu              VARCHAR(64) NOT NULL REFERENCES public.phieudieuchuyenkho(maphieu) ON DELETE CASCADE,
    manl                 VARCHAR(50) NOT NULL,
    soluong              NUMERIC(15, 3) NOT NULL CHECK (soluong > 0),
    dongiavon            NUMERIC(15, 2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ctdieuchuyen_phieu ON public.chitietdieuchuyenkho (tenantid, maphieu);

-- Seed Chi nhánh gốc cho mọi Tenant hiện có (Idempotent)
DO $$
BEGIN
    IF to_regclass('public.tenants') IS NOT NULL THEN
        INSERT INTO public.chinhanh (branchid, tenantid, machinhanh, tenchinhanh, khuvucgia, lakhotong, tylephinhuongquyen)
        SELECT
            t.tenantid || '_MAIN',
            t.tenantid,
            'CN01',
            COALESCE(t.tenquan, 'Chi nhánh Trung tâm') || ' - Cơ sở 1 (Kho tổng)',
            'DEFAULT',
            TRUE,
            0
        FROM public.tenants t
        ON CONFLICT (branchid) DO NOTHING;
    ELSE
        INSERT INTO public.chinhanh (branchid, tenantid, machinhanh, tenchinhanh, khuvucgia, lakhotong, tylephinhuongquyen)
        VALUES ('DEFAULT_MAIN', 'DEFAULT', 'CN01', 'Cơ sở 1 (Kho tổng)', 'DEFAULT', TRUE, 0)
        ON CONFLICT (branchid) DO NOTHING;
    END IF;
END $$;

-- Backfill BranchId mặc định cho dữ liệu hiện hữu nếu đang NULL
UPDATE public.ban              SET branchid = COALESCE(tenantid, 'DEFAULT') || '_MAIN' WHERE branchid IS NULL;
UPDATE public.hoadon           SET branchid = COALESCE(tenantid, 'DEFAULT') || '_MAIN' WHERE branchid IS NULL;
UPDATE public.nguyenlieu       SET branchid = COALESCE(tenantid, 'DEFAULT') || '_MAIN' WHERE branchid IS NULL;
UPDATE public.cathungan        SET branchid = COALESCE(tenantid, 'DEFAULT') || '_MAIN' WHERE branchid IS NULL;
UPDATE public.phieugiaodichkho SET branchid = COALESCE(tenantid, 'DEFAULT') || '_MAIN' WHERE branchid IS NULL;

-- ---------------------------------------------------------------------------
-- 2. QR ORDER TẠI BÀN + CHỐNG PHÁ HOẠI 3 LỚP (ANTI-SPAM)
-- ---------------------------------------------------------------------------
ALTER TABLE public.ban ADD COLUMN IF NOT EXISTS qrtoken VARCHAR(64);
ALTER TABLE public.ban ADD COLUMN IF NOT EXISTS qrtokenrotatedat TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.ban ADD COLUMN IF NOT EXISTS qryeucaumoban BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.ban ADD COLUMN IF NOT EXISTS qrbatbuocvietqr BOOLEAN NOT NULL DEFAULT FALSE;

-- Khởi tạo QrToken động cho mọi bàn chưa có token
UPDATE public.ban
   SET qrtoken = LOWER(SUBSTRING(md5(COALESCE(tenantid, 'DEFAULT') || ':' || maban || ':' || clock_timestamp()::text || ':' || random()::text), 1, 12)),
       qrtokenrotatedat = now()
 WHERE qrtoken IS NULL OR qrtoken = '';

CREATE INDEX IF NOT EXISTS idx_ban_tenant_qrtoken ON public.ban (COALESCE(tenantid, 'DEFAULT'), qrtoken);

CREATE TABLE IF NOT EXISTS public.donqrchoduyet (
    madonqr              VARCHAR(64) PRIMARY KEY,
    tenantid             VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    branchid             VARCHAR(64),
    maban                VARCHAR(50),
    tenban               VARCHAR(100),
    qrtokensnapshot      VARCHAR(64),
    trangthai            VARCHAR(32) NOT NULL DEFAULT 'PENDING_APPROVAL',
    batbuocthanhtoantruoc BOOLEAN NOT NULL DEFAULT FALSE,
    dathanhtoantruoc     BOOLEAN NOT NULL DEFAULT FALSE,
    tongtientamtinh      NUMERIC(15, 2) NOT NULL DEFAULT 0,
    sodienthoaikhach     VARCHAR(32),
    tenkhach             VARCHAR(100),
    ghichuchung          TEXT,
    danhsachmon          JSONB NOT NULL DEFAULT '[]'::jsonb,
    mahoadondatao        VARCHAR(64),
    nguoiduyet           VARCHAR(50),
    lydotuchoi           TEXT,
    ipkhach              VARCHAR(64),
    thoigiantao          TIMESTAMPTZ NOT NULL DEFAULT now(),
    thoigianxuly         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_donqr_tenant_status ON public.donqrchoduyet (tenantid, trangthai, thoigiantao DESC);

-- Hàm SECURITY DEFINER phạm vi hẹp cho route công khai /m/:tenantSlug/:tableToken (an toàn với Fail-Closed RLS)
CREATE OR REPLACE FUNCTION public.fn_resolve_qr_table(p_slug TEXT, p_token TEXT)
RETURNS TABLE (
    tenantid             VARCHAR(64),
    tenquan              VARCHAR(150),
    slug                 VARCHAR(100),
    thongtinnganhang     JSONB,
    maban                VARCHAR(50),
    tenban               VARCHAR(100),
    khuvuc               VARCHAR(100),
    trangthaiban         INT,
    branchid             VARCHAR(64),
    qrtoken              VARCHAR(64),
    qryeucaumoban        BOOLEAN,
    qrbatbuocvietqr      BOOLEAN,
    tokenhopLe           BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant RECORD;
    v_ban    RECORD;
BEGIN
    SELECT t.tenantid, t.tenquan, t.slug, COALESCE(t.thongtinnganhang, '{}'::jsonb) AS thongtinnganhang
      INTO v_tenant
      FROM public.tenants t
     WHERE LOWER(t.slug) = LOWER(TRIM(COALESCE(p_slug, '')))
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT b.maban, b.tenban, b.khuvuc, b.trangthai, b.branchid,
           b.qrtoken, COALESCE(b.qryeucaumoban, TRUE) AS qryeucaumoban,
           COALESCE(b.qrbatbuocvietqr, FALSE) AS qrbatbuocvietqr
      INTO v_ban
      FROM public.ban b
     WHERE COALESCE(b.tenantid, 'DEFAULT') = v_tenant.tenantid
       AND b.daxoa = FALSE
       AND b.qrtoken = TRIM(COALESCE(p_token, ''))
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN QUERY
        SELECT v_tenant.tenantid, v_tenant.tenquan, v_tenant.slug, v_tenant.thongtinnganhang,
               NULL::VARCHAR(50), NULL::VARCHAR(100), NULL::VARCHAR(100), NULL::INT, NULL::VARCHAR(64),
               NULL::VARCHAR(64), TRUE, FALSE, FALSE;
        RETURN;
    END IF;

    RETURN QUERY
    SELECT v_tenant.tenantid, v_tenant.tenquan, v_tenant.slug, v_tenant.thongtinnganhang,
           v_ban.maban, v_ban.tenban, v_ban.khuvuc, v_ban.trangthai, v_ban.branchid,
           v_ban.qrtoken, v_ban.qryeucaumoban, v_ban.qrbatbuocvietqr, TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. TRA CỨU KHÁCH 2 GIÂY (4 SỐ CUỐI SĐT) + CRM PHÂN HẠNG + VÍ + ZALO ZNS
-- ---------------------------------------------------------------------------
ALTER TABLE public.khachhang ADD COLUMN IF NOT EXISTS hangthanhvien VARCHAR(20) NOT NULL DEFAULT 'DONG';
ALTER TABLE public.khachhang ADD COLUMN IF NOT EXISTS tongchitieu   NUMERIC(15, 2) NOT NULL DEFAULT 0;
ALTER TABLE public.khachhang ADD COLUMN IF NOT EXISTS soduvi        NUMERIC(15, 2) NOT NULL DEFAULT 0;
ALTER TABLE public.khachhang ADD COLUMN IF NOT EXISTS ngaysinh      DATE;
ALTER TABLE public.khachhang ADD COLUMN IF NOT EXISTS zalooptin     BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.khachhang ADD COLUMN IF NOT EXISTS lanmuacuoi    TIMESTAMPTZ;

-- Index chức năng RIGHT(SoDienThoai, 4) cho tra cứu 4 số cuối dưới 2ms
CREATE INDEX IF NOT EXISTS idx_khachhang_tenant_right4
    ON public.khachhang (COALESCE(tenantid, 'DEFAULT'), RIGHT(sodienthoai, 4));

CREATE INDEX IF NOT EXISTS idx_khachhang_tenant_digits_right4
    ON public.khachhang (COALESCE(tenantid, 'DEFAULT'), RIGHT(REGEXP_REPLACE(COALESCE(sodienthoai, ''), '[^0-9]', '', 'g'), 4));

CREATE TABLE IF NOT EXISTS public.khachhang_giaodichvi (
    id                   BIGSERIAL PRIMARY KEY,
    tenantid             VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    makh                 VARCHAR(50) NOT NULL,
    loaigd               VARCHAR(24) NOT NULL,
    sotien               NUMERIC(15, 2) NOT NULL,
    sodusau              NUMERIC(15, 2) NOT NULL,
    mahoadon             VARCHAR(64),
    ghichu               TEXT,
    manv                 VARCHAR(50),
    thoigiantao          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kh_vi_tenant_makh ON public.khachhang_giaodichvi (tenantid, makh, thoigiantao DESC);

CREATE TABLE IF NOT EXISTS public.zalo_zns_outbox (
    id                   BIGSERIAL PRIMARY KEY,
    tenantid             VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    makh                 VARCHAR(50),
    sodienthoai          VARCHAR(32) NOT NULL,
    loaitin              VARCHAR(32) NOT NULL,
    noidung              JSONB NOT NULL DEFAULT '{}'::jsonb,
    trangthai            VARCHAR(24) NOT NULL DEFAULT 'QUEUED',
    thoigiantao          TIMESTAMPTZ NOT NULL DEFAULT now(),
    thoigiangui          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_zns_tenant_status ON public.zalo_zns_outbox (tenantid, trangthai, thoigiantao DESC);

-- ---------------------------------------------------------------------------
-- 4. AGGREGATOR HUB (GRABFOOD / SHOPEEFOOD / BEFOOD)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.donsangiaohang (
    madonsan             VARCHAR(64) PRIMARY KEY,
    tenantid             VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    branchid             VARCHAR(64),
    nentang              VARCHAR(24) NOT NULL,
    madonngoai           VARCHAR(64) NOT NULL,
    tenkhach             VARCHAR(120),
    sodienthoai          VARCHAR(32),
    tentaixe             VARCHAR(120),
    biensoxe             VARCHAR(32),
    trangthai            VARCHAR(24) NOT NULL DEFAULT 'NEW',
    tongtienhang         NUMERIC(15, 2) NOT NULL DEFAULT 0,
    phichietkhausan      NUMERIC(15, 2) NOT NULL DEFAULT 0,
    doanhthuthucnhan     NUMERIC(15, 2) NOT NULL DEFAULT 0,
    danhsachmon          JSONB NOT NULL DEFAULT '[]'::jsonb,
    ghichu               TEXT,
    mahoadonpos          VARCHAR(64),
    thoigiantao          TIMESTAMPTZ NOT NULL DEFAULT now(),
    thoigiancapnhat      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenantid, nentang, madonngoai)
);

CREATE INDEX IF NOT EXISTS idx_donsan_tenant_status ON public.donsangiaohang (tenantid, trangthai, thoigiantao DESC);

-- ---------------------------------------------------------------------------
-- 5. ĐA MÔ HÌNH F&B NGANG: TÍNH GIỜ (BIDA/BOARDGAME/COWORKING) & LÔ BÁNH BAKERY
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.phientinhgio (
    maphien              VARCHAR(64) PRIMARY KEY,
    tenantid             VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    branchid             VARCHAR(64),
    maban                VARCHAR(50) NOT NULL,
    mahoadon             VARCHAR(64),
    loaidichvu           VARCHAR(32) NOT NULL DEFAULT 'BIDA',
    dongiatheogio        NUMERIC(15, 2) NOT NULL DEFAULT 60000 CHECK (dongiatheogio >= 0),
    khunggiocaodiem      JSONB NOT NULL DEFAULT '{"startHour":18,"endHour":23,"multiplier":1.25}'::jsonb,
    batdauluc            TIMESTAMPTZ NOT NULL DEFAULT now(),
    ketthucluc           TIMESTAMPTZ,
    trangthai            VARCHAR(24) NOT NULL DEFAULT 'RUNNING',
    sophuttamdung        INT NOT NULL DEFAULT 0,
    tamdungluc           TIMESTAMPTZ,
    tongtiengio          NUMERIC(15, 2) NOT NULL DEFAULT 0,
    manv                 VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_phientinhgio_tenant_active ON public.phientinhgio (tenantid, maban, trangthai);

CREATE TABLE IF NOT EXISTS public.lobanhngay (
    malo                 VARCHAR(64) PRIMARY KEY,
    tenantid             VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    branchid             VARCHAR(64),
    mamon                VARCHAR(50) NOT NULL,
    tenmon               VARCHAR(150) NOT NULL,
    ngaysanxuat          DATE NOT NULL DEFAULT CURRENT_DATE,
    soluongsanxuat       INT NOT NULL CHECK (soluongsanxuat > 0),
    soluongconlai        INT NOT NULL CHECK (soluongconlai >= 0),
    giogiamgia           INT NOT NULL DEFAULT 19 CHECK (giogiamgia >= 0 AND giogiamgia <= 23),
    phantramgiam         INT NOT NULL DEFAULT 50 CHECK (phantramgiam >= 0 AND phantramgiam <= 95),
    giagoc               NUMERIC(15, 2) NOT NULL DEFAULT 0,
    trangthai            VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
    thoigiantao          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lobanhngay_tenant_date ON public.lobanhngay (tenantid, ngaysanxuat DESC, mamon);

-- ---------------------------------------------------------------------------
-- 6. BẬT FAIL-CLOSED RLS & CẤP QUYỀN LEAST-PRIVILEGE CHO APP_RUNTIME
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    tbl TEXT;
    new_tables TEXT[] := ARRAY[
        'chinhanh',
        'quayterminal',
        'sanpham_giavung',
        'tonkhochinhanh',
        'phieudieuchuyenkho',
        'chitietdieuchuyenkho',
        'donqrchoduyet',
        'khachhang_giaodichvi',
        'zalo_zns_outbox',
        'donsangiaohang',
        'phientinhgio',
        'lobanhngay'
    ];
BEGIN
    FOREACH tbl IN ARRAY new_tables LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
             WHERE schemaname = 'public' AND tablename = tbl AND policyname = 'tenant_isolation_policy'
        ) THEN
            EXECUTE format(
                'CREATE POLICY tenant_isolation_policy ON public.%I
                 USING (tenantid = NULLIF(current_setting(''app.current_tenant_id'', true), ''''))
                 WITH CHECK (tenantid = NULLIF(current_setting(''app.current_tenant_id'', true), ''''))',
                tbl
            );
        END IF;
    END LOOP;

    -- Khóa quyền tối thiểu cho hàm fn_resolve_qr_table
    REVOKE ALL ON FUNCTION public.fn_resolve_qr_table(TEXT, TEXT) FROM PUBLIC;
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.fn_resolve_qr_table(TEXT, TEXT) TO %I', current_user);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime';
        EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime';
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.fn_resolve_qr_table(TEXT, TEXT) TO app_runtime';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.fn_resolve_qr_table(TEXT, TEXT) TO service_role';
    END IF;
END $$;

COMMIT;
