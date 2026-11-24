-- =============================================================================
-- MIGRATION 030 (WAVE 2 — P0-06):
--   1. Đổi khóa chính public.donhang_idempotency sang (tenantid, khoaidem)
--   2. Thêm lease_expires_at (TTL lease 60s thu hồi zombie lock) & request_fingerprint
--   3. Thêm index dọn TTL theo thoigiantao & index truy vấn lease hết hạn
--   4. Bảo toàn FORCE ROW LEVEL SECURITY + GRANT cho app_runtime
-- Expand-and-Contract & Idempotent 100%.
-- =============================================================================

BEGIN;

-- Đảm bảo bảng tồn tại và các cột cơ bản sẵn sàng
CREATE TABLE IF NOT EXISTS public.donhang_idempotency (
    khoaidem            VARCHAR(128) NOT NULL,
    tenantid            VARCHAR(64)  NOT NULL DEFAULT COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), 'DEFAULT'),
    trangthai           VARCHAR(16)  NOT NULL DEFAULT 'DONE',
    mahoadonkq          VARCHAR(64),
    responsejson        JSONB,
    httpstatus          INT DEFAULT 200,
    thoigiantao         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

UPDATE public.donhang_idempotency
   SET tenantid = 'DEFAULT'
 WHERE tenantid IS NULL;

ALTER TABLE public.donhang_idempotency
    ALTER COLUMN tenantid SET NOT NULL;

ALTER TABLE public.donhang_idempotency
    ADD COLUMN IF NOT EXISTS lease_expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '60 seconds'),
    ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(64);

-- Đổi khóa chính sang composite (tenantid, khoaidem) một cách idempotent
DO $$
DECLARE
    v_pk_cols TEXT;
    v_pk_name TEXT;
BEGIN
    SELECT c.conname,
           string_agg(a.attname, ',' ORDER BY k.ord)
      INTO v_pk_name, v_pk_cols
      FROM pg_constraint c
      JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.conrelid = 'public.donhang_idempotency'::regclass
       AND c.contype = 'p'
     GROUP BY c.conname;

    IF v_pk_cols IS DISTINCT FROM 'tenantid,khoaidem' THEN
        IF v_pk_name IS NOT NULL THEN
            EXECUTE format('ALTER TABLE public.donhang_idempotency DROP CONSTRAINT %I', v_pk_name);
        END IF;
        ALTER TABLE public.donhang_idempotency
            ADD CONSTRAINT donhang_idempotency_pkey PRIMARY KEY (tenantid, khoaidem);
    END IF;
END $$;

-- Index dọn TTL theo thoigiantao & index thu hồi zombie lease
CREATE INDEX IF NOT EXISTS idx_donhang_idempotency_thoigiantao
    ON public.donhang_idempotency (thoigiantao);

CREATE INDEX IF NOT EXISTS idx_donhang_idempotency_lease_processing
    ON public.donhang_idempotency (tenantid, lease_expires_at)
    WHERE trangthai = 'PROCESSING';

-- Bảo toàn Fail-Closed RLS & GRANT cho app_runtime
ALTER TABLE public.donhang_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.donhang_idempotency FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_idempotency ON public.donhang_idempotency;
CREATE POLICY tenant_isolation_idempotency ON public.donhang_idempotency
    USING (COALESCE(tenantid, 'DEFAULT') = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (COALESCE(tenantid, 'DEFAULT') = NULLIF(current_setting('app.current_tenant_id', true), ''));

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.donhang_idempotency TO app_runtime;
    END IF;
END $$;

COMMIT;
