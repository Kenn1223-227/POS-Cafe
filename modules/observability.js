// =============================================================================
// Observability & Alerting Module (Phân hệ 7)
// - Structured JSON Logging chuẩn Pino (tự động dùng `pino` nếu đã cài, fallback zero-dep NDJSON)
// - Gắn requestId, tenantId, maNV lên mọi log & header X-Request-Id
// - Giám sát độ trễ DB (Slow Query Alert > SLOW_QUERY_MS) & thống kê sức khỏe
// - Tích hợp Sentry (@sentry/node hoặc native Sentry Envelope HTTP nếu có SENTRY_DSN)
// =============================================================================
const crypto = require('crypto');

const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const MIN_LEVEL = LEVEL_RANK[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || 20;
const LOG_FORMAT = String(process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'pretty')).toLowerCase();
const SLOW_QUERY_MS = Math.max(50, Number(process.env.SLOW_QUERY_MS || 500));
const SENTRY_DSN = String(process.env.SENTRY_DSN || '').trim();

let pinoLogger = null;
try {
    // eslint-disable-next-line global-require
    const pino = require('pino');
    pinoLogger = pino({
        level: String(process.env.LOG_LEVEL || 'info').toLowerCase(),
        base: { service: 'cafe-pos-backend', pid: process.pid },
    });
} catch {
    pinoLogger = null;
}

let sentrySdk = null;
if (SENTRY_DSN) {
    try {
        // eslint-disable-next-line global-require
        const Sentry = require('@sentry/node');
        Sentry.init({
            dsn: SENTRY_DSN,
            environment: process.env.NODE_ENV || 'production',
            tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
        });
        sentrySdk = Sentry;
    } catch {
        sentrySdk = null;
    }
}

function parseSentryDsn(dsn) {
    try {
        const u = new URL(dsn);
        const projectId = u.pathname.replace(/^\/+/, '').split('/').pop();
        if (!projectId || !u.username) return null;
        return {
            endpoint: `${u.protocol}//${u.host}/api/${projectId}/envelope/`,
            publicKey: u.username,
            dsn,
        };
    } catch {
        return null;
    }
}

const parsedSentryDsn = SENTRY_DSN ? parseSentryDsn(SENTRY_DSN) : null;

function emitLog(level, msg, meta = {}) {
    const rank = LEVEL_RANK[level] || 20;
    if (rank < MIN_LEVEL) return;

    if (pinoLogger && typeof pinoLogger[level] === 'function') {
        pinoLogger[level](meta, msg);
        return;
    }

    const entry = {
        level,
        time: new Date().toISOString(),
        pid: process.pid,
        service: 'cafe-pos-backend',
        ...meta,
        msg,
    };

    if (LOG_FORMAT === 'json') {
        const line = JSON.stringify(entry);
        if (rank >= LEVEL_RANK.error) process.stderr.write(line + '\n');
        else process.stdout.write(line + '\n');
    } else {
        const ctxParts = [];
        if (meta.requestId) ctxParts.push(`req=${meta.requestId.slice(0, 8)}`);
        if (meta.tenantId) ctxParts.push(`tenant=${meta.tenantId}`);
        if (meta.durationMs !== undefined) ctxParts.push(`${meta.durationMs}ms`);
        const prefix = `[${entry.time}] ${level.toUpperCase()}${ctxParts.length ? ` (${ctxParts.join(' ')})` : ''}:`;
        if (rank >= LEVEL_RANK.error) console.error(prefix, msg, Object.keys(meta).length ? meta : '');
        else if (rank >= LEVEL_RANK.warn) console.warn(prefix, msg);
        else console.log(prefix, msg);
    }
}

const logger = {
    debug: (msg, meta) => emitLog('debug', msg, meta),
    info: (msg, meta) => emitLog('info', msg, meta),
    warn: (msg, meta) => emitLog('warn', msg, meta),
    error: (msg, meta) => emitLog('error', msg, meta),
    fatal: (msg, meta) => emitLog('fatal', msg, meta),
    usingPino: Boolean(pinoLogger),
};

// =============================================================================
// DB Latency & Slow-Query Telemetry
// =============================================================================
const dbMetrics = {
    totalQueries: 0,
    slowQueries: 0,
    errorQueries: 0,
    maxDurationMs: 0,
    recentDurations: [], // rolling window tối đa 200 mẫu để tính p95
    recentSlowSamples: [], // 20 truy vấn chậm gần nhất
};

function sanitizeSqlSnippet(sql) {
    return String(sql || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
}

function recordDbQueryMetric({ durationMs = 0, sql = '', tenantId = null, error = null } = {}) {
    const ms = Math.max(0, Math.round(Number(durationMs) * 100) / 100);
    dbMetrics.totalQueries += 1;
    if (ms > dbMetrics.maxDurationMs) dbMetrics.maxDurationMs = ms;
    dbMetrics.recentDurations.push(ms);
    if (dbMetrics.recentDurations.length > 200) dbMetrics.recentDurations.shift();

    if (error) {
        dbMetrics.errorQueries += 1;
    }

    if (ms >= SLOW_QUERY_MS) {
        dbMetrics.slowQueries += 1;
        const sample = {
            at: new Date().toISOString(),
            durationMs: ms,
            tenantId: tenantId || null,
            sql: sanitizeSqlSnippet(sql),
        };
        dbMetrics.recentSlowSamples.unshift(sample);
        if (dbMetrics.recentSlowSamples.length > 20) dbMetrics.recentSlowSamples.pop();
        logger.warn('Slow PostgreSQL query detected', {
            event: 'DB_SLOW_QUERY',
            thresholdMs: SLOW_QUERY_MS,
            ...sample,
        });
    }
}

function getDbMetricsSnapshot() {
    const sorted = [...dbMetrics.recentDurations].sort((a, b) => a - b);
    const p95Idx = sorted.length > 0 ? Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95)) : 0;
    const avg = sorted.length > 0 ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
    return {
        totalQueries: dbMetrics.totalQueries,
        slowQueries: dbMetrics.slowQueries,
        errorQueries: dbMetrics.errorQueries,
        slowQueryThresholdMs: SLOW_QUERY_MS,
        avgDurationMs: Math.round(avg * 100) / 100,
        p95DurationMs: sorted[p95Idx] || 0,
        maxDurationMs: dbMetrics.maxDurationMs,
        recentSlowSamples: dbMetrics.recentSlowSamples.slice(0, 5),
    };
}

// =============================================================================
// Sentry Error Capture (SDK hoặc Native Envelope fallback — non-blocking)
// =============================================================================
function captureException(err, context = {}) {
    const message = err?.message || String(err || 'Unknown error');
    logger.error(message, {
        event: 'UNHANDLED_EXCEPTION',
        stack: err?.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : undefined,
        ...context,
    });

    if (sentrySdk) {
        try {
            sentrySdk.withScope((scope) => {
                if (context.tenantId) scope.setTag('tenantId', String(context.tenantId));
                if (context.requestId) scope.setTag('requestId', String(context.requestId));
                if (context.maNV) scope.setUser({ id: String(context.maNV) });
                scope.setExtras(context);
                sentrySdk.captureException(err instanceof Error ? err : new Error(message));
            });
        } catch {
            // Không để lỗi Sentry ảnh hưởng luồng chính
        }
        return;
    }

    if (parsedSentryDsn && typeof fetch === 'function') {
        const eventId = crypto.randomBytes(16).toString('hex');
        const header = JSON.stringify({ event_id: eventId, dsn: parsedSentryDsn.dsn, sent_at: new Date().toISOString() });
        const itemHeader = JSON.stringify({ type: 'event' });
        const payload = JSON.stringify({
            event_id: eventId,
            level: 'error',
            platform: 'node',
            environment: process.env.NODE_ENV || 'production',
            timestamp: Date.now() / 1000,
            message,
            tags: {
                tenantId: context.tenantId || 'UNKNOWN',
                requestId: context.requestId || 'NONE',
            },
            extra: {
                ...context,
                stack: err?.stack || null,
            },
        });
        fetch(parsedSentryDsn.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-sentry-envelope',
                'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${parsedSentryDsn.publicKey}, sentry_client=cafe-pos-backend/3.1`,
            },
            body: `${header}\n${itemHeader}\n${payload}`,
        }).catch(() => {});
    }
}

// =============================================================================
// Express Request Context Middleware (X-Request-Id + Structured Access Log)
// =============================================================================
const httpMetrics = {
    totalRequests: 0,
    error5xxCount: 0,
    startedAt: new Date().toISOString(),
};

function requestContextMiddleware(req, res, next) {
    const incomingId = String(req.headers['x-request-id'] || '').trim().slice(0, 64);
    const requestId = incomingId || crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const startNs = process.hrtime.bigint();
    httpMetrics.totalRequests += 1;

    res.on('finish', () => {
        const durationMs = Math.round((Number(process.hrtime.bigint() - startNs) / 1e6) * 100) / 100;
        const statusCode = res.statusCode;
        if (statusCode >= 500) httpMetrics.error5xxCount += 1;

        // Tránh làm ồn log bằng health check probe định kỳ
        if (req.path === '/api/health' || req.path === '/api/ready' || req.path === '/') return;

        const meta = {
            event: 'HTTP_REQUEST',
            requestId,
            tenantId: req.user?.tenantId || null,
            maNV: req.user?.maNV || null,
            method: req.method,
            path: req.originalUrl || req.path,
            statusCode,
            durationMs,
            ip: req.ip,
        };

        if (statusCode >= 500) logger.error('HTTP 5xx response', meta);
        else if (durationMs >= SLOW_QUERY_MS * 2) logger.warn('Slow HTTP request', meta);
        else if (MIN_LEVEL <= LEVEL_RANK.debug || LOG_FORMAT === 'json') logger.info('HTTP request completed', meta);
    });

    next();
}

function getObservabilitySnapshot() {
    const mem = process.memoryUsage();
    return {
        startedAt: httpMetrics.startedAt,
        uptimeSec: Math.round(process.uptime()),
        logger: pinoLogger ? 'pino' : 'structured-json',
        sentryEnabled: Boolean(sentrySdk || parsedSentryDsn),
        http: {
            totalRequests: httpMetrics.totalRequests,
            error5xxCount: httpMetrics.error5xxCount,
        },
        db: getDbMetricsSnapshot(),
        memoryMb: {
            rss: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
            heapUsed: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
        },
    };
}

module.exports = {
    logger,
    requestContextMiddleware,
    recordDbQueryMetric,
    getDbMetricsSnapshot,
    captureException,
    getObservabilitySnapshot,
    SLOW_QUERY_MS,
};
