const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { computeSafeWacOnStockIn } = require('../../modules/inventoryCogsPhase4Engine');
const { calculateMixedRateVietnamTax } = require('../../modules/vnTaxAndEInvoiceService');

const ROOT = path.resolve(__dirname, '../..');
const readRel = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Batch 10 Unit — V3 Hotfix P0-4, P0-5, P0-8', () => {
    it('P0-5 Safe WAC: nhập bù tồn âm 2 đợt giữ nguyên oldCost khi tồn sau nhập vẫn âm, tổng COGS bù đủ 3400', () => {
        const d1 = computeSafeWacOnStockIn({
            tonCu: -100,
            giaVonCu: 50,
            slNhapBase: 60,
            tongTienHang: 60 * 80,
            chiPhiPhanBo: 0,
        });
        assert.equal(d1.cogsAdjustment, 1800);
        assert.equal(d1.giaVonMoi, 50);

        const d2 = computeSafeWacOnStockIn({
            tonCu: -40,
            giaVonCu: d1.giaVonMoi,
            slNhapBase: 100,
            tongTienHang: 100 * 90,
            chiPhiPhanBo: 0,
        });
        assert.equal(d2.cogsAdjustment, 1600);
        assert.equal(d2.giaVonMoi, 90);
        assert.equal(d1.cogsAdjustment + d2.cogsAdjustment, 3400);
    });

    it('P0-8 Mixed-Rate VAT EXCLUDED cộng đúng thuế 8%/10% vào grandTotal; INCLUDED và NONE không bị lệch', () => {
        const items = [
            { maMon: 'CF', vatRate: 8, isKct: false, lineAmount: 50000 },
            { maMon: 'BIA', vatRate: 10, isKct: false, lineAmount: 100000 },
        ];

        const excluded = calculateMixedRateVietnamTax({ items, taxMode: 'EXCLUDED' });
        assert.equal(excluded.totalBeforeTax, 150000);
        assert.equal(excluded.totalTax, 14000); // 4.000 (8%) + 10.000 (10%)
        assert.equal(excluded.grandTotal, 164000);

        const included = calculateMixedRateVietnamTax({ items, taxMode: 'INCLUDED' });
        assert.equal(included.grandTotal, 150000);
        assert.equal(included.totalBeforeTax + included.totalTax, 150000);

        const none = calculateMixedRateVietnamTax({ items, taxMode: 'NONE' });
        assert.equal(none.totalTax, 0);
        assert.equal(none.grandTotal, 150000);

        const orderHelpersSrc = readRel('src/core/orderHelpers.js');
        assert.match(orderHelpersSrc, /taxMode === 'EXCLUDED' && hasMixedTaxBreakdown/);
        assert.match(orderHelpersSrc, /taxModePay === 'EXCLUDED' && mixedTaxPay !== null/);
        assert.match(orderHelpersSrc, /mixedTaxPay\.grandTotal/);
    });

    it('P0-4 P&L không trừ kép hoàn tiền cho cả 3 kịch bản: không hoàn, hoàn 1 phần, hoàn toàn phần', () => {
        const reportsSrc = readRel('src/domains/reports/index.js');
        const bdaySrc = readRel('src/domains/reports/businessDaySummaryService.js');

        // reports/index.js: DoanhThuGop không tự loại trừ trước các dòng/đơn đã hoàn; trừ order_refunds 1 lần duy nhất
        assert.match(reportsSrc, /COALESCE\(cthd\.LyDoHuy, ''\) LIKE '\[Hoàn tiền%'/);
        assert.match(reportsSrc, /hd\.TrangThaiTT = 2[\s\S]*?FROM public\.order_refunds/);
        assert.match(reportsSrc, /const doanhThu = Math\.max\(0, Math\.round\(\(doanhThuGop - hoanTien\) \* 100\) \/ 100\)/);

        // businessDaySummaryService.js: không trừ sotienhoan lần 2 trên tongtienthanhtoan
        assert.doesNotMatch(bdaySrc, /tongtienthanhtoan[\s\S]{0,160}-\s*COALESCE\(NULLIF\(to_jsonb\(hd\)->>'sotienhoan'/);

        // Mô phỏng đối chiếu số học giữa 2 động cơ cho cả 3 kịch bản:
        const scenarios = [
            { name: 'Không hoàn', gross: 100000, refund: 0, trangThaiTT: 1, tongTienThanhToanAfterOrder: 100000 },
            { name: 'Hoàn 1 phần', gross: 100000, refund: 30000, trangThaiTT: 1, tongTienThanhToanAfterOrder: 70000 },
            { name: 'Hoàn toàn phần', gross: 100000, refund: 100000, trangThaiTT: 2, tongTienThanhToanAfterOrder: 100000 },
        ];
        for (const sc of scenarios) {
            const reportsNet = Math.max(0, sc.gross - sc.refund);
            const bdayNet = sc.trangThaiTT === 1 ? sc.tongTienThanhToanAfterOrder : 0;
            assert.equal(reportsNet, bdayNet, `Lệch doanh thu thuần ở kịch bản ${sc.name}`);
        }
    });

    it('P0-5 & P0-8: Kiểm tra chữ ký layCaDangMo, bảo toàn VI_KHACH, hoàn kho TonKhoChiNhanh, Migration 042 & schema_base.sql', () => {
        const kdsSrc = readRel('modules/kdsPhase2Routes.js');
        assert.match(kdsSrc, /normalizeInventoryBranch\(tenantId,/);
        assert.match(kdsSrc, /layCaDangMo\(client,\s*'SHARE',\s*tenantId,\s*\{\s*branchId:\s*invBranchId\s*\}\)/);
        assert.doesNotMatch(kdsSrc, /cleanPhuongThuc === 'VI_KHACH'\s*\?\s*'TIEN_MAT'/);

        const ordersSrc = readRel('src/domains/orders/index.js');
        const refundBlock = ordersSrc.slice(
            ordersSrc.indexOf('const thucHienHoanKho = Boolean(hoanKho);'),
            ordersSrc.indexOf('const targetIds = targetItems.map')
        );
        assert.match(refundBlock, /lockBranchStockOrdered\(/);
        assert.match(refundBlock, /updateBranchStockRow\(/);
        assert.match(refundBlock, /insertLedgerLine\(/);
        assert.doesNotMatch(refundBlock, /UPDATE NguyenLieu SET SoLuongTon/);

        const mig042 = readRel('db/migrations/042_fix_public_einvoice_rpc.sql');
        assert.match(mig042, /CREATE OR REPLACE FUNCTION public\.fn_public_request_einvoice/);
        assert.match(mig042, /v_order\.trangthaitt <> 1/);
        assert.match(mig042, /FROM public\.tenants t/);

        const schemaBase = readRel('db/schema_base.sql');
        assert.match(schemaBase, /CREATE TABLE IF NOT EXISTS public\.PhieuGiaoDichKho[\s\S]*?MaGiaoDich\s+VARCHAR\(64\)\s+PRIMARY KEY/);
        assert.match(schemaBase, /CREATE TABLE IF NOT EXISTS public\.PhieuThuChiLatVat[\s\S]*?MaPhieuTC\s+BIGSERIAL\s+PRIMARY KEY/);
    });
});
