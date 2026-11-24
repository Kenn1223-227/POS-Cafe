const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FRONTEND_DIST = path.join(__dirname, '..', '..', 'frontend', 'dist');

function tryLoadPlaywright() {
    try {
        // eslint-disable-next-line global-require
        return require('playwright');
    } catch {
        return null;
    }
}

describe('Wave 2 E2E [Tầng 4] — TC-W2-04 (QA-01): PWA Workbox Precache & Offline F5 Chống Trắng Màn Hình', () => {
    it('bản build production (frontend/dist) có Workbox sw.js precache đầy đủ JS/CSS/index.html & loại trừ /api/, /socket.io/', () => {
        const swPath = path.join(FRONTEND_DIST, 'sw.js');
        assert.equal(fs.existsSync(swPath), true, 'Thiếu frontend/dist/sw.js — hãy chạy `cd frontend && npm run build`');
        const swContent = fs.readFileSync(swPath, 'utf8');
        assert.ok(swContent.includes('precacheAndRoute'), 'sw.js phải được sinh bởi Workbox (precacheAndRoute)');
        assert.ok(swContent.includes('index.html'), 'Workbox precache phải bao gồm index.html');
        assert.ok(/assets\/index-[^"']+\.js/.test(swContent), 'Workbox precache phải bao gồm bundle assets/index-*.js');
        assert.ok(/assets\/index-[^"']+\.css/.test(swContent), 'Workbox precache phải bao gồm bundle assets/index-*.css');
        assert.ok(swContent.includes('api') && swContent.includes('socket'), 'navigateFallbackDenylist phải loại trừ /api/ và /socket.io/');
    });

    it('Playwright Chromium: mở POS từ bản build production -> setOffline(true) -> reload (F5) không trắng màn hình', async (t) => {
        const pw = tryLoadPlaywright();
        const previewUrl = String(process.env.E2E_PREVIEW_URL || '').trim();
        if (!pw || !previewUrl) {
            t.skip('Bỏ qua trình duyệt Chromium sống (cài `playwright` và đặt E2E_PREVIEW_URL để chạy full browser E2E)');
            return;
        }

        const browser = await pw.chromium.launch({ headless: true });
        try {
            const context = await browser.newContext();
            const page = await context.newPage();
            await page.goto(previewUrl, { waitUntil: 'networkidle' });
            await page.waitForTimeout(1000); // Chờ Workbox SW kích hoạt

            await context.setOffline(true);
            await page.reload({ waitUntil: 'domcontentloaded' });
            const rootHtml = await page.locator('#root').innerHTML();
            assert.ok(rootHtml.trim().length > 0, 'Màn hình POS không được trắng (#root rỗng) sau khi F5 offline!');

            await context.setOffline(false);
        } finally {
            await browser.close();
        }
    });
});
