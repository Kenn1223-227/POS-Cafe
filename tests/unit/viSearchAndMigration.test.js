const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { parseMenuSheetRows } = require('../../modules/saasRoutes');

describe('Wave 3B Unit [Tầng 1]: Tìm kiếm tiếng Việt không dấu & Migration Toolkit (KiotViet / Sapo)', () => {
    it('normalizeViSearch: "Bạc Xỉu Đá" khớp "bac xiu", "Cà Phê Sữa Đá" khớp "ca phe sua da"', async () => {
        const modUrl = pathToFileURL(
            path.resolve(__dirname, '..', '..', 'frontend', 'src', 'utils', 'viSearch.js')
        ).href;
        const { normalizeViSearch, matchesViSearch } = await import(modUrl);

        assert.equal(normalizeViSearch('Bạc Xỉu Đá'), 'bac xiu da');
        assert.equal(normalizeViSearch('Cà Phê Sữa Đá'), 'ca phe sua da');
        assert.equal(normalizeViSearch('  Đường   Đen  '), 'duong den');
        assert.equal(matchesViSearch('Bạc Xỉu Đá', 'bac xiu'), true);
        assert.equal(matchesViSearch('Cà Phê Sữa Đá', 'ca phe sua da'), true);
        assert.equal(matchesViSearch('Trà Đào Cam Sả', 'bac xiu'), false);
    });

    it('parseMenuSheetRows: nhận diện & map đúng cột mẫu xuất từ KiotViet', () => {
        const kiotVietCsv = [
            'Mã hàng,Tên hàng,Nhóm hàng(3 Cấp),Giá bán,ĐVT',
            'CF01,Cà Phê Sữa Đá,Cà phê,29000,M',
            'BX01,Bạc Xỉu Đá,Cà phê,35000,L',
        ].join('\n');

        const parsed = parseMenuSheetRows({ csvText: kiotVietCsv });
        assert.equal(parsed.detectedSource, 'KIOTVIET');
        assert.equal(parsed.errors.length, 0);
        assert.equal(parsed.items.length, 2);
        assert.equal(parsed.items[0].maMon, 'CF01');
        assert.equal(parsed.items[0].tenMon, 'Cà Phê Sữa Đá');
        assert.equal(parsed.items[0].nhomMon, 'Cà phê');
        assert.equal(parsed.items[0].giaBan, 29000);
        assert.equal(parsed.items[0].size, 'M');
        assert.equal(parsed.items[1].size, 'L');
    });

    it('parseMenuSheetRows: nhận diện & map đúng cột mẫu xuất từ Sapo', () => {
        const sapoRows = [
            {
                'Mã SKU': 'TS-01',
                'Tên sản phẩm': 'Trà Sữa Trân Châu Đường Đen',
                'Loại sản phẩm': 'Trà sữa',
                'Giá bán': '42,000',
                'Tên phiên bản': 'L',
            },
            {
                'Mã SKU': 'TS-02',
                'Tên sản phẩm': 'Trà Đào Cam Sả',
                'Loại sản phẩm': 'Trà trái cây',
                'Giá bán': 38000,
                'Tên phiên bản': 'S',
            },
        ];

        const parsed = parseMenuSheetRows({ rows: sapoRows });
        assert.equal(parsed.detectedSource, 'SAPO');
        assert.equal(parsed.errors.length, 0);
        assert.equal(parsed.items.length, 2);
        assert.equal(parsed.items[0].maMon, 'TS-01');
        assert.equal(parsed.items[0].tenMon, 'Trà Sữa Trân Châu Đường Đen');
        assert.equal(parsed.items[0].giaBan, 42000);
        assert.equal(parsed.items[0].size, 'L');
        assert.equal(parsed.items[1].size, 'S');
    });
});
