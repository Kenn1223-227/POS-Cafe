-- =============================================================================
-- MIGRATION 023: NÂNG CẤP PHÂN HỆ 1 (FRONT-OF-HOUSE & ORDER ENGINE) LÊN 100/100
--   Trụ cột 1: Modifiers có cấu trúc (Forced Modifiers, Smart Defaults),
--              Topping giới hạn/giá lũy tiến & Substitution BOM (+/- nguyên liệu)
--   Trụ cột 2: Topping-per-Cup (ChiTietHoaDon_Topping.SoLuongMoiLy)
--   Trụ cột 3: Động cơ Combo / Bundle phân bổ Pro-rata & Trừ kho từng món con
--   Trụ cột 4: Sơ đồ bàn nâng cao, Tách bill 3 kiểu (HoaDon_ChiaTien),
--              Gộp bàn MERGED (TrangThaiTT=3), Đặt bàn trước (DatBan)
--   Trụ cột 5: Đa luồng Counter/Table (LoaiDonHang, SoTheRung, SoThuTuHienThi,
--              DotGoi, IsTakeaway, Course Firing, CauHinh_VatTu_MangDi, Park=-1)
--   Trụ cột 6: Concurrency (HoaDon.Version), Thuế VAT, Phí phục vụ, Làm tròn,
--              Chiết khấu từng món, Món tặng 0đ, Open Item & Cân ký
--   Bảo mật:   Fail-Closed FORCE RLS + GRANT Least-Privilege cho app_runtime
-- An toàn chạy lặp lại nhiều lần (Idempotent).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 1: KIẾN TRÚC MODIFIERS CÓ CẤU TRÚC, TOPPING LŨY TIẾN & SUBSTITUTION BOM
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.modifier_groups (
    id              BIGSERIAL PRIMARY KEY,
    tenantid        VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    tengroup        VARCHAR(80) NOT NULL,
    loai            VARCHAR(20) NOT NULL DEFAULT 'SINGLE' CHECK (loai IN ('SINGLE', 'MULTI')),
    batbuoc         BOOLEAN NOT NULL DEFAULT FALSE,
    chontoithieu    INT NOT NULL DEFAULT 0 CHECK (chontoithieu >= 0),
    chontoida       INT NOT NULL DEFAULT 1 CHECK (chontoida >= 1),
    soluongmienphi  INT NOT NULL DEFAULT 0 CHECK (soluongmienphi >= 0),
    thutuhienthi    INT NOT NULL DEFAULT 0,
    danghoatdong    BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_modifier_groups_tenant
    ON public.modifier_groups (tenantid, danghoatdong, thutuhienthi);

CREATE TABLE IF NOT EXISTS public.modifier_options (
    id                  BIGSERIAL PRIMARY KEY,
    tenantid            VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    groupid             BIGINT NOT NULL REFERENCES public.modifier_groups(id) ON DELETE CASCADE,
    tenoption           VARCHAR(80) NOT NULL,
    teninngan           VARCHAR(24),
    lamacdinh           BOOLEAN NOT NULL DEFAULT FALSE,
    giacongthem         NUMERIC(15, 2) NOT NULL DEFAULT 0,
    toidasoluong        INT NOT NULL DEFAULT 1 CHECK (toidasoluong >= 1),
    tamhet              BOOLEAN NOT NULL DEFAULT FALSE,
    thutuhienthi        INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_modifier_options_group
    ON public.modifier_options (tenantid, groupid, thutuhienthi);

CREATE TABLE IF NOT EXISTS public.modifier_option_bom (
    id                  BIGSERIAL PRIMARY KEY,
    tenantid            VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    optionid            BIGINT NOT NULL REFERENCES public.modifier_options(id) ON DELETE CASCADE,
    kichthuoc           VARCHAR(10),
    manl                VARCHAR(64) NOT NULL,
    khoiluongdelta      NUMERIC(15, 3) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_modifier_option_bom_opt
    ON public.modifier_option_bom (tenantid, optionid);

CREATE TABLE IF NOT EXISTS public.sanpham_modifier_groups (
    tenantid        VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    mamon           VARCHAR(50) NOT NULL,
    groupid         BIGINT NOT NULL REFERENCES public.modifier_groups(id) ON DELETE CASCADE,
    thutuhienthi    INT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenantid, mamon, groupid)
);

CREATE INDEX IF NOT EXISTS idx_sp_mod_groups_mamon
    ON public.sanpham_modifier_groups (tenantid, mamon, thutuhienthi);

-- Nâng cấp bảng Topping: giới hạn số lượng/ly & bảng giá lũy tiến (Tiered Pricing)
ALTER TABLE public.topping
    ADD COLUMN IF NOT EXISTS toidamoily   INT NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS giabacthang  JSONB;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_topping_toidamoily'
           AND conrelid = 'public.topping'::regclass
    ) THEN
        ALTER TABLE public.topping
            ADD CONSTRAINT chk_topping_toidamoily CHECK (toidamoily >= 1);
    END IF;
END $$;

-- Snapshot bất biến Modifiers trên ChiTietHoaDon
ALTER TABLE public.chitiethoadon
    ADD COLUMN IF NOT EXISTS modifierssnapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS giamodifiers      NUMERIC(15, 2) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 2: CHUẨN HÓA TOPPING-PER-CUP (SoLuongMoiLy)
-- ---------------------------------------------------------------------------
ALTER TABLE public.chitiethoadon_topping
    ADD COLUMN IF NOT EXISTS soluongmoily INT NOT NULL DEFAULT 1;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_cthd_tp_soluongmoily'
           AND conrelid = 'public.chitiethoadon_topping'::regclass
    ) THEN
        ALTER TABLE public.chitiethoadon_topping
            ADD CONSTRAINT chk_cthd_tp_soluongmoily CHECK (soluongmoily >= 1);
    END IF;
END $$;

-- Backfill soluongmoily cho dữ liệu cũ (nếu SoLuong chia hết cho SoLuong ly của ChiTietHoaDon)
UPDATE public.chitiethoadon_topping ctp
   SET soluongmoily = GREATEST(1, ROUND(ctp.soluong::numeric / GREATEST(1, c.soluong))::int)
  FROM public.chitiethoadon c
 WHERE c.macthd = ctp.macthd
   AND ctp.soluongmoily = 1
   AND c.soluong > 0
   AND ctp.soluong > c.soluong;

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 3: ĐỘNG CƠ COMBO / BUNDLE PHÂN BỔ PRO-RATA & TRỪ KHO TỪNG MÓN CON
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.combo (
    macombo          VARCHAR(50) PRIMARY KEY,
    tenantid         VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    tencombo         VARCHAR(150) NOT NULL,
    giabancombo      NUMERIC(15, 2) NOT NULL CHECK (giabancombo >= 0),
    khunggiotu       VARCHAR(5),
    khunggioden      VARCHAR(5),
    dangkinhdoanh    BOOLEAN NOT NULL DEFAULT TRUE,
    thoigiantao      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_combo_tenant_active
    ON public.combo (tenantid, dangkinhdoanh);

CREATE TABLE IF NOT EXISTS public.combo_slots (
    id              BIGSERIAL PRIMARY KEY,
    tenantid        VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    macombo         VARCHAR(50) NOT NULL REFERENCES public.combo(macombo) ON DELETE CASCADE,
    tenslot         VARCHAR(80) NOT NULL,
    soluongchon     INT NOT NULL DEFAULT 1 CHECK (soluongchon >= 1),
    thutuhienthi    INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_combo_slots_combo
    ON public.combo_slots (tenantid, macombo, thutuhienthi);

CREATE TABLE IF NOT EXISTS public.combo_slot_items (
    id                  BIGSERIAL PRIMARY KEY,
    tenantid            VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    slotid              BIGINT NOT NULL REFERENCES public.combo_slots(id) ON DELETE CASCADE,
    mamon               VARCHAR(50) NOT NULL,
    kichthuocmacdinh    VARCHAR(10) NOT NULL DEFAULT 'M',
    chophepdoikichthuoc BOOLEAN NOT NULL DEFAULT TRUE,
    phuthu              NUMERIC(15, 2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_combo_slot_items_slot
    ON public.combo_slot_items (tenantid, slotid);

ALTER TABLE public.chitiethoadon
    ADD COLUMN IF NOT EXISTS combogroupuid     VARCHAR(64),
    ADD COLUMN IF NOT EXISTS macombo           VARCHAR(50),
    ADD COLUMN IF NOT EXISTS tencombosnapshot  VARCHAR(150),
    ADD COLUMN IF NOT EXISTS giagocniemyet     NUMERIC(15, 2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_cthd_combogroup
    ON public.chitiethoadon (mahoadon, combogroupuid)
    WHERE combogroupuid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 4: SƠ ĐỒ BÀN, TÁCH 3 KIỂU (HoaDon_ChiaTien), GỘP BÀN (MERGED), ĐẶT BÀN
-- ---------------------------------------------------------------------------
-- Mở rộng HoaDon.TrangThaiTT: -1=PARKED, 0=OPEN, 1=PAID, 2=REFUNDED, 3=MERGED
DO $$
DECLARE
    con_name text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'hoadon') THEN
        FOR con_name IN
            SELECT c.conname
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE n.nspname = 'public'
               AND t.relname = 'hoadon'
               AND c.contype = 'c'
               AND pg_get_constraintdef(c.oid) ILIKE '%trangthaitt%'
        LOOP
            EXECUTE format('ALTER TABLE public.hoadon DROP CONSTRAINT IF EXISTS %I', con_name);
        END LOOP;

        ALTER TABLE public.hoadon
            ADD CONSTRAINT chk_hoadon_trangthaitt CHECK (TrangThaiTT IN (-1, 0, 1, 2, 3));
    END IF;
END $$;

ALTER TABLE public.hoadon
    ADD COLUMN IF NOT EXISTS mergedintomahoadon VARCHAR(64),
    ADD COLUMN IF NOT EXISTS parentmahoadon     VARCHAR(64),
    ADD COLUMN IF NOT EXISTS sokhach            INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS thoigianmoban      TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_hoadon_sokhach'
           AND conrelid = 'public.hoadon'::regclass
    ) THEN
        ALTER TABLE public.hoadon
            ADD CONSTRAINT chk_hoadon_sokhach CHECK (sokhach >= 1);
    END IF;
END $$;

-- Bảng Chia tiền Hóa đơn (Tách kiểu 2: Chia đều N người & Kiểu 3: Theo số tiền tùy ý)
CREATE TABLE IF NOT EXISTS public.hoadon_chiatien (
    id              BIGSERIAL PRIMARY KEY,
    tenantid        VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    mahoadon        TEXT NOT NULL,
    nhanchia        VARCHAR(40) NOT NULL,
    sotienphaitra   NUMERIC(15, 2) NOT NULL CHECK (sotienphaitra > 0),
    sotiendatra     NUMERIC(15, 2) NOT NULL DEFAULT 0,
    trangthai       VARCHAR(16) NOT NULL DEFAULT 'UNPAID' CHECK (trangthai IN ('UNPAID', 'PAID', 'CANCELLED')),
    thoigiantao     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hd_chiatien
    ON public.hoadon_chiatien (tenantid, mahoadon, trangthai);

ALTER TABLE public.order_payments
    ADD COLUMN IF NOT EXISTS chiatienid BIGINT REFERENCES public.hoadon_chiatien(id) ON DELETE SET NULL;

-- Bảng Đặt bàn trước (Khớp hoàn toàn với Ban.TrangThai = 4)
CREATE TABLE IF NOT EXISTS public.datban (
    madatban        VARCHAR(64) PRIMARY KEY,
    tenantid        VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    branchid        VARCHAR(64),
    maban           VARCHAR(50) NOT NULL,
    tenkhach        VARCHAR(120) NOT NULL,
    sodienthoai     VARCHAR(32) NOT NULL,
    sokhach         INT NOT NULL DEFAULT 2 CHECK (sokhach >= 1),
    thoigianden     TIMESTAMPTZ NOT NULL,
    tiencoc         NUMERIC(15, 2) NOT NULL DEFAULT 0,
    trangthai       VARCHAR(24) NOT NULL DEFAULT 'CONFIRMED'
                    CHECK (trangthai IN ('CONFIRMED', 'ARRIVED', 'CANCELLED', 'NO_SHOW')),
    ghichu          TEXT,
    mahoadon        VARCHAR(64),
    thoigiantao     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_datban_upcoming
    ON public.datban (tenantid, branchid, trangthai, thoigianden);

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 5: ĐA LUỒNG VẬN HÀNH (ORDER TYPE, THẺ RUNG, DOTGOI, COURSE FIRING, PACKAGING BOM)
-- ---------------------------------------------------------------------------
ALTER TABLE public.hoadon
    ADD COLUMN IF NOT EXISTS loaidonhang     VARCHAR(20) NOT NULL DEFAULT 'TAI_QUAN',
    ADD COLUMN IF NOT EXISTS sotherung       VARCHAR(16),
    ADD COLUMN IF NOT EXISTS sothutuhienthi  VARCHAR(16),
    ADD COLUMN IF NOT EXISTS phidonggoi      NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS diachigiao      TEXT,
    ADD COLUMN IF NOT EXISTS tenkhachvanglai VARCHAR(100);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_hoadon_loaidonhang'
           AND conrelid = 'public.hoadon'::regclass
    ) THEN
        ALTER TABLE public.hoadon
            ADD CONSTRAINT chk_hoadon_loaidonhang
            CHECK (loaidonhang IN ('TAI_QUAN', 'MANG_DI', 'GIAO_HANG', 'APP_SAN'));
    END IF;
END $$;

ALTER TABLE public.chitiethoadon
    ADD COLUMN IF NOT EXISTS dotgoi          INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS istakeaway      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS courseno        INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS firestatus      VARCHAR(16) NOT NULL DEFAULT 'FIRED',
    ADD COLUMN IF NOT EXISTS firedat         TIMESTAMPTZ DEFAULT now();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_cthd_firestatus'
           AND conrelid = 'public.chitiethoadon'::regclass
    ) THEN
        ALTER TABLE public.chitiethoadon
            ADD CONSTRAINT chk_cthd_firestatus
            CHECK (firestatus IN ('HELD', 'FIRED'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cthd_firestatus
    ON public.chitiethoadon (mahoadon, firestatus, courseno);

-- Cấu hình vật tư đóng gói tự động trừ kho khi món là Takeaway
CREATE TABLE IF NOT EXISTS public.cauhinh_vattu_mangdi (
    tenantid          VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    kichthuoc         VARCHAR(10) NOT NULL,
    manl              VARCHAR(64) NOT NULL,
    soluongtieuhao    NUMERIC(15, 3) NOT NULL CHECK (soluongtieuhao > 0),
    PRIMARY KEY (tenantid, kichthuoc, manl)
);

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 6: CONCURRENCY (OPTIMISTIC LOCKING), THUẾ/PHÍ, MÓN TẶNG & OPEN ITEM
-- ---------------------------------------------------------------------------
ALTER TABLE public.hoadon
    ADD COLUMN IF NOT EXISTS version            INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS cachtinhthue       VARCHAR(16) NOT NULL DEFAULT 'INCLUDED',
    ADD COLUMN IF NOT EXISTS thuevatphantram    NUMERIC(5, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tienthuevat        NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS phiphucvuphantram  NUMERIC(5, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tienphiphucvu      NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tienlamtron        NUMERIC(15, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_hoadon_cachtinhthue'
           AND conrelid = 'public.hoadon'::regclass
    ) THEN
        ALTER TABLE public.hoadon
            ADD CONSTRAINT chk_hoadon_cachtinhthue
            CHECK (cachtinhthue IN ('INCLUDED', 'EXCLUDED', 'NONE'));
    END IF;
END $$;

ALTER TABLE public.chitiethoadon
    ADD COLUMN IF NOT EXISTS chietkhaumon       NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lamontang          BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS lydotang           TEXT,
    ADD COLUMN IF NOT EXISTS trongluonggram     NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS tenmontuychinh     VARCHAR(150);

ALTER TABLE public.sanpham
    ADD COLUMN IF NOT EXISTS lamonthoigia       BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS donvibanhang       VARCHAR(16) NOT NULL DEFAULT 'LY';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_sanpham_donvibanhang'
           AND conrelid = 'public.sanpham'::regclass
    ) THEN
        ALTER TABLE public.sanpham
            ADD CONSTRAINT chk_sanpham_donvibanhang
            CHECK (donvibanhang IN ('LY', 'CAI', 'GRAM', 'KG'));
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- BẬT FAIL-CLOSED FORCE RLS & CẤP QUYỀN LEAST-PRIVILEGE CHO APP_RUNTIME
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    tbl TEXT;
    new_tables TEXT[] := ARRAY[
        'modifier_groups',
        'modifier_options',
        'modifier_option_bom',
        'sanpham_modifier_groups',
        'combo',
        'combo_slots',
        'combo_slot_items',
        'hoadon_chiatien',
        'datban',
        'cauhinh_vattu_mangdi'
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

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime';
        EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime';
    END IF;
END $$;

COMMIT;
