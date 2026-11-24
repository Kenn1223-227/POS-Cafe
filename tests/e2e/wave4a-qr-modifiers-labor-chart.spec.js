'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FRONTEND_SRC = path.resolve(__dirname, '..', '..', 'frontend', 'src');

function walkFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkFiles(full, out);
        else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
}

describe('Wave 4A Frontend Guard [Tầng 3]: QR Modifiers, HourlySalesLaborChart & 0 window.prompt/confirm', () => {
    it('QrOrderPage.jsx render modifierGroups, giaModifiers và hỗ trợ số lượng qty khi toiDaSoLuong > 1', () => {
        const qrSrc = fs.readFileSync(path.join(FRONTEND_SRC, 'pages', 'public', 'QrOrderPage.jsx'), 'utf8');
        assert.match(qrSrc, /modifierGroups/);
        assert.match(qrSrc, /giaModifiers/);
        assert.match(qrSrc, /toiDaSoLuong/);
        assert.match(qrSrc, /adjustModifierQty/);
        assert.match(qrSrc, /sel\.qty/);
    });

    it('HourlySalesLaborChart.jsx tồn tại, cảnh báo đỏ > 30% và được gắn vào Dashboard.jsx', () => {
        const chartPath = path.join(FRONTEND_SRC, 'components', 'HourlySalesLaborChart.jsx');
        assert.equal(fs.existsSync(chartPath), true, 'Thiếu file HourlySalesLaborChart.jsx');
        const chartSrc = fs.readFileSync(chartPath, 'utf8');
        assert.match(chartSrc, /\/analytics\/hourly-sales-vs-labor/);
        assert.match(chartSrc, /laborCostPct/);
        assert.match(chartSrc, />\s*30/);

        const dashboardSrc = fs.readFileSync(path.join(FRONTEND_SRC, 'pages', 'admin', 'Dashboard.jsx'), 'utf8');
        assert.match(dashboardSrc, /HourlySalesLaborChart/);
    });

    it('HeSinhThai.jsx gỡ nhãn demo trên Zalo ZNS Worker và có khu vực Price Books / Đối soát sàn / Công nợ B2B; NhanSu.jsx có Tip Pool & OT', () => {
        const ecoSrc = fs.readFileSync(path.join(FRONTEND_SRC, 'pages', 'admin', 'HeSinhThai.jsx'), 'utf8');
        assert.doesNotMatch(ecoSrc, /Beta \/ Demo Outbox/);
        assert.match(ecoSrc, /\/zns\/outbox\/process/);
        assert.match(ecoSrc, /\/price-books/);
        assert.match(ecoSrc, /\/finance\/house-accounts/);
        assert.match(ecoSrc, /\/finance\/aggregator-settlements/);

        const hrSrc = fs.readFileSync(path.join(FRONTEND_SRC, 'pages', 'admin', 'NhanSu.jsx'), 'utf8');
        assert.match(hrSrc, /\/hr\/tip-pools/);
        assert.match(hrSrc, /\/hr\/ot-logs/);
    });

    it('quét toàn bộ frontend/src/ khẳng định 0 lời gọi window.prompt( và 0 lời gọi window.confirm(', () => {
        const files = walkFiles(FRONTEND_SRC);
        assert.ok(files.length > 20, 'Phải quét được danh sách file frontend/src');

        const violations = [];
        for (const f of files) {
            const content = fs.readFileSync(f, 'utf8');
            if (/window\.prompt\s*\(/.test(content) || /window\.confirm\s*\(/.test(content)) {
                violations.push(path.relative(FRONTEND_SRC, f));
            }
        }
        assert.deepEqual(
            violations,
            [],
            `Vẫn còn window.prompt/window.confirm trong frontend/src: ${violations.join(', ')}`
        );
    });
});
