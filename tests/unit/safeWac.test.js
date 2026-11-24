const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    computeSafeWacOnStockIn,
    allocateLandedCost,
} = require('../../modules/inventoryCogsPhase4Engine');

describe('Wave 2 Unit — Safe WAC & Landed Cost Allocation (P0-05)', () => {
    it('computeSafeWacOnStockIn: tồn âm -> nhập mới đặt lại WAC & tính cogsAdjustment chính xác', () => {
        // Đang âm 100g với giá vốn cũ 200đ/g. Nhập mới 500g với tổng tiền 150.000đ (300đ/g).
        // Phần bù âm = min(100, 500) = 100g; chênh lệch = 100 * (300 - 200) = +10.000đ
        const res = computeSafeWacOnStockIn({
            tonCu: -100,
            giaVonCu: 200,
            slNhapBase: 500,
            tongTienHang: 150000,
            chiPhiPhanBo: 0,
        });
        assert.equal(res.donGiaNhapThucTe, 300);
        assert.equal(res.giaVonMoi, 300);
        assert.equal(res.cogsAdjustment, 10000);
    });

    it('computeSafeWacOnStockIn: tồn âm lớn hơn lượng nhập -> chỉ tính cogsAdjustment trên slNhapBase', () => {
        const res = computeSafeWacOnStockIn({
            tonCu: -500,
            giaVonCu: 250,
            slNhapBase: 200,
            tongTienHang: 60000, // 300đ/g
            chiPhiPhanBo: 0,
        });
        assert.equal(res.donGiaNhapThucTe, 300);
        assert.equal(res.giaVonMoi, 300);
        assert.equal(res.cogsAdjustment, 10000); // 200 * (300 - 250)
    });

    it('computeSafeWacOnStockIn: tồn dương + Landed Cost tính bình quân gia quyền chính xác', () => {
        const res = computeSafeWacOnStockIn({
            tonCu: 100,
            giaVonCu: 200,
            slNhapBase: 100,
            tongTienHang: 28000,
            chiPhiPhanBo: 2000, // thực tế = 30.000 / 100 = 300đ/g
        });
        assert.equal(res.donGiaNhapThucTe, 300);
        assert.equal(res.giaVonMoi, 250);
        assert.equal(res.cogsAdjustment, 0);
    });

    it('allocateLandedCost: phân bổ chi phí vận chuyển - chiết khấu NCC không lệch 1đ', () => {
        const items = [
            { tongTienHang: 100000 },
            { tongTienHang: 100000 },
            { tongTienHang: 100000 },
        ];
        const alloc = allocateLandedCost(items, 10000, 0);
        assert.equal(alloc.length, 3);
        const total = Math.round(alloc.reduce((s, v) => s + v, 0) * 100) / 100;
        assert.equal(total, 10000);
    });
});
