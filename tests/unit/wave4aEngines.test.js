'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    resolveEffectivePrice,
    calculateBidaSessionFee,
} = require('../../modules/priceBookAndZnsService');
const {
    distributeTipPool,
    calculateVietnamOvertimePay,
} = require('../../modules/hrPayrollTipsService');

describe('Wave 4A Unit Tests [Tầng 1]: Price Books, Bida Time-Billing, Tip Pool & Vietnam OT', () => {
    it('resolveEffectivePrice: kênh GRABFOOD tăng giá so với DINE_IN, ưu tiên chi nhánh hơn toàn chuỗi và bỏ qua bảng giá hết hạn', () => {
        const now = '2026-06-15T10:00:00+07:00';
        const entries = [
            {
                id: 1,
                code: 'GRAB_ALL',
                name: 'GrabFood toàn chuỗi',
                channel: 'GRABFOOD',
                branch_id: null,
                priority: 20,
                effective_from: '2026-01-01T00:00:00+07:00',
                effective_to: '2026-12-31T23:59:59+07:00',
                is_active: true,
                override_price: 45000,
            },
            {
                id: 2,
                code: 'GRAB_CN01',
                name: 'GrabFood riêng CN01',
                channel: 'GRABFOOD',
                branch_id: 'CN01',
                priority: 10,
                effective_from: '2026-01-01T00:00:00+07:00',
                effective_to: '2026-12-31T23:59:59+07:00',
                is_active: true,
                override_price: 49000,
            },
            {
                id: 3,
                code: 'GRAB_EXPIRED',
                name: 'GrabFood hết hạn',
                channel: 'GRABFOOD',
                branch_id: 'CN01',
                priority: 99,
                effective_from: '2025-01-01T00:00:00+07:00',
                effective_to: '2025-12-31T23:59:59+07:00',
                is_active: true,
                override_price: 99000,
            },
        ];

        // DINE_IN fallback về basePrice
        const dineIn = resolveEffectivePrice({
            basePrice: 35000,
            priceBookEntries: entries,
            channel: 'DINE_IN',
            branchId: 'CN01',
            atTime: now,
        });
        assert.equal(dineIn.effectivePrice, 35000);
        assert.equal(dineIn.source, 'BASE_PRICE');

        // GRABFOOD tại CN02 (không có book riêng) -> lấy book toàn chuỗi 45.000đ (> DINE_IN 35.000đ)
        const grabCn02 = resolveEffectivePrice({
            basePrice: 35000,
            priceBookEntries: entries,
            channel: 'GRABFOOD',
            branchId: 'CN02',
            atTime: now,
        });
        assert.equal(grabCn02.effectivePrice, 45000);
        assert.equal(grabCn02.matchedPriceBook.code, 'GRAB_ALL');

        // GRABFOOD tại CN01 -> ưu tiên book riêng chi nhánh 49.000đ, bỏ qua book hết hạn 99.000đ
        const grabCn01 = resolveEffectivePrice({
            basePrice: 35000,
            priceBookEntries: entries,
            channel: 'GRABFOOD',
            branchId: 'CN01',
            atTime: now,
        });
        assert.equal(grabCn01.effectivePrice, 49000);
        assert.equal(grabCn01.matchedPriceBook.code, 'GRAB_CN01');
    });

    it('calculateBidaSessionFee: chơi 95 phút (15 phút tạm dừng = 80 phút thực), tách giờ thường + cao điểm, làm tròn block 15p ra 90 phút tính tiền, không lệch floating-point', () => {
        const res = calculateBidaSessionFee({
            startedAt: '2026-06-15T17:00:00+07:00',
            endedAt: '2026-06-15T18:35:00+07:00', // 95 phút
            totalPausedSeconds: 15 * 60,          // 15 phút tạm dừng -> 80 phút thực
            hourlyRate: 60000,                    // 1.000đ/phút giờ thường
            peakHourlyRate: 90000,                // 1.500đ/phút giờ cao điểm (18h-23h)
            peakStartHour: 18,
            peakEndHour: 23,
            billingBlockMinutes: 15,
        });

        assert.equal(res.rawMinutes, 95);
        assert.equal(res.pausedMinutes, 15);
        assert.equal(res.activeMinutes, 80);
        assert.equal(res.billedMinutes, 90);
        assert.equal(res.normalMinutes, 60);
        assert.equal(res.peakMinutes, 30);
        // 60p * 60.000/60 + 30p * 90.000/60 = 60.000 + 45.000 = 105.000đ chính xác
        assert.equal(res.totalAmount, 105000);
        assert.equal(Number.isInteger(res.totalAmount), true);
    });

    it('distributeTipPool: chia 100.000đ cho 3 nhân viên với giờ công khác nhau -> tổng phân bổ đúng 100.000đ (lệch 0đ)', () => {
        const result = distributeTipPool(
            100000,
            [
                { maNV: 'NV01', hoursWorked: 3 },
                { maNV: 'NV02', hoursWorked: 4 },
                { maNV: 'NV03', hoursWorked: 2 },
            ],
            'BY_HOURS'
        );

        assert.equal(result.totalAmount, 100000);
        assert.equal(result.allocatedTotal, 100000);
        assert.equal(result.diff, 0);
        assert.equal(result.allocations.length, 3);
        const sum = result.allocations.reduce((acc, a) => acc + a.allocatedAmount, 0);
        assert.equal(sum, 100000);
        assert.ok(result.allocations[1].allocatedAmount > result.allocations[0].allocatedAmount);
    });

    it('calculateVietnamOvertimePay: đủ 3 mốc WEEKDAY (150%), WEEKEND (200%), HOLIDAY (300%) và phụ cấp ca đêm', () => {
        const weekday = calculateVietnamOvertimePay({
            baseHourlyRate: 40000,
            otHours: 2,
            dayType: 'WEEKDAY',
            nightHours: 0,
        });
        assert.equal(weekday.otMultiplier, 1.5);
        assert.equal(weekday.otPay, 120000);
        assert.equal(weekday.nightAllowance, 0);

        const weekend = calculateVietnamOvertimePay({
            baseHourlyRate: 40000,
            otHours: 3,
            dayType: 'WEEKEND',
            nightHours: 0,
        });
        assert.equal(weekend.otMultiplier, 2.0);
        assert.equal(weekend.otPay, 240000);

        const holidayNight = calculateVietnamOvertimePay({
            baseHourlyRate: 40000,
            otHours: 2,
            dayType: 'HOLIDAY',
            nightHours: 2,
        });
        assert.equal(holidayNight.otMultiplier, 3.0);
        assert.equal(holidayNight.otPay, 240000);
        // 30% phụ cấp đêm (24.000) + 20% phụ trội OT đêm (16.000) = 40.000
        assert.equal(holidayNight.nightBaseAllowance, 24000);
        assert.equal(holidayNight.nightOtExtraAllowance, 16000);
        assert.equal(holidayNight.nightAllowance, 40000);
        assert.equal(holidayNight.totalPay, 280000);
    });
});
