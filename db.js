const { Pool } = require('pg');
require('dotenv').config();
const { recordDbQueryMetric, getDbMetricsSnapshot, logger } = require('./modules/observability');

function buildSslConfig(connStr) {
  if (process.env.DB_SSL_CA) {
    return {
      ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n'),
      rejectUnauthorized: true,
    };
  }
  const url = String(connStr || '');
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
  return isLocal ? false : { rejectUnauthorized: false }; // Fallback cho Supabase/Neon khi chưa cấu hình DB_SSL_CA
}

function detectPgBouncer(connStr) {
  const url = String(connStr || '');
  return (
    process.env.DB_DISABLE_STARTUP_TIMEOUT === 'true' ||
    /:6543(\/|\?|$)/.test(url) ||
    /pgbouncer=true/i.test(url)
  );
}

/**
 * [Wave 4B — P2-01] Khóa tuyệt đối Auto-DDL trên môi trường Production.
 * - NODE_ENV === 'production' => BẮT BUỘC trả false (bất kể SKIP_AUTO_DDL có đặt hay không).
 * - SKIP_AUTO_DDL === 'true'  => trả false.
 * - Các môi trường dev/test khác => trả true.
 */
function shouldRunAutoDdl(env = process.env) {
  const safeEnv = env || {};
  if (String(safeEnv.NODE_ENV || '').trim().toLowerCase() === 'production') {
    return false;
  }
  if (String(safeEnv.SKIP_AUTO_DDL || '').trim().toLowerCase() === 'true') {
    return false;
  }
  return true;
}

function instrumentPoolQuery(targetPool, poolLabel = 'primary') {
  const rawPoolQuery = targetPool.query.bind(targetPool);
  targetPool.query = function instrumentedPoolQuery(textOrConfig, values, callback) {
    if (typeof callback === 'function' || typeof values === 'function') {
      return rawPoolQuery(textOrConfig, values, callback);
    }
    const sql = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig?.text || '';
    const startNs = process.hrtime.bigint();
    return rawPoolQuery(textOrConfig, values).then(
      (res) => {
        const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        recordDbQueryMetric({ durationMs, sql, pool: poolLabel });
        return res;
      },
      (err) => {
        const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        recordDbQueryMetric({ durationMs, sql, pool: poolLabel, error: err });
        throw err;
      }
    );
  };
}

function instrumentClientQuery(client, cleanTenant, poolLabel = 'primary') {
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
        recordDbQueryMetric({ durationMs, sql, tenantId: cleanTenant, pool: poolLabel });
        return res;
      },
      (err) => {
        const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        recordDbQueryMetric({ durationMs, sql, tenantId: cleanTenant, pool: poolLabel, error: err });
        throw err;
      }
    );
  };
  return rawClientQuery;
}

// Supabase PgBouncer Transaction Pooler (cổng 6543 / pgbouncer=true) có thể từ chối startup parameter statement_timeout.
// Khi chạy qua 6543, statement_timeout được gán trực tiếp ở cấp PostgreSQL Role (ALTER ROLE app_runtime SET statement_timeout = '15s' ở Migration 013).
const dbUrl = String(process.env.DATABASE_URL || '');
const isPgBouncerPooler = detectPgBouncer(dbUrl);

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: buildSslConfig(dbUrl),
  max: Number(process.env.DB_POOL_MAX || 30),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: Number(process.env.DB_CONN_TIMEOUT_MS || 30000),
};
if (!isPgBouncerPooler) {
  poolConfig.statement_timeout = Number(process.env.DB_STATEMENT_TIMEOUT_MS || 15000);
}

const pool = new Pool(poolConfig);
instrumentPoolQuery(pool, 'primary');

pool.on('connect', () => {
  logger.info('Đã kết nối thành công với cơ sở dữ liệu PostgreSQL qua Connection String', {
    event: 'DB_POOL_CONNECTED',
    pgBouncer: isPgBouncerPooler,
  });
});

// [Wave 4B — P2-01] Read-Replica Pool cho các truy vấn Báo cáo / Analytics nặng
const reportDbUrl = String(process.env.REPORT_DATABASE_URL || '').trim();
const isReadReplicaConfigured = Boolean(reportDbUrl);

let reportPool = pool;
if (isReadReplicaConfigured) {
  const isReportPgBouncer = detectPgBouncer(reportDbUrl);
  const reportPoolConfig = {
    connectionString: reportDbUrl,
    ssl: buildSslConfig(reportDbUrl),
    max: Number(process.env.REPORT_DB_POOL_MAX || process.env.DB_POOL_MAX || 20),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: Number(process.env.DB_CONN_TIMEOUT_MS || 30000),
  };
  if (!isReportPgBouncer) {
    reportPoolConfig.statement_timeout = Number(process.env.REPORT_DB_STATEMENT_TIMEOUT_MS || 30000);
  }
  reportPool = new Pool(reportPoolConfig);
  instrumentPoolQuery(reportPool, 'read_replica');
  reportPool.on('connect', () => {
    logger.info('Đã kết nối Read-Replica Pool (REPORT_DATABASE_URL) cho báo cáo', {
      event: 'DB_REPORT_POOL_CONNECTED',
      pgBouncer: isReportPgBouncer,
    });
  });
}

// Chuẩn hóa lớp truy vấn Tenant-Aware tương thích Fail-Closed RLS (SET LOCAL trong transaction ngắn)
pool.withTenant = async function withTenant(tenantId, fn) {
  const client = await pool.connect();
  const cleanTenant = String(tenantId || 'DEFAULT');
  const rawClientQuery = instrumentClientQuery(client, cleanTenant, 'primary');
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

/**
 * [Wave 4B — P2-01] Thực thi truy vấn báo cáo trên Read-Replica Pool trong giao dịch READ ONLY.
 * - Bắt buộc `BEGIN TRANSACTION READ ONLY` để PostgreSQL từ chối mọi câu lệnh ghi (25006).
 * - Luôn `SET LOCAL app.current_tenant_id = $1` (qua set_config(..., true)) để bảo toàn FORCE RLS.
 * - Tự động COMMIT / ROLLBACK và release client sạch sẽ.
 */
async function chayTruyVanBaoCao(tenantId, callback, targetPool = reportPool) {
  const activePool = targetPool || reportPool;
  const client = await activePool.connect();
  const cleanTenant = String(tenantId || 'DEFAULT');
  const rawClientQuery = instrumentClientQuery(
    client,
    cleanTenant,
    isReadReplicaConfigured ? 'read_replica' : 'primary_ro'
  );
  try {
    await rawClientQuery('BEGIN TRANSACTION READ ONLY');
    await rawClientQuery(`SELECT set_config('app.current_tenant_id', $1, true)`, [cleanTenant]);
    const result = await callback(client);
    await rawClientQuery('COMMIT');
    return result;
  } catch (error) {
    await rawClientQuery('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.query = rawClientQuery;
    client.release();
  }
}

async function closeAllPools() {
  const tasks = [];
  if (reportPool && reportPool !== pool) {
    tasks.push(reportPool.end().catch(() => {}));
  }
  tasks.push(pool.end().catch(() => {}));
  await Promise.allSettled(tasks);
}

pool.pool = pool;
pool.reportPool = reportPool;
pool.isReadReplicaConfigured = isReadReplicaConfigured;
pool.chayTruyVanBaoCao = chayTruyVanBaoCao;
pool.closeAllPools = closeAllPools;
pool.shouldRunAutoDdl = shouldRunAutoDdl;
pool.getDbMetrics = getDbMetricsSnapshot;

module.exports = pool;
