/**
 * =============================================================================
 * PHÂN HỆ 2 ROUTES: KDS/BDS REAL-TIME, SYNC REPLAY, BATCH/EXPO, PRINT TOKEN,
 * ITEM SWAP RACE-SAFE, 5-LAYER 86'ING, COUNTDOWN, PARK/RESUME, REMAKE & TELEMETRY
 * =============================================================================
 */

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
    buildBatchSummary,
    buildExpoTickets,
    cascadeIngredient86,
    computeKdsBottleneckTelemetry,
} = require('./kdsPhase2Engine');

const { danhGiaModifiersChoMon, tinhGiaToppingBacThang, tinhBomMotLySauSubstitution } = require('./fohEngineService');

const LOAI_GD_BAN_HANG = 6;
const LOAI_GD_HOAN_KHO = 7;
const LOAI_GD_HAO_HUT_HUY_MON = 8;

const lam3 = (n) => Math.round(Number(n || 0) * 1000) / 1000;

function registerKdsPhase2Routes(app, deps) {
    const {
        pool,
        chayGiaoDich,
        qTenant,
        layTenantId,
        kiemTraToken,
        choPhepVaiTro,
        coQuyenHan,
        xacThucPinQuanLy,
        ghiAuditLog,
        ghiCanhBaoGianLan,
        guiLoi,
        LoiNghiepVu,
        io,
        roomTen,
        SQL_MON_PHA_CHE,
        mapMonPhaChe,
        layMonTheoMa,
        layHoaDonChiTiet,
        layCaDangMo,
        layMapGiaVonNguyenLieu,
        congDinhLuongNguyenLieuDongMon,
        doiTrangThaiMon,
        kiemTraVaPhatAllStationsReady,
        suyLuanTramCheBien,
    } = deps;

    // Helper: lấy danh sách món active cho 1 tenant (+ lọc branchId & station)
    async function loadActiveKdsItems(client, { tenantId, branchId = null, station = 'ALL', statuses = ['ChoPhaChe', 'DangLam'] }) {
        const cleanBranch = branchId ? normalizeBranchId(branchId) : null;
        const cleanStation = normalizeStation(station);
        const r = await client.query(
            `${SQL_MON_PHA_CHE}
             JOIN HoaDon hd ON hd.MaHoaDon = cthd.MaHoaDon
             WHERE cthd.TrangThaiPhaChe = ANY($1::varchar[])
               AND hd.TrangThaiTT IN (0, 1)
               AND COALESCE(to_jsonb(cthd)->>'firestatus', 'FIRED') = 'FIRED'
               AND COALESCE(hd.TenantId, 'DEFAULT') = $2
               AND ($3::text IS NULL OR COALESCE(NULLIF(to_jsonb(hd)->>'branchid', ''), 'DEFAULT') = $3)
             ORDER BY COALESCE((to_jsonb(cthd)->>'mucdouutien')::int, 0) DESC,
                      COALESCE(cthd.FiredAt, cthd.ThoiGianGoi::timestamptz) ASC,
                      cthd.MaCTHD ASC`,
            [statuses, tenantId, cleanBranch]
        );
        let items = r.rows.map(mapMonPhaChe);
        if (cleanStation !== 'ALL') {
            items = items.filter((m) => m.tramCheBien === cleanStation);
        }
        return items;
    }

    // =========================================================================
    // 1. KDS RECONNECT REPLAY & CLOCK-SKEW SYNC (GET /api/kds/sync)
    // =========================================================================
    app.get('/api/kds/sync', kiemTraToken, choPhepVaiTro(1, 2, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = normalizeBranchId(req.query.branchId || req.user.branchId || 'DEFAULT');
        const station = normalizeStation(req.query.station || req.query.tram || 'ALL');
        const lastSeq = Math.max(0, Math.floor(Number(req.query.lastSeq || 0)));

        try {
            const data = await pool.withTenant(tenantId, async (client) => {
                const maxRes = await client.query(
                    `SELECT COALESCE(MAX(seq), 0)::bigint AS latest_seq
                       FROM public.kds_event_log
                      WHERE tenantid = $1 AND branchid = $2`,
                    [tenantId, branchId]
                );
                const latestSeq = Number(maxRes.rows[0]?.latest_seq || 0);

                let missedEvents = [];
                let mode = 'SNAPSHOT';

                if (lastSeq > 0) {
                    const evRes = await client.query(
                        `SELECT seq, branchid, station, eventtype, mahoadon, payload, thoigiantao
                           FROM public.kds_event_log
                          WHERE tenantid = $1
                            AND branchid = $2
                            AND seq > $3
                            AND ($4 = 'ALL' OR station = 'ALL' OR station = $4)
                          ORDER BY seq ASC
                          LIMIT 201`,
                        [tenantId, branchId, lastSeq, station]
                    );
                    if (evRes.rows.length <= 200) {
                        mode = 'DELTA';
                        missedEvents = evRes.rows.map((r) => ({
                            seq: Number(r.seq),
                            branchId: r.branchid,
                            station: r.station,
                            eventType: r.eventtype,
                            maHoaDon: r.mahoadon,
                            payload: r.payload || {},
                            thoiGianTao: r.thoigiantao,
                        }));
                    }
                }

                const activeItems = await loadActiveKdsItems(client, {
                    tenantId,
                    branchId,
                    station,
                    statuses: ['ChoPhaChe', 'DangLam'],
                });
                const expoSourceItems = await loadActiveKdsItems(client, {
                    tenantId,
                    branchId,
                    station: 'ALL',
                    statuses: ['ChoPhaChe', 'DangLam', 'DaXong', 'DaPhucVu'],
                });

                return {
                    serverNowMs: Date.now(),
                    branchId,
                    station,
                    latestSeq,
                    lastSeq,
                    mode,
                    missedEvents,
                    tickets: activeItems,
                    batchSummary: buildBatchSummary(activeItems),
                    expoTickets: buildExpoTickets(expoSourceItems),
                };
            });

            res.json(data);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API KDS Sync Replay:');
        }
    });

    // =========================================================================
    // 2. TRA CỨU ĐƠN THEO CLIENT_ORDER_UID (CHỐNG ĐÚP VÉ CLOUD TIMEOUT / LAN HUB)
    // =========================================================================
    app.get('/api/order/by-client-uid/:clientOrderUid', kiemTraToken, choPhepVaiTro(1, 2, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const uid = String(req.params.clientOrderUid || '').trim();
        if (!uid) return res.status(400).json({ message: 'Thiếu clientOrderUid!' });
        try {
            const result = await pool.withTenant(tenantId, async (client) => {
                const hdRes = await client.query(
                    `SELECT MaHoaDon, TrangThaiTT, SoThuTuNgay,
                            to_jsonb(HoaDon)->>'sothutuhienthi' AS SoThuTuHienThi
                       FROM HoaDon
                      WHERE COALESCE(TenantId, 'DEFAULT') = $1
                        AND (ClientOrderUid = $2 OR to_jsonb(HoaDon)->>'maofflineclient' = $2)
                      ORDER BY ThoiGianTao DESC
                      LIMIT 1`,
                    [tenantId, uid]
                );
                if (hdRes.rows.length > 0) {
                    const maHoaDon = hdRes.rows[0].mahoadon;
                    return {
                        exists: true,
                        maHoaDon,
                        hoaDon: await layHoaDonChiTiet(client, maHoaDon),
                    };
                }
                const idemRes = await client.query(
                    `SELECT trangthai, mahoadon, mahoadonkq
                       FROM public.donhang_idempotency
                      WHERE khoaidem = $1`,
                    [uid]
                );
                if (idemRes.rows.length > 0) {
                    const row = idemRes.rows[0];
                    const maHD = row.mahoadonkq || row.mahoadon;
                    if (maHD) {
                        return {
                            exists: true,
                            inFlight: false,
                            maHoaDon: maHD,
                            hoaDon: await layHoaDonChiTiet(client, maHD),
                        };
                    }
                    if (row.trangthai === 'PROCESSING') {
                        return { exists: false, inFlight: true };
                    }
                }
                return { exists: false, inFlight: false };
            });
            res.json(result);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Tra cứu ClientOrderUid:');
        }
    });

    // =========================================================================
    // 3. KDS BATCH SUMMARY VIEW & BATCH ACTION (FIFO)
    // =========================================================================
    app.get('/api/kds/batch-summary', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = req.query.branchId ? normalizeBranchId(req.query.branchId) : null;
        const station = normalizeStation(req.query.station || req.query.tram || 'ALL');
        try {
            const items = await pool.withTenant(tenantId, (client) =>
                loadActiveKdsItems(client, { tenantId, branchId, station, statuses: ['ChoPhaChe', 'DangLam'] })
            );
            res.json({
                serverNowMs: Date.now(),
                branchId: branchId || 'DEFAULT',
                station,
                batches: buildBatchSummary(items),
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API KDS Batch Summary:');
        }
    });

    app.post('/api/kds/batch-action', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
        const tenantId = layTenantId(req);
        const {
            action = 'START_ALL',
            maMon,
            kichThuoc = 'M',
            branchId = null,
            station = 'ALL',
        } = req.body || {};
        if (!maMon) return res.status(400).json({ message: 'Thiếu mã món (maMon)!' });
        const cleanAction = String(action || 'START_ALL').toUpperCase();
        if (!['START_ALL', 'BUMP_ONE', 'COMPLETE_ALL'].includes(cleanAction)) {
            return res.status(400).json({ message: 'action chỉ chấp nhận START_ALL, BUMP_ONE hoặc COMPLETE_ALL!' });
        }

        try {
            const items = await pool.withTenant(tenantId, (client) =>
                loadActiveKdsItems(client, {
                    tenantId,
                    branchId: branchId ? normalizeBranchId(branchId) : null,
                    station,
                    statuses: ['ChoPhaChe', 'DangLam'],
                })
            );
            const matched = items.filter((m) => m.maMon === maMon && String(m.kichThuoc || 'M') === String(kichThuoc || 'M'));
            if (matched.length === 0) {
                return res.status(404).json({ message: 'Không còn món nào trong lô này để thao tác!' });
            }

            const updated = [];
            if (cleanAction === 'START_ALL') {
                const pending = matched.filter((m) => m.trangThaiPhaChe === 'ChoPhaChe');
                for (const m of pending) {
                    const u = await doiTrangThaiMon(m.maCTHD, ['ChoPhaChe'], 'DangLam', tenantId, req.user.maNV);
                    updated.push(u);
                }
            } else if (cleanAction === 'BUMP_ONE') {
                // FIFO: ưu tiên món đang làm lâu nhất hoặc món chờ lâu nhất
                const target = matched.find((m) => m.trangThaiPhaChe === 'DangLam') || matched[0];
                const u = await doiTrangThaiMon(target.maCTHD, ['ChoPhaChe', 'DangLam'], 'DaXong', tenantId, req.user.maNV);
                updated.push(u);
                await kiemTraVaPhatAllStationsReady(u, tenantId);
            } else if (cleanAction === 'COMPLETE_ALL') {
                for (const m of matched) {
                    const u = await doiTrangThaiMon(m.maCTHD, ['ChoPhaChe', 'DangLam'], 'DaXong', tenantId, req.user.maNV);
                    updated.push(u);
                    await kiemTraVaPhatAllStationsReady(u, tenantId);
                }
            }

            res.json({
                message: `Đã xử lý ${updated.length} dòng trong lô (${cleanAction})!`,
                action: cleanAction,
                updatedCount: updated.length,
                updatedItems: updated,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API KDS Batch Action:');
        }
    });

    // =========================================================================
    // 4. KDS EXPO / PASS SCREEN (TRẠM GOM MÓN ĐA QUẦY)
    // =========================================================================
    app.get('/api/kds/expo', kiemTraToken, choPhepVaiTro(1, 2, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = req.query.branchId ? normalizeBranchId(req.query.branchId) : null;
        try {
            const items = await pool.withTenant(tenantId, (client) =>
                loadActiveKdsItems(client, {
                    tenantId,
                    branchId,
                    station: 'ALL',
                    statuses: ['ChoPhaChe', 'DangLam', 'DaXong', 'DaPhucVu'],
                })
            );
            res.json({
                serverNowMs: Date.now(),
                branchId: branchId || 'DEFAULT',
                tickets: buildExpoTickets(items),
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API KDS Expo Screen:');
        }
    });

    // =========================================================================
    // 5. KDS RECALL (HOÀN TÁC TRẢ MÓN TRONG 15 PHÚT — HỢP NHẤT /api/kds/recall/:maCTHD & /api/order/hoantac-tramon)
    // =========================================================================
    async function handleKdsRecall(req, res) {
        const tenantId = layTenantId(req);
        const maCTHD = req.params.maCTHD || req.body?.maCTHD;
        if (!maCTHD) return res.status(400).json({ message: 'Thiếu mã chi tiết hóa đơn (maCTHD)!' });
        try {
            const check = await pool.withTenant(tenantId, async (client) => {
                const r = await client.query(
                    `SELECT c.TrangThaiPhaChe, c.ThoiGianXong,
                            COALESCE(NULLIF(to_jsonb(hd)->>'branchid', ''), 'DEFAULT') AS BranchId
                       FROM ChiTietHoaDon c
                       JOIN HoaDon hd ON hd.MaHoaDon = c.MaHoaDon
                      WHERE c.MaCTHD = $1 AND COALESCE(hd.TenantId, 'DEFAULT') = $2`,
                    [maCTHD, tenantId]
                );
                return r.rows[0] || null;
            });
            if (!check) return res.status(404).json({ message: 'Không tìm thấy món cần hoàn tác!' });
            if (check.thoigianxong) {
                const elapsedMin = (Date.now() - new Date(check.thoigianxong).getTime()) / 60000;
                if (elapsedMin > 15) {
                    return res.status(409).json({
                        message: 'Món đã hoàn thành quá 15 phút, không thể Recall! Vui lòng dùng tính năng Làm Lại (Remake).',
                    });
                }
            }

            const mon = await doiTrangThaiMon(maCTHD, ['DaXong'], 'DangLam', tenantId, req.user.maNV);
            const bId = normalizeBranchId(mon.branchId || check.branchid || 'DEFAULT');
            const logInfo = await pool.withTenant(tenantId, (client) =>
                insertKdsEventLog(client, {
                    tenantId,
                    branchId: bId,
                    station: mon.tramCheBien,
                    eventType: 'STATUS_CHANGE',
                    maHoaDon: mon.maHoaDon,
                    payload: { action: 'RECALL', mon },
                })
            );
            emitScopedKdsEvent(io, {
                tenantId,
                branchId: bId,
                station: mon.tramCheBien,
                seq: logInfo.seq,
                eventType: 'STATUS_CHANGE',
                socketEvents: ['kds:item_recalled', 'MON_HOAN_TAC', 'MON_DANG_LAM'],
                payload: mon,
                includeExpo: true,
                includeWaiter: true,
                legacyBaristaEvent: 'MON_HOAN_TAC',
                legacyWaiterEvent: 'MON_HOAN_TAC',
            });

            res.json({ message: `↩️ Đã hoàn tác (Recall) "${mon.tenMon}" về hàng đợi Đang làm!`, mon, seq: logInfo.seq });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API KDS Recall:');
        }
    }

    app.post('/api/kds/recall/:maCTHD', kiemTraToken, choPhepVaiTro(1, 2), handleKdsRecall);
    app.put('/api/order/hoantac-tramon', kiemTraToken, choPhepVaiTro(1, 2), handleKdsRecall);

    // =========================================================================
    // 6. SERVER-ENFORCED REPRINT WATERMARK TOKEN (HỢP NHẤT /api/order/:maHoaDon/print-token & /api/hoadon/:maHoaDon/in)
    // =========================================================================
    async function handleIssuePrintToken(req, res) {
        const tenantId = layTenantId(req);
        const { maHoaDon } = req.params;
        const { managerPin = null, maNVDuyet = null, lyDo = null } = req.body || {};

        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const checkRes = await client.query(
                    `SELECT MaHoaDon, TrangThaiTT, COALESCE(SoLanIn, 0) AS SoLanIn, COALESCE(DaInTamTinh, FALSE) AS DaInTamTinh
                       FROM HoaDon
                      WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                      FOR UPDATE`,
                    [maHoaDon, tenantId]
                );
                if (checkRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn!');
                const current = checkRes.rows[0];
                const nextSoLanIn = Number(current.solanin || 0) + 1;

                // Lần in thứ 2 trở đi bắt buộc kiểm tra RBAC order.reprint_receipt hoặc Manager PIN!
                let nguoiDuyet = req.user.maNV;
                if (nextSoLanIn >= 2) {
                    const coQuyenInLai =
                        Number(req.user.vaiTro) === 1 ||
                        coQuyenHan(req.user, 'order.reprint_receipt') ||
                        coQuyenHan(req.user, 'order.item.void_approve');
                    if (!coQuyenInLai) {
                        const mgr = managerPin
                            ? await xacThucPinQuanLy(client, tenantId, managerPin, req.ip, maNVDuyet, 'order.reprint_receipt')
                            : null;
                        if (!mgr) {
                            throw new LoiNghiepVu(
                                403,
                                'In lại hóa đơn (lần 2+) yêu cầu quyền order.reprint_receipt hoặc mã PIN Quản lý!',
                                { maLoi: 'CAN_QUYEN_IN_LAI', code: 'REPRINT_FORBIDDEN' }
                            );
                        }
                        nguoiDuyet = mgr.maNV;
                    }
                }

                const upd = await client.query(
                    `UPDATE HoaDon
                        SET SoLanIn = COALESCE(SoLanIn, 0) + 1,
                            DaInTamTinh = CASE WHEN TrangThaiTT = 0 THEN TRUE ELSE COALESCE(DaInTamTinh, FALSE) END
                      WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                      RETURNING MaHoaDon, TrangThaiTT, SoLanIn, DaInTamTinh`,
                    [maHoaDon, tenantId]
                );
                const hd = upd.rows[0];
                const soLanIn = Number(hd.solanin || 1);
                const laTamTinh = Number(hd.trangthaitt) === 0;
                const laBanSao = soLanIn >= 2;
                const reprintBanner = laBanSao ? `*** BAN SAO - REPRINT LAN ${soLanIn} ***` : null;

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    nguoiDuyet,
                    hanhDong: laBanSao ? 'RECEIPT_REPRINT' : laTamTinh ? 'PREBILL_PRINT' : 'RECEIPT_PRINT',
                    doiTuong: 'HOADON',
                    maDoiTuong: maHoaDon,
                    giaTriMoi: { soLanIn, laBanSao, laTamTinh, reprintBanner },
                    lyDo: lyDo ? String(lyDo).trim().slice(0, 255) : laBanSao ? `In lại hóa đơn lần ${soLanIn}` : null,
                    ip: req.ip,
                    batBuoc: true,
                });

                if (laBanSao && typeof ghiCanhBaoGianLan === 'function') {
                    await ghiCanhBaoGianLan(client, {
                        tenantId,
                        loaiCanhBao: 'RECEIPT_REPRINT',
                        mucDo: soLanIn >= 3 ? 'HIGH' : 'MEDIUM',
                        maNV: req.user.maNV,
                        maDoiTuong: maHoaDon,
                        moTa: `Nhân viên ${req.user.maNV} in lại hóa đơn #${maHoaDon} (Lần ${soLanIn})`,
                        duLieu: { maHoaDon, soLanIn, nguoiDuyet, lyDo: lyDo || null },
                    }).catch(() => {});
                }

                return {
                    maHoaDon,
                    soLanIn,
                    laBanSao,
                    laTamTinh,
                    reprintBanner,
                    printToken: `PRT-${maHoaDon}-${soLanIn}-${Date.now()}`,
                    issuedAt: new Date().toISOString(),
                };
            }, tenantId);

            res.json(ketQua);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Cấp lệnh in hóa đơn (Print Token):');
        }
    }

    app.post('/api/order/:maHoaDon/print-token', kiemTraToken, choPhepVaiTro(1, 3, 4), handleIssuePrintToken);
    app.post('/api/hoadon/:maHoaDon/in', kiemTraToken, choPhepVaiTro(1, 4), handleIssuePrintToken);

    // =========================================================================
    // 7. ĐỔI MÓN SAU THANH TOÁN / ĐANG MỞ CHỐNG RACE CONDITION (HỢP NHẤT /api/order/item-swap & /api/order/:maHoaDon/doi-mon)
    //    - Khóa FOR UPDATE
    //    - Đang làm / Đã xong -> 409 ITEM_ALREADY_STARTED trừ khi forceWasteIfInProgress + PIN/Manager
    //    - 3 nhánh tài chính: delta > 0 (Order_Payments), delta < 0 (order_refunds + REFUNDED/VI_KHACH), delta === 0
    // =========================================================================
    async function handleItemSwap(req, res) {
        const tenantId = layTenantId(req);
        const body = req.body || {};
        const expectedMaHoaDon = req.params.maHoaDon ? String(req.params.maHoaDon).trim() : null;
        const maCTHD = body.maCTHD;
        const newItem =
            body.newItem ||
            (body.maMonMoi
                ? {
                      maMon: body.maMonMoi,
                      kichThuoc: body.kichThuocMoi,
                      soLuong: body.soLuongMoi,
                      ghiChu: body.ghiChuMoi,
                      toppings: body.toppingsMoi,
                  }
                : null);
        const lyDo = body.lyDo || 'Khách yêu cầu đổi món';
        const phuongThucBuHoan = body.phuongThucBuHoan || body.phuongThucTTChenhLech || 'TIEN_MAT';
        const forceWasteIfInProgress = Boolean(body.forceWasteIfInProgress);
        const managerPin = body.managerPin || null;
        const maNVDuyet = body.maNVDuyet || null;

        if (!maCTHD || !newItem || !newItem.maMon) {
            return res.status(400).json({ message: 'Vui lòng cung cấp maCTHD và thông tin món mới (newItem.maMon)!' });
        }

        const cleanPhuongThuc = ['TIEN_MAT', 'CHUYEN_KHOAN', 'THE', 'VI_KHACH'].includes(String(phuongThucBuHoan || '').toUpperCase())
            ? String(phuongThucBuHoan).toUpperCase()
            : 'TIEN_MAT';

        try {
            const ketQua = await chayGiaoDich(async (client) => {
                // 1. Khóa chặt dòng món cũ + hóa đơn bằng FOR UPDATE chống Race Condition với Barista
                const cRes = await client.query(
                    `SELECT c.MaCTHD, c.MaHoaDon, c.MaMon, c.KichThuoc, c.SoLuong, c.DonGia,
                            COALESCE((to_jsonb(c)->>'giamodifiers')::numeric, 0) AS GiaModifiers,
                            COALESCE((to_jsonb(c)->>'giagiam')::numeric, 0) AS GiaGiam,
                            c.TrangThaiPhaChe, c.DotGoi,
                            COALESCE(to_jsonb(sp)->>'tramchebien', '') AS TramCheBienCu,
                            sp.TenMon AS TenMonCu, sp.NhomMon AS NhomMonCu,
                            COALESCE((to_jsonb(sp)->>'lahangdonggoi')::boolean, FALSE) AS LaHangDongGoiCu,
                            hd.TrangThaiTT, hd.MaKH, hd.TongTienThanhToan, hd.MaCaThuNgan,
                            COALESCE(NULLIF(to_jsonb(hd)->>'branchid', ''), 'DEFAULT') AS BranchId
                       FROM ChiTietHoaDon c
                       JOIN HoaDon hd ON hd.MaHoaDon = c.MaHoaDon
                       JOIN SanPham sp ON sp.MaMon = c.MaMon
                      WHERE c.MaCTHD = $1
                        AND COALESCE(hd.TenantId, 'DEFAULT') = $2
                        AND ($3::text IS NULL OR c.MaHoaDon::text = $3::text)
                      FOR UPDATE OF c, hd`,
                    [maCTHD, tenantId, expectedMaHoaDon]
                );
                if (cRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy món cần đổi!');
                const oldItem = cRes.rows[0];

                if (oldItem.trangthaiphache === 'DaHuy') {
                    throw new LoiNghiepVu(409, 'Món này đã bị hủy trước đó, không thể đổi!');
                }
                if (Number(oldItem.trangthaitt) === 2) {
                    throw new LoiNghiepVu(409, 'Hóa đơn này đã hoàn tiền toàn bộ, không thể đổi món!');
                }

                const daBatDauPha = ['DangLam', 'DaXong', 'DaPhucVu'].includes(oldItem.trangthaiphache);
                let nguoiDuyet = req.user.maNV;
                if (daBatDauPha) {
                    if (!forceWasteIfInProgress) {
                        throw new LoiNghiepVu(
                            409,
                            `Barista đã bắt đầu pha món "${oldItem.tenmoncu}" (${oldItem.trangthaiphache})! Cần xác nhận hủy hao hụt (forceWasteIfInProgress) + quyền Quản lý để đổi.`,
                            {
                                code: 'ITEM_ALREADY_STARTED',
                                maLoi: 'ITEM_ALREADY_STARTED',
                                trangThaiHienTai: oldItem.trangthaiphache,
                            }
                        );
                    }
                    const tuDuQuyen = coQuyenHan(req.user, 'order.item.void_approve');
                    if (!tuDuQuyen) {
                        const mgr = managerPin
                            ? await xacThucPinQuanLy(client, tenantId, managerPin, req.ip, maNVDuyet, 'order.item.void_approve')
                            : null;
                        if (!mgr) {
                            throw new LoiNghiepVu(
                                403,
                                'Đổi món đang pha/đã xong yêu cầu mã PIN Quản lý hoặc Ca trưởng để xác nhận hao hụt!',
                                { maLoi: 'CAN_PIN_QUAN_LY' }
                            );
                        }
                        nguoiDuyet = mgr.maNV;
                    }
                }

                // 2. Tính tổng tiền dòng món cũ (bao gồm modifiers + toppings)
                const oldTpRes = await client.query(
                    `SELECT COALESCE(SUM(SoLuong * DonGia), 0) AS tong_tp FROM ChiTietHoaDon_Topping WHERE MaCTHD = $1`,
                    [maCTHD]
                );
                const giaCu =
                    (Number(oldItem.dongia) + Number(oldItem.giamodifiers || 0)) * Number(oldItem.soluong) -
                    Number(oldItem.giagiam || 0) +
                    Number(oldTpRes.rows[0]?.tong_tp || 0);

                // 3. Tra cứu thông tin & giá món mới từ Server (chống client giả mạo giá)
                const newSize = String(newItem.kichThuoc || oldItem.kichthuoc || 'M').trim().toUpperCase();
                const newQty = Math.max(1, Math.floor(Number(newItem.soLuong || oldItem.soluong || 1)));
                const spMoiRes = await client.query(
                    `SELECT sp.MaMon, sp.TenMon, sp.NhomMon, COALESCE(sp.TamHet, FALSE) AS TamHet,
                            COALESCE(to_jsonb(sp)->>'tramchebien', '') AS TramCheBien,
                            sz.GiaBan
                       FROM SanPham sp
                       JOIN SanPham_Size sz ON sz.MaMon = sp.MaMon AND sz.KichThuoc = $2
                      WHERE sp.MaMon = $1
                        AND sp.DangKinhDoanh = TRUE
                        AND COALESCE(sp.TenantId, 'DEFAULT') = $3`,
                    [newItem.maMon, newSize, tenantId]
                );
                if (spMoiRes.rows.length === 0) {
                    throw new LoiNghiepVu(400, `Món mới ${newItem.maMon} (size ${newSize}) không tồn tại hoặc đã ngừng bán!`);
                }
                const spMoi = spMoiRes.rows[0];
                if (spMoi.tamhet) {
                    throw new LoiNghiepVu(409, `Món mới "${spMoi.tenmon}" hiện đang tạm hết (86'd)!`, { maLoi: 'MON_TAM_HET' });
                }

                // Tính topping món mới (nếu có)
                const newToppings = [];
                let tongTienTpMoi = 0;
                const bomMoiMap = new Map();
                const ctMoiRes = await client.query(
                    `SELECT ct.MaNL, ct.KhoiLuongTieuHao, COALESCE(nl.GiaVonDonVi, 0) AS GiaVonDonVi
                       FROM CongThuc ct LEFT JOIN NguyenLieu nl ON nl.MaNL = ct.MaNL
                      WHERE ct.MaMon = $1 AND ct.KichThuoc = $2`,
                    [spMoi.mamon, newSize]
                );
                let giaVonMotLyMoi = 0;
                for (const r of ctMoiRes.rows) {
                    const kl = Number(r.khoiluongtieuhao || 0);
                    if (kl > 0) {
                        bomMoiMap.set(r.manl, lam3((bomMoiMap.get(r.manl) || 0) + kl * newQty));
                        giaVonMotLyMoi += kl * Number(r.giavondonvi || 0);
                    }
                }
                for (const tp of Array.isArray(newItem.toppings) ? newItem.toppings : []) {
                    if (!tp?.maTopping) continue;
                    const tpRes = await client.query(
                        `SELECT t.MaTopping, t.TenTopping, t.GiaTopping, t.MaNL, COALESCE(t.KhoiLuongTieuHao, 0) AS KhoiLuongTieuHao,
                                COALESCE(t.TamHet, FALSE) AS TamHet, COALESCE(nl.GiaVonDonVi, 0) AS GiaVonDonVi
                           FROM Topping t LEFT JOIN NguyenLieu nl ON nl.MaNL = t.MaNL
                          WHERE t.MaTopping = $1 AND t.DangKinhDoanh = TRUE AND COALESCE(t.TenantId, 'DEFAULT') = $2`,
                        [tp.maTopping, tenantId]
                    );
                    if (tpRes.rows.length === 0) continue;
                    const tRow = tpRes.rows[0];
                    if (tRow.tamhet) throw new LoiNghiepVu(409, `Topping "${tRow.tentopping}" đang tạm hết!`);
                    const perCup = Math.max(1, Math.floor(Number(tp.soLuongMoiLy ?? tp.soLuong ?? 1)));
                    const totalTpQty = perCup * newQty;
                    const donGiaTp = Number(tRow.giatopping || 0);
                    tongTienTpMoi += donGiaTp * totalTpQty;
                    newToppings.push({
                        maTopping: tRow.matopping,
                        tenTopping: tRow.tentopping,
                        soLuongMoiLy: perCup,
                        soLuong: totalTpQty,
                        donGia: donGiaTp,
                    });
                    if (tRow.manl && Number(tRow.khoiluongtieuhao) > 0) {
                        bomMoiMap.set(tRow.manl, lam3((bomMoiMap.get(tRow.manl) || 0) + Number(tRow.khoiluongtieuhao) * totalTpQty));
                        giaVonMotLyMoi += Number(tRow.khoiluongtieuhao) * perCup * Number(tRow.giavondonvi || 0);
                    }
                }

                const donGiaMoi = Number(spMoi.giaban);
                const giaMoi = donGiaMoi * newQty + tongTienTpMoi;
                const chenhLech = Math.round((giaMoi - giaCu) * 100) / 100;

                // 4. Xử lý kho cho món cũ: ChoPhaChe hoặc hàng đóng gói -> Hoàn kho (LoaiGD=7); Đã bắt đầu pha -> Hao hụt (LoaiGD=8)
                const tieuHaoCu = new Map();
                await congDinhLuongNguyenLieuDongMon(
                    client,
                    tenantId,
                    { maCTHD, maMon: oldItem.mamon, kichThuoc: oldItem.kichthuoc, soLuong: oldItem.soluong },
                    tieuHaoCu
                );
                const hoanKhoMonCu =
                    oldItem.trangthaiphache !== 'DaPhucVu' &&
                    (!daBatDauPha || Boolean(oldItem.lahangdonggoicu));
                const bIdStock = normalizeBranchId(oldItem.branchid || req.user?.branchId || 'DEFAULT');
                const adjustBranchStock = async (maNL, deltaQty) => {
                    await client.query('SAVEPOINT sp_swap_branch_stock');
                    try {
                        const tkUpd = await client.query(
                            `UPDATE public.tonkhochinhanh
                                SET soluongton = COALESCE(soluongton, 0) + $1,
                                    capnhatluc = now()
                              WHERE tenantid = $2 AND branchid = $3 AND manl = $4
                              RETURNING soluongton`,
                            [deltaQty, tenantId, bIdStock, maNL]
                        );
                        if (tkUpd.rows.length === 0) {
                            await client.query(
                                `INSERT INTO public.tonkhochinhanh (tenantid, branchid, manl, soluongton, capnhatluc)
                                 VALUES ($1, $2, $3, $4, now())
                                 ON CONFLICT (branchid, manl) DO UPDATE
                                     SET soluongton = COALESCE(public.tonkhochinhanh.soluongton, 0) + $4,
                                         capnhatluc = now()`,
                                [tenantId, bIdStock, maNL, deltaQty]
                            );
                        }
                        await client.query('RELEASE SAVEPOINT sp_swap_branch_stock');
                    } catch {
                        await client.query('ROLLBACK TO SAVEPOINT sp_swap_branch_stock').catch(() => {});
                        await client.query(
                            "UPDATE NguyenLieu SET SoLuongTon = SoLuongTon + $1 WHERE MaNL = $2 AND COALESCE(TenantId, 'DEFAULT') = $3",
                            [deltaQty, maNL, tenantId]
                        );
                    }
                };
                const giaVonCuMap = await layMapGiaVonNguyenLieu(client, tenantId, [...tieuHaoCu.keys()]);
                if (tieuHaoCu.size > 0) {
                    const phieuCu = await client.query(
                        'INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId) VALUES ($1, $2, $3, $4) RETURNING MaGiaoDich',
                        [
                            req.user.maNV,
                            hoanKhoMonCu ? LOAI_GD_HOAN_KHO : LOAI_GD_HAO_HUT_HUY_MON,
                            `${hoanKhoMonCu ? 'Hoàn kho' : 'Hao hụt'} đổi món HĐ ${oldItem.mahoadon}: ${oldItem.tenmoncu} -> ${spMoi.tenmon}`,
                            tenantId,
                        ]
                    );
                    const maGDCu = phieuCu.rows[0].magiaodich;
                    for (const [maNL, sl] of [...tieuHaoCu].sort((a, b) => a[0].localeCompare(b[0]))) {
                        const qty = lam3(sl);
                        await client.query(
                            `INSERT INTO ChiTietGiaoDichKho (MaGiaoDich, MaNL, SoLuong, DonGiaNhap, TinhTrang)
                             VALUES ($1, $2, $3, $4, $5)`,
                            [maGDCu, maNL, qty, giaVonCuMap.get(maNL) || 0, hoanKhoMonCu ? 'Hoàn kho đổi món' : 'Hao hụt đổi món đã pha']
                        );
                        if (hoanKhoMonCu) {
                            await adjustBranchStock(maNL, qty);
                        }
                    }
                }

                // 5. Hủy dòng món cũ & tạo dòng món mới + Trừ kho BOM món mới (LoaiGD=6)
                const ghiChuHuy = `[ĐỔI MÓN -> ${spMoi.tenmon}] ${String(lyDo || '').trim()}`.slice(0, 255);
                await client.query(
                    `UPDATE ChiTietHoaDon SET TrangThaiPhaChe = 'DaHuy', LyDoHuy = $2 WHERE MaCTHD = $1`,
                    [maCTHD, ghiChuHuy]
                );

                const cMoiIns = await client.query(
                    `INSERT INTO ChiTietHoaDon
                        (MaHoaDon, MaMon, TenMonSnapshot, KichThuoc, SoLuong, DonGia, GiaVonSnapshot,
                         GhiChu, TrangThaiPhaChe, DotGoi, FireStatus, FiredAt, MucDoUuTien)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ChoPhaChe', $9, 'FIRED', now(), 1)
                     RETURNING MaCTHD`,
                    [
                        oldItem.mahoadon,
                        spMoi.mamon,
                        spMoi.tenmon,
                        newSize,
                        newQty,
                        donGiaMoi,
                        Math.round(giaVonMotLyMoi * 100) / 100,
                        newItem.ghiChu ? `[ĐỔI MÓN] ${String(newItem.ghiChu).trim()}`.slice(0, 255) : `[ĐỔI TỪ ${oldItem.tenmoncu}]`.slice(0, 255),
                        Number(oldItem.dotgoi || 1),
                    ]
                );
                const newMaCTHD = cMoiIns.rows[0].macthd;
                for (const tp of newToppings) {
                    await client.query(
                        `INSERT INTO ChiTietHoaDon_Topping (MaCTHD, MaTopping, TenToppingSnapshot, SoLuong, SoLuongMoiLy, DonGia)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [newMaCTHD, tp.maTopping, tp.tenTopping, tp.soLuong, tp.soLuongMoiLy, tp.donGia]
                    );
                }

                if (bomMoiMap.size > 0) {
                    const giaVonMoiMap = await layMapGiaVonNguyenLieu(client, tenantId, [...bomMoiMap.keys()]);
                    const phieuMoi = await client.query(
                        'INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId) VALUES ($1, $2, $3, $4) RETURNING MaGiaoDich',
                        [req.user.maNV, LOAI_GD_BAN_HANG, `Xuất kho món đổi HĐ ${oldItem.mahoadon}: ${spMoi.tenmon}`, tenantId]
                    );
                    const maGDMoi = phieuMoi.rows[0].magiaodich;
                    for (const [maNL, sl] of [...bomMoiMap].sort((a, b) => a[0].localeCompare(b[0]))) {
                        const qty = lam3(sl);
                        await client.query(
                            `INSERT INTO ChiTietGiaoDichKho (MaGiaoDich, MaNL, SoLuong, DonGiaNhap, TinhTrang)
                             VALUES ($1, $2, $3, $4, 'Xuất bán đổi món')`,
                            [maGDMoi, maNL, qty, giaVonMoiMap.get(maNL) || 0]
                        );
                        await adjustBranchStock(maNL, -qty);
                    }
                }

                // 6. Xử lý 3 nhánh Tài chính (bù tiền / hoàn tiền / ngang giá) nếu hóa đơn đã thanh toán
                const ca = await layCaDangMo(client, tenantId).catch(() => null);
                const maCa = ca?.macathungan || oldItem.macathungan || null;
                let financialAction = 'EVEN';
                let refundRecordId = null;

                if (Number(oldItem.trangthaitt) === 1 && chenhLech !== 0) {
                    if (chenhLech > 0) {
                        financialAction = 'COLLECT_EXTRA';
                        await client.query(
                            `INSERT INTO Order_Payments
                                (MaHoaDon, MaCaThuNgan, PhuongThucTT, SoTien, TienKhachDua, TienThua, TrangThai, NguonXacNhan, MaNV, TenantId)
                             VALUES ($1, $2, $3, $4, $4, 0, 'PAID', 'ITEM_SWAP_EXTRA', $5, $6)`,
                            [
                                String(oldItem.mahoadon),
                                maCa ? String(maCa) : null,
                                cleanPhuongThuc === 'VI_KHACH' ? 'TIEN_MAT' : cleanPhuongThuc,
                                chenhLech,
                                String(req.user.maNV),
                                tenantId,
                            ]
                        );
                        await client.query(
                            `UPDATE HoaDon SET TongTienThanhToan = COALESCE(TongTienThanhToan, 0) + $2, Version = COALESCE(Version, 1) + 1
                              WHERE MaHoaDon = $1`,
                            [oldItem.mahoadon, chenhLech]
                        );
                    } else {
                        financialAction = 'REFUND_DIFF';
                        const soTienHoan = Math.abs(chenhLech);
                        const refRes = await client.query(
                            `INSERT INTO public.order_refunds
                                (tenantid, mahoadon, macathungan, macathunganbangoc, phuongthuchoan, sotienhoan, lydo, manv, manvthuchien, nguoiduyet)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text, $9::varchar, $10)
                             RETURNING id`,
                            [
                                tenantId,
                                oldItem.mahoadon,
                                maCa ? String(maCa) : null,
                                oldItem.macathungan ? String(oldItem.macathungan) : null,
                                cleanPhuongThuc,
                                soTienHoan,
                                `Hoàn chênh lệch đổi món: ${oldItem.tenmoncu} -> ${spMoi.tenmon} (${String(lyDo || '').trim()})`,
                                String(req.user.maNV),
                                String(req.user.maNV),
                                String(nguoiDuyet || req.user.maNV),
                            ]
                        );
                        refundRecordId = Number(refRes.rows[0].id);

                        if (cleanPhuongThuc === 'VI_KHACH' && oldItem.makh) {
                            await client.query('SAVEPOINT sp_swap_wallet');
                            try {
                                const wRes = await client.query(
                                    `UPDATE KhachHang SET SoDuVi = COALESCE(SoDuVi, 0) + $2
                                      WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $3
                                      RETURNING SoDuVi`,
                                    [oldItem.makh, soTienHoan, tenantId]
                                );
                                if (wRes.rows.length > 0) {
                                    await client.query(
                                        `INSERT INTO KhachHang_GiaoDichVi (TenantId, MaKH, LoaiGD, SoTien, SoDuSau, MaHoaDon, MaNV, GhiChu)
                                         VALUES ($1, $2, 'REFUND_SWAP', $3, $4, $5, $6, $7)`,
                                        [
                                            tenantId,
                                            oldItem.makh,
                                            soTienHoan,
                                            Number(wRes.rows[0].soduvi),
                                            oldItem.mahoadon,
                                            req.user.maNV,
                                            `Hoàn ví chênh lệch đổi món HĐ ${oldItem.mahoadon}`,
                                        ]
                                    );
                                }
                                await client.query('RELEASE SAVEPOINT sp_swap_wallet');
                            } catch {
                                await client.query('ROLLBACK TO SAVEPOINT sp_swap_wallet').catch(() => {});
                            }
                        }

                        await client.query(
                            `UPDATE HoaDon SET TongTienThanhToan = GREATEST(0, COALESCE(TongTienThanhToan, 0) - $2), Version = COALESCE(Version, 1) + 1
                              WHERE MaHoaDon = $1`,
                            [oldItem.mahoadon, soTienHoan]
                        );
                    }
                } else {
                    await client.query(`UPDATE HoaDon SET Version = COALESCE(Version, 1) + 1 WHERE MaHoaDon = $1`, [oldItem.mahoadon]);
                }

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    nguoiDuyet,
                    hanhDong: 'ITEM_SWAPPED',
                    doiTuong: 'CHITIETHOADON',
                    maDoiTuong: maCTHD,
                    giaTriCu: { maCTHD, maMon: oldItem.mamon, tenMon: oldItem.tenmoncu, giaCu, trangThaiPhaChe: oldItem.trangthaiphache },
                    giaTriMoi: { newMaCTHD, maMon: spMoi.mamon, tenMon: spMoi.tenmon, giaMoi, chenhLech, financialAction, hoanKhoMonCu, refundRecordId },
                    lyDo: String(lyDo || '').trim(),
                    ip: req.ip,
                    batBuoc: true,
                });

                const [monMoi] = await layMonTheoMa(client, [newMaCTHD]);
                const oldStation = suyLuanTramCheBien({
                    tramCheBien: oldItem.tramchebiencu,
                    nhomMon: oldItem.nhommoncu,
                    tenMon: oldItem.tenmoncu,
                });
                const newStation = monMoi?.tramCheBien || suyLuanTramCheBien({
                    tramCheBien: spMoi.tramchebien,
                    nhomMon: spMoi.nhommon,
                    tenMon: spMoi.tenmon,
                });
                const bId = normalizeBranchId(oldItem.branchid || 'DEFAULT');

                const swapPayload = {
                    maHoaDon: oldItem.mahoadon,
                    oldMaCTHD: maCTHD,
                    oldTenMon: oldItem.tenmoncu,
                    oldStation,
                    newMaCTHD,
                    newStation,
                    monMoi,
                    requiresAck: true,
                    lyDo: String(lyDo || '').trim(),
                };

                // Ghi event log cho cả trạm cũ & trạm mới (nếu khác trạm)
                const stationsToNotify = [...new Set([oldStation, newStation])];
                const seqs = [];
                for (const st of stationsToNotify) {
                    const logInfo = await insertKdsEventLog(client, {
                        tenantId,
                        branchId: bId,
                        station: st,
                        eventType: 'ITEM_SWAP',
                        maHoaDon: oldItem.mahoadon,
                        payload: swapPayload,
                    });
                    seqs.push({ station: st, seq: logInfo.seq });
                }

                return {
                    maHoaDon: oldItem.mahoadon,
                    oldMaCTHD: maCTHD,
                    newMaCTHD,
                    giaCu,
                    giaMoi,
                    chenhLech,
                    financialAction,
                    hoanKhoMonCu,
                    refundRecordId,
                    branchId: bId,
                    swapPayload,
                    seqs,
                    monMoi,
                    hoaDon: await layHoaDonChiTiet(client, oldItem.mahoadon),
                };
            }, tenantId);

            for (const { station, seq } of ketQua.seqs) {
                emitScopedKdsEvent(io, {
                    tenantId,
                    branchId: ketQua.branchId,
                    station,
                    seq,
                    eventType: 'ITEM_SWAP',
                    socketEvents: ['kds:item_swapped', 'MON_BI_HUY'],
                    payload: ketQua.swapPayload,
                    includeExpo: true,
                    includeWaiter: true,
                    includePos: true,
                    legacyBaristaEvent: 'kds:item_swapped',
                    legacyWaiterEvent: 'kds:item_swapped',
                    legacyPosEvent: 'kds:item_swapped',
                });
            }
            if (ketQua.financialAction && ketQua.financialAction !== 'EVEN') {
                emitScopedKdsEvent(io, {
                    tenantId,
                    branchId: ketQua.branchId,
                    station: 'ALL',
                    eventType: 'SHIFT_UPDATED',
                    socketEvents: ['CA_THAY_DOI'],
                    payload: { trangThai: 'CAP_NHAT' },
                    includePos: true,
                    legacyPosEvent: 'CA_THAY_DOI',
                });
            }

            res.json({
                message:
                    ketQua.chenhLech > 0
                        ? `🔄 Đã đổi món thành công! Thu bù thêm ${ketQua.chenhLech.toLocaleString('vi-VN')}đ.`
                        : ketQua.chenhLech < 0
                        ? `🔄 Đã đổi món thành công! Hoàn lại ${Math.abs(ketQua.chenhLech).toLocaleString('vi-VN')}đ.`
                        : '🔄 Đã đổi món thành công (ngang giá)!',
                ...ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Đổi món (Item Swap):');
        }
    }

    app.post('/api/order/item-swap', kiemTraToken, choPhepVaiTro(1, 4), handleItemSwap);
    app.post('/api/order/:maHoaDon/doi-mon', kiemTraToken, choPhepVaiTro(1, 4), handleItemSwap);

    // =========================================================================
    // 8. ĐỘNG CƠ 86'ING TOÀN DIỆN 5 LỚP (POST /api/kho/ingredient-86)
    // =========================================================================
    app.post('/api/kho/ingredient-86', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
        const tenantId = layTenantId(req);
        const { maNL, action = 'LOCK', branchId = 'DEFAULT' } = req.body || {};
        if (!maNL) return res.status(400).json({ message: 'Thiếu mã nguyên liệu (maNL)!' });
        const act = String(action || 'LOCK').toUpperCase() === 'UNLOCK' ? 'UNLOCK' : 'LOCK';
        const bId = normalizeBranchId(branchId || req.user.branchId || 'DEFAULT');

        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const nlRes = await client.query(
                    `SELECT MaNL, TenNL, SoLuongTon FROM NguyenLieu
                      WHERE MaNL = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2`,
                    [maNL, tenantId]
                );
                if (nlRes.rows.length === 0) throw new LoiNghiepVu(404, `Không tìm thấy nguyên liệu ${maNL}!`);

                const cascade = await cascadeIngredient86(client, {
                    tenantId,
                    branchId: bId,
                    maNL,
                    action: act,
                    updatedBy: req.user.maNV,
                });

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: act === 'LOCK' ? 'INGREDIENT_86_LOCK_5LAYER' : 'INGREDIENT_86_UNLOCK_5LAYER',
                    doiTuong: 'NGUYENLIEU',
                    maDoiTuong: maNL,
                    giaTriMoi: {
                        tenNL: nlRes.rows[0].tennl,
                        action: act,
                        cascadedSubRecipes: cascade.cascadedSubRecipes,
                        products: cascade.affectedProducts.map((p) => p.maMon),
                        toppings: cascade.affectedToppings.map((t) => t.maTopping),
                        modifiers: cascade.affectedModifiers.map((m) => m.optionId),
                        combos: cascade.affectedCombos.map((c) => c.maCombo),
                    },
                    ip: req.ip,
                    batBuoc: true,
                });

                const logInfo = await insertKdsEventLog(client, {
                    tenantId,
                    branchId: bId,
                    station: 'ALL',
                    eventType: 'MENU_86',
                    payload: { maNL, tenNL: nlRes.rows[0].tennl, action: act, ...cascade },
                });

                return { tenNL: nlRes.rows[0].tennl, ...cascade, seq: logInfo.seq };
            }, tenantId);

            // [Wave 3A — P1-03] Đồng bộ cô lập 3 tầng theo đúng Chi nhánh (không leak sang phòng 2 tầng legacy)
            emitScopedKdsEvent(io, {
                tenantId,
                branchId: bId,
                station: 'ALL',
                seq: ketQua.seq,
                eventType: 'MENU_86',
                socketEvents: ['menu:86_updated'],
                payload: ketQua,
                includeExpo: true,
                includeWaiter: true,
                includePos: true,
                includeQr: true,
            });
            for (const p of ketQua.affectedProducts) {
                emitScopedKdsEvent(io, {
                    tenantId,
                    branchId: bId,
                    station: 'ALL',
                    eventType: 'THUC_DON_THAY_DOI',
                    socketEvents: ['THUC_DON_THAY_DOI'],
                    payload: p,
                    includeExpo: true,
                    includeWaiter: true,
                    includePos: true,
                    includeQr: true,
                });
            }

            res.json({
                message:
                    act === 'LOCK'
                        ? `🚫 Đã khóa 86'ing 5 lớp cho "${ketQua.tenNL}" (${ketQua.affectedProducts.length} món, ${ketQua.affectedToppings.length} topping, ${ketQua.affectedModifiers.length} tùy chọn, ${ketQua.affectedCombos.length} combo)!`
                        : `✅ Đã mở khóa tự động 5 lớp cho "${ketQua.tenNL}"!`,
                ...ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Cascade 86 nguyên liệu:');
        }
    });

    // =========================================================================
    // [Wave 3A — P1-03] PATCH /api/order/:maHoaDon/rush — Đặt/Gỡ ưu tiên GẤP (Rush Order)
    // =========================================================================
    app.patch('/api/order/:maHoaDon/rush', kiemTraToken, choPhepVaiTro(1, 2, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const { maHoaDon } = req.params;
        const rush = req.body?.rush !== undefined ? Boolean(req.body.rush) : true;
        const priority = rush ? Math.max(1, Number(req.body?.priority || 2)) : 0;
        const lyDo = String(req.body?.lyDo || (rush ? 'Đánh dấu đơn GẤP (Rush)' : 'Gỡ cờ GẤP')).trim().slice(0, 200);

        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const hdRes = await client.query(
                    `SELECT MaHoaDon,
                            COALESCE(NULLIF(to_jsonb(HoaDon)->>'branchid', ''), $3) AS BranchId
                       FROM public.HoaDon
                      WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
                    [maHoaDon, tenantId, normalizeBranchId(req.user?.branchId || 'DEFAULT')]
                );
                if (hdRes.rows.length === 0) {
                    throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn!');
                }
                const branchId = normalizeBranchId(hdRes.rows[0].branchid || 'DEFAULT');

                const updRes = await client.query(
                    `UPDATE public.ChiTietHoaDon c
                        SET MucDoUuTien = $2
                       FROM public.SanPham sp
                      WHERE c.MaMon = sp.MaMon
                        AND c.MaHoaDon = $1
                        AND c.TrangThaiPhaChe NOT IN ('DaHuy', 'DaXong', 'DaPhucVu')
                      RETURNING c.MaCTHD, c.MaMon, sp.TenMon, sp.NhomMon,
                                COALESCE(to_jsonb(sp)->>'tramchebien', '') AS TramCheBien`,
                    [maHoaDon, priority]
                );

                const stations = [
                    ...new Set(
                        updRes.rows.map((r) =>
                            suyLuanTramCheBien({
                                tramCheBien: r.tramchebien,
                                nhomMon: r.nhommon,
                                tenMon: r.tenmon,
                            })
                        )
                    ),
                ];
                if (stations.length === 0) stations.push('ALL');

                const payload = {
                    maHoaDon,
                    branchId,
                    rush,
                    mucDoUuTien: priority,
                    updatedMaCTHD: updRes.rows.map((r) => r.macthd),
                    updatedBy: req.user?.maNV || 'SYSTEM',
                    lyDo,
                    updatedAt: new Date().toISOString(),
                };

                const seqs = [];
                for (const st of stations) {
                    const logInfo = await insertKdsEventLog(client, {
                        tenantId,
                        branchId,
                        station: st,
                        eventType: 'ORDER_RUSH_UPDATED',
                        maHoaDon,
                        payload,
                    });
                    seqs.push({ station: st, seq: logInfo.seq });
                }

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user?.maNV || 'SYSTEM',
                    vaiTro: req.user?.vaiTro,
                    hanhDong: rush ? 'ORDER_RUSH_SET' : 'ORDER_RUSH_CLEARED',
                    doiTuong: 'HOADON',
                    maDoiTuong: maHoaDon,
                    giaTriMoi: { rush, mucDoUuTien: priority, count: updRes.rows.length },
                    lyDo,
                    ip: req.ip,
                });

                return { ...payload, stations, seqs };
            }, tenantId);

            for (const { station, seq } of ketQua.seqs) {
                emitScopedKdsEvent(io, {
                    tenantId,
                    branchId: ketQua.branchId,
                    station,
                    seq,
                    eventType: 'ORDER_RUSH_UPDATED',
                    socketEvents: ['ORDER_RUSH_UPDATED'],
                    payload: ketQua,
                    includeExpo: true,
                    includeWaiter: true,
                    includePos: true,
                });
            }

            return res.json({
                message: rush
                    ? `🔥 Đã đặt ưu tiên GẤP cho ${ketQua.updatedMaCTHD.length} món thuộc đơn #${maHoaDon}!`
                    : `Đã gỡ ưu tiên GẤP cho đơn #${maHoaDon}!`,
                ...ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Đặt ưu tiên GẤP (Rush Order):');
        }
    });

    // =========================================================================
    // 9. COUNTDOWN 86 STOCK CHO MÓN GIỚI HẠN TRONG NGÀY (PUT /api/sanpham/:maMon/countdown)
    // =========================================================================
    app.put('/api/sanpham/:maMon/countdown', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
        const tenantId = layTenantId(req);
        const { maMon } = req.params;
        const rawVal = req.body?.soLuongGioiHan86;
        const qty = rawVal === null || rawVal === '' || rawVal === undefined ? null : Math.floor(Number(rawVal));
        if (qty !== null && (!Number.isInteger(qty) || qty < 0)) {
            return res.status(400).json({ message: 'soLuongGioiHan86 phải là số nguyên >= 0 hoặc null!' });
        }

        try {
            const updated = await chayGiaoDich(async (client) => {
                const r = await client.query(
                    `UPDATE public.sanpham
                        SET soluonggioihan86 = $2::int,
                            tamhet = CASE
                                WHEN $2::int IS NULL THEN tamhet
                                WHEN $2::int = 0 THEN TRUE
                                ELSE FALSE
                            END,
                            tamhettudong = CASE
                                WHEN $2::int IS NOT NULL AND $2::int > 0 THEN FALSE
                                ELSE tamhettudong
                            END
                      WHERE mamon = $1 AND COALESCE(tenantid, 'DEFAULT') = $3
                      RETURNING mamon, tenmon, tamhet, soluonggioihan86`,
                    [maMon, qty, tenantId]
                );
                if (r.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy món cần cài Countdown 86!');
                return {
                    maMon: r.rows[0].mamon,
                    tenMon: r.rows[0].tenmon,
                    tamHet: Boolean(r.rows[0].tamhet),
                    soLuongGioiHan86: r.rows[0].soluonggioihan86 === null ? null : Number(r.rows[0].soluonggioihan86),
                };
            }, tenantId);

            io.to(roomTen(tenantId, 'thungan'))
                .to(roomTen(tenantId, 'phucvu'))
                .to(roomTen(tenantId, 'barista'))
                .emit('THUC_DON_THAY_DOI', updated);
            io.to(roomTen(tenantId, 'thungan'))
                .to(roomTen(tenantId, 'phucvu'))
                .to(roomTen(tenantId, 'barista'))
                .emit('menu:86_updated', { type: 'COUNTDOWN', product: updated });

            res.json({
                message:
                    updated.soLuongGioiHan86 === null
                        ? `Đã tắt đếm ngược giới hạn cho "${updated.tenMon}".`
                        : `⏳ Đã cài Countdown 86 = ${updated.soLuongGioiHan86} phần cho "${updated.tenMon}"!`,
                product: updated,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Cài Countdown 86:');
        }
    });

    // =========================================================================
    // 10. HOLD / PARK ORDER ĐA THIẾT BỊ (POST /api/order/park & POST /api/order/:id/resume)
    // =========================================================================
    app.get('/api/order/park', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const rows = await pool.withTenant(tenantId, async (client) => {
                const r = await client.query(
                    `SELECT hd.MaHoaDon, hd.MaNV, hd.MaKH, hd.ThoiGianTao, hd.TenKhachVangLai, hd.LoaiDonHang,
                            COALESCE((SELECT SUM(c.SoLuong) FROM ChiTietHoaDon c WHERE c.MaHoaDon = hd.MaHoaDon), 0) AS TongLy
                       FROM HoaDon hd
                      WHERE COALESCE(hd.TenantId, 'DEFAULT') = $1 AND hd.TrangThaiTT = -1
                      ORDER BY hd.ThoiGianTao DESC LIMIT 50`,
                    [tenantId]
                );
                return r.rows.map((x) => ({
                    maHoaDon: x.mahoadon,
                    maNV: x.manv,
                    maKH: x.makh || null,
                    tenGhiNho: x.tenkhachvanglai || `Đơn nháp #${x.mahoadon}`,
                    loaiDonHang: x.loaidonhang || 'MANG_DI',
                    tongLy: Number(x.tongly || 0),
                    thoiGianTao: x.thoigiantao,
                }));
            });
            res.json(rows);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Danh sách Park Order:');
        }
    });

    app.post('/api/order/park', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const {
            tenGhiNho = null,
            label = null,
            maKH = null,
            loaiDonHang = 'MANG_DI',
            diaChiGiao = null,
            danhSachMon = [],
        } = req.body || {};
        if (!Array.isArray(danhSachMon) || danhSachMon.length === 0) {
            return res.status(400).json({ message: 'Giỏ hàng trống, không thể lưu nháp (Park)!' });
        }
        const memo = String(tenGhiNho || label || '').trim().slice(0, 100) || null;

        try {
            const parked = await chayGiaoDich(async (client) => {
                const hdRes = await client.query(
                    `INSERT INTO HoaDon (MaNV, MaKH, TrangThaiTT, TenantId, LoaiDonHang, TenKhachVangLai, DiaChiGiao)
                     VALUES ($1, $2, -1, $3, $4, $5, $6)
                     RETURNING MaHoaDon, ThoiGianTao`,
                    [
                        req.user.maNV,
                        maKH || null,
                        tenantId,
                        ['TAI_QUAN', 'MANG_DI', 'GIAO_HANG', 'APP_SAN'].includes(loaiDonHang) ? loaiDonHang : 'MANG_DI',
                        memo,
                        diaChiGiao ? String(diaChiGiao).trim().slice(0, 500) : null,
                    ]
                );
                const maHoaDon = hdRes.rows[0].mahoadon;
                for (const m of danhSachMon) {
                    const qty = Math.max(1, Math.floor(Number(m.soLuong || 1)));
                    const cIns = await client.query(
                        `INSERT INTO ChiTietHoaDon
                            (MaHoaDon, MaMon, TenMonSnapshot, TenMonTuyChinh, KichThuoc, SoLuong, DonGia, GiaModifiers,
                             ModifiersSnapshot, TrongLuongGram, GhiChu, TrangThaiPhaChe, IsTakeaway, CourseNo, FireStatus)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, 'ChoPhaChe', $12, $13, 'HELD')
                         RETURNING MaCTHD`,
                        [
                            maHoaDon,
                            m.maMon,
                            m.tenMonTuyChinh || m.tenMon || m.maMon,
                            m.tenMonTuyChinh ? String(m.tenMonTuyChinh).trim().slice(0, 150) : null,
                            m.kichThuoc || 'M',
                            qty,
                            Number(m.donGia || 0),
                            Number(m.giaModifiers || 0),
                            JSON.stringify(Array.isArray(m.modifiers) ? m.modifiers : []),
                            m.trongLuongGram ? Number(m.trongLuongGram) : null,
                            m.ghiChu ? String(m.ghiChu).slice(0, 255) : null,
                            Boolean(m.isTakeaway),
                            Math.max(1, Math.floor(Number(m.courseNo || 1))),
                        ]
                    );
                    const maCTHD = cIns.rows[0].macthd;
                    for (const tp of m.toppings || []) {
                        if (!tp?.maTopping) continue;
                        const perCup = Math.max(1, Math.floor(Number(tp.soLuongMoiLy ?? tp.soLuong ?? 1)));
                        await client.query(
                            `INSERT INTO ChiTietHoaDon_Topping (MaCTHD, MaTopping, TenToppingSnapshot, SoLuong, SoLuongMoiLy, DonGia)
                             VALUES ($1, $2, $3, $4, $5, $6)`,
                            [maCTHD, tp.maTopping, tp.tenTopping || null, perCup * qty, perCup, Number(tp.donGia || 0)]
                        );
                    }
                }
                return { maHoaDon, tenGhiNho: memo, trangThaiTT: -1, thoiGianTao: hdRes.rows[0].thoigiantao };
            }, tenantId);

            io.to(roomTen(tenantId, 'thungan')).emit('PARKED_ORDERS_UPDATED', { maHoaDon: parked.maHoaDon });
            res.status(201).json({
                message: `⏸️ Đã lưu nháp (Park) đơn #${parked.maHoaDon} (chưa trừ kho, chưa đẩy KDS)!`,
                ...parked,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Park Order:');
        }
    });

    app.post('/api/order/:maHoaDon/resume', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const { maHoaDon } = req.params;
        try {
            const restored = await chayGiaoDich(async (client) => {
                const hdRes = await client.query(
                    `SELECT MaHoaDon, TrangThaiTT, MaKH, LoaiDonHang, TenKhachVangLai, DiaChiGiao
                       FROM HoaDon
                      WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                      FOR UPDATE`,
                    [maHoaDon, tenantId]
                );
                if (hdRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy đơn lưu nháp!');
                if (Number(hdRes.rows[0].trangthaitt) !== -1) {
                    throw new LoiNghiepVu(409, 'Đơn lưu nháp này đã được khôi phục bởi máy POS khác!');
                }
                const detail = await layHoaDonChiTiet(client, maHoaDon);
                await client.query(
                    `DELETE FROM ChiTietHoaDon_Topping WHERE MaCTHD IN (SELECT MaCTHD FROM ChiTietHoaDon WHERE MaHoaDon = $1)`,
                    [maHoaDon]
                );
                await client.query(`DELETE FROM ChiTietHoaDon WHERE MaHoaDon = $1`, [maHoaDon]);
                await client.query(`DELETE FROM HoaDon WHERE MaHoaDon = $1 AND TrangThaiTT = -1`, [maHoaDon]);
                return {
                    maHoaDon,
                    tenGhiNho: hdRes.rows[0].tenkhachvanglai || '',
                    loaiDonHang: hdRes.rows[0].loaidonhang || 'MANG_DI',
                    diaChiGiao: hdRes.rows[0].diachigiao || '',
                    khachHang: detail?.khachHang || null,
                    cart: (detail?.danhSachMon || []).map((m) => ({
                        maMon: m.maMon,
                        tenMon: m.tenMon,
                        tenMonTuyChinh: m.tenMonTuyChinh || null,
                        kichThuoc: m.kichThuoc,
                        soLuong: m.soLuong,
                        donGia: m.donGia,
                        giaModifiers: m.giaModifiers || 0,
                        modifiers: m.modifiersSnapshot || [],
                        trongLuongGram: m.trongLuongGram || null,
                        ghiChu: m.ghiChu || '',
                        isTakeaway: Boolean(m.isTakeaway),
                        courseNo: m.courseNo || 1,
                        toppings: (m.toppings || []).map((t) => ({
                            maTopping: t.maTopping,
                            tenTopping: t.tenTopping,
                            donGia: Number(t.donGia || 0),
                            soLuongMoiLy: Number(t.soLuongMoiLy || 1),
                            soLuong: Number(t.soLuongMoiLy || 1),
                        })),
                    })),
                };
            }, tenantId);

            io.to(roomTen(tenantId, 'thungan')).emit('PARKED_ORDERS_UPDATED', { maHoaDon });
            res.json({ message: `▶️ Đã khôi phục đơn nháp #${maHoaDon} về giỏ hàng!`, ...restored });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Resume Park Order:');
        }
    });

    // =========================================================================
    // 11. VÉ LÀM LẠI (REMAKE TICKET 0Đ, MỨC ƯU TIÊN 2, GHI HAO HỤT LOAIGD=8)
    // =========================================================================
    app.post('/api/kds/remake', kiemTraToken, choPhepVaiTro(1, 2, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const { maCTHD, lyDo = 'Làm lại món lỗi / đổ vỡ', soLuong = null } = req.body || {};
        if (!maCTHD) return res.status(400).json({ message: 'Thiếu mã chi tiết hóa đơn gốc (maCTHD)!' });
        if (!lyDo || String(lyDo).trim().length < 3) {
            return res.status(400).json({ message: 'Vui lòng nhập lý do làm lại (tối thiểu 3 ký tự)!' });
        }

        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const origRes = await client.query(
                    `SELECT c.*, COALESCE(NULLIF(to_jsonb(hd)->>'branchid', ''), 'DEFAULT') AS BranchId
                       FROM ChiTietHoaDon c
                       JOIN HoaDon hd ON hd.MaHoaDon = c.MaHoaDon
                      WHERE c.MaCTHD = $1 AND COALESCE(hd.TenantId, 'DEFAULT') = $2
                      FOR UPDATE OF c`,
                    [maCTHD, tenantId]
                );
                if (origRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy món gốc cần làm lại!');
                const orig = origRes.rows[0];
                const remakeQty = Math.max(1, Math.min(Number(orig.soluong || 1), Math.floor(Number(soLuong || orig.soluong || 1))));

                // Tạo dòng món Remake 0đ, LaMonTang = TRUE, MucDoUuTien = 2 (găm lên đầu KDS!)
                const remakeNote = `⚡ LÀM LẠI: ${String(lyDo).trim()}${orig.ghichu ? ` | ${orig.ghichu}` : ''}`.slice(0, 255);
                const ins = await client.query(
                    `INSERT INTO ChiTietHoaDon
                        (MaHoaDon, MaMon, TenMonSnapshot, TenMonTuyChinh, KichThuoc, SoLuong,
                         DonGia, GiaGocNiemYet, GiaModifiers, ModifiersSnapshot, GiaVonSnapshot,
                         LaMonTang, LyDoTang, TrongLuongGram, GhiChu, TrangThaiPhaChe,
                         DotGoi, IsTakeaway, CourseNo, FireStatus, FiredAt, MucDoUuTien, RemakeOfCTHD)
                     VALUES ($1, $2, $3, $4, $5, $6,
                             0, 0, 0, $7::jsonb, $8,
                             TRUE, $9, $10, $11, 'ChoPhaChe',
                             $12, $13, $14, 'FIRED', now(), 2, $15)
                     RETURNING MaCTHD`,
                    [
                        orig.mahoadon,
                        orig.mamon,
                        orig.tenmonsnapshot || orig.mamon,
                        orig.tenmontuychinh || null,
                        orig.kichthuoc || 'M',
                        remakeQty,
                        JSON.stringify(Array.isArray(orig.modifierssnapshot) ? orig.modifierssnapshot : []),
                        Number(orig.giavonsnapshot || 0),
                        `LÀM LẠI: ${String(lyDo).trim()}`.slice(0, 255),
                        orig.trongluonggram || null,
                        remakeNote,
                        Number(orig.dotgoi || 1),
                        Boolean(orig.istakeaway),
                        Number(orig.courseno || 1),
                        maCTHD,
                    ]
                );
                const remakeMaCTHD = ins.rows[0].macthd;

                // Sao chép Topping của món gốc với DonGia = 0
                const origTps = await client.query(
                    `SELECT MaTopping, TenToppingSnapshot, COALESCE(SoLuongMoiLy, 1) AS SoLuongMoiLy, GiaVonToppingSnapshot
                       FROM ChiTietHoaDon_Topping WHERE MaCTHD = $1`,
                    [maCTHD]
                );
                for (const tp of origTps.rows) {
                    const perCup = Math.max(1, Number(tp.soluongmoily || 1));
                    await client.query(
                        `INSERT INTO ChiTietHoaDon_Topping
                            (MaCTHD, MaTopping, TenToppingSnapshot, SoLuong, SoLuongMoiLy, DonGia, GiaVonToppingSnapshot)
                         VALUES ($1, $2, $3, $4, $5, 0, $6)`,
                        [remakeMaCTHD, tp.matopping, tp.tentoppingsnapshot, perCup * remakeQty, perCup, Number(tp.giavontoppingsnapshot || 0)]
                    );
                }

                // Trừ kho & ghi nhận Phiếu Hao Hụt Làm Lại (LoaiGD = 8)
                const tieuHao = new Map();
                await congDinhLuongNguyenLieuDongMon(
                    client,
                    tenantId,
                    { maCTHD: remakeMaCTHD, maMon: orig.mamon, kichThuoc: orig.kichthuoc, soLuong: remakeQty },
                    tieuHao
                );
                let maGiaoDichHaoHut = null;
                if (tieuHao.size > 0) {
                    const giaVonMap = await layMapGiaVonNguyenLieu(client, tenantId, [...tieuHao.keys()]);
                    const phieu = await client.query(
                        'INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId) VALUES ($1, $2, $3, $4) RETURNING MaGiaoDich',
                        [req.user.maNV, LOAI_GD_HAO_HUT_HUY_MON, `Hao hụt Làm Lại (Remake) HĐ ${orig.mahoadon}: ${String(lyDo).trim()}`, tenantId]
                    );
                    maGiaoDichHaoHut = phieu.rows[0].magiaodich;
                    for (const [maNL, sl] of [...tieuHao].sort((a, b) => a[0].localeCompare(b[0]))) {
                        const qty = lam3(sl);
                        await client.query(
                            `INSERT INTO ChiTietGiaoDichKho (MaGiaoDich, MaNL, SoLuong, DonGiaNhap, TinhTrang)
                             VALUES ($1, $2, $3, $4, 'Hao hụt Làm Lại (Remake)')`,
                            [maGiaoDichHaoHut, maNL, qty, giaVonMap.get(maNL) || 0]
                        );
                        await client.query(
                            "UPDATE NguyenLieu SET SoLuongTon = SoLuongTon - $1 WHERE MaNL = $2 AND COALESCE(TenantId, 'DEFAULT') = $3",
                            [qty, maNL, tenantId]
                        );
                    }
                }

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'KDS_ITEM_REMAKE',
                    doiTuong: 'CHITIETHOADON',
                    maDoiTuong: remakeMaCTHD,
                    giaTriCu: { remakeOfCTHD: maCTHD, maMon: orig.mamon },
                    giaTriMoi: { remakeMaCTHD, soLuong: remakeQty, donGia: 0, mucDoUuTien: 2, maGiaoDichHaoHut },
                    lyDo: String(lyDo).trim(),
                    ip: req.ip,
                    batBuoc: true,
                });

                const [monRemake] = await layMonTheoMa(client, [remakeMaCTHD]);
                const bId = normalizeBranchId(orig.branchid || 'DEFAULT');
                const logInfo = await insertKdsEventLog(client, {
                    tenantId,
                    branchId: bId,
                    station: monRemake?.tramCheBien || 'BAR_CHINH',
                    eventType: 'REMAKE',
                    maHoaDon: orig.mahoadon,
                    payload: { mon: monRemake, remakeOfCTHD: maCTHD, lyDo: String(lyDo).trim() },
                });

                return {
                    maHoaDon: orig.mahoadon,
                    remakeMaCTHD,
                    remakeOfCTHD: maCTHD,
                    maGiaoDichHaoHut,
                    branchId: bId,
                    seq: logInfo.seq,
                    mon: monRemake,
                };
            }, tenantId);

            emitScopedKdsEvent(io, {
                tenantId,
                branchId: ketQua.branchId,
                station: ketQua.mon?.tramCheBien || 'BAR_CHINH',
                seq: ketQua.seq,
                eventType: 'REMAKE',
                socketEvents: ['kds:remake', 'order:new'],
                payload: {
                    maHoaDon: ketQua.maHoaDon,
                    remakeOfCTHD: ketQua.remakeOfCTHD,
                    danhSachMon: [ketQua.mon],
                    mon: ketQua.mon,
                },
                includeExpo: true,
                legacyBaristaEvent: 'CO_DON_MOI',
            });

            res.status(201).json({
                message: `⚡ Đã đẩy vé LÀM LẠI (0đ • Ưu tiên cao nhất) lên đầu hàng đợi quầy pha chế!`,
                ...ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Làm lại món (Remake):');
        }
    });

    // =========================================================================
    // 12. ĐO LƯỜNG NÚT THẮT PHA CHẾ KDS (GET /api/kds/telemetry)
    // =========================================================================
    app.get('/api/kds/telemetry', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = req.query.branchId ? normalizeBranchId(req.query.branchId) : null;
        const station = normalizeStation(req.query.station || 'ALL');
        const hours = Math.min(720, Math.max(1, Math.floor(Number(req.query.hours || 24))));

        try {
            const telemetry = await pool.withTenant(tenantId, async (client) => {
                const r = await client.query(
                    `SELECT c.MaCTHD, c.MaMon, sp.TenMon, sp.NhomMon,
                            to_jsonb(sp)->>'tramchebien' AS TramCheBien,
                            c.ThoiGianGoi, c.FiredAt, c.ThoiGianBatDauLam, c.ThoiGianXong, c.ThoiGianPhucVu,
                            c.RemakeOfCTHD, c.MaNVPhaChe
                       FROM ChiTietHoaDon c
                       JOIN HoaDon hd ON hd.MaHoaDon = c.MaHoaDon
                       JOIN SanPham sp ON sp.MaMon = c.MaMon
                      WHERE COALESCE(hd.TenantId, 'DEFAULT') = $1
                        AND c.TrangThaiPhaChe <> 'DaHuy'
                        AND hd.TrangThaiTT IN (0, 1)
                        AND ($2::text IS NULL OR COALESCE(NULLIF(to_jsonb(hd)->>'branchid', ''), 'DEFAULT') = $2)
                        AND COALESCE(c.FiredAt, c.ThoiGianGoi::timestamptz) >= now() - ($3::int || ' hours')::interval`,
                    [tenantId, branchId, hours]
                );
                let rows = r.rows.map((x) => ({
                    maCTHD: x.macthd,
                    tramCheBien: suyLuanTramCheBien({ tramCheBien: x.tramchebien, nhomMon: x.nhommon, tenMon: x.tenmon }),
                    thoiGianGoi: x.thoigiangoi,
                    firedAt: x.firedat,
                    thoiGianBatDauLam: x.thoigianbatdaulam,
                    thoiGianXong: x.thoigianxong,
                    thoiGianPhucVu: x.thoigianphucvu,
                    remakeOfCTHD: x.remakeofcthd || null,
                }));
                if (station !== 'ALL') {
                    rows = rows.filter((x) => x.tramCheBien === station);
                }
                return computeKdsBottleneckTelemetry(rows);
            });

            res.json({
                serverNowMs: Date.now(),
                branchId: branchId || 'DEFAULT',
                station,
                windowHours: hours,
                ...telemetry,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API KDS Bottleneck Telemetry:');
        }
    });
}

module.exports = { registerKdsPhase2Routes };
