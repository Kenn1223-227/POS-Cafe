const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../..');

describe('Batch 1 Remediation Verification — P0 Fixes', () => {
    it('1. Dockerfile: COPY src ./src tồn tại và toàn bộ runtime dependencies của server.js được copy', () => {
        const dockerfilePath = path.join(ROOT_DIR, 'Dockerfile');
        const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');

        assert.match(dockerfile, /COPY\s+src\s+\.\/src/, 'Dockerfile phải có lệnh COPY src ./src');
        assert.match(dockerfile, /COPY\s+modules\s+\.\/modules/, 'Dockerfile phải copy modules');
        assert.match(dockerfile, /COPY\s+db\s+\.\/db/, 'Dockerfile phải copy db');
        assert.match(dockerfile, /COPY\s+server\.js\s+db\.js\s+config\.js\s+middleware\.js\s+password\.js\s+\.\//, 'Dockerfile phải copy các file runtime root');
    });

    it('2. CI Workflow (.github/workflows/ci.yml): Build frontend chạy TRƯỚC test:wave2', () => {
        const ciPath = path.join(ROOT_DIR, '.github/workflows/ci.yml');
        const ci = fs.readFileSync(ciPath, 'utf8');

        const buildFrontendIndex = ci.indexOf('name: Build frontend');
        const testWave2Index = ci.indexOf('name: Run Test Wave 2');
        assert.ok(buildFrontendIndex > -1, 'CI phải có bước Build frontend');
        assert.ok(testWave2Index > -1, 'CI phải có bước Run Test Wave 2');
        assert.ok(buildFrontendIndex < testWave2Index, 'Build frontend phải đứng TRƯỚC Run Test Wave 2');
    });

    it('3. Cookie Cross-Domain: COOKIE_SAMESITE=None tự động ép Secure=true & .env.example có chú thích đầy đủ', () => {
        const middleware = require('../../middleware');
        const envExamplePath = path.join(ROOT_DIR, '.env.example');
        const envExample = fs.readFileSync(envExamplePath, 'utf8');

        // Test None case-insensitive -> auto Secure
        const originalSameSite = process.env.COOKIE_SAMESITE;
        const originalSecure = process.env.COOKIE_SECURE;
        try {
            process.env.COOKIE_SAMESITE = 'None';
            delete process.env.COOKIE_SECURE;

            let cookieSet = '';
            const mockRes = {
                setHeader: (name, val) => {
                    if (name === 'Set-Cookie') cookieSet = val;
                },
            };
            const mockReq = { secure: false, headers: {} };

            middleware.setRefreshCookie(mockRes, mockReq, 'test_refresh_token_value_32_chars_long', 3600);
            assert.match(cookieSet, /SameSite=None/i, 'Phải có SameSite=None');
            assert.match(cookieSet, /Secure/, 'Khi SameSite=None, bắt buộc tự động có cờ Secure');

            // Test lowercase 'none'
            process.env.COOKIE_SAMESITE = 'none';
            cookieSet = '';
            middleware.setRefreshCookie(mockRes, mockReq, 'test_refresh_token_value_32_chars_long', 3600);
            assert.match(cookieSet, /SameSite=None/, 'Phải chuẩn hóa chữ hoa SameSite=None');
            assert.match(cookieSet, /Secure/, 'Khi SameSite=none, bắt buộc tự động có cờ Secure');

            // Test clearRefreshCookie
            cookieSet = '';
            middleware.clearRefreshCookie(mockRes, mockReq);
            assert.match(cookieSet, /SameSite=None/);
            assert.match(cookieSet, /Secure/);

            // Test Lax
            process.env.COOKIE_SAMESITE = 'Lax';
            cookieSet = '';
            middleware.setRefreshCookie(mockRes, mockReq, 'test_refresh_token_value_32_chars_long', 3600);
            assert.match(cookieSet, /SameSite=Lax/);
        } finally {
            process.env.COOKIE_SAMESITE = originalSameSite;
            process.env.COOKIE_SECURE = originalSecure;
        }

        assert.match(envExample, /COOKIE_SAMESITE/, '.env.example phải cấu hình COOKIE_SAMESITE');
        assert.match(envExample, /RFC 6265bis/, '.env.example phải chú thích rõ chuẩn ép Secure khi None');
        assert.match(envExample, /TRUST_PROXY=1/, '.env.example phải có cấu hình TRUST_PROXY=1');
    });

    it('4. SaaS Dunning: POST /api/saas/dunning/run dùng kiemTraPlatformAdmin (không dùng choPhepVaiTro(1))', () => {
        const saasRoutesPath = path.join(ROOT_DIR, 'modules/saasRoutes.js');
        const saasCode = fs.readFileSync(saasRoutesPath, 'utf8');

        assert.match(saasCode, /app\.post\('\/api\/saas\/dunning\/run',\s*authDunning/);
        assert.match(saasCode, /const authDunning = kiemTraPlatformAdmin/);
        assert.doesNotMatch(saasCode, /app\.post\('\/api\/saas\/dunning\/run',\s*kiemTraToken,\s*choPhepVaiTro\(1\)/);
    });

    it('5. Sửa nhầm Role 2 vs Role 4: Quyền Thu ngân trong chainFinanceOpsRoutes.js & priceBookAndZnsRoutes.js đã gán đúng Role 4', () => {
        const chainPath = path.join(ROOT_DIR, 'modules/chainFinanceOpsRoutes.js');
        const chainCode = fs.readFileSync(chainPath, 'utf8');

        // House Accounts & Shift Handover phải dùng choPhepVaiTro(1, 4)
        assert.match(chainCode, /app\.get\('\/api\/finance\/house-accounts',\s*kiemTraToken,\s*choPhepVaiTro\(1,\s*4\)/);
        assert.match(chainCode, /app\.post\('\/api\/finance\/house-accounts\/:id\/charge',\s*kiemTraToken,\s*choPhepVaiTro\(1,\s*4\)/);
        assert.match(chainCode, /app\.post\('\/api\/finance\/house-accounts\/:id\/repayment',\s*kiemTraToken,\s*choPhepVaiTro\(1,\s*4\)/);
        assert.match(chainCode, /app\.get\('\/api\/finance\/house-accounts\/:id\/statement',\s*kiemTraToken,\s*choPhepVaiTro\(1,\s*4\)/);
        assert.match(chainCode, /app\.post\('\/api\/shifts\/:maCa\/handover',\s*kiemTraToken,\s*choPhepVaiTro\(1,\s*4\)/);
        assert.match(chainCode, /app\.get\('\/api\/shifts\/:maCa\/handovers',\s*kiemTraToken,\s*choPhepVaiTro\(1,\s*4\)/);
        assert.doesNotMatch(chainCode, /choPhepVaiTro\(1,\s*2\)/, 'Không còn route tài chính/thu ngân nào trong chainFinanceOpsRoutes dùng role 2');

        const pbPath = path.join(ROOT_DIR, 'modules/priceBookAndZnsRoutes.js');
        const pbCode = fs.readFileSync(pbPath, 'utf8');

        assert.match(pbCode, /app\.get\('\/api\/price-books',\s*kiemTraToken,\s*choPhepVaiTro\(1,\s*4\)/);
        assert.match(pbCode, /app\.post\('\/api\/zns\/outbox',\s*kiemTraToken,\s*choPhepVaiTro\(1,\s*4\)/);
        assert.match(pbCode, /app\.get\('\/api\/bida\/sessions',\s*kiemTraToken,\s*choPhepVaiTro\(1,\s*3,\s*4\)/);
        assert.match(pbCode, /app\.post\('\/api\/bida\/sessions\/start',\s*kiemTraToken,\s*choPhepVaiTro\(1,\s*3,\s*4\)/);
        assert.match(pbCode, /app\.post\('\/api\/bida\/sessions\/:id\/pause',\s*kiemTraToken,\s*choPhepVaiTro\(1,\s*3,\s*4\)/);
        assert.match(pbCode, /app\.post\('\/api\/bida\/sessions\/:id\/resume',\s*kiemTraToken,\s*choPhepVaiTro\(1,\s*3,\s*4\)/);
        assert.match(pbCode, /app\.post\('\/api\/bida\/sessions\/:id\/close',\s*kiemTraToken,\s*choPhepVaiTro\(1,\s*3,\s*4\)/);
        assert.doesNotMatch(pbCode, /choPhepVaiTro\(1,\s*2\)/, 'Không còn route nào trong priceBookAndZnsRoutes dùng role 2');
    });

    it('6. Migration 039: Thu hồi quyền EXECUTE 6 hàm Super Admin khỏi app_runtime', () => {
        const migPath = path.join(ROOT_DIR, 'db/migrations/039_revoke_platform_rpcs_from_app_runtime.sql');
        assert.ok(fs.existsSync(migPath), 'File migration 039 phải tồn tại');
        const migSql = fs.readFileSync(migPath, 'utf8');

        assert.match(migSql, /REVOKE EXECUTE ON FUNCTION %s FROM app_runtime/);
        assert.match(migSql, /public\.fn_platform_overview_tenants\(\)/);
        assert.match(migSql, /public\.fn_platform_overview_billing\(\)/);
        assert.match(migSql, /public\.fn_platform_list_tenants\(integer\)/);
        assert.match(migSql, /public\.fn_platform_list_billing_orders\(text, integer\)/);
        assert.match(migSql, /public\.fn_platform_manual_approve_billing\(text, text, text, jsonb, text, text\)/);
        assert.match(migSql, /public\.fn_platform_impersonate_prepare\(text, text, text, timestamp with time zone, text\)/);
    });

    it('7. E-Invoice RLS: Toàn bộ 5 route trong einvoiceRoutes.js đều truyền tenantId vào chayGiaoDich', () => {
        const einvoicePath = path.join(ROOT_DIR, 'modules/einvoiceRoutes.js');
        const einvoiceCode = fs.readFileSync(einvoicePath, 'utf8');

        const calls = [...einvoiceCode.matchAll(/chayGiaoDich\(async\s*\([a-zA-Z0-9_, ]*\)\s*=>\s*\{[\s\S]*?\},\s*([a-zA-Z0-9_]+)\)/g)];
        assert.equal(calls.length, 5, 'Phải có đúng 5 lời gọi chayGiaoDich trong einvoiceRoutes.js có truyền tenantId');
        for (const call of calls) {
            assert.equal(call[1], 'tenantId', `Lời gọi chayGiaoDich phải truyền tenantId, nhận được: ${call[1]}`);
        }
    });
});
