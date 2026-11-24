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

describe('Wave 3B E2E / Static Guard [Tầng 3]: Công thái học POS, CFD, Barcode & SaaS Pricing', () => {
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

    it('useBarcodeScanner.js hỗ trợ cả HTMLTextAreaElement.prototype lẫn HTMLInputElement.prototype', () => {
        const scannerSrc = fs.readFileSync(path.join(FRONTEND_SRC, 'hooks', 'useBarcodeScanner.js'), 'utf8');
        assert.match(scannerSrc, /HTMLTextAreaElement\.prototype/);
        assert.match(scannerSrc, /HTMLInputElement\.prototype/);
        assert.match(scannerSrc, /activeEl\.tagName\s*===\s*'TEXTAREA'/);
    });

    it('CfdPage.jsx & PosPage.jsx cộng đủ giaModifiers và trừ promoPreview + Counter VietQR AWAITING_PAYMENT + Mobile Thumb Zone', () => {
        const cfdSrc = fs.readFileSync(path.join(FRONTEND_SRC, 'pages', 'pos', 'CfdPage.jsx'), 'utf8');
        const posSrc = fs.readFileSync(path.join(FRONTEND_SRC, 'pages', 'pos', 'PosPage.jsx'), 'utf8');

        assert.match(cfdSrc, /giaModifiers/);
        assert.match(cfdSrc, /promoPreview/);
        assert.match(posSrc, /giaModifiers/);
        assert.match(posSrc, /promoPreview/);
        assert.match(posSrc, /VIETQR_PREPAID/);
        assert.match(posSrc, /choThanhToanTruoc/);
        assert.match(posSrc, /mobile-thumb-zone/);
    });

    it('MenuGrid.jsx nối normalizeViSearch + Combo; ToppingModal.jsx hỗ trợ qty > 1 & cân ký/thời giá; Kho.jsx nối bao bì động', () => {
        const menuGridSrc = fs.readFileSync(path.join(FRONTEND_SRC, 'pages', 'pos', 'components', 'MenuGrid.jsx'), 'utf8');
        const toppingSrc = fs.readFileSync(path.join(FRONTEND_SRC, 'pages', 'pos', 'components', 'ToppingModal.jsx'), 'utf8');
        const khoSrc = fs.readFileSync(path.join(FRONTEND_SRC, 'pages', 'admin', 'Kho.jsx'), 'utf8');

        assert.match(menuGridSrc, /normalizeViSearch/);
        assert.match(menuGridSrc, /onPickCombo/);
        assert.match(toppingSrc, /toiDaSoLuong/);
        assert.match(toppingSrc, /trongLuongGram/);
        assert.match(toppingSrc, /laMonThoiGia/);
        assert.match(khoSrc, /\/kho\/vattu-mangdi/);
    });

    it('SaasPortal.jsx cập nhật bảng giá theo điểm bán (169.000 / 349.000 / 499.000) + Import KiotViet/Sapo', () => {
        const saasSrc = fs.readFileSync(path.join(FRONTEND_SRC, 'pages', 'admin', 'SaasPortal.jsx'), 'utf8');
        assert.match(saasSrc, /169\.000/);
        assert.match(saasSrc, /349\.000/);
        assert.match(saasSrc, /499\.000/);
        assert.match(saasSrc, /\/saas\/import-menu-sheet/);
        assert.match(saasSrc, /Beta \/ Demo/);
    });
});
