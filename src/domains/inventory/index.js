'use strict';

const crypto = require('crypto');
const {
    SIZE_HOP_LE,
    LOAI_GD_TIEU_HAO,
    LOAI_GD_HOAN_KHO,
    LOAI_GD_HAO_HUT_HUY_MON,
    VN_TZ,
    coQuyenHan,
    ngayHomNayVN,
    LoiNghiepVu,
    guiLoi,
    choPhepVaiTro,
    layTenantId,
    lam3,
} = require('../../core/auditAndSecurity');
const {
    emitToBranch,
} = require('../../core/socketRooms');
const {
    normalizeBranchId,
    roomBranchPos,
    roomBranchKds,
    emitScopedKdsEvent,
    cascadeIngredient86,
    autoUn86OnRestock,
} = require('../../../modules/kdsPhase2Engine');
const {
    WASTAGE_TAXONOMY,
    VALID_WASTAGE_CODES,
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
    consumeFefoBatches,
    detectSubRecipeCycle,
    lookupHistoricalWac,
    detectPriceSpikeAndMarginImpact,
} = require('../../../modules/inventoryCogsPhase4Engine');

function registerInventoryDomain(app, deps) {
    const {
        pool,
        io,
        chayGiaoDich,
        qTenant,
        kiemTraToken,
        yeuCauTinhNang,
        ghiAuditLog,
        dispatchFraudAlertFromAudit,
        kiemTraCanhBaoTanSuatGianLan,
        layCaDangMo,
        layMapGiaVonNguyenLieu,
    } = deps;

// ==========================================
// PHÂN HỆ: QUẢN TRỊ & KHO BÃI (PHÂN HỆ 4 - 100/100: SINGLE-SOURCE TONKHOCHINHANH, SAFE WAC + LANDED COST, FEFO, PRICE SPIKE & PERIOD LOCK)
// ==========================================
app.post('/api/kho/nhap', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const {
        ghiChu,
        branchId: rawBranchId = null,
        ngayChungTu = null,
        chiPhiVanChuyen = 0,
        giamGiaNCC = 0,
        maNCC = null,
        maPO = null,
        danhSachNguyenLieu,
    } = req.body || {};
    const maNV = req.user.maNV;
    const tenantId = layTenantId(req);

    if (!Array.isArray(danhSachNguyenLieu) || danhSachNguyenLieu.length === 0) {
        return res.status(400).json({ message: 'Danh sách nguyên liệu nhập không được để trống!' });
    }
    for (const item of danhSachNguyenLieu) {
        if (!item || !item.maNL || !(Number(item.soLuong) > 0) || !(Number(item.donGiaNhap) >= 0)) {
            return res.status(400).json({ message: 'Mỗi dòng nhập kho phải có maNL, soLuong > 0 và donGiaNhap >= 0!' });
        }
    }

    try {
        const ketQuaNhap = await chayGiaoDich(async (client) => {
            const targetBranch = normalizeInventoryBranch(tenantId, rawBranchId || req.user.branchId || null);
            const docDate = await assertPeriodNotLocked(client, tenantId, targetBranch, ngayChungTu, LoiNghiepVu);

            const sorted = [...danhSachNguyenLieu].sort((a, b) => String(a.maNL).localeCompare(String(b.maNL)));
            const { branchId, stockMap } = await lockBranchStockOrdered(
                client,
                tenantId,
                targetBranch,
                sorted.map((x) => x.maNL)
            );

            // Chuẩn hóa tiền hàng & phân bổ Landed Cost (cước xe lạnh / phí ship / giảm giá NCC)
            const prepared = sorted.map((item) => {
                const heSo = Number(item.heSoQuyDoi) > 0 ? Number(item.heSoQuyDoi) : 1;
                const slNhapGoc = Number(item.soLuong);
                const donGiaGoc = Number(item.donGiaNhap);
                const soLuongBase = lam3(slNhapGoc * heSo);
                // Hỗ trợ cả 2 cách truyền: donGiaNhap là giá theo đơn vị nhập (VD: 360.000đ/Thùng)
                const tongTienHang = lam2(slNhapGoc * donGiaGoc);
                return { item, heSo, slNhapGoc, donGiaGoc, soLuongBase, tongTienHang };
            });
            const landedAlloc = allocateLandedCost(prepared, chiPhiVanChuyen, giamGiaNCC);

            const caMo = await layCaDangMo(client, 'SHARE', tenantId, { branchId });
            const phieuResult = await client.query(
                `INSERT INTO PhieuGiaoDichKho
                    (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan, ChiPhiVanChuyen, GiamGiaNhaCC, MaNCC, MaPO, NgayChungTu, TrangThaiDuyet)
                 VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, 'POSTED')
                 RETURNING MaGiaoDich`,
                [
                    maNV,
                    ghiChu || 'Nhập kho nguyên liệu',
                    tenantId,
                    branchId,
                    caMo ? String(caMo.macathungan) : null,
                    lam2(chiPhiVanChuyen),
                    lam2(giamGiaNCC),
                    maNCC || null,
                    maPO || null,
                    docDate,
                ]
            );
            const maGD = phieuResult.rows[0].magiaodich;

            let totalCogsAdjustment = 0;
            const lineResults = [];
            const priceSpikeAlerts = [];
            const createdLots = [];

            for (let i = 0; i < prepared.length; i++) {
                const { item, heSo, slNhapGoc, soLuongBase, tongTienHang } = prepared[i];
                const st = stockMap.get(item.maNL);
                if (!st) {
                    throw new LoiNghiepVu(404, `Không tìm thấy nguyên liệu ${item.maNL}!`);
                }

                const chiPhiPhanBo = item.chiPhiPhanBo !== undefined ? lam2(item.chiPhiPhanBo) : landedAlloc[i] || 0;
                const tonTruoc = st.soLuongTon;
                const giaVonTruoc = st.giaVonDonVi;

                // Safe WAC chống bùng nổ/âm khi tồn kho trước đó < 0 + tính cogsAdjustment!
                const wac = computeSafeWacOnStockIn({
                    tonCu: tonTruoc,
                    giaVonCu: giaVonTruoc,
                    slNhapBase: soLuongBase,
                    tongTienHang,
                    chiPhiPhanBo,
                });
                totalCogsAdjustment = lam2(totalCogsAdjustment + wac.cogsAdjustment);
                if (Math.abs(wac.cogsAdjustment) >= 0.01) {
                    await recordCogsAdjustment(client, {
                        tenantId,
                        branchId,
                        businessDate: ngayChungTu || todayDateVN(),
                        maNL: item.maNL,
                        sourceType: 'NEGATIVE_STOCK_CATCHUP',
                        refMaGiaoDich: maGD,
                        qtyAffected: Math.min(Math.abs(tonTruoc), soLuongBase),
                        oldUnitCost: giaVonTruoc,
                        newUnitCost: wac.donGiaNhapThucTe,
                        adjustmentAmount: wac.cogsAdjustment,
                        createdBy: req.user.maNV,
                    });
                }
                const tonSau = lam3(tonTruoc + soLuongBase);

                const moTaDonVi =
                    heSo !== 1 && item.donViNhap
                        ? `${slNhapGoc} ${item.donViNhap} (x${heSo} = ${soLuongBase} ${st.donViTinh}) • ${item.tinhTrang || 'Tốt'}`
                        : item.tinhTrang || 'Tốt';

                await insertLedgerLine(client, {
                    maGiaoDich: maGD,
                    maNL: item.maNL,
                    soLuong: soLuongBase,
                    donGiaNhap: wac.donGiaNhapThucTe,
                    tinhTrang: moTaDonVi,
                    tonTruoc,
                    tonSau,
                    giaVonTruoc,
                    giaVonSau: wac.giaVonMoi,
                    donViNhap: item.donViNhap || st.donViTinh,
                    heSoQuyDoi: heSo,
                    soLuongTheoDonVi: slNhapGoc,
                    chiPhiPhanBo,
                });

                await updateBranchStockRow(client, {
                    tenantId,
                    branchId,
                    maNL: item.maNL,
                    nextQty: tonSau,
                    nextWac: wac.giaVonMoi,
                });

                // Cập nhật stockMap trong bộ nhớ nếu cùng phiếu có 2 dòng trùng MaNL
                st.soLuongTon = tonSau;
                st.giaVonDonVi = wac.giaVonMoi;

                // Tạo Lô FEFO nếu có ngày hết hạn (hanSuDung / thoiGianHetHan) hoặc bật TheoDoiHanDung
                const expiryVal = item.thoiGianHetHan || item.hanSuDung || null;
                if (expiryVal || item.maLo || st.theoDoiHanDung) {
                    const lot = await createFefoLot(client, {
                        tenantId,
                        branchId,
                        maNL: item.maNL,
                        maLo: item.maLo || null,
                        nguonLo: 'PURCHASE',
                        maGiaoDichNguon: String(maGD),
                        soLuong: soLuongBase,
                        giaVonLo: wac.donGiaNhapThucTe,
                        thoiGianHetHan: expiryVal,
                    });
                    if (lot) createdLots.push(lot);
                }

                // Kiểm tra Cảnh báo Tăng giá nhập >= +5% & Xói mòn biên lợi nhuận món!
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

                lineResults.push({
                    maNL: item.maNL,
                    soLuongBase,
                    tonTruoc,
                    tonSau,
                    giaVonTruoc,
                    donGiaNhapThucTe: wac.donGiaNhapThucTe,
                    giaVonMoi: wac.giaVonMoi,
                    chiPhiPhanBo,
                    cogsAdjustment: wac.cogsAdjustment,
                });
            }

            if (totalCogsAdjustment !== 0) {
                await client.query(
                    `UPDATE public.phieugiaodichkho SET cogsadjustment = $2::numeric WHERE magiaodich = $1`,
                    [maGD, totalCogsAdjustment]
                );
            }

            // [Phân hệ 2 - Smart Auto Un-86] Tự mở khóa các món/topping/modifier/combo đã bị khóa tự động khi nhập đủ hàng!
            const autoUnlocked = await autoUn86OnRestock(client, {
                tenantId,
                maNLList: sorted.map((it) => it.maNL),
            });

            await ghiAuditLog(client, {
                tenantId,
                maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'INVENTORY_STOCK_IN',
                doiTuong: 'KHO',
                maDoiTuong: maGD,
                giaTriMoi: {
                    branchId,
                    soDong: sorted.length,
                    chiPhiVanChuyen: lam2(chiPhiVanChuyen),
                    giamGiaNCC: lam2(giamGiaNCC),
                    cogsAdjustment: totalCogsAdjustment,
                    priceSpikeAlertsCount: priceSpikeAlerts.length,
                    ghiChu,
                    autoUnlocked,
                },
                ip: req.ip,
                batBuoc: true,
            });
            return {
                maGiaoDich: maGD,
                branchId,
                cogsAdjustment: totalCogsAdjustment,
                lineResults,
                createdLots,
                priceSpikeAlerts,
                autoUnlocked,
            };
        }, tenantId);

        const { maGiaoDich, branchId, cogsAdjustment, lineResults, createdLots, priceSpikeAlerts, autoUnlocked } = ketQuaNhap;
        if (
            autoUnlocked &&
            (autoUnlocked.unlockedProducts.length > 0 ||
                autoUnlocked.unlockedToppings.length > 0 ||
                autoUnlocked.unlockedModifiers.length > 0 ||
                autoUnlocked.unlockedCombos.length > 0)
        ) {
            emitToBranch(io, {
                tenantId,
                branchId,
                roles: ['POS', 'WAITER', 'KDS', 'EXPO'],
                event: 'menu:86_updated',
                payload: { type: 'AUTO_UN86_RESTOCK', ...autoUnlocked },
            });
            for (const p of autoUnlocked.unlockedProducts) {
                emitToBranch(io, {
                    tenantId,
                    branchId,
                    roles: ['POS', 'WAITER', 'KDS', 'EXPO'],
                    event: 'THUC_DON_THAY_DOI',
                    payload: p,
                });
            }
        }

        res.json({
            message: 'Nhập kho & cập nhật giá vốn bình quân an toàn (Safe WAC) thành công!',
            maGiaoDich,
            branchId,
            cogsAdjustment,
            lineResults,
            createdLots,
            priceSpikeAlerts,
            autoUnlocked,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Nhập kho:');
    }
});

// [P1] Tạo nguyên liệu mới từ giao diện Admin (cô lập theo TenantId)
app.post('/api/kho/nguyenlieu', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { maNL, tenNL, donViTinh, hanMucCanhBao = 0, giaVonDonVi = 0 } = req.body || {};
    const tenantId = layTenantId(req);
    const prefix = req.user.maTienTo && tenantId !== 'DEFAULT' ? `${req.user.maTienTo}_` : '';
    const rawMa = String(maNL || '').trim().toUpperCase();
    const ma = rawMa.startsWith(prefix) ? rawMa : `${prefix}${rawMa}`;
    const ten = String(tenNL || '').trim();
    const dvt = String(donViTinh || '').trim();
    if (!rawMa || !ten || !dvt) {
        return res.status(400).json({ message: 'Vui lòng nhập đủ mã NL, tên nguyên liệu và đơn vị tính!' });
    }
    try {
        await qTenant(
            req,
            `INSERT INTO NguyenLieu (MaNL, TenNL, DonViTinh, SoLuongTon, HanMucCanhBao, GiaVonDonVi, DaXoa, TenantId)
             VALUES ($1, $2, $3, 0, $4, $5, FALSE, $6)`,
            [ma, ten, dvt, Math.max(0, Number(hanMucCanhBao) || 0), Math.max(0, Number(giaVonDonVi) || 0), tenantId]
        );
        res.status(201).json({ message: `Đã thêm nguyên liệu "${ten}" thành công!`, maNL: ma });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `Mã nguyên liệu ${ma} đã tồn tại!` });
        guiLoi(res, error, 'Lỗi API Tạo nguyên liệu:');
    }
});

// [P1 + P4 - UoM] Danh sách quy đổi đơn vị tính kho (Thùng -> Lon -> ml/g + Barcode) của Tenant
app.get('/api/kho/quydoi', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const r = await qTenant(
            req,
            `SELECT q.Id, q.MaNL, nl.TenNL, nl.DonViTinh AS DonViGoc, q.TenDonVi, q.HeSoQuyDoi,
                    to_jsonb(q)->>'mavachdonvi' AS MaVachDonVi,
                    COALESCE((to_jsonb(q)->>'lamacdinhnhap')::boolean, FALSE) AS LaMacDinhNhap,
                    COALESCE((to_jsonb(q)->>'lamacdinhkiem')::boolean, FALSE) AS LaMacDinhKiem
               FROM NguyenLieu_DonViQuyDoi q
               JOIN NguyenLieu nl ON nl.MaNL = q.MaNL AND COALESCE(nl.TenantId, 'DEFAULT') = $1
              WHERE q.TenantId = $1
              ORDER BY nl.TenNL, q.HeSoQuyDoi DESC`,
            [tenantId]
        );
        res.json(r.rows.map((row) => ({
            id: row.id,
            maNL: row.manl,
            tenNL: row.tennl,
            donViGoc: row.donvigoc,
            tenDonVi: row.tendonvi,
            heSoQuyDoi: Number(row.hesoquydoi),
            maVachDonVi: row.mavachdonvi || null,
            laMacDinhNhap: Boolean(row.lamacdinhnhap),
            laMacDinhKiem: Boolean(row.lamacdinhkiem),
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lấy quy đổi đơn vị kho:');
    }
});

// [P1 + P4 - UoM] Thêm/Cập nhật quy đổi đơn vị cho 1 nguyên liệu (VD: 1 Thùng = 12000 ml + Mã vạch riêng)
app.post('/api/kho/quydoi', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('inventory_bom'), async (req, res) => {
    const tenantId = layTenantId(req);
    const { maNL, tenDonVi, heSoQuyDoi, maVachDonVi = null, laMacDinhNhap = false, laMacDinhKiem = false } = req.body || {};
    const tenDV = String(tenDonVi || '').trim().slice(0, 32);
    const heSo = Number(heSoQuyDoi);
    const cleanBarcode = maVachDonVi && String(maVachDonVi).trim() ? String(maVachDonVi).trim().slice(0, 64) : null;
    if (!maNL || !tenDV || !(heSo > 0)) {
        return res.status(400).json({ message: 'Vui lòng nhập đủ nguyên liệu, tên đơn vị (VD: Thùng/Hộp/Kg) và hệ số quy đổi > 0!' });
    }
    try {
        const out = await pool.withTenant(tenantId, async (client) => {
            const own = await client.query(
                "SELECT TenNL, DonViTinh FROM NguyenLieu WHERE MaNL = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
                [maNL, tenantId]
            );
            if (own.rows.length === 0) return null;

            const r = await client.query(
                `INSERT INTO NguyenLieu_DonViQuyDoi (TenantId, MaNL, TenDonVi, HeSoQuyDoi, MaVachDonVi, LaMacDinhNhap, LaMacDinhKiem)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (TenantId, MaNL, TenDonVi)
                 DO UPDATE SET HeSoQuyDoi = EXCLUDED.HeSoQuyDoi,
                               MaVachDonVi = COALESCE(EXCLUDED.MaVachDonVi, NguyenLieu_DonViQuyDoi.MaVachDonVi),
                               LaMacDinhNhap = EXCLUDED.LaMacDinhNhap,
                               LaMacDinhKiem = EXCLUDED.LaMacDinhKiem
                 RETURNING Id`,
                [tenantId, maNL, tenDV, heSo, cleanBarcode, Boolean(laMacDinhNhap), Boolean(laMacDinhKiem)]
            );
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'UOM_UPDATED',
                doiTuong: 'NGUYENLIEU',
                maDoiTuong: maNL,
                giaTriMoi: { tenDonVi: tenDV, heSoQuyDoi: heSo, maVachDonVi: cleanBarcode, donViGoc: own.rows[0].donvitinh },
                ip: req.ip,
            });
            return { id: r.rows[0].id, nl: own.rows[0] };
        });
        if (!out) return res.status(404).json({ message: 'Không tìm thấy nguyên liệu thuộc quán này!' });
        res.status(201).json({
            message: `Đã lưu quy đổi: 1 ${tenDV} = ${heSo} ${out.nl.donvitinh} (${out.nl.tennl})!`,
            id: out.id,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lưu quy đổi đơn vị:');
    }
});

app.delete('/api/kho/quydoi/:id', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const r = await qTenant(
            req,
            'DELETE FROM NguyenLieu_DonViQuyDoi WHERE Id = $1 AND TenantId = $2 RETURNING Id',
            [req.params.id, tenantId]
        );
        if (r.rows.length === 0) return res.status(404).json({ message: 'Không tìm thấy quy đổi đơn vị!' });
        res.json({ message: 'Đã xóa quy đổi đơn vị tính!' });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Xóa quy đổi đơn vị:');
    }
});


app.get('/api/kho/canhbao', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    const branchId = normalizeInventoryBranch(tenantId, req.query.branchId || req.user.branchId || null);
    const isMain = branchId === `${tenantId}_MAIN`;
    try {
        const result = await qTenant(
            req,
            `SELECT nl.MaNL, nl.TenNL, nl.DonViTinh,
                    COALESCE(tk.SoLuongTon, CASE WHEN $3::boolean THEN nl.SoLuongTon ELSE 0 END, 0) AS SoLuongTon,
                    COALESCE(tk.HanMucCanhBao, nl.HanMucCanhBao, 0) AS HanMucCanhBao
               FROM NguyenLieu nl
               LEFT JOIN public.tonkhochinhanh tk
                 ON tk.tenantid = $1::text AND tk.branchid = $2::text AND tk.manl = nl.manl
              WHERE nl.DaXoa = FALSE
                AND COALESCE(nl.TenantId::text, 'DEFAULT') = $1::text
                AND COALESCE(tk.SoLuongTon, CASE WHEN $3::boolean THEN nl.SoLuongTon ELSE 0 END, 0)
                    <= COALESCE(tk.HanMucCanhBao, nl.HanMucCanhBao, 0)
              ORDER BY SoLuongTon ASC`,
            [tenantId, branchId, isMain]
        );
        res.json(result.rows);
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Cảnh báo kho:');
    }
});

app.post('/api/congthuc', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('inventory_bom'), async (req, res) => {
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const tenantId = layTenantId(req);

    const { maMon, kichThuoc, dinhMuc } = req.body;
    if (!maMon || !kichThuoc || !Array.isArray(dinhMuc) || dinhMuc.length === 0) {
        return res.status(400).json({ message: 'Dữ liệu đầu vào không hợp lệ!' });
    }

    try {
        await chayGiaoDich(async (client) => {
            const ownMon = await client.query(
                "SELECT MaMon, TenMon FROM SanPham WHERE MaMon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
                [maMon, tenantId]
            );
            if (ownMon.rows.length === 0) {
                throw new LoiNghiepVu(404, 'Không tìm thấy món thuộc quán hiện tại!');
            }

            const nlIds = [...new Set(dinhMuc.map((d) => d.maNL))];
            const ownNl = await client.query(
                "SELECT MaNL FROM NguyenLieu WHERE MaNL = ANY($1::varchar[]) AND COALESCE(TenantId, 'DEFAULT') = $2",
                [nlIds, tenantId]
            );
            if (ownNl.rows.length !== nlIds.length) {
                throw new LoiNghiepVu(400, 'Có nguyên liệu không tồn tại hoặc không thuộc quán này!');
            }

            const prevRes = await client.query(
                'SELECT MaNL, KhoiLuongTieuHao FROM CongThuc WHERE MaMon = $1 AND KichThuoc = $2',
                [maMon, kichThuoc]
            );
            const giaTriCu = prevRes.rows.map((r) => ({ maNL: r.manl, khoiLuongTieuHao: Number(r.khoiluongtieuhao) }));

            await client.query('DELETE FROM CongThuc WHERE MaMon = $1 AND KichThuoc = $2', [maMon, kichThuoc]);
            for (const item of dinhMuc) {
                await client.query(
                    'INSERT INTO CongThuc (MaMon, KichThuoc, MaNL, KhoiLuongTieuHao) VALUES ($1, $2, $3, $4)',
                    [maMon, kichThuoc, item.maNL, item.khoiLuongTieuHao]
                );
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'RECIPE_UPDATED',
                doiTuong: 'CONGTHUC',
                maDoiTuong: `${maMon}|${kichThuoc}`,
                giaTriCu,
                giaTriMoi: dinhMuc,
                ip: req.ip,
                batBuoc: true,
            });
        }, tenantId);

        res.json({ message: `Cập nhật công thức cho món ${maMon} (Size ${kichThuoc}) thành công!` });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Thiết lập công thức:');
    }
});


app.post('/api/kho/kiemke', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
    const {
        loaiGD,
        ghiChu,
        branchId: rawBranchId = null,
        ngayChungTu = null,
        maLyDoHuy = null,
        danhSachNguyenLieu,
    } = req.body || {};
    const tenantId = layTenantId(req);
    if (![2, 3].includes(loaiGD) || !Array.isArray(danhSachNguyenLieu) || danhSachNguyenLieu.length === 0) {
        return res.status(400).json({ message: 'Loại giao dịch không hợp lệ hoặc danh sách nguyên liệu trống!' });
    }
    if (loaiGD === 3 && Number(req.user.vaiTro) !== 1) {
        return res.status(403).json({
            message: 'Nhân viên ca phải kiểm kho qua luồng Kiểm kê mù (/api/kho/kiem-ke/start và /submit), không được điều chỉnh trực tiếp tồn kho!',
        });
    }
    const cleanReasonCode =
        loaiGD === 2
            ? VALID_WASTAGE_CODES.includes(String(maLyDoHuy || '').toUpperCase())
                ? String(maLyDoHuy).toUpperCase()
                : 'BARISTA_SPILL'
            : null;

    // Quy đổi Tổ hợp Đơn vị tính (Compound UoM) hoặc hệ số quy đổi cho cả Xuất Hủy (2) và Kiểm Kê (3)!
    const parsedItems = [];
    for (const item of danhSachNguyenLieu) {
        if (!item?.maNL) {
            return res.status(400).json({ message: 'Mỗi dòng phải có maNL hợp lệ!' });
        }
        let slBase = 0;
        let descUnit = '';
        if (Array.isArray(item.chiTietDonVi) && item.chiTietDonVi.length > 0) {
            const parts = [];
            for (const u of item.chiTietDonVi) {
                const q = Number(u?.soLuong || 0);
                const hs = Number(u?.heSoQuyDoi || 1);
                if (q > 0 && hs > 0) {
                    slBase += q * hs;
                    parts.push(`${q} ${u.tenDonVi || 'đv'}(x${hs})`);
                }
            }
            slBase = lam3(slBase);
            descUnit = parts.join(' + ');
        } else {
            const slRaw = Number(item.soLuong);
            const hs = Number(item.heSoQuyDoi) > 0 ? Number(item.heSoQuyDoi) : 1;
            if (Number.isNaN(slRaw)) {
                return res.status(400).json({ message: `Số lượng của ${item.maNL} không hợp lệ!` });
            }
            slBase = lam3(slRaw * hs);
            descUnit = hs !== 1 && item.donViNhap ? `${slRaw} ${item.donViNhap}(x${hs})` : '';
        }

        if ((loaiGD === 2 && !(slBase > 0)) || (loaiGD === 3 && slBase < 0)) {
            return res.status(400).json({
                message: loaiGD === 2
                    ? 'Xuất hủy yêu cầu maNL và soLuong > 0!'
                    : 'Kiểm kê yêu cầu maNL và số lượng thực tế >= 0!',
            });
        }
        parsedItems.push({ ...item, slBase, descUnit });
    }

    try {
        const maGiaoDich = await chayGiaoDich(async (client) => {
            const targetBranch = normalizeInventoryBranch(tenantId, rawBranchId || req.user.branchId || null);
            const docDate = await assertPeriodNotLocked(client, tenantId, targetBranch, ngayChungTu, LoiNghiepVu);

            const sorted = [...parsedItems].sort((a, b) => String(a.maNL).localeCompare(String(b.maNL)));
            const { branchId, stockMap } = await lockBranchStockOrdered(
                client,
                tenantId,
                targetBranch,
                sorted.map((x) => x.maNL)
            );
            const caMo = await layCaDangMo(client, 'SHARE', tenantId, { branchId });

            const phieuResult = await client.query(
                `INSERT INTO PhieuGiaoDichKho
                    (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan, MaLyDoHuy, NgayChungTu, TrangThaiDuyet)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, 'POSTED')
                 RETURNING MaGiaoDich`,
                [
                    req.user.maNV,
                    loaiGD,
                    ghiChu || (loaiGD === 2 ? `Xuất hủy (${WASTAGE_TAXONOMY[cleanReasonCode] || cleanReasonCode})` : 'Kiểm kê kho định kỳ'),
                    tenantId,
                    branchId,
                    caMo ? String(caMo.macathungan) : null,
                    cleanReasonCode,
                    docDate,
                ]
            );
            const maGD = phieuResult.rows[0].magiaodich;

            for (const item of sorted) {
                const st = stockMap.get(item.maNL);
                if (!st) throw new LoiNghiepVu(404, `Không tìm thấy nguyên liệu ${item.maNL}!`);
                const sl = item.slBase;
                const tonTruoc = st.soLuongTon;
                const giaVonSnap = st.giaVonDonVi;

                if (loaiGD === 2) {
                    const fefoRes = await consumeFefoBatches(client, { tenantId, branchId, maNL: item.maNL, qty: sl });
                    const unitCost = fefoRes.weightedCost !== null ? fefoRes.weightedCost : giaVonSnap;
                    const tonSau = lam3(tonTruoc - sl);
                    const note = [item.tinhTrang || WASTAGE_TAXONOMY[cleanReasonCode] || 'Hủy do hư hỏng', item.descUnit]
                        .filter(Boolean)
                        .join(' • ');

                    await insertLedgerLine(client, {
                        maGiaoDich: maGD,
                        maNL: item.maNL,
                        soLuong: sl,
                        donGiaNhap: unitCost,
                        tinhTrang: note,
                        tonTruoc,
                        tonSau,
                        giaVonTruoc: giaVonSnap,
                        giaVonSau: giaVonSnap,
                        donViNhap: item.donViNhap || st.donViTinh,
                        heSoQuyDoi: Number(item.heSoQuyDoi) > 0 ? Number(item.heSoQuyDoi) : 1,
                    });
                    await updateBranchStockRow(client, { tenantId, branchId, maNL: item.maNL, nextQty: tonSau });
                } else {
                    const doLech = lam3(sl - tonTruoc);
                    const note = `Kiểm kê thực tế: ${sl}${item.descUnit ? ` (${item.descUnit})` : ''}`;

                    await insertLedgerLine(client, {
                        maGiaoDich: maGD,
                        maNL: item.maNL,
                        soLuong: doLech,
                        donGiaNhap: giaVonSnap,
                        tinhTrang: note,
                        tonTruoc,
                        tonSau: sl,
                        giaVonTruoc: giaVonSnap,
                        giaVonSau: giaVonSnap,
                        donViNhap: item.donViNhap || st.donViTinh,
                        heSoQuyDoi: Number(item.heSoQuyDoi) > 0 ? Number(item.heSoQuyDoi) : 1,
                    });
                    await updateBranchStockRow(client, { tenantId, branchId, maNL: item.maNL, nextQty: sl });

                    if (caMo) {
                        await client.query(
                            `INSERT INTO public.chotton_ca (tenantid, branchid, macathungan, manl, tondauca, toncuoica, giavonca)
                             VALUES ($1::varchar, $2::varchar, $3::text, $4::varchar, $5::numeric, $6::numeric, $7::numeric)
                             ON CONFLICT (tenantid, macathungan, manl)
                             DO UPDATE SET toncuoica = EXCLUDED.toncuoica, giavonca = EXCLUDED.giavonca, thoigianchot = now()`,
                            [tenantId, branchId, String(caMo.macathungan), item.maNL, tonTruoc, sl, giaVonSnap]
                        );
                    }
                }
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: loaiGD === 2 ? 'INVENTORY_WASTAGE' : 'INVENTORY_STOCKTAKE',
                doiTuong: 'KHO',
                maDoiTuong: maGD,
                giaTriMoi: { branchId, soDong: sorted.length, maLyDoHuy: cleanReasonCode, ghiChu },
                ip: req.ip,
                batBuoc: true,
            });
            return maGD;
        }, tenantId);

        res.json({
            message: loaiGD === 2 ? 'Lập phiếu xuất hủy thành công!' : 'Cập nhật kiểm kê kho thành công!',
            maGiaoDich,
            maLyDoHuy: cleanReasonCode,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Xuất hủy/Kiểm kê:');
    }
});

function tinhDongCanDoiKho(r) {
    const giaVon = Number(r.giavondonvi || 0);
    const tieuHaoGoc = Number(r.tongtieuhaobanhang || 0);
    const hoanKhoHuyMon = Number(r.tonghoankhohuymon || 0);
    const haoHutHuyMon = Number(r.tonghaohuthuymon || 0);
    // Loại trừ hoàn kho (LoaiGD=7) & hao hụt hủy món đã pha (LoaiGD=8) khỏi LoaiGD=6 để KHÔNG đếm trùng lượng hao hụt
    const tieuHao = Math.max(0, Math.round((tieuHaoGoc - hoanKhoHuyMon - haoHutHuyMon) * 1000) / 1000);
    const xuatHuy = Math.round((Number(r.tongxuathuy || 0) + haoHutHuyMon) * 1000) / 1000;
    const lechKiemKe = Number(r.tongchenhlechkiemke || 0);
    const luongThatThoat = Math.max(0, xuatHuy + Math.max(0, -lechKiemKe));
    // Ưu tiên tính giá trị thất thoát theo DonGiaNhap (GiaVonDonVi lịch sử đã snapshot lúc xuất hủy/kiểm kê)
    const giaTriXuatHuyLichSu = Number(r.giatrixuathuylichsu || 0);
    const giaTriLechKiemKeLichSu = Number(r.giatrilechkiemkelichsu || 0);
    const giaTriThatThoat =
        giaTriXuatHuyLichSu > 0 || giaTriLechKiemKeLichSu > 0
            ? Math.round(giaTriXuatHuyLichSu + giaTriLechKiemKeLichSu)
            : Math.round(luongThatThoat * giaVon);
    const mauSo = tieuHao + luongThatThoat;
    const tyLeThatThoatPct = mauSo > 0 ? Math.round((luongThatThoat / mauSo) * 1000) / 10 : 0;
    return {
        ...r,
        tongtieuhaobanhang: tieuHao,
        tongxuathuy: xuatHuy,
        tonghaohuthuymon: haoHutHuyMon,
        giaTriThatThoat,
        tyLeThatThoatPct,
    };
}

app.get('/api/kho/candoi', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { tuNgay, denNgay, branchId: rawBranchId = null } = req.query;
    const tenantId = layTenantId(req);
    if (!tuNgay || !denNgay) return res.status(400).json({ message: 'Vui lòng cung cấp tham số tuNgay và denNgay (YYYY-MM-DD)!' });
    const branchId = normalizeInventoryBranch(tenantId, rawBranchId || req.user.branchId || null);
    const isMain = branchId === `${tenantId}_MAIN`;

    try {
        const result = await qTenant(req, `
            SELECT nl.MaNL, nl.TenNL, nl.DonViTinh,
                   COALESCE(tk.SoLuongTon, CASE WHEN $5::boolean THEN nl.SoLuongTon ELSE 0 END, 0) AS TonKhoHienTai,
                   COALESCE(tk.GiaVonDonVi, nl.GiaVonDonVi, 0) AS GiaVonDonVi,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD IN (1, 10) THEN ct.SoLuong ELSE 0 END), 0) AS TongNhap,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 2 THEN ct.SoLuong ELSE 0 END), 0) AS TongXuatHuy,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 3 THEN ct.SoLuong ELSE 0 END), 0) AS TongChenhLechKiemKe,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 6 THEN ct.SoLuong ELSE 0 END), 0) AS TongTieuHaoBanHang,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 7 THEN ct.SoLuong ELSE 0 END), 0) AS TongHoanKhoHuyMon,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 8 THEN ct.SoLuong ELSE 0 END), 0) AS TongHaoHutHuyMon,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD IN (2, 8) THEN ct.SoLuong * CASE WHEN COALESCE(ct.DonGiaNhap, 0) > 0 THEN ct.DonGiaNhap ELSE COALESCE(tk.GiaVonDonVi, nl.GiaVonDonVi, 0) END ELSE 0 END), 0) AS GiaTriXuatHuyLichSu,
                   COALESCE(SUM(CASE WHEN pgd.LoaiGD = 3 AND ct.SoLuong < 0 THEN (-ct.SoLuong) * CASE WHEN COALESCE(ct.DonGiaNhap, 0) > 0 THEN ct.DonGiaNhap ELSE COALESCE(tk.GiaVonDonVi, nl.GiaVonDonVi, 0) END ELSE 0 END), 0) AS GiaTriLechKiemKeLichSu
            FROM NguyenLieu nl
            LEFT JOIN public.tonkhochinhanh tk
                 ON tk.tenantid = $3::text AND tk.branchid = $4::text AND tk.manl = nl.manl
            LEFT JOIN ChiTietGiaoDichKho ct ON nl.MaNL = ct.MaNL
            LEFT JOIN PhieuGiaoDichKho pgd ON ct.MaGiaoDich = pgd.MaGiaoDich
                 AND COALESCE(pgd.TrangThaiDuyet, 'POSTED') = 'POSTED'
                 AND COALESCE(NULLIF(NULLIF(pgd.BranchId::text, ''), 'DEFAULT'), $3::text || '_MAIN') = $4::text
                 AND pgd.ThoiGianTao >= ($1::text::timestamp AT TIME ZONE '${VN_TZ}')
                 AND pgd.ThoiGianTao < (($2::text::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')
            WHERE nl.DaXoa = FALSE AND COALESCE(nl.TenantId::text, 'DEFAULT') = $3::text
            GROUP BY nl.MaNL, nl.TenNL, nl.DonViTinh, tk.SoLuongTon, nl.SoLuongTon, tk.GiaVonDonVi, nl.GiaVonDonVi
            ORDER BY nl.MaNL ASC
        `, [tuNgay, denNgay, tenantId, branchId, isMain]);

        const canDoiKho = result.rows.map(tinhDongCanDoiKho);

        res.json({ kyBaoCao: { tuNgay, denNgay, branchId }, canDoiKho });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Cân đối kho:');
    }
});


app.get('/api/kho/nguyenlieu', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    const laQuanLy = Number(req.user.vaiTro) === 1;
    const branchId = normalizeInventoryBranch(tenantId, req.query.branchId || req.user.branchId || null);
    const isMain = branchId === `${tenantId}_MAIN`;
    // Luôn ẩn tồn hệ thống (Blind) cho tài khoản không phải Quản lý để tránh rò rỉ tồn lý thuyết
    const isBlind = !laQuanLy || String(req.query.blind || '') === '1';
    try {
        const r = await qTenant(
            req,
            `SELECT nl.MaNL, nl.TenNL, nl.DonViTinh,
                    COALESCE(tk.SoLuongTon, CASE WHEN $3::boolean THEN nl.SoLuongTon ELSE 0 END, 0) AS SoLuongTon,
                    COALESCE(tk.TonDangChuyen, 0) AS TonDangChuyen,
                    COALESCE(tk.HanMucCanhBao, nl.HanMucCanhBao, 0) AS HanMucCanhBao,
                    COALESCE(tk.GiaVonDonVi, nl.GiaVonDonVi, 0) AS GiaVonDonVi,
                    COALESCE((to_jsonb(nl)->>'iskeyitem')::boolean, FALSE) AS IsKeyItem,
                    COALESCE((to_jsonb(nl)->>'labanthanhpham')::boolean, FALSE) AS LaBanThanhPham,
                    COALESCE((to_jsonb(nl)->>'sanluongmemacdinh')::numeric, 1000) AS SanLuongMeMacDinh,
                    (to_jsonb(nl)->>'hansudunggio')::int AS HanSuDungGio,
                    COALESCE((to_jsonb(nl)->>'theodoihandung')::boolean, FALSE) AS TheoDoiHanDung,
                    to_jsonb(nl)->>'manccmacdinh' AS MaNCCMacDinh
               FROM NguyenLieu nl
               LEFT JOIN public.tonkhochinhanh tk
                 ON tk.tenantid = $1::text AND tk.branchid = $2::text AND tk.manl = nl.manl
              WHERE nl.DaXoa = FALSE AND COALESCE(nl.TenantId::text, 'DEFAULT') = $1::text
              ORDER BY nl.TenNL`,
            [tenantId, branchId, isMain]
        );
        res.json(r.rows.map((n) => ({
            maNL: n.manl,
            tenNL: n.tennl,
            donViTinh: n.donvitinh,
            branchId,
            ...(!isBlind ? { soLuongTon: Number(n.soluongton), tonDangChuyen: Number(n.tondangchuyen || 0) } : {}),
            hanMucCanhBao: Number(n.hanmuccanhbao),
            isKeyItem: Boolean(n.iskeyitem),
            laBanThanhPham: Boolean(n.labanthanhpham),
            sanLuongMeMacDinh: Number(n.sanluongmemacdinh || 1000),
            hanSuDungGio: n.hansudunggio ? Number(n.hansudunggio) : null,
            theoDoiHanDung: Boolean(n.theodoihandung),
            maNCCMacDinh: n.manccmacdinh || null,
            ...(laQuanLy ? { giaVonDonVi: Number(n.giavondonvi) } : {}),
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách nguyên liệu:');
    }
});

// [P1 + P4] Cập nhật thuộc tính IsKeyItem / LaBanThanhPham / TheoDoiHanDung / MaNCCMacDinh trên Nguyên liệu
app.put('/api/kho/nguyenlieu/:maNL/thuoctinh', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { maNL } = req.params;
    const tenantId = layTenantId(req);
    const { isKeyItem, laBanThanhPham, sanLuongMeMacDinh, hanSuDungGio, theoDoiHanDung, maNCCMacDinh } = req.body || {};

    try {
        const updated = await pool.withTenant(tenantId, async (client) => {
            const curRes = await client.query(
                `SELECT MaNL, TenNL,
                        COALESCE((to_jsonb(NguyenLieu)->>'iskeyitem')::boolean, FALSE) AS IsKeyItem,
                        COALESCE((to_jsonb(NguyenLieu)->>'labanthanhpham')::boolean, FALSE) AS LaBanThanhPham,
                        COALESCE((to_jsonb(NguyenLieu)->>'sanluongmemacdinh')::numeric, 1000) AS SanLuongMeMacDinh,
                        (to_jsonb(NguyenLieu)->>'hansudunggio')::int AS HanSuDungGio,
                        COALESCE((to_jsonb(NguyenLieu)->>'theodoihandung')::boolean, FALSE) AS TheoDoiHanDung,
                        to_jsonb(NguyenLieu)->>'manccmacdinh' AS MaNCCMacDinh
                   FROM NguyenLieu
                  WHERE MaNL = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2
                  FOR UPDATE`,
                [maNL, tenantId]
            );
            if (curRes.rows.length === 0) return null;
            const cur = curRes.rows[0];
            const nextKey = isKeyItem !== undefined ? Boolean(isKeyItem) : Boolean(cur.iskeyitem);
            const nextBtp = laBanThanhPham !== undefined ? Boolean(laBanThanhPham) : Boolean(cur.labanthanhpham);
            const nextYield =
                Number(sanLuongMeMacDinh) > 0 ? Number(sanLuongMeMacDinh) : Number(cur.sanluongmemacdinh || 1000);
            const nextExpiry =
                hanSuDungGio === null || hanSuDungGio === ''
                    ? null
                    : Number(hanSuDungGio) > 0
                    ? Math.floor(Number(hanSuDungGio))
                    : cur.hansudunggio;
            const nextFefo = theoDoiHanDung !== undefined ? Boolean(theoDoiHanDung) : Boolean(cur.theodoihandung);
            const nextNcc = maNCCMacDinh !== undefined ? (maNCCMacDinh ? String(maNCCMacDinh).trim() : null) : cur.manccmacdinh;

            await client.query(
                `UPDATE NguyenLieu
                    SET IsKeyItem = $2,
                        LaBanThanhPham = $3,
                        SanLuongMeMacDinh = $4,
                        HanSuDungGio = $5,
                        TheoDoiHanDung = $6,
                        MaNCCMacDinh = $7
                  WHERE MaNL = $1 AND COALESCE(TenantId, 'DEFAULT') = $8`,
                [maNL, nextKey, nextBtp, nextYield, nextExpiry, nextFefo, nextNcc, tenantId]
            );
            return {
                maNL: cur.manl,
                tenNL: cur.tennl,
                isKeyItem: nextKey,
                laBanThanhPham: nextBtp,
                sanLuongMeMacDinh: nextYield,
                hanSuDungGio: nextExpiry,
                theoDoiHanDung: nextFefo,
                maNCCMacDinh: nextNcc,
            };
        });
        if (!updated) return res.status(404).json({ message: 'Không tìm thấy nguyên liệu thuộc quán này!' });
        res.json({
            message: `Đã cập nhật thuộc tính cho "${updated.tenNL}"!`,
            ...updated,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Cập nhật thuộc tính nguyên liệu:');
    }
});

// [P1 - Sub-Recipes / Batch Prep] Danh sách Bán thành phẩm & Công thức sơ chế theo mẻ (Công thức Cấp 2)
app.get('/api/kho/ban-thanh-pham', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const data = await pool.withTenant(tenantId, async (client) => {
            const nlRes = await client.query(
                `SELECT MaNL, TenNL, DonViTinh, SoLuongTon, HanMucCanhBao, COALESCE(GiaVonDonVi, 0) AS GiaVonDonVi,
                        COALESCE((to_jsonb(NguyenLieu)->>'labanthanhpham')::boolean, FALSE) AS LaBanThanhPham,
                        COALESCE((to_jsonb(NguyenLieu)->>'sanluongmemacdinh')::numeric, 1000) AS SanLuongMeMacDinh,
                        (to_jsonb(NguyenLieu)->>'hansudunggio')::int AS HanSuDungGio
                   FROM NguyenLieu
                  WHERE DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $1
                  ORDER BY TenNL`,
                [tenantId]
            );
            let ctRows = [];
            await client.query('SAVEPOINT sp_btp_ct_sel');
            try {
                const ctRes = await client.query(
                    `SELECT btp.MaNLThanhPham, btp.MaNLThanhPhan, nl.TenNL AS TenNLThanhPhan,
                            nl.DonViTinh AS DonViThanhPhan, btp.KhoiLuongTieuHao,
                            COALESCE(nl.GiaVonDonVi, 0) AS GiaVonThanhPhan
                       FROM BanThanhPham_CongThuc btp
                       JOIN NguyenLieu nl ON nl.MaNL = btp.MaNLThanhPhan
                      WHERE btp.TenantId = $1
                      ORDER BY nl.TenNL`,
                    [tenantId]
                );
                await client.query('RELEASE SAVEPOINT sp_btp_ct_sel');
                ctRows = ctRes.rows;
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_btp_ct_sel').catch(() => {});
            }
            return { nlRows: nlRes.rows, ctRows };
        });

        const ctMap = new Map();
        for (const r of data.ctRows) {
            if (!ctMap.has(r.manlthanhpham)) ctMap.set(r.manlthanhpham, []);
            ctMap.get(r.manlthanhpham).push({
                maNLThanhPhan: r.manlthanhphan,
                tenNLThanhPhan: r.tennlthanhphan,
                donViTinh: r.donvithanhphan,
                khoiLuongTieuHao: Number(r.khoiluongtieuhao),
                giaVonDonVi: Number(r.giavonthanhphan || 0),
            });
        }

        const list = data.nlRows
            .filter((n) => Boolean(n.labanthanhpham) || ctMap.has(n.manl))
            .map((n) => {
                const dinhMuc = ctMap.get(n.manl) || [];
                const sanLuongMe = Number(n.sanluongmemacdinh || 1000);
                const giaVonMeDuKien = Math.round(
                    dinhMuc.reduce((s, c) => s + c.khoiLuongTieuHao * c.giaVonDonVi, 0)
                );
                const giaVonDonViDuKien =
                    sanLuongMe > 0 ? Math.round((giaVonMeDuKien / sanLuongMe) * 10000) / 10000 : 0;
                return {
                    maNL: n.manl,
                    tenNL: n.tennl,
                    donViTinh: n.donvitinh,
                    soLuongTon: Number(n.soluongton),
                    giaVonDonViHienTai: Number(n.giavondonvi || 0),
                    sanLuongMeMacDinh: sanLuongMe,
                    hanSuDungGio: n.hansudunggio ? Number(n.hansudunggio) : null,
                    giaVonMeDuKien,
                    giaVonDonViDuKien,
                    dinhMuc,
                };
            });
        res.json(list);
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách Bán thành phẩm:');
    }
});

// [P1 - Sub-Recipes / Batch Prep] Thiết lập Công thức Cấp 2 cho Bán thành phẩm (VD: 1 mẻ 2000g Trân châu chín = 1000g Trân châu sống + 250g Đường đen)
app.post('/api/kho/ban-thanh-pham/:maNLThanhPham/congthuc', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('inventory_bom'), async (req, res) => {
    const { maNLThanhPham } = req.params;
    const tenantId = layTenantId(req);
    const { sanLuongMeMacDinh = 1000, hanSuDungGio = null, dinhMuc = [] } = req.body || {};

    if (!Array.isArray(dinhMuc)) {
        return res.status(400).json({ message: 'dinhMuc phải là danh sách nguyên liệu thành phần!' });
    }
    const rawCompIds = [...new Set(dinhMuc.map((d) => String(d?.maNLThanhPhan || '').trim()).filter(Boolean))];
    if (rawCompIds.includes(maNLThanhPham)) {
        return res.status(400).json({
            code: 'CIRCULAR_SUBRECIPE_DETECTED',
            maLoi: 'CIRCULAR_SUBRECIPE_DETECTED',
            message: `Phát hiện vòng lặp công thức: Bán thành phẩm "${maNLThanhPham}" không thể tự chứa chính nó!`,
        });
    }
    const validRows = dinhMuc.filter(
        (d) => d && d.maNLThanhPhan && d.maNLThanhPhan !== maNLThanhPham && Number(d.khoiLuongTieuHao) > 0
    );
    if (validRows.length === 0) {
        return res.status(400).json({ message: 'Cần ít nhất 1 nguyên liệu thành phần hợp lệ có định lượng > 0!' });
    }
    const sanLuong = Number(sanLuongMeMacDinh) > 0 ? Number(sanLuongMeMacDinh) : 1000;
    const hsd = Number(hanSuDungGio) > 0 ? Math.floor(Number(hanSuDungGio)) : null;

    try {
        const result = await chayGiaoDich(async (client) => {
            const tpRes = await client.query(
                "SELECT MaNL, TenNL, DonViTinh FROM NguyenLieu WHERE MaNL = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2 FOR UPDATE",
                [maNLThanhPham, tenantId]
            );
            if (tpRes.rows.length === 0) {
                throw new LoiNghiepVu(404, 'Không tìm thấy nguyên liệu bán thành phẩm thuộc quán này!');
            }

            const compIds = [...new Set(validRows.map((r) => r.maNLThanhPhan))];
            const ownComp = await client.query(
                "SELECT MaNL FROM NguyenLieu WHERE MaNL = ANY($1::varchar[]) AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2",
                [compIds, tenantId]
            );
            if (ownComp.rows.length !== compIds.length) {
                throw new LoiNghiepVu(400, 'Có nguyên liệu thành phần không thuộc quán hiện tại!');
            }

            // [Phân hệ 4 - Cycle Detection DAG] Chặn vòng lặp đa cấp A -> B -> C -> A (sâu tối đa 5 tầng)!
            await detectSubRecipeCycle(client, tenantId, maNLThanhPham, compIds, LoiNghiepVu);

            await client.query(
                `UPDATE NguyenLieu
                    SET LaBanThanhPham = TRUE,
                        SanLuongMeMacDinh = $2,
                        HanSuDungGio = $3
                  WHERE MaNL = $1 AND COALESCE(TenantId, 'DEFAULT') = $4`,
                [maNLThanhPham, sanLuong, hsd, tenantId]
            );

            await client.query(
                'DELETE FROM BanThanhPham_CongThuc WHERE TenantId = $1 AND MaNLThanhPham = $2',
                [tenantId, maNLThanhPham]
            );
            for (const row of validRows) {
                await client.query(
                    `INSERT INTO BanThanhPham_CongThuc (TenantId, MaNLThanhPham, MaNLThanhPhan, KhoiLuongTieuHao)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (TenantId, MaNLThanhPham, MaNLThanhPhan)
                     DO UPDATE SET KhoiLuongTieuHao = EXCLUDED.KhoiLuongTieuHao`,
                    [tenantId, maNLThanhPham, row.maNLThanhPhan, Number(row.khoiLuongTieuHao)]
                );
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'SUBRECIPE_BOM_UPDATED',
                doiTuong: 'NGUYENLIEU',
                maDoiTuong: maNLThanhPham,
                giaTriMoi: { sanLuongMeMacDinh: sanLuong, hanSuDungGio: hsd, dinhMuc: validRows },
                ip: req.ip,
                batBuoc: true,
            });

            return tpRes.rows[0];
        }, tenantId);

        res.json({
            message: `Đã lưu công thức sơ chế mẻ cho "${result.tennl}" (${sanLuong} ${result.donvitinh}/mẻ)!`,
            maNLThanhPham,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lưu công thức Bán thành phẩm:');
    }
});

// [P1 + P4 - Sub-Recipes / Flexible Batch + Yield Loss + FEFO Lot]
app.post('/api/kho/san-xuat-me', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
    const tenantId = layTenantId(req);
    const {
        branchId: rawBranchId = null,
        maNLThanhPham,
        soMe = 1,
        sanLuongThucTe = null,
        ghiChu = null,
        ngayChungTu = null,
    } = req.body || {};
    const numBatches = Number(soMe);
    if (!maNLThanhPham || !(numBatches > 0)) {
        return res.status(400).json({ message: 'Vui lòng cung cấp maNLThanhPham và số mẻ > 0!' });
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const targetBranch = normalizeInventoryBranch(tenantId, rawBranchId || req.user.branchId || null);
            const docDate = await assertPeriodNotLocked(client, tenantId, targetBranch, ngayChungTu, LoiNghiepVu);

            const ctRes = await client.query(
                `SELECT MaNLThanhPhan, KhoiLuongTieuHao
                   FROM BanThanhPham_CongThuc
                  WHERE TenantId = $1 AND MaNLThanhPham = $2
                  ORDER BY MaNLThanhPhan ASC`,
                [tenantId, maNLThanhPham]
            );
            if (ctRes.rows.length === 0) {
                throw new LoiNghiepVu(400, `Bán thành phẩm "${maNLThanhPham}" chưa được cấu hình công thức nguyên liệu thô!`);
            }

            // Khóa đồng thời cả Bán thành phẩm + toàn bộ nguyên liệu thô theo ORDER BY MaNL ASC -> 0% Deadlock!
            const allNlIds = [maNLThanhPham, ...ctRes.rows.map((r) => r.manlthanhphan)];
            const { branchId, stockMap } = await lockBranchStockOrdered(client, tenantId, targetBranch, allNlIds);
            const tp = stockMap.get(maNLThanhPham);
            if (!tp) {
                throw new LoiNghiepVu(404, 'Không tìm thấy bán thành phẩm cần nấu/ủ!');
            }

            const sanLuongLyThuyet = lam3(Number(tp.sanLuongMeMacDinh || 1000) * numBatches);
            const sanLuongMe =
                Number(sanLuongThucTe) > 0 ? lam3(Number(sanLuongThucTe)) : sanLuongLyThuyet;
            const yieldPct =
                sanLuongLyThuyet > 0 ? Math.round((sanLuongMe / sanLuongLyThuyet) * 1000) / 10 : 100;
            const prepLossPct = Math.round((100 - yieldPct) * 10) / 10;
            const highPrepLoss = prepLossPct > 15;

            const caMo = await layCaDangMo(client, 'SHARE', tenantId, { branchId });

            // 1. Trừ nguyên liệu thô (Single-Source TonKhoChiNhanh + FEFO) & tính tổng giá vốn của mẻ
            let tongGiaVonMe = 0;
            const phieuXuat = await client.query(
                `INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan, NgayChungTu, TrangThaiDuyet)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::date, 'POSTED') RETURNING MaGiaoDich`,
                [
                    req.user.maNV,
                    LOAI_GD_TIEU_HAO,
                    `Xuất nguyên liệu thô nấu ${numBatches} mẻ ${tp.tenNL} (thực thu ${sanLuongMe} ${tp.donViTinh}, Yield ${yieldPct}%)`,
                    tenantId,
                    branchId,
                    caMo ? String(caMo.macathungan) : null,
                    docDate,
                ]
            );
            const maGDXuat = phieuXuat.rows[0].magiaodich;

            const dsTieuHao = [];
            for (const row of ctRes.rows) {
                const comp = stockMap.get(row.manlthanhphan);
                if (!comp) {
                    throw new LoiNghiepVu(404, `Không tìm thấy nguyên liệu thành phần ${row.manlthanhphan}!`);
                }
                const klCan = lam3(Number(row.khoiluongtieuhao) * numBatches);
                const fefoRes = await consumeFefoBatches(client, { tenantId, branchId, maNL: comp.maNL, qty: klCan });
                const giaVonComp = fefoRes.weightedCost !== null ? fefoRes.weightedCost : comp.giaVonDonVi;
                tongGiaVonMe += klCan * giaVonComp;

                const compBefore = comp.soLuongTon;
                const compAfter = lam3(compBefore - klCan);
                await insertLedgerLine(client, {
                    maGiaoDich: maGDXuat,
                    maNL: comp.maNL,
                    soLuong: klCan,
                    donGiaNhap: giaVonComp,
                    tinhTrang: `Sơ chế ${numBatches} mẻ ${tp.tenNL}`,
                    tonTruoc: compBefore,
                    tonSau: compAfter,
                    giaVonTruoc: comp.giaVonDonVi,
                    giaVonSau: comp.giaVonDonVi,
                });
                await updateBranchStockRow(client, { tenantId, branchId, maNL: comp.maNL, nextQty: compAfter });
                dsTieuHao.push({
                    maNL: comp.maNL,
                    tenNL: comp.tenNL,
                    soLuong: klCan,
                    donViTinh: comp.donViTinh,
                    giaVonDonVi: giaVonComp,
                });
            }

            // 2. Tính Safe WAC theo Sản lượng Thực thu (sanLuongMe) & cộng tồn kho (LoaiGD = 10: SAN_XUAT_ME_BTP)
            const wacMe = computeSafeWacOnStockIn({
                tonCu: tp.soLuongTon,
                giaVonCu: tp.giaVonDonVi,
                slNhapBase: sanLuongMe,
                tongTienHang: tongGiaVonMe,
            });
            const donGiaVonMe = wacMe.donGiaNhapThucTe;
            const giaVonMoi = wacMe.giaVonMoi;
            const tpBefore = tp.soLuongTon;
            const tpAfter = lam3(tpBefore + sanLuongMe);
            if (Math.abs(wacMe.cogsAdjustment) >= 0.01) {
                await recordCogsAdjustment(client, {
                    tenantId,
                    branchId,
                    businessDate: todayDateVN(),
                    maNL: maNLThanhPham,
                    sourceType: 'NEGATIVE_STOCK_CATCHUP',
                    refMaGiaoDich: null,
                    qtyAffected: Math.min(Math.abs(tpBefore), sanLuongMe),
                    oldUnitCost: tp.giaVonDonVi,
                    newUnitCost: donGiaVonMe,
                    adjustmentAmount: wacMe.cogsAdjustment,
                    createdBy: req.user.maNV,
                });
            }

            const hanSuDungDen =
                tp.hanSuDungGio && Number(tp.hanSuDungGio) > 0
                    ? new Date(Date.now() + Number(tp.hanSuDungGio) * 3600000).toISOString()
                    : null;
            const gioNauStr = new Date(Date.now() + 7 * 3600000).toISOString().slice(11, 16);
            const gioHsdStr = hanSuDungDen
                ? new Date(new Date(hanSuDungDen).getTime() + 7 * 3600000).toISOString().slice(11, 16)
                : null;
            const maLoBtp = `BTP-${gioNauStr.replace(':', '')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

            const moTaMe = [
                `Nấu ${numBatches} mẻ (+${sanLuongMe}/${sanLuongLyThuyet} ${tp.donViTinh} • Yield ${yieldPct}%)`,
                gioHsdStr ? `HSD: ${gioHsdStr}` : null,
                highPrepLoss ? '⚠️ HIGH_PREP_LOSS' : null,
                ghiChu ? String(ghiChu).trim() : null,
            ]
                .filter(Boolean)
                .join(' • ');

            const phieuNhap = await client.query(
                `INSERT INTO PhieuGiaoDichKho (MaNV, LoaiGD, GhiChu, TenantId, BranchId, MaCaThuNgan, NgayChungTu, TrangThaiDuyet)
                 VALUES ($1, 10, $2, $3, $4, $5, $6::date, 'POSTED') RETURNING MaGiaoDich`,
                [
                    req.user.maNV,
                    `Sản xuất mẻ BTP: ${tp.tenNL} (${moTaMe})`.slice(0, 255),
                    tenantId,
                    branchId,
                    caMo ? String(caMo.macathungan) : null,
                    docDate,
                ]
            );
            const maGDNhap = phieuNhap.rows[0].magiaodich;

            await insertLedgerLine(client, {
                maGiaoDich: maGDNhap,
                maNL: maNLThanhPham,
                soLuong: sanLuongMe,
                donGiaNhap: donGiaVonMe,
                tinhTrang: moTaMe,
                tonTruoc: tpBefore,
                tonSau: tpAfter,
                giaVonTruoc: tp.giaVonDonVi,
                giaVonSau: giaVonMoi,
            });
            await updateBranchStockRow(client, {
                tenantId,
                branchId,
                maNL: maNLThanhPham,
                nextQty: tpAfter,
                nextWac: giaVonMoi,
            });

            // 3. Tự động sinh Lô Bán thành phẩm trong public.lo_tonkho (có đồng hồ HSD riêng!)
            const createdLot = await createFefoLot(client, {
                tenantId,
                branchId,
                maNL: maNLThanhPham,
                maLo: maLoBtp,
                nguonLo: 'SUBRECIPE',
                maGiaoDichNguon: String(maGDNhap),
                soLuong: sanLuongMe,
                giaVonLo: donGiaVonMe,
                thoiGianHetHan: hanSuDungDen,
            });

            // [Phân hệ 2 - Smart Auto Un-86] Khi nấu mẻ Bán thành phẩm mới -> tự mở khóa các món/topping/combo bị khóa!
            const autoUnlocked = await autoUn86OnRestock(client, {
                tenantId,
                maNLList: [maNLThanhPham],
            });

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: highPrepLoss ? 'HIGH_PREP_LOSS' : 'SUBRECIPE_BATCH_PRODUCED',
                doiTuong: 'NGUYENLIEU',
                maDoiTuong: maNLThanhPham,
                giaTriCu: { soLuongTon: tpBefore, giaVonDonVi: tp.giaVonDonVi },
                giaTriMoi: {
                    branchId,
                    soMe: numBatches,
                    sanLuongLyThuyet,
                    sanLuongMe,
                    yieldPct,
                    prepLossPct,
                    highPrepLoss,
                    tongGiaVonMe: Math.round(tongGiaVonMe),
                    donGiaVonMe,
                    giaVonDonViMoi: giaVonMoi,
                    hanSuDungDen,
                    lotId: createdLot?.id || null,
                    maLo: createdLot?.malo || maLoBtp,
                    dsTieuHao,
                    autoUnlocked,
                },
                lyDo: moTaMe,
                ip: req.ip,
                batBuoc: true,
            });

            if (highPrepLoss && typeof dispatchFraudAlertFromAudit === 'function') {
                void dispatchFraudAlertFromAudit(pool, {
                    tenantId,
                    hanhDong: 'HIGH_PREP_LOSS',
                    maNV: req.user.maNV,
                    maDoiTuong: maNLThanhPham,
                    giaTriMoi: { tenNL: tp.tenNL, sanLuongLyThuyet, sanLuongMe, prepLossPct },
                    lyDo: `⚠️ Hao hụt sơ chế bất thường (${prepLossPct}%): ${tp.tenNL} chỉ thu ${sanLuongMe}/${sanLuongLyThuyet} ${tp.donViTinh}!`,
                }).catch(() => {});
            }

            return {
                branchId,
                maNLThanhPham,
                tenNL: tp.tenNL,
                donViTinh: tp.donViTinh,
                soMe: numBatches,
                sanLuongLyThuyet,
                sanLuongMe,
                yieldPct,
                prepLossPct,
                highPrepLoss,
                tongGiaVonMe: Math.round(tongGiaVonMe),
                donGiaVonMe,
                giaVonDonViMoi: giaVonMoi,
                soLuongTonMoi: tpAfter,
                hanSuDungDen,
                lot: createdLot
                    ? {
                          id: Number(createdLot.id),
                          maLo: createdLot.malo,
                          soLuongConLai: Number(createdLot.soluongconlai),
                          thoiGianHetHan: createdLot.thoigianhethan,
                      }
                    : null,
                labelPayload: {
                    title: tp.tenNL.toUpperCase(),
                    cookedAt: gioNauStr,
                    expiresAt: gioHsdStr || 'Trong ngày',
                    staff: req.user.tenNV || req.user.maNV,
                    batchCode: maLoBtp,
                    qtyText: `${sanLuongMe} ${tp.donViTinh}`,
                },
                dsTieuHao,
                autoUnlocked,
            };
        }, tenantId);

        if (
            ketQua.autoUnlocked &&
            (ketQua.autoUnlocked.unlockedProducts.length > 0 ||
                ketQua.autoUnlocked.unlockedToppings.length > 0 ||
                ketQua.autoUnlocked.unlockedModifiers.length > 0 ||
                ketQua.autoUnlocked.unlockedCombos.length > 0)
        ) {
            const subRecipeBranchId = ketQua.branchId || req.body?.branchId || req.user?.branchId || 'DEFAULT';
            emitToBranch(io, {
                tenantId,
                branchId: subRecipeBranchId,
                roles: ['POS', 'WAITER', 'KDS', 'EXPO'],
                event: 'menu:86_updated',
                payload: { type: 'AUTO_UN86_SUBRECIPE', ...ketQua.autoUnlocked },
            });
            for (const p of ketQua.autoUnlocked.unlockedProducts) {
                emitToBranch(io, {
                    tenantId,
                    branchId: subRecipeBranchId,
                    roles: ['POS', 'WAITER', 'KDS', 'EXPO'],
                    event: 'THUC_DON_THAY_DOI',
                    payload: p,
                });
            }
        }

        res.status(201).json({
            message: `🔥 Đã nấu/ủ xong ${ketQua.soMe} mẻ "${ketQua.tenNL}" (+${ketQua.sanLuongMe} ${ketQua.donViTinh} • Giá vốn WAC mới: ${ketQua.giaVonDonViMoi}đ/${ketQua.donViTinh})!`,
            ...ketQua,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Sản xuất mẻ Bán thành phẩm:');
    }
});

// [Wave 3B — P1-04] Quét mẻ Bán thành phẩm/Nguyên liệu sắp hết hạn (<= 15 phút) & bắn cảnh báo lên KDS đúng chi nhánh
async function checkExpiringBatchesAndEmitKds({ tenantId, branchId = 'DEFAULT', withinMinutes = 15 } = {}) {
    const cleanBranch = normalizeBranchId(branchId || 'DEFAULT');
    const mins = Math.max(1, Math.min(240, Number(withinMinutes || 15)));
    const batches = await pool.withTenant(tenantId, async (client) => {
        const res = await client.query(
            `SELECT lt.id, lt.branchid, lt.manl, nl.tennl, nl.donvitinh,
                    lt.malo, lt.soluongconlai, lt.thoigianhethan, lt.trangthai,
                    ROUND(EXTRACT(EPOCH FROM (lt.thoigianhethan - now())) / 60.0)::int AS minutes_left
               FROM public.lo_tonkho lt
               JOIN public.nguyenlieu nl ON nl.manl = lt.manl AND COALESCE(nl.tenantid, 'DEFAULT') = lt.tenantid
              WHERE lt.tenantid = $1
                AND lt.branchid = $2
                AND lt.trangthai = 'ACTIVE'
                AND lt.soluongconlai > 0
                AND lt.thoigianhethan IS NOT NULL
                AND lt.thoigianhethan <= now() + ($3 || ' minutes')::interval
              ORDER BY lt.thoigianhethan ASC
              LIMIT 30`,
            [tenantId, cleanBranch, String(mins)]
        );
        return res.rows.map((r) => ({
            lotId: Number(r.id),
            branchId: r.branchid,
            maNL: r.manl,
            tenNL: r.tennl,
            donViTinh: r.donvitinh,
            maLo: r.malo,
            soLuongConLai: Number(r.soluongconlai),
            thoiGianHetHan: r.thoigianhethan,
            minutesLeft: Number(r.minutes_left),
            isExpired: Number(r.minutes_left) <= 0,
        }));
    });

    if (batches.length > 0 && io) {
        emitToBranch(io, {
            tenantId,
            branchId: cleanBranch,
            roles: ['KDS', 'EXPO'],
            station: 'ALL',
            event: 'kds:batch_expiring_warning',
            payload: {
                tenantId,
                branchId: cleanBranch,
                batches,
                checkedAt: new Date().toISOString(),
            },
        });
    }
    return batches;
}

app.get('/api/kds/expiring-batches', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    const branchId = normalizeBranchId(req.query.branchId || req.headers['x-branch-id'] || req.user?.maChiNhanh || 'DEFAULT');
    const withinMinutes = Number(req.query.withinMinutes || 15);
    try {
        const batches = await checkExpiringBatchesAndEmitKds({ tenantId, branchId, withinMinutes });
        res.json({ branchId, withinMinutes, batches });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Cảnh báo HSD bán thành phẩm KDS:');
    }
});

// [Wave 3B — P1-04] Xuất hủy 1 chạm mẻ hết hạn (EXPIRED_BATCH) từ màn hình KDS
app.post('/api/kds/batches/:lotId/discard-expired', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
    const tenantId = layTenantId(req);
    const lotId = Number(req.params.lotId);
    const lyDo = String(req.body?.lyDo || 'Xuất hủy mẻ bán thành phẩm hết hạn từ KDS').trim().slice(0, 255);
    if (!Number.isInteger(lotId) || lotId <= 0) {
        return res.status(400).json({ message: 'lotId không hợp lệ!' });
    }

    try {
        const ketQua = await chayGiaoDich(async (client) => {
            const lotRes = await client.query(
                `SELECT lt.id, lt.branchid, lt.manl, lt.malo, lt.soluongconlai, lt.giavonlo, lt.trangthai,
                        nl.tennl, nl.donvitinh, COALESCE(nl.giavondonvi, 0) AS giavondonvi
                   FROM public.lo_tonkho lt
                   JOIN public.nguyenlieu nl ON nl.manl = lt.manl AND COALESCE(nl.tenantid, 'DEFAULT') = lt.tenantid
                  WHERE lt.id = $1 AND lt.tenantid = $2
                  FOR UPDATE OF lt`,
                [lotId, tenantId]
            );
            if (lotRes.rows.length === 0) {
                throw new LoiNghiepVu(404, 'Không tìm thấy lô bán thành phẩm cần xuất hủy!');
            }
            const lot = lotRes.rows[0];
            if ((lot.trangthai !== 'ACTIVE' && lot.trangthai !== 'EXPIRED') || Number(lot.soluongconlai) <= 0) {
                throw new LoiNghiepVu(409, 'Lô này đã được sử dụng hết hoặc đã xuất hủy trước đó!');
            }

            const qtyDiscard = lam3(Number(lot.soluongconlai));
            const rawLotBranch = lot.branchid || 'DEFAULT';
            const docDate = await assertPeriodNotLocked(client, tenantId, rawLotBranch, todayDateVN(), LoiNghiepVu);
            const { branchId, stockMap } = await lockBranchStockOrdered(client, tenantId, rawLotBranch, [lot.manl]);
            const st = stockMap.get(lot.manl);
            const tonBefore = st ? Number(st.soLuongTon) : qtyDiscard;
            const tonAfter = Math.max(0, lam3(tonBefore - qtyDiscard));
            const giaVon = Number(lot.giavonlo || st?.giaVonDonVi || lot.giavondonvi || 0);

            await client.query(
                `UPDATE public.lo_tonkho
                    SET soluongconlai = 0, trangthai = 'DISPOSED'
                  WHERE id = $1::bigint AND tenantid = $2::text`,
                [lotId, tenantId]
            );

            await updateBranchStockRow(client, {
                tenantId,
                branchId,
                maNL: lot.manl,
                nextQty: tonAfter,
                nextWac: st ? Number(st.giaVonDonVi) : giaVon,
            });

            const caMo = await layCaDangMo(client, 'SHARE', tenantId, { branchId });
            const phieu = await client.query(
                `INSERT INTO public.phieugiaodichkho
                    (manv, loaigd, ghichu, tenantid, branchid, macathungan, malydohuy, ngaychungtu, trangthaiduyet)
                 VALUES ($1, 2, $2, $3, $4, $5, 'EXPIRED_BATCH', $6::date, 'POSTED')
                 RETURNING magiaodich`,
                [
                    req.user.maNV,
                    `[EXPIRED_BATCH] Hủy lô ${lot.malo} (${lot.tennl}): ${lyDo}`.slice(0, 255),
                    tenantId,
                    branchId,
                    caMo ? String(caMo.macathungan) : null,
                    docDate,
                ]
            );
            const maGD = phieu.rows[0].magiaodich;

            await insertLedgerLine(client, {
                maGiaoDich: maGD,
                maNL: lot.manl,
                soLuong: qtyDiscard,
                donGiaNhap: giaVon,
                tinhTrang: `EXPIRED_BATCH:${lot.malo}`,
                tonTruoc: tonBefore,
                tonSau: tonAfter,
                giaVonTruoc: st ? Number(st.giaVonDonVi) : giaVon,
                giaVonSau: st ? Number(st.giaVonDonVi) : giaVon,
            });

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'EXPIRED_BATCH',
                doiTuong: 'LO_TONKHO',
                maDoiTuong: String(lotId),
                giaTriCu: { maLo: lot.malo, soLuongConLai: qtyDiscard, trangThai: lot.trangthai },
                giaTriMoi: { maLo: lot.malo, soLuongConLai: 0, trangThai: 'DISPOSED', maGiaoDich: maGD, branchId },
                lyDo,
                ip: req.ip,
                batBuoc: true,
            });

            return {
                lotId,
                branchId,
                maLo: lot.malo,
                maNL: lot.manl,
                tenNL: lot.tennl,
                soLuongHuy: qtyDiscard,
                donViTinh: lot.donvitinh,
                maGiaoDich: maGD,
            };
        }, tenantId);

        const remaining = await checkExpiringBatchesAndEmitKds({ tenantId, branchId: ketQua.branchId, withinMinutes: 15 });
        emitToBranch(io, {
            tenantId,
            branchId: ketQua.branchId,
            roles: ['KDS', 'EXPO'],
            station: 'ALL',
            event: 'kds:batch_expiring_warning',
            payload: {
                tenantId,
                branchId: ketQua.branchId,
                batches: remaining,
                discardedLotId: lotId,
                checkedAt: new Date().toISOString(),
            },
        });

        res.json({
            message: `🗑️ Đã xuất hủy mẻ hết hạn "${ketQua.tenNL}" (${ketQua.maLo}, -${ketQua.soLuongHuy} ${ketQua.donViTinh})!`,
            ...ketQua,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Xuất hủy mẻ hết hạn KDS:');
    }
});

// [Phân hệ 2 - Cascade 86'ing 5 lớp] Khóa/Mở đệ quy theo Chi nhánh (branch_availability_86)
app.put('/api/kho/nguyenlieu/:maNL/tamhet', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
    const { maNL } = req.params;
    const tamHet = Boolean(req.body?.tamHet);
    const tenantId = layTenantId(req);
    const branchId = normalizeBranchId(req.body?.branchId || req.headers['x-branch-id'] || req.user?.branchId || 'DEFAULT');

    try {
        const result = await chayGiaoDich(async (client) => {
            const nlRes = await client.query(
                "SELECT MaNL, TenNL FROM NguyenLieu WHERE MaNL = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2",
                [maNL, tenantId]
            );
            if (nlRes.rows.length === 0) {
                throw new LoiNghiepVu(404, 'Không tìm thấy nguyên liệu thuộc quán này!');
            }
            const nl = nlRes.rows[0];
            const cascade = await cascadeIngredient86(client, {
                tenantId,
                branchId,
                maNL,
                action: tamHet ? 'LOCK' : 'UNLOCK',
                updatedBy: req.user.maNV,
            });

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'INGREDIENT_86_CASCADE',
                doiTuong: 'NGUYENLIEU',
                maDoiTuong: maNL,
                giaTriMoi: {
                    branchId,
                    tenNL: nl.tennl,
                    tamHet,
                    cascadedSubRecipes: cascade.cascadedSubRecipes,
                    soMonAnhHuong: cascade.affectedProducts.length,
                    soToppingAnhHuong: cascade.affectedToppings.length,
                    soModifierAnhHuong: cascade.affectedModifiers.length,
                    soComboAnhHuong: cascade.affectedCombos.length,
                    dsMon: cascade.affectedProducts.map((m) => m.maMon),
                    dsTopping: cascade.affectedToppings.map((t) => t.maTopping),
                },
                ip: req.ip,
                batBuoc: true,
            });

            return {
                branchId,
                maNL: nl.manl,
                tenNL: nl.tennl,
                tamHet,
                ...cascade,
            };
        }, tenantId);

        // [Wave 3A — P1-03] Phát Socket 3 tầng cô lập tuyệt đối theo đúng Chi nhánh (branchId)
        emitScopedKdsEvent(io, {
            tenantId,
            branchId,
            station: 'ALL',
            eventType: 'MENU_86_UPDATED',
            socketEvents: ['menu:86_updated'],
            payload: result,
            includeExpo: true,
            includeWaiter: true,
            includePos: true,
            includeQr: true,
        });
        for (const m of result.affectedProducts) {
            emitScopedKdsEvent(io, {
                tenantId,
                branchId,
                station: 'ALL',
                eventType: 'THUC_DON_THAY_DOI',
                socketEvents: ['THUC_DON_THAY_DOI'],
                payload: m,
                includeExpo: true,
                includeWaiter: true,
                includePos: true,
                includeQr: true,
            });
        }
        for (const t of result.affectedToppings) {
            emitScopedKdsEvent(io, {
                tenantId,
                branchId,
                station: 'ALL',
                eventType: 'TOPPING_THAY_DOI',
                socketEvents: ['TOPPING_THAY_DOI'],
                payload: t,
                includeExpo: true,
                includeWaiter: true,
                includePos: true,
                includeQr: true,
            });
        }

        const tongMon = result.affectedProducts.length;
        const tongTp = result.affectedToppings.length;
        res.json({
            message: tamHet
                ? `🚫 Đã khóa 86 theo "${result.tenNL}": tạm hết ${tongMon} món & ${tongTp} topping!`
                : `✅ Đã mở bán lại theo "${result.tenNL}": mở ${tongMon} món & ${tongTp} topping!`,
            ...result,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Khóa 86 theo nguyên liệu:');
    }
});


// [P0] Lấy công thức định lượng theo Size kèm giá vốn hiện tại (cô lập TenantId)
app.get('/api/congthuc/:maMon', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const rows = await pool.withTenant(tenantId, async (client) => {
            const own = await client.query(
                "SELECT 1 FROM SanPham WHERE MaMon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
                [req.params.maMon, tenantId]
            );
            if (own.rows.length === 0) return null;
            const r = await client.query(
                `SELECT ct.MaMon, ct.KichThuoc, ct.MaNL, nl.TenNL, nl.DonViTinh,
                        ct.KhoiLuongTieuHao, COALESCE(nl.GiaVonDonVi, 0) AS GiaVonDonVi
                   FROM CongThuc ct
                   JOIN NguyenLieu nl ON nl.MaNL = ct.MaNL
                  WHERE ct.MaMon = $1
                  ORDER BY ct.KichThuoc, nl.TenNL`,
                [req.params.maMon]
            );
            return r.rows;
        });
        if (!rows) return res.status(404).json({ message: 'Không tìm thấy món!' });
        const theoSize = { S: [], M: [], L: [] };
        for (const row of rows) {
            if (!theoSize[row.kichthuoc]) theoSize[row.kichthuoc] = [];
            theoSize[row.kichthuoc].push({
                maNL: row.manl,
                tenNL: row.tennl,
                donViTinh: row.donvitinh,
                khoiLuongTieuHao: Number(row.khoiluongtieuhao),
                giaVonDonVi: Number(row.giavondonvi),
            });
        }
        res.json({ maMon: req.params.maMon, congThuc: theoSize });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lấy công thức:');
    }
});


    return {
        tinhDongCanDoiKho,
        checkExpiringBatchesAndEmitKds,
    };
}

module.exports = { registerInventoryDomain };
