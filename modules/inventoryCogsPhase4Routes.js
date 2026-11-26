/**
 * =============================================================================
 * PHÂN HỆ 4 ROUTES (81 -> 100/100):
 *  - Reversal Phiếu Nhập Sai + WAC Replay
 *  - Định giá Tồn kho Điểm Thời Gian (Point-in-Time Valuation)
 *  - Quản lý Lô FEFO & Hủy Mẻ Hết Hạn 1 chạm
 *  - Kiểm Kho Mù 60 Giây (Start -> Submit w/ In-Flight Sales Delta & 2-Step Approve)
 *  - Báo cáo AvT Theo Từng Ca + Cảnh báo Telegram Thất thoát Vô danh
 *  - Nhà Cung Cấp, Auto-PO từ AI Forecast 60 ngày, GRN Nhận hàng & Khóa Sổ Kho
 *  - Tra cứu Barcode Đơn vị tính (Thùng / Hộp)
 * =============================================================================
 */
const crypto = require('crypto');
const {
    WASTAGE_TAXONOMY,
    lam3,
    lam4,
    lam2,
    normalizeInventoryBranch,
    todayDateVN,
    ensureBranchRecord,
    computeSafeWacOnStockIn,
    recordCogsAdjustment,
    allocateLandedCost,
    lockBranchStockOrdered,
    updateBranchStockRow,
    insertLedgerLine,
    assertPeriodNotLocked,
    createFefoLot,
    replayWacForBranchIngredient,
    detectPriceSpikeAndMarginImpact,
    computePointInTimeValuation,
    computeShiftAvtReport,
} = require('./inventoryCogsPhase4Engine');
const { emitToBranch } = require('../src/core/socketRooms');

function registerInventoryCogsPhase4Routes(app, deps) {
    const {
        pool,
        chayGiaoDich,
        qTenant,
        layTenantId,
        kiemTraToken,
        choPhepVaiTro,
        coQuyenHan,
        ghiAuditLog,
        dispatchFraudAlertFromAudit,
        guiLoi,
        LoiNghiepVu,
        layCaDangMo,
        io,
        roomTen,
        autoUn86OnRestock,
    } = deps;

    // =========================================================================
    // 1. HỦY / ĐẢO PHIẾU NHẬP KHO GÕ SAI GIÁ (LoaiGD = 9) + WAC REPLAY
    // =========================================================================
    app.post('/api/kho/phieu/:maGD/reverse', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const maGDGoc = String(req.params.maGD || '').trim();
        const lyDo = String(req.body?.lyDo || 'Đảo phiếu nhập gõ sai đơn giá / số lượng').trim();

        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const pRes = await client.query(
                    `SELECT magiaodich, loaigd, thoigiantao,
                            COALESCE(ngaychungtu::text, to_char(thoigiantao AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')) AS ngaychungtu,
                            COALESCE(NULLIF(NULLIF(branchid::text, ''), 'DEFAULT'), $1::text || '_MAIN') AS branchid
                       FROM public.phieugiaodichkho
                      WHERE magiaodich::text = $2::text
                        AND COALESCE(tenantid::text, 'DEFAULT') = $1::text
                      FOR UPDATE`,
                    [tenantId, maGDGoc]
                );
                if (pRes.rows.length === 0) {
                    throw new LoiNghiepVu(404, 'Không tìm thấy phiếu giao dịch kho cần đảo!');
                }
                const orig = pRes.rows[0];
                if (Number(orig.loaigd) !== 1) {
                    throw new LoiNghiepVu(400, 'Chỉ hỗ trợ lập phiếu đảo (Reversal) cho phiếu Nhập kho (LoaiGD = 1)!');
                }

                // Kiểm tra khóa sổ kỳ kế toán
                await assertPeriodNotLocked(client, tenantId, orig.branchid, orig.ngaychungtu, LoiNghiepVu);

                // Chặn đảo trùng 2 lần cùng 1 phiếu nhập
                const dupRev = await client.query(
                    `SELECT magiaodich FROM public.phieugiaodichkho
                      WHERE COALESCE(tenantid::text, 'DEFAULT') = $1::text
                        AND loaigd = 9
                        AND magdthamchieu = $2::text
                      LIMIT 1`,
                    [tenantId, String(orig.magiaodich)]
                );
                if (dupRev.rows.length > 0) {
                    throw new LoiNghiepVu(409, `Phiếu nhập #${maGDGoc} đã được đảo bởi phiếu #${dupRev.rows[0].magiaodich}!`);
                }

                const ctRes = await client.query(
                    `SELECT manl, soluong, COALESCE(dongianhap, 0) AS dongianhap, COALESCE(chiphiphanbo, 0) AS chiphiphanbo
                       FROM public.chitietgiaodichkho
                      WHERE magiaodich = $1
                      ORDER BY manl ASC`,
                    [orig.magiaodich]
                );
                if (ctRes.rows.length === 0) {
                    throw new LoiNghiepVu(400, 'Phiếu nhập gốc không có dòng chi tiết để đảo!');
                }

                const maNLList = ctRes.rows.map((r) => r.manl);
                const { branchId, stockMap } = await lockBranchStockOrdered(client, tenantId, orig.branchid, maNLList);

                const revPhieu = await client.query(
                    `INSERT INTO public.phieugiaodichkho
                        (manv, loaigd, ghichu, tenantid, branchid, magdthamchieu, ngaychungtu, trangthaiduyet)
                     VALUES ($1, 9, $2, $3, $4, $5, $6::date, 'POSTED')
                     RETURNING magiaodich`,
                    [
                        req.user.maNV,
                        `Đảo phiếu nhập #${orig.magiaodich}: ${lyDo}`.slice(0, 255),
                        tenantId,
                        branchId,
                        String(orig.magiaodich),
                        todayDateVN(),
                    ]
                );
                const maGDReversal = revPhieu.rows[0].magiaodich;

                const replayedList = [];
                for (const line of ctRes.rows) {
                    const row = stockMap.get(line.manl);
                    const qtyOrig = lam3(line.soluong);
                    const tonTruoc = row ? row.soLuongTon : 0;
                    const tonSau = lam3(tonTruoc - qtyOrig);
                    const giaVonTruoc = row ? row.giaVonDonVi : 0;

                    await updateBranchStockRow(client, {
                        tenantId,
                        branchId,
                        maNL: line.manl,
                        nextQty: tonSau,
                    });

                    // Đóng lô FEFO sinh ra từ phiếu nhập bị đảo (nếu có)
                    await client.query(
                        `UPDATE public.lo_tonkho
                            SET soluongconlai = 0, trangthai = 'DISPOSED'
                          WHERE tenantid = $1::text AND branchid = $2::text
                            AND magiaodichnguon = $3::text AND manl = $4::text`,
                        [tenantId, branchId, String(orig.magiaodich), line.manl]
                    );

                    // Chạy lại WAC tuần tự cho nguyên liệu này sau khi loại bỏ phiếu sai!
                    const rep = await replayWacForBranchIngredient(client, {
                        tenantId,
                        branchId,
                        maNL: line.manl,
                        refMaGiaoDich: maGDReversal,
                        createdBy: req.user.maNV,
                    });

                    await insertLedgerLine(client, {
                        maGiaoDich: maGDReversal,
                        maNL: line.manl,
                        soLuong: -qtyOrig,
                        donGiaNhap: Number(line.dongianhap || 0),
                        tinhTrang: `Đảo phiếu nhập sai #${orig.magiaodich}`,
                        tonTruoc,
                        tonSau,
                        giaVonTruoc,
                        giaVonSau: rep.replayedWac,
                        chiPhiPhanBo: -Number(line.chiphiphanbo || 0),
                    });

                    replayedList.push({
                        maNL: line.manl,
                        qtyReversed: qtyOrig,
                        tonTruoc,
                        tonSau,
                        giaVonTruoc,
                        giaVonSauReplay: rep.replayedWac,
                    });
                }

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'INVENTORY_RECEIPT_REVERSED',
                    doiTuong: 'KHO',
                    maDoiTuong: String(orig.magiaodich),
                    giaTriMoi: { maGDReversal, branchId, lyDo, replayedList },
                    lyDo,
                    ip: req.ip,
                    batBuoc: true,
                });

                return { maGDGoc: orig.magiaodich, maGDReversal, branchId, replayedList };
            }, tenantId);

            res.json({
                message: `↩️ Đã lập phiếu đảo #${ketQua.maGDReversal} cho phiếu nhập #${ketQua.maGDGoc} và tính lại giá vốn WAC!`,
                ...ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Đảo phiếu nhập kho:');
        }
    });

    // =========================================================================
    // 2. ĐỊNH GIÁ TỒN KHO ĐIỂM THỜI GIAN (POINT-IN-TIME VALUATION)
    // =========================================================================
    app.get('/api/kho/dinh-gia', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const asOfDate = req.query.asOfDate || todayDateVN();
        const branchId = req.query.branchId || null;
        try {
            const report = await pool.withTenant(tenantId, (client) =>
                computePointInTimeValuation(client, { tenantId, branchId, asOfDate })
            );
            res.json(report);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Định giá tồn kho điểm thời gian:');
        }
    });

    // =========================================================================
    // 3. QUẢN LÝ LÔ FEFO & HỦY MẺ HẾT HẠN 1 CHẠM
    // =========================================================================
    app.get('/api/kho/lo-tonkho', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = normalizeInventoryBranch(tenantId, req.query.branchId || null);
        const maNL = req.query.maNL ? String(req.query.maNL).trim() : null;
        const onlyActive = String(req.query.onlyActive ?? 'true') !== 'false';

        try {
            const r = await qTenant(
                req,
                `SELECT l.id, l.branchid, l.manl, nl.tennl, nl.donvitinh, l.malo, l.nguonlo,
                        l.magiaodichnguon, l.soluongbandau, l.soluongconlai, l.giavonlo,
                        l.ngaysanxuat, l.thoigianhethan, l.trangthai
                   FROM public.lo_tonkho l
                   JOIN public.nguyenlieu nl ON nl.manl = l.manl AND COALESCE(nl.tenantid::text, 'DEFAULT') = $1::text
                  WHERE l.tenantid = $1::text
                    AND l.branchid = $2::text
                    AND ($3::text IS NULL OR l.manl = $3::text)
                    AND ($4::boolean = FALSE OR l.trangthai = 'ACTIVE')
                  ORDER BY l.thoigianhethan ASC NULLS LAST, l.id ASC
                  LIMIT 200`,
                [tenantId, branchId, maNL, onlyActive]
            );

            const nowMs = Date.now();
            const lots = r.rows.map((row) => {
                const expMs = row.thoigianhethan ? new Date(row.thoigianhethan).getTime() : null;
                const minsLeft = expMs !== null ? Math.round((expMs - nowMs) / 60000) : null;
                const isExpired = minsLeft !== null && minsLeft <= 0 && row.trangthai === 'ACTIVE';
                const isExpiringSoon =
                    minsLeft !== null &&
                    minsLeft > 0 &&
                    row.trangthai === 'ACTIVE' &&
                    (row.nguonlo === 'SUBRECIPE' ? minsLeft <= 30 : minsLeft <= 48 * 60);
                return {
                    id: Number(row.id),
                    branchId: row.branchid,
                    maNL: row.manl,
                    tenNL: row.tennl,
                    donViTinh: row.donvitinh,
                    maLo: row.malo,
                    nguonLo: row.nguonlo,
                    maGiaoDichNguon: row.magiaodichnguon,
                    soLuongBanDau: Number(row.soluongbandau),
                    soLuongConLai: Number(row.soluongconlai),
                    giaVonLo: Number(row.giavonlo),
                    ngaySanXuat: row.ngaysanxuat,
                    thoiGianHetHan: row.thoigianhethan,
                    trangThai: row.trangthai,
                    minsLeft,
                    isExpired,
                    isExpiringSoon,
                };
            });

            res.json({
                branchId,
                lots,
                expiringAlerts: lots.filter((l) => l.isExpired || l.isExpiringSoon),
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Danh sách lô FEFO:');
        }
    });

    app.post('/api/kho/lo-tonkho/:id/dispose', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
        const tenantId = layTenantId(req);
        const lotId = Number(req.params.id);
        const customQty = req.body?.soLuongHuy !== undefined ? Number(req.body.soLuongHuy) : null;
        const ghiChu = String(req.body?.ghiChu || 'Hủy lô / mẻ hết hạn sử dụng').trim();
        if (!Number.isInteger(lotId) || lotId <= 0) {
            return res.status(400).json({ message: 'Mã lô không hợp lệ!' });
        }

        try {
            const out = await chayGiaoDich(async (client) => {
                const lRes = await client.query(
                    `SELECT id, branchid, manl, malo, soluongconlai, giavonlo, trangthai
                       FROM public.lo_tonkho
                      WHERE id = $1::bigint AND tenantid = $2::text
                      FOR UPDATE`,
                    [lotId, tenantId]
                );
                if (lRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy lô tồn kho!');
                const lot = lRes.rows[0];
                if (lot.trangthai !== 'ACTIVE' && lot.trangthai !== 'EXPIRED') {
                    throw new LoiNghiepVu(409, `Lô ${lot.malo} đã đóng (${lot.trangthai})!`);
                }

                const docDate = await assertPeriodNotLocked(client, tenantId, lot.branchid, todayDateVN(), LoiNghiepVu);
                const qtyDispose = customQty !== null && customQty > 0 ? lam3(customQty) : lam3(lot.soluongconlai);
                if (!(qtyDispose > 0)) throw new LoiNghiepVu(400, 'Lô này đã hết tồn để hủy!');

                const { branchId, stockMap } = await lockBranchStockOrdered(client, tenantId, lot.branchid, [lot.manl]);
                const st = stockMap.get(lot.manl);
                const tonTruoc = st ? st.soLuongTon : 0;
                const tonSau = lam3(tonTruoc - qtyDispose);
                const giaVonLo = Number(lot.giavonlo || st?.giaVonDonVi || 0);
                const giaTriHuy = Math.round(qtyDispose * giaVonLo);

                const ca = await layCaDangMo(client, 'SHARE', tenantId, { branchId });

                const pRes = await client.query(
                    `INSERT INTO public.phieugiaodichkho
                        (manv, loaigd, ghichu, tenantid, branchid, macathungan, malydohuy, ngaychungtu, trangthaiduyet)
                     VALUES ($1, 2, $2, $3, $4, $5, 'EXPIRED_BATCH', $6::date, 'POSTED')
                     RETURNING magiaodich`,
                    [
                        req.user.maNV,
                        `Hủy lô hết HSD ${lot.malo}: ${ghiChu}`.slice(0, 255),
                        tenantId,
                        branchId,
                        ca ? String(ca.macathungan) : null,
                        docDate,
                    ]
                );
                const maGD = pRes.rows[0].magiaodich;

                await insertLedgerLine(client, {
                    maGiaoDich: maGD,
                    maNL: lot.manl,
                    soLuong: qtyDispose,
                    donGiaNhap: giaVonLo,
                    tinhTrang: `Hủy lô hết HSD ${lot.malo}`,
                    tonTruoc,
                    tonSau,
                    giaVonTruoc: st?.giaVonDonVi || giaVonLo,
                    giaVonSau: st?.giaVonDonVi || giaVonLo,
                });

                await updateBranchStockRow(client, {
                    tenantId,
                    branchId,
                    maNL: lot.manl,
                    nextQty: tonSau,
                });

                await client.query(
                    `UPDATE public.lo_tonkho
                        SET soluongconlai = 0, trangthai = 'DISPOSED'
                      WHERE id = $1::bigint`,
                    [lotId]
                );

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'EXPIRED_LOT_DISPOSED',
                    doiTuong: 'KHO',
                    maDoiTuong: lot.malo,
                    giaTriMoi: { lotId, maNL: lot.manl, qtyDispose, giaVonLo, giaTriHuy, maGD },
                    lyDo: ghiChu,
                    ip: req.ip,
                    batBuoc: true,
                });

                return { lotId, maLo: lot.malo, maNL: lot.manl, qtyDispose, giaVonLo, giaTriHuy, maGiaoDich: maGD, tonSau };
            }, tenantId);

            res.json({
                message: `🗑️ Đã hủy lô ${out.maLo} (-${out.qtyDispose}, giá trị hao hụt ${out.giaTriHuy.toLocaleString('vi-VN')}đ)!`,
                ...out,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Hủy lô hết hạn:');
        }
    });

    // =========================================================================
    // 4. KIỂM KHO MÙ 60 GIÂY (BLIND STOCKTAKE + COMPOUND UOM + IN-FLIGHT DELTA)
    // =========================================================================
    app.get('/api/kho/kiem-ke/items', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = normalizeInventoryBranch(tenantId, req.query.branchId || req.user.branchId || null);
        const keyOnly = String(req.query.keyOnly ?? '1') !== '0' && String(req.query.keyOnly ?? 'true') !== 'false';
        const forceBlind = String(req.query.forceBlind || '') === '1' || String(req.query.forceBlind || '') === 'true';
        const isManager = Number(req.user.vaiTro) === 1;
        const canViewSystemStock =
            isManager || (typeof coQuyenHan === 'function' && coQuyenHan(req.user, 'inventory.view_system_stock'));
        const isBlind = !canViewSystemStock || forceBlind;

        try {
            const payload = await pool.withTenant(tenantId, async (client) => {
                let nlRes = await client.query(
                    `SELECT nl.manl, nl.tennl, nl.donvitinh, COALESCE(nl.iskeyitem, FALSE) AS iskeyitem,
                            COALESCE(tk.soluongton, CASE WHEN $3::boolean THEN nl.soluongton ELSE 0 END, 0) AS ton_he_thong
                       FROM public.nguyenlieu nl
                       LEFT JOIN public.tonkhochinhanh tk
                         ON tk.tenantid = $1::text AND tk.branchid = $2::text AND tk.manl = nl.manl
                      WHERE COALESCE(nl.tenantid::text, 'DEFAULT') = $1::text
                        AND nl.daxoa = FALSE
                        AND ($4::boolean = FALSE OR COALESCE(nl.iskeyitem, FALSE) = TRUE)
                      ORDER BY nl.tennl ASC`,
                    [tenantId, branchId, branchId === `${tenantId}_MAIN`, keyOnly]
                );
                if (nlRes.rows.length === 0 && keyOnly) {
                    nlRes = await client.query(
                        `SELECT nl.manl, nl.tennl, nl.donvitinh, COALESCE(nl.iskeyitem, FALSE) AS iskeyitem,
                                COALESCE(tk.soluongton, CASE WHEN $3::boolean THEN nl.soluongton ELSE 0 END, 0) AS ton_he_thong
                           FROM public.nguyenlieu nl
                           LEFT JOIN public.tonkhochinhanh tk
                             ON tk.tenantid = $1::text AND tk.branchid = $2::text AND tk.manl = nl.manl
                          WHERE COALESCE(nl.tenantid::text, 'DEFAULT') = $1::text
                            AND nl.daxoa = FALSE
                          ORDER BY nl.tennl ASC
                          LIMIT 10`,
                        [tenantId, branchId, branchId === `${tenantId}_MAIN`]
                    );
                }

                const uomRes = await client.query(
                    `SELECT id, manl, tendonvi, hesoquydoi, mavachdonvi, lamacdinhkiem
                       FROM public.nguyenlieu_donviquydoi
                      WHERE tenantid = $1::text
                      ORDER BY hesoquydoi DESC`,
                    [tenantId]
                );
                const uomByNl = new Map();
                for (const u of uomRes.rows) {
                    if (!uomByNl.has(u.manl)) uomByNl.set(u.manl, []);
                    uomByNl.get(u.manl).push({
                        id: Number(u.id),
                        tenDonVi: u.tendonvi,
                        heSoQuyDoi: Number(u.hesoquydoi),
                        maVachDonVi: u.mavachdonvi || null,
                        laMacDinhKiem: Boolean(u.lamacdinhkiem),
                    });
                }

                // TUYỆT ĐỐI KHÔNG trả tồn hệ thống hoặc giá vốn cho nhân viên ca (Blind Stocktake!)
                const items = nlRes.rows.map((r) => ({
                    maNL: r.manl,
                    tenNL: r.tennl,
                    donViTinh: r.donvitinh,
                    isKeyItem: Boolean(r.iskeyitem),
                    donViQuyDoi: uomByNl.get(r.manl) || [],
                    ...(!isBlind ? { tonKhoHeThong: Number(r.ton_he_thong) } : {}),
                }));

                return { branchId, isBlind, items };
            });

            res.status(200).json(payload);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Tải danh sách kiểm kho mù:');
        }
    });

    app.get('/api/kho/kiem-ke/pending', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = req.query.branchId ? normalizeInventoryBranch(tenantId, req.query.branchId) : null;
        try {
            const rows = await pool.withTenant(tenantId, async (client) => {
                const pRes = await client.query(
                    `SELECT p.magiaodich, p.manv, p.ghichu, p.branchid, p.macathungan,
                            p.trangthaiduyet, p.ngaychungtu, p.thoigiantao, p.thoidiemkiemke
                       FROM public.phieugiaodichkho p
                      WHERE COALESCE(p.tenantid::text, 'DEFAULT') = $1::text
                        AND p.loaigd = 3
                        AND p.trangthaiduyet = 'PENDING_APPROVAL'
                        AND ($2::text IS NULL OR COALESCE(NULLIF(NULLIF(p.branchid::text, ''), 'DEFAULT'), $1::text || '_MAIN') = $2::text)
                      ORDER BY p.thoigiantao DESC
                      LIMIT 50`,
                    [tenantId, branchId]
                );
                const result = [];
                for (const p of pRes.rows) {
                    const ctRes = await client.query(
                        `SELECT ct.manl, nl.tennl, nl.donvitinh, ct.soluong, ct.dongianhap, ct.tontruoc, ct.tonsau, ct.tinhtrang
                           FROM public.chitietgiaodichkho ct
                           LEFT JOIN public.nguyenlieu nl ON nl.manl = ct.manl
                          WHERE ct.magiaodich = $1
                          ORDER BY ct.manl ASC`,
                        [p.magiaodich]
                    );
                    const items = ctRes.rows.map((c) => {
                        const diff = lam3(c.soluong || 0);
                        const wac = Number(c.dongianhap || 0);
                        return {
                            maNL: c.manl,
                            tenNL: c.tennl || c.manl,
                            donViTinh: c.donvitinh || '',
                            systemBefore: lam3(c.tontruoc || 0),
                            diff,
                            giaVonDonVi: wac,
                            absDiffVal: Math.round(Math.abs(diff) * wac),
                            tinhTrang: c.tinhtrang || '',
                        };
                    });
                    result.push({
                        maGiaoDich: p.magiaodich,
                        maNV: p.manv,
                        branchId: p.branchid,
                        maCaThuNgan: p.macathungan,
                        ghiChu: p.ghichu,
                        trangThaiDuyet: p.trangthaiduyet,
                        ngayChungTu: p.ngaychungtu,
                        thoiGianTao: p.thoigiantao,
                        totalAbsVarianceValue: items.reduce((s, it) => s + it.absDiffVal, 0),
                        items,
                    });
                }
                return result;
            });
            res.status(200).json(rows);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Danh sách phiếu kiểm kho chờ duyệt:');
        }
    });

    app.post('/api/kho/kiem-ke/start', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = normalizeInventoryBranch(tenantId, req.body?.branchId || req.user.branchId || null);
        const keyOnly = req.body?.keyOnly !== false;
        const canViewSystemStock =
            Number(req.user.vaiTro) === 1 || (typeof coQuyenHan === 'function' && coQuyenHan(req.user, 'inventory.view_system_stock'));

        try {
            const session = await chayGiaoDich(async (client) => {
                await ensureBranchRecord(client, tenantId, branchId);
                const ca = await layCaDangMo(client, 'SHARE', tenantId, { branchId });
                const sessionId = `BS_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

                const ins = await client.query(
                    `INSERT INTO public.phien_kiemkho_mu (id, tenantid, branchid, macathungan, manv, thoidiembatdau, trangthai)
                     VALUES ($1::varchar, $2::varchar, $3::varchar, $4::text, $5::varchar, now(), 'OPEN')
                     RETURNING id, thoidiembatdau`,
                    [sessionId, tenantId, branchId, ca ? String(ca.macathungan) : null, req.user.maNV]
                );

                // Lấy danh sách nguyên liệu (ưu tiên IsKeyItem = TRUE)
                let nlRes = await client.query(
                    `SELECT nl.manl, nl.tennl, nl.donvitinh, COALESCE(nl.iskeyitem, FALSE) AS iskeyitem,
                            COALESCE(tk.soluongton, CASE WHEN $3::boolean THEN nl.soluongton ELSE 0 END, 0) AS ton_he_thong
                       FROM public.nguyenlieu nl
                       LEFT JOIN public.tonkhochinhanh tk
                         ON tk.tenantid = $1::text AND tk.branchid = $2::text AND tk.manl = nl.manl
                      WHERE COALESCE(nl.tenantid::text, 'DEFAULT') = $1::text
                        AND nl.daxoa = FALSE
                        AND ($4::boolean = FALSE OR COALESCE(nl.iskeyitem, FALSE) = TRUE)
                      ORDER BY nl.tennl ASC`,
                    [tenantId, branchId, branchId === `${tenantId}_MAIN`, keyOnly]
                );
                if (nlRes.rows.length === 0 && keyOnly) {
                    nlRes = await client.query(
                        `SELECT nl.manl, nl.tennl, nl.donvitinh, COALESCE(nl.iskeyitem, FALSE) AS iskeyitem,
                                COALESCE(tk.soluongton, CASE WHEN $3::boolean THEN nl.soluongton ELSE 0 END, 0) AS ton_he_thong
                           FROM public.nguyenlieu nl
                           LEFT JOIN public.tonkhochinhanh tk
                             ON tk.tenantid = $1::text AND tk.branchid = $2::text AND tk.manl = nl.manl
                          WHERE COALESCE(nl.tenantid::text, 'DEFAULT') = $1::text
                            AND nl.daxoa = FALSE
                          ORDER BY nl.tennl ASC
                          LIMIT 10`,
                        [tenantId, branchId, branchId === `${tenantId}_MAIN`]
                    );
                }

                // Tải danh sách đơn vị quy đổi (Thùng / Hộp / Kg) để frontend render Compound Unit Input
                const uomRes = await client.query(
                    `SELECT id, manl, tendonvi, hesoquydoi, mavachdonvi, lamacdinhkiem
                       FROM public.nguyenlieu_donviquydoi
                      WHERE tenantid = $1::text
                      ORDER BY hesoquydoi DESC`,
                    [tenantId]
                );
                const uomByNl = new Map();
                for (const u of uomRes.rows) {
                    if (!uomByNl.has(u.manl)) uomByNl.set(u.manl, []);
                    uomByNl.get(u.manl).push({
                        id: Number(u.id),
                        tenDonVi: u.tendonvi,
                        heSoQuyDoi: Number(u.hesoquydoi),
                        maVachDonVi: u.mavachdonvi || null,
                        laMacDinhKiem: Boolean(u.lamacdinhkiem),
                    });
                }

                // TUYỆT ĐỐI KHÔNG TRẢ tonKho / soLuongTon cho tài khoản không phải Quản lý (Blind Stocktake!)
                const items = nlRes.rows.map((r) => ({
                    maNL: r.manl,
                    tenNL: r.tennl,
                    donViTinh: r.donvitinh,
                    isKeyItem: Boolean(r.iskeyitem),
                    donViQuyDoi: uomByNl.get(r.manl) || [],
                    ...(canViewSystemStock && !req.body?.forceBlind ? { tonKhoHeThong: Number(r.ton_he_thong) } : {}),
                }));

                return {
                    sessionId: ins.rows[0].id,
                    branchId,
                    maCaThuNgan: ca ? ca.macathungan : null,
                    thoiDiemBatDau: ins.rows[0].thoidiembatdau,
                    isBlind: !canViewSystemStock || Boolean(req.body?.forceBlind),
                    items,
                };
            }, tenantId);

            res.status(201).json(session);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Bắt đầu phiên kiểm kho mù:');
        }
    });

    app.post('/api/kho/kiem-ke/submit', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const {
            sessionId = null,
            branchId: rawBranch = null,
            thoiDiemBatDau: rawStart = null,
            ngayChungTu = null,
            ghiChu = 'Kiểm kho mù 60 giây',
            recountConfirmed = false,
            danhSachNguyenLieu = [],
        } = req.body || {};

        if (!Array.isArray(danhSachNguyenLieu) || danhSachNguyenLieu.length === 0) {
            return res.status(400).json({ message: 'Vui lòng nhập số lượng kiểm đếm cho ít nhất 1 nguyên liệu!' });
        }

        const isManager = Number(req.user.vaiTro) === 1;

        try {
            const out = await chayGiaoDich(async (client) => {
                let bId = normalizeInventoryBranch(tenantId, rawBranch || req.user.branchId || null);
                let startTs = rawStart || null;
                let sessionRow = null;

                if (sessionId) {
                    const sRes = await client.query(
                        `SELECT id, branchid, macathungan, thoidiembatdau, trangthai, solandemlai
                           FROM public.phien_kiemkho_mu
                          WHERE id = $1::text AND tenantid = $2::text
                          FOR UPDATE`,
                        [String(sessionId), tenantId]
                    );
                    if (sRes.rows.length === 0) {
                        throw new LoiNghiepVu(404, 'Không tìm thấy phiên kiểm kho mù!');
                    }
                    sessionRow = sRes.rows[0];
                    if (sessionRow.trangthai !== 'OPEN') {
                        throw new LoiNghiepVu(409, `Phiên kiểm kho #${sessionId} đã được nộp (${sessionRow.trangthai})!`);
                    }
                    bId = sessionRow.branchid;
                    startTs = sessionRow.thoidiembatdau;
                }

                const docDate = await assertPeriodNotLocked(client, tenantId, bId, ngayChungTu, LoiNghiepVu);

                // Quy đổi tổ hợp đơn vị (Compound UoM: VD 2 Hộp (1000ml) + 500ml = 2500ml)
                const normalizedRows = [];
                for (const item of danhSachNguyenLieu) {
                    const maNL = String(item?.maNL || '').trim();
                    if (!maNL) continue;
                    let countedBase = 0;
                    let compoundDesc = '';

                    if (Array.isArray(item.chiTietDonVi) && item.chiTietDonVi.length > 0) {
                        const parts = [];
                        for (const u of item.chiTietDonVi) {
                            const sl = Number(u?.soLuong || 0);
                            const hs = Number(u?.heSoQuyDoi || 1);
                            if (sl > 0 && hs > 0) {
                                countedBase += sl * hs;
                                parts.push(`${sl} ${u.tenDonVi || 'đv'}(x${hs})`);
                            }
                        }
                        countedBase = lam3(countedBase);
                        compoundDesc = parts.join(' + ');
                    } else {
                        const sl = Number(item.soLuong);
                        const hs = Number(item.heSoQuyDoi) > 0 ? Number(item.heSoQuyDoi) : 1;
                        if (Number.isNaN(sl) || sl < 0) {
                            throw new LoiNghiepVu(400, `Số lượng kiểm kê của ${maNL} phải >= 0!`);
                        }
                        countedBase = lam3(sl * hs);
                        compoundDesc = hs !== 1 && item.donViNhap ? `${sl} ${item.donViNhap}(x${hs})` : `${countedBase}`;
                    }

                    normalizedRows.push({ maNL, countedBase, compoundDesc });
                }
                if (normalizedRows.length === 0) {
                    throw new LoiNghiepVu(400, 'Không có dòng kiểm kê hợp lệ!');
                }

                const sortedRows = normalizedRows.sort((a, b) => a.maNL.localeCompare(b.maNL));
                const { branchId, stockMap } = await lockBranchStockOrdered(
                    client,
                    tenantId,
                    bId,
                    sortedRows.map((r) => r.maNL)
                );

                // Tính In-Flight Sales Delta cho từng nguyên liệu phát sinh từ startTs đến now()!
                const evaluated = [];
                const recountNeededCodes = [];
                let totalAbsVarianceValue = 0;

                for (const row of sortedRows) {
                    const st = stockMap.get(row.maNL);
                    if (!st) throw new LoiNghiepVu(404, `Không tìm thấy nguyên liệu ${row.maNL}!`);

                    let inFlightDelta = 0;
                    if (startTs) {
                        const dRes = await client.query(
                            `SELECT COALESCE(SUM(
                                      CASE
                                        WHEN p.loaigd IN (1, 5, 7, 10) THEN ct.soluong
                                        WHEN p.loaigd IN (2, 4, 6) THEN -ct.soluong
                                        WHEN p.loaigd = 9 THEN -ABS(ct.soluong)
                                        ELSE 0
                                      END
                                    ), 0) AS delta_trong_luc_kiem
                               FROM public.chitietgiaodichkho ct
                               JOIN public.phieugiaodichkho p ON p.magiaodich = ct.magiaodich
                              WHERE COALESCE(p.tenantid::text, 'DEFAULT') = $1::text
                                AND COALESCE(NULLIF(NULLIF(p.branchid::text, ''), 'DEFAULT'), $1::text || '_MAIN') = $2::text
                                AND ct.manl = $3::text
                                AND p.thoigiantao >= $4::timestamptz
                                AND p.thoigiantao <= now()
                                AND COALESCE(p.trangthaiduyet, 'POSTED') = 'POSTED'`,
                            [tenantId, branchId, row.maNL, startTs]
                        );
                        inFlightDelta = lam3(dRes.rows[0]?.delta_trong_luc_kiem || 0);
                    }

                    // Tồn thực tế quy về hiện tại = Đếm được tại lúc đi kiểm + Biến động bán/nhập giữa chừng!
                    const adjustedActual = lam3(row.countedBase + inFlightDelta);
                    const systemNow = lam3(st.soLuongTon);
                    const diff = lam3(adjustedActual - systemNow);
                    const absDiffPct = Math.abs(diff) / Math.max(Math.abs(systemNow), 1);
                    const absDiffVal = Math.round(Math.abs(diff) * st.giaVonDonVi);
                    totalAbsVarianceValue += absDiffVal;

                    if (Math.abs(diff) > 0.001 && (absDiffPct > 0.05 || absDiffVal > 100000)) {
                        recountNeededCodes.push({ maNL: row.maNL, tenNL: st.tenNL, donViTinh: st.donViTinh });
                    }

                    evaluated.push({
                        ...row,
                        st,
                        inFlightDelta,
                        adjustedActual,
                        systemNow,
                        diff,
                        absDiffVal,
                    });
                }

                // Kiểm tra Đếm lại 1 lần (Blind Recount Challenge) — TUYỆT ĐỐI KHÔNG tiết lộ systemNow hay diff!
                if (recountNeededCodes.length > 0 && !Boolean(recountConfirmed) && !isManager) {
                    if (sessionRow) {
                        await client.query(
                            `UPDATE public.phien_kiemkho_mu SET solandemlai = solandemlai + 1 WHERE id = $1::text`,
                            [sessionRow.id]
                        );
                    }
                    return {
                        recountRequired: true,
                        recountItems: recountNeededCodes,
                    };
                }

                const needsApproval = !isManager && totalAbsVarianceValue > 200000;
                const statusDuyet = needsApproval ? 'PENDING_APPROVAL' : 'POSTED';
                const ca = await layCaDangMo(client, 'SHARE', tenantId, { branchId });
                const maCa = sessionRow?.macathungan || (ca ? String(ca.macathungan) : null);

                const pRes = await client.query(
                    `INSERT INTO public.phieugiaodichkho
                        (manv, loaigd, ghichu, tenantid, branchid, macathungan, trangthaiduyet, thoidiemkiemke, ngaychungtu)
                     VALUES ($1, 3, $2, $3, $4, $5, $6, $7::timestamptz, $8::date)
                     RETURNING magiaodich`,
                    [
                        req.user.maNV,
                        String(ghiChu || 'Kiểm kho mù 60 giây').slice(0, 255),
                        tenantId,
                        branchId,
                        maCa,
                        statusDuyet,
                        startTs || null,
                        docDate,
                    ]
                );
                const maGD = pRes.rows[0].magiaodich;

                for (const ev of evaluated) {
                    const note = `Đếm: ${ev.compoundDesc} (= ${ev.countedBase}) | Bù bán giữa chừng: ${ev.inFlightDelta >= 0 ? '+' : ''}${ev.inFlightDelta} -> Quy về: ${ev.adjustedActual}`;
                    await insertLedgerLine(client, {
                        maGiaoDich: maGD,
                        maNL: ev.maNL,
                        soLuong: ev.diff,
                        donGiaNhap: ev.st.giaVonDonVi,
                        tinhTrang: note,
                        tonTruoc: ev.systemNow,
                        tonSau: needsApproval ? ev.systemNow : ev.adjustedActual,
                        giaVonTruoc: ev.st.giaVonDonVi,
                        giaVonSau: ev.st.giaVonDonVi,
                    });

                    if (!needsApproval) {
                        await updateBranchStockRow(client, {
                            tenantId,
                            branchId,
                            maNL: ev.maNL,
                            nextQty: ev.adjustedActual,
                        });
                        // Cập nhật mốc tồn cuối ca cho Báo cáo AvT theo ca!
                        if (maCa) {
                            await client.query(
                                `INSERT INTO public.chotton_ca (tenantid, branchid, macathungan, manl, tondauca, toncuoica, giavonca)
                                 VALUES ($1::varchar, $2::varchar, $3::text, $4::varchar, $5::numeric, $6::numeric, $7::numeric)
                                 ON CONFLICT (tenantid, macathungan, manl)
                                 DO UPDATE SET toncuoica = EXCLUDED.toncuoica, giavonca = EXCLUDED.giavonca, thoigianchot = now()`,
                                [tenantId, branchId, maCa, ev.maNL, ev.systemNow, ev.adjustedActual, ev.st.giaVonDonVi]
                            );
                        }
                    }
                }

                if (sessionRow) {
                    await client.query(
                        `UPDATE public.phien_kiemkho_mu
                            SET trangthai = $2::varchar, magiaodich = $3::varchar, thoigiannop = now()
                          WHERE id = $1::text`,
                        [sessionRow.id, needsApproval ? 'SUBMITTED' : 'APPROVED', String(maGD)]
                    );
                }

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: needsApproval ? 'BLIND_STOCKTAKE_PENDING_APPROVAL' : 'BLIND_STOCKTAKE_POSTED',
                    doiTuong: 'KHO',
                    maDoiTuong: String(maGD),
                    giaTriMoi: {
                        branchId,
                        sessionId,
                        statusDuyet,
                        totalAbsVarianceValue,
                        items: evaluated.map((e) => ({
                            maNL: e.maNL,
                            countedBase: e.countedBase,
                            inFlightDelta: e.inFlightDelta,
                            adjustedActual: e.adjustedActual,
                            diff: e.diff,
                        })),
                    },
                    ip: req.ip,
                    batBuoc: true,
                });

                if (needsApproval && typeof dispatchFraudAlertFromAudit === 'function') {
                    void dispatchFraudAlertFromAudit(pool, {
                        tenantId,
                        hanhDong: 'BLIND_STOCKTAKE_PENDING_APPROVAL',
                        maNV: req.user.maNV,
                        maDoiTuong: String(maGD),
                        giaTriMoi: { branchId, totalAbsVarianceValue },
                        lyDo: `⚠️ Phiếu kiểm kho mù #${maGD} lệch ${totalAbsVarianceValue.toLocaleString('vi-VN')}đ đang chờ Chủ quán duyệt!`,
                    }).catch(() => {});
                }

                return {
                    recountRequired: false,
                    maGiaoDich: maGD,
                    branchId,
                    trangThaiDuyet: statusDuyet,
                    ...(isManager ? { totalAbsVarianceValue } : {}),
                    items: evaluated.map((e) => ({
                        maNL: e.maNL,
                        tenNL: e.st.tenNL,
                        countedBase: e.countedBase,
                        inFlightDelta: e.inFlightDelta,
                        adjustedActual: e.adjustedActual,
                        ...(isManager ? { systemBefore: e.systemNow, diff: e.diff, absDiffVal: e.absDiffVal } : {}),
                    })),
                };
            }, tenantId);

            if (out.recountRequired) {
                return res.status(422).json({
                    code: 'BLIND_STOCK_RECOUNT',
                    maLoi: 'BLIND_STOCK_RECOUNT',
                    message:
                        'Một số nguyên liệu có sai lệch lớn so với tiêu hao — vui lòng cân/đếm lại lần 2 rồi bấm xác nhận!',
                    recountItems: out.recountItems,
                });
            }

            res.json({
                message:
                    out.trangThaiDuyet === 'PENDING_APPROVAL'
                        ? isManager
                            ? `⏳ Đã gửi phiếu kiểm kho #${out.maGiaoDich} chờ Chủ quán duyệt (lệch > 200.000đ)!`
                            : `⏳ Đã gửi phiếu kiểm kho #${out.maGiaoDich} chờ Quản lý duyệt!`
                        : `✅ Đã hoàn tất kiểm kho mù #${out.maGiaoDich} (đã bù trừ tiêu hao bán hàng giữa chừng)!`,
                ...out,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Nộp phiếu kiểm kho mù:');
        }
    });

    app.post('/api/kho/kiem-ke/:maGD/approve', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const maGD = String(req.params.maGD || '').trim();
        const approve = req.body?.approve !== false;

        try {
            const out = await chayGiaoDich(async (client) => {
                const pRes = await client.query(
                    `SELECT magiaodich, loaigd, trangthaiduyet,
                            COALESCE(NULLIF(NULLIF(branchid::text, ''), 'DEFAULT'), $1::text || '_MAIN') AS branchid
                       FROM public.phieugiaodichkho
                      WHERE magiaodich::text = $2::text AND COALESCE(tenantid::text, 'DEFAULT') = $1::text
                      FOR UPDATE`,
                    [tenantId, maGD]
                );
                if (pRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy phiếu kiểm kho!');
                const p = pRes.rows[0];
                if (p.trangthaiduyet !== 'PENDING_APPROVAL') {
                    throw new LoiNghiepVu(409, `Phiếu #${maGD} không ở trạng thái chờ duyệt (${p.trangthaiduyet})!`);
                }

                if (!approve) {
                    await client.query(
                        `UPDATE public.phieugiaodichkho SET trangthaiduyet = 'REJECTED', nguoiduyet = $2 WHERE magiaodich = $1`,
                        [p.magiaodich, req.user.maNV]
                    );
                    await client.query(
                        `UPDATE public.phien_kiemkho_mu SET trangthai = 'REJECTED' WHERE tenantid = $1::text AND magiaodich = $2::text`,
                        [tenantId, String(p.magiaodich)]
                    );
                    return { maGiaoDich: p.magiaodich, trangThaiDuyet: 'REJECTED' };
                }

                const ctRes = await client.query(
                    `SELECT manl, soluong, tontruoc FROM public.chitietgiaodichkho WHERE magiaodich = $1 ORDER BY manl ASC`,
                    [p.magiaodich]
                );
                const { branchId, stockMap } = await lockBranchStockOrdered(
                    client,
                    tenantId,
                    p.branchid,
                    ctRes.rows.map((r) => r.manl)
                );

                for (const row of ctRes.rows) {
                    const st = stockMap.get(row.manl);
                    if (!st) continue;
                    const nextQty = lam3(st.soLuongTon + Number(row.soluong || 0));
                    await updateBranchStockRow(client, { tenantId, branchId, maNL: row.manl, nextQty });
                    await client.query(
                        `UPDATE public.chitietgiaodichkho SET tonsau = $3::numeric WHERE magiaodich = $1 AND manl = $2`,
                        [p.magiaodich, row.manl, nextQty]
                    );
                }

                await client.query(
                    `UPDATE public.phieugiaodichkho SET trangthaiduyet = 'POSTED', nguoiduyet = $2 WHERE magiaodich = $1`,
                    [p.magiaodich, req.user.maNV]
                );
                await client.query(
                    `UPDATE public.phien_kiemkho_mu SET trangthai = 'APPROVED' WHERE tenantid = $1::text AND magiaodich = $2::text`,
                    [tenantId, String(p.magiaodich)]
                );

                return { maGiaoDich: p.magiaodich, branchId, trangThaiDuyet: 'POSTED' };
            }, tenantId);

            res.json({
                message:
                    out.trangThaiDuyet === 'POSTED'
                        ? `✅ Chủ quán đã duyệt phiếu kiểm kho #${out.maGiaoDich} và cập nhật tồn kho!`
                        : `🚫 Đã từ chối phiếu kiểm kho #${out.maGiaoDich}!`,
                ...out,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Duyệt phiếu kiểm kho:');
        }
    });

    // =========================================================================
    // 5. CHỐT TỒN CA & BÁO CÁO AvT (ACTUAL vs. THEORETICAL) THEO TỪNG CA
    // =========================================================================
    app.post('/api/kho/avt-by-shift/snapshot', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const { maCaThuNgan = null, branchId: rawBranch = null, loaiMoc = 'OPENING', items = [] } = req.body || {};
        const moc = String(loaiMoc || 'OPENING').toUpperCase();
        if (!['OPENING', 'CLOSING'].includes(moc)) {
            return res.status(400).json({ message: 'loaiMoc phải là OPENING hoặc CLOSING!' });
        }

        try {
            const out = await chayGiaoDich(async (client) => {
                const bId = normalizeInventoryBranch(tenantId, rawBranch || req.user.branchId || null);
                let shiftId = maCaThuNgan;
                if (!shiftId) {
                    const ca = await layCaDangMo(client, 'SHARE', tenantId, { branchId: bId });
                    if (!ca) throw new LoiNghiepVu(409, 'Không có ca thu ngân nào đang mở!');
                    shiftId = ca.macathungan;
                }

                const maNLList = items.map((x) => String(x?.maNL || '').trim()).filter(Boolean);
                const { branchId, stockMap } = await lockBranchStockOrdered(client, tenantId, bId, maNLList);

                for (const it of items) {
                    const maNL = String(it?.maNL || '').trim();
                    if (!maNL || !stockMap.has(maNL)) continue;
                    const st = stockMap.get(maNL);
                    const qty = it.soLuong !== undefined ? lam3(it.soLuong) : lam3(st.soLuongTon);
                    if (moc === 'OPENING') {
                        await client.query(
                            `INSERT INTO public.chotton_ca (tenantid, branchid, macathungan, manl, tondauca, giavonca)
                             VALUES ($1::varchar, $2::varchar, $3::text, $4::varchar, $5::numeric, $6::numeric)
                             ON CONFLICT (tenantid, macathungan, manl)
                             DO UPDATE SET tondauca = EXCLUDED.tondauca, giavonca = EXCLUDED.giavonca, thoigianchot = now()`,
                            [tenantId, branchId, String(shiftId), maNL, qty, st.giaVonDonVi]
                        );
                    } else {
                        await client.query(
                            `INSERT INTO public.chotton_ca (tenantid, branchid, macathungan, manl, tondauca, toncuoica, giavonca)
                             VALUES ($1::varchar, $2::varchar, $3::text, $4::varchar, $5::numeric, $6::numeric, $7::numeric)
                             ON CONFLICT (tenantid, macathungan, manl)
                             DO UPDATE SET toncuoica = EXCLUDED.toncuoica, giavonca = EXCLUDED.giavonca, thoigianchot = now()`,
                            [tenantId, branchId, String(shiftId), maNL, st.soLuongTon, qty, st.giaVonDonVi]
                        );
                    }
                }
                return { maCaThuNgan: shiftId, branchId, loaiMoc: moc, count: items.length };
            }, tenantId);

            res.json({ message: `✅ Đã chốt tồn ${out.loaiMoc} cho ca #${out.maCaThuNgan}!`, ...out });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Chốt tồn theo ca:');
        }
    });

    app.get('/api/kho/avt-by-shift', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const rawCa = req.query.maCaThuNgan || null;
        const branchId = req.query.branchId || null;
        const dispatchAlerts = String(req.query.dispatchAlerts ?? 'true') !== 'false';

        try {
            const report = await pool.withTenant(tenantId, async (client) => {
                let targetCa = rawCa;
                if (!targetCa) {
                    const ca = await layCaDangMo(client, undefined, tenantId, { branchId });
                    if (ca) targetCa = ca.macathungan;
                    else {
                        const lastRes = await client.query(
                            `SELECT macathungan FROM public.cathungan
                              WHERE COALESCE(tenantid::text, 'DEFAULT') = $1::text
                              ORDER BY thoigianmoca DESC LIMIT 1`,
                            [tenantId]
                        );
                        targetCa = lastRes.rows[0]?.macathungan || null;
                    }
                }
                if (!targetCa) return null;
                const rep = await computeShiftAvtReport(client, { tenantId, branchId, maCaThuNgan: targetCa });

                if (rep && dispatchAlerts && rep.flaggedItems.length > 0) {
                    const top = rep.flaggedItems[0];
                    const alertMsg = `🚨 AvT Ca (${rep.tenNV}): ${top.tenNL} tiêu hao thực ${top.actualUsage}${top.donViTinh} vs Lý thuyết ${top.theoreticalUsage}${top.donViTinh} — Thất thoát vô danh +${top.unexplainedVariance}${top.donViTinh} (${top.variancePct}% ≈ ${top.varianceValue.toLocaleString('vi-VN')}đ)!`;
                    await ghiAuditLog(client, {
                        tenantId,
                        maNV: req.user.maNV,
                        vaiTro: req.user.vaiTro,
                        hanhDong: 'SHIFT_AVT_VARIANCE_ALERT',
                        doiTuong: 'CATHUNGAN',
                        maDoiTuong: String(rep.maCaThuNgan),
                        giaTriMoi: { flaggedItems: rep.flaggedItems },
                        lyDo: alertMsg,
                        ip: req.ip,
                        batBuoc: true,
                    });
                    if (typeof dispatchFraudAlertFromAudit === 'function') {
                        void dispatchFraudAlertFromAudit(pool, {
                            tenantId,
                            hanhDong: 'SHIFT_AVT_VARIANCE_ALERT',
                            maNV: req.user.maNV,
                            maDoiTuong: String(rep.maCaThuNgan),
                            giaTriMoi: { flaggedCount: rep.flaggedItems.length, topItem: top },
                            lyDo: alertMsg,
                        }).catch(() => {});
                    }
                    rep.telegramAlertTriggered = true;
                    rep.telegramAlertPreview = alertMsg;
                } else if (rep) {
                    rep.telegramAlertTriggered = false;
                }

                return rep;
            });

            if (!report) return res.status(404).json({ message: 'Chưa có ca thu ngân nào để tính báo cáo AvT!' });
            res.json(report);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Báo cáo AvT theo ca:');
        }
    });

    // =========================================================================
    // 6. NHÀ CUNG CẤP, AUTO-PO TỪ AI FORECAST 60 NGÀY, GRN NHẬN HÀNG & KHÓA SỔ KHO
    // =========================================================================
    app.get('/api/kho/nhacungcap', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const r = await qTenant(
                req,
                `SELECT mancc, tenncc, sodienthoai, zalo, diachi, ngaygiaomacdinh, danghoatdong, thoigiantao
                   FROM public.nhacungcap
                  WHERE tenantid = $1::text
                  ORDER BY tenncc ASC`,
                [tenantId]
            );
            res.json(
                r.rows.map((x) => ({
                    maNCC: x.mancc,
                    tenNCC: x.tenncc,
                    soDienThoai: x.sodienthoai || '',
                    zalo: x.zalo || '',
                    diaChi: x.diachi || '',
                    ngayGiaoMacDinh: Number(x.ngaygiaomacdinh || 1),
                    dangHoatDong: Boolean(x.danghoatdong),
                }))
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Danh sách nhà cung cấp:');
        }
    });

    app.post('/api/kho/nhacungcap', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const { tenNCC, soDienThoai = '', zalo = '', diaChi = '', ngayGiaoMacDinh = 1 } = req.body || {};
        if (!tenNCC || String(tenNCC).trim().length < 2) {
            return res.status(400).json({ message: 'Vui lòng nhập tên nhà cung cấp!' });
        }
        const maNCC = `NCC_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        try {
            await qTenant(
                req,
                `INSERT INTO public.nhacungcap (mancc, tenantid, tenncc, sodienthoai, zalo, diachi, ngaygiaomacdinh)
                 VALUES ($1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::varchar, $6::text, $7::int)`,
                [
                    maNCC,
                    tenantId,
                    String(tenNCC).trim().slice(0, 150),
                    String(soDienThoai || '').trim().slice(0, 32),
                    String(zalo || '').trim().slice(0, 64),
                    String(diaChi || '').trim(),
                    Math.max(1, Math.floor(Number(ngayGiaoMacDinh || 1))),
                ]
            );
            res.status(201).json({ message: `✅ Đã tạo nhà cung cấp "${tenNCC}"!`, maNCC });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Tạo nhà cung cấp:');
        }
    });

    app.get('/api/kho/po', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const [poRes, ctRes] = await Promise.all([
                qTenant(
                    req,
                    `SELECT po.mapo, po.branchid, po.mancc, ncc.tenncc, po.trangthai,
                            po.tongtiendukien, po.ngaydukiennhan, po.ghichu, po.manvtao, po.thoigiantao
                       FROM public.dondathang_ncc po
                       LEFT JOIN public.nhacungcap ncc ON ncc.mancc = po.mancc
                      WHERE po.tenantid = $1::text
                      ORDER BY po.thoigiantao DESC
                      LIMIT 50`,
                    [tenantId]
                ),
                qTenant(
                    req,
                    `SELECT ct.id, ct.mapo, ct.manl, nl.tennl, nl.donvitinh,
                            ct.tendonvidat, ct.hesoquydoi, ct.soluongdat, ct.soluongdanhan, ct.dongiadukien
                       FROM public.chitiet_dondathang_ncc ct
                       LEFT JOIN public.nguyenlieu nl ON nl.manl = ct.manl
                      WHERE ct.tenantid = $1::text`,
                    [tenantId]
                ),
            ]);
            const ctMap = new Map();
            for (const c of ctRes.rows) {
                if (!ctMap.has(c.mapo)) ctMap.set(c.mapo, []);
                ctMap.get(c.mapo).push({
                    id: Number(c.id),
                    maNL: c.manl,
                    tenNL: c.tennl || c.manl,
                    donViGoc: c.donvitinh || '',
                    tenDonViDat: c.tendonvidat,
                    heSoQuyDoi: Number(c.hesoquydoi),
                    soLuongDat: Number(c.soluongdat),
                    soLuongDaNhan: Number(c.soluongdanhan),
                    donGiaDuKien: Number(c.dongiadukien),
                });
            }
            res.json(
                poRes.rows.map((p) => ({
                    maPO: p.mapo,
                    branchId: p.branchid,
                    maNCC: p.mancc,
                    tenNCC: p.tenncc || 'NCC Tự do',
                    trangThai: p.trangthai,
                    tongTienDuKien: Number(p.tongtiendukien || 0),
                    ngayDuKienNhan: p.ngaydukiennhan,
                    ghiChu: p.ghichu || '',
                    thoiGianTao: p.thoigiantao,
                    chiTiet: ctMap.get(p.mapo) || [],
                }))
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Danh sách đơn đặt hàng NCC:');
        }
    });

    app.post('/api/kho/po/auto-generate', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = normalizeInventoryBranch(tenantId, req.body?.branchId || null);
        const daysCover = Math.min(30, Math.max(1, Number(req.body?.daysCover || 5)));

        try {
            const generated = await chayGiaoDich(async (client) => {
                await ensureBranchRecord(client, tenantId, branchId);
                // Tính tốc độ tiêu hao trung bình/ngày trong 60 ngày gần nhất + so với tồn hiện tại & hạn mức
                const velRes = await client.query(
                    `SELECT nl.manl, nl.tennl, nl.donvitinh, nl.manccmacdinh,
                            COALESCE(tk.soluongton, nl.soluongton, 0) AS ton_hien_tai,
                            COALESCE(tk.hanmuccanhbao, nl.hanmuccanhbao, 0) AS han_muc,
                            COALESCE(tk.giavondonvi, nl.giavondonvi, 0) AS gia_von,
                            COALESCE((
                                SELECT SUM(ct.soluong) / 60.0
                                  FROM public.chitietgiaodichkho ct
                                  JOIN public.phieugiaodichkho p ON p.magiaodich = ct.magiaodich
                                 WHERE COALESCE(p.tenantid::text, 'DEFAULT') = $1::text
                                   AND ct.manl = nl.manl
                                   AND p.loaigd = 6
                                   AND p.thoigiantao >= now() - interval '60 days'
                            ), 0) AS avg_daily_usage,
                            COALESCE(ncc.ngaygiaomacdinh, 1) AS lead_time
                       FROM public.nguyenlieu nl
                       LEFT JOIN public.tonkhochinhanh tk
                         ON tk.tenantid = $1::text AND tk.branchid = $2::text AND tk.manl = nl.manl
                       LEFT JOIN public.nhacungcap ncc ON ncc.mancc = nl.manccmacdinh
                      WHERE COALESCE(nl.tenantid::text, 'DEFAULT') = $1::text
                        AND nl.daxoa = FALSE`,
                    [tenantId, branchId]
                );

                const uomRes = await client.query(
                    `SELECT manl, tendonvi, hesoquydoi, lamacdinhnhap
                       FROM public.nguyenlieu_donviquydoi
                      WHERE tenantid = $1::text
                      ORDER BY lamacdinhnhap DESC, hesoquydoi DESC`,
                    [tenantId]
                );
                const defUomMap = new Map();
                for (const u of uomRes.rows) {
                    if (!defUomMap.has(u.manl)) defUomMap.set(u.manl, u);
                }

                const bySupplier = new Map();
                for (const r of velRes.rows) {
                    const ton = Number(r.ton_hien_tai || 0);
                    const hanMuc = Number(r.han_muc || 0);
                    const avgDaily = Number(r.avg_daily_usage || 0);
                    const leadDays = Number(r.lead_time || 1);
                    const targetStock = Math.max(hanMuc * 2, avgDaily * (daysCover + leadDays));
                    const needBase = Math.max(0, targetStock - ton);
                    if (needBase <= 0 && ton > hanMuc) continue;

                    const qtyBaseNeeded = needBase > 0 ? needBase : Math.max(hanMuc, 1);
                    const uom = defUomMap.get(r.manl);
                    const hs = uom ? Number(uom.hesoquydoi) : 1;
                    const unitName = uom ? uom.tendonvi : r.donvitinh;
                    const qtyUnits = Math.max(1, Math.ceil(qtyBaseNeeded / hs));
                    const unitPrice = lam2(Number(r.gia_von || 0) * hs);

                    const key = r.manccmacdinh || '__DEFAULT__';
                    if (!bySupplier.has(key)) bySupplier.set(key, { leadDays, items: [] });
                    bySupplier.get(key).items.push({
                        maNL: r.manl,
                        tenNL: r.tennl,
                        tenDonViDat: unitName,
                        heSoQuyDoi: hs,
                        soLuongDat: qtyUnits,
                        donGiaDuKien: unitPrice,
                    });
                }

                const createdPOs = [];
                for (const [supKey, group] of bySupplier.entries()) {
                    const maPO = `PO_${todayDateVN().replace(/-/g, '')}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
                    const tongDuKien = lam2(group.items.reduce((s, it) => s + it.soLuongDat * it.donGiaDuKien, 0));
                    const etaDate = new Date(Date.now() + (7 + group.leadDays * 24) * 3600000).toISOString().slice(0, 10);

                    await client.query(
                        `INSERT INTO public.dondathang_ncc
                            (mapo, tenantid, branchid, mancc, trangthai, tongtiendukien, ngaydukiennhan, ghichu, manvtao)
                         VALUES ($1::varchar, $2::varchar, $3::varchar, $4::varchar, 'DRAFT', $5::numeric, $6::date, $7::text, $8::varchar)`,
                        [
                            maPO,
                            tenantId,
                            branchId,
                            supKey === '__DEFAULT__' ? null : supKey,
                            tongDuKien,
                            etaDate,
                            `Auto-PO dự báo ${daysCover} ngày + Lead time ${group.leadDays} ngày`,
                            req.user.maNV,
                        ]
                    );
                    for (const it of group.items) {
                        await client.query(
                            `INSERT INTO public.chitiet_dondathang_ncc
                                (tenantid, mapo, manl, tendonvidat, hesoquydoi, soluongdat, dongiadukien)
                             VALUES ($1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::numeric, $6::numeric, $7::numeric)`,
                            [tenantId, maPO, it.maNL, it.tenDonViDat, it.heSoQuyDoi, it.soLuongDat, it.donGiaDuKien]
                        );
                    }
                    const zaloText =
                        `[ĐẶT HÀNG ${maPO}] Giao ngày ${etaDate}:\n` +
                        group.items.map((x) => `- ${x.tenNL}: ${x.soLuongDat} ${x.tenDonViDat}`).join('\n');
                    createdPOs.push({ maPO, maNCC: supKey === '__DEFAULT__' ? null : supKey, tongDuKien, etaDate, items: group.items, zaloText });
                }

                return createdPOs;
            }, tenantId);

            res.status(201).json({
                message:
                    generated.length > 0
                        ? `🤖 Đã tạo tự động ${generated.length} Đơn đặt hàng NCC (Auto-PO) từ dự báo tiêu hao!`
                        : '✅ Tồn kho hiện tại đang đủ định mức, chưa cần tạo Auto-PO!',
                orders: generated,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Tạo Auto-PO:');
        }
    });

    // Nhận hàng từ PO -> tạo phiếu Nhập kho (GRN) hỗ trợ nhận 1 phần (PARTIAL_RECEIVED) hoặc đủ (RECEIVED)
    app.post('/api/kho/po/:maPO/receive', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const maPO = String(req.params.maPO || '').trim();
        const { chiPhiVanChuyen = 0, giamGiaNCC = 0, ngayChungTu = null, ghiChu = '', receivedItems = [] } = req.body || {};

        try {
            const out = await chayGiaoDich(async (client) => {
                const poRes = await client.query(
                    `SELECT mapo, branchid, mancc, trangthai FROM public.dondathang_ncc
                      WHERE mapo = $1::text AND tenantid = $2::text FOR UPDATE`,
                    [maPO, tenantId]
                );
                if (poRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy đơn đặt hàng NCC!');
                const po = poRes.rows[0];
                if (['RECEIVED', 'CANCELLED'].includes(po.trangthai)) {
                    throw new LoiNghiepVu(409, `Đơn PO #${maPO} đã ở trạng thái ${po.trangthai}!`);
                }

                const docDate = await assertPeriodNotLocked(client, tenantId, po.branchid, ngayChungTu, LoiNghiepVu);

                const ctRes = await client.query(
                    `SELECT id, manl, tendonvidat, hesoquydoi, soluongdat, soluongdanhan, dongiadukien
                       FROM public.chitiet_dondathang_ncc
                      WHERE mapo = $1::text AND tenantid = $2::text
                      ORDER BY manl ASC`,
                    [maPO, tenantId]
                );
                const recvMap = new Map((receivedItems || []).map((x) => [String(x.maNL), x]));
                const toReceive = [];
                for (const c of ctRes.rows) {
                    const custom = recvMap.get(c.manl);
                    const remain = lam3(Number(c.soluongdat) - Number(c.soluongdanhan));
                    const slNhanDonVi = custom ? Number(custom.soLuongNhan) : remain;
                    if (!(slNhanDonVi > 0)) continue;
                    const donGiaDonVi = custom && custom.donGiaThucTe !== undefined ? Number(custom.donGiaThucTe) : Number(c.dongiadukien);
                    toReceive.push({
                        ctId: Number(c.id),
                        maNL: c.manl,
                        tenDonViDat: c.tendonvidat,
                        heSoQuyDoi: Number(c.hesoquydoi || 1),
                        slNhanDonVi,
                        slBase: lam3(slNhanDonVi * Number(c.hesoquydoi || 1)),
                        tongTienHang: lam2(slNhanDonVi * donGiaDonVi),
                        hanSuDung: custom?.hanSuDung || null,
                    });
                }
                if (toReceive.length === 0) throw new LoiNghiepVu(400, 'Không có dòng hàng nào có số lượng thực nhận > 0!');

                const { branchId, stockMap } = await lockBranchStockOrdered(
                    client,
                    tenantId,
                    po.branchid,
                    toReceive.map((r) => r.maNL)
                );
                const landedAlloc = allocateLandedCost(toReceive, chiPhiVanChuyen, giamGiaNCC);

                const pRes = await client.query(
                    `INSERT INTO public.phieugiaodichkho
                        (manv, loaigd, ghichu, tenantid, branchid, chiphivanchuyen, giamgianhacc, mancc, mapo, ngaychungtu, trangthaiduyet)
                     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9::date, 'POSTED')
                     RETURNING magiaodich`,
                    [
                        req.user.maNV,
                        (ghiChu || `Nhận hàng GRN từ PO ${maPO}`).slice(0, 255),
                        tenantId,
                        branchId,
                        lam2(chiPhiVanChuyen),
                        lam2(giamGiaNCC),
                        po.mancc || null,
                        maPO,
                        docDate,
                    ]
                );
                const maGD = pRes.rows[0].magiaodich;

                let totalCogsAdj = 0;
                const priceSpikeAlerts = [];

                for (let i = 0; i < toReceive.length; i++) {
                    const item = toReceive[i];
                    const st = stockMap.get(item.maNL);
                    const landed = landedAlloc[i] || 0;
                    const wac = computeSafeWacOnStockIn({
                        tonCu: st.soLuongTon,
                        giaVonCu: st.giaVonDonVi,
                        slNhapBase: item.slBase,
                        tongTienHang: item.tongTienHang,
                        chiPhiPhanBo: landed,
                    });
                    totalCogsAdj = lam2(totalCogsAdj + wac.cogsAdjustment);
                    if (Math.abs(wac.cogsAdjustment) >= 0.01) {
                        await recordCogsAdjustment(client, {
                            tenantId,
                            branchId,
                            businessDate: ngayChungTu || todayDateVN(),
                            maNL: item.maNL,
                            sourceType: 'NEGATIVE_STOCK_CATCHUP',
                            refMaGiaoDich: maGD,
                            qtyAffected: Math.min(Math.abs(st.soLuongTon), item.slBase),
                            oldUnitCost: st.giaVonDonVi,
                            newUnitCost: wac.donGiaNhapThucTe,
                            adjustmentAmount: wac.cogsAdjustment,
                            createdBy: req.user.maNV,
                        });
                    }
                    const tonSau = lam3(st.soLuongTon + item.slBase);

                    await insertLedgerLine(client, {
                        maGiaoDich: maGD,
                        maNL: item.maNL,
                        soLuong: item.slBase,
                        donGiaNhap: wac.donGiaNhapThucTe,
                        tinhTrang: `GRN ${maPO}: ${item.slNhanDonVi} ${item.tenDonViDat}`,
                        tonTruoc: st.soLuongTon,
                        tonSau,
                        giaVonTruoc: st.giaVonDonVi,
                        giaVonSau: wac.giaVonMoi,
                        donViNhap: item.tenDonViDat,
                        heSoQuyDoi: item.heSoQuyDoi,
                        soLuongTheoDonVi: item.slNhanDonVi,
                        chiPhiPhanBo: landed,
                    });

                    await updateBranchStockRow(client, {
                        tenantId,
                        branchId,
                        maNL: item.maNL,
                        nextQty: tonSau,
                        nextWac: wac.giaVonMoi,
                    });

                    if (item.hanSuDung || st.theoDoiHanDung) {
                        await createFefoLot(client, {
                            tenantId,
                            branchId,
                            maNL: item.maNL,
                            nguonLo: 'PURCHASE',
                            maGiaoDichNguon: String(maGD),
                            soLuong: item.slBase,
                            giaVonLo: wac.donGiaNhapThucTe,
                            thoiGianHetHan: item.hanSuDung || null,
                        });
                    }

                    await client.query(
                        `UPDATE public.chitiet_dondathang_ncc SET soluongdanhan = soluongdanhan + $2::numeric WHERE id = $1::bigint`,
                        [item.ctId, item.slNhanDonVi]
                    );

                    const spike = await detectPriceSpikeAndMarginImpact(client, {
                        tenantId,
                        branchId,
                        maNL: item.maNL,
                        tenNL: st.tenNL,
                        donViTinh: st.donViTinh,
                        newUnitCost: wac.donGiaNhapThucTe,
                        excludeMaGD: maGD,
                    });
                    if (spike) priceSpikeAlerts.push(spike);
                }

                if (totalCogsAdj !== 0) {
                    await client.query(
                        `UPDATE public.phieugiaodichkho SET cogsadjustment = $2::numeric WHERE magiaodich = $1`,
                        [maGD, totalCogsAdj]
                    );
                }

                const remCheck = await client.query(
                    `SELECT COUNT(*) AS pending_lines FROM public.chitiet_dondathang_ncc
                      WHERE mapo = $1::text AND tenantid = $2::text AND soluongdanhan + 0.001 < soluongdat`,
                    [maPO, tenantId]
                );
                const nextPoStatus = Number(remCheck.rows[0].pending_lines) === 0 ? 'RECEIVED' : 'PARTIAL_RECEIVED';
                await client.query(
                    `UPDATE public.dondathang_ncc SET trangthai = $2::varchar WHERE mapo = $1::text AND tenantid = $3::text`,
                    [maPO, nextPoStatus, tenantId]
                );

                const autoUnlocked = autoUn86OnRestock
                    ? await autoUn86OnRestock(client, { tenantId, maNLList: toReceive.map((x) => x.maNL) })
                    : null;

                return { maPO, maGiaoDich: maGD, trangThaiPO: nextPoStatus, totalCogsAdj, priceSpikeAlerts, autoUnlocked };
            }, tenantId);

            if (out.autoUnlocked && io) {
                emitToBranch(io, {
                    tenantId,
                    branchId: out.branchId || req.body?.branchId || req.user?.branchId || 'DEFAULT',
                    roles: ['POS', 'WAITER', 'KDS', 'EXPO'],
                    event: 'menu:86_updated',
                    payload: {
                        type: 'AUTO_UN86_GRN',
                        ...out.autoUnlocked,
                    },
                });
            }

            res.json({
                message: `📦 Đã nhận hàng GRN #${out.maGiaoDich} từ PO ${out.maPO} (${out.trangThaiPO})!`,
                ...out,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Nhận hàng GRN từ PO:');
        }
    });

    // Khóa sổ Kho Định Kỳ (GET / POST /api/kho/khoa-so)
    app.get('/api/kho/khoa-so', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = req.query.branchId ? normalizeInventoryBranch(tenantId, req.query.branchId) : null;
        try {
            const r = await qTenant(
                req,
                `SELECT id, branchid, ngaykhoasoden::text AS ngaykhoasoden, nguoidongso, ghichu, thoigiankhoa
                   FROM public.khoaso_kho
                  WHERE tenantid = $1::text
                    AND ($2::text IS NULL OR branchid = $2::text)
                  ORDER BY ngaykhoasoden DESC
                  LIMIT 30`,
                [tenantId, branchId]
            );
            res.json(
                r.rows.map((x) => ({
                    id: Number(x.id),
                    branchId: x.branchid,
                    ngayKhoaSoDen: x.ngaykhoasoden,
                    nguoiDongSo: x.nguoidongso,
                    ghiChu: x.ghichu || '',
                    thoiGianKhoa: x.thoigiankhoa,
                }))
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Lịch sử khóa sổ kho:');
        }
    });

    app.post('/api/kho/khoa-so', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = normalizeInventoryBranch(tenantId, req.body?.branchId || null);
        const ngayKhoaSoDen = String(req.body?.ngayKhoaSoDen || '').trim();
        const ghiChu = String(req.body?.ghiChu || 'Khóa sổ kế toán kho cuối kỳ').trim();

        if (!/^\d{4}-\d{2}-\d{2}$/.test(ngayKhoaSoDen)) {
            return res.status(400).json({ message: 'ngayKhoaSoDen phải theo định dạng YYYY-MM-DD!' });
        }

        try {
            await chayGiaoDich(async (client) => {
                await ensureBranchRecord(client, tenantId, branchId);
                await client.query(
                    `INSERT INTO public.khoaso_kho (tenantid, branchid, ngaykhoasoden, nguoidongso, ghichu)
                     VALUES ($1::varchar, $2::varchar, $3::date, $4::varchar, $5::text)
                     ON CONFLICT (tenantid, branchid, ngaykhoasoden)
                     DO UPDATE SET nguoidongso = EXCLUDED.nguoidongso, ghichu = EXCLUDED.ghichu, thoigiankhoa = now()`,
                    [tenantId, branchId, ngayKhoaSoDen, req.user.maNV, ghiChu]
                );
                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'INVENTORY_PERIOD_LOCKED',
                    doiTuong: 'KHO',
                    maDoiTuong: `${branchId}:${ngayKhoaSoDen}`,
                    giaTriMoi: { branchId, ngayKhoaSoDen, ghiChu },
                    ip: req.ip,
                    batBuoc: true,
                });
            }, tenantId);

            res.status(201).json({
                message: `🔒 Đã khóa sổ kho chi nhánh ${branchId} đến hết ngày ${ngayKhoaSoDen}!`,
                branchId,
                ngayKhoaSoDen,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Khóa sổ kho định kỳ:');
        }
    });

    // Tra cứu Barcode Đơn vị tính kho (cho súng quét mã vạch trên Kho.jsx)
    app.get('/api/kho/barcode/:code', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const code = String(req.params.code || '').trim();
        if (!code) return res.status(400).json({ message: 'Thiếu mã vạch!' });
        try {
            const r = await qTenant(
                req,
                `SELECT q.id, q.manl, nl.tennl, nl.donvitinh, q.tendonvi, q.hesoquydoi, q.mavachdonvi
                   FROM public.nguyenlieu_donviquydoi q
                   JOIN public.nguyenlieu nl ON nl.manl = q.manl AND COALESCE(nl.tenantid::text, 'DEFAULT') = $1::text
                  WHERE q.tenantid = $1::text AND q.mavachdonvi = $2::text
                  LIMIT 1`,
                [tenantId, code]
            );
            if (r.rows.length === 0) return res.status(404).json({ message: `Không tìm thấy mã vạch "${code}" trong cấu hình đơn vị kho!` });
            const row = r.rows[0];
            res.json({
                id: Number(row.id),
                maNL: row.manl,
                tenNL: row.tennl,
                donViGoc: row.donvitinh,
                tenDonVi: row.tendonvi,
                heSoQuyDoi: Number(row.hesoquydoi),
                maVachDonVi: row.mavachdonvi,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Quét mã vạch kho:');
        }
    });

    // Danh sách 6 mã lý do xuất hủy chuẩn (Wastage Taxonomy)
    app.get('/api/kho/wastage-taxonomy', kiemTraToken, (_req, res) => {
        res.json(WASTAGE_TAXONOMY);
    });
}

module.exports = { registerInventoryCogsPhase4Routes };
