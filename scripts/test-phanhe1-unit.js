const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    tinhGiaToppingBacThang,
    danhGiaModifiersChoMon,
    tinhBomMotLySauSubstitution,
    phanBoGiaComboProRata,
    chiaDeuTienVND,
    tinhTongKeToanHoaDon,
} = require('../modules/fohEngineService');
const { registerFohPhase1Routes } = require('../modules/fohPhase1Routes');

function run() {
    console.log('🧪 Bắt đầu Unit Test Phân hệ 1 (Front-of-House & Order Engine 100/100)...');

    // 1. Tiered Topping Pricing
    const tier1 = tinhGiaToppingBacThang(10000, [{ tu: 1, gia: 10000 }, { tu: 2, gia: 8000 }], 3);
    assert.strictEqual(tier1.tongTienMoiLy, 26000, 'Ly 1=10k, Ly 2=8k, Ly 3=8k => 26k');
    console.log('✅ [1/7] Giá Topping lũy tiến (Tiered Pricing) chính xác!');

    // 2. Forced Modifiers + Smart Defaults + Free K + Substitution BOM Clamping >= 0
    const groupMap = new Map([
        [1, { id: 1, tenGroup: 'Mức đường', loai: 'SINGLE', batBuoc: true, chonToiThieu: 1, chonToiDa: 1, soLuongMienPhi: 0, dangHoatDong: true }],
        [2, { id: 2, tenGroup: 'Loại sữa', loai: 'SINGLE', batBuoc: false, chonToiThieu: 0, chonToiDa: 1, soLuongMienPhi: 0, dangHoatDong: true }],
        [3, { id: 3, tenGroup: 'Topping Free 1', loai: 'MULTI', batBuoc: false, chonToiThieu: 0, chonToiDa: 3, soLuongMienPhi: 1, dangHoatDong: true }],
    ]);
    const optionMap = new Map([
        [11, { id: 11, groupId: 1, tenOption: '100% Đường', tenInNgan: '100%Đ', laMacDinh: true, giaCongThem: 0, toiDaSoLuong: 1, tamHet: false, thuTuHienThi: 0 }],
        [12, { id: 12, groupId: 1, tenOption: 'Không đường', tenInNgan: '0%Đ', laMacDinh: false, giaCongThem: 0, toiDaSoLuong: 1, tamHet: false, thuTuHienThi: 1 }],
        [21, { id: 21, groupId: 2, tenOption: 'Đổi sữa yến mạch', tenInNgan: 'OatMilk', laMacDinh: false, giaCongThem: 12000, toiDaSoLuong: 1, tamHet: false, thuTuHienThi: 0 }],
        [31, { id: 31, groupId: 3, tenOption: 'Trân châu đen', tenInNgan: 'TCĐ', laMacDinh: false, giaCongThem: 8000, toiDaSoLuong: 1, tamHet: false, thuTuHienThi: 0 }],
        [32, { id: 32, groupId: 3, tenOption: 'Kem cheese', tenInNgan: 'Cheese', laMacDinh: false, giaCongThem: 15000, toiDaSoLuong: 1, tamHet: false, thuTuHienThi: 1 }],
    ]);
    const optionBomMap = new Map([
        [12, [{ kichThuoc: null, maNL: 'NL_DUONG', khoiLuongDelta: -20 }]],
        [21, [
            { kichThuoc: 'M', maNL: 'NL_SUA_TUOI', khoiLuongDelta: -150 },
            { kichThuoc: 'M', maNL: 'NL_SUA_YEN_MACH', khoiLuongDelta: 150 },
        ]],
    ]);

    // Test Smart Default tự điền 100% Đường + Free 1 option (8k miễn phí, chỉ tính 15k) + OatMilk (12k) = 27k
    const modEval = danhGiaModifiersChoMon({
        selectedModifiers: [
            { groupId: 2, optionId: 21, qty: 1 },
            { groupId: 3, optionId: 31, qty: 1 },
            { groupId: 3, optionId: 32, qty: 1 },
        ],
        attachedGroupIds: [1, 2, 3],
        groupMap,
        optionMap,
        optionBomMap,
        kichThuoc: 'M',
    });
    assert.strictEqual(modEval.giaModifiers, 27000, 'OatMilk 12k + Cheese 15k (TCĐ 8k được miễn phí) = 27k');
    assert.ok(modEval.modifiersSnapshot.some((m) => m.optionId === 11), 'Phải tự điền Smart Default 100% Đường');

    // Test Clamped Substitution BOM: món KHÔNG có sữa tươi chọn "Đổi sữa yến mạch (-150ml sữa tươi, +150ml sữa yến mạch)" -> sữa tươi = 0 (không âm!), sữa yến mạch = 150!
    const bomClamped = tinhBomMotLySauSubstitution({
        baseBomRows: [
            { maNL: 'NL_CAFE', khoiLuong: 25, giaVonDonVi: 400 },
            { maNL: 'NL_SUA_TUOI', khoiLuong: 100, giaVonDonVi: 40 }, // Ít hơn -150ml -> clamp về 0!
        ],
        modifierDeltas: modEval.bomDeltas,
    });
    assert.strictEqual(bomClamped.perCupMap.get('NL_CAFE'), 25);
    assert.strictEqual(bomClamped.perCupMap.has('NL_SUA_TUOI'), false, 'Sữa tươi sau -150ml trên 100ml phải clamp về 0 (không cộng ngược!)');
    assert.strictEqual(bomClamped.perCupMap.get('NL_SUA_YEN_MACH'), 150);
    console.log('✅ [2/7] Forced Modifiers, Smart Defaults, Free K & Clamped Substitution BOM (>= 0) chính xác!');

    // 3. Combo Pro-rata Allocation 0đ sai số
    // Combo 55k gồm Cafe sữa M (35k) nâng size L (+7k) + Croissant (35k) -> phân bổ 27500 + 27500 = 55000, +7k nâng size => 34500 + 27500 = 62000
    const comboDist = phanBoGiaComboProRata(55000, [
        { maMon: 'CF01', giaLeCoBan: 35000, phuThuNangSize: 7000, phuThuSlot: 0 },
        { maMon: 'BN01', giaLeCoBan: 35000, phuThuNangSize: 0, phuThuSlot: 0 },
    ]);
    assert.strictEqual(comboDist[0].donGiaPhanBo + comboDist[1].donGiaPhanBo, 55000);
    assert.strictEqual(comboDist[0].donGia, 34500);
    assert.strictEqual(comboDist[1].donGia, 27500);
    // Test lẻ không chia hết: 100.000đ chia 3 món giá lẻ 40k, 40k, 40k -> 33.334 + 33.333 + 33.333 = 100.000đ
    const comboOdd = phanBoGiaComboProRata(100000, [
        { maMon: 'A', giaLeCoBan: 40000 },
        { maMon: 'B', giaLeCoBan: 40000 },
        { maMon: 'C', giaLeCoBan: 40000 },
    ]);
    assert.strictEqual(comboOdd.reduce((s, x) => s + x.donGiaPhanBo, 0), 100000, 'Phân bổ Pro-rata phải khớp 0đ sai số');
    console.log('✅ [3/7] Combo Pro-rata phân bổ doanh thu khớp 0đ sai số!');

    // 4. Split Equal VNĐ (100.000 / 3 -> 34.000, 33.000, 33.000)
    const eq3 = chiaDeuTienVND(100000, 3);
    assert.deepStrictEqual(eq3, [34000, 33000, 33000]);
    const eq4 = chiaDeuTienVND(105000, 4);
    assert.deepStrictEqual(eq4, [27000, 26000, 26000, 26000]);
    console.log('✅ [4/7] Chia đều hóa đơn theo bội số 1.000đ (34k/33k/33k) chính xác!');

    // 5. Kế toán đơn hàng chuẩn F&B VN (Món tặng 0đ, Chiết khấu món, Phí PV, Phí đóng gói, VAT EXCLUDED vs INCLUDED)
    const ktExcl = tinhTongKeToanHoaDon({
        danhSachMon: [
            { soLuong: 2, donGia: 40000, giaModifiers: 5000, tienTopping: 10000, chietKhauMon: 5000, laMonTang: false }, // 2*45k + 10k - 5k = 95k
            { soLuong: 1, donGia: 35000, laMonTang: true }, // Món tặng 0đ!
        ],
        tienGiamKM: 15000, // Sau giảm = 80k
        loaiDonHang: 'TAI_QUAN',
        phiPhucVuPhanTram: 5, // 5% * 80k = 4k
        phiDongGoi: 2000, // Cơ sở thuế = 86k
        cachTinhThue: 'EXCLUDED',
        thueVATPhanTram: 10, // VAT = 8.6k -> Tổng = 94.6k
    });
    assert.strictEqual(ktExcl.tamTinhMon, 95000);
    assert.strictEqual(ktExcl.sauGiamGia, 80000);
    assert.strictEqual(ktExcl.tienPhiPhucVu, 4000);
    assert.strictEqual(ktExcl.tienThueVAT, 8600);
    assert.strictEqual(ktExcl.tongPhaiTra, 94600);

    const ktIncl = tinhTongKeToanHoaDon({
        danhSachMon: [{ soLuong: 1, donGia: 110000 }],
        loaiDonHang: 'MANG_DI',
        phiPhucVuPhanTram: 5, // Mang đi không tính phí phục vụ!
        cachTinhThue: 'INCLUDED',
        thueVATPhanTram: 10,
    });
    assert.strictEqual(ktIncl.tienPhiPhucVu, 0);
    assert.strictEqual(ktIncl.tienThueVAT, 10000);
    assert.strictEqual(ktIncl.tongPhaiTra, 110000);
    console.log('✅ [5/7] Kế toán đơn hàng (VAT Included/Excluded, Phí PV, Phí đóng gói, Món tặng 0đ) chính xác!');

    // 6. Kiểm tra đăng ký đầy đủ routes Phân hệ 1
    const routes = [];
    const mockApp = {
        get: (p) => routes.push(`GET ${p}`),
        post: (p) => routes.push(`POST ${p}`),
        put: (p) => routes.push(`PUT ${p}`),
        delete: (p) => routes.push(`DELETE ${p}`),
    };
    const noop = () => () => {};
    registerFohPhase1Routes(mockApp, {
        pool: {},
        chayGiaoDich: noop,
        qTenant: noop,
        layTenantId: () => 'DEFAULT',
        kiemTraToken: noop(),
        choPhepVaiTro: noop,
        ghiAuditLog: noop,
        guiLoi: noop,
        LoiNghiepVu: Error,
        io: { to: () => ({ to: () => ({ emit: () => {} }), emit: () => {} }) },
        roomTen: () => 'room',
        layHoaDonChiTiet: noop,
        layHoaDonMoCuaBan: noop,
        layMonTheoMa: noop,
        xoayQrTokenChoCacBan: noop,
        kiemTraHopLeKhuyenMai: noop,
        paymentsSanSangRef: () => true,
        handleSplitOrder: noop(),
    });
    const requiredRoutes = [
        'GET /api/modifiers/groups',
        'POST /api/modifiers/groups',
        'PUT /api/modifiers/options/:id/tamhet',
        'POST /api/modifiers/options/:id/bom',
        'POST /api/sanpham/:maMon/modifiers',
        'GET /api/combos',
        'GET /api/combos/active',
        'POST /api/combos',
        'GET /api/kho/vattu-mangdi',
        'POST /api/kho/vattu-mangdi',
        'GET /api/datban',
        'POST /api/datban',
        'PUT /api/datban/:maDatBan/trangthai',
        'GET /api/order/cho-bao-bep',
        'POST /api/order/:maHoaDon/fire-course',
        'GET /api/order/luu-tam',
        'POST /api/order/luu-tam',
        'POST /api/order/:maHoaDon/khoi-phuc-tam',
        'POST /api/order/chuyen-mon',
        'POST /api/order/tach',
        'GET /api/order/:maHoaDon/chiatien',
        'GET /api/pos/the-rung',
    ];
    for (const r of requiredRoutes) {
        assert.ok(routes.includes(r), `Thiếu route bắt buộc: ${r}`);
    }
    console.log(`✅ [6/7] Đã xác minh đủ ${requiredRoutes.length} routes mới Phân hệ 1!`);

    // 7. Kiểm tra tính toàn vẹn Migration 023 (Fail-Closed FORCE RLS & app_runtime GRANT)
    const migSql = fs.readFileSync(
        path.join(__dirname, '..', 'db', 'migrations', '023_foh_phase1_100_percent_upgrade.sql'),
        'utf8'
    );
    const mustTables = [
        'modifier_groups',
        'modifier_options',
        'modifier_option_bom',
        'sanpham_modifier_groups',
        'combo',
        'combo_slots',
        'combo_slot_items',
        'hoadon_chiatien',
        'datban',
        'cauhinh_vattu_mangdi',
    ];
    for (const tbl of mustTables) {
        assert.ok(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${tbl}`, 'i').test(migSql), `Thiếu bảng ${tbl} trong Migration 023`);
        assert.ok(new RegExp(`'${tbl}'`, 'i').test(migSql), `Thiếu cấu hình RLS cho bảng ${tbl} trong Migration 023`);
    }
    assert.ok(/ENABLE ROW LEVEL SECURITY/i.test(migSql) && /FORCE ROW LEVEL SECURITY/i.test(migSql));
    assert.ok(/GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime/i.test(migSql));
    console.log('✅ [7/7] Migration 023 đầy đủ 10 bảng mới, Fail-Closed FORCE RLS & GRANT app_runtime!');

    console.log('🎉 TẤT CẢ UNIT TEST PHÂN HỆ 1 (7/7) ĐỀU PASS 100%!');
}

run();
