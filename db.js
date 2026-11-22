const { Pool } = require('pg');
require('dotenv').config();
const { recordDbQueryMetric, getDbMetricsSnapshot, logger } = require('./modules/observability');

const sslConfig = (() => {
  if (process.env.DB_SSL_CA) {
    return {
      ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n'),
      rejectUnauthorized: true,
    };
  }
  return process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }; // Fallback cho Supabase/Neon khi chưa cấu hình DB_SSL_CA
})();

// Supabase PgBouncer Transaction Pooler (cổng 6543 / pgbouncer=true) có thể từ chối startup parameter statement_timeout.
// Khi chạy qua 6543, statement_timeout được gán trực tiếp ở cấp PostgreSQL Role (ALTER ROLE app_runtime SET statement_timeout = '15s' ở Migration 013).
const dbUrl = String(process.env.DATABASE_URL || '');
const isPgBouncerPooler =
  process.env.DB_DISABLE_STARTUP_TIMEOUT === 'true' ||
  /:6543(\/|\?|$)/.test(dbUrl) ||
  /pgbouncer=true/i.test(dbUrl);

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
  max: Number(process.env.DB_POOL_MAX || 30),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: Number(process.env.DB_CONN_TIMEOUT_MS || 30000),
};
if (!isPgBouncerPooler) {
  poolConfig.statement_timeout = Number(process.env.DB_STATEMENT_TIMEOUT_MS || 15000);
}

const pool = new Pool(poolConfig);

// Bọc pool.query để tự động đo độ trễ & cảnh báo Slow Query (Observability Phân hệ 7)
const rawPoolQuery = pool.query.bind(pool);
pool.query = function instrumentedPoolQuery(textOrConfig, values, callback) {
  if (typeof callback === 'function' || typeof values === 'function') {
    return rawPoolQuery(textOrConfig, values, callback);
  }
  const sql = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig?.text || '';
  const startNs = process.hrtime.bigint();
  return rawPoolQuery(textOrConfig, values).then(
    (res) => {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      recordDbQueryMetric({ durationMs, sql });
      return res;
    },
    (err) => {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      recordDbQueryMetric({ durationMs, sql, error: err });
      throw err;
    }
  );
};

pool.on('connect', () => {
  logger.info('Đã kết nối thành công với cơ sở dữ liệu PostgreSQL qua Connection String', {
    event: 'DB_POOL_CONNECTED',
    pgBouncer: isPgBouncerPooler,
  });
});

// Chuẩn hóa lớp truy vấn Tenant-Aware tương thích Fail-Closed RLS (SET LOCAL trong transaction ngắn)
pool.withTenant = async function withTenant(tenantId, fn) {
  const client = await pool.connect();
  const cleanTenant = String(tenantId || 'DEFAULT');
  const rawClientQuery = client.query.bind(client);
  client.query = function instrumentedTenantQuery(textOrConfig, values, callback) {
    if (typeof callback === 'function' || typeof values === 'function') {
      return rawClientQuery(textOrConfig, values, callback);
    }
    const sql = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig?.text || '';
    const startNs = process.hrtime.bigint();
    return rawClientQuery(textOrConfig, values).then(
      (res) => {
        const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        recordDbQueryMetric({ durationMs, sql, tenantId: cleanTenant });
        return res;
      },
      (err) => {
        const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        recordDbQueryMetric({ durationMs, sql, tenantId: cleanTenant, error: err });
        throw err;
      }
    );
  };
  try {
    await rawClientQuery('BEGIN');
    await rawClientQuery(`SELECT set_config('app.current_tenant_id', $1, true)`, [cleanTenant]);
    const result = await fn(client);
    await rawClientQuery('COMMIT');
    return result;
  } catch (error) {
    await rawClientQuery('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.query = rawClientQuery;
    client.release();
  }
};

pool.queryTenant = function queryTenant(tenantId, text, params = []) {
  return pool.withTenant(tenantId, (client) => client.query(text, params));
};

pool.getDbMetrics = getDbMetricsSnapshot;

module.exports = pool;
