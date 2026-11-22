require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
    const connStr = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
    if (!connStr) {
        console.error('❌ Thiếu biến môi trường DATABASE_URL hoặc MIGRATION_DATABASE_URL trong .env');
        process.exit(1);
    }

    const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
    const allFiles = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

    const filterArg = process.argv[2] ? String(process.argv[2]).trim() : '026';
    const targetFiles =
        filterArg.toLowerCase() === 'all'
            ? allFiles
            : allFiles.filter((f) => f.includes(filterArg));

    if (targetFiles.length === 0) {
        console.error(`❌ Không tìm thấy file migration khớp với "${filterArg}" trong db/migrations/`);
        process.exit(1);
    }

    const pool = new Pool({
        connectionString: connStr,
        ssl: connStr.includes('localhost') || connStr.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
    });

    try {
        for (const file of targetFiles) {
            const fullPath = path.join(migrationsDir, file);
            const sql = fs.readFileSync(fullPath, 'utf8');
            console.log(`⏳ Đang chạy migration: ${file}...`);
            await pool.query(sql);
            console.log(`✅ Hoàn tất migration: ${file}`);
        }
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('❌ Lỗi khi chạy migration:', err.message);
    process.exit(1);
});
