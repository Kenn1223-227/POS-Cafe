'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { maskPhoneForRole } = require('../../modules/vnTaxAndEInvoiceService');

describe('Batch 8.5 Release Gate Verification — InFlightDelta, PII Masking & Tenant Isolation', () => {
    test('1. inFlightDelta SQL: LoaiGD = 9 (Đảo phiếu nhập) tính đúng -ABS(ct.soluong) kể cả khi ct.soluong mang dấu âm', () => {
        const routePath = path.resolve(__dirname, '../../modules/inventoryCogsPhase4Routes.js');
        const code = fs.readFileSync(routePath, 'utf8');

        // Đối chiếu câu SQL trong route
        assert.match(
            code,
            /WHEN\s+p\.loaigd\s*=\s*9\s+THEN\s+-ABS\(ct\.soluong\)/i,
            'inventoryCogsPhase4Routes.js phải có WHEN p.loaigd = 9 THEN -ABS(ct.soluong) để chống đảo dấu kép'
        );

        // Mô phỏng logic CASE WHEN trong JavaScript để chứng minh tính đúng đắn:
        function evalDeltaSql(loaigd, soluong) {
            if ([1, 5, 7, 10].includes(loaigd)) return soluong;
            if ([2, 4, 6].includes(loaigd)) return -soluong;
            if (loaigd === 9) return -Math.abs(soluong);
            return 0;
        }

        // Test với dữ liệu thực tế: Phiếu đảo LoaiGD = 9 lưu soluong âm (vd: -5 do line 166 lưu -qtyOrig)
        const deltaNegative = evalDeltaSql(9, -5);
        assert.equal(deltaNegative, -5, 'Với LoaiGD = 9 và soluong = -5, delta phải là -5 (trừ hàng khỏi tồn kho)');

        // Test trường hợp dữ liệu cũ lưu dương:
        const deltaPositive = evalDeltaSql(9, 5);
        assert.equal(deltaPositive, -5, 'Với LoaiGD = 9 và soluong = 5, delta vẫn phải là -5');
    });

    test('2. PII NĐ 13/2023: GET /api/qr-orders che số điện thoại cho vai trò không phải Quản lý', () => {
        const ecosystemPath = path.resolve(__dirname, '../../modules/ecosystemPhase8Routes.js');
        const code = fs.readFileSync(ecosystemPath, 'utf8');

        assert.match(
            code,
            /soDienThoaiKhach:\s*maskPhoneForRole\(x\.sodienthoaikhach,\s*req\.user\?\.vaiTro\)/,
            'GET /api/qr-orders phải bọc maskPhoneForRole(x.sodienthoaikhach, req.user?.vaiTro)'
        );

        const phone = '0905123456';
        assert.equal(maskPhoneForRole(phone, 1), '0905123456', 'Quản lý (vaiTro = 1) được xem SĐT đầy đủ');
        assert.equal(maskPhoneForRole(phone, 4), '0905***456', 'Thu ngân (vaiTro = 4) chỉ được xem SĐT che');
        assert.equal(maskPhoneForRole(phone, 3), '0905***456', 'Phục vụ (vaiTro = 3) chỉ được xem SĐT che');
    });

    test('3. PII NĐ 13/2023: POST /api/khachhang che số điện thoại trả về cho non-manager', () => {
        const crmPath = path.resolve(__dirname, '../../src/domains/crm/index.js');
        const code = fs.readFileSync(crmPath, 'utf8');

        assert.match(
            code,
            /soDienThoai:\s*maskPhoneForRole\(/,
            'POST /api/khachhang phải che SĐT trong response trả về qua maskPhoneForRole'
        );
    });

    test('4. fraudAlertService: che số điện thoại cảnh báo và bọc withTenant khi đọc NhanVien', () => {
        const fraudPath = path.resolve(__dirname, '../../modules/fraudAlertService.js');
        const code = fs.readFileSync(fraudPath, 'utf8');

        assert.match(
            code,
            /const\s*\{\s*maskPhoneForRole\s*\}\s*=\s*require\('\.\/vnTaxAndEInvoiceService'\)/,
            'fraudAlertService phải import maskPhoneForRole'
        );
        assert.match(
            code,
            /maskPhoneForRole\(gm\.soDienThoai,\s*4\)/,
            'fraudAlertService format message phải che SĐT khách hàng'
        );
        assert.match(
            code,
            /maskPhoneForRole\(khCashRes\.rows\[0\]\?\.sdt\s*\|\|\s*null,\s*4\)/,
            'fraudAlertService audit log giaTriMoi phải che SĐT khách hàng'
        );
        assert.match(
            code,
            /pool\.withTenant\(tenantId,\s*\(client\)\s*=>[\s\S]*?SELECT TenNV FROM NhanVien WHERE MaNV = \$1 AND COALESCE\(TenantId, 'DEFAULT'\) = \$2/,
            'fraudAlertService tra cứu TenNV phải dùng pool.withTenant(tenantId) tuân thủ RLS'
        );
    });

    test('5. Workspace sạch tests/.tmp và .gitignore đã chặn tests/.tmp/', () => {
        const gitignorePath = path.resolve(__dirname, '../../.gitignore');
        const gitignore = fs.readFileSync(gitignorePath, 'utf8');
        assert.ok(gitignore.includes('tests/.tmp/'), '.gitignore phải chứa tests/.tmp/');

        const tmpDir = path.resolve(__dirname, '../.tmp');
        assert.equal(fs.existsSync(tmpDir), false, 'Thư mục tests/.tmp/ phải được xóa sạch khỏi workspace');
    });
});
