const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    generateKioskQrToken,
    verifyKioskQrToken,
    calculateHaversineMeters,
    verifyLocationOrIp,
    isShiftTimeOverlapping,
    calculateLateMinutes,
} = require('../../modules/hrAntiFraudService');

describe('Wave 3B Unit [Tầng 1]: Kiosk QR HMAC 30s, Haversine GPS & Shift Overlap', () => {
    const tenantId = 'TENANT_TEST';
    const branchId = 'CN01';
    const secret = 'super-secret-kiosk-hmac-key-2026';

    it('chấp nhận Kiosk QR token ở cửa sổ hiện tại (0s) và cửa sổ trước (30s)', () => {
        const t0 = 1_760_000_000_000; // mốc cố định
        const tokenNow = generateKioskQrToken(tenantId, branchId, secret, t0);
        const resNow = verifyKioskQrToken(tokenNow, tenantId, branchId, secret, t0);
        assert.equal(resNow.valid, true);

        // 30 giây sau (cửa sổ current - 1) vẫn hợp lệ
        const resPrevWindow = verifyKioskQrToken(tokenNow, tenantId, branchId, secret, t0 + 30_000);
        assert.equal(resPrevWindow.valid, true);
    });

    it('từ chối Kiosk QR token cũ > 60s, sai branchId hoặc sai chữ ký HMAC', () => {
        const t0 = 1_760_000_000_000;
        const token = generateKioskQrToken(tenantId, branchId, secret, t0);

        // Quá 60 giây (2 cửa sổ 30s) -> EXPIRED
        const resExpired = verifyKioskQrToken(token, tenantId, branchId, secret, t0 + 61_000);
        assert.equal(resExpired.valid, false);
        assert.equal(resExpired.reason, 'EXPIRED_OR_FUTURE_TOKEN');

        // Sai branchId -> INVALID_SIGNATURE
        const resWrongBranch = verifyKioskQrToken(token, tenantId, 'CN02', secret, t0);
        assert.equal(resWrongBranch.valid, false);
        assert.equal(resWrongBranch.reason, 'INVALID_SIGNATURE');

        // Sai secret -> INVALID_SIGNATURE
        const resWrongSecret = verifyKioskQrToken(token, tenantId, branchId, 'wrong-secret', t0);
        assert.equal(resWrongSecret.valid, false);
        assert.equal(resWrongSecret.reason, 'INVALID_SIGNATURE');
    });

    it('calculateHaversineMeters: ~20m trả <= 50m, ~2km trả > 1900m', () => {
        const baseLat = 10.776889;
        const baseLng = 106.700806;

        // Dịch ~20m về phía Bắc (0.00018 độ vĩ độ ≈ 20m)
        const dist20m = calculateHaversineMeters(baseLat, baseLng, baseLat + 0.00018, baseLng);
        assert.ok(dist20m <= 50, `Expected <= 50m, got ${dist20m}`);
        assert.ok(dist20m >= 10, `Expected >= 10m, got ${dist20m}`);

        // Dịch ~2km về phía Bắc (0.018 độ vĩ độ ≈ 2001m)
        const dist2km = calculateHaversineMeters(baseLat, baseLng, baseLat + 0.018, baseLng);
        assert.ok(dist2km > 1900, `Expected > 1900m, got ${dist2km}`);

        // verifyLocationOrIp: trong bán kính 50m ok, ngoài bán kính bị chặn trừ khi trùng IP tĩnh
        const okNear = verifyLocationOrIp({
            branchGeoLat: baseLat,
            branchGeoLng: baseLng,
            geofenceRadiusM: 50,
            checkinLat: baseLat + 0.00018,
            checkinLng: baseLng,
            clientIp: '1.2.3.4',
        });
        assert.equal(okNear.ok, true);
        assert.equal(okNear.method, 'GPS_GEOFENCE');

        const blockedFar = verifyLocationOrIp({
            branchGeoLat: baseLat,
            branchGeoLng: baseLng,
            geofenceRadiusM: 50,
            checkinLat: baseLat + 0.018,
            checkinLng: baseLng,
            clientIp: '1.2.3.4',
        });
        assert.equal(blockedFar.ok, false);
        assert.equal(blockedFar.reason, 'OUT_OF_GEOFENCE');

        const okIp = verifyLocationOrIp({
            branchGeoLat: baseLat,
            branchGeoLng: baseLng,
            geofenceRadiusM: 50,
            allowedPublicIps: ['113.161.72.10'],
            checkinLat: baseLat + 0.018,
            checkinLng: baseLng,
            clientIp: '::ffff:113.161.72.10',
        });
        assert.equal(okIp.ok, true);
        assert.equal(okIp.method, 'STATIC_IP');
    });

    it('isShiftTimeOverlapping & calculateLateMinutes (ân hạn 5 phút)', () => {
        assert.equal(isShiftTimeOverlapping('07:00', '12:00', '11:00', '16:00'), true);
        assert.equal(isShiftTimeOverlapping('07:00', '12:00', '12:00', '17:00'), false);
        assert.equal(isShiftTimeOverlapping('07:00', '12:00', '13:00', '18:00'), false);

        assert.equal(calculateLateMinutes('07:00:00', '07:04:00', 5), 0);
        assert.equal(calculateLateMinutes('07:00:00', '07:05:00', 5), 0);
        assert.equal(calculateLateMinutes('07:00:00', '07:12:00', 5), 7);
    });
});
