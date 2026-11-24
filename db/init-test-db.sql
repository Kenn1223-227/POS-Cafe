-- =============================================================================
-- Khởi tạo Role Runtime Test (app_runtime — NOBYPASSRLS, NOSUPERUSER)
-- Chạy tự động khi docker-compose.test.yml khởi tạo DB trắng lần đầu.
-- Tuyệt đối KHÔNG cấp BYPASSRLS cho app_runtime.
-- =============================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        CREATE ROLE app_runtime
            LOGIN
            PASSWORD 'app_runtime_test_pass'
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOBYPASSRLS;
    ELSE
        ALTER ROLE app_runtime
            LOGIN
            PASSWORD 'app_runtime_test_pass'
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOBYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
ALTER ROLE app_runtime SET statement_timeout = '15s';
