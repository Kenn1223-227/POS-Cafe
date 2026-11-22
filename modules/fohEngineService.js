const crypto = require('crypto');

const VN_TZ = 'Asia/Ho_Chi_Minh';
const lam3 = (x) => Math.round(Number(x || 0) * 1000) / 1000;
const lam2 = (x) => Math.round(Number(x || 0) * 100) / 100;

function ngayHomNayVN(nowDate = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: VN_TZ }).format(nowDate);
}

// =============================================================================
// 1. GIÁ TOPPING LŨY TIẾN (TIERED PRICING)
// VD: giaBacThang = [{"tu":1,"gia":10000},{"tu":2,"gia":8000}]
// =============================================================================
function tinhGiaToppingBacThang(giaCoBan, giaBacThang, soLuongMoiLy = 1) {
    const qty = Math.max(1, Math.floor(Number(soLuongMoiLy || 1)));
    const basePrice = Math.max(0, Number(giaCoBan || 0));

    let tiers = [];
    if (Array.isArray(giaBacThang) && giaBacThang.length > 0) {
        tiers = giaBacThang
            .map((t) => ({
                tu: Math.max(1, Math.floor(Number(t?.tu || 1))),
                gia: Math.max(0, Number(t?.gia ?? basePrice)),
            }))
            .sort((a, b) => a.tu - b.tu);
    }

    if (tiers.length === 0) {
        return {
            tongTienMoiLy: lam2(basePrice * qty),
            donGiaBinhQuan: basePrice,
        };
    }

    let tong = 0;
    for (let u = 1; u <= qty; u += 1) {
        let giaUnit = basePrice;
        for (const t of tiers) {
            if (u >= t.tu) giaUnit = t.gia;
            else break;
        }
        tong += giaUnit;
    }

    return {
        tongTienMoiLy: lam2(tong),
        donGiaBinhQuan: lam2(tong / qty),
    };
}

// =============================================================================
// 2. MODIFIERS CÓ CẤU TRÚC (FORCED MODIFIERS, SMART DEFAULTS, FREE K, BOM DELTA)
// =============================================================================
function danhGiaModifiersChoMon({
    selectedModifiers = [],
    attachedGroupIds = [],
    groupMap = new Map(),
    optionMap = new Map(),
    optionBomMap = new Map(),
    kichThuoc = 'M',
    laOfflineSync = false,
    LoiNghiepVu = Error,
}) {
    const soldOutWarnings = [];
    const byGroup = new Map(); // groupId -> [{ option, qty }]

    // Chuẩn hóa danh sách chọn từ client
    for (const sel of Array.isArray(selectedModifiers) ? selectedModifiers : []) {
        const optId = Number(sel?.optionId ?? sel?.id);
        if (!Number.isInteger(optId) || optId <= 0) continue;
        const opt = optionMap.get(optId);
        if (!opt) {
            throw new LoiNghiepVu(400, `Tùy chọn modifier #${optId} không tồn tại!`);
        }
        const grp = groupMap.get(Number(opt.groupId));
        if (!grp || !grp.dangHoatDong) {
            throw new LoiNghiepVu(400, `Nhóm tùy chọn của "${opt.tenOption}" không còn hoạt động!`);
        }
        if (opt.tamHet) {
            if (laOfflineSync) {
                soldOutWarnings.push({
                    code: 'SYNC_SOLD_OUT_WARNING',
                    type: 'MODIFIER',
                    optionId: opt.id,
                    tenOption: opt.tenOption,
                });
            } else {
                throw new LoiNghiepVu(409, `Tùy chọn "${opt.tenOption}" hiện đang tạm hết (86)!`, {
                    maLoi: 'MODIFIER_TAM_HET',
                    optionId: opt.id,
                });
            }
        }
        const qty = Math.max(1, Math.floor(Number(sel?.qty ?? sel?.soLuong ?? 1)));
        if (qty > Number(opt.toiDaSoLuong || 1)) {
            throw new LoiNghiepVu(
                400,
                `Tùy chọn "${opt.tenOption}" chỉ cho phép chọn tối đa ${opt.toiDaSoLuong} mỗi ly!`
            );
        }
        const gId = Number(opt.groupId);
        if (!byGroup.has(gId)) byGroup.set(gId, []);
        const existing = byGroup.get(gId).find((x) => x.option.id === opt.id);
        if (existing) {
            existing.qty = Math.min(Number(opt.toiDaSoLuong || 1), existing.qty + qty);
        } else {
            byGroup.get(gId).push({ option: opt, qty });
        }
    }

    // Áp Smart Defaults & kiểm tra ràng buộc Forced Modifiers cho mọi nhóm gắn vào món
    const allRelevantGroups = new Set([
        ...attachedGroupIds.map((g) => Number(g)),
        ...byGroup.keys(),
    ]);

    for (const gId of allRelevantGroups) {
        const grp = groupMap.get(gId);
        if (!grp || !grp.dangHoatDong) continue;
        let list = byGroup.get(gId) || [];

        // Nếu nhóm bắt buộc hoặc cần tối thiểu mà chưa chọn -> tự động điền Smart Default (lamacdinh = true)
        const minReq = grp.batBuoc ? Math.max(1, Number(grp.chonToiThieu || 1)) : Number(grp.chonToiThieu || 0);
        if (list.length === 0 && minReq > 0) {
            const defaults = [...optionMap.values()]
                .filter((o) => Number(o.groupId) === gId && o.laMacDinh && !o.tamHet)
                .sort((a, b) => a.thuTuHienThi - b.thuTuHienThi);
            if (defaults.length > 0) {
                const takeCount = grp.loai === 'SINGLE' ? 1 : Math.min(defaults.length, Number(grp.chonToiDa || 1));
                list = defaults.slice(0, takeCount).map((o) => ({ option: o, qty: 1 }));
                byGroup.set(gId, list);
            }
        }

        const totalSelectedCount = list.reduce((s, x) => s + x.qty, 0);
        if (totalSelectedCount < minReq) {
            throw new LoiNghiepVu(
                400,
                `Vui lòng chọn ít nhất ${minReq} tùy chọn cho nhóm bắt buộc "${grp.tenGroup}"!`,
                { maLoi: 'MODIFIER_REQUIRED', groupId: gId }
            );
        }

        const maxAllowed = grp.loai === 'SINGLE' ? Math.max(1, Number(grp.chonToiDa || 1)) : Number(grp.chonToiDa || 1);
        if (grp.loai === 'SINGLE' && list.length > 1) {
            throw new LoiNghiepVu(400, `Nhóm "${grp.tenGroup}" chỉ cho phép chọn 1 tùy chọn!`);
        }
        if (totalSelectedCount > maxAllowed) {
            throw new LoiNghiepVu(
                400,
                `Nhóm "${grp.tenGroup}" chỉ cho phép chọn tối đa ${maxAllowed} tùy chọn!`
            );
        }
    }

    // Tính giá Modifiers (hỗ trợ soluongmienphi: miễn phí K lựa chọn đầu theo giá ASC) + BOM Deltas + Snapshot
    let giaModifiers = 0;
    const modifiersSnapshot = [];
    const bomDeltas = []; // [{ maNL, khoiLuongDelta }]

    for (const [gId, list] of byGroup.entries()) {
        const grp = groupMap.get(gId);
        if (!grp || list.length === 0) continue;

        const freeSlots = Math.max(0, Number(grp.soLuongMienPhi || 0));
        // Bung từng đơn vị có tính phí để sắp xếp ASC và trừ K phần miễn phí
        const expandedUnits = [];
        for (const item of list) {
            for (let i = 0; i < item.qty; i += 1) {
                expandedUnits.push({
                    optionId: item.option.id,
                    gia: Math.max(0, Number(item.option.giaCongThem || 0)),
                });
            }
        }
        expandedUnits.sort((a, b) => a.gia - b.gia);
        let freeRemaining = freeSlots;
        const freeCountByOption = new Map();
        for (const u of expandedUnits) {
            if (freeRemaining > 0 && u.gia > 0) {
                freeCountByOption.set(u.optionId, (freeCountByOption.get(u.optionId) || 0) + 1);
                freeRemaining -= 1;
            }
        }

        for (const { option, qty } of list) {
            const freeQty = freeCountByOption.get(option.id) || 0;
            const billedQty = Math.max(0, qty - freeQty);
            const optionPriceTotal = lam2(Number(option.giaCongThem || 0) * billedQty);
            giaModifiers = lam2(giaModifiers + optionPriceTotal);

            modifiersSnapshot.push({
                groupId: grp.id,
                tenGroup: grp.tenGroup,
                optionId: option.id,
                tenOption: option.tenOption,
                tenInNgan: option.tenInNgan || option.tenOption,
                qty,
                freeQty,
                giaCongThem: Number(option.giaCongThem || 0),
                thanhTien: optionPriceTotal,
            });

            // Gom Substitution BOM theo size (hoặc kichthuoc === null áp mọi size)
            const bomRows = optionBomMap.get(option.id) || [];
            const sizeSpecific = bomRows.filter((b) => b.kichThuoc && b.kichThuoc === kichThuoc);
            const universal = bomRows.filter((b) => !b.kichThuoc);
            const chosenBom = sizeSpecific.length > 0 ? sizeSpecific : universal;
            for (const b of chosenBom) {
                bomDeltas.push({
                    maNL: b.maNL,
                    khoiLuongDelta: Number(b.khoiLuongDelta || 0) * qty,
                });
            }
        }
    }

    return {
        giaModifiers: lam2(giaModifiers),
        modifiersSnapshot,
        bomDeltas,
        soldOutWarnings,
    };
}

// =============================================================================
// 3. TÍNH BOM 1 LY SAU SUBSTITUTION (CLAMP >= 0 CHỐNG CỘNG NGƯỢC KHO!)
// Công thức bắt buộc: max(0, BOM_size + sum(Delta_modifier)) + Topping BOM + Packaging BOM
// =============================================================================
function tinhBomMotLySauSubstitution({
    baseBomRows = [], // [{ maNL, khoiLuong, giaVonDonVi }]
    modifierDeltas = [], // [{ maNL, khoiLuongDelta }]
    toppingBomRows = [], // [{ maNL, khoiLuong, giaVonDonVi }]
    packagingBomRows = [], // [{ maNL, khoiLuong, giaVonDonVi }]
    giaVonNlMap = new Map(),
}) {
    const baseAndDelta = new Map();
    for (const r of baseBomRows) {
        if (!r?.maNL) continue;
        baseAndDelta.set(r.maNL, (baseAndDelta.get(r.maNL) || 0) + Number(r.khoiLuong || 0));
    }
    for (const d of modifierDeltas) {
        if (!d?.maNL) continue;
        baseAndDelta.set(d.maNL, (baseAndDelta.get(d.maNL) || 0) + Number(d.khoiLuongDelta || 0));
    }

    // Clamp từng nguyên liệu nền >= 0 để không bao giờ cộng ngược sữa/đường vào kho
    const perCupMap = new Map();
    for (const [maNL, netQty] of baseAndDelta.entries()) {
        const clamped = Math.max(0, lam3(netQty));
        if (clamped > 0) {
            perCupMap.set(maNL, clamped);
        }
    }

    // Cộng Topping BOM (trên 1 ly)
    for (const tb of toppingBomRows) {
        if (!tb?.maNL || !(Number(tb.khoiLuong) > 0)) continue;
        perCupMap.set(tb.maNL, lam3((perCupMap.get(tb.maNL) || 0) + Number(tb.khoiLuong)));
    }

    // Cộng Vật tư đóng gói mang đi (ly nhựa, nắp, ống hút, túi chữ T)
    for (const pk of packagingBomRows) {
        if (!pk?.maNL || !(Number(pk.khoiLuong) > 0)) continue;
        perCupMap.set(pk.maNL, lam3((perCupMap.get(pk.maNL) || 0) + Number(pk.khoiLuong)));
    }

    // Tính giá vốn 1 ly từ perCupMap
    const localCost = new Map(giaVonNlMap);
    for (const r of [...baseBomRows, ...toppingBomRows, ...packagingBomRows]) {
        if (r?.maNL && !localCost.has(r.maNL) && r.giaVonDonVi !== undefined) {
            localCost.set(r.maNL, Number(r.giaVonDonVi || 0));
        }
    }

    let giaVonMotLy = 0;
    for (const [maNL, qty] of perCupMap.entries()) {
        giaVonMotLy += qty * (Number(localCost.get(maNL) || 0));
    }

    return {
        perCupMap,
        giaVonMotLy: lam2(giaVonMotLy),
    };
}

// =============================================================================
// 4. ĐỘNG CƠ PHÂN BỔ DOANH THU COMBO PRO-RATA KHÔNG LỆCH 1 ĐỒNG
// =============================================================================
function phanBoGiaComboProRata(giaBanCombo, items = []) {
    const comboPrice = Math.max(0, Math.round(Number(giaBanCombo || 0)));
    if (!Array.isArray(items) || items.length === 0) return [];

    // Mỗi phần tử item đại diện cho 1 món con trong 1 bộ Combo (tính trên 1 bộ; nếu qty > 1 nhân sau)
    const weights = items.map((it) => Math.max(0, Number(it.giaLeCoBan ?? it.giaLe ?? 0)));
    const sumWeights = weights.reduce((s, w) => s + w, 0);

    const allocated = items.map((it, idx) => {
        const w = weights[idx];
        const baseAlloc =
            sumWeights > 0
                ? Math.floor((comboPrice * w) / sumWeights)
                : Math.floor(comboPrice / items.length);
        return baseAlloc;
    });

    const sumAllocated = allocated.reduce((s, a) => s + a, 0);
    const remainder = comboPrice - sumAllocated;

    if (remainder !== 0) {
        // Cộng phần dư vào món con có giá lẻ lớn nhất
        let maxIdx = 0;
        for (let i = 1; i < weights.length; i += 1) {
            if (weights[i] > weights[maxIdx]) maxIdx = i;
        }
        allocated[maxIdx] += remainder;
    }

    return items.map((it, idx) => {
        const phuThuSlot = Math.max(0, Number(it.phuThuSlot || 0));
        const phuThuNangSize = Math.max(0, Number(it.phuThuNangSize || 0));
        const donGiaPhanBo = allocated[idx];
        const donGiaCuoi = lam2(donGiaPhanBo + phuThuSlot + phuThuNangSize);
        const giaGocNiemYet = lam2(Number(it.giaLeThucTe ?? (weights[idx] + phuThuNangSize)));
        return {
            ...it,
            donGiaPhanBo,
            phuThuSlot,
            phuThuNangSize,
            donGia: donGiaCuoi,
            giaGocNiemYet,
        };
    });
}

// =============================================================================
// 5. CHIA ĐỀU N NGƯỜI THEO BỘI SỐ 1.000đ CHUẨN TIỀN MẶT VNĐ
// VD: 100.000đ / 3 -> [34.000, 33.000, 33.000]
// =============================================================================
function chiaDeuTienVND(conLai, soNguoi) {
    const n = Math.floor(Number(soNguoi || 0));
    const total = Math.round(Number(conLai || 0));
    if (n < 2 || total <= 0) return [];

    if (total >= n * 1000) {
        const base = Math.floor(total / n / 1000) * 1000;
        let rem = total - base * n;
        const shares = new Array(n).fill(base);
        let idx = 0;
        while (rem >= 1000) {
            shares[idx % n] += 1000;
            rem -= 1000;
            idx += 1;
        }
        if (rem > 0) {
            shares[0] += rem;
        }
        return shares;
    }

    const base = Math.floor(total / n);
    const rem = total - base * n;
    return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

// =============================================================================
// 6. KẾ TOÁN ĐƠN HÀNG SINGLE SOURCE OF TRUTH (VAT, PHÍ PV, ĐÓNG GÓI, LÀM TRÒN)
// =============================================================================
function tinhTongKeToanHoaDon({
    danhSachMon = [],
    tienGiamKM = 0,
    tienGiamDiem = 0,
    loaiDonHang = 'TAI_QUAN',
    phiPhucVuPhanTram = 0,
    phiDongGoi = 0,
    cachTinhThue = 'INCLUDED', // 'INCLUDED' | 'EXCLUDED' | 'NONE'
    thueVATPhanTram = 0,
    buocLamTron = 0, // 0 | 500 | 1000
}) {
    let tamTinhMon = 0;
    for (const m of danhSachMon) {
        if (m.daHuy || m.trangThaiPhaChe === 'DaHuy') continue;
        if (m.laMonTang) continue;
        const soLuong = Math.max(0, Number(m.soLuong || 0));
        const donGia = Number(m.donGia || 0);
        const giaModifiers = Number(m.giaModifiers || 0);
        const tongTopping = Array.isArray(m.toppings)
            ? m.toppings.reduce((s, t) => s + Number(t.soLuong || 0) * Number(t.donGia || 0), 0)
            : Number(m.tienTopping || 0);
        const chietKhauMon = Math.max(0, Number(m.chietKhauMon || 0));
        const giaGiam = Math.max(0, Number(m.giaGiam || 0));
        const lineAmt = Math.max(0, (donGia + giaModifiers) * soLuong + tongTopping - chietKhauMon - giaGiam);
        tamTinhMon += lineAmt;
    }
    tamTinhMon = lam2(tamTinhMon);

    const giamKM = Math.max(0, Number(tienGiamKM || 0));
    const giamDiem = Math.max(0, Number(tienGiamDiem || 0));
    const tongGiamGia = lam2(giamKM + giamDiem);
    const sauGiamGia = lam2(Math.max(0, tamTinhMon - tongGiamGia));

    const pvcPct = loaiDonHang === 'TAI_QUAN' ? Math.max(0, Number(phiPhucVuPhanTram || 0)) : 0;
    const tienPhiPhucVu = Math.round((sauGiamGia * pvcPct) / 100);
    const phiDongGoiClean = Math.max(0, Number(phiDongGoi || 0));

    const coSoTinhThue = lam2(sauGiamGia + tienPhiPhucVu + phiDongGoiClean);
    const vatPct = Math.max(0, Number(thueVATPhanTram || 0));
    const mode = String(cachTinhThue || 'INCLUDED').toUpperCase();

    let tienThueVAT = 0;
    let tongTruocLamTron = coSoTinhThue;
    if (mode === 'EXCLUDED' && vatPct > 0) {
        tienThueVAT = Math.round((coSoTinhThue * vatPct) / 100);
        tongTruocLamTron = lam2(coSoTinhThue + tienThueVAT);
    } else if (mode === 'INCLUDED' && vatPct > 0) {
        tienThueVAT = Math.round((coSoTinhThue * vatPct) / (100 + vatPct));
        tongTruocLamTron = coSoTinhThue;
    }

    let tienLamTron = 0;
    let tongPhaiTra = tongTruocLamTron;
    const step = Number(buocLamTron || 0);
    if (step > 0 && tongTruocLamTron > 0) {
        const rounded = Math.round(tongTruocLamTron / step) * step;
        tienLamTron = lam2(rounded - tongTruocLamTron);
        tongPhaiTra = lam2(rounded);
    }

    return {
        tamTinhMon,
        tongGiamGia,
        sauGiamGia,
        tienPhiPhucVu,
        phiDongGoi: phiDongGoiClean,
        coSoTinhThue,
        cachTinhThue: mode,
        thueVATPhanTram: vatPct,
        tienThueVAT,
        tienLamTron,
        tongPhaiTra,
    };
}

// =============================================================================
// 7. SỐ THỨ TỰ NGÀY KHÔNG TRÙNG (001..999+ — BỎ MODULO 99)
// =============================================================================
async function capSoThuTuNgayKhongTrung(client, tenantId = 'DEFAULT') {
    const tId = String(tenantId || 'DEFAULT');
    const todayVN = ngayHomNayVN();
    let seq = 1;

    await client.query('SAVEPOINT sp_daily_counter_v2');
    try {
        const r = await client.query(
            `INSERT INTO Tenant_Daily_Counter (TenantId, NgayVN, LastSeq)
             VALUES ($1, $2::date, 1)
             ON CONFLICT (TenantId, NgayVN)
             DO UPDATE SET LastSeq = Tenant_Daily_Counter.LastSeq + 1
             RETURNING LastSeq AS stt`,
            [tId, todayVN]
        );
        await client.query('RELEASE SAVEPOINT sp_daily_counter_v2');
        seq = Number(r.rows[0].stt);
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_daily_counter_v2').catch(() => {});
        const cntRes = await client.query(
            `SELECT COUNT(*)::int + 1 AS stt
               FROM HoaDon
              WHERE COALESCE(TenantId, 'DEFAULT') = $1
                AND ThoiGianTao >= ($2::timestamp AT TIME ZONE '${VN_TZ}')
                AND ThoiGianTao < (($2::date + 1)::timestamp AT TIME ZONE '${VN_TZ}')`,
            [tId, todayVN]
        );
        seq = Number(cntRes.rows[0]?.stt || 1);
    }

    const soThuTuHienThi = String(seq).padStart(3, '0');
    return { seq, soThuTuHienThi };
}

// =============================================================================
// 8. KHÓA LẠC QUAN (OPTIMISTIC LOCKING) CHỐNG RACE CONDITION
// =============================================================================
async function kiemTraVaTangVersionHoaDon(
    client,
    { maHoaDon, tenantId = 'DEFAULT', expectedVersion = null, layHoaDonChiTiet, LoiNghiepVu }
) {
    const hasExpected =
        expectedVersion !== undefined &&
        expectedVersion !== null &&
        String(expectedVersion).trim() !== '';

    await client.query('SAVEPOINT sp_hd_opt_lock');
    try {
        if (hasExpected) {
            const expInt = Number(expectedVersion);
            if (!Number.isInteger(expInt) || expInt < 1) {
                await client.query('RELEASE SAVEPOINT sp_hd_opt_lock');
                throw new LoiNghiepVu(400, 'expectedVersion phải là số nguyên dương!');
            }
            const upd = await client.query(
                `UPDATE HoaDon
                    SET Version = COALESCE(Version, 1) + 1
                  WHERE MaHoaDon = $1
                    AND COALESCE(TenantId, 'DEFAULT') = $2
                    AND COALESCE(Version, 1) = $3
                  RETURNING Version`,
                [maHoaDon, tenantId, expInt]
            );
            await client.query('RELEASE SAVEPOINT sp_hd_opt_lock');
            if (upd.rows.length === 0) {
                const latest = layHoaDonChiTiet ? await layHoaDonChiTiet(client, maHoaDon) : null;
                throw new LoiNghiepVu(
                    409,
                    `Hóa đơn #${maHoaDon} vừa được thiết bị khác cập nhật — vui lòng kiểm tra lại tổng tiền mới trước khi thao tác!`,
                    {
                        maLoi: 'ORDER_CONCURRENT_MODIFIED',
                        code: 'ORDER_CONCURRENT_MODIFIED',
                        expectedVersion: expInt,
                        currentVersion: latest?.version ?? null,
                        hoaDonMoiNhat: latest,
                    }
                );
            }
            return Number(upd.rows[0].version);
        }

        const upd = await client.query(
            `UPDATE HoaDon
                SET Version = COALESCE(Version, 1) + 1
              WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
              RETURNING Version`,
            [maHoaDon, tenantId]
        );
        await client.query('RELEASE SAVEPOINT sp_hd_opt_lock');
        return upd.rows[0] ? Number(upd.rows[0].version) : 1;
    } catch (err) {
        if (err && err.status) throw err;
        await client.query('ROLLBACK TO SAVEPOINT sp_hd_opt_lock').catch(() => {});
        return 1;
    }
}

// =============================================================================
// 9. TỰ ĐỘNG TÍNH LẠI TỔNG TIỀN, KIỂM ĐỊNH KHUYẾN MÃI & ĐIỂM LOYALTY (ACID)
// =============================================================================
async function recalculateInvoiceTotals(
    client,
    {
        tenantId = 'DEFAULT',
        maHoaDon,
        maNV = null,
        vaiTro = null,
        ip = null,
        ghiAuditLog = null,
        kiemTraHopLeKhuyenMai = null,
        VND_MOI_DIEM_DOI = 1000,
    }
) {
    const hdRes = await client.query(
        `SELECT MaHoaDon, TrangThaiTT, MaKH,
                MaKhuyenMai, TenKhuyenMai,
                COALESCE(TienGiamKM, 0) AS TienGiamKM,
                COALESCE(DiemSuDung, 0) AS DiemSuDung,
                COALESCE(TienGiamDiem, 0) AS TienGiamDiem,
                COALESCE(to_jsonb(HoaDon)->>'loaidonhang', 'TAI_QUAN') AS LoaiDonHang,
                COALESCE((to_jsonb(HoaDon)->>'phidonggoi')::numeric, 0) AS PhiDongGoi,
                COALESCE(to_jsonb(HoaDon)->>'cachtinhthue', 'INCLUDED') AS CachTinhThue,
                COALESCE((to_jsonb(HoaDon)->>'thuevatphantram')::numeric, 0) AS ThueVATPhanTram,
                COALESCE((to_jsonb(HoaDon)->>'phiphucvuphantram')::numeric, 0) AS PhiPhucVuPhanTram
           FROM HoaDon
          WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
        [maHoaDon, tenantId]
    );
    if (hdRes.rows.length === 0) return { promoAdjusted: false, totals: null };
    const hd = hdRes.rows[0];

    // Đọc các dòng món còn hiệu lực
    const monRes = await client.query(
        `SELECT c.MaCTHD, c.SoLuong, c.DonGia,
                COALESCE(c.GiaGiam, 0) AS GiaGiam,
                COALESCE((to_jsonb(c)->>'giamodifiers')::numeric, 0) AS GiaModifiers,
                COALESCE((to_jsonb(c)->>'chietkhaumon')::numeric, 0) AS ChietKhauMon,
                COALESCE((to_jsonb(c)->>'lamontang')::boolean, FALSE) AS LaMonTang,
                c.TrangThaiPhaChe,
                COALESCE((SELECT SUM(t.SoLuong * t.DonGia)
                            FROM ChiTietHoaDon_Topping t
                           WHERE t.MaCTHD = c.MaCTHD), 0) AS TienTopping
           FROM ChiTietHoaDon c
          WHERE c.MaHoaDon = $1 AND c.TrangThaiPhaChe <> 'DaHuy'`,
        [maHoaDon]
    );

    const monList = monRes.rows.map((r) => ({
        soLuong: Number(r.soluong || 0),
        donGia: Number(r.dongia || 0),
        giaGiam: Number(r.giagiam || 0),
        giaModifiers: Number(r.giamodifiers || 0),
        chietKhauMon: Number(r.chietkhaumon || 0),
        laMonTang: Boolean(r.lamontang),
        tienTopping: Number(r.tientopping || 0),
        trangThaiPhaChe: r.trangthaiphache,
    }));

    const baseCalc = tinhTongKeToanHoaDon({
        danhSachMon: monList,
        loaiDonHang: hd.loaidonhang,
        phiPhucVuPhanTram: Number(hd.phiphucvuphantram || 0),
        phiDongGoi: Number(hd.phidonggoi || 0),
        cachTinhThue: hd.cachtinhthue,
        thueVATPhanTram: Number(hd.thuevatphantram || 0),
    });
    const tamTinhMoi = baseCalc.tamTinhMon;

    let promoAdjusted = false;
    const promoAdjustReasons = [];

    let newMaKM = hd.makhuyenmai || null;
    let newTenKM = hd.tenkhuyenmai || null;
    let newTienGiamKM = Number(hd.tiengiamkm || 0);
    let newDiemSuDung = Number(hd.diemsudung || 0);
    let newTienGiamDiem = Number(hd.tiengiamdiem || 0);

    // Kiểm định lại Khuyến mãi đang gắn
    if (newMaKM || newTienGiamKM > 0) {
        let kmRow = null;
        if (newMaKM && newMaKM !== 'HAPPY_HOUR') {
            await client.query('SAVEPOINT sp_reval_km');
            try {
                const kmRes = await client.query(
                    `SELECT * FROM KhuyenMai
                      WHERE TenantId = $1 AND UPPER(MaCode) = UPPER($2)
                      LIMIT 1`,
                    [tenantId, newMaKM]
                );
                await client.query('RELEASE SAVEPOINT sp_reval_km');
                kmRow = kmRes.rows[0] || null;
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_reval_km').catch(() => {});
            }
        }

        if (kmRow && typeof kiemTraHopLeKhuyenMai === 'function') {
            // Lưu ý: lượt dùng hiện tại đã tính đơn này, nên khi re-validate bỏ qua check gioiHanLuotDung bằng bản sao
            const kmCheckCopy = {
                ...kmRow,
                soluotdadung: Math.max(0, Number(kmRow.soluotdadung || 0) - 1),
            };
            const evalRes = kiemTraHopLeKhuyenMai(kmCheckCopy, tamTinhMoi);
            if (!evalRes.hopLe) {
                // Không còn thỏa DonToiThieu hoặc điều kiện KM -> tự động gỡ & trả lượt dùng!
                await client.query(
                    `UPDATE KhuyenMai
                        SET SoLuotDaDung = GREATEST(0, COALESCE(SoLuotDaDung, 0) - 1)
                      WHERE Id = $1`,
                    [kmRow.id]
                ).catch(() => {});
                promoAdjusted = true;
                promoAdjustReasons.push(`Đã tự động gỡ mã "${newMaKM}" (${evalRes.lyDo})`);
                newMaKM = null;
                newTenKM = null;
                newTienGiamKM = 0;
            } else if (Math.abs(evalRes.tienGiam - newTienGiamKM) > 0.01) {
                promoAdjusted = true;
                promoAdjustReasons.push(
                    `Đã tính lại mức giảm mã "${newMaKM}" từ ${newTienGiamKM.toLocaleString('vi-VN')}đ → ${evalRes.tienGiam.toLocaleString('vi-VN')}đ`
                );
                newTienGiamKM = evalRes.tienGiam;
            }
        } else if (tamTinhMoi < newTienGiamKM) {
            promoAdjusted = true;
            newTienGiamKM = Math.max(0, tamTinhMoi);
            if (newTienGiamKM === 0) {
                newMaKM = null;
                newTenKM = null;
            }
            promoAdjustReasons.push('Đã điều chỉnh tiền giảm KM không vượt quá tạm tính mới');
        }
    }

    // Kiểm định lại Điểm Loyalty (tránh TongTamTinh - TienGiamKM < TienGiamDiem)
    const maxForPoints = Math.max(0, tamTinhMoi - newTienGiamKM);
    if (newDiemSuDung > 0 && newTienGiamDiem > maxForPoints) {
        const maxPointsAllowed = Math.floor(maxForPoints / VND_MOI_DIEM_DOI);
        const refundPoints = Math.max(0, newDiemSuDung - maxPointsAllowed);
        if (refundPoints > 0 && hd.makh) {
            await client.query(
                `UPDATE KhachHang
                    SET DiemTichLuy = COALESCE(DiemTichLuy, 0) + $1
                  WHERE MaKH = $2 AND COALESCE(TenantId, 'DEFAULT') = $3`,
                [refundPoints, hd.makh, tenantId]
            );
        }
        newDiemSuDung = maxPointsAllowed;
        newTienGiamDiem = maxPointsAllowed * VND_MOI_DIEM_DOI;
        promoAdjusted = true;
        promoAdjustReasons.push(`Đã hoàn lại ${refundPoints} điểm Loyalty thừa cho khách`);
    }

    const totals = tinhTongKeToanHoaDon({
        danhSachMon: monList,
        tienGiamKM: newTienGiamKM,
        tienGiamDiem: newTienGiamDiem,
        loaiDonHang: hd.loaidonhang,
        phiPhucVuPhanTram: Number(hd.phiphucvuphantram || 0),
        phiDongGoi: Number(hd.phidonggoi || 0),
        cachTinhThue: hd.cachtinhthue,
        thueVATPhanTram: Number(hd.thuevatphantram || 0),
    });

    await client.query('SAVEPOINT sp_recalc_hd_upd');
    try {
        await client.query(
            `UPDATE HoaDon
                SET MaKhuyenMai = $2,
                    TenKhuyenMai = $3,
                    TienGiamKM = $4,
                    DiemSuDung = $5,
                    TienGiamDiem = $6,
                    TienPhiPhucVu = $7,
                    TienThueVAT = $8,
                    TienLamTron = $9
              WHERE MaHoaDon = $1`,
            [
                maHoaDon,
                newMaKM,
                newTenKM,
                newTienGiamKM,
                newDiemSuDung,
                newTienGiamDiem,
                totals.tienPhiPhucVu,
                totals.tienThueVAT,
                totals.tienLamTron,
            ]
        );
        await client.query('RELEASE SAVEPOINT sp_recalc_hd_upd');
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_recalc_hd_upd').catch(() => {});
        await client.query(
            `UPDATE HoaDon
                SET MaKhuyenMai = $2,
                    TenKhuyenMai = $3,
                    TienGiamKM = $4,
                    DiemSuDung = $5,
                    TienGiamDiem = $6
              WHERE MaHoaDon = $1`,
            [maHoaDon, newMaKM, newTenKM, newTienGiamKM, newDiemSuDung, newTienGiamDiem]
        ).catch(() => {});
    }

    if (promoAdjusted && typeof ghiAuditLog === 'function') {
        await ghiAuditLog(client, {
            tenantId,
            maNV: maNV || 'SYSTEM',
            vaiTro,
            hanhDong: 'PROMO_REVALIDATED_ON_CHANGE',
            doiTuong: 'HOADON',
            maDoiTuong: maHoaDon,
            giaTriCu: {
                maKhuyenMai: hd.makhuyenmai,
                tienGiamKM: Number(hd.tiengiamkm || 0),
                diemSuDung: Number(hd.diemsudung || 0),
                tienGiamDiem: Number(hd.tiengiamdiem || 0),
            },
            giaTriMoi: {
                maKhuyenMai: newMaKM,
                tienGiamKM: newTienGiamKM,
                diemSuDung: newDiemSuDung,
                tienGiamDiem: newTienGiamDiem,
                tamTinhMoi,
            },
            lyDo: promoAdjustReasons.join('; '),
            ip,
        });
    }

    return {
        promoAdjusted,
        promoAdjustReasons,
        totals,
    };
}

// =============================================================================
// 10. PHÁ VỠ COMBO KHI HỦY 1 MÓN CON (CHỐNG GIAN LẬN MUA COMBO RỒI HỦY MÓN ĐẮT)
// =============================================================================
async function phaVoComboKhiHuyMon(
    client,
    { tenantId = 'DEFAULT', maHoaDon, comboGroupUid, maCTHDHuy, maNV, vaiTro, ip, ghiAuditLog }
) {
    if (!comboGroupUid) return { comboBroken: false, updatedSiblings: [] };

    const sibRes = await client.query(
        `SELECT MaCTHD, MaMon, TenMonSnapshot, DonGia,
                COALESCE(GiaGocNiemYet, DonGia) AS GiaGocNiemYet,
                MaCombo, TenComboSnapshot
           FROM ChiTietHoaDon
          WHERE MaHoaDon = $1
            AND ComboGroupUid = $2
            AND MaCTHD <> $3
            AND TrangThaiPhaChe <> 'DaHuy'
          FOR UPDATE`,
        [maHoaDon, comboGroupUid, maCTHDHuy]
    );

    if (sibRes.rows.length === 0) return { comboBroken: false, updatedSiblings: [] };

    const updatedSiblings = [];
    for (const s of sibRes.rows) {
        const giaLe = Number(s.giagocniemyet || s.dongia || 0);
        const giaCu = Number(s.dongia || 0);
        await client.query(
            `UPDATE ChiTietHoaDon
                SET DonGia = $2,
                    ComboGroupUid = NULL,
                    MaCombo = NULL,
                    TenComboSnapshot = NULL
              WHERE MaCTHD = $1`,
            [s.macthd, giaLe]
        );
        updatedSiblings.push({
            maCTHD: s.macthd,
            tenMon: s.tenmonsnapshot || s.mamon,
            donGiaCu: giaCu,
            donGiaMoi: giaLe,
        });
    }

    if (typeof ghiAuditLog === 'function') {
        await ghiAuditLog(client, {
            tenantId,
            maNV,
            vaiTro,
            hanhDong: 'COMBO_BROKEN_ON_VOID',
            doiTuong: 'HOADON',
            maDoiTuong: maHoaDon,
            giaTriCu: {
                comboGroupUid,
                maCombo: sibRes.rows[0]?.macombo || null,
                maCTHDHuy,
            },
            giaTriMoi: {
                updatedSiblings,
            },
            lyDo: `Phá vỡ Combo do hủy 1 món con (#${maCTHDHuy}) — chuyển ${updatedSiblings.length} món còn lại về giá niêm yết`,
            ip,
            batBuoc: true,
        });
    }

    return { comboBroken: true, updatedSiblings };
}

function taoComboGroupUid() {
    return `CMB-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

module.exports = {
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
    lam2,
    lam3,
};
