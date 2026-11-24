/**
 * =============================================================================
 * PHÂN HỆ 3 ROUTES: VIETQR MANUAL MATCH & OVERPAYMENT, PRE-CLOSE GATE,
 * RECEIPT PHOTO UPLOAD, SAFE DROP TWO-MAN RULE, SHIFT POLICY & EOD 3-WAY RECONCILIATION
 * =============================================================================
 */
const crypto = require('crypto');
const { uploadReceiptPhoto, readLocalReceiptPhoto } = require('./storageAdapter');
const {
    DEFAULT_SHIFT_POLICY,
    normalizeBranchForShift,
    getTenantShiftPolicy,
    computePreCloseChecklist,
    computeEndOfDayReconciliation,
} = require('./paymentShiftPhase3Engine');

function registerPaymentShiftPhase3Routes(app, deps) {
    const {
        pool,
        chayGiaoDich,
        qTenant,
        layTenantId,
        kiemTraToken,
        choPhepVaiTro,
        coQuyenHan,
        ghiAuditLog,
        ghiCanhBaoGianLan,
        guiLoi,
        LoiNghiepVu,
        io,
        roomTen,
        layCaDangMo,
        loiChuaMoCa,
        ghiNhanThanhToanTrongGiaoDich,
        ngayHomNayVN,
        handlers = {},
    } = deps;

    // Alias chuẩn theo đặc tả Phân hệ 3 (đảm bảo cả URL mới & URL cũ cùng chạy 1 handler thống nhất!)
    if (handlers.handleMoCa) {
        app.post('/api/ca/mo-ca', kiemTraToken, choPhepVaiTro(1, 4), handlers.handleMoCa);
    }
    if (handlers.handleDoiSoatCa) {
        app.get('/api/ca/doi-soat', kiemTraToken, choPhepVaiTro(1, 4), handlers.handleDoiSoatCa);
    }
    if (handlers.handleDongCa) {
        app.post('/api/ca/dong-ca', kiemTraToken, choPhepVaiTro(1, 4), handlers.handleDongCa);
    }
    if (handlers.handleThuChiCa) {
        app.post('/api/ca/thu-chi', kiemTraToken, choPhepVaiTro(1, 4), handlers.handleThuChiCa);
    }

    // =========================================================================
    // 1. CẤU HÌNH CHÍNH SÁCH CA THU NGÂN (GET / PUT /api/ca/policy)
    // =========================================================================
    app.get('/api/ca/policy', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const policy = await pool.withTenant(tenantId, (client) => getTenantShiftPolicy(client, tenantId));
            res.json({ policy });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Lấy chính sách ca thu ngân:');
        }
    });

    app.put('/api/ca/policy', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const body = req.body || {};
        try {
            const policy = await chayGiaoDich(async (client) => {
                const current = await getTenantShiftPolicy(client, tenantId);
                const next = {
                    preCloseMode: ['STRICT', 'CARRY_OVER'].includes(String(body.preCloseMode || '').toUpperCase())
                        ? String(body.preCloseMode).toUpperCase()
                        : current.preCloseMode,
                    nguongBatBuocChungTu:
                        body.nguongBatBuocChungTu !== undefined
                            ? Math.max(0, Number(body.nguongBatBuocChungTu))
                            : current.nguongBatBuocChungTu,
                    nguongPinPhieuChi:
                        body.nguongPinPhieuChi !== undefined
                            ? Math.max(0, Number(body.nguongPinPhieuChi))
                            : current.nguongPinPhieuChi,
                    hanMucKetTienMat:
                        body.hanMucKetTienMat !== undefined
                            ? Math.max(0, Number(body.hanMucKetTienMat))
                            : current.hanMucKetTienMat,
                    nguongLechCaRecount:
                        body.nguongLechCaRecount !== undefined
                            ? Math.max(0, Number(body.nguongLechCaRecount))
                            : current.nguongLechCaRecount,
                    strictDenomination:
                        body.strictDenomination !== undefined
                            ? Boolean(body.strictDenomination)
                            : current.strictDenomination,
                };
                await client.query(`UPDATE Tenants SET CauHinhCa = $2::jsonb WHERE TenantId = $1`, [
                    tenantId,
                    JSON.stringify(next),
                ]);
                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'SHIFT_POLICY_UPDATED',
                    doiTuong: 'TENANT',
                    maDoiTuong: tenantId,
                    giaTriCu: current,
                    giaTriMoi: next,
                    ip: req.ip,
                });
                return next;
            }, tenantId);

            res.json({ message: 'Đã cập nhật chính sách Ca Thu Ngân!', policy });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Cập nhật chính sách ca:');
        }
    });

    // =========================================================================
    // 2. CỔNG AN TOÀN TRƯỚC KHI ĐÓNG CA (GET /api/ca/pre-close-check)
    // =========================================================================
    app.get('/api/ca/pre-close-check', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = req.query.branchId ? normalizeBranchForShift(tenantId, req.query.branchId) : null;
        const outboxPendingCount = Math.max(0, Math.floor(Number(req.query.outboxPending || 0)));
        try {
            const checklist = await pool.withTenant(tenantId, async (client) => {
                const ca = await layCaDangMo(client, undefined, tenantId, {
                    branchId: req.query.branchId || null,
                    terminalId: req.query.terminalId || null,
                });
                return computePreCloseChecklist(client, {
                    tenantId,
                    branchId,
                    maCaThuNgan: ca?.macathungan || null,
                    outboxPendingCount,
                });
            });
            res.json(checklist);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Kiểm tra trước chốt ca:');
        }
    });

    // =========================================================================
    // 3. TẢI LÊN ẢNH CHỨNG TỪ PHIẾU CHI XÁC THỰC (POST /api/uploads/receipt-photo)
    // =========================================================================
    app.post('/api/uploads/receipt-photo', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const { dataUrl, mimeType = 'image/webp' } = req.body || {};
        const cleanData = String(dataUrl || '').trim();
        if (!cleanData || (!cleanData.startsWith('data:image/') && !cleanData.startsWith('base64:'))) {
            return res.status(400).json({
                code: 'INVALID_RECEIPT_PHOTO',
                message: 'Vui lòng tải lên ảnh chụp chứng từ hợp lệ (data:image/webp, jpeg hoặc png)!',
            });
        }
        const sizeBytes = Buffer.byteLength(cleanData, 'utf8');
        if (sizeBytes > 460000) {
            return res.status(413).json({
                code: 'RECEIPT_PHOTO_TOO_LARGE',
                message: 'Ảnh chứng từ vượt quá 450KB! Vui lòng nén ảnh trước khi tải lên.',
            });
        }
        const allowedMime = ['image/webp', 'image/jpeg', 'image/jpg', 'image/png'].includes(String(mimeType).toLowerCase())
            ? String(mimeType).toLowerCase()
            : 'image/webp';
        const idChungTu = `RCP_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

        try {
            const stored = await uploadReceiptPhoto({
                tenantId,
                idChungTu,
                dataUrl: cleanData,
                mimeType: allowedMime,
            });
            await pool.withTenant(tenantId, async (client) => {
                await client.query(
                    `INSERT INTO public.receipt_photo_uploads
                        (id, tenantid, manv, mimetype, sizebytes, dataurl, storage_provider, storage_key, storage_url)
                     VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
                    [
                        idChungTu,
                        tenantId,
                        req.user.maNV,
                        stored.mimeType,
                        stored.sizeBytes,
                        stored.storageProvider,
                        stored.storageKey,
                        stored.storageUrl,
                    ]
                );
            });
            res.status(201).json({
                message: 'Đã lưu ảnh chứng từ xác thực!',
                idChungTu,
                url: stored.storageUrl || `/api/uploads/receipt-photo/${idChungTu}`,
                storageProvider: stored.storageProvider,
                storageKey: stored.storageKey,
                storageUrl: stored.storageUrl,
                sizeBytes: stored.sizeBytes,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Upload ảnh chứng từ:');
        }
    });

    app.get('/api/uploads/receipt-photo/:id', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const r = await qTenant(
                req,
                `SELECT id, mimetype, sizebytes, dataurl, storage_provider, storage_key, storage_url, createdat
                   FROM public.receipt_photo_uploads
                  WHERE id = $1 AND tenantid = $2`,
                [req.params.id, tenantId]
            );
            if (r.rows.length === 0) return res.status(404).json({ message: 'Không tìm thấy ảnh chứng từ!' });
            const row = r.rows[0];
            if (req.query.raw === '1' && row.storage_provider === 'LOCAL' && row.storage_key) {
                const buf = await readLocalReceiptPhoto(row.storage_key);
                if (buf) {
                    res.setHeader('Content-Type', row.mimetype || 'image/webp');
                    return res.send(buf);
                }
            }
            res.json(row);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Xem ảnh chứng từ:');
        }
    });

    // =========================================================================
    // 4. RÚT KÉT AN TOÀN 2 LỚP (SAFE DROP TWO-MAN RULE CONFIRMATION)
    // =========================================================================
    app.post('/api/ca/safe-drop/:maPhieuTC/confirm', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const { maPhieuTC } = req.params;
        const status = String(req.body?.status || 'CONFIRMED').toUpperCase();
        const ghiChu = req.body?.ghiChu ? String(req.body.ghiChu).trim().slice(0, 255) : null;
        if (!['CONFIRMED', 'DISPUTED'].includes(status)) {
            return res.status(400).json({ message: 'status chỉ chấp nhận CONFIRMED hoặc DISPUTED!' });
        }

        try {
            const updated = await chayGiaoDich(async (client) => {
                const pRes = await client.query(
                    `SELECT p.MaPhieuTC, p.MaCaThuNgan, p.LoaiPhieu, p.SoTien, p.LyDo, p.TrangThaiXacNhan
                       FROM PhieuThuChiLatVat p
                       JOIN CaThuNgan ca ON ca.MaCaThuNgan = p.MaCaThuNgan
                      WHERE p.MaPhieuTC = $1 AND COALESCE(ca.TenantId, 'DEFAULT') = $2
                      FOR UPDATE OF p`,
                    [maPhieuTC, tenantId]
                );
                if (pRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy phiếu rút két!');
                const row = pRes.rows[0];
                if (Number(row.loaiphieu) !== 3) {
                    throw new LoiNghiepVu(400, 'Chỉ áp dụng xác nhận 2 lớp cho phiếu Rút két an toàn (RUT_KET)!');
                }

                await client.query(
                    `UPDATE PhieuThuChiLatVat
                        SET TrangThaiXacNhan = $2,
                            NguoiNhanKet = $3,
                            ThoiGianNhanKet = now()
                      WHERE MaPhieuTC = $1`,
                    [maPhieuTC, status, req.user.maNV]
                );

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    nguoiDuyet: req.user.maNV,
                    hanhDong: status === 'CONFIRMED' ? 'SAFE_DROP_CONFIRMED' : 'SAFE_DROP_DISPUTED',
                    doiTuong: 'CATHUNGAN',
                    maDoiTuong: row.macathungan,
                    giaTriCu: { maPhieuTC, trangThaiXacNhan: row.trangthaixacnhan, soTien: Number(row.sotien) },
                    giaTriMoi: { maPhieuTC, trangThaiXacNhan: status, nguoiNhanKet: req.user.maNV, ghiChu },
                    lyDo: ghiChu || (status === 'CONFIRMED' ? 'Chủ quán xác nhận đã nhận đủ tiền rút két' : 'Chủ quán báo sai lệch tiền rút két'),
                    ip: req.ip,
                    batBuoc: true,
                });

                if (status === 'DISPUTED' && typeof ghiCanhBaoGianLan === 'function') {
                    await ghiCanhBaoGianLan(client, {
                        tenantId,
                        loaiCanhBao: 'SAFE_DROP_DISPUTED',
                        mucDo: 'HIGH',
                        maNV: req.user.maNV,
                        maDoiTuong: maPhieuTC,
                        moTa: `🚨 Chủ quán báo SAI LỆCH phiếu rút két #${maPhieuTC} (${Number(row.sotien).toLocaleString('vi-VN')}đ)!`,
                        duLieu: { maPhieuTC, soTien: Number(row.sotien), ghiChu },
                    }).catch(() => {});
                }

                return {
                    maPhieuTC,
                    maCaThuNgan: row.macathungan,
                    soTien: Number(row.sotien),
                    trangThaiXacNhan: status,
                    nguoiNhanKet: req.user.maNV,
                };
            }, tenantId);

            io.to(roomTen(tenantId, 'thungan')).emit('CA_THAY_DOI', { trangThai: 'SAFE_DROP_UPDATED', ...updated });
            res.json({
                message:
                    status === 'CONFIRMED'
                        ? `✅ Đã xác nhận nhận đủ ${updated.soTien.toLocaleString('vi-VN')}đ từ phiếu rút két #${maPhieuTC}!`
                        : `🚨 Đã đánh dấu sai lệch cho phiếu rút két #${maPhieuTC}!`,
                ...updated,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Xác nhận Safe Drop:');
        }
    });

    // =========================================================================
    // 5. HỘP THƯ KHỚP TAY 1 CHẠM (MANUAL BANK MATCH QUEUE) & XỬ LÝ CHUYỂN DƯ/TRÙNG
    // =========================================================================
    app.get('/api/vietqr/unmatched', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const minutes = Math.min(1440, Math.max(5, Math.floor(Number(req.query.minutes || 30))));
        try {
            const r = await qTenant(
                req,
                `SELECT Id, NhaCungCap, SoTaiKhoanNhan, MaGiaoDichNgoai, SoTien, SoTienConLai,
                        NoiDungCK, MaHoaDonKhop, TrangThaiXuLy, TrangThaiXuLyDu, ThoiGianNhan
                   FROM public.vietqr_webhook_events
                  WHERE COALESCE(TenantId, 'DEFAULT') = $1
                    AND (TrangThaiXuLy = 'UNMATCHED' OR TrangThaiXuLyDu = 'PENDING_ACTION')
                    AND ThoiGianNhan >= now() - ($2::int || ' minutes')::interval
                  ORDER BY ThoiGianNhan DESC
                  LIMIT 50`,
                [tenantId, minutes]
            );
            res.json(
                r.rows.map((row) => ({
                    id: Number(row.id),
                    nhaCungCap: row.nhacungcap,
                    soTaiKhoanNhan: row.sotaikhoannhan || '',
                    maGiaoDichNgoai: row.magiaodichngoai,
                    soTien: Number(row.sotien || 0),
                    soTienConLai: Number(row.sotienconlai || row.sotien || 0),
                    noiDungCK: row.noidungck || '',
                    maHoaDonKhop: row.mahoadonkhop || null,
                    trangThaiXuLy: row.trangthaixuly,
                    trangThaiXuLyDu: row.trangthaixulydu || 'NONE',
                    thoiGianNhan: row.thoigiannhan,
                }))
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Danh sách VietQR chưa khớp:');
        }
    });

    // Khớp 1 giao dịch UNMATCHED thật từ Webhook vào 1 hóa đơn (khóa FOR UPDATE chống Bill Recycling 100%!)
    app.post('/api/vietqr/match-unmatched', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const { webhookEventId, maHoaDon } = req.body || {};
        if (!webhookEventId || !maHoaDon) {
            return res.status(400).json({ message: 'Vui lòng cung cấp webhookEventId và maHoaDon cần khớp!' });
        }

        try {
            const ketQua = await chayGiaoDich(async (client) => {
                // Khóa cứng dòng webhook event bằng FOR UPDATE -> 2 request song song chỉ đúng 1 bên được khớp!
                const evRes = await client.query(
                    `SELECT Id, NhaCungCap, MaGiaoDichNgoai, SoTien, NoiDungCK, TrangThaiXuLy
                       FROM public.vietqr_webhook_events
                      WHERE Id = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                      FOR UPDATE`,
                    [Number(webhookEventId), tenantId]
                );
                if (evRes.rows.length === 0) {
                    throw new LoiNghiepVu(404, 'Không tìm thấy giao dịch ngân hàng tương ứng!');
                }
                const ev = evRes.rows[0];
                if (ev.trangthaixuly !== 'UNMATCHED') {
                    throw new LoiNghiepVu(
                        409,
                        `Giao dịch ngân hàng #${ev.magiaodichngoai} đã được khớp hoặc xử lý trước đó (${ev.trangthaixuly})!`,
                        { code: 'WEBHOOK_EVENT_ALREADY_MATCHED', trangThaiHienTai: ev.trangthaixuly }
                    );
                }

                const ca = await layCaDangMo(client, 'SHARE', tenantId);
                if (!ca) throw loiChuaMoCa();

                const amount = Number(ev.sotien || 0);
                const ttRes = await ghiNhanThanhToanTrongGiaoDich(client, {
                    maHoaDon,
                    expectedTenantId: tenantId,
                    ca,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    cacKhoanTT: [
                        {
                            phuongThucTT: 'CHUYEN_KHOAN',
                            soTien: amount,
                            maGiaoDichNgoai: ev.magiaodichngoai,
                            noiDungCK: ev.noidungck || '',
                            nguonXacNhan: 'MANUAL_BANK_MATCH',
                        },
                    ],
                    choPhepThuMotPhan: true,
                    ip: req.ip,
                });

                const overpay = Number(ttRes.tienChuyenThua || 0);
                await client.query(
                    `UPDATE public.vietqr_webhook_events
                        SET TrangThaiXuLy = 'MANUALLY_MATCHED',
                            MaHoaDonKhop = $2,
                            SoTienConLai = $3,
                            TrangThaiXuLyDu = $4,
                            NguoiXuLyDu = $5,
                            ThoiGianXuLyDu = now()
                      WHERE Id = $1`,
                    [
                        Number(webhookEventId),
                        String(maHoaDon),
                        overpay,
                        overpay > 0 ? 'PENDING_ACTION' : 'MANUALLY_MATCHED',
                        req.user.maNV,
                    ]
                );

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'VIETQR_MANUALLY_MATCHED',
                    doiTuong: 'HOADON',
                    maDoiTuong: maHoaDon,
                    giaTriMoi: {
                        webhookEventId: Number(webhookEventId),
                        maGiaoDichNgoai: ev.magiaodichngoai,
                        soTien: amount,
                        tienChuyenThua: overpay,
                        daHoanTat: ttRes.daHoanTat,
                    },
                    ip: req.ip,
                    batBuoc: true,
                });

                return { ...ttRes, webhookEventId: Number(webhookEventId), maGiaoDichNgoai: ev.magiaodichngoai };
            }, tenantId);

            for (const maBan of ketQua.banDaTrong || []) {
                io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('BAN_THAY_DOI', { maBan, trangThai: 3 });
            }
            if (ketQua.daHoanTat) {
                io.to(roomTen(tenantId, 'thungan')).emit('HOADON_DA_TT', { maHoaDon });
            }

            res.json({
                message: `✅ Đã khớp giao dịch #${ketQua.maGiaoDichNgoai} vào HĐ #${maHoaDon}!`,
                ...ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Khớp giao dịch VietQR chưa khớp:');
        }
    });

    // Xử lý khoản VietQR Chuyển dư (Overpayment) hoặc Chuyển trùng giây thu Tiền mặt (ALREADY_PAID)
    app.post('/api/vietqr/resolve-overpayment', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const { webhookEventId, action, maKH = null, lyDo = null } = req.body || {};
        const act = String(action || '').toUpperCase();
        if (!webhookEventId || !['CASH_RETURNED', 'WALLET_CREDITED', 'TIP', 'BANK_REFUNDED'].includes(act)) {
            return res.status(400).json({
                message: 'Vui lòng truyền webhookEventId và action thuộc: CASH_RETURNED, WALLET_CREDITED, TIP, BANK_REFUNDED!',
            });
        }

        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const evRes = await client.query(
                    `SELECT Id, MaGiaoDichNgoai, MaHoaDonKhop, SoTien, SoTienConLai, TrangThaiXuLy, TrangThaiXuLyDu
                       FROM public.vietqr_webhook_events
                      WHERE Id = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                      FOR UPDATE`,
                    [Number(webhookEventId), tenantId]
                );
                if (evRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy giao dịch VietQR!');
                const ev = evRes.rows[0];
                if (ev.trangthaixulydu !== 'PENDING_ACTION') {
                    throw new LoiNghiepVu(409, `Khoản dư/trùng này đã được xử lý (${ev.trangthaixulydu})!`);
                }
                const soTienDu = Number(ev.sotienconlai || 0);
                if (!(soTienDu > 0)) {
                    throw new LoiNghiepVu(400, 'Giao dịch này không có số tiền dư cần xử lý!');
                }

                let maPhieuTC = null;
                let soDuViMoi = null;

                if (act === 'CASH_RETURNED') {
                    const ca = await layCaDangMo(client, 'SHARE', tenantId);
                    if (!ca) throw loiChuaMoCa();
                    const note = lyDo
                        ? String(lyDo).trim().slice(0, 255)
                        : `Thối tiền mặt khoản CK dư/trùng #${ev.magiaodichngoai}${ev.mahoadonkhop ? ` (HĐ #${ev.mahoadonkhop})` : ''}`;
                    const ptc = await client.query(
                        `INSERT INTO PhieuThuChiLatVat
                            (MaCaThuNgan, LoaiPhieu, SoTien, LyDo, DanhMucChi, TrangThaiXacNhan)
                         VALUES ($1, 4, $2, $3, 'THOI_CK_DU', 'CONFIRMED')
                         RETURNING MaPhieuTC`,
                        [ca.macathungan, soTienDu, note]
                    );
                    maPhieuTC = ptc.rows[0].maphieutc;
                } else if (act === 'WALLET_CREDITED') {
                    let targetMaKH = maKH || null;
                    if (!targetMaKH && ev.mahoadonkhop) {
                        const hdKh = await client.query(`SELECT MaKH FROM HoaDon WHERE MaHoaDon = $1`, [ev.mahoadonkhop]);
                        targetMaKH = hdKh.rows[0]?.makh || null;
                    }
                    if (!targetMaKH) {
                        throw new LoiNghiepVu(400, 'Vui lòng chọn khách hàng (maKH) để nạp phần tiền dư vào Ví thành viên!');
                    }
                    const khRes = await client.query(
                        `UPDATE KhachHang SET SoDuVi = COALESCE(SoDuVi, 0) + $2
                          WHERE MaKH = $1 AND COALESCE(TenantId, 'DEFAULT') = $3
                          RETURNING SoDuVi`,
                        [targetMaKH, soTienDu, tenantId]
                    );
                    if (khRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy khách hàng!');
                    soDuViMoi = Number(khRes.rows[0].soduvi);
                    await client.query(
                        `INSERT INTO KhachHang_GiaoDichVi (TenantId, MaKH, LoaiGD, SoTien, SoDuSau, MaHoaDon, MaNV, GhiChu)
                         VALUES ($1, $2, 'VIETQR_OVERPAY_CREDIT', $3, $4, $5, $6, $7)`,
                        [
                            tenantId,
                            targetMaKH,
                            soTienDu,
                            soDuViMoi,
                            ev.mahoadonkhop || null,
                            req.user.maNV,
                            `Nạp tiền CK dư #${ev.magiaodichngoai}`,
                        ]
                    );
                }

                await client.query(
                    `UPDATE public.vietqr_webhook_events
                        SET TrangThaiXuLyDu = $2,
                            NguoiXuLyDu = $3,
                            ThoiGianXuLyDu = now()
                      WHERE Id = $1`,
                    [Number(webhookEventId), act, req.user.maNV]
                );

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: `VIETQR_OVERPAY_${act}`,
                    doiTuong: 'VIETQR_WEBHOOK',
                    maDoiTuong: String(webhookEventId),
                    giaTriMoi: { soTienDu, action: act, maPhieuTC, soDuViMoi, maHoaDonKhop: ev.mahoadonkhop },
                    lyDo: lyDo || `Xử lý khoản VietQR dư/trùng: ${act}`,
                    ip: req.ip,
                    batBuoc: true,
                });

                return { webhookEventId: Number(webhookEventId), action: act, soTienDu, maPhieuTC, soDuViMoi };
            }, tenantId);

            io.to(roomTen(tenantId, 'thungan')).emit('CA_THAY_DOI', { trangThai: 'OVERPAY_RESOLVED', ...ketQua });
            res.json({
                message:
                    act === 'CASH_RETURNED'
                        ? `💵 Đã tạo phiếu thối tiền mặt #${ketQua.maPhieuTC} (${ketQua.soTienDu.toLocaleString('vi-VN')}đ) — trừ thẳng vào quỹ ca hiện tại!`
                        : act === 'WALLET_CREDITED'
                        ? `👛 Đã nạp ${ketQua.soTienDu.toLocaleString('vi-VN')}đ vào Ví thành viên (Số dư mới: ${ketQua.soDuViMoi.toLocaleString('vi-VN')}đ)!`
                        : `✅ Đã ghi nhận xử lý khoản chuyển dư (${act})!`,
                ...ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Xử lý VietQR chuyển dư/trùng:');
        }
    });

    // =========================================================================
    // 6. ĐỐI SOÁT 3 CHIỀU CUỐI NGÀY (POS <-> WEBHOOK <-> CHỐT LÔ EDC)
    // =========================================================================
    app.get('/api/ca/reconciliation-eod', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const today = ngayHomNayVN();
        const tuNgay = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.tuNgay || '')) ? req.query.tuNgay : today;
        const denNgay = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.denNgay || '')) ? req.query.denNgay : tuNgay;
        const maCaThuNgan = req.query.maCaThuNgan || null;
        const tongChotLoEDC = req.query.tongChotLoEDC !== undefined ? req.query.tongChotLoEDC : null;

        try {
            const report = await pool.withTenant(tenantId, (client) =>
                computeEndOfDayReconciliation(client, { tenantId, tuNgay, denNgay, maCaThuNgan, tongChotLoEDC })
            );
            res.json({ tuNgay, denNgay, maCaThuNgan, ...report });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Đối soát 3 chiều cuối ngày:');
        }
    });

    app.post('/api/ca/edc-settlement', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const { maCaThuNgan, tongChotLoEDC } = req.body || {};
        if (!maCaThuNgan || !(Number(tongChotLoEDC) >= 0)) {
            return res.status(400).json({ message: 'Vui lòng cung cấp maCaThuNgan và tongChotLoEDC >= 0!' });
        }

        try {
            const report = await chayGiaoDich(async (client) => {
                const upd = await client.query(
                    `UPDATE CaThuNgan SET TongChotLoEDC = $2
                      WHERE MaCaThuNgan = $1 AND COALESCE(TenantId, 'DEFAULT') = $3
                      RETURNING MaCaThuNgan`,
                    [maCaThuNgan, Number(tongChotLoEDC), tenantId]
                );
                if (upd.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy ca thu ngân!');
                const rec = await computeEndOfDayReconciliation(client, {
                    tenantId,
                    maCaThuNgan,
                    tongChotLoEDC: Number(tongChotLoEDC),
                });
                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'EDC_BATCH_SETTLED',
                    doiTuong: 'CATHUNGAN',
                    maDoiTuong: maCaThuNgan,
                    giaTriMoi: rec.edcReconciliation,
                    ip: req.ip,
                    batBuoc: true,
                });
                return rec;
            }, tenantId);

            res.json({
                message:
                    report.edcReconciliation.matched
                        ? '✅ Chốt lô máy quẹt thẻ EDC khớp 100% với POS!'
                        : `⚠️ Lệch chốt lô EDC: ${report.edcReconciliation.variance.toLocaleString('vi-VN')}đ so với sổ thẻ POS!`,
                ...report,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Đối soát chốt lô EDC:');
        }
    });
}

module.exports = { registerPaymentShiftPhase3Routes };
