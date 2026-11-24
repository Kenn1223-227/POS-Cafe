const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const vietqrPath = pathToFileURL(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'vietqrCore.js')
).href;

describe('Wave 1 Unit — VietQR EMVCo & Local SVG Renderer (P0-03)', async () => {
    const mod = await import(vietqrPath);

    it('chấp nhận mã ngân hàng hợp lệ (VCB, TCB) và mã BIN 6 chữ số', () => {
        assert.equal(mod.resolveVietQrBankBin('VCB'), '970436');
        assert.equal(mod.resolveVietQrBankBin('tcb'), '970407');
        assert.equal(mod.resolveVietQrBankBin('970416'), '970416');
    });

    it('BẮT BUỘC báo lỗi tường minh khi thiếu hoặc sai mã ngân hàng (không fallback im lặng về MB Bank 970422)', () => {
        assert.throws(() => mod.resolveVietQrBankBin(''), /UNSUPPORTED_BANK_BIN/);
        assert.throws(() => mod.resolveVietQrBankBin('UNKNOWN_BANK_XYZ'), /UNSUPPORTED_BANK_BIN/);
        assert.throws(
            () =>
                mod.buildVietQrEmvcoPayload({
                    bankId: 'FAKEBANK',
                    accountNo: '1234567890',
                    amount: 50000,
                    memo: 'POSHD100',
                }),
            /UNSUPPORTED_BANK_BIN/
        );
    });

    it('sinh chuỗi EMVCo Napas247 hợp lệ kèm CRC16-CCITT và vẽ QR SVG cục bộ (0 phụ thuộc img.vietqr.io)', () => {
        const payload = mod.buildVietQrEmvcoPayload({
            bankId: 'VCB',
            accountNo: '0123456789',
            amount: 65000,
            memo: 'POSHD999',
        });
        assert.ok(payload.includes('970436'), 'Payload phải chứa đúng BIN Vietcombank 970436');
        assert.ok(!payload.includes('970422'), 'Payload không được chứa BIN MB Bank 970422');
        assert.ok(payload.includes('540565000'), 'Payload phải chứa đúng số tiền 65000');
        assert.ok(/6304[0-9A-F]{4}$/.test(payload), 'Payload phải kết thúc bằng Tag 63 + 4 ký tự CRC16');

        const bodyWithoutCrc = payload.slice(0, -4);
        assert.equal(payload.slice(-4), mod.crc16Ccitt(bodyWithoutCrc));

        const dataUrl = mod.buildVietQrSvgDataUrl({
            bankId: 'VCB',
            accountNo: '0123456789',
            amount: 65000,
            memo: 'POSHD999',
        });
        assert.ok(dataUrl.startsWith('data:image/svg+xml;charset=utf-8,'));
        assert.ok(!dataUrl.includes('img.vietqr.io'), 'Không được phụ thuộc img.vietqr.io');
        assert.ok(decodeURIComponent(dataUrl).includes('<svg '), 'Phải vẽ ra thẻ SVG hợp lệ');
    });
});
