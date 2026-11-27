#!/usr/bin/env node
'use strict';

/**
 * Cafe POS — Pilot Environment & Print Bridge Pre-Flight Validator
 *
 * Chạy độc lập, TUYỆT ĐỐI KHÔNG kết nối hay sửa đổi Database.
 * Cách dùng:
 *   npm run verify:pilot-env
 *   node scripts/verify-pilot-env.js --env .env.production
 *   node scripts/verify-pilot-env.js --bridge local-print-bridge/bridge-config.json
 *   node scripts/verify-pilot-env.js --env .env.production --bridge local-print-bridge/bridge-config.json
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { loiJwtSecret } = require('../config');

const WEAK_ADMIN_PASSWORDS = new Set([
    'superadmin@2026',
    'admin',
    'admin123',
    'admin@123',
    '123456',
    '12345678',
    'password',
    'password123',
    'changeme',
    'qwerty',
    'cafepos',
    'cafepos123',
]);

const FORBIDDEN_BROAD_WILDCARDS = [
    /^https?:\/\/\*\.vercel\.app(?::\d+)?$/i,
    /^https?:\/\/\*\.netlify\.app(?::\d+)?$/i,
    /^https?:\/\/\*\.onrender\.com(?::\d+)?$/i,
    /^https?:\/\/\*\.pages\.dev(?::\d+)?$/i,
    /^https?:\/\/\*\.fly\.dev(?::\d+)?$/i,
];

function parseCliArgs(argv) {
    const out = { envFile: null, bridgeFile: null, bridgeOnly: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--env' && argv[i + 1]) {
            out.envFile = argv[++i];
        } else if (arg.startsWith('--env=')) {
            out.envFile = arg.slice('--env='.length);
        } else if (arg === '--bridge' && argv[i + 1]) {
            out.bridgeFile = argv[++i];
        } else if (arg.startsWith('--bridge=')) {
            out.bridgeFile = arg.slice('--bridge='.length);
        } else if (arg === '--bridge-only') {
            out.bridgeOnly = true;
        }
    }
    return out;
}

function parsePostgresUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return { valid: false, reason: 'trống' };
    try {
        const u = new URL(s);
        if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
            return { valid: false, reason: `protocol "${u.protocol}" không phải postgres:// hoặc postgresql://` };
        }
        if (!u.hostname) return { valid: false, reason: 'thiếu hostname' };
        const port = u.port ? Number(u.port) : 5432;
        const username = decodeURIComponent(u.username || '');
        const pgbouncer = /pgbouncer=true/i.test(u.search || '');
        return { valid: true, url: u, port, username, hostname: u.hostname, pgbouncer, raw: s };
    } catch {
        return { valid: false, reason: 'không đúng định dạng URI hợp lệ' };
    }
}

function validatePilotEnv(env) {
    const passes = [];
    const warnings = [];
    const failures = [];

    const pass = (name, detail) => passes.push({ name, detail });
    const warn = (name, detail) => warnings.push({ name, detail });
    const fail = (name, detail) => failures.push({ name, detail });

    // 1. NODE_ENV
    const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
    if (nodeEnv === 'production') {
        pass('NODE_ENV', 'production');
    } else {
        fail('NODE_ENV', `Phải đặt NODE_ENV=production (hiện tại: "${env.NODE_ENV || ''}")`);
    }

    // 2. SKIP_AUTO_DDL
    const skipAutoDdl = String(env.SKIP_AUTO_DDL || '').trim().toLowerCase();
    if (skipAutoDdl === 'true') {
        pass('SKIP_AUTO_DDL', 'true (khóa Auto-DDL trên Production)');
    } else {
        fail('SKIP_AUTO_DDL', `Phải đặt SKIP_AUTO_DDL=true (hiện tại: "${env.SKIP_AUTO_DDL || ''}")`);
    }

    // 3. TRUST_PROXY
    const trustProxy = String(env.TRUST_PROXY || '').trim().toLowerCase();
    if (trustProxy === '1' || trustProxy === 'true') {
        pass('TRUST_PROXY', `${env.TRUST_PROXY}`);
    } else {
        fail('TRUST_PROXY', `Phải đặt TRUST_PROXY=1 khi chạy sau Render/Fly/Cloudflare (hiện tại: "${env.TRUST_PROXY || ''}")`);
    }

    // 4. COOKIE_SAMESITE & COOKIE_SECURE
    const sameSite = String(env.COOKIE_SAMESITE || '').trim();
    const cookieSecure = String(env.COOKIE_SECURE || '').trim().toLowerCase();
    if (/^(None|Lax)$/i.test(sameSite)) {
        pass('COOKIE_SAMESITE', `${sameSite} (None cho cross-domain Vercel<->Render/Fly, Lax cho cùng root domain)`);
    } else {
        fail('COOKIE_SAMESITE', `Phải đặt COOKIE_SAMESITE=None (cross-domain) hoặc Lax (cùng root domain) (hiện tại: "${sameSite}")`);
    }
    if (cookieSecure === 'true') {
        pass('COOKIE_SECURE', 'true');
    } else {
        fail('COOKIE_SECURE', `Phải đặt COOKIE_SECURE=true trên Production HTTPS (hiện tại: "${env.COOKIE_SECURE || ''}")`);
    }

    // 5. Tách biệt 3 kết nối DB: DATABASE_URL, PLATFORM_DATABASE_URL, MIGRATION_DATABASE_URL
    const runtimeDb = parsePostgresUrl(env.DATABASE_URL);
    const platformDb = parsePostgresUrl(env.PLATFORM_DATABASE_URL);
    const migrationDb = parsePostgresUrl(env.MIGRATION_DATABASE_URL);

    if (!runtimeDb.valid) {
        fail('DATABASE_URL', `Không hợp lệ (${runtimeDb.reason})`);
    } else if (!/^app_runtime(\.|$)/i.test(runtimeDb.username)) {
        fail(
            'DATABASE_URL',
            `Role kết nối runtime phải là "app_runtime" (hoặc "app_runtime.<ref>" trên Supabase Pooler) có NOBYPASSRLS — hiện tại đang dùng "${runtimeDb.username || '(trống)'}"`
        );
    } else {
        pass('DATABASE_URL', `Role "${runtimeDb.username}" @ ${runtimeDb.hostname}:${runtimeDb.port}`);
    }

    if (!platformDb.valid) {
        fail('PLATFORM_DATABASE_URL', `Bắt buộc cấu hình riêng cho Super Admin (Migration 039 thu hồi quyền app_runtime) — lỗi: ${platformDb.reason}`);
    } else if (runtimeDb.valid && platformDb.raw === runtimeDb.raw) {
        fail('PLATFORM_DATABASE_URL', 'PLATFORM_DATABASE_URL KHÔNG ĐƯỢC trùng với DATABASE_URL!');
    } else if (/^app_runtime(\.|$)/i.test(platformDb.username)) {
        fail('PLATFORM_DATABASE_URL', 'PLATFORM_DATABASE_URL không được dùng role app_runtime (sẽ bị PG 42501 sau Migration 039)!');
    } else {
        pass('PLATFORM_DATABASE_URL', `Tách biệt với DATABASE_URL (role "${platformDb.username}" @ ${platformDb.hostname}:${platformDb.port})`);
    }

    if (!migrationDb.valid) {
        fail('MIGRATION_DATABASE_URL', `Bắt buộc cấu hình kết nối Direct (cổng 5432) cho scripts/run-migration.js — lỗi: ${migrationDb.reason}`);
    } else if (migrationDb.port !== 5432 || migrationDb.pgbouncer) {
        fail(
            'MIGRATION_DATABASE_URL',
            `Phải dùng cổng Direct 5432 (không dùng PgBouncer 6543 / pgbouncer=true) — hiện tại: port=${migrationDb.port}, pgbouncer=${migrationDb.pgbouncer}`
        );
    } else if (/^app_runtime(\.|$)/i.test(migrationDb.username)) {
        fail('MIGRATION_DATABASE_URL', 'MIGRATION_DATABASE_URL phải dùng role owner có quyền DDL, không dùng app_runtime!');
    } else {
        pass('MIGRATION_DATABASE_URL', `Direct port 5432 (role "${migrationDb.username}" @ ${migrationDb.hostname}:5432)`);
    }

    // 6. JWT_SECRET
    const jwtErrors = loiJwtSecret(env.JWT_SECRET);
    if (jwtErrors.length === 0) {
        pass('JWT_SECRET', `Đạt chuẩn (>= 32 ký tự ngẫu nhiên, độ dài ${String(env.JWT_SECRET).length})`);
    } else {
        fail('JWT_SECRET', jwtErrors.join(' | ').replace(/\s+/g, ' '));
    }

    // 7. FRONTEND_URL (HTTPS hợp lệ, không wildcard *)
    const rawFrontend = String(env.FRONTEND_URL || '').trim();
    if (!rawFrontend) {
        fail('FRONTEND_URL', 'Thiếu FRONTEND_URL (bắt buộc là danh sách origin HTTPS hợp lệ, không chứa *)');
    } else {
        const origins = rawFrontend.split(',').map((s) => s.trim()).filter(Boolean);
        const badOrigins = [];
        for (const origin of origins) {
            if (origin.includes('*')) {
                badOrigins.push(`${origin} (chứa wildcard *)`);
                continue;
            }
            try {
                const u = new URL(origin);
                if (u.protocol !== 'https:') {
                    badOrigins.push(`${origin} (phải là HTTPS)`);
                } else if (u.pathname && u.pathname !== '/') {
                    badOrigins.push(`${origin} (không để kèm path "${u.pathname}")`);
                }
            } catch {
                badOrigins.push(`${origin} (URL không hợp lệ)`);
            }
        }
        if (badOrigins.length > 0) {
            fail('FRONTEND_URL', `Origin không hợp lệ: ${badOrigins.join(', ')}`);
        } else {
            pass('FRONTEND_URL', `${origins.length} origin HTTPS hợp lệ (${origins.join(', ')})`);
        }
    }

    // 8. PLATFORM_ADMIN_USERNAME & PLATFORM_ADMIN_PASSWORD
    const adminUser = String(env.PLATFORM_ADMIN_USERNAME || '').trim();
    const adminPass = String(env.PLATFORM_ADMIN_PASSWORD || '');
    if (!adminUser) {
        fail('PLATFORM_ADMIN_USERNAME', 'Thiếu PLATFORM_ADMIN_USERNAME');
    } else {
        pass('PLATFORM_ADMIN_USERNAME', `Đã cấu hình ("${adminUser}")`);
        if (adminUser.toLowerCase() === 'superadmin') {
            warn('PLATFORM_ADMIN_USERNAME', 'Đang dùng tên mặc định "superadmin" — khuyến nghị đổi tên riêng khó đoán hơn.');
        }
    }

    if (!adminPass) {
        fail('PLATFORM_ADMIN_PASSWORD', 'Thiếu PLATFORM_ADMIN_PASSWORD (tuyệt đối không để trống rơi về mật khẩu mặc định!)');
    } else if (WEAK_ADMIN_PASSWORDS.has(adminPass.trim().toLowerCase())) {
        fail('PLATFORM_ADMIN_PASSWORD', 'Đang dùng mật khẩu mặc định/yếu (ví dụ SuperAdmin@2026) — bắt buộc đổi ngay!');
    } else if (adminPass.length < 12) {
        fail('PLATFORM_ADMIN_PASSWORD', `Quá ngắn (${adminPass.length} ký tự), yêu cầu tối thiểu 12 ký tự gồm chữ hoa, thường, số và ký tự đặc biệt.`);
    } else {
        const hasUpper = /[A-Z]/.test(adminPass);
        const hasLower = /[a-z]/.test(adminPass);
        const hasDigit = /\d/.test(adminPass);
        const hasSpecial = /[^A-Za-z0-9]/.test(adminPass);
        if (!(hasUpper && hasLower && hasDigit && hasSpecial)) {
            warn('PLATFORM_ADMIN_PASSWORD', 'Khuyến nghị mật khẩu Super Admin có đủ chữ HOA, chữ thường, số và ký tự đặc biệt.');
        } else {
            pass('PLATFORM_ADMIN_PASSWORD', `Đạt chuẩn mạnh (${adminPass.length} ký tự)`);
        }
    }

    return { passes, warnings, failures };
}

function validateBridgeConfig(configPath) {
    const passes = [];
    const warnings = [];
    const failures = [];

    const pass = (name, detail) => passes.push({ name, detail });
    const warn = (name, detail) => warnings.push({ name, detail });
    const fail = (name, detail) => failures.push({ name, detail });

    const resolved = path.resolve(configPath);
    if (!fs.existsSync(resolved)) {
        fail('bridge-config', `Không tìm thấy file: ${resolved}`);
        return { passes, warnings, failures };
    }

    let cfg;
    try {
        const rawText = fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, '');
        cfg = JSON.parse(rawText);
    } catch (err) {
        fail('bridge-config', `File JSON không hợp lệ: ${err.message}`);
        return { passes, warnings, failures };
    }

    // 1. security.apiToken
    const apiToken = String(cfg?.security?.apiToken || '').trim();
    if (!apiToken || apiToken.length < 16) {
        fail('bridge.security.apiToken', 'Thiếu hoặc quá ngắn (< 16 ký tự). Bắt buộc đặt token ngẫu nhiên mạnh.');
    } else {
        pass('bridge.security.apiToken', `Đã cấu hình (${apiToken.length} ký tự)`);
    }

    // 2. security.allowedOrigins
    const origins = Array.isArray(cfg?.security?.allowedOrigins)
        ? cfg.security.allowedOrigins.map((o) => String(o || '').trim()).filter(Boolean)
        : [];
    if (origins.length === 0) {
        fail('bridge.security.allowedOrigins', 'Rỗng! Bắt buộc khai báo chính xác domain POS của quán.');
    } else {
        const bad = [];
        for (const o of origins) {
            if (o === '*' || o.includes('://*')) {
                bad.push(`${o} (chứa wildcard *)`);
            } else if (FORBIDDEN_BROAD_WILDCARDS.some((re) => re.test(o))) {
                bad.push(`${o} (cấm wildcard domain công cộng như *.vercel.app)`);
            } else if (o.includes('*')) {
                bad.push(`${o} (chứa wildcard * không an toàn cho máy quầy)`);
            }
        }
        if (bad.length > 0) {
            fail('bridge.security.allowedOrigins', `Origin không an toàn: ${bad.join(', ')}`);
        } else {
            pass('bridge.security.allowedOrigins', `An toàn: ${origins.join(', ')}`);
        }
    }

    // 3. Kiểm tra shareName & sensorProbeEnabled cho tất cả các máy in
    const printerKeys = ['receiptPrinter', 'labelPrinter', 'fallbackPrinter'];
    for (const key of printerKeys) {
        const p = cfg?.[key];
        if (!p || typeof p !== 'object') continue;
        if (key === 'fallbackPrinter' && p.enabled !== true) continue;

        const shareName = String(p.shareName || '').trim();
        if (shareName.startsWith('\\\\') || shareName.startsWith('//') || shareName.includes('\\') || shareName.includes('/')) {
            fail(`bridge.${key}.shareName`, `Không hợp lệ ("${shareName}") — cấm đường dẫn UNC bắt đầu bằng \\\\ hoặc chứa dấu gạch chéo!`);
        } else if (shareName) {
            pass(`bridge.${key}.shareName`, `"${shareName}" hợp lệ (không phải đường dẫn UNC từ xa)`);
        }

        const mode = String(p.mode || 'SIMULATOR').toUpperCase();
        if (mode === 'LAN_TCP' && p.sensorProbeEnabled === true) {
            warn(
                `bridge.${key}.sensorProbeEnabled`,
                'Đang bật sensorProbeEnabled=true với mode=LAN_TCP. Nhiều máy in nhiệt giá rẻ (Xprinter/Zywell) không phản hồi DLE EOT/<ESC>!? qua TCP 9100 -> dễ gây timeout treo lệnh in. Khuyến nghị đặt false!'
            );
        } else if (mode === 'LAN_TCP') {
            pass(`bridge.${key}.sensorProbeEnabled`, 'false (an toàn cho máy in LAN_TCP K80/TSPL)');
        }
    }

    return { passes, warnings, failures };
}

function printSection(title, result) {
    console.log(`\n=== ${title} ===`);
    for (const p of result.passes) {
        console.log(`  [PASS] ${p.name}: ${p.detail}`);
    }
    for (const w of result.warnings) {
        console.log(`  [WARN] ${w.name}: ${w.detail}`);
    }
    for (const f of result.failures) {
        console.log(`  [FAIL] ${f.name}: ${f.detail}`);
    }
}

function main() {
    const opts = parseCliArgs(process.argv.slice(2));
    let totalFail = 0;
    let totalWarn = 0;

    if (!opts.bridgeOnly) {
        let envToCheck = { ...process.env };
        if (opts.envFile) {
            const envPath = path.resolve(opts.envFile);
            if (!fs.existsSync(envPath)) {
                console.error(`❌ Không tìm thấy file env: ${envPath}`);
                process.exit(1);
            }
            const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
            envToCheck = parsed;
        }
        const envRes = validatePilotEnv(envToCheck);
        printSection('PILOT BACKEND ENV PRE-FLIGHT', envRes);
        totalFail += envRes.failures.length;
        totalWarn += envRes.warnings.length;
    }

    if (opts.bridgeFile) {
        const bridgeRes = validateBridgeConfig(opts.bridgeFile);
        printSection(`LOCAL PRINT BRIDGE CONFIG (${opts.bridgeFile})`, bridgeRes);
        totalFail += bridgeRes.failures.length;
        totalWarn += bridgeRes.warnings.length;
    }

    console.log('\n--------------------------------------------------');
    if (totalFail > 0) {
        console.error(`❌ PRE-FLIGHT FAILED: ${totalFail} lỗi bắt buộc sửa, ${totalWarn} cảnh báo.`);
        process.exit(1);
    }
    console.log(`✅ PRE-FLIGHT PASSED (0 lỗi, ${totalWarn} cảnh báo). Sẵn sàng triển khai Pilot!`);
    process.exit(0);
}

if (require.main === module) {
    main();
}

module.exports = {
    validatePilotEnv,
    validateBridgeConfig,
};
