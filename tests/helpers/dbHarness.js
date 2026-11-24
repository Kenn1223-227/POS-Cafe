const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const dotenv = require('dotenv');
const { Pool } = require('pg');

const envTestPath = path.join(__dirname, '..', '..', '.env.test');
if (fs.existsSync(envTestPath)) {
    dotenv.config({ path: envTestPath, quiet: true });
} else {
    dotenv.config({ quiet: true });
}

function getRuntimeConnectionString() {
    return String(process.env.TEST_APP_RUNTIME_URL || process.env.APP_RUNTIME_DATABASE_URL || '').trim();
}

function getMigrationConnectionString() {
    return String(process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || '').trim();
}

function buildSsl(connStr) {
    if (!connStr) return false;
    return connStr.includes('localhost') || connStr.includes('127.0.0.1') ? false : { rejectUnauthorized: false };
}

function createRuntimePool() {
    const connStr = getRuntimeConnectionString();
    if (!connStr) {
        throw new Error(
            'Thiếu TEST_APP_RUNTIME_URL (role app_runtime NOBYPASSRLS). Hãy chạy `docker compose -f docker-compose.test.yml up -d` và copy `.env.test.example` thành `.env.test`!'
        );
    }
    return new Pool({
        connectionString: connStr,
        ssl: buildSsl(connStr),
        max: 5,
        connectionTimeoutMillis: 8000,
    });
}

function createMigrationPool() {
    const connStr = getMigrationConnectionString();
    if (!connStr) {
        throw new Error('Thiếu MIGRATION_DATABASE_URL hoặc DATABASE_URL!');
    }
    return new Pool({
        connectionString: connStr,
        ssl: buildSsl(connStr),
        max: 3,
        connectionTimeoutMillis: 8000,
    });
}

async function assertAppRuntimeNoBypassRls(pool) {
    const res = await pool.query(
        `SELECT current_user AS role_name, rolsuper, rolbypassrls
           FROM pg_roles
          WHERE rolname = current_user`
    );
    assert.equal(res.rows.length, 1, 'Không đọc được thông tin role hiện tại từ pg_roles');
    const row = res.rows[0];
    assert.equal(
        row.rolbypassrls,
        false,
        `VI PHẠM BẢO MẬT: Role "${row.role_name}" đang có rolbypassrls = true! Integration test BẮT BUỘC chạy dưới role NOBYPASSRLS.`
    );
    assert.equal(
        row.rolsuper,
        false,
        `VI PHẠM BẢO MẬT: Role "${row.role_name}" đang có rolsuper = true! Integration test BẮT BUỘC chạy dưới role non-superuser.`
    );
    return row;
}

async function withTenantTx(pool, tenantId, fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [String(tenantId)]);
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

module.exports = {
    getRuntimeConnectionString,
    getMigrationConnectionString,
    createRuntimePool,
    createMigrationPool,
    assertAppRuntimeNoBypassRls,
    withTenantTx,
};
