const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { maskPhoneForRole } = require('../../modules/vnTaxAndEInvoiceService');
const { suyLuanTramCheBien, formatModifierTag } = require('../../modules/kdsPhase2Engine');

describe('Wave 3A Unit — NĐ 13/2023 Masking & KDS Routing / Modifier Formatting', () => {
    it('maskPhoneForRole: vaiTro = 4 che SĐT dạng 0905***892; vaiTro = 1 giữ nguyên SĐT đầy đủ', () => {
        assert.equal(maskPhoneForRole('0905123892', 4), '0905***892');
        assert.equal(maskPhoneForRole('0905123892', 3), '0905***892');
        assert.equal(maskPhoneForRole('0905123892', 1), '0905123892');
        assert.equal(maskPhoneForRole('12345', 4), '1***5');
        assert.equal(maskPhoneForRole('', 4), '');
    });

    it('suyLuanTramCheBien: món tên "Cà phê Kem Trứng Bánh Flan" cấu hình BAR_CHINH giữ nguyên BAR_CHINH (không bị regex đẩy sang BEP_BANH)', () => {
        const station = suyLuanTramCheBien({
            tramCheBien: 'BAR_CHINH',
            nhomMon: 'Cà phê đặc biệt',
            tenMon: 'Cà phê Kem Trứng Bánh Flan',
        });
        assert.equal(station, 'BAR_CHINH');

        // Khi chưa cấu hình tramCheBien -> mới suy luận theo regex tên món
        const inferred = suyLuanTramCheBien({
            tramCheBien: '',
            nhomMon: 'Bánh ngọt',
            tenMon: 'Bánh Croissant Bơ Pháp',
        });
        assert.equal(inferred, 'BEP_BANH');
    });

    it('formatModifierTag: đọc đúng qty (x2) thay vì rơi về x1 khi không có soLuong', () => {
        const tag = formatModifierTag({
            modifiersSnapshot: [
                { tenOption: 'Shot Espresso', qty: 2 },
                { tenInNgan: 'Ít đường', qty: 1 },
            ],
            toppings: [{ tenTopping: 'Trân châu đen', soLuongMoiLy: 2 }],
            ghiChu: 'Ít đá',
        });
        assert.ok(tag.includes('Shot Espresso x2'), `Tag phải chứa "Shot Espresso x2", nhận được: ${tag}`);
        assert.ok(tag.includes('Ít đường'));
        assert.ok(tag.includes('+Trân châu đen x2'));
        assert.ok(tag.includes('Ít đá'));
    });
});
