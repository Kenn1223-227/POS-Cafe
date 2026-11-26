'use strict';

const {
    TRAM_CHE_BIEN_HOP_LE,
    suyLuanTramCheBien,
    LoiNghiepVu,
    guiLoi,
    choPhepVaiTro,
    layTenantId,
} = require('../../core/auditAndSecurity');
const {
    emitToTenant,
} = require('../../core/socketRooms');
const {
    normalizeBranchId,
    roomBranchPos,
    emitScopedKdsEvent,
    loadBranchAvailability86Map,
} = require('../../../modules/kdsPhase2Engine');
const {
    layBanDoGiamGiaLoBanhHomNay,
} = require('../../../modules/ecosystemPhase8Routes');

function registerMenuDomain(app, deps) {
    const {
        pool,
        io,
        chayGiaoDich,
        qTenant,
        kiemTraToken,
        yeuCauTinhNang,
        ghiAuditLog,
    } = deps;

app.get('/api/sanpham', kiemTraToken, async (req, res) => {
    const tenantId = layTenantId(req);
    const branchId = normalizeBranchId(req.query.branchId || req.headers['x-branch-id'] || req.user?.branchId || 'DEFAULT');
    try {
        const { rows, bakeryMap, regionalPriceMap, modGroupsByMon, branch86 } = await pool.withTenant(tenantId, async (client) => {
            const spRes = await client.query(`
                SELECT sp.MaMon, sp.TenMon, sp.NhomMon, COALESCE(sp.TamHet, FALSE) AS TamHet,
                       to_jsonb(sp)->>'tramchebien' AS TramCheBien,
                       COALESCE((to_jsonb(sp)->>'lamonthoigia')::boolean, FALSE) AS LaMonThoiGia,
                       COALESCE(to_jsonb(sp)->>'donvibanhang', 'LY') AS DonViBanHang,
                       (to_jsonb(sp)->>'soluonggioihan86')::int AS SoLuongGioiHan86,
                       COALESCE((to_jsonb(sp)->>'tamhettudong')::boolean, FALSE) AS TamHetTuDong,
                       COALESCE((to_jsonb(sp)->>'lahangdonggoi')::boolean, FALSE) AS LaHangDongGoi,
                       COALESCE((to_jsonb(sp)->>'intemcoc')::boolean, TRUE) AS InTemCoc,
                       COALESCE(to_jsonb(sp)->>'tax_category_code', 'VAT_8_FB') AS TaxCategoryCode,
                       sz.KichThuoc, sz.GiaBan
                FROM SanPham sp
                JOIN SanPham_Size sz ON sp.MaMon = sz.MaMon
                WHERE sp.DangKinhDoanh = TRUE AND COALESCE(sp.TenantId, 'DEFAULT') = $1
                ORDER BY sp.NhomMon, sp.TenMon, sz.GiaBan
            `, [tenantId]);
            const bMap = await layBanDoGiamGiaLoBanhHomNay(client, tenantId);
            const b86 = await loadBranchAvailability86Map(client, tenantId, branchId);

            // Giá vùng theo Chi nhánh (SanPham_GiaVung)
            const rpMap = new Map();
            if (branchId) {
                await client.query('SAVEPOINT sp_sp_giavung');
                try {
                    const brRes = await client.query(
                        `SELECT khuvucgia FROM chinhanh WHERE tenantid = $1 AND branchid = $2 LIMIT 1`,
                        [tenantId, branchId]
                    );
                    const kvg = brRes.rows[0]?.khuvucgia;
                    if (kvg && kvg !== 'DEFAULT') {
                        const gvRes = await client.query(
                            `SELECT mamon, kichthuoc, giaban FROM sanpham_giavung WHERE tenantid = $1 AND khuvucgia = $2`,
                            [tenantId, kvg]
                        );
                        for (const gv of gvRes.rows) {
                            rpMap.set(`${gv.mamon}|${gv.kichthuoc}`, Number(gv.giaban));
                        }
                    }
                    await client.query('RELEASE SAVEPOINT sp_sp_giavung');
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_sp_giavung').catch(() => {});
                }
            }

            // Modifiers gắn theo từng món (Forced Modifiers + Smart Defaults)
            const mgByMon = new Map();
            await client.query('SAVEPOINT sp_sp_mods');
            try {
                const linkRes = await client.query(
                    `SELECT smg.mamon, mg.id, mg.tengroup, mg.loai, mg.batbuoc,
                            mg.chontoithieu, mg.chontoida, mg.soluongmienphi, smg.thutuhienthi
                       FROM sanpham_modifier_groups smg
                       JOIN modifier_groups mg ON mg.id = smg.groupid
                      WHERE smg.tenantid = $1 AND mg.danghoatdong = TRUE
                      ORDER BY smg.mamon, smg.thutuhienthi ASC, mg.thutuhienthi ASC`,
                    [tenantId]
                );
                if (linkRes.rows.length > 0) {
                    const gIds = [...new Set(linkRes.rows.map((r) => Number(r.id)))];
                    const optRes = await client.query(
                        `SELECT id, groupid, tenoption, teninngan, lamacdinh, giacongthem, toidasoluong, tamhet, thutuhienthi
                           FROM modifier_options
                          WHERE tenantid = $1 AND groupid = ANY($2::bigint[])
                          ORDER BY thutuhienthi ASC, id ASC`,
                        [tenantId, gIds]
                    );
                    const optsByG = new Map();
                    for (const o of optRes.rows) {
                        const gid = Number(o.groupid);
                        if (!optsByG.has(gid)) optsByG.set(gid, []);
                        optsByG.get(gid).push({
                            id: Number(o.id),
                            groupId: gid,
                            tenOption: o.tenoption,
                            tenInNgan: o.teninngan || o.tenoption,
                            laMacDinh: Boolean(o.lamacdinh),
                            giaCongThem: Number(o.giacongthem || 0),
                            toiDaSoLuong: Number(o.toidasoluong || 1),
                            tamHet: Boolean(o.tamhet),
                        });
                    }
                    for (const r of linkRes.rows) {
                        if (!mgByMon.has(r.mamon)) mgByMon.set(r.mamon, []);
                        mgByMon.get(r.mamon).push({
                            id: Number(r.id),
                            tenGroup: r.tengroup,
                            loai: r.loai,
                            batBuoc: Boolean(r.batbuoc),
                            chonToiThieu: Number(r.chontoithieu || 0),
                            chonToiDa: Number(r.chontoida || 1),
                            soLuongMienPhi: Number(r.soluongmienphi || 0),
                            options: optsByG.get(Number(r.id)) || [],
                        });
                    }
                }
                await client.query('RELEASE SAVEPOINT sp_sp_mods');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_sp_mods').catch(() => {});
            }

            return { rows: spRes.rows, bakeryMap: bMap, regionalPriceMap: rpMap, modGroupsByMon: mgByMon, branch86: b86 };
        });

        const menu = [];
        const map = new Map();
        rows.forEach(row => {
            const md = bakeryMap.get(row.mamon);
            const bProd = branch86?.products?.get(String(row.mamon));
            if (!map.has(row.mamon)) {
                const modGroups = (modGroupsByMon.get(row.mamon) || []).map((g) => ({
                    ...g,
                    options: (g.options || []).map((o) => {
                        const bMod = branch86?.modifiers?.get(String(o.id));
                        return bMod ? { ...o, tamHet: Boolean(bMod.isSoldOut) } : o;
                    }),
                }));
                const newItem = {
                    maMon: row.mamon,
                    tenMon: row.tenmon,
                    nhomMon: row.nhommon,
                    tramCheBien: suyLuanTramCheBien({
                        tramCheBien: row.tramchebien,
                        nhomMon: row.nhommon,
                        tenMon: row.tenmon,
                    }),
                    tamHet: bProd !== undefined ? Boolean(bProd.isSoldOut) : Boolean(row.tamhet),
                    soLuongGioiHan86:
                        bProd && bProd.dailyRemainingQty !== null
                            ? bProd.dailyRemainingQty
                            : row.soluonggioihan86 !== null && row.soluonggioihan86 !== undefined
                              ? Number(row.soluonggioihan86)
                              : null,
                    tamHetTuDong: bProd !== undefined ? Boolean(bProd.isAutoCascaded) : Boolean(row.tamhettudong),
                    laHangDongGoi: Boolean(row.lahangdonggoi),
                    inTemCoc: row.intemcoc !== false,
                    laMonThoiGia: Boolean(row.lamonthoigia),
                    donViBanHang: row.donvibanhang || 'LY',
                    taxCategoryCode: row.taxcategorycode || 'VAT_8_FB',
                    modifierGroups: modGroups,
                    bakeryMarkdown: md?.dangGiamGia
                        ? {
                              phanTramGiam: md.phanTramGiam,
                              gioGiamGia: md.gioGiamGia,
                              soLuongConLai: md.soLuongConLai,
                              giaSauGiam: md.giaHienTai,
                          }
                        : null,
                    sizes: [],
                };
                map.set(row.mamon, newItem);
                menu.push(newItem);
            }
            const regionalPrice = regionalPriceMap.get(`${row.mamon}|${row.kichthuoc}`);
            const giaGoc = regionalPrice !== undefined ? regionalPrice : parseFloat(row.giaban);
            const giaHienTai = md?.dangGiamGia
                ? Math.round((giaGoc * (100 - md.phanTramGiam)) / 100 / 500) * 500
                : giaGoc;
            map.get(row.mamon).sizes.push({ kichThuoc: row.kichthuoc, giaBan: giaHienTai, giaGoc });
        });
        res.json(menu);
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lấy Thực đơn:');
    }
});


// [Wave 3A — P1-03] Khóa/Mở nhanh món tạm hết (86'ing) cô lập theo Chi nhánh trong branch_availability_86
app.put('/api/sanpham/:maMon/tamhet', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
    const { maMon } = req.params;
    const tamHet = Boolean(req.body?.tamHet);
    const tenantId = layTenantId(req);
    const branchId = normalizeBranchId(req.body?.branchId || req.headers['x-branch-id'] || req.user?.branchId || 'DEFAULT');
    try {
        const mon = await pool.withTenant(tenantId, async (client) => {
            const r = await client.query(
                `SELECT MaMon, TenMon FROM SanPham WHERE MaMon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
                [maMon, tenantId]
            );
            if (r.rows.length === 0) return null;
            const row = r.rows[0];
            await client.query(
                `INSERT INTO public.branch_availability_86
                    (tenant_id, branch_id, entity_type, entity_id, is_sold_out, is_auto_cascaded, caused_by_ingredients, updated_by, updated_at)
                 VALUES ($1, $2, 'PRODUCT', $3, $4, FALSE, '{}'::text[], $5, now())
                 ON CONFLICT (tenant_id, branch_id, entity_type, entity_id) DO UPDATE
                     SET is_sold_out = EXCLUDED.is_sold_out,
                         is_auto_cascaded = FALSE,
                         caused_by_ingredients = CASE WHEN EXCLUDED.is_sold_out = FALSE THEN '{}'::text[] ELSE public.branch_availability_86.caused_by_ingredients END,
                         updated_by = EXCLUDED.updated_by,
                         updated_at = now()`,
                [tenantId, branchId, maMon, tamHet, req.user.maNV]
            );
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'MENU_86_TOGGLE',
                doiTuong: 'SANPHAM',
                maDoiTuong: maMon,
                giaTriMoi: { tenMon: row.tenmon, branchId, tamHet },
                ip: req.ip,
            });
            return { ...row, tamhet: tamHet };
        });
        if (!mon) return res.status(404).json({ message: 'Không tìm thấy món này!' });

        const payload = {
            branchId,
            maMon: mon.mamon,
            tenMon: mon.tenmon,
            tamHet: Boolean(mon.tamhet),
            affectedProducts: [{ maMon: mon.mamon, tenMon: mon.tenmon, branchId, tamHet: Boolean(mon.tamhet) }],
        };
        emitScopedKdsEvent(io, {
            tenantId,
            branchId,
            station: 'ALL',
            eventType: 'MENU_86_UPDATED',
            socketEvents: ['menu:86_updated', 'THUC_DON_THAY_DOI'],
            payload,
            includeExpo: true,
            includeWaiter: true,
            includePos: true,
            includeQr: true,
        });

        res.json({
            message: tamHet ? `Đã báo TẠM HẾT món "${mon.tenmon}" tại chi nhánh ${branchId}!` : `Đã mở bán lại món "${mon.tenmon}" tại chi nhánh ${branchId}!`,
            branchId,
            maMon: mon.mamon,
            tamHet: Boolean(mon.tamhet),
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Báo tạm hết món:');
    }
});

// [Wave 3A — P1-03] Khóa/Mở nhanh Topping tạm hết cô lập theo Chi nhánh
app.put('/api/topping/:maTopping/tamhet', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
    const { maTopping } = req.params;
    const tamHet = Boolean(req.body?.tamHet);
    const tenantId = layTenantId(req);
    const branchId = normalizeBranchId(req.body?.branchId || req.headers['x-branch-id'] || req.user?.branchId || 'DEFAULT');
    try {
        const tp = await pool.withTenant(tenantId, async (client) => {
            const r = await client.query(
                "SELECT MaTopping, TenTopping FROM Topping WHERE MaTopping = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
                [maTopping, tenantId]
            );
            if (r.rows.length === 0) return null;
            const row = r.rows[0];
            await client.query(
                `INSERT INTO public.branch_availability_86
                    (tenant_id, branch_id, entity_type, entity_id, is_sold_out, is_auto_cascaded, caused_by_ingredients, updated_by, updated_at)
                 VALUES ($1, $2, 'TOPPING', $3, $4, FALSE, '{}'::text[], $5, now())
                 ON CONFLICT (tenant_id, branch_id, entity_type, entity_id) DO UPDATE
                     SET is_sold_out = EXCLUDED.is_sold_out,
                         is_auto_cascaded = FALSE,
                         updated_by = EXCLUDED.updated_by,
                         updated_at = now()`,
                [tenantId, branchId, maTopping, tamHet, req.user.maNV]
            );
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'TOPPING_86_TOGGLE',
                doiTuong: 'TOPPING',
                maDoiTuong: maTopping,
                giaTriMoi: { tenTopping: row.tentopping, branchId, tamHet },
                ip: req.ip,
            });
            return { ...row, tamhet: tamHet };
        });
        if (!tp) return res.status(404).json({ message: 'Không tìm thấy topping này!' });

        const payload = {
            branchId,
            maTopping: tp.matopping,
            tenTopping: tp.tentopping,
            tamHet: Boolean(tp.tamhet),
            affectedToppings: [{ maTopping: tp.matopping, tenTopping: tp.tentopping, branchId, tamHet: Boolean(tp.tamhet) }],
        };
        emitScopedKdsEvent(io, {
            tenantId,
            branchId,
            station: 'ALL',
            eventType: 'MENU_86_UPDATED',
            socketEvents: ['menu:86_updated', 'TOPPING_THAY_DOI'],
            payload,
            includeExpo: true,
            includeWaiter: true,
            includePos: true,
            includeQr: true,
        });

        res.json({
            message: tamHet ? `Đã báo TẠM HẾT topping "${tp.tentopping}" tại chi nhánh ${branchId}!` : `Đã mở lại topping "${tp.tentopping}" tại chi nhánh ${branchId}!`,
            branchId,
            maTopping: tp.matopping,
            tamHet: Boolean(tp.tamhet),
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Báo tạm hết topping:');
    }
});


app.get('/api/topping', kiemTraToken, async (req, res) => {
    const tenantId = layTenantId(req);
    const branchId = normalizeBranchId(req.query.branchId || req.headers['x-branch-id'] || req.user?.branchId || 'DEFAULT');
    try {
        const { rows, branch86 } = await pool.withTenant(tenantId, async (client) => {
            const tpRes = await client.query(
                `SELECT MaTopping, TenTopping, GiaTopping, COALESCE(TamHet, FALSE) AS TamHet,
                        COALESCE((to_jsonb(Topping)->>'toidamoily')::int, 3) AS ToiDaMoiLy,
                        to_jsonb(Topping)->'giabacthang' AS GiaBacThang
                   FROM Topping
                  WHERE DangKinhDoanh = TRUE AND COALESCE(TenantId, 'DEFAULT') = $1
                  ORDER BY TenTopping`,
                [tenantId]
            );
            const b86 = await loadBranchAvailability86Map(client, tenantId, branchId);
            return { rows: tpRes.rows, branch86: b86 };
        });
        res.json(rows.map((r) => {
            const bTp = branch86?.toppings?.get(String(r.matopping));
            return {
                maTopping: r.matopping,
                tenTopping: r.tentopping,
                giaTopping: Number(r.giatopping),
                tamHet: bTp !== undefined ? Boolean(bTp.isSoldOut) : Boolean(r.tamhet),
                tamHetTuDong: bTp !== undefined ? Boolean(bTp.isAutoCascaded) : false,
                branchId,
                toiDaMoiLy: Number(r.toidamoily || 3),
                giaBacThang: Array.isArray(r.giabacthang) ? r.giabacthang : null,
            };
        }));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Topping:');
    }
});


// [P1 - Topping BOM] Quản lý danh sách Topping kèm Công thức đa nguyên liệu & Giá vốn
app.get('/api/topping/quanly', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const { tpRes, bomRes } = await pool.withTenant(tenantId, async (client) => {
            const tpR = await client.query(
                `SELECT tp.MaTopping, tp.TenTopping, tp.GiaTopping, tp.MaNL, tp.KhoiLuongTieuHao,
                        tp.DangKinhDoanh, COALESCE(tp.TamHet, FALSE) AS TamHet,
                        nl.TenNL AS LegacyTenNL, nl.DonViTinh AS LegacyDVT, COALESCE(nl.GiaVonDonVi, 0) AS LegacyGiaVon
                   FROM Topping tp
                   LEFT JOIN NguyenLieu nl ON nl.MaNL = tp.MaNL
                  WHERE COALESCE(tp.TenantId, 'DEFAULT') = $1
                  ORDER BY tp.TenTopping`,
                [tenantId]
            );
            let bomR = { rows: [] };
            try {
                await client.query('SAVEPOINT sp_tp_bom_list');
                bomR = await client.query(
                    `SELECT tc.MaTopping, tc.MaNL, nl.TenNL, nl.DonViTinh,
                            tc.KhoiLuongTieuHao, COALESCE(nl.GiaVonDonVi, 0) AS GiaVonDonVi
                       FROM Topping_CongThuc tc
                       JOIN NguyenLieu nl ON nl.MaNL = tc.MaNL
                      WHERE tc.TenantId = $1
                      ORDER BY nl.TenNL`,
                    [tenantId]
                );
                await client.query('RELEASE SAVEPOINT sp_tp_bom_list');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_tp_bom_list').catch(() => {});
            }
            return { tpRes: tpR, bomRes: bomR };
        });

        const bomMap = new Map();
        for (const r of bomRes.rows) {
            if (!bomMap.has(r.matopping)) bomMap.set(r.matopping, []);
            bomMap.get(r.matopping).push({
                maNL: r.manl,
                tenNL: r.tennl,
                donViTinh: r.donvitinh,
                khoiLuongTieuHao: Number(r.khoiluongtieuhao),
                giaVonDonVi: Number(r.giavondonvi),
            });
        }

        res.json(tpRes.rows.map((row) => {
            let congThuc = bomMap.get(row.matopping) || [];
            if (congThuc.length === 0 && row.manl && Number(row.khoiluongtieuhao) > 0) {
                congThuc = [{
                    maNL: row.manl,
                    tenNL: row.legacytennl || row.manl,
                    donViTinh: row.legacydvt || '',
                    khoiLuongTieuHao: Number(row.khoiluongtieuhao),
                    giaVonDonVi: Number(row.legacygiavon || 0),
                }];
            }
            const giaVon = Math.round(congThuc.reduce((s, c) => s + c.khoiLuongTieuHao * c.giaVonDonVi, 0));
            const giaBan = Number(row.giatopping || 0);
            const tySuat = giaBan > 0 ? Math.round(((giaBan - giaVon) / giaBan) * 1000) / 10 : 0;
            return {
                maTopping: row.matopping,
                tenTopping: row.tentopping,
                giaTopping: giaBan,
                dangKinhDoanh: row.dangkinhdoanh !== false,
                tamHet: Boolean(row.tamhet),
                giaVon,
                tySuatLoiNhuan: tySuat,
                congThuc,
            };
        }));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Quản lý Topping:');
    }
});

app.post('/api/topping', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    const {
        maTopping,
        tenTopping,
        giaTopping,
        maNL = null,
        khoiLuongTieuHao = 0,
        toiDaMoiLy = 3,
        giaBacThang = null,
    } = req.body || {};
    const prefix = req.user.maTienTo && tenantId !== 'DEFAULT' ? `${req.user.maTienTo}_` : '';
    const rawMa = String(maTopping || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const ma = rawMa.startsWith(prefix) ? rawMa : `${prefix}${rawMa}`;
    const ten = String(tenTopping || '').trim();
    const gia = Math.max(0, Number(giaTopping) || 0);
    if (!rawMa || ten.length < 2) {
        return res.status(400).json({ message: 'Vui lòng nhập mã topping và tên topping hợp lệ!' });
    }
    try {
        await qTenant(
            req,
            `INSERT INTO Topping (MaTopping, TenTopping, GiaTopping, MaNL, KhoiLuongTieuHao, DangKinhDoanh, TamHet, TenantId, ToiDaMoiLy, GiaBacThang)
             VALUES ($1, $2, $3, $4, $5, TRUE, FALSE, $6, $7, $8::jsonb)`,
            [
                ma,
                ten,
                gia,
                maNL ? String(maNL).trim() : null,
                Math.max(0, Number(khoiLuongTieuHao) || 0),
                tenantId,
                Math.max(1, Math.floor(Number(toiDaMoiLy || 3))),
                Array.isArray(giaBacThang) ? JSON.stringify(giaBacThang) : null,
            ]
        );
        emitToTenant(io, {
            tenantId,
            roles: ['POS', 'WAITER', 'KDS'],
            event: 'TOPPING_THAY_DOI',
            payload: {
                maTopping: ma,
                tenTopping: ten,
                tamHet: false,
            },
        });
        res.status(201).json({ message: `Đã thêm topping "${ten}" thành công!`, maTopping: ma });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `Mã topping ${ma} đã tồn tại!` });
        guiLoi(res, error, 'Lỗi API Thêm Topping:');
    }
});

app.post('/api/topping/:maTopping/congthuc', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('inventory_bom'), async (req, res) => {
    const tenantId = layTenantId(req);
    const { maTopping } = req.params;
    const { dinhMuc = [] } = req.body || {};
    if (!Array.isArray(dinhMuc)) {
        return res.status(400).json({ message: 'dinhMuc phải là danh sách nguyên liệu!' });
    }
    try {
        await chayGiaoDich(async (client) => {
            const ownTp = await client.query(
                "SELECT MaTopping, TenTopping FROM Topping WHERE MaTopping = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
                [maTopping, tenantId]
            );
            if (ownTp.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy topping thuộc quán này!');

            const validRows = dinhMuc.filter((d) => d && d.maNL && Number(d.khoiLuongTieuHao) > 0);
            if (validRows.length > 0) {
                const nlIds = [...new Set(validRows.map((d) => d.maNL))];
                const ownNl = await client.query(
                    "SELECT MaNL FROM NguyenLieu WHERE MaNL = ANY($1::varchar[]) AND COALESCE(TenantId, 'DEFAULT') = $2",
                    [nlIds, tenantId]
                );
                if (ownNl.rows.length !== nlIds.length) {
                    throw new LoiNghiepVu(400, 'Có nguyên liệu không thuộc quán hiện tại!');
                }
            }

            await client.query('DELETE FROM Topping_CongThuc WHERE TenantId = $1 AND MaTopping = $2', [tenantId, maTopping]);
            for (const row of validRows) {
                await client.query(
                    `INSERT INTO Topping_CongThuc (TenantId, MaTopping, MaNL, KhoiLuongTieuHao)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (TenantId, MaTopping, MaNL)
                     DO UPDATE SET KhoiLuongTieuHao = EXCLUDED.KhoiLuongTieuHao`,
                    [tenantId, maTopping, row.maNL, Number(row.khoiLuongTieuHao)]
                );
            }

            // Đồng bộ luôn nguyên liệu đầu tiên vào cột legacy để tương thích hoàn toàn
            const first = validRows[0] || null;
            await client.query(
                'UPDATE Topping SET MaNL = $2, KhoiLuongTieuHao = $3 WHERE MaTopping = $1',
                [maTopping, first ? first.maNL : null, first ? Number(first.khoiLuongTieuHao) : 0]
            );

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'TOPPING_BOM_UPDATED',
                doiTuong: 'TOPPING',
                maDoiTuong: maTopping,
                giaTriMoi: validRows,
                ip: req.ip,
                batBuoc: true,
            });
        }, tenantId);

        res.json({ message: `Đã lưu định lượng BOM cho topping ${maTopping}!` });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lưu công thức Topping:');
    }
});


app.post('/api/sanpham', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const {
        maMon,
        tenMon,
        nhomMon,
        giaGoc,
        sizes,
        tramCheBien,
        laHangDongGoi = false,
        inTemCoc = true,
        laMonThoiGia = false,
        donViBanHang = 'LY',
        soLuongGioiHan86 = null,
    } = req.body || {};
    const tenantId = layTenantId(req);
    const prefix = req.user.maTienTo && tenantId !== 'DEFAULT' ? `${req.user.maTienTo}_` : '';
    if (!maMon || !tenMon || !nhomMon || !Array.isArray(sizes) || sizes.length === 0) {
        return res.status(400).json({ message: 'Vui lòng cung cấp đủ thông tin sản phẩm và sizes!' });
    }
    const rawMa = String(maMon).trim().toUpperCase();
    const maFinal = rawMa.startsWith(prefix) ? rawMa : `${prefix}${rawMa}`;
    const tramFinal = suyLuanTramCheBien({ tramCheBien, nhomMon, tenMon });
    const cdVal =
        soLuongGioiHan86 === null || soLuongGioiHan86 === undefined || soLuongGioiHan86 === ''
            ? null
            : Math.max(0, Math.floor(Number(soLuongGioiHan86)));

    try {
        await chayGiaoDich(async (client) => {
            await client.query('SAVEPOINT sp_ins_sp_tram');
            try {
                await client.query(
                    `INSERT INTO SanPham
                        (MaMon, TenMon, NhomMon, GiaGoc, DangKinhDoanh, TenantId, TramCheBien,
                         LaHangDongGoi, InTemCoc, LaMonThoiGia, DonViBanHang, SoLuongGioiHan86)
                     VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8, $9, $10, $11)`,
                    [
                        maFinal,
                        tenMon,
                        nhomMon,
                        giaGoc || 0,
                        tenantId,
                        tramFinal,
                        Boolean(laHangDongGoi),
                        inTemCoc !== false,
                        Boolean(laMonThoiGia),
                        String(donViBanHang || 'LY').toUpperCase(),
                        cdVal,
                    ]
                );
                await client.query('RELEASE SAVEPOINT sp_ins_sp_tram');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_ins_sp_tram').catch(() => {});
                await client.query(
                    'INSERT INTO SanPham (MaMon, TenMon, NhomMon, GiaGoc, DangKinhDoanh, TenantId) VALUES ($1, $2, $3, $4, TRUE, $5)',
                    [maFinal, tenMon, nhomMon, giaGoc || 0, tenantId]
                );
            }
            for (const sz of sizes) {
                await client.query('INSERT INTO SanPham_Size (MaMon, KichThuoc, GiaBan) VALUES ($1, $2, $3)', [maFinal, sz.kichThuoc, sz.giaBan]);
            }
        }, tenantId);
        res.json({ message: 'Thêm món mới thành công!', maMon: maFinal, tramCheBien: tramFinal });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Thêm món:');
    }
});

app.put('/api/sanpham/:maMon', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const tenantId = layTenantId(req);

    const { maMon } = req.params;
    const { tenMon, nhomMon, giaGoc, sizes, tramCheBien } = req.body;
    const tramFinal = suyLuanTramCheBien({ tramCheBien, nhomMon, tenMon });

    try {
        await chayGiaoDich(async (client) => {
            const oldSizes = await client.query('SELECT KichThuoc, GiaBan FROM SanPham_Size WHERE MaMon = $1', [maMon]);
            let updateSP;
            await client.query('SAVEPOINT sp_upd_sp_tram');
            try {
                updateSP = await client.query(
                    "UPDATE SanPham SET TenMon = $1, NhomMon = $2, GiaGoc = $3, TramCheBien = $6, DangKinhDoanh = TRUE WHERE MaMon = $4 AND COALESCE(TenantId, 'DEFAULT') = $5 RETURNING MaMon",
                    [tenMon, nhomMon, giaGoc || 0, maMon, tenantId, tramFinal]
                );
                await client.query('RELEASE SAVEPOINT sp_upd_sp_tram');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_upd_sp_tram').catch(() => {});
                updateSP = await client.query(
                    "UPDATE SanPham SET TenMon = $1, NhomMon = $2, GiaGoc = $3, DangKinhDoanh = TRUE WHERE MaMon = $4 AND COALESCE(TenantId, 'DEFAULT') = $5 RETURNING MaMon",
                    [tenMon, nhomMon, giaGoc || 0, maMon, tenantId]
                );
            }
            if (updateSP.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy mã món cần sửa!');

            await client.query('DELETE FROM SanPham_Size WHERE MaMon = $1', [maMon]);
            for (const sz of sizes) {
                await client.query('INSERT INTO SanPham_Size (MaMon, KichThuoc, GiaBan) VALUES ($1, $2, $3)', [maMon, sz.kichThuoc, sz.giaBan]);
            }

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'PRICE_UPDATED',
                doiTuong: 'SANPHAM',
                maDoiTuong: maMon,
                giaTriCu: { sizes: oldSizes.rows },
                giaTriMoi: { tenMon, nhomMon, tramCheBien: tramFinal, sizes },
                ip: req.ip,
                batBuoc: true,
            });
        }, tenantId);
        res.json({ message: 'Cập nhật thông tin món thành công!', maMon, tramCheBien: tramFinal });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Sửa món:');
    }
});

app.delete('/api/sanpham/:maMon', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { maMon } = req.params;
    const tenantId = layTenantId(req);
    try {
        const deleted = await pool.withTenant(tenantId, async (client) => {
            const result = await client.query(
                "UPDATE SanPham SET DangKinhDoanh = FALSE WHERE MaMon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2 RETURNING MaMon, TenMon",
                [maMon, tenantId]
            );
            if (result.rows.length === 0) return null;
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'PRODUCT_DELETED',
                doiTuong: 'SANPHAM',
                maDoiTuong: maMon,
                giaTriCu: { tenMon: result.rows[0].tenmon },
                ip: req.ip,
            });
            return result.rows[0];
        });
        if (!deleted) return res.status(404).json({ message: 'Không tìm thấy mã món này!' });
        res.json({ message: `Đã ngừng kinh doanh món ${maMon} thành công!` });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Xóa món:');
    }
});


// Thực đơn dành cho Quản lý: gồm cả món đã ngừng kinh doanh & trạng thái tạm hết (86) — cô lập TenantId
app.get('/api/sanpham/quanly', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const r = await qTenant(
            req,
            `SELECT sp.MaMon, sp.TenMon, sp.NhomMon, sp.GiaGoc, sp.DangKinhDoanh,
                    to_jsonb(sp)->>'tramchebien' AS TramCheBien,
                    COALESCE(sp.TamHet, FALSE) AS TamHet, sz.KichThuoc, sz.GiaBan
               FROM SanPham sp LEFT JOIN SanPham_Size sz ON sz.MaMon = sp.MaMon
              WHERE COALESCE(sp.TenantId, 'DEFAULT') = $1
              ORDER BY sp.NhomMon, sp.TenMon, sz.GiaBan`,
            [tenantId]
        );
        const ds = [];
        const map = new Map();
        for (const row of r.rows) {
            if (!map.has(row.mamon)) {
                const item = {
                    maMon: row.mamon,
                    tenMon: row.tenmon,
                    nhomMon: row.nhommon,
                    tramCheBien: suyLuanTramCheBien({
                        tramCheBien: row.tramchebien,
                        nhomMon: row.nhommon,
                        tenMon: row.tenmon,
                    }),
                    giaGoc: Number(row.giagoc),
                    dangKinhDoanh: row.dangkinhdoanh,
                    tamHet: Boolean(row.tamhet),
                    sizes: [],
                };
                map.set(row.mamon, item);
                ds.push(item);
            }
            if (row.kichthuoc) map.get(row.mamon).sizes.push({ kichThuoc: row.kichthuoc, giaBan: Number(row.giaban) });
        }
        res.json(ds);
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Thực đơn quản lý:');
    }
});

}

module.exports = { registerMenuDomain };
