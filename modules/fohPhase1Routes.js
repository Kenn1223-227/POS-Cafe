const crypto = require('crypto');
const {
    kiemTraVaTangVersionHoaDon,
    recalculateInvoiceTotals,
    capSoThuTuNgayKhongTrung,
} = require('./fohEngineService');
const { emitScopedKdsEvent, normalizeBranchId } = require('./kdsPhase2Engine');
const { emitToBranch, emitToTenant } = require('../src/core/socketRooms');

function layGioHienTaiHHMMVN() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(new Date());
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    const hh = map.hour === '24' ? '00' : map.hour;
    return `${hh}:${map.minute}`;
}

function namTrongKhungGio(hhmm, tu, den) {
    if (!tu || !den) return true;
    if (tu <= den) return hhmm >= tu && hhmm <= den;
    return hhmm >= tu || hhmm <= den;
}

function registerFohPhase1Routes(app, deps) {
    const {
        pool,
        chayGiaoDich,
        qTenant,
        layTenantId,
        kiemTraToken,
        choPhepVaiTro,
        coQuyenHan = null,
        xacThucPinQuanLy = null,
        ghiAuditLog,
        guiLoi,
        LoiNghiepVu,
        io,
        roomTen,
        layHoaDonChiTiet,
        layHoaDonMoCuaBan,
        layMonTheoMa,
        xoayQrTokenChoCacBan,
        kiemTraHopLeKhuyenMai,
        paymentsSanSangRef,
        handleSplitOrder,
    } = deps;

    // =========================================================================
    // 1. MODIFIERS CÓ CẤU TRÚC & SUBSTITUTION BOM CRUD
    // =========================================================================
    app.get('/api/modifiers/groups', kiemTraToken, async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const data = await pool.withTenant(tenantId, async (client) => {
                const gRes = await client.query(
                    `SELECT id, tengroup, loai, batbuoc, chontoithieu, chontoida,
                            soluongmienphi, thutuhienthi, danghoatdong
                       FROM modifier_groups
                      WHERE tenantid = $1
                      ORDER BY thutuhienthi ASC, id ASC`,
                    [tenantId]
                );
                const oRes = await client.query(
                    `SELECT id, groupid, tenoption, teninngan, lamacdinh, giacongthem,
                            toidasoluong, tamhet, thutuhienthi
                       FROM modifier_options
                      WHERE tenantid = $1
                      ORDER BY thutuhienthi ASC, id ASC`,
                    [tenantId]
                );
                const bRes = await client.query(
                    `SELECT b.id, b.optionid, b.kichthuoc, b.manl, b.khoiluongdelta,
                            nl.tennl, nl.donvitinh
                       FROM modifier_option_bom b
                       LEFT JOIN nguyenlieu nl ON nl.manl = b.manl
                      WHERE b.tenantid = $1
                      ORDER BY b.id ASC`,
                    [tenantId]
                );

                const bomByOpt = new Map();
                for (const b of bRes.rows) {
                    const oid = Number(b.optionid);
                    if (!bomByOpt.has(oid)) bomByOpt.set(oid, []);
                    bomByOpt.get(oid).push({
                        id: Number(b.id),
                        kichThuoc: b.kichthuoc || null,
                        maNL: b.manl,
                        tenNL: b.tennl || b.manl,
                        donViTinh: b.donvitinh || '',
                        khoiLuongDelta: Number(b.khoiluongdelta),
                    });
                }

                const optsByGroup = new Map();
                for (const o of oRes.rows) {
                    const gid = Number(o.groupid);
                    if (!optsByGroup.has(gid)) optsByGroup.set(gid, []);
                    optsByGroup.get(gid).push({
                        id: Number(o.id),
                        groupId: gid,
                        tenOption: o.tenoption,
                        tenInNgan: o.teninngan || o.tenoption,
                        laMacDinh: Boolean(o.lamacdinh),
                        giaCongThem: Number(o.giacongthem || 0),
                        toiDaSoLuong: Number(o.toidasoluong || 1),
                        tamHet: Boolean(o.tamhet),
                        thuTuHienThi: Number(o.thutuhienthi || 0),
                        bom: bomByOpt.get(Number(o.id)) || [],
                    });
                }

                return gRes.rows.map((g) => ({
                    id: Number(g.id),
                    tenGroup: g.tengroup,
                    loai: g.loai,
                    batBuoc: Boolean(g.batbuoc),
                    chonToiThieu: Number(g.chontoithieu || 0),
                    chonToiDa: Number(g.chontoida || 1),
                    soLuongMienPhi: Number(g.soluongmienphi || 0),
                    thuTuHienThi: Number(g.thutuhienthi || 0),
                    dangHoatDong: Boolean(g.danghoatdong),
                    options: optsByGroup.get(Number(g.id)) || [],
                }));
            });
            res.json(data);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Lấy danh sách Modifier Groups:');
        }
    });

    app.post('/api/modifiers/groups', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const {
            tenGroup,
            loai = 'SINGLE',
            batBuoc = false,
            chonToiThieu = 0,
            chonToiDa = 1,
            soLuongMienPhi = 0,
            thuTuHienThi = 0,
            options = [],
        } = req.body || {};

        if (!tenGroup || !String(tenGroup).trim()) {
            return res.status(400).json({ message: 'Vui lòng nhập tên nhóm Modifier (tenGroup)!' });
        }
        const loaiClean = String(loai).toUpperCase() === 'MULTI' ? 'MULTI' : 'SINGLE';

        try {
            const created = await chayGiaoDich(async (client) => {
                const gRes = await client.query(
                    `INSERT INTO modifier_groups
                        (tenantid, tengroup, loai, batbuoc, chontoithieu, chontoida, soluongmienphi, thutuhienthi)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     RETURNING id, tengroup, loai, batbuoc, chontoithieu, chontoida, soluongmienphi, thutuhienthi, danghoatdong`,
                    [
                        tenantId,
                        String(tenGroup).trim().slice(0, 80),
                        loaiClean,
                        Boolean(batBuoc),
                        Math.max(0, Math.floor(Number(chonToiThieu || 0))),
                        Math.max(1, Math.floor(Number(chonToiDa || 1))),
                        Math.max(0, Math.floor(Number(soLuongMienPhi || 0))),
                        Math.floor(Number(thuTuHienThi || 0)),
                    ]
                );
                const group = gRes.rows[0];
                const createdOptions = [];

                for (let idx = 0; idx < (Array.isArray(options) ? options.length : 0); idx += 1) {
                    const opt = options[idx];
                    if (!opt?.tenOption) continue;
                    const oRes = await client.query(
                        `INSERT INTO modifier_options
                            (tenantid, groupid, tenoption, teninngan, lamacdinh, giacongthem, toidasoluong, tamhet, thutuhienthi)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                         RETURNING id, groupid, tenoption, teninngan, lamacdinh, giacongthem, toidasoluong, tamhet, thutuhienthi`,
                        [
                            tenantId,
                            group.id,
                            String(opt.tenOption).trim().slice(0, 80),
                            opt.tenInNgan ? String(opt.tenInNgan).trim().slice(0, 24) : null,
                            Boolean(opt.laMacDinh),
                            Number(opt.giaCongThem || 0),
                            Math.max(1, Math.floor(Number(opt.toiDaSoLuong || 1))),
                            Boolean(opt.tamHet),
                            Math.floor(Number(opt.thuTuHienThi ?? idx)),
                        ]
                    );
                    const optRow = oRes.rows[0];
                    const bomCreated = [];
                    for (const b of Array.isArray(opt.bom) ? opt.bom : []) {
                        if (!b?.maNL || Number(b.khoiLuongDelta) === 0) continue;
                        const bIns = await client.query(
                            `INSERT INTO modifier_option_bom (tenantid, optionid, kichthuoc, manl, khoiluongdelta)
                             VALUES ($1, $2, $3, $4, $5)
                             RETURNING id, kichthuoc, manl, khoiluongdelta`,
                            [
                                tenantId,
                                optRow.id,
                                b.kichThuoc ? String(b.kichThuoc).trim().toUpperCase() : null,
                                String(b.maNL).trim(),
                                Number(b.khoiLuongDelta),
                            ]
                        );
                        bomCreated.push({
                            id: Number(bIns.rows[0].id),
                            kichThuoc: bIns.rows[0].kichthuoc,
                            maNL: bIns.rows[0].manl,
                            khoiLuongDelta: Number(bIns.rows[0].khoiluongdelta),
                        });
                    }
                    createdOptions.push({
                        id: Number(optRow.id),
                        groupId: Number(optRow.groupid),
                        tenOption: optRow.tenoption,
                        tenInNgan: optRow.teninngan || optRow.tenoption,
                        laMacDinh: Boolean(optRow.lamacdinh),
                        giaCongThem: Number(optRow.giacongthem || 0),
                        toiDaSoLuong: Number(optRow.toidasoluong || 1),
                        tamHet: Boolean(optRow.tamhet),
                        bom: bomCreated,
                    });
                }

                return {
                    id: Number(group.id),
                    tenGroup: group.tengroup,
                    loai: group.loai,
                    batBuoc: Boolean(group.batbuoc),
                    chonToiThieu: Number(group.chontoithieu),
                    chonToiDa: Number(group.chontoida),
                    soLuongMienPhi: Number(group.soluongmienphi),
                    thuTuHienThi: Number(group.thutuhienthi),
                    dangHoatDong: Boolean(group.danghoatdong),
                    options: createdOptions,
                };
            }, tenantId);

            res.status(201).json({ message: 'Tạo nhóm Modifier thành công!', group: created });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Tạo Modifier Group:');
        }
    });

    app.post('/api/modifiers/groups/:id/options', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const groupId = Number(req.params.id);
        const {
            tenOption,
            tenInNgan = null,
            laMacDinh = false,
            giaCongThem = 0,
            toiDaSoLuong = 1,
            tamHet = false,
            thuTuHienThi = 0,
            bom = [],
        } = req.body || {};

        if (!Number.isInteger(groupId) || groupId <= 0 || !tenOption) {
            return res.status(400).json({ message: 'Thiếu groupId hoặc tenOption!' });
        }

        try {
            const option = await chayGiaoDich(async (client) => {
                const g = await client.query(
                    `SELECT id FROM modifier_groups WHERE id = $1 AND tenantid = $2`,
                    [groupId, tenantId]
                );
                if (g.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy nhóm Modifier!');
                const oRes = await client.query(
                    `INSERT INTO modifier_options
                        (tenantid, groupid, tenoption, teninngan, lamacdinh, giacongthem, toidasoluong, tamhet, thutuhienthi)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                     RETURNING id, groupid, tenoption, teninngan, lamacdinh, giacongthem, toidasoluong, tamhet, thutuhienthi`,
                    [
                        tenantId,
                        groupId,
                        String(tenOption).trim().slice(0, 80),
                        tenInNgan ? String(tenInNgan).trim().slice(0, 24) : null,
                        Boolean(laMacDinh),
                        Number(giaCongThem || 0),
                        Math.max(1, Math.floor(Number(toiDaSoLuong || 1))),
                        Boolean(tamHet),
                        Math.floor(Number(thuTuHienThi || 0)),
                    ]
                );
                const row = oRes.rows[0];
                for (const b of Array.isArray(bom) ? bom : []) {
                    if (!b?.maNL || Number(b.khoiLuongDelta) === 0) continue;
                    await client.query(
                        `INSERT INTO modifier_option_bom (tenantid, optionid, kichthuoc, manl, khoiluongdelta)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [
                            tenantId,
                            row.id,
                            b.kichThuoc ? String(b.kichThuoc).trim().toUpperCase() : null,
                            String(b.maNL).trim(),
                            Number(b.khoiLuongDelta),
                        ]
                    );
                }
                return {
                    id: Number(row.id),
                    groupId: Number(row.groupid),
                    tenOption: row.tenoption,
                    tenInNgan: row.teninngan || row.tenoption,
                    laMacDinh: Boolean(row.lamacdinh),
                    giaCongThem: Number(row.giacongthem || 0),
                    toiDaSoLuong: Number(row.toidasoluong || 1),
                    tamHet: Boolean(row.tamhet),
                };
            }, tenantId);

            res.status(201).json({ message: 'Đã thêm lựa chọn Modifier!', option });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Thêm Modifier Option:');
        }
    });

    // 86'ing từng Modifier Option (VD: hết Sữa yến mạch)
    app.put('/api/modifiers/options/:id/tamhet', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
        const tenantId = layTenantId(req);
        const optionId = Number(req.params.id);
        const tamHet = Boolean(req.body?.tamHet);
        if (!Number.isInteger(optionId) || optionId <= 0) {
            return res.status(400).json({ message: 'ID tùy chọn không hợp lệ!' });
        }
        try {
            const row = await chayGiaoDich(async (client) => {
                const upd = await client.query(
                    `UPDATE modifier_options
                        SET tamhet = $2
                      WHERE id = $1 AND tenantid = $3
                      RETURNING id, groupid, tenoption, tamhet`,
                    [optionId, tamHet, tenantId]
                );
                if (upd.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy tùy chọn Modifier!');
                return upd.rows[0];
            }, tenantId);

            emitToTenant(io, {
                tenantId,
                roles: ['POS', 'WAITER', 'KDS'],
                event: 'MODIFIER_TAM_HET',
                payload: {
                    optionId: Number(row.id),
                    groupId: Number(row.groupid),
                    tenOption: row.tenoption,
                    tamHet: Boolean(row.tamhet),
                },
            });

            res.json({
                message: row.tamhet
                    ? `Đã báo TẠM HẾT tùy chọn "${row.tenoption}"!`
                    : `Đã mở bán lại tùy chọn "${row.tenoption}"!`,
                option: {
                    id: Number(row.id),
                    groupId: Number(row.groupid),
                    tenOption: row.tenoption,
                    tamHet: Boolean(row.tamhet),
                },
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API 86 Modifier Option:');
        }
    });

    app.post('/api/modifiers/options/:id/bom', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const optionId = Number(req.params.id);
        const { bom = [] } = req.body || {};
        if (!Number.isInteger(optionId) || optionId <= 0 || !Array.isArray(bom)) {
            return res.status(400).json({ message: 'Thiếu optionId hoặc danh sách bom!' });
        }
        try {
            const rows = await chayGiaoDich(async (client) => {
                const chk = await client.query(
                    `SELECT id FROM modifier_options WHERE id = $1 AND tenantid = $2`,
                    [optionId, tenantId]
                );
                if (chk.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy tùy chọn Modifier!');
                await client.query(
                    `DELETE FROM modifier_option_bom WHERE optionid = $1 AND tenantid = $2`,
                    [optionId, tenantId]
                );
                const inserted = [];
                for (const b of bom) {
                    if (!b?.maNL || Number(b.khoiLuongDelta) === 0) continue;
                    const ins = await client.query(
                        `INSERT INTO modifier_option_bom (tenantid, optionid, kichthuoc, manl, khoiluongdelta)
                         VALUES ($1, $2, $3, $4, $5)
                         RETURNING id, kichthuoc, manl, khoiluongdelta`,
                        [
                            tenantId,
                            optionId,
                            b.kichThuoc ? String(b.kichThuoc).trim().toUpperCase() : null,
                            String(b.maNL).trim(),
                            Number(b.khoiLuongDelta),
                        ]
                    );
                    inserted.push({
                        id: Number(ins.rows[0].id),
                        kichThuoc: ins.rows[0].kichthuoc,
                        maNL: ins.rows[0].manl,
                        khoiLuongDelta: Number(ins.rows[0].khoiluongdelta),
                    });
                }
                return inserted;
            }, tenantId);

            res.json({ message: 'Cập nhật Substitution BOM thành công!', bom: rows });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Cập nhật Modifier BOM:');
        }
    });

    app.post('/api/sanpham/:maMon/modifiers', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const { maMon } = req.params;
        const { groupIds = [] } = req.body || {};
        if (!Array.isArray(groupIds)) {
            return res.status(400).json({ message: 'groupIds phải là mảng số nguyên!' });
        }
        try {
            await chayGiaoDich(async (client) => {
                const sp = await client.query(
                    `SELECT MaMon FROM SanPham WHERE MaMon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
                    [maMon, tenantId]
                );
                if (sp.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy sản phẩm!');
                await client.query(
                    `DELETE FROM sanpham_modifier_groups WHERE tenantid = $1 AND mamon = $2`,
                    [tenantId, maMon]
                );
                for (let idx = 0; idx < groupIds.length; idx += 1) {
                    const gid = Number(groupIds[idx]);
                    if (!Number.isInteger(gid) || gid <= 0) continue;
                    await client.query(
                        `INSERT INTO sanpham_modifier_groups (tenantid, mamon, groupid, thutuhienthi)
                         VALUES ($1, $2, $3, $4)
                         ON CONFLICT (tenantid, mamon, groupid) DO UPDATE SET thutuhienthi = EXCLUDED.thutuhienthi`,
                        [tenantId, maMon, gid, idx]
                    );
                }
            }, tenantId);

            res.json({ message: `Đã gắn ${groupIds.length} nhóm Modifier cho món ${maMon}!`, maMon, groupIds });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Gắn Modifier vào món:');
        }
    });

    // =========================================================================
    // 2. ĐỘNG CƠ COMBO / BUNDLE CRUD & ACTIVE LIST
    // =========================================================================
    async function loadCombosWithSlots(client, tenantId, { onlyActiveNow = false } = {}) {
        const cRes = await client.query(
            `SELECT macombo, tencombo, giabancombo, khunggiotu, khunggioden, dangkinhdoanh, thoigiantao
               FROM combo
              WHERE tenantid = $1 ${onlyActiveNow ? 'AND dangkinhdoanh = TRUE' : ''}
              ORDER BY thoigiantao DESC, macombo ASC`,
            [tenantId]
        );
        const hhmm = layGioHienTaiHHMMVN();
        const combosFiltered = onlyActiveNow
            ? cRes.rows.filter((c) => namTrongKhungGio(hhmm, c.khunggiotu, c.khunggioden))
            : cRes.rows;

        if (combosFiltered.length === 0) return [];
        const maCombos = combosFiltered.map((c) => c.macombo);

        const sRes = await client.query(
            `SELECT id, macombo, tenslot, soluongchon, thutuhienthi
               FROM combo_slots
              WHERE tenantid = $1 AND macombo = ANY($2::varchar[])
              ORDER BY thutuhienthi ASC, id ASC`,
            [tenantId, maCombos]
        );
        const slotIds = sRes.rows.map((s) => Number(s.id));
        const itemsBySlot = new Map();

        if (slotIds.length > 0) {
            const iRes = await client.query(
                `SELECT csi.id, csi.slotid, csi.mamon, csi.kichthuocmacdinh, csi.chophepdoikichthuoc, csi.phuthu,
                        sp.tenmon, sp.nhommon, COALESCE(sp.tamhet, FALSE) AS tamhet,
                        to_jsonb(sp)->>'tramchebien' AS tramchebien,
                        COALESCE((SELECT json_agg(json_build_object('kichThuoc', sz.kichthuoc, 'giaBan', sz.giaban) ORDER BY sz.giaban)
                                    FROM sanpham_size sz WHERE sz.mamon = csi.mamon), '[]'::json) AS sizes
                   FROM combo_slot_items csi
                   LEFT JOIN sanpham sp ON sp.mamon = csi.mamon
                  WHERE csi.tenantid = $1 AND csi.slotid = ANY($2::bigint[])
                  ORDER BY csi.id ASC`,
                [tenantId, slotIds]
            );
            for (const r of iRes.rows) {
                const sid = Number(r.slotid);
                if (!itemsBySlot.has(sid)) itemsBySlot.set(sid, []);
                itemsBySlot.get(sid).push({
                    id: Number(r.id),
                    slotId: sid,
                    maMon: r.mamon,
                    tenMon: r.tenmon || r.mamon,
                    nhomMon: r.nhommon || null,
                    tamHet: Boolean(r.tamhet),
                    kichThuocMacDinh: r.kichthuocmacdinh || 'M',
                    choPhepDoiKichThuoc: Boolean(r.chophepdoikichthuoc),
                    phuThu: Number(r.phuthu || 0),
                    sizes: (r.sizes || []).map((sz) => ({
                        kichThuoc: sz.kichThuoc,
                        giaBan: Number(sz.giaBan || 0),
                    })),
                });
            }
        }

        const slotsByCombo = new Map();
        for (const s of sRes.rows) {
            if (!slotsByCombo.has(s.macombo)) slotsByCombo.set(s.macombo, []);
            slotsByCombo.get(s.macombo).push({
                id: Number(s.id),
                maCombo: s.macombo,
                tenSlot: s.tenslot,
                soLuongChon: Number(s.soluongchon || 1),
                thuTuHienThi: Number(s.thutuhienthi || 0),
                items: itemsBySlot.get(Number(s.id)) || [],
            });
        }

        return combosFiltered.map((c) => ({
            maCombo: c.macombo,
            tenCombo: c.tencombo,
            giaBanCombo: Number(c.giabancombo || 0),
            khungGioTu: c.khunggiotu || null,
            khungGioDen: c.khunggioden || null,
            dangKinhDoanh: Boolean(c.dangkinhdoanh),
            slots: slotsByCombo.get(c.macombo) || [],
        }));
    }

    app.get('/api/combos', kiemTraToken, async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const list = await pool.withTenant(tenantId, (client) =>
                loadCombosWithSlots(client, tenantId, { onlyActiveNow: false })
            );
            res.json(list);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Lấy danh sách Combo:');
        }
    });

    app.get('/api/combos/active', kiemTraToken, async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const list = await pool.withTenant(tenantId, (client) =>
                loadCombosWithSlots(client, tenantId, { onlyActiveNow: true })
            );
            res.json(list);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Lấy danh sách Combo đang áp dụng:');
        }
    });

    app.post('/api/combos', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const {
            maCombo,
            tenCombo,
            giaBanCombo,
            khungGioTu = null,
            khungGioDen = null,
            dangKinhDoanh = true,
            slots = [],
        } = req.body || {};

        if (!maCombo || !tenCombo || !(Number(giaBanCombo) >= 0) || !Array.isArray(slots) || slots.length === 0) {
            return res.status(400).json({
                message: 'Vui lòng nhập đầy đủ maCombo, tenCombo, giaBanCombo >= 0 và tối thiểu 1 khe chọn (slots)!',
            });
        }
        const cleanCode = String(maCombo).trim().toUpperCase().slice(0, 50);

        try {
            const combo = await chayGiaoDich(async (client) => {
                await client.query(
                    `INSERT INTO combo (macombo, tenantid, tencombo, giabancombo, khunggiotu, khunggioden, dangkinhdoanh)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (tenantid, macombo) DO UPDATE SET
                        tencombo = EXCLUDED.tencombo,
                        giabancombo = EXCLUDED.giabancombo,
                        khunggiotu = EXCLUDED.khunggiotu,
                        khunggioden = EXCLUDED.khunggioden,
                        dangkinhdoanh = EXCLUDED.dangkinhdoanh`,
                    [
                        cleanCode,
                        tenantId,
                        String(tenCombo).trim().slice(0, 150),
                        Number(giaBanCombo),
                        khungGioTu ? String(khungGioTu).trim().slice(0, 5) : null,
                        khungGioDen ? String(khungGioDen).trim().slice(0, 5) : null,
                        Boolean(dangKinhDoanh),
                    ]
                );

                await client.query(`DELETE FROM combo_slots WHERE tenantid = $1 AND macombo = $2`, [
                    tenantId,
                    cleanCode,
                ]);

                for (let idx = 0; idx < slots.length; idx += 1) {
                    const sl = slots[idx];
                    if (!sl?.tenSlot || !Array.isArray(sl.items) || sl.items.length === 0) continue;
                    const sIns = await client.query(
                        `INSERT INTO combo_slots (tenantid, macombo, tenslot, soluongchon, thutuhienthi)
                         VALUES ($1, $2, $3, $4, $5)
                         RETURNING id`,
                        [
                            tenantId,
                            cleanCode,
                            String(sl.tenSlot).trim().slice(0, 80),
                            Math.max(1, Math.floor(Number(sl.soLuongChon || 1))),
                            Math.floor(Number(sl.thuTuHienThi ?? idx)),
                        ]
                    );
                    const slotId = Number(sIns.rows[0].id);
                    for (const it of sl.items) {
                        if (!it?.maMon) continue;
                        await client.query(
                            `INSERT INTO combo_slot_items
                                (tenantid, slotid, mamon, kichthuocmacdinh, chophepdoikichthuoc, phuthu)
                             VALUES ($1, $2, $3, $4, $5, $6)`,
                            [
                                tenantId,
                                slotId,
                                String(it.maMon).trim(),
                                String(it.kichThuocMacDinh || 'M').trim().toUpperCase(),
                                it.choPhepDoiKichThuoc !== false,
                                Math.max(0, Number(it.phuThu || 0)),
                            ]
                        );
                    }
                }

                const loaded = await loadCombosWithSlots(client, tenantId, { onlyActiveNow: false });
                return loaded.find((c) => c.maCombo === cleanCode);
            }, tenantId);

            res.status(201).json({ message: `Đã lưu Combo "${tenCombo}" thành công!`, combo });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Lưu Combo:');
        }
    });

    app.delete('/api/combos/:maCombo', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            await qTenant(req, `UPDATE combo SET dangkinhdoanh = FALSE WHERE macombo = $1 AND tenantid = $2`, [
                req.params.maCombo,
                tenantId,
            ]);
            res.json({ message: 'Đã ngừng kinh doanh Combo!' });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Xóa Combo:');
        }
    });

    // =========================================================================
    // 3. CẤU HÌNH VẬT TƯ ĐÓNG GÓI MANG ĐI THEO KÊNH BÁN (cauhinh_vattu_mangdi)
    // =========================================================================
    const normalizePackagingChannel = (raw) => {
        const up = String(raw || 'ALL').trim().toUpperCase();
        if (!up || up === 'ALL') return 'ALL';
        if (up === 'APP' || up === 'APP_SAN' || up === 'DELIVERY_APP') return 'APP_SAN';
        if (up === 'MANG_DI' || up === 'TAKEAWAY') return 'MANG_DI';
        if (up === 'GIAO_HANG' || up === 'DELIVERY') return 'GIAO_HANG';
        if (up === 'TAI_QUAN' || up === 'DINE_IN') return 'TAI_QUAN';
        return 'ALL';
    };

    app.get('/api/kho/vattu-mangdi', kiemTraToken, async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const r = await qTenant(
                req,
                `SELECT COALESCE(to_jsonb(c)->>'kenhdung', 'ALL') AS kenhdung,
                        c.kichthuoc, c.manl, c.soluongtieuhao, nl.tennl, nl.donvitinh
                   FROM cauhinh_vattu_mangdi c
                   LEFT JOIN nguyenlieu nl ON nl.manl = c.manl
                  WHERE c.tenantid = $1
                  ORDER BY COALESCE(to_jsonb(c)->>'kenhdung', 'ALL'), c.kichthuoc, c.manl`,
                [tenantId]
            );
            res.json(
                r.rows.map((x) => {
                    const kenhDung = normalizePackagingChannel(x.kenhdung);
                    const qty = Number(x.soluongtieuhao);
                    return {
                        kenhDung,
                        loaiDonHang: kenhDung,
                        kichThuoc: x.kichthuoc,
                        maNL: x.manl,
                        tenNL: x.tennl || x.manl,
                        donViTinh: x.donvitinh || '',
                        soLuongTieuHao: qty,
                        soLuongMoiLy: qty,
                    };
                })
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Lấy cấu hình vật tư mang đi:');
        }
    });

    app.post('/api/kho/vattu-mangdi', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const items = Array.isArray(req.body?.items)
            ? req.body.items
            : req.body?.maNL
            ? [req.body]
            : [];
        if (items.length === 0) {
            return res.status(400).json({ message: 'Thiếu danh sách vật tư đóng gói (kichThuoc, maNL, soLuongMoiLy/soLuongTieuHao)!' });
        }
        const normalized = [];
        for (const it of items) {
            const maNL = String(it?.maNL || '').trim();
            const sz = String(it?.kichThuoc || 'ALL').trim().toUpperCase();
            const kenhDung = normalizePackagingChannel(it?.kenhDung ?? it?.loaiDonHang ?? 'ALL');
            const rawSl = it?.soLuongTieuHao !== undefined ? it.soLuongTieuHao : it?.soLuongMoiLy;
            const sl = Number(rawSl);
            if (!maNL || !(sl > 0)) continue;
            normalized.push({ kenhDung, kichThuoc: sz, maNL, soLuongTieuHao: sl });
        }
        if (normalized.length === 0) {
            return res.status(400).json({
                message: 'Không có dòng vật tư đóng gói hợp lệ (yêu cầu maNL và soLuongMoiLy/soLuongTieuHao > 0)!',
            });
        }
        try {
            await chayGiaoDich(async (client) => {
                for (const it of normalized) {
                    await client.query(
                        `INSERT INTO cauhinh_vattu_mangdi (tenantid, kenhdung, kichthuoc, manl, soluongtieuhao)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (tenantid, kenhdung, kichthuoc, manl)
                         DO UPDATE SET soluongtieuhao = EXCLUDED.soluongtieuhao`,
                        [tenantId, it.kenhDung, it.kichThuoc, it.maNL, it.soLuongTieuHao]
                    );
                }
            }, tenantId);
            res.status(201).json({
                message: 'Đã cập nhật định mức vật tư đóng gói theo kênh bán!',
                savedCount: normalized.length,
                items: normalized.map((x) => ({
                    ...x,
                    loaiDonHang: x.kenhDung,
                    soLuongMoiLy: x.soLuongTieuHao,
                })),
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Cập nhật vật tư mang đi:');
        }
    });

    app.delete('/api/kho/vattu-mangdi', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const src = { ...(req.query || {}), ...(req.body || {}) };
        const maNL = String(src.maNL || '').trim();
        const kichThuoc = String(src.kichThuoc || 'ALL').trim().toUpperCase();
        const kenhDung = normalizePackagingChannel(src.kenhDung ?? src.loaiDonHang ?? 'ALL');
        if (!maNL) {
            return res.status(400).json({ message: 'Thiếu mã nguyên liệu (maNL) cần xóa khỏi cấu hình bao bì!' });
        }
        try {
            const del = await qTenant(
                req,
                `DELETE FROM cauhinh_vattu_mangdi
                  WHERE tenantid = $1 AND kenhdung = $2 AND kichthuoc = $3 AND manl = $4`,
                [tenantId, kenhDung, kichThuoc, maNL]
            );
            res.json({ message: 'Đã xóa cấu hình vật tư đóng gói!', deletedCount: del.rowCount || 0 });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Xóa vật tư mang đi:');
        }
    });

    // =========================================================================
    // 4. ĐẶT BÀN TRƯỚC (RESERVATIONS - datban)
    // =========================================================================
    app.get('/api/datban', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const trangThai = req.query.trangThai ? String(req.query.trangThai).trim().toUpperCase() : null;
        try {
            const r = await qTenant(
                req,
                `SELECT d.madatban, d.branchid, d.maban, b.tenban, d.tenkhach, d.sodienthoai,
                        d.sokhach, d.thoigianden, d.tiencoc, d.trangthai, d.ghichu, d.mahoadon, d.thoigiantao
                   FROM datban d
                   LEFT JOIN ban b ON b.maban = d.maban AND COALESCE(b.tenantid, 'DEFAULT') = d.tenantid
                  WHERE d.tenantid = $1
                    AND ($2::text IS NULL OR d.trangthai = $2)
                  ORDER BY d.thoigianden ASC`,
                [tenantId, trangThai]
            );
            res.json(
                r.rows.map((x) => ({
                    maDatBan: x.madatban,
                    branchId: x.branchid || null,
                    maBan: x.maban,
                    tenBan: x.tenban || x.maban,
                    tenKhach: x.tenkhach,
                    soDienThoai: x.sodienthoai,
                    soKhach: Number(x.sokhach || 2),
                    thoiGianDen: x.thoigianden,
                    tienCoc: Number(x.tiencoc || 0),
                    trangThai: x.trangthai,
                    ghiChu: x.ghichu || null,
                    maHoaDon: x.mahoadon || null,
                    thoiGianTao: x.thoigiantao,
                }))
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Lấy danh sách Đặt bàn:');
        }
    });

    app.post('/api/datban', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const {
            maBan,
            tenKhach,
            soDienThoai,
            soKhach = 2,
            thoiGianDen,
            tienCoc = 0,
            ghiChu = null,
            branchId = null,
        } = req.body || {};

        if (!maBan || !tenKhach || !soDienThoai || !thoiGianDen) {
            return res.status(400).json({
                message: 'Vui lòng nhập đầy đủ maBan, tenKhach, soDienThoai và thoiGianDen!',
            });
        }
        const maDatBan = `DB-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

        try {
            const created = await chayGiaoDich(async (client) => {
                const bRes = await client.query(
                    `SELECT MaBan, TenBan, TrangThai, to_jsonb(Ban)->>'branchid' AS BranchId
                       FROM Ban
                      WHERE MaBan = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2
                      FOR UPDATE`,
                    [maBan, tenantId]
                );
                if (bRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy bàn cần đặt!');

                const ins = await client.query(
                    `INSERT INTO datban
                        (madatban, tenantid, branchid, maban, tenkhach, sodienthoai, sokhach, thoigianden, tiencoc, trangthai, ghichu)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CONFIRMED', $10)
                     RETURNING *`,
                    [
                        maDatBan,
                        tenantId,
                        branchId || bRes.rows[0].branchid || null,
                        maBan,
                        String(tenKhach).trim().slice(0, 120),
                        String(soDienThoai).trim().slice(0, 32),
                        Math.max(1, Math.floor(Number(soKhach || 2))),
                        new Date(thoiGianDen).toISOString(),
                        Math.max(0, Number(tienCoc || 0)),
                        ghiChu ? String(ghiChu).trim().slice(0, 500) : null,
                    ]
                );

                // Nếu bàn đang trống (1) và lịch đặt trong vòng 60 phút tới -> đổi ngay sang 4 (Đặt trước)
                const diffMins = (new Date(thoiGianDen).getTime() - Date.now()) / 60000;
                if (Number(bRes.rows[0].trangthai) === 1 && diffMins <= 60 && diffMins >= -30) {
                    await client.query(`UPDATE Ban SET TrangThai = 4 WHERE MaBan = $1`, [maBan]);
                }

                return { row: ins.rows[0], tenBan: bRes.rows[0].tenban };
            }, tenantId);

            emitToBranch(io, {
                tenantId,
                branchId: req.body?.branchId || req.user?.branchId || 'DEFAULT',
                roles: ['POS', 'WAITER'],
                event: 'DATBAN_CAP_NHAT',
                payload: {
                    maDatBan,
                    maBan,
                    trangThai: 'CONFIRMED',
                },
            });

            res.status(201).json({
                message: `Đã đặt trước ${created.tenBan} cho khách ${tenKhach}!`,
                datBan: {
                    maDatBan: created.row.madatban,
                    maBan: created.row.maban,
                    tenBan: created.tenBan,
                    tenKhach: created.row.tenkhach,
                    soDienThoai: created.row.sodienthoai,
                    soKhach: Number(created.row.sokhach),
                    thoiGianDen: created.row.thoigianden,
                    tienCoc: Number(created.row.tiencoc || 0),
                    trangThai: created.row.trangthai,
                },
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Tạo Đặt bàn:');
        }
    });

    app.put('/api/datban/:maDatBan/trangthai', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const { maDatBan } = req.params;
        const trangThai = String(req.body?.trangThai || '').trim().toUpperCase();
        if (!['CONFIRMED', 'ARRIVED', 'CANCELLED', 'NO_SHOW'].includes(trangThai)) {
            return res.status(400).json({ message: 'trangThai đặt bàn không hợp lệ!' });
        }
        try {
            const out = await chayGiaoDich(async (client) => {
                const dRes = await client.query(
                    `SELECT * FROM datban WHERE madatban = $1 AND tenantid = $2 FOR UPDATE`,
                    [maDatBan, tenantId]
                );
                if (dRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy lịch đặt bàn!');
                const d = dRes.rows[0];

                await client.query(
                    `UPDATE datban SET trangthai = $2, mahoadon = COALESCE($3, mahoadon)
                      WHERE madatban = $1 AND tenantid = $4`,
                    [maDatBan, trangThai, req.body?.maHoaDon || null, tenantId]
                );

                // Cập nhật trạng thái bàn tương ứng nếu bàn chưa có hóa đơn mở
                if (trangThai === 'CANCELLED' || trangThai === 'NO_SHOW') {
                    await client.query(
                        `UPDATE Ban SET TrangThai = 1
                          WHERE MaBan = $1 AND TrangThai = 4 AND COALESCE(TenantId, 'DEFAULT') = $2`,
                        [d.maban, tenantId]
                    );
                } else if (trangThai === 'ARRIVED') {
                    await client.query(
                        `UPDATE Ban SET TrangThai = 2
                          WHERE MaBan = $1 AND TrangThai IN (1, 4) AND COALESCE(TenantId, 'DEFAULT') = $2`,
                        [d.maban, tenantId]
                    );
                }

                return { maDatBan, maBan: d.maban, trangThai };
            }, tenantId);

            emitToBranch(io, {
                tenantId,
                branchId: req.body?.branchId || req.user?.branchId || 'DEFAULT',
                roles: ['POS', 'WAITER'],
                event: 'DATBAN_CAP_NHAT',
                payload: out,
            });
            res.json({ message: `Đã cập nhật lịch đặt bàn #${maDatBan} sang ${trangThai}!`, ...out });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Cập nhật Đặt bàn:');
        }
    });

    // =========================================================================
    // 5. HẸN GIỜ RA MÓN (COURSE FIRING) & HÀNG ĐỢI CHỜ BÁO BẾP
    // =========================================================================
    app.get('/api/order/cho-bao-bep', kiemTraToken, choPhepVaiTro(1, 2, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const rows = await pool.withTenant(tenantId, async (client) => {
                const r = await client.query(
                    `SELECT c.MaCTHD, c.MaHoaDon, c.MaMon, COALESCE(c.TenMonSnapshot, sp.TenMon) AS TenMon,
                            c.KichThuoc, c.SoLuong, c.GhiChu,
                            COALESCE(c.CourseNo, 1) AS CourseNo,
                            COALESCE(c.DotGoi, 1) AS DotGoi,
                            COALESCE(c.IsTakeaway, FALSE) AS IsTakeaway,
                            COALESCE(c.FireStatus, 'FIRED') AS FireStatus,
                            c.ThoiGianGoi,
                            (SELECT string_agg(b.TenBan, ', ' ORDER BY b.TenBan)
                               FROM HoaDon_Ban hb JOIN Ban b ON b.MaBan = hb.MaBan
                              WHERE hb.MaHoaDon = c.MaHoaDon) AS TenBan
                       FROM ChiTietHoaDon c
                       JOIN HoaDon hd ON hd.MaHoaDon = c.MaHoaDon
                       JOIN SanPham sp ON sp.MaMon = c.MaMon
                      WHERE COALESCE(hd.TenantId, 'DEFAULT') = $1
                        AND hd.TrangThaiTT = 0
                        AND c.TrangThaiPhaChe <> 'DaHuy'
                        AND COALESCE(c.FireStatus, 'FIRED') = 'HELD'
                      ORDER BY c.CourseNo ASC, c.ThoiGianGoi ASC`,
                    [tenantId]
                );
                return r.rows.map((x) => ({
                    maCTHD: x.macthd,
                    maHoaDon: x.mahoadon,
                    maMon: x.mamon,
                    tenMon: x.tenmon,
                    kichThuoc: x.kichthuoc,
                    soLuong: Number(x.soluong),
                    ghiChu: x.ghichu || null,
                    courseNo: Number(x.courseno || 1),
                    dotGoi: Number(x.dotgoi || 1),
                    isTakeaway: Boolean(x.istakeaway),
                    fireStatus: x.firestatus,
                    thoiGianGoi: x.thoigiangoi,
                    tenBan: x.tenban || 'Mang đi',
                }));
            });
            res.json(rows);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Món chờ báo bếp (Course Held):');
        }
    });

    app.post('/api/order/:maHoaDon/fire-course', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const { maHoaDon } = req.params;
        const { courseNo = null, dsMaCTHD = null } = req.body || {};

        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const hd = await client.query(
                    `SELECT MaHoaDon, TrangThaiTT FROM HoaDon
                      WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2 FOR UPDATE`,
                    [maHoaDon, tenantId]
                );
                if (hd.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn!');
                if (hd.rows[0].trangthaitt !== 0) {
                    throw new LoiNghiepVu(409, 'Chỉ có thể báo bếp ra món cho hóa đơn đang mở!');
                }

                let upd;
                if (Array.isArray(dsMaCTHD) && dsMaCTHD.length > 0) {
                    upd = await client.query(
                        `UPDATE ChiTietHoaDon
                            SET FireStatus = 'FIRED',
                                FiredAt = CURRENT_TIMESTAMP,
                                ThoiGianGoi = CURRENT_TIMESTAMP
                          WHERE MaHoaDon = $1
                            AND MaCTHD = ANY($2::varchar[])
                            AND FireStatus = 'HELD'
                            AND TrangThaiPhaChe <> 'DaHuy'
                          RETURNING MaCTHD`,
                        [maHoaDon, dsMaCTHD.map(String)]
                    );
                } else if (courseNo !== null && courseNo !== undefined) {
                    upd = await client.query(
                        `UPDATE ChiTietHoaDon
                            SET FireStatus = 'FIRED',
                                FiredAt = CURRENT_TIMESTAMP,
                                ThoiGianGoi = CURRENT_TIMESTAMP
                          WHERE MaHoaDon = $1
                            AND CourseNo = $2
                            AND FireStatus = 'HELD'
                            AND TrangThaiPhaChe <> 'DaHuy'
                          RETURNING MaCTHD`,
                        [maHoaDon, Number(courseNo)]
                    );
                } else {
                    upd = await client.query(
                        `UPDATE ChiTietHoaDon
                            SET FireStatus = 'FIRED',
                                FiredAt = CURRENT_TIMESTAMP,
                                ThoiGianGoi = CURRENT_TIMESTAMP
                          WHERE MaHoaDon = $1
                            AND FireStatus = 'HELD'
                            AND TrangThaiPhaChe <> 'DaHuy'
                          RETURNING MaCTHD`,
                        [maHoaDon]
                    );
                }

                if (upd.rows.length === 0) {
                    throw new LoiNghiepVu(409, 'Không có món nào đang chờ báo ra món (HELD) phù hợp!');
                }
                const firedIds = upd.rows.map((r) => r.macthd);
                const monFired = await layMonTheoMa(client, firedIds);

                return {
                    maHoaDon,
                    firedIds,
                    monFired,
                    hoaDon: await layHoaDonChiTiet(client, maHoaDon),
                };
            }, tenantId);

            const fireBranchId = normalizeBranchId(ketQua.hoaDon?.branchId || req.user?.branchId || 'DEFAULT');
            const fireStations = [...new Set((ketQua.monFired || []).map((m) => m.tramCheBien || 'BAR_CHINH'))];
            for (const st of fireStations.length > 0 ? fireStations : ['ALL']) {
                emitScopedKdsEvent(io, {
                    tenantId,
                    branchId: fireBranchId,
                    station: st,
                    eventType: 'COURSE_FIRED',
                    socketEvents: ['CO_DON_MOI', 'kds:course_fired'],
                    payload: {
                        maHoaDon,
                        tenBan: ketQua.monFired[0]?.tenBan || null,
                        laBaoBepCourse: true,
                        courseNo: courseNo ? Number(courseNo) : null,
                        firedIds: ketQua.firedIds,
                        danhSachMon: ketQua.monFired.filter((m) => st === 'ALL' || (m.tramCheBien || 'BAR_CHINH') === st),
                        firedAt: new Date().toISOString(),
                    },
                    includeExpo: true,
                    includeWaiter: true,
                    includePos: true,
                });
            }

            res.json({
                message: `🔥 Đã báo bếp ra ${ketQua.firedIds.length} món${courseNo ? ` (Đợt món #${courseNo})` : ''}!`,
                ...ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Báo bếp ra món (Fire Course):');
        }
    });

    // =========================================================================
    // 6. LƯU NHÁP ĐƠN ĐA THIẾT BỊ (HOLD / PARK ORDER: TrangThaiTT = -1)
    // Không trừ kho, không bắn KDS, không giữ bàn!
    // =========================================================================
    app.get('/api/order/luu-tam', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const list = await pool.withTenant(tenantId, async (client) => {
                const hdRes = await client.query(
                    `SELECT hd.MaHoaDon, hd.MaNV, nv.TenNV, hd.MaKH,
                            COALESCE(to_jsonb(kh)->>'tenkh', to_jsonb(kh)->>'hoten') AS TenKH,
                            hd.ThoiGianTao, hd.TenKhachVangLai, hd.LoaiDonHang, hd.DiaChiGiao,
                            COALESCE((SELECT SUM(c.SoLuong) FROM ChiTietHoaDon c WHERE c.MaHoaDon = hd.MaHoaDon), 0) AS TongLy,
                            COALESCE((SELECT SUM((c.DonGia + COALESCE(c.GiaModifiers, 0)) * c.SoLuong)
                                        FROM ChiTietHoaDon c WHERE c.MaHoaDon = hd.MaHoaDon), 0)
                            + COALESCE((SELECT SUM(t.SoLuong * t.DonGia)
                                          FROM ChiTietHoaDon c2 JOIN ChiTietHoaDon_Topping t ON t.MaCTHD = c2.MaCTHD
                                         WHERE c2.MaHoaDon = hd.MaHoaDon), 0) AS TongTamTinh
                       FROM HoaDon hd
                       LEFT JOIN NhanVien nv ON nv.MaNV = hd.MaNV
                       LEFT JOIN KhachHang kh ON kh.MaKH = hd.MaKH
                      WHERE COALESCE(hd.TenantId, 'DEFAULT') = $1
                        AND hd.TrangThaiTT = -1
                      ORDER BY hd.ThoiGianTao DESC
                      LIMIT 50`,
                    [tenantId]
                );
                return hdRes.rows.map((r) => ({
                    maHoaDon: r.mahoadon,
                    maNV: r.manv,
                    tenNV: r.tennv || r.manv,
                    maKH: r.makh || null,
                    tenKH: r.tenkh || null,
                    label: r.tenkhachvanglai || r.tenkh || `Đơn tạm #${r.mahoadon}`,
                    loaiDonHang: r.loaidonhang || 'TAI_QUAN',
                    diaChiGiao: r.diachigiao || null,
                    tongLy: Number(r.tongly || 0),
                    tongTamTinh: Number(r.tongtamtinh || 0),
                    thoiGianTao: r.thoigiantao,
                }));
            });
            res.json(list);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Lấy danh sách Đơn lưu tạm:');
        }
    });

    app.post('/api/order/luu-tam', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const {
            label = null,
            maKH = null,
            loaiDonHang = 'MANG_DI',
            diaChiGiao = null,
            danhSachMon = [],
        } = req.body || {};

        if (!Array.isArray(danhSachMon) || danhSachMon.length === 0) {
            return res.status(400).json({ message: 'Giỏ hàng trống, không thể lưu tạm!' });
        }

        try {
            const parked = await chayGiaoDich(async (client) => {
                let hdRes;
                await client.query('SAVEPOINT sp_ins_parked_hd');
                try {
                    hdRes = await client.query(
                        `INSERT INTO HoaDon (MaNV, MaKH, TrangThaiTT, lifecycle_status, TenantId, LoaiDonHang, TenKhachVangLai, DiaChiGiao)
                         VALUES ($1, $2, -1, 'PARKED', $3, $4, $5, $6)
                         RETURNING MaHoaDon, ThoiGianTao`,
                        [
                            req.user.maNV,
                            maKH || null,
                            tenantId,
                            ['TAI_QUAN', 'MANG_DI', 'GIAO_HANG', 'APP_SAN'].includes(loaiDonHang) ? loaiDonHang : 'MANG_DI',
                            label ? String(label).trim().slice(0, 100) : null,
                            diaChiGiao ? String(diaChiGiao).trim().slice(0, 500) : null,
                        ]
                    );
                    await client.query('RELEASE SAVEPOINT sp_ins_parked_hd');
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_ins_parked_hd').catch(() => {});
                    hdRes = await client.query(
                        `INSERT INTO HoaDon (MaNV, MaKH, TrangThaiTT, TenantId, LoaiDonHang, TenKhachVangLai, DiaChiGiao)
                         VALUES ($1, $2, -1, $3, $4, $5, $6)
                         RETURNING MaHoaDon, ThoiGianTao`,
                        [
                            req.user.maNV,
                            maKH || null,
                            tenantId,
                            ['TAI_QUAN', 'MANG_DI', 'GIAO_HANG', 'APP_SAN'].includes(loaiDonHang) ? loaiDonHang : 'MANG_DI',
                            label ? String(label).trim().slice(0, 100) : null,
                            diaChiGiao ? String(diaChiGiao).trim().slice(0, 500) : null,
                        ]
                    );
                }
                const maHoaDon = hdRes.rows[0].mahoadon;

                // Tra cứu giá dự phòng từ SanPham_Size nếu client thiếu donGia (chống lưu 0đ)
                const maMonList = [...new Set(danhSachMon.map((x) => x?.maMon).filter(Boolean))];
                const fallbackPriceMap = new Map();
                const fallbackNameMap = new Map();
                if (maMonList.length > 0) {
                    const pRes = await client.query(
                        `SELECT sz.MaMon, sz.KichThuoc, sz.GiaBan, sp.TenMon
                           FROM SanPham_Size sz
                           JOIN SanPham sp ON sp.MaMon = sz.MaMon
                          WHERE COALESCE(sp.TenantId, 'DEFAULT') = $2
                            AND sz.MaMon = ANY($1::varchar[])`,
                        [maMonList, tenantId]
                    );
                    for (const pr of pRes.rows) {
                        fallbackPriceMap.set(`${pr.mamon}|${pr.kichthuoc}`, Number(pr.giaban || 0));
                        fallbackNameMap.set(pr.mamon, pr.tenmon);
                    }
                }

                let tongTamTinhSaved = 0;
                for (const m of danhSachMon) {
                    const qty = Math.max(1, Math.floor(Number(m.soLuong || 1)));
                    const sz = m.kichThuoc || 'M';
                    const resolvedDonGia =
                        m.donGia !== undefined && m.donGia !== null && Number(m.donGia) > 0
                            ? Number(m.donGia)
                            : fallbackPriceMap.get(`${m.maMon}|${sz}`) ?? Number(m.donGia || 0);
                    const resolvedGiaMods = Number(m.giaModifiers || 0);
                    const resolvedTenMon = m.tenMon || fallbackNameMap.get(m.maMon) || m.maMon;
                    const resolvedWeight =
                        m.trongLuongGram !== undefined && m.trongLuongGram !== null && Number(m.trongLuongGram) > 0
                            ? Number(m.trongLuongGram)
                            : null;
                    const resolvedCustomName = m.tenMonTuyChinh ? String(m.tenMonTuyChinh).trim().slice(0, 160) : null;
                    const resolvedMaCombo = m.maCombo ? String(m.maCombo).trim().slice(0, 64) : null;
                    const resolvedTenCombo = m.tenComboSnapshot ? String(m.tenComboSnapshot).trim().slice(0, 160) : null;

                    let cIns;
                    await client.query('SAVEPOINT sp_ins_parked_cthd');
                    try {
                        cIns = await client.query(
                            `INSERT INTO ChiTietHoaDon
                                (MaHoaDon, MaMon, TenMonSnapshot, TenMonTuyChinh, KichThuoc, SoLuong, DonGia, GiaModifiers,
                                 ModifiersSnapshot, TrongLuongGram, MaCombo, TenComboSnapshot,
                                 GhiChu, TrangThaiPhaChe, IsTakeaway, CourseNo, FireStatus)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, 'ChoPhaChe', $14, $15, 'HELD')
                             RETURNING MaCTHD`,
                            [
                                maHoaDon,
                                m.maMon,
                                resolvedTenMon,
                                resolvedCustomName,
                                sz,
                                qty,
                                resolvedDonGia,
                                resolvedGiaMods,
                                JSON.stringify(Array.isArray(m.modifiers) ? m.modifiers : []),
                                resolvedWeight,
                                resolvedMaCombo,
                                resolvedTenCombo,
                                m.ghiChu ? String(m.ghiChu).slice(0, 255) : null,
                                Boolean(m.isTakeaway),
                                Math.max(1, Math.floor(Number(m.courseNo || 1))),
                            ]
                        );
                        await client.query('RELEASE SAVEPOINT sp_ins_parked_cthd');
                    } catch {
                        await client.query('ROLLBACK TO SAVEPOINT sp_ins_parked_cthd').catch(() => {});
                        cIns = await client.query(
                            `INSERT INTO ChiTietHoaDon
                                (MaHoaDon, MaMon, TenMonSnapshot, KichThuoc, SoLuong, DonGia, GiaModifiers,
                                 ModifiersSnapshot, GhiChu, TrangThaiPhaChe, IsTakeaway, CourseNo, FireStatus)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'ChoPhaChe', $10, $11, 'HELD')
                             RETURNING MaCTHD`,
                            [
                                maHoaDon,
                                m.maMon,
                                resolvedTenMon,
                                sz,
                                qty,
                                resolvedDonGia,
                                resolvedGiaMods,
                                JSON.stringify(Array.isArray(m.modifiers) ? m.modifiers : []),
                                m.ghiChu ? String(m.ghiChu).slice(0, 255) : null,
                                Boolean(m.isTakeaway),
                                Math.max(1, Math.floor(Number(m.courseNo || 1))),
                            ]
                        );
                    }
                    tongTamTinhSaved += (resolvedDonGia + resolvedGiaMods) * qty;
                    const maCTHD = cIns.rows[0].macthd;
                    for (const tp of m.toppings || []) {
                        if (!tp?.maTopping) continue;
                        const perCup = Math.max(1, Math.floor(Number(tp.soLuongMoiLy ?? tp.soLuong ?? 1)));
                        const tpPrice = Number(tp.donGia || 0);
                        tongTamTinhSaved += tpPrice * perCup * qty;
                        await client.query(
                            `INSERT INTO ChiTietHoaDon_Topping
                                (MaCTHD, MaTopping, TenToppingSnapshot, SoLuong, SoLuongMoiLy, DonGia)
                             VALUES ($1, $2, $3, $4, $5, $6)`,
                            [maCTHD, tp.maTopping, tp.tenTopping || null, perCup * qty, perCup, tpPrice]
                        );
                    }
                }
                return { maHoaDon, tongTamTinh: tongTamTinhSaved, thoiGianTao: hdRes.rows[0].thoigiantao };
            }, tenantId);

            emitToBranch(io, {
                tenantId,
                branchId: req.body?.branchId || req.user?.branchId || 'DEFAULT',
                roles: ['POS'],
                event: 'PARKED_ORDERS_UPDATED',
                payload: { maHoaDon: parked.maHoaDon },
            });
            res.status(201).json({
                message: `⏸️ Đã lưu tạm đơn #${parked.maHoaDon} lên máy chủ (khôi phục được từ mọi máy POS)!`,
                ...parked,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Lưu tạm đơn:');
        }
    });

    app.post('/api/order/:maHoaDon/khoi-phuc-tam', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
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
                if (hdRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy đơn lưu tạm!');
                if (Number(hdRes.rows[0].trangthaitt) !== -1) {
                    throw new LoiNghiepVu(409, 'Đơn lưu tạm này đã được khôi phục bởi máy khác!');
                }
                const detail = await layHoaDonChiTiet(client, maHoaDon);
                // Xóa nháp sau khi nạp về giỏ để không bị 2 máy thu ngân khôi phục trùng
                await client.query(
                    `DELETE FROM ChiTietHoaDon_Topping WHERE MaCTHD IN (SELECT MaCTHD FROM ChiTietHoaDon WHERE MaHoaDon = $1)`,
                    [maHoaDon]
                );
                await client.query(`DELETE FROM ChiTietHoaDon WHERE MaHoaDon = $1`, [maHoaDon]);
                await client.query(`DELETE FROM HoaDon WHERE MaHoaDon = $1 AND TrangThaiTT = -1`, [maHoaDon]);

                return {
                    maHoaDon,
                    loaiDonHang: hdRes.rows[0].loaidonhang || 'MANG_DI',
                    tenKhachVangLai: hdRes.rows[0].tenkhachvanglai || '',
                    diaChiGiao: hdRes.rows[0].diachigiao || '',
                    khachHang: detail?.khachHang || null,
                    cart: (detail?.danhSachMon || []).map((m) => ({
                        maMon: m.maMon,
                        tenMon: m.tenMon,
                        kichThuoc: m.kichThuoc,
                        soLuong: m.soLuong,
                        donGia: m.donGia,
                        giaModifiers: m.giaModifiers || 0,
                        modifiers: m.modifiersSnapshot || [],
                        ghiChu: m.ghiChu || '',
                        isTakeaway: Boolean(m.isTakeaway),
                        courseNo: m.courseNo || 1,
                        fireStatus: m.fireStatus === 'HELD' && Number(m.courseNo || 1) > 1 ? 'HELD' : 'FIRED',
                        ...(m.trongLuongGram ? { trongLuongGram: Number(m.trongLuongGram) } : {}),
                        ...(m.tenMonTuyChinh ? { tenMonTuyChinh: m.tenMonTuyChinh } : {}),
                        ...(m.maCombo
                            ? {
                                  maCombo: m.maCombo,
                                  tenComboSnapshot: m.tenComboSnapshot || null,
                                  comboInstanceId: m.comboGroupUid || `CMB-RESTORED-${maHoaDon}-${m.maCombo}`,
                              }
                            : {}),
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

            emitToBranch(io, {
                tenantId,
                branchId: req.body?.branchId || req.user?.branchId || 'DEFAULT',
                roles: ['POS'],
                event: 'PARKED_ORDERS_UPDATED',
                payload: { maHoaDon },
            });
            res.json({ message: `▶️ Đã khôi phục đơn tạm #${maHoaDon} về giỏ hàng!`, ...restored });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Khôi phục đơn tạm:');
        }
    });

    app.delete('/api/order/:maHoaDon/luu-tam', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const { maHoaDon } = req.params;
        try {
            await chayGiaoDich(async (client) => {
                const hdRes = await client.query(
                    `SELECT MaHoaDon FROM HoaDon WHERE MaHoaDon = $1 AND TrangThaiTT = -1 AND COALESCE(TenantId, 'DEFAULT') = $2 FOR UPDATE`,
                    [maHoaDon, tenantId]
                );
                if (hdRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy đơn lưu tạm!');
                await client.query(
                    `DELETE FROM ChiTietHoaDon_Topping WHERE MaCTHD IN (SELECT MaCTHD FROM ChiTietHoaDon WHERE MaHoaDon = $1)`,
                    [maHoaDon]
                );
                await client.query(`DELETE FROM ChiTietHoaDon WHERE MaHoaDon = $1`, [maHoaDon]);
                await client.query(`DELETE FROM HoaDon WHERE MaHoaDon = $1 AND TrangThaiTT = -1`, [maHoaDon]);
            }, tenantId);

            emitToBranch(io, {
                tenantId,
                branchId: req.body?.branchId || req.user?.branchId || 'DEFAULT',
                roles: ['POS'],
                event: 'PARKED_ORDERS_UPDATED',
                payload: { maHoaDon },
            });
            res.json({ message: `Đã xóa đơn lưu tạm #${maHoaDon}!` });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Xóa đơn lưu tạm:');
        }
    });

    // =========================================================================
    // 7. CHUYỂN MÓN LẺ GIỮA CÁC BÀN (POST /api/order/chuyen-mon)
    // =========================================================================
    app.post('/api/order/chuyen-mon', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const {
            fromMaHoaDon,
            toMaBan = null,
            toMaHoaDon = null,
            items = [],
            expectedVersion = null,
            destExpectedVersion = null,
            toExpectedVersion = null,
            managerPin = null,
            maNVDuyet = null,
            lyDo = null,
        } = req.body || {};
        const finalDestExpectedVersion = destExpectedVersion ?? toExpectedVersion ?? null;

        if (!fromMaHoaDon || (!toMaBan && !toMaHoaDon) || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                message: 'Vui lòng truyền đủ fromMaHoaDon, (toMaBan hoặc toMaHoaDon) và danh sách items [{ maCTHD, soLuongChuyen }]!',
            });
        }

        try {
            const ketQua = await chayGiaoDich(async (client) => {
                const srcHdRes = await client.query(
                    `SELECT MaHoaDon, TrangThaiTT, COALESCE(DaInTamTinh, FALSE) AS DaInTamTinh, COALESCE(Version, 1) AS Version
                       FROM HoaDon
                      WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                      FOR UPDATE`,
                    [fromMaHoaDon, tenantId]
                );
                if (srcHdRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn nguồn!');
                if (Number(srcHdRes.rows[0].trangthaitt) !== 0) {
                    throw new LoiNghiepVu(409, 'Chỉ có thể chuyển món từ hóa đơn đang mở!');
                }

                const srcDaInTamTinh = Boolean(srcHdRes.rows[0].daintamtinh);
                let prebillApprover = null;
                if (srcDaInTamTinh) {
                    const hasPerm =
                        Number(req.user.vaiTro) === 1 ||
                        (typeof coQuyenHan === 'function' && coQuyenHan(req.user, 'order.item.void_approve'));
                    if (hasPerm) {
                        prebillApprover = req.user.maNV;
                    } else {
                        const mgr =
                            managerPin && typeof xacThucPinQuanLy === 'function'
                                ? await xacThucPinQuanLy(client, tenantId, managerPin, req.ip, maNVDuyet, 'order.item.void_approve')
                                : null;
                        if (!mgr) {
                            throw new LoiNghiepVu(
                                403,
                                'Hóa đơn nguồn đã in tạm tính (Pre-bill)! Cần quyền Quản lý hoặc mã PIN Quản lý hợp lệ để chuyển món.',
                                { maLoi: 'CAN_PIN_QUAN_LY', code: 'PREBILL_TRANSFER_FORBIDDEN' }
                            );
                        }
                        prebillApprover = mgr.maNV;
                    }
                }

                await kiemTraVaTangVersionHoaDon(client, {
                    maHoaDon: fromMaHoaDon,
                    tenantId,
                    expectedVersion,
                    layHoaDonChiTiet,
                    LoiNghiepVu,
                });

                const srcBansRes = await client.query(
                    `SELECT b.MaBan, b.TenBan
                       FROM HoaDon_Ban hb JOIN Ban b ON b.MaBan = hb.MaBan
                      WHERE hb.MaHoaDon = $1 ORDER BY b.MaBan`,
                    [fromMaHoaDon]
                );
                const srcBanIds = srcBansRes.rows.map((b) => b.maban);
                const fromTenBan = srcBansRes.rows.map((b) => b.tenban).join(', ') || `HĐ #${fromMaHoaDon}`;

                let destMaHoaDon = toMaHoaDon || null;
                let destTenBan = '';
                let destBanOpened = null;

                if (toMaBan) {
                    const bRes = await client.query(
                        `SELECT MaBan, TenBan, TrangThai FROM Ban
                          WHERE MaBan = $1 AND DaXoa = FALSE AND COALESCE(TenantId, 'DEFAULT') = $2
                          FOR UPDATE`,
                        [toMaBan, tenantId]
                    );
                    if (bRes.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy bàn đích!');
                    destTenBan = bRes.rows[0].tenban;
                    const openOnDest = await layHoaDonMoCuaBan(client, toMaBan, true);
                    if (openOnDest) {
                        if (String(openOnDest) === String(fromMaHoaDon)) {
                            throw new LoiNghiepVu(409, 'Bàn đích đang gắn cùng hóa đơn nguồn!');
                        }
                        destMaHoaDon = openOnDest;
                    } else {
                        // Bàn đích trống -> tự động mở hóa đơn mới gắn toMaBan!
                        const { seq, soThuTuHienThi } = await capSoThuTuNgayKhongTrung(client, tenantId);
                        const newHd = await client.query(
                            `INSERT INTO HoaDon (MaNV, TrangThaiTT, TenantId, SoThuTuNgay, SoThuTuHienThi, LoaiDonHang, ThoiGianMoBan)
                             VALUES ($1, 0, $2, $3, $4, 'TAI_QUAN', CURRENT_TIMESTAMP)
                             RETURNING MaHoaDon`,
                            [req.user.maNV, tenantId, seq, soThuTuHienThi]
                        );
                        destMaHoaDon = newHd.rows[0].mahoadon;
                        await client.query(`INSERT INTO HoaDon_Ban (MaHoaDon, MaBan) VALUES ($1, $2)`, [
                            destMaHoaDon,
                            toMaBan,
                        ]);
                        await client.query(`UPDATE Ban SET TrangThai = 2 WHERE MaBan = $1`, [toMaBan]);
                        destBanOpened = toMaBan;
                    }
                } else {
                    const dHd = await client.query(
                        `SELECT MaHoaDon, TrangThaiTT FROM HoaDon WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2 FOR UPDATE`,
                        [destMaHoaDon, tenantId]
                    );
                    if (dHd.rows.length === 0 || Number(dHd.rows[0].trangthaitt) !== 0) {
                        throw new LoiNghiepVu(404, 'Không tìm thấy hóa đơn đích đang mở!');
                    }
                    const dbans = await client.query(
                        `SELECT string_agg(b.TenBan, ', ' ORDER BY b.TenBan) AS tb
                           FROM HoaDon_Ban hb JOIN Ban b ON b.MaBan = hb.MaBan
                          WHERE hb.MaHoaDon = $1`,
                        [destMaHoaDon]
                    );
                    destTenBan = dbans.rows[0]?.tb || `HĐ #${destMaHoaDon}`;
                }

                // Tải và khóa các dòng món nguồn
                const reqMap = new Map();
                for (const it of items) {
                    const id = String(it?.maCTHD ?? '').trim();
                    const sl = it?.soLuongChuyen !== undefined ? Math.floor(Number(it.soLuongChuyen)) : null;
                    if (!id) continue;
                    if (sl !== null && !(sl >= 1)) {
                        throw new LoiNghiepVu(400, 'soLuongChuyen phải >= 1!');
                    }
                    reqMap.set(id, sl);
                }

                const cthdRes = await client.query(
                    `SELECT MaCTHD, MaMon, TenMonSnapshot, KichThuoc, SoLuong, DonGia,
                            COALESCE(GiaGiam, 0) AS GiaGiam, COALESCE(GiaVonSnapshot, 0) AS GiaVonSnapshot,
                            COALESCE(GiaModifiers, 0) AS GiaModifiers,
                            COALESCE(ModifiersSnapshot, '[]'::jsonb) AS ModifiersSnapshot,
                            COALESCE(ChietKhauMon, 0) AS ChietKhauMon,
                            COALESCE(LaMonTang, FALSE) AS LaMonTang, LyDoTang,
                            COALESCE(DotGoi, 1) AS DotGoi, COALESCE(IsTakeaway, FALSE) AS IsTakeaway,
                            COALESCE(CourseNo, 1) AS CourseNo, COALESCE(FireStatus, 'FIRED') AS FireStatus, FiredAt,
                            GhiChu, TrangThaiPhaChe, ThoiGianGoi
                       FROM ChiTietHoaDon
                      WHERE MaHoaDon = $1 AND TrangThaiPhaChe <> 'DaHuy'
                      ORDER BY MaCTHD FOR UPDATE`,
                    [fromMaHoaDon]
                );

                let movedCups = 0;
                const transferredIds = [];

                for (const r of cthdRes.rows) {
                    const idStr = String(r.macthd);
                    if (!reqMap.has(idStr)) continue;
                    const origQty = Math.max(1, Number(r.soluong || 1));
                    const reqQty = reqMap.get(idStr);
                    const qtyMove = reqQty === null ? origQty : Math.min(origQty, reqQty);
                    if (qtyMove <= 0) continue;

                    if (qtyMove >= origQty) {
                        await client.query(
                            `UPDATE ChiTietHoaDon SET MaHoaDon = $1 WHERE MaCTHD = $2`,
                            [destMaHoaDon, r.macthd]
                        );
                        transferredIds.push(r.macthd);
                    } else {
                        const remainQty = origQty - qtyMove;
                        const splitDiscount = Math.round((Number(r.giagiam || 0) * qtyMove) / origQty);
                        const remainDiscount = Math.max(0, Number(r.giagiam || 0) - splitDiscount);
                        const splitCk = Math.round((Number(r.chietkhaumon || 0) * qtyMove) / origQty);
                        const remainCk = Math.max(0, Number(r.chietkhaumon || 0) - splitCk);

                        await client.query(
                            `UPDATE ChiTietHoaDon SET SoLuong = $2, GiaGiam = $3, ChietKhauMon = $4 WHERE MaCTHD = $1`,
                            [r.macthd, remainQty, remainDiscount, remainCk]
                        );

                        const cloned = await client.query(
                            `INSERT INTO ChiTietHoaDon
                                (MaHoaDon, MaMon, TenMonSnapshot, KichThuoc, SoLuong, DonGia, GiaGiam, GiaVonSnapshot,
                                 GiaModifiers, ModifiersSnapshot, ChietKhauMon, LaMonTang, LyDoTang,
                                 DotGoi, IsTakeaway, CourseNo, FireStatus, FiredAt, GhiChu, TrangThaiPhaChe, ThoiGianGoi)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
                             RETURNING MaCTHD`,
                            [
                                destMaHoaDon,
                                r.mamon,
                                r.tenmonsnapshot,
                                r.kichthuoc,
                                qtyMove,
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
                        const newMaCTHD = cloned.rows[0].macthd;
                        transferredIds.push(newMaCTHD);

                        // Nhân bản Topping theo đúng SoLuongMoiLy (KHÔNG chia lẻ thập phân, KHÔNG trừ kho lại!)
                        const tpRes = await client.query(
                            `SELECT MaTopping, TenToppingSnapshot, SoLuong,
                                    COALESCE(SoLuongMoiLy, 1) AS SoLuongMoiLy, DonGia,
                                    COALESCE(GiaVonToppingSnapshot, 0) AS GiaVonToppingSnapshot
                               FROM ChiTietHoaDon_Topping WHERE MaCTHD = $1 FOR UPDATE`,
                            [r.macthd]
                        );
                        for (const tp of tpRes.rows) {
                            const perCup = Math.max(1, Number(tp.soluongmoily || 1));
                            await client.query(
                                `UPDATE ChiTietHoaDon_Topping SET SoLuong = $3 WHERE MaCTHD = $1 AND MaTopping = $2`,
                                [r.macthd, tp.matopping, perCup * remainQty]
                            );
                            await client.query(
                                `INSERT INTO ChiTietHoaDon_Topping
                                    (MaCTHD, MaTopping, TenToppingSnapshot, SoLuong, SoLuongMoiLy, DonGia, GiaVonToppingSnapshot)
                                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                                [
                                    newMaCTHD,
                                    tp.matopping,
                                    tp.tentoppingsnapshot || null,
                                    perCup * qtyMove,
                                    perCup,
                                    Number(tp.dongia),
                                    Number(tp.giavontoppingsnapshot || 0),
                                ]
                            );
                        }
                    }
                    movedCups += qtyMove;
                }

                if (movedCups === 0) throw new LoiNghiepVu(400, 'Không có món hợp lệ nào để chuyển!');

                if (srcDaInTamTinh) {
                    await client.query(`UPDATE HoaDon SET DaInTamTinh = TRUE WHERE MaHoaDon = $1`, [destMaHoaDon]);
                    await ghiAuditLog(client, {
                        tenantId,
                        maNV: req.user.maNV,
                        vaiTro: req.user.vaiTro,
                        nguoiDuyet: prebillApprover,
                        hanhDong: 'PREBILL_ITEM_TRANSFER',
                        doiTuong: 'HOADON',
                        maDoiTuong: fromMaHoaDon,
                        giaTriMoi: {
                            fromMaHoaDon,
                            destMaHoaDon,
                            movedCups,
                            transferredIds,
                            daInTamTinhCopied: true,
                        },
                        lyDo: lyDo ? String(lyDo).trim().slice(0, 255) : 'Chuyển món từ hóa đơn đã in tạm tính',
                        ip: req.ip,
                        batBuoc: true,
                    });
                }

                // Tăng version hóa đơn đích & tính lại KM/Tổng tiền cả 2 hóa đơn
                await kiemTraVaTangVersionHoaDon(client, {
                    maHoaDon: destMaHoaDon,
                    tenantId,
                    expectedVersion: finalDestExpectedVersion,
                    mandatory: Boolean(finalDestExpectedVersion),
                    layHoaDonChiTiet,
                    LoiNghiepVu,
                });
                await recalculateInvoiceTotals(client, {
                    tenantId,
                    maHoaDon: destMaHoaDon,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    ip: req.ip,
                    ghiAuditLog,
                    kiemTraHopLeKhuyenMai,
                });

                // Edge Case dọn bàn nguồn: Nếu hóa đơn nguồn không còn món hoạt động nào & chưa có Order_Payments -> đóng sạch (TrangThaiTT = 3) & giải phóng bàn về 1=Trống + xoay QrToken!
                const remainRes = await client.query(
                    `SELECT COUNT(*)::int AS cnt FROM ChiTietHoaDon WHERE MaHoaDon = $1 AND TrangThaiPhaChe <> 'DaHuy'`,
                    [fromMaHoaDon]
                );
                let paidSrc = 0;
                if (paymentsSanSangRef()) {
                    const pSrc = await client.query(
                        `SELECT COALESCE(SUM(SoTien), 0) AS daThu FROM Order_Payments WHERE MaHoaDon = $1 AND TrangThai = 'PAID'`,
                        [String(fromMaHoaDon)]
                    );
                    paidSrc = Number(pSrc.rows[0]?.dathu || 0);
                }

                let sourceClosed = false;
                const freedSourceTables = [];
                if (Number(remainRes.rows[0]?.cnt || 0) === 0 && paidSrc <= 0) {
                    await client.query(
                        `UPDATE HoaDon SET TrangThaiTT = 3, MergedIntoMaHoaDon = $2 WHERE MaHoaDon = $1`,
                        [fromMaHoaDon, String(destMaHoaDon)]
                    );
                    sourceClosed = true;
                    for (const mb of srcBanIds) {
                        const otherOpen = await client.query(
                            `SELECT 1 FROM HoaDon_Ban hb JOIN HoaDon h ON h.MaHoaDon = hb.MaHoaDon
                              WHERE hb.MaBan = $1 AND h.TrangThaiTT = 0 AND h.MaHoaDon <> $2 LIMIT 1`,
                            [mb, fromMaHoaDon]
                        );
                        if (otherOpen.rows.length === 0) {
                            await client.query(`UPDATE Ban SET TrangThai = 1 WHERE MaBan = $1`, [mb]);
                            freedSourceTables.push(mb);
                        }
                    }
                    if (freedSourceTables.length > 0 && xoayQrTokenChoCacBan) {
                        await xoayQrTokenChoCacBan(client, freedSourceTables);
                    }
                } else {
                    await recalculateInvoiceTotals(client, {
                        tenantId,
                        maHoaDon: fromMaHoaDon,
                        maNV: req.user.maNV,
                        vaiTro: req.user.vaiTro,
                        ip: req.ip,
                        ghiAuditLog,
                        kiemTraHopLeKhuyenMai,
                    });
                }

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'ITEM_TRANSFER',
                    doiTuong: 'HOADON',
                    maDoiTuong: fromMaHoaDon,
                    giaTriMoi: {
                        toMaHoaDon: destMaHoaDon,
                        toMaBan,
                        movedCups,
                        transferredIds,
                        sourceClosed,
                        freedSourceTables,
                    },
                    ip: req.ip,
                    batBuoc: true,
                });

                return {
                    fromMaHoaDon,
                    toMaHoaDon: destMaHoaDon,
                    fromTenBan,
                    destTenBan,
                    movedCups,
                    transferredIds,
                    sourceClosed,
                    freedSourceTables,
                    destBanOpened,
                    hoaDonNguon: await layHoaDonChiTiet(client, fromMaHoaDon),
                    hoaDonDich: await layHoaDonChiTiet(client, destMaHoaDon),
                };
            }, tenantId);

            const transferBranchId = normalizeBranchId(
                ketQua.hoaDonDich?.branchId || ketQua.hoaDonNguon?.branchId || req.user?.branchId || 'DEFAULT'
            );
            for (const mb of ketQua.freedSourceTables) {
                emitToBranch(io, {
                    tenantId,
                    branchId: transferBranchId,
                    roles: ['POS', 'WAITER'],
                    event: 'BAN_THAY_DOI',
                    payload: {
                        maBan: mb,
                        trangThai: 1,
                    },
                });
            }
            if (ketQua.destBanOpened) {
                emitToBranch(io, {
                    tenantId,
                    branchId: transferBranchId,
                    roles: ['POS', 'WAITER'],
                    event: 'BAN_THAY_DOI',
                    payload: {
                        maBan: ketQua.destBanOpened,
                        trangThai: 2,
                    },
                });
            }
            emitScopedKdsEvent(io, {
                tenantId,
                branchId: transferBranchId,
                station: 'ALL',
                eventType: 'ITEM_TRANSFERRED',
                socketEvents: ['kds:item_transferred'],
                payload: {
                    fromMaHoaDon: ketQua.fromMaHoaDon,
                    toMaHoaDon: ketQua.toMaHoaDon,
                    fromTenBan: ketQua.fromTenBan,
                    toTenBan: ketQua.destTenBan,
                    transferredIds: ketQua.transferredIds,
                    transferredAt: new Date().toISOString(),
                },
                includeExpo: true,
                includeWaiter: true,
                includePos: true,
            });

            res.json({
                message: `🔄 Đã chuyển ${ketQua.movedCups} ly từ ${ketQua.fromTenBan} sang ${ketQua.destTenBan}${ketQua.sourceClosed ? ' (đã đóng sạch bàn nguồn)' : ''}!`,
                ...ketQua,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Chuyển món giữa các bàn:');
        }
    });

    // =========================================================================
    // 8. ALIAS POST /api/order/tach & QUẢN LÝ CHIA TIỀN (HoaDon_ChiaTien)
    // =========================================================================
    app.post('/api/order/tach', kiemTraToken, choPhepVaiTro(1, 4), (req, res) => {
        const maHoaDon = req.body?.maHoaDon || req.body?.fromMaHoaDon;
        if (!maHoaDon) return res.status(400).json({ message: 'Thiếu maHoaDon cần tách!' });
        req.params.maHoaDon = String(maHoaDon);
        return handleSplitOrder(req, res);
    });

    app.get('/api/order/:maHoaDon/chiatien', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const r = await qTenant(
                req,
                `SELECT id, mahoadon, nhanchia, sotienphaitra, sotiendatra, trangthai, thoigiantao
                   FROM hoadon_chiatien
                  WHERE tenantid = $1 AND mahoadon = $2::text AND trangthai <> 'CANCELLED'
                  ORDER BY id ASC`,
                [tenantId, String(req.params.maHoaDon)]
            );
            res.json(
                r.rows.map((x) => ({
                    id: Number(x.id),
                    maHoaDon: x.mahoadon,
                    nhanChia: x.nhanchia,
                    soTienPhaiTra: Number(x.sotienphaitra),
                    soTienDaTra: Number(x.sotiendatra || 0),
                    trangThai: x.trangthai,
                    thoiGianTao: x.thoigiantao,
                }))
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Lấy danh sách chia tiền hóa đơn:');
        }
    });

    app.delete('/api/order/:maHoaDon/chiatien', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const { maHoaDon } = req.params;
        try {
            await chayGiaoDich(async (client) => {
                const paid = await client.query(
                    `SELECT 1 FROM hoadon_chiatien
                      WHERE tenantid = $1 AND mahoadon = $2::text AND trangthai = 'PAID' LIMIT 1`,
                    [tenantId, String(maHoaDon)]
                );
                if (paid.rows.length > 0) {
                    throw new LoiNghiepVu(409, 'Đã có phần chia được thanh toán, không thể hủy bảng chia tiền!');
                }
                await client.query(
                    `UPDATE hoadon_chiatien SET trangthai = 'CANCELLED'
                      WHERE tenantid = $1 AND mahoadon = $2::text AND trangthai = 'UNPAID'`,
                    [tenantId, String(maHoaDon)]
                );
            }, tenantId);
            res.json({ message: 'Đã hủy bảng chia tiền tạm của hóa đơn!' });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Hủy chia tiền:');
        }
    });

    // =========================================================================
    // 9. DANH SÁCH THẺ RUNG VẬT LÝ (01..50) ĐANG RẢNH / BẬN
    // =========================================================================
    app.get('/api/pos/the-rung', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const total = Math.min(99, Math.max(10, Number(req.query.total || 30)));
        try {
            const busyRes = await qTenant(
                req,
                `SELECT DISTINCT hd.SoTheRung, hd.MaHoaDon, hd.SoThuTuHienThi
                   FROM HoaDon hd
                  WHERE COALESCE(hd.TenantId, 'DEFAULT') = $1
                    AND hd.SoTheRung IS NOT NULL
                    AND hd.SoTheRung <> ''
                    AND (
                        hd.TrangThaiTT = 0
                        OR EXISTS (
                            SELECT 1 FROM ChiTietHoaDon c
                             WHERE c.MaHoaDon = hd.MaHoaDon
                               AND c.TrangThaiPhaChe IN ('ChoPhaChe', 'DangLam')
                        )
                    )`,
                [tenantId]
            );
            const busyMap = new Map(busyRes.rows.map((r) => [String(r.sotherung).padStart(2, '0'), r]));
            const list = [];
            for (let i = 1; i <= total; i += 1) {
                const code = String(i).padStart(2, '0');
                const hit = busyMap.get(code) || busyMap.get(String(i));
                list.push({
                    soTheRung: code,
                    dangBan: Boolean(hit),
                    maHoaDon: hit?.mahoadon || null,
                });
            }
            res.json(list);
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Lấy danh sách Thẻ rung:');
        }
    });
}

module.exports = { registerFohPhase1Routes };
