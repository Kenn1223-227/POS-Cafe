-- ============================================================================
-- Migration 039: Thu hồi quyền EXECUTE 6 hàm Super Admin khỏi app_runtime
-- Theo AUDIT_REPORT_V2.md (P0-09): Các hàm SECURITY DEFINER của Super Admin
-- tuyệt đối không cấp quyền EXECUTE cho role ứng dụng quán (app_runtime).
-- Chỉ role quản trị nền tảng (current_user / database owner) mới được phép gọi.
-- ============================================================================

BEGIN;

DO $$
DECLARE
    fn_sig TEXT;
    fn_list TEXT[] := ARRAY[
        'public.fn_platform_overview_tenants()',
        'public.fn_platform_overview_billing()',
        'public.fn_platform_list_tenants(integer)',
        'public.fn_platform_list_billing_orders(text, integer)',
        'public.fn_platform_manual_approve_billing(text, text, text, jsonb, text, text)',
        'public.fn_platform_impersonate_prepare(text, text, text, timestamp with time zone, text)'
    ];
BEGIN
    FOREACH fn_sig IN ARRAY fn_list LOOP
        -- 1. Thu hồi quyền EXECUTE khỏi PUBLIC
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn_sig);

        -- 2. Thu hồi quyền EXECUTE khỏi role app_runtime nếu role tồn tại
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
            EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM app_runtime', fn_sig);
        END IF;

        -- 3. Đảm bảo role quản trị nền tảng / database owner hiện tại có toàn quyền EXECUTE
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn_sig, current_user);
    END LOOP;
END $$;

COMMIT;
