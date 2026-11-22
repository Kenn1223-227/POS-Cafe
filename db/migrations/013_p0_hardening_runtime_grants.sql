-- ============================================================================
-- MIGRATION 013: HARDENING CHO APP_RUNTIME (NOBYPASSRLS) & SUPABASE PGBOUNCER 6543
-- Mục đích:
--   0. Tự động khởi tạo role app_runtime (NOBYPASSRLS) nếu chưa tồn tại và cấp
--      quyền DML/Sequence tối thiểu để sẵn sàng chạy Production & Test tích hợp.
--   1. Tạo hàm SECURITY DEFINER fn_cleanup_old_idempotency() để job dọn rác
--      DonHang_Idempotency hoạt động dưới Fail-Closed RLS (app_runtime).
--   2. Khóa quyền tối thiểu (Least Privilege) trên các hàm SECURITY DEFINER:
--      REVOKE ALL FROM PUBLIC; GRANT EXECUTE chỉ cho app_runtime / role vận hành.
--   3. Thiết lập statement_timeout = '15s' trực tiếp ở cấp ROLE app_runtime để
--      tương thích cả Direct (5432) lẫn Supabase PgBouncer Transaction Pooler (6543).
-- An toàn chạy lặp lại nhiều lần (Idempotent).
-- ============================================================================

-- 0. Tạo hoặc chuẩn hóa role app_runtime (NOBYPASSRLS) & cấp quyền DML/Sequence
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        BEGIN
            CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'Bỏ qua CREATE ROLE app_runtime (user hiện tại không có quyền CREATEROLE)';
        END;
    ELSE
        BEGIN
            ALTER ROLE app_runtime NOSUPERUSER NOBYPASSRLS;
        EXCEPTION WHEN insufficient_privilege THEN
            NULL;
        END;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA public TO app_runtime';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime';
        EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime';
        BEGIN
            EXECUTE format('GRANT app_runtime TO %I', current_user);
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;
END $$;

-- 1. Hàm dọn dẹp DonHang_Idempotency quá 2 ngày (chạy được dưới Fail-Closed RLS)
CREATE OR REPLACE FUNCTION public.fn_cleanup_old_idempotency()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_deleted INTEGER := 0;
BEGIN
    DELETE FROM public.DonHang_Idempotency
     WHERE ThoiGianTao < now() - interval '2 days';
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

-- 2. Khóa quyền tối thiểu (REVOKE PUBLIC + GRANT EXECUTE cho app_runtime & role thực thi)
DO $$
DECLARE
    fn_sig TEXT;
    fn_list TEXT[] := ARRAY[
        'public.fn_lookup_billing_order(text)',
        'public.fn_username_exists(text)',
        'public.fn_record_webhook_event(character varying, character varying, numeric, text, jsonb)',
        'public.fn_update_webhook_event(character varying, character varying, text, character varying)',
        'public.fn_cleanup_old_idempotency()',
        'public.fn_lookup_login_user(text)',
        'public.fn_lookup_open_invoice_by_codes(text[])',
        'public.fn_check_staff_active(text)'
    ];
BEGIN
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

    -- 3. Gán statement_timeout cấp role cho app_runtime (an toàn với PgBouncer Transaction Pooler cổng 6543)
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        BEGIN
            EXECUTE 'ALTER ROLE app_runtime SET statement_timeout = ''15s''';
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'Bỏ qua ALTER ROLE app_runtime SET statement_timeout (không đủ quyền superuser/createrole)';
        END;
    END IF;
END $$;
