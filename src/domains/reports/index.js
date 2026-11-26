'use strict';

const {
    VN_TZ,
    CASH_PAYOUT_LIMIT_VND,
    coQuyenHan,
    ngayHomNayVN,
    LoiNghiepVu,
    guiLoi,
    choPhepVaiTro,
    layTenantId,
} = require('../../core/auditAndSecurity');
const {
    emitToBranch,
} = require('../../core/socketRooms');
const {
    DEFAULT_SHIFT_POLICY,
    normalizeBranchForShift,
    normalizeTerminalId,
    computeDenominationTotal,
    getTenantShiftPolicy,
    nextAtomicZReportNumber,
    computePreCloseChecklist,
    buildImmutableZReportSnapshot,
} = require('../../../modules/paymentShiftPhase3Engine');
const {
    computeBusinessDate,
    refreshDailyBranchFinancialSummary,
    getDailyBranchFinancialSummary,
} = require('./businessDaySummaryService');

function registerReportsDomain(app, deps) {
    const {
        pool,
        reportPool,
        io,
        runtimeFlags,
        chayGiaoDich,
        chayTruyVanBaoCao,
        qTenant,
        kiemTraToken,
        kiemTraHanSuDung,
        yeuCauTinhNang,
        layEntitlementTenant,
        ghiAuditLog,
        dispatchFraudAlertFromAudit,
        kiemTraCanhBaoTanSuatGianLan,
        xacThucPinQuanLy,
        KIEU_KHOA,
        layCaDangMo,
        loiChuaMoCa,
        tinhDoiSoatCa,
    } = deps;

// ==========================================
// CA THU NGÂN TOÀN CỤC — PHÂN HỆ 3 (100/100: BLIND DROP 1-LẦN ĐẾM LẠI, BÀN GIAO LIÊN CA, SAFE DROP 2 LỚP, Z-REPORT BẤT BIẾN)
// ==========================================

async function handleMoCa(req, res) {
    const tenantId = layTenantId(req);
    const {
        branchId = null,
        terminalId = null,
        chiTietMenhGiaDauCa = null,
    } = req.body || {};

    const denomInit = computeDenominationTotal(chiTietMenhGiaDauCa);
    const tienMatDauCa =
        denomInit.cleanMap && denomInit.total !== null
            ? denomInit.total
            : req.body && req.body.tienMatDauCa !== undefined
            ? Number(req.body.tienMatDauCa)
            : 0;
    if (!(tienMatDauCa >= 0)) return res.status(400).json({ message: 'tienMatDauCa phải là số >= 0!' });

    const normBranch = normalizeBranchForShift(tenantId, branchId || req.user.branchId || null);
    const normTerminal = normalizeTerminalId(terminalId);

    try {
        const ca = await chayGiaoDich(async (client) => {
            const daMo = await layCaDangMo(client, 'UPDATE', tenantId, {
                branchId: normBranch,
                terminalId: normTerminal,
            });
            if (daMo) {
                throw new LoiNghiepVu(409, `Quầy ${normTerminal} (${normBranch}) đang có một ca chưa chốt!`, {
                    maLoi: 'DA_MO_CA',
                    maCaThuNgan: daMo.macathungan,
                });
            }

            // Tìm ca vừa đóng gần nhất của cùng (BranchId, TerminalId) để kiểm tra Chênh lệch Bàn giao Liên ca!
            let maCaTruoc = null;
            let tienGiuLaiCaTruoc = null;
            let chenhLechBanGiao = 0;
            await client.query('SAVEPOINT sp_prev_shift_handover');
            try {
                const prevRes = await client.query(
                    `SELECT MaCaThuNgan, COALESCE(TienGiuLaiKet, 0) AS TienGiuLaiKet
                       FROM CaThuNgan
                      WHERE COALESCE(TenantId::text, 'DEFAULT') = $1::text
                        AND COALESCE(NULLIF(BranchId::text, ''), $1::text || '_MAIN') = $2::text
                        AND COALESCE(NULLIF(TerminalId::text, ''), 'POS_01') = $3::text
                        AND TrangThaiCa = 2
                      ORDER BY ThoiGianDongCa DESC NULLS LAST, ThoiGianMoCa DESC
                      LIMIT 1`,
                    [tenantId, normBranch, normTerminal]
                );
                if (prevRes.rows.length > 0) {
                    maCaTruoc = prevRes.rows[0].macathungan;
                    tienGiuLaiCaTruoc = Number(prevRes.rows[0].tiengiulaiket || 0);
                    chenhLechBanGiao = Math.round((tienMatDauCa - tienGiuLaiCaTruoc) * 100) / 100;
                }
                await client.query('RELEASE SAVEPOINT sp_prev_shift_handover');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_prev_shift_handover').catch(() => {});
            }

            let r;
            await client.query('SAVEPOINT sp_ins_ca_p3');
            try {
                r = await client.query(
                    `INSERT INTO CaThuNgan
                        (MaNV, TienMatDauCa, TenantId, BranchId, TerminalId, ChiTietMenhGiaDauCa, MaCaTruoc, ChenhLechBanGiao)
                     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
                     RETURNING MaCaThuNgan, ThoiGianMoCa, TienMatDauCa, BranchId, TerminalId, ChenhLechBanGiao, MaCaTruoc`,
                    [
                        req.user.maNV,
                        tienMatDauCa,
                        tenantId,
                        normBranch,
                        normTerminal,
                        denomInit.cleanMap ? JSON.stringify(denomInit.cleanMap) : null,
                        maCaTruoc,
                        chenhLechBanGiao,
                    ]
                );
                await client.query('RELEASE SAVEPOINT sp_ins_ca_p3');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_ins_ca_p3').catch(() => {});
                r = await client.query(
                    `INSERT INTO CaThuNgan (MaNV, TienMatDauCa, TenantId) VALUES ($1, $2, $3)
                     RETURNING MaCaThuNgan, ThoiGianMoCa, TienMatDauCa`,
                    [req.user.maNV, tienMatDauCa, tenantId]
                );
            }
            const row = r.rows[0];

            // Nếu lệch tiền bàn giao giữa Ca trước để lại vs Ca sau đếm nhận -> Audit Log + Cảnh báo Telegram ngay!
            if (maCaTruoc && Math.abs(chenhLechBanGiao) > 0) {
                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'SHIFT_HANDOVER_VARIANCE',
                    doiTuong: 'CATHUNGAN',
                    maDoiTuong: row.macathungan,
                    giaTriCu: { maCaTruoc, tienGiuLaiCaTruoc },
                    giaTriMoi: { tienMatDauCa, chenhLechBanGiao, branchId: normBranch, terminalId: normTerminal },
                    lyDo: `Lệch tiền bàn giao giữa Ca #${maCaTruoc} (để lại ${tienGiuLaiCaTruoc.toLocaleString('vi-VN')}đ) và Ca #${row.macathungan} (đếm nhận ${tienMatDauCa.toLocaleString('vi-VN')}đ): ${chenhLechBanGiao.toLocaleString('vi-VN')}đ`,
                    ip: req.ip,
                    batBuoc: true,
                });
                void dispatchFraudAlertFromAudit(pool, {
                    tenantId,
                    hanhDong: 'SHIFT_HANDOVER_VARIANCE',
                    maNV: req.user.maNV,
                    maDoiTuong: row.macathungan,
                    giaTriMoi: { maCaTruoc, tienGiuLaiCaTruoc, tienMatDauCa, chenhLechBanGiao },
                    lyDo: `⚠️ Lệch bàn giao két liên ca: ${chenhLechBanGiao.toLocaleString('vi-VN')}đ`,
                }).catch(() => {});
            }

            // Gắn tự động giao dịch VietQR ngoài giờ đóng ca (lọc đúng BranchId!)
            let soGiaoDichTuDongGanCa = 0;
            if (runtimeFlags.paymentsSanSang) {
                const orphanRes = await client.query(
                    `UPDATE Order_Payments
                        SET MaCaThuNgan = $2
                      WHERE MaCaThuNgan IS NULL
                        AND TrangThai = 'PAID'
                        AND COALESCE(TenantId, 'DEFAULT') = $1
                        AND (BranchId IS NULL OR BranchId = $3)
                      RETURNING Id, MaHoaDon, SoTien`,
                    [tenantId, String(row.macathungan), normBranch]
                );
                soGiaoDichTuDongGanCa = orphanRes.rows.length;
                if (soGiaoDichTuDongGanCa > 0) {
                    await client.query(
                        `UPDATE HoaDon
                            SET MaCaThuNgan = $2::int
                          WHERE MaCaThuNgan IS NULL
                            AND COALESCE(TenantId, 'DEFAULT') = $1
                            AND MaHoaDon::text IN (
                                SELECT DISTINCT MaHoaDon FROM Order_Payments WHERE MaCaThuNgan = $3::text
                            )`,
                        [tenantId, Number(row.macathungan), String(row.macathungan)]
                    );
                    const tongTienOrphan = orphanRes.rows.reduce((s, o) => s + Number(o.sotien || 0), 0);
                    await ghiAuditLog(client, {
                        tenantId,
                        maNV: req.user.maNV,
                        vaiTro: req.user.vaiTro,
                        hanhDong: 'ORPHAN_PAYMENTS_ATTACHED',
                        doiTuong: 'CATHUNGAN',
                        maDoiTuong: row.macathungan,
                        giaTriMoi: { soGiaoDich: soGiaoDichTuDongGanCa, tongTien: tongTienOrphan, branchId: normBranch },
                        lyDo: 'Tự động gắn giao dịch VietQR ngoài giờ đóng ca vào ca vừa mở',
                        ip: req.ip,
                        batBuoc: true,
                    });
                }
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'SHIFT_OPEN',
                doiTuong: 'CATHUNGAN',
                maDoiTuong: row.macathungan,
                giaTriMoi: {
                    tienMatDauCa: Number(row.tienmatdauca),
                    branchId: normBranch,
                    terminalId: normTerminal,
                    chiTietMenhGiaDauCa: denomInit.cleanMap,
                    maCaTruoc,
                    chenhLechBanGiao,
                    soGiaoDichTuDongGanCa,
                },
                ip: req.ip,
            });
            return { ...row, branchId: normBranch, terminalId: normTerminal, chenhLechBanGiao, maCaTruoc, soGiaoDichTuDongGanCa };
        }, tenantId);

        emitToBranch(io, {
            tenantId,
            branchId: ca.branchId || req.user?.branchId || 'DEFAULT',
            roles: ['POS', 'WAITER'],
            event: 'CA_THAY_DOI',
            payload: { trangThai: 'MO', maCaThuNgan: ca.macathungan },
        });
        res.status(201).json({
            message: ca.soGiaoDichTuDongGanCa > 0
                ? `Mở ca thành công & đã tự động gắn ${ca.soGiaoDichTuDongGanCa} giao dịch chuyển khoản ngoài giờ vào ca!`
                : 'Mở ca thành công!',
            soGiaoDichTuDongGanCa: ca.soGiaoDichTuDongGanCa || 0,
            chenhLechBanGiao: Number(ca.chenhLechBanGiao || 0),
            ca: {
                maCaThuNgan: ca.macathungan,
                branchId: ca.branchId,
                terminalId: ca.terminalId,
                thoiGianMoCa: ca.thoigianmoca,
                tienMatDauCa: Number(ca.tienmatdauca),
                maCaTruoc: ca.maCaTruoc || null,
                chenhLechBanGiao: Number(ca.chenhLechBanGiao || 0),
            },
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Mở ca:');
    }
}

app.post('/api/ca/mo', kiemTraToken, choPhepVaiTro(1, 4), kiemTraHanSuDung, handleMoCa);

// Ca đang mở: Blind Mode cho Thu ngân/Phục vụ (cô lập theo TenantId + BranchId + TerminalId)
app.get('/api/ca/hientai', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const doiSoat = await pool.withTenant(tenantId, async (client) => {
            const ca = await layCaDangMo(client, undefined, tenantId, {
                branchId: req.query.branchId || null,
                terminalId: req.query.terminalId || null,
            });
            if (!ca) return null;
            return tinhDoiSoatCa(client, ca.macathungan);
        });
        if (!doiSoat) return res.json({ caHienTai: null });
        const canViewXReport = Number(req.user.vaiTro) === 1 || coQuyenHan(req.user, 'shift.view_x_report');
        if (!canViewXReport) {
            return res.json({
                caHienTai: {
                    maCaThuNgan: doiSoat.maCaThuNgan,
                    branchId: doiSoat.branchId,
                    terminalId: doiSoat.terminalId,
                    maNV: doiSoat.maNV,
                    tenNV: doiSoat.tenNV,
                    thoiGianMoCa: doiSoat.thoiGianMoCa,
                    trangThaiCa: doiSoat.trangThaiCa,
                    blindMode: true,
                },
            });
        }
        res.json({ caHienTai: { ...doiSoat, blindMode: false } });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Ca hiện tại:');
    }
});

// Ghi nhận Thu / Chi lặt vặt / Rút két an toàn 2 lớp (Safe Drop Two-Man Rule + Receipt Photo Gate + PIN duyệt vượt ngưỡng)
async function handleThuChiCa(req, res) {
    const {
        loaiThuChi: rawLoai,
        soTien,
        lyDo,
        danhMucChi = 'KHAC',
        anhChungTuUrl = null,
        idChungTu = null,
        managerPin = null,
        maNVDuyet = null,
        branchId = null,
        terminalId = null,
    } = req.body || {};
    const tenantId = layTenantId(req);
    const loaiThuChi = String(rawLoai || '').toUpperCase() === 'SAFE_DROP' ? 'RUT_KET' : String(rawLoai || '').toUpperCase();
    const tien = Number(soTien);
    if (!['THU', 'CHI', 'RUT_KET'].includes(loaiThuChi) || !(tien > 0)) {
        return res.status(400).json({ message: 'Vui lòng cung cấp đúng loaiThuChi (THU / CHI / RUT_KET) và soTien > 0!' });
    }
    const lyDoSach = String(lyDo || '').trim();
    if (lyDoSach.length < 3) {
        return res.status(400).json({
            message: loaiThuChi === 'RUT_KET'
                ? 'Vui lòng ghi rõ tên người nhận tiền rút két / lý do bàn giao (tối thiểu 3 ký tự)!'
                : 'Vui lòng nhập lý do thu/chi (tối thiểu 3 ký tự)!',
        });
    }
    const cleanAnhUrl =
        typeof anhChungTuUrl === 'string' && anhChungTuUrl.trim().length > 0
            ? anhChungTuUrl.trim().slice(0, 460000)
            : null;
    const cleanIdChungTu = typeof idChungTu === 'string' && idChungTu.trim() ? idChungTu.trim().slice(0, 64) : null;
    const cleanDanhMuc = ['MUA_DA', 'NGUYEN_LIEU_GAP', 'SHIP', 'VE_SINH', 'RUT_KET', 'THOI_CK_DU', 'KHAC'].includes(
        String(danhMucChi || '').toUpperCase()
    )
        ? String(danhMucChi).toUpperCase()
        : loaiThuChi === 'RUT_KET'
        ? 'RUT_KET'
        : 'KHAC';

    const loaiPhieuDb = loaiThuChi === 'THU' ? 1 : loaiThuChi === 'RUT_KET' ? 3 : 2;
    const auditAction =
        loaiThuChi === 'THU' ? 'CASH_PAYIN' : loaiThuChi === 'RUT_KET' ? 'CASH_SAFE_DROP' : 'CASH_PAYOUT';

    try {
        const phieu = await chayGiaoDich(async (client) => {
            const ca = await layCaDangMo(client, 'SHARE', tenantId, { branchId, terminalId });
            if (!ca) throw loiChuaMoCa();

            const policy = await getTenantShiftPolicy(client, tenantId);
            let nguoiDuyet = Number(req.user.vaiTro) === 1 ? req.user.maNV : null;
            let verifiedAnhUrl = cleanAnhUrl;

            // 1. Cổng Ảnh Chứng Từ Thật cho Phiếu Chi >= nguongBatBuocChungTu (mặc định 50.000đ)
            if (loaiThuChi === 'CHI' && tien >= Number(policy.nguongBatBuocChungTu || 50000)) {
                if (!cleanIdChungTu) {
                    throw new LoiNghiepVu(
                        400,
                        `Phiếu chi từ ${Number(policy.nguongBatBuocChungTu || 50000).toLocaleString('vi-VN')}đ trở lên bắt buộc tải lên ảnh chụp hóa đơn/biên nhận xác thực (idChungTu)!`,
                        { code: 'RECEIPT_PHOTO_REQUIRED', maLoi: 'RECEIPT_PHOTO_REQUIRED' }
                    );
                }
                const photoRes = await client.query(
                    `SELECT id FROM public.receipt_photo_uploads WHERE id = $1 AND tenantid = $2`,
                    [cleanIdChungTu, tenantId]
                );
                if (photoRes.rows.length === 0) {
                    throw new LoiNghiepVu(
                        400,
                        'Mã ảnh chứng từ (idChungTu) không hợp lệ hoặc không thuộc quán này!',
                        { code: 'INVALID_RECEIPT_PHOTO', maLoi: 'INVALID_RECEIPT_PHOTO' }
                    );
                }
                verifiedAnhUrl = `/api/uploads/receipt-photo/${cleanIdChungTu}`;
            }

            // 2. Cổng Manager PIN cho Phiếu Chi >= nguongPinPhieuChi (mặc định 200.000đ)
            if (loaiThuChi === 'CHI' && tien >= Number(policy.nguongPinPhieuChi || 200000)) {
                if (!coQuyenHan(req.user, 'shift.cash_payout.approve')) {
                    const mgr = managerPin
                        ? await xacThucPinQuanLy(client, tenantId, managerPin, req.ip, maNVDuyet, 'shift.cash_payout.approve')
                        : null;
                    if (!mgr) {
                        throw new LoiNghiepVu(
                            403,
                            `Phiếu chi từ ${Number(policy.nguongPinPhieuChi || 200000).toLocaleString('vi-VN')}đ cần quyền hoặc mã PIN Quản lý phê duyệt!`,
                            { code: 'PAYOUT_APPROVAL_REQUIRED', maLoi: 'CAN_PIN_QUAN_LY' }
                        );
                    }
                    nguoiDuyet = mgr.maNV;
                }
            }

            // 3. Safe Drop (RUT_KET) luôn khởi tạo ở trạng thái PENDING_RECEIPT chờ Chủ quán xác nhận đã cầm tiền (Two-Man Rule)
            const trangThaiXacNhan = loaiThuChi === 'RUT_KET' ? 'PENDING_RECEIPT' : 'CONFIRMED';

            let r;
            await client.query('SAVEPOINT sp_ins_thuchi_p3');
            try {
                r = await client.query(
                    `INSERT INTO PhieuThuChiLatVat
                        (MaCaThuNgan, LoaiPhieu, SoTien, LyDo, AnhChungTuUrl, DanhMucChi, NguoiDuyet, TrangThaiXacNhan, IdChungTu)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                     RETURNING MaPhieuTC, ThoiGianTao, AnhChungTuUrl, DanhMucChi, TrangThaiXacNhan, IdChungTu`,
                    [ca.macathungan, loaiPhieuDb, tien, lyDoSach.slice(0, 255), verifiedAnhUrl, cleanDanhMuc, nguoiDuyet, trangThaiXacNhan, cleanIdChungTu]
                );
                await client.query('RELEASE SAVEPOINT sp_ins_thuchi_p3');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_ins_thuchi_p3').catch(() => {});
                r = await client.query(
                    `INSERT INTO PhieuThuChiLatVat (MaCaThuNgan, LoaiPhieu, SoTien, LyDo, AnhChungTuUrl)
                     VALUES ($1, $2, $3, $4, $5) RETURNING MaPhieuTC, ThoiGianTao, AnhChungTuUrl`,
                    [ca.macathungan, loaiPhieuDb, tien, lyDoSach.slice(0, 255), verifiedAnhUrl]
                );
            }
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                nguoiDuyet,
                hanhDong: auditAction,
                doiTuong: 'CATHUNGAN',
                maDoiTuong: ca.macathungan,
                giaTriMoi: {
                    maPhieuTC: r.rows[0].maphieutc,
                    loaiThuChi,
                    danhMucChi: cleanDanhMuc,
                    soTien: tien,
                    trangThaiXacNhan,
                    idChungTu: cleanIdChungTu,
                    coAnhChungTu: Boolean(verifiedAnhUrl || cleanIdChungTu),
                },
                lyDo: lyDoSach,
                ip: req.ip,
                batBuoc: true,
            });
            return { ...r.rows[0], maCaThuNgan: ca.macathungan, trangThaiXacNhan };
        }, tenantId);

        if (loaiThuChi === 'RUT_KET') {
            void dispatchFraudAlertFromAudit(pool, {
                tenantId,
                hanhDong: 'CASH_SAFE_DROP',
                maNV: req.user.maNV,
                maDoiTuong: phieu.maphieutc,
                giaTriMoi: { maPhieuTC: phieu.maphieutc, soTien: tien, trangThaiXacNhan: 'PENDING_RECEIPT' },
                lyDo: `🏦 Phiếu Rút két an toàn #${phieu.maphieutc} (${tien.toLocaleString('vi-VN')}đ) đang chờ Chủ quán xác nhận đã nhận tiền!`,
            }).catch(() => {});
        }

        const msg =
            loaiThuChi === 'RUT_KET'
                ? `🏦 Đã lập phiếu Rút két an toàn #${phieu.maphieutc} (${tien.toLocaleString('vi-VN')}đ) — đang chờ Chủ quán xác nhận đã nhận tiền!`
                : `Ghi nhận khoản ${loaiThuChi} lặt vặt thành công!`;
        res.status(201).json({
            message: msg,
            loaiThuChi,
            danhMucChi: cleanDanhMuc,
            trangThaiXacNhan: phieu.trangThaiXacNhan,
            idChungTu: phieu.idchungtu || cleanIdChungTu,
            maPhieuTC: phieu.maphieutc,
            maCaThuNgan: phieu.maCaThuNgan,
            anhChungTuUrl: phieu.anhchungtuurl || cleanAnhUrl || null,
            thoiGianTao: phieu.thoigiantao,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Thu Chi / Rút két:');
    }
}

app.post('/api/ca/thuchi', kiemTraToken, choPhepVaiTro(1, 4), handleThuChiCa);

// Danh sách phiếu thu/chi/rút két/thối CK dư (kèm trạng thái Two-Man Rule & idChungTu)
app.get('/api/ca/thuchi', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const rows = await pool.withTenant(tenantId, async (client) => {
            let maCa = req.query.maCaThuNgan;
            if (!maCa) {
                const ca = await layCaDangMo(client, undefined, tenantId);
                if (!ca) throw loiChuaMoCa();
                maCa = ca.macathungan;
            } else {
                const own = await client.query(
                    `SELECT 1 FROM CaThuNgan WHERE MaCaThuNgan = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
                    [maCa, tenantId]
                );
                if (own.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy ca thu ngân!');
            }
            const r = await client.query(
                `SELECT MaPhieuTC, LoaiPhieu, SoTien, LyDo, ThoiGianTao,
                        to_jsonb(PhieuThuChiLatVat)->>'anhchungtuurl' AS AnhChungTuUrl,
                        COALESCE(to_jsonb(PhieuThuChiLatVat)->>'danhmucchi', 'KHAC') AS DanhMucChi,
                        COALESCE(to_jsonb(PhieuThuChiLatVat)->>'trangthaixacnhan', 'CONFIRMED') AS TrangThaiXacNhan,
                        to_jsonb(PhieuThuChiLatVat)->>'nguoinhanket' AS NguoiNhanKet,
                        to_jsonb(PhieuThuChiLatVat)->>'thoigiannhanket' AS ThoiGianNhanKet,
                        to_jsonb(PhieuThuChiLatVat)->>'idchungtu' AS IdChungTu
                   FROM PhieuThuChiLatVat WHERE MaCaThuNgan = $1 ORDER BY ThoiGianTao DESC`,
                [maCa]
            );
            return r.rows;
        });
        res.json(rows.map((p) => ({
            maPhieuTC: p.maphieutc,
            loaiThuChi:
                Number(p.loaiphieu) === 1
                    ? 'THU'
                    : Number(p.loaiphieu) === 3
                    ? 'RUT_KET'
                    : Number(p.loaiphieu) === 4
                    ? 'THOI_CK_DU'
                    : 'CHI',
            danhMucChi: p.danhmucchi || 'KHAC',
            soTien: Number(p.sotien),
            lyDo: p.lydo,
            trangThaiXacNhan: p.trangthaixacnhan || 'CONFIRMED',
            nguoiNhanKet: p.nguoinhanket || null,
            thoiGianNhanKet: p.thoigiannhanket || null,
            idChungTu: p.idchungtu || null,
            anhChungTuUrl: p.anhchungtuurl || null,
            thoiGianTao: p.thoigiantao,
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách thu chi:');
    }
});

// Đối soát xem trước (X-Report): Bắt buộc quyền RBAC shift.view_x_report (Thu ngân bị chặn 403 tuyệt đối để bảo vệ Blind Drop!)
async function handleDoiSoatCa(req, res) {
    const { maCaThuNgan, tienMatThucTe } = req.query;
    const tenantId = layTenantId(req);
    const hasXReportPerm = Number(req.user.vaiTro) === 1 || coQuyenHan(req.user, 'shift.view_x_report');
    if (!hasXReportPerm) {
        return res.status(403).json({
            code: 'X_REPORT_FORBIDDEN',
            message: 'Tài khoản Thu ngân không được xem quỹ lý thuyết (X-Report) để đảm bảo đối soát mù (Blind Drop)!',
        });
    }
    if (tienMatThucTe !== undefined && !(Number(tienMatThucTe) >= 0)) {
        return res.status(400).json({ message: 'tienMatThucTe phải là số >= 0!' });
    }
    try {
        const doiSoat = await pool.withTenant(tenantId, async (client) => {
            let maCa = maCaThuNgan;
            if (maCa) {
                const ca = await client.query(
                    `SELECT MaNV FROM CaThuNgan WHERE MaCaThuNgan = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
                    [maCa, tenantId]
                );
                if (ca.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy ca thu ngân!');
            } else {
                const ca = await layCaDangMo(client, undefined, tenantId);
                if (!ca) throw loiChuaMoCa();
                maCa = ca.macathungan;
            }
            return tinhDoiSoatCa(client, maCa, tienMatThucTe);
        });
        res.json({ doiSoat });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Đối soát cuối ca:');
    }
}

app.get('/api/ca/doisoat', kiemTraToken, choPhepVaiTro(1, 4), handleDoiSoatCa);

// Chốt ca (Phân hệ 3: Pre-Close Gate STRICT/CARRY_OVER + Blind Drop Recount Challenge 1 lần + Atomic Z-Report Counter + ZReportSnapshot bất biến!)
async function handleDongCa(req, res) {
    const {
        tienMatThucTe: rawActual,
        maCaThuNgan,
        ghiChuChenhLech,
        chiTietMenhGia,
        tienGiuLaiKet = 0,
        confirmRecount = false,
        outboxPendingCount = 0,
        branchId = null,
        terminalId = null,
    } = req.body || {};
    const tenantId = layTenantId(req);

    const denom = computeDenominationTotal(chiTietMenhGia);
    const menhGiaClean = denom.cleanMap;
    const tienMatThucTe =
        rawActual !== undefined && rawActual !== null && rawActual !== ''
            ? Number(rawActual)
            : denom.cleanMap
            ? denom.total
            : NaN;

    if (!Number.isFinite(tienMatThucTe) || tienMatThucTe < 0) {
        return res.status(400).json({ message: 'Vui lòng cung cấp tienMatThucTe hoặc chiTietMenhGia hợp lệ (>= 0)!' });
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            let ca = null;
            if (maCaThuNgan && Number(req.user.vaiTro) === 1) {
                const rCa = await client.query(
                    `SELECT MaCaThuNgan, MaNV, ThoiGianMoCa, TienMatDauCa,
                            COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'branchid', ''), $2::text || '_MAIN') AS BranchId,
                            COALESCE(NULLIF(to_jsonb(CaThuNgan)->>'terminalid', ''), 'POS_01') AS TerminalId,
                            COALESCE((to_jsonb(CaThuNgan)->>'solandemlai')::int, 0) AS SoLanDemLai
                       FROM CaThuNgan
                      WHERE MaCaThuNgan = $1 AND TrangThaiCa = 1 AND COALESCE(TenantId::text, 'DEFAULT') = $2::text
                      FOR UPDATE`,
                    [maCaThuNgan, tenantId]
                );
                ca = rCa.rows[0] || null;
            } else {
                ca = await layCaDangMo(client, 'UPDATE', tenantId, {
                    branchId: branchId || req.user.branchId || null,
                    terminalId: terminalId || null,
                });
                if (!ca && (branchId || terminalId)) {
                    ca = await layCaDangMo(client, 'UPDATE', tenantId);
                }
            }
            if (!ca) throw new LoiNghiepVu(409, 'Hệ thống không có ca nào đang mở!', { maLoi: 'CHUA_MO_CA' });

            const caBranch = normalizeBranchForShift(tenantId, ca.branchid || branchId);
            const caTerminal = normalizeTerminalId(ca.terminalid || terminalId);
            const policy = await getTenantShiftPolicy(client, tenantId);

            if (policy.strictDenomination && !menhGiaClean) {
                throw new LoiNghiepVu(
                    400,
                    'Quán đang bật chế độ đếm mệnh giá bắt buộc (Strict Denomination) — vui lòng nhập chi tiết số tờ từng mệnh giá!',
                    { code: 'DENOMINATION_REQUIRED' }
                );
            }

            // 1. Cổng kiểm tra an toàn trước khi chốt ca (STRICT chặn 409 nếu còn bàn/outbox/VietQR treo; CARRY_OVER ghi bàn chuyển giao vào Z-Report)
            const preCheck = await computePreCloseChecklist(client, {
                tenantId,
                branchId: caBranch,
                maCaThuNgan: ca.macathungan,
                outboxPendingCount,
            });
            if (!preCheck.canClose) {
                throw new LoiNghiepVu(
                    409,
                    `Không thể chốt ca ở chế độ STRICT: ${preCheck.blockingReasons.join(' ')}`,
                    {
                        code: 'PRE_CLOSE_BLOCKED',
                        maLoi: 'PRE_CLOSE_BLOCKED',
                        checklist: preCheck,
                    }
                );
            }

            const ds = await tinhDoiSoatCa(client, ca.macathungan, tienMatThucTe);
            const absDiff = Math.abs(Number(ds.chenhLech || 0));
            const recountThreshold = Number(policy.nguongLechCaRecount ?? 10000);

            const currentRecountAttempts = Number(ca.solandemlai || 0);
            const hasCompletedFirstChallenge = currentRecountAttempts >= 1;

            // 2. True Blind Drop Recount Challenge (Server-enforced bằng CaThuNgan.SoLanDemLai!)
            // Bảo mật L3.1: Tuyệt đối KHÔNG cho client bỏ qua lần đếm lại bằng confirmRecount=true khi máy chủ chưa từng yêu cầu đếm lại (SoLanDemLai < 1)!
            if (absDiff > recountThreshold && (!hasCompletedFirstChallenge || !Boolean(confirmRecount))) {
                await client.query(
                    `UPDATE CaThuNgan SET SoLanDemLai = COALESCE(SoLanDemLai, 0) + 1 WHERE MaCaThuNgan = $1`,
                    [ca.macathungan]
                );
                return {
                    recountRequired: true,
                    maCaThuNgan: ca.macathungan,
                };
            }

            const ghiChu = ghiChuChenhLech ? String(ghiChuChenhLech).trim().slice(0, 500) : null;
            if (absDiff > recountThreshold && (!ghiChu || ghiChu.length < 10)) {
                throw new LoiNghiepVu(
                    400,
                    'Số tiền vẫn chênh lệch sau lần kiểm đếm thứ 2 — vui lòng nhập ghi chú giải trình chi tiết (tối thiểu 10 ký tự)!',
                    { code: 'VARIANCE_REASON_REQUIRED' }
                );
            }

            // 3. Đánh số Z-Report nguyên tử theo (TenantId, BranchId) & đóng băng ZReportSnapshot JSONB
            const { zInt, zNumber } = await nextAtomicZReportNumber(client, tenantId, caBranch);
            const carryFloat = Math.max(0, Math.min(tienMatThucTe, Number(tienGiuLaiKet || 0)));
            const recountRes = await client.query(
                `SELECT COALESCE((to_jsonb(CaThuNgan)->>'solandemlai')::int, 0) AS n FROM CaThuNgan WHERE MaCaThuNgan = $1`,
                [ca.macathungan]
            );
            const recountAttempts = Number(recountRes.rows[0]?.n || 0);

            const zReportSnapshot = await buildImmutableZReportSnapshot(client, {
                tenantId,
                maCaThuNgan: ca.macathungan,
                caRow: ca,
                ds,
                zNumber,
                branchId: caBranch,
                terminalId: caTerminal,
                closeByName: req.user.tenNV || req.user.maNV,
                carryOverFloatNextShift: carryFloat,
                carriedOverOpenTables: {
                    count: preCheck.openOrders.length,
                    estimatedTotal: preCheck.openTablesEstimatedTotal,
                    tables: preCheck.openOrders.slice(0, 20),
                },
                recountAttempts,
            });

            await client.query('SAVEPOINT sp_dong_ca_zreport_p3');
            try {
                await client.query(
                    `UPDATE CaThuNgan
                        SET ThoiGianDongCa = CURRENT_TIMESTAMP, TongThuHoaDon = $2, TongThuLatVat = $3, TongChiLatVat = $4,
                            TienMatThucTe = $5, ChenhLech = $6, TrangThaiCa = 2, GhiChuChenhLech = $7,
                            TongRutKet = $8, ChiTietMenhGia = $9::jsonb, SoZReport = $10,
                            TienGiuLaiKet = $11, ZReportSnapshot = $12::jsonb
                      WHERE MaCaThuNgan = $1`,
                    [
                        ca.macathungan,
                        ds.doanhThu.tong,
                        ds.thuLatVat,
                        ds.chiLatVat,
                        ds.tienMatThucTe,
                        ds.chenhLech,
                        ghiChu,
                        ds.rutKet || 0,
                        menhGiaClean ? JSON.stringify(menhGiaClean) : null,
                        zInt,
                        carryFloat,
                        JSON.stringify(zReportSnapshot),
                    ]
                );
                await client.query('RELEASE SAVEPOINT sp_dong_ca_zreport_p3');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_dong_ca_zreport_p3').catch(() => {});
                await client.query(
                    `UPDATE CaThuNgan
                        SET ThoiGianDongCa = CURRENT_TIMESTAMP, TongThuHoaDon = $2, TongThuLatVat = $3, TongChiLatVat = $4,
                            TienMatThucTe = $5, ChenhLech = $6, TrangThaiCa = 2, GhiChuChenhLech = $7
                      WHERE MaCaThuNgan = $1`,
                    [ca.macathungan, ds.doanhThu.tong, ds.thuLatVat, ds.chiLatVat, ds.tienMatThucTe, ds.chenhLech, ghiChu]
                );
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: absDiff > recountThreshold ? 'SHIFT_CLOSE_DIFF' : 'SHIFT_CLOSE',
                doiTuong: 'CATHUNGAN',
                maDoiTuong: ca.macathungan,
                giaTriMoi: {
                    zNumber,
                    branchId: caBranch,
                    terminalId: caTerminal,
                    tienMatLyThuyet: ds.tienMatLyThuyet,
                    tienMatThucTe: ds.tienMatThucTe,
                    chenhLech: ds.chenhLech,
                    tienGiuLaiKet: carryFloat,
                    rutKet: ds.rutKet || 0,
                    recountAttempts,
                    doanhThu: ds.doanhThu,
                    chiTietMenhGia: menhGiaClean,
                },
                lyDo: ghiChu || ds.trangThai,
                ip: req.ip,
                batBuoc: true,
            });

            const doiSoatCuoi = await tinhDoiSoatCa(client, ca.macathungan, tienMatThucTe);
            return {
                recountRequired: false,
                zNumber,
                zReportSnapshot,
                doiSoat: doiSoatCuoi,
                soHoaDonDangMo: preCheck.openOrders.length,
                absDiff,
                recountThreshold,
            };
        }, tenantId);

        // Chế độ Đếm lại Blind Drop: trả 422 KHÔNG chứa tienMatLyThuyet / chenhLech!
        if (ketQua.recountRequired) {
            return res.status(422).json({
                code: 'BLIND_RECOUNT_REQUIRED',
                maLoi: 'BLIND_RECOUNT_REQUIRED',
                message:
                    'Số tiền kiểm đếm đang chênh lệch so với sổ quỹ. Vui lòng kiểm tra lại ngăn kéo / tờ tiền kẹt và xác nhận lần 2 kèm lý do giải trình!',
            });
        }

        if (ketQua.absDiff > ketQua.recountThreshold) {
            void dispatchFraudAlertFromAudit(pool, {
                tenantId,
                hanhDong: 'SHIFT_CLOSE_DIFF',
                maNV: req.user.maNV,
                maDoiTuong: ketQua.doiSoat?.maCaThuNgan,
                giaTriMoi: {
                    zNumber: ketQua.zNumber,
                    tienMatLyThuyet: ketQua.doiSoat?.tienMatLyThuyet,
                    tienMatThucTe: ketQua.doiSoat?.tienMatThucTe,
                    chenhLech: ketQua.doiSoat?.chenhLech,
                },
                lyDo: `⚠️ Chốt ca ${ketQua.zNumber} lệch quỹ ${Number(ketQua.doiSoat?.chenhLech || 0).toLocaleString('vi-VN')}đ`,
            }).catch(() => {});
        }

        emitToBranch(io, {
            tenantId,
            branchId: ketQua.doiSoat?.branchId || req.user?.branchId || 'DEFAULT',
            roles: ['POS', 'WAITER'],
            event: 'CA_THAY_DOI',
            payload: { trangThai: 'DONG' },
        });
        res.json({
            message: `Đã chốt ca thành công (${ketQua.zNumber})!`,
            zNumber: ketQua.zNumber,
            zReportSnapshot: ketQua.zReportSnapshot,
            doiSoat: ketQua.doiSoat,
            soHoaDonDangMo: ketQua.soHoaDonDangMo,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Chốt ca:');
    }
}

app.post('/api/ca/dong', kiemTraToken, choPhepVaiTro(1, 4), handleDongCa);

// Lịch sử các ca thu ngân (Quản lý): lọc chuẩn múi giờ Asia/Ho_Chi_Minh + cô lập TenantId
app.get('/api/ca/danhsach', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { tuNgay, denNgay } = req.query;
    const tenantId = layTenantId(req);
    if (!tuNgay || !denNgay) return res.status(400).json({ message: 'Vui lòng cung cấp tham số tuNgay và denNgay (YYYY-MM-DD)!' });
    try {
        const rows = await pool.withTenant(tenantId, async (client) => {
            await client.query('SAVEPOINT sp_ds_ca_ext');
            try {
                const r = await client.query(
                    `SELECT ca.MaCaThuNgan, ca.MaNV, nv.TenNV, ca.ThoiGianMoCa, ca.ThoiGianDongCa, ca.TienMatDauCa,
                            ca.TongThuHoaDon, ca.TongThuLatVat, ca.TongChiLatVat, COALESCE(ca.TongRutKet, 0) AS TongRutKet,
                            ca.TienMatThucTe, ca.ChenhLech, ca.TrangThaiCa, ca.GhiChuChenhLech
                       FROM CaThuNgan ca JOIN NhanVien nv ON nv.MaNV = ca.MaNV
                      WHERE COALESCE(ca.TenantId, 'DEFAULT') = $3
                        AND ca.ThoiGianMoCa >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                        AND ca.ThoiGianMoCa < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                      ORDER BY ca.ThoiGianMoCa DESC`,
                    [tuNgay, denNgay, tenantId]
                );
                await client.query('RELEASE SAVEPOINT sp_ds_ca_ext');
                return r.rows;
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_ds_ca_ext').catch(() => {});
                const r = await client.query(
                    `SELECT ca.MaCaThuNgan, ca.MaNV, nv.TenNV, ca.ThoiGianMoCa, ca.ThoiGianDongCa, ca.TienMatDauCa,
                            ca.TongThuHoaDon, ca.TongThuLatVat, ca.TongChiLatVat, ca.TienMatThucTe, ca.ChenhLech,
                            ca.TrangThaiCa, ca.GhiChuChenhLech
                       FROM CaThuNgan ca JOIN NhanVien nv ON nv.MaNV = ca.MaNV
                      WHERE COALESCE(ca.TenantId, 'DEFAULT') = $3
                        AND ca.ThoiGianMoCa >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                        AND ca.ThoiGianMoCa < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                      ORDER BY ca.ThoiGianMoCa DESC`,
                    [tuNgay, denNgay, tenantId]
                );
                return r.rows;
            }
        });
        const so = (v) => (v === null || v === undefined ? null : Number(v));
        res.json(rows.map((c) => ({
            maCaThuNgan: c.macathungan,
            maNV: c.manv,
            tenNV: c.tennv,
            thoiGianMoCa: c.thoigianmoca,
            thoiGianDongCa: c.thoigiandongca,
            tienMatDauCa: so(c.tienmatdauca),
            tongThuHoaDon: so(c.tongthuhoadon),
            tongThuLatVat: so(c.tongthulatvat),
            tongChiLatVat: so(c.tongchilatvat),
            tongRutKet: so(c.tongrutket) || 0,
            tienMatThucTe: so(c.tienmatthucte),
            chenhLech: so(c.chenhlech),
            trangThaiCa: c.trangthaica,
            ghiChuChenhLech: c.ghichuchenhlech || null,
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách ca:');
    }
});


// [P1 - BCG Matrix] Ma trận Kỹ thuật Thực đơn (Menu Engineering: Stars / Plowhorses / Puzzles / Dogs)
app.get('/api/baocao/menu-engineering', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('inventory_bom'), async (req, res) => {
    const { tuNgay, denNgay } = req.query;
    const tenantId = layTenantId(req);
    if (!tuNgay || !denNgay) {
        return res.status(400).json({ message: 'Vui lòng cung cấp tham số tuNgay và denNgay (YYYY-MM-DD)!' });
    }
    try {
        const r = await chayTruyVanBaoCao(tenantId, (client) => client.query(
            `SELECT cthd.MaMon,
                    COALESCE(MAX(cthd.TenMonSnapshot), MAX(sp.TenMon), cthd.MaMon) AS TenMon,
                    COALESCE(MAX(sp.NhomMon), 'Khác') AS NhomMon,
                    SUM(cthd.SoLuong) AS SoLyBan,
                    SUM(cthd.SoLuong * cthd.DonGia - COALESCE(cthd.GiaGiam, 0) + COALESCE(tp.TienTopping, 0)) AS DoanhThu,
                    SUM(cthd.SoLuong * COALESCE(cthd.GiaVonSnapshot, 0)) AS GiaVon
               FROM ChiTietHoaDon cthd
               JOIN HoaDon hd ON hd.MaHoaDon = cthd.MaHoaDon
               LEFT JOIN SanPham sp ON sp.MaMon = cthd.MaMon
               LEFT JOIN (
                   SELECT MaCTHD, SUM(SoLuong * DonGia) AS TienTopping
                     FROM ChiTietHoaDon_Topping
                    GROUP BY MaCTHD
               ) tp ON tp.MaCTHD = cthd.MaCTHD
              WHERE hd.TrangThaiTT = 1
                AND cthd.TrangThaiPhaChe <> 'DaHuy'
                AND COALESCE(hd.TenantId, 'DEFAULT') = $3
                AND hd.ThoiGianThanhToan >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                AND hd.ThoiGianThanhToan < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
              GROUP BY cthd.MaMon
              HAVING SUM(cthd.SoLuong) > 0
              ORDER BY DoanhThu DESC`,
            [tuNgay, denNgay, tenantId]));

        const rawItems = r.rows.map((row) => {
            const soLyBan = Number(row.solyban || 0);
            const doanhThu = Number(row.doanhthu || 0);
            const giaVon = Number(row.giavon || 0);
            const laiGop = doanhThu - giaVon;
            const laiGopMoiLy = soLyBan > 0 ? Math.round(laiGop / soLyBan) : 0;
            const bienLoiNhuanPct = doanhThu > 0 ? Math.round((laiGop / doanhThu) * 1000) / 10 : 0;
            return {
                maMon: row.mamon,
                tenMon: row.tenmon,
                nhomMon: row.nhommon,
                soLyBan,
                doanhThu,
                giaVon,
                laiGop,
                laiGopMoiLy,
                bienLoiNhuanPct,
            };
        });

        const totalQty = rawItems.reduce((s, i) => s + i.soLyBan, 0);
        const totalProfit = rawItems.reduce((s, i) => s + i.laiGop, 0);
        // Chuẩn Menu Engineering Kasavana & Smith: ngưỡng phổ biến = 70% trung bình, ngưỡng lãi gộp = trung bình gia quyền
        const avgQtyThreshold = rawItems.length > 0 ? (totalQty / rawItems.length) * 0.7 : 0;
        const avgUnitMargin = totalQty > 0 ? totalProfit / totalQty : 0;

        const ADVICE = {
            STAR: { label: '⭐ Ngôi sao (Star)', action: 'Giữ vững chất lượng, đẩy lên đầu menu & gợi ý upsell!' },
            PLOWHORSE: { label: '🐄 Bò sữa (Plowhorse)', action: 'Bán chạy nhưng lãi mỏng — tối ưu định lượng BOM hoặc tăng nhẹ 2–3k.' },
            PUZZLE: { label: '❓ Câu đố (Puzzle)', action: 'Lãi rất cao nhưng ít khách gọi — đẩy Combo, ảnh lớn hoặc khuyến mãi dùng thử.' },
            DOG: { label: '🐕 Chó mực (Dog)', action: 'Bán chậm & lãi thấp — cân nhắc lược bỏ khỏi menu để giảm tồn kho.' },
        };

        const items = rawItems.map((it) => {
            const highPop = it.soLyBan >= avgQtyThreshold;
            const highMargin = it.laiGopMoiLy >= avgUnitMargin;
            const category = highPop && highMargin
                ? 'STAR'
                : highPop && !highMargin
                ? 'PLOWHORSE'
                : !highPop && highMargin
                ? 'PUZZLE'
                : 'DOG';
            return {
                ...it,
                category,
                categoryLabel: ADVICE[category].label,
                advice: ADVICE[category].action,
            };
        });

        const summary = {
            STAR: items.filter((i) => i.category === 'STAR').length,
            PLOWHORSE: items.filter((i) => i.category === 'PLOWHORSE').length,
            PUZZLE: items.filter((i) => i.category === 'PUZZLE').length,
            DOG: items.filter((i) => i.category === 'DOG').length,
            avgQtyThreshold: Math.round(avgQtyThreshold * 10) / 10,
            avgUnitMargin: Math.round(avgUnitMargin),
        };

        res.json({ kyBaoCao: { tuNgay, denNgay }, summary, items });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Menu Engineering (BCG Matrix):');
    }
});

app.get('/api/baocao/dashboard', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    let { tuNgay, denNgay } = req.query;
    const tenantId = layTenantId(req);
    if (!tuNgay || !denNgay) return res.status(400).json({ message: 'Vui lòng cung cấp tham số tuNgay và denNgay (YYYY-MM-DD)!' });

    try {
        // [PHÂN HỆ 9] Gói FREE giới hạn xem lịch sử báo cáo 7 ngày gần nhất (reportHistoryDays = 7)
        let reportLimitDays = -1;
        let wasClamped = false;
        let currentPlan = req.user?.goiCuoc || 'PRO';
        if (tenantId !== 'DEFAULT') {
            const ent = await layEntitlementTenant(pool, tenantId);
            currentPlan = ent.goiCuoc || currentPlan;
            const limitDays = Number(ent.flags?.reportHistoryDays ?? -1);
            if (Number.isFinite(limitDays) && limitDays > 0) {
                reportLimitDays = limitDays;
                const vnNowMs = Date.now() + 7 * 3600000;
                const minAllowedIso = new Date(vnNowMs - (limitDays - 1) * 86400000).toISOString().slice(0, 10);
                if (String(tuNgay) < minAllowedIso) {
                    tuNgay = minAllowedIso;
                    wasClamped = true;
                }
                if (String(denNgay) < tuNgay) {
                    denNgay = tuNgay;
                }
            }
        }
        const [doanhThuNgayResult, chiPhiResult, ptttResult, topMonResult, refundNgayResult, cogsAdjNgayResult] = await Promise.all([
            chayTruyVanBaoCao(tenantId, async (client) => {
                await client.query('SAVEPOINT sp_dash_net_rev');
                try {
                    // [Wave 2 — P0-05] Khớp 100% Z-Report: loại LaMonTang = TRUE khỏi doanh thu, cộng GiaModifiers, trừ ChietKhauMon + GiaGiam + KM/Điểm
                    const r = await client.query(`
                        WITH DoanhThuMon AS (
                            SELECT 
                                hd.MaHoaDon,
                                TO_CHAR(hd.ThoiGianThanhToan::timestamptz AT TIME ZONE '${VN_TZ}', 'YYYY-MM-DD') AS Ngay,
                                SUM(
                                    CASE
                                        WHEN COALESCE(cthd.LaMonTang, FALSE) = TRUE THEN 0
                                        ELSE GREATEST(
                                            0,
                                            cthd.SoLuong * (cthd.DonGia + COALESCE(cthd.GiaModifiers, 0))
                                            - COALESCE(cthd.GiaGiam, 0)
                                            - COALESCE(cthd.ChietKhauMon, 0)
                                        )
                                    END
                                ) AS TienMon,
                                COALESCE(
                                    SUM(CASE WHEN COALESCE(cthd.LaMonTang, FALSE) = TRUE THEN 0 ELSE COALESCE(tp.TienTopping, 0) END),
                                    0
                                ) AS TienTopping,
                                COALESCE(MAX(hd.TienGiamKM), 0) + COALESCE(MAX(hd.TienGiamDiem), 0) AS TienGiamHD,
                                COALESCE(SUM(CASE WHEN cthd.TrangThaiPhaChe <> 'DaHuy' THEN cthd.SoLuong * COALESCE(cthd.GiaVonSnapshot, 0) ELSE 0 END), 0) AS GiaVon
                            FROM HoaDon hd
                            JOIN ChiTietHoaDon cthd
                              ON hd.MaHoaDon = cthd.MaHoaDon
                             AND (cthd.TrangThaiPhaChe <> 'DaHuy' OR COALESCE(cthd.LyDoHuy, '') LIKE '[Hoàn tiền%')
                            LEFT JOIN (
                                SELECT MaCTHD, SUM(SoLuong * DonGia) AS TienTopping
                                FROM ChiTietHoaDon_Topping
                                GROUP BY MaCTHD
                            ) tp ON cthd.MaCTHD = tp.MaCTHD
                            WHERE (
                                  hd.TrangThaiTT = 1
                                  OR (
                                      hd.TrangThaiTT = 2
                                      AND EXISTS (
                                          SELECT 1
                                            FROM public.order_refunds r
                                           WHERE r.mahoadon = hd.MaHoaDon::text
                                             AND COALESCE(r.tenantid, 'DEFAULT') = COALESCE(hd.TenantId, 'DEFAULT')
                                      )
                                  )
                              )
                              AND COALESCE(hd.TenantId, 'DEFAULT') = $3
                              AND hd.ThoiGianThanhToan >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                              AND hd.ThoiGianThanhToan < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                            GROUP BY hd.MaHoaDon, TO_CHAR(hd.ThoiGianThanhToan::timestamptz AT TIME ZONE '${VN_TZ}', 'YYYY-MM-DD')
                        )
                        SELECT Ngay,
                               COUNT(MaHoaDon) AS SoDon,
                               SUM(GREATEST(0, TienMon + TienTopping - TienGiamHD)) AS DoanhThu,
                               SUM(TienGiamHD) AS TongGiamGia,
                               SUM(GiaVon) AS GiaVon
                        FROM DoanhThuMon
                        GROUP BY Ngay
                        ORDER BY Ngay ASC
                    `, [tuNgay, denNgay, tenantId]);
                    await client.query('RELEASE SAVEPOINT sp_dash_net_rev');
                    return r;
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_dash_net_rev').catch(() => {});
                    return client.query(`
                        WITH DoanhThuMon AS (
                            SELECT 
                                hd.MaHoaDon,
                                TO_CHAR(hd.ThoiGianThanhToan::timestamptz AT TIME ZONE '${VN_TZ}', 'YYYY-MM-DD') AS Ngay,
                                SUM(cthd.SoLuong * cthd.DonGia - COALESCE(cthd.GiaGiam, 0)) AS TienMon,
                                COALESCE(SUM(tp.TienTopping), 0) AS TienTopping,
                                COALESCE(SUM(CASE WHEN cthd.TrangThaiPhaChe <> 'DaHuy' THEN cthd.SoLuong * COALESCE(cthd.GiaVonSnapshot, 0) ELSE 0 END), 0) AS GiaVon
                            FROM HoaDon hd
                            JOIN ChiTietHoaDon cthd
                              ON hd.MaHoaDon = cthd.MaHoaDon
                             AND (cthd.TrangThaiPhaChe <> 'DaHuy' OR COALESCE(to_jsonb(cthd)->>'lydohuy', '') LIKE '[Hoàn tiền%')
                            LEFT JOIN (
                                SELECT MaCTHD, SUM(SoLuong * DonGia) AS TienTopping
                                FROM ChiTietHoaDon_Topping
                                GROUP BY MaCTHD
                            ) tp ON cthd.MaCTHD = tp.MaCTHD
                            WHERE (
                                  hd.TrangThaiTT = 1
                                  OR (
                                      hd.TrangThaiTT = 2
                                      AND EXISTS (
                                          SELECT 1
                                            FROM public.order_refunds r
                                           WHERE r.mahoadon = hd.MaHoaDon::text
                                             AND COALESCE(r.tenantid, 'DEFAULT') = COALESCE(hd.TenantId, 'DEFAULT')
                                      )
                                  )
                              )
                              AND COALESCE(hd.TenantId, 'DEFAULT') = $3
                              AND hd.ThoiGianThanhToan >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                              AND hd.ThoiGianThanhToan < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                            GROUP BY hd.MaHoaDon, TO_CHAR(hd.ThoiGianThanhToan::timestamptz AT TIME ZONE '${VN_TZ}', 'YYYY-MM-DD')
                        )
                        SELECT Ngay,
                               COUNT(MaHoaDon) AS SoDon,
                               SUM(TienMon + TienTopping) AS DoanhThu,
                               0 AS TongGiamGia,
                               SUM(GiaVon) AS GiaVon
                        FROM DoanhThuMon
                        GROUP BY Ngay
                        ORDER BY Ngay ASC
                    `, [tuNgay, denNgay, tenantId]);
                }
            }),

            // [Wave 2 — P0-05] Loại trừ phiếu nhập kho đã bị đảo (LoaiGD = 9 tham chiếu MaGDThamChieu)
            chayTruyVanBaoCao(tenantId, (client) => client.query(`
                SELECT COALESCE(SUM(ct.SoLuong * ct.DonGiaNhap), 0) AS TongChiPhiNhap
                FROM PhieuGiaoDichKho pgd
                JOIN ChiTietGiaoDichKho ct ON pgd.MaGiaoDich = ct.MaGiaoDich
                WHERE pgd.LoaiGD = 1
                  AND COALESCE(pgd.TenantId, 'DEFAULT') = $3
                  AND pgd.ThoiGianTao >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                  AND pgd.ThoiGianTao < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                  AND NOT EXISTS (
                      SELECT 1
                        FROM PhieuGiaoDichKho rev
                       WHERE rev.LoaiGD = 9
                         AND COALESCE(rev.TenantId, 'DEFAULT') = $3
                         AND rev.MaGDThamChieu = pgd.MaGiaoDich::text
                  )
            `, [tuNgay, denNgay, tenantId])),

            runtimeFlags.paymentsSanSang
                ? chayTruyVanBaoCao(tenantId, (client) => client.query(`
                    SELECT PhuongThucTT,
                           COUNT(DISTINCT CASE WHEN SoTien > 0 THEN MaHoaDon END) AS SoDon,
                           COALESCE(SUM(SoTien), 0) AS TongTien
                      FROM (
                          SELECT op.MaHoaDon,
                                 op.PhuongThucTT,
                                 CASE WHEN op.TrangThai = 'REFUNDED' THEN -op.SoTien ELSE op.SoTien END AS SoTien
                            FROM Order_Payments op
                           WHERE op.TrangThai IN ('PAID', 'REFUNDED')
                             AND COALESCE(op.TenantId, 'DEFAULT') = $3
                             AND op.ThoiGianTao >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                             AND op.ThoiGianTao < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                          UNION ALL
                          SELECT hd.MaHoaDon::text AS MaHoaDon,
                                 COALESCE(hd.PhuongThucTT, 'TIEN_MAT') AS PhuongThucTT,
                                 hd.TongTienThanhToan AS SoTien
                            FROM HoaDon hd
                           WHERE hd.TrangThaiTT = 1
                             AND COALESCE(hd.TenantId, 'DEFAULT') = $3
                             AND hd.ThoiGianThanhToan >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                             AND hd.ThoiGianThanhToan < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                             AND NOT EXISTS (
                                 SELECT 1 FROM Order_Payments op2
                                  WHERE op2.MaHoaDon = hd.MaHoaDon::text AND op2.TrangThai = 'PAID'
                             )
                      ) combined
                     GROUP BY PhuongThucTT
                `, [tuNgay, denNgay, tenantId]))
                : chayTruyVanBaoCao(tenantId, (client) => client.query(`
                    SELECT COALESCE(PhuongThucTT, 'TIEN_MAT') AS PhuongThucTT,
                           COUNT(*) AS SoDon,
                           COALESCE(SUM(TongTienThanhToan), 0) AS TongTien
                      FROM HoaDon
                     WHERE TrangThaiTT = 1
                       AND COALESCE(TenantId, 'DEFAULT') = $3
                       AND ThoiGianThanhToan >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                       AND ThoiGianThanhToan < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                     GROUP BY COALESCE(PhuongThucTT, 'TIEN_MAT')
                `, [tuNgay, denNgay, tenantId])),

            chayTruyVanBaoCao(tenantId, (client) => client.query(`
                SELECT cthd.MaMon,
                       COALESCE(MAX(cthd.TenMonSnapshot), MAX(sp.TenMon)) AS TenMon,
                       SUM(cthd.SoLuong) AS TongLy,
                       SUM(
                           CASE
                               WHEN COALESCE(cthd.LaMonTang, FALSE) = TRUE THEN 0
                               ELSE GREATEST(
                                   0,
                                   cthd.SoLuong * (cthd.DonGia + COALESCE(cthd.GiaModifiers, 0))
                                   - COALESCE(cthd.GiaGiam, 0)
                                   - COALESCE(cthd.ChietKhauMon, 0)
                               ) + COALESCE(tp.TienTopping, 0)
                           END
                       ) AS DoanhThu,
                       SUM(cthd.SoLuong * COALESCE(cthd.GiaVonSnapshot, 0)) AS GiaVon
                  FROM HoaDon hd
                  JOIN ChiTietHoaDon cthd ON hd.MaHoaDon = cthd.MaHoaDon AND cthd.TrangThaiPhaChe <> 'DaHuy'
                  JOIN SanPham sp ON sp.MaMon = cthd.MaMon
                  LEFT JOIN (
                      SELECT MaCTHD, SUM(SoLuong * DonGia) AS TienTopping
                        FROM ChiTietHoaDon_Topping
                       GROUP BY MaCTHD
                  ) tp ON tp.MaCTHD = cthd.MaCTHD
                 WHERE hd.TrangThaiTT = 1
                   AND COALESCE(hd.TenantId, 'DEFAULT') = $3
                   AND hd.ThoiGianThanhToan >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                   AND hd.ThoiGianThanhToan < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                 GROUP BY cthd.MaMon
                 ORDER BY TongLy DESC, DoanhThu DESC
                 LIMIT 8
            `, [tuNgay, denNgay, tenantId])),

            // [Wave 2 — P0-05] Tổng hoàn tiền (order_refunds) theo ngày để trừ khỏi Doanh thu thuần
            chayTruyVanBaoCao(tenantId, async (client) => {
                await client.query('SAVEPOINT sp_dash_refunds');
                try {
                    const r = await client.query(`
                        SELECT TO_CHAR(thoigiantao::timestamptz AT TIME ZONE '${VN_TZ}', 'YYYY-MM-DD') AS Ngay,
                               COALESCE(SUM(sotienhoan), 0) AS TongHoan
                          FROM public.order_refunds
                         WHERE COALESCE(tenantid, 'DEFAULT') = $3
                           AND thoigiantao >= ($1::timestamp AT TIME ZONE '${VN_TZ}')
                           AND thoigiantao < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                         GROUP BY TO_CHAR(thoigiantao::timestamptz AT TIME ZONE '${VN_TZ}', 'YYYY-MM-DD')
                    `, [tuNgay, denNgay, tenantId]);
                    await client.query('RELEASE SAVEPOINT sp_dash_refunds');
                    return r;
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_dash_refunds').catch(() => {});
                    return { rows: [] };
                }
            }),

            // [Wave 2 — P0-05] Tổng điều chỉnh giá vốn (cogs_adjustment_journal) theo business_date
            chayTruyVanBaoCao(tenantId, async (client) => {
                await client.query('SAVEPOINT sp_dash_cogs_adj');
                try {
                    const r = await client.query(`
                        SELECT TO_CHAR(business_date, 'YYYY-MM-DD') AS Ngay,
                               COALESCE(SUM(adjustment_amount), 0) AS TongDieuChinhGiaVon
                          FROM public.cogs_adjustment_journal
                         WHERE tenant_id = $3
                           AND business_date >= $1::date
                           AND business_date <= $2::date
                         GROUP BY TO_CHAR(business_date, 'YYYY-MM-DD')
                    `, [tuNgay, denNgay, tenantId]);
                    await client.query('RELEASE SAVEPOINT sp_dash_cogs_adj');
                    return r;
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_dash_cogs_adj').catch(() => {});
                    return { rows: [] };
                }
            }),
        ]);

        const refundByDate = new Map(refundNgayResult.rows.map((r) => [r.ngay, parseFloat(r.tonghoan || 0)]));
        const cogsAdjByDate = new Map(cogsAdjNgayResult.rows.map((r) => [r.ngay, parseFloat(r.tongdieuchinhgiavon || 0)]));
        const allDates = new Set([
            ...doanhThuNgayResult.rows.map((r) => r.ngay),
            ...refundByDate.keys(),
            ...cogsAdjByDate.keys(),
        ]);
        const revRowByDate = new Map(doanhThuNgayResult.rows.map((r) => [r.ngay, r]));

        let tongSoDon = 0;
        let tongDoanhThu = 0;
        let tongGiaVon = 0;
        let tongGiamGia = 0;
        let tongHoanTien = 0;
        let tongDieuChinhGiaVon = 0;
        const bieuDoDoanhThu = [...allDates].sort().map((ngay) => {
            const row = revRowByDate.get(ngay);
            const soDon = row ? parseInt(row.sodon, 10) : 0;
            const doanhThuGop = row ? parseFloat(row.doanhthu || 0) : 0;
            const hoanTien = refundByDate.get(ngay) || 0;
            const doanhThu = Math.max(0, Math.round((doanhThuGop - hoanTien) * 100) / 100);
            const cogsAdj = cogsAdjByDate.get(ngay) || 0;
            const giaVon = Math.round(((row ? parseFloat(row.giavon || 0) : 0) + cogsAdj) * 100) / 100;
            const giamGia = row ? parseFloat(row.tonggiamgia || 0) : 0;
            tongSoDon += soDon;
            tongDoanhThu = Math.round((tongDoanhThu + doanhThu) * 100) / 100;
            tongGiaVon = Math.round((tongGiaVon + giaVon) * 100) / 100;
            tongGiamGia = Math.round((tongGiamGia + giamGia) * 100) / 100;
            tongHoanTien = Math.round((tongHoanTien + hoanTien) * 100) / 100;
            tongDieuChinhGiaVon = Math.round((tongDieuChinhGiaVon + cogsAdj) * 100) / 100;
            return { ngay, soDon, doanhThu, hoanTien, giamGia, giaVon, dieuChinhGiaVon: cogsAdj, loiNhuanGop: doanhThu - giaVon };
        });

        const tongChiPhiNhapKho = parseFloat(chiPhiResult.rows[0].tongchiphinhap);
        const loiNhuanGop = Math.round((tongDoanhThu - tongGiaVon) * 100) / 100;
        const tySuatLoiNhuan = tongDoanhThu > 0 ? Math.round((loiNhuanGop / tongDoanhThu) * 1000) / 10 : 0;
        const loiNhuanTamTinh = Math.round((tongDoanhThu - tongChiPhiNhapKho) * 100) / 100;

        const doanhThuTheoPhuongThuc = ptttResult.rows.map((r) => ({
            phuongThucTT: r.phuongthuctt,
            soDon: Number(r.sodon),
            tongTien: Number(r.tongtien),
        }));

        const topMonBanChay = topMonResult.rows.map((r) => {
            const dt = Number(r.doanhthu);
            const gv = Number(r.giavon || 0);
            return {
                maMon: r.mamon,
                tenMon: r.tenmon,
                tongLy: Number(r.tongly),
                doanhThu: dt,
                giaVon: gv,
                loiNhuanGop: dt - gv,
            };
        });

        res.json({
            kyBaoCao: { tuNgay, denNgay },
            reportLimitDays,
            wasClamped,
            currentPlan,
            tongQuan: {
                tongSoDon,
                tongDoanhThu,
                tongHoanTien,
                tongGiamGia,
                tongGiaVon,
                tongDieuChinhGiaVon,
                loiNhuanGop,
                tySuatLoiNhuan,
                tongChiPhiNhapKho,
                loiNhuanTamTinh,
            },
            bieuDoDoanhThu,
            doanhThuTheoPhuongThuc,
            topMonBanChay,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Dashboard:');
    }
});


    // =========================================================================
    // [Wave 4B — P2-01] BÁO CÁO TỔNG HỢP VẬT HÓA THEO NGÀY KINH DOANH (04:00)
    // =========================================================================
    app.post('/api/reports/daily-summary/refresh', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = String(
            req.body?.branchId || req.headers['x-branch-id'] || req.query?.branchId || 'CN01'
        ).trim();
        const cutoffHour = req.body?.cutoffHour !== undefined ? Number(req.body.cutoffHour) : null;
        const timezone = req.body?.timezone ? String(req.body.timezone).trim() : null;
        const businessDate = req.body?.businessDate
            ? String(req.body.businessDate).trim()
            : computeBusinessDate(new Date(), cutoffHour ?? 4);

        try {
            const summary = await chayGiaoDich(
                (client) =>
                    refreshDailyBranchFinancialSummary(client, {
                        tenantId,
                        branchId,
                        businessDate,
                        cutoffHour,
                        timezone,
                    }),
                tenantId
            );
            return res.json({
                message: 'Đã làm mới bảng tổng hợp tài chính theo ngày kinh doanh!',
                summary,
            });
        } catch (error) {
            return guiLoi(res, error, 'Lỗi API Refresh Daily Branch Financial Summary:');
        }
    });

    app.get('/api/reports/daily-summary', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = req.query.branchId || req.headers['x-branch-id'] || null;
        const fromDate = req.query.fromDate || req.query.tuNgay || null;
        const toDate = req.query.toDate || req.query.denNgay || null;
        const limit = req.query.limit ? Number(req.query.limit) : 90;

        try {
            const data = await chayTruyVanBaoCao(tenantId, (client) =>
                getDailyBranchFinancialSummary(client, {
                    tenantId,
                    branchId,
                    fromDate,
                    toDate,
                    limit,
                })
            );
            return res.json({
                source: reportPool && reportPool !== pool ? 'read_replica' : 'primary_read_only',
                ...data,
            });
        } catch (error) {
            return guiLoi(res, error, 'Lỗi API Đọc Daily Branch Financial Summary:');
        }
    });

    return {
        handleMoCa,
        handleThuChiCa,
        handleDoiSoatCa,
        handleDongCa,
    };
}

module.exports = {
    registerReportsDomain,
    computeBusinessDate,
    refreshDailyBranchFinancialSummary,
    getDailyBranchFinancialSummary,
};
