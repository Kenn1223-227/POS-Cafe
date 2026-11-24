'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const jwt = require('jsonwebtoken');
const { hashPassword } = require('../../password');
const {
    getRuntimeConnectionString,
    createRuntimePool,
    createMigrationPool,
    assertAppRuntimeNoBypassRls,
    withTenantTx,
} = require('../helpers/dbHarness');
const { todayDateVN } = require('../../modules/inventoryCogsPhase4Engine');

const HAS_DB = Boolean(getRuntimeConnectionString());
const TEST_JWT_SECRET = process.env.JWT_SECRET || 'wave4a_live_test_secret_key_2026';

async function waitForServerReady(baseUrl, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`${baseUrl}/api/ready`);
            if (res.ok) return;
        } catch {
            // retry
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Server không sẵn sàng sau ${timeoutMs}ms tại ${baseUrl}`);
}

describe(
    'Wave 4A Live Integration [Tầng 2 — app_runtime NOBYPASSRLS]: TC-W4A-01 -> TC-W4A-05',
    { skip: !HAS_DB ? 'Chưa cấu hình TEST_APP_RUNTIME_URL (.env.test)' : false },
    () => {
        let runtimePool;
        let migrationPool;
        let serverProc;
        let baseUrl;
        let serverStderr = '';
        const port = 39600 + Math.floor(Math.random() * 300);
        const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const tenantA = `W4A_TA_${suffix}`;
        const tenantB = `W4A_TB_${suffix}`;
        const branchId = `CN_${suffix.slice(-6)}`;
        const staffOut = `NV_OUT_${suffix.slice(-5)}`;
        const staffIn = `NV_IN_${suffix.slice(-5)}`;
        const staffB = `NV_TB_${suffix.slice(-5)}`;
        const pinOut = '112233';
        const pinIn = '445566';
        let tokenA;
        let tokenB;

        before(async () => {
            runtimePool = createRuntimePool();
            migrationPool = createMigrationPool();
            await assertAppRuntimeNoBypassRls(runtimePool);

            // 1. Xác nhận migrations 035, 036, 037 đã có trong schema_migrations
            const migRes = await runtimePool.query(
                `SELECT version FROM public.schema_migrations WHERE version IN ('035', '036', '037') ORDER BY version ASC`
            );
            assert.deepEqual(
                migRes.rows.map((r) => r.version),
                ['035', '036', '037'],
                'Migrations 035, 036, 037 phải có trong public.schema_migrations'
            );

            // 2. Seed Tenant A & Tenant B + Staff có PinHash
            const prefixA = `A4${String(Date.now()).slice(-4)}${Math.floor(Math.random() * 90 + 10)}`;
            const prefixB = `B4${String(Date.now()).slice(-4)}${Math.floor(Math.random() * 90 + 10)}`;
            await migrationPool.query(
                `INSERT INTO public.tenants (tenantid, matiento, tenquan, slug, goicuoc, trangthai)
                 VALUES ($1, $2, 'Quán W4A A', $3, 'PRO', 'ACTIVE'),
                        ($4, $5, 'Quán W4A B', $6, 'PRO', 'ACTIVE')
                 ON CONFLICT (tenantid) DO NOTHING`,
                [tenantA, prefixA, tenantA.toLowerCase(), tenantB, prefixB, tenantB.toLowerCase()]
            );

            const [hashOut, hashIn] = await Promise.all([hashPassword(pinOut), hashPassword(pinIn)]);
            await withTenantTx(runtimePool, tenantA, async (client) => {
                await client.query(
                    `INSERT INTO public.nhanvien
                        (manv, tennv, tendangnhap, matkhauhash, pinhash, vaitro, trangthailamviec, mucluonggio, tenantid)
                     VALUES
                        ($1, 'Thu Ngân Giao Ca', $2, 'pw', $3, 1, TRUE, 35000, $7),
                        ($4, 'Thu Ngân Nhận Ca', $5, 'pw', $6, 2, TRUE, 30000, $7)
                     ON CONFLICT (manv) DO NOTHING`,
                    [staffOut, `out_${suffix}`, hashOut, staffIn, `in_${suffix}`, hashIn, tenantA]
                );
            });
            await withTenantTx(runtimePool, tenantB, async (client) => {
                await client.query(
                    `INSERT INTO public.nhanvien
                        (manv, tennv, tendangnhap, matkhauhash, vaitro, trangthailamviec, tenantid)
                     VALUES ($1, 'Admin Tenant B', $2, 'pw', 1, TRUE, $3)
                     ON CONFLICT (manv) DO NOTHING`,
                    [staffB, `tb_${suffix}`, tenantB]
                );
            });

            tokenA = jwt.sign(
                { maNV: staffOut, tenNV: 'Thu Ngân Giao Ca', vaiTro: 1, tenantId: tenantA, branchId },
                TEST_JWT_SECRET,
                { expiresIn: '1h' }
            );
            tokenB = jwt.sign(
                { maNV: staffB, tenNV: 'Admin Tenant B', vaiTro: 1, tenantId: tenantB, branchId: 'CN_B' },
                TEST_JWT_SECRET,
                { expiresIn: '1h' }
            );

            // 3. Khởi chạy server.js thật dưới app_runtime (NOBYPASSRLS)
            const runtimeUrlForServer = getRuntimeConnectionString().replace('127.0.0.1', 'localhost');
            baseUrl = `http://127.0.0.1:${port}`;
            serverProc = spawn(process.execPath, [path.resolve(__dirname, '..', '..', 'server.js')], {
                env: {
                    ...process.env,
                    NODE_ENV: 'test',
                    PORT: String(port),
                    DATABASE_URL: runtimeUrlForServer,
                    JWT_SECRET: TEST_JWT_SECRET,
                    SKIP_AUTO_DDL: 'true',
                    ZNS_PROVIDER_MODE: 'mock',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            serverProc.stderr.on('data', (chunk) => {
                serverStderr += chunk.toString();
            });
            try {
                await waitForServerReady(baseUrl, 20000);
            } catch (err) {
                throw new Error(`${err.message}\nSTDERR:\n${serverStderr.slice(-1500)}`);
            }
        });

        after(async () => {
            if (serverProc && !serverProc.killed) {
                serverProc.kill('SIGTERM');
                await new Promise((r) => setTimeout(r, 300));
            }
            if (runtimePool) await runtimePool.end();
            if (migrationPool) await migrationPool.end();
        });

        it('TC-W4A-01 (House Account B2B & FORCE RLS): hạn mức 500k -> ghi nợ 300k OK -> thêm 250k chặn 409 -> trả 200k còn 100k; Tenant B không đọc được sổ cái Tenant A', async () => {
            // Tạo tài khoản hạn mức 500.000đ
            const createRes = await fetch(`${baseUrl}/api/finance/house-accounts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({
                    accountCode: `B2B_${suffix.slice(-5)}`,
                    companyName: 'Công ty TNHH Coffee Partner',
                    creditLimit: 500000,
                }),
            });
            assert.equal(createRes.status, 201);
            const { account } = await createRes.json();

            // Ghi nợ 300.000đ -> OK
            const ch1 = await fetch(`${baseUrl}/api/finance/house-accounts/${account.id}/charge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({ amount: 300000, maHoaDon: 'HD_B2B_01', note: 'Đặt cà phê họp sáng' }),
            });
            assert.equal(ch1.status, 201);
            const ch1Body = await ch1.json();
            assert.equal(Number(ch1Body.account.current_balance), 300000);

            // Ghi nợ thêm 250.000đ -> vượt 500.000đ -> 409 CREDIT_LIMIT_EXCEEDED
            const ch2 = await fetch(`${baseUrl}/api/finance/house-accounts/${account.id}/charge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({ amount: 250000, maHoaDon: 'HD_B2B_02' }),
            });
            assert.equal(ch2.status, 409);
            const ch2Body = await ch2.json();
            assert.equal(ch2Body.code, 'CREDIT_LIMIT_EXCEEDED');

            // Thanh toán 200.000đ -> số dư còn 100.000đ
            const rep = await fetch(`${baseUrl}/api/finance/house-accounts/${account.id}/repayment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({ amount: 200000, note: 'Chuyển khoản đợt 1' }),
            });
            assert.equal(rep.status, 201);
            const repBody = await rep.json();
            assert.equal(Number(repBody.account.current_balance), 100000);

            // Tenant B không đọc được sao kê / sổ cái của Tenant A dưới FORCE RLS
            const stmtB = await fetch(`${baseUrl}/api/finance/house-accounts/${account.id}/statement`, {
                headers: { Authorization: `Bearer ${tokenB}` },
            });
            assert.equal(stmtB.status, 404);

            const directLedgerB = await withTenantTx(runtimePool, tenantB, async (client) => {
                const r = await client.query(
                    `SELECT COUNT(*)::int AS cnt FROM public.house_account_ledger WHERE house_account_id = $1`,
                    [account.id]
                );
                return r.rows[0].cnt;
            });
            assert.equal(directLedgerB, 0, 'Tenant B không được thấy sổ cái của Tenant A dưới FORCE RLS');
        });

        it('TC-W4A-02 (VietQR TTL 5p & Dual-PIN Handover): attempt cũ -> SUPERSEDED, attempt mới ACTIVE TTL 5p; bàn giao ca 1 người / sai PIN bị chặn 400/403, đúng 2 PIN ghi shift_handovers + Audit_Logs', async () => {
            const maHoaDon = `HD_QR_${suffix.slice(-5)}`;
            const att1Res = await fetch(`${baseUrl}/api/finance/vietqr-attempts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({ maHoaDon, amount: 85000 }),
            });
            assert.equal(att1Res.status, 201);
            const { attempt: att1 } = await att1Res.json();

            const att2Res = await fetch(`${baseUrl}/api/finance/vietqr-attempts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({ maHoaDon, amount: 95000 }),
            });
            assert.equal(att2Res.status, 201);
            const { attempt: att2 } = await att2Res.json();

            // Attempt cũ phải chuyển SUPERSEDED, attempt mới ACTIVE với TTL ~5 phút
            const res1 = await fetch(`${baseUrl}/api/finance/vietqr-attempts/${att1.transfer_code}/resolve`, {
                headers: { Authorization: `Bearer ${tokenA}` },
            });
            assert.equal(res1.status, 409);
            const res1Body = await res1.json();
            assert.equal(res1Body.attempt.status, 'SUPERSEDED');

            const res2 = await fetch(`${baseUrl}/api/finance/vietqr-attempts/${att2.transfer_code}/resolve`, {
                headers: { Authorization: `Bearer ${tokenA}` },
            });
            assert.equal(res2.status, 200);
            const res2Body = await res2.json();
            assert.equal(res2Body.attempt.status, 'ACTIVE');
            const ttlDiffMs = new Date(res2Body.attempt.expires_at).getTime() - new Date(res2Body.attempt.created_at).getTime();
            assert.ok(ttlDiffMs >= 4.5 * 60 * 1000 && ttlDiffMs <= 5.5 * 60 * 1000, 'TTL phải xấp xỉ 5 phút');

            // Dual-PIN Handover: cùng 1 người -> 400
            const sameRes = await fetch(`${baseUrl}/api/shifts/101/handover`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({
                    outgoingStaffId: staffOut,
                    outgoingPin: pinOut,
                    incomingStaffId: staffOut,
                    incomingPin: pinOut,
                    expectedCash: 1000000,
                    countedCash: 1000000,
                }),
            });
            assert.equal(sameRes.status, 400);

            // Sai PIN người nhận -> 403
            const badPinRes = await fetch(`${baseUrl}/api/shifts/101/handover`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({
                    outgoingStaffId: staffOut,
                    outgoingPin: pinOut,
                    incomingStaffId: staffIn,
                    incomingPin: '999999',
                    expectedCash: 1000000,
                    countedCash: 990000,
                }),
            });
            assert.equal(badPinRes.status, 403);

            // Đúng 2 PIN hợp lệ -> 201 + ghi shift_handovers + Audit_Logs
            const okRes = await fetch(`${baseUrl}/api/shifts/101/handover`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({
                    outgoingStaffId: staffOut,
                    outgoingPin: pinOut,
                    incomingStaffId: staffIn,
                    incomingPin: pinIn,
                    expectedCash: 1000000,
                    countedCash: 995000,
                    note: 'Bàn giao ca sáng -> chiều',
                }),
            });
            assert.equal(okRes.status, 201);
            const okBody = await okRes.json();
            assert.equal(Number(okBody.handover.variance_amount), -5000);

            const auditCnt = await withTenantTx(runtimePool, tenantA, async (client) => {
                const r = await client.query(
                    `SELECT COUNT(*)::int AS cnt FROM public.audit_logs
                      WHERE tenantid = $1 AND hanhdong = 'SHIFT_DUAL_PIN_HANDOVER' AND madoituong = '101'`,
                    [tenantA]
                );
                return r.rows[0].cnt;
            });
            assert.ok(auditCnt >= 1, 'Phải ghi Audit_Logs cho SHIFT_DUAL_PIN_HANDOVER');
        });

        it('TC-W4A-03 (Aggregator Settlement & Supplier AP): đối soát GrabFood đúng phí & chênh lệch; hóa đơn NCC 1.000.000đ -> trả 400k PARTIAL -> trả 600k PAID', async () => {
            const setRes = await fetch(`${baseUrl}/api/finance/aggregator-settlements`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({
                    platform: 'GRABFOOD',
                    periodFrom: '2026-06-01',
                    periodTo: '2026-06-07',
                    grossSales: 2000000,
                    commissionRatePct: 25,
                    promoSubsidy: 100000,
                    netReceived: 1380000,
                }),
            });
            assert.equal(setRes.status, 201);
            const { settlement } = await setRes.json();
            assert.equal(Number(settlement.commission_fee), 500000);
            assert.equal(Number(settlement.net_expected), 1400000);
            assert.equal(Number(settlement.variance_amount), -20000);
            assert.equal(settlement.status, 'DISPUTED');

            // Supplier AP 1.000.000đ
            const invRes = await fetch(`${baseUrl}/api/finance/supplier-ap`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({
                    invoiceNo: `AP_${suffix.slice(-5)}`,
                    supplierName: 'Nhà rang xay Đà Lạt',
                    totalAmount: 1000000,
                    dueDate: '2026-07-01',
                }),
            });
            assert.equal(invRes.status, 201);
            const { invoice } = await invRes.json();
            assert.equal(invoice.status, 'OPEN');

            const pay1 = await fetch(`${baseUrl}/api/finance/supplier-ap/${invoice.id}/payments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({ amount: 400000, note: 'Đợt 1' }),
            });
            assert.equal(pay1.status, 201);
            assert.equal((await pay1.json()).invoice.status, 'PARTIAL');

            const pay2 = await fetch(`${baseUrl}/api/finance/supplier-ap/${invoice.id}/payments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({ amount: 600000, note: 'Tất toán' }),
            });
            assert.equal(pay2.status, 201);
            const pay2Body = await pay2.json();
            assert.equal(pay2Body.invoice.status, 'PAID');
            assert.equal(Number(pay2Body.invoice.paid_amount), 1000000);
        });

        it('TC-W4A-04 (Price Books & Zalo ZNS NĐ 13/2023): Price Book GRABFOOD resolve đúng giá; ZNS worker mock -> khách chưa opt-in SKIPPED_NO_CONSENT, khách đã opt-in SENT', async () => {
            const pbRes = await fetch(`${baseUrl}/api/price-books`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({
                    code: `GRAB_${suffix.slice(-5)}`,
                    name: 'Bảng giá GrabFood',
                    channel: 'GRABFOOD',
                    priority: 30,
                    items: [{ maSp: 'SP_LATTE', overridePrice: 52000 }],
                }),
            });
            assert.equal(pbRes.status, 201);

            const resolveRes = await fetch(
                `${baseUrl}/api/price-books/resolve?maSp=SP_LATTE&channel=GRABFOOD&basePrice=42000`,
                { headers: { Authorization: `Bearer ${tokenA}` } }
            );
            assert.equal(resolveRes.status, 200);
            const resolved = await resolveRes.json();
            assert.equal(resolved.effectivePrice, 52000);

            // Seed 2 khách hàng: 1 khách chưa opt-in (false), 1 khách đã opt-in (true)
            const khNo = `KH_NO_${suffix.slice(-5)}`;
            const khYes = `KH_YES_${suffix.slice(-5)}`;
            await withTenantTx(runtimePool, tenantA, async (client) => {
                await client.query(
                    `INSERT INTO public.khachhang (makh, hoten, sodienthoai, zalooptin, tenantid)
                     VALUES ($1, 'Khách Không OptIn', '0901000001', FALSE, $3),
                            ($2, 'Khách Đã OptIn',    '0901000002', TRUE,  $3)`,
                    [khNo, khYes, tenantA]
                );
            });

            const enq1 = await fetch(`${baseUrl}/api/zns/outbox`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({ maKh: khNo, phone: '0901000001', templateId: 'TPL_01', purpose: 'ZNS_RECEIPT' }),
            });
            assert.equal(enq1.status, 201);

            const enq2 = await fetch(`${baseUrl}/api/zns/outbox`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({ maKh: khYes, phone: '0901000002', templateId: 'TPL_01', purpose: 'ZNS_RECEIPT' }),
            });
            assert.equal(enq2.status, 201);

            const procRes = await fetch(`${baseUrl}/api/zns/outbox/process`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({ limit: 10, providerMode: 'mock' }),
            });
            assert.equal(procRes.status, 200);
            const procBody = await procRes.json();
            assert.equal(procBody.skippedNoConsent, 1);
            assert.equal(procBody.sent, 1);

            const byKh = new Map(procBody.results.map((r) => [r.ma_kh, r.status]));
            assert.equal(byKh.get(khNo), 'SKIPPED_NO_CONSENT');
            assert.equal(byKh.get(khYes), 'SENT');
        });

        it('TC-W4A-05 (Tip Pool, OT 300% & Hourly Sales vs Labor): Tip Pool lệch 0đ, OT ngày lễ 300%, analytics trả đủ 24 bucket giờ dưới app_runtime', async () => {
            const today = todayDateVN();

            // 1. Tip Pool
            const tpRes = await fetch(`${baseUrl}/api/hr/tip-pools`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({
                    businessDate: today,
                    source: 'CASH_JAR',
                    totalAmount: 100000,
                    allocationMethod: 'BY_HOURS',
                    participants: [
                        { maNV: staffOut, hoursWorked: 5 },
                        { maNV: staffIn, hoursWorked: 3 },
                    ],
                }),
            });
            assert.equal(tpRes.status, 201);
            const tpBody = await tpRes.json();
            assert.equal(tpBody.summary.diff, 0);
            assert.equal(tpBody.summary.allocatedTotal, 100000);

            // 2. OT 300% ngày lễ
            const otRes = await fetch(`${baseUrl}/api/hr/ot-logs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({
                    maNV: staffOut,
                    workDate: today,
                    dayType: 'HOLIDAY',
                    otHours: 2,
                    nightHours: 0,
                    baseHourlyRate: 35000,
                }),
            });
            assert.equal(otRes.status, 201);
            const otBody = await otRes.json();
            assert.equal(Number(otBody.log.ot_multiplier), 3);
            assert.equal(Number(otBody.log.ot_pay), 210000);

            // 3. Hourly Sales vs Labor -> trả đủ 24 bucket giờ (00 -> 23)
            const analyticsRes = await fetch(
                `${baseUrl}/api/analytics/hourly-sales-vs-labor?fromDate=${today}&toDate=${today}`,
                { headers: { Authorization: `Bearer ${tokenA}` } }
            );
            assert.equal(analyticsRes.status, 200);
            const analytics = await analyticsRes.json();
            assert.equal(analytics.hours.length, 24);
            assert.equal(analytics.hours[0].hour, 0);
            assert.equal(analytics.hours[23].hour, 23);
        });
    }
);
