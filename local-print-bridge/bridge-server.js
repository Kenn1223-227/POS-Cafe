#!/usr/bin/env node
/**
 * =============================================================================
 * Cafe POS — Local Print Bridge Agent & POS LAN Hub v3.0 (Phân hệ 2 - 100/100)
 * - Zero-Dependency Silent Printing Server (http://127.0.0.1:9100)
 * - Persistent Disk Spooler (spool-queue.json) -> HTTP 202 ACCEPTED < 10ms
 * - TSPL 40x30/50x30mm 1-N Cup Splitting + BITMAP_VI Tiếng Việt + Mid-Job Jam Checkpoint Resume
 * - ESC/POS (DLE EOT 4/2) & TSPL (<ESC>!?) Hardware Sensor Check + Failover Printer
 * - Server-Enforced Reprint Watermark & Local-LAN POS Hub (kèm clientOrderUid chống đúp vé)
 * =============================================================================
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildReceiptK80, buildRasterReceiptBuffer, buildZReportK80, buildCashDrawerKickBuffer } = require('./escposBuilder');
const { buildCupLabelsTspl } = require('./tsplBuilder');
const {
    dispatchRawBuffer,
    queryEscPosStatus,
    queryTsplStatus,
    setSimulatedSensorStatus,
    getSimulatedSensorStatus,
    resetSimulatedSensors,
} = require('./printerTransport');

const PORT = Number(process.env.PRINT_BRIDGE_PORT || 9100);
const CONFIG_PATH = process.env.PRINT_BRIDGE_CONFIG_PATH || path.join(__dirname, 'bridge-config.json');
const LAN_ORDERS_PATH = path.join(__dirname, 'lan-orders.json');
const SPOOL_PATH = process.env.PRINT_SPOOL_PATH || path.join(__dirname, 'spool-queue.json');

const LOCAL_LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

function parseAllowedOrigins(raw) {
    if (Array.isArray(raw)) {
        return raw.map((o) => String(o || '').trim().replace(/\/+$/, '')).filter(Boolean);
    }
    return String(raw || '')
        .split(',')
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean);
}

const DEFAULT_CONFIG = {
    receiptPrinter: {
        name: 'PRIMARY_RECEIPT_K80',
        mode: 'SIMULATOR', // 'SIMULATOR' | 'LAN_TCP' | 'WINDOWS_SHARE'
        host: '192.168.1.200',
        port: 9100,
        shareName: 'XP-80C',
        autoCut: true,
        kickDrawerOnCash: true,
        fallbackPrinterId: null,
    },
    labelPrinter: {
        name: 'PRIMARY_LABEL_TSPL',
        mode: 'SIMULATOR', // 'SIMULATOR' | 'LAN_TCP' | 'WINDOWS_SHARE'
        host: '192.168.1.201',
        port: 9100,
        shareName: 'XP-350B',
        widthMm: 50,
        heightMm: 30,
        renderMode: 'BITMAP_VI', // 'BITMAP_VI' | 'ASCII_FALLBACK'
        fallbackPrinterId: null,
    },
    fallbackPrinter: {
        enabled: false,
        name: 'BACKUP_PRINTER',
        mode: 'SIMULATOR',
        host: '192.168.1.202',
        port: 9100,
        shareName: 'XP-BACKUP',
    },
    cloudRelay: {
        enabled: Boolean(process.env.CLOUD_RELAY_URL && process.env.CLOUD_RELAY_TOKEN),
        backendUrl: process.env.CLOUD_RELAY_URL || 'http://localhost:3000',
        token: process.env.CLOUD_RELAY_TOKEN || '',
        pollIntervalMs: 1500,
    },
    lanHub: {
        enabled: process.env.LAN_HUB_ENABLED !== 'false',
        token: process.env.LAN_HUB_TOKEN || '',
    },
    security: {
        apiToken: process.env.PRINT_BRIDGE_TOKEN || '',
        allowedOrigins: parseAllowedOrigins(process.env.PRINT_BRIDGE_ALLOWED_ORIGINS),
    },
};

function loadConfig() {
    let merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    let existed = false;
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            existed = true;
            const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            merged = {
                receiptPrinter: { ...DEFAULT_CONFIG.receiptPrinter, ...(raw.receiptPrinter || {}) },
                labelPrinter: { ...DEFAULT_CONFIG.labelPrinter, ...(raw.labelPrinter || {}) },
                fallbackPrinter: { ...DEFAULT_CONFIG.fallbackPrinter, ...(raw.fallbackPrinter || {}) },
                cloudRelay: { ...DEFAULT_CONFIG.cloudRelay, ...(raw.cloudRelay || {}) },
                lanHub: { ...DEFAULT_CONFIG.lanHub, ...(raw.lanHub || {}) },
                security: {
                    apiToken: String(
                        process.env.PRINT_BRIDGE_TOKEN ||
                            raw.security?.apiToken ||
                            raw.lanHub?.token ||
                            ''
                    ).trim(),
                    allowedOrigins: [
                        ...new Set([
                            ...parseAllowedOrigins(raw.security?.allowedOrigins),
                            ...parseAllowedOrigins(process.env.PRINT_BRIDGE_ALLOWED_ORIGINS),
                        ]),
                    ],
                },
            };
        }
    } catch (e) {
        console.warn('⚠️ Không đọc được bridge-config.json, dùng mặc định:', e.message);
    }

    // [Wave 1 — P0-04] Bắt buộc luôn có apiToken xác thực 32-byte random (tự sinh khi khởi chạy lần đầu, không hardcode trong repo)
    if (!merged.security.apiToken) {
        merged.security.apiToken = String(merged.lanHub?.token || '').trim() || crypto.randomBytes(32).toString('hex');
        if (!process.env.PRINT_BRIDGE_TOKEN) {
            try {
                fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
            } catch {
                // ignore write errors in read-only env
            }
        }
    }
    return merged;
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

let bridgeConfig = loadConfig();
// [Wave 1 — P0-04] Mặc định chỉ bind 127.0.0.1; chỉ mở 0.0.0.0 khi admin chủ động cấu hình PRINT_BRIDGE_HOST=0.0.0.0 hoặc bindAllInterfaces=true
const HOST = process.env.PRINT_BRIDGE_HOST || (bridgeConfig.lanHub?.bindAllInterfaces === true ? '0.0.0.0' : '127.0.0.1');

// =============================================================================
// PERSISTENT DISK SPOOLER (Chống mất lệnh khi kẹt giấy / tắt nguồn)
// =============================================================================
function loadSpoolQueue() {
    try {
        if (fs.existsSync(SPOOL_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(SPOOL_PATH, 'utf8'));
            if (Array.isArray(parsed)) return parsed.slice(0, 80);
        }
    } catch {
        // ignore corrupt spool file
    }
    return [];
}

function saveSpoolQueue(jobs) {
    try {
        const clean = jobs.slice(0, 80).map(sanitizeJob);
        fs.writeFileSync(SPOOL_PATH, JSON.stringify(clean, null, 2), 'utf8');
    } catch {
        // ignore write errors in read-only env
    }
}

const printJobs = loadSpoolQueue();
let jobSeq = printJobs.reduce((max, j) => Math.max(max, Number(j.id || 0)), 0) + 1;

// =============================================================================
// LOCAL-LAN POS HUB (Offline KDS Fallback qua Wi-Fi nội bộ + SSE Sensor Alerts)
// =============================================================================
const lanSseClients = new Set();

function loadLanOrders() {
    try {
        if (fs.existsSync(LAN_ORDERS_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(LAN_ORDERS_PATH, 'utf8'));
            if (Array.isArray(parsed)) return parsed.slice(0, 120);
        }
    } catch {
        // ignore
    }
    return [];
}

function saveLanOrders(orders) {
    try {
        fs.writeFileSync(LAN_ORDERS_PATH, JSON.stringify(orders.slice(0, 120), null, 2), 'utf8');
    } catch {
        // ignore
    }
}

const lanOrders = loadLanOrders();

function getLocalLanAddresses() {
    const nets = os.networkInterfaces();
    const ips = [];
    for (const iface of Object.values(nets)) {
        for (const net of iface || []) {
            if (net.family === 'IPv4' && !net.internal) {
                ips.push(net.address);
            }
        }
    }
    return ips;
}

function safeTokenEquals(provided, expected) {
    const a = String(provided || '').trim();
    const b = String(expected || '').trim();
    if (!a || !b) return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function extractRequestToken(req, url, { allowQuery = false } = {}) {
    const bridgeHdr = String(req?.headers?.['x-print-bridge-token'] || '').trim();
    if (bridgeHdr) return bridgeHdr;
    const lanHdr = String(req?.headers?.['x-lan-hub-token'] || '').trim();
    if (lanHdr) return lanHdr;
    const authHdr = String(req?.headers?.authorization || '').trim();
    if (/^Bearer\s+/i.test(authHdr)) {
        return authHdr.replace(/^Bearer\s+/i, '').trim();
    }
    if (allowQuery && url?.searchParams) {
        const qTok = String(url.searchParams.get('token') || '').trim();
        if (qTok) return qTok;
    }
    return '';
}

function verifyBridgeAuth(req, url, { allowQuery = false, allowLanToken = false } = {}) {
    const apiToken = String(bridgeConfig.security?.apiToken || '').trim();
    const lanToken = String(bridgeConfig.lanHub?.token || '').trim();
    const provided = extractRequestToken(req, url, { allowQuery });
    if (!provided) return false;
    if (apiToken && safeTokenEquals(provided, apiToken)) return true;
    if (allowLanToken && lanToken && safeTokenEquals(provided, lanToken)) return true;
    return false;
}

function verifyLanHubAuth(req, url) {
    // Luôn yêu cầu token hợp lệ (lanHub.token hoặc security.apiToken), không bao giờ mở không xác thực
    return verifyBridgeAuth(req, url, { allowQuery: true, allowLanToken: true });
}

function sanitizeConfigForClient(cfg) {
    return {
        receiptPrinter: cfg.receiptPrinter,
        labelPrinter: cfg.labelPrinter,
        fallbackPrinter: cfg.fallbackPrinter,
        cloudRelay: {
            ...cfg.cloudRelay,
            token: cfg.cloudRelay?.token ? '***CONFIGURED***' : '',
        },
        lanHub: {
            enabled: Boolean(cfg.lanHub?.enabled),
            hasToken: Boolean(cfg.lanHub?.token || cfg.security?.apiToken),
        },
        security: {
            authRequired: true,
            allowedOrigins: cfg.security?.allowedOrigins || [],
        },
    };
}

function broadcastLanEvent(tenantId, eventName, data) {
    const targetTenant = String(tenantId || '*');
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of lanSseClients) {
        if (targetTenant === '*' || client.tenantId === '*' || client.tenantId === targetTenant) {
            try {
                client.res.write(payload);
            } catch {
                lanSseClients.delete(client);
            }
        }
    }
}

function sanitizeJob(job) {
    const copy = { ...job };
    delete copy._buffer;
    delete copy._cups;
    return copy;
}

function recordJob(job) {
    printJobs.unshift(job);
    if (printJobs.length > 80) printJobs.pop();
    saveSpoolQueue(printJobs);
    return job;
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk;
            if (data.length > 2 * 1024 * 1024) {
                reject(new Error('Payload quá lớn'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!data.trim()) return resolve({});
            try {
                resolve(JSON.parse(data));
            } catch {
                reject(new Error('JSON không hợp lệ'));
            }
        });
        req.on('error', reject);
    });
}

function isOriginAllowed(origin) {
    if (!origin) return true;
    const clean = String(origin).trim().replace(/\/+$/, '');
    if (LOCAL_LOOPBACK_ORIGIN_RE.test(clean)) return true;
    const configured = [
        ...parseAllowedOrigins(process.env.PRINT_BRIDGE_ALLOWED_ORIGINS),
        ...parseAllowedOrigins(bridgeConfig.security?.allowedOrigins),
    ];
    return configured.some((allowed) => allowed.toLowerCase() === clean.toLowerCase());
}

function buildCorsHeaders(req) {
    const origin = req && req.headers && req.headers.origin ? String(req.headers.origin).trim() : '';
    if (!origin) {
        return { Vary: 'Origin' };
    }
    if (!isOriginAllowed(origin)) {
        return { Vary: 'Origin' };
    }
    return {
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Print-Bridge-Token, X-Lan-Hub-Token, Last-Event-ID',
        'Access-Control-Allow-Private-Network': 'true',
    };
}

function sendJson(res, status, obj, req = null) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        ...buildCorsHeaders(req),
    });
    res.end(JSON.stringify(obj));
}

// Dựng lại buffer/cups từ payload gốc khi khôi phục job từ spool-queue.json sau restart/resume
function ensureJobBuffers(job, { failoverHeader = null } = {}) {
    const body = job.payload || {};
    if (job.kind === 'LABEL') {
        const built = buildCupLabelsTspl({
            hoaDon: body.hoaDon,
            onlyCupIndex: body.onlyCupIndex || null,
            widthMm: body.widthMm || bridgeConfig.labelPrinter.widthMm || 50,
            heightMm: body.heightMm || bridgeConfig.labelPrinter.heightMm || 30,
            renderMode: body.renderMode || bridgeConfig.labelPrinter.renderMode || 'BITMAP_VI',
            failoverHeader,
        });
        job._cups = built.cups;
        job._buffer = built.buffer;
        job.cupCount = built.cupCount;
        job.totalCups = built.totalCups;
        job.previewText = built.previewText;
        return built;
    }
    if (job.kind === 'RECEIPT') {
        const kickDrawer =
            body.kickDrawer !== undefined
                ? Boolean(body.kickDrawer)
                : Boolean(bridgeConfig.receiptPrinter.kickDrawerOnCash && body.isCashPayment);
        const built = body.rasterBase64
            ? {
                  ...buildRasterReceiptBuffer({
                      rasterBase64: body.rasterBase64,
                      kickDrawer,
                      autoCut: bridgeConfig.receiptPrinter.autoCut !== false,
                  }),
                  previewText: '[RASTER_GS_V_0_VIETNAMESE_K80]',
              }
            : buildReceiptK80({
            hoaDon: body.hoaDon,
            tenQuan: body.tenQuan || 'QUAN CA PHE POS',
            diaChi: body.diaChi || '',
            soLanIn: body.soLanIn || 1,
            laBanSao: Boolean(body.laBanSao),
            reprintBanner: body.reprintBanner || null,
            failoverHeader,
            laTamTinh: Boolean(body.laTamTinh),
            laDonOffline: Boolean(body.laDonOffline),
            thuNgan: body.thuNgan || '',
            autoCut: bridgeConfig.receiptPrinter.autoCut !== false,
            kickDrawer,
            showPlgWatermark: Boolean(body.showPlgWatermark),
            plgReferralUrl: body.plgReferralUrl || '',
        });
        job._buffer = built.buffer;
        job.previewText = built.previewText;
        return built;
    }
    if (job.kind === 'Z_REPORT') {
        const built = buildZReportK80({
            tenQuan: body.tenQuan || 'QUAN CA PHE POS',
            ca: body.ca || {},
            nguoiIn: body.nguoiIn || '',
            autoCut: bridgeConfig.receiptPrinter.autoCut !== false,
        });
        job._buffer = built.buffer;
        job.previewText = built.previewText;
        return built;
    }
    if (job.kind === 'DRAWER_KICK') {
        job._buffer = buildCashDrawerKickBuffer();
        job.previewText = '[Xung điện RJ11 mở két tiền: ESC p 0 25 250]';
        return { buffer: job._buffer };
    }
    return null;
}

/**
 * Thực thi 1 Spool Job:
 * - Với LABEL (TSPL): chạy vòng lặp từng ly (1..N), bỏ qua các ly đã nằm trong `printedCupIndexes`,
 *   kiểm tra cảm biến <ESC>!? trước mỗi ly; nếu kẹt giấy (0x02) / hết giấy (0x04) / mở nắp (0x01) ->
 *   lập tức PAUSE và lưu checkpoint xuống disk (spool-queue.json) + bắn SSE PRINT_SENSOR_ALERT!
 * - Với RECEIPT / Z_REPORT / DRAWER_KICK: kiểm tra cảm biến ESC/POS (DLE EOT 4/2); nếu lỗi và có
 *   fallbackPrinter.enabled -> tự động failover sang máy in dự phòng với header "*** IN DU PHONG ***"!
 */
async function executeJob(job) {
    if (job.status === 'DONE' || job._running) {
        return { ok: job.status === 'DONE', job: sanitizeJob(job) };
    }
    job._running = true;
    job.attempts = (job.attempts || 0) + 1;
    job.status = 'PRINTING';
    job.error = null;
    job.sensorCode = null;
    job.sensorLabel = null;
    if (!Array.isArray(job.printedCupIndexes)) job.printedCupIndexes = [];
    if (!Array.isArray(job.dispatchedCupLog)) job.dispatchedCupLog = [];

    try {
        if (job.kind === 'LABEL') {
            if (!Array.isArray(job._cups) || job._cups.length === 0) {
                ensureJobBuffers(job);
            }
            const printerCfg = bridgeConfig.labelPrinter;
            let totalBytes = job.bytes || 0;

            for (const cup of job._cups || []) {
                // Checkpoint resume: tuyệt đối KHÔNG in lặp lại các tem đã in trước khi kẹt giấy!
                if (job.printedCupIndexes.includes(cup.cupIndex)) continue;

                const sensor = await queryTsplStatus(printerCfg, { cupIndex: cup.cupIndex });
                if (!sensor.ready) {
                    // Kiểm tra xem có Fallback Printer dự phòng hay không
                    if (bridgeConfig.fallbackPrinter?.enabled) {
                        ensureJobBuffers(job, { failoverHeader: '*** IN DU PHONG (MAY TEM LOI) ***' });
                        const fbCup = (job._cups || []).find((c) => c.cupIndex === cup.cupIndex) || cup;
                        const fbRes = await dispatchRawBuffer(fbCup.buffer, bridgeConfig.fallbackPrinter);
                        job.usedFallbackPrinter = true;
                        job.transport = fbRes.transport;
                        job.target = fbRes.target;
                        totalBytes += fbRes.bytes;
                        job.printedCupIndexes.push(cup.cupIndex);
                        job.dispatchedCupLog.push({
                            cupIndex: cup.cupIndex,
                            cupLabelId: cup.cupLabelId,
                            failover: true,
                            at: new Date().toISOString(),
                        });
                        broadcastLanEvent('*', 'PRINT_FAILOVER_ALERT', {
                            spoolJobId: job.id,
                            maHoaDon: job.maHoaDon,
                            cupIndex: cup.cupIndex,
                            reason: sensor.message,
                            fallbackTarget: fbRes.target,
                        });
                        saveSpoolQueue(printJobs);
                        continue;
                    }

                    // Tạm dừng đúng tại ly bị kẹt & lưu checkpoint xuống disk!
                    job.status = 'PAUSED_SENSOR';
                    job.sensorCode = sensor.statusCode;
                    job.sensorLabel = sensor.label;
                    job.pausedAtCupIndex = cup.cupIndex;
                    job.error = sensor.message;
                    job.bytes = totalBytes;
                    saveSpoolQueue(printJobs);

                    broadcastLanEvent('*', 'PRINT_SENSOR_ALERT', {
                        spoolJobId: job.id,
                        kind: job.kind,
                        maHoaDon: job.maHoaDon,
                        sensorCode: sensor.statusCode,
                        sensorLabel: sensor.label,
                        pausedAtCupIndex: cup.cupIndex,
                        printedCupIndexes: [...job.printedCupIndexes],
                        totalCups: job.totalCups,
                        message: sensor.message,
                    });
                    console.warn(
                        `⚠️ [Spool #${job.id}] TẠM DỪNG tại ly ${cup.cupIndex}/${job.totalCups} (${sensor.label} 0x${Number(sensor.statusCode).toString(16)}) — Đã in: [${job.printedCupIndexes.join(',')}]`
                    );
                    return { ok: false, paused: true, error: sensor.message, job: sanitizeJob(job) };
                }

                const res = await dispatchRawBuffer(cup.buffer, printerCfg);
                job.transport = res.transport;
                job.target = res.target;
                totalBytes += res.bytes;
                job.printedCupIndexes.push(cup.cupIndex);
                job.dispatchedCupLog.push({
                    cupIndex: cup.cupIndex,
                    cupLabelId: cup.cupLabelId,
                    failover: false,
                    at: new Date().toISOString(),
                });
                saveSpoolQueue(printJobs);
            }

            job.status = 'DONE';
            job.pausedAtCupIndex = null;
            job.bytes = totalBytes;
            job.printedAt = new Date().toISOString();
            saveSpoolQueue(printJobs);
            console.log(`✅ [Spool #${job.id}] LABEL (${job.printedCupIndexes.length}/${job.totalCups} tem) -> ${job.transport} (${totalBytes} bytes)`);
            return { ok: true, job: sanitizeJob(job) };
        }

        // RECEIPT / Z_REPORT / DRAWER_KICK (ESC/POS)
        if (!job._buffer) ensureJobBuffers(job);
        const primaryCfg = bridgeConfig.receiptPrinter;
        const sensor = await queryEscPosStatus(primaryCfg);
        if (!sensor.ready) {
            if (bridgeConfig.fallbackPrinter?.enabled) {
                ensureJobBuffers(job, { failoverHeader: '*** IN DU PHONG (MAY BILL CHINH LOI) ***' });
                const fbRes = await dispatchRawBuffer(job._buffer, bridgeConfig.fallbackPrinter);
                job.status = 'DONE';
                job.usedFallbackPrinter = true;
                job.transport = fbRes.transport;
                job.target = fbRes.target;
                job.bytes = fbRes.bytes;
                job.printedAt = new Date().toISOString();
                saveSpoolQueue(printJobs);
                broadcastLanEvent('*', 'PRINT_FAILOVER_ALERT', {
                    spoolJobId: job.id,
                    maHoaDon: job.maHoaDon,
                    reason: sensor.message,
                    fallbackTarget: fbRes.target,
                });
                return { ok: true, failover: true, job: sanitizeJob(job) };
            }
            job.status = 'PAUSED_SENSOR';
            job.sensorCode = sensor.statusCode;
            job.sensorLabel = sensor.label;
            job.error = sensor.message;
            saveSpoolQueue(printJobs);
            broadcastLanEvent('*', 'PRINT_SENSOR_ALERT', {
                spoolJobId: job.id,
                kind: job.kind,
                maHoaDon: job.maHoaDon,
                sensorCode: sensor.statusCode,
                sensorLabel: sensor.label,
                message: sensor.message,
            });
            return { ok: false, paused: true, error: sensor.message, job: sanitizeJob(job) };
        }

        const result = await dispatchRawBuffer(job._buffer, primaryCfg);
        job.status = 'DONE';
        job.transport = result.transport;
        job.target = result.target;
        job.bytes = result.bytes;
        job.printedAt = new Date().toISOString();
        saveSpoolQueue(printJobs);
        console.log(`✅ [Spool #${job.id}] ${job.kind} -> ${result.transport} (${result.target}, ${result.bytes} bytes)`);
        return { ok: true, job: sanitizeJob(job) };
    } catch (err) {
        // Thử failover nếu kết nối LAN TCP bị lỗi và có bật fallbackPrinter
        if (bridgeConfig.fallbackPrinter?.enabled && !job.usedFallbackPrinter) {
            try {
                ensureJobBuffers(job, { failoverHeader: '*** IN DU PHONG (LOI KET NOI) ***' });
                const fbRes = await dispatchRawBuffer(job._buffer, bridgeConfig.fallbackPrinter);
                job.status = 'DONE';
                job.usedFallbackPrinter = true;
                job.transport = fbRes.transport;
                job.target = fbRes.target;
                job.bytes = fbRes.bytes;
                job.printedAt = new Date().toISOString();
                saveSpoolQueue(printJobs);
                return { ok: true, failover: true, job: sanitizeJob(job) };
            } catch {
                // fallback also failed
            }
        }
        job.status = 'FAILED';
        job.error = err.message;
        saveSpoolQueue(printJobs);
        console.error(`❌ [Spool #${job.id}] ${job.kind} FAILED:`, err.message);
        return { ok: false, error: err.message, job: sanitizeJob(job) };
    } finally {
        job._running = false;
    }
}

/**
 * Đưa lệnh in vào Persistent Disk Spooler:
 * - Mặc định chạy bất đồng bộ (non-blocking) và trả về ngay spoolJobId để POS không bao giờ bị treo UI!
 * - Hỗ trợ `sync: true` cho Cloud Relay cần chờ trạng thái ACK.
 */
async function enqueuePrintJob(kind, body = {}, { sync = false } = {}) {
    const cleanKind = String(kind || 'RECEIPT').toUpperCase();
    const job = {
        id: jobSeq++,
        kind: cleanKind,
        maHoaDon: body.hoaDon?.maHoaDon || body.ca?.maCaThuNgan || 'TEST',
        label: '',
        status: 'QUEUED',
        attempts: 0,
        printedCupIndexes: [],
        dispatchedCupLog: [],
        usedFallbackPrinter: false,
        payload: body,
        createdAt: new Date().toISOString(),
    };

    const built = ensureJobBuffers(job);
    if (cleanKind === 'LABEL') {
        if (!built || built.cupCount === 0) {
            return { ok: false, statusHttp: 400, error: 'Hóa đơn không có ly hợp lệ (InTemCoc=true) để in tem!' };
        }
        job.label = body.onlyCupIndex
            ? `In lại Tem ly #${body.onlyCupIndex}/${built.totalCups} — HĐ #${job.maHoaDon}`
            : `In ${built.cupCount} Tem cốc (${body.widthMm || bridgeConfig.labelPrinter.widthMm || 50}x${body.heightMm || bridgeConfig.labelPrinter.heightMm || 30}mm) — HĐ #${job.maHoaDon}`;
    } else if (cleanKind === 'RECEIPT') {
        const kickDrawer =
            body.kickDrawer !== undefined
                ? Boolean(body.kickDrawer)
                : Boolean(bridgeConfig.receiptPrinter.kickDrawerOnCash && body.isCashPayment);
        job.kickDrawer = kickDrawer;
        job.label = `Bill K80 #${job.maHoaDon}${kickDrawer ? ' + Mở két RJ11' : ''}`;
    } else if (cleanKind === 'Z_REPORT') {
        job.label = `Phiếu chốt ca Z-Report #${job.maHoaDon}`;
    } else if (cleanKind === 'DRAWER_KICK') {
        job.label = `Mở két tiền thu ngân (${body.lyDo || 'Thủ công'})`;
    } else {
        return { ok: false, statusHttp: 400, error: `Loại lệnh in không hỗ trợ: ${cleanKind}` };
    }

    recordJob(job);

    if (sync) {
        return executeJob(job);
    }

    // Trả 202 ACCEPTED ngay lập tức (< 10ms) và đẩy worker nền in từng tem / bill
    setImmediate(() => {
        void executeJob(job);
    });

    return {
        ok: true,
        accepted: true,
        statusHttp: 202,
        spoolJobId: job.id,
        job: sanitizeJob(job),
    };
}

// Quét nền tự động nối tiếp các job đang PAUSED_SENSOR ngay khi cảm biến máy in về 0x00 READY
async function resumePausedSpoolJobs() {
    const paused = printJobs.filter((j) => (j.status === 'PAUSED_SENSOR' || j.status === 'QUEUED') && !j._running);
    for (const job of paused) {
        await executeJob(job);
    }
}

async function handleBridgeRequest(req, res) {
    const respond = (status, obj) => sendJson(res, status, obj, req);
    const requestOrigin = req?.headers?.origin ? String(req.headers.origin).trim() : '';

    if (requestOrigin && !isOriginAllowed(requestOrigin)) {
        res.writeHead(403, {
            'Content-Type': 'application/json; charset=utf-8',
            Vary: 'Origin',
        });
        return res.end(JSON.stringify({ ok: false, error: 'Origin không được phép truy cập Local Print Bridge!' }));
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, buildCorsHeaders(req));
        return res.end();
    }

    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = url.pathname;

    try {
        if (req.method === 'GET' && pathname === '/health') {
            const authenticated = verifyBridgeAuth(req, url, { allowQuery: false, allowLanToken: true });
            return respond(200, {
                ok: true,
                service: 'cafe-pos-local-print-bridge',
                version: '3.1.0',
                platform: process.platform,
                port: PORT,
                authRequired: true,
                authenticated,
                lanIps: authenticated ? getLocalLanAddresses() : [],
                lanHubEnabled: Boolean(bridgeConfig.lanHub?.enabled),
                lanHub: { enabled: Boolean(bridgeConfig.lanHub?.enabled) },
                lanConnectedBaristas: lanSseClients.size,
                lanPendingOrders: lanOrders.filter((o) => !o.syncedToCloud).length,
                ...(authenticated ? { config: sanitizeConfigForClient(bridgeConfig) } : {}),
                sensors: getSimulatedSensorStatus(),
                jobCount: printJobs.length,
                pausedJobs: printJobs.filter((j) => j.status === 'PAUSED_SENSOR').length,
            });
        }

        // Mọi endpoint ngoài /health đều bắt buộc xác thực token (chống CSRF / truy cập trái phép qua localhost/LAN)
        if (!pathname.startsWith('/lan/')) {
            if (!verifyBridgeAuth(req, url, { allowQuery: false, allowLanToken: false })) {
                return respond(401, {
                    ok: false,
                    code: 'BRIDGE_AUTH_REQUIRED',
                    error: 'Thiếu hoặc sai X-Print-Bridge-Token (Authorization: Bearer <token>)!',
                });
            }
        }

        if (req.method === 'GET' && pathname === '/config') {
            return respond(200, sanitizeConfigForClient(bridgeConfig));
        }

        if (req.method === 'PUT' && pathname === '/config') {
            const body = await readJsonBody(req);
            const nextCloudRelay = { ...bridgeConfig.cloudRelay, ...(body.cloudRelay || {}) };
            if (nextCloudRelay.token === '***CONFIGURED***') {
                nextCloudRelay.token = bridgeConfig.cloudRelay.token;
            }
            const nextLanHub = { ...bridgeConfig.lanHub, ...(body.lanHub || {}) };
            const nextAllowedOrigins =
                body.security && body.security.allowedOrigins !== undefined
                    ? parseAllowedOrigins(body.security.allowedOrigins)
                    : bridgeConfig.security.allowedOrigins;
            const nextApiToken =
                body.security && typeof body.security.apiToken === 'string' && body.security.apiToken.trim().length >= 12
                    ? body.security.apiToken.trim()
                    : bridgeConfig.security.apiToken;

            bridgeConfig = {
                receiptPrinter: { ...bridgeConfig.receiptPrinter, ...(body.receiptPrinter || {}) },
                labelPrinter: { ...bridgeConfig.labelPrinter, ...(body.labelPrinter || {}) },
                fallbackPrinter: { ...bridgeConfig.fallbackPrinter, ...(body.fallbackPrinter || {}) },
                cloudRelay: nextCloudRelay,
                lanHub: nextLanHub,
                security: {
                    apiToken: nextApiToken,
                    allowedOrigins: nextAllowedOrigins,
                },
            };
            saveConfig(bridgeConfig);
            return respond(200, {
                ok: true,
                message: 'Đã lưu cấu hình Local Print Bridge & LAN Hub!',
                config: sanitizeConfigForClient(bridgeConfig),
            });
        }

        // ==================== CẢM BIẾN & SPOOLER ENDPOINTS (Phân hệ 2) ====================
        if (req.method === 'GET' && pathname === '/sensor/status') {
            const [receipt, label] = await Promise.all([
                queryEscPosStatus(bridgeConfig.receiptPrinter),
                queryTsplStatus(bridgeConfig.labelPrinter),
            ]);
            return respond(200, { ok: true, receipt, label, simulated: getSimulatedSensorStatus() });
        }

        if (req.method === 'POST' && pathname === '/sensor/simulate') {
            const body = await readJsonBody(req);
            if (body.reset) {
                resetSimulatedSensors();
            } else {
                const printer = body.printer || 'label';
                const patch = {};
                if (body.statusCode !== undefined) patch.statusCode = Number(body.statusCode);
                if (body.offline !== undefined) patch.offline = Boolean(body.offline);
                if (body.jamAtCupIndex !== undefined) {
                    patch.jamAtCupIndex = body.jamAtCupIndex === null ? null : Number(body.jamAtCupIndex);
                }
                setSimulatedSensorStatus(printer, patch);
            }
            // Nếu cảm biến vừa khôi phục về 0x00 READY -> lập tức chạy tiếp các job bị PAUSED_SENSOR!
            if (Number(body.statusCode) === 0 || body.reset) {
                setImmediate(() => {
                    void resumePausedSpoolJobs();
                });
            }
            return respond(200, { ok: true, simulated: getSimulatedSensorStatus() });
        }

        if (req.method === 'GET' && (pathname === '/jobs' || pathname === '/spool/jobs')) {
            return respond(200, { jobs: printJobs.map(sanitizeJob) });
        }

        const spoolGetMatch = pathname.match(/^\/(?:jobs|spool\/jobs)\/(\d+)$/);
        if (req.method === 'GET' && spoolGetMatch) {
            const id = Number(spoolGetMatch[1]);
            const job = printJobs.find((j) => j.id === id);
            if (!job) return respond(404, { ok: false, error: 'Không tìm thấy lệnh in!' });
            return respond(200, { ok: true, job: sanitizeJob(job) });
        }

        const retryMatch = pathname.match(/^\/(?:jobs|spool\/jobs)\/(\d+)\/(?:retry|resume)$/);
        if (req.method === 'POST' && retryMatch) {
            const id = Number(retryMatch[1]);
            const job = printJobs.find((j) => j.id === id);
            if (!job) return respond(404, { ok: false, error: 'Không tìm thấy lệnh in!' });
            const outcome = await executeJob(job);
            return respond(outcome.ok ? 200 : outcome.paused ? 202 : 502, outcome);
        }

        // ==================== LOCAL-LAN POS HUB ENDPOINTS ====================
        if (pathname.startsWith('/lan/')) {
            if (!verifyLanHubAuth(req, url)) {
                return respond(401, { ok: false, error: 'Sai hoặc thiếu X-Lan-Hub-Token!' });
            }

            if (req.method === 'GET' && pathname === '/lan/status') {
                return respond(200, {
                    ok: true,
                    enabled: Boolean(bridgeConfig.lanHub?.enabled),
                    lanIps: getLocalLanAddresses(),
                    port: PORT,
                    connectedBaristas: lanSseClients.size,
                    totalOrders: lanOrders.length,
                    pendingCloudSync: lanOrders.filter((o) => !o.syncedToCloud).length,
                });
            }

            if (req.method === 'GET' && pathname === '/lan/events') {
                const tenantId = String(url.searchParams.get('tenantId') || 'DEFAULT');
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache, no-transform',
                    Connection: 'keep-alive',
                    ...buildCorsHeaders(req),
                });
                const clientObj = { res, tenantId };
                lanSseClients.add(clientObj);
                const activeForTenant = lanOrders.filter(
                    (o) => !o.syncedToCloud && String(o.tenantId || 'DEFAULT') === tenantId
                );
                res.write(`event: LAN_SNAPSHOT\ndata: ${JSON.stringify({ orders: activeForTenant })}\n\n`);
                const pingTimer = setInterval(() => {
                    try {
                        res.write(': keepalive\n\n');
                    } catch {
                        clearInterval(pingTimer);
                        lanSseClients.delete(clientObj);
                    }
                }, 15000);
                req.on('close', () => {
                    clearInterval(pingTimer);
                    lanSseClients.delete(clientObj);
                });
                return;
            }

            if (req.method === 'GET' && pathname === '/lan/orders') {
                const tenantId = url.searchParams.get('tenantId');
                const includeSynced = url.searchParams.get('includeSynced') === '1';
                const list = lanOrders.filter((o) => {
                    if (tenantId && String(o.tenantId || 'DEFAULT') !== String(tenantId)) return false;
                    if (!includeSynced && o.syncedToCloud) return false;
                    return true;
                });
                return respond(200, { ok: true, orders: list });
            }

            if (req.method === 'POST' && pathname === '/lan/orders') {
                const body = await readJsonBody(req);
                const tenantId = String(body.tenantId || 'DEFAULT');
                const clientOrderUid = String(body.clientOrderUid || body.idempotencyKey || body.offlineClientId || '').trim() || null;
                const offlineId = String(body.offlineClientId || body.localInvoice?.maHoaDon || `LAN-${Date.now()}`);
                const existingIdx = lanOrders.findIndex(
                    (o) =>
                        o.tenantId === tenantId &&
                        (o.offlineClientId === offlineId || (clientOrderUid && o.clientOrderUid === clientOrderUid))
                );
                const items = (body.localInvoice?.danhSachMon || body.danhSachMon || []).map((m, idx) => ({
                    maCTHD: m.maCTHD || `${offlineId}-${idx + 1}`,
                    maHoaDon: offlineId,
                    clientOrderUid,
                    maMon: m.maMon,
                    tenMon: m.tenMon,
                    kichThuoc: m.kichThuoc || 'M',
                    soLuong: Number(m.soLuong || 1),
                    ghiChu: m.ghiChu || null,
                    modifiersSnapshot: m.modifiersSnapshot || m.modifiers || [],
                    toppings: m.toppings || [],
                    tramCheBien: m.tramCheBien || 'BAR_CHINH',
                    tenBan: body.tableName || body.localInvoice?.ban?.[0]?.tenBan || 'Mang đi',
                    trangThaiPhaChe: m.trangThaiPhaChe || 'ChoPhaChe',
                    thoiGianGoi: body.createdAt || new Date().toISOString(),
                    laDonLanOffline: true,
                }));

                const record = {
                    id: offlineId,
                    offlineClientId: offlineId,
                    clientOrderUid,
                    tenantId,
                    tableName: body.tableName || 'Mang đi',
                    type: body.type || 'ORDER_CREATE',
                    totalAmount: Number(body.totalAmount || 0),
                    items,
                    syncedToCloud: false,
                    createdAt: body.createdAt || new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };
                if (existingIdx >= 0) lanOrders[existingIdx] = record;
                else lanOrders.unshift(record);
                if (lanOrders.length > 120) lanOrders.pop();
                saveLanOrders(lanOrders);

                broadcastLanEvent(tenantId, 'LAN_ORDER_CREATED', record);
                return respond(201, { ok: true, order: record });
            }

            const lanItemStatusMatch = pathname.match(/^\/lan\/orders\/([^/]+)\/items\/([^/]+)\/status$/);
            if (req.method === 'PUT' && lanItemStatusMatch) {
                const orderId = decodeURIComponent(lanItemStatusMatch[1]);
                const itemId = decodeURIComponent(lanItemStatusMatch[2]);
                const body = await readJsonBody(req);
                const nextStatus = String(body.trangThaiPhaChe || body.status || 'DaXong');
                const order = lanOrders.find((o) => o.id === orderId || o.offlineClientId === orderId);
                if (!order) return respond(404, { ok: false, error: 'Không tìm thấy đơn LAN!' });
                const item = (order.items || []).find((i) => String(i.maCTHD) === itemId);
                if (!item) return respond(404, { ok: false, error: 'Không tìm thấy món trong đơn LAN!' });
                item.trangThaiPhaChe = nextStatus;
                if (nextStatus === 'DaXong') item.thoiGianXong = new Date().toISOString();
                order.updatedAt = new Date().toISOString();
                saveLanOrders(lanOrders);
                broadcastLanEvent(order.tenantId, 'LAN_ITEM_UPDATED', { orderId: order.id, itemId, trangThaiPhaChe: nextStatus });
                return respond(200, { ok: true, order, item });
            }

            const lanSyncedMatch = pathname.match(/^\/lan\/orders\/([^/]+)\/synced$/);
            if (req.method === 'POST' && lanSyncedMatch) {
                const orderId = decodeURIComponent(lanSyncedMatch[1]);
                const order = lanOrders.find((o) => o.id === orderId || o.offlineClientId === orderId || o.clientOrderUid === orderId);
                if (order) {
                    order.syncedToCloud = true;
                    order.syncedAt = new Date().toISOString();
                    saveLanOrders(lanOrders);
                    broadcastLanEvent(order.tenantId, 'LAN_ORDER_SYNCED', { orderId: order.id, clientOrderUid: order.clientOrderUid });
                }
                return respond(200, { ok: true });
            }
        }

        // ==================== AUDIO SOUNDBOX / PROOF-OF-PAYMENT (POST /speak) ====================
        if (req.method === 'POST' && pathname === '/speak') {
            const body = await readJsonBody(req);
            const text = String(body.text || '').trim().slice(0, 260);
            if (!text) return respond(400, { ok: false, error: 'Thiếu nội dung đọc (text)!' });
            const spokenRecord = {
                ok: true,
                spoken: true,
                text,
                amount: body.amount ? Number(body.amount) : null,
                maHoaDon: body.maHoaDon || null,
                at: new Date().toISOString(),
            };
            // Trả HTTP 202 ngay lập tức & phát loa nền (chỉ kích hoạt Windows SAPI khi chạy thực ngoài test simulator)
            if (process.platform === 'win32' && body.simulateOnly !== true && process.env.NODE_ENV !== 'test') {
                const { execFile } = require('child_process');
                const safeText = text.replace(/['"`$]/g, ' ');
                const psCmd = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('${safeText}');`;
                execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 8000 }, () => {});
            }
            broadcastLanEvent('*', 'SOUNDBOX_SPOKEN', spokenRecord);
            return respond(202, spokenRecord);
        }

        // ==================== PRINT ENDPOINTS (HTTP 202 ACCEPTED SPOOLER) ====================
        if (req.method === 'POST' && pathname === '/print/receipt') {
            const body = await readJsonBody(req);
            const outcome = await enqueuePrintJob('RECEIPT', body, { sync: Boolean(body.sync) });
            return respond(outcome.ok ? outcome.statusHttp || 202 : outcome.statusHttp || 502, outcome);
        }

        if (req.method === 'POST' && pathname === '/print/labels') {
            const body = await readJsonBody(req);
            const outcome = await enqueuePrintJob('LABEL', body, { sync: Boolean(body.sync) });
            return respond(outcome.ok ? outcome.statusHttp || 202 : outcome.statusHttp || 502, outcome);
        }

        if (req.method === 'POST' && pathname === '/print/z-report') {
            const body = await readJsonBody(req);
            const outcome = await enqueuePrintJob('Z_REPORT', body, { sync: Boolean(body.sync) });
            return respond(outcome.ok ? outcome.statusHttp || 202 : outcome.statusHttp || 502, outcome);
        }

        if (req.method === 'POST' && pathname === '/drawer/kick') {
            const body = await readJsonBody(req);
            const outcome = await enqueuePrintJob('DRAWER_KICK', body, { sync: Boolean(body.sync) });
            return respond(outcome.ok ? outcome.statusHttp || 202 : outcome.statusHttp || 502, outcome);
        }

        return respond(404, { ok: false, error: 'Endpoint Print Bridge không tồn tại' });
    } catch (err) {
        return respond(400, { ok: false, error: err.message });
    }
}

const server = http.createServer(handleBridgeRequest);

// Polling tự động mỗi 1.5s để nối tiếp các lệnh in đang tạm dừng do kẹt giấy khi cảm biến về 0x00 READY
const sensorRecoveryInterval = setInterval(() => {
    void resumePausedSpoolJobs();
}, 1500);
sensorRecoveryInterval.unref();

if (require.main === module) {
    server.listen(PORT, HOST, () => {
        const lanIps = getLocalLanAddresses();
        console.log('');
        console.log('==============================================================');
        console.log(`🖨️  CAFE POS — LOCAL PRINT BRIDGE & POS LAN HUB v3.0 đang chạy!`);
        console.log(`    Local URL:        http://127.0.0.1:${PORT}`);
        if (HOST === '0.0.0.0' && lanIps.length > 0) {
            console.log(`    LAN Hub Wi-Fi:    ${lanIps.map((ip) => `http://${ip}:${PORT}`).join(' | ')}`);
        }
        console.log(`    Spooler Disk:     ${SPOOL_PATH}`);
        console.log(`    Auth Token:       ${bridgeConfig.security?.apiToken} (dán vào Cài đặt Máy in trên POS)`);
        console.log(`    Allowed Origins:  localhost/127.0.0.1${bridgeConfig.security?.allowedOrigins?.length ? ' + ' + bridgeConfig.security.allowedOrigins.join(', ') : ''}`);
        console.log(`    Máy in Bill K80:  ${bridgeConfig.receiptPrinter.mode}`);
        console.log(`    Máy in Tem TSPL:  ${bridgeConfig.labelPrinter.mode} (${bridgeConfig.labelPrinter.widthMm}x${bridgeConfig.labelPrinter.heightMm}mm • ${bridgeConfig.labelPrinter.renderMode})`);
        console.log('==============================================================');
        console.log('');
    });
}

// Outbound Cloud-to-Local Print Relay Poller
let relayBusy = false;
if (require.main === module) {
    setInterval(async () => {
        const relay = bridgeConfig.cloudRelay;
        if (relayBusy || !relay || !relay.enabled || !relay.backendUrl || !relay.token || typeof fetch === 'undefined') {
            return;
        }
        relayBusy = true;
        try {
            const base = String(relay.backendUrl).replace(/\/+$/, '');
            const pullUrl = base.endsWith('/api') ? `${base}/print-relay/pull` : `${base}/api/print-relay/pull`;
            const ackUrl = base.endsWith('/api') ? `${base}/print-relay/ack` : `${base}/api/print-relay/ack`;
            const res = await fetch(pullUrl, {
                headers: { Authorization: `Bearer ${relay.token}` },
            });
            if (!res.ok) return;
            const data = await res.json();
            const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
            for (const rJob of jobs) {
                const outcome = await enqueuePrintJob(rJob.kind, rJob.payload || {}, { sync: true });
                await fetch(ackUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${relay.token}`,
                    },
                    body: JSON.stringify({
                        jobId: rJob.id,
                        status: outcome.ok ? 'DONE' : 'FAILED',
                        error: outcome.error || null,
                        transport: outcome.job?.transport || null,
                        bytes: outcome.job?.bytes || 0,
                    }),
                }).catch(() => {});
            }
        } catch {
            // ignore transient errors
        } finally {
            relayBusy = false;
        }
    }, 1500).unref();
}

module.exports = {
    handleBridgeRequest,
    server,
    enqueuePrintJob,
    executeJob,
    resumePausedSpoolJobs,
    printJobs,
};
