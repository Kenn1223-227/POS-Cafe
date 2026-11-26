// Bộ dựng lệnh nhị phân chuẩn ESC/POS cho máy in nhiệt K80 (80mm / 48 ký tự) + Xung mở két tiền RJ11

const ESC = 0x1b;
const GS = 0x1d;
const RASTER_BAND_HEIGHT = 256;

/**
 * [Wave 2 — P0-08] Chuyển dữ liệu ảnh 1-bit hoặc RGBA thành lệnh ESC/POS Raster GS v 0
 * (0x1D 0x76 0x30 0x00 xL xH yL yH <data>), tự động cắt băng theo BAND_HEIGHT = 256px
 * để chống tràn bộ đệm RAM của máy in nhiệt Xprinter/Zywell.
 */
function encodeBitmapToEscPosGsV0(
    pixelData,
    width,
    height,
    { bandHeight = RASTER_BAND_HEIGHT, threshold = 160, isAlready1Bit = false } = {}
) {
    const w = Math.max(1, Math.floor(Number(width) || 0));
    const h = Math.max(1, Math.floor(Number(height) || 0));
    const maxBand = Math.max(1, Math.min(256, Math.floor(Number(bandHeight) || RASTER_BAND_HEIGHT)));
    const widthBytes = Math.ceil(w / 8);

    let monoBytes;
    if (isAlready1Bit) {
        monoBytes = Buffer.isBuffer(pixelData) ? pixelData : Buffer.from(pixelData || []);
    } else {
        monoBytes = Buffer.alloc(widthBytes * h, 0x00);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = (y * w + x) * 4;
                const r = pixelData[idx] ?? 255;
                const g = pixelData[idx + 1] ?? 255;
                const b = pixelData[idx + 2] ?? 255;
                const a = pixelData[idx + 3] ?? 255;
                // Alpha thấp coi như nền trắng; độ sáng < threshold thì chấm mực đen (bit = 1)
                const lum = a < 128 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b;
                if (lum < threshold) {
                    const byteIdx = y * widthBytes + (x >> 3);
                    monoBytes[byteIdx] |= 0x80 >> (x & 7);
                }
            }
        }
    }

    const chunks = [];
    const xL = widthBytes & 0xff;
    const xH = (widthBytes >> 8) & 0xff;

    for (let yStart = 0; yStart < h; yStart += maxBand) {
        const bandH = Math.min(maxBand, h - yStart);
        const yL = bandH & 0xff;
        const yH = (bandH >> 8) & 0xff;
        const header = Buffer.from([GS, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
        const sliceStart = yStart * widthBytes;
        const sliceEnd = sliceStart + bandH * widthBytes;
        const bandData = Buffer.alloc(bandH * widthBytes, 0x00);
        monoBytes.copy(bandData, 0, sliceStart, Math.min(sliceEnd, monoBytes.length));
        chunks.push(header, bandData);
    }

    return Buffer.concat(chunks);
}

/**
 * Đóng gói buffer ESC/POS hoàn chỉnh từ ảnh Raster tiếng Việt có dấu (nhận từ Frontend Canvas)
 */
function buildRasterReceiptBuffer({
    rasterBase64 = null,
    rasterBytes = null,
    rgbaData = null,
    width = 576,
    height = 0,
    bandHeight = RASTER_BAND_HEIGHT,
    kickDrawer = false,
    autoCut = true,
} = {}) {
    const chunks = [Buffer.from([ESC, 0x40])]; // ESC @ Init
    if (kickDrawer) {
        chunks.push(buildCashDrawerKickBuffer());
    }
    chunks.push(Buffer.from([ESC, 0x61, 0x01])); // Center align

    if (rasterBase64) {
        chunks.push(Buffer.from(String(rasterBase64), 'base64'));
    } else if (rasterBytes) {
        chunks.push(Buffer.isBuffer(rasterBytes) ? rasterBytes : Buffer.from(rasterBytes));
    } else if (rgbaData && width > 0 && height > 0) {
        chunks.push(encodeBitmapToEscPosGsV0(rgbaData, width, height, { bandHeight }));
    }

    chunks.push(Buffer.from('\n\n\n', 'ascii'));
    if (autoCut) {
        chunks.push(Buffer.from([GS, 0x56, 0x42, 0x00]));
    }
    return {
        buffer: Buffer.concat(chunks),
        kickDrawer: Boolean(kickDrawer),
    };
}

// Chuyển tiếng Việt có dấu sang ASCII sạch để mọi máy in nhiệt giá rẻ (Xprinter/Zywell) không bị lỗi font/ô vuông
function boDauTiengViet(str) {
    return String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .replace(/[^\x20-\x7E\n]/g, ' ');
}

function dinhDangTien(n) {
    const num = Math.round(Number(n) || 0);
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + 'd';
}

function padTwoCols(left, right, width = 48) {
    const l = boDauTiengViet(left);
    const r = boDauTiengViet(right);
    const space = Math.max(1, width - l.length - r.length);
    if (l.length + r.length + 1 > width) {
        return l.slice(0, Math.max(1, width - r.length - 1)) + ' ' + r;
    }
    return l + ' '.repeat(space) + r;
}

function wrapText(text, width = 48) {
    const clean = boDauTiengViet(text).trim();
    if (!clean) return [];
    const lines = [];
    let cur = clean;
    while (cur.length > width) {
        let cut = cur.lastIndexOf(' ', width);
        if (cut <= 0) cut = width;
        lines.push(cur.slice(0, cut).trim());
        cur = cur.slice(cut).trim();
    }
    if (cur) lines.push(cur);
    return lines;
}

// Lệnh mở ngăn kéo tiền RJ11 chuẩn ESC/POS: ESC p 0 25 250 (0x1B 0x70 0x00 0x19 0xFA)
function buildCashDrawerKickBuffer() {
    return Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]);
}

// [PHÂN HỆ 9 - VIRAL PLG] Lệnh in mã QR Code chuẩn ESC/POS (GS ( k — Model 2, ECC Level M)
function buildEscPosQrCodeBuffer(data, moduleSize = 4) {
    const clean = String(data || '').trim();
    if (!clean) return Buffer.alloc(0);
    const dataBuf = Buffer.from(clean, 'utf8');
    const storeLen = dataBuf.length + 3;
    const pL = storeLen & 0xff;
    const pH = (storeLen >> 8) & 0xff;
    const size = Math.max(3, Math.min(8, Number(moduleSize) || 4));
    return Buffer.concat([
        Buffer.from([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]), // Model 2
        Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, size]),       // Module size
        Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]),       // Error correction M (49)
        Buffer.from([GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]),           // Store QR payload
        dataBuf,
        Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]),       // Print QR
    ]);
}

function maskPhoneForReceipt(sdt) {
    const raw = String(sdt || '').trim();
    if (!raw) return '';
    if (raw.length < 7) {
        if (raw.length <= 2) return '***';
        return `${raw.slice(0, 1)}***${raw.slice(-1)}`;
    }
    return `${raw.slice(0, 4)}***${raw.slice(-3)}`;
}

// Dựng Buffer nhị phân ESC/POS + bản xem trước dạng text cho Bill K80
function buildReceiptK80({
    hoaDon,
    tenQuan = 'QUAN CA PHE POS',
    diaChi = '',
    soLanIn = 1,
    laBanSao = false,
    reprintBanner = null,
    failoverHeader = null,
    laTamTinh = false,
    laDonOffline = false,
    thuNgan = '',
    autoCut = true,
    kickDrawer = false,
    showPlgWatermark = false,
    plgReferralUrl = '',
}) {
    const chunks = [];
    const previewLines = [];
    const LINE = '-'.repeat(48);

    const pushBytes = (...bytes) => chunks.push(Buffer.from(bytes));
    const pushLine = (text = '') => {
        const clean = boDauTiengViet(text);
        previewLines.push(clean);
        chunks.push(Buffer.from(clean + '\n', 'ascii'));
    };

    // Init printer
    pushBytes(ESC, 0x40);
    if (kickDrawer) {
        chunks.push(buildCashDrawerKickBuffer());
    }

    // Banner Failover hoặc Server-enforced Reprint Watermark
    if (failoverHeader) {
        pushBytes(ESC, 0x61, 0x01);
        pushBytes(ESC, 0x45, 0x01);
        pushLine(failoverHeader);
        pushBytes(ESC, 0x45, 0x00);
    }
    const effectiveReprintBanner = reprintBanner || (laBanSao || Number(soLanIn) >= 2 ? `*** BAN SAO - REPRINT LAN ${Math.max(2, Number(soLanIn || 2))} ***` : null);
    if (effectiveReprintBanner) {
        pushBytes(ESC, 0x61, 0x01);
        pushBytes(ESC, 0x45, 0x01);
        pushLine(effectiveReprintBanner);
        pushBytes(ESC, 0x45, 0x00);
    }

    // Center + Bold + Double Size cho tên quán
    pushBytes(ESC, 0x61, 0x01); // Align center
    pushBytes(ESC, 0x45, 0x01); // Bold ON
    pushBytes(GS, 0x21, 0x11);  // Double width & height
    pushLine(boDauTiengViet(tenQuan).toUpperCase());
    pushBytes(GS, 0x21, 0x00);  // Normal size
    pushBytes(ESC, 0x45, 0x00); // Bold OFF

    if (diaChi) pushLine(diaChi);

    const maHD = hoaDon?.maHoaDon || 'TEST';
    const tenBan = hoaDon?.ban?.map((b) => b.tenBan).join(', ') || 'Mang di';
    const sttNum = Number(hoaDon?.soThuTuNgay);
    if (Number.isInteger(sttNum) && sttNum > 0) {
        const sttLabel = String(sttNum).padStart(2, '0');
        pushBytes(ESC, 0x45, 0x01); // Bold ON
        pushBytes(GS, 0x21, 0x11);  // Double width & height
        pushLine(`SO #${sttLabel}`);
        pushBytes(GS, 0x21, 0x00);  // Normal size
        pushBytes(ESC, 0x45, 0x00); // Bold OFF
    }
    pushLine(`HD: #${maHD} | ${tenBan}`);

    if (laDonOffline || hoaDon?.offline) {
        pushBytes(ESC, 0x45, 0x01);
        pushLine('*** DON OFFLINE - DANG CHO DONG BO ***');
        pushBytes(ESC, 0x45, 0x00);
    } else if (laTamTinh) {
        pushBytes(ESC, 0x45, 0x01);
        pushLine('*** PHIEU TAM TINH (CHUA THANH TOAN) ***');
        pushBytes(ESC, 0x45, 0x00);
    }

    // Align left cho chi tiết đơn
    pushBytes(ESC, 0x61, 0x00);
    const gio = new Date(hoaDon?.thoiGianTao || hoaDon?.thoigiantao || Date.now()).toLocaleString('vi-VN');
    pushLine(`Gio: ${gio}`);
    if (thuNgan) pushLine(`Thu ngan: ${thuNgan}`);
    if (hoaDon?.khachHang) {
        const maskedPhone = maskPhoneForReceipt(hoaDon.khachHang.soDienThoai);
        pushLine(`KH: ${hoaDon.khachHang.tenKH}${maskedPhone ? ` (${maskedPhone})` : ''}`);
    }
    pushLine(LINE);
    pushBytes(ESC, 0x45, 0x01);
    pushLine(padTwoCols('MON / SL', 'THANH TIEN'));
    pushBytes(ESC, 0x45, 0x00);
    pushLine(LINE);

    const items = (hoaDon?.danhSachMon || []).filter((m) => !m.daHuy && m.trangThaiPhaChe !== 'DaHuy');
    for (const m of items) {
        const title = `${m.tenMon} (${m.kichThuoc}) x${m.soLuong}`;
        pushLine(padTwoCols(title, dinhDangTien(m.thanhTien)));
        const mods = Array.isArray(m.modifiersSnapshot) ? m.modifiersSnapshot : Array.isArray(m.modifiers) ? m.modifiers : [];
        if (mods.length > 0) {
            const modStr = mods
                .map((mod) => {
                    const lbl = mod.tenInNgan || mod.tenOption || '';
                    const mQty = Number(mod.qty ?? mod.soLuong ?? 1);
                    return lbl ? (mQty > 1 ? `${lbl} x${mQty}` : lbl) : '';
                })
                .filter(Boolean)
                .join(', ');
            if (modStr) {
                for (const l of wrapText(`* ${modStr}`, 46)) pushLine('  ' + l);
            }
        }
        if (m.toppings?.length) {
            const tpStr = '+ ' + m.toppings.map((t) => `${t.tenTopping} x${t.soLuong}`).join(', ');
            for (const l of wrapText(tpStr, 46)) pushLine('  ' + l);
        }
        if (m.ghiChu) {
            for (const l of wrapText(`(${m.ghiChu})`, 46)) pushLine('  ' + l);
        }
    }

    pushLine(LINE);
    const tienGiamKM = Number(hoaDon?.tienGiamKM || 0);
    const tienGiamDiem = Number(hoaDon?.tienGiamDiem || 0);
    const diemSuDung = Number(hoaDon?.diemSuDung || 0);
    const phiPhucVu = Number(hoaDon?.phiPhucVu ?? hoaDon?.tienPhiPhucVu ?? 0);
    const thueVAT = Number(hoaDon?.thueVAT ?? hoaDon?.tienThueVAT ?? hoaDon?.tienVat ?? 0);
    const taxBreakdown = Array.isArray(hoaDon?.taxBreakdown || hoaDon?.tax_breakdown_json)
        ? hoaDon.taxBreakdown || hoaDon.tax_breakdown_json
        : [];
    if (tienGiamKM > 0 || tienGiamDiem > 0 || phiPhucVu > 0 || thueVAT > 0 || taxBreakdown.length > 0) {
        pushLine(padTwoCols('Tam tinh:', dinhDangTien(hoaDon?.tongTamTinh ?? 0)));
        if (tienGiamKM > 0) {
            const labelKm = hoaDon?.maKhuyenMai ? `Giam KM (${hoaDon.maKhuyenMai}):` : 'Giam khuyen mai:';
            pushLine(padTwoCols(labelKm, '-' + dinhDangTien(tienGiamKM)));
        }
        if (tienGiamDiem > 0) {
            pushLine(padTwoCols(`Doi diem (${diemSuDung} diem):`, '-' + dinhDangTien(tienGiamDiem)));
        }
        if (phiPhucVu > 0) {
            const pctSrv = Number(hoaDon?.tyLePhiPhucVu || 0);
            const srvLabel = pctSrv > 0 ? `Phi phuc vu (${pctSrv}%):` : 'Phi phuc vu:';
            pushLine(padTwoCols(srvLabel, '+' + dinhDangTien(phiPhucVu)));
        }
        if (taxBreakdown.length > 0) {
            for (const b of taxBreakdown) {
                const rateLbl = b.isKct ? 'KCT (0%)' : `VAT ${Number(b.vatRate || 0)}%`;
                pushLine(
                    padTwoCols(
                        `  ${rateLbl} (DT ${dinhDangTien(b.taxableBase || 0)}):`,
                        dinhDangTien(b.vatAmount || 0)
                    )
                );
            }
        } else if (thueVAT > 0) {
            const pctVat = Number(hoaDon?.tyLeThueVAT || 0);
            const vatLabel = pctVat > 0 ? `Thue VAT (${pctVat}%):` : 'Thue VAT:';
            pushLine(padTwoCols(vatLabel, '+' + dinhDangTien(thueVAT)));
        }
    }
    const tongCong = hoaDon?.tongTienThanhToan ?? hoaDon?.tongSauGiam ?? hoaDon?.tongTamTinh ?? 0;
    pushBytes(ESC, 0x45, 0x01);
    pushBytes(GS, 0x21, 0x01); // Double height
    pushLine(padTwoCols('TONG CONG:', dinhDangTien(tongCong)));
    pushBytes(GS, 0x21, 0x00);
    pushBytes(ESC, 0x45, 0x00);

    if (hoaDon?.danhSachThanhToan?.length > 0) {
        for (const p of hoaDon.danhSachThanhToan) {
            pushLine(padTwoCols(`  TT (${p.phuongThucTT}):`, dinhDangTien(p.soTien)));
        }
    }

    pushLine(LINE);
    pushBytes(ESC, 0x61, 0x01);
    const maDoiChieu = String(maHD).slice(-4).toUpperCase();
    const gioIn = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    pushBytes(ESC, 0x45, 0x01);
    pushLine(`MA DOI CHIEU: #${maDoiChieu} | GIO IN: ${gioIn}`);
    pushBytes(ESC, 0x45, 0x00);
    pushLine('Quy khach vui long kiem tra DUNG GIO IN & STT');
    const einvoiceCode = String(hoaDon?.einvoiceLookupCode || hoaDon?.einvoice_lookup_code || '').trim();
    if (einvoiceCode && !laTamTinh) {
        const einvoiceUrl = String(
            hoaDon?.einvoiceLookupUrl || `https://einvoice.cafepos.vn/lookup/${einvoiceCode}`
        ).trim();
        pushLine(LINE);
        pushBytes(ESC, 0x45, 0x01);
        pushLine(`XUAT HOA DON VAT (MTT) - MA: ${einvoiceCode}`);
        pushBytes(ESC, 0x45, 0x00);
        pushLine('Quet QR trong ngay de xuat hoa don dien tu:');
        chunks.push(buildEscPosQrCodeBuffer(einvoiceUrl, 4));
        previewLines.push(`[QR E-INVOICE: ${einvoiceCode}]`);
    }
    pushLine('Cam on Quy khach & Hen gap lai!');
    if (showPlgWatermark) {
        const refUrl = String(plgReferralUrl || 'https://cafepos.vn/onboarding').trim();
        pushLine(LINE);
        pushBytes(ESC, 0x45, 0x01);
        pushLine('Phan mem CafePOS - MIEN PHI 350 don/thang');
        pushBytes(ESC, 0x45, 0x00);
        pushLine('Quet QR dung thu 30s cho chu quan:');
        chunks.push(buildEscPosQrCodeBuffer(refUrl, 4));
        previewLines.push(`[QR: ${refUrl}]`);
        pushLine(refUrl.replace(/^https?:\/\//i, '').slice(0, 48));
    }
    pushLine('');
    pushLine('');
    pushLine('');

    if (autoCut) {
        // GS V 66 0 — Cắt giấy tự động (partial cut)
        pushBytes(GS, 0x56, 0x42, 0x00);
    }

    return {
        buffer: Buffer.concat(chunks),
        previewText: previewLines.join('\n'),
        kickDrawer: Boolean(kickDrawer),
    };
}

// Dựng Buffer nhị phân ESC/POS + bản xem trước cho Phiếu Chốt Ca Nhiệt (Z-Report K80)
function buildZReportK80({
    doiSoat,
    ca,
    tenQuan = 'QUAN CA PHE POS',
    diaChi = '',
    nguoiIn = '',
    laBanSao = false,
    failoverHeader = null,
    autoCut = true,
    kickDrawer = false,
}) {
    const chunks = [];
    const previewLines = [];
    const LINE = '-'.repeat(48);
    const DLINE = '='.repeat(48);

    const pushBytes = (...bytes) => chunks.push(Buffer.from(bytes));
    const pushLine = (text = '') => {
        const clean = boDauTiengViet(text);
        previewLines.push(clean);
        chunks.push(Buffer.from(clean + '\n', 'ascii'));
    };

    const fmtSigned = (n) => {
        const v = Math.round(Number(n) || 0);
        if (v > 0) return '+' + dinhDangTien(v);
        if (v < 0) return '-' + dinhDangTien(Math.abs(v));
        return dinhDangTien(0);
    };

    pushBytes(ESC, 0x40);
    if (kickDrawer) chunks.push(buildCashDrawerKickBuffer());

    if (failoverHeader) {
        pushBytes(ESC, 0x61, 0x01);
        pushBytes(ESC, 0x45, 0x01);
        pushLine(failoverHeader);
        pushBytes(ESC, 0x45, 0x00);
    }

    // Header
    pushBytes(ESC, 0x61, 0x01);
    pushBytes(ESC, 0x45, 0x01);
    pushBytes(GS, 0x21, 0x11);
    pushLine(boDauTiengViet(tenQuan).toUpperCase());
    pushBytes(GS, 0x21, 0x00);
    if (diaChi) pushLine(diaChi);
    pushLine('PHIEU CHOT CA (Z-REPORT)');
    if (laBanSao) pushLine('*** BAN SAO - REPRINT ***');
    pushBytes(ESC, 0x45, 0x00);
    pushLine(DLINE);

    // Thông tin ca
    pushBytes(ESC, 0x61, 0x00);
    const ds = doiSoat || ca || {};
    const dt = ds.doanhThu || {};
    const ht = ds.hoanTien || {};
    const moLuc = ds.thoiGianMoCa ? new Date(ds.thoiGianMoCa).toLocaleString('vi-VN') : '-';
    const dongLuc = ds.thoiGianDongCa
        ? new Date(ds.thoiGianDongCa).toLocaleString('vi-VN')
        : new Date().toLocaleString('vi-VN');

    const maZReport =
        ds.maZReport || (ds.soZReport ? `Z-${String(ds.soZReport).padStart(4, '0')}` : null);
    if (maZReport) pushLine(`So Z-Report: ${maZReport}`);
    pushLine(`Ma ca:    #${ds.maCaThuNgan || '-'}`);
    pushLine(`Thu ngan: ${ds.tenNV || '-'}`);
    pushLine(`Mo ca:    ${moLuc}`);
    pushLine(`Dong ca:  ${dongLuc}`);
    pushLine(padTwoCols('So hoa don da thu:', `${Number(dt.soHoaDon || 0)} don`));
    pushLine(LINE);

    // 1. Doanh thu theo PTTT
    const dtTienMat = Number(dt.tienMat || 0);
    const dtChuyenKhoan = Number(dt.chuyenKhoan || 0);
    const dtThe = Number(dt.the || 0);
    const dtVoucher = Number(dt.voucher || 0);
    const dtViKhach = Number(dt.viKhach || 0);
    const dtViDienTu = Number(dt.viDienTu || 0);
    const dtSanGiaoHang = Number(dt.sanGiaoHang || 0);
    const dtTong =
        dt.tong !== undefined && dt.tong !== null
            ? Number(dt.tong)
            : dtTienMat + dtChuyenKhoan + dtThe + dtVoucher + dtViKhach + dtViDienTu + dtSanGiaoHang;

    pushBytes(ESC, 0x45, 0x01);
    pushLine('1. DOANH THU TRONG CA');
    pushBytes(ESC, 0x45, 0x00);
    pushLine(padTwoCols('  Tien mat:', dinhDangTien(dtTienMat)));
    pushLine(padTwoCols('  Chuyen khoan / VietQR:', dinhDangTien(dtChuyenKhoan)));
    if (dtThe > 0) pushLine(padTwoCols('  The ngan hang:', dinhDangTien(dtThe)));
    if (dtVoucher > 0) pushLine(padTwoCols('  Voucher / Khac:', dinhDangTien(dtVoucher)));
    if (dtViKhach > 0) pushLine(padTwoCols('  Vi thanh vien:', dinhDangTien(dtViKhach)));
    if (dtViDienTu > 0) pushLine(padTwoCols('  Vi dien tu:', dinhDangTien(dtViDienTu)));
    if (dtSanGiaoHang > 0) pushLine(padTwoCols('  San giao hang:', dinhDangTien(dtSanGiaoHang)));
    pushBytes(ESC, 0x45, 0x01);
    pushLine(padTwoCols('  TONG DOANH THU:', dinhDangTien(dtTong)));
    pushBytes(ESC, 0x45, 0x00);

    if (Number(ht.tong) > 0) {
        pushLine(padTwoCols('  Hoan tien sau TT (tong):', '-' + dinhDangTien(ht.tong)));
        if (Number(ht.tienMat) > 0) {
            pushLine(padTwoCols('    - Hoan tien mat:', '-' + dinhDangTien(ht.tienMat)));
        }
        const hoanKhac =
            Number(ht.chuyenKhoan || 0) +
            Number(ht.the || 0) +
            Number(ht.voucher || 0) +
            Number(ht.viKhach || 0);
        if (hoanKhac > 0) {
            pushLine(padTwoCols('    - Hoan CK / The / Vi:', '-' + dinhDangTien(hoanKhac)));
        }
    }
    pushLine(LINE);

    // 2. Đối soát két tiền mặt (tách riêng Safe Drop / Rút két & Thối CK dư!)
    pushBytes(ESC, 0x45, 0x01);
    pushLine('2. DOI SOAT KET TIEN MAT');
    pushBytes(ESC, 0x45, 0x00);
    pushLine(padTwoCols('  (+) Tien mat dau ca:', dinhDangTien(ds.tienMatDauCa)));
    pushLine(padTwoCols('  (+) Doanh thu tien mat:', dinhDangTien(dtTienMat)));
    if (Number(ht.tienMat) > 0) {
        pushLine(padTwoCols('  (-) Hoan tien mat sau TT:', '-' + dinhDangTien(ht.tienMat)));
    }
    pushLine(padTwoCols('  (+) Thu lat vat (Pay-In):', dinhDangTien(ds.thuLatVat)));
    pushLine(padTwoCols('  (-) Chi lat vat (Pay-Out):', '-' + dinhDangTien(ds.chiLatVat)));
    pushLine(padTwoCols('  (-) Rut ket an toan (Safe Drop):', '-' + dinhDangTien(ds.rutKet)));
    if (Number(ds.thoiCkDu) > 0) {
        pushLine(padTwoCols('  (-) Thoi CK du (tien mat):', '-' + dinhDangTien(ds.thoiCkDu)));
    }
    pushLine(LINE);

    pushBytes(ESC, 0x45, 0x01);
    pushLine(padTwoCols('QUY LY THUYET TAI KET:', dinhDangTien(ds.tienMatLyThuyet)));
    pushLine(padTwoCols('TIEN MAT THUC DEM:', dinhDangTien(ds.tienMatThucTe)));
    pushBytes(GS, 0x21, 0x01); // Double height
    pushLine(padTwoCols('CHENH LECH:', fmtSigned(ds.chenhLech)));
    pushBytes(GS, 0x21, 0x00);
    pushBytes(ESC, 0x45, 0x00);
    if (Number(ds.tienGiuLaiKet) > 0) {
        pushLine(padTwoCols('  Tien giu lai ket ca sau:', dinhDangTien(ds.tienGiuLaiKet)));
    }
    if (Number(ds.tienNopVeChuQuan) > 0) {
        pushLine(padTwoCols('  Tien nop ve chu quan:', dinhDangTien(ds.tienNopVeChuQuan)));
    }
    if (ds.trangThai) {
        pushLine(`Ket luan: ${ds.trangThai}`);
    }

    // 3. Chi tiết mệnh giá kiểm đếm Blind Drop (nếu có)
    const menhGia = ds.chiTietMenhGia && typeof ds.chiTietMenhGia === 'object' ? ds.chiTietMenhGia : null;
    if (menhGia) {
        const entries = Object.entries(menhGia)
            .map(([k, v]) => [Number(k), Number(v)])
            .filter(([mg, sl]) => mg > 0 && sl > 0)
            .sort((a, b) => b[0] - a[0]);
        if (entries.length > 0) {
            pushLine(LINE);
            pushBytes(ESC, 0x45, 0x01);
            pushLine('3. BANG DEM MENH GIA (BLIND DROP)');
            pushBytes(ESC, 0x45, 0x00);
            for (const [mg, sl] of entries) {
                pushLine(padTwoCols(`  ${dinhDangTien(mg)} x ${sl} to`, dinhDangTien(mg * sl)));
            }
        }
    }

    if (ds.ghiChuChenhLech) {
        pushLine(LINE);
        for (const l of wrapText(`Ghi chu: ${ds.ghiChuChenhLech}`, 48)) pushLine(l);
    }

    pushLine(DLINE);
    pushLine(padTwoCols('  Thu ngan ky', 'Quan ly / Chu quan  '));
    pushLine('');
    pushLine('');
    pushLine('');
    pushBytes(ESC, 0x61, 0x01);
    const gioIn = new Date().toLocaleString('vi-VN');
    pushLine(`In luc: ${gioIn}${nguoiIn ? ' | ' + nguoiIn : ''}`);
    pushLine('');
    pushLine('');

    if (autoCut) {
        pushBytes(GS, 0x56, 0x42, 0x00);
    }

    return {
        buffer: Buffer.concat(chunks),
        previewText: previewLines.join('\n'),
        kickDrawer: Boolean(kickDrawer),
    };
}

module.exports = {
    RASTER_BAND_HEIGHT,
    boDauTiengViet,
    buildCashDrawerKickBuffer,
    buildEscPosQrCodeBuffer,
    encodeBitmapToEscPosGsV0,
    buildRasterReceiptBuffer,
    buildReceiptK80,
    buildZReportK80,
};
