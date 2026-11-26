const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { calculateMixedRateVietnamTax } = require('../../modules/vnTaxAndEInvoiceService');

describe('Wave 3A Unit — Động cơ Thuế VAT Đa Mức Việt Nam (P1-01)', () => {
    it('Case 1 (EXCLUDED): 1 Cafe 40.000đ (8%) + 1 Bia 80.000đ (10%), Voucher -12.000đ, Service Charge 5% (8%) -> Pro-rata 4k/8k, tách 2 bucket, sai số 0đ', () => {
        const res = calculateMixedRateVietnamTax({
            items: [
                { maMon: 'CF01', name: 'Cafe Sữa Đá', qty: 1, unitPrice: 40000, taxCategoryCode: 'VAT_8_FB', vatRate: 8 },
                { maMon: 'BIA01', name: 'Bia Thủ Công', qty: 1, unitPrice: 80000, taxCategoryCode: 'VAT_10_STD', vatRate: 10 },
            ],
            orderDiscountTotal: 12000,
            serviceChargePct: 5,
            serviceChargeVatRate: 8,
            taxMode: 'EXCLUDED',
        });

        assert.equal(res.totalGross, 120000);
        assert.equal(res.orderDiscountTotal, 12000);
        assert.equal(res.items[0].allocatedDiscount, 4000);
        assert.equal(res.items[1].allocatedDiscount, 8000);
        assert.equal(res.items[0].netAmount, 36000);
        assert.equal(res.items[1].netAmount, 72000);

        // Phí phục vụ 5% trên 108.000đ = 5.400đ cộng vào bucket 8%
        assert.equal(res.serviceChargeAmt, 5400);
        assert.equal(res.taxBreakdown.length, 2);

        const bucket8 = res.taxBreakdown.find((b) => b.vatRate === 8 && !b.isKct);
        const bucket10 = res.taxBreakdown.find((b) => b.vatRate === 10 && !b.isKct);
        assert.ok(bucket8, 'Phải có bucket VAT 8%');
        assert.ok(bucket10, 'Phải có bucket VAT 10%');

        assert.equal(bucket8.taxableBase, 41400); // 36.000 + 5.400
        assert.equal(bucket8.vatAmount, 3312);    // 41.400 * 8%
        assert.equal(bucket10.taxableBase, 72000);
        assert.equal(bucket10.vatAmount, 7200);   // 72.000 * 10%

        assert.equal(res.totalBeforeTax, 113400);
        assert.equal(res.totalTax, 10512);
        assert.equal(res.grandTotal, 123912);
        assert.equal(res.totalBeforeTax + res.totalTax, res.grandTotal, 'totalBeforeTax + totalTax phải khớp grandTotal tuyệt đối (0đ sai số)');
    });

    it('Case 2 (INCLUDED): Tổng có lẻ đồng + chiết khấu lẻ -> không lệch 1đ trên mọi bucket', () => {
        const res = calculateMixedRateVietnamTax({
            items: [
                { maMon: 'M1', qty: 1, unitPrice: 33333, taxCategoryCode: 'VAT_8_FB', vatRate: 8 },
                { maMon: 'M2', qty: 1, unitPrice: 47777, taxCategoryCode: 'VAT_10_STD', vatRate: 10 },
                { maMon: 'M3', qty: 1, unitPrice: 19999, taxCategoryCode: 'KCT', vatRate: 0, isKct: true },
            ],
            orderDiscountTotal: 7777,
            serviceChargePct: 3,
            serviceChargeVatRate: 8,
            taxMode: 'INCLUDED',
        });

        // Tổng chiết khấu phân bổ về dòng món khớp tuyệt đối 7.777đ
        const sumAllocated = res.items.reduce((s, it) => s + it.allocatedDiscount, 0);
        assert.equal(sumAllocated, 7777);

        // Kiểm tra từng bucket và tổng cộng lệch 0đ
        for (const b of res.taxBreakdown) {
            if (b.isKct) assert.equal(b.vatAmount, 0);
        }
        assert.equal(res.totalBeforeTax + res.totalTax, res.grandTotal);
        assert.equal(res.grandTotal, res.netAfterDiscount + res.serviceChargeAmt);
    });

    it('Case 3 (NONE): Tôn trọng taxMode = "NONE" (trả 0đ thuế trên mọi dòng & mọi bucket, không ép về EXCLUDED 8%)', () => {
        const res = calculateMixedRateVietnamTax({
            items: [
                { maMon: 'CF01', name: 'Cafe Sữa Đá', qty: 1, unitPrice: 40000, taxCategoryCode: 'VAT_8_FB', vatRate: 8 },
                { maMon: 'BIA01', name: 'Bia Thủ Công', qty: 1, unitPrice: 80000, taxCategoryCode: 'VAT_10_STD', vatRate: 10 },
            ],
            orderDiscountTotal: 10000,
            serviceChargePct: 5,
            serviceChargeVatRate: 8,
            taxMode: 'NONE',
        });

        assert.equal(res.taxMode, 'NONE');
        assert.equal(res.totalGross, 120000);
        assert.equal(res.orderDiscountTotal, 10000);
        assert.equal(res.netAfterDiscount, 110000);
        assert.equal(res.serviceChargeAmt, 5500);
        assert.equal(res.totalTax, 0, 'taxMode = NONE bắt buộc trả totalTax = 0đ');
        assert.equal(res.totalBeforeTax, 115500);
        assert.equal(res.grandTotal, 115500);
        assert.equal(res.totalBeforeTax + res.totalTax, res.grandTotal);

        for (const it of res.items) {
            assert.equal(it.vatAmount, 0, `Dòng ${it.maMon} phải có vatAmount = 0 khi taxMode = NONE`);
            assert.equal(it.taxableBase, it.netAmount);
        }
        for (const b of res.taxBreakdown) {
            assert.equal(b.vatAmount, 0, 'Mọi taxBucket phải có vatAmount = 0 khi taxMode = NONE');
        }
    });
});
