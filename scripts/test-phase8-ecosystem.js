const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    tinhHangThanhVien,
    tinhGiaLoBanhHienTai,
    tinhTienPhienGio,
    tinhDuBaoNhapKho60Ngay,
    goiYBanKemSmartUpsell,
    taoQrTokenMoi,
    registerEcosystemPhase8Routes,
} = require('../modules/ecosystemPhase8Routes');

function run() {
    console.log('🧪 Bắt đầu kiểm thử Phân hệ 8 (Hệ sinh thái & Chiến lược mở rộng)...');

    // 1. Kiểm thử CRM Phân hạng (Đồng / Bạc / Vàng / Kim Cương) & Cashback
    const tDong = tinhHangThanhVien(500000);
    assert.strictEqual(tDong.hang, 'DONG');
    assert.strictEqual(tDong.cashbackPct, 0);
    assert.strictEqual(tDong.mocTiepTheo, 1500000);

    const tBac = tinhHangThanhVien(2000000);
    assert.strictEqual(tBac.hang, 'BAC');
    assert.strictEqual(tBac.cashbackPct, 2);

    const tVang = tinhHangThanhVien(6000000);
    assert.strictEqual(tVang.hang, 'VANG');
    assert.strictEqual(tVang.cashbackPct, 4);

    const tKimCuong = tinhHangThanhVien(18000000);
    assert.strictEqual(tKimCuong.hang, 'KIM_CUONG');
    assert.strictEqual(tKimCuong.cashbackPct, 6);
    assert.strictEqual(tKimCuong.mocTiepTheo, null);
    console.log('✅ [1/6] CRM Phân hạng thành viên (Đồng/Bạc/Vàng/Kim Cương) & Cashback chính xác!');

    // 2. Kiểm thử Lô bánh Bakery giảm giá tự động 50% sau 19h (giờ Việt Nam UTC+7)
    // 14:00 UTC+7 = 07:00 UTC -> chưa giảm
    const before19 = tinhGiaLoBanhHienTai({
        giaGoc: 40000,
        gioGiamGia: 19,
        phanTramGiam: 50,
        nowDate: new Date('2026-11-22T07:00:00Z'),
    });
    assert.strictEqual(before19.dangGiamGia, false);
    assert.strictEqual(before19.giaHienTai, 40000);

    // 19:30 UTC+7 = 12:30 UTC -> giảm 50%
    const after19 = tinhGiaLoBanhHienTai({
        giaGoc: 40000,
        gioGiamGia: 19,
        phanTramGiam: 50,
        nowDate: new Date('2026-11-22T12:30:00Z'),
    });
    assert.strictEqual(after19.dangGiamGia, true);
    assert.strictEqual(after19.phanTramGiam, 50);
    assert.strictEqual(after19.giaHienTai, 20000);
    console.log('✅ [2/6] Bakery Auto-Markdown 50% sau 19h (UTC+7) chính xác!');

    // 3. Kiểm thử Time-based Billing (Bida / Boardgame / Co-working) kèm khung giờ cao điểm 18h-23h x1.25
    // Chơi 2 tiếng từ 17:00 -> 19:00 UTC+7 (10:00Z -> 12:00Z): 60p thường (60k) + 60p cao điểm (60k * 1.25 = 75k) = 135k
    const tb = tinhTienPhienGio({
        batDauLuc: '2026-11-22T10:00:00Z',
        ketThucLuc: '2026-11-22T12:00:00Z',
        donGiaTheoGio: 60000,
        khungGioCaoDiem: { startHour: 18, endHour: 23, multiplier: 1.25 },
    });
    assert.strictEqual(tb.soPhutSuDung, 120);
    assert.strictEqual(tb.soPhutThuong, 60);
    assert.strictEqual(tb.soPhutCaoDiem, 60);
    assert.strictEqual(tb.tongTienGio, 135000);
    console.log('✅ [3/6] Time-based Billing (giờ thường + khung giờ cao điểm x1.25) chính xác!');

    // 4. Kiểm thử AI Demand Forecasting 60 ngày + Thứ trong tuần
    // Giả lập ngày mai là Chủ nhật (DOW = 0), sữa tươi bình thường 1000ml/ngày nhưng Chủ nhật bán mạnh 2000ml/ngày
    const targetSun = new Date('2026-11-22T02:00:00Z'); // Sunday in VN
    const forecast = tinhDuBaoNhapKho60Ngay(
        [
            { maNL: 'SUA_TUOI', thuTrongTuan: 1, trong14Ngay: false, tongTieuHao: 1000 },
            { maNL: 'SUA_TUOI', thuTrongTuan: 2, trong14Ngay: false, tongTieuHao: 1000 },
            { maNL: 'SUA_TUOI', thuTrongTuan: 0, trong14Ngay: true, tongTieuHao: 2000 },
            { maNL: 'SUA_TUOI', thuTrongTuan: 0, trong14Ngay: true, tongTieuHao: 2200 },
        ],
        [
            { maNL: 'SUA_TUOI', tenNL: 'Sữa tươi', donViTinh: 'ml', soLuongTon: 600, hanMucCanhBao: 800, giaVonDonVi: 40 },
        ],
        targetSun
    );
    assert.strictEqual(forecast.thuNgayMai, 'Chủ nhật');
    assert.strictEqual(forecast.soNguyenLieuCanNhap, 1);
    assert.strictEqual(forecast.danhSach[0].mucDoKhanCap, 'HIGH');
    assert.ok(forecast.danhSach[0].heSoThu > 1.2, 'Hệ số Chủ nhật phải > 1.2');
    assert.ok(forecast.danhSach[0].goiYNhapSangMai > 1500, 'Phải gợi ý nhập đủ cho Chủ nhật');
    console.log('✅ [4/6] AI Demand Forecasting 60 ngày + Hệ số Thứ trong tuần chính xác!');

    // 5. Kiểm thử AI Smart Upsell (kết hợp Association Rules + Lô bánh giảm giá 50% sau 19h)
    const bakeryMap = new Map([
        ['BN01', { dangGiamGia: true, phanTramGiam: 50, gioGiamGia: 19, soLuongConLai: 6, giaHienTai: 18000 }],
    ]);
    const upsells = goiYBanKemSmartUpsell({
        cartMaMonList: ['CF01'],
        coOccurrenceRows: [{ maMon: 'TR01', soLanCungMua: 4 }],
        menuItems: [
            { maMon: 'CF01', tenMon: 'Cà phê Đen', nhomMon: 'Cà phê', tamHet: false, sizes: [{ kichThuoc: 'M', giaBan: 25000 }] },
            { maMon: 'BN01', tenMon: 'Bánh Croissant', nhomMon: 'Bánh ngọt', tamHet: false, sizes: [{ kichThuoc: 'M', giaBan: 35000 }] },
            { maMon: 'TR01', tenMon: 'Trà Đào', nhomMon: 'Trà', tamHet: false, sizes: [{ kichThuoc: 'M', giaBan: 42000 }] },
        ],
        bakeryMarkdownMap: bakeryMap,
    });
    assert.ok(upsells.length >= 2);
    assert.strictEqual(upsells[0].maMon, 'BN01');
    assert.strictEqual(upsells[0].badgeText, '+Bánh Croissant chỉ 18k');
    assert.strictEqual(upsells[0].dangGiamGiaBanh, true);
    console.log('✅ [5/6] AI Smart Upsell & ưu tiên giải phóng Lô bánh sau 19h chính xác!');

    // 6. Kiểm thử QR Token Generator, Route Registration & Migration 021 Fail-Closed RLS Integrity
    const tk1 = taoQrTokenMoi();
    const tk2 = taoQrTokenMoi();
    assert.strictEqual(tk1.length, 12);
    assert.notStrictEqual(tk1, tk2);

    const registeredRoutes = [];
    const mockApp = {
        get: (p) => registeredRoutes.push(`GET ${p}`),
        post: (p) => registeredRoutes.push(`POST ${p}`),
        put: (p) => registeredRoutes.push(`PUT ${p}`),
        delete: (p) => registeredRoutes.push(`DELETE ${p}`),
    };
    const noop = () => () => {};
    registerEcosystemPhase8Routes(mockApp, {
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
        taoDonHangTrongGiaoDich: noop,
    });

    const expectedRoutes = [
        'GET /api/public/qr-menu/:tenantSlug/:tableToken',
        'POST /api/public/qr-order/:tenantSlug/:tableToken',
        'POST /api/qr-orders/:maDonQr/approve',
        'POST /api/ban/:maBan/qr-rotate',
        'GET /api/crm/customers',
        'POST /api/crm/zns/trigger-birthday',
        'GET /api/branches/consolidated-report',
        'POST /api/branches/regional-prices/push',
        'POST /api/branches/transfers/:maPhieu/complete',
        'POST /api/aggregators/orders/:maDonSan/accept',
        'POST /api/time-billing/start',
        'POST /api/bakery/batches',
        'GET /api/ai/demand-forecast',
        'GET /api/ai/smart-upsell',
    ];
    for (const r of expectedRoutes) {
        assert.ok(registeredRoutes.includes(r), `Thiếu route bắt buộc: ${r}`);
    }

    // Kiểm tra Migration 021 có đầy đủ Fail-Closed RLS, index RIGHT(sodienthoai, 4), fn_resolve_qr_table & app_runtime grant
    const migSql = fs.readFileSync(
        path.join(__dirname, '..', 'db', 'migrations', '021_ecosystem_multibranch_qr_crm_horizontal_ai.sql'),
        'utf8'
    );
    assert.ok(/RIGHT\(sodienthoai,\s*4\)/i.test(migSql), 'Migration 021 phải có index RIGHT(SoDienThoai, 4)');
    assert.ok(/ENABLE ROW LEVEL SECURITY/i.test(migSql) && /FORCE ROW LEVEL SECURITY/i.test(migSql), 'Migration 021 phải bật FORCE RLS');
    assert.ok(/fn_resolve_qr_table/i.test(migSql), 'Migration 021 phải có hàm fn_resolve_qr_table SECURITY DEFINER');
    assert.ok(/GRANT EXECUTE ON FUNCTION public\.fn_resolve_qr_table/i.test(migSql), 'Migration 021 phải grant quyền cho app_runtime');
    console.log(`✅ [6/6] Đã xác minh ${registeredRoutes.length} API routes & tính toàn vẹn Fail-Closed RLS của Migration 021!`);

    console.log('🎉 TẤT CẢ KIỂM THỬ PHÂN HỆ 8 ĐỀU ĐẠT 100%!');
}

run();
