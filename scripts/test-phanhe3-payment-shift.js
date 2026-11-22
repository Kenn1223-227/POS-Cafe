/**
 * =============================================================================
 * PHÂN HỆ 3 (82 -> 100/100) — 12 BÀI TEST TÍCH HỢP TỰ ĐỘNG BẮT BUỘC
 * Kiểm thử trực tiếp trên PostgreSQL (app_runtime NOBYPASSRLS) + Express Server
 * =============================================================================
 */
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const pool = require(path.join(__dirname, '..', 'db'));

const TEST_PORT = 3403;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, endpoint, { token = null, body = null, headers = {} } = {}) {
    const hdrs = { 'Content-Type': 'application/json', ...headers };
    if (token) hdrs.Authorization = `Bearer ${token}`;
    const res = await fetch(`${BASE_URL}${endpoint}`, {
        method,
        headers: hdrs,
        body: body !== null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = text;
    }
    return { status: res.status, ok: res.ok, data };
}

async function waitForHealth(url, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(url);
            if (r.ok) return;
        } catch {
            // retry
        }
        await sleep(300);
    }
    throw new Error(`Timeout chờ Backend API tại ${url}`);
}

async function registerFreshTenant(tag) {
    const rand = `${tag}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const reg = await api('POST', '/api/saas/register', {
        body: {
            tenQuan: `PH3 Test Cafe ${rand}`,
            moHinh: 'CAFE_TAKEAWAY',
            soBan: 5,
            tenChuQuan: `Chu Quan ${tag}`,
            tenDangNhap: `ph3_${rand.toLowerCase()}`,
            email: `ph3_${rand.toLowerCase()}@test.local`,
            matKhau: 'TestPass123!',
            goiCuoc: 'PRO',
        },
    });
    assert.strictEqual(reg.status, 201, `Đăng ký tenant ${tag} thất bại: ${JSON.stringify(reg.data)}`);
    const tenantId = reg.data.tenant?.tenantId || reg.data.user?.tenantId;
    const slug = reg.data.tenant?.slug || reg.data.user?.tenantSlug || reg.data.slug || tenantId;
    assert(tenantId && slug, `Thiếu tenantId/slug khi đăng ký: ${JSON.stringify(reg.data)}`);
    return {
        rand,
        token: reg.data.token,
        tenantId,
        slug,
        user: reg.data.user,
    };
}

async function main() {
    console.log('🚀 Khởi động Backend tạm cho 12 bài test Phân hệ 3 (Payment, VietQR, Blind Shift & Z-Report)...\n');
    const serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(TEST_PORT), NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let serverLogs = '';
    serverProc.stdout.on('data', (d) => (serverLogs += d.toString()));
    serverProc.stderr.on('data', (d) => (serverLogs += d.toString()));

    const qTenantDb = (tId, sql, params = []) => pool.withTenant(tId, (c) => c.query(sql, params));
    let passed = 0;
    const totalTests = 12;

    const runTest = async (num, title, fn) => {
        try {
            await fn();
            passed += 1;
            console.log(`✅ [Test ${num}/${totalTests}] PASS — ${title}`);
        } catch (err) {
            console.error(`❌ [Test ${num}/${totalTests}] FAIL — ${title}`);
            console.error('   Chi tiết:', err.stack || err.message);
            throw err;
        }
    };

    try {
        await waitForHealth(`${BASE_URL}/api/health`);

        // Tạo Tenant chính + cấu hình Bank SePay riêng
        const t1 = await registerFreshTenant('MAIN');
        const { token, tenantId, slug, rand } = t1;
        const sepayKey1 = `SEPAY_KEY_${rand}`;
        const accNo1 = `11112222${Math.floor(10 + Math.random() * 89)}`;

        const bankCfg1 = await api('PUT', '/api/settings/bank', {
            token,
            body: { bankId: 'MB', accountNo: accNo1, accountName: 'QUAN TEST 1', sepayApiKey: sepayKey1 },
        });
        assert.strictEqual(bankCfg1.status, 200, `Cấu hình Bank T1 thất bại: ${JSON.stringify(bankCfg1.data)}`);

        // Đảm bảo có ca mở
        const openCa = await api('POST', '/api/ca/mo-ca', { token, body: { tienMatDauCa: 500000 } });
        assert([200, 201, 409].includes(openCa.status));

        // Tạo các món giá chuẩn: 135k, 85k, 45k, 155k, 65k
        const makeItem = async (code, name, price) => {
            const r = await api('POST', '/api/sanpham', {
                token,
                body: { maMon: `${code}_${rand}`, tenMon: name, nhomMon: 'Cà phê', sizes: [{ kichThuoc: 'M', giaBan: price }] },
            });
            assert.strictEqual(r.status, 200, `Tạo món ${code} thất bại: ${JSON.stringify(r.data)}`);
            return r.data.maMon;
        };
        const sp135 = await makeItem('M135', 'Combo VIP 135k', 135000);
        const sp85 = await makeItem('M85', 'Matcha Special 85k', 85000);
        const sp45 = await makeItem('M45', 'Cà phê muối 45k', 45000);
        const sp155 = await makeItem('M155', 'Set Bánh Nước 155k', 155000);
        const sp65 = await makeItem('M65', 'Cold Brew Cam 65k', 65000);

        const getCurrentShiftDoiSoat = async () => {
            const r = await api('GET', '/api/ca/doi-soat', { token });
            assert.strictEqual(r.status, 200, JSON.stringify(r.data));
            return r.data.doiSoat;
        };

        // =====================================================================
        // TEST 1: Split Tender 3 phương thức + Tiền thừa
        // =====================================================================
        await runTest(1, 'Split Tender 3 phương thức (50k Ví + 50k CK + 35k TM khách đưa 50k thối 15k)', async () => {
            const khRes = await api('POST', '/api/khachhang', {
                token,
                body: { tenKH: 'Khách Ví VIP', soDienThoai: `091${Math.floor(1000000 + Math.random() * 8999999)}` },
            });
            const maKH = khRes.data.khachHang.makh || khRes.data.khachHang.maKH;
            // Nạp 100.000đ vào Ví khách
            await qTenantDb(tenantId, `UPDATE KhachHang SET SoDuVi = 100000 WHERE MaKH = $1`, [maKH]);

            const dsBefore = await getCurrentShiftDoiSoat();
            const ord = await api('POST', '/api/order', {
                token,
                body: { maKH, danhSachMon: [{ maMon: sp135, kichThuoc: 'M', soLuong: 1 }] },
            });
            assert.strictEqual(ord.status, 201);
            const maHD = ord.data.maHoaDon;

            const pay = await api('POST', '/api/order/thanhtoan', {
                token,
                body: {
                    maHoaDon: maHD,
                    maKH,
                    payments: [
                        { phuongThucTT: 'VI_KHACH', soTien: 50000 },
                        { phuongThucTT: 'CHUYEN_KHOAN', soTien: 50000 },
                        { phuongThucTT: 'TIEN_MAT', soTien: 35000, tienKhachDua: 50000 },
                    ],
                },
            });
            assert.strictEqual(pay.status, 200, JSON.stringify(pay.data));
            assert.strictEqual(pay.data.daHoanTat, true);
            assert.strictEqual(pay.data.tienThua, 15000, `Tiền thừa phải là 15000, thực tế ${pay.data.tienThua}`);

            const khAfter = await qTenantDb(tenantId, `SELECT SoDuVi FROM KhachHang WHERE MaKH = $1`, [maKH]);
            assert.strictEqual(Number(khAfter.rows[0].soduvi), 50000, 'SoDuVi phải giảm đúng 50.000đ (100k -> 50k)');

            const opRows = await qTenantDb(tenantId, `SELECT PhuongThucTT, SoTien FROM Order_Payments WHERE MaHoaDon = $1::text AND TrangThai = 'PAID'`, [String(maHD)]);
            assert.strictEqual(opRows.rows.length, 3, 'Order_Payments phải ghi đủ 3 dòng phương thức!');

            const dsAfter = await getCurrentShiftDoiSoat();
            assert.strictEqual(
                dsAfter.tienMatLyThuyet - dsBefore.tienMatLyThuyet,
                35000,
                `TienMatLyThuyet chỉ được cộng đúng 35.000đ (không cộng 50k khách đưa), thực tế: ${dsAfter.tienMatLyThuyet - dsBefore.tienMatLyThuyet}`
            );
        });

        // =====================================================================
        // TEST 2: Double-Payment Race Condition (VietQR vs. Tiền mặt)
        // =====================================================================
        await runTest(2, 'Double-Payment Race Condition — bắn đồng thời Webhook SePay & Tiền mặt -> 1 bên chốt, Webhook trễ vào PENDING_ACTION', async () => {
            // 2A. Bắn song song thật (Promise.all)
            const ord = await api('POST', '/api/order', {
                token,
                body: { danhSachMon: [{ maMon: sp85, kichThuoc: 'M', soLuong: 1 }] },
            });
            const maHD = ord.data.maHoaDon;

            const [cashRes, whRes] = await Promise.all([
                api('POST', '/api/order/thanhtoan', {
                    token,
                    body: { maHoaDon: maHD, phuongThucTT: 'TIEN_MAT', tienKhachDua: 85000 },
                }),
                api('POST', `/api/webhooks/sepay/${encodeURIComponent(slug)}`, {
                    headers: { Authorization: `Apikey ${sepayKey1}` },
                    body: {
                        id: `RACE_${Date.now()}`,
                        transferType: 'in',
                        transferAmount: 85000,
                        accountNumber: accNo1,
                        content: `POSHD${maHD}`,
                    },
                }),
            ]);

            const opSum = await qTenantDb(
                tenantId,
                `SELECT COALESCE(SUM(SoTien), 0) AS tong FROM Order_Payments WHERE MaHoaDon = $1::text AND TrangThai = 'PAID'`,
                [String(maHD)]
            );
            assert.strictEqual(Number(opSum.rows[0].tong), 85000, 'Tuyệt đối không được cộng đúp doanh thu 170k!');
            assert(
                (cashRes.status === 200 && whRes.data?.trangThaiXuLyDu === 'PENDING_ACTION') ||
                    (whRes.data?.trangThaiXuLy === 'MATCHED_PAID' && cashRes.status === 409 && cashRes.data?.code === 'ALREADY_PAID'),
                `Kết quả race không chuẩn: cash=${cashRes.status} (${JSON.stringify(cashRes.data)}), wh=${JSON.stringify(whRes.data)}`
            );

            // 2B. Xác nhận chắc chắn nhánh Webhook đến sau 50ms khi Tiền mặt đã chốt -> ALREADY_PAID + PENDING_ACTION
            const ord2 = await api('POST', '/api/order', {
                token,
                body: { danhSachMon: [{ maMon: sp85, kichThuoc: 'M', soLuong: 1 }] },
            });
            const maHD2 = ord2.data.maHoaDon;
            const c2 = await api('POST', '/api/order/thanhtoan', {
                token,
                body: { maHoaDon: maHD2, phuongThucTT: 'TIEN_MAT', tienKhachDua: 85000 },
            });
            assert.strictEqual(c2.status, 200);
            await sleep(50);
            const wh2 = await api('POST', `/api/webhooks/sepay/${encodeURIComponent(slug)}`, {
                headers: { Authorization: `Apikey ${sepayKey1}` },
                body: {
                    id: `LATE_${Date.now()}`,
                    transferType: 'in',
                    transferAmount: 85000,
                    accountNumber: accNo1,
                    content: `POSHD${maHD2}`,
                },
            });
            assert.strictEqual(wh2.status, 200);
            assert.strictEqual(wh2.data.trangThaiXuLy, 'ALREADY_PAID');
            assert.strictEqual(wh2.data.trangThaiXuLyDu, 'PENDING_ACTION');
            assert.strictEqual(wh2.data.soTienConLai, 85000);
        });

        // =====================================================================
        // TEST 3: Cross-Shift Partial Refund (Bán Ca A -> Chốt Ca A -> Hoàn 45k ở Ca B)
        // =====================================================================
        await runTest(3, 'Cross-Shift Partial Refund — Z-Report Ca A bất biến 0đ sai lệch, TienMatLyThuyet Ca B giảm đúng 45k', async () => {
            const ord = await api('POST', '/api/order/quick-checkout', {
                token,
                body: {
                    phuongThucTT: 'TIEN_MAT',
                    danhSachMon: [
                        { maMon: sp155, kichThuoc: 'M', soLuong: 1 },
                        { maMon: sp45, kichThuoc: 'M', soLuong: 1 },
                    ],
                },
            });
            assert.strictEqual(ord.status, 201);
            const maHD = ord.data.maHoaDon;
            const cthd45 = ord.data.hoaDon.danhSachMon.find((m) => m.maMon === sp45).maCTHD;

            // Chốt Ca A đúng quỹ lý thuyết (đóng băng ZReportSnapshot!)
            const dsBeforeCloseA = await getCurrentShiftDoiSoat();
            const maCaA = dsBeforeCloseA.maCaThuNgan;
            const closeA = await api('POST', '/api/ca/dong-ca', {
                token,
                body: {
                    tienMatThucTe: dsBeforeCloseA.tienMatLyThuyet,
                    tienGiuLaiKet: 500000,
                },
            });
            assert.strictEqual(closeA.status, 200, JSON.stringify(closeA.data));
            const snapExpectedCashA = closeA.data.zReportSnapshot.cashFlow.expectedCash;
            const snapNetSalesA = closeA.data.zReportSnapshot.sales.netSales;

            // Mở Ca B (đầu ca 500k khớp bàn giao Ca A)
            const openB = await api('POST', '/api/ca/mo-ca', { token, body: { tienMatDauCa: 500000 } });
            assert.strictEqual(openB.status, 201, JSON.stringify(openB.data));
            const dsBeforeRefundB = await getCurrentShiftDoiSoat();

            // Hoàn tiền mặt 45.000đ cho 1 ly của hóa đơn Ca A ngay trong Ca B
            const ref = await api('POST', `/api/order/${encodeURIComponent(maHD)}/hoan-tien`, {
                token,
                body: {
                    lyDo: 'Khách khiếu nại pha nhầm ở ca sáng',
                    phuongThucHoan: 'TIEN_MAT',
                    dsMaCTHDHoan: [cthd45],
                },
            });
            assert.strictEqual(ref.status, 200, JSON.stringify(ref.data));
            assert.strictEqual(ref.data.tongHoan, 45000);

            // Kiểm tra 1: Z-Report Ca A hoàn toàn bất biến (0đ thay đổi!)
            const dsAAfter = (await api('GET', `/api/ca/doi-soat?maCaThuNgan=${encodeURIComponent(maCaA)}`, { token })).data.doiSoat;
            assert.strictEqual(dsAAfter.isFrozenSnapshot, true);
            assert.strictEqual(dsAAfter.tienMatLyThuyet, snapExpectedCashA, 'Quỹ Ca A không được đổi 1 đồng!');
            assert.strictEqual(dsAAfter.doanhThu.tong, snapNetSalesA, 'Doanh thu Ca A không được đổi 1 đồng!');

            // Kiểm tra 2: TienMatLyThuyet Ca B giảm đúng 45.000đ!
            const dsBAfter = await getCurrentShiftDoiSoat();
            assert.strictEqual(dsBeforeRefundB.tienMatLyThuyet - dsBAfter.tienMatLyThuyet, 45000);
        });

        // =====================================================================
        // TEST 4: VietQR Overpayment (100k cho HĐ 85k) -> Thối 15k tiền mặt
        // =====================================================================
        await runTest(4, 'VietQR Overpayment -> Thối 15k tiền mặt (sinh phiếu loại 4 THOI_CK_DU, trừ quỹ 15k)', async () => {
            const ord = await api('POST', '/api/order', {
                token,
                body: { danhSachMon: [{ maMon: sp85, kichThuoc: 'M', soLuong: 1 }] },
            });
            const maHD = ord.data.maHoaDon;
            const dsBefore = await getCurrentShiftDoiSoat();

            const wh = await api('POST', `/api/webhooks/sepay/${encodeURIComponent(slug)}`, {
                headers: { Authorization: `Apikey ${sepayKey1}` },
                body: {
                    id: `OVER_${Date.now()}`,
                    transferType: 'in',
                    transferAmount: 100000,
                    accountNumber: accNo1,
                    content: `POSHD${maHD}`,
                },
            });
            assert.strictEqual(wh.status, 200);
            assert.strictEqual(wh.data.tienChuyenThua, 15000);
            assert.strictEqual(wh.data.trangThaiXuLyDu, 'PENDING_ACTION');

            const opCheck = await qTenantDb(tenantId, `SELECT SoTien, TienChuyenThua FROM Order_Payments WHERE MaHoaDon = $1::text`, [String(maHD)]);
            assert.strictEqual(Number(opCheck.rows[0].sotien), 85000);
            assert.strictEqual(Number(opCheck.rows[0].tienchuyenthua), 15000);

            // Thu ngân bấm Thối 15k tiền mặt từ két
            const resOver = await api('POST', '/api/vietqr/resolve-overpayment', {
                token,
                body: { webhookEventId: wh.data.webhookEventId, action: 'CASH_RETURNED' },
            });
            assert.strictEqual(resOver.status, 200, JSON.stringify(resOver.data));
            assert(resOver.data.maPhieuTC, 'Phải sinh phiếu PhieuThuChiLatVat loại 4!');

            const ptcCheck = await qTenantDb(tenantId, `SELECT LoaiPhieu, SoTien FROM PhieuThuChiLatVat WHERE MaPhieuTC = $1`, [resOver.data.maPhieuTC]);
            assert.strictEqual(Number(ptcCheck.rows[0].loaiphieu), 4);
            assert.strictEqual(Number(ptcCheck.rows[0].sotien), 15000);

            const dsAfter = await getCurrentShiftDoiSoat();
            assert.strictEqual(dsBefore.tienMatLyThuyet - dsAfter.tienMatLyThuyet, 15000);
        });

        // =====================================================================
        // TEST 5: VietQR Underpayment (40k cho HĐ 45k) -> Thu bù 5k tiền mặt
        // =====================================================================
        await runTest(5, 'VietQR Underpayment -> giữ TrangThaiTT=0, conLai=5k, thu bù 5k tiền mặt chốt đơn', async () => {
            const ord = await api('POST', '/api/order', {
                token,
                body: { danhSachMon: [{ maMon: sp45, kichThuoc: 'M', soLuong: 1 }] },
            });
            const maHD = ord.data.maHoaDon;

            const wh = await api('POST', `/api/webhooks/sepay/${encodeURIComponent(slug)}`, {
                headers: { Authorization: `Apikey ${sepayKey1}` },
                body: {
                    id: `UNDER_${Date.now()}`,
                    transferType: 'in',
                    transferAmount: 40000,
                    accountNumber: accNo1,
                    content: `POSHD${maHD}`,
                },
            });
            assert.strictEqual(wh.status, 200);
            assert.strictEqual(wh.data.trangThaiXuLy, 'PARTIAL_PAID');
            assert.strictEqual(wh.data.daHoanTat, false);
            assert.strictEqual(wh.data.conLai, 5000);

            const hdMid = await qTenantDb(tenantId, `SELECT TrangThaiTT FROM HoaDon WHERE MaHoaDon = $1`, [maHD]);
            assert.strictEqual(Number(hdMid.rows[0].trangthaitt), 0);

            // Thu nốt 5.000đ tiền mặt
            const payRest = await api('POST', '/api/order/thanhtoan', {
                token,
                body: { maHoaDon: maHD, phuongThucTT: 'TIEN_MAT', tienKhachDua: 5000 },
            });
            assert.strictEqual(payRest.status, 200);
            assert.strictEqual(payRest.data.daHoanTat, true);
            assert.strictEqual(payRest.data.hoaDon.trangThaiTT, 1);
        });

        // =====================================================================
        // TEST 6: VietQR Unmatched Anti-Recycling (FOR UPDATE chặn 2 đơn khớp chung 1 giao dịch NH)
        // =====================================================================
        await runTest(6, 'VietQR Unmatched Anti-Recycling — 2 request khớp song song vào 2 HĐ -> đúng 1 khớp 200, 1 bị chặn 409', async () => {
            const ordA = await api('POST', '/api/order', { token, body: { danhSachMon: [{ maMon: sp65, kichThuoc: 'M', soLuong: 1 }] } });
            const ordB = await api('POST', '/api/order', { token, body: { danhSachMon: [{ maMon: sp65, kichThuoc: 'M', soLuong: 1 }] } });

            // Nhận 1 webhook UNMATCHED 65.000đ (khách xóa mã HĐ)
            const whUnm = await api('POST', `/api/webhooks/sepay/${encodeURIComponent(slug)}`, {
                headers: { Authorization: `Apikey ${sepayKey1}` },
                body: {
                    id: `UNM_${Date.now()}`,
                    transferType: 'in',
                    transferAmount: 65000,
                    accountNumber: accNo1,
                    content: 'NGUYEN VAN A CHUYEN TIEN CAFE',
                },
            });
            assert.strictEqual(whUnm.status, 200);
            assert.strictEqual(whUnm.data.trangThaiXuLy, 'UNMATCHED');
            const evId = whUnm.data.webhookEventId;
            assert(evId > 0);

            const [m1, m2] = await Promise.all([
                api('POST', '/api/vietqr/match-unmatched', { token, body: { webhookEventId: evId, maHoaDon: ordA.data.maHoaDon } }),
                api('POST', '/api/vietqr/match-unmatched', { token, body: { webhookEventId: evId, maHoaDon: ordB.data.maHoaDon } }),
            ]);
            const okCount = [m1, m2].filter((r) => r.status === 200).length;
            const conflictCount = [m1, m2].filter((r) => r.status === 409).length;
            assert.strictEqual(okCount, 1, `Phải đúng 1 đơn khớp thành công, thực tế: ${m1.status}, ${m2.status}`);
            assert.strictEqual(conflictCount, 1, `Đơn còn lại phải bị chặn 409 chống Bill Recycling!`);

            // Dọn đơn còn lại (thanh toán tiền mặt để tránh mở treo sang bài sau)
            const openOrd = m1.status === 200 ? ordB.data.maHoaDon : ordA.data.maHoaDon;
            await api('POST', '/api/order/thanhtoan', { token, body: { maHoaDon: openOrd, phuongThucTT: 'TIEN_MAT', tienKhachDua: 65000 } });
        });

        // =====================================================================
        // TEST 7: Multi-Tenant Webhook Isolation (Cùng mã FT263260001 trên 2 quán & 2 STK khác nhau)
        // =====================================================================
        await runTest(7, 'Multi-Tenant Webhook Isolation — 2 Tenant cùng nhận mã FT263260001 trên 2 STK -> cả 2 đều chốt đơn độc lập', async () => {
            const t2 = await registerFreshTenant('TEN2');
            const sepayKey2 = `SEPAY_KEY_${t2.rand}`;
            const accNo2 = `99998888${Math.floor(10 + Math.random() * 89)}`;
            await api('PUT', '/api/settings/bank', {
                token: t2.token,
                body: { bankId: 'VCB', accountNo: accNo2, accountName: 'QUAN TEST 2', sepayApiKey: sepayKey2 },
            });
            await api('POST', '/api/ca/mo-ca', { token: t2.token, body: { tienMatDauCa: 200000 } });
            const spT2 = (
                await api('POST', '/api/sanpham', {
                    token: t2.token,
                    body: { maMon: `M45_${t2.rand}`, tenMon: 'Trà đào T2', nhomMon: 'Trà', sizes: [{ kichThuoc: 'M', giaBan: 45000 }] },
                })
            ).data.maMon;

            const ord1 = await api('POST', '/api/order', { token, body: { danhSachMon: [{ maMon: sp45, kichThuoc: 'M', soLuong: 1 }] } });
            const ord2 = await api('POST', '/api/order', { token: t2.token, body: { danhSachMon: [{ maMon: spT2, kichThuoc: 'M', soLuong: 1 }] } });
            const sharedRef = `FT263260001_${Date.now().toString().slice(-5)}`;

            const [w1, w2] = await Promise.all([
                api('POST', `/api/webhooks/sepay/${encodeURIComponent(slug)}`, {
                    headers: { Authorization: `Apikey ${sepayKey1}` },
                    body: { referenceCode: sharedRef, transferType: 'in', transferAmount: 45000, accountNumber: accNo1, content: `POSHD${ord1.data.maHoaDon}` },
                }),
                api('POST', `/api/webhooks/sepay/${encodeURIComponent(t2.slug)}`, {
                    headers: { Authorization: `Apikey ${sepayKey2}` },
                    body: { referenceCode: sharedRef, transferType: 'in', transferAmount: 45000, accountNumber: accNo2, content: `POSHD${ord2.data.maHoaDon}` },
                }),
            ]);
            assert.strictEqual(w1.data.trangThaiXuLy, 'MATCHED_PAID', `Tenant 1 phải chốt đơn: ${JSON.stringify(w1.data)}`);
            assert.strictEqual(w2.data.trangThaiXuLy, 'MATCHED_PAID', `Tenant 2 phải chốt đơn (không bị ON CONFLICT nuốt tiền!): ${JSON.stringify(w2.data)}`);
        });

        // =====================================================================
        // TEST 8: True Blind Drop & Recount Challenge (1-Lần Đếm Lại)
        // =====================================================================
        let closedShiftForHandoverExpectedCarry = 0;
        await runTest(8, 'True Blind Drop & Recount Challenge — Thu ngân gọi doi-soat bị 403, chốt lệch lần 1 trả 422 KHÔNG lộ quỹ, lần 2 chốt + SHIFT_CLOSE_DIFF', async () => {
            // Tạo tài khoản Thu ngân (VaiTro = 4)
            const cashUser = `cashier_${rand.toLowerCase()}`;
            const createStaff = await api('POST', '/api/nhansu/nhanvien', {
                token,
                body: { tenNV: 'Thu Ngân Blind', tenDangNhap: cashUser, matKhau: 'Cashier123!', vaiTro: 4 },
            });
            assert([200, 201].includes(createStaff.status), JSON.stringify(createStaff.data));
            const loginCash = await api('POST', '/api/auth/login', {
                body: { tenDangNhap: cashUser, matKhau: 'Cashier123!', tenantSlug: slug },
            });
            assert.strictEqual(loginCash.status, 200, JSON.stringify(loginCash.data));
            const cashierToken = loginCash.data.token;

            // 1. Thu ngân gọi GET /api/ca/doi-soat -> PHẢI bị chặn 403!
            const xRep = await api('GET', '/api/ca/doi-soat', { token: cashierToken });
            assert.strictEqual(xRep.status, 403, `Thu ngân phải bị chặn 403 X-Report, thực tế ${xRep.status}`);

            // 2. Lấy quỹ lý thuyết bằng token quản lý (chỉ để dựng giá trị test lệch 50.000đ)
            const mgrDs = await getCurrentShiftDoiSoat();
            const wrongCash = Math.max(0, mgrDs.tienMatLyThuyet - 50000);

            // 3. Thu ngân gửi chốt ca lần 1 lệch 50k (kể cả cố tình gửi confirmRecount: true để bypass!) -> PHẢI nhận 422 BLIND_RECOUNT_REQUIRED và KHÔNG lộ tienMatLyThuyet hay chenhLech!
            const close1 = await api('POST', '/api/ca/dong-ca', {
                token: cashierToken,
                body: {
                    tienMatThucTe: wrongCash,
                    confirmRecount: true,
                    ghiChuChenhLech: 'Cố tình gửi confirmRecount=true ở lần 1 để thử bypass Blind Drop',
                },
            });
            assert.strictEqual(close1.status, 422, `Lần 1 lệch 50k phải trả 422, thực tế ${close1.status}: ${JSON.stringify(close1.data)}`);
            assert.strictEqual(close1.data.code, 'BLIND_RECOUNT_REQUIRED');
            assert.strictEqual(close1.data.tienMatLyThuyet, undefined, 'TUYỆT ĐỐI không được lộ tienMatLyThuyet!');
            assert.strictEqual(close1.data.chenhLech, undefined, 'TUYỆT ĐỐI không được lộ chenhLech!');
            assert.strictEqual(close1.data.doiSoat, undefined, 'TUYỆT ĐỐI không được lộ doiSoat ở lần 1!');

            // 4. Thu ngân gửi lần 2 kèm lý do >= 10 ký tự & tienGiuLaiKet = 1.000.000đ (hoặc tối đa wrongCash) -> chốt thành công!
            const carry = Math.min(wrongCash, 1000000);
            closedShiftForHandoverExpectedCarry = carry;
            const close2 = await api('POST', '/api/ca/dong-ca', {
                token: cashierToken,
                body: {
                    tienMatThucTe: wrongCash,
                    tienGiuLaiKet: carry,
                    confirmRecount: true,
                    ghiChuChenhLech: 'Đã kiểm đếm lại lần 2 vẫn hụt 50.000đ do thối nhầm',
                },
            });
            assert.strictEqual(close2.status, 200, JSON.stringify(close2.data));
            assert(close2.data.zReportSnapshot, 'Lần 2 mới được trả Z-Report!');
            assert.strictEqual(close2.data.zReportSnapshot.riskMetrics.recountAttempts, 1);

            const auditDiff = await qTenantDb(
                tenantId,
                `SELECT 1 FROM Audit_Logs WHERE TenantId = $1 AND HanhDong = 'SHIFT_CLOSE_DIFF' ORDER BY ThoiGianTao DESC LIMIT 1`,
                [tenantId]
            );
            assert(auditDiff.rows.length >= 1, 'Phải ghi nhận SHIFT_CLOSE_DIFF trong Audit_Logs!');
        });

        // =====================================================================
        // TEST 9: Shift Handover Variance (Ca trước giữ lại X -> Ca sau đếm nhận X - 50k)
        // =====================================================================
        await runTest(9, 'Shift Handover Variance — Ca sau mở đếm mệnh giá thiếu 50k so với Ca trước để lại -> chenhLechBanGiao = -50k + Audit', async () => {
            const targetOpen = Math.max(0, closedShiftForHandoverExpectedCarry - 50000);
            // Tạo bảng mệnh giá sao cho tổng đúng bằng targetOpen
            const denomMap = {};
            let rem = targetOpen;
            for (const d of [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000]) {
                if (rem >= d) {
                    const q = Math.floor(rem / d);
                    denomMap[d] = q;
                    rem -= q * d;
                }
            }
            const openNext = await api('POST', '/api/ca/mo-ca', {
                token,
                body: { chiTietMenhGiaDauCa: denomMap },
            });
            assert.strictEqual(openNext.status, 201, JSON.stringify(openNext.data));
            assert.strictEqual(openNext.data.chenhLechBanGiao, -50000, `Phải ghi nhận chenhLechBanGiao = -50000, thực tế ${openNext.data.chenhLechBanGiao}`);

            const handAudit = await qTenantDb(
                tenantId,
                `SELECT 1 FROM Audit_Logs WHERE TenantId = $1 AND HanhDong = 'SHIFT_HANDOVER_VARIANCE'`,
                [tenantId]
            );
            assert(handAudit.rows.length >= 1, 'Phải ghi SHIFT_HANDOVER_VARIANCE vào Audit_Logs!');
        });

        // =====================================================================
        // TEST 10: Pre-Close Gate (STRICT chặn 409 vs CARRY_OVER cho đóng & ghi vào ZReportSnapshot)
        // =====================================================================
        await runTest(10, 'Pre-Close Gate — STRICT chặn 409 khi còn bàn mở/Outbox treo; CARRY_OVER cho đóng & ghi vào ZReportSnapshot', async () => {
            const banRes = await api('GET', '/api/ban', { token });
            const maBan = banRes.data[0].maban;
            const openOrd = await api('POST', '/api/order', {
                token,
                body: { maBan, danhSachMon: [{ maMon: sp65, kichThuoc: 'M', soLuong: 1 }] },
            });
            assert.strictEqual(openOrd.status, 201);

            // Chuyển chính sách sang STRICT
            const polStrict = await api('PUT', '/api/ca/policy', { token, body: { preCloseMode: 'STRICT' } });
            assert.strictEqual(polStrict.status, 200);

            const dsNow = await getCurrentShiftDoiSoat();
            const tryCloseStrict = await api('POST', '/api/ca/dong-ca', {
                token,
                body: { tienMatThucTe: dsNow.tienMatLyThuyet, outboxPendingCount: 1 },
            });
            assert.strictEqual(tryCloseStrict.status, 409, `STRICT phải chặn 409, thực tế ${tryCloseStrict.status}`);
            assert.strictEqual(tryCloseStrict.data.code, 'PRE_CLOSE_BLOCKED');

            // Chuyển chính sách sang CARRY_OVER -> cho đóng ca và ghi danh sách bàn chuyển giao vào ZReportSnapshot!
            await api('PUT', '/api/ca/policy', { token, body: { preCloseMode: 'CARRY_OVER' } });
            const closeCarry = await api('POST', '/api/ca/dong-ca', {
                token,
                body: { tienMatThucTe: dsNow.tienMatLyThuyet, tienGiuLaiKet: 500000 },
            });
            assert.strictEqual(closeCarry.status, 200, JSON.stringify(closeCarry.data));
            assert(
                closeCarry.data.zReportSnapshot.riskMetrics.carriedOverOpenTables.count >= 1,
                'ZReportSnapshot phải lưu danh sách bàn chuyển giao sang ca sau!'
            );

            // Mở lại ca mới cho Test 11 & thanh toán nốt bàn treo
            await api('POST', '/api/ca/mo-ca', { token, body: { tienMatDauCa: 500000 } });
            await api('POST', '/api/order/thanhtoan', {
                token,
                body: { maHoaDon: openOrd.data.maHoaDon, phuongThucTT: 'TIEN_MAT', tienKhachDua: 65000 },
            });
        });

        // =====================================================================
        // TEST 11: Safe Drop Two-Man Rule & Receipt Photo Gate
        // =====================================================================
        await runTest(11, 'Safe Drop Two-Man Rule & Receipt Photo Gate — Chi 150k thiếu ảnh chặn 400; RUT_KET 3tr tạo PENDING_RECEIPT & trừ quỹ (không cộng chi phí)', async () => {
            // 1. Phiếu chi 150k thiếu idChungTu -> bị chặn 400 RECEIPT_PHOTO_REQUIRED!
            const badChi = await api('POST', '/api/ca/thu-chi', {
                token,
                body: { loaiThuChi: 'CHI', soTien: 150000, lyDo: 'Mua đá viên & sữa gấp', danhMucChi: 'MUA_DA' },
            });
            assert.strictEqual(badChi.status, 400);
            assert.strictEqual(badChi.data.code, 'RECEIPT_PHOTO_REQUIRED');

            // 2. Upload ảnh chứng từ thật -> lập phiếu chi 150k thành công!
            const up = await api('POST', '/api/uploads/receipt-photo', {
                token,
                body: { dataUrl: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=', mimeType: 'image/webp' },
            });
            assert.strictEqual(up.status, 201);
            const okChi = await api('POST', '/api/ca/thu-chi', {
                token,
                body: { loaiThuChi: 'CHI', soTien: 150000, lyDo: 'Mua đá viên & sữa gấp', danhMucChi: 'MUA_DA', idChungTu: up.data.idChungTu },
            });
            assert.strictEqual(okChi.status, 201);

            // 3. Rút két an toàn (RUT_KET) 3.000.000đ -> PENDING_RECEIPT, trừ TienMatLyThuyet, KHÔNG cộng vào chiLatVat!
            const dsBeforeDrop = await getCurrentShiftDoiSoat();
            const drop = await api('POST', '/api/ca/thu-chi', {
                token,
                body: { loaiThuChi: 'RUT_KET', soTien: 3000000, lyDo: 'Bỏ phong bì két sắt giữa ca' },
            });
            assert.strictEqual(drop.status, 201);
            assert.strictEqual(drop.data.trangThaiXacNhan, 'PENDING_RECEIPT');

            const dsAfterDrop = await getCurrentShiftDoiSoat();
            assert.strictEqual(dsBeforeDrop.tienMatLyThuyet - dsAfterDrop.tienMatLyThuyet, 3000000, 'Safe Drop phải trừ thẳng vào TienMatLyThuyet!');
            assert.strictEqual(dsAfterDrop.chiLatVat, dsBeforeDrop.chiLatVat, 'Safe Drop KHÔNG ĐƯỢC cộng vào chi phí vận hành chiLatVat!');
            assert.strictEqual(dsAfterDrop.rutKet - dsBeforeDrop.rutKet, 3000000);

            // 4. Chủ quán xác nhận đã cầm đủ tiền -> CONFIRMED!
            const confirmDrop = await api('POST', `/api/ca/safe-drop/${encodeURIComponent(drop.data.maPhieuTC)}/confirm`, {
                token,
                body: { status: 'CONFIRMED' },
            });
            assert.strictEqual(confirmDrop.status, 200);
            assert.strictEqual(confirmDrop.data.trangThaiXacNhan, 'CONFIRMED');
        });

        // =====================================================================
        // TEST 12: Atomic Z-Report Counter (2 Chi nhánh đồng thời) & Late Offline Sync
        // =====================================================================
        await runTest(12, 'Atomic Z-Report Counter (2 chi nhánh song song Z-0001) & Late Offline Sync gắn vào Ca mới (laOfflineLechCa=true)', async () => {
            // 1. Mở 2 ca ở 2 chi nhánh độc lập BR_NORTH & BR_SOUTH -> chốt song song -> cả 2 đều sinh Z-0001 độc lập!
            const opN = await api('POST', '/api/ca/mo-ca', { token, body: { tienMatDauCa: 100000, branchId: 'BR_NORTH', terminalId: 'POS_N1' } });
            const opS = await api('POST', '/api/ca/mo-ca', { token, body: { tienMatDauCa: 100000, branchId: 'BR_SOUTH', terminalId: 'POS_S1' } });
            assert.strictEqual(opN.status, 201, JSON.stringify(opN.data));
            assert.strictEqual(opS.status, 201, JSON.stringify(opS.data));

            const [clN, clS] = await Promise.all([
                api('POST', '/api/ca/dong-ca', { token, body: { maCaThuNgan: opN.data.ca.maCaThuNgan, tienMatThucTe: 100000 } }),
                api('POST', '/api/ca/dong-ca', { token, body: { maCaThuNgan: opS.data.ca.maCaThuNgan, tienMatThucTe: 100000 } }),
            ]);
            assert.strictEqual(clN.status, 200, JSON.stringify(clN.data));
            assert.strictEqual(clS.status, 200, JSON.stringify(clS.data));
            assert.strictEqual(clN.data.zNumber, 'Z-0001');
            assert.strictEqual(clS.data.zNumber, 'Z-0001');

            const closedShiftId = opN.data.ca.maCaThuNgan;
            const frozenCashBefore = clN.data.zReportSnapshot.cashFlow.expectedCash;

            // 2. Đồng bộ 1 đơn Offline tạo từ Ca BR_NORTH đã đóng -> phải gắn vào Ca hiện tại đang mở với laOfflineLechCa = true!
            const lateSync = await api('POST', '/api/order/quick-checkout', {
                token,
                headers: { 'X-Offline-Sync': '1', 'Idempotency-Key': `OFF-LATE-${rand}` },
                body: {
                    phuongThucTT: 'TIEN_MAT',
                    maCaThuNganGoc: closedShiftId,
                    offlineClientId: `OFF-${rand}-LATE`,
                    danhSachMon: [{ maMon: sp45, kichThuoc: 'M', soLuong: 1 }],
                },
            });
            assert.strictEqual(lateSync.status, 201, JSON.stringify(lateSync.data));

            const opLate = await qTenantDb(
                tenantId,
                `SELECT MaCaThuNgan, LaOfflineLechCa, MaCaThuNganGoc FROM Order_Payments WHERE MaHoaDon = $1::text`,
                [String(lateSync.data.maHoaDon)]
            );
            assert.strictEqual(Boolean(opLate.rows[0].laofflinelechca), true, 'Đơn đồng bộ trễ phải gắn cờ laOfflineLechCa = true!');
            assert.strictEqual(String(opLate.rows[0].macathungangoc), String(closedShiftId));
            assert.notStrictEqual(String(opLate.rows[0].macathungan), String(closedShiftId), 'Không được hạch toán ngược vào ca cũ đã chốt!');

            // Kiểm chứng ZReportSnapshot của ca cũ hoàn toàn không đổi!
            const oldCheck = (await api('GET', `/api/ca/doi-soat?maCaThuNgan=${encodeURIComponent(closedShiftId)}`, { token })).data.doiSoat;
            assert.strictEqual(oldCheck.tienMatLyThuyet, frozenCashBefore, 'ZReportSnapshot ca cũ phải bất biến 100%!');

            // Kiểm chứng thêm Đối soát 3 chiều EOD & EDC Batch Settlement
            const eod = await api('GET', '/api/ca/reconciliation-eod', { token });
            assert.strictEqual(eod.status, 200);
            assert(eod.data.bankReconciliation && eod.data.edcReconciliation);
        });

        console.log(`\n🎉 HOÀN TẤT XUẤT SẮC: ${passed}/${totalTests} BÀI TEST TÍCH HỢP PHÂN HỆ 3 (100/100) ĐỀU PASS!`);
    } finally {
        serverProc.kill('SIGTERM');
        await pool.end().catch(() => {});
        if (passed < totalTests && serverLogs) {
            console.error('\n--- Backend Logs (last 40 lines) ---\n' + serverLogs.split('\n').slice(-40).join('\n'));
        }
    }
}

main().catch((err) => {
    console.error('\n💥 Bộ test Phân hệ 3 dừng do lỗi:', err.message);
    process.exit(1);
});
