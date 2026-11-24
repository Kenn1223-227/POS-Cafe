const crypto = require('crypto');
const {
    lam3,
    lam4,
    todayDateVN,
    computeSafeWacOnStockIn,
    lockBranchStockOrdered,
    updateBranchStockRow,
    insertLedgerLine,
} = require('./inventoryCogsPhase4Engine');
const { maskPhoneForRole } = require('./vnTaxAndEInvoiceService');
const { loadBranchAvailability86Map } = require('./kdsPhase2Engine');

// =============================================================================
// PHÂN HỆ 8: CHIẾN LƯỢC MỞ RỘNG TỆP KHÁCH HÀNG & HỆ SINH THÁI TÍNH NĂNG
//   - QR Order tại bàn kèm Anti-Spam 3 lớp (/m/:tenantSlug/:tableToken)
//   - CRM Phân hạng (Đồng/Bạc/Vàng/Kim Cương) + Ví trả trước/Cashback + Zalo ZNS
//   - Multi-Branch & Franchise HQ (Tenant -> ChiNhanh -> QuayTerminal, Đẩy giá vùng, Kho tổng & Điều chuyển, Phí nhượng quyền)
//   - Aggregator Hub (GrabFood / ShopeeFood / BeFood)
//   - Đa mô hình F&B ngang (Time-based Billing Bida/Boardgame/Co-working + Lô bánh giảm giá 50% sau 19h)
//   - AI Demand Forecasting (60 ngày theo thứ trong tuần) & Smart Upsell
// =============================================================================

const CRM_TIERS = [
    { code: 'KIM_CUONG', label: 'Kim Cương', minSpend: 15000000, cashbackPct: 6, badgeColor: 'cyan' },
    { code: 'VANG',      label: 'Vàng',      minSpend: 5000000,  cashbackPct: 4, badgeColor: 'amber' },
    { code: 'BAC',       label: 'Bạc',       minSpend: 1500000,  cashbackPct: 2, badgeColor: 'slate' },
    { code: 'DONG',      label: 'Đồng',      minSpend: 0,        cashbackPct: 0, badgeColor: 'orange' },
];

const AGGREGATOR_COMMISSION = {
    GRABFOOD: 0.25,
    SHOPEEFOOD: 0.22,
    BEFOOD: 0.20,
};

const TIME_SERVICE_DEFAULTS = {
    BIDA: { label: 'Bàn Bida', ratePerHour: 65000 },
    BOARDGAME: { label: 'Boardgame Cafe', ratePerHour: 45000 },
    COWORKING: { label: 'Co-working Space', ratePerHour: 50000 },
    PHONG_VIP: { label: 'Phòng họp / VIP', ratePerHour: 120000 },
};

// Rate limiter nhẹ trong RAM cho public QR order chống spam theo IP
const qrRateMap = new Map();
function kiemTraGioiHanQrIp(ip, maxPerMinute = 15) {
    const now = Date.now();
    const key = String(ip || 'unknown');
    const cur = qrRateMap.get(key);
    if (!cur || cur.resetAt <= now) {
        qrRateMap.set(key, { count: 1, resetAt: now + 60 * 1000 });
        return { allowed: true };
    }
    if (cur.count >= maxPerMinute) {
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)) };
    }
    cur.count += 1;
    return { allowed: true };
}
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of qrRateMap) if (v.resetAt <= now) qrRateMap.delete(k);
}, 5 * 60 * 1000).unref();

function taoQrTokenMoi() {
    return crypto.randomBytes(6).toString('hex');
}

function layGioHienTaiVN(nowDate = new Date()) {
    const vnMs = nowDate.getTime() + 7 * 60 * 60 * 1000;
    const vn = new Date(vnMs);
    return {
        hour: vn.getUTCHours(),
        minute: vn.getUTCMinutes(),
        dayOfWeek: vn.getUTCDay(), // 0 = CN, 1 = T2 ... 6 = T7
        dateISO: vn.toISOString().slice(0, 10),
    };
}

function tinhHangThanhVien(tongChiTieu = 0) {
    const spend = Math.max(0, Number(tongChiTieu || 0));
    const current = CRM_TIERS.find((t) => spend >= t.minSpend) || CRM_TIERS[CRM_TIERS.length - 1];
    const idx = CRM_TIERS.findIndex((t) => t.code === current.code);
    const nextTier = idx > 0 ? CRM_TIERS[idx - 1] : null;
    return {
        hang: current.code,
        tenHang: current.label,
        cashbackPct: current.cashbackPct,
        mocTiepTheo: nextTier ? nextTier.minSpend : null,
        tenHangTiepTheo: nextTier ? nextTier.label : null,
        canThemDeLenHang: nextTier ? Math.max(0, nextTier.minSpend - spend) : 0,
    };
}

function tinhGiaLoBanhHienTai({ giaGoc, gioGiamGia = 19, phanTramGiam = 50, nowDate = new Date() }) {
    const base = Math.max(0, Number(giaGoc || 0));
    const hourThreshold = Number.isFinite(Number(gioGiamGia)) ? Number(gioGiamGia) : 19;
    const pct = Math.min(95, Math.max(0, Number(phanTramGiam ?? 50)));
    const { hour } = layGioHienTaiVN(nowDate);
    const dangGiamGia = hour >= hourThreshold && pct > 0;
    const giaSauGiam = dangGiamGia ? Math.round((base * (100 - pct)) / 100 / 500) * 500 : base;
    return {
        dangGiamGia,
        gioHienTaiVN: hour,
        gioGiamGia: hourThreshold,
        phanTramGiam: dangGiamGia ? pct : 0,
        giaGoc: base,
        giaHienTai: giaSauGiam,
        soTienTietKiem: Math.max(0, base - giaSauGiam),
    };
}

function tinhTienPhienGio({
    batDauLuc,
    ketThucLuc = new Date(),
    donGiaTheoGio = 60000,
    khungGioCaoDiem = null,
    soPhutTamDung = 0,
}) {
    const startMs = new Date(batDauLuc).getTime();
    const endMs = new Date(ketThucLuc).getTime();
    const rawMinutes = Math.max(1, Math.ceil((endMs - startMs) / 60000) - Math.max(0, Number(soPhutTamDung || 0)));
    const billableMinutes = Math.max(1, rawMinutes);
    const rate = Math.max(0, Number(donGiaTheoGio || 0));

    const peakCfg = khungGioCaoDiem && typeof khungGioCaoDiem === 'object' ? khungGioCaoDiem : null;
    const peakStart = peakCfg && Number.isFinite(Number(peakCfg.startHour)) ? Number(peakCfg.startHour) : 18;
    const peakEnd = peakCfg && Number.isFinite(Number(peakCfg.endHour)) ? Number(peakCfg.endHour) : 23;
    const peakMult = peakCfg && Number(peakCfg.multiplier) > 1 ? Number(peakCfg.multiplier) : 1;

    let peakMinutes = 0;
    let regularMinutes = billableMinutes;

    if (peakMult > 1) {
        // Tính số phút giao với khung giờ cao điểm theo giờ Việt Nam (UTC+7)
        const stepStart = Math.floor(startMs / 60000);
        const totalSteps = Math.min(billableMinutes, 24 * 60 * 7); // giới hạn tối đa 7 ngày để tránh vòng lặp cực lớn
        peakMinutes = 0;
        for (let i = 0; i < totalSteps; i += 1) {
            const vnHour = new Date((stepStart + i) * 60000 + 7 * 3600000).getUTCHours();
            if (vnHour >= peakStart && vnHour < peakEnd) {
                peakMinutes += 1;
            }
        }
        regularMinutes = Math.max(0, billableMinutes - peakMinutes);
    }

    const regularFee = (regularMinutes / 60) * rate;
    const peakFee = (peakMinutes / 60) * rate * peakMult;
    const tongTienGio = Math.round((regularFee + peakFee) / 1000) * 1000;

    return {
        soPhutSuDung: billableMinutes,
        soPhutThuong: regularMinutes,
        soPhutCaoDiem: peakMinutes,
        heSoCaoDiem: peakMult,
        donGiaTheoGio: rate,
        tongTienGio,
    };
}

function tinhDuBaoNhapKho60Ngay(historyRows = [], currentStocks = [], targetDate = new Date(Date.now() + 86400000)) {
    const vnTarget = layGioHienTaiVN(targetDate);
    const targetDow = vnTarget.dayOfWeek;
    const DOW_LABELS = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

    // Gom dữ liệu tiêu hao 60 ngày theo MaNL
    const byNl = new Map();
    for (const row of historyRows) {
        const maNL = row.manl || row.maNL;
        if (!maNL) continue;
        if (!byNl.has(maNL)) byNl.set(maNL, { allDays: [], sameDow: [], last14: [] });
        const bucket = byNl.get(maNL);
        const qty = Math.max(0, Number(row.tongtieuhao ?? row.tongTieuHao ?? 0));
        const dow = Number(row.thutrongtuan ?? row.thuTrongTuan ?? -1);
        const isRecent14 = Boolean(row.trong14ngay ?? row.trong14Ngay);
        bucket.allDays.push(qty);
        if (dow === targetDow) bucket.sameDow.push(qty);
        if (isRecent14) bucket.last14.push(qty);
    }

    const avg = (arr) => (arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

    const recommendations = currentStocks.map((st) => {
        const maNL = st.manl || st.maNL;
        const tenNL = st.tennl || st.tenNL;
        const donViTinh = st.donvitinh || st.donViTinh || '';
        const tonHienTai = Number(st.soluongton ?? st.soLuongTon ?? 0);
        const hanMuc = Number(st.hanmuccanhbao ?? st.hanMucCanhBao ?? 0);
        const giaVon = Number(st.giavondonvi ?? st.giaVonDonVi ?? 0);
        const h = byNl.get(maNL);

        const avgAll = h ? avg(h.allDays) : 0;
        const avgDow = h && h.sameDow.length > 0 ? avg(h.sameDow) : avgAll;
        const avg14 = h && h.last14.length > 0 ? avg(h.last14) : avgAll;

        // Mô hình kết hợp: 55% trung bình cùng Thứ trong tuần + 30% xu hướng 14 ngày gần nhất + 15% nền 60 ngày
        const duBaoCoSo = avgAll > 0 ? 0.55 * avgDow + 0.30 * avg14 + 0.15 * avgAll : 0;
        const heSoThu = avgAll > 0 ? Math.round((avgDow / avgAll) * 100) / 100 : 1;
        // Dự phòng an toàn 20% + bù ngưỡng cảnh báo
        const nhuCauNgayMai = Math.round(duBaoCoSo * 1.2 * 100) / 100;
        const mucTonMucTieu = Math.max(nhuCauNgayMai + hanMuc * 0.5, hanMuc);
        const goiYNhap = Math.max(0, Math.ceil(mucTonMucTieu - tonHienTai));
        const soNgayConLai = duBaoCoSo > 0 ? Math.round((tonHienTai / duBaoCoSo) * 10) / 10 : null;
        const mucDoKhanCap =
            tonHienTai <= hanMuc || (soNgayConLai !== null && soNgayConLai < 1.2)
                ? 'HIGH'
                : goiYNhap > 0
                ? 'MEDIUM'
                : 'OK';

        return {
            maNL,
            tenNL,
            donViTinh,
            tonHienTai: Math.round(tonHienTai * 100) / 100,
            hanMucCanhBao: hanMuc,
            trungBinh60Ngay: Math.round(avgAll * 100) / 100,
            trungBinhCungThu: Math.round(avgDow * 100) / 100,
            heSoThu,
            duBaoNgayMai: nhuCauNgayMai,
            goiYNhapSangMai: goiYNhap,
            chiPhiDuKien: Math.round(goiYNhap * giaVon),
            soNgayConLai,
            mucDoKhanCap,
            doTinCay: h ? Math.min(96, 55 + h.allDays.length * 1.2) : 40,
        };
    });

    recommendations.sort((a, b) => {
        const rank = { HIGH: 0, MEDIUM: 1, OK: 2 };
        if (rank[a.mucDoKhanCap] !== rank[b.mucDoKhanCap]) return rank[a.mucDoKhanCap] - rank[b.mucDoKhanCap];
        return b.chiPhiDuKien - a.chiPhiDuKien;
    });

    return {
        ngayDuBao: vnTarget.dateISO,
        thuNgayMai: DOW_LABELS[targetDow],
        tongChiPhiNhapDuKien: recommendations.reduce((s, r) => s + r.chiPhiDuKien, 0),
        soNguyenLieuCanNhap: recommendations.filter((r) => r.goiYNhapSangMai > 0).length,
        danhSach: recommendations,
    };
}

function goiYBanKemSmartUpsell({ cartMaMonList = [], coOccurrenceRows = [], menuItems = [], bakeryMarkdownMap = new Map() }) {
    const inCart = new Set(cartMaMonList.map((m) => String(m)));
    const menuMap = new Map(menuItems.map((m) => [m.maMon, m]));
    const scores = new Map();

    // 1. Điểm từ lịch sử mua cùng hóa đơn 60 ngày (Market-Basket Association)
    for (const row of coOccurrenceRows) {
        const maMon = row.mamon || row.maMon;
        if (!maMon || inCart.has(maMon) || !menuMap.has(maMon)) continue;
        const freq = Number(row.solancungmua ?? row.soLanCungMua ?? 1);
        scores.set(maMon, {
            score: 100 + freq * 15,
            reason: `Khách thường mua kèm (${freq} lượt)`,
        });
    }

    // 2. Ưu tiên đẩy Lô bánh giảm giá sau 19h (giải phóng tồn bánh trong ngày)
    for (const [maMon, md] of bakeryMarkdownMap.entries()) {
        if (inCart.has(maMon) || !menuMap.has(maMon)) continue;
        if (md.dangGiamGia && Number(md.soLuongConLai || 0) > 0) {
            const prev = scores.get(maMon);
            scores.set(maMon, {
                score: (prev?.score || 0) + 180,
                reason: `🔥 Giảm ${md.phanTramGiam}% sau ${md.gioGiamGia}h (còn ${md.soLuongConLai})`,
            });
        }
    }

    // 3. Nếu giỏ có đồ uống nhưng chưa có bánh/snack, gợi ý món bánh/topping bán kèm biên lãi cao
    const hasBakeryInCart = [...inCart].some((id) => {
        const item = menuMap.get(id);
        return item && /bánh|bakery|croissant|tiramisu|cake|snack|ăn vặt/i.test(`${item.nhomMon} ${item.tenMon}`);
    });
    for (const item of menuItems) {
        if (inCart.has(item.maMon) || item.tamHet) continue;
        const isBakery = /bánh|bakery|croissant|tiramisu|cake|snack|ăn vặt/i.test(`${item.nhomMon} ${item.tenMon}`);
        if (!hasBakeryInCart && isBakery) {
            const prev = scores.get(item.maMon);
            scores.set(item.maMon, {
                score: (prev?.score || 0) + 90,
                reason: prev?.reason || 'Combo đồ uống + bánh ngọt siêu hợp',
            });
        } else if (!scores.has(item.maMon)) {
            scores.set(item.maMon, {
                score: 20,
                reason: 'Món bán chạy gợi ý thêm',
            });
        }
    }

    return [...scores.entries()]
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, 4)
        .map(([maMon, meta]) => {
            const item = menuMap.get(maMon);
            const md = bakeryMarkdownMap.get(maMon);
            const defaultSize = item.sizes.find((s) => s.kichThuoc === 'M') || item.sizes[0];
            const basePrice = Number(defaultSize?.giaBan || 0);
            const effectivePrice = md && md.dangGiamGia ? md.giaHienTai : basePrice;
            const kLabel = Math.round(effectivePrice / 1000);
            return {
                maMon: item.maMon,
                tenMon: item.tenMon,
                nhomMon: item.nhomMon,
                kichThuoc: defaultSize?.kichThuoc || 'M',
                giaGoc: basePrice,
                giaGoiY: effectivePrice,
                dangGiamGiaBanh: Boolean(md?.dangGiamGia),
                phanTramGiam: md?.dangGiamGia ? md.phanTramGiam : 0,
                badgeText: `+${item.tenMon} chỉ ${kLabel}k`,
                lyDo: meta.reason,
            };
        });
}

function xayDungVietQrUrl(bankCfg, amount, addInfo) {
    const bankId = bankCfg?.bankId || 'MB';
    const accountNo = bankCfg?.accountNo || '';
    const accountName = bankCfg?.accountName || '';
    if (!accountNo) return null;
    const amt = Math.max(0, Math.round(Number(amount || 0)));
    return `https://img.vietqr.io/image/${encodeURIComponent(bankId)}-${encodeURIComponent(accountNo)}-compact2.png?amount=${amt}&addInfo=${encodeURIComponent(addInfo || '')}&accountName=${encodeURIComponent(accountName)}`;
}

// Hook chạy trong transaction thanh toán (an toàn với SAVEPOINT nếu DB chưa chạy migration 019)
async function xoayQrTokenChoCacBan(client, banDaTrong = []) {
    if (!Array.isArray(banDaTrong) || banDaTrong.length === 0) return [];
    const rotated = [];
    await client.query('SAVEPOINT sp_rotate_qr_tokens');
    try {
        for (const maBan of banDaTrong) {
            const newToken = taoQrTokenMoi();
            await client.query(
                'UPDATE Ban SET QrToken = $1, QrTokenRotatedAt = now() WHERE MaBan = $2',
                [newToken, maBan]
            );
            rotated.push({ maBan, qrToken: newToken });
        }
        await client.query('RELEASE SAVEPOINT sp_rotate_qr_tokens');
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_rotate_qr_tokens').catch(() => {});
    }
    return rotated;
}

async function capNhatCrmVaZnsSauThanhToan(client, { tenantId, maKH, maHoaDon, tongTien, diemCong = 0 }) {
    if (!maKH || !(Number(tongTien) > 0)) return null;
    await client.query('SAVEPOINT sp_crm_tier_zns');
    try {
        const khRes = await client.query(
            `SELECT MaKH, TenKH, SoDienThoai, COALESCE(TongChiTieu, 0) AS TongChiTieu,
                    COALESCE(HangThanhVien, 'DONG') AS HangThanhVien,
                    COALESCE(SoDuVi, 0) AS SoDuVi,
                    COALESCE(ZaloOptIn, TRUE) AS ZaloOptIn
               FROM KhachHang
              WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
              FOR UPDATE`,
            [maKH, tenantId]
        );
        if (khRes.rows.length === 0) {
            await client.query('RELEASE SAVEPOINT sp_crm_tier_zns');
            return null;
        }
        const kh = khRes.rows[0];
        const hangCu = kh.hangthanhvien || 'DONG';
        const tongChiTieuMoi = Math.round((Number(kh.tongchitieu || 0) + Number(tongTien)) * 100) / 100;
        const tierInfo = tinhHangThanhVien(tongChiTieuMoi);
        const cashback = tierInfo.cashbackPct > 0
            ? Math.round((Number(tongTien) * tierInfo.cashbackPct) / 100)
            : 0;
        const soDuViMoi = Math.round((Number(kh.soduvi || 0) + cashback) * 100) / 100;

        await client.query(
            `UPDATE KhachHang
                SET TongChiTieu = $2,
                    HangThanhVien = $3,
                    SoDuVi = $4,
                    LanMuaCuoi = now()
              WHERE MaKH = $1`,
            [maKH, tongChiTieuMoi, tierInfo.hang, soDuViMoi]
        );

        if (cashback > 0) {
            await client.query(
                `INSERT INTO KhachHang_GiaoDichVi (TenantId, MaKH, LoaiGD, SoTien, SoDuSau, MaHoaDon, GhiChu)
                 VALUES ($1, $2, 'CASHBACK', $3, $4, $5, $6)`,
                [tenantId, maKH, cashback, soDuViMoi, String(maHoaDon), `Hoàn tiền ${tierInfo.cashbackPct}% hạng ${tierInfo.tenHang}`]
            );
        }

        if (kh.zalooptin && kh.sodienthoai) {
            await client.query(
                `INSERT INTO Zalo_ZNS_Outbox (TenantId, MaKH, SoDienThoai, LoaiTin, NoiDung, TrangThai)
                 VALUES ($1, $2, $3, 'POST_PURCHASE', $4::jsonb, 'QUEUED')`,
                [
                    tenantId,
                    maKH,
                    kh.sodienthoai,
                    JSON.stringify({
                        tenKH: kh.tenkh,
                        maHoaDon: String(maHoaDon),
                        tongTien: Number(tongTien),
                        diemCong,
                        cashback,
                        hangThanhVien: tierInfo.tenHang,
                        soDuVi: soDuViMoi,
                        tinNhan: `Cảm ơn ${kh.tenkh} đã thanh toán ${Number(tongTien).toLocaleString('vi-VN')}đ (HĐ #${maHoaDon}). Bạn nhận +${diemCong} điểm${cashback > 0 ? ` & +${cashback.toLocaleString('vi-VN')}đ hoàn ví` : ''}. Hạng hiện tại: ${tierInfo.tenHang}!`,
                    }),
                ]
            );

            if (tierInfo.hang !== hangCu) {
                await client.query(
                    `INSERT INTO Zalo_ZNS_Outbox (TenantId, MaKH, SoDienThoai, LoaiTin, NoiDung, TrangThai)
                     VALUES ($1, $2, $3, 'TIER_UPGRADE', $4::jsonb, 'QUEUED')`,
                    [
                        tenantId,
                        maKH,
                        kh.sodienthoai,
                        JSON.stringify({
                            tenKH: kh.tenkh,
                            hangCu,
                            hangMoi: tierInfo.hang,
                            tenHangMoi: tierInfo.tenHang,
                            cashbackPct: tierInfo.cashbackPct,
                            tinNhan: `🎉 Chúc mừng ${kh.tenkh} thăng hạng thành viên ${tierInfo.tenHang}! Từ nay bạn được hoàn ${tierInfo.cashbackPct}% vào ví thành viên cho mọi đơn hàng.`,
                        }),
                    ]
                );
            }
        }

        await client.query('RELEASE SAVEPOINT sp_crm_tier_zns');
        return {
            hangCu,
            hangMoi: tierInfo.hang,
            tenHangMoi: tierInfo.tenHang,
            thangHang: tierInfo.hang !== hangCu,
            cashback,
            soDuViMoi,
            tongChiTieuMoi,
        };
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_crm_tier_zns').catch(() => {});
        return null;
    }
}

async function layBanDoGiamGiaLoBanhHomNay(client, tenantId) {
    const map = new Map();
    await client.query('SAVEPOINT sp_bakery_today');
    try {
        const { dateISO } = layGioHienTaiVN();
        const r = await client.query(
            `SELECT MaLo, MaMon, TenMon, SoLuongSanXuat, SoLuongConLai, GioGiamGia, PhanTramGiam, GiaGoc, TrangThai
               FROM LoBanhNgay
              WHERE TenantId = $1
                AND NgaySanXuat = $2::date
                AND TrangThai IN ('ACTIVE', 'MARKDOWN')
                AND SoLuongConLai > 0`,
            [tenantId, dateISO]
        );
        for (const row of r.rows) {
            const calc = tinhGiaLoBanhHienTai({
                giaGoc: Number(row.giagoc || 0),
                gioGiamGia: Number(row.giogiamgia ?? 19),
                phanTramGiam: Number(row.phantramgiam ?? 50),
            });
            map.set(row.mamon, {
                maLo: row.malo,
                maMon: row.mamon,
                tenMon: row.tenmon,
                soLuongConLai: Number(row.soluongconlai || 0),
                ...calc,
            });
        }
        await client.query('RELEASE SAVEPOINT sp_bakery_today');
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_bakery_today').catch(() => {});
    }
    return map;
}

function registerEcosystemPhase8Routes(
    app,
    {
        pool,
        chayGiaoDich,
        qTenant,
        layTenantId,
        kiemTraToken,
        choPhepVaiTro,
        ghiAuditLog,
        guiLoi,
        LoiNghiepVu,
        io,
        roomTen,
        taoDonHangTrongGiaoDich,
    }
) {
    // =========================================================================
    // A. QR ORDER TẠI BÀN + CHỐNG PHÁ HOẠI 3 LỚP (/m/:tenantSlug/:tableToken)
    // =========================================================================

    // Helper tải menu + topping + smart upsell cho một tenant (dùng trong public QR menu)
    async function taiThucDonChoQr(client, tenantId, branchId = null) {
        let khuVucGia = 'DEFAULT';
        if (branchId) {
            await client.query('SAVEPOINT sp_qr_branch_zone');
            try {
                const br = await client.query(
                    'SELECT KhuVucGia FROM ChiNhanh WHERE BranchId = $1 AND TenantId = $2 LIMIT 1',
                    [branchId, tenantId]
                );
                khuVucGia = br.rows[0]?.khuvucgia || 'DEFAULT';
                await client.query('RELEASE SAVEPOINT sp_qr_branch_zone');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_qr_branch_zone').catch(() => {});
            }
        }

        const [spRes, tpRes, zoneRes, bakeryMap, branch86, modData] = await Promise.all([
            client.query(
                `SELECT sp.MaMon, sp.TenMon, sp.NhomMon, COALESCE(sp.TamHet, FALSE) AS TamHet,
                        sz.KichThuoc, sz.GiaBan
                   FROM SanPham sp
                   JOIN SanPham_Size sz ON sp.MaMon = sz.MaMon
                  WHERE sp.DangKinhDoanh = TRUE AND COALESCE(sp.TenantId, 'DEFAULT') = $1
                  ORDER BY sp.NhomMon, sp.TenMon, sz.GiaBan`,
                [tenantId]
            ),
            client.query(
                `SELECT MaTopping, TenTopping, GiaTopping, COALESCE(TamHet, FALSE) AS TamHet
                   FROM Topping
                  WHERE DangKinhDoanh = TRUE AND COALESCE(TenantId, 'DEFAULT') = $1
                  ORDER BY TenTopping`,
                [tenantId]
            ),
            (async () => {
                if (khuVucGia === 'DEFAULT') return { rows: [] };
                await client.query('SAVEPOINT sp_qr_zone_prices');
                try {
                    const r = await client.query(
                        'SELECT MaMon, KichThuoc, GiaBan FROM SanPham_GiaVung WHERE TenantId = $1 AND KhuVucGia = $2',
                        [tenantId, khuVucGia]
                    );
                    await client.query('RELEASE SAVEPOINT sp_qr_zone_prices');
                    return r;
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_qr_zone_prices').catch(() => {});
                    return { rows: [] };
                }
            })(),
            layBanDoGiamGiaLoBanhHomNay(client, tenantId),
            loadBranchAvailability86Map(client, tenantId, branchId || 'DEFAULT'),
            (async () => {
                await client.query('SAVEPOINT sp_qr_modifiers');
                try {
                    const [linkRes, grpRes, optRes] = await Promise.all([
                        client.query(
                            `SELECT mamon, groupid, thutuhienthi
                               FROM public.sanpham_modifier_groups
                              WHERE tenantid = $1
                              ORDER BY thutuhienthi ASC, groupid ASC`,
                            [tenantId]
                        ),
                        client.query(
                            `SELECT id, tengroup, loai, batbuoc, chontoithieu, chontoida, soluongmienphi, thutuhienthi
                               FROM public.modifier_groups
                              WHERE tenantid = $1 AND danghoatdong = TRUE
                              ORDER BY thutuhienthi ASC, id ASC`,
                            [tenantId]
                        ),
                        client.query(
                            `SELECT id, groupid, tenoption, teninngan, lamacdinh, giacongthem, toidasoluong, tamhet, thutuhienthi
                               FROM public.modifier_options
                              WHERE tenantid = $1
                              ORDER BY thutuhienthi ASC, id ASC`,
                            [tenantId]
                        ),
                    ]);
                    await client.query('RELEASE SAVEPOINT sp_qr_modifiers');
                    return { links: linkRes.rows, groups: grpRes.rows, options: optRes.rows };
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_qr_modifiers').catch(() => {});
                    return { links: [], groups: [], options: [] };
                }
            })(),
        ]);

        // Dựng bản đồ modifierGroups theo MaMon (kết hợp 86 chi nhánh từ branch_availability_86)
        const optsByGroup = new Map();
        for (const o of modData.options || []) {
            const bMod = branch86?.modifiers?.get(String(o.id));
            const list = optsByGroup.get(Number(o.groupid)) || [];
            list.push({
                id: Number(o.id),
                tenOption: o.tenoption,
                tenInNgan: o.teninngan || o.tenoption,
                laMacDinh: Boolean(o.lamacdinh),
                giaThem: Number(o.giacongthem || 0),
                toiDaSoLuong: Math.max(1, Number(o.toidasoluong || 1)),
                tamHet: bMod !== undefined ? Boolean(bMod.isSoldOut) : Boolean(o.tamhet),
            });
            optsByGroup.set(Number(o.groupid), list);
        }
        const groupById = new Map();
        for (const g of modData.groups || []) {
            groupById.set(Number(g.id), {
                id: Number(g.id),
                tenGroup: g.tengroup,
                loai: g.loai || 'SINGLE',
                batBuoc: Boolean(g.batbuoc),
                chonToiThieu: Number(g.chontoithieu || 0),
                chonToiDa: Math.max(1, Number(g.chontoida || 1)),
                soLuongMienPhi: Number(g.soluongmienphi || 0),
                options: optsByGroup.get(Number(g.id)) || [],
            });
        }
        const groupsByMaMon = new Map();
        for (const lk of modData.links || []) {
            const grp = groupById.get(Number(lk.groupid));
            if (!grp) continue;
            const list = groupsByMaMon.get(String(lk.mamon)) || [];
            list.push(grp);
            groupsByMaMon.set(String(lk.mamon), list);
        }

        const zonePriceMap = new Map(zoneRes.rows.map((r) => [`${r.mamon}|${r.kichthuoc}`, Number(r.giaban)]));
        const menuMap = new Map();
        const menu = [];
        for (const row of spRes.rows) {
            if (!menuMap.has(row.mamon)) {
                const md = bakeryMap.get(row.mamon);
                const bProd = branch86?.products?.get(String(row.mamon));
                const item = {
                    maMon: row.mamon,
                    tenMon: row.tenmon,
                    nhomMon: row.nhommon,
                    tamHet: bProd !== undefined ? Boolean(bProd.isSoldOut) : Boolean(row.tamhet),
                    bakeryMarkdown: md?.dangGiamGia
                        ? {
                              phanTramGiam: md.phanTramGiam,
                              gioGiamGia: md.gioGiamGia,
                              soLuongConLai: md.soLuongConLai,
                              giaSauGiam: md.giaHienTai,
                          }
                        : null,
                    modifierGroups: groupsByMaMon.get(String(row.mamon)) || [],
                    sizes: [],
                };
                menuMap.set(row.mamon, item);
                menu.push(item);
            }
            const baseGia = zonePriceMap.get(`${row.mamon}|${row.kichthuoc}`) ?? parseFloat(row.giaban);
            const md = bakeryMap.get(row.mamon);
            const finalGia = md?.dangGiamGia
                ? Math.round((baseGia * (100 - md.phanTramGiam)) / 100 / 500) * 500
                : baseGia;
            menuMap.get(row.mamon).sizes.push({
                kichThuoc: row.kichthuoc,
                giaGoc: baseGia,
                giaBan: finalGia,
            });
        }

        const toppings = tpRes.rows.map((t) => {
            const bTp = branch86?.toppings?.get(String(t.matopping));
            return {
                maTopping: t.matopping,
                tenTopping: t.tentopping,
                giaTopping: parseFloat(t.giatopping),
                tamHet: bTp !== undefined ? Boolean(bTp.isSoldOut) : Boolean(t.tamhet),
            };
        });

        const upsells = goiYBanKemSmartUpsell({
            cartMaMonList: [],
            coOccurrenceRows: [],
            menuItems: menu,
            bakeryMarkdownMap: bakeryMap,
        });

        return { menu, toppings, upsells, khuVucGia };
    }

    // 1. Public GET /api/public/qr-menu/:tenantSlug/:tableToken
    app.get('/api/public/qr-menu/:tenantSlug/:tableToken', async (req, res) => {
        const tenantSlug = String(req.params.tenantSlug || '').trim();
        const tableToken = String(req.params.tableToken || '').trim();
        if (!tenantSlug || !tableToken) {
            return res.status(400).json({ message: 'Thiếu đường dẫn quán hoặc mã bàn QR!' });
        }
        try {
            const resolved = await pool.query(
                'SELECT * FROM public.fn_resolve_qr_table($1, $2)',
                [tenantSlug, tableToken]
            );
            if (resolved.rows.length === 0) {
                return res.status(404).json({ code: 'TENANT_NOT_FOUND', message: 'Không tìm thấy quán cafe tương ứng với mã QR này!' });
            }
            const info = resolved.rows[0];
            if (!info.tokenhople) {
                return res.status(410).json({
                    code: 'QR_TOKEN_ROTATED',
                    tenQuan: info.tenquan,
                    message: 'Mã QR bàn đã tự động xoay mới sau lượt khách trước để chống đặt đơn phá hoại. Vui lòng quét lại mã QR mới nhất hoặc báo thu ngân!',
                });
            }

            const data = await pool.withTenant(info.tenantid, (client) =>
                taiThucDonChoQr(client, info.tenantid, info.branchid)
            );

            const tableIsOpen = Number(info.trangthaiban) === 2;
            const requirePrepayVietQr = Boolean(info.qrbatbuocvietqr) || (!tableIsOpen && Boolean(info.qrbatbuocvietqr));

            res.json({
                tenant: {
                    tenantId: info.tenantid,
                    tenQuan: info.tenquan,
                    slug: info.slug,
                    hasVietQr: Boolean(info.thongtinnganhang?.accountNo),
                },
                table: {
                    maBan: info.maban,
                    tenBan: info.tenban,
                    khuVuc: info.khuvuc,
                    trangThai: Number(info.trangthaiban),
                    daMoBan: tableIsOpen,
                    branchId: info.branchid,
                },
                antiSpamPolicy: {
                    layer1_yeuCauMoBanHoacDuyetPos: Boolean(info.qryeucaumoban),
                    layer2_tokenDongTuXoay: true,
                    layer3_batBuocVietQrTruoc: requirePrepayVietQr,
                    canOrderImmediately: tableIsOpen || !info.qryeucaumoban || true, // luôn gửi vào hàng chờ duyệt POS 1 chạm
                    notice: tableIsOpen
                        ? 'Bàn đã được mở! Đơn của bạn sẽ chuyển tới thu ngân duyệt 1 chạm xuống quầy Bar.'
                        : requirePrepayVietQr
                        ? 'Bàn chưa mở — hệ thống yêu cầu quét VietQR thanh toán trước để xác thực đơn chống phá hoại.'
                        : 'Bàn chưa mở — đơn sẽ nằm trong hàng đợi để thu ngân xác nhận 1 chạm trước khi pha chế.',
                },
                ...data,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Public QR Menu:');
        }
    });

    // 2. Public POST /api/public/qr-order/:tenantSlug/:tableToken (Anti-Spam 3 lớp)
    app.post('/api/public/qr-order/:tenantSlug/:tableToken', async (req, res) => {
        const rate = kiemTraGioiHanQrIp(req.ip, 15);
        if (!rate.allowed) {
            return res.status(429).json({
                message: `Bạn gửi quá nhiều yêu cầu đặt món. Vui lòng thử lại sau ${rate.retryAfterSec} giây.`,
            });
        }

        const tenantSlug = String(req.params.tenantSlug || '').trim();
        const tableToken = String(req.params.tableToken || '').trim();
        const { danhSachMon, tenKhach = '', soDienThoai = '', ghiChu = '' } = req.body || {};

        if (!Array.isArray(danhSachMon) || danhSachMon.length === 0) {
            return res.status(400).json({ message: 'Vui lòng chọn ít nhất 1 món trước khi gửi đơn!' });
        }
        if (danhSachMon.length > 30) {
            return res.status(400).json({ message: 'Đơn QR tối đa 30 dòng món mỗi lượt để chống spam!' });
        }

        try {
            const resolved = await pool.query(
                'SELECT * FROM public.fn_resolve_qr_table($1, $2)',
                [tenantSlug, tableToken]
            );
            if (resolved.rows.length === 0) {
                return res.status(404).json({ message: 'Không tìm thấy quán tương ứng!' });
            }
            const info = resolved.rows[0];
            if (!info.tokenhople) {
                return res.status(410).json({
                    code: 'QR_TOKEN_ROTATED',
                    message: 'Mã QR bàn đã hết hiệu lực (tự động xoay sau khi thanh toán). Vui lòng quét mã QR mới!',
                });
            }

            const tenantId = info.tenantid;
            const tableIsOpen = Number(info.trangthaiban) === 2;
            const requirePrepay = Boolean(info.qrbatbuocvietqr) && !tableIsOpen;

            const ketQua = await chayGiaoDich(async (client) => {
                // Kiểm tra chống trùng spam cùng bàn quá 5 đơn chờ duyệt
                const pendingCnt = await client.query(
                    `SELECT COUNT(*) AS cnt FROM DonQrChoDuyet
                      WHERE TenantId = $1 AND MaBan = $2 AND TrangThai IN ('PENDING_APPROVAL', 'AWAITING_PAYMENT')`,
                    [tenantId, info.maban]
                );
                if (Number(pendingCnt.rows[0]?.cnt || 0) >= 5) {
                    throw new LoiNghiepVu(429, 'Bàn này đang có nhiều đơn chờ thu ngân duyệt. Vui lòng đợi nhân viên xác nhận!');
                }

                // Tải giá hiện hành (kèm giảm giá lô bánh sau 19h) để tính tổng chuẩn server-side
                const { menu, toppings } = await taiThucDonChoQr(client, tenantId, info.branchid);
                const menuMap = new Map(menu.map((m) => [m.maMon, m]));
                const tpMap = new Map(toppings.map((t) => [t.maTopping, t]));

                let tongTienTamTinh = 0;
                const cleanItems = [];
                for (const raw of danhSachMon) {
                    const item = menuMap.get(String(raw.maMon || ''));
                    if (!item || item.tamHet) {
                        throw new LoiNghiepVu(400, `Món ${raw.maMon} không tồn tại hoặc đã tạm hết!`);
                    }
                    const kichThuoc = String(raw.kichThuoc || 'M').toUpperCase();
                    const sz = item.sizes.find((s) => s.kichThuoc === kichThuoc) || item.sizes[0];
                    const soLuong = Math.min(20, Math.max(1, parseInt(raw.soLuong, 10) || 1));

                    const cleanToppings = [];
                    let tpPerCup = 0;
                    for (const t of Array.isArray(raw.toppings) ? raw.toppings : []) {
                        const tp = tpMap.get(String(t.maTopping || ''));
                        if (!tp || tp.tamHet) continue;
                        const slTp = Math.min(5, Math.max(1, parseInt(t.soLuong, 10) || 1));
                        tpPerCup += tp.giaTopping * slTp;
                        cleanToppings.push({
                            maTopping: tp.maTopping,
                            tenTopping: tp.tenTopping,
                            giaTopping: tp.giaTopping,
                            soLuong: slTp,
                        });
                    }

                    // Tính phụ thu Modifiers (Wave 4A — P2-03)
                    const cleanModifiers = [];
                    let giaModifiers = 0;
                    const optLookup = new Map();
                    for (const grp of item.modifierGroups || []) {
                        for (const opt of grp.options || []) {
                            optLookup.set(Number(opt.id), { ...opt, groupId: grp.id, tenGroup: grp.tenGroup });
                        }
                    }
                    for (const m of Array.isArray(raw.modifiers) ? raw.modifiers : []) {
                        const optId = Number(m.optionId ?? m.id);
                        const opt = optLookup.get(optId);
                        if (!opt || opt.tamHet) continue;
                        const qty = Math.min(opt.toiDaSoLuong || 1, Math.max(1, parseInt(m.qty ?? m.soLuong, 10) || 1));
                        const lineFee = Number(opt.giaThem || 0) * qty;
                        giaModifiers += lineFee;
                        cleanModifiers.push({
                            groupId: opt.groupId,
                            tenGroup: opt.tenGroup,
                            optionId: opt.id,
                            tenOption: opt.tenOption,
                            giaThem: Number(opt.giaThem || 0),
                            qty,
                        });
                    }

                    const thanhTien = (sz.giaBan + tpPerCup + giaModifiers) * soLuong;
                    tongTienTamTinh += thanhTien;
                    cleanItems.push({
                        maMon: item.maMon,
                        tenMon: item.tenMon,
                        kichThuoc: sz.kichThuoc,
                        soLuong,
                        donGia: sz.giaBan,
                        giaModifiers,
                        ghiChu: raw.ghiChu ? String(raw.ghiChu).trim().slice(0, 150) : null,
                        toppings: cleanToppings,
                        modifiers: cleanModifiers,
                        thanhTien,
                    });
                }

                const maDonQr = `QR${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
                const trangThai = requirePrepay ? 'AWAITING_PAYMENT' : 'PENDING_APPROVAL';

                await client.query(
                    `INSERT INTO DonQrChoDuyet
                        (MaDonQr, TenantId, BranchId, MaBan, TenBan, QrTokenSnapshot, TrangThai,
                         BatBuocThanhToanTruoc, DaThanhToanTruoc, TongTienTamTinh,
                         SoDienThoaiKhach, TenKhach, GhiChuChung, DanhSachMon, IpKhach)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, $9, $10, $11, $12, $13::jsonb, $14)`,
                    [
                        maDonQr,
                        tenantId,
                        info.branchid || null,
                        info.maban,
                        info.tenban,
                        tableToken,
                        trangThai,
                        requirePrepay,
                        tongTienTamTinh,
                        String(soDienThoai || '').trim().slice(0, 32) || null,
                        String(tenKhach || '').trim().slice(0, 100) || null,
                        String(ghiChu || '').trim().slice(0, 255) || null,
                        JSON.stringify(cleanItems),
                        String(req.ip || '').slice(0, 64),
                    ]
                );

                return {
                    maDonQr,
                    trangThai,
                    batBuocThanhToanTruoc: requirePrepay,
                    tongTienTamTinh,
                    danhSachMon: cleanItems,
                    tenBan: info.tenban,
                    maBan: info.maban,
                    vietQrUrl: requirePrepay
                        ? xayDungVietQrUrl(info.thongtinnganhang, tongTienTamTinh, `QRORDER ${maDonQr}`)
                        : null,
                    noiDungCK: requirePrepay ? `QRORDER ${maDonQr}` : null,
                };
            }, tenantId);

            // Bắn thông báo real-time tới POS Thu ngân & Phục vụ để bấm "Duyệt đơn QR" 1 chạm
            io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('QR_ORDER_MOI', {
                maDonQr: ketQua.maDonQr,
                maBan: ketQua.maBan,
                tenBan: ketQua.tenBan,
                trangThai: ketQua.trangThai,
                tongTienTamTinh: ketQua.tongTienTamTinh,
                soMon: ketQua.danhSachMon.reduce((s, i) => s + i.soLuong, 0),
                thoiGianTao: new Date().toISOString(),
            });

            res.status(201).json({
                message: ketQua.batBuocThanhToanTruoc
                    ? 'Đã tạo đơn QR! Vui lòng quét mã VietQR bên dưới để xác nhận thanh toán trước.'
                    : '🎉 Đã gửi đơn thành công! Thu ngân sẽ xác nhận 1 chạm và chuyển quầy pha chế ngay.',
                order: ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Gửi đơn QR tại bàn:');
        }
    });

    // 3. POS lấy danh sách đơn QR chờ duyệt
    app.get('/api/qr-orders', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const status = String(req.query.trangThai || '').trim().toUpperCase();
        try {
            const params = [tenantId];
            let where = 'TenantId = $1';
            if (status && ['PENDING_APPROVAL', 'AWAITING_PAYMENT', 'APPROVED', 'REJECTED'].includes(status)) {
                params.push(status);
                where += ` AND TrangThai = $${params.length}`;
            }
            const r = await qTenant(
                req,
                `SELECT MaDonQr, BranchId, MaBan, TenBan, TrangThai, BatBuocThanhToanTruoc, DaThanhToanTruoc,
                        TongTienTamTinh, SoDienThoaiKhach, TenKhach, GhiChuChung, DanhSachMon,
                        MaHoaDonDaTao, NguoiDuyet, LyDoTuChoi, ThoiGianTao, ThoiGianXuLy
                   FROM DonQrChoDuyet
                  WHERE ${where}
                  ORDER BY CASE WHEN TrangThai IN ('PENDING_APPROVAL', 'AWAITING_PAYMENT') THEN 0 ELSE 1 END,
                           ThoiGianTao DESC
                  LIMIT 50`,
                params
            );
            res.json(
                r.rows.map((x) => ({
                    maDonQr: x.madonqr,
                    branchId: x.branchid,
                    maBan: x.maban,
                    tenBan: x.tenban,
                    trangThai: x.trangthai,
                    batBuocThanhToanTruoc: Boolean(x.batbuocthanhtoantruoc),
                    daThanhToanTruoc: Boolean(x.dathanhtoantruoc),
                    tongTienTamTinh: Number(x.tongtientamtinh || 0),
                    soDienThoaiKhach: x.sodienthoaikhach,
                    tenKhach: x.tenkhach,
                    ghiChuChung: x.ghichuchung,
                    danhSachMon: Array.isArray(x.danhsachmon) ? x.danhsachmon : [],
                    maHoaDonDaTao: x.mahoadondatao,
                    nguoiDuyet: x.nguoiduyet,
                    lyDoTuChoi: x.lydotuchoi,
                    thoiGianTao: x.thoigiantao,
                    thoiGianXuLy: x.thoigianxuly,
                }))
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Danh sách đơn QR:');
        }
    });

    // 4. POS Duyệt đơn QR 1 chạm -> đẩy thẳng xuống Quầy Bar KDS + Trừ kho BOM
    app.post('/api/qr-orders/:maDonQr/approve', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const maDonQr = String(req.params.maDonQr || '').trim();
        const { daXacNhanVietQr = false, allowNegativeStock = true } = req.body || {};
        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const qrRes = await client.query(
                    'SELECT * FROM DonQrChoDuyet WHERE MaDonQr = $1 AND TenantId = $2 FOR UPDATE',
                    [maDonQr, tenantId]
                );
                if (qrRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy đơn QR này!');
                const qrOrder = qrRes.rows[0];
                if (qrOrder.trangthai === 'APPROVED') {
                    throw new LoiNghiepVu(409, `Đơn QR ${maDonQr} đã được duyệt trước đó (HĐ #${qrOrder.mahoadondatao})!`);
                }
                if (qrOrder.trangthai === 'REJECTED') {
                    throw new LoiNghiepVu(409, 'Đơn QR này đã bị từ chối trước đó!');
                }

                const items = Array.isArray(qrOrder.danhsachmon) ? qrOrder.danhsachmon : [];
                if (items.length === 0) throw new LoiNghiepVu(400, 'Đơn QR không có món hợp lệ!');

                // Tự động tìm khách hàng nếu khách có để lại SĐT
                let maKH = null;
                if (qrOrder.sodienthoaikhach) {
                    const khFound = await client.query(
                        "SELECT MaKH FROM KhachHang WHERE COALESCE(TenantId, 'DEFAULT') = $1 AND SoDienThoai = $2 LIMIT 1",
                        [tenantId, qrOrder.sodienthoaikhach]
                    );
                    maKH = khFound.rows[0]?.makh || null;
                }

                const orderRes = await taoDonHangTrongGiaoDich(client, {
                    maBan: qrOrder.maban,
                    maKH,
                    maNV: req.user.maNV,
                    tenantId,
                    allowNegativeStock: Boolean(allowNegativeStock),
                    danhSachMon: items.map((m) => ({
                        maMon: m.maMon,
                        kichThuoc: m.kichThuoc,
                        soLuong: m.soLuong,
                        ghiChu: m.ghiChu || (qrOrder.ghichuchung ? `[QR] ${qrOrder.ghichuchung}` : '[QR Order]'),
                        toppings: (m.toppings || []).map((t) => ({ maTopping: t.maTopping, soLuong: t.soLuong || 1 })),
                    })),
                });

                await client.query(
                    `UPDATE DonQrChoDuyet
                        SET TrangThai = 'APPROVED',
                            DaThanhToanTruoc = CASE WHEN $3 THEN TRUE ELSE DaThanhToanTruoc END,
                            MaHoaDonDaTao = $4,
                            NguoiDuyet = $5,
                            ThoiGianXuLy = now()
                      WHERE MaDonQr = $1 AND TenantId = $2`,
                    [maDonQr, tenantId, Boolean(daXacNhanVietQr), String(orderRes.maHoaDon), req.user.maNV]
                );

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'QR_ORDER_APPROVED',
                    doiTuong: 'DON_QR',
                    maDoiTuong: maDonQr,
                    giaTriMoi: { maHoaDon: orderRes.maHoaDon, maBan: qrOrder.maban, soMon: items.length },
                    ip: req.ip,
                });

                return { maDonQr, maBan: qrOrder.maban, tenBan: qrOrder.tenban, ...orderRes };
            }, tenantId);

            io.to(roomTen(tenantId, 'barista')).emit('DON_MOI', {
                maHoaDon: ketQua.maHoaDon,
                maBan: ketQua.maBan,
                nguon: 'QR_ORDER',
                soLuongMon: ketQua.soMonMoi,
            });
            io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('QR_ORDER_CAP_NHAT', {
                maDonQr,
                trangThai: 'APPROVED',
                maHoaDon: ketQua.maHoaDon,
            });
            if (ketQua.maBan) {
                io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('BAN_THAY_DOI', {
                    maBan: ketQua.maBan,
                    trangThai: 2,
                });
            }

            res.json({
                message: `✅ Đã duyệt đơn QR ${maDonQr} → Hóa đơn #${ketQua.maHoaDon} & đẩy xuống Barista!`,
                maHoaDon: ketQua.maHoaDon,
                hoaDon: ketQua.hoaDon,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Duyệt đơn QR:');
        }
    });

    // 5. POS Từ chối đơn QR spam
    app.post('/api/qr-orders/:maDonQr/reject', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const maDonQr = String(req.params.maDonQr || '').trim();
        const lyDo = String(req.body?.lyDo || 'Đơn không hợp lệ / Khách không có tại bàn').trim().slice(0, 200);
        try {
            const upd = await qTenant(
                req,
                `UPDATE DonQrChoDuyet
                    SET TrangThai = 'REJECTED', LyDoTuChoi = $3, NguoiDuyet = $4, ThoiGianXuLy = now()
                  WHERE MaDonQr = $1 AND TenantId = $2 AND TrangThai IN ('PENDING_APPROVAL', 'AWAITING_PAYMENT')
                  RETURNING MaDonQr`,
                [maDonQr, tenantId, lyDo, req.user.maNV]
            );
            if (upd.rows.length === 0) {
                return res.status(404).json({ message: 'Không tìm thấy đơn QR đang chờ để từ chối!' });
            }
            io.to(roomTen(tenantId, 'thungan')).emit('QR_ORDER_CAP_NHAT', { maDonQr, trangThai: 'REJECTED' });
            res.json({ message: `Đã từ chối đơn QR ${maDonQr}!` });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Từ chối đơn QR:');
        }
    });

    // 6. Xoay QrToken động & Cấu hình Anti-Spam 3 lớp cho từng bàn
    app.post('/api/ban/:maBan/qr-rotate', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const maBan = String(req.params.maBan || '').trim();
        const { rotateToken = true, qrYeuCauMoBan, qrBatBuocVietQR } = req.body || {};
        try {
            const out = await chayGiaoDich(async (client) => {
                const newToken = rotateToken ? taoQrTokenMoi() : null;
                const r = await client.query(
                    `UPDATE Ban
                        SET QrToken = COALESCE($3, QrToken),
                            QrTokenRotatedAt = CASE WHEN $3 IS NOT NULL THEN now() ELSE QrTokenRotatedAt END,
                            QrYeuCauMoBan = COALESCE($4, QrYeuCauMoBan),
                            QrBatBuocVietQR = COALESCE($5, QrBatBuocVietQR)
                      WHERE MaBan = $1 AND COALESCE(TenantId, 'DEFAULT') = $2 AND DaXoa = FALSE
                      RETURNING MaBan, TenBan, QrToken, QrTokenRotatedAt, QrYeuCauMoBan, QrBatBuocVietQR`,
                    [
                        maBan,
                        tenantId,
                        newToken,
                        typeof qrYeuCauMoBan === 'boolean' ? qrYeuCauMoBan : null,
                        typeof qrBatBuocVietQR === 'boolean' ? qrBatBuocVietQR : null,
                    ]
                );
                if (r.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy bàn!');

                const tRes = await client.query('SELECT Slug, TenQuan FROM Tenants WHERE TenantId = $1 LIMIT 1', [tenantId]);
                const slug = tRes.rows[0]?.slug || 'default-cafe';
                const b = r.rows[0];
                return {
                    maBan: b.maban,
                    tenBan: b.tenban,
                    slug,
                    qrToken: b.qrtoken,
                    qrTokenRotatedAt: b.qrtokenrotatedat,
                    qrYeuCauMoBan: Boolean(b.qryeucaumoban),
                    qrBatBuocVietQR: Boolean(b.qrbatbuocvietqr),
                    qrPath: `/m/${slug}/${b.qrtoken}`,
                };
            }, tenantId);

            res.json({
                message: rotateToken ? `🔄 Đã xoay mã QR mới cho ${out.tenBan}!` : `✅ Đã cập nhật chính sách chống spam QR cho ${out.tenBan}!`,
                tableQr: out,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Xoay QR Token bàn:');
        }
    });

    // =========================================================================
    // B. CRM PHÂN HẠNG (ĐỒNG/BẠC/VÀNG/KIM CƯƠNG) + VÍ TRẢ TRƯỚC + ZALO ZNS
    // =========================================================================

    app.get('/api/crm/customers', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const search = String(req.query.q || '').trim();
        const isManager = Number(req.user?.vaiTro) === 1;

        // [Wave 3A — NĐ 13/2023] Cấm thu ngân tải hàng loạt toàn bộ tệp khách hàng
        if (!isManager && !search) {
            return res.status(403).json({
                message: 'Thu ngân không được phép tải hàng loạt tệp khách hàng. Vui lòng nhập từ khóa (SĐT/tên) để tra cứu (NĐ 13/2023/NĐ-CP)!',
                customers: [],
            });
        }

        const rowLimit = isManager ? 100 : 5;
        try {
            const params = [tenantId];
            let extraWhere = '';
            if (search) {
                params.push(`%${search}%`);
                extraWhere = ` AND (COALESCE(to_jsonb(KhachHang)->>'tenkh', to_jsonb(KhachHang)->>'hoten', '') ILIKE $${params.length} OR SoDienThoai ILIKE $${params.length})`;
            }
            params.push(rowLimit);
            const r = await qTenant(
                req,
                `SELECT MaKH,
                        COALESCE(to_jsonb(KhachHang)->>'tenkh', to_jsonb(KhachHang)->>'hoten', '') AS TenKH,
                        SoDienThoai,
                        COALESCE(DiemTichLuy, 0) AS DiemTichLuy,
                        COALESCE(HangThanhVien, 'DONG') AS HangThanhVien,
                        COALESCE(TongChiTieu, 0) AS TongChiTieu,
                        COALESCE(SoDuVi, 0) AS SoDuVi,
                        NgaySinh,
                        COALESCE(ZaloOptIn, FALSE) AS ZaloOptIn,
                        LanMuaCuoi,
                        anonymized_at
                   FROM KhachHang
                  WHERE COALESCE(TenantId, 'DEFAULT') = $1 ${extraWhere}
                  ORDER BY TongChiTieu DESC, DiemTichLuy DESC
                  LIMIT $${params.length}`,
                params
            );
            const customers = r.rows.map((k) => {
                const tier = tinhHangThanhVien(Number(k.tongchitieu || 0));
                return {
                    maKH: k.makh,
                    tenKH: k.tenkh,
                    soDienThoai: maskPhoneForRole(k.sodienthoai, req.user?.vaiTro),
                    diemTichLuy: Number(k.diemtichluy || 0),
                    hangThanhVien: k.hangthanhvien || tier.hang,
                    tenHang: tier.tenHang,
                    cashbackPct: tier.cashbackPct,
                    tongChiTieu: Number(k.tongchitieu || 0),
                    soDuVi: Number(k.soduvi || 0),
                    ngaySinh: isManager ? k.ngaysinh : null,
                    zaloOptIn: Boolean(k.zalooptin),
                    lanMuaCuoi: k.lanmuacuoi,
                    anonymizedAt: k.anonymized_at || null,
                };
            });

            const tierSummary = CRM_TIERS.map((t) => ({
                code: t.code,
                label: t.label,
                minSpend: t.minSpend,
                cashbackPct: t.cashbackPct,
                count: customers.filter((c) => c.hangThanhVien === t.code).length,
            }));

            res.json({
                tierSummary,
                tongSoDuVi: customers.reduce((s, c) => s + c.soDuVi, 0),
                customers,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API CRM Khách hàng:');
        }
    });

    // [Wave 3A — NĐ 13/2023] Ghi nhận đồng thuận xử lý dữ liệu cá nhân & đồng bộ ZaloOptIn
    app.post('/api/crm/customers/:maKH/consent', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const maKH = String(req.params.maKH || '').trim();
        const channel = String(req.body?.channel || 'POS_COUNTER').trim().toUpperCase();
        const purpose = String(req.body?.purpose || '').trim().toUpperCase();
        const granted = Boolean(req.body?.granted);

        if (!['POS_COUNTER', 'QR_MENU', 'ZALO_MINIAPP'].includes(channel)) {
            return res.status(400).json({ message: 'channel phải thuộc POS_COUNTER, QR_MENU, ZALO_MINIAPP!' });
        }
        if (!['LOYALTY_POINTS', 'ZNS_RECEIPT', 'MARKETING_PROMO'].includes(purpose)) {
            return res.status(400).json({ message: 'purpose phải thuộc LOYALTY_POINTS, ZNS_RECEIPT, MARKETING_PROMO!' });
        }

        try {
            const consent = await chayGiaoDich(async (client) => {
                const khCheck = await client.query(
                    `SELECT MaKH FROM public.KhachHang WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
                    [maKH, tenantId]
                );
                if (khCheck.rows.length === 0) {
                    throw new LoiNghiepVu(404, 'Không tìm thấy khách hàng!');
                }

                const ins = await client.query(
                    `INSERT INTO public.customer_consent_logs
                        (tenant_id, ma_kh, channel, purpose, granted, ip_address, recorded_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     RETURNING *`,
                    [tenantId, maKH, channel, purpose, granted, req.ip || null, req.user?.maNV || 'SYSTEM']
                );

                if (purpose === 'ZNS_RECEIPT' || purpose === 'MARKETING_PROMO') {
                    await client.query(
                        `UPDATE public.KhachHang
                            SET ZaloOptIn = $3
                          WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
                        [maKH, tenantId, granted]
                    );
                }
                return ins.rows[0];
            }, tenantId);

            return res.status(201).json({
                message: 'Đã ghi nhận đồng thuận khách hàng theo Nghị định 13/2023/NĐ-CP!',
                consent,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi ghi nhận đồng thuận khách hàng:');
        }
    });

    // [Wave 3A — NĐ 13/2023] Quyền được xóa / ẩn danh PII khách hàng (Chỉ Quản lý vaiTro = 1)
    app.post('/api/crm/customers/:maKH/anonymize', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const maKH = String(req.params.maKH || '').trim();
        const lyDo = String(req.body?.lyDo || 'Yêu cầu xóa dữ liệu cá nhân theo NĐ 13/2023/NĐ-CP').trim().slice(0, 255);

        try {
            const result = await chayGiaoDich(async (client) => {
                const khRes = await client.query(
                    `SELECT MaKH, SoDienThoai,
                            COALESCE(to_jsonb(KhachHang)->>'tenkh', to_jsonb(KhachHang)->>'hoten', '') AS TenKH,
                            anonymized_at
                       FROM public.KhachHang
                      WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                      FOR UPDATE`,
                    [maKH, tenantId]
                );
                if (khRes.rows.length === 0) {
                    throw new LoiNghiepVu(404, 'Không tìm thấy khách hàng để ẩn danh!');
                }
                const oldKh = khRes.rows[0];
                const anonPhone = `ANON-${crypto.createHash('sha256').update(`${tenantId}:${maKH}:${Date.now()}`).digest('hex').slice(0, 10).toUpperCase()}`;

                await client.query(
                    `UPDATE public.KhachHang
                        SET SoDienThoai = $3,
                            Email = NULL,
                            NgaySinh = NULL,
                            ZaloOptIn = FALSE,
                            anonymized_at = now()
                      WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
                    [maKH, tenantId, anonPhone]
                );

                // Cập nhật tên ẩn danh tương thích cả schema có TenKH lẫn schema_base có HoTen
                for (const nameCol of ['TenKH', 'HoTen']) {
                    await client.query(`SAVEPOINT sp_anon_${nameCol}`);
                    try {
                        await client.query(
                            `UPDATE public.KhachHang
                                SET ${nameCol} = 'Khách hàng đã ẩn danh'
                              WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
                            [maKH, tenantId]
                        );
                        await client.query(`RELEASE SAVEPOINT sp_anon_${nameCol}`);
                    } catch {
                        await client.query(`ROLLBACK TO SAVEPOINT sp_anon_${nameCol}`).catch(() => {});
                    }
                }

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user?.maNV || 'SYSTEM',
                    vaiTro: req.user?.vaiTro,
                    hanhDong: 'CUSTOMER_PII_ANONYMIZED',
                    doiTuong: 'KHACHHANG',
                    maDoiTuong: maKH,
                    giaTriCu: {
                        maKH,
                        maskedPhone: maskPhoneForRole(oldKh.sodienthoai, 4),
                    },
                    giaTriMoi: {
                        maKH,
                        anonPhone,
                        anonymized: true,
                    },
                    lyDo,
                    ip: req.ip,
                    batBuoc: true,
                });

                return { maKH, anonPhone, anonymized: true };
            }, tenantId);

            return res.json({
                message: 'Đã ẩn danh toàn bộ thông tin định danh (PII) khách hàng, giữ nguyên liên kết hóa đơn kế toán!',
                ...result,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi ẩn danh dữ liệu khách hàng:');
        }
    });

    // Nạp Ví trả trước / Tặng Cashback cho khách hàng + cập nhật ngày sinh
    app.post('/api/crm/customers/:maKH/wallet-topup', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const maKH = String(req.params.maKH || '').trim();
        const soTien = Number(req.body?.soTien || 0);
        const loaiGD = ['TOPUP', 'CASHBACK'].includes(String(req.body?.loaiGD || 'TOPUP').toUpperCase())
            ? String(req.body?.loaiGD || 'TOPUP').toUpperCase()
            : 'TOPUP';
        const ghiChu = String(req.body?.ghiChu || (loaiGD === 'CASHBACK' ? 'Thưởng Cashback thành viên' : 'Nạp ví trả trước tại quầy')).trim().slice(0, 200);
        const ngaySinh = req.body?.ngaySinh || null;

        if (!(soTien > 0) || soTien > 50000000) {
            return res.status(400).json({ message: 'Số tiền nạp ví phải > 0 và <= 50.000.000đ!' });
        }

        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const khRes = await client.query(
                    `SELECT MaKH, TenKH, SoDienThoai, COALESCE(SoDuVi, 0) AS SoDuVi
                       FROM KhachHang WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $2 FOR UPDATE`,
                    [maKH, tenantId]
                );
                if (khRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy khách hàng!');
                const kh = khRes.rows[0];
                const soDuMoi = Math.round((Number(kh.soduvi || 0) + soTien) * 100) / 100;

                await client.query(
                    `UPDATE KhachHang
                        SET SoDuVi = $2,
                            NgaySinh = COALESCE($3::date, NgaySinh)
                      WHERE MaKH = $1`,
                    [maKH, soDuMoi, ngaySinh]
                );

                await client.query(
                    `INSERT INTO KhachHang_GiaoDichVi (TenantId, MaKH, LoaiGD, SoTien, SoDuSau, GhiChu, MaNV)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [tenantId, maKH, loaiGD, soTien, soDuMoi, ghiChu, req.user.maNV]
                );

                return { maKH, tenKH: kh.tenkh, soTien, soDuMoi, loaiGD };
            }, tenantId);

            res.json({
                message: `💰 Đã cộng ${soTien.toLocaleString('vi-VN')}đ vào ví của ${ketQua.tenKH} (Số dư mới: ${ketQua.soDuMoi.toLocaleString('vi-VN')}đ)!`,
                ...ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Nạp ví khách hàng:');
        }
    });

    // Hàng đợi Zalo ZNS & Kích hoạt chúc mừng sinh nhật tự động
    app.get('/api/crm/zns/outbox', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const r = await qTenant(
                req,
                `SELECT Id, MaKH, SoDienThoai, LoaiTin, NoiDung, TrangThai, ThoiGianTao, ThoiGianGui
                   FROM Zalo_ZNS_Outbox
                  WHERE TenantId = $1
                  ORDER BY ThoiGianTao DESC
                  LIMIT 50`,
                [tenantId]
            );
            res.json(
                r.rows.map((z) => ({
                    id: z.id,
                    maKH: z.makh,
                    soDienThoai: z.sodienthoai,
                    loaiTin: z.loaitin,
                    noiDung: z.noidung || {},
                    trangThai: z.trangthai,
                    thoiGianTao: z.thoigiantao,
                    thoiGianGui: z.thoigiangui,
                }))
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Danh sách Zalo ZNS:');
        }
    });

    app.post('/api/crm/zns/trigger-birthday', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const giftCashback = Math.max(0, Number(req.body?.tangCashback ?? 30000));
        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const { dateISO } = layGioHienTaiVN();
                const currentMonth = parseInt(dateISO.slice(5, 7), 10);
                const khRes = await client.query(
                    `SELECT MaKH, TenKH, SoDienThoai, NgaySinh, COALESCE(SoDuVi, 0) AS SoDuVi
                       FROM KhachHang
                      WHERE COALESCE(TenantId, 'DEFAULT') = $1
                        AND COALESCE(ZaloOptIn, TRUE) = TRUE
                        AND NgaySinh IS NOT NULL
                        AND EXTRACT(MONTH FROM NgaySinh) = $2`,
                    [tenantId, currentMonth]
                );

                let queued = 0;
                for (const kh of khRes.rows) {
                    const daGui = await client.query(
                        `SELECT 1 FROM Zalo_ZNS_Outbox
                          WHERE TenantId = $1 AND MaKH = $2 AND LoaiTin = 'BIRTHDAY'
                            AND ThoiGianTao >= date_trunc('month', now()) LIMIT 1`,
                        [tenantId, kh.makh]
                    );
                    if (daGui.rows.length > 0) continue;

                    if (giftCashback > 0) {
                        const soDuMoi = Number(kh.soduvi || 0) + giftCashback;
                        await client.query('UPDATE KhachHang SET SoDuVi = $2 WHERE MaKH = $1', [kh.makh, soDuMoi]);
                        await client.query(
                            `INSERT INTO KhachHang_GiaoDichVi (TenantId, MaKH, LoaiGD, SoTien, SoDuSau, GhiChu, MaNV)
                             VALUES ($1, $2, 'CASHBACK', $3, $4, 'Quà sinh nhật thành viên', $5)`,
                            [tenantId, kh.makh, giftCashback, soDuMoi, req.user.maNV]
                        );
                    }

                    await client.query(
                        `INSERT INTO Zalo_ZNS_Outbox (TenantId, MaKH, SoDienThoai, LoaiTin, NoiDung, TrangThai, ThoiGianGui)
                         VALUES ($1, $2, $3, 'BIRTHDAY', $4::jsonb, 'SENT', now())`,
                        [
                            tenantId,
                            kh.makh,
                            kh.sodienthoai,
                            JSON.stringify({
                                tenKH: kh.tenkh,
                                giftCashback,
                                tinNhan: `🎂 Chúc mừng sinh nhật ${kh.tenkh}! Quán gửi tặng bạn ${giftCashback.toLocaleString('vi-VN')}đ vào Ví thành viên. Hẹn gặp bạn tại quán tháng này nhé!`,
                            }),
                        ]
                    );
                    queued += 1;
                }
                return { currentMonth, matched: khRes.rows.length, queued };
            }, tenantId);

            res.json({
                message:
                    ketQua.queued > 0
                        ? `🎂 Đã gửi ${ketQua.queued} tin nhắn Zalo ZNS sinh nhật tháng ${ketQua.currentMonth}!`
                        : `Không có khách hàng sinh nhật mới trong tháng ${ketQua.currentMonth} cần gửi.`,
                ...ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Gửi Zalo ZNS sinh nhật:');
        }
    });

    // =========================================================================
    // C. MULTI-BRANCH & FRANCHISE HQ (TENANT -> BRANCH -> TERMINAL)
    // =========================================================================

    app.get('/api/branches', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const [brRes, termRes] = await Promise.all([
                qTenant(
                    req,
                    `SELECT BranchId, MaChiNhanh, TenChiNhanh, KhuVucGia, DiaChi, SoDienThoai,
                            LaKhoTong, TyLePhiNhuongQuyen, TrangThai, ThoiGianTao
                       FROM ChiNhanh
                      WHERE TenantId = $1
                      ORDER BY LaKhoTong DESC, ThoiGianTao ASC`,
                    [tenantId]
                ),
                qTenant(
                    req,
                    `SELECT TerminalId, BranchId, TenQuay, LoaiQuay, TrangThai, ThoiGianTao
                       FROM QuayTerminal
                      WHERE TenantId = $1
                      ORDER BY ThoiGianTao ASC`,
                    [tenantId]
                ),
            ]);
            const termsByBranch = new Map();
            for (const t of termRes.rows) {
                if (!termsByBranch.has(t.branchid)) termsByBranch.set(t.branchid, []);
                termsByBranch.get(t.branchid).push({
                    terminalId: t.terminalid,
                    branchId: t.branchid,
                    tenQuay: t.tenquay,
                    loaiQuay: t.loaiquay,
                    trangThai: t.trangthai,
                });
            }

            res.json(
                brRes.rows.map((b) => ({
                    branchId: b.branchid,
                    maChiNhanh: b.machinhanh,
                    tenChiNhanh: b.tenchinhanh,
                    khuVucGia: b.khuvucgia || 'DEFAULT',
                    diaChi: b.diachi || '',
                    soDienThoai: b.sodienthoai || '',
                    laKhoTong: Boolean(b.lakhotong),
                    tyLePhiNhuongQuyen: Number(b.tylephinhuongquyen || 0),
                    trangThai: b.trangthai,
                    thoiGianTao: b.thoigiantao,
                    terminals: termsByBranch.get(b.branchid) || [],
                }))
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Danh sách Chi nhánh:');
        }
    });

    app.post('/api/branches', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const {
            maChiNhanh,
            tenChiNhanh,
            khuVucGia = 'DEFAULT',
            diaChi = '',
            soDienThoai = '',
            laKhoTong = false,
            tyLePhiNhuongQuyen = 0,
        } = req.body || {};

        const cleanCode = String(maChiNhanh || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
        const cleanName = String(tenChiNhanh || '').trim();
        const cleanZone = String(khuVucGia || 'DEFAULT').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '') || 'DEFAULT';
        const royalty = Math.min(100, Math.max(0, Number(tyLePhiNhuongQuyen || 0)));

        if (cleanCode.length < 2 || cleanName.length < 2) {
            return res.status(400).json({ message: 'Vui lòng nhập Mã chi nhánh và Tên chi nhánh (tối thiểu 2 ký tự)!' });
        }

        try {
            const branchId = `${tenantId}_${cleanCode}`;
            const ketQua = await chayGiaoDich(async (client) => {
                const ins = await client.query(
                    `INSERT INTO ChiNhanh
                        (BranchId, TenantId, MaChiNhanh, TenChiNhanh, KhuVucGia, DiaChi, SoDienThoai, LaKhoTong, TyLePhiNhuongQuyen)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                     RETURNING BranchId, MaChiNhanh, TenChiNhanh, KhuVucGia, LaKhoTong, TyLePhiNhuongQuyen`,
                    [branchId, tenantId, cleanCode, cleanName, cleanZone, diaChi, soDienThoai, Boolean(laKhoTong), royalty]
                );

                // Tạo sẵn 1 Quầy POS mặc định cho chi nhánh mới
                const termId = `TM_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
                await client.query(
                    `INSERT INTO QuayTerminal (TerminalId, TenantId, BranchId, TenQuay, LoaiQuay)
                     VALUES ($1, $2, $3, 'Quầy Thu ngân 01', 'POS')`,
                    [termId, tenantId, branchId]
                );

                // Khởi tạo tồn kho 0 cho chi nhánh mới từ danh mục nguyên liệu của HQ
                await client.query(
                    `INSERT INTO TonKhoChiNhanh (TenantId, BranchId, MaNL, SoLuongTon, HanMucCanhBao, GiaVonDonVi)
                     SELECT $1::text, $2::text, MaNL, 0, COALESCE(HanMucCanhBao, 0), COALESCE(GiaVonDonVi, 0)
                       FROM NguyenLieu
                      WHERE COALESCE(TenantId::text, 'DEFAULT') = $1::text AND DaXoa = FALSE
                     ON CONFLICT (BranchId, MaNL) DO NOTHING`,
                    [tenantId, branchId]
                );

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'BRANCH_CREATED',
                    doiTuong: 'CHINHANH',
                    maDoiTuong: branchId,
                    giaTriMoi: { maChiNhanh: cleanCode, tenChiNhanh: cleanName, khuVucGia: cleanZone, royalty },
                    ip: req.ip,
                });

                return ins.rows[0];
            }, tenantId);

            res.status(201).json({
                message: `🏢 Đã khởi tạo chi nhánh "${ketQua.tenchinhanh}" (Vùng giá: ${ketQua.khuvucgia})!`,
                branch: ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Tạo Chi nhánh:');
        }
    });

    app.post('/api/branches/:branchId/terminals', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = String(req.params.branchId || '').trim();
        const tenQuay = String(req.body?.tenQuay || '').trim();
        const loaiQuay = ['POS', 'KDS', 'KIOSK'].includes(String(req.body?.loaiQuay || 'POS').toUpperCase())
            ? String(req.body?.loaiQuay || 'POS').toUpperCase()
            : 'POS';
        if (tenQuay.length < 2) return res.status(400).json({ message: 'Vui lòng nhập Tên quầy (tối thiểu 2 ký tự)!' });

        try {
            const terminalId = `TM_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            const r = await qTenant(
                req,
                `INSERT INTO QuayTerminal (TerminalId, TenantId, BranchId, TenQuay, LoaiQuay)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING TerminalId, BranchId, TenQuay, LoaiQuay, TrangThai`,
                [terminalId, tenantId, branchId, tenQuay, loaiQuay]
            );
            res.status(201).json({ message: `Đã thêm quầy ${tenQuay} (${loaiQuay})!`, terminal: r.rows[0] });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Thêm Terminal:');
        }
    });

    // Báo cáo hợp nhất chuỗi đa chi nhánh + Tự động tính Phí bản quyền Nhượng quyền (% doanh thu thuần)
    app.get('/api/branches/consolidated-report', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const { dateISO } = layGioHienTaiVN();
        const tuNgay = String(req.query.tuNgay || `${dateISO.slice(0, 8)}01`);
        const denNgay = String(req.query.denNgay || dateISO);

        try {
            const r = await qTenant(
                req,
                `SELECT
                    cn.BranchId,
                    cn.MaChiNhanh,
                    cn.TenChiNhanh,
                    cn.KhuVucGia,
                    cn.LaKhoTong,
                    COALESCE(cn.TyLePhiNhuongQuyen, 0) AS TyLePhiNhuongQuyen,
                    COUNT(DISTINCT hd.MaHoaDon) AS SoDon,
                    COALESCE(SUM(hd.TongTienThanhToan), 0) AS DoanhThuThuan
                   FROM ChiNhanh cn
                   LEFT JOIN HoaDon hd
                     ON hd.BranchId = cn.BranchId
                    AND COALESCE(hd.TenantId, 'DEFAULT') = $1
                    AND hd.TrangThaiTT = 1
                    AND (hd.ThoiGianThanhToan::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date
                  WHERE cn.TenantId = $1
                  GROUP BY cn.BranchId, cn.MaChiNhanh, cn.TenChiNhanh, cn.KhuVucGia, cn.LaKhoTong, cn.TyLePhiNhuongQuyen
                  ORDER BY DoanhThuThuan DESC, cn.TenChiNhanh ASC`,
                [tenantId, tuNgay, denNgay]
            );

            const branches = r.rows.map((b) => {
                const doanhThuThuan = Number(b.doanhthuthuan || 0);
                const tyLe = Number(b.tylephinhuongquyen || 0);
                const phiNhuongQuyen = Math.round((doanhThuThuan * tyLe) / 100);
                return {
                    branchId: b.branchid,
                    maChiNhanh: b.machinhanh,
                    tenChiNhanh: b.tenchinhanh,
                    khuVucGia: b.khuvucgia,
                    laKhoTong: Boolean(b.lakhotong),
                    soDon: Number(b.sodon || 0),
                    doanhThuThuan,
                    tyLePhiNhuongQuyen: tyLe,
                    phiNhuongQuyen,
                };
            });

            res.json({
                tuNgay,
                denNgay,
                tongSoChiNhanh: branches.length,
                tongSoDon: branches.reduce((s, b) => s + b.soDon, 0),
                tongDoanhThuChuoi: branches.reduce((s, b) => s + b.doanhThuThuan, 0),
                tongPhiNhuongQuyen: branches.reduce((s, b) => s + b.phiNhuongQuyen, 0),
                branches,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Báo cáo hợp nhất đa chi nhánh:');
        }
    });

    // Menu tập trung đẩy theo vùng giá (VD: DA_NANG 39k / HCM 45k)
    app.get('/api/branches/regional-prices', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const r = await qTenant(
                req,
                `SELECT gv.Id, gv.KhuVucGia, gv.MaMon, sp.TenMon, gv.KichThuoc, gv.GiaBan, gv.CapNhatLuc
                   FROM SanPham_GiaVung gv
                   LEFT JOIN SanPham sp ON sp.MaMon = gv.MaMon AND COALESCE(sp.TenantId, 'DEFAULT') = $1
                  WHERE gv.TenantId = $1
                  ORDER BY gv.KhuVucGia, sp.TenMon, gv.KichThuoc`,
                [tenantId]
            );
            res.json(
                r.rows.map((x) => ({
                    id: x.id,
                    khuVucGia: x.khuvucgia,
                    maMon: x.mamon,
                    tenMon: x.tenmon || x.mamon,
                    kichThuoc: x.kichthuoc,
                    giaBan: Number(x.giaban || 0),
                    capNhatLuc: x.capnhatluc,
                }))
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Lấy bảng giá theo vùng:');
        }
    });

    app.post('/api/branches/regional-prices/push', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const { khuVucGia, items = [] } = req.body || {};
        const cleanZone = String(khuVucGia || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
        if (!cleanZone || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ message: 'Vui lòng chọn Vùng giá (VD: HCM, DA_NANG) và ít nhất 1 mức giá món!' });
        }
        try {
            const count = await chayGiaoDich(async (client) => {
                let updated = 0;
                for (const it of items) {
                    const maMon = String(it.maMon || '').trim();
                    const kichThuoc = String(it.kichThuoc || 'M').toUpperCase();
                    const giaBan = Number(it.giaBan);
                    if (!maMon || !(giaBan >= 0)) continue;
                    await client.query(
                        `INSERT INTO SanPham_GiaVung (TenantId, KhuVucGia, MaMon, KichThuoc, GiaBan, CapNhatLuc)
                         VALUES ($1, $2, $3, $4, $5, now())
                         ON CONFLICT (TenantId, KhuVucGia, MaMon, KichThuoc)
                         DO UPDATE SET GiaBan = EXCLUDED.GiaBan, CapNhatLuc = now()`,
                        [tenantId, cleanZone, maMon, kichThuoc, giaBan]
                    );
                    updated += 1;
                }
                return updated;
            }, tenantId);

            res.json({
                message: `🚀 Đã đẩy đồng bộ ${count} mức giá xuống toàn bộ chi nhánh thuộc vùng ${cleanZone}!`,
                khuVucGia: cleanZone,
                soMucGiaCapNhat: count,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Đẩy giá theo vùng:');
        }
    });

    // Kho tổng & Điều chuyển nội bộ giữa các chi nhánh (Phân hệ 4: 3 trạng thái PENDING -> IN_TRANSIT -> COMPLETED + Chênh lệch vận chuyển)
    app.get('/api/branches/transfers', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const [pRes, ctRes] = await Promise.all([
                qTenant(
                    req,
                    `SELECT p.MaPhieu, p.TuBranchId, cn1.TenChiNhanh AS TenTuChiNhanh,
                            p.DenBranchId, cn2.TenChiNhanh AS TenDenChiNhanh,
                            p.MaNVTao, p.MaNVXuat, p.MaNVNhan, p.TrangThai, p.GhiChu,
                            p.ThoiGianTao, p.ThoiGianXuatKho, p.ThoiGianHoanTat
                       FROM PhieuDieuChuyenKho p
                       LEFT JOIN ChiNhanh cn1 ON cn1.BranchId = p.TuBranchId
                       LEFT JOIN ChiNhanh cn2 ON cn2.BranchId = p.DenBranchId
                      WHERE p.TenantId = $1
                      ORDER BY p.ThoiGianTao DESC
                      LIMIT 50`,
                    [tenantId]
                ),
                qTenant(
                    req,
                    `SELECT ct.MaPhieu, ct.MaNL, nl.TenNL, nl.DonViTinh, ct.SoLuong, ct.DonGiaVon,
                            ct.SoLuongThucNhan, ct.GhiChuChenhLech
                       FROM ChiTietDieuChuyenKho ct
                       LEFT JOIN NguyenLieu nl ON nl.MaNL = ct.MaNL AND COALESCE(nl.TenantId, 'DEFAULT') = $1
                      WHERE ct.TenantId = $1`,
                    [tenantId]
                ),
            ]);

            const ctMap = new Map();
            for (const c of ctRes.rows) {
                if (!ctMap.has(c.maphieu)) ctMap.set(c.maphieu, []);
                ctMap.get(c.maphieu).push({
                    maNL: c.manl,
                    tenNL: c.tennl || c.manl,
                    donViTinh: c.donvitinh || '',
                    soLuong: Number(c.soluong || 0),
                    soLuongThucNhan: c.soluongthucnhan !== null && c.soluongthucnhan !== undefined ? Number(c.soluongthucnhan) : null,
                    ghiChuChenhLech: c.ghichuchenhlech || null,
                    donGiaVon: Number(c.dongiavon || 0),
                });
            }

            res.json(
                pRes.rows.map((p) => ({
                    maPhieu: p.maphieu,
                    tuBranchId: p.tubranchid,
                    tenTuChiNhanh: p.tentuchinhanh || p.tubranchid,
                    denBranchId: p.denbranchid,
                    tenDenChiNhanh: p.tendenchinhanh || p.denbranchid,
                    maNVXuat: p.manvxuat || null,
                    maNVNhan: p.manvnhan || null,
                    trangThai: p.trangthai,
                    ghiChu: p.ghichu || '',
                    thoiGianTao: p.thoigiantao,
                    thoiGianXuatKho: p.thoigianxuatkho || null,
                    thoiGianHoanTat: p.thoigianhoantat,
                    chiTiet: ctMap.get(p.maphieu) || [],
                }))
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Danh sách phiếu điều chuyển kho:');
        }
    });

    app.post('/api/branches/transfers', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const { tuBranchId, denBranchId, ghiChu = '', items = [] } = req.body || {};
        if (!tuBranchId || !denBranchId || tuBranchId === denBranchId) {
            return res.status(400).json({ message: 'Vui lòng chọn Chi nhánh xuất và Chi nhánh nhận khác nhau!' });
        }
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ message: 'Vui lòng chọn ít nhất 1 nguyên liệu để điều chuyển!' });
        }

        try {
            const maPhieu = `DC${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            await chayGiaoDich(async (client) => {
                await client.query(
                    `INSERT INTO PhieuDieuChuyenKho (MaPhieu, TenantId, TuBranchId, DenBranchId, MaNVTao, TrangThai, GhiChu)
                     VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)`,
                    [maPhieu, tenantId, tuBranchId, denBranchId, req.user.maNV, String(ghiChu).slice(0, 255)]
                );
                for (const it of items) {
                    const maNL = String(it.maNL || '').trim();
                    const sl = Number(it.soLuong);
                    if (!maNL || !(sl > 0)) continue;
                    const tkRes = await client.query(
                        `SELECT COALESCE(tk.GiaVonDonVi, nl.GiaVonDonVi, 0) AS GiaVonDonVi
                           FROM NguyenLieu nl
                           LEFT JOIN TonKhoChiNhanh tk ON tk.BranchId = $3::text AND tk.MaNL = nl.MaNL
                          WHERE nl.MaNL = $1::text AND COALESCE(nl.TenantId::text, 'DEFAULT') = $2::text`,
                        [maNL, tenantId, tuBranchId]
                    );
                    const giaVon = Number(tkRes.rows[0]?.giavondonvi || 0);
                    await client.query(
                        `INSERT INTO ChiTietDieuChuyenKho (TenantId, MaPhieu, MaNL, SoLuong, DonGiaVon)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [tenantId, maPhieu, maNL, sl, giaVon]
                    );
                }
            }, tenantId);

            res.status(201).json({ message: `📦 Đã tạo phiếu điều chuyển kho ${maPhieu} (PENDING)!`, maPhieu, trangThai: 'PENDING' });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Tạo phiếu điều chuyển kho:');
        }
    });

    // Bước 2: Xuất xe giao hàng (PENDING -> IN_TRANSIT): trừ ngay kho nguồn, cộng TonDangChuyen ở chi nhánh đích & đóng băng DonGiaVon!
    app.post('/api/branches/transfers/:maPhieu/dispatch', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const maPhieu = String(req.params.maPhieu || '').trim();
        try {
            const out = await chayGiaoDich(async (client) => {
                const pRes = await client.query(
                    'SELECT * FROM PhieuDieuChuyenKho WHERE MaPhieu = $1 AND TenantId = $2 FOR UPDATE',
                    [maPhieu, tenantId]
                );
                if (pRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy phiếu điều chuyển!');
                const phieu = pRes.rows[0];
                if (phieu.trangthai !== 'PENDING') {
                    throw new LoiNghiepVu(409, `Phiếu ${maPhieu} không ở trạng thái PENDING (${phieu.trangthai})!`);
                }

                const ctRes = await client.query(
                    'SELECT id, MaNL, SoLuong FROM ChiTietDieuChuyenKho WHERE MaPhieu = $1 AND TenantId = $2 ORDER BY MaNL ASC',
                    [maPhieu, tenantId]
                );
                const maNLList = ctRes.rows.map((r) => r.manl);

                // Khóa tồn kho nguồn & đích theo thứ tự chuẩn ORDER BY MaNL ASC (tránh Deadlock!)
                const srcLock = await lockBranchStockOrdered(client, tenantId, phieu.tubranchid, maNLList);
                const dstLock = await lockBranchStockOrdered(client, tenantId, phieu.denbranchid, maNLList);

                const pXuat = await client.query(
                    `INSERT INTO public.phieugiaodichkho (manv, loaigd, ghichu, tenantid, branchid, ngaychungtu, trangthaiduyet)
                     VALUES ($1, 4, $2, $3, $4, $5::date, 'POSTED')
                     RETURNING magiaodich`,
                    [req.user.maNV, `Xuất điều chuyển ${maPhieu} -> ${phieu.denbranchid}`, tenantId, srcLock.branchId, todayDateVN()]
                );
                const maGDXuat = pXuat.rows[0].magiaodich;

                for (const item of ctRes.rows) {
                    const stSrc = srcLock.stockMap.get(item.manl);
                    const qty = lam3(item.soluong);
                    const frozenCost = lam4(stSrc?.giaVonDonVi || 0);
                    const srcBefore = stSrc ? stSrc.soLuongTon : 0;
                    const srcAfter = lam3(srcBefore - qty);

                    // Đóng băng DonGiaVon = KhoTong.GiaVonDonVi
                    await client.query(
                        `UPDATE ChiTietDieuChuyenKho SET DonGiaVon = $2::numeric WHERE id = $1::bigint`,
                        [Number(item.id), frozenCost]
                    );

                    // Trừ tồn kho nguồn (TonKhoChiNhanh + mirror nếu là MAIN)
                    await updateBranchStockRow(client, {
                        tenantId,
                        branchId: srcLock.branchId,
                        maNL: item.manl,
                        nextQty: srcAfter,
                    });

                    // Cộng TonDangChuyen (IN_TRANSIT) cho Chi nhánh đích (CHƯA cộng vào SoLuongTon!)
                    await client.query(
                        `UPDATE public.tonkhochinhanh
                            SET tondangchuyen = COALESCE(tondangchuyen, 0) + $4::numeric,
                                capnhatluc = now()
                          WHERE tenantid = $1::text AND branchid = $2::text AND manl = $3::text`,
                        [tenantId, dstLock.branchId, item.manl, qty]
                    );

                    await insertLedgerLine(client, {
                        maGiaoDich: maGDXuat,
                        maNL: item.manl,
                        soLuong: qty,
                        donGiaNhap: frozenCost,
                        tinhTrang: `Xuất xe giao hàng ${maPhieu} (IN_TRANSIT)`,
                        tonTruoc: srcBefore,
                        tonSau: srcAfter,
                        giaVonTruoc: frozenCost,
                        giaVonSau: frozenCost,
                    });
                }

                await client.query(
                    `UPDATE PhieuDieuChuyenKho
                        SET TrangThai = 'IN_TRANSIT', MaNVXuat = $3, ThoiGianXuatKho = now()
                      WHERE MaPhieu = $1 AND TenantId = $2`,
                    [maPhieu, tenantId, req.user.maNV]
                );

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'BRANCH_TRANSFER_DISPATCHED',
                    doiTuong: 'DIEU_CHUYEN_KHO',
                    maDoiTuong: maPhieu,
                    giaTriMoi: { tuBranchId: phieu.tubranchid, denBranchId: phieu.denbranchid, soDong: ctRes.rows.length, maGDXuat },
                    ip: req.ip,
                });

                return { maPhieu, trangThai: 'IN_TRANSIT', maGDXuat };
            }, tenantId);

            res.json({ message: `🚚 Đã xuất xe giao hàng cho phiếu ${maPhieu} (IN_TRANSIT)!`, ...out });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Xuất kho điều chuyển (IN_TRANSIT):');
        }
    });

    // Bước 3: Kiểm nhận hàng tại Chi nhánh đích (IN_TRANSIT/PENDING -> COMPLETED + xử lý thiếu hụt vận chuyển DAMAGED_DELIVERY)
    app.post('/api/branches/transfers/:maPhieu/complete', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const maPhieu = String(req.params.maPhieu || '').trim();
        const receivedItems = Array.isArray(req.body?.receivedItems) ? req.body.receivedItems : [];
        const recvMap = new Map(receivedItems.map((x) => [String(x.maNL), x]));

        try {
            const out = await chayGiaoDich(async (client) => {
                const pRes = await client.query(
                    'SELECT * FROM PhieuDieuChuyenKho WHERE MaPhieu = $1 AND TenantId = $2 FOR UPDATE',
                    [maPhieu, tenantId]
                );
                if (pRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy phiếu điều chuyển!');
                const phieu = pRes.rows[0];
                if (phieu.trangthai === 'COMPLETED') throw new LoiNghiepVu(409, 'Phiếu này đã hoàn tất trước đó!');
                const wasInTransit = phieu.trangthai === 'IN_TRANSIT';

                const ctRes = await client.query(
                    'SELECT id, MaNL, SoLuong, COALESCE(DonGiaVon, 0) AS DonGiaVon FROM ChiTietDieuChuyenKho WHERE MaPhieu = $1 AND TenantId = $2 ORDER BY MaNL ASC',
                    [maPhieu, tenantId]
                );
                const maNLList = ctRes.rows.map((r) => r.manl);

                const srcLock = await lockBranchStockOrdered(client, tenantId, phieu.tubranchid, maNLList);
                const dstLock = await lockBranchStockOrdered(client, tenantId, phieu.denbranchid, maNLList);

                // Nếu hoàn tất trực tiếp từ PENDING (chưa bấm dispatch) -> trừ kho nguồn luôn để tương thích ngược!
                if (!wasInTransit) {
                    const pXuat = await client.query(
                        `INSERT INTO public.phieugiaodichkho (manv, loaigd, ghichu, tenantid, branchid, ngaychungtu, trangthaiduyet)
                         VALUES ($1, 4, $2, $3, $4, $5::date, 'POSTED')
                         RETURNING magiaodich`,
                        [req.user.maNV, `Xuất điều chuyển trực tiếp ${maPhieu} -> ${phieu.denbranchid}`, tenantId, srcLock.branchId, todayDateVN()]
                    );
                    for (const item of ctRes.rows) {
                        const stSrc = srcLock.stockMap.get(item.manl);
                        const qty = lam3(item.soluong);
                        const cost = lam4(stSrc?.giaVonDonVi || item.dongiavon || 0);
                        item.dongiavon = cost;
                        const srcAfter = lam3((stSrc?.soLuongTon || 0) - qty);
                        await updateBranchStockRow(client, {
                            tenantId,
                            branchId: srcLock.branchId,
                            maNL: item.manl,
                            nextQty: srcAfter,
                        });
                        await insertLedgerLine(client, {
                            maGiaoDich: pXuat.rows[0].magiaodich,
                            maNL: item.manl,
                            soLuong: qty,
                            donGiaNhap: cost,
                            tinhTrang: `Xuất điều chuyển ${maPhieu}`,
                            tonTruoc: stSrc?.soLuongTon || 0,
                            tonSau: srcAfter,
                            giaVonTruoc: cost,
                            giaVonSau: cost,
                        });
                    }
                }

                const pNhap = await client.query(
                    `INSERT INTO public.phieugiaodichkho (manv, loaigd, ghichu, tenantid, branchid, ngaychungtu, trangthaiduyet)
                     VALUES ($1, 5, $2, $3, $4, $5::date, 'POSTED')
                     RETURNING magiaodich`,
                    [req.user.maNV, `Nhận điều chuyển ${maPhieu} từ ${phieu.tubranchid}`, tenantId, dstLock.branchId, todayDateVN()]
                );
                const maGDNhap = pNhap.rows[0].magiaodich;

                const discrepancies = [];
                for (const item of ctRes.rows) {
                    const stDst = dstLock.stockMap.get(item.manl);
                    const shippedQty = lam3(item.soluong);
                    const custom = recvMap.get(item.manl);
                    const actualRecv =
                        custom && custom.soLuongThucNhan !== undefined
                            ? Math.max(0, lam3(custom.soLuongThucNhan))
                            : shippedQty;
                    const noteDiff = custom?.ghiChuChenhLech ? String(custom.ghiChuChenhLech).slice(0, 255) : null;
                    const transferCost = lam4(Number(item.dongiavon || stDst?.giaVonDonVi || 0));

                    await client.query(
                        `UPDATE ChiTietDieuChuyenKho
                            SET SoLuongThucNhan = $2::numeric, GhiChuChenhLech = $3::text
                          WHERE id = $1::bigint`,
                        [Number(item.id), actualRecv, noteDiff]
                    );

                    // Gỡ TonDangChuyen (nếu đã dispatch IN_TRANSIT)
                    if (wasInTransit) {
                        await client.query(
                            `UPDATE public.tonkhochinhanh
                                SET tondangchuyen = GREATEST(0, COALESCE(tondangchuyen, 0) - $4::numeric),
                                    capnhatluc = now()
                              WHERE tenantid = $1::text AND branchid = $2::text AND manl = $3::text`,
                            [tenantId, dstLock.branchId, item.manl, shippedQty]
                        );
                    }

                    // Cộng SoLuongThucNhan vào kho đích + cập nhật Safe WAC theo DonGiaVon từ kho nguồn!
                    const dstBefore = stDst ? stDst.soLuongTon : 0;
                    const dstWacBefore = stDst ? stDst.giaVonDonVi : 0;
                    const wacDst = computeSafeWacOnStockIn({
                        tonCu: dstBefore,
                        giaVonCu: dstWacBefore,
                        slNhapBase: actualRecv,
                        tongTienHang: actualRecv * transferCost,
                    });
                    const dstAfter = lam3(dstBefore + actualRecv);

                    await updateBranchStockRow(client, {
                        tenantId,
                        branchId: dstLock.branchId,
                        maNL: item.manl,
                        nextQty: dstAfter,
                        nextWac: actualRecv > 0 ? wacDst.giaVonMoi : dstWacBefore,
                    });

                    await insertLedgerLine(client, {
                        maGiaoDich: maGDNhap,
                        maNL: item.manl,
                        soLuong: actualRecv,
                        donGiaNhap: transferCost,
                        tinhTrang: `Nhận hàng ${maPhieu} (xuất ${shippedQty}, thực nhận ${actualRecv})`,
                        tonTruoc: dstBefore,
                        tonSau: dstAfter,
                        giaVonTruoc: dstWacBefore,
                        giaVonSau: actualRecv > 0 ? wacDst.giaVonMoi : dstWacBefore,
                    });

                    // Nếu thực nhận < xuất kho -> tự sinh phiếu hao hụt vận chuyển (DAMAGED_DELIVERY)!
                    const lostQty = lam3(shippedQty - actualRecv);
                    if (lostQty > 0) {
                        discrepancies.push({
                            maNL: item.manl,
                            shippedQty,
                            actualRecv,
                            lostQty,
                            unitCost: transferCost,
                            lostValue: Math.round(lostQty * transferCost),
                            note: noteDiff || `Hao hụt vận chuyển phiếu ${maPhieu}`,
                        });
                    }
                }

                let discrepancyReceiptId = null;
                if (discrepancies.length > 0) {
                    const pLoss = await client.query(
                        `INSERT INTO public.phieugiaodichkho
                            (manv, loaigd, ghichu, tenantid, branchid, malydohuy, ngaychungtu, trangthaiduyet)
                         VALUES ($1, 2, $2, $3, $4, 'DAMAGED_DELIVERY', $5::date, 'POSTED')
                         RETURNING magiaodich`,
                        [
                            req.user.maNV,
                            `Hao hụt vận chuyển phiếu điều chuyển ${maPhieu}`,
                            tenantId,
                            dstLock.branchId,
                            todayDateVN(),
                        ]
                    );
                    discrepancyReceiptId = pLoss.rows[0].magiaodich;
                    for (const d of discrepancies) {
                        await insertLedgerLine(client, {
                            maGiaoDich: discrepancyReceiptId,
                            maNL: d.maNL,
                            soLuong: d.lostQty,
                            donGiaNhap: d.unitCost,
                            tinhTrang: d.note,
                        });
                    }
                }

                await client.query(
                    `UPDATE PhieuDieuChuyenKho
                        SET TrangThai = 'COMPLETED', MaNVNhan = $3, ThoiGianHoanTat = now()
                      WHERE MaPhieu = $1 AND TenantId = $2`,
                    [maPhieu, tenantId, req.user.maNV]
                );

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'BRANCH_TRANSFER_COMPLETED',
                    doiTuong: 'DIEU_CHUYEN_KHO',
                    maDoiTuong: maPhieu,
                    giaTriMoi: {
                        tuBranchId: phieu.tubranchid,
                        denBranchId: phieu.denbranchid,
                        soDong: ctRes.rows.length,
                        discrepancies,
                        discrepancyReceiptId,
                    },
                    ip: req.ip,
                });

                return { maPhieu, trangThai: 'COMPLETED', maGDNhap, discrepancyReceiptId, discrepancies };
            }, tenantId);

            res.json({
                message:
                    out.discrepancies.length > 0
                        ? `✅ Đã kiểm nhận phiếu ${maPhieu} & tự động lập phiếu hao hụt vận chuyển #${out.discrepancyReceiptId}!`
                        : `✅ Đã xác nhận hoàn tất điều chuyển kho ${maPhieu}!`,
                ...out,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Hoàn tất điều chuyển kho:');
        }
    });

    // =========================================================================
    // D. AGGREGATOR HUB (GRABFOOD / SHOPEEFOOD / BEFOOD)
    // =========================================================================

    app.get('/api/aggregators/orders', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const r = await qTenant(
                req,
                `SELECT MaDonSan, NenTang, MaDonNgoai, TenKhach, SoDienThoai, TenTaiXe, BienSoXe,
                        TrangThai, TongTienHang, PhiChietKhauSan, DoanhThuThucNhan,
                        DanhSachMon, GhiChu, MaHoaDonPos, ThoiGianTao, ThoiGianCapNhat
                   FROM DonSanGiaoHang
                  WHERE TenantId = $1
                  ORDER BY CASE WHEN TrangThai IN ('NEW', 'ACCEPTED', 'READY') THEN 0 ELSE 1 END,
                           ThoiGianTao DESC
                  LIMIT 60`,
                [tenantId]
            );
            const orders = r.rows.map((o) => ({
                maDonSan: o.madonsan,
                nenTang: o.nentang,
                maDonNgoai: o.madonngoai,
                tenKhach: o.tenkhach,
                soDienThoai: o.sodienthoai,
                tenTaiXe: o.tentaixe,
                bienSoXe: o.biensoxe,
                trangThai: o.trangthai,
                tongTienHang: Number(o.tongtienhang || 0),
                phiChietKhauSan: Number(o.phichietkhausan || 0),
                doanhThuThucNhan: Number(o.doanhthuthucnhan || 0),
                danhSachMon: Array.isArray(o.danhsachmon) ? o.danhsachmon : [],
                ghiChu: o.ghichu || '',
                maHoaDonPos: o.mahoadonpos,
                thoiGianTao: o.thoigiantao,
            }));

            const summary = ['GRABFOOD', 'SHOPEEFOOD', 'BEFOOD'].map((pf) => {
                const sub = orders.filter((x) => x.nenTang === pf && x.trangThai !== 'CANCELLED');
                return {
                    nenTang: pf,
                    soDon: sub.length,
                    tongTienHang: sub.reduce((s, x) => s + x.tongTienHang, 0),
                    tongPhiSan: sub.reduce((s, x) => s + x.phiChietKhauSan, 0),
                    doanhThuThucNhan: sub.reduce((s, x) => s + x.doanhThuThucNhan, 0),
                };
            });

            res.json({ summary, orders });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Aggregator Hub:');
        }
    });

    // Mô phỏng / Nhận đơn từ sàn GrabFood / ShopeeFood / BeFood trực tiếp vào POS
    app.post('/api/aggregators/simulate', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const nenTang = ['GRABFOOD', 'SHOPEEFOOD', 'BEFOOD'].includes(String(req.body?.nenTang || 'GRABFOOD').toUpperCase())
            ? String(req.body?.nenTang || 'GRABFOOD').toUpperCase()
            : 'GRABFOOD';
        try {
            const ketQua = await chayGiaoDich(async (client) => {
                // Lấy 1-2 món đang bán thật của quán để tạo đơn thực tế
                const spRes = await client.query(
                    `SELECT sp.MaMon, sp.TenMon, sz.KichThuoc, sz.GiaBan
                       FROM SanPham sp
                       JOIN SanPham_Size sz ON sp.MaMon = sz.MaMon
                      WHERE sp.DangKinhDoanh = TRUE AND COALESCE(sp.TamHet, FALSE) = FALSE
                        AND COALESCE(sp.TenantId, 'DEFAULT') = $1
                      ORDER BY random() LIMIT 2`,
                    [tenantId]
                );
                if (spRes.rows.length === 0) {
                    throw new LoiNghiepVu(400, 'Quán chưa có món đang kinh doanh để tạo đơn sàn giao hàng!');
                }
                const items = spRes.rows.map((s) => ({
                    maMon: s.mamon,
                    tenMon: s.tenmon,
                    kichThuoc: s.kichthuoc,
                    soLuong: 1 + Math.floor(Math.random() * 2),
                    donGia: parseFloat(s.giaban),
                    ghiChu: 'Ít đá, để riêng ống hút',
                }));
                const tongTienHang = items.reduce((sum, i) => sum + i.donGia * i.soLuong, 0);
                const feeRate = AGGREGATOR_COMMISSION[nenTang] || 0.22;
                const phiChietKhauSan = Math.round(tongTienHang * feeRate);
                const doanhThuThucNhan = tongTienHang - phiChietKhauSan;

                const prefix = nenTang === 'GRABFOOD' ? 'GF' : nenTang === 'SHOPEEFOOD' ? 'SF' : 'BF';
                const maDonNgoai = `${prefix}-${Math.floor(100000 + Math.random() * 899999)}`;
                const maDonSan = `AGG_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

                await client.query(
                    `INSERT INTO DonSanGiaoHang
                        (MaDonSan, TenantId, NenTang, MaDonNgoai, TenKhach, SoDienThoai, TenTaiXe, BienSoXe,
                         TrangThai, TongTienHang, PhiChietKhauSan, DoanhThuThucNhan, DanhSachMon, GhiChu)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'NEW', $9, $10, $11, $12::jsonb, $13)`,
                    [
                        maDonSan,
                        tenantId,
                        nenTang,
                        maDonNgoai,
                        req.body?.tenKhach || 'Nguyễn Minh Anh (App)',
                        '0909' + String(Math.floor(100000 + Math.random() * 899999)),
                        nenTang === 'GRABFOOD' ? 'Tài xế Grab - Lê Văn Hùng' : nenTang === 'SHOPEEFOOD' ? 'Tài xế Shopee - Trần Quốc Bảo' : 'Tài xế Be - Phạm Đức Duy',
                        '59X3-' + String(Math.floor(10000 + Math.random() * 89999)),
                        tongTienHang,
                        phiChietKhauSan,
                        doanhThuThucNhan,
                        JSON.stringify(items),
                        `Đơn tự động đồng bộ từ ${nenTang} (Chiết khấu sàn ${Math.round(feeRate * 100)}%)`,
                    ]
                );

                return { maDonSan, nenTang, maDonNgoai, tongTienHang, phiChietKhauSan, doanhThuThucNhan, danhSachMon: items };
            }, tenantId);

            io.to(roomTen(tenantId, 'thungan')).emit('AGGREGATOR_ORDER_MOI', ketQua);
            res.status(201).json({
                message: `🛵 Có đơn mới từ ${ketQua.nenTang} (${ketQua.maDonNgoai}) — Bấm Nhận đơn 1 chạm để đẩy thẳng xuống Bar!`,
                order: ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Nhận đơn Aggregator:');
        }
    });

    // Nhận đơn từ Sàn -> 1 chạm tự tạo Hóa đơn POS + đẩy thẳng xuống KDS Barista (không phải gõ tay lại!)
    app.post('/api/aggregators/orders/:maDonSan/accept', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const maDonSan = String(req.params.maDonSan || '').trim();
        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const r = await client.query(
                    'SELECT * FROM DonSanGiaoHang WHERE MaDonSan = $1 AND TenantId = $2 FOR UPDATE',
                    [maDonSan, tenantId]
                );
                if (r.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy đơn sàn giao hàng!');
                const agg = r.rows[0];
                if (agg.trangthai !== 'NEW') {
                    throw new LoiNghiepVu(409, `Đơn ${agg.madonngoai} đã ở trạng thái ${agg.trangthai}!`);
                }

                const items = Array.isArray(agg.danhsachmon) ? agg.danhsachmon : [];
                const orderRes = await taoDonHangTrongGiaoDich(client, {
                    maBan: null,
                    maKH: null,
                    maNV: req.user.maNV,
                    tenantId,
                    allowNegativeStock: true,
                    danhSachMon: items.map((i) => ({
                        maMon: i.maMon,
                        kichThuoc: i.kichThuoc || 'M',
                        soLuong: Number(i.soLuong || 1),
                        ghiChu: `[${agg.nentang} #${agg.madonngoai}] ${i.ghiChu || ''}`.trim(),
                        toppings: [],
                    })),
                });

                await client.query(
                    `UPDATE DonSanGiaoHang
                        SET TrangThai = 'ACCEPTED', MaHoaDonPos = $3, ThoiGianCapNhat = now()
                      WHERE MaDonSan = $1 AND TenantId = $2`,
                    [maDonSan, tenantId, String(orderRes.maHoaDon)]
                );

                return { maDonSan, nenTang: agg.nentang, maDonNgoai: agg.madonngoai, maHoaDonPos: orderRes.maHoaDon, soMon: orderRes.soMonMoi };
            }, tenantId);

            io.to(roomTen(tenantId, 'barista')).emit('DON_MOI', {
                maHoaDon: ketQua.maHoaDonPos,
                nguon: ketQua.nenTang,
                soLuongMon: ketQua.soMon,
            });
            io.to(roomTen(tenantId, 'thungan')).emit('AGGREGATOR_ORDER_CAP_NHAT', {
                maDonSan,
                trangThai: 'ACCEPTED',
                maHoaDonPos: ketQua.maHoaDonPos,
            });

            res.json({
                message: `✅ Đã nhận đơn ${ketQua.nenTang} #${ketQua.maDonNgoai} → Tạo HĐ POS #${ketQua.maHoaDonPos} & chuyển Barista!`,
                ...ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Nhận đơn Aggregator vào POS:');
        }
    });

    app.put('/api/aggregators/orders/:maDonSan/status', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const maDonSan = String(req.params.maDonSan || '').trim();
        const trangThai = String(req.body?.trangThai || '').toUpperCase();
        if (!['READY', 'PICKED_UP', 'CANCELLED'].includes(trangThai)) {
            return res.status(400).json({ message: 'trangThai phải là READY, PICKED_UP hoặc CANCELLED!' });
        }
        try {
            const r = await qTenant(
                req,
                `UPDATE DonSanGiaoHang SET TrangThai = $3, ThoiGianCapNhat = now()
                  WHERE MaDonSan = $1 AND TenantId = $2 RETURNING MaDonSan, TrangThai`,
                [maDonSan, tenantId, trangThai]
            );
            if (r.rows.length === 0) return res.status(404).json({ message: 'Không tìm thấy đơn sàn!' });
            res.json({ message: `Đã cập nhật trạng thái đơn sang ${trangThai}!`, order: r.rows[0] });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Cập nhật đơn Aggregator:');
        }
    });

    // =========================================================================
    // E. ĐA MÔ HÌNH F&B NGANG: TÍNH GIỜ (BIDA/BOARDGAME/COWORKING) & LÔ BÁNH 19H
    // =========================================================================

    app.get('/api/time-billing/active', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const r = await qTenant(
                req,
                `SELECT p.MaPhien, p.MaBan, b.TenBan, b.KhuVuc, p.MaHoaDon, p.LoaiDichVu,
                        p.DonGiaTheoGio, p.KhungGioCaoDiem, p.BatDauLuc, p.KetThucLuc,
                        p.TrangThai, p.SoPhutTamDung, p.TongTienGio
                   FROM PhienTinhGio p
                   LEFT JOIN Ban b ON b.MaBan = p.MaBan AND COALESCE(b.TenantId, 'DEFAULT') = $1
                  WHERE p.TenantId = $1
                  ORDER BY CASE WHEN p.TrangThai = 'RUNNING' THEN 0 ELSE 1 END, p.BatDauLuc DESC
                  LIMIT 40`,
                [tenantId]
            );
            const now = new Date();
            res.json(
                r.rows.map((p) => {
                    const live = p.trangthai === 'RUNNING'
                        ? tinhTienPhienGio({
                              batDauLuc: p.batdauluc,
                              ketThucLuc: now,
                              donGiaTheoGio: Number(p.dongiatheogio || 0),
                              khungGioCaoDiem: p.khunggiocaodiem,
                              soPhutTamDung: Number(p.sophuttamdung || 0),
                          })
                        : {
                              soPhutSuDung: Math.max(
                                  1,
                                  Math.ceil(((p.ketthucluc ? new Date(p.ketthucluc).getTime() : Date.now()) - new Date(p.batdauluc).getTime()) / 60000)
                              ),
                              tongTienGio: Number(p.tongtiengio || 0),
                          };
                    return {
                        maPhien: p.maphien,
                        maBan: p.maban,
                        tenBan: p.tenban || p.maban,
                        khuVuc: p.khuvuc || '',
                        maHoaDon: p.mahoadon,
                        loaiDichVu: p.loaidichvu,
                        tenDichVu: TIME_SERVICE_DEFAULTS[p.loaidichvu]?.label || p.loaidichvu,
                        donGiaTheoGio: Number(p.dongiatheogio || 0),
                        khungGioCaoDiem: p.khunggiocaodiem,
                        batDauLuc: p.batdauluc,
                        ketThucLuc: p.ketthucluc,
                        trangThai: p.trangthai,
                        ...live,
                    };
                })
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Danh sách phiên tính giờ:');
        }
    });

    app.post('/api/time-billing/start', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const {
            maBan,
            loaiDichVu = 'BIDA',
            donGiaTheoGio,
            khungGioCaoDiem = { startHour: 18, endHour: 23, multiplier: 1.25 },
        } = req.body || {};

        if (!maBan) return res.status(400).json({ message: 'Vui lòng chọn Bàn / Phòng để bắt đầu bấm giờ!' });
        const svcType = TIME_SERVICE_DEFAULTS[loaiDichVu] ? loaiDichVu : 'BIDA';
        const rate = donGiaTheoGio !== undefined ? Number(donGiaTheoGio) : TIME_SERVICE_DEFAULTS[svcType].ratePerHour;
        if (!(rate >= 0)) return res.status(400).json({ message: 'Đơn giá theo giờ không hợp lệ!' });

        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const banRes = await client.query(
                    "SELECT MaBan, TenBan, BranchId FROM Ban WHERE MaBan = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2 FOR UPDATE",
                    [maBan, tenantId]
                );
                if (banRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy bàn!');

                const running = await client.query(
                    "SELECT MaPhien FROM PhienTinhGio WHERE TenantId = $1 AND MaBan = $2 AND TrangThai = 'RUNNING' LIMIT 1",
                    [tenantId, maBan]
                );
                if (running.rows.length > 0) {
                    throw new LoiNghiepVu(409, `Bàn ${banRes.rows[0].tenban} đang có đồng hồ tính giờ chạy!`);
                }

                // Tìm hoặc mở hóa đơn cho bàn này
                const hdRes = await client.query(
                    `SELECT h.MaHoaDon FROM HoaDon_Ban hb JOIN HoaDon h ON h.MaHoaDon = hb.MaHoaDon
                      WHERE hb.MaBan = $1 AND h.TrangThaiTT = 0 AND COALESCE(h.TenantId, 'DEFAULT') = $2
                      ORDER BY h.ThoiGianTao DESC LIMIT 1`,
                    [maBan, tenantId]
                );
                let maHoaDon = hdRes.rows[0]?.mahoadon || null;
                if (!maHoaDon) {
                    const insHd = await client.query(
                        'INSERT INTO HoaDon (MaNV, TrangThaiTT, TenantId, BranchId) VALUES ($1, 0, $2, $3) RETURNING MaHoaDon',
                        [req.user.maNV, tenantId, banRes.rows[0].branchid || null]
                    );
                    maHoaDon = insHd.rows[0].mahoadon;
                    await client.query('INSERT INTO HoaDon_Ban (MaHoaDon, MaBan) VALUES ($1, $2)', [maHoaDon, maBan]);
                    await client.query('UPDATE Ban SET TrangThai = 2 WHERE MaBan = $1', [maBan]);
                }

                const maPhien = `TB_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
                await client.query(
                    `INSERT INTO PhienTinhGio
                        (MaPhien, TenantId, BranchId, MaBan, MaHoaDon, LoaiDichVu, DonGiaTheoGio, KhungGioCaoDiem, TrangThai, MaNV)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'RUNNING', $9)`,
                    [
                        maPhien,
                        tenantId,
                        banRes.rows[0].branchid || null,
                        maBan,
                        String(maHoaDon),
                        svcType,
                        rate,
                        JSON.stringify(khungGioCaoDiem),
                        req.user.maNV,
                    ]
                );

                return { maPhien, maBan, tenBan: banRes.rows[0].tenban, maHoaDon, loaiDichVu: svcType, donGiaTheoGio: rate };
            }, tenantId);

            io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('BAN_THAY_DOI', {
                maBan: ketQua.maBan,
                trangThai: 2,
            });

            res.status(201).json({
                message: `⏱️ Đã bắt đầu tính giờ ${TIME_SERVICE_DEFAULTS[svcType].label} tại ${ketQua.tenBan} (${rate.toLocaleString('vi-VN')}đ/giờ)!`,
                session: ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Bắt đầu tính giờ:');
        }
    });

    app.post('/api/time-billing/:maPhien/stop', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const maPhien = String(req.params.maPhien || '').trim();
        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const r = await client.query(
                    'SELECT * FROM PhienTinhGio WHERE MaPhien = $1 AND TenantId = $2 FOR UPDATE',
                    [maPhien, tenantId]
                );
                if (r.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy phiên tính giờ!');
                const p = r.rows[0];
                if (p.trangthai !== 'RUNNING') throw new LoiNghiepVu(409, 'Phiên tính giờ này đã kết thúc!');

                const now = new Date();
                const calc = tinhTienPhienGio({
                    batDauLuc: p.batdauluc,
                    ketThucLuc: now,
                    donGiaTheoGio: Number(p.dongiatheogio || 0),
                    khungGioCaoDiem: p.khunggiocaodiem,
                    soPhutTamDung: Number(p.sophuttamdung || 0),
                });

                await client.query(
                    `UPDATE PhienTinhGio
                        SET TrangThai = 'BILLED', KetThucLuc = $3, TongTienGio = $4
                      WHERE MaPhien = $1 AND TenantId = $2`,
                    [maPhien, tenantId, now.toISOString(), calc.tongTienGio]
                );

                // Đảm bảo có mã món dịch vụ tính giờ trong SanPham (tạo 1 lần duy nhất cho tenant) để gắn sạch vào ChiTietHoaDon!
                const maMonGio = `SVC_TIME_${tenantId.slice(0, 8)}`;
                const svcLabel = TIME_SERVICE_DEFAULTS[p.loaidichvu]?.label || 'Tiền giờ dịch vụ';
                await client.query(
                    `INSERT INTO SanPham (MaMon, TenMon, NhomMon, GiaGoc, DangKinhDoanh, TamHet, TenantId)
                     VALUES ($1, 'Dịch vụ tính giờ (Bida/Boardgame/Co-working)', 'Dịch vụ giờ', 0, FALSE, FALSE, $2)
                     ON CONFLICT (MaMon) DO NOTHING`,
                    [maMonGio, tenantId]
                );

                if (p.mahoadon && calc.tongTienGio > 0) {
                    const note = `${svcLabel}: ${calc.soPhutSuDung} phút (${calc.soPhutCaoDiem > 0 ? `${calc.soPhutCaoDiem}p cao điểm x${calc.heSoCaoDiem}` : 'giờ thường'})`;
                    await client.query(
                        `INSERT INTO ChiTietHoaDon (MaHoaDon, MaMon, TenMonSnapshot, KichThuoc, SoLuong, DonGia, GiaVonSnapshot, GhiChu, TrangThaiPhaChe)
                         VALUES ($1, $2, $3, 'M', 1, $4, 0, $5, 'DaPhucVu')`,
                        [p.mahoadon, maMonGio, `⏱️ ${svcLabel} (${calc.soPhutSuDung}p)`, calc.tongTienGio, note]
                    );
                }

                return { maPhien, maBan: p.maban, maHoaDon: p.mahoadon, ...calc };
            }, tenantId);

            res.json({
                message: `⏹️ Đã dừng đồng hồ (${ketQua.soPhutSuDung} phút) — Cộng ${ketQua.tongTienGio.toLocaleString('vi-VN')}đ vào HĐ #${ketQua.maHoaDon}!`,
                result: ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Dừng phiên tính giờ:');
        }
    });

    // Quản lý Lô bánh trong ngày (Tự động giảm giá 50% sau 19h cho Bakery)
    app.get('/api/bakery/batches', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const { dateISO } = layGioHienTaiVN();
        const ngay = String(req.query.ngay || dateISO);
        try {
            const r = await qTenant(
                req,
                `SELECT MaLo, MaMon, TenMon, NgaySanXuat, SoLuongSanXuat, SoLuongConLai,
                        GioGiamGia, PhanTramGiam, GiaGoc, TrangThai, ThoiGianTao
                   FROM LoBanhNgay
                  WHERE TenantId = $1 AND NgaySanXuat = $2::date
                  ORDER BY ThoiGianTao DESC`,
                [tenantId, ngay]
            );
            res.json(
                r.rows.map((b) => {
                    const calc = tinhGiaLoBanhHienTai({
                        giaGoc: Number(b.giagoc || 0),
                        gioGiamGia: Number(b.giogiamgia ?? 19),
                        phanTramGiam: Number(b.phantramgiam ?? 50),
                    });
                    return {
                        maLo: b.malo,
                        maMon: b.mamon,
                        tenMon: b.tenmon,
                        ngaySanXuat: b.ngaysanxuat,
                        soLuongSanXuat: Number(b.soluongsanxuat),
                        soLuongConLai: Number(b.soluongconlai),
                        trangThai: b.trangthai,
                        ...calc,
                    };
                })
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Danh sách Lô bánh:');
        }
    });

    app.post('/api/bakery/batches', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const { maMon, soLuongSanXuat = 20, gioGiamGia = 19, phanTramGiam = 50 } = req.body || {};
        if (!maMon || !(Number(soLuongSanXuat) > 0)) {
            return res.status(400).json({ message: 'Vui lòng chọn món bánh và số lượng nướng trong ngày > 0!' });
        }
        try {
            const { dateISO } = layGioHienTaiVN();
            const ketQua = await chayGiaoDich(async (client) => {
                const spRes = await client.query(
                    `SELECT sp.MaMon, sp.TenMon, COALESCE(MIN(sz.GiaBan), sp.GiaGoc, 0) AS GiaGoc
                       FROM SanPham sp
                       LEFT JOIN SanPham_Size sz ON sz.MaMon = sp.MaMon
                      WHERE sp.MaMon = $1 AND COALESCE(sp.TenantId, 'DEFAULT') = $2
                      GROUP BY sp.MaMon, sp.TenMon, sp.GiaGoc`,
                    [maMon, tenantId]
                );
                if (spRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy món bánh trong thực đơn!');
                const sp = spRes.rows[0];
                const maLo = `BAK_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
                const gio = Math.min(23, Math.max(0, parseInt(gioGiamGia, 10) || 19));
                const pct = Math.min(95, Math.max(0, parseInt(phanTramGiam, 10) || 50));
                const sl = parseInt(soLuongSanXuat, 10);

                await client.query(
                    `INSERT INTO LoBanhNgay
                        (MaLo, TenantId, MaMon, TenMon, NgaySanXuat, SoLuongSanXuat, SoLuongConLai, GioGiamGia, PhanTramGiam, GiaGoc, TrangThai)
                     VALUES ($1, $2, $3, $4, $5::date, $6, $6, $7, $8, $9, 'ACTIVE')`,
                    [maLo, tenantId, sp.mamon, sp.tenmon, dateISO, sl, gio, pct, Number(sp.giagoc || 0)]
                );
                return { maLo, tenMon: sp.tenmon, soLuongSanXuat: sl, gioGiamGia: gio, phanTramGiam: pct };
            }, tenantId);

            res.status(201).json({
                message: `🥐 Đã nhập lô ${ketQua.soLuongSanXuat} "${ketQua.tenMon}" — Tự động giảm ${ketQua.phanTramGiam}% sau ${ketQua.gioGiamGia}h!`,
                batch: ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Tạo Lô bánh:');
        }
    });

    app.put('/api/bakery/batches/:maLo', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const maLo = String(req.params.maLo || '').trim();
        const { soLuongConLai, trangThai } = req.body || {};
        try {
            const r = await qTenant(
                req,
                `UPDATE LoBanhNgay
                    SET SoLuongConLai = COALESCE($3, SoLuongConLai),
                        TrangThai = COALESCE($4, CASE WHEN COALESCE($3, SoLuongConLai) = 0 THEN 'SOLD_OUT' ELSE TrangThai END)
                  WHERE MaLo = $1 AND TenantId = $2
                  RETURNING MaLo, TenMon, SoLuongConLai, TrangThai`,
                [
                    maLo,
                    tenantId,
                    soLuongConLai !== undefined ? Math.max(0, parseInt(soLuongConLai, 10) || 0) : null,
                    trangThai && ['ACTIVE', 'MARKDOWN', 'SOLD_OUT', 'DISCARDED'].includes(trangThai) ? trangThai : null,
                ]
            );
            if (r.rows.length === 0) return res.status(404).json({ message: 'Không tìm thấy lô bánh!' });
            res.json({ message: 'Đã cập nhật tồn lô bánh!', batch: r.rows[0] });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Cập nhật lô bánh:');
        }
    });

    // =========================================================================
    // F. AI DEMAND FORECASTING (60 NGÀY + THỨ TRONG TUẦN) & SMART UPSELL
    // =========================================================================

    app.get('/api/ai/demand-forecast', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const [histRes, stockRes] = await Promise.all([
                qTenant(
                    req,
                    `SELECT
                        ct.MaNL,
                        (pg.ThoiGianTao::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS Ngay,
                        EXTRACT(DOW FROM (pg.ThoiGianTao::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh'))::int AS ThuTrongTuan,
                        (pg.ThoiGianTao >= now() - interval '14 days') AS Trong14Ngay,
                        SUM(ABS(ct.SoLuong)) AS TongTieuHao
                       FROM PhieuGiaoDichKho pg
                       JOIN ChiTietGiaoDichKho ct ON ct.MaGiaoDich = pg.MaGiaoDich
                      WHERE COALESCE(pg.TenantId, 'DEFAULT') = $1
                        AND pg.LoaiGD = 6
                        AND pg.ThoiGianTao >= now() - interval '60 days'
                      GROUP BY ct.MaNL, Ngay, ThuTrongTuan, Trong14Ngay`,
                    [tenantId]
                ),
                qTenant(
                    req,
                    `SELECT MaNL, TenNL, DonViTinh, SoLuongTon, HanMucCanhBao, COALESCE(GiaVonDonVi, 0) AS GiaVonDonVi
                       FROM NguyenLieu
                      WHERE COALESCE(TenantId, 'DEFAULT') = $1 AND DaXoa = FALSE
                      ORDER BY TenNL`,
                    [tenantId]
                ),
            ]);

            const forecast = tinhDuBaoNhapKho60Ngay(histRes.rows, stockRes.rows);
            res.json(forecast);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API AI Dự báo nhập kho 60 ngày:');
        }
    });

    app.get('/api/ai/smart-upsell', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const rawCart = String(req.query.cartMaMon || '').trim();
        const cartMaMonList = rawCart ? rawCart.split(',').map((s) => s.trim()).filter(Boolean) : [];

        try {
            const data = await pool.withTenant(tenantId, async (client) => {
                const { menu } = await taiThucDonChoQr(client, tenantId, null);
                const bakeryMap = await layBanDoGiamGiaLoBanhHomNay(client, tenantId);

                let coRows = [];
                if (cartMaMonList.length > 0) {
                    const coRes = await client.query(
                        `SELECT c2.MaMon, COUNT(DISTINCT c2.MaHoaDon) AS SoLanCungMua
                           FROM ChiTietHoaDon c1
                           JOIN ChiTietHoaDon c2
                             ON c2.MaHoaDon = c1.MaHoaDon AND c2.MaMon <> c1.MaMon
                           JOIN HoaDon h ON h.MaHoaDon = c1.MaHoaDon
                          WHERE COALESCE(h.TenantId, 'DEFAULT') = $1
                            AND h.TrangThaiTT = 1
                            AND h.ThoiGianTao >= now() - interval '60 days'
                            AND c1.MaMon = ANY($2::varchar[])
                            AND NOT (c2.MaMon = ANY($2::varchar[]))
                            AND c2.TrangThaiPhaChe <> 'DaHuy'
                          GROUP BY c2.MaMon
                          ORDER BY SoLanCungMua DESC
                          LIMIT 8`,
                        [tenantId, cartMaMonList]
                    );
                    coRows = coRes.rows;
                }

                return goiYBanKemSmartUpsell({
                    cartMaMonList,
                    coOccurrenceRows: coRows,
                    menuItems: menu,
                    bakeryMarkdownMap: bakeryMap,
                });
            });

            res.json({ suggestions: data });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Smart Upsell:');
        }
    });
}

module.exports = {
    CRM_TIERS,
    AGGREGATOR_COMMISSION,
    TIME_SERVICE_DEFAULTS,
    taoQrTokenMoi,
    layGioHienTaiVN,
    tinhHangThanhVien,
    tinhGiaLoBanhHienTai,
    tinhTienPhienGio,
    tinhDuBaoNhapKho60Ngay,
    goiYBanKemSmartUpsell,
    xoayQrTokenChoCacBan,
    capNhatCrmVaZnsSauThanhToan,
    layBanDoGiamGiaLoBanhHomNay,
    registerEcosystemPhase8Routes,
};
