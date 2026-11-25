'use strict';

const crypto = require('crypto');
const {
    SIZE_HOP_LE,
    TRAM_CHE_BIEN_HOP_LE,
    PHUONG_THUC_TT,
    PHUONG_THUC_LEGACY,
    LOAI_GD_TIEU_HAO,
    LOAI_GD_HOAN_KHO,
    LOAI_GD_HAO_HUT_HUY_MON,
    VN_TZ,
    ALLOW_NEGATIVE_STOCK,
    DIEM_MOI_VND,
    CASH_PAYOUT_LIMIT_VND,
    suyLuanTramCheBien,
    ngayHomNayVN,
    LoiNghiepVu,
    roomTen,
    lam3,
} = require('./auditAndSecurity');
const {
    tinhGiaToppingBacThang,
    danhGiaModifiersChoMon,
    tinhBomMotLySauSubstitution,
    phanBoGiaComboProRata,
    chiaDeuTienVND,
    tinhTongKeToanHoaDon,
    capSoThuTuNgayKhongTrung,
    kiemTraVaTangVersionHoaDon,
    recalculateInvoiceTotals,
    phaVoComboKhiHuyMon,
    taoComboGroupUid,
} = require('../../modules/fohEngineService');
const {
    VALID_STATIONS,
    normalizeBranchId,
    normalizeStation,
    roomBranchPos,
    roomBranchKds,
    roomBranchExpo,
    roomBranchWaiter,
    roomBranchQr,
    insertKdsEventLog,
    emitScopedKdsEvent,
    recordAndEmitOrderNewByStation,
    cascadeIngredient86,
    loadBranchAvailability86Map,
} = require('../../modules/kdsPhase2Engine');
const {
    DEFAULT_SHIFT_POLICY,
    normalizeBranchForShift,
    normalizeTerminalId,
    computeDenominationTotal,
    getTenantShiftPolicy,
} = require('../../modules/paymentShiftPhase3Engine');
const {
    lam4,
    lam2,
    normalizeInventoryBranch,
    todayDateVN,
    ensureBranchRecord,
    lockBranchStockOrdered,
    updateBranchStockRow,
    insertLedgerLine,
    assertPeriodNotLocked,
    consumeFefoBatches,
    lookupHistoricalWac,
} = require('../../modules/inventoryCogsPhase4Engine');
const {
    tinhHangThanhVien,
    xoayQrTokenChoCacBan,
    capNhatCrmVaZnsSauThanhToan,
    layBanDoGiamGiaLoBanhHomNay,
} = require('../../modules/ecosystemPhase8Routes');
const {
    applyMixedRateTaxToOrder,
} = require('../../modules/vnTaxAndEInvoiceService');
const {
    kiemTraHopLeKhuyenMai,
    tinhUuDaiVaDiemTrongGiaoDich,
} = require('../../modules/promotionAndPinService');

function createOrderHelpers(deps) {
    const {
        pool,
        io,
        runtimeFlags,
        chayGiaoDich,
        ghiAuditLog,
        dispatchFraudAlertFromAudit,
        kiemTraCanhBaoTanSuatGianLan,
    } = deps;

// [P0 Trap #1 FIX] Chặn gọi thêm món / hủy món / tách đơn / gộp bàn khi hóa đơn đang khóa Khuyến mãi hoặc Đổi điểm
// Tránh lệch điều kiện DonToiThieu, lệch số tiền giảm hoặc mất điểm khách hàng đã trừ tạm trên HoaDon!
async function chanSuaDonDangCoUuDai(client, maHoaDon, hanhDong = 'thay đổi món') {
    await client.query('SAVEPOINT sp_chk_uudai_lock');
    let row = null;
    try {
        const r = await client.query(
            `SELECT MaKhuyenMai, COALESCE(TienGiamKM, 0) AS TienGiamKM, COALESCE(DiemSuDung, 0) AS DiemSuDung
               FROM HoaDon WHERE MaHoaDon = $1`,
            [maHoaDon]
        );
        await client.query('RELEASE SAVEPOINT sp_chk_uudai_lock');
        row = r.rows[0] || null;
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_chk_uudai_lock').catch(() => {});
        return;
    }
    if (row && (Number(row.tiengiamkm || 0) > 0 || Number(row.diemsudung || 0) > 0 || Boolean(row.makhuyenmai))) {
        throw new LoiNghiepVu(
            409,
            `Hóa đơn #${maHoaDon} đang áp mã giảm giá / đổi điểm Loyalty! Vui lòng bấm "✕ Gỡ ưu đãi" trước khi ${hanhDong}.`,
            { maLoi: 'CO_UU_DAI_CHUA_GO' }
        );
    }
}

// Ca thu ngân đang mở theo từng Tenant (+ tùy chọn BranchId & TerminalId cho đa quầy POS)
const KIEU_KHOA = { UPDATE: ' FOR UPDATE', SHARE: ' FOR SHARE' };
async function layCaDangMo(db, kieuKhoa, tenantId = 'DEFAULT', { branchId = null, terminalId = null } = {}) {
    const tId = String(tenantId || 'DEFAULT');
    const bFilter = branchId ? normalizeBranchForShift(tId, branchId) : null;
    const termFilter = terminalId ? normalizeTerminalId(terminalId) : null;
    const r = await db.query(
        `SELECT MaCaThuNgan, MaNV, ThoiGianMoCa, TienMatDauCa,
                COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'branchid', ''), $1::text || '_MAIN') AS BranchId,
                COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'terminalid', ''), 'POS_01') AS TerminalId,
                COALESCE((to_jsonb(CaThuNgan)->>'solandemlai')::int, 0) AS SoLanDemLai
           FROM CaThuNgan
          WHERE TrangThaiCa = 1
            AND COALESCE(TenantId::text, 'DEFAULT') = $1::text
            AND ($2::text IS NULL OR COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'branchid', ''), $1::text || '_MAIN') = $2::text)
            AND ($3::text IS NULL OR COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'terminalid', ''), 'POS_01') = $3::text)
          ORDER BY ThoiGianMoCa DESC
          LIMIT 1${KIEU_KHOA[kieuKhoa] || ''}`,
        [tId, bFilter, termFilter]
    );
    return r.rows[0] || null;
}

const loiChuaMoCa = () =>
    new LoiNghiepVu(409, 'Hệ thống chưa mở ca! Vui lòng mở ca thu ngân trước khi thực hiện thao tác này.', { maLoi: 'CHUA_MO_CA' });

// Chính sách hạch toán ca thống nhất cho đơn Offline (Phân hệ 7 + Phân hệ 3):
// 1. Nếu Ca gốc (maCaThuNganGoc) vẫn đang mở -> gắn vào đúng Ca gốc.
// 2. Nếu Ca gốc đã đóng nhưng hiện có Ca mới (Ca 2) đang mở -> tự động hạch toán vào Ca hiện tại kèm cờ laOfflineLechCa=true (TUYỆT ĐỐI không sửa ngược ZReportSnapshot của ca cũ!).
// 3. Nếu hiện không có bất kỳ ca nào mở -> báo 409 CHUA_MO_CA để Outbox giữ PENDING.
async function layCaChoGiaoDichOffline(client, { tenantId, maCaGoc = null, laOfflineSync = false, branchId = null, terminalId = null }) {
    let ca = await layCaDangMo(client, 'SHARE', tenantId, { branchId, terminalId });
    if (!ca && (branchId || terminalId)) {
        ca = await layCaDangMo(client, 'SHARE', tenantId);
    }
    let caGocDaDong = false;

    if (laOfflineSync && maCaGoc) {
        const caGocRes = await client.query(
            `SELECT MaCaThuNgan, MaNV, ThoiGianMoCa, TienMatDauCa, TrangThaiCa,
                    COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'branchid', ''), $2::text || '_MAIN') AS BranchId,
                    COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'terminalid', ''), 'POS_01') AS TerminalId
               FROM CaThuNgan
              WHERE MaCaThuNgan = $1 AND COALESCE(TenantId::text, 'DEFAULT') = $2::text
              FOR SHARE`,
            [maCaGoc, tenantId]
        );
        const rowGoc = caGocRes.rows[0];
        if (rowGoc && Number(rowGoc.trangthaica) === 1) {
            ca = rowGoc;
        } else {
            caGocDaDong = true;
        }
    }

    if (!ca) {
        if (laOfflineSync) {
            throw new LoiNghiepVu(
                409,
                'Hiện chưa có ca thu ngân nào đang mở để tiếp nhận đơn Offline. Vui lòng mở ca mới, hệ thống sẽ tự động xả hàng đợi!',
                { maLoi: 'SHIFT_NOT_OPEN_FOR_SYNC' }
            );
        }
        throw loiChuaMoCa();
    }

    const lechCaDongBo = Boolean(laOfflineSync && maCaGoc && String(maCaGoc) !== String(ca.macathungan));
    const ghiChuLechCa = lechCaDongBo
        ? `Ca gốc #${maCaGoc} ${caGocDaDong ? 'đã đóng' : 'khác ca hiện tại'} — tự động hạch toán vào Ca #${ca.macathungan}`
        : null;

    return { ca, maCaGoc: maCaGoc || null, lechCaDongBo, caGocDaDong, ghiChuLechCa };
}

// ---- Món cho màn hình Barista / Phục vụ -------------------------------------
const SQL_MON_PHA_CHE = `
    SELECT cthd.MaCTHD, cthd.MaHoaDon, cthd.MaMon,
           COALESCE(to_jsonb(cthd)->>'tenmontuychinh', cthd.TenMonSnapshot, sp.TenMon) AS TenMon,
           to_jsonb(cthd)->>'tenmontuychinh' AS TenMonTuyChinh,
           sp.NhomMon, to_jsonb(sp)->>'tramchebien' AS TramCheBien,
           COALESCE((to_jsonb(sp)->>'lamonthoigia')::boolean, FALSE) AS LaMonThoiGia,
           COALESCE((to_jsonb(sp)->>'intemcoc')::boolean, TRUE) AS InTemCoc,
           cthd.KichThuoc, cthd.SoLuong,
           cthd.GhiChu, cthd.TrangThaiPhaChe, cthd.ThoiGianGoi, cthd.ThoiGianXong,
           to_jsonb(cthd)->>'thoigianbatdaulam' AS ThoiGianBatDauLam,
           to_jsonb(cthd)->>'thoigianphucvu' AS ThoiGianPhucVu,
           to_jsonb(cthd)->>'manvphache' AS MaNVPhaChe,
           COALESCE((to_jsonb(cthd)->>'mucdouutien')::int, 0) AS MucDoUuTien,
           to_jsonb(cthd)->>'remakeofcthd' AS RemakeOfCTHD,
           (to_jsonb(cthd)->>'trongluonggram')::numeric AS TrongLuongGram,
           COALESCE((to_jsonb(cthd)->>'dotgoi')::int, 1) AS DotGoi,
           COALESCE((to_jsonb(cthd)->>'istakeaway')::boolean, FALSE) AS IsTakeaway,
           COALESCE((to_jsonb(cthd)->>'courseno')::int, 1) AS CourseNo,
           COALESCE(to_jsonb(cthd)->>'firestatus', 'FIRED') AS FireStatus,
           to_jsonb(cthd)->>'firedat' AS FiredAt,
           COALESCE((to_jsonb(cthd)->'modifierssnapshot')::jsonb, '[]'::jsonb) AS ModifiersSnapshot,
           to_jsonb(cthd)->>'combogroupuid' AS ComboGroupUid,
           to_jsonb(cthd)->>'macombo' AS MaCombo,
           to_jsonb(cthd)->>'tencombosnapshot' AS TenComboSnapshot,
           (SELECT hdq.SoThuTuNgay FROM HoaDon hdq WHERE hdq.MaHoaDon = cthd.MaHoaDon) AS SoThuTuNgay,
           (SELECT to_jsonb(hdq)->>'sothutuhienthi' FROM HoaDon hdq WHERE hdq.MaHoaDon = cthd.MaHoaDon) AS SoThuTuHienThi,
           (SELECT to_jsonb(hdq)->>'sotherung' FROM HoaDon hdq WHERE hdq.MaHoaDon = cthd.MaHoaDon) AS SoTheRung,
           (SELECT to_jsonb(hdq)->>'tenkhachvanglai' FROM HoaDon hdq WHERE hdq.MaHoaDon = cthd.MaHoaDon) AS TenKhachVangLai,
           (SELECT to_jsonb(hdq)->>'clientorderuid' FROM HoaDon hdq WHERE hdq.MaHoaDon = cthd.MaHoaDon) AS ClientOrderUid,
           (SELECT COALESCE(NULLIF(to_jsonb(hdq)->>'branchid', ''), 'DEFAULT') FROM HoaDon hdq WHERE hdq.MaHoaDon = cthd.MaHoaDon) AS BranchId,
           (SELECT COALESCE(to_jsonb(hdq)->>'loaidonhang', 'TAI_QUAN') FROM HoaDon hdq WHERE hdq.MaHoaDon = cthd.MaHoaDon) AS LoaiDonHang,
           (SELECT MIN(hb.MaBan) FROM HoaDon_Ban hb WHERE hb.MaHoaDon = cthd.MaHoaDon) AS MaBan,
           (SELECT string_agg(b.TenBan, ', ' ORDER BY b.TenBan)
              FROM HoaDon_Ban hb JOIN Ban b ON b.MaBan = hb.MaBan
             WHERE hb.MaHoaDon = cthd.MaHoaDon) AS TenBan,
           COALESCE((SELECT json_agg(json_build_object(
                                'maTopping', t.MaTopping,
                                'tenTopping', COALESCE(to_jsonb(t)->>'tentoppingsnapshot', tp.TenTopping),
                                'soLuong', t.SoLuong,
                                'soLuongMoiLy', COALESCE((to_jsonb(t)->>'soluongmoily')::int, 1)
                            ) ORDER BY tp.TenTopping)
                       FROM ChiTietHoaDon_Topping t LEFT JOIN Topping tp ON tp.MaTopping = t.MaTopping
                      WHERE t.MaCTHD = cthd.MaCTHD), '[]'::json) AS Toppings
      FROM ChiTietHoaDon cthd
      JOIN SanPham sp ON sp.MaMon = cthd.MaMon`;

const mapMonPhaChe = (r) => ({
    maCTHD: r.macthd,
    maHoaDon: r.mahoadon,
    branchId: r.branchid || 'DEFAULT',
    clientOrderUid: r.clientorderuid || null,
    soThuTuNgay: r.sothutungay ? Number(r.sothutungay) : null,
    soThuTuHienThi: r.sothutuhienthi || (r.sothutungay ? String(r.sothutungay).padStart(3, '0') : null),
    soTheRung: r.sotherung || null,
    tenKhachVangLai: r.tenkhachvanglai || null,
    loaiDonHang: r.loaidonhang || (r.maban ? 'TAI_QUAN' : 'MANG_DI'),
    maMon: r.mamon,
    tenMon: r.tenmon,
    tenMonTuyChinh: r.tenmontuychinh || null,
    laMonThoiGia: Boolean(r.lamonthoigia),
    inTemCoc: r.intemcoc !== false,
    trongLuongGram: r.trongluonggram !== null && r.trongluonggram !== undefined ? Number(r.trongluonggram) : null,
    nhomMon: r.nhommon || null,
    tramCheBien: suyLuanTramCheBien({ tramCheBien: r.tramchebien, nhomMon: r.nhommon, tenMon: r.tenmon }),
    kichThuoc: r.kichthuoc,
    soLuong: r.soluong,
    ghiChu: r.ghichu,
    dotGoi: Number(r.dotgoi || 1),
    isTakeaway: Boolean(r.istakeaway) || !r.maban,
    courseNo: Number(r.courseno || 1),
    fireStatus: r.firestatus || 'FIRED',
    firedAt: r.firedat || null,
    mucDoUuTien: Number(r.mucdouutien || 0),
    remakeOfCTHD: r.remakeofcthd || null,
    modifiersSnapshot: Array.isArray(r.modifierssnapshot) ? r.modifierssnapshot : [],
    comboGroupUid: r.combogroupuid || null,
    maCombo: r.macombo || null,
    tenComboSnapshot: r.tencombosnapshot || null,
    trangThaiPhaChe: r.trangthaiphache,
    thoiGianGoi: r.thoigiangoi,
    thoiGianBatDauLam: r.thoigianbatdaulam || null,
    thoiGianXong: r.thoigianxong || null,
    thoiGianPhucVu: r.thoigianphucvu || null,
    maNVPhaChe: r.manvphache || null,
    maBan: r.maban || null,
    tenBan: r.tenban || null,
    mangDi: !r.maban || Boolean(r.istakeaway),
    toppings: r.toppings,
});

async function layMonTheoMa(db, dsMaCTHD) {
    if (!Array.isArray(dsMaCTHD) || dsMaCTHD.length === 0) return [];
    const r = await db.query(
        `${SQL_MON_PHA_CHE} WHERE cthd.MaCTHD::text = ANY($1::text[])
         ORDER BY COALESCE((to_jsonb(cthd)->>'mucdouutien')::int, 0) DESC, cthd.ThoiGianGoi ASC, cthd.MaCTHD ASC`,
        [dsMaCTHD.map(String)]
    );
    return r.rows.map(mapMonPhaChe);
}

async function layMonTheoTrangThai(db, dsTrangThai, tenantId = 'DEFAULT', { includeHeld = false } = {}) {
    const heldFilter = includeHeld ? '' : `AND COALESCE(to_jsonb(cthd)->>'firestatus', 'FIRED') = 'FIRED'`;
    const r = await db.query(
        `${SQL_MON_PHA_CHE}
         JOIN HoaDon hd ON hd.MaHoaDon = cthd.MaHoaDon
         WHERE cthd.TrangThaiPhaChe = ANY($1::varchar[])
           AND hd.TrangThaiTT IN (0, 1)
           ${heldFilter}
           AND COALESCE(hd.TenantId, 'DEFAULT') = $2
         ORDER BY COALESCE((to_jsonb(cthd)->>'mucdouutien')::int, 0) DESC, cthd.ThoiGianGoi ASC, cthd.MaCTHD ASC`,
        [dsTrangThai, String(tenantId || 'DEFAULT')]
    );
    return r.rows.map(mapMonPhaChe);
}

// ---- Hóa đơn chi tiết (dùng cho xem bàn, thanh toán, in bill — Single Source of Truth) ----------------
async function layHoaDonChiTiet(db, maHoaDon) {
    const hdRes = await db.query(
        `SELECT hd.MaHoaDon, hd.MaKH, COALESCE(to_jsonb(kh)->>'tenkh', to_jsonb(kh)->>'hoten') AS TenKH, kh.SoDienThoai, kh.DiemTichLuy,
                hd.TrangThaiTT, hd.PhuongThucTT, hd.TongTienThanhToan, hd.ThoiGianTao, hd.ThoiGianThanhToan,
                COALESCE(hd.SoLanIn, 0) AS SoLanIn, COALESCE(hd.DaInTamTinh, FALSE) AS DaInTamTinh,
                hd.SoThuTuNgay,
                to_jsonb(hd)->>'makhuyenmai' AS MaKhuyenMai,
                to_jsonb(hd)->>'tenkhuyenmai' AS TenKhuyenMai,
                COALESCE((to_jsonb(hd)->>'tiengiamkm')::numeric, 0) AS TienGiamKM,
                COALESCE((to_jsonb(hd)->>'diemsudung')::int, 0) AS DiemSuDung,
                COALESCE((to_jsonb(hd)->>'tiengiamdiem')::numeric, 0) AS TienGiamDiem,
                COALESCE((to_jsonb(hd)->>'version')::int, 1) AS Version,
                COALESCE(to_jsonb(hd)->>'loaidonhang', 'TAI_QUAN') AS LoaiDonHang,
                to_jsonb(hd)->>'sotherung' AS SoTheRung,
                to_jsonb(hd)->>'sothutuhienthi' AS SoThuTuHienThi,
                COALESCE((to_jsonb(hd)->>'phidonggoi')::numeric, 0) AS PhiDongGoi,
                to_jsonb(hd)->>'diachigiao' AS DiaChiGiao,
                to_jsonb(hd)->>'tenkhachvanglai' AS TenKhachVangLai,
                COALESCE((to_jsonb(hd)->>'sokhach')::int, 1) AS SoKhach,
                COALESCE(to_jsonb(hd)->>'thoigianmoban', hd.ThoiGianTao::text) AS ThoiGianMoBan,
                to_jsonb(hd)->>'mergedintomahoadon' AS MergedIntoMaHoaDon,
                to_jsonb(hd)->>'parentmahoadon' AS ParentMaHoaDon,
                COALESCE(to_jsonb(hd)->>'cachtinhthue', 'INCLUDED') AS CachTinhThue,
                COALESCE((to_jsonb(hd)->>'thuevatphantram')::numeric, 0) AS ThueVATPhanTram,
                COALESCE((to_jsonb(hd)->>'tienthuevat')::numeric, 0) AS TienThueVAT,
                COALESCE((to_jsonb(hd)->>'phiphucvuphantram')::numeric, 0) AS PhiPhucVuPhanTram,
                COALESCE((to_jsonb(hd)->>'tienphiphucvu')::numeric, 0) AS TienPhiPhucVu,
                COALESCE((to_jsonb(hd)->>'tienlamtron')::numeric, 0) AS TienLamTron,
                COALESCE(hd.TenantId, 'DEFAULT') AS TenantId
           FROM HoaDon hd
           LEFT JOIN KhachHang kh ON kh.MaKH = hd.MaKH
          WHERE hd.MaHoaDon = $1`,
        [maHoaDon]
    );
    if (hdRes.rows.length === 0) return null;
    const hd = hdRes.rows[0];

    const banRes = await db.query(
        `SELECT b.MaBan, b.TenBan FROM HoaDon_Ban hb JOIN Ban b ON b.MaBan = hb.MaBan
          WHERE hb.MaHoaDon = $1 ORDER BY b.TenBan`,
        [maHoaDon]
    );

    const monRes = await db.query(
        `SELECT c.MaCTHD, c.MaMon,
                COALESCE(to_jsonb(c)->>'tenmontuychinh', c.TenMonSnapshot, sp.TenMon) AS TenMon,
                c.KichThuoc, c.SoLuong, c.DonGia,
                COALESCE((to_jsonb(c)->>'giagiam')::numeric, 0) AS GiaGiam, COALESCE(c.GiaVonSnapshot, 0) AS GiaVonSnapshot,
                COALESCE((to_jsonb(c)->>'giamodifiers')::numeric, 0) AS GiaModifiers,
                COALESCE((to_jsonb(c)->'modifierssnapshot')::jsonb, '[]'::jsonb) AS ModifiersSnapshot,
                to_jsonb(c)->>'combogroupuid' AS ComboGroupUid,
                to_jsonb(c)->>'macombo' AS MaCombo,
                to_jsonb(c)->>'tencombosnapshot' AS TenComboSnapshot,
                COALESCE((to_jsonb(c)->>'giagocniemyet')::numeric, c.DonGia) AS GiaGocNiemYet,
                COALESCE((to_jsonb(c)->>'dotgoi')::int, 1) AS DotGoi,
                COALESCE((to_jsonb(c)->>'istakeaway')::boolean, FALSE) AS IsTakeaway,
                COALESCE((to_jsonb(c)->>'courseno')::int, 1) AS CourseNo,
                COALESCE(to_jsonb(c)->>'firestatus', 'FIRED') AS FireStatus,
                to_jsonb(c)->>'firedat' AS FiredAt,
                COALESCE((to_jsonb(c)->>'chietkhaumon')::numeric, 0) AS ChietKhauMon,
                COALESCE((to_jsonb(c)->>'lamontang')::boolean, FALSE) AS LaMonTang,
                to_jsonb(c)->>'lydotang' AS LyDoTang,
                (to_jsonb(c)->>'trongluonggram')::numeric AS TrongLuongGram,
                to_jsonb(c)->>'tenmontuychinh' AS TenMonTuyChinh,
                to_jsonb(sp)->>'tramchebien' AS TramCheBien,
                sp.NhomMon,
                c.GhiChu, c.TrangThaiPhaChe, c.LyDoHuy, c.ThoiGianGoi,
                COALESCE((SELECT json_agg(json_build_object(
                                    'maTopping', t.MaTopping,
                                    'tenTopping', COALESCE(to_jsonb(t)->>'tentoppingsnapshot', tp.TenTopping),
                                    'soLuong', t.SoLuong,
                                    'soLuongMoiLy', COALESCE((to_jsonb(t)->>'soluongmoily')::int, 1),
                                    'donGia', t.DonGia,
                                    'giaVonSnapshot', COALESCE((to_jsonb(t)->>'giavontoppingsnapshot')::numeric, 0)
                                ) ORDER BY COALESCE(to_jsonb(t)->>'tentoppingsnapshot', tp.TenTopping))
                            FROM ChiTietHoaDon_Topping t LEFT JOIN Topping tp ON tp.MaTopping = t.MaTopping
                           WHERE t.MaCTHD = c.MaCTHD), '[]'::json) AS Toppings
           FROM ChiTietHoaDon c
           JOIN SanPham sp ON sp.MaMon = c.MaMon
          WHERE c.MaHoaDon = $1
          ORDER BY c.ThoiGianGoi, c.MaCTHD`,
        [maHoaDon]
    );

    const danhSachMon = monRes.rows.map((r) => {
        const donGia = Number(r.dongia);
        const giaGiam = Number(r.giagiam);
        const giaModifiers = Number(r.giamodifiers || 0);
        const chietKhauMon = Number(r.chietkhaumon || 0);
        const laMonTang = Boolean(r.lamontang);
        const daHuy = r.trangthaiphache === 'DaHuy';
        const tienTopping = r.toppings.reduce((s, t) => s + Number(t.soLuong) * Number(t.donGia), 0);
        const thanhTien =
            daHuy || laMonTang
                ? 0
                : Math.max(0, r.soluong * (donGia + giaModifiers) + tienTopping - giaGiam - chietKhauMon);
        return {
            maCTHD: r.macthd,
            maMon: r.mamon,
            tenMon: r.tenmon,
            nhomMon: r.nhommon || null,
            tramCheBien: suyLuanTramCheBien({ tramCheBien: r.tramchebien, nhomMon: r.nhommon, tenMon: r.tenmon }),
            kichThuoc: r.kichthuoc,
            soLuong: r.soluong,
            donGia,
            giaGiam,
            giaModifiers,
            modifiersSnapshot: Array.isArray(r.modifierssnapshot) ? r.modifierssnapshot : [],
            chietKhauMon,
            laMonTang,
            lyDoTang: r.lydotang || null,
            trongLuongGram: r.trongluonggram !== null && r.trongluonggram !== undefined ? Number(r.trongluonggram) : null,
            tenMonTuyChinh: r.tenmontuychinh || null,
            comboGroupUid: r.combogroupuid || null,
            maCombo: r.macombo || null,
            tenComboSnapshot: r.tencombosnapshot || null,
            giaGocNiemYet: Number(r.giagocniemyet || donGia),
            dotGoi: Number(r.dotgoi || 1),
            isTakeaway: Boolean(r.istakeaway),
            courseNo: Number(r.courseno || 1),
            fireStatus: r.firestatus || 'FIRED',
            firedAt: r.firedat || null,
            giaVon: Number(r.giavonsnapshot || 0),
            ghiChu: r.ghichu,
            trangThaiPhaChe: r.trangthaiphache,
            daHuy,
            lyDoHuy: r.lydohuy || null,
            thoiGianGoi: r.thoigiangoi,
            toppings: r.toppings,
            thanhTien,
        };
    });

    const monHopLe = danhSachMon.filter((m) => !m.daHuy);

    let danhSachThanhToan = [];
    if (runtimeFlags.paymentsSanSang) {
        try {
            const pRes = await db.query(
                `SELECT Id, PhuongThucTT, SoTien, TienKhachDua, TienThua, TrangThai,
                        MaGiaoDichNgoai, NoiDungCK, NguonXacNhan, ThoiGianTao,
                        (to_jsonb(Order_Payments)->>'chiatienid')::bigint AS ChiaTienId
                   FROM Order_Payments
                  WHERE MaHoaDon = $1::text AND TrangThai = 'PAID'
                  ORDER BY Id ASC`,
                [String(maHoaDon)]
            );
            danhSachThanhToan = pRes.rows.map((p) => ({
                id: p.id,
                phuongThucTT: p.phuongthuctt,
                soTien: Number(p.sotien),
                tienKhachDua: p.tienkhachdua !== null ? Number(p.tienkhachdua) : null,
                tienThua: Number(p.tienthua || 0),
                trangThai: p.trangthai,
                maGiaoDichNgoai: p.magiaodichngoai || null,
                noiDungCK: p.noidungck || null,
                nguonXacNhan: p.nguonxacnhan || 'POS_MANUAL',
                chiaTienId: p.chiatienid ? Number(p.chiatienid) : null,
                thoiGianTao: p.thoigiantao,
            }));
        } catch {
            danhSachThanhToan = [];
        }
    }

    let danhSachChiaTien = [];
    try {
        await db.query('SAVEPOINT sp_sel_chiatien');
        const ctRes = await db.query(
            `SELECT id, nhanchia, sotienphaitra, sotiendatra, trangthai, thoigiantao
               FROM hoadon_chiatien
              WHERE mahoadon = $1::text AND trangthai <> 'CANCELLED'
              ORDER BY id ASC`,
            [String(maHoaDon)]
        );
        await db.query('RELEASE SAVEPOINT sp_sel_chiatien');
        danhSachChiaTien = ctRes.rows.map((x) => ({
            id: Number(x.id),
            nhanChia: x.nhanchia,
            soTienPhaiTra: Number(x.sotienphaitra),
            soTienDaTra: Number(x.sotiendatra || 0),
            trangThai: x.trangthai,
            thoiGianTao: x.thoigiantao,
        }));
    } catch {
        await db.query('ROLLBACK TO SAVEPOINT sp_sel_chiatien').catch(() => {});
    }

    const tienGiamKM = Number(hd.tiengiamkm || 0);
    const diemSuDung = Number(hd.diemsudung || 0);
    const tienGiamDiem = Number(hd.tiengiamdiem || 0);
    const loaiDonHang = hd.loaidonhang || (banRes.rows.length > 0 ? 'TAI_QUAN' : 'MANG_DI');

    const keToan = tinhTongKeToanHoaDon({
        danhSachMon,
        tienGiamKM,
        tienGiamDiem,
        loaiDonHang,
        phiPhucVuPhanTram: Number(hd.phiphucvuphantram || 0),
        phiDongGoi: Number(hd.phidonggoi || 0),
        cachTinhThue: hd.cachtinhthue || 'INCLUDED',
        thueVATPhanTram: Number(hd.thuevatphantram || 0),
    });

    const tongTamTinh = keToan.tamTinhMon;
    const tongGiamGia = keToan.tongGiamGia;
    const tongSauGiam = keToan.sauGiamGia;
    const tongPhaiTra = keToan.tongPhaiTra;

    const tongDaThuTuBang = danhSachThanhToan.reduce((s, p) => s + p.soTien, 0);
    const daThanhToan =
        hd.trangthaitt === 1 && danhSachThanhToan.length === 0
            ? Number(hd.tongtienthanhtoan ?? tongPhaiTra)
            : tongDaThuTuBang;
    const conLaiCanThu = hd.trangthaitt === 1 || hd.trangthaitt === 3
        ? 0
        : Math.max(0, Math.round((tongPhaiTra - daThanhToan) * 100) / 100);
    const distinctMethods = new Set(danhSachThanhToan.map((p) => p.phuongThucTT));

    return {
        maHoaDon: hd.mahoadon,
        version: Number(hd.version || 1),
        soThuTuNgay: hd.sothutungay ? Number(hd.sothutungay) : null,
        soThuTuHienThi: hd.sothutuhienthi || (hd.sothutungay ? String(hd.sothutungay).padStart(3, '0') : null),
        soTheRung: hd.sotherung || null,
        loaiDonHang,
        tenKhachVangLai: hd.tenkhachvanglai || null,
        diaChiGiao: hd.diachigiao || null,
        soKhach: Number(hd.sokhach || 1),
        thoiGianMoBan: hd.thoigianmoban || hd.thoigiantao,
        mergedIntoMaHoaDon: hd.mergedintomahoadon || null,
        parentMaHoaDon: hd.parentmahoadon || null,
        tenantId: hd.tenantid || 'DEFAULT',
        khachHang: hd.makh
            ? { maKH: hd.makh, tenKH: hd.tenkh, soDienThoai: hd.sodienthoai, diemTichLuy: hd.diemtichluy }
            : null,
        trangThaiTT: hd.trangthaitt,
        phuongThucTT: hd.phuongthuctt,
        laThanhToanHonHop: distinctMethods.size > 1,
        thoiGianTao: hd.thoigiantao,
        thoiGianThanhToan: hd.thoigianthanhtoan,
        soLanIn: Number(hd.solanin || 0),
        daInTamTinh: Boolean(hd.daintamtinh),
        ban: banRes.rows.map((b) => ({ maBan: b.maban, tenBan: b.tenban })),
        danhSachMon,
        danhSachThanhToan,
        danhSachChiaTien,
        soMonHopLe: monHopLe.length,
        tongTamTinh,
        maKhuyenMai: hd.makhuyenmai || null,
        tenKhuyenMai: hd.tenkhuyenmai || null,
        tienGiamKM,
        diemSuDung,
        tienGiamDiem,
        tongGiamGia,
        tongSauGiam,
        phiDongGoi: keToan.phiDongGoi,
        phiPhucVuPhanTram: Number(hd.phiphucvuphantram || 0),
        tienPhiPhucVu: keToan.tienPhiPhucVu,
        cachTinhThue: keToan.cachTinhThue,
        thueVATPhanTram: keToan.thueVATPhanTram,
        tienThueVAT: keToan.tienThueVAT,
        tienLamTron: Number(hd.tienlamtron || keToan.tienLamTron || 0),
        tongPhaiTra,
        daThanhToan,
        conLaiCanThu,
        tongTienThanhToan: hd.trangthaitt === 1 ? Number(hd.tongtienthanhtoan) : null,
    };
}

async function layHoaDonMoCuaBan(db, maBan, khoa = false) {
    const r = await db.query(
        `SELECT hd.MaHoaDon
           FROM HoaDon hd JOIN HoaDon_Ban hb ON hb.MaHoaDon = hd.MaHoaDon
          WHERE hb.MaBan = $1 AND hd.TrangThaiTT = 0
          ORDER BY hd.ThoiGianTao DESC
          LIMIT 1${khoa ? ' FOR UPDATE OF hd' : ''}`,
        [maBan]
    );
    return r.rows.length ? r.rows[0].mahoadon : null;
}

// ---- Đối soát tiền mặt của 1 ca thu ngân (Phân hệ 3: Sổ cái Order_Refunds độc lập, Thối CK dư Loại 4, ZReportSnapshot bất biến) ----
async function tinhDoiSoatCa(db, maCaThuNgan, tienMatThucTe) {
    let caRes;
    try {
        await db.query('SAVEPOINT sp_ca_zreport');
        caRes = await db.query(
            `SELECT ca.MaCaThuNgan, ca.MaNV, nv.TenNV, ca.ThoiGianMoCa, ca.ThoiGianDongCa,
                    ca.TienMatDauCa, ca.TienMatThucTe, ca.TrangThaiCa, ca.GhiChuChenhLech, ca.ChiTietMenhGia,
                    COALESCE(ca.TenantId, 'DEFAULT') AS TenantId,
                    to_jsonb(ca)->>'sozreport' AS SoZReport,
                    COALESCE(NULLIF(to_jsonb(ca)->>'branchid', ''), COALESCE(ca.TenantId, 'DEFAULT') || '_MAIN') AS BranchId,
                    COALESCE(NULLIF(to_jsonb(ca)->>'terminalid', ''), 'POS_01') AS TerminalId,
                    to_jsonb(ca)->'chitietmenhgiadauca' AS ChiTietMenhGiaDauCa,
                    COALESCE((to_jsonb(ca)->>'tiengiulaiket')::numeric, 0) AS TienGiuLaiKet,
                    COALESCE((to_jsonb(ca)->>'chenhlechbangiao')::numeric, 0) AS ChenhLechBanGiao,
                    to_jsonb(ca)->>'macatruoc' AS MaCaTruoc,
                    COALESCE((to_jsonb(ca)->>'solandemlai')::int, 0) AS SoLanDemLai,
                    to_jsonb(ca)->'zreportsnapshot' AS ZReportSnapshot,
                    (to_jsonb(ca)->>'tongchotloedc')::numeric AS TongChotLoEDC
               FROM CaThuNgan ca JOIN NhanVien nv ON nv.MaNV = ca.MaNV
              WHERE ca.MaCaThuNgan = $1`,
            [maCaThuNgan]
        );
        await db.query('RELEASE SAVEPOINT sp_ca_zreport');
    } catch {
        await db.query('ROLLBACK TO SAVEPOINT sp_ca_zreport').catch(() => {});
        caRes = await db.query(
            `SELECT ca.MaCaThuNgan, ca.MaNV, nv.TenNV, ca.ThoiGianMoCa, ca.ThoiGianDongCa,
                    ca.TienMatDauCa, ca.TienMatThucTe, ca.TrangThaiCa, ca.GhiChuChenhLech,
                    COALESCE(ca.TenantId, 'DEFAULT') AS TenantId
               FROM CaThuNgan ca JOIN NhanVien nv ON nv.MaNV = ca.MaNV
              WHERE ca.MaCaThuNgan = $1`,
            [maCaThuNgan]
        );
    }
    if (caRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy ca thu ngân!');
    const ca = caRes.rows[0];
    const soZReport = ca.sozreport ? Number(ca.sozreport) : null;

    // [Phân hệ 3 - Z-Report Bất biến] Nếu ca đã chốt (TrangThaiCa = 2) và đã đóng băng ZReportSnapshot -> trả số liệu đóng băng vĩnh viễn!
    if (Number(ca.trangthaica) === 2 && ca.zreportsnapshot && typeof ca.zreportsnapshot === 'object' && ca.zreportsnapshot.cashFlow) {
        const snap = ca.zreportsnapshot;
        const cf = snap.cashFlow;
        const pm = snap.paymentsByMethod || {};
        const rf = snap.refunds || {};
        const chenhLechSnap = Number(cf.variance || 0);
        const trangThaiSnap =
            chenhLechSnap > 0 ? 'Thừa tiền mặt (Dư quỹ)' : chenhLechSnap < 0 ? 'Thiếu tiền mặt (Hụt quỹ)' : 'Khớp quỹ chính xác';

        return {
            maCaThuNgan: ca.macathungan,
            branchId: snap.branchId || ca.branchid,
            terminalId: snap.terminalId || ca.terminalid,
            soZReport,
            maZReport: snap.zNumber || (soZReport ? `Z-${String(soZReport).padStart(4, '0')}` : null),
            maNV: ca.manv,
            tenNV: ca.tennv,
            thoiGianMoCa: ca.thoigianmoca,
            thoiGianDongCa: ca.thoigiandongca,
            trangThaiCa: ca.trangthaica,
            tienMatDauCa: Number(cf.openingFloat || 0),
            doanhThu: {
                tienMat: Number(pm.TIEN_MAT || 0),
                chuyenKhoan: Number(pm.CHUYEN_KHOAN_AUTO_WEBHOOK || 0) + Number(pm.CHUYEN_KHOAN_MANUAL || 0),
                the: Number(pm.THE || 0),
                voucher: Number(pm.VOUCHER || 0),
                viKhach: Number(pm.VI_KHACH || 0),
                viDienTu: Number(pm.VI_DIEN_TU || 0),
                sanGiaoHang: Number(pm.SAN_GIAO_HANG || 0),
                tong: Number(snap.sales?.netSales || 0),
                soHoaDon: Number(snap.sales?.orderCount || 0),
            },
            hoanTien: {
                tienMat: Number(rf.cash || 0),
                chuyenKhoan: Number(rf.bank || 0),
                the: Number(rf.card || 0),
                viKhach: Number(rf.wallet || 0),
                voucher: 0,
                tong: Number(rf.total || 0),
                soLuot: Number(rf.count || 0),
            },
            thuLatVat: Number(cf.payIn || 0),
            chiLatVat: Number(cf.payOut || 0),
            rutKet: Number(cf.safeDrop || 0),
            thoiCkDu: Number(cf.overpaymentCashChange || 0),
            soPhieuRutKet: 0,
            tienMatLyThuyet: Number(cf.expectedCash || 0),
            tienMatThucTe: Number(cf.actualCountedCash || 0),
            chenhLech: chenhLechSnap,
            trangThai: trangThaiSnap,
            tienGiuLaiKet: Number(cf.carryOverFloatNextShift || ca.tiengiulaiket || 0),
            tienNopVeChuQuan: Number(cf.netCashToOwner || 0),
            chenhLechBanGiao: Number(ca.chenhlechbangiao || 0),
            maCaTruoc: ca.macatruoc || null,
            soLanDemLai: Number(ca.solandemlai || 0),
            ghiChuChenhLech: ca.ghichuchenhlech || null,
            chiTietMenhGiaDauCa: ca.chitietmenhgiadauca || null,
            chiTietMenhGia: ca.chitietmenhgia || null,
            tongChotLoEDC: ca.tongchotloedc !== null && ca.tongchotloedc !== undefined ? Number(ca.tongchotloedc) : null,
            zReportSnapshot: snap,
            isFrozenSnapshot: true,
        };
    }

    const doanhThu = {
        tienMat: 0,
        chuyenKhoan: 0,
        the: 0,
        voucher: 0,
        viKhach: 0,
        viDienTu: 0,
        sanGiaoHang: 0,
        tong: 0,
        soHoaDon: 0,
    };
    const hoanTien = { tienMat: 0, chuyenKhoan: 0, the: 0, voucher: 0, viKhach: 0, tong: 0, soLuot: 0 };

    if (runtimeFlags.paymentsSanSang) {
        const [pRes, hdCountRes] = await Promise.all([
            db.query(
                `SELECT PhuongThucTT, COALESCE(SUM(SoTien), 0) AS TongTien
                   FROM (
                       SELECT op.PhuongThucTT, op.SoTien
                         FROM Order_Payments op
                        WHERE op.MaCaThuNgan = $1::text AND op.TrangThai = 'PAID'
                       UNION ALL
                       SELECT COALESCE(hd.PhuongThucTT, 'TIEN_MAT') AS PhuongThucTT, hd.TongTienThanhToan AS SoTien
                         FROM HoaDon hd
                        WHERE hd.MaCaThuNgan = $1 AND hd.TrangThaiTT = 1
                          AND NOT EXISTS (
                              SELECT 1 FROM Order_Payments op2
                               WHERE op2.MaHoaDon = hd.MaHoaDon::text AND op2.TrangThai = 'PAID'
                          )
                   ) combined
                  GROUP BY PhuongThucTT`,
                [maCaThuNgan]
            ),
            db.query(
                `SELECT COUNT(DISTINCT ma_hd) AS SoHoaDon
                   FROM (
                       SELECT MaHoaDon AS ma_hd FROM Order_Payments WHERE MaCaThuNgan = $1::text AND TrangThai = 'PAID'
                       UNION
                       SELECT MaHoaDon::text AS ma_hd FROM HoaDon WHERE MaCaThuNgan = $1 AND TrangThaiTT = 1
                   ) d`,
                [maCaThuNgan]
            ),
        ]);
        for (const r of pRes.rows) {
            const tien = Number(r.tongtien);
            if (r.phuongthuctt === 'CHUYEN_KHOAN') doanhThu.chuyenKhoan += tien;
            else if (r.phuongthuctt === 'THE') doanhThu.the += tien;
            else if (r.phuongthuctt === 'VOUCHER') doanhThu.voucher += tien;
            else if (r.phuongthuctt === 'VI_KHACH') doanhThu.viKhach += tien;
            else if (r.phuongthuctt === 'VI_DIEN_TU') doanhThu.viDienTu += tien;
            else if (r.phuongthuctt === 'SAN_GIAO_HANG') doanhThu.sanGiaoHang += tien;
            else doanhThu.tienMat += tien;
            doanhThu.tong += tien;
        }
        doanhThu.soHoaDon = Number(hdCountRes.rows[0]?.sohoadon || 0);

        // Đọc tổng Hoàn tiền của riêng Ca này từ Sổ cái Hoàn tiền Độc lập (public.order_refunds) + fallback legacy REFUNDED
        let gotLedgerRefunds = false;
        await db.query('SAVEPOINT sp_ds_order_refunds');
        try {
            const orRes = await db.query(
                `SELECT phuongthuchoan AS PhuongThucTT, COUNT(*) AS SoLuot, COALESCE(SUM(sotienhoan), 0) AS TongTien
                   FROM public.order_refunds
                  WHERE macathungan = $1::text
                  GROUP BY phuongthuchoan`,
                [String(maCaThuNgan)]
            );
            await db.query('RELEASE SAVEPOINT sp_ds_order_refunds');
            for (const r of orRes.rows) {
                const tien = Number(r.tongtien || 0);
                if (r.phuongthuctt === 'CHUYEN_KHOAN') hoanTien.chuyenKhoan += tien;
                else if (r.phuongthuctt === 'THE') hoanTien.the += tien;
                else if (r.phuongthuctt === 'VOUCHER') hoanTien.voucher += tien;
                else if (r.phuongthuctt === 'VI_KHACH') hoanTien.viKhach += tien;
                else hoanTien.tienMat += tien;
                hoanTien.tong += tien;
                hoanTien.soLuot += Number(r.soluot || 0);
            }
            gotLedgerRefunds = true;
        } catch {
            await db.query('ROLLBACK TO SAVEPOINT sp_ds_order_refunds').catch(() => {});
        }
        if (!gotLedgerRefunds) {
            const refundRes = await db.query(
                `SELECT PhuongThucTT, COUNT(*) AS SoLuot, COALESCE(SUM(SoTien), 0) AS TongTien
                   FROM Order_Payments
                  WHERE MaCaThuNgan = $1::text AND TrangThai = 'REFUNDED'
                  GROUP BY PhuongThucTT`,
                [maCaThuNgan]
            );
            for (const r of refundRes.rows) {
                const tien = Number(r.tongtien);
                if (r.phuongthuctt === 'CHUYEN_KHOAN') hoanTien.chuyenKhoan += tien;
                else if (r.phuongthuctt === 'THE') hoanTien.the += tien;
                else if (r.phuongthuctt === 'VOUCHER') hoanTien.voucher += tien;
                else hoanTien.tienMat += tien;
                hoanTien.tong += tien;
                hoanTien.soLuot += Number(r.soluot || 0);
            }
        }
    } else {
        const ttRes = await db.query(
            `SELECT PhuongThucTT, COUNT(*) AS SoHoaDon, COALESCE(SUM(TongTienThanhToan), 0) AS TongTien
               FROM HoaDon
              WHERE MaCaThuNgan = $1 AND TrangThaiTT = 1
              GROUP BY PhuongThucTT`,
            [maCaThuNgan]
        );
        for (const r of ttRes.rows) {
            const tien = Number(r.tongtien);
            if (r.phuongthuctt === 'CHUYEN_KHOAN') doanhThu.chuyenKhoan += tien;
            else if (r.phuongthuctt === 'THE') doanhThu.the += tien;
            else if (r.phuongthuctt === 'VOUCHER') doanhThu.voucher += tien;
            else doanhThu.tienMat += tien;
            doanhThu.tong += tien;
            doanhThu.soHoaDon += Number(r.sohoadon);
        }
    }

    const tcRes = await db.query(
        `SELECT LoaiPhieu, COUNT(*) AS SoPhieu, COALESCE(SUM(SoTien), 0) AS Tong
           FROM PhieuThuChiLatVat WHERE MaCaThuNgan = $1 GROUP BY LoaiPhieu`,
        [maCaThuNgan]
    );
    let thuLatVat = 0;
    let chiLatVat = 0;
    let rutKet = 0;
    let thoiCkDu = 0;
    let soPhieuRutKet = 0;
    for (const r of tcRes.rows) {
        const lp = Number(r.loaiphieu);
        if (lp === 1) thuLatVat = Number(r.tong);
        else if (lp === 3) {
            rutKet = Number(r.tong);
            soPhieuRutKet = Number(r.sophieu || 0);
        } else if (lp === 4) {
            thoiCkDu = Number(r.tong);
        } else {
            chiLatVat += Number(r.tong);
        }
    }

    const tienMatDauCa = Number(ca.tienmatdauca);
    // Công thức Sổ Quỹ Chuẩn 100%: DauCa + BanTienMat + Thu - Chi - RutKet - ThoiCKDu - HoanTienMat
    const tienMatLyThuyet =
        Math.round((tienMatDauCa + doanhThu.tienMat + thuLatVat - chiLatVat - rutKet - thoiCkDu - hoanTien.tienMat) * 100) / 100;
    const thucTe =
        tienMatThucTe !== undefined && tienMatThucTe !== null && tienMatThucTe !== ''
            ? Number(tienMatThucTe)
            : Number(ca.trangthaica) === 2 && ca.tienmatthucte !== null && ca.tienmatthucte !== undefined
            ? Number(ca.tienmatthucte)
            : null;
    const chenhLech = thucTe === null ? null : Math.round((thucTe - tienMatLyThuyet) * 100) / 100;

    let trangThai = null;
    if (chenhLech !== null) {
        trangThai = 'Khớp quỹ chính xác';
        if (chenhLech > 0) trangThai = 'Thừa tiền mặt (Dư quỹ)';
        if (chenhLech < 0) trangThai = 'Thiếu tiền mặt (Hụt quỹ)';
    }

    return {
        maCaThuNgan: ca.macathungan,
        branchId: ca.branchid || normalizeBranchForShift(ca.tenantid),
        terminalId: ca.terminalid || 'POS_01',
        soZReport,
        maZReport: soZReport ? `Z-${String(soZReport).padStart(4, '0')}` : null,
        maNV: ca.manv,
        tenNV: ca.tennv,
        thoiGianMoCa: ca.thoigianmoca,
        thoiGianDongCa: ca.thoigiandongca,
        trangThaiCa: ca.trangthaica, // 1 đang mở, 2 đã chốt
        tienMatDauCa,
        doanhThu,
        hoanTien,
        thuLatVat,
        chiLatVat,
        rutKet,
        thoiCkDu,
        soPhieuRutKet,
        tienMatLyThuyet,
        tienMatThucTe: thucTe,
        chenhLech,
        trangThai,
        tienGiuLaiKet: Number(ca.tiengiulaiket || 0),
        chenhLechBanGiao: Number(ca.chenhlechbangiao || 0),
        maCaTruoc: ca.macatruoc || null,
        soLanDemLai: Number(ca.solandemlai || 0),
        ghiChuChenhLech: ca.ghichuchenhlech || null,
        chiTietMenhGiaDauCa: ca.chitietmenhgiadauca || null,
        chiTietMenhGia: ca.chitietmenhgia || null,
        tongChotLoEDC: ca.tongchotloedc !== null && ca.tongchotloedc !== undefined ? Number(ca.tongchotloedc) : null,
        zReportSnapshot: ca.zreportsnapshot || null,
        isFrozenSnapshot: false,
    };
}


function validateDanhSachMon(danhSachMon, combos = []) {
    const hasMon = Array.isArray(danhSachMon) && danhSachMon.length > 0;
    const hasCombo = Array.isArray(combos) && combos.length > 0;
    if (!hasMon && !hasCombo) {
        return 'Danh sách món hoặc Combo không được để trống!';
    }
    for (const mon of danhSachMon || []) {
        if (!mon || !mon.maMon || !SIZE_HOP_LE.includes(mon.kichThuoc) || !Number.isInteger(mon.soLuong) || mon.soLuong <= 0) {
            return 'Mỗi món cần có maMon, kichThuoc (S/M/L) và soLuong là số nguyên > 0!';
        }
        for (const tp of mon.toppings || []) {
            const sl = tp && tp.soLuongMoiLy !== undefined ? tp.soLuongMoiLy : tp && tp.soLuong === undefined ? 1 : tp && tp.soLuong;
            if (!tp || !tp.maTopping || !Number.isInteger(sl) || sl <= 0) {
                return 'Mỗi topping cần có maTopping và soLuongMoiLy là số nguyên > 0!';
            }
        }
    }
    return null;
}

// [Phân hệ 1 - 100/100] Cấp số thứ tự theo ngày nguyên tử KHÔNG quay vòng ở 99 (001..999+)
async function capSoThuTuNgayNguyenTu(client, tenantId = 'DEFAULT') {
    const { seq } = await capSoThuTuNgayKhongTrung(client, tenantId);
    return seq;
}

async function taoOrderTrongGiaoDich(
    client,
    {
        tenantId = 'DEFAULT',
        branchId = null,
        maNV,
        vaiTro = null,
        maBan = null,
        maHoaDon: maHoaDonGoc = null,
        maKH = null,
        soTheRung = null,
        loaiDonHang = null,
        tenKhachVangLai = null,
        diaChiGiao = null,
        soKhach = 1,
        phiDongGoi = null,
        phiDongGoiMoiLy = 0,
        cachTinhThue = null,
        thueVATPhanTram = null,
        phiPhucVuPhanTram = null,
        expectedVersion = null,
        clientOrderUid = null,
        laOfflineSync = false,
        offlineCreatedAt = null,
        choThanhToanTruoc = false,
        phuongThucDuKien = null,
        danhSachMon = [],
        combos = [],
        allowNegativeStock = ALLOW_NEGATIVE_STOCK,
        ip = null,
    }
) {
    const laAwaitingPayment =
        Boolean(choThanhToanTruoc) || String(phuongThucDuKien || '').trim().toUpperCase() === 'VIETQR_PREPAID';
    const soldOutWarnings = [];
    const countdownUpdates = [];
    const openItemAuditRows = [];

    // 0. Xác định KhuVucGia theo Branch (ưu tiên giá vùng SanPham_GiaVung) & Lô bánh giảm giá (LoBanhNgay)
    let khuVucGia = 'DEFAULT';
    if (branchId) {
        await client.query('SAVEPOINT sp_ord_branch');
        try {
            const brRes = await client.query(
                `SELECT khuvucgia FROM chinhanh WHERE tenantid = $1 AND branchid = $2 LIMIT 1`,
                [tenantId, branchId]
            );
            khuVucGia = brRes.rows[0]?.khuvucgia || 'DEFAULT';
            await client.query('RELEASE SAVEPOINT sp_ord_branch');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_ord_branch').catch(() => {});
        }
    }
    const bakeryMap = await layBanDoGiamGiaLoBanhHomNay(client, tenantId);

    // 0.5. Mở rộng danh sách Combo (nếu có) thành các dòng món con kèm giá phân bổ Pro-rata 0đ sai số
    const expandedInputItems = [...(Array.isArray(danhSachMon) ? danhSachMon : [])];
    if (Array.isArray(combos) && combos.length > 0) {
        const comboCodes = [...new Set(combos.map((c) => String(c.maCombo || '').trim().toUpperCase()).filter(Boolean))];
        const cmbRes = await client.query(
            `SELECT macombo, tencombo, giabancombo, dangkinhdoanh,
                    COALESCE((to_jsonb(combo)->>'tamhet')::boolean, FALSE) AS tamhet
               FROM combo WHERE tenantid = $1 AND macombo = ANY($2::varchar[])`,
            [tenantId, comboCodes]
        );
        const comboMap = new Map(cmbRes.rows.map((r) => [r.macombo, r]));
        const slotRes = await client.query(
            `SELECT cs.id AS slotid, cs.macombo, cs.tenslot, cs.soluongchon,
                    csi.mamon, csi.kichthuocmacdinh, csi.chophepdoikichthuoc, csi.phuthu
               FROM combo_slots cs
               JOIN combo_slot_items csi ON csi.slotid = cs.id
              WHERE cs.tenantid = $1 AND cs.macombo = ANY($2::varchar[])`,
            [tenantId, comboCodes]
        );
        const slotItemLookup = new Map(); // `${maCombo}|${slotId}|${maMon}` -> row
        const slotItemByMon = new Map(); // `${maCombo}|${maMon}` -> row
        for (const r of slotRes.rows) {
            slotItemLookup.set(`${r.macombo}|${r.slotid}|${r.mamon}`, r);
            if (!slotItemByMon.has(`${r.macombo}|${r.mamon}`)) {
                slotItemByMon.set(`${r.macombo}|${r.mamon}`, r);
            }
        }

        // Tải bảng giá lẻ cho tất cả món trong combo để tính Pro-rata & phụ thu nâng size
        const comboMons = [...new Set(combos.flatMap((c) => (c.selections || c.items || []).map((s) => s.maMon)).filter(Boolean))];
        const cmbGiaRes = await client.query(
            `SELECT sz.MaMon, sz.KichThuoc, sz.GiaBan
               FROM SanPham_Size sz JOIN SanPham sp ON sp.MaMon = sz.MaMon
              WHERE COALESCE(sp.TenantId, 'DEFAULT') = $2 AND sz.MaMon = ANY($1::varchar[])`,
            [comboMons, tenantId]
        );
        const cmbGiaMap = new Map(cmbGiaRes.rows.map((r) => [`${r.mamon}|${r.kichthuoc}`, Number(r.giaban)]));

        for (const cmbReq of combos) {
            const code = String(cmbReq.maCombo || '').trim().toUpperCase();
            const cmbDef = comboMap.get(code);
            if (!cmbDef || !cmbDef.dangkinhdoanh) {
                throw new LoiNghiepVu(400, `Combo "${code}" không tồn tại hoặc đã ngừng kinh doanh!`);
            }
            if (cmbDef.tamhet && !laOfflineSync) {
                throw new LoiNghiepVu(409, `Combo "${cmbDef.tencombo}" hiện đang tạm hết (86'd do thiếu món con)!`, {
                    maLoi: 'COMBO_TAM_HET',
                });
            }
            const sels = Array.isArray(cmbReq.selections) ? cmbReq.selections : Array.isArray(cmbReq.items) ? cmbReq.items : [];
            if (sels.length === 0) {
                throw new LoiNghiepVu(400, `Combo "${cmbDef.tencombo}" chưa chọn món con nào!`);
            }
            const comboQty = Math.max(1, Math.floor(Number(cmbReq.soLuong || 1)));

            // Với mỗi bộ Combo, cấp 1 comboGroupUid duy nhất để phá vỡ độc lập nếu hủy 1 món con
            for (let copyIdx = 0; copyIdx < comboQty; copyIdx += 1) {
                const comboGroupUid = taoComboGroupUid();
                const proRataInput = sels.map((sel) => {
                    const rule =
                        (sel.slotId ? slotItemLookup.get(`${code}|${sel.slotId}|${sel.maMon}`) : null) ||
                        slotItemByMon.get(`${code}|${sel.maMon}`);
                    if (!rule) {
                        throw new LoiNghiepVu(400, `Món ${sel.maMon} không nằm trong danh sách hợp lệ của Combo "${cmbDef.tencombo}"!`);
                    }
                    const defaultSz = rule.kichthuocmacdinh || 'M';
                    const chosenSz = sel.kichThuoc && SIZE_HOP_LE.includes(sel.kichThuoc) ? sel.kichThuoc : defaultSz;
                    if (chosenSz !== defaultSz && !rule.chophepdoikichthuoc) {
                        throw new LoiNghiepVu(400, `Món ${sel.maMon} trong Combo "${cmbDef.tencombo}" không cho phép đổi kích thước!`);
                    }
                    const giaLeDefault = cmbGiaMap.get(`${sel.maMon}|${defaultSz}`) ?? 0;
                    const giaLeChosen = cmbGiaMap.get(`${sel.maMon}|${chosenSz}`) ?? giaLeDefault;
                    const phuThuNangSize = Math.max(0, giaLeChosen - giaLeDefault);
                    return {
                        ...sel,
                        maMon: sel.maMon,
                        kichThuoc: chosenSz,
                        soLuong: 1,
                        giaLeCoBan: giaLeDefault,
                        giaLeThucTe: giaLeChosen,
                        phuThuSlot: Number(rule.phuthu || 0),
                        phuThuNangSize,
                    };
                });

                const distributed = phanBoGiaComboProRata(Number(cmbDef.giabancombo), proRataInput);
                for (const child of distributed) {
                    expandedInputItems.push({
                        ...child,
                        _comboAllocatedPrice: child.donGia,
                        _comboRetailPrice: child.giaGocNiemYet,
                        comboGroupUid,
                        maCombo: code,
                        tenComboSnapshot: cmbDef.tencombo,
                        isTakeaway: Boolean(child.isTakeaway ?? cmbReq.isTakeaway),
                        courseNo: child.courseNo ?? cmbReq.courseNo ?? 1,
                        fireStatus: child.fireStatus ?? cmbReq.fireStatus ?? 'FIRED',
                    });
                }
            }
        }
    }

    const cacMon = [...new Set(expandedInputItems.map((m) => m.maMon))];
    const giaRes = await client.query(
        `SELECT sz.MaMon, sz.KichThuoc, sz.GiaBan, sp.TenMon,
                COALESCE(sp.TamHet, FALSE) AS TamHet,
                (to_jsonb(sp)->>'soluonggioihan86')::int AS SoLuongGioiHan86,
                COALESCE((to_jsonb(sp)->>'lamonthoigia')::boolean, FALSE) AS LaMonThoiGia,
                COALESCE(to_jsonb(sp)->>'donvibanhang', 'LY') AS DonViBanHang
           FROM SanPham_Size sz JOIN SanPham sp ON sp.MaMon = sz.MaMon
          WHERE sp.DangKinhDoanh = TRUE
            AND COALESCE(sp.TenantId, 'DEFAULT') = $2
            AND sz.MaMon = ANY($1::varchar[])`,
        [cacMon, tenantId]
    );
    const bangGia = new Map();
    const monCountdownMap = new Map();
    for (const r of giaRes.rows) {
        bangGia.set(`${r.mamon}|${r.kichthuoc}`, {
            giaBan: Number(r.giaban),
            tenMon: r.tenmon,
            tamHet: Boolean(r.tamhet),
            soLuongGioiHan86: r.soluonggioihan86 !== null && r.soluonggioihan86 !== undefined ? Number(r.soluonggioihan86) : null,
            laMonThoiGia: Boolean(r.lamonthoigia),
            donViBanHang: r.donvibanhang || 'LY',
        });
        if (r.soluonggioihan86 !== null && r.soluonggioihan86 !== undefined) {
            monCountdownMap.set(r.mamon, { tenMon: r.tenmon, limit: Number(r.soluonggioihan86) });
        }
    }

    // Ghi đè giá vùng (SanPham_GiaVung) nếu chi nhánh thuộc vùng giá riêng
    if (khuVucGia && khuVucGia !== 'DEFAULT' && cacMon.length > 0) {
        await client.query('SAVEPOINT sp_ord_giavung');
        try {
            const gvRes = await client.query(
                `SELECT mamon, kichthuoc, giaban FROM sanpham_giavung
                  WHERE tenantid = $1 AND khuvucgia = $2 AND mamon = ANY($3::varchar[])`,
                [tenantId, khuVucGia, cacMon]
            );
            for (const gv of gvRes.rows) {
                const hit = bangGia.get(`${gv.mamon}|${gv.kichthuoc}`);
                if (hit) hit.giaBan = Number(gv.giaban);
            }
            await client.query('RELEASE SAVEPOINT sp_ord_giavung');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_ord_giavung').catch(() => {});
        }
    }

    // Tải Modifiers & Substitution BOM cho các món có trong đơn
    const attachedGroupsByMon = new Map();
    const modGroupMap = new Map();
    const modOptionMap = new Map();
    const modOptionBomMap = new Map();
    if (cacMon.length > 0) {
        await client.query('SAVEPOINT sp_ord_load_mods');
        try {
            const linkRes = await client.query(
                `SELECT mamon, groupid FROM sanpham_modifier_groups
                  WHERE tenantid = $1 AND mamon = ANY($2::varchar[])`,
                [tenantId, cacMon]
            );
            for (const r of linkRes.rows) {
                if (!attachedGroupsByMon.has(r.mamon)) attachedGroupsByMon.set(r.mamon, []);
                attachedGroupsByMon.get(r.mamon).push(Number(r.groupid));
            }
            const reqOptIds = [
                ...new Set(
                    expandedInputItems
                        .flatMap((m) => (Array.isArray(m.modifiers) ? m.modifiers : []))
                        .map((x) => Number(x?.optionId ?? x?.id))
                        .filter((n) => Number.isInteger(n) && n > 0)
                ),
            ];
            const allGroupIds = [...new Set([...attachedGroupsByMon.values()].flat())];
            if (allGroupIds.length > 0 || reqOptIds.length > 0) {
                const gRes = await client.query(
                    `SELECT id, tengroup, loai, batbuoc, chontoithieu, chontoida, soluongmienphi, thutuhienthi, danghoatdong
                       FROM modifier_groups WHERE tenantid = $1`,
                    [tenantId]
                );
                for (const g of gRes.rows) {
                    modGroupMap.set(Number(g.id), {
                        id: Number(g.id),
                        tenGroup: g.tengroup,
                        loai: g.loai,
                        batBuoc: Boolean(g.batbuoc),
                        chonToiThieu: Number(g.chontoithieu || 0),
                        chonToiDa: Number(g.chontoida || 1),
                        soLuongMienPhi: Number(g.soluongmienphi || 0),
                        thuTuHienThi: Number(g.thutuhienthi || 0),
                        dangHoatDong: Boolean(g.danghoatdong),
                    });
                }
                const oRes = await client.query(
                    `SELECT id, groupid, tenoption, teninngan, lamacdinh, giacongthem, toidasoluong, tamhet, thutuhienthi
                       FROM modifier_options WHERE tenantid = $1`,
                    [tenantId]
                );
                for (const o of oRes.rows) {
                    modOptionMap.set(Number(o.id), {
                        id: Number(o.id),
                        groupId: Number(o.groupid),
                        tenOption: o.tenoption,
                        tenInNgan: o.teninngan || o.tenoption,
                        laMacDinh: Boolean(o.lamacdinh),
                        giaCongThem: Number(o.giacongthem || 0),
                        toiDaSoLuong: Number(o.toidasoluong || 1),
                        tamHet: Boolean(o.tamhet),
                        thuTuHienThi: Number(o.thutuhienthi || 0),
                    });
                }
                const bRes = await client.query(
                    `SELECT optionid, kichthuoc, manl, khoiluongdelta
                       FROM modifier_option_bom WHERE tenantid = $1`,
                    [tenantId]
                );
                for (const b of bRes.rows) {
                    const oid = Number(b.optionid);
                    if (!modOptionBomMap.has(oid)) modOptionBomMap.set(oid, []);
                    modOptionBomMap.get(oid).push({
                        kichThuoc: b.kichthuoc || null,
                        maNL: b.manl,
                        khoiLuongDelta: Number(b.khoiluongdelta),
                    });
                }
            }
            await client.query('RELEASE SAVEPOINT sp_ord_load_mods');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_ord_load_mods').catch(() => {});
        }
    }

    // Tải Cấu hình vật tư đóng gói mang đi (cauhinh_vattu_mangdi — hỗ trợ lọc theo kênh bán kenhdung)
    const packagingBySize = new Map(); // size -> [{ maNL, khoiLuong, giaVonDonVi, kenhDung }]
    await client.query('SAVEPOINT sp_ord_pack_bom');
    try {
        const pkRes = await client.query(
            `SELECT c.kichthuoc, c.manl, c.soluongtieuhao,
                    COALESCE(to_jsonb(c)->>'kenhdung', 'ALL') AS kenhdung,
                    COALESCE(nl.giavondonvi, 0) AS giavondonvi
               FROM cauhinh_vattu_mangdi c
               LEFT JOIN nguyenlieu nl ON nl.manl = c.manl
              WHERE c.tenantid = $1`,
            [tenantId]
        );
        for (const r of pkRes.rows) {
            const sz = String(r.kichthuoc || 'ALL').toUpperCase();
            if (!packagingBySize.has(sz)) packagingBySize.set(sz, []);
            packagingBySize.get(sz).push({
                maNL: r.manl,
                khoiLuong: Number(r.soluongtieuhao),
                giaVonDonVi: Number(r.giavondonvi || 0),
                kenhDung: String(r.kenhdung || 'ALL').toUpperCase(),
            });
        }
        await client.query('RELEASE SAVEPOINT sp_ord_pack_bom');
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_ord_pack_bom').catch(() => {});
    }

    const cacTopping = [...new Set(expandedInputItems.flatMap((m) => (m.toppings || []).map((t) => t.maTopping)))];
    const bangTopping = new Map();
    const bangToppingBom = new Map();
    if (cacTopping.length > 0) {
        const tpRes = await client.query(
            `SELECT tp.MaTopping, tp.TenTopping, tp.GiaTopping, tp.MaNL, tp.KhoiLuongTieuHao,
                    COALESCE(tp.TamHet, FALSE) AS TamHet,
                    COALESCE((to_jsonb(tp)->>'toidamoily')::int, 3) AS ToiDaMoiLy,
                    to_jsonb(tp)->'giabacthang' AS GiaBacThang,
                    COALESCE(nl.GiaVonDonVi, 0) AS GiaVonDonVi
               FROM Topping tp
               LEFT JOIN NguyenLieu nl ON nl.MaNL = tp.MaNL
              WHERE tp.DangKinhDoanh = TRUE
                AND COALESCE(tp.TenantId, 'DEFAULT') = $2
                AND tp.MaTopping = ANY($1::varchar[])`,
            [cacTopping, tenantId]
        );
        for (const r of tpRes.rows) {
            bangTopping.set(r.matopping, {
                tenTopping: r.tentopping,
                giaTopping: Number(r.giatopping),
                toiDaMoiLy: Number(r.toidamoily || 3),
                giaBacThang: Array.isArray(r.giabacthang) ? r.giabacthang : null,
                maNL: r.manl,
                khoiLuong: Number(r.khoiluongtieuhao),
                giaVonDonVi: Number(r.giavondonvi || 0),
                tamHet: Boolean(r.tamhet),
            });
        }
        try {
            await client.query('SAVEPOINT sp_tp_bom');
            const tpBomRes = await client.query(
                `SELECT tc.MaTopping, tc.MaNL, tc.KhoiLuongTieuHao, COALESCE(nl.GiaVonDonVi, 0) AS GiaVonDonVi
                   FROM Topping_CongThuc tc
                   LEFT JOIN NguyenLieu nl ON nl.MaNL = tc.MaNL
                  WHERE tc.TenantId = $2 AND tc.MaTopping = ANY($1::varchar[])`,
                [cacTopping, tenantId]
            );
            await client.query('RELEASE SAVEPOINT sp_tp_bom');
            for (const r of tpBomRes.rows) {
                if (!bangToppingBom.has(r.matopping)) bangToppingBom.set(r.matopping, []);
                bangToppingBom.get(r.matopping).push({
                    maNL: r.manl,
                    khoiLuong: Number(r.khoiluongtieuhao),
                    giaVonDonVi: Number(r.giavondonvi || 0),
                });
            }
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_tp_bom').catch(() => {});
        }
    }

    const congThucRes = await client.query(
        `SELECT ct.MaMon, ct.KichThuoc, ct.MaNL, ct.KhoiLuongTieuHao, COALESCE(nl.GiaVonDonVi, 0) AS GiaVonDonVi
           FROM CongThuc ct
           JOIN SanPham sp ON sp.MaMon = ct.MaMon AND COALESCE(sp.TenantId, 'DEFAULT') = $2
           LEFT JOIN NguyenLieu nl ON nl.MaNL = ct.MaNL
          WHERE ct.MaMon = ANY($1::varchar[])`,
        [cacMon, tenantId]
    );
    const bangCongThuc = new Map();
    for (const r of congThucRes.rows) {
        const key = `${r.mamon}|${r.kichthuoc}`;
        if (!bangCongThuc.has(key)) bangCongThuc.set(key, []);
        bangCongThuc.get(key).push({
            maNL: r.manl,
            khoiLuong: Number(r.khoiluongtieuhao),
            giaVonDonVi: Number(r.giavondonvi || 0),
        });
    }

    const loaiDonFinal =
        loaiDonHang && ['TAI_QUAN', 'MANG_DI', 'GIAO_HANG', 'APP_SAN'].includes(String(loaiDonHang).toUpperCase())
            ? String(loaiDonHang).toUpperCase()
            : maBan
            ? 'TAI_QUAN'
            : 'MANG_DI';

    // Chuẩn hóa từng dòng + Modifiers + Clamped Substitution BOM + Takeaway Packaging + Giá vốn snapshot
    const tieuHao = new Map();
    const congDon = (maNL, sl) => {
        if (!maNL || !(sl > 0)) return;
        tieuHao.set(maNL, lam3((tieuHao.get(maNL) || 0) + sl));
    };

    let takeawayCupsCount = 0;

    const dongMon = expandedInputItems.map((mon) => {
        const infoMon = bangGia.get(`${mon.maMon}|${mon.kichThuoc}`);
        if (!infoMon) {
            throw new LoiNghiepVu(400, `Món ${mon.maMon} (size ${mon.kichThuoc}) không tồn tại hoặc đã ngừng kinh doanh!`);
        }
        if (infoMon.tamHet) {
            if (laOfflineSync) {
                soldOutWarnings.push({
                    code: 'SYNC_SOLD_OUT_WARNING',
                    type: 'PRODUCT',
                    maMon: mon.maMon,
                    tenMon: infoMon.tenMon,
                });
            } else {
                throw new LoiNghiepVu(409, `Món "${infoMon.tenMon}" hiện đang tạm hết (quầy Bar đã khóa)!`, {
                    maLoi: 'MON_TAM_HET',
                });
            }
        }

        // Thứ tự ưu tiên giá bán chuẩn Server: Combo Pro-rata > Open Item (thời giá + RBAC) > Lô bánh giảm 50% > Giá vùng/Size
        let donGiaServer = infoMon.giaBan;
        let giaGocNiemYet = infoMon.giaBan;
        const mdBakery = bakeryMap.get(mon.maMon);
        if (mdBakery?.dangGiamGia && Number(mdBakery.soLuongConLai || 0) > 0) {
            donGiaServer = Math.round((infoMon.giaBan * (100 - mdBakery.phanTramGiam)) / 100 / 500) * 500;
            giaGocNiemYet = donGiaServer;
        }
        if (mon._comboAllocatedPrice !== undefined) {
            donGiaServer = Number(mon._comboAllocatedPrice);
            giaGocNiemYet = Number(mon._comboRetailPrice ?? infoMon.giaBan);
        } else if (infoMon.laMonThoiGia && mon.donGia !== undefined && mon.donGia !== null) {
            if (![1, 4].includes(Number(vaiTro || 1))) {
                throw new LoiNghiepVu(403, 'Chỉ Thu ngân / Quản lý mới được nhập giá cho món thời giá (Open Item)!');
            }
            const customPrice = Number(mon.donGia);
            if (!(customPrice >= 0)) throw new LoiNghiepVu(400, 'Giá món thời giá phải >= 0!');
            donGiaServer = customPrice;
            giaGocNiemYet = customPrice;
            openItemAuditRows.push({
                maMon: mon.maMon,
                tenMonTuyChinh: mon.tenMonTuyChinh || infoMon.tenMon,
                donGia: customPrice,
                soLuong: mon.soLuong,
                trongLuongGram: mon.trongLuongGram ? Number(mon.trongLuongGram) : null,
            });
        }

        // Nếu món bán theo cân ký (GRAM/KG) và có trongLuongGram -> tính giá theo gram (SanPham_Size.GiaBan = giá mỗi 1kg hoặc đơn vị chuẩn)
        let trongLuongGram = null;
        if (mon.trongLuongGram !== undefined && mon.trongLuongGram !== null && Number(mon.trongLuongGram) > 0) {
            trongLuongGram = Number(mon.trongLuongGram);
            if (infoMon.donViBanHang === 'KG') {
                donGiaServer = Math.round((donGiaServer * trongLuongGram) / 1000);
                giaGocNiemYet = donGiaServer;
            } else if (infoMon.donViBanHang === 'GRAM') {
                donGiaServer = Math.round(donGiaServer * trongLuongGram);
                giaGocNiemYet = donGiaServer;
            }
        }

        // Đánh giá Modifiers (Forced Modifiers + Smart Defaults + Free K + Substitution BOM Deltas)
        const modEval = danhGiaModifiersChoMon({
            selectedModifiers: mon.modifiers || [],
            attachedGroupIds: attachedGroupsByMon.get(mon.maMon) || [],
            groupMap: modGroupMap,
            optionMap: modOptionMap,
            optionBomMap: modOptionBomMap,
            kichThuoc: mon.kichThuoc,
            laOfflineSync,
            LoiNghiepVu,
        });
        if (modEval.soldOutWarnings.length > 0) {
            soldOutWarnings.push(...modEval.soldOutWarnings);
        }

        // Đánh giá Toppings theo đơn vị TRÊN 1 LY (SoLuongMoiLy) + Giới hạn toiDaMoiLy + Giá bậc thang
        const gopToppingPerCup = new Map();
        for (const tp of mon.toppings || []) {
            const info = bangTopping.get(tp.maTopping);
            if (!info) throw new LoiNghiepVu(400, `Topping ${tp.maTopping} không tồn tại hoặc đã ngừng kinh doanh!`);
            if (info.tamHet) {
                if (laOfflineSync) {
                    soldOutWarnings.push({
                        code: 'SYNC_SOLD_OUT_WARNING',
                        type: 'TOPPING',
                        maTopping: tp.maTopping,
                        tenTopping: info.tenTopping,
                    });
                } else {
                    throw new LoiNghiepVu(409, `Topping "${info.tenTopping}" hiện đang tạm hết!`, {
                        maLoi: 'TOPPING_TAM_HET',
                    });
                }
            }
            const perCup = Math.max(1, Math.floor(Number(tp.soLuongMoiLy ?? tp.soLuong ?? 1)));
            const nextPerCup = (gopToppingPerCup.get(tp.maTopping) || 0) + perCup;
            if (nextPerCup > info.toiDaMoiLy) {
                throw new LoiNghiepVu(
                    400,
                    `Topping "${info.tenTopping}" chỉ cho phép tối đa ${info.toiDaMoiLy} phần mỗi ly!`
                );
            }
            gopToppingPerCup.set(tp.maTopping, nextPerCup);
        }

        const toppingBomPerCup = [];
        const toppings = [...gopToppingPerCup].map(([maTopping, soLuongMoiLy]) => {
            const info = bangTopping.get(maTopping);
            const tiered = tinhGiaToppingBacThang(info.giaTopping, info.giaBacThang, soLuongMoiLy);
            const multiBom = bangToppingBom.get(maTopping);
            let giaVonMotTp = 0;
            if (multiBom && multiBom.length > 0) {
                for (const b of multiBom) {
                    toppingBomPerCup.push({
                        maNL: b.maNL,
                        khoiLuong: b.khoiLuong * soLuongMoiLy,
                        giaVonDonVi: b.giaVonDonVi,
                    });
                    giaVonMotTp += b.khoiLuong * b.giaVonDonVi;
                }
            } else if (info.maNL && info.khoiLuong > 0) {
                toppingBomPerCup.push({
                    maNL: info.maNL,
                    khoiLuong: info.khoiLuong * soLuongMoiLy,
                    giaVonDonVi: info.giaVonDonVi,
                });
                giaVonMotTp += info.khoiLuong * info.giaVonDonVi;
            }
            const bomPerUnit =
                Array.isArray(info.bom) && info.bom.length > 0
                    ? info.bom.map((b) => ({ maNL: b.maNL, khoiLuong: b.khoiLuong, giaVonDonVi: b.giaVonDonVi }))
                    : info.maNL && info.khoiLuong > 0
                      ? [{ maNL: info.maNL, khoiLuong: info.khoiLuong, giaVonDonVi: info.giaVonDonVi }]
                      : [];
            return {
                maTopping,
                tenToppingSnapshot: info.tenTopping,
                soLuongMoiLy,
                soLuong: soLuongMoiLy * mon.soLuong,
                donGia: tiered.donGiaBinhQuan,
                giaVonToppingSnapshot: Math.round(giaVonMotTp * 100) / 100,
                bomPerUnit,
            };
        });

        // Vật tư đóng gói mang đi theo kênh bán (ALL / MANG_DI / GIAO_HANG / APP_SAN)
        const isItemTakeaway = loaiDonFinal !== 'TAI_QUAN' || Boolean(mon.isTakeaway);
        const packagingBomPerCup = [];
        if (isItemTakeaway) {
            takeawayCupsCount += mon.soLuong;
            const channelTarget = loaiDonFinal === 'TAI_QUAN' ? 'MANG_DI' : loaiDonFinal;
            const specificPack = (packagingBySize.get(String(mon.kichThuoc).toUpperCase()) || []).filter(
                (p) => p.kenhDung === 'ALL' || p.kenhDung === channelTarget
            );
            const allPack = (packagingBySize.get('ALL') || []).filter(
                (p) => p.kenhDung === 'ALL' || p.kenhDung === channelTarget
            );
            packagingBomPerCup.push(...specificPack, ...allPack);
        }

        // Tính BOM 5 lớp (Base Size + Modifier Substitution + Topping + Packaging) & lưu BomSnapshotJson!
        const baseBomRows = bangCongThuc.get(`${mon.maMon}|${mon.kichThuoc}`) || [];
        const bomPerCup = tinhBomMotLySauSubstitution({
            baseBomRows,
            modifierDeltas: modEval.bomDeltas,
            toppingBomRows: toppingBomPerCup,
            packagingBomRows: packagingBomPerCup,
        });

        const lineBomSnapshot = {};
        for (const [maNL, qtyPerCup] of bomPerCup.perCupMap.entries()) {
            const lineQty = lam3(qtyPerCup * mon.soLuong);
            if (lineQty > 0) {
                lineBomSnapshot[maNL] = lineQty;
                congDon(maNL, lineQty);
            }
        }

        const fireStatus = laAwaitingPayment
            ? 'AWAITING_PAYMENT'
            : String(mon.fireStatus || 'FIRED').toUpperCase() === 'HELD'
            ? 'HELD'
            : 'FIRED';
        const courseNo = Math.max(1, Math.floor(Number(mon.courseNo || 1)));
        const laMonTang = Boolean(mon.laMonTang);
        const chietKhauMon = Math.max(0, Number(mon.chietKhauMon || 0));

        return {
            maMon: mon.maMon,
            tenMonSnapshot: mon.tenMonTuyChinh ? String(mon.tenMonTuyChinh).trim().slice(0, 150) : infoMon.tenMon,
            tenMonTuyChinh: mon.tenMonTuyChinh ? String(mon.tenMonTuyChinh).trim().slice(0, 150) : null,
            kichThuoc: mon.kichThuoc,
            soLuong: mon.soLuong,
            donGia: donGiaServer,
            giaGocNiemYet,
            giaModifiers: modEval.giaModifiers,
            modifiersSnapshot: modEval.modifiersSnapshot,
            giaVonSnapshot: bomPerCup.giaVonMotLy,
            bomPerCupMap: bomPerCup.perCupMap,
            bomSnapshotJson: lineBomSnapshot,
            chietKhauMon,
            laMonTang,
            lyDoTang: laMonTang && mon.lyDoTang ? String(mon.lyDoTang).trim().slice(0, 255) : null,
            trongLuongGram,
            comboGroupUid: mon.comboGroupUid || null,
            maCombo: mon.maCombo || null,
            tenComboSnapshot: mon.tenComboSnapshot || null,
            isTakeaway: isItemTakeaway,
            courseNo,
            fireStatus,
            ghiChu: mon.ghiChu ? String(mon.ghiChu).slice(0, 255) : null,
            toppings,
        };
    });

    if (maKH) {
        const kh = await client.query(
            "SELECT 1 FROM KhachHang WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
            [maKH, tenantId]
        );
        if (kh.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy khách hàng!');
    }

    let maHoaDon = null;
    let laHoaDonMoi = false;
    if (maBan) {
        const ban = await client.query(
            "SELECT MaBan FROM Ban WHERE MaBan = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2 FOR UPDATE",
            [maBan, tenantId]
        );
        if (ban.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy bàn!');
        maHoaDon = await layHoaDonMoCuaBan(client, maBan, true);
        if (!maHoaDon && expectedVersion !== null && expectedVersion !== undefined) {
            throw new LoiNghiepVu(
                409,
                `Bàn này vừa được thiết bị khác thanh toán hoặc chuyển bàn — vui lòng tải lại sơ đồ bàn!`,
                { maLoi: 'ORDER_CONCURRENT_MODIFIED', code: 'ORDER_CONCURRENT_MODIFIED' }
            );
        }
    } else if (maHoaDonGoc) {
        const hdExisting = await client.query(
            `SELECT MaHoaDon, TrangThaiTT FROM HoaDon
              WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
              FOR UPDATE`,
            [maHoaDonGoc, tenantId]
        );
        if (hdExisting.rows.length === 0) {
            throw new LoiNghiepVu(404, `Không tìm thấy hóa đơn #${maHoaDonGoc}!`);
        }
        if (Number(hdExisting.rows[0].trangthaitt) !== 0) {
            const latest = await layHoaDonChiTiet(client, maHoaDonGoc);
            throw new LoiNghiepVu(
                409,
                `Hóa đơn #${maHoaDonGoc} vừa được thanh toán hoặc đóng bởi thiết bị khác!`,
                {
                    maLoi: 'ORDER_CONCURRENT_MODIFIED',
                    code: 'ORDER_CONCURRENT_MODIFIED',
                    hoaDonMoiNhat: latest,
                }
            );
        }
        maHoaDon = hdExisting.rows[0].mahoadon;
    }

    // Nếu gọi thêm vào hóa đơn đang mở: kiểm tra Optimistic Locking & tính DotGoi mới
    let dotGoi = 1;
    if (maHoaDon) {
        await kiemTraVaTangVersionHoaDon(client, {
            maHoaDon,
            tenantId,
            expectedVersion,
            layHoaDonChiTiet,
            LoiNghiepVu,
        });
        await client.query('SAVEPOINT sp_sel_dotgoi');
        try {
            const dgRes = await client.query(
                `SELECT COALESCE(MAX(DotGoi), 0)::int + 1 AS next_dot FROM ChiTietHoaDon WHERE MaHoaDon = $1`,
                [maHoaDon]
            );
            dotGoi = Number(dgRes.rows[0]?.next_dot || 1);
            await client.query('RELEASE SAVEPOINT sp_sel_dotgoi');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_sel_dotgoi').catch(() => {});
        }
        // Cộng thêm phí đóng gói (nếu đợt gọi thêm có ly mang về)
        const addPackFee =
            phiDongGoi !== null && phiDongGoi !== undefined
                ? Math.max(0, Number(phiDongGoi))
                : Math.max(0, Number(phiDongGoiMoiLy || 0)) * takeawayCupsCount;
        if (addPackFee > 0) {
            await client.query('SAVEPOINT sp_upd_packfee');
            try {
                await client.query(`UPDATE HoaDon SET PhiDongGoi = COALESCE(PhiDongGoi, 0) + $2 WHERE MaHoaDon = $1`, [
                    maHoaDon,
                    addPackFee,
                ]);
                await client.query('RELEASE SAVEPOINT sp_upd_packfee');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_upd_packfee').catch(() => {});
            }
        }
    } else {
        // Hóa đơn mới: cấp SoThuTuNgay nguyên tử KHÔNG quay vòng 99 + giữ SoTheRung tách biệt hoàn toàn!
        const { seq: soThuTuNgay, soThuTuHienThi } = await capSoThuTuNgayKhongTrung(client, tenantId, normalizeBranchId(branchId || 'MAIN'));
        const soTheRungClean =
            soTheRung !== null && soTheRung !== undefined && String(soTheRung).trim() !== ''
                ? String(soTheRung).trim().slice(0, 16)
                : null;
        const initPackFee =
            phiDongGoi !== null && phiDongGoi !== undefined
                ? Math.max(0, Number(phiDongGoi))
                : Math.max(0, Number(phiDongGoiMoiLy || 0)) * takeawayCupsCount;

        let hd;
        await client.query('SAVEPOINT sp_ins_hd_v23');
        try {
            hd = await client.query(
                `INSERT INTO HoaDon
                    (MaNV, TrangThaiTT, TenantId, BranchId, ClientOrderUid, SoThuTuNgay, SoThuTuHienThi, SoTheRung,
                     LoaiDonHang, PhiDongGoi, DiaChiGiao, TenKhachVangLai, SoKhach, ThoiGianMoBan,
                     CachTinhThue, ThueVATPhanTram, PhiPhucVuPhanTram, Version)
                 VALUES ($1, 0, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP, $13, $14, $15, 1)
                 RETURNING MaHoaDon`,
                [
                    maNV,
                    tenantId,
                    branchId ? normalizeBranchId(branchId) : 'DEFAULT',
                    clientOrderUid ? String(clientOrderUid).trim().slice(0, 64) : null,
                    soThuTuNgay,
                    soThuTuHienThi,
                    soTheRungClean,
                    loaiDonFinal,
                    initPackFee,
                    diaChiGiao ? String(diaChiGiao).trim().slice(0, 500) : null,
                    tenKhachVangLai ? String(tenKhachVangLai).trim().slice(0, 100) : null,
                    Math.max(1, Math.floor(Number(soKhach || 1))),
                    cachTinhThue && ['INCLUDED', 'EXCLUDED', 'NONE'].includes(String(cachTinhThue).toUpperCase())
                        ? String(cachTinhThue).toUpperCase()
                        : 'INCLUDED',
                    Math.max(0, Number(thueVATPhanTram || 0)),
                    Math.max(0, Number(phiPhucVuPhanTram || 0)),
                ]
            );
            await client.query('RELEASE SAVEPOINT sp_ins_hd_v23');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_ins_hd_v23').catch(() => {});
            hd = await client.query(
                'INSERT INTO HoaDon (MaNV, TrangThaiTT, TenantId, SoThuTuNgay) VALUES ($1, 0, $2, $3) RETURNING MaHoaDon',
                [maNV, tenantId, soThuTuNgay]
            );
        }
        maHoaDon = hd.rows[0].mahoadon;
        laHoaDonMoi = true;
        if (laAwaitingPayment) {
            await client.query(
                `UPDATE HoaDon SET lifecycle_status = 'AWAITING_PAYMENT' WHERE MaHoaDon = $1`,
                [maHoaDon]
            );
        }
        if (maBan) {
            await client.query('INSERT INTO HoaDon_Ban (MaHoaDon, MaBan) VALUES ($1, $2)', [maHoaDon, maBan]);
            await client.query('UPDATE Ban SET TrangThai = 2 WHERE MaBan = $1', [maBan]);
        }
    }
    if (maKH) await client.query('UPDATE HoaDon SET MaKH = $1 WHERE MaHoaDon = $2', [maKH, maHoaDon]);

    // [Phân hệ 2 - Countdown 86 Stock] Trừ nguyên tử số lượng giới hạn trong ngày (chống 2 thu ngân bán vượt suất!)
    // [Wave 3B — P1-02] Đơn Counter VietQR AWAITING_PAYMENT chưa trừ suất & chưa trừ kho cho đến khi thanh toán đủ 100%
    if (monCountdownMap.size > 0 && !laAwaitingPayment) {
        const qtyByCountdownMon = new Map();
        for (const d of dongMon) {
            if (monCountdownMap.has(d.maMon)) {
                qtyByCountdownMon.set(d.maMon, (qtyByCountdownMon.get(d.maMon) || 0) + Number(d.soLuong || 1));
            }
        }
        for (const [cdMaMon, needQty] of [...qtyByCountdownMon.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            const cdRes = await client.query(
                `UPDATE public.sanpham
                    SET soluonggioihan86 = soluonggioihan86 - $1,
                        tamhet = CASE WHEN soluonggioihan86 - $1 <= 0 THEN TRUE ELSE tamhet END,
                        tamhettudong = CASE WHEN soluonggioihan86 - $1 <= 0 THEN TRUE ELSE tamhettudong END
                  WHERE mamon = $2
                    AND COALESCE(tenantid, 'DEFAULT') = $3
                    AND soluonggioihan86 IS NOT NULL
                    AND soluonggioihan86 >= $1
                  RETURNING mamon, tenmon, soluonggioihan86, tamhet`,
                [needQty, cdMaMon, tenantId]
            );
            if (cdRes.rows.length === 0) {
                const info = monCountdownMap.get(cdMaMon);
                if (laOfflineSync) {
                    soldOutWarnings.push({
                        code: 'OUT_OF_COUNTDOWN_STOCK',
                        type: 'COUNTDOWN',
                        maMon: cdMaMon,
                        tenMon: info?.tenMon || cdMaMon,
                    });
                } else {
                    throw new LoiNghiepVu(
                        409,
                        `Món "${info?.tenMon || cdMaMon}" không đủ suất giới hạn trong ngày (Countdown 86)!`,
                        { code: 'OUT_OF_COUNTDOWN_STOCK', maLoi: 'OUT_OF_COUNTDOWN_STOCK', maMon: cdMaMon }
                    );
                }
            } else {
                const row = cdRes.rows[0];
                countdownUpdates.push({
                    maMon: row.mamon,
                    tenMon: row.tenmon,
                    soLuongGioiHan86: Number(row.soluonggioihan86),
                    tamHet: Boolean(row.tamhet),
                });
            }
        }
    }

    // [Phân hệ 4 - 100/100] Kiểm tra & trừ kho Single-Source TonKhoChiNhanh (ORDER BY MaNL ASC FOR UPDATE -> 0% Deadlock, FEFO & Historical Offline WAC)
    // [Wave 3B — P1-02] Đơn AWAITING_PAYMENT chưa trừ kho ở bước tạo đơn (sẽ trừ nguyên tử khi chốt PAID)
    const canhBaoTonThap = [];
    const orderBranchId = normalizeInventoryBranch(tenantId, branchId);
    const branchWacUsedMap = new Map();
    if (tieuHao.size > 0 && !laAwaitingPayment) {
        const dsNL = [...tieuHao.keys()];
        const { branchId: lockedBranchId, stockMap } = await lockBranchStockOrdered(client, tenantId, orderBranchId, dsNL);

        const thieu = [];
        for (const maNL of dsNL.sort((a, b) => a.localeCompare(b))) {
            const st = stockMap.get(maNL);
            if (!st) continue;
            const need = tieuHao.get(maNL);
            if (st.soLuongTon + 1e-9 < need) {
                thieu.push({
                    maNL: st.maNL,
                    tenNL: st.tenNL,
                    donViTinh: st.donViTinh,
                    canDung: lam3(need),
                    conLai: st.soLuongTon,
                });
            }
            const conSauBan = lam3(st.soLuongTon - need);
            if (conSauBan <= st.hanMucCanhBao) {
                canhBaoTonThap.push({
                    maNL: st.maNL,
                    tenNL: st.tenNL,
                    donViTinh: st.donViTinh,
                    conLai: conSauBan,
                });
            }
        }

        if (thieu.length > 0 && !allowNegativeStock) {
            const ten = thieu.map((t) => `${t.tenNL} (cần ${t.canDung}, còn ${t.conLai} ${t.donViTinh})`).join('; ');
            throw new LoiNghiepVu(409, `Không đủ nguyên liệu: ${ten}`, { maLoi: 'HET_NGUYEN_LIEU', nguyenLieuThieu: thieu });
        }

        const caMo = await layCaDangMo(client, 'SHARE', tenantId, { branchId: lockedBranchId });
        const phieu = await client.query(
            `INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan, NgayChungTu, TrangThaiDuyet)
             VALUES ($1, $2, $3, $4, $5, $6, $7::date, 'POSTED')
             RETURNING MaGiaoDich`,
            [
                maNV,
                LOAI_GD_TIEU_HAO,
                `Tiêu hao bán hàng - HĐ ${maHoaDon}`,
                tenantId,
                lockedBranchId,
                caMo ? String(caMo.macathungan) : null,
                todayDateVN(),
            ]
        );
        const maGiaoDich = phieu.rows[0].magiaodich;

        for (const [maNL, sl] of [...tieuHao].sort((a, b) => a[0].localeCompare(b[0]))) {
            const st = stockMap.get(maNL);
            if (!st) continue;
            const soLuong = lam3(sl);
            let donGiaVonSnapshot = st.giaVonDonVi;
            if (laOfflineSync && offlineCreatedAt) {
                donGiaVonSnapshot = await lookupHistoricalWac(client, {
                    tenantId,
                    branchId: lockedBranchId,
                    maNL,
                    atTimestamp: offlineCreatedAt,
                    fallbackWac: st.giaVonDonVi,
                });
            }
            branchWacUsedMap.set(maNL, donGiaVonSnapshot);

            // Tiêu hao theo Lô FEFO tự động (nếu nguyên liệu có lô đang ACTIVE)
            await consumeFefoBatches(client, {
                tenantId,
                branchId: lockedBranchId,
                maNL,
                qty: soLuong,
            });

            const tonTruoc = st.soLuongTon;
            const tonSau = lam3(tonTruoc - soLuong);

            await insertLedgerLine(client, {
                maGiaoDich,
                maNL,
                soLuong,
                donGiaNhap: donGiaVonSnapshot,
                tinhTrang: 'Tiêu hao bán hàng',
                tonTruoc,
                tonSau,
                giaVonTruoc: st.giaVonDonVi,
                giaVonSau: st.giaVonDonVi,
            });

            await updateBranchStockRow(client, {
                tenantId,
                branchId: lockedBranchId,
                maNL,
                nextQty: tonSau,
            });
        }

        // [Wave 2 — P0-05] Cập nhật lại GiaVonSnapshot (bao gồm bao bì) & giaVonToppingSnapshot theo đúng branchWacUsedMap!
        for (const dong of dongMon) {
            if (dong.bomPerCupMap && dong.bomPerCupMap.size > 0) {
                let cogsCup = 0;
                for (const [mNl, qCup] of dong.bomPerCupMap.entries()) {
                    cogsCup += Number(qCup || 0) * Number(branchWacUsedMap.get(mNl) ?? stockMap.get(mNl)?.giaVonDonVi ?? 0);
                }
                dong.giaVonSnapshot = Math.round(cogsCup * 100) / 100;
            }
            if (Array.isArray(dong.toppings) && dong.toppings.length > 0) {
                for (const tp of dong.toppings) {
                    if (Array.isArray(tp.bomPerUnit) && tp.bomPerUnit.length > 0) {
                        let cogsTp = 0;
                        for (const b of tp.bomPerUnit) {
                            const wacNl = Number(
                                branchWacUsedMap.get(b.maNL) ?? stockMap.get(b.maNL)?.giaVonDonVi ?? b.giaVonDonVi ?? 0
                            );
                            cogsTp += Number(b.khoiLuong || 0) * wacNl;
                        }
                        tp.giaVonToppingSnapshot = Math.round(cogsTp * 100) / 100;
                    }
                }
            }
        }
    }

    const dsMaCTHD = [];
    const dsMaCTHDFired = [];
    for (const dong of dongMon) {
        let cthd;
        await client.query('SAVEPOINT sp_ins_cthd_v23');
        try {
            cthd = await client.query(
                `INSERT INTO ChiTietHoaDon
                    (MaHoaDon, MaMon, TenMonSnapshot, TenMonTuyChinh, KichThuoc, SoLuong, DonGia, GiaGocNiemYet,
                     GiaModifiers, ModifiersSnapshot, GiaVonSnapshot, ChietKhauMon, LaMonTang, LyDoTang, TrongLuongGram,
                     ComboGroupUid, MaCombo, TenComboSnapshot, DotGoi, IsTakeaway, CourseNo, FireStatus, FiredAt,
                     GhiChu, BomSnapshotJson, TrangThaiPhaChe)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,'ChoPhaChe')
                 RETURNING MaCTHD`,
                [
                    maHoaDon,
                    dong.maMon,
                    dong.tenMonSnapshot,
                    dong.tenMonTuyChinh,
                    dong.kichThuoc,
                    dong.soLuong,
                    dong.donGia,
                    dong.giaGocNiemYet,
                    dong.giaModifiers,
                    JSON.stringify(dong.modifiersSnapshot || []),
                    dong.giaVonSnapshot,
                    dong.chietKhauMon,
                    dong.laMonTang,
                    dong.lyDoTang,
                    dong.trongLuongGram,
                    dong.comboGroupUid,
                    dong.maCombo,
                    dong.tenComboSnapshot,
                    dotGoi,
                    dong.isTakeaway,
                    dong.courseNo,
                    dong.fireStatus,
                    dong.fireStatus === 'FIRED' ? new Date().toISOString() : null,
                    dong.ghiChu,
                    JSON.stringify(dong.bomSnapshotJson || {}),
                ]
            );
            await client.query('RELEASE SAVEPOINT sp_ins_cthd_v23');
        } catch (insErr) {
            console.warn('⚠️ Fallback INSERT ChiTietHoaDon (v23):', insErr.message);
            await client.query('ROLLBACK TO SAVEPOINT sp_ins_cthd_v23').catch(() => {});
            cthd = await client.query(
                `INSERT INTO ChiTietHoaDon (MaHoaDon, MaMon, TenMonSnapshot, KichThuoc, SoLuong, DonGia, GiaVonSnapshot, GhiChu, TrangThaiPhaChe)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ChoPhaChe') RETURNING MaCTHD`,
                [maHoaDon, dong.maMon, dong.tenMonSnapshot, dong.kichThuoc, dong.soLuong, dong.donGia, dong.giaVonSnapshot, dong.ghiChu]
            );
        }
        const maCTHD = cthd.rows[0].macthd;
        dsMaCTHD.push(maCTHD);
        if (dong.fireStatus === 'FIRED') dsMaCTHDFired.push(maCTHD);

        for (const tp of dong.toppings) {
            await client.query('SAVEPOINT sp_ins_cthd_tp_v23');
            try {
                await client.query(
                    `INSERT INTO ChiTietHoaDon_Topping
                        (MaCTHD, MaTopping, TenToppingSnapshot, SoLuong, SoLuongMoiLy, DonGia, GiaVonToppingSnapshot)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        maCTHD,
                        tp.maTopping,
                        tp.tenToppingSnapshot || null,
                        tp.soLuong,
                        tp.soLuongMoiLy || 1,
                        tp.donGia,
                        tp.giaVonToppingSnapshot || 0,
                    ]
                );
                await client.query('RELEASE SAVEPOINT sp_ins_cthd_tp_v23');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_ins_cthd_tp_v23').catch(() => {});
                await client.query(
                    'INSERT INTO ChiTietHoaDon_Topping (MaCTHD, MaTopping, SoLuong, DonGia) VALUES ($1, $2, $3, $4)',
                    [maCTHD, tp.maTopping, tp.soLuong, tp.donGia]
                );
            }
        }
    }

    // [Phân hệ 2 - Open Item Audit] Ghi nhận nhật ký bắt buộc khi Thu ngân/Quản lý tạo món thời giá / cân ký
    if (openItemAuditRows.length > 0) {
        for (const oi of openItemAuditRows) {
            await ghiAuditLog(client, {
                tenantId,
                maNV,
                vaiTro,
                hanhDong: 'OPEN_ITEM_CREATED',
                doiTuong: 'HOADON',
                maDoiTuong: maHoaDon,
                giaTriMoi: oi,
                ip,
                batBuoc: true,
            });
        }
    }

    // Tự động tính lại Tổng tiền, Thuế VAT, Phí phục vụ & Kiểm định lại Khuyến mãi trong cùng ACID Transaction
    const recalc = await recalculateInvoiceTotals(client, {
        tenantId,
        maHoaDon,
        maNV,
        vaiTro,
        ip,
        ghiAuditLog,
        kiemTraHopLeKhuyenMai,
    });

    return {
        maHoaDon,
        branchId: normalizeBranchId(branchId || 'DEFAULT'),
        laHoaDonMoi,
        dotGoi,
        dsMaCTHD,
        dsMaCTHDFired,
        canhBaoTonThap,
        soldOutWarnings,
        countdownUpdates,
        promoAdjusted: recalc.promoAdjusted,
        promoAdjustReasons: recalc.promoAdjustReasons,
    };
}


// Helper dùng chung: đọc Map<MaNL, GiaVonDonVi> hiện tại để snapshot vào ChiTietGiaoDichKho.DonGiaNhap (chống ghi 0đ khi xuất hủy/tiêu hao/hoàn kho)
async function layMapGiaVonNguyenLieu(client, tenantId, dsMaNL) {
    const list = [...new Set((dsMaNL || []).filter(Boolean))];
    const map = new Map();
    if (list.length === 0) return map;
    const r = await client.query(
        `SELECT MaNL, COALESCE(GiaVonDonVi, 0) AS GiaVonDonVi
           FROM NguyenLieu
          WHERE MaNL = ANY($1::varchar[]) AND COALESCE(TenantId, 'DEFAULT') = $2`,
        [list, tenantId]
    );
    for (const row of r.rows) {
        map.set(row.manl, Number(row.giavondonvi || 0));
    }
    return map;
}

// Helper dùng chung: gom định lượng nguyên liệu (Món + Substitution BOM Modifiers + Topping đa NL + Vật tư mang đi)
async function congDinhLuongNguyenLieuDongMon(client, tenantId, { maCTHD, maMon, kichThuoc, soLuong }, tieuHaoMap) {
    const congNL = (maNL, sl) => {
        if (!maNL || !(sl > 0)) return;
        tieuHaoMap.set(maNL, lam3((tieuHaoMap.get(maNL) || 0) + sl));
    };

    // [Phân hệ 4 - 5-Layer BOM Snapshot] Nếu dòng ChiTietHoaDon đã lưu BomSnapshotJson lúc bán -> hoàn trả 100% chính xác từng ml/cái!
    await client.query('SAVEPOINT sp_bom_snap_read');
    try {
        const snapRes = await client.query(
            `SELECT (to_jsonb(c)->'bomsnapshotjson') AS snap FROM ChiTietHoaDon c WHERE c.MaCTHD = $1`,
            [maCTHD]
        );
        await client.query('RELEASE SAVEPOINT sp_bom_snap_read');
        const snap = snapRes.rows[0]?.snap;
        if (snap && typeof snap === 'object' && !Array.isArray(snap) && Object.keys(snap).length > 0) {
            for (const [maNL, qty] of Object.entries(snap)) {
                congNL(maNL, Number(qty));
            }
            return;
        }
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_bom_snap_read').catch(() => {});
    }

    const ctRes = await client.query(
        'SELECT MaNL, KhoiLuongTieuHao FROM CongThuc WHERE MaMon = $1 AND KichThuoc = $2',
        [maMon, kichThuoc]
    );
    const baseBomRows = ctRes.rows.map((ct) => ({
        maNL: ct.manl,
        khoiLuong: Number(ct.khoiluongtieuhao),
    }));

    // Đọc ModifiersSnapshot & IsTakeaway trên ChiTietHoaDon (nếu có) để hoàn/hủy đúng Substitution BOM & vật tư đóng gói
    let modifierDeltas = [];
    let isTakeaway = false;
    await client.query('SAVEPOINT sp_bom_cthd_meta');
    try {
        const metaRes = await client.query(
            `SELECT COALESCE((to_jsonb(c)->'modifierssnapshot')::jsonb, '[]'::jsonb) AS mods,
                    COALESCE((to_jsonb(c)->>'istakeaway')::boolean, FALSE) AS istakeaway
               FROM ChiTietHoaDon c WHERE c.MaCTHD = $1`,
            [maCTHD]
        );
        const mods = Array.isArray(metaRes.rows[0]?.mods) ? metaRes.rows[0].mods : [];
        isTakeaway = Boolean(metaRes.rows[0]?.istakeaway);
        const optIds = [...new Set(mods.map((m) => Number(m?.optionId)).filter((n) => Number.isInteger(n) && n > 0))];
        if (optIds.length > 0) {
            const mbRes = await client.query(
                `SELECT optionid, kichthuoc, manl, khoiluongdelta
                   FROM modifier_option_bom
                  WHERE tenantid = $1 AND optionid = ANY($2::bigint[])`,
                [tenantId, optIds]
            );
            const bomByOpt = new Map();
            for (const b of mbRes.rows) {
                const oid = Number(b.optionid);
                if (!bomByOpt.has(oid)) bomByOpt.set(oid, []);
                bomByOpt.get(oid).push(b);
            }
            for (const m of mods) {
                const oid = Number(m?.optionId);
                const qty = Math.max(1, Number(m?.qty || 1));
                const rows = bomByOpt.get(oid) || [];
                const spec = rows.filter((b) => b.kichthuoc && b.kichthuoc === kichThuoc);
                const univ = rows.filter((b) => !b.kichthuoc);
                for (const b of spec.length > 0 ? spec : univ) {
                    modifierDeltas.push({ maNL: b.manl, khoiLuongDelta: Number(b.khoiluongdelta) * qty });
                }
            }
        }
        await client.query('RELEASE SAVEPOINT sp_bom_cthd_meta');
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_bom_cthd_meta').catch(() => {});
    }

    const packagingBomRows = [];
    if (isTakeaway) {
        await client.query('SAVEPOINT sp_bom_pack_void');
        try {
            const pkRes = await client.query(
                `SELECT manl, soluongtieuhao FROM cauhinh_vattu_mangdi
                  WHERE tenantid = $1 AND kichthuoc IN ($2, 'ALL')`,
                [tenantId, String(kichThuoc || 'M').toUpperCase()]
            );
            for (const r of pkRes.rows) {
                packagingBomRows.push({ maNL: r.manl, khoiLuong: Number(r.soluongtieuhao) });
            }
            await client.query('RELEASE SAVEPOINT sp_bom_pack_void');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_bom_pack_void').catch(() => {});
        }
    }

    const perCupCalc = tinhBomMotLySauSubstitution({
        baseBomRows,
        modifierDeltas,
        toppingBomRows: [],
        packagingBomRows,
    });
    for (const [maNL, perCupQty] of perCupCalc.perCupMap.entries()) {
        congNL(maNL, perCupQty * Number(soLuong));
    }

    const tpRes = await client.query(
        `SELECT ctp.MaTopping, tp.MaNL, tp.KhoiLuongTieuHao, ctp.SoLuong
           FROM ChiTietHoaDon_Topping ctp JOIN Topping tp ON tp.MaTopping = ctp.MaTopping
          WHERE ctp.MaCTHD = $1`,
        [maCTHD]
    );
    for (const tp of tpRes.rows) {
        let usedMulti = false;
        try {
            await client.query('SAVEPOINT sp_bom_tp');
            const mRes = await client.query(
                'SELECT MaNL, KhoiLuongTieuHao FROM Topping_CongThuc WHERE TenantId = $1 AND MaTopping = $2',
                [tenantId, tp.matopping]
            );
            await client.query('RELEASE SAVEPOINT sp_bom_tp');
            if (mRes.rows.length > 0) {
                usedMulti = true;
                for (const b of mRes.rows) {
                    congNL(b.manl, Number(b.khoiluongtieuhao) * Number(tp.soluong));
                }
            }
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_bom_tp').catch(() => {});
        }
        if (!usedMulti) {
            congNL(tp.manl, Number(tp.khoiluongtieuhao) * Number(tp.soluong));
        }
    }
}


// ---- Tiện ích Thanh toán Hỗn hợp (Order_Payments 1-N) & Xác thực Webhook VietQR ----
function chonPhuongThucChinh(dsThanhToan) {
    // Tương thích ngược với constraint HoaDon.PhuongThucTT (TIEN_MAT | CHUYEN_KHOAN | THE)
    const tongTheoPttt = new Map();
    for (const p of dsThanhToan) {
        if (PHUONG_THUC_LEGACY.includes(p.phuongThucTT)) {
            tongTheoPttt.set(p.phuongThucTT, (tongTheoPttt.get(p.phuongThucTT) || 0) + Number(p.soTien));
        }
    }
    let best = 'TIEN_MAT';
    let maxVal = -1;
    for (const [k, v] of tongTheoPttt) {
        if (v > maxVal) {
            maxVal = v;
            best = k;
        }
    }
    return best;
}

// [P0] Chuẩn hóa & chặn lệch sổ cái khi thu vượt (Split Tender Overpayment + VietQR Chuyển thừa)
function chuanHoaKhoanThanhToanVaThuThua({
    cacKhoanTT,
    conLaiTruoc,
    vaiTro = null,
    voucherApprovedByManager = false,
    khoaIdem = null,
}) {
    const dongGhi = [];

    for (let i = 0; i < cacKhoanTT.length; i++) {
        const k = cacKhoanTT[i];
        const pt = k.phuongThucTT;
        if (!PHUONG_THUC_TT.includes(pt)) {
            throw new LoiNghiepVu(400, `Phương thức thanh toán "${pt}" không hợp lệ!`);
        }
        if (pt === 'VOUCHER' && vaiTro !== 1 && !voucherApprovedByManager) {
            throw new LoiNghiepVu(403, 'Chỉ Quản lý hoặc mã PIN Quản lý mới có quyền xác nhận thanh toán bằng VOUCHER!', {
                code: 'VOUCHER_PIN_REQUIRED',
                maLoi: 'CAN_PIN_QUAN_LY',
            });
        }
        const soTien = Math.round(Number(k.soTien) * 100) / 100;
        if (!(soTien > 0)) {
            throw new LoiNghiepVu(400, 'Số tiền mỗi khoản thanh toán phải > 0!');
        }

        let tienKhachDua = k.tienKhachDua !== undefined && k.tienKhachDua !== null ? Number(k.tienKhachDua) : null;
        let tienThua = 0;
        if (pt === 'TIEN_MAT' && tienKhachDua !== null) {
            if (!(tienKhachDua >= soTien)) {
                throw new LoiNghiepVu(400, 'Số tiền khách đưa cho khoản tiền mặt chưa đủ!', { canThu: soTien });
            }
            tienThua = Math.round((tienKhachDua - soTien) * 100) / 100;
        } else if (pt !== 'TIEN_MAT') {
            tienKhachDua = soTien;
        }

        dongGhi.push({
            phuongThucTT: pt,
            soTien,
            tienKhachDua: tienKhachDua !== null ? tienKhachDua : soTien,
            tienThua,
            tienChuyenThua: 0,
            maGiaoDichNgoai: k.maGiaoDichNgoai || null,
            noiDungCK: k.noiDungCK || null,
            maChuanChiEDC: k.maChuanChiEDC ? String(k.maChuanChiEDC).trim().slice(0, 64) : null,
            bonSoCuoiThe: k.bonSoCuoiThe ? String(k.bonSoCuoiThe).trim().slice(0, 8) : null,
            nguonXacNhan: k.nguonXacNhan || 'POS_MANUAL',
            khoaIdem: khoaIdem && i === 0 ? khoaIdem : null,
        });
    }

    const laWebhook =
        dongGhi.length > 0 &&
        dongGhi.every((d) => ['SEPAY_WEBHOOK', 'PAYOS_WEBHOOK', 'WEBHOOK_SIMULATOR', 'MANUAL_BANK_MATCH'].includes(d.nguonXacNhan));
    const tongRaw = Math.round(dongGhi.reduce((s, d) => s + d.soTien, 0) * 100) / 100;
    let tienChuyenThua = 0;

    if (!laWebhook) {
        const tongNonCash = Math.round(
            dongGhi.filter((d) => d.phuongThucTT !== 'TIEN_MAT').reduce((s, d) => s + d.soTien, 0) * 100
        ) / 100;
        if (tongNonCash > conLaiTruoc + 0.01) {
            throw new LoiNghiepVu(
                400,
                `Tổng Chuyển khoản/Thẻ/Voucher (${tongNonCash.toLocaleString('vi-VN')}đ) vượt quá số tiền còn lại của hóa đơn (${conLaiTruoc.toLocaleString('vi-VN')}đ)!`,
                { conLai: conLaiTruoc, tongNonCash }
            );
        }
        if (tongRaw > conLaiTruoc + 0.01) {
            if (tongNonCash >= conLaiTruoc - 0.01 && dongGhi.some((d) => d.phuongThucTT === 'TIEN_MAT')) {
                throw new LoiNghiepVu(
                    400,
                    'Các khoản Chuyển khoản/Thẻ đã đủ thanh toán hóa đơn, không cần thu thêm Tiền mặt!'
                );
            }
            let duCanCat = Math.round((tongRaw - conLaiTruoc) * 100) / 100;
            for (let i = dongGhi.length - 1; i >= 0 && duCanCat > 0; i--) {
                if (dongGhi[i].phuongThucTT !== 'TIEN_MAT') continue;
                const gocSoTien = dongGhi[i].soTien;
                const cat = Math.min(gocSoTien, duCanCat);
                const soTienMoi = Math.round((gocSoTien - cat) * 100) / 100;
                if (soTienMoi <= 0) {
                    throw new LoiNghiepVu(
                        400,
                        'Khoản tiền mặt nhập vào bị dư hoàn toàn so với phần còn lại cần thu!'
                    );
                }
                dongGhi[i].soTien = soTienMoi;
                dongGhi[i].tienThua = Math.round((dongGhi[i].tienKhachDua - soTienMoi) * 100) / 100;
                duCanCat = Math.round((duCanCat - cat) * 100) / 100;
            }
        }
    } else if (conLaiTruoc > 0 && tongRaw > conLaiTruoc + 0.01) {
        tienChuyenThua = Math.round((tongRaw - conLaiTruoc) * 100) / 100;
        dongGhi[0].tienKhachDua = dongGhi[0].soTien; // Giữ nguyên số tiền ngân hàng báo chuyển
        dongGhi[0].soTien = conLaiTruoc; // Sổ cái chỉ ghi nhận đúng phần thanh toán hóa đơn
        dongGhi[0].tienChuyenThua = tienChuyenThua;
    }

    const tongThuLanNay = Math.round(dongGhi.reduce((s, d) => s + d.soTien, 0) * 100) / 100;
    const tongTienThua = Math.round(dongGhi.reduce((s, d) => s + d.tienThua, 0) * 100) / 100;
    return { dongGhi, tongThuLanNay, tongTienThua, tienChuyenThua };
}

// Dùng chung cho POS Thanh toán (Đơn/Hỗn hợp/Thu 1 phần/Chia tiền/Khuyến mãi/Đổi điểm/Optimistic Locking) và Webhook VietQR tự động
async function ghiNhanThanhToanTrongGiaoDich(
    client,
    {
        maHoaDon,
        expectedTenantId = null,
        expectedVersion = null,
        mandatoryVersion = true,
        chiaTienId = null,
        ca,
        maNV,
        vaiTro = null,
        voucherApprovedByManager = false,
        maKH = null,
        maKhuyenMai = null,
        diemSuDung = 0,
        tuDongHappyHour = false,
        autoFillSingleMethod = null, // { phuongThucTT, tienKhachDua }
        cacKhoanTT, // [{ phuongThucTT, soTien, tienKhachDua, maGiaoDichNgoai, noiDungCK, nguonXacNhan }]
        choPhepThuMotPhan = false,
        khoaIdem = null,
        laOfflineLechCa = false,
        maCaThuNganGoc = null,
        branchId = null,
        terminalId = null,
        ip = null,
    }
) {
    await client.query(
        `SELECT MaBan FROM Ban
          WHERE MaBan IN (SELECT MaBan FROM HoaDon_Ban WHERE MaHoaDon = $1)
          ORDER BY MaBan FOR UPDATE`,
        [maHoaDon]
    );
    const hdRes = await client.query(
        `SELECT TrangThaiTT, COALESCE(to_jsonb(HoaDon)->>'lifecycle_status', 'OPEN') AS lifecycle_status,
                MaKH, COALESCE(TenantId, 'DEFAULT') AS TenantId
           FROM HoaDon WHERE MaHoaDon = $1 FOR UPDATE`,
        [maHoaDon]
    );
    if (hdRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn!');
    const hdTenantId = hdRes.rows[0].tenantid || 'DEFAULT';
    if (expectedTenantId && hdTenantId !== expectedTenantId) {
        throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn!');
    }
    if (hdRes.rows[0].lifecycle_status === 'VOIDED') {
        throw new LoiNghiepVu(409, 'Hóa đơn này đã bị hủy (VOIDED), không thể thanh toán!', {
            code: 'ORDER_VOIDED',
            maLoi: 'ORDER_VOIDED',
        });
    }
    if (hdRes.rows[0].trangthaitt === 2) throw new LoiNghiepVu(409, 'Hóa đơn này đã được hoàn tiền!');
    if (hdRes.rows[0].trangthaitt === 3 || hdRes.rows[0].lifecycle_status === 'MERGED') {
        throw new LoiNghiepVu(409, 'Hóa đơn này đã được gộp sang hóa đơn khác!');
    }
    if (hdRes.rows[0].trangthaitt !== 0) {
        throw new LoiNghiepVu(409, 'Hóa đơn này đã được thanh toán hoàn tất trước đó!', {
            code: 'ALREADY_PAID',
            maLoi: 'ALREADY_PAID',
        });
    }

    // [Phân hệ 1 - 100/100] Khóa lạc quan (Optimistic Locking) chống Phục vụ & Thu ngân ghi đè cùng 1 bàn!
    await kiemTraVaTangVersionHoaDon(client, {
        maHoaDon,
        tenantId: hdTenantId,
        expectedVersion,
        mandatory: mandatoryVersion,
        layHoaDonChiTiet,
        LoiNghiepVu,
    });

    if (maKH) {
        const kh = await client.query(
            "SELECT 1 FROM KhachHang WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
            [maKH, hdTenantId]
        );
        if (kh.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy khách hàng!');
        await client.query('UPDATE HoaDon SET MaKH = $1 WHERE MaHoaDon = $2', [maKH, maHoaDon]);
    }

    const chiTietTruoc = await layHoaDonChiTiet(client, maHoaDon);
    if (chiTietTruoc.soMonHopLe === 0) throw new LoiNghiepVu(400, 'Hóa đơn không còn món hợp lệ nào để thanh toán!');

    // Kiểm tra phần chia tiền (nếu thanh toán theo HoaDon_ChiaTien)
    let chiaTienRow = null;
    if (chiaTienId !== null && chiaTienId !== undefined) {
        const ctRes = await client.query(
            `SELECT id, mahoadon, nhanchia, sotienphaitra, sotiendatra, trangthai
               FROM hoadon_chiatien
              WHERE id = $1 AND tenantid = $2 AND mahoadon = $3::text
              FOR UPDATE`,
            [Number(chiaTienId), hdTenantId, String(maHoaDon)]
        );
        if (ctRes.rows.length === 0) {
            throw new LoiNghiepVu(404, 'Không tìm thấy phần chia tiền tương ứng của hóa đơn!');
        }
        chiaTienRow = ctRes.rows[0];
        if (chiaTienRow.trangthai !== 'UNPAID') {
            throw new LoiNghiepVu(409, `Phần chia "${chiaTienRow.nhanchia}" đã được thanh toán hoặc đã hủy!`);
        }
    }

    // Áp Khuyến mãi (Mã giảm giá / Happy Hour) & Đổi điểm Loyalty nếu hóa đơn chưa áp ưu đãi trước đó
    const khHienTai = maKH || hdRes.rows[0].makh || null;
    let tienGiamKMFinal = Number(chiTietTruoc.tienGiamKM || 0);
    let tienGiamDiemFinal = Number(chiTietTruoc.tienGiamDiem || 0);
    const chuaApUuDai =
        tienGiamKMFinal + tienGiamDiemFinal === 0 && !chiTietTruoc.maKhuyenMai && Number(chiTietTruoc.diemSuDung || 0) === 0;
    const muonApUuDai = Boolean(maKhuyenMai) || Number(diemSuDung || 0) > 0 || (tuDongHappyHour && chiTietTruoc.daThanhToan === 0);

    if (chuaApUuDai && muonApUuDai) {
        const uuDai = await tinhUuDaiVaDiemTrongGiaoDich(client, {
            tenantId: hdTenantId,
            tongTamTinh: chiTietTruoc.tongTamTinh,
            maKhuyenMai,
            maKH: khHienTai,
            diemSuDung,
            tuDongHappyHour: Boolean(tuDongHappyHour),
            khoaCapNhat: true,
            LoiNghiepVu,
        });
        tienGiamKMFinal = uuDai.tienGiamKM;
        tienGiamDiemFinal = uuDai.tienGiamDiem;
        if (uuDai.tongGiamGia > 0 || uuDai.maKhuyenMai) {
            await client.query('SAVEPOINT sp_tt_promo');
            try {
                await client.query(
                    `UPDATE HoaDon
                        SET MaKhuyenMai = $2, TenKhuyenMai = $3, TienGiamKM = $4, DiemSuDung = $5, TienGiamDiem = $6
                      WHERE MaHoaDon = $1`,
                    [
                        maHoaDon,
                        uuDai.maKhuyenMai,
                        uuDai.tenKhuyenMai,
                        uuDai.tienGiamKM,
                        uuDai.diemSuDung,
                        uuDai.tienGiamDiem,
                    ]
                );
                await client.query('RELEASE SAVEPOINT sp_tt_promo');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_tt_promo').catch(() => {});
            }
        }
    }

    const keToanPay = tinhTongKeToanHoaDon({
        danhSachMon: chiTietTruoc.danhSachMon,
        tienGiamKM: tienGiamKMFinal,
        tienGiamDiem: tienGiamDiemFinal,
        loaiDonHang: chiTietTruoc.loaiDonHang,
        phiPhucVuPhanTram: chiTietTruoc.phiPhucVuPhanTram,
        phiDongGoi: chiTietTruoc.phiDongGoi,
        cachTinhThue: chiTietTruoc.cachTinhThue,
        thueVATPhanTram: chiTietTruoc.thueVATPhanTram,
    });
    const tongTien = keToanPay.tongPhaiTra;
    const daThuTruoc = chiTietTruoc.daThanhToan;
    const conLaiTruoc = Math.max(0, Math.round((tongTien - daThuTruoc) * 100) / 100);
    const mucThuMucTieu = chiaTienRow
        ? Math.min(conLaiTruoc, Math.max(0, Number(chiaTienRow.sotienphaitra) - Number(chiaTienRow.sotiendatra || 0)))
        : conLaiTruoc;
    const allowPartial = Boolean(choPhepThuMotPhan || chiaTienRow);

    let dongGhi = [];
    let tongThuLanNay = 0;
    let tongTienThua = 0;
    let tienChuyenThua = 0;

    if (conLaiTruoc > 0) {
        const khoanTTThucTe =
            (!Array.isArray(cacKhoanTT) || cacKhoanTT.length === 0) && autoFillSingleMethod
                ? [
                      {
                          phuongThucTT: autoFillSingleMethod.phuongThucTT,
                          soTien: mucThuMucTieu,
                          tienKhachDua: autoFillSingleMethod.tienKhachDua,
                          noiDungCK: autoFillSingleMethod.noiDungCK || null,
                          nguonXacNhan: autoFillSingleMethod.nguonXacNhan || 'POS_MANUAL',
                      },
                  ]
                : cacKhoanTT;
        const norm = chuanHoaKhoanThanhToanVaThuThua({
            cacKhoanTT: khoanTTThucTe,
            conLaiTruoc: chiaTienRow ? mucThuMucTieu : conLaiTruoc,
            vaiTro,
            voucherApprovedByManager,
            khoaIdem,
        });
        dongGhi = norm.dongGhi;
        tongThuLanNay = norm.tongThuLanNay;
        tongTienThua = norm.tongTienThua;
        tienChuyenThua = norm.tienChuyenThua;
    } else if (daThuTruoc > 0 && tongTien > 0) {
        throw new LoiNghiepVu(409, 'Hóa đơn này đã thu đủ tiền trước đó!', {
            code: 'ALREADY_PAID',
            maLoi: 'ALREADY_PAID',
        });
    }

    const tongSauThu = Math.round((daThuTruoc + tongThuLanNay) * 100) / 100;

    if (!allowPartial && tongSauThu + 0.01 < tongTien) {
        throw new LoiNghiepVu(
            400,
            `Tổng tiền thanh toán (${tongSauThu.toLocaleString('vi-VN')}đ) chưa đủ cho hóa đơn (${tongTien.toLocaleString('vi-VN')}đ)!`,
            { tongTien, daThuTruoc, conLai: conLaiTruoc }
        );
    }

    // [Phân hệ 3 - Trụ cột 1] Trừ Ví trả trước thành viên (VI_KHACH) nguyên tử bằng FOR UPDATE trong cùng ACID Transaction
    const walletPayments = dongGhi.filter((d) => d.phuongThucTT === 'VI_KHACH');
    if (walletPayments.length > 0) {
        const walletTotal = Math.round(walletPayments.reduce((s, d) => s + Number(d.soTien), 0) * 100) / 100;
        const targetMaKH = khHienTai;
        if (!targetMaKH) {
            throw new LoiNghiepVu(400, 'Thanh toán bằng Ví thành viên (VI_KHACH) yêu cầu chọn khách hàng (maKH)!');
        }
        const khLock = await client.query(
            `SELECT MaKH, TenKH, COALESCE(SoDuVi, 0) AS SoDuVi
               FROM KhachHang
              WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
              FOR UPDATE`,
            [targetMaKH, hdTenantId]
        );
        if (khLock.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy khách hàng để trừ Ví!');
        const soDuHienTai = Number(khLock.rows[0].soduvi || 0);
        if (soDuHienTai + 0.01 < walletTotal) {
            throw new LoiNghiepVu(
                409,
                `Số dư Ví thành viên (${soDuHienTai.toLocaleString('vi-VN')}đ) không đủ để thanh toán ${walletTotal.toLocaleString('vi-VN')}đ!`,
                { code: 'INSUFFICIENT_WALLET_BALANCE', soDuVi: soDuHienTai, canTru: walletTotal }
            );
        }
        const soDuSau = Math.round((soDuHienTai - walletTotal) * 100) / 100;
        await client.query(`UPDATE KhachHang SET SoDuVi = $2 WHERE MaKH = $1`, [targetMaKH, soDuSau]);
        await client.query(
            `INSERT INTO KhachHang_GiaoDichVi (TenantId, MaKH, LoaiGD, SoTien, SoDuSau, MaHoaDon, MaNV, GhiChu)
             VALUES ($1, $2, 'PAYMENT', $3, $4, $5, $6, $7)`,
            [hdTenantId, targetMaKH, -walletTotal, soDuSau, maHoaDon, maNV ? String(maNV) : null, `Thanh toán hóa đơn #${maHoaDon}`]
        );
    }

    const payBranchId = normalizeBranchForShift(hdTenantId, branchId || ca?.branchid);
    const payTerminalId = normalizeTerminalId(terminalId || ca?.terminalid);

    if (runtimeFlags.paymentsSanSang) {
        for (const dong of dongGhi) {
            await client.query('SAVEPOINT sp_pay_chuyenthua');
            try {
                await client.query(
                    `INSERT INTO Order_Payments
                        (MaHoaDon, MaCaThuNgan, PhuongThucTT, SoTien, TienKhachDua, TienThua, TienChuyenThua, TrangThai,
                         MaGiaoDichNgoai, NoiDungCK, NguonXacNhan, KhoaIdem, MaNV, TenantId, ChiaTienId,
                         BranchId, TerminalId, MaChuanChiEDC, BonSoCuoiThe, LaOfflineLechCa, MaCaThuNganGoc)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PAID', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
                    [
                        String(maHoaDon),
                        ca ? String(ca.macathungan) : null,
                        dong.phuongThucTT,
                        dong.soTien,
                        dong.tienKhachDua,
                        dong.tienThua,
                        dong.tienChuyenThua || 0,
                        dong.maGiaoDichNgoai,
                        dong.noiDungCK,
                        dong.nguonXacNhan,
                        dong.khoaIdem,
                        maNV ? String(maNV) : null,
                        hdTenantId,
                        chiaTienRow ? Number(chiaTienRow.id) : null,
                        payBranchId,
                        payTerminalId,
                        dong.maChuanChiEDC || null,
                        dong.bonSoCuoiThe || null,
                        Boolean(laOfflineLechCa),
                        maCaThuNganGoc ? String(maCaThuNganGoc) : null,
                    ]
                );
                await client.query('RELEASE SAVEPOINT sp_pay_chuyenthua');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_pay_chuyenthua').catch(() => {});
                await client.query(
                    `INSERT INTO Order_Payments
                        (MaHoaDon, MaCaThuNgan, PhuongThucTT, SoTien, TienKhachDua, TienThua, TrangThai,
                         MaGiaoDichNgoai, NoiDungCK, NguonXacNhan, KhoaIdem, MaNV, TenantId)
                     VALUES ($1, $2, $3, $4, $5, $6, 'PAID', $7, $8, $9, $10, $11, $12)`,
                    [
                        String(maHoaDon),
                        ca ? String(ca.macathungan) : null,
                        dong.phuongThucTT,
                        dong.soTien,
                        dong.tienKhachDua,
                        dong.tienThua,
                        dong.maGiaoDichNgoai,
                        dong.noiDungCK,
                        dong.nguonXacNhan,
                        dong.khoaIdem,
                        maNV ? String(maNV) : null,
                        hdTenantId,
                    ]
                );
            }
        }
    }

    // Cập nhật trạng thái phần chia tiền trong HoaDon_ChiaTien (nếu có)
    if (chiaTienRow && tongThuLanNay > 0) {
        const newPaidShare = Math.round((Number(chiaTienRow.sotiendatra || 0) + tongThuLanNay) * 100) / 100;
        const shareDone = newPaidShare + 0.01 >= Number(chiaTienRow.sotienphaitra);
        await client.query(
            `UPDATE hoadon_chiatien
                SET sotiendatra = $2,
                    trangthai = CASE WHEN $3 THEN 'PAID' ELSE trangthai END
              WHERE id = $1`,
            [Number(chiaTienRow.id), newPaidShare, shareDone]
        );
    }

    const daHoanTat = tongSauThu + 0.01 >= tongTien;
    let diemCong = 0;
    let banDaTrong = [];
    let kdsEmitPlan = null;

    if (daHoanTat) {
        const tatCaThanhToan = [
            ...(chiTietTruoc.danhSachThanhToan || []),
            ...dongGhi,
        ];
        const ptttChinh = chonPhuongThucChinh(tatCaThanhToan);

        await client.query('SAVEPOINT sp_pay_upd_hd');
        try {
            await client.query(
                `UPDATE HoaDon
                    SET TrangThaiTT = 1, lifecycle_status = 'PAID', TongTienThanhToan = $2, ThoiGianThanhToan = CURRENT_TIMESTAMP,
                        PhuongThucTT = $3, MaCaThuNgan = COALESCE($4, MaCaThuNgan), MaKH = COALESCE($5, MaKH),
                        TienPhiPhucVu = $6, TienThueVAT = $7, TienLamTron = $8
                  WHERE MaHoaDon = $1`,
                [
                    maHoaDon,
                    tongTien,
                    ptttChinh,
                    ca ? ca.macathungan : null,
                    maKH || null,
                    keToanPay.tienPhiPhucVu,
                    keToanPay.tienThueVAT,
                    keToanPay.tienLamTron,
                ]
            );
            await client.query('RELEASE SAVEPOINT sp_pay_upd_hd');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_pay_upd_hd').catch(() => {});
            await client.query(
                `UPDATE HoaDon
                    SET TrangThaiTT = 1, TongTienThanhToan = $2, ThoiGianThanhToan = CURRENT_TIMESTAMP,
                        PhuongThucTT = $3, MaCaThuNgan = COALESCE($4, MaCaThuNgan), MaKH = COALESCE($5, MaKH)
                  WHERE MaHoaDon = $1`,
                [maHoaDon, tongTien, ptttChinh, ca ? ca.macathungan : null, maKH || null]
            );
        }

        // [Wave 3B — P1-02] Nếu hóa đơn có các dòng AWAITING_PAYMENT (Counter VietQR trả trước),
        // thực hiện trừ kho BOM + chuyển FireStatus='FIRED' + tạo sự kiện KDS ORDER_NEW nguyên tử trong cùng transaction!
        const awaitingRowsRes = await client.query(
            `SELECT MaCTHD, MaMon, SoLuong, (to_jsonb(ChiTietHoaDon)->'bomsnapshotjson') AS bomsnap
               FROM ChiTietHoaDon
              WHERE MaHoaDon = $1
                AND FireStatus = 'AWAITING_PAYMENT'
                AND TrangThaiPhaChe <> 'DaHuy'
              ORDER BY MaCTHD ASC
              FOR UPDATE`,
            [maHoaDon]
        );
        if (awaitingRowsRes.rows.length > 0) {
            const awaitingIds = awaitingRowsRes.rows.map((r) => r.macthd);
            const deferredTieuHao = new Map();
            for (const r of awaitingRowsRes.rows) {
                const snap = r.bomsnap && typeof r.bomsnap === 'object' ? r.bomsnap : null;
                if (snap) {
                    for (const [mNl, qVal] of Object.entries(snap)) {
                        const q = Number(qVal || 0);
                        if (q > 0) {
                            deferredTieuHao.set(mNl, lam3((deferredTieuHao.get(mNl) || 0) + q));
                        }
                    }
                }
            }

            const settleBranchId = normalizeInventoryBranch(hdTenantId, branchId || ca?.branchid || 'DEFAULT');
            if (deferredTieuHao.size > 0) {
                const dsNL = [...deferredTieuHao.keys()];
                const { branchId: lockedBranchId, stockMap } = await lockBranchStockOrdered(client, hdTenantId, settleBranchId, dsNL);
                const phieu = await client.query(
                    `INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan, NgayChungTu, TrangThaiDuyet)
                     VALUES ($1, 3, $2, $3, $4, $5, $6::date, 'POSTED') RETURNING MaGiaoDich`,
                    [
                        maNV || 'WEBHOOK',
                        `Tiêu hao bán hàng (VietQR PAID) - HĐ ${maHoaDon}`,
                        hdTenantId,
                        lockedBranchId,
                        ca ? String(ca.macathungan) : null,
                        todayDateVN(),
                    ]
                );
                const maGiaoDich = phieu.rows[0].magiaodich;

                for (const [mNl, sl] of [...deferredTieuHao].sort((a, b) => a[0].localeCompare(b[0]))) {
                    const st = stockMap.get(mNl);
                    if (!st) continue;
                    const soLuong = lam3(sl);
                    await consumeFefoBatches(client, {
                        tenantId: hdTenantId,
                        branchId: lockedBranchId,
                        maNL: mNl,
                        qty: soLuong,
                    });
                    const tonTruoc = st.soLuongTon;
                    const tonSau = lam3(tonTruoc - soLuong);
                    await insertLedgerLine(client, {
                        maGiaoDich,
                        maNL: mNl,
                        soLuong,
                        donGiaNhap: st.giaVonDonVi,
                        tinhTrang: 'Tiêu hao bán hàng (VietQR PAID)',
                        tonTruoc,
                        tonSau,
                        giaVonTruoc: st.giaVonDonVi,
                        giaVonSau: st.giaVonDonVi,
                    });
                    await updateBranchStockRow(client, {
                        tenantId: hdTenantId,
                        branchId: lockedBranchId,
                        maNL: mNl,
                        nextQty: tonSau,
                        nextWac: st.giaVonDonVi,
                    });
                }
            }

            await client.query(
                `UPDATE ChiTietHoaDon
                    SET FireStatus = 'FIRED', FiredAt = CURRENT_TIMESTAMP
                  WHERE MaCTHD::text = ANY($1::text[])`,
                [awaitingIds.map(String)]
            );

            const monMoiFired = await layMonTheoMa(client, awaitingIds);
            if (monMoiFired.length > 0) {
                kdsEmitPlan = await recordAndEmitOrderNewByStation(client, io, {
                    tenantId: hdTenantId,
                    branchId: normalizeBranchId(branchId || ca?.branchid || 'DEFAULT'),
                    maHoaDon,
                    maBan: chiTietTruoc.ban?.[0]?.maBan || null,
                    tenBan: chiTietTruoc.ban?.[0]?.tenBan || null,
                    mangDi: !(chiTietTruoc.ban && chiTietTruoc.ban.length > 0),
                    themMon: false,
                    dotGoi: 1,
                    monMoiFired,
                });
            }
        }

        // Chốt toàn bộ các phần chia tiền (nếu còn) sang PAID khi hóa đơn hoàn tất
        await client.query('SAVEPOINT sp_close_chiatien');
        try {
            await client.query(
                `UPDATE hoadon_chiatien SET trangthai = 'PAID', sotiendatra = sotienphaitra
                  WHERE tenantid = $1 AND mahoadon = $2::text AND trangthai = 'UNPAID'`,
                [hdTenantId, String(maHoaDon)]
            );
            await client.query('RELEASE SAVEPOINT sp_close_chiatien');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_close_chiatien').catch(() => {});
        }

        const khFinal = maKH || hdRes.rows[0].makh || null;
        if (khFinal && tongTien >= DIEM_MOI_VND) {
            diemCong = Math.floor(tongTien / DIEM_MOI_VND);
            await client.query(
                'UPDATE KhachHang SET DiemTichLuy = COALESCE(DiemTichLuy, 0) + $1 WHERE MaKH = $2',
                [diemCong, khFinal]
            );
        }
        // [PHÂN HỆ 8] Cập nhật Hạng thành viên (Đồng/Bạc/Vàng/Kim Cương), Hoàn tiền Cashback vào Ví & xếp hàng Zalo ZNS
        if (khFinal && tongTien > 0) {
            await capNhatCrmVaZnsSauThanhToan(client, {
                tenantId: hdTenantId,
                maKH: khFinal,
                maHoaDon,
                tongTien,
                diemCong,
            });
        }

        // [Phân hệ 1 - 100/100] Sau khi thanh toán xong bàn -> tự chuyển sang 3 = Chờ dọn (CHO_DON) thay vì nhảy thẳng về Trống!
        const banGiai = await client.query(
            `UPDATE Ban b SET TrangThai = 3
              WHERE b.MaBan IN (SELECT MaBan FROM HoaDon_Ban WHERE MaHoaDon = $1)
                AND NOT EXISTS (SELECT 1 FROM HoaDon_Ban hb2 JOIN HoaDon h2 ON h2.MaHoaDon = hb2.MaHoaDon
                                 WHERE hb2.MaBan = b.MaBan AND h2.TrangThaiTT = 0 AND h2.MaHoaDon <> $1)
              RETURNING b.MaBan`,
            [maHoaDon]
        );
        banDaTrong = banGiai.rows.map((r) => r.maban);
        // [PHÂN HỆ 8 - Anti-Spam Lớp 2] Tự động xoay mã QrToken bàn sau khi thanh toán để vô hiệu hóa QR của khách cũ
        if (banDaTrong.length > 0) {
            await xoayQrTokenChoCacBan(client, banDaTrong);
        }
    }

    const coCkThuCong = dongGhi.some((d) => d.phuongThucTT === 'CHUYEN_KHOAN' && d.nguonXacNhan === 'POS_MANUAL');
    if (dongGhi.length > 1 || !daHoanTat || coCkThuCong || tienChuyenThua > 0 || chiaTienRow) {
        await ghiAuditLog(client, {
            tenantId: hdTenantId,
            maNV: maNV || 'WEBHOOK',
            vaiTro,
            hanhDong: coCkThuCong
                ? 'MANUAL_TRANSFER_CONFIRMED'
                : daHoanTat
                ? 'SPLIT_PAYMENT_SETTLED'
                : 'PARTIAL_PAYMENT_RECORDED',
            doiTuong: 'HOADON',
            maDoiTuong: maHoaDon,
            giaTriMoi: {
                daHoanTat,
                tongTien,
                tongSauThu,
                tienChuyenThua,
                chiaTienId: chiaTienRow ? Number(chiaTienRow.id) : null,
                cacKhoanTT: dongGhi.map((d) => ({ phuongThucTT: d.phuongThucTT, soTien: d.soTien, tienChuyenThua: d.tienChuyenThua || 0, nguon: d.nguonXacNhan })),
            },
            ip,
            batBuoc: true,
        });
    }

    return {
        tenantId: hdTenantId,
        maCaThuNgan: ca ? ca.macathungan : null,
        daHoanTat,
        tongTien,
        tongThuLanNay,
        tongSauThu,
        conLai: daHoanTat ? 0 : Math.max(0, Math.round((tongTien - tongSauThu) * 100) / 100),
        tienThua: tongTienThua > 0 ? tongTienThua : null,
        tienChuyenThua,
        diemCong,
        banDaTrong,
        kdsEmitPlan,
        hoaDon: await layHoaDonChiTiet(client, maHoaDon),
    };
}


// ==========================================
// PHÂN HỆ: PHA CHẾ (BARISTA) — TELEMETRY 3 MỐC & EXPO ALL_STATIONS_READY
// ==========================================
async function doiTrangThaiMon(maCTHD, tuTrangThai, denTrangThai, tenantId = 'DEFAULT', maNV = null) {
    return pool.withTenant(tenantId, async (client) => {
        let r;
        await client.query('SAVEPOINT sp_doi_tt_mon');
        try {
            let setExtraSql = '';
            const params = [maCTHD, denTrangThai, tuTrangThai, tenantId];
            if (denTrangThai === 'DangLam') {
                params.push(maNV || null);
                setExtraSql = ', ThoiGianBatDauLam = COALESCE(ThoiGianBatDauLam, now()), MaNVPhaChe = COALESCE(MaNVPhaChe, $5), ThoiGianXong = NULL';
            } else if (denTrangThai === 'DaXong') {
                params.push(maNV || null);
                setExtraSql = ', ThoiGianBatDauLam = COALESCE(ThoiGianBatDauLam, now()), MaNVPhaChe = COALESCE(MaNVPhaChe, $5), ThoiGianXong = now()';
            } else if (denTrangThai === 'DaPhucVu') {
                setExtraSql = ', ThoiGianPhucVu = now()';
            }
            r = await client.query(
                `UPDATE ChiTietHoaDon c SET TrangThaiPhaChe = $2${setExtraSql}
                   FROM HoaDon hd
                  WHERE c.MaCTHD = $1
                    AND hd.MaHoaDon = c.MaHoaDon
                    AND COALESCE(hd.TenantId, 'DEFAULT') = $4
                    AND hd.TrangThaiTT IN (0, 1)
                    AND COALESCE(to_jsonb(c)->>'firestatus', 'FIRED') = 'FIRED'
                    AND c.TrangThaiPhaChe = ANY($3::varchar[])
                  RETURNING c.MaCTHD`,
                params
            );
            await client.query('RELEASE SAVEPOINT sp_doi_tt_mon');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_doi_tt_mon').catch(() => {});
            r = await client.query(
                `UPDATE ChiTietHoaDon c SET TrangThaiPhaChe = $2
                   FROM HoaDon hd
                  WHERE c.MaCTHD = $1
                    AND hd.MaHoaDon = c.MaHoaDon
                    AND COALESCE(hd.TenantId, 'DEFAULT') = $4
                    AND hd.TrangThaiTT IN (0, 1)
                    AND COALESCE(to_jsonb(c)->>'firestatus', 'FIRED') = 'FIRED'
                    AND c.TrangThaiPhaChe = ANY($3::varchar[])
                  RETURNING c.MaCTHD`,
                [maCTHD, denTrangThai, tuTrangThai, tenantId]
            );
        }
        if (r.rows.length === 0) {
            const t = await client.query(
                `SELECT c.TrangThaiPhaChe
                   FROM ChiTietHoaDon c
                   JOIN HoaDon hd ON hd.MaHoaDon = c.MaHoaDon
                  WHERE c.MaCTHD = $1 AND COALESCE(hd.TenantId, 'DEFAULT') = $2`,
                [maCTHD, tenantId]
            );
            if (t.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy món này!');
            throw new LoiNghiepVu(
                409,
                `Món này đang ở trạng thái "${t.rows[0].trangthaiphache}", không thể chuyển sang "${denTrangThai}"!`,
                { trangThaiHienTai: t.rows[0].trangthaiphache }
            );
        }
        const [mon] = await layMonTheoMa(client, [maCTHD]);
        return mon;
    });
}

// Kiểm tra xem 100% các món của (maHoaDon, dotGoi) trên tất cả các trạm đã xong chưa -> phát ORDER_ALL_READY tới Expo & Phục vụ!
async function kiemTraVaPhatAllStationsReady(mon, tenantId = 'DEFAULT') {
    if (!mon?.maHoaDon) return { allReady: false };
    const bId = normalizeBranchId(mon.branchId || 'DEFAULT');
    const dotGoi = Number(mon.dotGoi || 1);

    const check = await pool.withTenant(tenantId, async (client) => {
        const res = await client.query(
            `SELECT COUNT(*) FILTER (WHERE TrangThaiPhaChe <> 'DaHuy') AS total_cnt,
                    COUNT(*) FILTER (WHERE TrangThaiPhaChe IN ('DaXong', 'DaPhucVu')) AS done_cnt
               FROM ChiTietHoaDon
              WHERE MaHoaDon = $1
                AND COALESCE((to_jsonb(ChiTietHoaDon)->>'dotgoi')::int, 1) = $2
                AND COALESCE(to_jsonb(ChiTietHoaDon)->>'firestatus', 'FIRED') = 'FIRED'`,
            [mon.maHoaDon, dotGoi]
        );
        const totalCnt = Number(res.rows[0]?.total_cnt || 0);
        const doneCnt = Number(res.rows[0]?.done_cnt || 0);
        if (totalCnt > 0 && doneCnt === totalCnt) {
            const payload = {
                maHoaDon: mon.maHoaDon,
                dotGoi,
                soThuTuNgay: mon.soThuTuNgay,
                soThuTuHienThi: mon.soThuTuHienThi,
                soTheRung: mon.soTheRung,
                tenBan: mon.tenBan,
                mangDi: mon.mangDi,
                totalItems: totalCnt,
                allStationsReady: true,
                completedAt: new Date().toISOString(),
            };
            const logInfo = await insertKdsEventLog(client, {
                tenantId,
                branchId: bId,
                station: 'ALL',
                eventType: 'ORDER_ALL_READY',
                maHoaDon: mon.maHoaDon,
                payload,
            });
            return { allReady: true, seq: logInfo.seq, payload };
        }
        return { allReady: false };
    });

    if (check.allReady) {
        emitScopedKdsEvent(io, {
            tenantId,
            branchId: bId,
            station: 'ALL',
            seq: check.seq,
            eventType: 'ORDER_ALL_READY',
            socketEvents: ['ORDER_ALL_READY', 'expo:order_all_ready'],
            payload: check.payload,
            includeExpo: true,
            includeWaiter: true,
            includePos: true,
            legacyBaristaEvent: 'ORDER_ALL_READY',
            legacyWaiterEvent: 'ORDER_ALL_READY',
        });
    }
    return check;
}

    return {
        KIEU_KHOA,
        SQL_MON_PHA_CHE,
        chanSuaDonDangCoUuDai,
        layCaDangMo,
        loiChuaMoCa,
        layCaChoGiaoDichOffline,
        mapMonPhaChe,
        layMonTheoMa,
        layMonTheoTrangThai,
        layHoaDonChiTiet,
        layHoaDonMoCuaBan,
        tinhDoiSoatCa,
        validateDanhSachMon,
        capSoThuTuNgayNguyenTu,
        taoOrderTrongGiaoDich,
        layMapGiaVonNguyenLieu,
        congDinhLuongNguyenLieuDongMon,
        chonPhuongThucChinh,
        chuanHoaKhoanThanhToanVaThuThua,
        ghiNhanThanhToanTrongGiaoDich,
        doiTrangThaiMon,
        kiemTraVaPhatAllStationsReady,
    };
}

module.exports = { createOrderHelpers };
