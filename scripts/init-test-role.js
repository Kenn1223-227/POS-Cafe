const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const envTestPath = path.join(__dirname, '..', '.env.test');
if (fs.existsSync(envTestPath)) {
    dotenv.config({ path: envTestPath });
} else {
    dotenv.config();
}

const connStr =
    process.env.MIGRATION_DATABASE_URL ||
    'postgres://postgres:test_owner_password@127.0.0.1:5433/cafe_pos_test';

const fallbackSql = `
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
`;

async function run() {
    const initSqlPath = path.join(__dirname, '..', 'db', 'init-test-db.sql');
    let sqlContent = fallbackSql;
    if (fs.existsSync(initSqlPath)) {
        sqlContent = fs.readFileSync(initSqlPath, 'utf8');
        console.log(`[CI] Đọc SQL từ: ${initSqlPath}`);
    } else {
        console.log('[CI] Không tìm thấy db/init-test-db.sql, dùng embedded SQL fallback');
    }

    let client;
    const maxRetries = 10;
    for (let i = 1; i <= maxRetries; i++) {
        try {
            client = new Client({ connectionString: connStr });
            await client.connect();
            break;
        } catch (err) {
            if (i === maxRetries) {
                throw new Error(`Không thể kết nối đến PostgreSQL sau ${maxRetries} lần thử: ${err.message}`);
            }
            console.log(`[CI] Đang chờ PostgreSQL sẵn sàng... (lần ${i}/${maxRetries})`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }

    try {
        await client.query(sqlContent);
        console.log('✅ [CI] Khởi tạo role app_runtime (NOBYPASSRLS) thành công.');
    } finally {
        await client.end();
    }
}

run().catch((err) => {
    console.error('❌ [CI] Lỗi khởi tạo role app_runtime:', err.message);
    process.exit(1);
});
