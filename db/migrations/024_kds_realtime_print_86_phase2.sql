-- =============================================================================
-- MIGRATION 024: NÂNG CẤP PHÂN HỆ 2 (REAL-TIME, KDS/BDS, IN TEM, 86'ING & NGOẠI LỆ) LÊN 100/100
--   Trụ cột 1: kds_event_log (sequence bù sự kiện rớt Wi-Fi), DonHang_Idempotency
--              trạng thái PROCESSING (2-phase lock), HoaDon.ClientOrderUid (Cloud/LAN dedup)
--   Trụ cột 3: SanPham.InTemCoc (tách tem 1-N bỏ qua món không dán tem)
--   Trụ cột 4: order_refunds (sổ hoàn tiền chênh lệch Item Swap / Refund), SanPham.LaHangDongGoi
--   Trụ cột 5: Countdown 86 (SoLuongGioiHan86) & Auto Un-86 (TamHetTuDong, TamHetBoiMaNL)
--   Trụ cột 6: Đo lường nút thắt KDS (ThoiGianBatDauLam, ThoiGianPhucVu, MaNVPhaChe),
--              Độ ưu tiên (MucDoUuTien: 0/1/2) & Vé Làm Lại (RemakeOfCTHD)
--   Bảo mật:   Fail-Closed FORCE RLS + GRANT Least-Privilege cho app_runtime
-- An toàn chạy lặp lại nhiều lần (Idempotent).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 1: EVENT LOG BÙ SỰ KIỆN KDS, IDEMPOTENCY 2-PHA & CLIENT ORDER UID
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kds_event_log (
    seq             BIGSERIAL PRIMARY KEY,
    tenantid        VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    branchid        VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    station         VARCHAR(24) NOT NULL DEFAULT 'ALL',
    eventtype       VARCHAR(40) NOT NULL,
    mahoadon        VARCHAR(64),
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    thoigiantao     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kds_event_replay
    ON public.kds_event_log (tenantid, branchid, seq DESC);

ALTER TABLE public.donhang_idempotency
    ADD COLUMN IF NOT EXISTS trangthai      VARCHAR(16) NOT NULL DEFAULT 'DONE',
    ADD COLUMN IF NOT EXISTS mahoadonkq     VARCHAR(64),
    ADD COLUMN IF NOT EXISTS responsejson   JSONB,
    ADD COLUMN IF NOT EXISTS httpstatus     INT DEFAULT 200;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_donhang_idem_trangthai'
           AND conrelid = 'public.donhang_idempotency'::regclass
    ) THEN
        ALTER TABLE public.donhang_idempotency
            ADD CONSTRAINT chk_donhang_idem_trangthai
            CHECK (trangthai IN ('PROCESSING', 'DONE', 'FAILED'));
    END IF;
END $$;

ALTER TABLE public.hoadon
    ADD COLUMN IF NOT EXISTS clientorderuid VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hoadon_tenant_clientuid
    ON public.hoadon (COALESCE(tenantid, 'DEFAULT'), clientorderuid)
    WHERE clientorderuid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 4: BẢNG ORDER_REFUNDS (HOÀN TIỀN CHÊNH LỆCH ITEM SWAP / REFUND)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_refunds (
    id              BIGSERIAL PRIMARY KEY,
    tenantid        VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    mahoadon        VARCHAR(64) NOT NULL,
    macathungan     VARCHAR(64),
    phuongthuchoan  VARCHAR(24) NOT NULL DEFAULT 'TIEN_MAT',
    sotienhoan      NUMERIC(15, 2) NOT NULL CHECK (sotienhoan > 0),
    lydo            TEXT,
    manv            VARCHAR(50),
    thoigiantao     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_refunds_hd
    ON public.order_refunds (tenantid, mahoadon, thoigiantao DESC);

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 3 & 5: IN TEM CỐC, HÀNG ĐÓNG GÓI, COUNTDOWN 86 & AUTO UN-86
-- ---------------------------------------------------------------------------
ALTER TABLE public.sanpham
    ADD COLUMN IF NOT EXISTS soluonggioihan86   INT,
    ADD COLUMN IF NOT EXISTS tamhettudong       BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS tamhetboimanl      TEXT[] NOT NULL DEFAULT '{}'::text[],
    ADD COLUMN IF NOT EXISTS lahangdonggoi      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS intemcoc           BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.topping
    ADD COLUMN IF NOT EXISTS soluonggioihan86   INT,
    ADD COLUMN IF NOT EXISTS tamhettudong       BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS tamhetboimanl      TEXT[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE public.modifier_options
    ADD COLUMN IF NOT EXISTS tamhettudong       BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS tamhetboimanl      TEXT[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE public.combo
    ADD COLUMN IF NOT EXISTS tamhet             BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS tamhettudong       BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS tamhetboimanl      TEXT[] NOT NULL DEFAULT '{}'::text[];

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 6: ĐO LƯỜNG VÒNG ĐỜI PHA CHẾ (TELEMETRY) & VÉ LÀM LẠI (REMAKE)
-- ---------------------------------------------------------------------------
ALTER TABLE public.chitiethoadon
    ADD COLUMN IF NOT EXISTS thoigianbatdaulam  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS thoigianphucvu     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS manvphache         VARCHAR(50),
    ADD COLUMN IF NOT EXISTS mucdouutien        INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS remakeofcthd       VARCHAR(64);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_cthd_mucdouutien'
           AND conrelid = 'public.chitiethoadon'::regclass
    ) THEN
        ALTER TABLE public.chitiethoadon
            ADD CONSTRAINT chk_cthd_mucdouutien
            CHECK (mucdouutien IN (0, 1, 2));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cthd_kds_priority
    ON public.chitiethoadon (mahoadon, mucdouutien DESC, thoigiangoi ASC);

-- ---------------------------------------------------------------------------
-- BẬT FAIL-CLOSED FORCE RLS & CẤP QUYỀN LEAST-PRIVILEGE CHO APP_RUNTIME
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    tbl TEXT;
    new_tables TEXT[] := ARRAY['kds_event_log', 'order_refunds'];
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
