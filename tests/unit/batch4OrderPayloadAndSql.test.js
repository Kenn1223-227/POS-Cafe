const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');

describe('Batch 4 Unit — Payload FE (Counter VietQR, Combo, Open/Weight, Hold/Park), Branch 86, Discard-Expired SQL & Multi-Rate VAT', () => {
    it('FE buildOrderPayloadFromCart & buildCreateOrderBody bảo toàn đủ combos[], donGia, trongLuongGram, tenMonTuyChinh, choThanhToanTruoc & phuongThucDuKien', async () => {
        const modUrl = pathToFileURL(path.join(ROOT, 'frontend', 'src', 'utils', 'orderPayload.js')).href;
        const {
            buildOrderPayloadFromCart,
            buildHoldOrderPayloadFromCart,
            buildCreateOrderBody,
        } = await import(modUrl);

        const cart = [
            // Combo 2 món
            {
                maMon: 'CF01',
                tenMon: '[Combo] Cafe Sữa',
                kichThuoc: 'M',
                donGia: 25000,
                giaModifiers: 0,
                soLuong: 1,
                ghiChu: 'Combo: Sáng Năng Lượng',
                maCombo: 'CMB_SANG',
                tenComboSnapshot: 'Sáng Năng Lượng',
                comboInstanceId: 'CMB-1',
                comboSlotId: 101,
                isTakeaway: false,
                courseNo: 1,
                fireStatus: 'FIRED',
                modifiers: [{ groupId: 1, optionId: 11, qty: 1 }],
                toppings: [],
            },
            {
                maMon: 'BM01',
                tenMon: '[Combo] Bánh Mì Croissant',
                kichThuoc: 'M',
                donGia: 24000,
                giaModifiers: 0,
                soLuong: 1,
                ghiChu: 'Combo: Sáng Năng Lượng',
                maCombo: 'CMB_SANG',
                tenComboSnapshot: 'Sáng Năng Lượng',
                comboInstanceId: 'CMB-1',
                comboSlotId: 102,
                isTakeaway: false,
                courseNo: 1,
                fireStatus: 'FIRED',
                modifiers: [],
                toppings: [],
            },
            // Món cân ký (KG/GRAM)
            {
                maMon: 'HAT01',
                tenMon: 'Hạt Arabica Rang Xay',
                kichThuoc: 'M',
                donGia: 87500,
                trongLuongGram: 250,
                giaModifiers: 0,
                soLuong: 1,
                ghiChu: 'Xay pha phin',
                isTakeaway: true,
                courseNo: 1,
                fireStatus: 'FIRED',
                modifiers: [],
                toppings: [],
            },
            // Món thời giá + tên tùy chỉnh
            {
                maMon: 'OPEN01',
                tenMon: 'Món Thời Giá',
                tenMonTuyChinh: 'Bánh Sinh Nhật Đặt Riêng 20cm',
                kichThuoc: 'L',
                donGia: 320000,
                donGiaTuyChinh: 320000,
                giaModifiers: 0,
                soLuong: 1,
                ghiChu: 'Viết chữ Happy Birthday',
                isTakeaway: true,
                courseNo: 1,
                fireStatus: 'FIRED',
                modifiers: [],
                toppings: [{ maTopping: 'TP01', tenTopping: 'Nến số', donGia: 10000, soLuongMoiLy: 2, soLuong: 2 }],
            },
        ];

        // 1. Order create payload
        const orderPayload = buildOrderPayloadFromCart({
            selectedTable: null,
            activeInvoice: null,
            customer: { maKH: 'KH01', tenKH: 'Anh Minh' },
            cart,
            soTheRung: '08',
            orderType: 'MANG_DI',
            tenKhachVangLai: 'Anh Minh',
        });

        assert.equal(orderPayload.combos.length, 1, 'Phải gom đúng 1 combo vào mảng combos[]');
        assert.equal(orderPayload.combos[0].maCombo, 'CMB_SANG');
        assert.equal(orderPayload.combos[0].soLuong, 1);
        assert.equal(orderPayload.combos[0].selections.length, 2);
        assert.equal(orderPayload.combos[0].selections[0].slotId, 101);
        assert.equal(orderPayload.combos[0].selections[0].maMon, 'CF01');
        assert.equal(orderPayload.combos[0].selections[1].slotId, 102);
        assert.equal(orderPayload.combos[0].selections[1].maMon, 'BM01');

        assert.equal(orderPayload.danhSachMon.length, 2, 'Chỉ giữ 2 món lẻ trong danhSachMon, không nhân đôi combo');
        const weightLine = orderPayload.danhSachMon.find((m) => m.maMon === 'HAT01');
        assert.equal(weightLine.donGia, 87500);
        assert.equal(weightLine.trongLuongGram, 250);

        const openLine = orderPayload.danhSachMon.find((m) => m.maMon === 'OPEN01');
        assert.equal(openLine.donGia, 320000);
        assert.equal(openLine.tenMonTuyChinh, 'Bánh Sinh Nhật Đặt Riêng 20cm');

        // 2. Counter VietQR AWAITING_PAYMENT request body (orderService.create)
        const requestBody = buildCreateOrderBody({
            ...orderPayload,
            choThanhToanTruoc: true,
            phuongThucDuKien: 'VIETQR_PREPAID',
        });
        assert.equal(requestBody.choThanhToanTruoc, true, 'orderService.create phải giữ nguyên cờ choThanhToanTruoc');
        assert.equal(requestBody.phuongThucDuKien, 'VIETQR_PREPAID', 'orderService.create phải giữ nguyên phuongThucDuKien');
        assert.equal(requestBody.combos.length, 1, 'orderService.create phải giữ nguyên combos[]');

        // 3. Hold / Park payload (luuTam) — tính đúng đơn giá & tổng tiền, không lưu 0đ
        const holdPayload = buildHoldOrderPayloadFromCart({
            selectedTable: null,
            customer: { maKH: 'KH01', tenKH: 'Anh Minh' },
            cart,
            orderType: 'MANG_DI',
            tenKhachVangLai: 'Anh Minh',
        });
        assert.equal(holdPayload.danhSachMon.length, 4);
        assert.equal(holdPayload.tongTamTinh, 25000 + 24000 + 87500 + 320000 + 20000);
        assert.ok(holdPayload.tongTamTinh > 0, 'Đơn lưu tạm tuyệt đối không được tính 0đ');
        for (const line of holdPayload.danhSachMon) {
            assert.ok(line.donGia > 0, `Dòng lưu tạm ${line.maMon} phải có donGia > 0`);
            assert.ok(line.tenMon, `Dòng lưu tạm ${line.maMon} phải có tenMon`);
        }
        const heldOpen = holdPayload.danhSachMon.find((m) => m.maMon === 'OPEN01');
        assert.equal(heldOpen.tenMonTuyChinh, 'Bánh Sinh Nhật Đặt Riêng 20cm');
        assert.equal(heldOpen.toppings[0].donGia, 10000);
    });

    it('PosPage.jsx khôi phục đơn tạm qua orderService.khoiPhucTam() + replaceCart(), không gán thẳng đơn TrangThaiTT=-1 vào activeInvoice', () => {
        const posSrc = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'pages', 'pos', 'PosPage.jsx'), 'utf8');
        const orderServiceSrc = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'services', 'orderService.js'), 'utf8');

        assert.ok(posSrc.includes('orderService.khoiPhucTam('), 'PosPage phải gọi orderService.khoiPhucTam() khi khôi phục đơn tạm online');
        assert.ok(posSrc.includes('replaceCart(restored.cart)'), 'PosPage phải nạp giỏ hàng qua replaceCart() khi khôi phục đơn tạm');
        assert.ok(posSrc.includes('buildOrderPayloadFromCart'), 'PosPage phải dùng buildOrderPayloadFromCart');
        assert.ok(posSrc.includes('buildHoldOrderPayloadFromCart'), 'PosPage phải dùng buildHoldOrderPayloadFromCart cho luuTam');
        assert.ok(orderServiceSrc.includes('buildCreateOrderBody'), 'orderService.create phải dùng buildCreateOrderBody giữ choThanhToanTruoc & phuongThucDuKien');
    });

    it('SQL & chữ ký hàm của POST /api/kds/batches/:lotId/discard-expired khớp 100% schema db/migrations/026 và engine', () => {
        const invSrc = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'inventory', 'index.js'), 'utf8');
        const mig026 = fs.readFileSync(
            path.join(ROOT, 'db', 'migrations', '026_inventory_cogs_bom_fefo_supplychain_phase4.sql'),
            'utf8'
        );

        const startIdx = invSrc.indexOf("app.post('/api/kds/batches/:lotId/discard-expired'");
        assert.ok(startIdx > 0, 'Phải tồn tại route POST /api/kds/batches/:lotId/discard-expired');
        const routeChunk = invSrc.slice(startIdx, startIdx + 4200);

        // 1. Chữ ký gọi lockBranchStockOrdered đúng 4 tham số vị trí & destructure { branchId, stockMap }
        assert.match(
            routeChunk,
            /const\s*\{\s*branchId,\s*stockMap\s*\}\s*=\s*await\s+lockBranchStockOrdered\(\s*client,\s*tenantId,\s*[^,]+,\s*\[lot\.manl\]\s*\)/,
            'Phải gọi lockBranchStockOrdered(client, tenantId, branchId, [lot.manl]) và destructure { branchId, stockMap }'
        );

        // 2. Không còn cột updatedat không tồn tại trên public.lo_tonkho
        assert.ok(!/updatedat/i.test(routeChunk), 'public.lo_tonkho không có cột updatedat trong db/migrations/026');
        assert.ok(!/CREATE TABLE IF NOT EXISTS public\.lo_tonkho[\s\S]*?updatedat[\s\S]*?\);/i.test(mig026));

        // 3. Thứ tự tham số gọi layCaDangMo(client, 'SHARE', tenantId, { branchId })
        assert.match(
            routeChunk,
            /layCaDangMo\(\s*client,\s*'SHARE',\s*tenantId,\s*\{\s*branchId\s*\}\s*\)/,
            "Phải gọi layCaDangMo(client, 'SHARE', tenantId, { branchId }) đúng thứ tự tham số"
        );

        // 4. LoaiGD = 2 (Xuất hủy) + MaLyDoHuy = 'EXPIRED_BATCH' khớp schema 026 (không ghi nhầm LoaiGD = 4)
        assert.match(
            routeChunk,
            /VALUES\s*\(\s*\$1,\s*2,\s*\$2,\s*\$3,\s*\$4,\s*\$5,\s*'EXPIRED_BATCH',\s*\$6::date,\s*'POSTED'\s*\)/i,
            "Phải ghi LoaiGD = 2 (Xuất hủy) và MaLyDoHuy = 'EXPIRED_BATCH' vào public.phieugiaodichkho"
        );
        assert.ok(mig026.includes('malydohuy'), 'Migration 026 phải có cột malydohuy trên phieugiaodichkho');
        assert.ok(mig026.includes('ngaychungtu'), 'Migration 026 phải có cột ngaychungtu trên phieugiaodichkho');
        assert.ok(mig026.includes('trangthaiduyet'), 'Migration 026 phải có cột trangthaiduyet trên phieugiaodichkho');
        assert.ok(mig026.includes('macathungan'), 'Migration 026 phải có cột macathungan trên phieugiaodichkho');
    });

    it('Kiểm tra branch_availability_86 trong orderHelpers.js, GET /api/topping và bảo toàn TienThueVAT đa mức khi thanh toán', () => {
        const helperSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'orderHelpers.js'), 'utf8');
        const menuSrc = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'menu', 'index.js'), 'utf8');

        assert.match(helperSrc, /const branch86 = await loadBranchAvailability86Map\(client,\s*tenantId,\s*effective86BranchId\)/);
        assert.ok(helperSrc.includes('branch86.products.get('), 'orderHelpers phải check 86 theo chi nhánh cho món');
        assert.ok(helperSrc.includes('branch86.toppings.get('), 'orderHelpers phải check 86 theo chi nhánh cho topping');
        assert.ok(helperSrc.includes('branch86.modifiers.get('), 'orderHelpers phải check 86 theo chi nhánh cho modifier');
        assert.ok(helperSrc.includes('branch86.combos.get('), 'orderHelpers phải check 86 theo chi nhánh cho combo');

        const toppingRouteIdx = menuSrc.indexOf("app.get('/api/topping'");
        assert.ok(toppingRouteIdx > 0);
        const toppingChunk = menuSrc.slice(toppingRouteIdx, toppingRouteIdx + 1400);
        assert.ok(toppingChunk.includes('loadBranchAvailability86Map'), 'GET /api/topping phải đọc branch_availability_86 theo chi nhánh');

        const payFnIdx = helperSrc.indexOf('async function ghiNhanThanhToanTrongGiaoDich');
        assert.ok(payFnIdx > 0);
        const payChunk = helperSrc.slice(payFnIdx, payFnIdx + 12500);
        assert.ok(payChunk.includes('applyMixedRateTaxToOrder'), 'ghiNhanThanhToanTrongGiaoDich phải đồng bộ thuế đa mức qua applyMixedRateTaxToOrder');
        assert.ok(payChunk.includes('tienThueVATFinal'), 'ghiNhanThanhToanTrongGiaoDich phải lưu tienThueVATFinal thay vì ghi đè bằng thuế phẳng');
    });
});
