-- =============================================================================
-- MIGRATION 026: PHÂN HỆ 4 (81 -> 100/100)
-- QUẢN LÝ KHO ĐA CHI NHÁNH (SINGLE-SOURCE TONKHOCHINHANH), SỔ CÁI BẤT BIẾN,
-- SAFE WAC + LANDED COST + REVERSAL, LÔ FEFO, BOM 5 LỚP + DAG,
-- KIỂM KHO MÙ 60S + AVT THEO CA, NHÀ CUNG CẤP / AUTO-PO & KHÓA SỔ KHO ĐỊNH KỲ
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 1: SINGLE-SOURCE TONKHOCHINHANH, SỔ CÁI TỒN KHO & IN_TRANSIT TRANSFER
-- ---------------------------------------------------------------------------
ALTER TABLE public.tonkhochinhanh
    ADD COLUMN IF NOT EXISTS giavondonvi   NUMERIC(15, 4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tondangchuyen NUMERIC(15, 3) NOT NULL DEFAULT 0;

-- Đảm bảo mọi Tenant có chi nhánh gốc trong ChiNhanh trước khi backfill TonKhoChiNhanh
DO $$
BEGIN
    IF to_regclass('public.tenants') IS NOT NULL AND to_regclass('public.chinhanh') IS NOT NULL THEN
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
    END IF;
END $$;

-- Đảm bảo mọi BranchId xuất hiện trong NguyenLieu đều tồn tại ở ChiNhanh (nếu hợp lệ)
INSERT INTO public.chinhanh (branchid, tenantid, machinhanh, tenchinhanh, khuvucgia, lakhotong, tylephinhuongquyen)
SELECT DISTINCT
    COALESCE(NULLIF(NULLIF(nl.branchid, ''), 'DEFAULT'), COALESCE(nl.tenantid, 'DEFAULT') || '_MAIN') AS branchid,
    COALESCE(nl.tenantid, 'DEFAULT') AS tenantid,
    'CN01',
    'Chi nhánh chính (Kho tổng)',
    'DEFAULT',
    TRUE,
    0
FROM public.nguyenlieu nl
WHERE COALESCE(nl.daxoa, FALSE) = FALSE
ON CONFLICT (branchid) DO NOTHING;

-- Backfill đồng bộ tồn & WAC từ NguyenLieu sang TonKhoChiNhanh cho chi nhánh gốc
INSERT INTO public.tonkhochinhanh (tenantid, branchid, manl, soluongton, hanmuccanhbao, giavondonvi)
SELECT COALESCE(nl.tenantid, 'DEFAULT'),
       COALESCE(NULLIF(NULLIF(nl.branchid, ''), 'DEFAULT'), COALESCE(nl.tenantid, 'DEFAULT') || '_MAIN'),
       nl.manl,
       COALESCE(nl.soluongton, 0),
       COALESCE(nl.hanmuccanhbao, 0),
       COALESCE(nl.giavondonvi, 0)
  FROM public.nguyenlieu nl
 WHERE COALESCE(nl.daxoa, FALSE) = FALSE
ON CONFLICT (branchid, manl) DO UPDATE
   SET giavondonvi = CASE
           WHEN public.tonkhochinhanh.giavondonvi = 0 THEN EXCLUDED.giavondonvi
           ELSE public.tonkhochinhanh.giavondonvi
       END;

-- Biến ChiTietGiaoDichKho thành Sổ Cái Tồn Kho Điểm Thời Gian (Point-in-Time Ledger)
ALTER TABLE public.chitietgiaodichkho
    ADD COLUMN IF NOT EXISTS tontruoc         NUMERIC(15, 3),
    ADD COLUMN IF NOT EXISTS tonsau           NUMERIC(15, 3),
    ADD COLUMN IF NOT EXISTS giavontruoc      NUMERIC(15, 4),
    ADD COLUMN IF NOT EXISTS giavonsau        NUMERIC(15, 4),
    ADD COLUMN IF NOT EXISTS donvinhap        VARCHAR(32),
    ADD COLUMN IF NOT EXISTS hesoquydoi       NUMERIC(15, 4) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS soluongtheodonvi NUMERIC(15, 3),
    ADD COLUMN IF NOT EXISTS chiphiphanbo     NUMERIC(15, 2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ctgdkho_manl_magd
    ON public.chitietgiaodichkho (manl, magiaodich);

-- Nâng cấp Phiếu Điều Chuyển Kho hỗ trợ IN_TRANSIT & Chênh lệch thực nhận
ALTER TABLE public.phieudieuchuyenkho
    ADD COLUMN IF NOT EXISTS thoigianxuatkho  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS manvxuat         VARCHAR(50);

ALTER TABLE public.chitietdieuchuyenkho
    ADD COLUMN IF NOT EXISTS soluongthucnhan  NUMERIC(15, 3),
    ADD COLUMN IF NOT EXISTS ghichuchenhlech  TEXT;

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 2: SAFE WAC, LANDED COST, PHIẾU ĐẢO (LOAIGD=9), BTP (LOAIGD=10) & LÔ FEFO
-- ---------------------------------------------------------------------------
ALTER TABLE public.phieugiaodichkho
    ADD COLUMN IF NOT EXISTS chiphivanchuyen  NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS giamgianhacc     NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS magdthamchieu    VARCHAR(64),
    ADD COLUMN IF NOT EXISTS macathungan      TEXT,
    ADD COLUMN IF NOT EXISTS malydohuy        VARCHAR(32),
    ADD COLUMN IF NOT EXISTS trangthaiduyet   VARCHAR(24) NOT NULL DEFAULT 'POSTED',
    ADD COLUMN IF NOT EXISTS nguoiduyet       VARCHAR(50),
    ADD COLUMN IF NOT EXISTS thoidiemkiemke   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ngaychungtu      DATE,
    ADD COLUMN IF NOT EXISTS cogsadjustment   NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS mancc            VARCHAR(64),
    ADD COLUMN IF NOT EXISTS mapo             VARCHAR(64);

-- Nới lỏng CHECK constraint LoaiGD trên PhieuGiaoDichKho hỗ trợ đủ 1..10
DO $$
DECLARE
    con_name text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'phieugiaodichkho') THEN
        FOR con_name IN
            SELECT c.conname
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE n.nspname = 'public'
               AND t.relname = 'phieugiaodichkho'
               AND c.contype = 'c'
               AND pg_get_constraintdef(c.oid) ILIKE '%loaigd%'
        LOOP
            EXECUTE format('ALTER TABLE public.phieugiaodichkho DROP CONSTRAINT IF EXISTS %I', con_name);
        END LOOP;

        ALTER TABLE public.phieugiaodichkho
            ADD CONSTRAINT chk_phieugiaodichkho_loaigd
            CHECK (loaigd IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10));

        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conname = 'chk_phieugiaodichkho_trangthaiduyet'
               AND conrelid = 'public.phieugiaodichkho'::regclass
        ) THEN
            ALTER TABLE public.phieugiaodichkho
                ADD CONSTRAINT chk_phieugiaodichkho_trangthaiduyet
                CHECK (trangthaiduyet IN ('PENDING_APPROVAL', 'POSTED', 'REJECTED'));
        END IF;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pgdkho_tenant_branch_time
    ON public.phieugiaodichkho (COALESCE(tenantid, 'DEFAULT'), branchid, thoigiantao DESC);
CREATE INDEX IF NOT EXISTS idx_pgdkho_shift
    ON public.phieugiaodichkho (COALESCE(tenantid, 'DEFAULT'), macathungan)
    WHERE macathungan IS NOT NULL;

ALTER TABLE public.nguyenlieu
    ADD COLUMN IF NOT EXISTS theodoihandung   BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS manccmacdinh     VARCHAR(64);

-- Bảng Lô Nguyên Liệu & Lô Bán Thành Phẩm (FEFO + Cảnh báo Hạn dùng)
CREATE TABLE IF NOT EXISTS public.lo_tonkho (
    id               BIGSERIAL PRIMARY KEY,
    tenantid         VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    branchid         VARCHAR(64) NOT NULL,
    manl             VARCHAR(64) NOT NULL,
    malo             VARCHAR(64) NOT NULL,
    nguonlo          VARCHAR(16) NOT NULL DEFAULT 'PURCHASE'
                     CHECK (nguonlo IN ('PURCHASE', 'SUBRECIPE', 'TRANSFER')),
    magiaodichnguon  VARCHAR(64),
    soluongbandau    NUMERIC(15, 3) NOT NULL CHECK (soluongbandau > 0),
    soluongconlai    NUMERIC(15, 3) NOT NULL CHECK (soluongconlai >= 0),
    giavonlo         NUMERIC(15, 4) NOT NULL DEFAULT 0,
    ngaysanxuat      TIMESTAMPTZ NOT NULL DEFAULT now(),
    thoigianhethan   TIMESTAMPTZ,
    trangthai        VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
                     CHECK (trangthai IN ('ACTIVE', 'DEPLETED', 'EXPIRED', 'DISPOSED'))
);

CREATE INDEX IF NOT EXISTS idx_lo_tonkho_fefo
    ON public.lo_tonkho (tenantid, branchid, manl, trangthai, thoigianhethan ASC NULLS LAST, id ASC);

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 3: BOM 5 LỚP SNAPSHOT & PACKAGING BOM THEO KÊNH BÁN
-- ---------------------------------------------------------------------------
ALTER TABLE public.chitiethoadon
    ADD COLUMN IF NOT EXISTS bomsnapshotjson  JSONB;

ALTER TABLE public.cauhinh_vattu_mangdi
    ADD COLUMN IF NOT EXISTS kenhdung         VARCHAR(24) NOT NULL DEFAULT 'ALL';

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 4: UOM BARCODE + KIỂM KHO MÙ 60 GIÂY (BLIND STOCKTAKE SESSIONS)
-- ---------------------------------------------------------------------------
ALTER TABLE public.nguyenlieu_donviquydoi
    ADD COLUMN IF NOT EXISTS mavachdonvi      VARCHAR(64),
    ADD COLUMN IF NOT EXISTS lamacdinhnhap    BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS lamacdinhkiem    BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_nl_quydoi_barcode
    ON public.nguyenlieu_donviquydoi (tenantid, mavachdonvi)
    WHERE mavachdonvi IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.phien_kiemkho_mu (
    id               VARCHAR(64) PRIMARY KEY,
    tenantid         VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    branchid         VARCHAR(64) NOT NULL,
    macathungan      TEXT,
    manv             VARCHAR(50) NOT NULL,
    thoidiembatdau   TIMESTAMPTZ NOT NULL DEFAULT now(),
    trangthai        VARCHAR(24) NOT NULL DEFAULT 'OPEN'
                     CHECK (trangthai IN ('OPEN', 'SUBMITTED', 'APPROVED', 'REJECTED')),
    solandemlai      INT NOT NULL DEFAULT 0,
    magiaodich       VARCHAR(64),
    thoigiannop      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_phien_kiemkho_tenant
    ON public.phien_kiemkho_mu (tenantid, branchid, thoidiembatdau DESC);

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 5: CHỐT TỒN KEY-ITEM THEO CA (AVT THEO CA)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chotton_ca (
    id               BIGSERIAL PRIMARY KEY,
    tenantid         VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    branchid         VARCHAR(64) NOT NULL,
    macathungan      TEXT NOT NULL,
    manl             VARCHAR(64) NOT NULL,
    tondauca         NUMERIC(15, 3) NOT NULL DEFAULT 0,
    toncuoica        NUMERIC(15, 3),
    giavonca         NUMERIC(15, 4) NOT NULL DEFAULT 0,
    thoigianchot     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenantid, macathungan, manl)
);

CREATE INDEX IF NOT EXISTS idx_chotton_ca_shift
    ON public.chotton_ca (tenantid, branchid, macathungan);

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 6: NHÀ CUNG CẤP, ĐƠN ĐẶT HÀNG (AUTO-PO -> GRN) & KHÓA SỔ KHO ĐỊNH KỲ
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.nhacungcap (
    mancc            VARCHAR(64) PRIMARY KEY,
    tenantid         VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    tenncc           VARCHAR(150) NOT NULL,
    sodienthoai      VARCHAR(32),
    zalo             VARCHAR(64),
    diachi           TEXT,
    ngaygiaomacdinh  INT NOT NULL DEFAULT 1,
    danghoatdong     BOOLEAN NOT NULL DEFAULT TRUE,
    thoigiantao      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nhacungcap_tenant
    ON public.nhacungcap (tenantid, danghoatdong);

CREATE TABLE IF NOT EXISTS public.dondathang_ncc (
    mapo             VARCHAR(64) PRIMARY KEY,
    tenantid         VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    branchid         VARCHAR(64) NOT NULL,
    mancc            VARCHAR(64) REFERENCES public.nhacungcap(mancc) ON DELETE SET NULL,
    trangthai        VARCHAR(24) NOT NULL DEFAULT 'DRAFT'
                     CHECK (trangthai IN ('DRAFT', 'SENT', 'PARTIAL_RECEIVED', 'RECEIVED', 'CANCELLED')),
    tongtiendukien   NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ngaydukiennhan   DATE,
    ghichu           TEXT,
    manvtao          VARCHAR(50),
    thoigiantao      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dondathang_ncc_tenant
    ON public.dondathang_ncc (tenantid, branchid, thoigiantao DESC);

CREATE TABLE IF NOT EXISTS public.chitiet_dondathang_ncc (
    id               BIGSERIAL PRIMARY KEY,
    tenantid         VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    mapo             VARCHAR(64) NOT NULL REFERENCES public.dondathang_ncc(mapo) ON DELETE CASCADE,
    manl             VARCHAR(64) NOT NULL,
    tendonvidat      VARCHAR(32) NOT NULL,
    hesoquydoi       NUMERIC(15, 4) NOT NULL DEFAULT 1,
    soluongdat       NUMERIC(15, 3) NOT NULL CHECK (soluongdat > 0),
    soluongdanhan    NUMERIC(15, 3) NOT NULL DEFAULT 0,
    dongiadukien     NUMERIC(15, 2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ct_po_mapo
    ON public.chitiet_dondathang_ncc (tenantid, mapo);

CREATE TABLE IF NOT EXISTS public.khoaso_kho (
    id               BIGSERIAL PRIMARY KEY,
    tenantid         VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    branchid         VARCHAR(64) NOT NULL,
    ngaykhoasoden    DATE NOT NULL,
    nguoidongso      VARCHAR(50) NOT NULL,
    ghichu           TEXT,
    thoigiankhoa     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenantid, branchid, ngaykhoasoden)
);

CREATE INDEX IF NOT EXISTS idx_khoaso_kho_lookup
    ON public.khoaso_kho (tenantid, branchid, ngaykhoasoden DESC);

-- ---------------------------------------------------------------------------
-- BẢO MẬT: FAIL-CLOSED FORCE RLS + LEAST-PRIVILEGE GRANT CHO APP_RUNTIME
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'lo_tonkho',
        'phien_kiemkho_mu',
        'chotton_ca',
        'nhacungcap',
        'dondathang_ncc',
        'chitiet_dondathang_ncc',
        'khoaso_kho'
    ]
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
        EXECUTE format('DROP POLICY IF EXISTS p_tenant_isolation ON public.%I', tbl);
        EXECUTE format(
            'CREATE POLICY p_tenant_isolation ON public.%I
                USING (
                    current_setting(''app.current_tenant_id'', true) IS NOT NULL
                    AND current_setting(''app.current_tenant_id'', true) <> ''''
                    AND tenantid = current_setting(''app.current_tenant_id'', true)
                )
                WITH CHECK (
                    current_setting(''app.current_tenant_id'', true) IS NOT NULL
                    AND current_setting(''app.current_tenant_id'', true) <> ''''
                    AND tenantid = current_setting(''app.current_tenant_id'', true)
                )',
            tbl
        );
    END LOOP;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
            public.lo_tonkho,
            public.phien_kiemkho_mu,
            public.chotton_ca,
            public.nhacungcap,
            public.dondathang_ncc,
            public.chitiet_dondathang_ncc,
            public.khoaso_kho
        TO app_runtime;

        GRANT USAGE, SELECT ON SEQUENCE
            public.lo_tonkho_id_seq,
            public.chotton_ca_id_seq,
            public.chitiet_dondathang_ncc_id_seq,
            public.khoaso_kho_id_seq
        TO app_runtime;
    END IF;
END $$;

COMMIT;
