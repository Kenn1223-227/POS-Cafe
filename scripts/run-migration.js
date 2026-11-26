const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const useEnvTest = args.includes('--env-test') || process.env.NODE_ENV === 'test';
const includeBase = args.includes('--base');
const forceRun = args.includes('--force');
const positionalArgs = args.filter((a) => !a.startsWith('--'));

// Khóa an toàn: khi có --env-test, BẮT BUỘC chỉ đọc .env.test, từ chối chạy nếu thiếu .env.test
if (useEnvTest) {
    const testEnvPath = path.join(__dirname, '..', '.env.test');
    if (!fs.existsSync(testEnvPath)) {
        console.error('❌ [AN TOÀN] Cờ --env-test được bật nhưng không tìm thấy file .env.test!');
        console.error('   Vui lòng copy .env.test.example thành .env.test và cấu hình trước khi chạy.');
        process.exit(1);
    }
    // Xóa DATABASE_URL khỏi process.env để triệt để không fallback sang DB thật
    delete process.env.DATABASE_URL;
    dotenv.config({ path: testEnvPath, override: true });
} else {
    const defaultEnvPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(defaultEnvPath)) {
        dotenv.config({ path: defaultEnvPath });
    } else {
        dotenv.config();
    }
}

function extractVersion(filename) {
    const m = String(filename).match(/^(\d+)_/);
    return m ? m[1] : filename;
}

function compareMigrationFiles(a, b) {
    const va = String(a).match(/^(\d+)_/);
    const vb = String(b).match(/^(\d+)_/);
    if (va && vb) {
        const diff = Number(va[1]) - Number(vb[1]);
        if (diff !== 0) return diff;
    }
    return a.localeCompare(b);
}

async function ensureSchemaMigrationsTable(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS public.schema_migrations (
            version    VARCHAR(32) PRIMARY KEY,
            filename   TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
}

async function main() {
    let connStr;
    if (useEnvTest) {
        connStr = process.env.MIGRATION_DATABASE_URL;
        if (!connStr) {
            console.error('❌ [AN TOÀN] Cờ --env-test yêu cầu biến MIGRATION_DATABASE_URL trong .env.test. Tuyệt đối KHÔNG fallback sang DATABASE_URL.');
            process.exit(1);
        }
    } else {
        connStr = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
        if (!connStr) {
            console.error('❌ Thiếu biến môi trường MIGRATION_DATABASE_URL hoặc DATABASE_URL');
            process.exit(1);
        }
    }

    const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
    const allFiles = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort(compareMigrationFiles);

    const filterArg = positionalArgs[0] ? String(positionalArgs[0]).trim() : 'all';
    const targetFiles =
        filterArg.toLowerCase() === 'all'
            ? allFiles
            : allFiles.filter((f) => f.startsWith(filterArg) || f.includes(filterArg));

    if (targetFiles.length === 0) {
        console.error(`❌ Không tìm thấy file migration khớp với "${filterArg}" trong db/migrations/`);
        process.exit(1);
    }

    const isLocal = connStr.includes('localhost') || connStr.includes('127.0.0.1');
    const pool = new Pool({
        connectionString: connStr,
        ssl: isLocal ? false : { rejectUnauthorized: false },
    });

    try {
        if (includeBase) {
            const baseSchemaPath = path.join(__dirname, '..', 'db', 'schema_base.sql');
            if (fs.existsSync(baseSchemaPath)) {
                console.log('⏳ Đang áp dụng schema nền (db/schema_base.sql)...');
                await pool.query(fs.readFileSync(baseSchemaPath, 'utf8'));
                console.log('✅ Hoàn tất schema nền.');
            }
        }

        await ensureSchemaMigrationsTable(pool);

        const appliedRes = await pool.query('SELECT version FROM public.schema_migrations');
        const appliedSet = new Set(appliedRes.rows.map((r) => r.version));

        let executed = 0;
        let skipped = 0;
        for (const file of targetFiles) {
            const version = extractVersion(file);
            if (!forceRun && appliedSet.has(version)) {
                skipped += 1;
                continue;
            }
            const fullPath = path.join(migrationsDir, file);
            const sql = fs.readFileSync(fullPath, 'utf8');
            console.log(`⏳ Đang chạy migration [${version}]: ${file}...`);
            await pool.query(sql);
            await pool.query(
                `INSERT INTO public.schema_migrations (version, filename)
                 VALUES ($1, $2)
                 ON CONFLICT (version) DO UPDATE SET filename = EXCLUDED.filename, applied_at = now()`,
                [version, file]
            );
            executed += 1;
            console.log(`✅ Hoàn tất migration [${version}]: ${file}`);
        }

        console.log(`🎯 Kết quả migrate: đã chạy ${executed}, bỏ qua (đã áp dụng) ${skipped}.`);
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('❌ Lỗi khi chạy migration:', err.message);
    process.exit(1);
});
