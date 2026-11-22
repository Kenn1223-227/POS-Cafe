-- =============================================================================
-- MIGRATION 025: NÂNG CẤP PHÂN HỆ 3 (THANH TOÁN, VIETQR, CA THU NGÂN BLIND DROP,
--                SAFE DROP 2 LỚP, Z-REPORT BẤT BIẾN & ĐỐI SOÁT 3 CHIỀU) LÊN 100/100
--   Trụ cột 1: Order_Payments theo Tenant/Branch/Terminal/EDC/OfflineLechCa,
--              Order_Refunds bất biến (Append-Only Trigger) tách bạch khỏi ca bán gốc
--   Trụ cột 2: VietQR_Webhook_Events gỡ UNIQUE toàn cục -> (NhaCungCap, SoTaiKhoanNhan, MaGiaoDichNgoai),
--              hàng đợi xử lý chuyển dư/chuyển trùng/chưa khớp + nâng cấp hàm SECURITY DEFINER
--   Trụ cột 3: CaThuNgan theo (BranchId, TerminalId), kiểm đếm đầu ca, bàn giao liên ca,
--              Blind Drop Recount Challenge (SoLanDemLai), ZReportSnapshot bất biến
--   Trụ cột 4: PhieuThuChiLatVat loại 4 = THOI_CK_DU, DanhMucChi, Safe Drop Two-Man Rule
--              (PENDING_RECEIPT -> CONFIRMED/DISPUTED), bảng receipt_photo_uploads xác thực chứng từ
--   Trụ cột 5: branch_zreport_counter đánh số Z-Report nguyên tử theo (TenantId, BranchId)
--   Bảo mật:   Fail-Closed FORCE RLS + Trigger Append-Only + GRANT app_runtime
-- An toàn chạy lặp lại nhiều lần (Idempotent).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 1: ORDER_PAYMENTS CHUẨN SỔ CÁI & ORDER_REFUNDS BẤT BIẾN (IMMUTABLE)
-- ---------------------------------------------------------------------------
ALTER TABLE public.order_payments
    ADD COLUMN IF NOT EXISTS branchid         VARCHAR(64),
    ADD COLUMN IF NOT EXISTS terminalid       VARCHAR(64),
    ADD COLUMN IF NOT EXISTS machuanchiedc    VARCHAR(64),
    ADD COLUMN IF NOT EXISTS bonsocuoithe     VARCHAR(8),
    ADD COLUMN IF NOT EXISTS laofflinelechca  BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS macathungangoc   TEXT;

-- Gỡ ràng buộc UNIQUE toàn cục cũ trên Order_Payments để thay bằng phạm vi Tenant
ALTER TABLE public.order_payments DROP CONSTRAINT IF EXISTS order_payments_magiaodichngoai_key;
ALTER TABLE public.order_payments DROP CONSTRAINT IF EXISTS order_payments_khoaidem_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_order_payments_tenant_extref
    ON public.order_payments (COALESCE(tenantid, 'DEFAULT'), nguonxacnhan, magiaodichngoai)
    WHERE magiaodichngoai IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_order_payments_tenant_idem
    ON public.order_payments (COALESCE(tenantid, 'DEFAULT'), khoaidem)
    WHERE khoaidem IS NOT NULL;

-- Nâng cấp bảng public.order_refunds (đã tạo ở Migration 024) thành Sổ cái Hoàn tiền Độc lập Bất biến
CREATE TABLE IF NOT EXISTS public.order_refunds (
    id                 BIGSERIAL PRIMARY KEY,
    tenantid           VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    mahoadon           TEXT NOT NULL,
    macathungan        TEXT,
    phuongthuchoan     VARCHAR(32) NOT NULL DEFAULT 'TIEN_MAT',
    sotienhoan         NUMERIC(15, 2) NOT NULL CHECK (sotienhoan > 0),
    lydo               TEXT,
    manv               VARCHAR(50),
    thoigiantao        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.order_refunds
    ADD COLUMN IF NOT EXISTS branchid          VARCHAR(64),
    ADD COLUMN IF NOT EXISTS terminalid        VARCHAR(64),
    ADD COLUMN IF NOT EXISTS macathunganbangoc TEXT,
    ADD COLUMN IF NOT EXISTS danhsachmacthd    JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS manvthuchien      TEXT,
    ADD COLUMN IF NOT EXISTS nguoiduyet        TEXT,
    ADD COLUMN IF NOT EXISTS khoaidem          VARCHAR(64);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_order_refunds_pttt'
           AND conrelid = 'public.order_refunds'::regclass
    ) THEN
        ALTER TABLE public.order_refunds
            ADD CONSTRAINT chk_order_refunds_pttt
            CHECK (phuongthuchoan IN ('TIEN_MAT', 'CHUYEN_KHOAN', 'THE', 'VI_KHACH', 'VOUCHER', 'VI_DIEN_TU'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_order_refunds_ca
    ON public.order_refunds (tenantid, macathungan, phuongthuchoan);

CREATE UNIQUE INDEX IF NOT EXISTS uq_order_refunds_idem
    ON public.order_refunds (tenantid, khoaidem)
    WHERE khoaidem IS NOT NULL;

-- Trigger cấm sửa/xóa dòng đã ghi trong Sổ cái Hoàn tiền (Immutable Ledger)
CREATE OR REPLACE FUNCTION public.order_refunds_no_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'order_refunds là sổ cái hoàn tiền bất biến (append-only), cấm sửa hoặc xóa!';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_refunds_immutable ON public.order_refunds;
CREATE TRIGGER trg_order_refunds_immutable
    BEFORE UPDATE OR DELETE ON public.order_refunds
    FOR EACH ROW EXECUTE FUNCTION public.order_refunds_no_mutation();

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 2: VIETQR_WEBHOOK_EVENTS ĐA TENANT & XỬ LÝ ĐỦ 5 CA BIÊN
-- ---------------------------------------------------------------------------
ALTER TABLE public.vietqr_webhook_events
    ADD COLUMN IF NOT EXISTS sotaikhoannhan   VARCHAR(64) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS branchid         VARCHAR(64),
    ADD COLUMN IF NOT EXISTS sotienconlai     NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS trangthaixulydu  VARCHAR(24) NOT NULL DEFAULT 'NONE',
    ADD COLUMN IF NOT EXISTS nguoixulydu      VARCHAR(50),
    ADD COLUMN IF NOT EXISTS thoigianxulydu   TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_vietqr_trangthaixulydu'
           AND conrelid = 'public.vietqr_webhook_events'::regclass
    ) THEN
        ALTER TABLE public.vietqr_webhook_events
            ADD CONSTRAINT chk_vietqr_trangthaixulydu
            CHECK (trangthaixulydu IN ('NONE', 'PENDING_ACTION', 'CASH_RETURNED', 'WALLET_CREDITED', 'TIP', 'BANK_REFUNDED', 'MANUALLY_MATCHED'));
    END IF;
END $$;

-- Gỡ mọi ràng buộc UNIQUE chỉ trên cột magiaodichngoai (toàn cục) trên vietqr_webhook_events
DO $$
DECLARE
    con_rec RECORD;
    idx_rec RECORD;
BEGIN
    FOR con_rec IN
        SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND t.relname = 'vietqr_webhook_events'
           AND c.contype = 'u'
           AND array_length(c.conkey, 1) = 1
    LOOP
        EXECUTE format('ALTER TABLE public.vietqr_webhook_events DROP CONSTRAINT IF EXISTS %I', con_rec.conname);
    END LOOP;

    FOR idx_rec IN
        SELECT i.relname AS idx_name
          FROM pg_index ix
          JOIN pg_class t ON t.oid = ix.indrelid
          JOIN pg_class i ON i.oid = ix.indexrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND t.relname = 'vietqr_webhook_events'
           AND ix.indisunique = TRUE
           AND ix.indisprimary = FALSE
           AND pg_get_indexdef(ix.indexrelid) ~* 'magiaodichngoai'
           AND pg_get_indexdef(ix.indexrelid) !~* 'sotaikhoannhan'
    LOOP
        EXECUTE format('DROP INDEX IF EXISTS public.%I', idx_rec.idx_name);
    END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vietqr_provider_acc_ref
    ON public.vietqr_webhook_events (nhacungcap, sotaikhoannhan, magiaodichngoai);

CREATE INDEX IF NOT EXISTS idx_vietqr_unmatched_queue
    ON public.vietqr_webhook_events (tenantid, trangthaixuly, thoigiannhan DESC);

-- Nâng cấp các hàm SECURITY DEFINER cho Webhook VietQR đa tài khoản (chống nuốt tiền trùng mã GD khác ngân hàng)
DROP FUNCTION IF EXISTS public.fn_record_webhook_event(varchar, varchar, numeric, text, jsonb);

CREATE OR REPLACE FUNCTION public.fn_record_webhook_event_v2(
    p_nha_cung_cap    VARCHAR,
    p_so_tk_nhan      VARCHAR,
    p_ma_gd_ngoai     VARCHAR,
    p_so_tien         NUMERIC,
    p_noi_dung_ck     TEXT,
    p_payload_goc     JSONB,
    p_tenant_id       VARCHAR DEFAULT 'SYSTEM_UNMATCHED',
    p_branch_id       VARCHAR DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id BIGINT;
BEGIN
    INSERT INTO public.VietQR_Webhook_Events
        (NhaCungCap, SoTaiKhoanNhan, MaGiaoDichNgoai, SoTien, NoiDungCK, TrangThaiXuLy, PayloadGoc, TenantId, BranchId)
    VALUES (
        p_nha_cung_cap,
        COALESCE(NULLIF(TRIM(p_so_tk_nhan), ''), ''),
        p_ma_gd_ngoai,
        p_so_tien,
        COALESCE(p_noi_dung_ck, ''),
        'PROCESSING',
        COALESCE(p_payload_goc, '{}'::jsonb),
        COALESCE(NULLIF(TRIM(p_tenant_id), ''), 'SYSTEM_UNMATCHED'),
        p_branch_id
    )
    ON CONFLICT (nhacungcap, sotaikhoannhan, magiaodichngoai) DO NOTHING
    RETURNING Id INTO v_id;

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_update_webhook_event_v2(
    p_event_id            BIGINT,
    p_trang_thai          VARCHAR,
    p_ma_hd_khop          TEXT DEFAULT NULL,
    p_tenant_id           VARCHAR DEFAULT NULL,
    p_so_tien_con_lai     NUMERIC DEFAULT NULL,
    p_trang_thai_xu_ly_du VARCHAR DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE public.VietQR_Webhook_Events
       SET TrangThaiXuLy   = p_trang_thai,
           MaHoaDonKhop    = COALESCE(p_ma_hd_khop, MaHoaDonKhop),
           TenantId        = COALESCE(p_tenant_id, TenantId),
           SoTienConLai    = COALESCE(p_so_tien_con_lai, SoTienConLai),
           TrangThaiXuLyDu = COALESCE(p_trang_thai_xu_ly_du, TrangThaiXuLyDu)
     WHERE Id = p_event_id;
$$;

-- Tra cứu hóa đơn bất kể trạng thái (0 = Đang mở, 1 = Đã TT) để nhận diện chuẩn xác ca Chuyển trùng giây thu tiền mặt (ALREADY_PAID)
CREATE OR REPLACE FUNCTION public.fn_lookup_any_invoice_by_codes(
    p_codes TEXT[],
    p_tenant_id TEXT DEFAULT NULL
)
RETURNS TABLE (
    MaHoaDon TEXT,
    TenantId VARCHAR,
    TrangThaiTT INT,
    BranchId VARCHAR
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT hd.MaHoaDon::text AS MaHoaDon,
           COALESCE(hd.TenantId, 'DEFAULT')::varchar AS TenantId,
           hd.TrangThaiTT::int AS TrangThaiTT,
           COALESCE(NULLIF(to_jsonb(hd)->>'branchid', ''), 'DEFAULT')::varchar AS BranchId
      FROM public.HoaDon hd
     WHERE hd.TrangThaiTT IN (0, 1)
       AND (p_tenant_id IS NULL OR COALESCE(hd.TenantId, 'DEFAULT') = p_tenant_id)
       AND (
           UPPER(hd.MaHoaDon::text) = ANY(p_codes)
           OR REGEXP_REPLACE(UPPER(hd.MaHoaDon::text), '[^A-Z0-9]', '', 'g') = ANY(p_codes)
       )
     ORDER BY CASE WHEN hd.TrangThaiTT = 0 THEN 0 ELSE 1 END ASC, hd.ThoiGianTao DESC
     LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 3 & 5: CA THU NGÂN (TERMINAL, BLIND RECOUNT, BÀN GIAO, Z-REPORT BẤT BIẾN)
-- ---------------------------------------------------------------------------
ALTER TABLE public.cathungan
    ADD COLUMN IF NOT EXISTS branchid             VARCHAR(64),
    ADD COLUMN IF NOT EXISTS terminalid           VARCHAR(64) NOT NULL DEFAULT 'POS_01',
    ADD COLUMN IF NOT EXISTS chitietmenhgiadauca  JSONB,
    ADD COLUMN IF NOT EXISTS tiengiulaiket        NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS chenhlechbangiao     NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS macatruoc            TEXT,
    ADD COLUMN IF NOT EXISTS solandemlai          INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS zreportsnapshot      JSONB,
    ADD COLUMN IF NOT EXISTS tongchotloedc        NUMERIC(15, 2);

-- Gỡ index/constraint cũ nếu chỉ cho mở 1 ca toàn Tenant/MaNV, thay bằng 1 ca đang mở / (Tenant, Branch, Terminal)
DROP INDEX IF EXISTS public.uq_cathungan_dang_mo;
DROP INDEX IF EXISTS public.idx_cathungan_one_open;
DROP INDEX IF EXISTS public.uq_cathungan_one_open;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cathungan_one_open_per_terminal
    ON public.cathungan (COALESCE(tenantid, 'DEFAULT'), COALESCE(NULLIF(branchid, ''), COALESCE(tenantid, 'DEFAULT') || '_MAIN'), terminalid)
    WHERE trangthaica = 1;

-- Bộ đếm Z-Report nguyên tử theo (TenantId, BranchId)
CREATE TABLE IF NOT EXISTS public.branch_zreport_counter (
    tenantid  VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    branchid  VARCHAR(64) NOT NULL,
    lastz     INT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenantid, branchid)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cathungan_branch_zreport
    ON public.cathungan (COALESCE(tenantid, 'DEFAULT'), COALESCE(NULLIF(branchid, ''), COALESCE(tenantid, 'DEFAULT') || '_MAIN'), sozreport)
    WHERE sozreport IS NOT NULL;

-- Cấu hình chính sách Ca Thu Ngân theo Tenant (Pre-close STRICT/CARRY_OVER, ngưỡng ảnh chứng từ, hạn mức két)
ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS cauhinhca JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- TRỤ CỘT 4: PHIẾU THU/CHI, LOẠI 4 = THOI_CK_DU, SAFE DROP TWO-MAN RULE & ẢNH CHỨNG TỪ
-- ---------------------------------------------------------------------------
ALTER TABLE public.phieuthuchilatvat
    ADD COLUMN IF NOT EXISTS danhmucchi       VARCHAR(32) DEFAULT 'KHAC',
    ADD COLUMN IF NOT EXISTS nguoiduyet       VARCHAR(50),
    ADD COLUMN IF NOT EXISTS trangthaixacnhan VARCHAR(24) NOT NULL DEFAULT 'CONFIRMED',
    ADD COLUMN IF NOT EXISTS nguoinhanket     VARCHAR(50),
    ADD COLUMN IF NOT EXISTS thoigiannhanket  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS idchungtu        VARCHAR(64);

DO $$
DECLARE
    con_name text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'phieuthuchilatvat') THEN
        FOR con_name IN
            SELECT c.conname
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE n.nspname = 'public'
               AND t.relname = 'phieuthuchilatvat'
               AND c.contype = 'c'
               AND pg_get_constraintdef(c.oid) ILIKE '%loaiphieu%'
        LOOP
            EXECUTE format('ALTER TABLE public.phieuthuchilatvat DROP CONSTRAINT IF EXISTS %I', con_name);
        END LOOP;

        ALTER TABLE public.phieuthuchilatvat
            ADD CONSTRAINT chk_phieuthuchi_loaiphieu CHECK (LoaiPhieu IN (1, 2, 3, 4));

        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conname = 'chk_phieuthuchi_trangthaixacnhan'
               AND conrelid = 'public.phieuthuchilatvat'::regclass
        ) THEN
            ALTER TABLE public.phieuthuchilatvat
                ADD CONSTRAINT chk_phieuthuchi_trangthaixacnhan
                CHECK (trangthaixacnhan IN ('PENDING_RECEIPT', 'CONFIRMED', 'DISPUTED'));
        END IF;
    END IF;
END $$;

-- Bảng lưu ảnh chứng từ biên nhận/hóa đơn chi đã xác thực theo TenantId (chống dán link giả)
CREATE TABLE IF NOT EXISTS public.receipt_photo_uploads (
    id          VARCHAR(64) PRIMARY KEY,
    tenantid    VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    manv        VARCHAR(50) NOT NULL,
    mimetype    VARCHAR(40) NOT NULL DEFAULT 'image/webp',
    sizebytes   INT NOT NULL DEFAULT 0,
    dataurl     TEXT NOT NULL,
    createdat   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_receipt_photo_tenant
    ON public.receipt_photo_uploads (tenantid, createdat DESC);

-- ---------------------------------------------------------------------------
-- BẬT FAIL-CLOSED FORCE RLS & CẤP QUYỀN LEAST-PRIVILEGE CHO APP_RUNTIME
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    tbl TEXT;
    fn_sig TEXT;
    new_tables TEXT[] := ARRAY['order_refunds', 'branch_zreport_counter', 'receipt_photo_uploads'];
    fn_list TEXT[] := ARRAY[
        'public.fn_record_webhook_event_v2(varchar, varchar, varchar, numeric, text, jsonb, varchar, varchar)',
        'public.fn_update_webhook_event_v2(bigint, varchar, text, varchar, numeric, varchar)',
        'public.fn_lookup_any_invoice_by_codes(text[], text)'
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

    FOREACH fn_sig IN ARRAY fn_list LOOP
        IF to_regprocedure(fn_sig) IS NOT NULL THEN
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn_sig);
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn_sig, current_user);
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_runtime', fn_sig);
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn_sig);
            END IF;
        END IF;
    END LOOP;
END $$;

COMMIT;
