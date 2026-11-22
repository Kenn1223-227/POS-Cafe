#!/usr/bin/env node
/**
 * Script đóng gói mã nguồn sạch (Phân hệ 7):
 * - Loại bỏ tuyệt đối node_modules/, frontend/node_modules/, frontend/dist/, .env, *.zip, *.log
 * - Giúp gói triển khai chỉ còn ~1–2 MB thay vì 45,3 MB (11.992 entries)
 * Chạy: npm run pack:clean
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(ROOT_DIR, '..');
const OUT_ZIP = path.join(OUT_DIR, 'cafe-pos-backend-clean.zip');
const STAGE_DIR = path.join(OUT_DIR, '.tmp-clean-pack');

const EXCLUDED_DIRS = new Set([
    'node_modules',
    'dist',
    '.vite',
    '.git',
    '.agents',
    'coverage',
]);

const EXCLUDED_FILES = new Set([
    '.env',
    'bridge-config.json',
    'lan-orders.json',
]);

const EXCLUDED_EXTS = new Set(['.zip', '.log', '.gz']);

function shouldSkip(entryName, isDir) {
    if (isDir) return EXCLUDED_DIRS.has(entryName);
    if (EXCLUDED_FILES.has(entryName)) return true;
    if (/^\.env\.(?!example$)/i.test(entryName)) return true;
    return EXCLUDED_EXTS.has(path.extname(entryName).toLowerCase());
}

function copyFiltered(src, dest, stats) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (shouldSkip(entry.name, entry.isDirectory())) {
            stats.skipped += 1;
            continue;
        }
        const sPath = path.join(src, entry.name);
        const dPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyFiltered(sPath, dPath, stats);
        } else if (entry.isFile()) {
            fs.copyFileSync(sPath, dPath);
            stats.files += 1;
            stats.bytes += fs.statSync(sPath).size;
        }
    }
}

function main() {
    const stats = { files: 0, bytes: 0, skipped: 0 };
    if (fs.existsSync(STAGE_DIR)) fs.rmSync(STAGE_DIR, { recursive: true, force: true });
    if (fs.existsSync(OUT_ZIP)) fs.unlinkSync(OUT_ZIP);

    try {
        copyFiltered(ROOT_DIR, STAGE_DIR, stats);
        if (process.platform === 'win32') {
            execFileSync(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-Command',
                    `Compress-Archive -Path "${STAGE_DIR}\\*" -DestinationPath "${OUT_ZIP}" -CompressionLevel Optimal`,
                ],
                { stdio: 'inherit' }
            );
        } else {
            execFileSync('zip', ['-rq', OUT_ZIP, '.'], { cwd: STAGE_DIR, stdio: 'inherit' });
        }
        const zipSizeMb = (fs.statSync(OUT_ZIP).size / (1024 * 1024)).toFixed(2);
        console.log(`✅ Đã đóng gói mã nguồn sạch tại: ${OUT_ZIP}`);
        console.log(`   Số file: ${stats.files} | Kích thước gốc: ${(stats.bytes / (1024 * 1024)).toFixed(2)} MB | File ZIP: ${zipSizeMb} MB | Đã loại trừ: ${stats.skipped} mục rác/node_modules`);
    } finally {
        if (fs.existsSync(STAGE_DIR)) fs.rmSync(STAGE_DIR, { recursive: true, force: true });
    }
}

if (require.main === module) {
    main();
}

module.exports = { shouldSkip };
