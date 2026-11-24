const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const {
    RASTER_BAND_HEIGHT,
    encodeBitmapToEscPosGsV0,
    buildReceiptK80,
} = require('../../local-print-bridge/escposBuilder');
const {
    escapeTsplSafe,
    buildCupLabelsTspl,
} = require('../../local-print-bridge/tsplBuilder');

describe('Wave 2 Unit — ESC/POS GS v 0 Raster & TSPL Injection/REVERSE (P0-08)', () => {
    it('escapeTsplSafe: loại sạch mọi ký tự điều khiển \\r \\n \\t và chuẩn hóa dấu nháy kép', () => {
        const malicious = 'Ít đá\nCLS\r\nPRINT 99\t"HACK"\x00';
        const safe = escapeTsplSafe(malicious);
        assert.equal(/[\r\n\t\x00-\x1f\x7f]/.test(safe), false, 'Không được còn ký tự điều khiển');
        assert.equal(safe.includes('"'), false, 'Không được còn dấu nháy kép');
        assert.ok(safe.includes("'HACK'"));
    });

    it('tsplBuilder: xuất lệnh REVERSE cho tùy chọn nhạy cảm [0% ĐƯỜNG] & wrap dòng 2 cho tên món dài > 26 ký tự', () => {
        const hoaDon = {
            maHoaDon: 'HD-TSPL-01',
            soThuTuNgay: 7,
            loaiDonHang: 'MANG_DI',
            danhSachMon: [
                {
                    maCTHD: 101,
                    maMon: 'M01',
                    tenMon: 'Trà Sữa Ô Long Nướng Kem Cheese Trân Châu Hoàng Kim',
                    kichThuoc: 'L',
                    soLuong: 1,
                    inTemCoc: true,
                    modifiersSnapshot: [{ tenOption: '0% Đường' }, { tenOption: 'Ít đá' }],
                    toppings: [],
                    ghiChu: 'Dị ứng đậu phộng',
                },
            ],
        };

        const built = buildCupLabelsTspl({ hoaDon, renderMode: 'ASCII_FALLBACK', widthMm: 50, heightMm: 30 });
        assert.equal(built.cupCount, 1);
        const cup = built.cups[0];
        assert.equal(cup.hasSensitiveModifier, true);
        assert.ok(cup.titleLines.length === 2, `Tên món dài phải được wrap thành 2 dòng, nhận được: ${cup.titleLines.length}`);
        const rawText = cup.buffer.toString('ascii');
        assert.ok(rawText.includes('REVERSE 8,'), 'Phải xuất lệnh REVERSE cho dòng tùy chọn nhạy cảm');
        assert.ok(rawText.includes('TEXT 10,70,"3"'), 'Phải có lệnh TEXT dòng 2 cho tên món dài');
    });

    it('canvasToEscPosRasterGsV0 & encodeBitmapToEscPosGsV0: header 0x1D 0x76 0x30 & cắt băng đúng BAND_HEIGHT=256px', async () => {
        const modUrl = pathToFileURL(
            path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'escposRaster.js')
        ).href;
        const { canvasToEscPosRasterGsV0 } = await import(modUrl);

        const width = 16; // 2 bytes per row
        const height = 600; // 3 bands: 256 + 256 + 88
        const rgba = new Uint8ClampedArray(width * height * 4);
        rgba.fill(255); // trắng
        // Chấm đen pixel (0, 0)
        rgba[0] = 0; rgba[1] = 0; rgba[2] = 0; rgba[3] = 255;

        const mockCanvas = {
            width,
            height,
            getContext: () => ({
                getImageData: () => ({ data: rgba }),
            }),
        };

        const rasterFrontend = canvasToEscPosRasterGsV0(mockCanvas);
        const rasterBridge = encodeBitmapToEscPosGsV0(rgba, width, height);

        assert.equal(RASTER_BAND_HEIGHT, 256);
        // 3 bands * 8-byte header + 2 bytes/row * 600 rows = 24 + 1200 = 1224 bytes
        assert.equal(rasterFrontend.length, 1224);
        assert.equal(rasterBridge.length, 1224);

        // Band 1 header tại offset 0: 1D 76 30 00 xL=2 xH=0 yL=0 yH=1 (256)
        assert.deepEqual([...rasterFrontend.slice(0, 8)], [0x1d, 0x76, 0x30, 0x00, 2, 0, 0, 1]);
        assert.equal(rasterFrontend[8], 0x80, 'Pixel (0,0) đen phải đặt bit MSB = 0x80');

        // Band 2 header tại offset 8 + 256*2 = 520
        assert.deepEqual([...rasterFrontend.slice(520, 528)], [0x1d, 0x76, 0x30, 0x00, 2, 0, 0, 1]);

        // Band 3 header tại offset 520 + 8 + 512 = 1040, y = 88 (0x58, 0x00)
        assert.deepEqual([...rasterFrontend.slice(1040, 1048)], [0x1d, 0x76, 0x30, 0x00, 2, 0, 88, 0]);
    });

    it('buildReceiptK80: chỉ in đúng 1 dòng watermark BAN SAO và có đủ Phí phục vụ + Thuế VAT', () => {
        const res = buildReceiptK80({
            hoaDon: {
                maHoaDon: 'HD-K80-01',
                tongTamTinh: 100000,
                phiPhucVu: 5000,
                tyLePhiPhucVu: 5,
                thueVAT: 8400,
                tyLeThueVAT: 8,
                tongTienThanhToan: 113400,
                danhSachMon: [
                    { tenMon: 'Cà Phê Sữa Đá', kichThuoc: 'M', soLuong: 2, thanhTien: 100000 },
                ],
            },
            laBanSao: true,
            soLanIn: 2,
        });

        const banSaoMatches = res.previewText.match(/BAN SAO/g) || [];
        assert.equal(banSaoMatches.length, 1, `Watermark BAN SAO chỉ được in đúng 1 lần, thấy ${banSaoMatches.length}`);
        assert.ok(res.previewText.includes('Phi phuc vu (5%):'), 'Phải có dòng Phí phục vụ');
        assert.ok(res.previewText.includes('Thue VAT (8%):'), 'Phải có dòng Thuế VAT');
    });
});
