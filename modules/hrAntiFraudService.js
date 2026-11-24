/**
 * Wave 3B (P1-04): Chấm công chống gian lận 3 lớp
 *   Lớp 1: Kiosk QR động HMAC-SHA256 đổi mỗi 30 giây (timingSafeEqual, cửa sổ current & current - 1 = tối đa 60s)
 *   Lớp 2: GPS Geofencing (Haversine <= geofence_radius_m, mặc định 50m) hoặc IP tĩnh cửa hàng (allowed_public_ips)
 *   Lớp 3: Chặn xếp trùng khung giờ ca (409 SHIFT_OVERLAP_CONFLICT) & Ân hạn đi trễ 5 phút
 */

const crypto = require('crypto');

const KIOSK_QR_STEP_MS = 30 * 1000;
const EARTH_RADIUS_M = 6371000;
const DEFAULT_GEOFENCE_RADIUS_M = 50;
const DEFAULT_LATE_GRACE_MINUTES = 5;

function computeHmacHex(tenantId, branchId, timeWindow, secret) {
    const payload = `${String(tenantId || '').trim()}:${String(branchId || '').trim()}:${Number(timeWindow)}`;
    return crypto.createHmac('sha256', String(secret)).update(payload).digest('hex');
}

/**
 * Sinh mã Kiosk QR động theo cửa sổ 30 giây.
 * Định dạng token: `v1.<window>.<hmacHex>`
 */
function generateKioskQrToken(tenantId, branchId, secret, nowMs = Date.now()) {
    if (!tenantId || !branchId || !secret) {
        throw new Error('Thiếu tenantId, branchId hoặc secret để sinh Kiosk QR token');
    }
    const windowIdx = Math.floor(Number(nowMs) / KIOSK_QR_STEP_MS);
    const sig = computeHmacHex(tenantId, branchId, windowIdx, secret);
    return `v1.${windowIdx}.${sig}`;
}

/**
 * Sinh payload đầy đủ cho endpoint GET /api/hr/kiosk-qr-token
 */
function createKioskQrPayload(tenantId, branchId, secret, nowMs = Date.now()) {
    const now = Number(nowMs);
    const windowIdx = Math.floor(now / KIOSK_QR_STEP_MS);
    const token = generateKioskQrToken(tenantId, branchId, secret, now);
    const nextWindowStartMs = (windowIdx + 1) * KIOSK_QR_STEP_MS;
    const expiresInSec = Math.max(1, Math.ceil((nextWindowStartMs - now) / 1000));
    return {
        token,
        window: windowIdx,
        expiresInSec,
        refreshIntervalSec: 30,
        validUntil: new Date(nextWindowStartMs).toISOString(),
        tenantId: String(tenantId),
        branchId: String(branchId),
    };
}

/**
 * Xác thực mã Kiosk QR động:
 * - Dùng crypto.timingSafeEqual
 * - Chỉ chấp nhận cửa sổ `current` hoặc `current - 1` (tối đa 60 giây)
 */
function verifyKioskQrToken(tokenInput, tenantId, branchId, secret, nowMs = Date.now()) {
    const raw = typeof tokenInput === 'object' && tokenInput !== null ? tokenInput.token : tokenInput;
    const token = String(raw || '').trim();
    if (!token || !tenantId || !branchId || !secret) {
        return { valid: false, reason: 'MISSING_TOKEN_OR_SECRET' };
    }

    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') {
        return { valid: false, reason: 'MALFORMED_TOKEN' };
    }

    const tokenWindow = Number(parts[1]);
    const providedHex = parts[2];
    if (!Number.isInteger(tokenWindow) || !/^[a-f0-9]{64}$/i.test(providedHex)) {
        return { valid: false, reason: 'MALFORMED_TOKEN' };
    }

    const currentWindow = Math.floor(Number(nowMs) / KIOSK_QR_STEP_MS);
    const diff = currentWindow - tokenWindow;
    if (diff < 0 || diff > 1) {
        return { valid: false, reason: 'EXPIRED_OR_FUTURE_TOKEN', window: tokenWindow, currentWindow };
    }

    const expectedHex = computeHmacHex(tenantId, branchId, tokenWindow, secret);
    const providedBuf = Buffer.from(providedHex.toLowerCase(), 'hex');
    const expectedBuf = Buffer.from(expectedHex.toLowerCase(), 'hex');
    if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
        return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    return { valid: true, window: tokenWindow, currentWindow };
}

/**
 * Tính khoảng cách Haversine (mét) giữa 2 tọa độ GPS (lat, lng).
 */
function calculateHaversineMeters(lat1, lng1, lat2, lng2) {
    const aLat = Number(lat1);
    const aLng = Number(lng1);
    const bLat = Number(lat2);
    const bLng = Number(lng2);
    if (![aLat, aLng, bLat, bLng].every(Number.isFinite)) {
        return NaN;
    }
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLng = toRad(bLng - aLng);
    const sinLat = Math.sin(dLat / 2);
    const sinLng = Math.sin(dLng / 2);
    const h = sinLat * sinLat + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * sinLng * sinLng;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function normalizeClientIp(ip) {
    const raw = String(ip || '').split(',')[0].trim();
    if (!raw) return '';
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function isIpAllowed(clientIp, allowedPublicIps) {
    const list = Array.isArray(allowedPublicIps) ? allowedPublicIps.map((x) => normalizeClientIp(x)).filter(Boolean) : [];
    if (list.length === 0) return false;
    const normalized = normalizeClientIp(clientIp);
    if (!normalized) return false;
    return list.includes(normalized);
}

/**
 * Kiểm tra GPS Geofencing hoặc IP tĩnh cửa hàng.
 * Nếu chi nhánh chưa cấu hình cả GPS lẫn IP và client không gửi GPS -> cho phép (backward-compatible).
 * Nếu chi nhánh đã cấu hình GPS/IP hoặc client gửi tọa độ GPS -> bắt buộc khớp 1 trong 2 lớp.
 */
function verifyLocationOrIp({
    branchGeoLat,
    branchGeoLng,
    geofenceRadiusM = DEFAULT_GEOFENCE_RADIUS_M,
    allowedPublicIps = [],
    checkinLat,
    checkinLng,
    clientIp,
}) {
    const hasBranchGeo = Number.isFinite(Number(branchGeoLat)) && Number.isFinite(Number(branchGeoLng))
        && branchGeoLat !== null && branchGeoLng !== null;
    const hasAllowedIps = Array.isArray(allowedPublicIps) && allowedPublicIps.filter(Boolean).length > 0;
    const hasCheckinGeo = checkinLat !== undefined && checkinLat !== null && checkinLat !== ''
        && checkinLng !== undefined && checkinLng !== null && checkinLng !== ''
        && Number.isFinite(Number(checkinLat)) && Number.isFinite(Number(checkinLng));

    if (!hasBranchGeo && !hasAllowedIps) {
        return { ok: true, method: 'UNCONFIGURED', distanceMeters: null };
    }

    if (hasAllowedIps && isIpAllowed(clientIp, allowedPublicIps)) {
        return { ok: true, method: 'STATIC_IP', distanceMeters: null };
    }

    if (hasBranchGeo && hasCheckinGeo) {
        const radius = Number.isFinite(Number(geofenceRadiusM)) ? Number(geofenceRadiusM) : DEFAULT_GEOFENCE_RADIUS_M;
        const dist = calculateHaversineMeters(branchGeoLat, branchGeoLng, checkinLat, checkinLng);
        if (Number.isFinite(dist) && dist <= radius) {
            return { ok: true, method: 'GPS_GEOFENCE', distanceMeters: Math.round(dist * 100) / 100 };
        }
        return {
            ok: false,
            reason: 'OUT_OF_GEOFENCE',
            distanceMeters: Number.isFinite(dist) ? Math.round(dist * 100) / 100 : null,
            radiusMeters: radius,
        };
    }

    return {
        ok: false,
        reason: hasBranchGeo ? 'MISSING_GPS_COORDINATES' : 'IP_NOT_ALLOWED',
        distanceMeters: null,
    };
}

function parseTimeToMinutes(timeStr) {
    const m = String(timeStr || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return NaN;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return NaN;
    return hh * 60 + mm;
}

/**
 * Kiểm tra 2 khung giờ ca có chồng lấn nhau trong cùng ngày không.
 */
function isShiftTimeOverlapping(startA, endA, startB, endB) {
    const a1 = parseTimeToMinutes(startA);
    let a2 = parseTimeToMinutes(endA);
    const b1 = parseTimeToMinutes(startB);
    let b2 = parseTimeToMinutes(endB);
    if (![a1, a2, b1, b2].every(Number.isFinite)) return false;
    if (a2 <= a1) a2 += 24 * 60;
    if (b2 <= b1) b2 += 24 * 60;
    return a1 < b2 && b1 < a2;
}

/**
 * Tính số phút đi trễ có ân hạn mặc định 5 phút:
 * late_minutes = Math.max(0, diffMin - graceMinutes)
 */
function calculateLateMinutes(shiftStartTimeStr, checkinTimeStr, graceMinutes = DEFAULT_LATE_GRACE_MINUTES) {
    const shiftMin = parseTimeToMinutes(shiftStartTimeStr);
    const checkinMin = parseTimeToMinutes(checkinTimeStr);
    if (!Number.isFinite(shiftMin) || !Number.isFinite(checkinMin)) return 0;
    const diffMin = checkinMin - shiftMin;
    return Math.max(0, diffMin - Number(graceMinutes || 0));
}

module.exports = {
    KIOSK_QR_STEP_MS,
    DEFAULT_GEOFENCE_RADIUS_M,
    DEFAULT_LATE_GRACE_MINUTES,
    generateKioskQrToken,
    createKioskQrPayload,
    verifyKioskQrToken,
    calculateHaversineMeters,
    normalizeClientIp,
    isIpAllowed,
    verifyLocationOrIp,
    parseTimeToMinutes,
    isShiftTimeOverlapping,
    calculateLateMinutes,
};
