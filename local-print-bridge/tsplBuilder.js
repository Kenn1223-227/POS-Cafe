/**
 * =============================================================================
 * PHÂN HỆ 2 - TRỤ CỘT 3: BỘ DỰNG LỆNH TSPL2 CHO TEM DÁN CỐC 40x30mm & 50x30mm
 * - Tách 1-N tem độc lập theo từng ly (bỏ qua món InTemCoc = false)
 * - Gán cupLabelId duy nhất + REVERSE banner cho [MANG VE] / [DOI MON] / [LAM LAI]
 * - Hỗ trợ chế độ BITMAP_VI (render 1-bit monochrome bitmap tiếng Việt có dấu, 0 external deps!)
 *   và ASCII_FALLBACK cho máy in cũ
 * =============================================================================
 */
const { boDauTiengViet } = require('./escposBuilder');

// [Wave 2 — P0-08] Chống TSPL Command Injection: lọc sạch toàn bộ ký tự điều khiển [\r\n\t\x00-\x1F\x7F]+ và chuẩn hóa " -> '
function escapeTsplSafe(str) {
    return boDauTiengViet(
        String(str || '').replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ')
    )
        .replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ')
        .replace(/"/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

// Giữ alias tương thích ngược
const escapeTspl = escapeTsplSafe;

// Regex nhận diện tùy chọn nhạy cảm cần đảo nền đen chữ trắng (REVERSE) trên tem cốc
const SENSITIVE_MODIFIER_RE =
    /(0%|khong duong|không đường|khong da|không đá|it da|ít đá|sua hat|sữa hạt|yen mach|yến mạch|di ung|dị ứng)/i;

// Tự động xuống dòng (word-wrap) tối đa maxLines dòng cho tên món dài thay vì cắt cụt cứng
function wrapTsplLines(text, maxChars = 26, maxLines = 2) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return [''];
    if (clean.length <= maxChars || maxLines <= 1) {
        return [clean.slice(0, maxChars)];
    }
    const lines = [];
    let rest = clean;
    while (rest.length > 0 && lines.length < maxLines) {
        if (rest.length <= maxChars || lines.length === maxLines - 1) {
            lines.push(rest.slice(0, maxChars).trim());
            break;
        }
        let cut = rest.lastIndexOf(' ', maxChars);
        if (cut <= Math.floor(maxChars * 0.4)) cut = maxChars;
        lines.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    return lines;
}

// Bảng 5x7 font pixel tối giản (Zero-dependency monochrome rasterizer cho BITMAP_VI)
// Mỗi ký tự cơ sở gồm 7 hàng, mỗi hàng 5 bit (bit 4 là trái nhất). Dấu tiếng Việt ghép lên trên/dưới!
const FONT_5X7 = {
    ' ': [0, 0, 0, 0, 0, 0, 0],
    A: [14, 17, 17, 31, 17, 17, 17],
    B: [30, 17, 17, 30, 17, 17, 30],
    C: [14, 17, 16, 16, 16, 17, 14],
    D: [30, 17, 17, 17, 17, 17, 30],
    E: [31, 16, 16, 30, 16, 16, 31],
    F: [31, 16, 16, 30, 16, 16, 16],
    G: [14, 17, 16, 19, 17, 17, 15],
    H: [17, 17, 17, 31, 17, 17, 17],
    I: [14, 4, 4, 4, 4, 4, 14],
    J: [7, 2, 2, 2, 18, 18, 12],
    K: [17, 18, 20, 24, 20, 18, 17],
    L: [16, 16, 16, 16, 16, 16, 31],
    M: [17, 27, 21, 21, 17, 17, 17],
    N: [17, 25, 21, 19, 17, 17, 17],
    O: [14, 17, 17, 17, 17, 17, 14],
    P: [30, 17, 17, 30, 16, 16, 16],
    Q: [14, 17, 17, 17, 21, 18, 13],
    R: [30, 17, 17, 30, 20, 18, 17],
    S: [15, 16, 16, 14, 1, 1, 30],
    T: [31, 4, 4, 4, 4, 4, 4],
    U: [17, 17, 17, 17, 17, 17, 14],
    V: [17, 17, 17, 17, 17, 10, 4],
    W: [17, 17, 17, 21, 21, 27, 17],
    X: [17, 17, 10, 4, 10, 17, 17],
    Y: [17, 17, 10, 4, 4, 4, 4],
    Z: [31, 1, 2, 4, 8, 16, 31],
    0: [14, 17, 19, 21, 25, 17, 14],
    1: [4, 12, 4, 4, 4, 4, 14],
    2: [14, 17, 1, 6, 8, 16, 31],
    3: [30, 1, 1, 14, 1, 1, 30],
    4: [2, 6, 10, 18, 31, 2, 2],
    5: [31, 16, 30, 1, 1, 17, 14],
    6: [14, 16, 30, 17, 17, 17, 14],
    7: [31, 1, 2, 4, 8, 8, 8],
    8: [14, 17, 17, 14, 17, 17, 14],
    9: [14, 17, 17, 15, 1, 2, 28],
    '-': [0, 0, 0, 31, 0, 0, 0],
    '+': [0, 4, 4, 31, 4, 4, 0],
    '/': [1, 2, 2, 4, 8, 8, 16],
    ':': [0, 4, 4, 0, 4, 4, 0],
    '.': [0, 0, 0, 0, 0, 4, 4],
    ',': [0, 0, 0, 0, 0, 4, 8],
    '(': [2, 4, 8, 8, 8, 4, 2],
    ')': [8, 4, 2, 2, 2, 4, 8],
    '#': [10, 31, 10, 10, 31, 10, 0],
    '%': [25, 26, 2, 4, 8, 11, 19],
    '!': [4, 4, 4, 4, 4, 0, 4],
    '|': [4, 4, 4, 4, 4, 4, 4],
    '[': [14, 8, 8, 8, 8, 8, 14],
    ']': [14, 2, 2, 2, 2, 2, 14],
};

// Raster 1 chuỗi tiếng Việt có dấu thành buffer TSPL BITMAP x,y,widthBytes,height,0,<rawBytes>
// Trong TSPL BITMAP mode 0: bit 0 = đen (in mực), bit 1 = trắng (nền giấy)
function buildTsplVietnameseBitmapCommand(text, { x = 12, y = 44, scale = 2, maxDotsWidth = 376 } = {}) {
    const str = String(text || '').trim();
    if (!str) return Buffer.alloc(0);

    // Tách từng grapheme đơn giản (ký tự + tổ hợp dấu NFD)
    const glyphs = [];
    for (const ch of str) {
        const isDStroke = ch === 'đ' || ch === 'Đ';
        const nfd = ch.normalize('NFD');
        const baseRaw = isDStroke ? 'D' : nfd[0].toUpperCase();
        const marks = nfd.slice(1);
        glyphs.push({ base: FONT_5X7[baseRaw] || FONT_5X7[' '], isDStroke, marks });
    }

    const cellW = 6 * scale;
    const maxChars = Math.max(1, Math.floor(maxDotsWidth / cellW));
    const clipped = glyphs.slice(0, maxChars);

    const imgW = clipped.length * cellW;
    const widthBytes = Math.ceil(imgW / 8);
    const imgH = 12 * scale; // 3 hàng trên cho dấu + 7 hàng chữ + 2 hàng dưới cho dấu nặng
    const buf = Buffer.alloc(widthBytes * imgH, 0xff); // 0xFF = nền trắng toàn bộ

    const setBlack = (px, py) => {
        if (px < 0 || py < 0 || px >= widthBytes * 8 || py >= imgH) return;
        const byteIdx = py * widthBytes + (px >> 3);
        const bitMask = 0x80 >> (px & 7);
        buf[byteIdx] &= ~bitMask;
    };

    const drawScaledPixel = (gx, gy, ox) => {
        for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
                setBlack(ox + gx * scale + dx, gy * scale + dy);
            }
        }
    };

    clipped.forEach((g, idx) => {
        const ox = idx * cellW;
        // Vẽ thân chữ (hàng y=3..9)
        for (let row = 0; row < 7; row++) {
            const bits = g.base[row] || 0;
            for (let col = 0; col < 5; col++) {
                if ((bits >> (4 - col)) & 1) {
                    drawScaledPixel(col, 3 + row, ox);
                }
            }
        }
        // Nét gạch ngang cho Đ/đ
        if (g.isDStroke) {
            for (let col = 0; col < 4; col++) drawScaledPixel(col, 6, ox);
        }
        // Vẽ dấu tiếng Việt cơ bản từ combining marks (NFD)
        for (const m of g.marks) {
            const code = m.charCodeAt(0);
            if (code === 0x0301) { // sắc (/)
                drawScaledPixel(3, 0, ox); drawScaledPixel(2, 1, ox);
            } else if (code === 0x0300) { // huyền (\)
                drawScaledPixel(1, 0, ox); drawScaledPixel(2, 1, ox);
            } else if (code === 0x0309) { // hỏi (?)
                drawScaledPixel(2, 0, ox); drawScaledPixel(3, 0, ox); drawScaledPixel(2, 1, ox);
            } else if (code === 0x0303) { // ngã (~)
                drawScaledPixel(1, 1, ox); drawScaledPixel(2, 0, ox); drawScaledPixel(3, 1, ox);
            } else if (code === 0x0302) { // mũ (^) â/ê/ô
                drawScaledPixel(2, 1, ox); drawScaledPixel(1, 2, ox); drawScaledPixel(3, 2, ox);
            } else if (code === 0x0306) { // trăng (˘) ă
                drawScaledPixel(1, 1, ox); drawScaledPixel(2, 2, ox); drawScaledPixel(3, 1, ox);
            } else if (code === 0x031b) { // móc ơ/ư
                drawScaledPixel(4, 2, ox); drawScaledPixel(4, 3, ox);
            } else if (code === 0x0323) { // nặng (.)
                drawScaledPixel(2, 10, ox);
            }
        }
    });

    const header = Buffer.from(`BITMAP ${x},${y},${widthBytes},${imgH},0,`, 'ascii');
    const tail = Buffer.from('\r\n', 'ascii');
    return Buffer.concat([header, buf, tail]);
}

function formatModifiersAndToppings(cup) {
    const modParts = [];
    if (Array.isArray(cup.modifiersSnapshot)) {
        for (const m of cup.modifiersSnapshot) {
            const name = m.tenInNgan || m.tenOption || '';
            if (name) modParts.push(m.soLuong > 1 ? `${name} x${m.soLuong}` : name);
        }
    }
    const tpParts = [];
    if (Array.isArray(cup.toppings)) {
        for (const t of cup.toppings) {
            if (!t?.tenTopping) continue;
            const perCup = Number(t.soLuongMoiLy || 1);
            tpParts.push(perCup > 1 ? `+${t.tenTopping} x${perCup}` : `+${t.tenTopping}`);
        }
    }
    return {
        modLine: modParts.join(', '),
        tpLine: tpParts.join(', '),
    };
}

/**
 * Tách 1 hóa đơn gồm N ly thành N nhãn tem độc lập ("Ly 1/N", "Ly 2/N"...)
 * - Tự động bỏ qua món có `inTemCoc === false` (VD: nước đóng chai, bánh nguyên gói)
 * - Hỗ trợ khổ 50x30mm (400x240 dots) & 40x30mm (320x240 dots)
 * - Hỗ trợ renderMode: 'BITMAP_VI' (mặc định, in tiếng Việt có dấu) hoặc 'ASCII_FALLBACK'
 * - Trả về mảng `cups[]` độc lập để Spooler in từng tem + lưu checkpoint kẹt giấy chính xác!
 */
function buildCupLabelsTspl({
    hoaDon,
    onlyCupIndex = null,
    widthMm = 50,
    heightMm = 30,
    renderMode = 'BITMAP_VI',
    failoverHeader = null,
}) {
    const items = (hoaDon?.danhSachMon || []).filter(
        (m) => !m.daHuy && m.trangThaiPhaChe !== 'DaHuy' && m.inTemCoc !== false
    );
    const maHD = escapeTspl(hoaDon?.maHoaDon || 'TEST');
    const isOrderTakeaway =
        String(hoaDon?.loaiDonHang || '').toUpperCase() === 'MANG_DI' ||
        String(hoaDon?.loaiDonHang || '').toUpperCase() === 'GIAO_HANG' ||
        !(hoaDon?.ban && hoaDon.ban.length > 0);

    const rawCups = [];
    for (const m of items) {
        const qty = Math.max(1, Number(m.soLuong || 1));
        for (let i = 1; i <= qty; i++) {
            rawCups.push({
                cupLabelId: `${maHD}-${m.maCTHD || m.maMon}-${i}`,
                maCTHD: m.maCTHD || null,
                maMon: m.maMon,
                tenMon: m.tenMonTuyChinh || m.tenMon,
                kichThuoc: m.kichThuoc || 'M',
                ghiChu: m.ghiChu || '',
                modifiersSnapshot: m.modifiersSnapshot || [],
                toppings: m.toppings || [],
                isTakeaway: Boolean(m.isTakeaway) || isOrderTakeaway,
                isRemake: Boolean(m.remakeOfCTHD) || Number(m.mucDoUuTien) === 2,
                isSwap: String(m.ghiChu || '').includes('[ĐỔI') || Number(m.mucDoUuTien) === 1,
                trongLuongGram: m.trongLuongGram || null,
            });
        }
    }

    if (rawCups.length === 0) {
        return { buffer: Buffer.alloc(0), cups: [], cupCount: 0, totalCups: 0, previewText: '' };
    }

    const total = rawCups.length;
    const widthDots = Math.round(Number(widthMm || 50) * 8); // 203 DPI ~ 8 dots/mm
    const maxW = Math.max(240, widthDots - 24);
    const sttDisplay = hoaDon?.soThuTuHienThi
        ? `SO #${escapeTspl(hoaDon.soThuTuHienThi)}`
        : Number(hoaDon?.soThuTuNgay) > 0
        ? `SO #${String(hoaDon.soThuTuNgay).padStart(3, '0')}`
        : `#${maHD}`;
    const tenBan = escapeTspl(hoaDon?.ban?.map((b) => b.tenBan).join(', ') || 'Mang ve');
    const tenKhach = escapeTspl(hoaDon?.tenKhachVangLai || hoaDon?.khachHang?.tenKH || '');
    const gio = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    const useBitmapVi = String(renderMode || 'BITMAP_VI').toUpperCase() === 'BITMAP_VI';

    const cups = [];
    const allBuffers = [];
    const previews = [];

    rawCups.forEach((cup, idx) => {
        const cupIndex = idx + 1;
        if (onlyCupIndex && Number(onlyCupIndex) !== cupIndex) return;

        const badge = cup.isRemake
            ? '[LAM LAI]'
            : cup.isSwap
            ? '[DOI MON]'
            : cup.isTakeaway
            ? '[MANG VE]'
            : '';

        const header = `${sttDisplay} | ${tenBan} (${cupIndex}/${total})`;
        const titleViRaw = `${cup.tenMon} (${cup.kichThuoc})${cup.trongLuongGram ? ` ${cup.trongLuongGram}g` : ''}`
            .replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const maxTitleChars = widthMm <= 40 ? 20 : 26;
        const titleViLines = wrapTsplLines(titleViRaw, maxTitleChars, 2);
        const titleAsciiLines = wrapTsplLines(escapeTsplSafe(titleViRaw), maxTitleChars, 2);
        const { modLine, tpLine } = formatModifiersAndToppings(cup);
        const detailViRaw = ([modLine, tpLine, cup.ghiChu].filter(Boolean).join(' • ') || 'Tiêu chuẩn')
            .replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const detailAscii = escapeTsplSafe(detailViRaw).slice(0, widthMm <= 40 ? 26 : 34);
        const hasSensitiveModifier = SENSITIVE_MODIFIER_RE.test(detailViRaw);

        const parts = [];
        parts.push(
            Buffer.from(
                [
                    `SIZE ${widthMm} mm,${heightMm} mm`,
                    'GAP 2 mm,0 mm',
                    'DIRECTION 1',
                    'CLS',
                    failoverHeader ? `TEXT 10,2,"1",0,1,1,"${escapeTsplSafe(failoverHeader).slice(0, 32)}"` : null,
                    `TEXT 10,12,"2",0,1,1,"${escapeTsplSafe(header).slice(0, widthMm <= 40 ? 22 : 30)}"`,
                    badge ? `TEXT ${widthDots - 108},12,"2",0,1,1,"${badge}"` : null,
                    badge ? `REVERSE ${widthDots - 112},10,104,22` : null,
                    `BAR 10,36,${maxW},2`,
                ]
                    .filter(Boolean)
                    .join('\r\n') + '\r\n',
                'ascii'
            )
        );

        const hasSecondTitleLine = (useBitmapVi ? titleViLines.length : titleAsciiLines.length) > 1;
        const detailY = hasSecondTitleLine ? 98 : 78;

        if (useBitmapVi) {
            parts.push(buildTsplVietnameseBitmapCommand(titleViLines[0], { x: 10, y: 42, scale: 2, maxDotsWidth: maxW }));
            if (titleViLines[1]) {
                parts.push(buildTsplVietnameseBitmapCommand(titleViLines[1], { x: 10, y: 68, scale: 2, maxDotsWidth: maxW }));
            }
            parts.push(buildTsplVietnameseBitmapCommand(detailViRaw, { x: 10, y: detailY, scale: 1, maxDotsWidth: maxW }));
            if (hasSensitiveModifier) {
                parts.push(Buffer.from(`REVERSE 8,${Math.max(40, detailY - 2)},${maxW + 4},18\r\n`, 'ascii'));
            }
        } else {
            const textCmds = [`TEXT 10,44,"3",0,1,1,"${titleAsciiLines[0]}"`];
            if (titleAsciiLines[1]) {
                textCmds.push(`TEXT 10,70,"3",0,1,1,"${titleAsciiLines[1]}"`);
            }
            textCmds.push(`TEXT 10,${detailY},"2",0,1,1,"${detailAscii}"`);
            if (hasSensitiveModifier) {
                textCmds.push(`REVERSE 8,${Math.max(40, detailY - 2)},${maxW + 4},22`);
            }
            parts.push(Buffer.from(textCmds.join('\r\n') + '\r\n', 'ascii'));
        }

        const footerParts = [`${gio}`, tenKhach ? `KH:${tenKhach.slice(0, 12)}` : null].filter(Boolean).join(' | ');
        const barcodeVal = `${maHD}-${cupIndex}`.replace(/[^A-Z0-9-]/gi, '').slice(0, 18);
        parts.push(
            Buffer.from(
                [
                    `BARCODE 10,136,"128",34,0,0,1,2,"${barcodeVal}"`,
                    `TEXT 10,180,"1",0,1,1,"${escapeTsplSafe(footerParts).slice(0, 32)}"`,
                    'PRINT 1,1',
                    '',
                ].join('\r\n'),
                'ascii'
            )
        );

        const cupBuffer = Buffer.concat(parts);
        const preview = `[TEM ${widthMm}x${heightMm} #${cupIndex}/${total}${badge ? ' ' + badge : ''}${hasSensitiveModifier ? ' [REVERSE]' : ''}] (${useBitmapVi ? 'BITMAP_VI' : 'ASCII'})\n${header}\n${titleViLines.join('\n')}\n${detailViRaw}\n${footerParts}`;

        cups.push({
            cupIndex,
            totalCups: total,
            cupLabelId: cup.cupLabelId,
            maCTHD: cup.maCTHD,
            tenMon: cup.tenMon,
            badge,
            hasSensitiveModifier,
            titleLines: useBitmapVi ? titleViLines : titleAsciiLines,
            renderMode: useBitmapVi ? 'BITMAP_VI' : 'ASCII_FALLBACK',
            buffer: cupBuffer,
            previewText: preview,
        });
        allBuffers.push(cupBuffer);
        previews.push(preview);
    });

    return {
        buffer: Buffer.concat(allBuffers),
        cups,
        cupCount: cups.length,
        totalCups: total,
        previewText: previews.join('\n---\n'),
    };
}

module.exports = {
    escapeTsplSafe,
    escapeTspl,
    SENSITIVE_MODIFIER_RE,
    wrapTsplLines,
    buildCupLabelsTspl,
    buildTsplVietnameseBitmapCommand,
};
