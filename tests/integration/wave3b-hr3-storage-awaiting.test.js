const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const jwt = require('jsonwebtoken');
const {
    getRuntimeConnectionString,
    createRuntimePool,
    createMigrationPool,
    createPlatformPool,
    assertAppRuntimeNoBypassRls,
    withTenantTx,
} = require('../helpers/dbHarness');
const { generateKioskQrToken } = require('../../modules/hrAntiFraudService');
const { uploadReceiptPhoto } = require('../../modules/storageAdapter');
const { runDunningCheck } = require('../../modules/saasRoutes');
const { todayDateVN } = require('../../modules/inventoryCogsPhase4Engine');

const HAS_DB = Boolean(getRuntimeConnectionString());
const TEST_JWT_SECRET = process.env.JWT_SECRET || 'wave3b_live_test_secret_key_2026';

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
    'Wave 3B Live Integration [Tầng 2 — app_runtime NOBYPASSRLS]: TC-W3B-01, TC-W3B-02, TC-W3B-03',
    { skip: !HAS_DB ? 'Chưa cấu hình TEST_APP_RUNTIME_URL (.env.test)' : false },
    () => {
        let runtimePool;
        let migrationPool;
        let serverProc;
        let baseUrl;
        let serverStderr = '';
        const port = 39500 + Math.floor(Math.random() * 400);
        const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const tenantId = `W3B_T_${suffix}`;
        const branchId = `CN_${suffix.slice(-6)}`;
        const maNV = `NV_${suffix.slice(-6)}`;
        const kioskSecret = `kiosk_secret_${suffix}`;
        let authToken;

        before(async () => {
            runtimePool = createRuntimePool();
            migrationPool = createMigrationPool();
            await assertAppRuntimeNoBypassRls(runtimePool);

            // 1. Xác nhận migration 034 đã được áp dụng trong schema_migrations
            const migRes = await runtimePool.query(
                `SELECT version FROM public.schema_migrations WHERE version = '034'`
            );
            assert.equal(migRes.rows.length, 1, 'Migration 034 chưa có trong public.schema_migrations');

            // 2. Seed Tenant + ChiNhanh (có kiosk_hmac_secret + GPS) + NhanVien
            const maTienTo = `W3${String(Date.now()).slice(-4)}${Math.floor(Math.random() * 90 + 10)}`;
            await migrationPool.query(
                `INSERT INTO public.tenants (tenantid, matiento, tenquan, slug, goicuoc, trangthai, subscriptionendsat)
                 VALUES ($1, $2, $3, $4, 'PRO', 'ACTIVE', now() + interval '3 days')
                 ON CONFLICT (tenantid) DO NOTHING`,
                [tenantId, maTienTo, `Quán Wave3B ${suffix}`, tenantId.toLowerCase()]
            );

            await withTenantTx(runtimePool, tenantId, async (client) => {
                await client.query(
                    `INSERT INTO public.chinhanh
                        (branchid, tenantid, machinhanh, tenchinhanh, kiosk_hmac_secret, geo_lat, geo_lng, geofence_radius_m)
                     VALUES ($1, $2, $1, 'Chi nhánh Test W3B', $3, 10.776889, 106.700806, 50)
                     ON CONFLICT (branchid) DO NOTHING`,
                    [branchId, tenantId, kioskSecret]
                );
                await client.query(
                    `INSERT INTO public.nhanvien
                        (manv, tennv, tendangnhap, matkhauhash, vaitro, trangthailamviec, tenantid)
                     VALUES ($1, 'Quản Lý W3B', $2, 'hashed_pw', 1, TRUE, $3)
                     ON CONFLICT (manv) DO NOTHING`,
                    [maNV, `ql_${suffix}`, tenantId]
                );
            });

            authToken = jwt.sign(
                { maNV, tenNV: 'Quản Lý W3B', vaiTro: 1, tenantId, maChiNhanh: branchId, branchId },
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

        it('TC-W3B-01 (QA-11): Chặn check-in GPS 2km / QR hết hạn (403 + Audit_Logs), cho qua 30m + QR hợp lệ (201), chặn trùng ca (409 SHIFT_OVERLAP_CONFLICT)', async () => {
            const today = todayDateVN();
            const maCa1 = `CA1_${suffix.slice(-5)}`;
            const maCa2 = `CA2_${suffix.slice(-5)}`;

            await withTenantTx(runtimePool, tenantId, async (client) => {
                await client.query(
                    `INSERT INTO public.calamviec (maca, tenca, giobatdau, gioketthuc, tenantid)
                     VALUES ($1, 'Ca Sáng W3B', '07:00', '12:00', $2)`,
                    [maCa1, tenantId]
                );
                await client.query(
                    `INSERT INTO public.calamviec (maca, tenca, giobatdau, gioketthuc, tenantid)
                     VALUES ($1, 'Ca Chồng Giờ W3B', '10:00', '15:00', $2)`,
                    [maCa2, tenantId]
                );
            });

            // 1. Xếp ca 1 thành công
            const pc1Res = await fetch(`${baseUrl}/api/nhansu/phanca`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                body: JSON.stringify({ maNV, maCa: maCa1, ngayLam: today }),
            });
            assert.equal(pc1Res.status, 200);
            const pc1Data = await pc1Res.json();
            const maPhanCa = pc1Data.maPhanCa;
            assert.ok(maPhanCa);

            // 2. Xếp ca 2 chồng giờ cùng ngày -> 409 SHIFT_OVERLAP_CONFLICT
            const pc2Res = await fetch(`${baseUrl}/api/nhansu/phanca`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                body: JSON.stringify({ maNV, maCa: maCa2, ngayLam: today }),
            });
            assert.equal(pc2Res.status, 409);
            const pc2Data = await pc2Res.json();
            assert.equal(pc2Data.code, 'SHIFT_OVERLAP_CONFLICT');

            // 3. Check-in với QR hết hạn (> 60s trước) -> 403 + Audit_Logs
            const expiredToken = generateKioskQrToken(tenantId, branchId, kioskSecret, Date.now() - 95_000);
            const badQrRes = await fetch(`${baseUrl}/api/nhansu/chamcong`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                body: JSON.stringify({
                    maPhanCa,
                    branchId,
                    kioskQrToken: expiredToken,
                    checkinLat: 10.7769,
                    checkinLng: 106.7008,
                }),
            });
            const badQrData = await badQrRes.json();
            assert.equal(badQrRes.status, 403, `Expected 403, got ${badQrRes.status}: ${JSON.stringify(badQrData)}\nSERVER STDERR:\n${serverStderr.slice(-1000)}`);
            assert.equal(badQrData.code, 'INVALID_KIOSK_QR');

            // 4. Check-in với QR đúng nhưng đứng cách 2km -> 403 + Audit_Logs
            const validToken = generateKioskQrToken(tenantId, branchId, kioskSecret, Date.now());
            const farGpsRes = await fetch(`${baseUrl}/api/nhansu/chamcong`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                body: JSON.stringify({
                    maPhanCa,
                    branchId,
                    kioskQrToken: validToken,
                    checkinLat: 10.796889, // cách ~2.2km
                    checkinLng: 106.700806,
                }),
            });
            assert.equal(farGpsRes.status, 403);
            const farGpsData = await farGpsRes.json();
            assert.equal(farGpsData.code, 'OUT_OF_GEOFENCE');

            // Xác nhận có Audit_Logs ghi nhận các lần bị chặn
            const auditCount = await withTenantTx(runtimePool, tenantId, async (client) => {
                const r = await client.query(
                    `SELECT COUNT(*)::int AS cnt FROM public.audit_logs
                      WHERE tenantid = $1 AND hanhdong IN ('HR_CHECKIN_REJECTED_QR', 'HR_CHECKIN_REJECTED_LOCATION')`,
                    [tenantId]
                );
                return r.rows[0].cnt;
            });
            assert.ok(auditCount >= 2, `Phải ghi Audit_Logs khi chặn QR/GPS, thực tế: ${auditCount}`);

            // 5. Check-in hợp lệ (trong 30m + QR hợp lệ) -> 201
            const okRes = await fetch(`${baseUrl}/api/nhansu/chamcong`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                body: JSON.stringify({
                    maPhanCa,
                    branchId,
                    kioskQrToken: validToken,
                    checkinLat: 10.77705, // cách ~18m
                    checkinLng: 106.700806,
                }),
            });
            assert.equal(okRes.status, 201);
            const okData = await okRes.json();
            assert.ok(okData.chamCong?.machamcong);
        });

        it('TC-W3B-02: Counter VietQR AWAITING_PAYMENT chưa trừ kho & chưa fire KDS cho đến khi thanh toán đủ 100% (PAID)', async () => {
            const maNL = `NL_W3B_${suffix.slice(-5)}`;
            const maMon = `MON_W3B_${suffix.slice(-5)}`;

            await withTenantTx(runtimePool, tenantId, async (client) => {
                // Mở ca thu ngân
                await client.query(
                    `INSERT INTO public.cathungan (manv, tiendauca, trangthaica, tenantid, branchid)
                     VALUES ($1, 500000, 1, $2, $3)`,
                    [maNV, tenantId, branchId]
                );
                // Seed Nguyên liệu + Tồn kho chi nhánh = 1000g
                await client.query(
                    `INSERT INTO public.nguyenlieu (manl, tennl, donvitinh, soluongton, hanmuccanhbao, giavondonvi, tenantid)
                     VALUES ($1, 'Hạt Cafe W3B', 'g', 1000, 100, 300, $2)`,
                    [maNL, tenantId]
                );
                await client.query(
                    `INSERT INTO public.tonkhochinhanh (tenantid, branchid, manl, soluongton, giavondonvi)
                     VALUES ($1, $2, $3, 1000, 300)
                     ON CONFLICT (branchid, manl) DO UPDATE SET soluongton = 1000`,
                    [tenantId, branchId, maNL]
                );
                // Seed Món + Size M + Công thức BOM (20g/ly)
                await client.query(
                    `INSERT INTO public.sanpham (mamon, tenmon, nhommon, dangkinhdoanh, tamhet, tenantid)
                     VALUES ($1, 'Espresso W3B', 'Cà phê', TRUE, FALSE, $2)`,
                    [maMon, tenantId]
                );
                await client.query(
                    `INSERT INTO public.sanpham_size (mamon, kichthuoc, giaban) VALUES ($1, 'M', 35000)`,
                    [maMon]
                );
                await client.query(
                    `INSERT INTO public.congthuc (mamon, kichthuoc, manl, khoiluongtieuhao) VALUES ($1, 'M', $2, 20)`,
                    [maMon, maNL]
                );
            });

            // 1. Tạo đơn Counter VietQR trả trước (AWAITING_PAYMENT)
            const createRes = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                body: JSON.stringify({
                    branchId,
                    loaiDonHang: 'MANG_DI',
                    choThanhToanTruoc: true,
                    phuongThucDuKien: 'VIETQR_PREPAID',
                    danhSachMon: [{ maMon, kichThuoc: 'M', soLuong: 2 }],
                }),
            });
            const createData = await createRes.json();
            assert.equal(createRes.status, 201, `Expected 201, got ${createRes.status}: ${JSON.stringify(createData)}\nSTDERR:\n${serverStderr.slice(-1500)}`);
            const maHoaDon = createData.maHoaDon;
            assert.ok(maHoaDon);

            // Xác nhận trạng thái AWAITING_PAYMENT, tồn kho CHƯA trừ (= 1000), KDS CHƯA có ORDER_NEW
            const beforePayState = await withTenantTx(runtimePool, tenantId, async (client) => {
                const hd = await client.query(`SELECT lifecycle_status, version FROM public.hoadon WHERE mahoadon = $1`, [maHoaDon]);
                const ct = await client.query(`SELECT firestatus FROM public.chitiethoadon WHERE mahoadon = $1`, [maHoaDon]);
                const tk = await client.query(
                    `SELECT soluongton FROM public.tonkhochinhanh WHERE tenantid = $1 AND branchid = $2 AND manl = $3`,
                    [tenantId, branchId, maNL]
                );
                const kds = await client.query(
                    `SELECT COUNT(*)::int AS cnt FROM public.kds_event_log WHERE tenantid = $1 AND mahoadon = $2::text AND eventtype = 'ORDER_NEW'`,
                    [tenantId, String(maHoaDon)]
                );
                return {
                    lifecycle: hd.rows[0]?.lifecycle_status,
                    version: hd.rows[0]?.version,
                    fireStatuses: ct.rows.map((r) => r.firestatus),
                    stock: Number(tk.rows[0]?.soluongton),
                    kdsCount: kds.rows[0]?.cnt,
                };
            });

            assert.equal(beforePayState.lifecycle, 'AWAITING_PAYMENT');
            assert.deepEqual(beforePayState.fireStatuses, ['AWAITING_PAYMENT']);
            assert.equal(beforePayState.stock, 1000, 'Tồn kho KHÔNG được trừ trước khi thanh toán đủ!');
            assert.equal(beforePayState.kdsCount, 0, 'KHÔNG được bắn sự kiện ORDER_NEW xuống KDS khi đang AWAITING_PAYMENT!');

            // 2. Xác nhận thanh toán đủ 100% -> chuyển PAID, trừ 40g (2 ly × 20g = còn 960g), FireStatus='FIRED', có ORDER_NEW trên KDS!
            const payRes = await fetch(`${baseUrl}/api/order/thanhtoan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                body: JSON.stringify({
                    maHoaDon,
                    branchId,
                    expectedVersion: beforePayState.version,
                    phuongThucTT: 'CHUYEN_KHOAN',
                }),
            });
            assert.equal(payRes.status, 200);

            const afterPayState = await withTenantTx(runtimePool, tenantId, async (client) => {
                const hd = await client.query(`SELECT lifecycle_status, trangthaitt FROM public.hoadon WHERE mahoadon = $1`, [maHoaDon]);
                const ct = await client.query(`SELECT firestatus FROM public.chitiethoadon WHERE mahoadon = $1`, [maHoaDon]);
                const tk = await client.query(
                    `SELECT soluongton FROM public.tonkhochinhanh WHERE tenantid = $1 AND branchid = $2 AND manl = $3`,
                    [tenantId, branchId, maNL]
                );
                const kds = await client.query(
                    `SELECT COUNT(*)::int AS cnt FROM public.kds_event_log WHERE tenantid = $1 AND mahoadon = $2::text AND eventtype = 'ORDER_NEW'`,
                    [tenantId, String(maHoaDon)]
                );
                return {
                    lifecycle: hd.rows[0]?.lifecycle_status,
                    trangThaiTT: hd.rows[0]?.trangthaitt,
                    fireStatuses: ct.rows.map((r) => r.firestatus),
                    stock: Number(tk.rows[0]?.soluongton),
                    kdsCount: kds.rows[0]?.cnt,
                };
            });

            assert.equal(afterPayState.lifecycle, 'PAID');
            assert.equal(afterPayState.trangThaiTT, 1);
            assert.deepEqual(afterPayState.fireStatuses, ['FIRED']);
            assert.equal(afterPayState.stock, 960, 'Tồn kho phải bị trừ đúng 40g (còn 960g) khi chốt PAID!');
            assert.ok(afterPayState.kdsCount >= 1, 'Phải sinh sự kiện KDS ORDER_NEW khi chốt PAID!');
        });

        it('TC-W3B-03: Object Storage Adapter (không nhồi Base64 vào DB) & Dunning Check Idempotent (D-3 ghi đúng 1 dòng)', async () => {
            // 1. Upload ảnh chứng từ qua storageAdapter + lưu vào receipt_photo_uploads
            const tinyPngBase64 =
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
            const tmpDir = path.join(os.tmpdir(), `w3b_receipts_${suffix}`);
            const idChungTu = `RCP_W3B_${suffix}`;

            const stored = await uploadReceiptPhoto({
                tenantId,
                idChungTu,
                dataUrl: tinyPngBase64,
                mimeType: 'image/png',
                localRoot: tmpDir,
            });
            assert.equal(stored.storageProvider, 'LOCAL');
            assert.ok(stored.storageKey && stored.storageKey.includes(idChungTu));
            assert.ok(fs.existsSync(stored.localPath), 'File nhị phân phải tồn tại trên storage ngoài DB');

            await withTenantTx(runtimePool, tenantId, async (client) => {
                await client.query(
                    `INSERT INTO public.receipt_photo_uploads
                        (id, tenantid, manv, mimetype, sizebytes, dataurl, storage_provider, storage_key, storage_url)
                     VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
                    [idChungTu, tenantId, maNV, stored.mimeType, stored.sizeBytes, stored.storageProvider, stored.storageKey, stored.storageUrl]
                );
                const r = await client.query(
                    `SELECT dataurl, storage_provider, storage_key FROM public.receipt_photo_uploads WHERE id = $1`,
                    [idChungTu]
                );
                assert.equal(r.rows[0].dataurl, null, 'KHÔNG được nhồi Base64 vào cột dataurl trong PostgreSQL!');
                assert.equal(r.rows[0].storage_provider, 'LOCAL');
                assert.equal(r.rows[0].storage_key, stored.storageKey);
            });

            fs.rmSync(tmpDir, { recursive: true, force: true });

            // 2. Chạy runDunningCheck 2 lần cho tenant còn 3 ngày hết hạn -> chỉ ghi đúng 1 dòng D-3 (idempotent)
            const platformPool = createPlatformPool();
            try {
                const poolWithTenant = {
                    query: (...args) => runtimePool.query(...args),
                    withTenant: (tId, fn) => withTenantTx(runtimePool, tId, fn),
                    platformPool,
                };
                const run1 = await runDunningCheck(poolWithTenant);
                const run2 = await runDunningCheck(poolWithTenant);

                assert.ok(
                    run1.logged.some((l) => l.tenantId === tenantId && l.stage === 'D-3'),
                    'Lần chạy 1 phải ghi nhận mốc D-3 cho tenant còn 3 ngày hết hạn'
                );
                assert.ok(
                    !run2.logged.some((l) => l.tenantId === tenantId && l.stage === 'D-3'),
                    'Lần chạy 2 KHÔNG được ghi trùng mốc D-3 (idempotent)'
                );
            } finally {
                await platformPool.end();
            }

            const dunningCount = await withTenantTx(runtimePool, tenantId, async (client) => {
                const r = await client.query(
                    `SELECT COUNT(*)::int AS cnt FROM public.tenant_dunning_logs WHERE tenant_id = $1 AND stage = 'D-3'`,
                    [tenantId]
                );
                return r.rows[0].cnt;
            });
            assert.equal(dunningCount, 1, 'tenant_dunning_logs chỉ được có đúng 1 dòng D-3');
        });
    }
);
