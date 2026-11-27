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
    OFFLINE_CLOCK_DRIFT_LIMIT_MS,
    coQuyenHan,
    suyLuanTramCheBien,
    ngayHomNayVN,
    LoiNghiepVu,
    guiLoi,
    choPhepVaiTro,
    layTenantId,
    lam3,
    docKhoaIdempotency,
    detectOfflineClockDrift,
} = require('../../core/auditAndSecurity');
const {
    emitToBranch,
} = require('../../core/socketRooms');
const {
    chiaDeuTienVND,
    capSoThuTuNgayKhongTrung,
    kiemTraVaTangVersionHoaDon,
    recalculateInvoiceTotals,
    phaVoComboKhiHuyMon,
} = require('../../../modules/fohEngineService');
const {
    normalizeBranchId,
    roomBranchPos,
    roomBranchKds,
    roomBranchExpo,
    roomBranchWaiter,
    insertKdsEventLog,
    emitScopedKdsEvent,
    recordAndEmitOrderNewByStation,
    acquireIdempotencyLock,
    completeIdempotencyLock,
    failIdempotencyLock,
} = require('../../../modules/kdsPhase2Engine');
const {
    normalizeBranchForShift,
    normalizeTerminalId,
    getTenantShiftPolicy,
} = require('../../../modules/paymentShiftPhase3Engine');
const {
    normalizeInventoryBranch,
    todayDateVN,
    ensureBranchRecord,
    lockBranchStockOrdered,
    updateBranchStockRow,
    insertLedgerLine,
} = require('../../../modules/inventoryCogsPhase4Engine');
const {
    kiemTraHopLeKhuyenMai,
} = require('../../../modules/promotionAndPinService');
const {
    xoayQrTokenChoCacBan,
} = require('../../../modules/ecosystemPhase8Routes');
const {
    createAdjustmentDecreaseOnRefund,
    maskPhoneForRole,
} = require('../../../modules/vnTaxAndEInvoiceService');

function registerOrdersDomain(app, deps) {
    const {
        pool,
        io,
        runtimeFlags,
        chayGiaoDich,
        qTenant,
        kiemTraToken,
        kiemTraHanSuDung,
        kiemTraHanMucDonThang,
        ghiAuditLog,
        dispatchFraudAlertFromAudit,
        kiemTraCanhBaoTanSuatGianLan,
        xacThucPinQuanLy,
        KIEU_KHOA,
        SQL_MON_PHA_CHE,
        mapMonPhaChe,
        tinhDoiSoatCa,
        chanSuaDonDangCoUuDai,
        layCaDangMo,
        loiChuaMoCa,
        layCaChoGiaoDichOffline,
        layMonTheoMa,
        layMonTheoTrangThai,
        layHoaDonChiTiet,
        layHoaDonMoCuaBan,
        validateDanhSachMon,
        taoOrderTrongGiaoDich,
        layMapGiaVonNguyenLieu,
        congDinhLuongNguyenLieuDongMon,
        ghiNhanThanhToanTrongGiaoDich,
        doiTrangThaiMon,
        kiemTraVaPhatAllStationsReady,
    } = deps;

// ==========================================
// PHÂN HỆ: BÁN HÀNG & THU NGÂN (POS)
// ==========================================
app.get('/api/ban', kiemTraToken, async (req, res) => {
    const tenantId = layTenantId(req);
    const branchIdFilter = req.query.branchId ? String(req.query.branchId).trim() : null;
    try {
        const result = await pool.withTenant(tenantId, async (client) => {
            const banRes = await client.query(
                `SELECT b.MaBan, b.TenBan, b.TrangThai, b.KhuVuc, b.ToaDoX, b.ToaDoY,
                        to_jsonb(b)->>'branchid' AS BranchId,
                        to_jsonb(b)->>'qrtoken' AS QrToken,
                        COALESCE((to_jsonb(b)->>'qryeucaumoban')::boolean, TRUE) AS QrYeuCauMoBan,
                        COALESCE((to_jsonb(b)->>'qrbatbuocvietqr')::boolean, FALSE) AS QrBatBuocVietQR,
                        hd_open.MaHoaDon AS MaHoaDonMo,
                        hd_open.ThoiGianMoBan AS ThoiGianMoBan,
                        hd_open.SoKhach AS SoKhach,
                        hd_open.Version AS Version,
                        hd_open.LastOrderAt AS LastOrderAt,
                        COALESCE(hd_open.TongMonKds, 0) AS TongMonKds,
                        COALESCE(hd_open.MonDaXongKds, 0) AS MonDaXongKds,
                        COALESCE(hd_open.MonDaPhucVuKds, 0) AS MonDaPhucVuKds,
                        COALESCE(hd_open.TongTamTinh, 0) AS TongTamTinh
                   FROM Ban b
                   LEFT JOIN LATERAL (
                       SELECT h.MaHoaDon,
                              COALESCE((to_jsonb(h)->>'thoigianmoban')::timestamptz, h.ThoiGianTao) AS ThoiGianMoBan,
                              COALESCE((to_jsonb(h)->>'sokhach')::int, 1) AS SoKhach,
                              COALESCE((to_jsonb(h)->>'version')::int, 1) AS Version,
                              (SELECT MAX(c.ThoiGianGoi) FROM ChiTietHoaDon c WHERE c.MaHoaDon = h.MaHoaDon AND c.TrangThaiPhaChe <> 'DaHuy') AS LastOrderAt,
                              (SELECT COUNT(*)::int FROM ChiTietHoaDon c WHERE c.MaHoaDon = h.MaHoaDon AND c.TrangThaiPhaChe <> 'DaHuy') AS TongMonKds,
                              (SELECT COUNT(*)::int FROM ChiTietHoaDon c WHERE c.MaHoaDon = h.MaHoaDon AND c.TrangThaiPhaChe IN ('DaXong', 'DaPhucVu')) AS MonDaXongKds,
                              (SELECT COUNT(*)::int FROM ChiTietHoaDon c WHERE c.MaHoaDon = h.MaHoaDon AND c.TrangThaiPhaChe = 'DaPhucVu') AS MonDaPhucVuKds,
                              COALESCE((
                                  SELECT SUM(CASE WHEN COALESCE((to_jsonb(c)->>'lamontang')::boolean, FALSE) THEN 0
                                             ELSE GREATEST(0, c.SoLuong * (c.DonGia + COALESCE((to_jsonb(c)->>'giamodifiers')::numeric, 0)) - COALESCE(c.GiaGiam, 0) - COALESCE((to_jsonb(c)->>'chietkhaumon')::numeric, 0)) END)
                                    FROM ChiTietHoaDon c
                                   WHERE c.MaHoaDon = h.MaHoaDon AND c.TrangThaiPhaChe <> 'DaHuy'
                              ), 0) + COALESCE((
                                  SELECT SUM(ctp.SoLuong * ctp.DonGia)
                                    FROM ChiTietHoaDon c
                                    JOIN ChiTietHoaDon_Topping ctp ON ctp.MaCTHD = c.MaCTHD
                                   WHERE c.MaHoaDon = h.MaHoaDon
                                     AND c.TrangThaiPhaChe <> 'DaHuy'
                                     AND NOT COALESCE((to_jsonb(c)->>'lamontang')::boolean, FALSE)
                              ), 0) AS TongTamTinh
                         FROM HoaDon_Ban hb
                         JOIN HoaDon h ON h.MaHoaDon = hb.MaHoaDon
                        WHERE hb.MaBan = b.MaBan
                          AND h.TrangThaiTT = 0
                          AND COALESCE(h.TenantId, 'DEFAULT') = $1
                        ORDER BY h.ThoiGianTao DESC
                        LIMIT 1
                   ) hd_open ON TRUE
                  WHERE b.DaXoa = FALSE
                    AND COALESCE(b.TenantId, 'DEFAULT') = $1
                    AND ($2::text IS NULL OR to_jsonb(b)->>'branchid' = $2)
                  ORDER BY b.TenBan`,
                [tenantId, branchIdFilter]
            );

            // Ghép thông tin Đặt bàn sắp đến trong vòng 45 phút (hoặc trễ dưới 20 phút)
            const resMap = new Map();
            try {
                await client.query('SAVEPOINT sp_ban_datban');
                const dbRes = await client.query(
                    `SELECT madatban, maban, tenkhach, sodienthoai, sokhach, thoigianden, tiencoc, ghichu
                       FROM datban
                      WHERE tenantid = $1
                        AND trangthai = 'CONFIRMED'
                        AND thoigianden >= now() - interval '20 minutes'
                        AND thoigianden <= now() + interval '45 minutes'
                      ORDER BY thoigianden ASC`,
                    [tenantId]
                );
                await client.query('RELEASE SAVEPOINT sp_ban_datban');
                for (const d of dbRes.rows) {
                    if (!resMap.has(d.maban)) {
                        resMap.set(d.maban, {
                            maDatBan: d.madatban,
                            tenKhach: d.tenkhach,
                            soDienThoai: d.sodienthoai,
                            soKhach: Number(d.sokhach || 2),
                            thoiGianDen: d.thoigianden,
                            tienCoc: Number(d.tiencoc || 0),
                            ghiChu: d.ghichu || null,
                        });
                    }
                }
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_ban_datban').catch(() => {});
            }

            return banRes.rows.map((r) => ({
                ...r,
                sokhach: Number(r.sokhach || 1),
                kdsProgress: {
                    tongMon: Number(r.tongmonkds || 0),
                    daXong: Number(r.mondaxongkds || 0),
                    daPhucVu: Number(r.mondaphucvukds || 0),
                },
                upcomingReservation: resMap.get(r.maban) || null,
            }));
        });
        res.json(result);
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lấy danh sách Bàn:');
    }
});


async function handleCreateOrAppendOrder(req, res) {
    const {
        maBan = null,
        maHoaDon: maHoaDonReq = null,
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
        branchId = null,
        choThanhToanTruoc = false,
        phuongThucDuKien = null,
        danhSachMon = [],
        combos = [],
    } = req.body || {};
    const maNV = req.user.maNV;

    const loiMon = validateDanhSachMon(danhSachMon, combos);
    if (loiMon) return res.status(400).json({ message: loiMon });

    const khoaIdem = docKhoaIdempotency(req);
    if (khoaIdem === false) {
        return res.status(400).json({ message: 'Header Idempotency-Key không hợp lệ (8-64 ký tự: chữ, số, gạch ngang, gạch dưới)!' });
    }
    const dungIdem = Boolean(khoaIdem) && runtimeFlags.idemSanSang;
    const dauVanTay = dungIdem
        ? crypto
              .createHash('sha256')
              .update(JSON.stringify({ maBan: maBan || null, maHoaDon: maHoaDonReq || null, maKH: maKH || null, danhSachMon, combos }))
              .digest('hex')
        : null;

    const tId = layTenantId(req);
    const resolvedBranchId = normalizeBranchId(branchId || req.user.branchId || 'DEFAULT');
    const clientOrderUid = req.body?.clientOrderUid
        ? String(req.body.clientOrderUid).trim().slice(0, 64)
        : khoaIdem || null;

    // [Phân hệ 2 - Khóa Idempotency 2 pha] Chiếm khóa PROCESSING ngoài giao dịch chính để chặn bấm đúp 50ms!
    let idemLocked = false;
    if (dungIdem) {
        try {
            const lock = await acquireIdempotencyLock(pool, { tenantId: tId, khoaIdem, maNV, dauVanTay });
            if (!lock.acquired) {
                if (lock.state === 'KEY_REUSED') {
                    return res.status(422).json({
                        message: 'Idempotency-Key này đã được dùng cho một order khác!',
                        maLoi: 'IDEMPOTENCY_KEY_REUSED',
                    });
                }
                if (lock.state === 'IN_FLIGHT') {
                    return res.status(409).json({
                        message: 'Order này đang được xử lý (PROCESSING), vui lòng chờ kết quả!',
                        maLoi: 'IDEMPOTENCY_IN_FLIGHT',
                        code: 'IDEMPOTENCY_IN_FLIGHT',
                    });
                }
                if (lock.state === 'DONE' && lock.record) {
                    if (lock.record.responseJson) {
                        return res.status(200).json({ ...lock.record.responseJson, trungLap: true });
                    }
                    const cached = await pool.withTenant(tId, async (client) => ({
                        hoaDon: await layHoaDonChiTiet(client, lock.record.maHoaDon),
                        monMoi: await layMonTheoMa(client, lock.record.dsMaCTHD || []),
                    }));
                    return res.status(200).json({
                        message: `Order #${lock.record.maHoaDon} đã được ghi nhận trước đó, không tạo trùng.`,
                        maHoaDon: lock.record.maHoaDon,
                        laHoaDonMoi: lock.record.laHoaDonMoi,
                        danhSachMon: cached.monMoi,
                        hoaDon: cached.hoaDon,
                        trungLap: true,
                    });
                }
            }
            idemLocked = true;
        } catch (lockErr) {
            return guiLoi(res, lockErr, 'Lỗi khóa Idempotency:');
        }
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const laOfflineSync = req.get('X-Offline-Sync') === '1';
            const caInfo = await layCaChoGiaoDichOffline(client, {
                tenantId: tId,
                maCaGoc: req.body?.maCaThuNganGoc || null,
                laOfflineSync,
            });
            const ca = caInfo.ca;

            const ordRes = await taoOrderTrongGiaoDich(client, {
                tenantId: tId,
                branchId: resolvedBranchId,
                maNV,
                vaiTro: req.user.vaiTro,
                maBan,
                maHoaDon: maHoaDonReq,
                maKH,
                soTheRung,
                loaiDonHang,
                tenKhachVangLai,
                diaChiGiao,
                soKhach,
                phiDongGoi,
                phiDongGoiMoiLy,
                cachTinhThue,
                thueVATPhanTram,
                phiPhucVuPhanTram,
                expectedVersion,
                clientOrderUid,
                laOfflineSync,
                offlineCreatedAt: req.body?.offlineCreatedAt || null,
                choThanhToanTruoc,
                phuongThucDuKien,
                danhSachMon,
                combos,
                ip: req.ip,
                user: req.user,
                managerPin: req.body?.managerPin || null,
                maNVDuyet: req.body?.maNVDuyet || null,
            });

            const {
                maHoaDon,
                laHoaDonMoi,
                dotGoi,
                dsMaCTHD,
                dsMaCTHDFired,
                canhBaoTonThap,
                soldOutWarnings,
                countdownUpdates,
                promoAdjusted,
            } = ordRes;

            const offlineClientId = req.body?.offlineClientId ? String(req.body.offlineClientId).trim().slice(0, 64) : null;
            if (offlineClientId) {
                await client.query('SAVEPOINT sp_ord_off_id');
                try {
                    await client.query(`UPDATE HoaDon SET MaOfflineClient = $2 WHERE MaHoaDon = $1`, [maHoaDon, offlineClientId]);
                    await client.query('RELEASE SAVEPOINT sp_ord_off_id');
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_ord_off_id').catch(() => {});
                }
            }

            if (laOfflineSync) {
                const clockCheck = detectOfflineClockDrift(req.body?.offlineCreatedAt);
                if (clockCheck.tampered) {
                    await ghiAuditLog(client, {
                        tenantId: tId,
                        maNV,
                        vaiTro: req.user.vaiTro,
                        hanhDong: 'OFFLINE_CLOCK_TAMPER_SUSPECTED',
                        doiTuong: 'HOADON',
                        maDoiTuong: maHoaDon,
                        giaTriMoi: {
                            offlineClientId,
                            offlineCreatedAt: req.body?.offlineCreatedAt,
                            serverNow: new Date().toISOString(),
                            driftMs: clockCheck.driftMs,
                            driftMinutes: clockCheck.driftMinutes,
                        },
                        lyDo: `Thiết bị đồng bộ Offline lệch đồng hồ ${clockCheck.driftMinutes} phút (> 10 phút) — từ chối tự động Happy Hour`,
                        ip: req.ip,
                        batBuoc: true,
                    });
                    if (typeof dispatchFraudAlertFromAudit === 'function') {
                        void dispatchFraudAlertFromAudit(pool, {
                            tenantId: tId,
                            hanhDong: 'OFFLINE_CLOCK_TAMPER_SUSPECTED',
                            maNV,
                            maDoiTuong: maHoaDon,
                            giaTriMoi: { driftMinutes: clockCheck.driftMinutes, offlineCreatedAt: req.body?.offlineCreatedAt },
                            lyDo: `⏰ Nghi vấn chỉnh đồng hồ thiết bị Offline (lệch ${clockCheck.driftMinutes} phút) trên HĐ #${maHoaDon}!`,
                        }).catch(() => {});
                    }
                }
                await ghiAuditLog(client, {
                    tenantId: tId,
                    maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'OFFLINE_ORDER_SYNCED',
                    doiTuong: 'HOADON',
                    maDoiTuong: maHoaDon,
                    giaTriMoi: {
                        khoaIdem,
                        offlineClientId,
                        offlineCreatedAt: req.body?.offlineCreatedAt || null,
                        maCaThuNganGoc: caInfo.maCaGoc,
                        maCaHachToan: ca.macathungan,
                        lechCaDongBo: caInfo.lechCaDongBo,
                        caGocDaDong: caInfo.caGocDaDong,
                        ghiChuLechCa: caInfo.ghiChuLechCa,
                        soldOutWarnings,
                    },
                    lyDo: offlineClientId
                        ? `Đồng bộ đơn Offline ${offlineClientId}${caInfo.ghiChuLechCa ? ` (${caInfo.ghiChuLechCa})` : ' từ hàng đợi Outbox'}`
                        : `Đồng bộ từ hàng đợi Offline Outbox Queue${caInfo.ghiChuLechCa ? ` (${caInfo.ghiChuLechCa})` : ''}`,
                    ip: req.ip,
                });
            }

            const monMoi = await layMonTheoMa(client, dsMaCTHD);
            const monMoiFired = await layMonTheoMa(client, dsMaCTHDFired);
            const hoaDon = await layHoaDonChiTiet(client, maHoaDon);

            // Ghi nhật ký sự kiện KDS theo từng Trạm & Chi nhánh ngay trong transaction để seq luôn nhất quán
            const kdsEmitPlan =
                monMoiFired.length > 0
                    ? await recordAndEmitOrderNewByStation(client, io, {
                          tenantId: tId,
                          branchId: resolvedBranchId,
                          maHoaDon,
                          maBan: maBan || null,
                          tenBan: monMoiFired[0]?.tenBan || null,
                          mangDi: !maBan,
                          themMon: !laHoaDonMoi,
                          dotGoi,
                          clientOrderUid,
                          monMoiFired,
                      })
                    : null;

            return {
                trungLap: false,
                maHoaDon,
                laHoaDonMoi,
                dotGoi,
                dsMaCTHD,
                monMoi,
                monMoiFired,
                hoaDon,
                canhBaoTonThap,
                soldOutWarnings,
                countdownUpdates,
                promoAdjusted,
                canhBaoLechCa: caInfo.ghiChuLechCa,
                kdsEmitPlan,
            };
        }, tId);

        const {
            maHoaDon,
            laHoaDonMoi,
            dotGoi,
            dsMaCTHD,
            monMoi,
            monMoiFired,
            hoaDon,
            canhBaoTonThap,
            soldOutWarnings,
            countdownUpdates,
            promoAdjusted,
            kdsEmitPlan,
        } = ketQua;

        const responsePayload = {
            message: laHoaDonMoi
                ? 'Tạo order thành công!'
                : `Đã thêm món (Đợt ${dotGoi}) vào hóa đơn đang mở!`,
            maHoaDon,
            branchId: resolvedBranchId,
            clientOrderUid,
            laHoaDonMoi,
            dotGoi,
            danhSachMon: monMoi,
            hoaDon,
            canhBaoTonThap,
            soldOutWarnings,
            countdownUpdates,
            promoAdjusted,
        };

        if (idemLocked) {
            await completeIdempotencyLock(pool, {
                tenantId: tId,
                khoaIdem,
                maHoaDon,
                laHoaDonMoi,
                dsMaCTHD,
                responseJson: responsePayload,
                httpStatus: 201,
            });
        }

        if (kdsEmitPlan && typeof kdsEmitPlan.flush === 'function') {
            kdsEmitPlan.flush();
        }
        if (Array.isArray(countdownUpdates) && countdownUpdates.length > 0) {
            for (const cd of countdownUpdates) {
                emitToBranch(io, {
                    tenantId: tId,
                    branchId: resolvedBranchId,
                    roles: ['POS', 'WAITER', 'KDS', 'EXPO'],
                    event: 'THUC_DON_THAY_DOI',
                    payload: cd,
                });
                emitToBranch(io, {
                    tenantId: tId,
                    branchId: resolvedBranchId,
                    roles: ['POS', 'WAITER', 'KDS'],
                    event: 'menu:86_updated',
                    payload: { type: 'COUNTDOWN', product: cd },
                });
            }
        }
        if (maBan) {
            emitToBranch(io, {
                tenantId: tId,
                branchId: resolvedBranchId,
                roles: ['POS', 'WAITER'],
                event: 'BAN_THAY_DOI',
                payload: { maBan, trangThai: 2 },
            });
        }

        res.status(201).json(responsePayload);
    } catch (error) {
        if (idemLocked) {
            await failIdempotencyLock(pool, { tenantId: tId, khoaIdem });
        }
        guiLoi(res, error, 'Lỗi API Tạo Order:');
    }
}

app.post('/api/order', kiemTraToken, choPhepVaiTro(1, 3, 4), kiemTraHanSuDung, kiemTraHanMucDonThang, handleCreateOrAppendOrder);
app.post('/api/order/them-mon', kiemTraToken, choPhepVaiTro(1, 3, 4), kiemTraHanSuDung, handleCreateOrAppendOrder);

// [P0] Counter 1-Tap Quick Checkout: Tạo đơn + Trừ kho + Thanh toán + Tích điểm trong 1 transaction duy nhất
app.post('/api/order/quick-checkout', kiemTraToken, choPhepVaiTro(1, 4), kiemTraHanSuDung, kiemTraHanMucDonThang, async (req, res) => {
    const {
        maBan = null,
        maKH = null,
        soTheRung = null,
        loaiDonHang = null,
        tenKhachVangLai = null,
        diaChiGiao = null,
        phiDongGoi = null,
        phiDongGoiMoiLy = 0,
        cachTinhThue = null,
        thueVATPhanTram = null,
        phiPhucVuPhanTram = null,
        branchId = null,
        maKhuyenMai = null,
        diemSuDung = 0,
        tuDongHappyHour = true,
        danhSachMon = [],
        combos = [],
        phuongThucTT = 'TIEN_MAT',
        tienKhachDua,
    } = req.body || {};
    const maNV = req.user.maNV;

    const loiMon = validateDanhSachMon(danhSachMon, combos);
    if (loiMon) return res.status(400).json({ message: loiMon });
    if (!PHUONG_THUC_TT.includes(phuongThucTT)) {
        return res.status(400).json({ message: `phuongThucTT phải là một trong: ${PHUONG_THUC_TT.join(', ')}` });
    }
    if (phuongThucTT === 'VOUCHER' && req.user.vaiTro !== 1) {
        return res.status(403).json({ message: 'Chỉ Quản lý mới có quyền xác nhận thanh toán bằng VOUCHER!' });
    }

    const khoaIdem = docKhoaIdempotency(req);
    if (khoaIdem === false) {
        return res.status(400).json({ message: 'Header Idempotency-Key không hợp lệ!' });
    }
    const dungIdem = Boolean(khoaIdem) && runtimeFlags.idemSanSang;
    const dauVanTay = dungIdem
        ? crypto.createHash('sha256').update(JSON.stringify({ quick: true, maBan, maKH, danhSachMon, combos, phuongThucTT })).digest('hex')
        : null;

    const tId = layTenantId(req);
    const resolvedBranchId = normalizeBranchId(branchId || req.user.branchId || 'DEFAULT');
    const clientOrderUid = req.body?.clientOrderUid
        ? String(req.body.clientOrderUid).trim().slice(0, 64)
        : khoaIdem || null;

    let idemLocked = false;
    if (dungIdem) {
        try {
            const lock = await acquireIdempotencyLock(pool, { tenantId: tId, khoaIdem, maNV, dauVanTay });
            if (!lock.acquired) {
                if (lock.state === 'KEY_REUSED') {
                    return res.status(422).json({ message: 'Idempotency-Key này đã được dùng cho đơn khác!', maLoi: 'IDEMPOTENCY_KEY_REUSED' });
                }
                if (lock.state === 'IN_FLIGHT') {
                    return res.status(409).json({
                        message: 'Đơn đang được xử lý (PROCESSING), vui lòng thử lại sau giây lát!',
                        maLoi: 'IDEMPOTENCY_IN_FLIGHT',
                        code: 'IDEMPOTENCY_IN_FLIGHT',
                    });
                }
                if (lock.state === 'DONE' && lock.record) {
                    if (lock.record.responseJson) {
                        return res.status(200).json({ ...lock.record.responseJson, trungLap: true });
                    }
                    const cached = await pool.withTenant(tId, async (client) => ({
                        hoaDon: await layHoaDonChiTiet(client, lock.record.maHoaDon),
                    }));
                    return res.status(200).json({
                        message: 'Thanh toán nhanh & chuyển pha chế thành công!',
                        maHoaDon: lock.record.maHoaDon,
                        hoaDon: cached.hoaDon,
                        trungLap: true,
                    });
                }
            }
            idemLocked = true;
        } catch (lockErr) {
            return guiLoi(res, lockErr, 'Lỗi khóa Idempotency (Quick Checkout):');
        }
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const laOfflineSync = req.get('X-Offline-Sync') === '1';
            const clockCheckQc = laOfflineSync ? detectOfflineClockDrift(req.body?.offlineCreatedAt) : { tampered: false };
            const caInfo = await layCaChoGiaoDichOffline(client, {
                tenantId: tId,
                maCaGoc: req.body?.maCaThuNganGoc || null,
                laOfflineSync,
            });
            const ca = caInfo.ca;
            const maCaGoc = caInfo.maCaGoc;

            const { maHoaDon, laHoaDonMoi, dsMaCTHD, dsMaCTHDFired, canhBaoTonThap, soldOutWarnings, countdownUpdates } = await taoOrderTrongGiaoDich(client, {
                tenantId: tId,
                branchId: resolvedBranchId,
                maNV,
                vaiTro: req.user.vaiTro,
                maBan,
                maKH,
                soTheRung,
                loaiDonHang: loaiDonHang || (maBan ? 'TAI_QUAN' : 'MANG_DI'),
                tenKhachVangLai,
                diaChiGiao,
                phiDongGoi,
                phiDongGoiMoiLy,
                cachTinhThue,
                thueVATPhanTram,
                phiPhucVuPhanTram,
                clientOrderUid,
                laOfflineSync,
                offlineCreatedAt: req.body?.offlineCreatedAt || null,
                choThanhToanTruoc: false,
                phuongThucDuKien: null,
                danhSachMon,
                combos,
                ip: req.ip,
                user: req.user,
                managerPin: req.body?.managerPin || null,
                maNVDuyet: req.body?.maNVDuyet || null,
            });

            // [P0 FIX] Lưu vết mã hóa đơn Offline (#OFF-HHMMSS) lên HoaDon
            const offlineClientId = req.body?.offlineClientId ? String(req.body.offlineClientId).trim().slice(0, 64) : null;
            if (offlineClientId) {
                await client.query('SAVEPOINT sp_qc_off_id');
                try {
                    await client.query(`UPDATE HoaDon SET MaOfflineClient = $2 WHERE MaHoaDon = $1`, [maHoaDon, offlineClientId]);
                    await client.query('RELEASE SAVEPOINT sp_qc_off_id');
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_qc_off_id').catch(() => {});
                }
            }

            // [Wave 1 — P0-03] Dùng chung ghiNhanThanhToanTrongGiaoDich để khóa FOR UPDATE & kiểm tra/trừ KhachHang.SoDuVi (chặn thanh toán 0đ qua Ví)
            const ttQc = await ghiNhanThanhToanTrongGiaoDich(client, {
                maHoaDon,
                expectedTenantId: tId,
                mandatoryVersion: false,
                ca,
                maNV,
                vaiTro: req.user.vaiTro,
                maKH: maKH || null,
                maKhuyenMai,
                diemSuDung,
                tuDongHappyHour: Boolean(tuDongHappyHour) && !clockCheckQc.tampered,
                autoFillSingleMethod: {
                    phuongThucTT,
                    tienKhachDua: tienKhachDua !== undefined && tienKhachDua !== null ? Number(tienKhachDua) : null,
                    nguonXacNhan: laOfflineSync ? 'POS_OFFLINE_SYNC' : 'POS_QUICK_CHECKOUT',
                },
                choPhepThuMotPhan: false,
                khoaIdem: dungIdem ? khoaIdem : null,
                laOfflineLechCa: Boolean(caInfo.lechCaDongBo),
                maCaThuNganGoc: caInfo.maCaGoc ? String(caInfo.maCaGoc) : null,
                branchId: normalizeBranchForShift(tId, branchId || ca.branchid),
                terminalId: normalizeTerminalId(req.body?.terminalId || ca.terminalid),
                ip: req.ip,
            });
            const tongTien = ttQc.tongTien;
            const tienThua = ttQc.tienThua;
            const diemCong = ttQc.diemCong || 0;
            const uuDai = ttQc.uuDai || {};

            if (laOfflineSync) {
                const clockCheck = detectOfflineClockDrift(req.body?.offlineCreatedAt);
                if (clockCheck.tampered) {
                    await ghiAuditLog(client, {
                        tenantId: tId,
                        maNV,
                        vaiTro: req.user.vaiTro,
                        hanhDong: 'OFFLINE_CLOCK_TAMPER_SUSPECTED',
                        doiTuong: 'HOADON',
                        maDoiTuong: maHoaDon,
                        giaTriMoi: {
                            offlineClientId,
                            offlineCreatedAt: req.body?.offlineCreatedAt,
                            serverNow: new Date().toISOString(),
                            driftMs: clockCheck.driftMs,
                            driftMinutes: clockCheck.driftMinutes,
                        },
                        lyDo: `Thiết bị đồng bộ Offline lệch đồng hồ ${clockCheck.driftMinutes} phút (> 10 phút) — từ chối tự động Happy Hour`,
                        ip: req.ip,
                        batBuoc: true,
                    });
                    if (typeof dispatchFraudAlertFromAudit === 'function') {
                        void dispatchFraudAlertFromAudit(pool, {
                            tenantId: tId,
                            hanhDong: 'OFFLINE_CLOCK_TAMPER_SUSPECTED',
                            maNV,
                            maDoiTuong: maHoaDon,
                            giaTriMoi: { driftMinutes: clockCheck.driftMinutes, offlineCreatedAt: req.body?.offlineCreatedAt },
                            lyDo: `⏰ Nghi vấn chỉnh đồng hồ thiết bị Offline (lệch ${clockCheck.driftMinutes} phút) trên HĐ #${maHoaDon}!`,
                        }).catch(() => {});
                    }
                }
                await ghiAuditLog(client, {
                    tenantId: tId,
                    maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'OFFLINE_ORDER_SYNCED',
                    doiTuong: 'HOADON',
                    maDoiTuong: maHoaDon,
                    giaTriMoi: {
                        khoaIdem,
                        offlineClientId,
                        offlineCreatedAt: req.body?.offlineCreatedAt || null,
                        maCaThuNganGoc: maCaGoc,
                        maCaHachToan: ca.macathungan,
                        lechCaDongBo: caInfo.lechCaDongBo,
                        caGocDaDong: caInfo.caGocDaDong,
                        ghiChuLechCa: caInfo.ghiChuLechCa,
                        soldOutWarnings,
                    },
                    lyDo: offlineClientId
                        ? `Đồng bộ Quick Checkout Offline ${offlineClientId}${caInfo.ghiChuLechCa ? ` (${caInfo.ghiChuLechCa})` : ''}`
                        : `Đồng bộ từ hàng đợi Offline Outbox Queue${caInfo.ghiChuLechCa ? ` (${caInfo.ghiChuLechCa})` : ''}`,
                    ip: req.ip,
                });
            }

            const monMoi = await layMonTheoMa(client, dsMaCTHDFired);
            const hoaDon = await layHoaDonChiTiet(client, maHoaDon);
            const kdsEmitPlan =
                monMoi.length > 0
                    ? await recordAndEmitOrderNewByStation(client, io, {
                          tenantId: tId,
                          branchId: resolvedBranchId,
                          maHoaDon,
                          maBan: maBan || null,
                          tenBan: monMoi[0]?.tenBan || null,
                          mangDi: !maBan,
                          themMon: false,
                          dotGoi: 1,
                          clientOrderUid,
                          monMoiFired: monMoi,
                      })
                    : null;

            return {
                trungLap: false,
                maHoaDon,
                laHoaDonMoi,
                dsMaCTHD,
                hoaDon,
                monMoi,
                tienThua,
                diemCong,
                canhBaoTonThap,
                soldOutWarnings,
                countdownUpdates,
                kdsEmitPlan,
            };
        }, tId);

        const qcResponse = {
            message: 'Thanh toán nhanh & chuyển pha chế thành công!',
            maHoaDon: ketQua.hoaDon?.maHoaDon || null,
            branchId: resolvedBranchId,
            clientOrderUid,
            hoaDon: ketQua.hoaDon,
            tienThua: ketQua.tienThua,
            diemCong: ketQua.diemCong,
            canhBaoTonThap: ketQua.canhBaoTonThap,
            soldOutWarnings: ketQua.soldOutWarnings,
            countdownUpdates: ketQua.countdownUpdates,
            trungLap: false,
        };

        if (idemLocked) {
            await completeIdempotencyLock(pool, {
                tenantId: tId,
                khoaIdem,
                maHoaDon: ketQua.maHoaDon,
                laHoaDonMoi: ketQua.laHoaDonMoi,
                dsMaCTHD: ketQua.dsMaCTHD,
                responseJson: qcResponse,
                httpStatus: 201,
            });
        }

        if (ketQua.kdsEmitPlan && typeof ketQua.kdsEmitPlan.flush === 'function') {
            ketQua.kdsEmitPlan.flush();
        }
        if (Array.isArray(ketQua.countdownUpdates) && ketQua.countdownUpdates.length > 0) {
            for (const cd of ketQua.countdownUpdates) {
                emitToBranch(io, {
                    tenantId: tId,
                    branchId: resolvedBranchId,
                    roles: ['POS', 'WAITER', 'KDS', 'EXPO'],
                    event: 'THUC_DON_THAY_DOI',
                    payload: cd,
                });
                emitToBranch(io, {
                    tenantId: tId,
                    branchId: resolvedBranchId,
                    roles: ['POS', 'WAITER', 'KDS'],
                    event: 'menu:86_updated',
                    payload: { type: 'COUNTDOWN', product: cd },
                });
            }
        }
        emitToBranch(io, {
            tenantId: tId,
            branchId: resolvedBranchId,
            roles: ['POS'],
            event: 'HOADON_DA_TT',
            payload: { maHoaDon: ketQua.hoaDon.maHoaDon },
        });
        void kiemTraCanhBaoTanSuatGianLan(pool, {
            tenantId: tId,
            maCaThuNgan: ketQua.hoaDon?.maCaThuNgan || null,
            maNV,
            vaiTro: req.user.vaiTro,
            maKH: maKH || null,
            phuongThucTT,
            coGiamGia: Number(ketQua.hoaDon?.tongGiamGia || 0) > 0,
            maHoaDon: ketQua.hoaDon?.maHoaDon,
            ghiAuditLog,
            ip: req.ip,
        });

        res.status(201).json(qcResponse);
    } catch (error) {
        if (idemLocked) {
            await failIdempotencyLock(pool, { tenantId: tId, khoaIdem });
        }
        guiLoi(res, error, 'Lỗi API Thanh toán nhanh:');
    }
});

// [P0] Danh sách tất cả hóa đơn đang mở (chưa thanh toán) — chống đơn Mang đi mồ côi
app.get('/api/hoadon/dangmo', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const r = await qTenant(req, `
            SELECT hd.MaHoaDon, hd.SoThuTuNgay, hd.ThoiGianTao, hd.MaKH,
                   COALESCE(to_jsonb(kh)->>'tenkh', to_jsonb(kh)->>'hoten') AS TenKH,
                   (SELECT string_agg(b.TenBan, ', ' ORDER BY b.TenBan)
                      FROM HoaDon_Ban hb JOIN Ban b ON b.MaBan = hb.MaBan
                     WHERE hb.MaHoaDon = hd.MaHoaDon) AS TenBan,
                   COALESCE((SELECT SUM(c.SoLuong)
                               FROM ChiTietHoaDon c
                              WHERE c.MaHoaDon = hd.MaHoaDon AND c.TrangThaiPhaChe <> 'DaHuy'), 0) AS TongLy,
                   COALESCE((SELECT SUM(c.SoLuong * c.DonGia - COALESCE(c.GiaGiam, 0))
                               FROM ChiTietHoaDon c
                              WHERE c.MaHoaDon = hd.MaHoaDon AND c.TrangThaiPhaChe <> 'DaHuy'), 0)
                   + COALESCE((SELECT SUM(tp.SoLuong * tp.DonGia)
                                 FROM ChiTietHoaDon c2 JOIN ChiTietHoaDon_Topping tp ON tp.MaCTHD = c2.MaCTHD
                                WHERE c2.MaHoaDon = hd.MaHoaDon AND c2.TrangThaiPhaChe <> 'DaHuy'), 0) AS TongTamTinh
              FROM HoaDon hd
              LEFT JOIN KhachHang kh ON kh.MaKH = hd.MaKH
             WHERE hd.TrangThaiTT = 0 AND COALESCE(hd.TenantId, 'DEFAULT') = $1
             ORDER BY hd.ThoiGianTao DESC
             LIMIT 100
        `, [tenantId]);
        res.json(r.rows.map((row) => ({
            maHoaDon: row.mahoadon,
            soThuTuNgay: row.sothutungay ? Number(row.sothutungay) : null,
            thoiGianTao: row.thoigiantao,
            tenBan: row.tenban || null,
            mangDi: !row.tenban,
            tenKH: row.tenkh || null,
            tongLy: Number(row.tongly || 0),
            tongTamTinh: Number(row.tongtamtinh || 0),
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Hóa đơn đang mở:');
    }
});

// [P0] Lịch sử hóa đơn đã thanh toán / hoàn tiền trong ngày (phục vụ Đổi món / Hoàn tiền sau thanh toán)
app.get('/api/hoadon/lichsu', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    const isManager = Number(req.user?.vaiTro) === 1;
    const ngay = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.ngay || '')) ? req.query.ngay : ngayHomNayVN();
    try {
        const [r, openShiftRes] = await Promise.all([
            qTenant(req, `
                SELECT hd.MaHoaDon, hd.SoThuTuNgay, hd.TrangThaiTT, hd.PhuongThucTT, hd.TongTienThanhToan,
                       hd.ThoiGianTao, hd.ThoiGianThanhToan, hd.MaCaThuNgan,
                       COALESCE(to_jsonb(kh)->>'tenkh', to_jsonb(kh)->>'hoten') AS TenKH,
                       (SELECT string_agg(b.TenBan, ', ' ORDER BY b.TenBan)
                          FROM HoaDon_Ban hb JOIN Ban b ON b.MaBan = hb.MaBan
                         WHERE hb.MaHoaDon = hd.MaHoaDon) AS TenBan,
                       COALESCE((SELECT SUM(c.SoLuong) FROM ChiTietHoaDon c WHERE c.MaHoaDon = hd.MaHoaDon), 0) AS TongLy
                  FROM HoaDon hd
                  LEFT JOIN KhachHang kh ON kh.MaKH = hd.MaKH
                 WHERE COALESCE(hd.TenantId, 'DEFAULT') = $1
                   AND hd.TrangThaiTT IN (1, 2)
                   AND COALESCE(hd.ThoiGianThanhToan, hd.ThoiGianTao) >= ($2::timestamp AT TIME ZONE '${VN_TZ}')
                   AND COALESCE(hd.ThoiGianThanhToan, hd.ThoiGianTao) < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
                 ORDER BY COALESCE(hd.ThoiGianThanhToan, hd.ThoiGianTao) DESC
                 LIMIT 50
            `, [tenantId, ngay]),
            isManager
                ? Promise.resolve({ rows: [] })
                : qTenant(
                      req,
                      `SELECT MaCaThuNgan FROM CaThuNgan WHERE COALESCE(TenantId, 'DEFAULT') = $1 AND TrangThaiCa = 1`,
                      [tenantId]
                  ),
        ]);
        const openShiftIds = new Set(openShiftRes.rows.map((s) => String(s.macathungan)));
        res.json(r.rows.map((row) => {
            // [Wave 1 — P0-07] Bịt rò rỉ Blind Drop: ẩn số tiền đơn TIỀN MẶT thuộc ca đang mở đối với vai trò Thu ngân
            const isMaskedCash =
                !isManager &&
                row.macathungan !== null &&
                openShiftIds.has(String(row.macathungan)) &&
                String(row.phuongthuctt || '').toUpperCase() === 'TIEN_MAT';
            return {
                maHoaDon: row.mahoadon,
                soThuTuNgay: row.sothutungay ? Number(row.sothutungay) : null,
                trangThaiTT: row.trangthaitt,
                daHoanTien: row.trangthaitt === 2,
                phuongThucTT: row.phuongthuctt,
                tongTienThanhToan: isMaskedCash ? null : Number(row.tongtienthanhtoan || 0),
                blindDropMasked: isMaskedCash,
                thoiGianTao: row.thoigiantao,
                thoiGianThanhToan: row.thoigianthanhtoan,
                maCaThuNgan: row.macathungan || null,
                tenBan: row.tenban || null,
                mangDi: !row.tenban,
                tenKH: row.tenkh || null,
                tongLy: Number(row.tongly || 0),
            };
        }));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lịch sử hóa đơn:');
    }
});


// [P0 + Phân hệ 1 100/100] Hủy món: Waste vs Return Stock + Manager PIN + Phá vỡ Combo + Tự động kiểm định lại KM + Optimistic Locking
app.post('/api/order/huy-mon', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
    const { maCTHD, lyDo, hoanKho = true, managerPin = null, maNVDuyet = null, expectedVersion = null } = req.body || {};
    const tenantId = layTenantId(req);
    if (!maCTHD) return res.status(400).json({ message: 'Thiếu mã chi tiết hóa đơn (maCTHD)!' });
    if (!lyDo || String(lyDo).trim().length < 3) {
        return res.status(400).json({ message: 'Vui lòng nhập lý do hủy món (tối thiểu 3 ký tự)!' });
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const cRes = await client.query(
                `SELECT c.MaCTHD, c.MaHoaDon, c.MaMon, c.KichThuoc, c.SoLuong, c.DonGia, c.TrangThaiPhaChe,
                        COALESCE(c.GiaVonSnapshot, 0) AS GiaVonSnapshot,
                        to_jsonb(c)->>'combogroupuid' AS ComboGroupUid,
                        sp.TenMon, sp.NhomMon, to_jsonb(sp)->>'tramchebien' AS TramCheBien,
                        COALESCE((to_jsonb(sp)->>'lahangdonggoi')::boolean, FALSE) AS LaHangDongGoi,
                        hd.TrangThaiTT, COALESCE(hd.DaInTamTinh, FALSE) AS DaInTamTinh,
                        COALESCE(NULLIF(to_jsonb(hd)->>'branchid', ''), 'DEFAULT') AS BranchId
                   FROM ChiTietHoaDon c
                   JOIN HoaDon hd ON hd.MaHoaDon = c.MaHoaDon
                   JOIN SanPham sp ON sp.MaMon = c.MaMon
                  WHERE c.MaCTHD = $1
                    AND COALESCE(hd.TenantId, 'DEFAULT') = $2
                  FOR UPDATE OF c, hd`,
                [maCTHD, tenantId]
            );
            if (cRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy món cần hủy!');
            const item = cRes.rows[0];
            if (item.trangthaiphache === 'DaHuy') throw new LoiNghiepVu(409, 'Món này đã được hủy trước đó!');
            if (item.trangthaitt === 1) throw new LoiNghiepVu(409, 'Hóa đơn đã thanh toán, vui lòng dùng chức năng Hoàn tiền sau thanh toán!');
            if (item.trangthaitt === 2) throw new LoiNghiepVu(409, 'Hóa đơn này đã được hoàn tiền!');

            await kiemTraVaTangVersionHoaDon(client, {
                maHoaDon: item.mahoadon,
                tenantId,
                expectedVersion,
                layHoaDonChiTiet,
                LoiNghiepVu,
            });

            const daPhaChe = item.trangthaiphache !== 'ChoPhaChe';
            const tuDuQuyenDuyet = coQuyenHan(req.user, 'order.item.void_approve');
            let nguoiDuyet = tuDuQuyenDuyet ? req.user.maNV : null;

            // Chống gian lận Pre-bill Scam & Hủy món đã pha: chỉ Quản lý / Ca trưởng được phân quyền HOẶC nhập đúng PIN O(1)
            if ((daPhaChe || item.daintamtinh) && !tuDuQuyenDuyet) {
                const mgr = managerPin
                    ? await xacThucPinQuanLy(client, tenantId, managerPin, req.ip, maNVDuyet, 'order.item.void_approve')
                    : null;
                if (!mgr) {
                    throw new LoiNghiepVu(
                        403,
                        managerPin
                            ? 'Mã PIN Quản lý / Ca trưởng không chính xác hoặc chưa được thiết lập!'
                            : item.daintamtinh
                            ? 'Hóa đơn đã in tạm tính! Cần nhập mã PIN Quản lý / Ca trưởng để phê duyệt hủy món.'
                            : 'Món đã nhận pha chế/hoàn thành! Cần nhập mã PIN Quản lý / Ca trưởng để xác nhận hủy hao hụt.',
                        { maLoi: 'CAN_PIN_QUAN_LY' }
                    );
                }
                nguoiDuyet = mgr.maNV;
            }

            // Tính định lượng nguyên liệu của dòng món (dùng để hoàn kho nếu chưa pha HOẶC lập phiếu hao hụt LoaiGD=8 nếu đã pha)
            const tieuHaoMon = new Map();
            await congDinhLuongNguyenLieuDongMon(
                client,
                tenantId,
                { maCTHD, maMon: item.mamon, kichThuoc: item.kichthuoc, soLuong: item.soluong },
                tieuHaoMon
            );

            const daPhucVu = item.trangthaiphache === 'DaPhucVu';
            // Cấm tuyệt đối hoàn kho món đã phục vụ (DaPhucVu) kể cả là hàng đóng gói (laHangDongGoi = true)
            const thucHienHoanKho = !daPhucVu && (!daPhaChe || Boolean(item.lahangdonggoi)) && Boolean(hoanKho);
            const trangThaiHuy = thucHienHoanKho ? 'CANCELLED_BEFORE_PREP' : 'WASTED_AFTER_PREP';
            const hdBrRes = await client.query(
                `SELECT COALESCE(NULLIF(NULLIF(to_jsonb(hd)->>'branchid', ''), 'DEFAULT'), $2::text || '_MAIN') AS branchid
                   FROM HoaDon hd WHERE hd.MaHoaDon = $1`,
                [item.mahoadon, tenantId]
            );
            const voidBranchId = normalizeInventoryBranch(tenantId, hdBrRes.rows[0]?.branchid);
            const caMoVoid = await layCaDangMo(client, 'SHARE', tenantId, { branchId: voidBranchId });
            const { stockMap: voidStockMap } =
                tieuHaoMon.size > 0
                    ? await lockBranchStockOrdered(client, tenantId, voidBranchId, [...tieuHaoMon.keys()])
                    : { stockMap: new Map() };
            const giaVonVoidMap = new Map([...voidStockMap.entries()].map(([k, v]) => [k, v.giaVonDonVi]));

            if (thucHienHoanKho && tieuHaoMon.size > 0) {
                const phieu = await client.query(
                    `INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan, NgayChungTu, TrangThaiDuyet)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::date, 'POSTED') RETURNING MaGiaoDich`,
                    [
                        req.user.maNV,
                        LOAI_GD_HOAN_KHO,
                        `Hoàn kho hủy món HĐ ${item.mahoadon}: ${String(lyDo).trim()}`,
                        tenantId,
                        voidBranchId,
                        caMoVoid ? String(caMoVoid.macathungan) : null,
                        todayDateVN(),
                    ]
                );
                const maGD = phieu.rows[0].magiaodich;
                for (const [maNL, sl] of [...tieuHaoMon].sort((a, b) => a[0].localeCompare(b[0]))) {
                    const st = voidStockMap.get(maNL);
                    if (!st) continue;
                    const qty = lam3(sl);
                    const tonTruoc = st.soLuongTon;
                    const tonSau = lam3(tonTruoc + qty);
                    await insertLedgerLine(client, {
                        maGiaoDich: maGD,
                        maNL,
                        soLuong: qty,
                        donGiaNhap: st.giaVonDonVi,
                        tinhTrang: 'Hoàn kho hủy món',
                        tonTruoc,
                        tonSau,
                        giaVonTruoc: st.giaVonDonVi,
                        giaVonSau: st.giaVonDonVi,
                    });
                    await updateBranchStockRow(client, { tenantId, branchId: voidBranchId, maNL, nextQty: tonSau });
                }
            } else if (!thucHienHoanKho && tieuHaoMon.size > 0) {
                const phieuWaste = await client.query(
                    `INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan, MaLyDoHuy, NgayChungTu, TrangThaiDuyet)
                     VALUES ($1, $2, $3, $4, $5, $6, 'CUSTOMER_REMAKE', $7::date, 'POSTED') RETURNING MaGiaoDich`,
                    [
                        req.user.maNV,
                        LOAI_GD_HAO_HUT_HUY_MON,
                        `Hao hụt hủy món đã pha HĐ ${item.mahoadon}: ${String(lyDo).trim()}`,
                        tenantId,
                        voidBranchId,
                        caMoVoid ? String(caMoVoid.macathungan) : null,
                        todayDateVN(),
                    ]
                );
                const maGDW = phieuWaste.rows[0].magiaodich;
                for (const [maNL, sl] of [...tieuHaoMon].sort((a, b) => a[0].localeCompare(b[0]))) {
                    const st = voidStockMap.get(maNL);
                    await insertLedgerLine(client, {
                        maGiaoDich: maGDW,
                        maNL,
                        soLuong: lam3(sl),
                        donGiaNhap: st?.giaVonDonVi || 0,
                        tinhTrang: 'Hao hụt - hủy món đã pha',
                        tonTruoc: st?.soLuongTon ?? null,
                        tonSau: st?.soLuongTon ?? null,
                        giaVonTruoc: st?.giaVonDonVi ?? null,
                        giaVonSau: st?.giaVonDonVi ?? null,
                    });
                }
            }

            await client.query(
                `UPDATE ChiTietHoaDon
                    SET TrangThaiPhaChe = 'DaHuy',
                        trang_thai_huy = $3,
                        LyDoHuy = $2
                  WHERE MaCTHD = $1`,
                [maCTHD, String(lyDo).trim().slice(0, 255), trangThaiHuy]
            );

            // Luật 2 Combo: Nếu hủy 1 món con trong Combo -> Phá vỡ Combo, chuyển các món còn lại về giá bán lẻ niêm yết + Audit Log!
            let comboBreakInfo = { comboBroken: false, updatedSiblings: [] };
            if (item.combogroupuid) {
                comboBreakInfo = await phaVoComboKhiHuyMon(client, {
                    tenantId,
                    maHoaDon: item.mahoadon,
                    comboGroupUid: item.combogroupuid,
                    maCTHDHuy: maCTHD,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    ip: req.ip,
                    ghiAuditLog,
                });
            }

            // Tự động kiểm định lại Khuyến mãi & Điểm Loyalty + Thuế/Phí ngay trong ACID transaction
            const recalc = await recalculateInvoiceTotals(client, {
                tenantId,
                maHoaDon: item.mahoadon,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                ip: req.ip,
                ghiAuditLog,
                kiemTraHopLeKhuyenMai,
            });

            // Kiểm tra: tổng tiền mới không được tụt thấp hơn số tiền khách đã thanh toán trước (Partial Payment)
            const hdPostVoid = await layHoaDonChiTiet(client, item.mahoadon);
            const daThanhToanMoi = Number(hdPostVoid?.daThanhToan || 0);
            const tongPhaiTraMoi = Number(recalc?.totals?.tongPhaiTra ?? hdPostVoid?.tongPhaiTra ?? 0);
            if (tongPhaiTraMoi < daThanhToanMoi) {
                throw new LoiNghiepVu(
                    409,
                    `Không thể hủy món vì tổng tiền còn lại (${tongPhaiTraMoi.toLocaleString('vi-VN')}đ) thấp hơn số tiền khách đã thanh toán (${daThanhToanMoi.toLocaleString('vi-VN')}đ)!`,
                    {
                        maLoi: 'VOID_EXCEEDS_UNPAID_BALANCE',
                        code: 'VOID_EXCEEDS_UNPAID_BALANCE',
                        tongPhaiTraMoi,
                        daThanhToan: daThanhToanMoi,
                    }
                );
            }

            // Chống Table Brick Deadlock: nếu số món hiệu lực về 0 và daThanhToan == 0 -> chuyển VOIDED + trả bàn trống + xoay QrToken!
            const activeCountRes = await client.query(
                `SELECT COUNT(*)::int AS cnt FROM ChiTietHoaDon WHERE MaHoaDon = $1 AND TrangThaiPhaChe <> 'DaHuy'`,
                [item.mahoadon]
            );
            const soMonHieuLuc = Number(activeCountRes.rows[0]?.cnt || 0);
            let autoVoidedOrder = false;
            let freedTables = [];
            if (soMonHieuLuc === 0 && daThanhToanMoi <= 0) {
                await client.query(
                    `UPDATE HoaDon SET lifecycle_status = 'VOIDED', TrangThaiTT = 0 WHERE MaHoaDon = $1`,
                    [item.mahoadon]
                );
                const banLinkRes = await client.query(
                    `SELECT MaBan FROM HoaDon_Ban WHERE MaHoaDon = $1`,
                    [item.mahoadon]
                );
                freedTables = banLinkRes.rows.map((r) => r.maban);
                await client.query(`DELETE FROM HoaDon_Ban WHERE MaHoaDon = $1`, [item.mahoadon]);
                if (freedTables.length > 0) {
                    await client.query(
                        `UPDATE Ban SET TrangThai = 1 WHERE MaBan = ANY($1::varchar[]) AND COALESCE(TenantId, 'DEFAULT') = $2`,
                        [freedTables, tenantId]
                    );
                    await xoayQrTokenChoCacBan(client, freedTables);
                }
                autoVoidedOrder = true;
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                nguoiDuyet,
                hanhDong: thucHienHoanKho ? 'ITEM_VOID_RETURN_STOCK' : 'ITEM_VOID_WASTE',
                doiTuong: 'CHITIETHOADON',
                maDoiTuong: maCTHD,
                giaTriCu: { maHoaDon: item.mahoadon, maMon: item.mamon, soLuong: item.soluong, trangThaiPhaChe: item.trangthaiphache, giaVonHaoHut: Number(item.giavonsnapshot) * Number(item.soluong) },
                giaTriMoi: { trangThaiPhaChe: 'DaHuy', hoanKho: thucHienHoanKho, comboBroken: comboBreakInfo.comboBroken, promoAdjusted: recalc.promoAdjusted },
                lyDo: String(lyDo).trim(),
                ip: req.ip,
                batBuoc: true,
            });

            const stationVoid = suyLuanTramCheBien({
                tramCheBien: item.tramchebien,
                nhomMon: item.nhommon,
                tenMon: item.tenmon,
            });
            const branchIdVoid = normalizeBranchId(item.branchid || 'DEFAULT');
            const voidPayload = {
                maCTHD,
                maHoaDon: item.mahoadon,
                maMon: item.mamon,
                tenMon: item.tenmon,
                soLuong: item.soluong,
                trangThaiCu: item.trangthaiphache,
                hoanKho: thucHienHoanKho,
                lyDo: String(lyDo).trim(),
                requiresAck: true,
            };
            const logVoid = await insertKdsEventLog(client, {
                tenantId,
                branchId: branchIdVoid,
                station: stationVoid,
                eventType: 'ITEM_VOID',
                maHoaDon: item.mahoadon,
                payload: voidPayload,
            });

            return {
                maHoaDon: item.mahoadon,
                hoanKho: thucHienHoanKho,
                trangThaiHuy,
                autoVoidedOrder,
                freedTables,
                comboBroken: comboBreakInfo.comboBroken,
                promoAdjusted: recalc.promoAdjusted,
                promoAdjustReasons: recalc.promoAdjustReasons,
                branchId: branchIdVoid,
                station: stationVoid,
                seq: logVoid.seq,
                voidPayload,
                hoaDon: await layHoaDonChiTiet(client, item.mahoadon),
            };
        }, tenantId);

        emitScopedKdsEvent(io, {
            tenantId,
            branchId: ketQua.branchId,
            station: ketQua.station,
            seq: ketQua.seq,
            eventType: 'ITEM_VOID',
            socketEvents: ['kds:item_voided', 'MON_BI_HUY'],
            payload: ketQua.voidPayload,
            includeExpo: true,
            includeWaiter: true,
            includePos: true,
            legacyBaristaEvent: 'kds:item_voided',
            legacyWaiterEvent: 'MON_BI_HUY',
            legacyPosEvent: 'MON_BI_HUY',
        });
        if (ketQua.autoVoidedOrder) {
            emitToBranch(io, {
                tenantId,
                branchId: ketQua.branchId,
                roles: ['POS', 'WAITER'],
                event: 'BAN_THAY_DOI',
                payload: {
                    loai: 'ORDER_AUTO_VOIDED',
                    maHoaDon: ketQua.maHoaDon,
                    freedTables: ketQua.freedTables || [],
                },
            });
        }

        res.json({
            message: ketQua.hoanKho ? 'Đã hủy món và hoàn trả nguyên liệu vào kho!' : 'Đã hủy món và ghi nhận phiếu hao hụt pha chế!',
            ...ketQua,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Hủy món:');
    }
});

// [L2.2] Đổi món (/api/order/:maHoaDon/doi-mon & /api/order/item-swap) đã được hợp nhất về modules/kdsPhase2Routes.js (emit 3 tầng + kds_event_log + FOR UPDATE).

// [P0/P1] Hoàn tiền sau thanh toán: Hỗ trợ cả Hoàn toàn bộ hóa đơn & Hoàn tiền một phần từng món (dsMaCTHDHoan)
app.post('/api/order/:maHoaDon/hoan-tien', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
    const { maHoaDon } = req.params;
    const {
        lyDo,
        phuongThucHoan = 'TIEN_MAT',
        hoanKho = false,
        managerPin = null,
        maNVDuyet = null,
        dsMaCTHDHoan = null,
    } = req.body || {};
    const tenantId = layTenantId(req);

    if (!lyDo || String(lyDo).trim().length < 3) {
        return res.status(400).json({ message: 'Vui lòng nhập lý do hoàn tiền / hủy đơn sau thanh toán (tối thiểu 3 ký tự)!' });
    }
    if (!PHUONG_THUC_TT.includes(phuongThucHoan)) {
        return res.status(400).json({ message: `phuongThucHoan phải thuộc: ${PHUONG_THUC_TT.join(', ')}` });
    }
    const cleanLyDo = String(lyDo).trim().slice(0, 255);
    const partialIdsSet =
        Array.isArray(dsMaCTHDHoan) && dsMaCTHDHoan.length > 0
            ? new Set(dsMaCTHDHoan.map((id) => String(id)))
            : null;

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const ca = await layCaDangMo(client, 'SHARE', tenantId);
            if (!ca) throw loiChuaMoCa();

            const tuDuQuyenHoan = coQuyenHan(req.user, 'order.refund.approve');
            let nguoiDuyet = tuDuQuyenHoan ? req.user.maNV : null;
            if (!tuDuQuyenHoan) {
                const mgr = managerPin
                    ? await xacThucPinQuanLy(client, tenantId, managerPin, req.ip, maNVDuyet, 'order.refund.approve')
                    : null;
                if (!mgr) {
                    throw new LoiNghiepVu(
                        403,
                        managerPin
                            ? 'Mã PIN Quản lý / Ca trưởng không chính xác hoặc chưa được thiết lập!'
                            : 'Hoàn tiền sau thanh toán bắt buộc phải có mã PIN Quản lý / Ca trưởng phê duyệt!',
                        { maLoi: 'CAN_PIN_QUAN_LY' }
                    );
                }
                nguoiDuyet = mgr.maNV;
            }

            let hdRes;
            await client.query('SAVEPOINT sp_refund_hd_sel');
            try {
                hdRes = await client.query(
                    `SELECT MaHoaDon, TrangThaiTT, TongTienThanhToan, MaKH, PhuongThucTT, MaCaThuNgan,
                            MaKhuyenMai, COALESCE(TienGiamKM, 0) AS TienGiamKM,
                            COALESCE(DiemSuDung, 0) AS DiemSuDung, COALESCE(TienGiamDiem, 0) AS TienGiamDiem
                       FROM HoaDon
                      WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                      FOR UPDATE`,
                    [maHoaDon, tenantId]
                );
                await client.query('RELEASE SAVEPOINT sp_refund_hd_sel');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_refund_hd_sel').catch(() => {});
                hdRes = await client.query(
                    `SELECT MaHoaDon, TrangThaiTT, TongTienThanhToan, MaKH, PhuongThucTT
                       FROM HoaDon
                      WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                      FOR UPDATE`,
                    [maHoaDon, tenantId]
                );
            }
            if (hdRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn!');
            const hd = hdRes.rows[0];
            if (hd.trangthaitt === 0) {
                throw new LoiNghiepVu(409, 'Hóa đơn chưa thanh toán, vui lòng hủy trực tiếp từng món trên đơn!');
            }
            if (hd.trangthaitt === 2) {
                throw new LoiNghiepVu(409, 'Hóa đơn này đã được hoàn tiền toàn bộ trước đó!');
            }

            const itemsRes = await client.query(
                `SELECT c.MaCTHD, c.MaMon, c.KichThuoc, c.SoLuong, c.DonGia, COALESCE(c.GiaGiam, 0) AS GiaGiam,
                        COALESCE((
                            SELECT SUM(ctp.SoLuong * ctp.DonGia)
                              FROM ChiTietHoaDon_Topping ctp
                             WHERE ctp.MaCTHD = c.MaCTHD
                        ), 0) AS TienTopping
                   FROM ChiTietHoaDon c
                  WHERE c.MaHoaDon = $1 AND c.TrangThaiPhaChe <> 'DaHuy'
                  FOR UPDATE OF c`,
                [maHoaDon]
            );
            const activeItems = itemsRes.rows.map((r) => ({
                ...r,
                thanhTien:
                    Number(r.soluong) * Number(r.dongia) -
                    Number(r.giagiam || 0) +
                    Number(r.tientopping || 0),
            }));
            if (activeItems.length === 0) {
                throw new LoiNghiepVu(409, 'Hóa đơn này không còn món hợp lệ nào để hoàn tiền!');
            }

            const targetItems = partialIdsSet
                ? activeItems.filter((r) => partialIdsSet.has(String(r.macthd)))
                : activeItems;
            if (targetItems.length === 0) {
                throw new LoiNghiepVu(400, 'Không tìm thấy dòng món hợp lệ cần hoàn trong dsMaCTHDHoan!');
            }
            const laHoanMotPhan = targetItems.length < activeItems.length;

            // [P0 FIX] Hoàn đúng số tiền khách thực thanh toán (hoặc phân bổ đúng tỷ lệ cho các món hoàn 1 phần)
            let soTienConCoTheHoan = Math.max(0, Number(hd.tongtienthanhtoan || 0));
            const diemHoanTra = laHoanMotPhan ? 0 : Math.max(0, Number(hd.diemsudung || 0));
            const maKmDaDung = laHoanMotPhan ? null : hd.makhuyenmai || null;

            if (runtimeFlags.paymentsSanSang && soTienConCoTheHoan === 0 && diemHoanTra === 0 && !laHoanMotPhan) {
                const paidRes = await client.query(
                    `SELECT COALESCE(SUM(CASE WHEN TrangThai = 'REFUNDED' THEN -SoTien ELSE SoTien END), 0) AS TongConLai
                       FROM Order_Payments
                      WHERE MaHoaDon = $1::text AND TrangThai IN ('PAID', 'REFUNDED')`,
                    [String(maHoaDon)]
                );
                soTienConCoTheHoan = Math.max(0, Number(paidRes.rows[0]?.tongconlai || 0));
            }

            let tongHoan = soTienConCoTheHoan;
            if (laHoanMotPhan) {
                const tongTamTinhConLai = activeItems.reduce((s, r) => s + r.thanhTien, 0);
                const tongTamTinhMonHoan = targetItems.reduce((s, r) => s + r.thanhTien, 0);
                if (tongTamTinhConLai <= soTienConCoTheHoan) {
                    tongHoan = Math.min(soTienConCoTheHoan, tongTamTinhMonHoan);
                } else if (tongTamTinhConLai > 0) {
                    tongHoan = Math.min(
                        soTienConCoTheHoan,
                        Math.round((soTienConCoTheHoan * tongTamTinhMonHoan) / tongTamTinhConLai)
                    );
                }
            }

            if (!(tongHoan > 0) && !(diemHoanTra > 0) && !maKmDaDung && !laHoanMotPhan) {
                throw new LoiNghiepVu(400, 'Hóa đơn không có giá trị tiền, điểm hoặc ưu đãi hợp lệ để hoàn!');
            }

            const khoaIdemRefund = docKhoaIdempotency(req) || null;
            let refundLedgerId = null;
            if (tongHoan > 0) {
                // [Phân hệ 3 - Immutable Order_Refunds] Ghi tách bạch vào Sổ cái Hoàn tiền Độc lập gắn đúng Ca thực hiện chi hoàn!
                // Tuyệt đối không sửa ngược Order_Payments hay ZReportSnapshot của Ca bán gốc!
                const rRef = await client.query(
                    `INSERT INTO public.order_refunds
                        (tenantid, branchid, terminalid, mahoadon, macathungan, macathunganbangoc,
                         phuongthuchoan, sotienhoan, danhsachmacthd, lydo, manv, manvthuchien, nguoiduyet, khoaidem)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::text, $12::varchar, $13, $14)
                     RETURNING id`,
                    [
                        tenantId,
                        normalizeBranchForShift(tenantId, ca.branchid),
                        normalizeTerminalId(ca.terminalid),
                        String(maHoaDon),
                        String(ca.macathungan),
                        hd.macathungan ? String(hd.macathungan) : null,
                        phuongThucHoan,
                        tongHoan,
                        JSON.stringify(laHoanMotPhan ? targetItems.map((i) => String(i.macthd)) : []),
                        cleanLyDo,
                        String(req.user.maNV),
                        String(req.user.maNV),
                        String(nguoiDuyet || req.user.maNV),
                        khoaIdemRefund,
                    ]
                );
                refundLedgerId = Number(rRef.rows[0].id);

                // Nếu hoàn tiền về Ví thành viên (VI_KHACH) -> cộng thẳng SoDuVi & ghi lịch sử ví
                if (phuongThucHoan === 'VI_KHACH' && hd.makh) {
                    const wRes = await client.query(
                        `UPDATE KhachHang SET SoDuVi = COALESCE(SoDuVi, 0) + $2
                          WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $3
                          RETURNING SoDuVi`,
                        [hd.makh, tongHoan, tenantId]
                    );
                    if (wRes.rows.length > 0) {
                        await client.query(
                            `INSERT INTO KhachHang_GiaoDichVi (TenantId, MaKH, LoaiGD, SoTien, SoDuSau, MaHoaDon, MaNV, GhiChu)
                             VALUES ($1, $2, 'REFUND_ORDER', $3, $4, $5, $6, $7)`,
                            [
                                tenantId,
                                hd.makh,
                                tongHoan,
                                Number(wRes.rows[0].soduvi),
                                maHoaDon,
                                req.user.maNV,
                                `Hoàn tiền vào ví HĐ ${maHoaDon}: ${cleanLyDo}`,
                            ]
                        );
                    }
                }
            }

            if (laHoanMotPhan) {
                const tongThanhToanConLai = Math.max(0, soTienConCoTheHoan - tongHoan);
                await client.query('SAVEPOINT sp_partial_ref_hd');
                try {
                    await client.query(
                        'UPDATE HoaDon SET TongTienThanhToan = $2, SoTienHoan = COALESCE(SoTienHoan, 0) + $3 WHERE MaHoaDon = $1',
                        [maHoaDon, tongThanhToanConLai, tongHoan]
                    );
                    await client.query('RELEASE SAVEPOINT sp_partial_ref_hd');
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_partial_ref_hd').catch(() => {});
                    await client.query(
                        'UPDATE HoaDon SET TongTienThanhToan = $2 WHERE MaHoaDon = $1',
                        [maHoaDon, tongThanhToanConLai]
                    );
                }
            } else {
                await client.query('UPDATE HoaDon SET TrangThaiTT = 2 WHERE MaHoaDon = $1', [maHoaDon]);
            }

            const tieuHaoMon = new Map();
            for (const row of targetItems) {
                await congDinhLuongNguyenLieuDongMon(
                    client,
                    tenantId,
                    { maCTHD: row.macthd, maMon: row.mamon, kichThuoc: row.kichthuoc, soLuong: row.soluong },
                    tieuHaoMon
                );
            }

            const thucHienHoanKho = Boolean(hoanKho);
            const giaVonRefundMap = await layMapGiaVonNguyenLieu(client, tenantId, [...tieuHaoMon.keys()]);
            const refundBranchId = normalizeInventoryBranch(
                tenantId,
                hd.branchid || ca?.branchid || req.user?.branchId || 'DEFAULT'
            );
            const maCaRefund = ca?.macathungan ? String(ca.macathungan) : null;
            if (thucHienHoanKho && tieuHaoMon.size > 0) {
                const dsNL = [...tieuHaoMon.keys()];
                const { branchId: lockedBranchId, stockMap } = await lockBranchStockOrdered(
                    client,
                    tenantId,
                    refundBranchId,
                    dsNL
                );
                const phieu = await client.query(
                    `INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan)
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING MaGiaoDich`,
                    [
                        req.user.maNV,
                        LOAI_GD_HOAN_KHO,
                        `Hoàn kho hoàn tiền HĐ ${maHoaDon}: ${cleanLyDo}`,
                        tenantId,
                        lockedBranchId,
                        maCaRefund,
                    ]
                );
                const maGD = phieu.rows[0].magiaodich;
                for (const [maNL, sl] of [...tieuHaoMon].sort((a, b) => a[0].localeCompare(b[0]))) {
                    const qty = lam3(sl);
                    const st = stockMap.get(maNL);
                    const tonTruoc = st ? st.soLuongTon : 0;
                    const tonSau = lam3(tonTruoc + qty);
                    const giaVon = st ? st.giaVonDonVi : giaVonRefundMap.get(maNL) || 0;
                    await insertLedgerLine(client, {
                        maGiaoDich: maGD,
                        maNL,
                        soLuong: qty,
                        donGiaNhap: giaVon,
                        tinhTrang: 'Hoàn kho sau hoàn tiền',
                        tonTruoc,
                        tonSau,
                        giaVonTruoc: giaVon,
                        giaVonSau: giaVon,
                    });
                    if (st) {
                        await updateBranchStockRow(client, {
                            tenantId,
                            branchId: lockedBranchId,
                            maNL,
                            nextQty: tonSau,
                            nextWac: giaVon,
                        });
                    }
                }
            } else if (!thucHienHoanKho && tieuHaoMon.size > 0) {
                const phieuWaste = await client.query(
                    `INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan)
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING MaGiaoDich`,
                    [
                        req.user.maNV,
                        LOAI_GD_HAO_HUT_HUY_MON,
                        `Hao hụt hoàn tiền HĐ ${maHoaDon}: ${cleanLyDo}`,
                        tenantId,
                        refundBranchId,
                        maCaRefund,
                    ]
                );
                const maGDW = phieuWaste.rows[0].magiaodich;
                for (const [maNL, sl] of [...tieuHaoMon].sort((a, b) => a[0].localeCompare(b[0]))) {
                    await client.query(
                        `INSERT INTO ChiTietGiaoDichKho (MaGiaoDich, MaNL, SoLuong, DonGiaNhap, TinhTrang)
                         VALUES ($1, $2, $3, $4, 'Hao hụt - hoàn tiền sau TT')`,
                        [maGDW, maNL, lam3(sl), giaVonRefundMap.get(maNL) || 0]
                    );
                }
            }

            const targetIds = targetItems.map((r) => String(r.macthd));
            await client.query(
                `UPDATE ChiTietHoaDon
                    SET TrangThaiPhaChe = 'DaHuy',
                        LyDoHuy = $2
                  WHERE MaHoaDon = $1 AND MaCTHD::text = ANY($3::text[])`,
                [
                    maHoaDon,
                    `[${laHoanMotPhan ? 'Hoàn tiền 1 phần' : 'Hoàn tiền'}] ${cleanLyDo}`.slice(0, 255),
                    targetIds,
                ]
            );

            let diemThuHoi = 0;
            if (hd.makh) {
                if (laHoanMotPhan) {
                    const diemCu = Math.floor(soTienConCoTheHoan / DIEM_MOI_VND);
                    const diemMoi = Math.floor(Math.max(0, soTienConCoTheHoan - tongHoan) / DIEM_MOI_VND);
                    diemThuHoi = Math.max(0, diemCu - diemMoi);
                } else if (tongHoan >= DIEM_MOI_VND) {
                    diemThuHoi = Math.floor(tongHoan / DIEM_MOI_VND);
                }
                const deltaDiem = diemHoanTra - diemThuHoi;
                if (deltaDiem !== 0) {
                    await client.query(
                        `UPDATE KhachHang
                            SET DiemTichLuy = GREATEST(0, COALESCE(DiemTichLuy, 0) + $1)
                          WHERE MaKH = $2 AND COALESCE(TenantId, 'DEFAULT') = $3`,
                        [deltaDiem, hd.makh, tenantId]
                    );
                }
            }

            if (maKmDaDung && !laHoanMotPhan) {
                await client.query('SAVEPOINT sp_refund_km_cnt');
                try {
                    await client.query(
                        `UPDATE KhuyenMai
                            SET SoLuotDaDung = GREATEST(0, COALESCE(SoLuotDaDung, 0) - 1)
                          WHERE TenantId = $1 AND UPPER(MaCode) = UPPER($2)`,
                        [tenantId, maKmDaDung]
                    );
                    await client.query('RELEASE SAVEPOINT sp_refund_km_cnt');
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_refund_km_cnt').catch(() => {});
                }
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                nguoiDuyet,
                hanhDong: laHoanMotPhan ? 'ORDER_PARTIAL_REFUND' : 'ORDER_POST_PAYMENT_REFUND',
                doiTuong: 'HOADON',
                maDoiTuong: maHoaDon,
                giaTriCu: {
                    tongTienThanhToan: soTienConCoTheHoan,
                    phuongThucTT: hd.phuongthuctt,
                    trangThaiTT: 1,
                    diemSuDung: diemHoanTra,
                    maKhuyenMai: maKmDaDung,
                },
                giaTriMoi: {
                    trangThaiTT: laHoanMotPhan ? 1 : 2,
                    laHoanMotPhan,
                    dsMaCTHDHoan: targetIds,
                    tongHoan,
                    phuongThucHoan,
                    hoanKho: thucHienHoanKho,
                    diemThuHoi,
                    diemHoanTra,
                },
                lyDo: cleanLyDo,
                ip: req.ip,
                batBuoc: true,
            });

            // [Wave 3A — P1-01] Nếu hóa đơn đã phát hành HĐĐT gốc (ISSUED), tự sinh HĐĐT điều chỉnh giảm (Credit Note) vào hàng đợi QUEUED
            let einvoiceAdjustment = null;
            await client.query('SAVEPOINT sp_refund_einvoice_adj');
            try {
                einvoiceAdjustment = await createAdjustmentDecreaseOnRefund(client, {
                    tenantId,
                    branchId: normalizeBranchForShift(tenantId, ca.branchid),
                    maHoaDon,
                    refundAmount: tongHoan,
                    reason: cleanLyDo,
                });
                await client.query('RELEASE SAVEPOINT sp_refund_einvoice_adj');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_refund_einvoice_adj').catch(() => {});
            }

            return {
                maHoaDon,
                branchId: normalizeBranchId(ca?.branchid || req.user?.branchId || 'DEFAULT'),
                laHoanMotPhan,
                soMonHoan: targetItems.length,
                tongHoan,
                phuongThucHoan,
                hoanKho: thucHienHoanKho,
                diemThuHoi,
                einvoiceAdjustmentId: einvoiceAdjustment ? einvoiceAdjustment.id : null,
            };
        }, tenantId);

        emitToBranch(io, {
            tenantId,
            branchId: ketQua.branchId,
            roles: ['POS', 'WAITER', 'KDS', 'EXPO'],
            event: 'HOADON_DA_HOAN',
            payload: {
                maHoaDon: ketQua.maHoaDon,
                laHoanMotPhan: ketQua.laHoanMotPhan,
                tongHoan: ketQua.tongHoan,
                phuongThucHoan: ketQua.phuongThucHoan,
            },
        });
        emitToBranch(io, {
            tenantId,
            branchId: ketQua.branchId,
            roles: ['POS'],
            event: 'CA_THAY_DOI',
            payload: { trangThai: 'CAP_NHAT' },
        });

        res.json({
            message: ketQua.laHoanMotPhan
                ? `Đã hoàn tiền 1 phần (${ketQua.soMonHoan} món — ${ketQua.tongHoan.toLocaleString('vi-VN')}đ qua ${ketQua.phuongThucHoan}) cho hóa đơn #${maHoaDon}!`
                : `Đã hoàn tiền ${ketQua.tongHoan.toLocaleString('vi-VN')}đ (${ketQua.phuongThucHoan}) cho hóa đơn #${maHoaDon}!`,
            ...ketQua,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Hoàn tiền sau thanh toán:');
    }
});

// [L3.4] Ghi nhận lượt in hóa đơn (/api/hoadon/:maHoaDon/in & /api/order/:maHoaDon/print-token) đã được hợp nhất về modules/kdsPhase2Routes.js (bắt buộc RBAC/PIN khi in lại lần 2+).

// [Phân hệ 1 - 100/100] Chuyển bàn chống Deadlock + Di chuyển PhienTinhGio & DonQrChoDuyet + Xoay QrToken + Chuyển bàn cũ sang 3=Chờ dọn + Emit kds:table_moved
app.post('/api/ban/chuyen', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const { fromMaBan, toMaBan, forceClean = false } = req.body || {};
    const tenantId = layTenantId(req);
    if (!fromMaBan || !toMaBan || fromMaBan === toMaBan) {
        return res.status(400).json({ message: 'Vui lòng chọn 2 bàn khác nhau để chuyển!' });
    }
    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const dsLock = [fromMaBan, toMaBan].sort();
            const banRes = await client.query(
                `SELECT MaBan, TenBan, TrangThai, to_jsonb(Ban)->>'qrtoken' AS QrToken
                   FROM Ban
                  WHERE MaBan = ANY($1::varchar[]) AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2
                  ORDER BY MaBan ASC FOR UPDATE`,
                [dsLock, tenantId]
            );
            const banCu = banRes.rows.find((b) => b.maban === fromMaBan);
            const banMoi = banRes.rows.find((b) => b.maban === toMaBan);
            if (!banCu || !banMoi) throw new LoiNghiepVu(404, 'Không tìm thấy bàn nguồn hoặc bàn đích!');

            const maHoaDon = await layHoaDonMoCuaBan(client, fromMaBan, true);
            if (!maHoaDon) throw new LoiNghiepVu(409, `${banCu.tenban} hiện không có hóa đơn đang mở!`);

            const hdBanMoi = await layHoaDonMoCuaBan(client, toMaBan, true);
            if (hdBanMoi || Number(banMoi.trangthai) === 2) {
                throw new LoiNghiepVu(409, `${banMoi.tenban} đang có khách! Đề xuất chuyển sang chức năng Gộp bàn.`, {
                    maLoi: 'DEST_TABLE_OCCUPIED',
                    suggestMerge: true,
                    destMaHoaDon: hdBanMoi,
                });
            }
            if (Number(banMoi.trangthai) === 3 && !forceClean) {
                throw new LoiNghiepVu(409, `${banMoi.tenban} đang ở trạng thái Chờ dọn! Xác nhận forceClean để nhận khách ngay.`, {
                    maLoi: 'DEST_TABLE_CLEANING',
                });
            }

            await client.query(
                'UPDATE HoaDon_Ban SET MaBan = $1 WHERE MaHoaDon = $2 AND MaBan = $3',
                [toMaBan, maHoaDon, fromMaBan]
            );

            // Chuyển phụ thuộc: PhienTinhGio (Bida/Boardgame) & DonQrChoDuyet sang bàn đích
            await client.query('SAVEPOINT sp_move_deps');
            try {
                await client.query(
                    `UPDATE phientinhgio SET maban = $1
                      WHERE tenantid = $2 AND maban = $3 AND trangthai IN ('RUNNING', 'PAUSED')`,
                    [toMaBan, tenantId, fromMaBan]
                );
                await client.query(
                    `UPDATE donqrchoduyet SET maban = $1, tenban = $2
                      WHERE tenantid = $3 AND maban = $4 AND trangthai = 'PENDING_APPROVAL'`,
                    [toMaBan, banMoi.tenban, tenantId, fromMaBan]
                );
                await client.query('RELEASE SAVEPOINT sp_move_deps');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_move_deps').catch(() => {});
            }

            // Đặt bàn cũ sang 3 = Chờ dọn & xoay mới QrToken để khách bàn cũ không quét nhầm vào đơn đã chuyển
            await client.query('UPDATE Ban SET TrangThai = 3 WHERE MaBan = $1', [fromMaBan]);
            await client.query('UPDATE Ban SET TrangThai = 2 WHERE MaBan = $1', [toMaBan]);
            await xoayQrTokenChoCacBan(client, [fromMaBan]);

            const rotatedRes = await client.query(`SELECT to_jsonb(Ban)->>'qrtoken' AS QrToken FROM Ban WHERE MaBan = $1`, [fromMaBan]);
            const movedAt = new Date().toISOString();

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'TABLE_MOVE',
                doiTuong: 'BAN',
                maDoiTuong: maHoaDon,
                giaTriCu: { maBan: fromMaBan, tenBan: banCu.tenban, qrToken: banCu.qrtoken || null },
                giaTriMoi: { maBan: toMaBan, tenBan: banMoi.tenban, newFromQrToken: rotatedRes.rows[0]?.qrtoken || null, fromTrangThai: 3 },
                ip: req.ip,
            });

            const hdBrRes = await client.query(
                `SELECT COALESCE(NULLIF(to_jsonb(HoaDon)->>'branchid', ''), 'DEFAULT') AS BranchId FROM HoaDon WHERE MaHoaDon = $1`,
                [maHoaDon]
            );
            const branchIdMove = normalizeBranchId(hdBrRes.rows[0]?.branchid || 'DEFAULT');
            const movePayload = {
                maHoaDon,
                fromMaBan,
                toMaBan,
                fromTenBan: banCu.tenban,
                toTenBan: banMoi.tenban,
                movedAt,
            };
            const logMove = await insertKdsEventLog(client, {
                tenantId,
                branchId: branchIdMove,
                station: 'ALL',
                eventType: 'TABLE_MOVE',
                maHoaDon,
                payload: movePayload,
            });

            return {
                maHoaDon,
                branchId: branchIdMove,
                seq: logMove.seq,
                fromMaBan,
                toMaBan,
                tenBanCu: banCu.tenban,
                tenBanMoi: banMoi.tenban,
                fromTenBan: banCu.tenban,
                toTenBan: banMoi.tenban,
                fromTrangThai: 3,
                newFromQrToken: rotatedRes.rows[0]?.qrtoken || null,
                movedAt,
            };
        }, tenantId);

        emitToBranch(io, {
            tenantId,
            branchId: ketQua.branchId,
            roles: ['POS', 'WAITER'],
            event: 'BAN_THAY_DOI',
            payload: { maBan: fromMaBan, trangThai: 3 },
        });
        emitToBranch(io, {
            tenantId,
            branchId: ketQua.branchId,
            roles: ['POS', 'WAITER'],
            event: 'BAN_THAY_DOI',
            payload: { maBan: toMaBan, trangThai: 2 },
        });
        emitToBranch(io, {
            tenantId,
            branchId: ketQua.branchId,
            roles: ['POS', 'WAITER', 'KDS', 'EXPO'],
            event: 'BAN_CHUYEN',
            payload: ketQua,
        });
        emitScopedKdsEvent(io, {
            tenantId,
            branchId: ketQua.branchId,
            station: 'ALL',
            seq: ketQua.seq,
            eventType: 'TABLE_MOVE',
            socketEvents: ['kds:table_moved'],
            payload: {
                maHoaDon: ketQua.maHoaDon,
                fromMaBan: ketQua.fromMaBan,
                toMaBan: ketQua.toMaBan,
                fromTenBan: ketQua.fromTenBan,
                toTenBan: ketQua.toTenBan,
                movedAt: ketQua.movedAt,
            },
            includeExpo: true,
            includeWaiter: true,
            includePos: true,
            legacyBaristaEvent: 'kds:table_moved',
            legacyWaiterEvent: 'kds:table_moved',
            legacyPosEvent: 'kds:table_moved',
        });

        res.json({ message: `Đã chuyển từ ${ketQua.tenBanCu} sang ${ketQua.tenBanMoi}!`, ...ketQua });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Chuyển bàn:');
    }
});

// [Phân hệ 1 - 100/100] Gộp bàn (đủ cả 2 TH: Ghép thêm bàn trống mở rộng chỗ & Gộp 2 hóa đơn giữ trọn Order_Payments/PhienTinhGio, TrangThaiTT=3 MERGED!)
app.post('/api/ban/gop', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const { fromMaBan, toMaBan, expectedVersion = null, keepTable = false } = req.body || {};
    const tenantId = layTenantId(req);
    if (!fromMaBan || !toMaBan || fromMaBan === toMaBan) {
        return res.status(400).json({ message: 'Vui lòng chọn 2 bàn khác nhau để gộp!' });
    }
    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const dsLock = [fromMaBan, toMaBan].sort();
            const banRes = await client.query(
                `SELECT MaBan, TenBan, TrangThai FROM Ban
                  WHERE MaBan = ANY($1::varchar[]) AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2
                  ORDER BY MaBan ASC FOR UPDATE`,
                [dsLock, tenantId]
            );
            const banCu = banRes.rows.find((b) => b.maban === fromMaBan);
            const banDich = banRes.rows.find((b) => b.maban === toMaBan);
            if (!banCu || !banDich) throw new LoiNghiepVu(404, 'Không tìm thấy bàn nguồn hoặc bàn đích!');

            const hdNguon = await layHoaDonMoCuaBan(client, fromMaBan, false);
            const hdDich = await layHoaDonMoCuaBan(client, toMaBan, false);
            if (!hdNguon) throw new LoiNghiepVu(409, `${banCu.tenban} không có hóa đơn đang mở để gộp!`);

            // TRƯỜNG HỢP A: Bàn đích đang trống -> Ghép thêm bàn trống mở rộng chỗ ngồi cho hóa đơn hiện tại!
            if (!hdDich) {
                await client.query(`SELECT MaHoaDon FROM HoaDon WHERE MaHoaDon = $1 FOR UPDATE`, [hdNguon]);
                await client.query(
                    `INSERT INTO HoaDon_Ban (MaHoaDon, MaBan) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                    [hdNguon, toMaBan]
                );
                await client.query(`UPDATE Ban SET TrangThai = 2 WHERE MaBan = $1`, [toMaBan]);
                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'TABLE_EXPAND_SEATING',
                    doiTuong: 'HOADON',
                    maDoiTuong: hdNguon,
                    giaTriMoi: { fromMaBan, addedMaBan: toMaBan, tenBanThem: banDich.tenban },
                    ip: req.ip,
                });
                return {
                    mode: 'EXPAND_EMPTY_TABLE',
                    hdNguon,
                    hdDich: hdNguon,
                    fromMaBan,
                    toMaBan,
                    tenBanCu: banCu.tenban,
                    tenBanDich: banDich.tenban,
                    hoaDon: await layHoaDonChiTiet(client, hdNguon),
                };
            }

            if (String(hdNguon) === String(hdDich)) throw new LoiNghiepVu(409, 'Hai bàn này đã nằm chung một hóa đơn!');

            // TRƯỜNG HỢP B: Cả 2 bàn đều có hóa đơn chưa thanh toán -> Khóa theo ORDER BY MaHoaDon ASC FOR UPDATE chống Deadlock!
            const orderedIds = [String(hdNguon), String(hdDich)].sort();
            const lockedMergeRes = await client.query(
                `SELECT MaHoaDon, COALESCE(DaInTamTinh, FALSE) AS daintamtinh
                   FROM HoaDon
                  WHERE MaHoaDon::text = ANY($1::text[])
                  ORDER BY MaHoaDon ASC
                  FOR UPDATE`,
                [orderedIds]
            );
            const preservedDaInTamTinh = lockedMergeRes.rows.some((r) => Boolean(r.daintamtinh));

            await kiemTraVaTangVersionHoaDon(client, {
                maHoaDon: hdDich,
                tenantId,
                expectedVersion,
                layHoaDonChiTiet,
                LoiNghiepVu,
            });

            // Chuyển toàn bộ ChiTietHoaDon, HoaDon_Ban (không trùng), Order_Payments (giữ nguyên thanh toán 1 phần!), HoaDon_ChiaTien, PhienTinhGio & DonQrChoDuyet
            await client.query('UPDATE ChiTietHoaDon SET MaHoaDon = $1 WHERE MaHoaDon = $2', [hdDich, hdNguon]);
            if (runtimeFlags.paymentsSanSang) {
                await client.query('UPDATE Order_Payments SET MaHoaDon = $1 WHERE MaHoaDon = $2', [String(hdDich), String(hdNguon)]);
            }
            await client.query('SAVEPOINT sp_merge_deps');
            try {
                await client.query(`UPDATE hoadon_chiatien SET mahoadon = $1 WHERE tenantid = $2 AND mahoadon = $3`, [
                    String(hdDich),
                    tenantId,
                    String(hdNguon),
                ]);
                await client.query(
                    `UPDATE phientinhgio SET mahoadon = $1, maban = $2 WHERE tenantid = $3 AND (mahoadon = $4 OR maban = $5) AND trangthai IN ('RUNNING', 'PAUSED')`,
                    [String(hdDich), toMaBan, tenantId, String(hdNguon), fromMaBan]
                );
                await client.query(
                    `UPDATE donqrchoduyet SET maban = $1, tenban = $2 WHERE tenantid = $3 AND maban = $4 AND trangthai = 'PENDING_APPROVAL'`,
                    [toMaBan, banDich.tenban, tenantId, fromMaBan]
                );
                await client.query('RELEASE SAVEPOINT sp_merge_deps');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_merge_deps').catch(() => {});
            }

            if (keepTable) {
                await client.query(
                    `INSERT INTO HoaDon_Ban (MaHoaDon, MaBan)
                     SELECT $1, MaBan FROM HoaDon_Ban WHERE MaHoaDon = $2
                     ON CONFLICT DO NOTHING`,
                    [hdDich, hdNguon]
                );
            }
            await client.query('DELETE FROM HoaDon_Ban WHERE MaHoaDon = $1', [hdNguon]);

            // CẤM XÓA CỨNG hdNguon: Chuyển TrangThaiTT = 3 & lifecycle_status = 'MERGED' + ghi vết MergedIntoMaHoaDon!
            await client.query(
                `UPDATE HoaDon
                    SET TrangThaiTT = 3,
                        lifecycle_status = 'MERGED',
                        MergedIntoMaHoaDon = $2
                  WHERE MaHoaDon = $1 AND TrangThaiTT = 0`,
                [hdNguon, String(hdDich)]
            );
            // Bịt lỗ hổng Pre-bill Scam: BẮT BUỘC bảo toàn DaInTamTinh = (h1.DaInTamTinh OR h2.DaInTamTinh)
            await client.query(`UPDATE HoaDon SET DaInTamTinh = $2 WHERE MaHoaDon = $1`, [hdDich, preservedDaInTamTinh]);

            if (!keepTable) {
                await client.query('UPDATE Ban SET TrangThai = 1 WHERE MaBan = $1', [fromMaBan]);
                await xoayQrTokenChoCacBan(client, [fromMaBan]);
            }

            // Tự động tính lại Khuyến mãi, Điểm Loyalty & Thuế/Phí trên hóa đơn đích
            const recalc = await recalculateInvoiceTotals(client, {
                tenantId,
                maHoaDon: hdDich,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                ip: req.ip,
                ghiAuditLog,
                kiemTraHopLeKhuyenMai,
            });

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'TABLE_MERGE',
                doiTuong: 'HOADON',
                maDoiTuong: hdDich,
                giaTriCu: { fromMaBan, tenBanCu: banCu.tenban, hdNguon },
                giaTriMoi: { toMaBan, tenBanDich: banDich.tenban, hdDich, keepTable, promoAdjusted: recalc.promoAdjusted },
                ip: req.ip,
                batBuoc: true,
            });

            const hdBrRes = await client.query(
                `SELECT COALESCE(NULLIF(to_jsonb(HoaDon)->>'branchid', ''), 'DEFAULT') AS BranchId FROM HoaDon WHERE MaHoaDon = $1`,
                [hdDich]
            );
            const branchIdMerge = normalizeBranchId(hdBrRes.rows[0]?.branchid || 'DEFAULT');
            const logMerge = await insertKdsEventLog(client, {
                tenantId,
                branchId: branchIdMerge,
                station: 'ALL',
                eventType: 'ORDER_MERGE',
                maHoaDon: hdDich,
                payload: {
                    hdNguon,
                    hdDich,
                    fromMaBan,
                    toMaBan,
                    fromTenBan: banCu.tenban,
                    toTenBan: banDich.tenban,
                    mergedAt: new Date().toISOString(),
                },
            });

            return {
                mode: 'MERGE_INVOICES',
                branchId: branchIdMerge,
                seq: logMerge.seq,
                hdNguon,
                hdDich,
                fromMaBan,
                toMaBan,
                tenBanCu: banCu.tenban,
                tenBanDich: banDich.tenban,
                promoAdjusted: recalc.promoAdjusted,
                hoaDon: await layHoaDonChiTiet(client, hdDich),
            };
        }, tenantId);

        const mergeBranchId = ketQua.branchId || ketQua.hoaDon?.branchId || req.user?.branchId || 'DEFAULT';
        if (ketQua.mode === 'EXPAND_EMPTY_TABLE') {
            emitToBranch(io, {
                tenantId,
                branchId: mergeBranchId,
                roles: ['POS', 'WAITER'],
                event: 'BAN_THAY_DOI',
                payload: { maBan: toMaBan, trangThai: 2 },
            });
        } else {
            if (!keepTable) {
                emitToBranch(io, {
                    tenantId,
                    branchId: mergeBranchId,
                    roles: ['POS', 'WAITER'],
                    event: 'BAN_THAY_DOI',
                    payload: { maBan: fromMaBan, trangThai: 1 },
                });
            }
            emitToBranch(io, {
                tenantId,
                branchId: mergeBranchId,
                roles: ['POS', 'WAITER', 'KDS', 'EXPO'],
                event: 'BAN_CHUYEN',
                payload: {
                    maHoaDon: ketQua.hdDich,
                    fromMaBan,
                    toMaBan,
                    tenBanCu: ketQua.tenBanCu,
                    tenBanMoi: ketQua.tenBanDich,
                },
            });
            emitScopedKdsEvent(io, {
                tenantId,
                branchId: ketQua.branchId,
                station: 'ALL',
                seq: ketQua.seq,
                eventType: 'ORDER_MERGE',
                socketEvents: ['kds:orders_merged'],
                payload: {
                    hdNguon: ketQua.hdNguon,
                    hdDich: ketQua.hdDich,
                    fromMaBan,
                    toMaBan,
                    fromTenBan: ketQua.tenBanCu,
                    toTenBan: ketQua.tenBanDich,
                    mergedAt: new Date().toISOString(),
                },
                includeExpo: true,
                includeWaiter: true,
                includePos: true,
                legacyBaristaEvent: 'kds:orders_merged',
                legacyWaiterEvent: 'kds:orders_merged',
                legacyPosEvent: 'kds:orders_merged',
            });
        }

        res.json({
            message:
                ketQua.mode === 'EXPAND_EMPTY_TABLE'
                    ? `Đã ghép thêm ${ketQua.tenBanDich} vào ${ketQua.tenBanCu} (HĐ #${ketQua.hdDich})!`
                    : `Đã gộp ${ketQua.tenBanCu} vào ${ketQua.tenBanDich} (HĐ #${ketQua.hdDich})!`,
            ...ketQua,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Gộp bàn:');
    }
});

// [P1] Cập nhật trạng thái vận hành bàn: 1 = Trống sẵn sàng, 3 = Chờ dọn (CHO_DON), 4 = Đã đặt trước
app.put('/api/ban/:maBan/trangthai', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const { maBan } = req.params;
    const trangThai = Number(req.body?.trangThai);
    const tenantId = layTenantId(req);

    if (![1, 3, 4].includes(trangThai)) {
        return res.status(400).json({ message: 'trangThai bàn hợp lệ phải là 1 (Trống), 3 (Chờ dọn) hoặc 4 (Đặt trước)!' });
    }

    try {
        const ban = await chayGiaoDich(async (client) => {
            const bRes = await client.query(
                `SELECT MaBan, TenBan, TrangThai FROM Ban
                  WHERE MaBan = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2
                  FOR UPDATE`,
                [maBan, tenantId]
            );
            if (bRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy bàn!');
            const hdMo = await layHoaDonMoCuaBan(client, maBan, false);
            if (hdMo) {
                throw new LoiNghiepVu(
                    409,
                    `${bRes.rows[0].tenban} đang có hóa đơn chưa thanh toán (#${hdMo}), không thể đổi trạng thái bàn!`,
                    { code: 'BAN_DANG_CO_KHACH', maHoaDon: hdMo }
                );
            }
            const upd = await client.query(
                `UPDATE Ban SET TrangThai = $2
                  WHERE MaBan = $1 AND COALESCE(TenantId, 'DEFAULT') = $3
                  RETURNING MaBan, TenBan, TrangThai, COALESCE(NULLIF(to_jsonb(Ban)->>'branchid', ''), 'DEFAULT') AS BranchId`,
                [maBan, trangThai, tenantId]
            );
            return upd.rows[0];
        }, tenantId);

        emitToBranch(io, {
            tenantId,
            branchId: ban.branchid || req.user?.branchId || 'DEFAULT',
            roles: ['POS', 'WAITER'],
            event: 'BAN_THAY_DOI',
            payload: {
                maBan: ban.maban,
                trangThai: Number(ban.trangthai),
            },
        });

        const nhan = trangThai === 3 ? '🧹 Chờ dọn' : trangThai === 4 ? '📅 Đã đặt trước' : '✨ Trống sẵn sàng';
        res.json({
            message: `Đã chuyển ${ban.tenban} sang trạng thái "${nhan}"!`,
            ban: { maBan: ban.maban, tenBan: ban.tenban, trangThai: Number(ban.trangthai) },
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Đổi trạng thái bàn:');
    }
});

// [Phân hệ 1 - 100/100] Tách hóa đơn đủ 3 kiểu:
//   1. BY_ITEM / NEW_INVOICE / TRANSFER_TO_TABLE (Tách theo món/số lượng lẻ, giữ nguyên SoLuongMoiLy & ModifiersSnapshot)
//   2. SPLIT_EQUAL (Chia đều N người theo bội số 1.000đ vào HoaDon_ChiaTien — KHÔNG vỡ ChiTietHoaDon!)
//   3. SPLIT_AMOUNT (Chia theo số tiền tùy ý vào HoaDon_ChiaTien — kiểm tra tổng khớp tuyệt đối!)
async function handleSplitOrder(req, res) {
    const { maHoaDon } = req.params;
    const {
        dsMaCTHD = [],
        splitItems = [],
        toMaBan = null,
        mode = 'NEW_INVOICE', // 'BY_ITEM' | 'NEW_INVOICE' | 'TRANSFER_TO_TABLE' | 'SPLIT_EQUAL' | 'SPLIT_AMOUNT'
        soNguoi = null,
        shares = [],
        expectedVersion = null,
    } = req.body || {};
    const tenantId = layTenantId(req);
    const modeNorm = String(mode || 'NEW_INVOICE').toUpperCase();

    // ----- KIỂU 2 (SPLIT_EQUAL) & KIỂU 3 (SPLIT_AMOUNT) -> GHI VÀO HoaDon_ChiaTien -----
    if (modeNorm === 'SPLIT_EQUAL' || modeNorm === 'SPLIT_AMOUNT') {
        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const hdRes = await client.query(
                    `SELECT MaHoaDon, TrangThaiTT FROM HoaDon
                      WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2 FOR UPDATE`,
                    [maHoaDon, tenantId]
                );
                if (hdRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn gốc!');
                if (hdRes.rows[0].trangthaitt !== 0) throw new LoiNghiepVu(409, 'Chỉ có thể chia tiền cho hóa đơn đang mở!');

                await kiemTraVaTangVersionHoaDon(client, {
                    maHoaDon,
                    tenantId,
                    expectedVersion,
                    layHoaDonChiTiet,
                    LoiNghiepVu,
                });

                const detail = await layHoaDonChiTiet(client, maHoaDon);
                const conLai = Math.round(Number(detail.conLaiCanThu || 0));
                if (conLai <= 0) {
                    throw new LoiNghiepVu(400, 'Hóa đơn không còn số tiền cần thu để chia!');
                }

                // Kiểm tra không có phần chia cũ nào đã PAID mà chưa dọn
                const existingPaid = await client.query(
                    `SELECT 1 FROM hoadon_chiatien
                      WHERE tenantid = $1 AND mahoadon = $2::text AND trangthai = 'PAID' LIMIT 1`,
                    [tenantId, String(maHoaDon)]
                );
                if (existingPaid.rows.length > 0) {
                    throw new LoiNghiepVu(409, 'Hóa đơn đã có phần chia tiền được thanh toán, không thể chia lại!');
                }
                await client.query(
                    `UPDATE hoadon_chiatien SET trangthai = 'CANCELLED'
                      WHERE tenantid = $1 AND mahoadon = $2::text AND trangthai = 'UNPAID'`,
                    [tenantId, String(maHoaDon)]
                );

                let rowsToInsert = [];
                if (modeNorm === 'SPLIT_EQUAL') {
                    const n = Math.floor(Number(soNguoi || 0));
                    if (n < 2 || n > 50) {
                        throw new LoiNghiepVu(400, 'Số người chia đều (soNguoi) phải từ 2 đến 50!');
                    }
                    const amounts = chiaDeuTienVND(conLai, n);
                    rowsToInsert = amounts.map((amt, idx) => ({
                        nhan: `Phần ${idx + 1}/${n}`,
                        soTien: amt,
                    }));
                } else {
                    if (!Array.isArray(shares) || shares.length < 2) {
                        throw new LoiNghiepVu(400, 'Vui lòng nhập tối thiểu 2 phần chia (shares: [{ nhan, soTien }])!');
                    }
                    let sum = 0;
                    for (let idx = 0; idx < shares.length; idx += 1) {
                        const s = shares[idx];
                        const amt = Math.round(Number(s?.soTien || 0));
                        if (!(amt > 0)) {
                            throw new LoiNghiepVu(400, `Số tiền của phần chia thứ ${idx + 1} phải > 0!`);
                        }
                        sum += amt;
                        rowsToInsert.push({
                            nhan: String(s?.nhan || `Phần ${idx + 1}`).trim().slice(0, 40),
                            soTien: amt,
                        });
                    }
                    if (Math.abs(sum - conLai) > 0) {
                        throw new LoiNghiepVu(
                            400,
                            `Tổng các phần chia (${sum.toLocaleString('vi-VN')}đ) không khớp số tiền còn phải thu (${conLai.toLocaleString('vi-VN')}đ)!`
                        );
                    }
                }

                const inserted = [];
                for (const r of rowsToInsert) {
                    const ins = await client.query(
                        `INSERT INTO hoadon_chiatien (tenantid, mahoadon, nhanchia, sotienphaitra, sotiendatra, trangthai)
                         VALUES ($1, $2::text, $3, $4, 0, 'UNPAID')
                         RETURNING id, nhanchia, sotienphaitra, sotiendatra, trangthai, thoigiantao`,
                        [tenantId, String(maHoaDon), r.nhan, r.soTien]
                    );
                    inserted.push({
                        id: Number(ins.rows[0].id),
                        nhanChia: ins.rows[0].nhanchia,
                        soTienPhaiTra: Number(ins.rows[0].sotienphaitra),
                        soTienDaTra: 0,
                        trangThai: ins.rows[0].trangthai,
                        thoiGianTao: ins.rows[0].thoigiantao,
                    });
                }

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: modeNorm === 'SPLIT_EQUAL' ? 'ORDER_SPLIT_EQUAL' : 'ORDER_SPLIT_AMOUNT',
                    doiTuong: 'HOADON',
                    maDoiTuong: maHoaDon,
                    giaTriMoi: { mode: modeNorm, conLai, shares: inserted },
                    ip: req.ip,
                });

                return {
                    mode: modeNorm,
                    maHoaDon,
                    conLai,
                    danhSachChiaTien: inserted,
                    hoaDon: await layHoaDonChiTiet(client, maHoaDon),
                };
            }, tenantId);

            return res.status(201).json({
                message:
                    modeNorm === 'SPLIT_EQUAL'
                        ? `➗ Đã chia đều hóa đơn #${maHoaDon} thành ${ketQua.danhSachChiaTien.length} phần!`
                        : `💵 Đã chia hóa đơn #${maHoaDon} theo ${ketQua.danhSachChiaTien.length} mức tiền tùy ý!`,
                ...ketQua,
            });
        } catch (error) {
            return guiLoi(res, error, 'Lỗi API Chia tiền hóa đơn:');
        }
    }

    // ----- KIỂU 1: TÁCH THEO MÓN / SỐ LƯỢNG LẺ (BY_ITEM | NEW_INVOICE | TRANSFER_TO_TABLE) -----
    const reqMap = new Map();
    if (Array.isArray(splitItems) && splitItems.length > 0) {
        for (const it of splitItems) {
            const id = String(it?.maCTHD ?? '').trim();
            const sl = it?.soLuong !== undefined && it?.soLuong !== null ? Math.floor(Number(it.soLuong)) : null;
            if (!id) continue;
            if (sl !== null && !(sl >= 1)) {
                return res.status(400).json({ message: 'Số lượng tách của từng món phải >= 1!' });
            }
            reqMap.set(id, sl);
        }
    } else if (Array.isArray(dsMaCTHD) && dsMaCTHD.length > 0) {
        for (const rawId of dsMaCTHD) {
            const id = String(rawId ?? '').trim();
            if (id) reqMap.set(id, null);
        }
    }

    if (reqMap.size === 0) {
        return res.status(400).json({ message: 'Vui lòng chọn ít nhất 1 món để tách hóa đơn!' });
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const hdRes = await client.query(
                `SELECT MaHoaDon, TrangThaiTT, MaKH, COALESCE(DaInTamTinh, FALSE) AS DaInTamTinh
                   FROM HoaDon
                  WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2 FOR UPDATE`,
                [maHoaDon, tenantId]
            );
            if (hdRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn gốc!');
            if (hdRes.rows[0].trangthaitt !== 0) throw new LoiNghiepVu(409, 'Hóa đơn không ở trạng thái mở, không thể tách!');

            await kiemTraVaTangVersionHoaDon(client, {
                maHoaDon,
                tenantId,
                expectedVersion,
                layHoaDonChiTiet,
                LoiNghiepVu,
            });

            const daInTamTinhGoc = Boolean(hdRes.rows[0].daintamtinh);

            const itemsRes = await client.query(
                `SELECT MaCTHD, MaMon, TenMonSnapshot, KichThuoc, SoLuong, DonGia,
                        COALESCE(GiaGiam, 0) AS GiaGiam, COALESCE(GiaVonSnapshot, 0) AS GiaVonSnapshot,
                        COALESCE((to_jsonb(ChiTietHoaDon)->>'giamodifiers')::numeric, 0) AS GiaModifiers,
                        COALESCE((to_jsonb(ChiTietHoaDon)->'modifierssnapshot')::jsonb, '[]'::jsonb) AS ModifiersSnapshot,
                        COALESCE((to_jsonb(ChiTietHoaDon)->>'chietkhaumon')::numeric, 0) AS ChietKhauMon,
                        COALESCE((to_jsonb(ChiTietHoaDon)->>'lamontang')::boolean, FALSE) AS LaMonTang,
                        to_jsonb(ChiTietHoaDon)->>'lydotang' AS LyDoTang,
                        COALESCE((to_jsonb(ChiTietHoaDon)->>'dotgoi')::int, 1) AS DotGoi,
                        COALESCE((to_jsonb(ChiTietHoaDon)->>'istakeaway')::boolean, FALSE) AS IsTakeaway,
                        COALESCE((to_jsonb(ChiTietHoaDon)->>'courseno')::int, 1) AS CourseNo,
                        COALESCE(to_jsonb(ChiTietHoaDon)->>'firestatus', 'FIRED') AS FireStatus,
                        to_jsonb(ChiTietHoaDon)->>'firedat' AS FiredAt,
                        to_jsonb(ChiTietHoaDon)->>'combogroupuid' AS ComboGroupUid,
                        GhiChu, TrangThaiPhaChe, ThoiGianGoi
                   FROM ChiTietHoaDon
                  WHERE MaHoaDon = $1 AND TrangThaiPhaChe <> 'DaHuy'
                  ORDER BY MaCTHD
                  FOR UPDATE`,
                [maHoaDon]
            );

            let tongLyGoc = 0;
            let tongLyTach = 0;
            const plan = [];

            for (const row of itemsRes.rows) {
                const idStr = String(row.macthd);
                const origQty = Math.max(1, Number(row.soluong || 1));
                tongLyGoc += origQty;
                if (!reqMap.has(idStr)) continue;
                const reqQty = reqMap.get(idStr);
                const qtyToMove = reqQty === null ? origQty : Math.min(origQty, reqQty);
                if (qtyToMove <= 0) continue;
                tongLyTach += qtyToMove;
                plan.push({
                    row,
                    origQty,
                    qtyToMove,
                    isPartial: qtyToMove < origQty,
                });
            }

            if (plan.length === 0) throw new LoiNghiepVu(400, 'Không có món hợp lệ nào để tách!');

            // Chặn lách luật phá Combo qua tách đơn: nếu tách bất kỳ món con nào trong Combo, phải tách trọn bộ tất cả món cùng combogroupuid và không tách lẻ số lượng
            const touchedComboGroups = new Set(
                plan.map((p) => p.row.combogroupuid).filter((uid) => uid && String(uid).trim() !== '')
            );
            for (const comboUid of touchedComboGroups) {
                const allComboRows = itemsRes.rows.filter((r) => r.combogroupuid === comboUid);
                const planComboRows = plan.filter((p) => p.row.combogroupuid === comboUid);
                const hasPartialQty = planComboRows.some((p) => p.isPartial);
                if (hasPartialQty || planComboRows.length !== allComboRows.length) {
                    throw new LoiNghiepVu(
                        409,
                        'Không thể tách lẻ từng món trong cùng một Combo! Vui lòng tách trọn bộ tất cả món thuộc Combo đó.',
                        { maLoi: 'CANNOT_SPLIT_COMBO_PARTIAL', code: 'CANNOT_SPLIT_COMBO_PARTIAL', comboGroupUid: comboUid }
                    );
                }
            }

            if (tongLyTach >= tongLyGoc) {
                throw new LoiNghiepVu(
                    400,
                    'Phải giữ lại ít nhất 1 ly trên hóa đơn gốc khi tách! (Nếu muốn chuyển cả bàn, hãy dùng Chuyển bàn hoặc Chuyển món).'
                );
            }

            let maHoaDonMoi = null;
            let laChuyenGhepBan = false;

            if (toMaBan) {
                const b = await client.query(
                    "SELECT MaBan, TenBan FROM Ban WHERE MaBan = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2 FOR UPDATE",
                    [toMaBan, tenantId]
                );
                if (b.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy bàn đích!');
                const existHdDich = await layHoaDonMoCuaBan(client, toMaBan, true);
                if (existHdDich) {
                    if (String(existHdDich) === String(maHoaDon)) {
                        throw new LoiNghiepVu(409, 'Bàn đích chính là bàn của hóa đơn hiện tại!');
                    }
                    if (modeNorm !== 'TRANSFER_TO_TABLE') {
                        throw new LoiNghiepVu(
                            409,
                            'Bàn đích đang có khách! Hãy bật chế độ "Chuyển ghép món sang bàn đang mở" hoặc chọn bàn trống.'
                        );
                    }
                    if (daInTamTinhGoc) {
                        await client.query('UPDATE HoaDon SET DaInTamTinh = TRUE WHERE MaHoaDon = $1', [existHdDich]);
                    }
                    maHoaDonMoi = existHdDich;
                    laChuyenGhepBan = true;
                }
            }

            if (!maHoaDonMoi) {
                const { seq: sttMoi, soThuTuHienThi } = await capSoThuTuNgayKhongTrung(client, tenantId);
                let newHdRes;
                await client.query('SAVEPOINT sp_ins_split_hd_v23');
                try {
                    newHdRes = await client.query(
                        `INSERT INTO HoaDon (MaNV, TrangThaiTT, DaInTamTinh, TenantId, SoThuTuNgay, SoThuTuHienThi, ParentMaHoaDon, LoaiDonHang)
                         VALUES ($1, 0, $2, $3, $4, $5, $6, $7) RETURNING MaHoaDon`,
                        [req.user.maNV, daInTamTinhGoc, tenantId, sttMoi, soThuTuHienThi, String(maHoaDon), toMaBan ? 'TAI_QUAN' : 'MANG_DI']
                    );
                    await client.query('RELEASE SAVEPOINT sp_ins_split_hd_v23');
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_ins_split_hd_v23').catch(() => {});
                    newHdRes = await client.query(
                        'INSERT INTO HoaDon (MaNV, TrangThaiTT, DaInTamTinh, TenantId, SoThuTuNgay) VALUES ($1, 0, $2, $3, $4) RETURNING MaHoaDon',
                        [req.user.maNV, daInTamTinhGoc, tenantId, sttMoi]
                    );
                }
                maHoaDonMoi = newHdRes.rows[0].mahoadon;

                if (toMaBan) {
                    await client.query('INSERT INTO HoaDon_Ban (MaHoaDon, MaBan) VALUES ($1, $2)', [maHoaDonMoi, toMaBan]);
                    await client.query('UPDATE Ban SET TrangThai = 2 WHERE MaBan = $1', [toMaBan]);
                } else if (modeNorm === 'BY_ITEM') {
                    // Kiểu 1 BY_ITEM không đổi bàn: gắn hóa đơn con vào cùng bàn gốc (không chiếm bàn mới!)
                    await client.query(
                        `INSERT INTO HoaDon_Ban (MaHoaDon, MaBan)
                         SELECT $1, MaBan FROM HoaDon_Ban WHERE MaHoaDon = $2
                         ON CONFLICT DO NOTHING`,
                        [maHoaDonMoi, maHoaDon]
                    );
                }
            }

            // Thực hiện di chuyển nguyên dòng hoặc tách 1 phần số lượng — GIỮ NGUYÊN SoLuongMoiLy & ModifiersSnapshot!
            for (const item of plan) {
                const r = item.row;
                if (!item.isPartial) {
                    await client.query(
                        'UPDATE ChiTietHoaDon SET MaHoaDon = $1 WHERE MaHoaDon = $2 AND MaCTHD = $3',
                        [maHoaDonMoi, maHoaDon, r.macthd]
                    );
                } else {
                    const remainQty = item.origQty - item.qtyToMove;
                    const origDiscount = Number(r.giagiam || 0);
                    const splitDiscount = Math.round((origDiscount * item.qtyToMove) / item.origQty);
                    const remainDiscount = Math.max(0, origDiscount - splitDiscount);
                    const origCk = Number(r.chietkhaumon || 0);
                    const splitCk = Math.round((origCk * item.qtyToMove) / item.origQty);
                    const remainCk = Math.max(0, origCk - splitCk);

                    await client.query(
                        'UPDATE ChiTietHoaDon SET SoLuong = $2, GiaGiam = $3, ChietKhauMon = $4 WHERE MaCTHD = $1',
                        [r.macthd, remainQty, remainDiscount, remainCk]
                    );

                    let cloned;
                    await client.query('SAVEPOINT sp_clone_split_v23');
                    try {
                        cloned = await client.query(
                            `INSERT INTO ChiTietHoaDon
                                (MaHoaDon, MaMon, TenMonSnapshot, KichThuoc, SoLuong, DonGia, GiaGiam, GiaVonSnapshot,
                                 GiaModifiers, ModifiersSnapshot, ChietKhauMon, LaMonTang, LyDoTang,
                                 DotGoi, IsTakeaway, CourseNo, FireStatus, FiredAt, GhiChu, TrangThaiPhaChe, ThoiGianGoi)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,COALESCE($21, CURRENT_TIMESTAMP))
                             RETURNING MaCTHD`,
                            [
                                maHoaDonMoi,
                                r.mamon,
                                r.tenmonsnapshot,
                                r.kichthuoc,
                                item.qtyToMove,
                                Number(r.dongia),
                                splitDiscount,
                                Number(r.giavonsnapshot || 0),
                                Number(r.giamodifiers || 0),
                                JSON.stringify(r.modifierssnapshot || []),
                                splitCk,
                                Boolean(r.lamontang),
                                r.lydotang || null,
                                Number(r.dotgoi || 1),
                                Boolean(r.istakeaway),
                                Number(r.courseno || 1),
                                r.firestatus || 'FIRED',
                                r.firedat || null,
                                r.ghichu,
                                r.trangthaiphache,
                                r.thoigiangoi,
                            ]
                        );
                        await client.query('RELEASE SAVEPOINT sp_clone_split_v23');
                    } catch {
                        await client.query('ROLLBACK TO SAVEPOINT sp_clone_split_v23').catch(() => {});
                        cloned = await client.query(
                            `INSERT INTO ChiTietHoaDon
                                (MaHoaDon, MaMon, TenMonSnapshot, KichThuoc, SoLuong, DonGia, GiaGiam, GiaVonSnapshot, GhiChu, TrangThaiPhaChe, ThoiGianGoi)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, CURRENT_TIMESTAMP))
                             RETURNING MaCTHD`,
                            [
                                maHoaDonMoi,
                                r.mamon,
                                r.tenmonsnapshot,
                                r.kichthuoc,
                                item.qtyToMove,
                                Number(r.dongia),
                                splitDiscount,
                                Number(r.giavonsnapshot || 0),
                                r.ghichu,
                                r.trangthaiphache,
                                r.thoigiangoi,
                            ]
                        );
                    }
                    const newMaCTHD = cloned.rows[0].macthd;

                    // Chuẩn hóa Topping-per-Cup: giữ nguyên SoLuongMoiLy, KHÔNG chia lẻ thập phân!
                    const tpRes = await client.query(
                        `SELECT MaTopping, to_jsonb(ChiTietHoaDon_Topping)->>'tentoppingsnapshot' AS TenToppingSnapshot,
                                SoLuong, COALESCE((to_jsonb(ChiTietHoaDon_Topping)->>'soluongmoily')::int, 1) AS SoLuongMoiLy,
                                DonGia, COALESCE((to_jsonb(ChiTietHoaDon_Topping)->>'giavontoppingsnapshot')::numeric, 0) AS GiaVonToppingSnapshot
                           FROM ChiTietHoaDon_Topping WHERE MaCTHD = $1 FOR UPDATE`,
                        [r.macthd]
                    );
                    for (const tp of tpRes.rows) {
                        const perCup = Math.max(1, Number(tp.soluongmoily || 1));
                        const remainTpQty = perCup * remainQty;
                        const splitTpQty = perCup * item.qtyToMove;
                        await client.query(
                            `UPDATE ChiTietHoaDon_Topping SET SoLuong = $3 WHERE MaCTHD = $1 AND MaTopping = $2`,
                            [r.macthd, tp.matopping, remainTpQty]
                        );
                        await client.query('SAVEPOINT sp_ins_split_tp_v23');
                        try {
                            await client.query(
                                `INSERT INTO ChiTietHoaDon_Topping
                                    (MaCTHD, MaTopping, TenToppingSnapshot, SoLuong, SoLuongMoiLy, DonGia, GiaVonToppingSnapshot)
                                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                                [
                                    newMaCTHD,
                                    tp.matopping,
                                    tp.tentoppingsnapshot || null,
                                    splitTpQty,
                                    perCup,
                                    Number(tp.dongia),
                                    Number(tp.giavontoppingsnapshot || 0),
                                ]
                            );
                            await client.query('RELEASE SAVEPOINT sp_ins_split_tp_v23');
                        } catch {
                            await client.query('ROLLBACK TO SAVEPOINT sp_ins_split_tp_v23').catch(() => {});
                            await client.query(
                                `INSERT INTO ChiTietHoaDon_Topping (MaCTHD, MaTopping, SoLuong, DonGia) VALUES ($1, $2, $3, $4)`,
                                [newMaCTHD, tp.matopping, splitTpQty, Number(tp.dongia)]
                            );
                        }
                    }
                }
            }

            // Kiểm tra luật an toàn thanh toán 1 phần: Cấm tách nếu hóa đơn gốc đã thu vượt quá tổng tiền còn lại sau tách!
            const recalcGoc = await recalculateInvoiceTotals(client, {
                tenantId,
                maHoaDon,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                ip: req.ip,
                ghiAuditLog,
                kiemTraHopLeKhuyenMai,
            });
            await recalculateInvoiceTotals(client, {
                tenantId,
                maHoaDon: maHoaDonMoi,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                ip: req.ip,
                ghiAuditLog,
                kiemTraHopLeKhuyenMai,
            });

            const hoaDonGocAfter = await layHoaDonChiTiet(client, maHoaDon);
            if (Number(hoaDonGocAfter.daThanhToan || 0) > Number(hoaDonGocAfter.tongPhaiTra || 0) + 0.01) {
                throw new LoiNghiepVu(
                    400,
                    `Hóa đơn gốc đã thanh toán trước ${hoaDonGocAfter.daThanhToan.toLocaleString('vi-VN')}đ, vượt quá phần tiền còn lại sau tách (${hoaDonGocAfter.tongPhaiTra.toLocaleString('vi-VN')}đ)!`
                );
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'ORDER_SPLIT',
                doiTuong: 'HOADON',
                maDoiTuong: maHoaDon,
                giaTriMoi: {
                    mode: modeNorm,
                    maHoaDonMoi,
                    laChuyenGhepBan,
                    soDongTach: plan.length,
                    tongLyTach,
                    toMaBan: toMaBan || (modeNorm === 'BY_ITEM' ? 'SAME_TABLE' : 'MANG_DI'),
                    promoAdjusted: recalcGoc.promoAdjusted,
                },
                ip: req.ip,
                batBuoc: true,
            });

            return {
                mode: modeNorm,
                maHoaDonGoc: maHoaDon,
                maHoaDonMoi,
                laChuyenGhepBan,
                tongLyTach,
                promoAdjusted: recalcGoc.promoAdjusted,
                hoaDonGoc: hoaDonGocAfter,
                hoaDonMoi: await layHoaDonChiTiet(client, maHoaDonMoi),
            };
        }, tenantId);

        const splitBranchId = ketQua.hoaDonMoi?.branchId || ketQua.hoaDonGoc?.branchId || req.user?.branchId || 'DEFAULT';
        if (toMaBan) {
            emitToBranch(io, {
                tenantId,
                branchId: splitBranchId,
                roles: ['POS', 'WAITER'],
                event: 'BAN_THAY_DOI',
                payload: { maBan: toMaBan, trangThai: 2 },
            });
        }
        emitToBranch(io, {
            tenantId,
            branchId: splitBranchId,
            roles: ['POS', 'WAITER', 'KDS', 'EXPO'],
            event: 'BAN_CHUYEN',
            payload: {
                maHoaDon: ketQua.maHoaDonMoi,
                maHoaDonGoc: ketQua.maHoaDonGoc,
                toMaBan,
                tenBanCu: ketQua.hoaDonGoc?.ban?.map((b) => b.tenBan).join(', ') || `HĐ #${ketQua.maHoaDonGoc}`,
                tenBanMoi: ketQua.hoaDonMoi?.ban?.map((b) => b.tenBan).join(', ') || (toMaBan || 'Đơn tách Mang đi'),
                laTachDon: true,
            },
        });

        res.status(201).json({
            message: ketQua.laChuyenGhepBan
                ? `🔄 Đã chuyển ${ketQua.tongLyTach} ly sang Hóa đơn #${ketQua.maHoaDonMoi} (${toMaBan})!`
                : `✂️ Đã tách ${ketQua.tongLyTach} ly sang Hóa đơn mới #${ketQua.maHoaDonMoi}!`,
            ...ketQua,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Tách hóa đơn:');
    }
}

app.post('/api/order/:maHoaDon/tach', kiemTraToken, choPhepVaiTro(1, 4), handleSplitOrder);


// [v2] Hóa đơn đang mở của 1 bàn (cô lập TenantId)
app.get('/api/ban/:maBan/hoadon', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const out = await pool.withTenant(tenantId, async (client) => {
            const ban = await client.query(
                "SELECT 1 FROM Ban WHERE MaBan = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2",
                [req.params.maBan, tenantId]
            );
            if (ban.rows.length === 0) return { notFound: true };
            const maHoaDon = await layHoaDonMoCuaBan(client, req.params.maBan);
            return { notFound: false, hoaDon: maHoaDon ? await layHoaDonChiTiet(client, maHoaDon, { vaiTro: req.user?.vaiTro }) : null };
        });
        if (out.notFound) return res.status(404).json({ message: 'Không tìm thấy bàn!' });
        res.json({ hoaDon: out.hoaDon });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Hóa đơn theo bàn:');
    }
});

// [v2] Chi tiết 1 hóa đơn (cô lập TenantId)
app.get('/api/hoadon/:maHoaDon', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const hoaDon = await pool.withTenant(tenantId, async (client) => {
            const own = await client.query(
                "SELECT 1 FROM HoaDon WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
                [req.params.maHoaDon, tenantId]
            );
            if (own.rows.length === 0) return null;
            return layHoaDonChiTiet(client, req.params.maHoaDon, { vaiTro: req.user?.vaiTro });
        });
        if (!hoaDon) return res.status(404).json({ message: 'Không tìm thấy hóa đơn!' });
        res.json({ hoaDon });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Chi tiết hóa đơn:');
    }
});


// [v4 - Phân hệ 1 100/100] Thanh toán: 1 phương thức + Hỗn hợp + Thu 1 phần + Thanh toán theo Chia tiền (chiaTienId) + Optimistic Locking (expectedVersion)
app.post('/api/order/thanhtoan', kiemTraToken, choPhepVaiTro(1, 4), kiemTraHanSuDung, async (req, res) => {
    const {
        maHoaDon,
        phuongThucTT = 'TIEN_MAT',
        maKH = null,
        maKhuyenMai = null,
        diemSuDung = 0,
        tuDongHappyHour = true,
        tienKhachDua,
        thanhToan,
        payments,
        choPhepThuMotPhan = false,
        chiaTienId = null,
        expectedVersion = null,
        branchId = null,
        terminalId = null,
    } = req.body || {};

    if (!maHoaDon) return res.status(400).json({ message: 'Thiếu mã hóa đơn (maHoaDon)!' });

    const khoaIdem = docKhoaIdempotency(req);
    if (khoaIdem === false) return res.status(400).json({ message: 'Header Idempotency-Key không hợp lệ!' });

    const tenantId = layTenantId(req);
    try {
        const ketQua = await chayGiaoDich(async (client) => {
            if (khoaIdem && runtimeFlags.paymentsSanSang) {
                const daCo = await client.query(
                    `SELECT MaHoaDon FROM Order_Payments WHERE COALESCE(TenantId, 'DEFAULT') = $1 AND KhoaIdem = $2 LIMIT 1`,
                    [tenantId, khoaIdem]
                );
                if (daCo.rows.length > 0) {
                    const hd = await layHoaDonChiTiet(client, daCo.rows[0].mahoadon);
                    return {
                        trungLap: true,
                        daHoanTat: hd?.trangThaiTT === 1,
                        hoaDon: hd,
                        tienThua: null,
                        diemCong: 0,
                        banDaTrong: [],
                    };
                }
            }

            const laOfflineSync = req.get('X-Offline-Sync') === '1';
            const caInfo = await layCaChoGiaoDichOffline(client, {
                tenantId,
                maCaGoc: req.body?.maCaThuNganGoc || null,
                laOfflineSync,
                branchId: branchId || req.user.branchId || null,
                terminalId: terminalId || null,
            });
            const ca = caInfo.ca;

            const splitArr = Array.isArray(payments) && payments.length > 0 ? payments : thanhToan;
            const reqManagerPin = req.body?.managerPin || null;
            const reqMaNVDuyet = req.body?.maNVDuyet || null;
            const reqNguonXacNhan = req.body?.nguonXacNhan || null;
            const reqIdChungTu = req.body?.idChungTu ? String(req.body.idChungTu).trim().slice(0, 64) : null;
            let cacKhoanTT = null;
            let autoFillSingleMethod = null;
            let hasVoucherTender = false;
            if (Array.isArray(splitArr) && splitArr.length > 0) {
                cacKhoanTT = splitArr.map((t) => {
                    if (t.phuongThucTT === 'VOUCHER') hasVoucherTender = true;
                    return {
                        phuongThucTT: t.phuongThucTT,
                        soTien: t.soTien,
                        tienKhachDua: t.tienKhachDua,
                        maChuanChiEDC: t.maChuanChiEDC || null,
                        bonSoCuoiThe: t.bonSoCuoiThe || null,
                        noiDungCK: t.noiDungCK || (t.idChungTu || reqIdChungTu ? `RECEIPT:${t.idChungTu || reqIdChungTu}` : null),
                        nguonXacNhan: laOfflineSync
                            ? 'POS_OFFLINE_SYNC'
                            : t.nguonXacNhan || (t.phuongThucTT === 'CHUYEN_KHOAN' && (t.idChungTu || reqIdChungTu) ? 'POS_MANUAL_PROVISIONAL' : 'POS_MANUAL'),
                    };
                });
            } else {
                if (!PHUONG_THUC_TT.includes(phuongThucTT)) {
                    throw new LoiNghiepVu(400, `phuongThucTT phải là một trong: ${PHUONG_THUC_TT.join(', ')}`);
                }
                if (phuongThucTT === 'VOUCHER') hasVoucherTender = true;
                autoFillSingleMethod = {
                    phuongThucTT,
                    tienKhachDua,
                    ...(reqNguonXacNhan ? { nguonXacNhan: reqNguonXacNhan } : {}),
                    ...(reqIdChungTu ? { noiDungCK: `RECEIPT:${reqIdChungTu}` } : {}),
                };
            }

            let voucherApprovedByManager = Number(req.user.vaiTro) === 1;
            if (hasVoucherTender && !voucherApprovedByManager && reqManagerPin) {
                const mgr = await xacThucPinQuanLy(client, tenantId, reqManagerPin, req.ip, reqMaNVDuyet);
                if (!mgr) {
                    throw new LoiNghiepVu(403, 'Mã PIN Quản lý duyệt VOUCHER không đúng!', {
                        code: 'VOUCHER_PIN_INVALID',
                        maLoi: 'CAN_PIN_QUAN_LY',
                    });
                }
                voucherApprovedByManager = true;
            }

            const clockCheckTT = laOfflineSync ? detectOfflineClockDrift(req.body?.offlineCreatedAt) : { tampered: false };
            const resTT = await ghiNhanThanhToanTrongGiaoDich(client, {
                maHoaDon,
                expectedTenantId: tenantId,
                expectedVersion,
                chiaTienId,
                ca,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                voucherApprovedByManager,
                maKH,
                maKhuyenMai,
                diemSuDung,
                tuDongHappyHour: Boolean(tuDongHappyHour) && !clockCheckTT.tampered,
                autoFillSingleMethod,
                cacKhoanTT,
                choPhepThuMotPhan: Boolean(choPhepThuMotPhan),
                khoaIdem,
                laOfflineLechCa: caInfo.lechCaDongBo,
                maCaThuNganGoc: caInfo.maCaGoc,
                branchId: branchId || ca.branchid,
                terminalId: terminalId || ca.terminalid,
                ip: req.ip,
            });

            if (laOfflineSync && clockCheckTT.tampered) {
                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'OFFLINE_CLOCK_TAMPER_SUSPECTED',
                    doiTuong: 'HOADON',
                    maDoiTuong: maHoaDon,
                    giaTriMoi: {
                        offlineCreatedAt: req.body?.offlineCreatedAt,
                        serverNow: new Date().toISOString(),
                        driftMs: clockCheckTT.driftMs,
                        driftMinutes: clockCheckTT.driftMinutes,
                    },
                    lyDo: `Thanh toán Offline lệch đồng hồ ${clockCheckTT.driftMinutes} phút (> 10 phút) — từ chối tự động Happy Hour`,
                    ip: req.ip,
                    batBuoc: true,
                });
                if (typeof dispatchFraudAlertFromAudit === 'function') {
                    void dispatchFraudAlertFromAudit(pool, {
                        tenantId,
                        hanhDong: 'OFFLINE_CLOCK_TAMPER_SUSPECTED',
                        maNV: req.user.maNV,
                        maDoiTuong: maHoaDon,
                        giaTriMoi: { driftMinutes: clockCheckTT.driftMinutes, offlineCreatedAt: req.body?.offlineCreatedAt },
                        lyDo: `⏰ Nghi vấn chỉnh đồng hồ thiết bị Offline khi thanh toán (lệch ${clockCheckTT.driftMinutes} phút) trên HĐ #${maHoaDon}!`,
                    }).catch(() => {});
                }
            }

            if (laOfflineSync) {
                const offlineClientId = req.body?.offlineClientId ? String(req.body.offlineClientId).trim().slice(0, 64) : null;
                if (offlineClientId) {
                    await client.query('SAVEPOINT sp_pay_off_id');
                    try {
                        await client.query(
                            `UPDATE HoaDon SET MaOfflineClient = COALESCE(MaOfflineClient, $2) WHERE MaHoaDon = $1`,
                            [maHoaDon, offlineClientId]
                        );
                        await client.query('RELEASE SAVEPOINT sp_pay_off_id');
                    } catch {
                        await client.query('ROLLBACK TO SAVEPOINT sp_pay_off_id').catch(() => {});
                    }
                }
                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'OFFLINE_PAYMENT_SYNCED',
                    doiTuong: 'HOADON',
                    maDoiTuong: maHoaDon,
                    giaTriMoi: {
                        khoaIdem,
                        offlineClientId,
                        offlineCreatedAt: req.body?.offlineCreatedAt || null,
                        maCaThuNganGoc: caInfo.maCaGoc,
                        maCaHachToan: ca.macathungan,
                        lechCaDongBo: caInfo.lechCaDongBo,
                        caGocDaDong: caInfo.caGocDaDong,
                        ghiChuLechCa: caInfo.ghiChuLechCa,
                        phuongThucTT,
                    },
                    lyDo: `Đồng bộ thanh toán bàn Offline${offlineClientId ? ` ${offlineClientId}` : ''}${caInfo.ghiChuLechCa ? ` (${caInfo.ghiChuLechCa})` : ''}`,
                    ip: req.ip,
                });
            }

            return { trungLap: false, ...resTT, canhBaoLechCa: caInfo.ghiChuLechCa };
        }, tenantId);

        if (!ketQua.trungLap) {
            const tId = layTenantId(req);
            const payBranchId = ketQua.branchId || ketQua.hoaDon?.branchId || branchId || req.user?.branchId || 'DEFAULT';
            for (const maBan of ketQua.banDaTrong) {
                emitToBranch(io, {
                    tenantId: tId,
                    branchId: payBranchId,
                    roles: ['POS', 'WAITER'],
                    event: 'BAN_THAY_DOI',
                    payload: { maBan, trangThai: 3 },
                });
            }
            if (ketQua.daHoanTat) {
                if (ketQua.kdsEmitPlan && typeof ketQua.kdsEmitPlan.flush === 'function') {
                    ketQua.kdsEmitPlan.flush();
                }
                emitToBranch(io, {
                    tenantId: tId,
                    branchId: payBranchId,
                    roles: ['POS'],
                    event: 'HOADON_DA_TT',
                    payload: { maHoaDon },
                });
                void kiemTraCanhBaoTanSuatGianLan(pool, {
                    tenantId: tId,
                    maCaThuNgan: ketQua.maCaThuNgan || null,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    maKH: maKH || ketQua.hoaDon?.khachHang?.maKH || null,
                    phuongThucTT: ketQua.hoaDon?.phuongThucTT || phuongThucTT,
                    coGiamGia: Number(ketQua.hoaDon?.tongGiamGia || 0) > 0,
                    maHoaDon,
                    ghiAuditLog,
                    ip: req.ip,
                });
            }
            // [Phân hệ 3 - Trụ cột 4] Kiểm tra Cảnh báo Đầy Két Tiền Mặt (Cash Drawer Threshold Alert)
            if (ketQua.maCaThuNgan) {
                pool.withTenant(tId, async (cCheck) => {
                    const [pol, dsNow] = await Promise.all([
                        getTenantShiftPolicy(cCheck, tId),
                        tinhDoiSoatCa(cCheck, ketQua.maCaThuNgan),
                    ]);
                    if (pol.hanMucKetTienMat > 0 && dsNow.tienMatLyThuyet >= pol.hanMucKetTienMat) {
                        // [Wave 1 — P0-07] Bịt rò rỉ Blind Drop: TUYỆT ĐỐI không gửi tienMatLyThuyet/tienMatHienTai trong payload & message!
                        emitToBranch(io, {
                            tenantId: tId,
                            branchId: payBranchId,
                            roles: ['POS'],
                            event: 'shift:drawer_limit_warning',
                            payload: {
                                maCaThuNgan: ketQua.maCaThuNgan,
                                hanMucKetTienMat: pol.hanMucKetTienMat,
                                thresholdExceeded: true,
                                message: `🏦 Két tiền mặt đã vượt ngưỡng an toàn (${pol.hanMucKetTienMat.toLocaleString('vi-VN')}đ) — vui lòng thực hiện Rút két (Safe Drop) ngay!`,
                            },
                        });
                    }
                }).catch(() => {});
            }
        }

        res.json({
            message: ketQua.daHoanTat
                ? 'Thanh toán hoàn tất!'
                : `Đã ghi nhận thu trước ${ketQua.tongThuLanNay.toLocaleString('vi-VN')}đ (còn lại ${ketQua.conLai.toLocaleString('vi-VN')}đ)!`,
            daHoanTat: ketQua.daHoanTat,
            conLai: ketQua.conLai ?? 0,
            hoaDon: ketQua.hoaDon,
            tienThua: ketQua.tienThua,
            diemCong: ketQua.diemCong,
            trungLap: ketQua.trungLap,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Thanh toán:');
    }
});



app.get('/api/order/dangcho', kiemTraToken, choPhepVaiTro(2, 1), async (req, res) => {
    const tId = layTenantId(req);
    const tramFilter = String(req.query.tram || '').trim().toUpperCase();
    try {
        const list = await pool.withTenant(tId, (client) => layMonTheoTrangThai(client, ['ChoPhaChe', 'DangLam'], tId));
        if (TRAM_CHE_BIEN_HOP_LE.includes(tramFilter)) {
            return res.json(list.filter((m) => m.tramCheBien === tramFilter));
        }
        res.json(list);
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Món đang chờ:');
    }
});

// [P1 - KDS Recall] Danh sách món vừa trả trong 15 phút gần nhất để Barista hoàn tác khi lỡ bấm nhầm
app.get('/api/order/vua-tra', kiemTraToken, choPhepVaiTro(2, 1), async (req, res) => {
    const tId = layTenantId(req);
    try {
        const rows = await pool.withTenant(tId, async (client) => {
            const r = await client.query(
                `${SQL_MON_PHA_CHE}
                 JOIN HoaDon hd ON hd.MaHoaDon = cthd.MaHoaDon
                 WHERE cthd.TrangThaiPhaChe = 'DaXong'
                   AND COALESCE(hd.TenantId, 'DEFAULT') = $1
                   AND COALESCE(cthd.ThoiGianXong, cthd.ThoiGianGoi) >= now() - interval '15 minutes'
                 ORDER BY COALESCE(cthd.ThoiGianXong, cthd.ThoiGianGoi) DESC
                 LIMIT 40`,
                [tId]
            );
            return r.rows.map(mapMonPhaChe);
        });
        res.json(rows);
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lịch sử vừa trả (KDS Recall):');
    }
});

// [L2.2] KDS Recall (/api/kds/recall/:maCTHD & /api/order/hoantac-tramon) đã được hợp nhất về modules/kdsPhase2Routes.js (giới hạn 15 phút + kds_event_log + emit 3 tầng).

app.put('/api/order/danglam', kiemTraToken, choPhepVaiTro(2, 1), async (req, res) => {
    const { maCTHD } = req.body || {};
    const tId = layTenantId(req);
    if (!maCTHD) return res.status(400).json({ message: 'Thiếu mã chi tiết hóa đơn (maCTHD)!' });
    try {
        const mon = await doiTrangThaiMon(maCTHD, ['ChoPhaChe'], 'DangLam', tId, req.user.maNV);
        const bId = normalizeBranchId(mon.branchId || 'DEFAULT');
        const logInfo = await pool.withTenant(tId, (client) =>
            insertKdsEventLog(client, {
                tenantId: tId,
                branchId: bId,
                station: mon.tramCheBien,
                eventType: 'STATUS_CHANGE',
                maHoaDon: mon.maHoaDon,
                payload: { trangThai: 'DangLam', mon },
            })
        );
        emitScopedKdsEvent(io, {
            tenantId: tId,
            branchId: bId,
            station: mon.tramCheBien,
            seq: logInfo.seq,
            eventType: 'STATUS_CHANGE',
            socketEvents: ['MON_DANG_LAM'],
            payload: mon,
            includeExpo: true,
            legacyBaristaEvent: 'MON_DANG_LAM',
        });
        res.json({ message: 'Đã nhận làm món!', mon, seq: logInfo.seq });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Nhận làm món:');
    }
});

app.put('/api/order/tramon', kiemTraToken, choPhepVaiTro(2, 1), async (req, res) => {
    const { maCTHD } = req.body || {};
    const tId = layTenantId(req);
    if (!maCTHD) return res.status(400).json({ message: 'Thiếu mã chi tiết hóa đơn (maCTHD)!' });
    try {
        const mon = await doiTrangThaiMon(maCTHD, ['ChoPhaChe', 'DangLam'], 'DaXong', tId, req.user.maNV);
        const bId = normalizeBranchId(mon.branchId || 'DEFAULT');
        const logInfo = await pool.withTenant(tId, (client) =>
            insertKdsEventLog(client, {
                tenantId: tId,
                branchId: bId,
                station: mon.tramCheBien,
                eventType: 'STATUS_CHANGE',
                maHoaDon: mon.maHoaDon,
                payload: { trangThai: 'DaXong', mon },
            })
        );
        emitScopedKdsEvent(io, {
            tenantId: tId,
            branchId: bId,
            station: mon.tramCheBien,
            seq: logInfo.seq,
            eventType: 'STATUS_CHANGE',
            socketEvents: ['MON_DA_XONG'],
            payload: mon,
            includeExpo: true,
            includeWaiter: true,
            legacyBaristaEvent: 'MON_DA_XONG',
            legacyWaiterEvent: 'MON_DA_XONG',
        });
        const readyCheck = await kiemTraVaPhatAllStationsReady(mon, tId);
        res.json({
            message: 'Đã báo trả món thành công!',
            maHoaDon: mon.maHoaDon,
            mon,
            allStationsReady: Boolean(readyCheck.allReady),
            seq: logInfo.seq,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Trả món:');
    }
});

app.get('/api/order/chophucvu', kiemTraToken, choPhepVaiTro(3, 1), async (req, res) => {
    const tId = layTenantId(req);
    try {
        res.json(await pool.withTenant(tId, (client) => layMonTheoTrangThai(client, ['DaXong'], tId)));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Món chờ phục vụ:');
    }
});

app.put('/api/order/phucvu', kiemTraToken, choPhepVaiTro(3, 1), async (req, res) => {
    const { maCTHD } = req.body || {};
    const tId = layTenantId(req);
    if (!maCTHD) return res.status(400).json({ message: 'Thiếu mã chi tiết hóa đơn (maCTHD)!' });
    try {
        const mon = await doiTrangThaiMon(maCTHD, ['DaXong'], 'DaPhucVu', tId, req.user.maNV);
        const bId = normalizeBranchId(mon.branchId || 'DEFAULT');
        emitScopedKdsEvent(io, {
            tenantId: tId,
            branchId: bId,
            station: mon.tramCheBien,
            eventType: 'STATUS_CHANGE',
            socketEvents: ['MON_DA_PHUC_VU'],
            payload: mon,
            includeExpo: true,
            includeWaiter: true,
            legacyWaiterEvent: 'MON_DA_PHUC_VU',
        });
        res.json({ message: 'Đã xác nhận phục vụ món!', mon });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Phục vụ món:');
    }
});


// [P0] Tạo bàn mới (cô lập tuyệt đối theo TenantId — chống chiếm đoạt bàn đã xóa chéo Tenant)
app.post('/api/ban', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { maBan, tenBan, khuVuc = 'Khu chính', toadoX = 0, toadoY = 0 } = req.body || {};
    const tenantId = layTenantId(req);
    const prefix = req.user.maTienTo && tenantId !== 'DEFAULT' ? `${req.user.maTienTo}_` : '';
    const rawMa = String(maBan || '').trim().toUpperCase();
    const ma = rawMa.startsWith(prefix) ? rawMa : `${prefix}${rawMa}`;
    const ten = String(tenBan || '').trim();
    if (!rawMa || !ten) return res.status(400).json({ message: 'Vui lòng nhập đủ mã bàn và tên bàn!' });

    try {
        const outcome = await pool.withTenant(tenantId, async (client) => {
            const tonTai = await client.query(
                "SELECT DaXoa, COALESCE(TenantId, 'DEFAULT') AS TenantId FROM Ban WHERE MaBan = $1 FOR UPDATE",
                [ma]
            );
            if (tonTai.rows.length > 0) {
                if (tonTai.rows[0].tenantid !== tenantId || !tonTai.rows[0].daxoa) {
                    throw new LoiNghiepVu(409, `Mã bàn ${ma} đã tồn tại!`);
                }
                const upd = await client.query(
                    `UPDATE Ban
                        SET TenBan = $2, KhuVuc = $3, TrangThai = 1, DaXoa = FALSE
                      WHERE MaBan = $1 AND COALESCE(TenantId, 'DEFAULT') = $4
                      RETURNING MaBan`,
                    [ma, ten, String(khuVuc).trim(), tenantId]
                );
                if (upd.rows.length === 0) throw new LoiNghiepVu(409, `Mã bàn ${ma} đã tồn tại!`);
                return { restored: true };
            }

            await client.query(
                `INSERT INTO Ban (MaBan, TenBan, TrangThai, KhuVuc, ToaDoX, ToaDoY, DaXoa, TenantId)
                 VALUES ($1, $2, 1, $3, $4, $5, FALSE, $6)`,
                [ma, ten, String(khuVuc).trim(), Number(toadoX) || 0, Number(toadoY) || 0, tenantId]
            );
            return { restored: false };
        });

        if (outcome.restored) {
            return res.status(200).json({ message: `Đã khôi phục bàn ${ten}!`, maBan: ma });
        }
        res.status(201).json({ message: 'Thêm bàn mới thành công!', maBan: ma });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `Mã bàn ${ma} đã tồn tại!` });
        guiLoi(res, error, 'Lỗi API Tạo bàn:');
    }
});


    return {
        handleCreateOrAppendOrder,
        handleSplitOrder,
    };
}

module.exports = { registerOrdersDomain };
