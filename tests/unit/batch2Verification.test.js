'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../..');

describe('Batch 2 Remediation Verification — AUDIT_REPORT_V2 Fixes', () => {
    it('1. Combo 42P10 (modules/fohPhase1Routes.js): ON CONFLICT dùng đúng (tenantid, macombo) theo Migration 027', () => {
        const fohSrc = fs.readFileSync(path.join(ROOT_DIR, 'modules', 'fohPhase1Routes.js'), 'utf8');
        assert.match(
            fohSrc,
            /INSERT\s+INTO\s+combo\s*\([^)]*macombo[^)]*tenantid[^)]*\)[\s\S]*ON\s+CONFLICT\s*\(\s*tenantid\s*,\s*macombo\s*\)\s+DO\s+UPDATE/,
            'POST /api/combos phải dùng ON CONFLICT (tenantid, macombo) khớp với PK composite sau Migration 027'
        );
        assert.doesNotMatch(
            fohSrc,
            /ON\s+CONFLICT\s*\(\s*macombo\s*\)\s+DO\s+UPDATE/,
            'Không được dùng ON CONFLICT (macombo) đơn lẻ gây lỗi 42P10'
        );
    });

    it('2. Chuyển món lỗi 428 (modules/fohPhase1Routes.js & frontend orderService.js): hỗ trợ destExpectedVersion & không ép mandatory khi dest chưa có version', () => {
        const fohSrc = fs.readFileSync(path.join(ROOT_DIR, 'modules', 'fohPhase1Routes.js'), 'utf8');
        assert.match(
            fohSrc,
            /destExpectedVersion/,
            'fohPhase1Routes.js phải nhận destExpectedVersion từ request body'
        );
        assert.match(
            fohSrc,
            /kiemTraVaTangVersionHoaDon\s*\(\s*client\s*,\s*\{[\s\S]*maHoaDon:\s*destMaHoaDon[\s\S]*mandatory:\s*Boolean\(/,
            'kiemTraVaTangVersionHoaDon cho destMaHoaDon phải dùng mandatory: Boolean(finalDestExpectedVersion) để không ném 428 khi không truyền'
        );

        const orderServSrc = fs.readFileSync(
            path.join(ROOT_DIR, 'frontend', 'src', 'services', 'orderService.js'),
            'utf8'
        );
        assert.match(
            orderServSrc,
            /chuyenMon:\s*\(\{[\s\S]*destExpectedVersion/,
            'orderService.chuyenMon phải hỗ trợ truyền destExpectedVersion'
        );
    });

    it('3. Hủy món đơn trả 1 phần lỗi 409 (src/domains/orders/index.js): đọc đúng tongPhaiTra thay vì tongTienThanhToan', () => {
        const ordersSrc = fs.readFileSync(path.join(ROOT_DIR, 'src', 'domains', 'orders', 'index.js'), 'utf8');
        assert.match(
            ordersSrc,
            /recalc\?\.totals\?\.tongPhaiTra\s*\?\?\s*hdPostVoid\?\.tongPhaiTra/,
            'POST /api/order/huy-mon phải đọc recalc.totals.tongPhaiTra và hdPostVoid.tongPhaiTra'
        );
        assert.doesNotMatch(
            ordersSrc,
            /recalc\?\.totals\?\.tongTienThanhToan/,
            'Không được đọc recalc.totals.tongTienThanhToan vì trường này không tồn tại trong totals'
        );
    });

    it('4. Sửa gọi sai .emit() thay vì .flush() & trừ kho đúng LoaiGD = 6 (Bán hàng)', () => {
        const ordersSrc = fs.readFileSync(path.join(ROOT_DIR, 'src', 'domains', 'orders', 'index.js'), 'utf8');
        const systemSrc = fs.readFileSync(path.join(ROOT_DIR, 'src', 'domains', 'system', 'index.js'), 'utf8');
        const orderHelpersSrc = fs.readFileSync(path.join(ROOT_DIR, 'src', 'core', 'orderHelpers.js'), 'utf8');

        // Check orders/index.js
        assert.match(
            ordersSrc,
            /ketQua\.kdsEmitPlan\s*&&\s*typeof\s+ketQua\.kdsEmitPlan\.flush\s*===\s*'function'\s*\)\s*\{\s*ketQua\.kdsEmitPlan\.flush\(\);/,
            'src/domains/orders/index.js phải gọi .flush() trên kdsEmitPlan'
        );

        // Check system/index.js
        assert.match(
            systemSrc,
            /ketQua\.kdsEmitPlan\s*&&\s*typeof\s+ketQua\.kdsEmitPlan\.flush\s*===\s*'function'\s*\)\s*\{\s*ketQua\.kdsEmitPlan\.flush\(\);/,
            'src/domains/system/index.js phải gọi .flush() trên kdsEmitPlan'
        );

        // Đảm bảo không còn điểm nào gọi .kdsEmitPlan.emit() trong toàn bộ src/ và modules/
        const checkDir = (dir) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const ent of entries) {
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) checkDir(full);
                else if (ent.isFile() && ent.name.endsWith('.js')) {
                    const content = fs.readFileSync(full, 'utf8');
                    assert.doesNotMatch(
                        content,
                        /kdsEmitPlan\.emit\s*\(/,
                        `File ${full} vẫn còn gọi nhầm kdsEmitPlan.emit()!`
                    );
                }
            }
        };
        checkDir(path.join(ROOT_DIR, 'src'));
        checkDir(path.join(ROOT_DIR, 'modules'));

        // Check LoaiGD = 6
        assert.match(
            orderHelpersSrc,
            /INSERT\s+INTO\s+PhieuGiaoDichKho\s*\([^)]*LoaiGD[^)]*\)\s+VALUES\s*\(\$1,\s*6,/,
            'Trừ kho trễ cho VietQR PAID trong orderHelpers.js phải ghi LoaiGD = 6 (Bán hàng/Tiêu hao)'
        );
        assert.doesNotMatch(
            orderHelpersSrc,
            /INSERT\s+INTO\s+PhieuGiaoDichKho\s*\([^)]*LoaiGD[^)]*\)\s+VALUES\s*\(\$1,\s*3,/,
            'Không được ghi LoaiGD = 3 (Kiểm kê) khi trừ kho bán hàng'
        );
    });

    it('5. Đơn QR bảo toàn Modifiers (modules/ecosystemPhase8Routes.js)', () => {
        const ecoSrc = fs.readFileSync(path.join(ROOT_DIR, 'modules', 'ecosystemPhase8Routes.js'), 'utf8');
        assert.match(
            ecoSrc,
            /modifiers:\s*Array\.isArray\(m\.modifiers\)\s*\?\s*m\.modifiers\s*:\s*\[\]/,
            'Khi duyệt đơn QR, danhSachMon phải bảo toàn đầy đủ m.modifiers'
        );
    });

    it('6. Crash UI trang Nhân sự (frontend/src/pages/admin/NhanSu.jsx): dùng danhSachNV thay vì nhanVienList', () => {
        const nhanSuSrc = fs.readFileSync(
            path.join(ROOT_DIR, 'frontend', 'src', 'pages', 'admin', 'NhanSu.jsx'),
            'utf8'
        );
        assert.doesNotMatch(
            nhanSuSrc,
            /nhanVienList/,
            'NhanSu.jsx không được tham chiếu nhanVienList chưa khai báo'
        );
        assert.match(
            nhanSuSrc,
            /danhSachNV\.map\s*\(\s*\(\s*nv\s*\)\s*=>/,
            'Bảng Lịch Phân Ca Tuần phải dùng danhSachNV.map(nv => ...)'
        );
    });

    it('7. Báo cáo Hourly Sales vs. Labor Cost % (modules/hrPayrollTipsService.js & businessDaySummaryService.js): join PhanCa và đọc đúng lương', () => {
        const hrServiceSrc = fs.readFileSync(path.join(ROOT_DIR, 'modules', 'hrPayrollTipsService.js'), 'utf8');
        assert.match(
            hrServiceSrc,
            /JOIN\s+public\.phanca\s+pc\s+ON\s+pc\.maphanca\s*=\s*cc\.maphanca/,
            'hrPayrollTipsService.js phải join PhanCa pc ON pc.maphanca = cc.maphanca để lấy tenantId và maNV'
        );
        assert.match(
            hrServiceSrc,
            /WHERE\s+COALESCE\s*\(\s*pc\.tenantid,\s*'DEFAULT'\s*\)\s*=\s*\$1/,
            'hrPayrollTipsService.js phải lọc pc.tenantid thay vì cc.tenantid'
        );
        assert.doesNotMatch(
            hrServiceSrc,
            /WHERE\s+COALESCE\s*\(\s*cc\.tenantid/,
            'Không được lọc cc.tenantid vì bảng chamcong không có cột tenantid'
        );

        const bdaySrc = fs.readFileSync(
            path.join(ROOT_DIR, 'src', 'domains', 'reports', 'businessDaySummaryService.js'),
            'utf8'
        );
        assert.match(
            bdaySrc,
            /JOIN\s+public\.phanca\s+pc\s+ON\s+pc\.maphanca\s*=\s*cc\.maphanca/,
            'businessDaySummaryService.js phải join PhanCa pc để liên kết nhân viên chấm công'
        );
    });
});
