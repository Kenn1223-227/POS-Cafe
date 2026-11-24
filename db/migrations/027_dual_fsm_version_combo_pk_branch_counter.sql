-- =============================================================================
-- MIGRATION 027 (WAVE 1 — P0-01 & P0-03):
--   1. Dual FSM trên HoaDon (lifecycle_status + buoc_lam_tron + trigger trg_guard_hoadon_fsm)
--   2. Tách trạng thái hủy món trên ChiTietHoaDon (CANCELLED_BEFORE_PREP / WASTED_AFTER_PREP)
--   3. Đổi PK bảng combo sang (tenantid, macombo) + recreate FK combo_slots
--   4. Bảng branch_daily_counter (tenant_id, branch_id, business_date) + FORCE RLS
--   5. Hàm SECURITY DEFINER fn_resolve_invoice_for_webhook(p_mahoadon) cho VietQR dưới FORCE RLS
-- Expand-and-Contract & Idempotent 100%.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Dual FSM & buoc_lam_tron trên public.hoadon
-- -----------------------------------------------------------------------------
ALTER TABLE public.hoadon
    ADD COLUMN IF NOT EXISTS lifecycle_status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
    ADD COLUMN IF NOT EXISTS buoc_lam_tron    INT NOT NULL DEFAULT 1000;

-- Backfill lifecycle_status cho dữ liệu hiện có (chỉ cập nhật khi còn mặc định 'OPEN' nhưng TrangThaiTT khác 0 hoặc đã thanh toán một phần)
UPDATE public.hoadon
   SET lifecycle_status = CASE
       WHEN TrangThaiTT = -1 THEN 'PARKED'
       WHEN TrangThaiTT = 1  THEN 'PAID'
       WHEN TrangThaiTT = 2  THEN 'REFUNDED'
       WHEN TrangThaiTT = 3  THEN 'MERGED'
       WHEN TrangThaiTT = 0 AND COALESCE(DaThanhToan, 0) > 0 THEN 'PARTIALLY_PAID'
       ELSE 'OPEN'
   END
 WHERE lifecycle_status = 'OPEN'
   AND (TrangThaiTT <> 0 OR COALESCE(DaThanhToan, 0) > 0);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_hoadon_lifecycle_status'
           AND conrelid = 'public.hoadon'::regclass
    ) THEN
        ALTER TABLE public.hoadon
            ADD CONSTRAINT chk_hoadon_lifecycle_status CHECK (
                lifecycle_status IN (
                    'PARKED',
                    'AWAITING_PAYMENT',
                    'OPEN',
                    'PARTIALLY_PAID',
                    'PAID',
                    'CLOSED',
                    'VOIDED',
                    'REFUNDED',
                    'MERGED'
                )
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_hoadon_tenant_lifecycle
    ON public.hoadon (tenantid, lifecycle_status, thoigiantao DESC);

-- Trigger bảo vệ chuyển trạng thái FSM (chặn mở lại VOIDED/MERGED, chặn quay ngược PAID/CLOSED)
CREATE OR REPLACE FUNCTION public.fn_guard_hoadon_fsm()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_old_lc VARCHAR(32) := COALESCE(OLD.lifecycle_status, 'OPEN');
    v_new_lc VARCHAR(32) := COALESCE(NEW.lifecycle_status, v_old_lc);
BEGIN
    -- Đồng bộ tự động nếu câu UPDATE cũ chỉ đổi TrangThaiTT mà chưa đổi lifecycle_status
    IF NEW.lifecycle_status IS NOT DISTINCT FROM OLD.lifecycle_status
       AND NEW.trangthaitt IS DISTINCT FROM OLD.trangthaitt THEN
        v_new_lc := CASE
            WHEN NEW.trangthaitt = -1 THEN 'PARKED'
            WHEN NEW.trangthaitt = 1  THEN 'PAID'
            WHEN NEW.trangthaitt = 2  THEN 'REFUNDED'
            WHEN NEW.trangthaitt = 3  THEN 'MERGED'
            WHEN NEW.trangthaitt = 0 AND COALESCE(NEW.dathanhtoan, 0) > 0 THEN 'PARTIALLY_PAID'
            ELSE 'OPEN'
        END;
        NEW.lifecycle_status := v_new_lc;
    END IF;

    -- Không có thay đổi trạng thái -> cho qua
    IF v_old_lc = v_new_lc THEN
        RETURN NEW;
    END IF;

    -- Chặn mở lại đơn đã VOIDED hoặc MERGED
    IF v_old_lc IN ('VOIDED', 'MERGED') THEN
        RAISE EXCEPTION 'FSM_VIOLATION: Không thể chuyển trạng thái hóa đơn từ % sang %', v_old_lc, v_new_lc
            USING ERRCODE = '22023';
    END IF;

    -- Chặn quay ngược đơn đã PAID hoặc CLOSED (chỉ cho phép PAID->CLOSED, PAID->REFUNDED, CLOSED->REFUNDED)
    IF v_old_lc = 'PAID' AND v_new_lc NOT IN ('CLOSED', 'REFUNDED') THEN
        RAISE EXCEPTION 'FSM_VIOLATION: Hóa đơn PAID không thể quay ngược sang %', v_new_lc
            USING ERRCODE = '22023';
    END IF;

    IF v_old_lc = 'CLOSED' AND v_new_lc NOT IN ('REFUNDED') THEN
        RAISE EXCEPTION 'FSM_VIOLATION: Hóa đơn CLOSED không thể quay ngược sang %', v_new_lc
            USING ERRCODE = '22023';
    END IF;

    IF v_old_lc = 'REFUNDED' THEN
        RAISE EXCEPTION 'FSM_VIOLATION: Hóa đơn REFUNDED không thể chuyển sang %', v_new_lc
            USING ERRCODE = '22023';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_hoadon_fsm ON public.hoadon;
CREATE TRIGGER trg_guard_hoadon_fsm
    BEFORE UPDATE OF lifecycle_status, trangthaitt ON public.hoadon
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_guard_hoadon_fsm();

-- -----------------------------------------------------------------------------
-- 2. Tách trạng thái hủy món trên public.chitiethoadon
-- -----------------------------------------------------------------------------
ALTER TABLE public.chitiethoadon
    ADD COLUMN IF NOT EXISTS trang_thai_huy VARCHAR(32);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_cthd_trang_thai_huy'
           AND conrelid = 'public.chitiethoadon'::regclass
    ) THEN
        ALTER TABLE public.chitiethoadon
            ADD CONSTRAINT chk_cthd_trang_thai_huy CHECK (
                trang_thai_huy IS NULL OR trang_thai_huy IN ('CANCELLED_BEFORE_PREP', 'WASTED_AFTER_PREP')
            );
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Đổi PK bảng public.combo sang (tenantid, macombo) & cập nhật FK combo_slots
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_pk_cols TEXT;
    v_fk_name TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'combo') THEN
        SELECT string_agg(a.attname, ',' ORDER BY k.ord)
          INTO v_pk_cols
          FROM pg_constraint c
          JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
         WHERE c.conrelid = 'public.combo'::regclass
           AND c.contype = 'p';

        IF v_pk_cols IS DISTINCT FROM 'tenantid,macombo' THEN
            -- Gỡ toàn bộ FK trên combo_slots đang trỏ vào public.combo
            FOR v_fk_name IN
                SELECT conname
                  FROM pg_constraint
                 WHERE conrelid = 'public.combo_slots'::regclass
                   AND confrelid = 'public.combo'::regclass
                   AND contype = 'f'
            LOOP
                EXECUTE format('ALTER TABLE public.combo_slots DROP CONSTRAINT IF EXISTS %I', v_fk_name);
            END LOOP;

            ALTER TABLE public.combo DROP CONSTRAINT IF EXISTS combo_pkey;
            ALTER TABLE public.combo ADD PRIMARY KEY (tenantid, macombo);

            IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'combo_slots') THEN
                ALTER TABLE public.combo_slots
                    ADD CONSTRAINT fk_combo_slots_combo
                    FOREIGN KEY (tenantid, macombo)
                    REFERENCES public.combo (tenantid, macombo)
                    ON DELETE CASCADE;
            END IF;
        END IF;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Bảng branch_daily_counter (tránh nhảy cóc số thứ tự giữa các chi nhánh)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.branch_daily_counter (
    tenant_id     VARCHAR(64) NOT NULL,
    branch_id     VARCHAR(64) NOT NULL DEFAULT 'MAIN',
    business_date DATE NOT NULL,
    last_seq      INT NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, branch_id, business_date)
);

ALTER TABLE public.branch_daily_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branch_daily_counter FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_branch_daily_counter ON public.branch_daily_counter;
CREATE POLICY tenant_isolation_branch_daily_counter ON public.branch_daily_counter
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- -----------------------------------------------------------------------------
-- 5. SECURITY DEFINER fn_resolve_invoice_for_webhook (VietQR dưới FORCE RLS)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_resolve_invoice_for_webhook(p_mahoadon VARCHAR)
RETURNS TABLE (
    tenant_id       VARCHAR,
    ma_hoa_don      VARCHAR,
    lifecycle_status VARCHAR,
    trang_thai_tt   INT,
    tong_tien       NUMERIC,
    da_thanh_toan   NUMERIC,
    bank_account_no TEXT,
    bank_bin        TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        COALESCE(h.TenantId, 'DEFAULT')::VARCHAR AS tenant_id,
        h.MaHoaDon::VARCHAR AS ma_hoa_don,
        COALESCE(h.lifecycle_status, 'OPEN')::VARCHAR AS lifecycle_status,
        h.TrangThaiTT::INT AS trang_thai_tt,
        COALESCE(h.TongTienThanhToan, h.ThanhTien, h.TongTien, 0)::NUMERIC AS tong_tien,
        COALESCE(h.DaThanhToan, 0)::NUMERIC AS da_thanh_toan,
        COALESCE(
            t.ThongTinNganHang->>'soTaiKhoan',
            t.ThongTinNganHang->>'accountNo',
            ''
        )::TEXT AS bank_account_no,
        COALESCE(
            t.ThongTinNganHang->>'maNganHang',
            t.ThongTinNganHang->>'bankId',
            ''
        )::TEXT AS bank_bin
      FROM public.HoaDon h
      LEFT JOIN public.Tenants t ON t.TenantId = COALESCE(h.TenantId, 'DEFAULT')
     WHERE h.MaHoaDon = p_mahoadon
     LIMIT 1;
$$;

DO $$
BEGIN
    REVOKE ALL ON FUNCTION public.fn_resolve_invoice_for_webhook(VARCHAR) FROM PUBLIC;
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.fn_resolve_invoice_for_webhook(VARCHAR) TO %I', current_user);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.branch_daily_counter TO app_runtime;
        GRANT EXECUTE ON FUNCTION public.fn_resolve_invoice_for_webhook(VARCHAR) TO app_runtime;
    END IF;
END $$;

COMMIT;
