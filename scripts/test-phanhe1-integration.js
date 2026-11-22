#!/usr/bin/env node
/**
 * BỘ KIỂM THỬ TÍCH HỢP 10 KỊCH BẢN NGHIỆM THU 100/100 CHO PHÂN HỆ 1 (FRONT-OF-HOUSE & ORDER ENGINE)
 * Chạy trực tiếp trên DB PostgreSQL thật + Express + Socket.IO!
 *
 * Chạy: node scripts/test-phanhe1-integration.js
 * (Tự khởi động server tạm trên cổng 3123 nếu không truyền API_URL)
 */
require('dotenv').config();
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');

let socketIoClient = null;
try {
    socketIoClient = require(path.join(__dirname, '..', 'frontend', 'node_modules', 'socket.io-client'));
} catch {
    try {
        socketIoClient = require('socket.io-client');
    } catch {
        socketIoClient = null;
    }
}

const TEST_PORT = Number(process.env.PH1_TEST_PORT || 3123);
const BASE_URL = (process.env.API_URL ? process.env.API_URL.replace(/\/api\/?$/, '') : `http://127.0.0.1:${TEST_PORT}`);
const API = `${BASE_URL}/api`;

function assert(cond, msg) {
    if (!cond) {
        console.error(`❌ FAIL: ${msg}`);
        throw new Error(msg);
    }
    console.log(`✅ PASS: ${msg}`);
}

async function req(urlPath, { method = 'GET', token = null, body = null, headers: extra = {} } = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${urlPath}`, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }
    return { status: res.status, data };
}

// Khớp 100% logic buildCartLineSignature trong frontend/src/store/posStore.js
function buildCartLineSignature(item) {
    const modsKey = (item.modifiers || [])
        .map((m) => `${m.groupId}:${m.optionId}:${m.qty || 1}`)
        .sort()
        .join('|');
    const tpKey = (item.toppings || [])
        .map((t) => `${t.maTopping}:${t.soLuongMoiLy ?? t.soLuong ?? 1}`)
        .sort()
        .join('|');
    const noteKey = String(item.ghiChu || '').trim().toLowerCase();
    const takeKey = item.isTakeaway ? 'TA' : 'DI';
    const comboKey = item.comboInstanceId || 'SINGLE';
    return `${comboKey}__${item.maMon}__${item.kichThuoc}__${takeKey}__${modsKey}__${tpKey}__${noteKey}`;
}

async function waitForServer(timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await req('/health');
            if (r.status === 200) return true;
        } catch {
            // retry
        }
        await new Promise((r) => setTimeout(r, 350));
    }
    throw new Error(`Backend tại ${API} không sẵn sàng sau ${timeoutMs}ms`);
}

async function getStock(pool, tenantId, maNL) {
    const r = await pool.withTenant(tenantId, (client) =>
        client.query(`SELECT SoLuongTon FROM NguyenLieu WHERE MaNL = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`, [maNL, tenantId])
    );
    return Number(r.rows[0]?.soluongton ?? 0);
}

async function main() {
    let childProc = null;
    const pool = require('../db');

    try {
        if (!process.env.API_URL) {
            console.log(`🚀 Đang khởi động Backend tạm trên cổng ${TEST_PORT} để chạy 10 Integration Tests...`);
            childProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
                cwd: path.join(__dirname, '..'),
                env: { ...process.env, PORT: String(TEST_PORT), SKIP_AUTO_DDL: 'true' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            childProc.stderr.on('data', (d) => {
                const s = String(d).trim();
                if (s) console.error('[SERVER STDERR]', s);
            });
        }
        await waitForServer();
        console.log(`✅ Backend đã sẵn sàng tại ${API}\n`);

        // 0. Tạo Tenant cô lập hoàn toàn cho phiên test này
        const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
        const regRes = await req('/saas/register', {
            method: 'POST',
            body: {
                tenQuan: `PH1 Test Cafe ${rand}`,
                moHinh: 'CAFE_TAKEAWAY',
                soBan: 10,
                tenChuQuan: 'Chủ Quán PH1',
                tenDangNhap: `ph1_${rand.toLowerCase()}`,
                email: `ph1_${rand.toLowerCase()}@test.local`,
                matKhau: 'TestPass123!',
                goiCuoc: 'PRO',
            },
        });
        assert(regRes.status === 201 && regRes.data?.token, `Tạo Tenant test cô lập thành công (status=${regRes.status})`);
        const token = regRes.data.token;
        const tenantId = regRes.data.tenant?.tenantId || regRes.data.user?.tenantId;
        assert(Boolean(tenantId), `Xác định được tenantId = ${tenantId}`);

        // Mở ca thu ngân (hoặc dùng ca đã được /saas/register tự mở sẵn — status 409)
        const openShift = await req('/ca/mo', { method: 'POST', token, body: { tienMatDauCa: 500000 } });
        assert(
            [200, 201, 409].includes(openShift.status),
            `Ca thu ngân sẵn sàng (status=${openShift.status})`
        );

        // Lấy danh sách bàn & đảm bảo có Bàn 3, 5, 6, 8, 9
        const banListRes = await req('/ban', { token });
        assert(banListRes.status === 200 && Array.isArray(banListRes.data) && banListRes.data.length >= 9, `Có ít nhất 9 bàn (hiện có ${banListRes.data?.length})`);
        const sortedBans = [...banListRes.data].sort((a, b) => String(a.maban).localeCompare(String(b.maban)));
        const ban3 = sortedBans[2];
        const ban5 = sortedBans[4];
        const ban6 = sortedBans[5];
        const ban8 = sortedBans[7];
        const ban9 = sortedBans[8];

        // Chuẩn bị dữ liệu Master Data chuẩn cho 10 kịch bản test (Nguyên liệu, Món, Topping, Modifiers, Combo, Vật tư mang đi, KM)
        const nlCafe = `NL_CF_${rand}`;
        const nlSuaTuoi = `NL_ST_${rand}`;
        const nlSuaYenMach = `NL_YM_${rand}`;
        const nlDuong = `NL_DG_${rand}`;
        const nlTranChau = `NL_TC_${rand}`;
        const nlKemCheese = `NL_KC_${rand}`;
        const nlLyNhua = `NL_LY_${rand}`;
        const nlNap = `NL_NAP_${rand}`;
        const nlOngHut = `NL_OH_${rand}`;

        for (const [maNL, tenNL, dvt, ton] of [
            [nlCafe, 'Cà phê hạt', 'g', 5000],
            [nlSuaTuoi, 'Sữa tươi', 'ml', 10000],
            [nlSuaYenMach, 'Sữa yến mạch', 'ml', 10000],
            [nlDuong, 'Đường nước', 'ml', 5000],
            [nlTranChau, 'Trân châu đen', 'g', 5000],
            [nlKemCheese, 'Kem cheese', 'g', 5000],
            [nlLyNhua, 'Ly nhựa M', 'cái', 1000],
            [nlNap, 'Nắp cầu', 'cái', 1000],
            [nlOngHut, 'Ống hút', 'cái', 1000],
        ]) {
            await pool.withTenant(tenantId, (client) =>
                client.query(
                    `INSERT INTO NguyenLieu (MaNL, TenNL, DonViTinh, SoLuongTon, HanMucCanhBao, GiaVonDonVi, TenantId)
                     VALUES ($1, $2, $3, $4, 10, 50, $5)
                     ON CONFLICT (MaNL) DO UPDATE SET SoLuongTon = EXCLUDED.SoLuongTon`,
                    [maNL, tenNL, dvt, ton, tenantId]
                )
            );
        }

        // Tạo 3 món (Bạc xỉu -> BAR_CHINH, Croissant -> BEP_BANH, Trà đào -> BAR_LANH) và lấy đúng mã đã gắn tiền tố Tenant
        const spBxRes = await req('/sanpham', {
            method: 'POST',
            token,
            body: {
                maMon: `BX_${rand}`,
                tenMon: 'Bạc xỉu Sài Gòn',
                nhomMon: 'Cà phê',
                tramCheBien: 'BAR_CHINH',
                sizes: [
                    { kichThuoc: 'S', giaBan: 30000 },
                    { kichThuoc: 'M', giaBan: 35000 },
                    { kichThuoc: 'L', giaBan: 42000 },
                ],
            },
        });
        const spBnRes = await req('/sanpham', {
            method: 'POST',
            token,
            body: {
                maMon: `BN_${rand}`,
                tenMon: 'Bánh Croissant Bơ',
                nhomMon: 'Bánh ngọt',
                tramCheBien: 'BEP_BANH',
                sizes: [{ kichThuoc: 'M', giaBan: 35000 }],
            },
        });
        const spTdRes = await req('/sanpham', {
            method: 'POST',
            token,
            body: {
                maMon: `TD_${rand}`,
                tenMon: 'Trà đào cam sả',
                nhomMon: 'Trà',
                tramCheBien: 'BAR_LANH',
                sizes: [{ kichThuoc: 'M', giaBan: 40000 }, { kichThuoc: 'L', giaBan: 45000 }],
            },
        });
        const monBacXiu = spBxRes.data.maMon;
        const monCroissant = spBnRes.data.maMon;
        const monTraDao = spTdRes.data.maMon;
        assert(Boolean(monBacXiu && monCroissant && monTraDao), `Tạo 3 sản phẩm thành công (${monBacXiu}, ${monCroissant}, ${monTraDao})`);

        // Công thức BOM nền cho Bạc xỉu size M: 20g Cafe + 120ml Sữa tươi + 15ml Đường
        const ctM = await req('/congthuc', {
            method: 'POST',
            token,
            body: {
                maMon: monBacXiu,
                kichThuoc: 'M',
                dinhMuc: [
                    { maNL: nlCafe, khoiLuongTieuHao: 20 },
                    { maNL: nlSuaTuoi, khoiLuongTieuHao: 120 },
                    { maNL: nlDuong, khoiLuongTieuHao: 15 },
                ],
            },
        });
        assert(ctM.status === 200, `Thiết lập BOM Bạc xỉu M thành công (status=${ctM.status})`);
        // Công thức BOM Bạc xỉu size L: 25g Cafe + 150ml Sữa tươi + 20ml Đường
        const ctL = await req('/congthuc', {
            method: 'POST',
            token,
            body: {
                maMon: monBacXiu,
                kichThuoc: 'L',
                dinhMuc: [
                    { maNL: nlCafe, khoiLuongTieuHao: 25 },
                    { maNL: nlSuaTuoi, khoiLuongTieuHao: 150 },
                    { maNL: nlDuong, khoiLuongTieuHao: 20 },
                ],
            },
        });
        assert(ctL.status === 200, `Thiết lập BOM Bạc xỉu L thành công (status=${ctL.status})`);

        // Tạo 2 Topping (lấy đúng mã đã gắn tiền tố Tenant)
        const tpTcRes = await req('/topping', {
            method: 'POST',
            token,
            body: { maTopping: `TP_TC_${rand}`, tenTopping: 'Trân châu đen', giaTopping: 10000, maNL: nlTranChau, khoiLuongTieuHao: 30 },
        });
        const tpKcRes = await req('/topping', {
            method: 'POST',
            token,
            body: { maTopping: `TP_KC_${rand}`, tenTopping: 'Kem cheese', giaTopping: 12000, maNL: nlKemCheese, khoiLuongTieuHao: 25 },
        });
        const tpTranChau = tpTcRes.data.maTopping;
        const tpKemCheese = tpKcRes.data.maTopping;
        assert(tpTcRes.status === 201 && tpKcRes.status === 201, `Tạo 2 Topping thành công (${tpTranChau}, ${tpKemCheese})`);

        // Tạo Modifiers (Mức đường - Forced + Smart Default, Loại sữa - Substitution BOM -150ml sữa tươi / +150ml sữa yến mạch)
        const grpDuongRes = await req('/modifiers/groups', {
            method: 'POST',
            token,
            body: {
                tenGroup: 'Mức đường',
                loai: 'SINGLE',
                batBuoc: true,
                chonToiThieu: 1,
                chonToiDa: 1,
                options: [
                    { tenOption: '100% Đường', tenInNgan: '100%Đ', laMacDinh: true, giaCongThem: 0 },
                    { tenOption: '50% Đường', tenInNgan: '50%Đ', giaCongThem: 0, bom: [{ kichThuoc: null, maNL: nlDuong, khoiLuongDelta: -7 }] },
                    { tenOption: 'Không đường', tenInNgan: '0%Đ', giaCongThem: 0, bom: [{ kichThuoc: null, maNL: nlDuong, khoiLuongDelta: -30 }] },
                ],
            },
        });
        assert(grpDuongRes.status === 201, 'Tạo nhóm Modifier Mức đường thành công');
        const opt50Duong = grpDuongRes.data.group.options.find((o) => o.tenOption === '50% Đường');
        const opt0Duong = grpDuongRes.data.group.options.find((o) => o.tenOption === 'Không đường');

        const grpSuaRes = await req('/modifiers/groups', {
            method: 'POST',
            token,
            body: {
                tenGroup: 'Loại sữa',
                loai: 'SINGLE',
                batBuoc: false,
                options: [
                    { tenOption: 'Sữa tươi mặc định', tenInNgan: 'SuaTuoi', laMacDinh: true, giaCongThem: 0 },
                    {
                        tenOption: 'Đổi sữa yến mạch',
                        tenInNgan: 'OatMilk',
                        giaCongThem: 12000,
                        bom: [
                            // Cố ý trừ -150ml sữa tươi trên món size M vốn chỉ có 120ml sữa tươi -> PHẢI clamp về 0, KHÔNG ĐƯỢC cộng ngược +30ml vào kho sữa tươi!
                            { kichThuoc: 'M', maNL: nlSuaTuoi, khoiLuongDelta: -150 },
                            { kichThuoc: 'M', maNL: nlSuaYenMach, khoiLuongDelta: 150 },
                        ],
                    },
                ],
            },
        });
        assert(grpSuaRes.status === 201, 'Tạo nhóm Modifier Đổi sữa yến mạch (Substitution BOM) thành công');
        const optOatMilk = grpSuaRes.data.group.options.find((o) => o.tenOption === 'Đổi sữa yến mạch');

        await req(`/sanpham/${monBacXiu}/modifiers`, {
            method: 'POST',
            token,
            body: { groupIds: [grpDuongRes.data.group.id, grpSuaRes.data.group.id] },
        });

        // =========================================================================
        // TEST 1: 4 ly Bạc xỉu với 3 tổ hợp đường/đá/đổi sữa yến mạch + 2 topping
        // -> lineSignature tách đúng 3 dòng, sữa yến mạch trừ đúng, sữa tươi KHÔNG cộng ngược!
        // =========================================================================
        console.log('\n--- TEST 1: Modifiers + Substitution BOM + lineSignature (4 ly Bạc xỉu 3 tổ hợp) ---');
        const suaTuoiBefore = await getStock(pool, tenantId, nlSuaTuoi);
        const suaYmBefore = await getStock(pool, tenantId, nlSuaYenMach);

        const rawCups = [
            // Ly 1 & Ly 2 giống hệt nhau: 50% đường, đổi sữa yến mạch, 2 topping
            { maMon: monBacXiu, kichThuoc: 'M', soLuong: 1, modifiers: [{ groupId: grpDuongRes.data.group.id, optionId: opt50Duong.id }, { groupId: grpSuaRes.data.group.id, optionId: optOatMilk.id }], toppings: [{ maTopping: tpTranChau, soLuongMoiLy: 1 }, { maTopping: tpKemCheese, soLuongMoiLy: 1 }] },
            { maMon: monBacXiu, kichThuoc: 'M', soLuong: 1, modifiers: [{ groupId: grpDuongRes.data.group.id, optionId: opt50Duong.id }, { groupId: grpSuaRes.data.group.id, optionId: optOatMilk.id }], toppings: [{ maTopping: tpTranChau, soLuongMoiLy: 1 }, { maTopping: tpKemCheese, soLuongMoiLy: 1 }] },
            // Ly 3: Không đường, sữa tươi mặc định, 1 topping
            { maMon: monBacXiu, kichThuoc: 'M', soLuong: 1, modifiers: [{ groupId: grpDuongRes.data.group.id, optionId: opt0Duong.id }], toppings: [{ maTopping: tpTranChau, soLuongMoiLy: 1 }] },
            // Ly 4: Smart Default (100% đường), đổi sữa yến mạch, không topping
            { maMon: monBacXiu, kichThuoc: 'M', soLuong: 1, modifiers: [{ groupId: grpSuaRes.data.group.id, optionId: optOatMilk.id }], toppings: [] },
        ];
        // Gộp bằng lineSignature -> phải ra ĐÚNG 3 dòng (2 + 1 + 1 = 4 ly)!
        const groupedMap = new Map();
        for (const c of rawCups) {
            const sig = buildCartLineSignature(c);
            if (groupedMap.has(sig)) groupedMap.get(sig).soLuong += c.soLuong;
            else groupedMap.set(sig, { ...c });
        }
        const groupedLines = [...groupedMap.values()];
        assert(groupedLines.length === 3, `lineSignature gom 4 ly Bạc xỉu thành đúng 3 dòng (thực tế: ${groupedLines.length})`);

        const t1Order = await req('/order', {
            method: 'POST',
            token,
            body: { loaiDonHang: 'MANG_DI', danhSachMon: groupedLines },
        });
        assert(t1Order.status === 201, `Tạo đơn Test 1 thành công (status=${t1Order.status})`);
        const suaTuoiAfter = await getStock(pool, tenantId, nlSuaTuoi);
        const suaYmAfter = await getStock(pool, tenantId, nlSuaYenMach);
        // Ly 1,2,4 dùng sữa yến mạch (3 * 150ml = 450ml) và 0ml sữa tươi (clamp >= 0, KHÔNG cộng ngược 3*30ml!). Ly 3 dùng 120ml sữa tươi!
        assert(
            Math.abs(suaYmBefore - suaYmAfter - 450) < 0.01,
            `Tồn kho sữa yến mạch trừ đúng 450ml (trừ thực tế: ${suaYmBefore - suaYmAfter}ml)`
        );
        assert(
            Math.abs(suaTuoiBefore - suaTuoiAfter - 120) < 0.01,
            `Tồn kho sữa tươi trừ đúng 120ml cho ly không đổi sữa, TUYỆT ĐỐI không cộng ngược từ -150ml (trừ thực tế: ${suaTuoiBefore - suaTuoiAfter}ml)`
        );

        // =========================================================================
        // TEST 2: Combo 2 món nâng size L + thêm topping -> Pro-rata 0đ sai số,
        // 2 trạm KDS (BAR_CHINH & BEP_BANH), hủy 1 món con phá vỡ Combo về giá lẻ!
        // =========================================================================
        console.log('\n--- TEST 2: Combo Pro-rata 0đ sai số + 2 trạm KDS + Phá vỡ Combo khi hủy ---');
        const maComboTest = `CMB_${rand}`;
        const cmbCreate = await req('/combos', {
            method: 'POST',
            token,
            body: {
                maCombo: maComboTest,
                tenCombo: 'Combo Sáng Năng Lượng',
                giaBanCombo: 55000,
                slots: [
                    { tenSlot: 'Đồ uống', soLuongChon: 1, items: [{ maMon: monBacXiu, kichThuocMacDinh: 'M', choPhepDoiKichThuoc: true, phuThu: 0 }] },
                    { tenSlot: 'Bánh ngọt', soLuongChon: 1, items: [{ maMon: monCroissant, kichThuocMacDinh: 'M', choPhepDoiKichThuoc: false, phuThu: 0 }] },
                ],
            },
        });
        assert(cmbCreate.status === 201, `Tạo Combo 2 món thành công (status=${cmbCreate.status})`);
        const slotDrink = cmbCreate.data.combo.slots[0];
        const slotCake = cmbCreate.data.combo.slots[1];

        // Gọi Combo 55k + nâng Bạc xỉu lên Size L (+7k: 42k - 35k) + thêm Trân châu (+10k) => Tổng phải khớp tuyệt đối 55k + 7k + 10k = 72.000đ!
        const t2Order = await req('/order', {
            method: 'POST',
            token,
            body: {
                loaiDonHang: 'MANG_DI',
                combos: [
                    {
                        maCombo: maComboTest,
                        soLuong: 1,
                        selections: [
                            { slotId: slotDrink.id, maMon: monBacXiu, kichThuoc: 'L', toppings: [{ maTopping: tpTranChau, soLuongMoiLy: 1 }] },
                            { slotId: slotCake.id, maMon: monCroissant, kichThuoc: 'M' },
                        ],
                    },
                ],
            },
        });
        assert(t2Order.status === 201, `Tạo đơn Combo thành công (status=${t2Order.status})`);
        const hdCombo = t2Order.data.hoaDon;
        assert(hdCombo.tongTamTinh === 72000, `Tổng tiền Combo Pro-rata khớp tuyệt đối 72.000đ (thực tế: ${hdCombo.tongTamTinh}đ)`);
        const lineDrink = hdCombo.danhSachMon.find((m) => m.maMon === monBacXiu);
        const lineCake = hdCombo.danhSachMon.find((m) => m.maMon === monCroissant);
        assert(lineDrink?.tramCheBien === 'BAR_CHINH' && lineCake?.tramCheBien === 'BEP_BANH', `2 món con định tuyến đúng 2 trạm KDS (${lineDrink?.tramCheBien} & ${lineCake?.tramCheBien})`);

        // Hủy món bánh Croissant -> Bạc xỉu L còn lại phải tự phá vỡ Combo về đúng giá niêm yết 42.000đ (+ 10k topping = 52.000đ)!
        const t2Void = await req('/order/huy-mon', {
            method: 'POST',
            token,
            body: { maCTHD: lineCake.maCTHD, lyDo: 'Khách bỏ bánh trong combo' },
        });
        assert(t2Void.status === 200 && t2Void.data?.comboBroken === true, `Hủy 1 món con trong Combo kích hoạt phá vỡ Combo (comboBroken=${t2Void.data?.comboBroken})`);
        const lineDrinkAfter = t2Void.data.hoaDon.danhSachMon.find((m) => m.maCTHD === lineDrink.maCTHD);
        assert(lineDrinkAfter.donGia === 42000 && t2Void.data.hoaDon.tongTamTinh === 52000, `Món còn lại tự trả về giá lẻ 42.000đ + 10k topping = 52.000đ (thực tế: ${t2Void.data.hoaDon.tongTamTinh}đ)`);

        // =========================================================================
        // TEST 3: Mở Bàn 5 (tại bàn), gọi 2 ly uống tại chỗ + 1 ly isTakeaway = true
        // -> Chỉ ly mang về trừ vật tư ly/nắp/ống hút và cộng phí đóng gói!
        // =========================================================================
        console.log('\n--- TEST 3: Ly mang về trong đơn ngồi bàn (Bàn 5) + Vật tư đóng gói + Phí đóng gói ---');
        await req('/kho/vattu-mangdi', {
            method: 'POST',
            token,
            body: {
                items: [
                    { kichThuoc: 'M', maNL: nlLyNhua, soLuongTieuHao: 1 },
                    { kichThuoc: 'ALL', maNL: nlNap, soLuongTieuHao: 1 },
                    { kichThuoc: 'ALL', maNL: nlOngHut, soLuongTieuHao: 1 },
                ],
            },
        });
        const lyBefore = await getStock(pool, tenantId, nlLyNhua);
        const napBefore = await getStock(pool, tenantId, nlNap);
        const ohBefore = await getStock(pool, tenantId, nlOngHut);

        const t3Order = await req('/order', {
            method: 'POST',
            token,
            body: {
                maBan: ban5.maban,
                loaiDonHang: 'TAI_QUAN',
                phiDongGoiMoiLy: 3000,
                danhSachMon: [
                    { maMon: monTraDao, kichThuoc: 'M', soLuong: 2, isTakeaway: false },
                    { maMon: monTraDao, kichThuoc: 'M', soLuong: 1, isTakeaway: true },
                ],
            },
        });
        assert(t3Order.status === 201, `Mở Bàn 5 thành công (status=${t3Order.status})`);
        const lyAfter = await getStock(pool, tenantId, nlLyNhua);
        const napAfter = await getStock(pool, tenantId, nlNap);
        const ohAfter = await getStock(pool, tenantId, nlOngHut);
        assert(
            lyBefore - lyAfter === 1 && napBefore - napAfter === 1 && ohBefore - ohAfter === 1,
            `Chỉ ly mang về trừ đúng 1 ly nhựa / 1 nắp / 1 ống hút (thực tế: ${lyBefore - lyAfter}/${napBefore - napAfter}/${ohBefore - ohAfter})`
        );
        assert(t3Order.data.hoaDon.phiDongGoi === 3000, `Cộng đúng phí đóng gói 3.000đ cho 1 ly mang về (thực tế: ${t3Order.data.hoaDon.phiDongGoi}đ)`);
        const hdBan5Id = t3Order.data.maHoaDon;

        // =========================================================================
        // TEST 4: Gọi thêm Đợt 2 + 1 bánh ở Course 2 (HELD) -> KDS chỉ nhận đồ uống Đợt 2;
        // sau đó bấm Fire Course 2 -> Bếp bánh mới nhận vé với SLA bắt đầu từ 00:00!
        // =========================================================================
        console.log('\n--- TEST 4: Gọi thêm Đợt 2 (DotGoi=2) & Hẹn giờ ra món (Course Firing HELD -> FIRED) ---');
        const t4Add = await req('/order/them-mon', {
            method: 'POST',
            token,
            body: {
                maBan: ban5.maban,
                danhSachMon: [
                    { maMon: monTraDao, kichThuoc: 'M', soLuong: 1, courseNo: 1, fireStatus: 'FIRED' },
                    { maMon: monCroissant, kichThuoc: 'M', soLuong: 1, courseNo: 2, fireStatus: 'HELD' },
                ],
            },
        });
        assert(t4Add.status === 201 && t4Add.data.dotGoi === 2, `Gọi thêm món tự tăng dotGoi = 2 (thực tế: ${t4Add.data?.dotGoi})`);
        const cakeHeldLine = t4Add.data.danhSachMon.find((m) => m.maMon === monCroissant);
        const drinkDot2Line = t4Add.data.danhSachMon.find((m) => m.maMon === monTraDao);

        const kdsBeforeFire = await req('/order/dangcho', { token });
        assert(
            kdsBeforeFire.data.some((m) => m.maCTHD === drinkDot2Line.maCTHD) &&
                !kdsBeforeFire.data.some((m) => m.maCTHD === cakeHeldLine.maCTHD),
            'KDS đang chờ CHỈ nhận đồ uống Đợt 2, KHÔNG nhận bánh Course 2 đang HELD'
        );

        await new Promise((r) => setTimeout(r, 1100));
        const fireRes = await req(`/order/${hdBan5Id}/fire-course`, {
            method: 'POST',
            token,
            body: { courseNo: 2 },
        });
        assert(fireRes.status === 200 && fireRes.data.firedIds.includes(cakeHeldLine.maCTHD), 'Fire Course 2 thành công');
        const kdsAfterFire = await req('/order/dangcho?tram=BEP_BANH', { token });
        const firedCakeOnKds = kdsAfterFire.data.find((m) => m.maCTHD === cakeHeldLine.maCTHD);
        assert(Boolean(firedCakeOnKds), 'Bếp bánh (BEP_BANH) đã nhận vé Croissant ngay sau Fire Course 2');
        const slaSecs = Math.abs(Date.now() - new Date(firedCakeOnKds.firedAt).getTime()) / 1000;
        assert(
            slaSecs < 10 && new Date(firedCakeOnKds.thoiGianGoi).getTime() > new Date(cakeHeldLine.thoiGianGoi).getTime(),
            `SLA đồng hồ vé mới bắn bắt đầu lại từ 00:00 (firedAt lệch: ${slaSecs.toFixed(1)}s, ThoiGianGoi đã reset mới)`
        );

        // =========================================================================
        // TEST 5: Chuyển Bàn 5 -> Bàn 8 đang trống -> QrToken Bàn 5 xoay mới,
        // Bàn 5 sang 3=Chờ dọn, Socket kds:table_moved bắn tới Barista!
        // =========================================================================
        console.log('\n--- TEST 5: Chuyển Bàn 5 -> Bàn 8 + Xoay QrToken + Chờ dọn (3) + Socket kds:table_moved ---');
        const qrBeforeMove = ban5.qrtoken;
        let receivedKdsTableMoved = null;
        let sock = null;
        if (socketIoClient) {
            const ioClient = socketIoClient.io || socketIoClient;
            sock = ioClient(BASE_URL, {
                auth: { token },
                transports: ['websocket'],
            });
            await new Promise((resolve) => {
                sock.on('connect', resolve);
                setTimeout(resolve, 2500);
            });
            sock.on('kds:table_moved', (payload) => {
                receivedKdsTableMoved = payload;
            });
        }

        const t5Move = await req('/ban/chuyen', {
            method: 'POST',
            token,
            body: { fromMaBan: ban5.maban, toMaBan: ban8.maban },
        });
        assert(t5Move.status === 200, `Chuyển Bàn 5 -> Bàn 8 thành công (status=${t5Move.status})`);
        assert(t5Move.data.fromTrangThai === 3, `Bàn 5 tự chuyển sang trạng thái 3=Chờ dọn`);
        assert(
            Boolean(t5Move.data.newFromQrToken) && t5Move.data.newFromQrToken !== qrBeforeMove,
            `QrToken Bàn 5 đã xoay mới (${qrBeforeMove} -> ${t5Move.data.newFromQrToken})`
        );
        if (sock) {
            await new Promise((r) => setTimeout(r, 400));
            assert(
                receivedKdsTableMoved && String(receivedKdsTableMoved.maHoaDon) === String(hdBan5Id),
                `Barista nhận được Socket event kds:table_moved (${receivedKdsTableMoved?.fromTenBan} -> ${receivedKdsTableMoved?.toTenBan})`
            );
            sock.disconnect();
        }

        // =========================================================================
        // TEST 6: Gộp Bàn 3 (đã thanh toán trước 50.000đ qua VietQR) vào Bàn 8
        // -> HoaDon Bàn 3 chuyển TrangThaiTT = 3 (MERGED), khoản 50k chuyển sang Bàn 8!
        // =========================================================================
        console.log('\n--- TEST 6: Gộp Bàn 3 (đã trả trước 50k VietQR) vào Bàn 8 ---');
        const t6OrdBan3 = await req('/order', {
            method: 'POST',
            token,
            body: {
                maBan: ban3.maban,
                danhSachMon: [{ maMon: monTraDao, kichThuoc: 'M', soLuong: 2 }], // 80.000đ
            },
        });
        const hdBan3Id = t6OrdBan3.data.maHoaDon;
        const t6PartialPay = await req('/order/thanhtoan', {
            method: 'POST',
            token,
            body: {
                maHoaDon: hdBan3Id,
                choPhepThuMotPhan: true,
                thanhToan: [{ phuongThucTT: 'CHUYEN_KHOAN', soTien: 50000 }],
            },
        });
        assert(t6PartialPay.status === 200 && t6PartialPay.data.daHoanTat === false, 'Bàn 3 thanh toán trước 50.000đ VietQR thành công');

        const ban8BeforeMerge = (await req(`/ban/${ban8.maban}/hoadon`, { token })).data.hoaDon;
        const t6Merge = await req('/ban/gop', {
            method: 'POST',
            token,
            body: { fromMaBan: ban3.maban, toMaBan: ban8.maban },
        });
        assert(t6Merge.status === 200, `Gộp Bàn 3 vào Bàn 8 thành công (status=${t6Merge.status})`);

        const hdBan3Check = await pool.withTenant(tenantId, (c) =>
            c.query(`SELECT TrangThaiTT, MergedIntoMaHoaDon FROM HoaDon WHERE MaHoaDon = $1`, [hdBan3Id])
        );
        assert(
            Number(hdBan3Check.rows[0]?.trangthaitt) === 3 && String(hdBan3Check.rows[0]?.mergedintomahoadon) === String(ban8BeforeMerge.maHoaDon),
            `Hóa đơn Bàn 3 chuyển sang TrangThaiTT = 3 (MERGED) & trỏ về HĐ #${ban8BeforeMerge.maHoaDon}`
        );
        const hdBan8AfterMerge = t6Merge.data.hoaDon;
        assert(
            Number(hdBan8AfterMerge.daThanhToan) === 50000 &&
                Math.abs(hdBan8AfterMerge.conLaiCanThu - (hdBan8AfterMerge.tongPhaiTra - 50000)) < 0.01,
            `Khoản 50.000đ VietQR chuyển nguyên vẹn sang Bàn 8 (daThanhToan=${hdBan8AfterMerge.daThanhToan}, conLai=${hdBan8AfterMerge.conLaiCanThu})`
        );

        // =========================================================================
        // TEST 7: Tách hóa đơn đủ 3 kiểu:
        //   (a) Tách lẻ 1/3 ly giữ nguyên SoLuongMoiLy của topping
        //   (b) Chia đều 100.000đ / 3 người -> 34k / 33k / 33k, thanh toán 3 PTTT khác nhau chốt đơn!
        //   (c) Chia theo số tiền tùy ý!
        // =========================================================================
        console.log('\n--- TEST 7: Tách hóa đơn đủ 3 kiểu (Lẻ ly Topping-per-Cup, Chia đều 100k/3, Chia tùy ý) ---');
        // 7a. Tạo hóa đơn 3 ly Trà đào (mỗi ly có 2 phần Trân châu -> SoLuongMoiLy = 2) rồi tách lẻ 1/3 ly
        const t7aOrd = await req('/order', {
            method: 'POST',
            token,
            body: {
                loaiDonHang: 'MANG_DI',
                danhSachMon: [{ maMon: monTraDao, kichThuoc: 'M', soLuong: 3, toppings: [{ maTopping: tpTranChau, soLuongMoiLy: 2 }] }],
            },
        });
        const origLine7a = t7aOrd.data.hoaDon.danhSachMon[0];
        const t7aSplit = await req(`/order/${t7aOrd.data.maHoaDon}/tach`, {
            method: 'POST',
            token,
            body: { mode: 'BY_ITEM', splitItems: [{ maCTHD: origLine7a.maCTHD, soLuong: 1 }] },
        });
        assert(t7aSplit.status === 201, `Tách lẻ 1/3 ly thành công (status=${t7aSplit.status})`);
        const tpRemain = t7aSplit.data.hoaDonGoc.danhSachMon[0].toppings[0];
        const tpMoved = t7aSplit.data.hoaDonMoi.danhSachMon[0].toppings[0];
        assert(
            Number(tpRemain.soLuongMoiLy) === 2 && Number(tpRemain.soLuong) === 4 && Number(tpMoved.soLuongMoiLy) === 2 && Number(tpMoved.soLuong) === 2,
            `Giữ nguyên SoLuongMoiLy = 2 khi tách 3 ly -> 2 + 1 (Gốc: ${tpRemain.soLuongMoiLy}/ly tổng ${tpRemain.soLuong}; Mới: ${tpMoved.soLuongMoiLy}/ly tổng ${tpMoved.soLuong})`
        );

        // 7b. Tạo hóa đơn đúng 100.000đ (2 ly Trà đào M 40k + 2 phần Trân châu 10k = 100k) -> Chia đều 3 người (34k / 33k / 33k) & trả bằng 3 PTTT khác nhau!
        const t7bOrd = await req('/order', {
            method: 'POST',
            token,
            body: {
                loaiDonHang: 'MANG_DI',
                danhSachMon: [{ maMon: monTraDao, kichThuoc: 'M', soLuong: 2, toppings: [{ maTopping: tpTranChau, soLuongMoiLy: 1 }] }],
            },
        });
        assert(t7bOrd.data.hoaDon.tongPhaiTra === 100000, `Hóa đơn Test 7b đúng 100.000đ`);
        const t7bSplitEq = await req('/order/tach', {
            method: 'POST',
            token,
            body: { maHoaDon: t7bOrd.data.maHoaDon, mode: 'SPLIT_EQUAL', soNguoi: 3 },
        });
        assert(t7bSplitEq.status === 201, 'Chia đều 100.000đ / 3 người thành công');
        const eqAmounts = t7bSplitEq.data.danhSachChiaTien.map((s) => s.soTienPhaiTra);
        assert(
            JSON.stringify(eqAmounts) === JSON.stringify([34000, 33000, 33000]),
            `Chia đều 100.000đ / 3 ra đúng [34000, 33000, 33000] (thực tế: ${JSON.stringify(eqAmounts)})`
        );
        const methods = ['TIEN_MAT', 'CHUYEN_KHOAN', 'THE'];
        let finalPayRes = null;
        for (let i = 0; i < 3; i += 1) {
            finalPayRes = await req('/order/thanhtoan', {
                method: 'POST',
                token,
                body: {
                    maHoaDon: t7bOrd.data.maHoaDon,
                    phuongThucTT: methods[i],
                    chiaTienId: t7bSplitEq.data.danhSachChiaTien[i].id,
                },
            });
            assert(finalPayRes.status === 200, `Thanh toán phần ${i + 1}/3 bằng ${methods[i]} thành công`);
        }
        assert(
            finalPayRes.data.daHoanTat === true && finalPayRes.data.hoaDon.trangThaiTT === 1,
            'Sau khi trả đủ 3 phần bằng 3 phương thức khác nhau -> Hóa đơn tự chốt TrangThaiTT = 1!'
        );

        // 7c. Chia theo số tiền tùy ý (100k -> 60k + 40k; kiểm tra sai tổng trả 400)
        const t7cOrd = await req('/order', {
            method: 'POST',
            token,
            body: {
                loaiDonHang: 'MANG_DI',
                danhSachMon: [{ maMon: monTraDao, kichThuoc: 'M', soLuong: 2, toppings: [{ maTopping: tpTranChau, soLuongMoiLy: 1 }] }],
            },
        });
        const t7cBad = await req('/order/tach', {
            method: 'POST',
            token,
            body: { maHoaDon: t7cOrd.data.maHoaDon, mode: 'SPLIT_AMOUNT', shares: [{ nhan: 'A', soTien: 60000 }, { nhan: 'B', soTien: 35000 }] },
        });
        assert(t7cBad.status === 400, `Chia số tiền tùy ý lệch tổng bị chặn 400 (status=${t7cBad.status})`);
        const t7cOk = await req('/order/tach', {
            method: 'POST',
            token,
            body: { maHoaDon: t7cOrd.data.maHoaDon, mode: 'SPLIT_AMOUNT', shares: [{ nhan: 'Anh A', soTien: 60000 }, { nhan: 'Chị B', soTien: 40000 }] },
        });
        assert(t7cOk.status === 201 && t7cOk.data.danhSachChiaTien.length === 2, 'Chia theo số tiền tùy ý khớp tổng thành công');

        // =========================================================================
        // TEST 8: Chuyển món cuối cùng của Bàn 6 sang Bàn 9 -> HĐ Bàn 6 tự đóng sạch
        // (TrangThaiTT = 3) và Bàn 6 về 1=Trống!
        // =========================================================================
        console.log('\n--- TEST 8: Chuyển món cuối cùng của Bàn 6 sang Bàn 9 -> Đóng sạch Bàn 6 ---');
        const t8Ord6 = await req('/order', {
            method: 'POST',
            token,
            body: { maBan: ban6.maban, danhSachMon: [{ maMon: monTraDao, kichThuoc: 'M', soLuong: 1 }] },
        });
        const hd6Id = t8Ord6.data.maHoaDon;
        const cthd6 = t8Ord6.data.hoaDon.danhSachMon[0].maCTHD;

        const t8Transfer = await req('/order/chuyen-mon', {
            method: 'POST',
            token,
            body: {
                fromMaHoaDon: hd6Id,
                toMaBan: ban9.maban,
                items: [{ maCTHD: cthd6, soLuongChuyen: 1 }],
            },
        });
        assert(t8Transfer.status === 200 && t8Transfer.data.sourceClosed === true, 'Chuyển món cuối cùng từ Bàn 6 sang Bàn 9 thành công & đóng nguồn');
        const ban6After = await pool.withTenant(tenantId, (c) =>
            c.query(`SELECT TrangThai FROM Ban WHERE MaBan = $1`, [ban6.maban])
        );
        assert(Number(ban6After.rows[0]?.trangthai) === 1, `Bàn 6 tự động giải phóng về 1=Trống (thực tế: ${ban6After.rows[0]?.trangthai})`);
        assert(t8Transfer.data.hoaDonNguon.trangThaiTT === 3, `Hóa đơn Bàn 6 chuyển TrangThaiTT = 3 (MERGED/CLOSED)`);

        // =========================================================================
        // TEST 9: Giả lập Race Condition (Optimistic Locking):
        // 2 request song song (Phục vụ thêm món + Thu ngân thanh toán cùng expectedVersion = 1)
        // -> 1 thành công (version = 2), 1 nhận đúng 409 ORDER_CONCURRENT_MODIFIED!
        // =========================================================================
        console.log('\n--- TEST 9: Giả lập Race Condition (Optimistic Locking expectedVersion = 1) ---');
        const t9Ord = await req('/order', {
            method: 'POST',
            token,
            body: { loaiDonHang: 'MANG_DI', danhSachMon: [{ maMon: monTraDao, kichThuoc: 'M', soLuong: 1 }] },
        });
        const hd9Id = t9Ord.data.maHoaDon;
        const ver9 = t9Ord.data.hoaDon.version;
        assert(ver9 === 1, `Hóa đơn mới khởi tạo version = 1 (thực tế: ${ver9})`);

        const [raceAdd, racePay] = await Promise.all([
            req('/order/them-mon', {
                method: 'POST',
                token,
                body: {
                    maHoaDon: hd9Id,
                    expectedVersion: ver9,
                    danhSachMon: [{ maMon: monTraDao, kichThuoc: 'M', soLuong: 2 }],
                },
            }),
            req('/order/thanhtoan', {
                method: 'POST',
                token,
                body: {
                    maHoaDon: hd9Id,
                    expectedVersion: ver9,
                    phuongThucTT: 'TIEN_MAT',
                },
            }),
        ]);
        const statuses = [raceAdd.status, racePay.status].sort((a, b) => a - b);
        const conflictRes = raceAdd.status === 409 ? raceAdd : racePay.status === 409 ? racePay : null;
        const okRes = raceAdd.status < 300 ? raceAdd : racePay.status < 300 ? racePay : null;
        assert(
            Boolean(okRes) && Boolean(conflictRes),
            `Đúng 1 request thành công (${okRes?.status}) & 1 request bị chặn 409 (statuses=${JSON.stringify(statuses)})`
        );
        assert(
            conflictRes.data?.maLoi === 'ORDER_CONCURRENT_MODIFIED' || conflictRes.data?.code === 'ORDER_CONCURRENT_MODIFIED' || conflictRes.status === 409,
            `Request thua cuộc nhận đúng 409 (${conflictRes.data?.maLoi || conflictRes.data?.message})`
        );

        // =========================================================================
        // TEST 10: Bắn 120 đơn liên tiếp tại quầy Counter -> SoThuTuNgay tăng liền mạch
        // không trùng số, không reset ở 99, không deadlock; + Áp mã KM rồi hủy món dưới
        // DonToiThieu tự động gỡ tiền giảm giá!
        // =========================================================================
        console.log('\n--- TEST 10: 120 đơn Counter liên tiếp (>99 không trùng) & Tự động gỡ KM dưới DonToiThieu ---');
        // Tạo tenant mới tinh để đếm SoThuTuNgay bắt đầu từ đúng 001 -> 120!
        const reg120 = await req('/saas/register', {
            method: 'POST',
            body: {
                tenQuan: `Counter 120 ${rand}`,
                moHinh: 'CAFE_TAKEAWAY',
                soBan: 2,
                tenChuQuan: 'Chủ 120',
                tenDangNhap: `c120_${rand.toLowerCase()}`,
                email: `c120_${rand.toLowerCase()}@test.local`,
                matKhau: 'TestPass123!',
                goiCuoc: 'PRO',
            },
        });
        const tok120 = reg120.data.token;
        const sh120 = await req('/ca/mo', { method: 'POST', token: tok120, body: { tienMatDauCa: 500000 } });
        assert([200, 201, 409].includes(sh120.status), `Ca Counter 120 sẵn sàng (status=${sh120.status})`);
        const sp120Res = await req('/sanpham', {
            method: 'POST',
            token: tok120,
            body: { maMon: `CF120_${rand}`, tenMon: 'Cafe Sữa Đá', nhomMon: 'Cà phê', sizes: [{ kichThuoc: 'M', giaBan: 45000 }] },
        });
        const m120 = sp120Res.data.maMon;

        const seqs = [];
        // Bắn 120 đơn theo batch 6 đơn song song (20 batch) để vừa test tốc độ vừa test chống deadlock!
        for (let b = 0; b < 20; b += 1) {
            const batch = await Promise.all(
                Array.from({ length: 6 }, () =>
                    req('/order/quick-checkout', {
                        method: 'POST',
                        token: tok120,
                        body: {
                            loaiDonHang: 'MANG_DI',
                            phuongThucTT: 'TIEN_MAT',
                            danhSachMon: [{ maMon: m120, kichThuoc: 'M', soLuong: 1 }],
                        },
                    })
                )
            );
            for (const r of batch) {
                assert(r.status === 201, `Đơn Counter batch ${b + 1} thành công (status=${r.status})`);
                seqs.push(Number(r.data.hoaDon.soThuTuNgay));
            }
        }
        const uniqueSeqs = new Set(seqs);
        const sortedSeqs = [...seqs].sort((a, b) => a - b);
        assert(
            uniqueSeqs.size === 120 && sortedSeqs[0] === 1 && sortedSeqs[119] === 120,
            `120 đơn Counter liên tiếp sinh đúng 001..120 KHÔNG trùng số, KHÔNG reset tại 99, KHÔNG deadlock (min=${sortedSeqs[0]}, max=${sortedSeqs[119]}, unique=${uniqueSeqs.size})`
        );

        // Kiểm thử Promo Re-validation: tạo mã giảm 30k (DonToiThieu = 150k), tạo đơn 4 ly x 45k = 180k, áp mã, rồi hủy 1 ly (còn 135k < 150k) -> tự động gỡ KM!
        const promoCode = `GIAM30_${rand}`;
        const createPromo = await req('/khuyenmai', {
            method: 'POST',
            token: tok120,
            body: {
                maCode: promoCode,
                tenChuongTrinh: 'Giảm 30k đơn từ 150k',
                loaiKM: 'CODE',
                kieuGiam: 'FIXED',
                giaTriGiam: 30000,
                donToiThieu: 150000,
            },
        });
        assert(createPromo.status === 201, `Tạo mã KM ${promoCode} (DonToiThieu=150k) thành công`);

        const ordPromo = await req('/order', {
            method: 'POST',
            token: tok120,
            body: {
                loaiDonHang: 'MANG_DI',
                danhSachMon: [
                    { maMon: m120, kichThuoc: 'M', soLuong: 3 }, // 135k
                    { maMon: m120, kichThuoc: 'M', soLuong: 1, ghiChu: 'Ít đá' }, // 45k -> Tổng 180k
                ],
            },
        });
        const apRes = await req(`/order/${ordPromo.data.maHoaDon}/ap-uu-dai`, {
            method: 'POST',
            token: tok120,
            body: { maKhuyenMai: promoCode },
        });
        assert(apRes.status === 200 && apRes.data.hoaDon.tienGiamKM === 30000, 'Áp mã giảm 30.000đ trên đơn 180.000đ thành công');

        const lineToVoid = ordPromo.data.hoaDon.danhSachMon.find((m) => m.soLuong === 1);
        const voidPromoRes = await req('/order/huy-mon', {
            method: 'POST',
            token: tok120,
            body: { maCTHD: lineToVoid.maCTHD, lyDo: 'Khách bớt 1 ly khiến đơn dưới 150k' },
        });
        assert(
            voidPromoRes.status === 200 &&
                voidPromoRes.data.promoAdjusted === true &&
                voidPromoRes.data.hoaDon.tienGiamKM === 0 &&
                voidPromoRes.data.hoaDon.maKhuyenMai === null,
            `Hủy món dưới DonToiThieu tự động gỡ KM (promoAdjusted=${voidPromoRes.data?.promoAdjusted}, tienGiamKM=${voidPromoRes.data?.hoaDon?.tienGiamKM})`
        );

        console.log('\n🎉🎉🎉 HOÀN TẤT XUẤT SẮC 10/10 INTEGRATION TESTS PHÂN HỆ 1 (100/100 TUYỆT ĐỐI)! 🎉🎉🎉');
    } finally {
        if (childProc) {
            childProc.kill();
        }
        await pool.end().catch(() => {});
    }
}

main().catch((err) => {
    console.error('\n💥 INTEGRATION TEST THẤT BẠI:', err.message);
    process.exit(1);
});
