'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeBusinessDate } = require('../../src/domains/reports/businessDaySummaryService');
const { shouldRunAutoDdl } = require('../../db');

describe('Wave 4B Unit [Tầng 1] — Business Day Cutoff 04:00 & Production Auto-DDL Lock (P2-01)', () => {
    describe('computeBusinessDate(dateInput, cutoffHour = 4, tzOffsetMinutes = 420)', () => {
        it('2026-11-24T23:30:00+07:00 với cutoff 04:00 thuộc ngày kinh doanh 2026-11-24', () => {
            assert.equal(computeBusinessDate('2026-11-24T23:30:00+07:00', 4, 420), '2026-11-24');
        });

        it('2026-11-25T03:59:59+07:00 với cutoff 04:00 vẫn thuộc ngày kinh doanh hôm trước (2026-11-24)', () => {
            assert.equal(computeBusinessDate('2026-11-25T03:59:59+07:00', 4, 420), '2026-11-24');
        });

        it('2026-11-25T04:00:00+07:00 với cutoff 04:00 bắt đầu ngày kinh doanh mới (2026-11-25)', () => {
            assert.equal(computeBusinessDate('2026-11-25T04:00:00+07:00', 4, 420), '2026-11-25');
        });

        it('2026-11-25T02:15:00+07:00 (giờ bán khuya) với mặc định cutoff 4 thuộc 2026-11-24', () => {
            assert.equal(computeBusinessDate('2026-11-25T02:15:00+07:00'), '2026-11-24');
        });

        it('hỗ trợ cutoff tùy chỉnh (0h, 6h) và ném lỗi khi thời gian không hợp lệ', () => {
            assert.equal(computeBusinessDate('2026-11-25T00:05:00+07:00', 0, 420), '2026-11-25');
            assert.equal(computeBusinessDate('2026-11-25T05:30:00+07:00', 6, 420), '2026-11-24');
            assert.throws(() => computeBusinessDate('not-a-date'), /không hợp lệ/i);
        });
    });

    describe('shouldRunAutoDdl(env)', () => {
        it('{ NODE_ENV: "production" } => bắt buộc trả false kể cả khi không đặt SKIP_AUTO_DDL', () => {
            assert.equal(shouldRunAutoDdl({ NODE_ENV: 'production' }), false);
        });

        it('{ NODE_ENV: "production", SKIP_AUTO_DDL: "false" } => vẫn khóa cứng trả false trên Production', () => {
            assert.equal(shouldRunAutoDdl({ NODE_ENV: 'production', SKIP_AUTO_DDL: 'false' }), false);
        });

        it('{ NODE_ENV: "development", SKIP_AUTO_DDL: "true" } => trả false', () => {
            assert.equal(shouldRunAutoDdl({ NODE_ENV: 'development', SKIP_AUTO_DDL: 'true' }), false);
        });

        it('{ NODE_ENV: "development" } => trả true', () => {
            assert.equal(shouldRunAutoDdl({ NODE_ENV: 'development' }), true);
        });
    });
});
