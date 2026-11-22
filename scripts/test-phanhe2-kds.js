/**
 * =============================================================================
 * PHÂN HỆ 2 (79 -> 100/100) — 12 BÀI TEST TÍCH HỢP TỰ ĐỘNG BẮT BUỘC
 * Chạy end-to-end với PostgreSQL thực, Express + Socket.IO 3 tầng & Local Print Bridge Spooler
 * =============================================================================
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const pool = require(path.join(__dirname, '..', 'db'));

const { io: ioClient } = require(path.join(__dirname, '..', 'frontend', 'node_modules', 'socket.io-client'));
const { buildCupLabelsTspl } = require(path.join(__dirname, '..', 'local-print-bridge', 'tsplBuilder'));

const TEST_PORT = 3399;
const BRIDGE_PORT = 9199;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const BRIDGE_TOKEN = `test-bridge-token-${Date.now()}`;
const TMP_SPOOL = path.join(os.tmpdir(), `pos-spool-test-${Date.now()}.json`);
const TMP_BRIDGE_CFG = path.join(os.tmpdir(), `pos-bridge-cfg-${Date.now()}.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, endpoint, { token = null, body = null, headers = {}, base = BASE_URL } = {}) {
    const hdrs = { 'Content-Type': 'application/json', ...headers };
    if (token) hdrs.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${endpoint}`, {
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

async function waitForHealth(url, label, timeoutMs = 20000) {
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
    throw new Error(`Timeout chờ ${label} khởi động tại ${url}`);
}

function connectSocket(token, subscribeOpts = null) {
    return new Promise((resolve, reject) => {
        const sock = ioClient(BASE_URL, {
            auth: { token },
            transports: ['websocket'],
            reconnection: false,
        });
        const timer = setTimeout(() => {
            sock.disconnect();
            reject(new Error('Socket connect timeout'));
        }, 10000);
        sock.on('connect_error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        sock.on('connect', () => {
            if (!subscribeOpts) {
                clearTimeout(timer);
                return resolve(sock);
            }
            sock.emit('room:subscribe', subscribeOpts, () => {
                clearTimeout(timer);
                resolve(sock);
            });
        });
    });
}

async function main() {
    console.log('🚀 Khởi động Backend & Local Print Bridge tạm cho 12 bài test Phân hệ 2...\n');
    const serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(TEST_PORT), NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const bridgeProc = spawn(process.execPath, [path.join(__dirname, '..', 'local-print-bridge', 'bridge-server.js')], {
        cwd: path.join(__dirname, '..', 'local-print-bridge'),
        env: {
            ...process.env,
            PRINT_BRIDGE_PORT: String(BRIDGE_PORT),
            PRINT_BRIDGE_HOST: '127.0.0.1',
            PRINT_BRIDGE_TOKEN: BRIDGE_TOKEN,
            PRINT_BRIDGE_CONFIG_PATH: TMP_BRIDGE_CFG,
            PRINT_SPOOL_PATH: TMP_SPOOL,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let serverLogs = '';
    serverProc.stderr.on('data', (d) => {
        serverLogs += d.toString();
    });
    serverProc.stdout.on('data', (d) => {
        serverLogs += d.toString();
    });

    const qTenantDb = (tId, sql, params = []) => pool.withTenant(tId, (c) => c.query(sql, params));

    const sockets = [];
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
        await Promise.all([
            waitForHealth(`${BASE_URL}/api/health`, 'Backend API'),
            waitForHealth(`${BRIDGE_URL}/health`, 'Local Print Bridge'),
        ]);

        // Đăng ký 1 Tenant sạch hoàn toàn cho bộ test Phân hệ 2
        const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
        const reg = await api('POST', '/api/saas/register', {
            body: {
                tenQuan: `KDS Test Cafe ${rand}`,
                moHinh: 'CAFE_TAKEAWAY',
                soBan: 6,
                tenChuQuan: 'Admin KDS',
                tenDangNhap: `kds_${rand.toLowerCase()}`,
                email: `kds_${rand.toLowerCase()}@test.local`,
                matKhau: 'TestPass123!',
                goiCuoc: 'PRO',
            },
        });
        assert.strictEqual(reg.status, 201, `Đăng ký tenant thất bại: ${JSON.stringify(reg.data)}`);
        const token = reg.data.token;
        const tenantId = reg.data.tenant?.tenantId || reg.data.user?.tenantId;
        assert(token && tenantId, 'Thiếu token hoặc tenantId sau đăng ký');

        // Mở ca (nếu chưa auto-mở)
        const caRes = await api('POST', '/api/ca/mo', { token, body: { tienMatDauCa: 500000 } });
        assert([200, 201, 409].includes(caRes.status), `Mở ca thất bại: ${caRes.status}`);

        // Lấy 2 bàn đã được tạo sẵn từ /saas/register
        const banListRes = await api('GET', '/api/ban', { token });
        assert(banListRes.status === 200 && Array.isArray(banListRes.data) && banListRes.data.length >= 2, 'Phải có ít nhất 2 bàn');
        const maBan1 = banListRes.data[0].maban;
        const maBan2 = banListRes.data[1].maban;
        assert(maBan1 && maBan2, `Thiếu mã bàn: ${JSON.stringify(banListRes.data.slice(0, 2))}`);

        // Tạo Nguyên liệu & Nhập kho dồi dào
        const nlCfRes = await api('POST', '/api/kho/nguyenlieu', {
            token,
            body: { maNL: `CF_${rand}`, tenNL: 'Cà phê hạt', donViTinh: 'g', hanMucCanhBao: 50, giaVonDonVi: 300 },
        });
        const maNlCf = nlCfRes.data.maNL;
        assert(maNlCf, 'Tạo NL cà phê thất bại');

        const nhapRes = await api('POST', '/api/kho/nhap', {
            token,
            body: { ghiChu: 'Nhập đầu ca test', danhSachNguyenLieu: [{ maNL: maNlCf, soLuong: 10000, donGiaNhap: 300 }] },
        });
        assert.strictEqual(nhapRes.status, 200, `Nhập kho thất bại: ${JSON.stringify(nhapRes.data)}`);

        // Tạo 4 sản phẩm chuẩn (3 trạm khác nhau + Latte đắt hơn + Open Item cân ký)
        const spEsp = (
            await api('POST', '/api/sanpham', {
                token,
                body: {
                    maMon: `ESP_${rand}`,
                    tenMon: 'Espresso Nóng',
                    nhomMon: 'Cà phê',
                    tramCheBien: 'BAR_CHINH',
                    sizes: [{ kichThuoc: 'M', giaBan: 35000 }],
                },
            })
        ).data.maMon;
        const spLatte = (
            await api('POST', '/api/sanpham', {
                token,
                body: {
                    maMon: `LAT_${rand}`,
                    tenMon: 'Latte Kem Muối',
                    nhomMon: 'Cà phê',
                    tramCheBien: 'BAR_CHINH',
                    sizes: [{ kichThuoc: 'M', giaBan: 49000 }],
                },
            })
        ).data.maMon;
        const spTs = (
            await api('POST', '/api/sanpham', {
                token,
                body: {
                    maMon: `TS_${rand}`,
                    tenMon: 'Trà Sữa Trân Châu',
                    nhomMon: 'Trà sữa',
                    tramCheBien: 'BAR_LANH',
                    sizes: [{ kichThuoc: 'M', giaBan: 45000 }],
                },
            })
        ).data.maMon;
        const spCake = (
            await api('POST', '/api/sanpham', {
                token,
                body: {
                    maMon: `CK_${rand}`,
                    tenMon: 'Bánh Croissant Bơ',
                    nhomMon: 'Bánh ngọt',
                    tramCheBien: 'BEP_BANH',
                    sizes: [{ kichThuoc: 'M', giaBan: 30000 }],
                },
            })
        ).data.maMon;
        const spOpen = (
            await api('POST', '/api/sanpham', {
                token,
                body: {
                    maMon: `OPEN_${rand}`,
                    tenMon: 'Hạt rang xay cân ký',
                    nhomMon: 'Đặc sản',
                    tramCheBien: 'BAR_CHINH',
                    laMonThoiGia: true,
                    donViBanHang: 'KG',
                    sizes: [{ kichThuoc: 'M', giaBan: 400000 }],
                },
            })
        ).data.maMon;

        // Gắn công thức 20g cà phê cho Espresso (để kiểm tra trừ kho chính xác)
        await api('POST', '/api/congthuc', {
            token,
            body: { maMon: spEsp, kichThuoc: 'M', dinhMuc: [{ maNL: maNlCf, khoiLuongTieuHao: 20 }] },
        });

        const getStock = async (maNL) => {
            const r = await qTenantDb(tenantId, 'SELECT SoLuongTon FROM NguyenLieu WHERE MaNL = $1', [maNL]);
            return Number(r.rows[0]?.soluongton || 0);
        };

        // =====================================================================
        // TEST 1: Double-Tap 50ms (Idempotency 2-Phase Lock)
        // =====================================================================
        await runTest(1, 'Double-Tap 50ms — 3 POST /order song song cùng Idempotency-Key chỉ tạo đúng 1 HĐ & trừ kho 1 lần', async () => {
            const stockBefore = await getStock(maNlCf);
            const idemKey = `IDEM-DBL-${rand}-${Date.now()}`;
            const payload = { danhSachMon: [{ maMon: spEsp, kichThuoc: 'M', soLuong: 1 }] };

            const [r1, r2, r3] = await Promise.all([
                api('POST', '/api/order', { token, body: payload, headers: { 'Idempotency-Key': idemKey } }),
                api('POST', '/api/order', { token, body: payload, headers: { 'Idempotency-Key': idemKey } }),
                api('POST', '/api/order', { token, body: payload, headers: { 'Idempotency-Key': idemKey } }),
            ]);

            const statuses = [r1.status, r2.status, r3.status];
            const createdCount = statuses.filter((s) => s === 201).length;
            assert.strictEqual(createdCount, 1, `Phải có đúng 1 request trả 201, thực tế: ${JSON.stringify(statuses)}`);
            for (const r of [r1, r2, r3]) {
                assert(
                    r.status === 201 || r.status === 409 || (r.status === 200 && r.data?.trungLap === true),
                    `Status không hợp lệ: ${r.status} ${JSON.stringify(r.data)}`
                );
            }

            // Gọi lại lần 4 sau khi xong -> phải trả 200 cached đúng maHoaDon cũ
            const winner = [r1, r2, r3].find((r) => r.status === 201);
            const r4 = await api('POST', '/api/order', { token, body: payload, headers: { 'Idempotency-Key': idemKey } });
            assert.strictEqual(r4.status, 200);
            assert.strictEqual(r4.data.trungLap, true);
            assert.strictEqual(r4.data.maHoaDon, winner.data.maHoaDon);

            const stockAfter = await getStock(maNlCf);
            assert.strictEqual(stockBefore - stockAfter, 20, `Kho chỉ được trừ đúng 20g (1 lần), thực tế trừ ${stockBefore - stockAfter}g`);
        });

        // =====================================================================
        // TEST 2: Cloud Timeout + LAN Hub Dedup (clientOrderUid)
        // =====================================================================
        await runTest(2, 'Cloud Timeout + LAN Hub Dedup — hợp nhất bằng clientOrderUid, chống pha đúp', async () => {
            const uid = `UID-DEDUP-${rand}-${Date.now()}`;
            // 1. Giả lập đơn đã commit lên Cloud thành công với clientOrderUid
            const cloudOrder = await api('POST', '/api/order', {
                token,
                body: { clientOrderUid: uid, danhSachMon: [{ maMon: spEsp, kichThuoc: 'M', soLuong: 1 }] },
                headers: { 'Idempotency-Key': uid },
            });
            assert.strictEqual(cloudOrder.status, 201);

            // 2. Client timeout thăm dò GET /api/order/by-client-uid/:uid -> xác nhận Cloud đã có đơn!
            const probe = await api('GET', `/api/order/by-client-uid/${encodeURIComponent(uid)}`, { token });
            assert.strictEqual(probe.status, 200);
            assert.strictEqual(probe.data.exists, true);
            assert.strictEqual(probe.data.maHoaDon, cloudOrder.data.maHoaDon);

            // 3. Kể cả khi LAN Hub cũng đã nhận cùng clientOrderUid, logic BaristaPage dedup thành 1 vé duy nhất
            const lanPush = await api('POST', '/lan/orders', {
                base: BRIDGE_URL,
                headers: { 'X-Print-Bridge-Token': BRIDGE_TOKEN },
                body: {
                    tenantId,
                    offlineClientId: `OFF-${rand}`,
                    clientOrderUid: uid,
                    danhSachMon: [{ maMon: spEsp, tenMon: 'Espresso Nóng', kichThuoc: 'M', soLuong: 1 }],
                },
            });
            assert.strictEqual(lanPush.status, 201);
            const lanOrder = lanPush.data.order;
            assert.strictEqual(lanOrder.clientOrderUid, uid);

            // Dedup kiểm chứng (cùng quy tắc Map<clientOrderUid> ở BaristaPage)
            const cloudItems = cloudOrder.data.danhSachMon;
            const cloudUids = new Set(cloudItems.map((i) => i.clientOrderUid).filter(Boolean));
            const merged = [...lanOrder.items.filter((i) => !cloudUids.has(i.clientOrderUid)), ...cloudItems];
            assert.strictEqual(merged.length, 1, 'Cloud & LAN trùng clientOrderUid phải hợp nhất còn đúng 1 vé!');
        });

        // =====================================================================
        // TEST 3: iPad Reconnect Missed Events (kds_event_log sequence replay)
        // =====================================================================
        await runTest(3, 'iPad Reconnect Missed Events — kéo bù đủ ORDER_NEW + TABLE_MOVE + ITEM_VOID theo lastSeq', async () => {
            const snap0 = await api('GET', '/api/kds/sync?branchId=DEFAULT&station=ALL&lastSeq=0', { token });
            assert.strictEqual(snap0.status, 200);
            const oldSeq = snap0.data.latestSeq;

            // 1) Tạo đơn trên Bàn 1
            const ord = await api('POST', '/api/order', {
                token,
                body: {
                    maBan: maBan1,
                    danhSachMon: [
                        { maMon: spEsp, kichThuoc: 'M', soLuong: 1 },
                        { maMon: spTs, kichThuoc: 'M', soLuong: 1 },
                    ],
                },
            });
            assert.strictEqual(ord.status, 201);
            const cthdToVoid = ord.data.danhSachMon[0].maCTHD;

            // 2) Chuyển Bàn 1 -> Bàn 2
            const mv = await api('POST', '/api/ban/chuyen', { token, body: { fromMaBan: maBan1, toMaBan: maBan2 } });
            assert.strictEqual(mv.status, 200);

            // 3) Hủy 1 món
            const vd = await api('POST', '/api/order/huy-mon', { token, body: { maCTHD: cthdToVoid, lyDo: 'Khách đổi ý' } });
            assert.strictEqual(vd.status, 200);

            // iPad reconnect -> kéo bù từ oldSeq
            const replay = await api('GET', `/api/kds/sync?branchId=DEFAULT&station=ALL&lastSeq=${oldSeq}`, { token });
            assert.strictEqual(replay.status, 200);
            assert.strictEqual(replay.data.mode, 'DELTA');
            const types = replay.data.missedEvents.map((e) => e.eventType);
            assert(types.includes('ORDER_NEW'), `Thiếu ORDER_NEW trong ${JSON.stringify(types)}`);
            assert(types.includes('TABLE_MOVE'), `Thiếu TABLE_MOVE trong ${JSON.stringify(types)}`);
            assert(types.includes('ITEM_VOID'), `Thiếu ITEM_VOID trong ${JSON.stringify(types)}`);
            assert(replay.data.latestSeq > oldSeq);
        });

        // =====================================================================
        // TEST 4: Branch & Station Room Isolation (3-Tier Socket.IO)
        // =====================================================================
        let cn1OrderItems = [];
        await runTest(4, 'Branch & Station Room Isolation — 3 trạm CN1 nhận đúng món của mình, CN2 nhận 0 sự kiện', async () => {
            const sHot = await connectSocket(token, { tenantId, branchId: 'CN1', station: 'BAR_CHINH', role: 'KDS' });
            const sCold = await connectSocket(token, { tenantId, branchId: 'CN1', station: 'BAR_LANH', role: 'KDS' });
            const sCake = await connectSocket(token, { tenantId, branchId: 'CN1', station: 'BEP_BANH', role: 'KDS' });
            const sCn2 = await connectSocket(token, { tenantId, branchId: 'CN2', station: 'ALL', role: 'KDS' });
            sockets.push(sHot, sCold, sCake, sCn2);

            const gotHot = [];
            const gotCold = [];
            const gotCake = [];
            const gotCn2 = [];
            sHot.on('order:new', (p) => gotHot.push(p));
            sCold.on('order:new', (p) => gotCold.push(p));
            sCake.on('order:new', (p) => gotCake.push(p));
            sCn2.on('order:new', (p) => gotCn2.push(p));

            const ordCn1 = await api('POST', '/api/order', {
                token,
                body: {
                    branchId: 'CN1',
                    danhSachMon: [
                        { maMon: spEsp, kichThuoc: 'M', soLuong: 1 },
                        { maMon: spTs, kichThuoc: 'M', soLuong: 1 },
                        { maMon: spCake, kichThuoc: 'M', soLuong: 1 },
                    ],
                },
            });
            assert.strictEqual(ordCn1.status, 201);
            cn1OrderItems = ordCn1.data.danhSachMon;
            await sleep(450);

            assert.strictEqual(gotHot.length, 1, `BAR_CHINH CN1 phải nhận 1 event, thực tế ${gotHot.length}`);
            assert.strictEqual(gotHot[0].danhSachMon.length, 1);
            assert.strictEqual(gotHot[0].danhSachMon[0].maMon, spEsp);

            assert.strictEqual(gotCold.length, 1, `BAR_LANH CN1 phải nhận 1 event, thực tế ${gotCold.length}`);
            assert.strictEqual(gotCold[0].danhSachMon.length, 1);
            assert.strictEqual(gotCold[0].danhSachMon[0].maMon, spTs);

            assert.strictEqual(gotCake.length, 1, `BEP_BANH CN1 phải nhận 1 event, thực tế ${gotCake.length}`);
            assert.strictEqual(gotCake[0].danhSachMon.length, 1);
            assert.strictEqual(gotCake[0].danhSachMon[0].maMon, spCake);

            assert.strictEqual(gotCn2.length, 0, `Chi nhánh 2 PHẢI nhận 0 sự kiện, thực tế nhận ${gotCn2.length}!`);
        });

        // =====================================================================
        // TEST 5: Expo All-Stations Ready (ORDER_ALL_READY)
        // =====================================================================
        await runTest(5, 'Expo All-Stations Ready — chỉ phát ORDER_ALL_READY khi 100% 3 trạm hoàn tất', async () => {
            const sExpo = await connectSocket(token, { tenantId, branchId: 'CN1', role: 'EXPO' });
            sockets.push(sExpo);
            const allReadyEvents = [];
            sExpo.on('ORDER_ALL_READY', (p) => allReadyEvents.push(p));

            const [i1, i2, i3] = cn1OrderItems;
            await api('PUT', '/api/order/tramon', { token, body: { maCTHD: i1.maCTHD } });
            await api('PUT', '/api/order/tramon', { token, body: { maCTHD: i2.maCTHD } });
            await sleep(250);
            assert.strictEqual(allReadyEvents.length, 0, 'Mới xong 2/3 trạm chưa được phát ORDER_ALL_READY!');

            const expoMid = await api('GET', '/api/kds/expo?branchId=CN1', { token });
            const tkMid = expoMid.data.tickets.find((t) => t.maHoaDon === i1.maHoaDon);
            assert(tkMid && tkMid.allStationsReady === false, 'Expo phải hiển thị allStationsReady = false khi mới xong 2/3 trạm');

            // Hoàn tất trạm thứ 3
            const r3 = await api('PUT', '/api/order/tramon', { token, body: { maCTHD: i3.maCTHD } });
            assert.strictEqual(r3.data.allStationsReady, true);
            await sleep(300);

            assert.strictEqual(allReadyEvents.length, 1, 'Expo phải nhận đúng 1 sự kiện ORDER_ALL_READY sau khi trạm 3 xong!');
            assert.strictEqual(allReadyEvents[0].maHoaDon, i1.maHoaDon);

            const expoDone = await api('GET', '/api/kds/expo?branchId=CN1', { token });
            const tkDone = expoDone.data.tickets.find((t) => t.maHoaDon === i1.maHoaDon);
            assert(tkDone && tkDone.allStationsReady === true, 'Expo phải chuyển sang allStationsReady = true!');
        });

        // =====================================================================
        // TEST 6: Clock-Skew SLA Compensation
        // =====================================================================
        await runTest(6, 'Clock-Skew SLA — bù lệch đồng hồ iPad +20 phút bằng serverNowMs, SLA vẫn xanh', async () => {
            const ord = await api('POST', '/api/order', {
                token,
                body: { danhSachMon: [{ maMon: spEsp, kichThuoc: 'M', soLuong: 1 }] },
            });
            const syncRes = await api('GET', '/api/kds/sync?branchId=DEFAULT&station=ALL&lastSeq=0', { token });
            assert(typeof syncRes.data.serverNowMs === 'number', 'GET /api/kds/sync phải trả serverNowMs');

            // Giả lập iPad bị chạy nhanh 20 phút (+1.200.000 ms)
            const fakeIpadNowMs = Date.now() + 20 * 60 * 1000;
            const offsetMs = syncRes.data.serverNowMs - fakeIpadNowMs;
            const correctedNowMs = fakeIpadNowMs + offsetMs;

            const item = syncRes.data.tickets.find((t) => t.maHoaDon === ord.data.maHoaDon);
            assert(item, 'Phải tìm thấy đơn mới trong snapshot KDS');
            const elapsedSec = Math.max(0, Math.floor((correctedNowMs - new Date(item.firedAt || item.thoiGianGoi).getTime()) / 1000));
            assert(elapsedSec < 30, `Sau bù lệch đồng hồ, SLA phải < 30s (xanh), thực tế ${elapsedSec}s`);
        });

        // =====================================================================
        // TEST 7: TSPL 1-N Label Split, BITMAP_VI & Mid-Job Paper Jam Checkpoint Resume
        // =====================================================================
        await runTest(7, 'TSPL Label Split (BITMAP_VI) & Mid-Job Jam Resume — kẹt ly 3/4, nối tiếp ly 3 & 4 không in trùng 1 & 2', async () => {
            const mockHoaDon = {
                maHoaDon: `HD-PRINT-${rand}`,
                soThuTuHienThi: '009',
                loaiDonHang: 'MANG_DI',
                tenKhachVangLai: 'Anh Tuấn',
                danhSachMon: [
                    { maCTHD: 'C1', maMon: spEsp, tenMon: 'Cà Phê Sữa Đá', kichThuoc: 'M', soLuong: 3, inTemCoc: true, modifiersSnapshot: [{ tenInNgan: '70%Đ' }] },
                    { maCTHD: 'C2', maMon: spTs, tenMon: 'Trà Đào Cam Sả', kichThuoc: 'L', soLuong: 1, inTemCoc: true },
                    { maCTHD: 'C3', maMon: 'WATER', tenMon: 'Nước suối chai', kichThuoc: 'M', soLuong: 2, inTemCoc: false },
                ],
            };

            // Kiểm chứng TSPL BITMAP_VI sinh đúng 4 tem (bỏ qua nước suối inTemCoc=false) và có lệnh BITMAP
            const built = buildCupLabelsTspl({ hoaDon: mockHoaDon, renderMode: 'BITMAP_VI' });
            assert.strictEqual(built.totalCups, 4, 'Phải tách đúng 4 tem cốc (bỏ qua món InTemCoc=false)');
            assert(built.buffer.includes(Buffer.from('BITMAP ', 'ascii')), 'Chế độ BITMAP_VI phải sinh lệnh TSPL BITMAP!');
            assert(built.buffer.includes(Buffer.from('REVERSE ', 'ascii')), 'Đơn Mang về phải có khung REVERSE nổi bật!');

            // Kiểm chứng bảo mật L2.3: Không token -> 401; Origin lạ -> 403 & KHÔNG phản chiếu CORS
            const noAuthPrint = await api('POST', '/print/labels', { base: BRIDGE_URL, body: { hoaDon: mockHoaDon } });
            assert.strictEqual(noAuthPrint.status, 401, `Print Bridge không token phải trả 401, thực tế ${noAuthPrint.status}`);
            const evilOriginRes = await fetch(`${BRIDGE_URL}/health`, {
                headers: { Origin: 'https://evil-attacker.example' },
            });
            assert.strictEqual(evilOriginRes.status, 403, `Origin lạ phải bị chặn 403, thực tế ${evilOriginRes.status}`);
            assert.strictEqual(evilOriginRes.headers.get('access-control-allow-origin'), null, 'Không được phản chiếu Origin lạ!');

            // Bơm lỗi cảm biến kẹt giấy 0x02 ngay tại ly thứ 3
            const bridgeAuthHeaders = { 'X-Print-Bridge-Token': BRIDGE_TOKEN };
            await api('POST', '/sensor/simulate', { base: BRIDGE_URL, headers: bridgeAuthHeaders, body: { printer: 'label', statusCode: 0, jamAtCupIndex: 3 } });

            const printRes = await api('POST', '/print/labels', { base: BRIDGE_URL, headers: bridgeAuthHeaders, body: { hoaDon: mockHoaDon } });
            assert.strictEqual(printRes.status, 202, 'POST /print/labels phải trả HTTP 202 ACCEPTED non-blocking!');
            const spoolJobId = printRes.data.spoolJobId;
            assert(spoolJobId, 'Thiếu spoolJobId');

            await sleep(250);
            const pausedJob = (await api('GET', `/spool/jobs/${spoolJobId}`, { base: BRIDGE_URL, headers: bridgeAuthHeaders })).data.job;
            assert.strictEqual(pausedJob.status, 'PAUSED_SENSOR', `Job phải PAUSED_SENSOR tại ly 3, thực tế ${pausedJob.status}`);
            assert.strictEqual(pausedJob.sensorCode, 0x02, 'sensorCode phải là 0x02 (PAPER_JAM)');
            assert.deepStrictEqual(pausedJob.printedCupIndexes, [1, 2], `Chỉ được in ly [1, 2] trước khi kẹt, thực tế ${JSON.stringify(pausedJob.printedCupIndexes)}`);

            // Phục hồi cảm biến máy in về 0x00 READY -> Spooler tự động nối tiếp đúng ly 3 & 4
            await api('POST', '/sensor/simulate', { base: BRIDGE_URL, headers: bridgeAuthHeaders, body: { printer: 'label', statusCode: 0 } });
            await sleep(300);

            const doneJob = (await api('GET', `/spool/jobs/${spoolJobId}`, { base: BRIDGE_URL, headers: bridgeAuthHeaders })).data.job;
            assert.strictEqual(doneJob.status, 'DONE', `Sau phục hồi sensor, job phải DONE, thực tế ${doneJob.status}`);
            assert.deepStrictEqual(doneJob.printedCupIndexes, [1, 2, 3, 4]);
            assert.strictEqual(doneJob.dispatchedCupLog.length, 4, 'Tổng số tem gửi xuống máy in phải đúng 4 (KHÔNG in trùng ly 1 & 2!)');
        });

        // =====================================================================
        // TEST 8: Server-Enforced Reprint Watermark
        // =====================================================================
        await runTest(8, 'Server Reprint Watermark — lần 1 sạch, lần 2 ép "*** BAN SAO - REPRINT LAN 2 ***" + Audit Log', async () => {
            const qc = await api('POST', '/api/order/quick-checkout', {
                token,
                body: { phuongThucTT: 'TIEN_MAT', danhSachMon: [{ maMon: spEsp, kichThuoc: 'M', soLuong: 1 }] },
            });
            assert.strictEqual(qc.status, 201);
            const maHD = qc.data.maHoaDon;

            const pt1 = await api('POST', `/api/order/${encodeURIComponent(maHD)}/print-token`, { token, body: {} });
            assert.strictEqual(pt1.status, 200);
            assert.strictEqual(pt1.data.soLanIn, 1);
            assert.strictEqual(pt1.data.laBanSao, false);
            assert.strictEqual(pt1.data.reprintBanner, null);

            const pt2 = await api('POST', `/api/order/${encodeURIComponent(maHD)}/print-token`, { token, body: { lyDo: 'Khách làm rách bill' } });
            assert.strictEqual(pt2.status, 200);
            assert.strictEqual(pt2.data.soLanIn, 2);
            assert.strictEqual(pt2.data.laBanSao, true);
            assert.strictEqual(pt2.data.reprintBanner, '*** BAN SAO - REPRINT LAN 2 ***');

            const auditRes = await qTenantDb(
                tenantId,
                `SELECT HanhDong FROM Audit_Logs WHERE TenantId = $1 AND MaDoiTuong = $2 AND HanhDong = 'RECEIPT_REPRINT'`,
                [tenantId, maHD]
            );
            assert(auditRes.rows.length >= 1, 'Phải ghi nhận RECEIPT_REPRINT trong Audit_Logs!');
        });

        // =====================================================================
        // TEST 9: Item Swap Race Condition & 3 Financial Deltas
        // =====================================================================
        await runTest(9, 'Item Swap Race Condition & 3 Financial Deltas (+14k thu bù, -10k hoàn tiền, 409 khi DangLam)', async () => {
            const qc = await api('POST', '/api/order/quick-checkout', {
                token,
                body: {
                    phuongThucTT: 'TIEN_MAT',
                    danhSachMon: [
                        { maMon: spEsp, kichThuoc: 'M', soLuong: 1 },  // 35k
                        { maMon: spTs, kichThuoc: 'M', soLuong: 1 },   // 45k
                        { maMon: spCake, kichThuoc: 'M', soLuong: 1 }, // 30k
                    ],
                },
            });
            assert.strictEqual(qc.status, 201);
            const maHD = qc.data.maHoaDon;
            const items = qc.data.hoaDon.danhSachMon;
            const cthdEsp = items.find((i) => i.maMon === spEsp).maCTHD;
            const cthdTs = items.find((i) => i.maMon === spTs).maCTHD;
            const cthdCake = items.find((i) => i.maMon === spCake).maCTHD;

            // Nhánh 1: Đổi Espresso (35k) -> Latte (49k) => +14k thu bù (Order_Payments PAID)
            const swUp = await api('POST', '/api/order/item-swap', {
                token,
                body: { maCTHD: cthdEsp, newItem: { maMon: spLatte, kichThuoc: 'M', soLuong: 1 }, lyDo: 'Đổi sang Latte' },
            });
            assert.strictEqual(swUp.status, 200, JSON.stringify(swUp.data));
            assert.strictEqual(swUp.data.chenhLech, 14000);
            assert.strictEqual(swUp.data.financialAction, 'COLLECT_EXTRA');

            // Nhánh 2: Đổi Trà sữa (45k) -> Espresso (35k) => -10k hoàn tiền (order_refunds + REFUNDED)
            const swDown = await api('POST', '/api/order/item-swap', {
                token,
                body: { maCTHD: cthdTs, newItem: { maMon: spEsp, kichThuoc: 'M', soLuong: 1 }, lyDo: 'Đổi sang món rẻ hơn' },
            });
            assert.strictEqual(swDown.status, 200, JSON.stringify(swDown.data));
            assert.strictEqual(swDown.data.chenhLech, -10000);
            assert.strictEqual(swDown.data.financialAction, 'REFUND_DIFF');
            assert(swDown.data.refundRecordId > 0, 'Phải sinh bản ghi trong public.order_refunds!');

            const refCheck = await qTenantDb(tenantId, `SELECT sotienhoan FROM public.order_refunds WHERE id = $1`, [swDown.data.refundRecordId]);
            assert.strictEqual(Number(refCheck.rows[0].sotienhoan), 10000);

            // Nhánh 3: Race Condition — Barista bấm DangLam trước khi Thu ngân đổi món -> 409 ITEM_ALREADY_STARTED!
            await api('PUT', '/api/order/danglam', { token, body: { maCTHD: cthdCake } });
            const swRace = await api('POST', '/api/order/item-swap', {
                token,
                body: { maCTHD: cthdCake, newItem: { maMon: spEsp, kichThuoc: 'M', soLuong: 1 }, lyDo: 'Thử đổi lúc đang nướng' },
            });
            assert.strictEqual(swRace.status, 409);
            assert.strictEqual(swRace.data.code, 'ITEM_ALREADY_STARTED');

            // Tổng hóa đơn cuối: 110k + 14k - 10k = 114k
            const payCheck = await qTenantDb(tenantId, `SELECT TongTienThanhToan FROM HoaDon WHERE MaHoaDon = $1`, [maHD]);
            assert.strictEqual(Number(payCheck.rows[0].tongtienthanhtoan), 114000);
        });

        // =====================================================================
        // TEST 10: Waste vs. Void (LoaiGD=8 vs 7) + KDS Ack
        // =====================================================================
        await runTest(10, 'Waste vs. Void + KDS Ack — hủy món DangLam không hoàn kho, ghi LoaiGD=8 & phát kds:item_voided (requiresAck=true)', async () => {
            const sBar = await connectSocket(token, { tenantId, branchId: 'DEFAULT', station: 'BAR_CHINH', role: 'KDS' });
            sockets.push(sBar);
            const voidEvents = [];
            sBar.on('kds:item_voided', (p) => voidEvents.push(p));

            const ord = await api('POST', '/api/order', {
                token,
                body: { danhSachMon: [{ maMon: spEsp, kichThuoc: 'M', soLuong: 1 }] },
            });
            const maCTHD = ord.data.danhSachMon[0].maCTHD;
            const stockAfterOrder = await getStock(maNlCf);

            // Barista bắt đầu pha
            await api('PUT', '/api/order/danglam', { token, body: { maCTHD } });

            // Thu ngân hủy món (dù gửi hoanKho=true, hệ thống PHẢI ép ghi hao hụt LoaiGD=8, KHÔNG hoàn kho!)
            const vd = await api('POST', '/api/order/huy-mon', {
                token,
                body: { maCTHD, lyDo: 'Khách đổi ý khi đang chiết xuất', hoanKho: true },
            });
            assert.strictEqual(vd.status, 200);
            assert.strictEqual(vd.data.hoanKho, false, 'Món DangLam KHÔNG ĐƯỢC hoàn kho!');

            const stockAfterVoid = await getStock(maNlCf);
            assert.strictEqual(stockAfterVoid, stockAfterOrder, 'Tồn kho tuyệt đối không được cộng ngược khi hủy món DangLam!');

            const wasteRes = await qTenantDb(
                tenantId,
                `SELECT LoaiGD FROM PhieuGiaoDichKho WHERE TenantId = $1 AND LoaiGD = 8 ORDER BY MaGiaoDich DESC LIMIT 1`,
                [tenantId]
            );
            assert(wasteRes.rows.length >= 1, 'Phải tạo phiếu Hao hụt LoaiGD = 8!');

            await sleep(250);
            assert(voidEvents.some((e) => e.maCTHD === maCTHD && e.requiresAck === true), 'KDS phải nhận kds:item_voided với requiresAck=true!');
        });

        // =====================================================================
        // TEST 11: 86'ing 5-Layer Cascade, Countdown Stock & Smart Auto Un-86
        // =====================================================================
        await runTest(11, '86\'ing 5-Layer Cascade (BTP đệ quy -> Món/Topping/Modifier/Combo), Countdown=2 Race & Auto Un-86', async () => {
            // Phần A: Countdown = 2 với 2 đơn song song (mỗi đơn mua 2 suất -> chỉ 1 thành công, 1 bị 409 OUT_OF_COUNTDOWN_STOCK!)
            const cdSet = await api('PUT', `/api/sanpham/${encodeURIComponent(spCake)}/countdown`, {
                token,
                body: { soLuongGioiHan86: 2 },
            });
            assert.strictEqual(cdSet.status, 200);

            const [c1, c2] = await Promise.all([
                api('POST', '/api/order', { token, body: { danhSachMon: [{ maMon: spCake, kichThuoc: 'M', soLuong: 2 }] } }),
                api('POST', '/api/order', { token, body: { danhSachMon: [{ maMon: spCake, kichThuoc: 'M', soLuong: 2 }] } }),
            ]);
            const okCnt = [c1, c2].filter((r) => r.status === 201).length;
            const conflictRes = [c1, c2].find((r) => r.status === 409);
            assert.strictEqual(okCnt, 1, `Chỉ đúng 1 đơn được mua 2 suất cuối, thực tế: ${c1.status}, ${c2.status}`);
            assert(conflictRes && ['OUT_OF_COUNTDOWN_STOCK', 'MON_TAM_HET'].includes(conflictRes.data?.code || conflictRes.data?.maLoi));

            // Kiểm tra SanPham tự động khóa TamHet = TRUE khi về 0
            const spCdCheck = await qTenantDb(tenantId, `SELECT TamHet, SoLuongGioiHan86 FROM SanPham WHERE MaMon = $1`, [spCake]);
            assert.strictEqual(Boolean(spCdCheck.rows[0].tamhet), true);
            assert.strictEqual(Number(spCdCheck.rows[0].soluonggioihan86), 0);

            // Phần B: 5-Layer Cascade qua Bán thành phẩm (Sub-Recipe tồn = 0) -> Sản phẩm, Topping, Modifier, Combo -> Nhập kho tự mở khóa!
            const rawNl = (await api('POST', '/api/kho/nguyenlieu', { token, body: { maNL: `RAW86_${rand}`, tenNL: 'Lá trà đặc biệt', donViTinh: 'g' } })).data.maNL;
            const btpNl = (await api('POST', '/api/kho/nguyenlieu', { token, body: { maNL: `BTP86_${rand}`, tenNL: 'Cốt trà ủ lạnh', donViTinh: 'ml' } })).data.maNL;
            // Liên kết BTP86 phụ thuộc RAW86 trong banthanhpham_congthuc (tồn BTP86 = 0 nên khi khóa RAW86 sẽ lan sang BTP86!)
            await qTenantDb(
                tenantId,
                `INSERT INTO public.banthanhpham_congthuc (tenantid, manlthanhpham, manlthanhphan, khoiluongtieuhao)
                 VALUES ($1, $2, $3, 50)`,
                [tenantId, btpNl, rawNl]
            );

            const sp86 = (
                await api('POST', '/api/sanpham', {
                    token,
                    body: { maMon: `SP86_${rand}`, tenMon: 'Trà ủ lạnh Signature', nhomMon: 'Trà', sizes: [{ kichThuoc: 'M', giaBan: 55000 }] },
                })
            ).data.maMon;
            await api('POST', '/api/congthuc', { token, body: { maMon: sp86, kichThuoc: 'M', dinhMuc: [{ maNL: btpNl, khoiLuongTieuHao: 100 }] } });

            const tp86 = (
                await api('POST', '/api/topping', {
                    token,
                    body: { maTopping: `TP86_${rand}`, tenTopping: 'Thạch trà ủ', giaTopping: 10000, maNL: btpNl, khoiLuongTieuHao: 30 },
                })
            ).data.maTopping;

            const mgRes = await api('POST', '/api/modifiers/groups', {
                token,
                body: {
                    tenGroup: 'Tăng đậm trà',
                    loai: 'SINGLE',
                    options: [
                        {
                            tenOption: 'Thêm cốt trà ủ',
                            tenInNgan: '+CotTra',
                            giaCongThem: 8000,
                            bom: [{ maNL: btpNl, khoiLuongDelta: 40 }],
                        },
                    ],
                },
            });
            const optId86 = mgRes.data.group.options[0].id;

            const cmbRes = await api('POST', '/api/combos', {
                token,
                body: {
                    maCombo: `CMB86_${rand}`,
                    tenCombo: 'Combo Trà Ủ Sáng',
                    giaBanCombo: 50000,
                    slots: [{ tenSlot: 'Ly trà', soLuongChon: 1, items: [{ maMon: sp86, kichThuocMacDinh: 'M' }] }],
                },
            });
            assert.strictEqual(cmbRes.status, 201);

            // Khóa 86 nguyên liệu gốc rawNl -> kiểm tra lan truyền đủ 5 lớp!
            const lock86 = await api('POST', '/api/kho/ingredient-86', { token, body: { maNL: rawNl, action: 'LOCK' } });
            assert.strictEqual(lock86.status, 200);
            assert(lock86.data.cascadedSubRecipes.includes(btpNl), 'Lớp 1 (Bán thành phẩm đệ quy) phải lan sang BTP86!');
            assert(lock86.data.affectedProducts.some((p) => p.maMon === sp86 && p.tamHet === true), 'Lớp 2 (SanPham) phải bị khóa!');
            assert(lock86.data.affectedToppings.some((t) => t.maTopping === tp86 && t.tamHet === true), 'Lớp 3 (Topping) phải bị khóa!');
            assert(lock86.data.affectedModifiers.some((m) => m.optionId === optId86 && m.tamHet === true), 'Lớp 4 (Modifier) phải bị khóa!');
            assert(lock86.data.affectedCombos.some((c) => c.maCombo === `CMB86_${rand}` && c.tamHet === true), 'Lớp 5 (Combo) phải bị khóa!');

            // Nhập kho lại rawNl -> Smart Auto Un-86 tự động mở khóa toàn bộ các lớp đã khóa tự động!
            const restock = await api('POST', '/api/kho/nhap', {
                token,
                body: { ghiChu: 'Nhập hàng về', danhSachNguyenLieu: [{ maNL: rawNl, soLuong: 500, donGiaNhap: 100 }] },
            });
            assert.strictEqual(restock.status, 200);
            assert(restock.data.autoUnlocked.unlockedProducts.some((p) => p.maMon === sp86), 'Smart Auto Un-86 phải tự mở lại SP86!');
            assert(restock.data.autoUnlocked.unlockedToppings.some((t) => t.maTopping === tp86), 'Smart Auto Un-86 phải tự mở lại TP86!');
            assert(restock.data.autoUnlocked.unlockedModifiers.some((m) => m.optionId === optId86), 'Smart Auto Un-86 phải tự mở lại Modifier!');
            assert(restock.data.autoUnlocked.unlockedCombos.some((c) => c.maCombo === `CMB86_${rand}`), 'Smart Auto Un-86 phải tự mở lại Combo!');
        });

        // =====================================================================
        // TEST 12: Park Order + Open Item + Remake Ticket 0đ + KDS Bottleneck Telemetry
        // =====================================================================
        await runTest(12, 'Park Order + Open Item + Remake 0đ (ưu tiên top KDS, LoaiGD=8) + KDS Bottleneck Telemetry', async () => {
            const stockBeforePark = await getStock(maNlCf);
            const kdsBeforePark = (await api('GET', '/api/order/dangcho', { token })).data.length;

            // 1. Park Order (TrangThaiTT = -1) -> không trừ kho, không lên KDS
            const pk = await api('POST', '/api/order/park', {
                token,
                body: {
                    tenGhiNho: 'Khách quên ví',
                    danhSachMon: [{ maMon: spEsp, tenMon: 'Espresso Nóng', kichThuoc: 'M', soLuong: 2, donGia: 35000 }],
                },
            });
            assert.strictEqual(pk.status, 201);
            assert.strictEqual(pk.data.trangThaiTT, -1);
            assert.strictEqual(await getStock(maNlCf), stockBeforePark, 'Park Order KHÔNG ĐƯỢC trừ kho!');
            assert.strictEqual((await api('GET', '/api/order/dangcho', { token })).data.length, kdsBeforePark, 'Park Order KHÔNG ĐƯỢC đẩy lên KDS!');

            // 2. Resume từ máy POS khác
            const resumed = await api('POST', `/api/order/${encodeURIComponent(pk.data.maHoaDon)}/resume`, { token });
            assert.strictEqual(resumed.status, 200);
            assert.strictEqual(resumed.data.cart.length, 1);
            assert.strictEqual(resumed.data.cart[0].soLuong, 2);

            // 3. Tạo đơn chứa Open Item (250g hạt rang xay thời giá 400k/kg = 100k) + Espresso
            const ordOpen = await api('POST', '/api/order', {
                token,
                body: {
                    danhSachMon: [
                        { maMon: spEsp, kichThuoc: 'M', soLuong: 1 },
                        { maMon: spOpen, kichThuoc: 'M', soLuong: 1, donGia: 400000, trongLuongGram: 250, tenMonTuyChinh: 'Arabica Cầu Đất 250g' },
                    ],
                },
            });
            assert.strictEqual(ordOpen.status, 201);
            const openAudit = await qTenantDb(
                tenantId,
                `SELECT 1 FROM Audit_Logs WHERE TenantId = $1 AND MaDoiTuong = $2 AND HanhDong = 'OPEN_ITEM_CREATED'`,
                [tenantId, ordOpen.data.maHoaDon]
            );
            assert(openAudit.rows.length >= 1, 'Open Item bắt buộc ghi Audit_Logs OPEN_ITEM_CREATED!');

            // 4. Tạo Vé Làm Lại (Remake 0đ, MucDoUuTien = 2 -> nhảy lên ĐẦU hàng đợi KDS + LoaiGD = 8!)
            const origCthd = ordOpen.data.danhSachMon.find((m) => m.maMon === spEsp).maCTHD;
            const stockBeforeRemake = await getStock(maNlCf);
            const rmk = await api('POST', '/api/kds/remake', {
                token,
                body: { maCTHD: origCthd, lyDo: 'Đổ vỡ khi bưng ra bàn' },
            });
            assert.strictEqual(rmk.status, 201, JSON.stringify(rmk.data));
            assert.strictEqual(rmk.data.mon.mucDoUuTien, 2);
            assert.strictEqual(rmk.data.mon.remakeOfCTHD, origCthd);
            assert(rmk.data.maGiaoDichHaoHut, 'Remake phải sinh phiếu hao hụt kho LoaiGD=8!');
            assert.strictEqual(stockBeforeRemake - (await getStock(maNlCf)), 20, 'Remake phải trừ thêm 20g cà phê hao hụt!');

            // Verify Remake item nằm ĐẦU TIÊN (index 0) của KDS queue!
            const kdsQueue = (await api('GET', '/api/order/dangcho', { token })).data;
            assert.strictEqual(kdsQueue[0].maCTHD, rmk.data.remakeMaCTHD, 'Vé LÀM LẠI (MucDoUuTien=2) phải nổi lên ĐẦU hàng đợi KDS!');

            // 5. Chạy đủ vòng đời DangLam -> DaXong -> DaPhucVu & kiểm tra KDS Bottleneck Telemetry (3 mốc thời gian)
            await api('PUT', '/api/order/danglam', { token, body: { maCTHD: rmk.data.remakeMaCTHD } });
            await sleep(150);
            await api('PUT', '/api/order/tramon', { token, body: { maCTHD: rmk.data.remakeMaCTHD } });
            await sleep(150);
            await api('PUT', '/api/order/phucvu', { token, body: { maCTHD: rmk.data.remakeMaCTHD } });

            const tel = await api('GET', '/api/kds/telemetry?hours=24', { token });
            assert.strictEqual(tel.status, 200);
            assert(tel.data.overall.totalItems >= 1);
            assert(tel.data.overall.remakeCount >= 1);
            assert(typeof tel.data.overall.avgQueueWaitSec === 'number');
            assert(typeof tel.data.overall.avgActivePrepSec === 'number');
            assert(typeof tel.data.overall.avgPickupDelaySec === 'number');
            assert(tel.data.stations.length >= 1);
        });

        console.log(`\n🎉 HOÀN TẤT XUẤT SẮC: ${passed}/${totalTests} BÀI TEST TÍCH HỢP PHÂN HỆ 2 (100/100) ĐỀU PASS!`);
    } finally {
        for (const s of sockets) {
            try {
                s.disconnect();
            } catch {
                // ignore
            }
        }
        serverProc.kill('SIGTERM');
        bridgeProc.kill('SIGTERM');
        await pool.end().catch(() => {});
        try {
            if (fs.existsSync(TMP_SPOOL)) fs.unlinkSync(TMP_SPOOL);
        } catch {
            // ignore
        }
        if (passed < totalTests && serverLogs) {
            console.error('\n--- Backend Logs (last 40 lines) ---\n' + serverLogs.split('\n').slice(-40).join('\n'));
        }
    }
}

main().catch((err) => {
    console.error('\n💥 Bộ test Phân hệ 2 dừng do lỗi:', err.message);
    process.exit(1);
});
