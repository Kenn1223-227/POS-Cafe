'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

function walkJsFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walkJsFiles(full));
        } else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) {
            results.push(full);
        }
    }
    return results;
}

describe('Wave 4B Architecture & CI Guard [Tầng 3] — Monolith Shrinkage, Domains, k6, CI & Zero Native Dialogs', () => {
    it('server.js đã rút gọn xuống dưới 2.000 dòng và pass node --check', () => {
        const serverPath = path.join(BACKEND_ROOT, 'server.js');
        const content = fs.readFileSync(serverPath, 'utf8');
        const lineCount = content.split(/\r?\n/).length;
        assert.ok(
            lineCount < 2000,
            `server.js phải dưới 2.000 dòng sau khi tách Strangler Pattern, thực tế: ${lineCount} dòng`
        );
        execFileSync(process.execPath, ['--check', serverPath], { stdio: 'pipe' });
    });

    it('toàn bộ 8 domain trong src/domains/ và tiện ích lõi trong src/core/ tồn tại + pass node --check', () => {
        const expectedDomains = ['auth', 'menu', 'orders', 'inventory', 'hr', 'crm', 'reports', 'system'];
        for (const domain of expectedDomains) {
            const domainIndex = path.join(BACKEND_ROOT, 'src', 'domains', domain, 'index.js');
            assert.ok(fs.existsSync(domainIndex), `Thiếu domain file: src/domains/${domain}/index.js`);
            execFileSync(process.execPath, ['--check', domainIndex], { stdio: 'pipe' });
        }

        const expectedCore = ['auditAndSecurity.js', 'socketRooms.js', 'orderHelpers.js'];
        for (const coreFile of expectedCore) {
            const p = path.join(BACKEND_ROOT, 'src', 'core', coreFile);
            assert.ok(fs.existsSync(p), `Thiếu core helper: src/core/${coreFile}`);
            execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
        }

        // Kiểm tra toàn bộ file .js dưới src/ đều hợp lệ cú pháp & không require ngược về server.js
        const allSrcJs = walkJsFiles(path.join(BACKEND_ROOT, 'src'));
        assert.ok(allSrcJs.length >= 12);
        for (const f of allSrcJs) {
            execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
            const text = fs.readFileSync(f, 'utf8');
            assert.ok(
                !/require\(['"`][^'"`]*server(?:\.js)?['"`]\)/.test(text),
                `Phát hiện circular require ngược về server.js trong ${path.relative(BACKEND_ROOT, f)}`
            );
        }
    });

    it('tests/load/k6-pos-25tps.js tồn tại và cấu hình đủ 25 TPS + 200 VU + SLO p(95)<500', () => {
        const k6Path = path.join(BACKEND_ROOT, 'tests', 'load', 'k6-pos-25tps.js');
        assert.ok(fs.existsSync(k6Path), 'Thiếu file tests/load/k6-pos-25tps.js');
        const k6Src = fs.readFileSync(k6Path, 'utf8');
        assert.ok(k6Src.includes('constant-arrival-rate'), 'k6 phải có executor constant-arrival-rate');
        assert.ok(/rate\s*:\s*25\b/.test(k6Src), 'k6 phải cấu hình rate: 25');
        assert.ok(k6Src.includes('200'), 'k6 phải có kịch bản 200 VU');
        assert.ok(k6Src.includes('thresholds'), 'k6 phải cấu hình thresholds SLO');
        assert.ok(k6Src.includes('p(95)<500'), 'k6 phải có ngưỡng p(95)<500');
    });

    it('.github/workflows/ci.yml đã bao gồm đầy đủ test:wave1 -> test:wave4b và frontend build', () => {
        const ciPath = path.join(BACKEND_ROOT, '.github', 'workflows', 'ci.yml');
        assert.ok(fs.existsSync(ciPath), 'Thiếu .github/workflows/ci.yml');
        const ciSrc = fs.readFileSync(ciPath, 'utf8');
        for (const script of ['test:wave1', 'test:wave2', 'test:wave3a', 'test:wave3b', 'test:wave4a', 'test:wave4b']) {
            assert.ok(ciSrc.includes(script), `.github/workflows/ci.yml thiếu bước chạy ${script}`);
        }
        assert.ok(ciSrc.includes('npm run build'), '.github/workflows/ci.yml thiếu bước frontend npm run build');
        assert.ok(ciSrc.includes('src/domains'), '.github/workflows/ci.yml phải kiểm tra cú pháp src/domains');
    });

    it('frontend/src/ giữ nguyên 0 lời gọi window.prompt( và 0 window.confirm(', () => {
        const feSrcDir = path.join(BACKEND_ROOT, 'frontend', 'src');
        const feFiles = walkJsFiles(feSrcDir);
        assert.ok(feFiles.length > 0, 'Không tìm thấy mã nguồn frontend/src');
        const violations = [];
        for (const f of feFiles) {
            const text = fs.readFileSync(f, 'utf8');
            if (text.includes('window.prompt(') || text.includes('window.confirm(')) {
                violations.push(path.relative(BACKEND_ROOT, f));
            }
        }
        assert.deepEqual(
            violations,
            [],
            `Phát hiện window.prompt( hoặc window.confirm( trong frontend/src: ${violations.join(', ')}`
        );
    });
});
