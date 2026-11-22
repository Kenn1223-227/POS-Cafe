/**
 * =============================================================================
 * PHÂN HỆ 4 (81 -> 100/100) — 12 BÀI TEST TÍCH HỢP TỰ ĐỘNG BẮT BUỘC
 * Kiểm thử trực tiếp trên PostgreSQL (app_runtime NOBYPASSRLS) + Express Server
 * =============================================================================
 */
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const pool = require(path.join(__dirname, '..', 'db'));

const TEST_PORT = 3404;
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
            tenQuan: `PH4 Test Cafe ${rand}`,
            moHinh: 'CAFE_TAKEAWAY',
            soBan: 5,
            tenChuQuan: `Chu Quan ${tag}`,
            tenDangNhap: `ph4_${rand.toLowerCase()}`,
            email: `ph4_${rand.toLowerCase()}@test.local`,
            matKhau: 'TestPass123!',
            goiCuoc: 'PRO',
        },
    });
    assert.strictEqual(reg.status, 201, `Đăng ký tenant ${tag} thất bại: ${JSON.stringify(reg.data)}`);
    const tenantId = reg.data.tenant?.tenantId || reg.data.user?.tenantId;
    const slug = reg.data.tenant?.slug || reg.data.user?.tenantSlug || tenantId;
    return { rand, token: reg.data.token, tenantId, slug, user: reg.data.user };
}

async function main() {
    console.log('🚀 Khởi động Backend tạm cho 12 bài test Phân hệ 4 (Inventory Single-Source, Safe WAC, FEFO, BOM 5-Layer & AvT)...\n');
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

        const { token, tenantId, slug, rand } = await registerFreshTenant('INV4');
        const mainBranch = `${tenantId}_MAIN`;

        // Đảm bảo có ca mở
        const openCa = await api('POST', '/api/ca/mo-ca', { token, body: { tienMatDauCa: 500000 } });
        assert([200, 201, 409].includes(openCa.status));

        // Tạo Chi nhánh 2 (BR2)
        const br2Res = await api('POST', '/api/branches', {
            token,
            body: { maChiNhanh: 'CN02', tenChiNhanh: 'Chi nhánh 2 - Quận 7', khuVucGia: 'HCM' },
        });
        assert.strictEqual(br2Res.status, 201, `Tạo CN2 thất bại: ${JSON.stringify(br2Res.data)}`);
        const br2 = br2Res.data.branch?.branchid || br2Res.data.branch?.branchId || br2Res.data.branchId;
        assert(br2 && br2 !== mainBranch, `Thiếu branchId CN2: ${JSON.stringify(br2Res.data)}`);

        // Helpers tạo Nguyên liệu & Món + Công thức
        const makeNL = async (code, name, unit, hanMuc = 100, giaVon = 0) => {
            const r = await api('POST', '/api/kho/nguyenlieu', {
                token,
                body: { maNL: `${code}_${rand}`, tenNL: name, donViTinh: unit, hanMucCanhBao: hanMuc, giaVonDonVi: giaVon },
            });
            assert.strictEqual(r.status, 201, `Tạo NL ${code} thất bại: ${JSON.stringify(r.data)}`);
            return r.data.maNL;
        };

        const makeItem = async (code, name, price, bomList = []) => {
            const r = await api('POST', '/api/sanpham', {
                token,
                body: { maMon: `${code}_${rand}`, tenMon: name, nhomMon: 'Cà phê', sizes: [{ kichThuoc: 'M', giaBan: price }] },
            });
            assert.strictEqual(r.status, 200, `Tạo món ${code} thất bại: ${JSON.stringify(r.data)}`);
            if (bomList.length > 0) {
                const ct = await api('POST', '/api/congthuc', {
                    token,
                    body: { maMon: r.data.maMon, kichThuoc: 'M', dinhMuc: bomList },
                });
                assert.strictEqual(ct.status, 200, `Lưu công thức ${code} thất bại: ${JSON.stringify(ct.data)}`);
            }
            return r.data.maMon;
        };

        const getBranchStock = async (branchId, maNL) => {
            const r = await qTenantDb(
                tenantId,
                `SELECT soluongton, giavondonvi, tondangchuyen FROM public.tonkhochinhanh WHERE tenantid = $1 AND branchid = $2 AND manl = $3`,
                [tenantId, branchId, maNL]
            );
            return r.rows[0]
                ? {
                      ton: Number(r.rows[0].soluongton),
                      wac: Number(r.rows[0].giavondonvi),
                      inTransit: Number(r.rows[0].tondangchuyen || 0),
                  }
                : null;
        };

        // =====================================================================
        // TEST 1: Single-Source Multi-Branch Isolation
        // =====================================================================
        await runTest(1, 'Single-Source Multi-Branch Isolation — Bán 10 ly CN2 & 5 ly CN1 trừ đúng TonKhoChiNhanh từng CN, WAC độc lập', async () => {
            const nlCf = await makeNL('CF_MB', 'Cà phê hạt MultiBranch', 'g', 50, 0);
            // Nhập CN1: 1000g giá 200đ/g; Nhập CN2: 1000g giá 250đ/g (do cước vùng khác!)
            const in1 = await api('POST', '/api/kho/nhap', {
                token,
                body: { branchId: mainBranch, danhSachNguyenLieu: [{ maNL: nlCf, soLuong: 1000, donGiaNhap: 200 }] },
            });
            const in2 = await api('POST', '/api/kho/nhap', {
                token,
                body: { branchId: br2, danhSachNguyenLieu: [{ maNL: nlCf, soLuong: 1000, donGiaNhap: 250 }] },
            });
            assert.strictEqual(in1.status, 200);
            assert.strictEqual(in2.status, 200);

            const spCf = await makeItem('CF_ISO', 'Espresso Isolation', 35000, [{ maNL: nlCf, khoiLuongTieuHao: 20 }]);

            // Bán 5 ly CN1 (-100g) & 10 ly CN2 (-200g)
            const o1 = await api('POST', '/api/order', {
                token,
                body: { branchId: mainBranch, danhSachMon: [{ maMon: spCf, kichThuoc: 'M', soLuong: 5 }] },
            });
            const o2 = await api('POST', '/api/order', {
                token,
                body: { branchId: br2, danhSachMon: [{ maMon: spCf, kichThuoc: 'M', soLuong: 10 }] },
            });
            assert.strictEqual(o1.status, 201, JSON.stringify(o1.data));
            assert.strictEqual(o2.status, 201, JSON.stringify(o2.data));

            const st1 = await getBranchStock(mainBranch, nlCf);
            const st2 = await getBranchStock(br2, nlCf);
            assert.strictEqual(st1.ton, 900, `CN1 phải còn 900g, thực tế ${st1.ton}`);
            assert.strictEqual(st2.ton, 800, `CN2 phải còn 800g, thực tế ${st2.ton}`);
            assert.strictEqual(st1.wac, 200, `CN1 phải giữ WAC 200đ/g, thực tế ${st1.wac}`);
            assert.strictEqual(st2.wac, 250, `CN2 phải giữ WAC 250đ/g, thực tế ${st2.wac}`);

            // Kiểm tra NguyenLieu đồng bộ với CN1 (không bị CN2 làm vênh!)
            const nlCatalog = await qTenantDb(tenantId, `SELECT soluongton FROM nguyenlieu WHERE manl = $1`, [nlCf]);
            assert.strictEqual(Number(nlCatalog.rows[0].soluongton), 900);
        });

        // =====================================================================
        // TEST 2: Concurrent Order Deadlock Resistance (30 đồng thời đảo thứ tự [NL_A, NL_B] vs [NL_B, NL_A])
        // =====================================================================
        await runTest(2, 'Concurrent Order Deadlock Resistance — 30 đơn song song đảo thứ tự BOM -> 0 lỗi 40P01, tồn kho khớp 100%', async () => {
            const nlA = await makeNL('DL_A', 'Nguyên liệu Deadlock A', 'ml', 10, 10);
            const nlB = await makeNL('DL_B', 'Nguyên liệu Deadlock B', 'ml', 10, 15);
            await api('POST', '/api/kho/nhap', {
                token,
                body: {
                    branchId: mainBranch,
                    danhSachNguyenLieu: [
                        { maNL: nlA, soLuong: 5000, donGiaNhap: 10 },
                        { maNL: nlB, soLuong: 5000, donGiaNhap: 15 },
                    ],
                },
            });

            const spAB = await makeItem('SP_AB', 'Cà phê sữa AB', 30000, [
                { maNL: nlA, khoiLuongTieuHao: 20 },
                { maNL: nlB, khoiLuongTieuHao: 30 },
            ]);
            const spBA = await makeItem('SP_BA', 'Bạc xỉu BA', 32000, [
                { maNL: nlB, khoiLuongTieuHao: 40 },
                { maNL: nlA, khoiLuongTieuHao: 10 },
            ]);

            const reqs = [];
            for (let i = 0; i < 30; i++) {
                const maMon = i % 2 === 0 ? spAB : spBA; // 15 đơn AB + 15 đơn BA song song!
                reqs.push(
                    api('POST', '/api/order', {
                        token,
                        body: { branchId: mainBranch, danhSachMon: [{ maMon, kichThuoc: 'M', soLuong: 1 }] },
                    })
                );
            }
            const results = await Promise.all(reqs);
            const failed = results.filter((r) => r.status !== 201);
            assert.strictEqual(failed.length, 0, `Có ${failed.length} request lỗi (Deadlock/5xx): ${JSON.stringify(failed[0]?.data)}`);

            // 15*(20) + 15*(10) = 450 ml của A; 15*(30) + 15*(40) = 1050 ml của B
            const stA = await getBranchStock(mainBranch, nlA);
            const stB = await getBranchStock(mainBranch, nlB);
            assert.strictEqual(stA.ton, 5000 - 450, `Tồn A phải là 4550, thực tế ${stA.ton}`);
            assert.strictEqual(stB.ton, 5000 - 1050, `Tồn B phải là 3950, thực tế ${stB.ton}`);
        });

        // =====================================================================
        // TEST 3: Negative Stock Safe WAC + COGS Adjustment
        // =====================================================================
        await runTest(3, 'Negative Stock Safe WAC + COGS Adjustment — tồn -800ml (WAC 30đ) nhập +1000ml giá 35đ -> WAC=35đ, tồn +200ml, cogsAdjustment=+4000đ', async () => {
            const nlMilk = await makeNL('MILK_NEG', 'Sữa tươi âm kho', 'ml', 100, 30);
            // Khởi tạo dòng TonKhoChiNhanh ở -800ml, WAC = 30đ
            await api('POST', '/api/kho/nhap', {
                token,
                body: { branchId: mainBranch, danhSachNguyenLieu: [{ maNL: nlMilk, soLuong: 200, donGiaNhap: 30 }] },
            });
            // Xuất hủy 1000ml để đưa tồn về đúng -800ml (giữ nguyên WAC = 30đ)
            const waste = await api('POST', '/api/kho/kiemke', {
                token,
                body: {
                    loaiGD: 2,
                    branchId: mainBranch,
                    maLyDoHuy: 'BARISTA_SPILL',
                    danhSachNguyenLieu: [{ maNL: nlMilk, soLuong: 1000 }],
                },
            });
            assert.strictEqual(waste.status, 200);
            const stBefore = await getBranchStock(mainBranch, nlMilk);
            assert.strictEqual(stBefore.ton, -800);
            assert.strictEqual(stBefore.wac, 30);

            // Nhập bù +1000ml giá 35đ/ml
            const stockIn = await api('POST', '/api/kho/nhap', {
                token,
                body: { branchId: mainBranch, danhSachNguyenLieu: [{ maNL: nlMilk, soLuong: 1000, donGiaNhap: 35 }] },
            });
            assert.strictEqual(stockIn.status, 200, JSON.stringify(stockIn.data));
            assert.strictEqual(stockIn.data.cogsAdjustment, 4000, `cogsAdjustment phải là +4000đ, thực tế ${stockIn.data.cogsAdjustment}`);

            const stAfter = await getBranchStock(mainBranch, nlMilk);
            assert.strictEqual(stAfter.ton, 200, `Tồn sau phải là +200ml, thực tế ${stAfter.ton}`);
            assert.strictEqual(stAfter.wac, 35, `Safe WAC phải là 35đ (tuyệt đối không vọt 55đ!), thực tế ${stAfter.wac}`);
        });

        // =====================================================================
        // TEST 4: Landed Cost Allocation (10 Thùng 12.000ml x 360k + 240k ship = 32đ/ml)
        // =====================================================================
        await runTest(4, 'Landed Cost Allocation — 10 Thùng (120.000ml, 3.6tr) + phí xe lạnh 240k -> donGiaNhapThucTe = 32đ/ml (0đ sai số)', async () => {
            const nlLc = await makeNL('MILK_LC', 'Sữa tươi Landed Cost', 'ml', 500, 0);
            const inLc = await api('POST', '/api/kho/nhap', {
                token,
                body: {
                    branchId: mainBranch,
                    chiPhiVanChuyen: 240000,
                    danhSachNguyenLieu: [
                        { maNL: nlLc, soLuong: 10, donGiaNhap: 360000, donViNhap: 'Thùng', heSoQuyDoi: 12000 },
                    ],
                },
            });
            assert.strictEqual(inLc.status, 200, JSON.stringify(inLc.data));
            assert.strictEqual(inLc.data.lineResults[0].donGiaNhapThucTe, 32, 'Đơn giá thực tế phải đúng 32đ/ml');
            const st = await getBranchStock(mainBranch, nlLc);
            assert.strictEqual(st.ton, 120000);
            assert.strictEqual(st.wac, 32);
        });

        // =====================================================================
        // TEST 5: Purchase Receipt Reversal & WAC Replay (350đ -> Reverse LoaiGD=9 -> 35đ)
        // =====================================================================
        await runTest(5, 'Purchase Receipt Reversal & WAC Replay — gõ nhầm 350đ/ml -> lập phiếu đảo LoaiGD=9 + nhập đúng 35đ -> WAC về chuẩn 35đ/ml', async () => {
            const nlRev = await makeNL('MILK_REV', 'Sữa tươi Reversal', 'ml', 100, 0);
            // Nhập nhầm 1000ml giá 350đ/ml (dư 1 số 0!)
            const wrongIn = await api('POST', '/api/kho/nhap', {
                token,
                body: { branchId: mainBranch, danhSachNguyenLieu: [{ maNL: nlRev, soLuong: 1000, donGiaNhap: 350 }] },
            });
            assert.strictEqual(wrongIn.status, 200);
            const wrongMaGD = wrongIn.data.maGiaoDich;
            assert.strictEqual((await getBranchStock(mainBranch, nlRev)).wac, 350);

            // Chạy Reversal -> phát sinh phiếu LoaiGD = 9, KHÔNG xóa cứng phiếu cũ!
            const rev = await api('POST', `/api/kho/phieu/${encodeURIComponent(wrongMaGD)}/reverse`, {
                token,
                body: { lyDo: 'Kế toán gõ dư 1 số 0 (350đ thay vì 35đ)' },
            });
            assert.strictEqual(rev.status, 200, JSON.stringify(rev.data));

            // Xác minh phiếu gốc vẫn còn trong sổ cái & phiếu đảo có LoaiGD = 9
            const checkLedger = await qTenantDb(
                tenantId,
                `SELECT magiaodich, loaigd, magdthamchieu FROM phieugiaodichkho WHERE magiaodich::text IN ($1::text, $2::text)`,
                [String(wrongMaGD), String(rev.data.maGDReversal)]
            );
            assert.strictEqual(checkLedger.rows.length, 2, 'Không được xóa cứng phiếu gốc và phải có phiếu đảo!');
            const revRow = checkLedger.rows.find((r) => String(r.magiaodich) === String(rev.data.maGDReversal));
            assert.strictEqual(Number(revRow.loaigd), 9);

            // Nhập lại đúng 1000ml giá 35đ/ml
            const rightIn = await api('POST', '/api/kho/nhap', {
                token,
                body: { branchId: mainBranch, danhSachNguyenLieu: [{ maNL: nlRev, soLuong: 1000, donGiaNhap: 35 }] },
            });
            assert.strictEqual(rightIn.status, 200);
            const stFinal = await getBranchStock(mainBranch, nlRev);
            assert.strictEqual(stFinal.ton, 1000);
            assert.strictEqual(stFinal.wac, 35, `WAC phải trở lại đúng 35đ/ml, thực tế ${stFinal.wac}`);
        });

        // =====================================================================
        // TEST 6: Sub-Recipe Flexible Batch, Yield Loss & Cycle Rejection (A->B->C->A)
        // =====================================================================
        await runTest(6, 'Sub-Recipe Flexible Batch (1.5 mẻ, Yield 2700/3000ml, lô HSD +4h) & Cycle Detection DAG (A->B->C->A = 400)', async () => {
            const nlTeaLeaf = await makeNL('TEA_LEAF', 'Lá trà Ô Long thô', 'g', 50, 0);
            const nlTeaBase = await makeNL('TEA_BASE', 'Cốt trà Ô Long', 'ml', 200, 0);
            await api('POST', '/api/kho/nhap', {
                token,
                body: { branchId: mainBranch, danhSachNguyenLieu: [{ maNL: nlTeaLeaf, soLuong: 1000, donGiaNhap: 300 }] }, // 300đ/g
            });

            // 1 mẻ lý thuyết = 2000ml (dùng 100g lá trà = 30.000đ), HSD = 4 giờ
            const setBom = await api('POST', `/api/kho/ban-thanh-pham/${encodeURIComponent(nlTeaBase)}/congthuc`, {
                token,
                body: { sanLuongMeMacDinh: 2000, hanSuDungGio: 4, dinhMuc: [{ maNLThanhPhan: nlTeaLeaf, khoiLuongTieuHao: 100 }] },
            });
            assert.strictEqual(setBom.status, 200, JSON.stringify(setBom.data));

            // (a) Nấu 1.5 mẻ (lý thuyết 3000ml, cần 150g lá = 45.000đ), thực thu 2700ml -> donGiaVonMe = 45000/2700 = 16.6667đ/ml!
            const prod = await api('POST', '/api/kho/san-xuat-me', {
                token,
                body: { branchId: mainBranch, maNLThanhPham: nlTeaBase, soMe: 1.5, sanLuongThucTe: 2700, ghiChu: 'Ủ cốt trà sáng' },
            });
            assert.strictEqual(prod.status, 201, JSON.stringify(prod.data));
            assert.strictEqual((await getBranchStock(mainBranch, nlTeaLeaf)).ton, 850, 'Lá trà phải trừ đúng 1.5 * 100g = 150g (còn 850g)');
            assert.strictEqual(prod.data.sanLuongMe, 2700);
            assert(Math.abs(prod.data.donGiaVonMe - 16.6667) < 0.01, `Giá vốn phải là 45000/2700 = 16.6667, thực tế ${prod.data.donGiaVonMe}`);
            assert(prod.data.lot && prod.data.lot.thoiGianHetHan, 'Phải tạo lô lo_tonkho có HSD +4h!');

            // (b) Kiểm tra chặn Chu trình Đa cấp A -> B -> C -> A!
            const nlCycA = await makeNL('CYC_A', 'BTP Vòng A', 'g', 10, 10);
            const nlCycB = await makeNL('CYC_B', 'BTP Vòng B', 'g', 10, 10);
            const nlCycC = await makeNL('CYC_C', 'BTP Vòng C', 'g', 10, 10);
            assert.strictEqual(
                (await api('POST', `/api/kho/ban-thanh-pham/${encodeURIComponent(nlCycA)}/congthuc`, { token, body: { dinhMuc: [{ maNLThanhPhan: nlCycB, khoiLuongTieuHao: 10 }] } })).status,
                200
            );
            assert.strictEqual(
                (await api('POST', `/api/kho/ban-thanh-pham/${encodeURIComponent(nlCycB)}/congthuc`, { token, body: { dinhMuc: [{ maNLThanhPhan: nlCycC, khoiLuongTieuHao: 10 }] } })).status,
                200
            );
            const badCycle = await api('POST', `/api/kho/ban-thanh-pham/${encodeURIComponent(nlCycC)}/congthuc`, {
                token,
                body: { dinhMuc: [{ maNLThanhPhan: nlCycA, khoiLuongTieuHao: 10 }] },
            });
            assert.strictEqual(badCycle.status, 400, `Chu trình A->B->C->A phải bị chặn 400, thực tế ${badCycle.status}`);
            assert.strictEqual(badCycle.data.code, 'CIRCULAR_SUBRECIPE_DETECTED');
        });

        // =====================================================================
        // TEST 7: FEFO Batch Consumption & Expiry Disposal
        // =====================================================================
        await runTest(7, 'FEFO Batch Consumption & Expiry Disposal — bán 700ml trừ sạch LOT1 (500ml DEPLETED) + 200ml LOT2 (còn 1800ml); hủy lô đúng giá vốn lô', async () => {
            const nlFefo = await makeNL('MILK_FEFO', 'Sữa thanh trùng FEFO', 'ml', 100, 0);
            await api('PUT', `/api/kho/nguyenlieu/${encodeURIComponent(nlFefo)}/thuoctinh`, {
                token,
                body: { theoDoiHanDung: true },
            });

            const tomorrow = new Date(Date.now() + 24 * 3600000).toISOString();
            const nextWeek = new Date(Date.now() + 7 * 24 * 3600000).toISOString();
            const in1 = await api('POST', '/api/kho/nhap', {
                token,
                body: { branchId: mainBranch, danhSachNguyenLieu: [{ maNL: nlFefo, soLuong: 500, donGiaNhap: 40, maLo: `LOT1_${rand}`, thoiGianHetHan: tomorrow }] },
            });
            const in2 = await api('POST', '/api/kho/nhap', {
                token,
                body: { branchId: mainBranch, danhSachNguyenLieu: [{ maNL: nlFefo, soLuong: 2000, donGiaNhap: 50, maLo: `LOT2_${rand}`, thoiGianHetHan: nextWeek }] },
            });
            assert.strictEqual(in1.status, 200);
            assert.strictEqual(in2.status, 200);

            const spFefo = await makeItem('SP_FEFO', 'Latte FEFO', 45000, [{ maNL: nlFefo, khoiLuongTieuHao: 350 }]);
            // Bán 2 ly = 700ml
            const ord = await api('POST', '/api/order', {
                token,
                body: { branchId: mainBranch, danhSachMon: [{ maMon: spFefo, kichThuoc: 'M', soLuong: 2 }] },
            });
            assert.strictEqual(ord.status, 201);

            const lotsRes = await qTenantDb(
                tenantId,
                `SELECT id, malo, soluongconlai, trangthai, giavonlo FROM public.lo_tonkho WHERE tenantid = $1 AND manl = $2 ORDER BY id ASC`,
                [tenantId, nlFefo]
            );
            const lot1 = lotsRes.rows.find((l) => l.malo === `LOT1_${rand}`);
            const lot2 = lotsRes.rows.find((l) => l.malo === `LOT2_${rand}`);
            assert.strictEqual(lot1.trangthai, 'DEPLETED');
            assert.strictEqual(Number(lot1.soluongconlai), 0);
            assert.strictEqual(lot2.trangthai, 'ACTIVE');
            assert.strictEqual(Number(lot2.soluongconlai), 1800);

            // Hủy lô LOT2 -> trừ đúng 1800ml theo đúng giá vốn lô 50đ/ml = 90.000đ!
            const disp = await api('POST', `/api/kho/lo-tonkho/${lot2.id}/dispose`, {
                token,
                body: { ghiChu: 'Sữa bị tách béo' },
            });
            assert.strictEqual(disp.status, 200, JSON.stringify(disp.data));
            assert.strictEqual(disp.data.giaVonLo, 50);
            assert.strictEqual(disp.data.giaTriHuy, 90000);
            assert.strictEqual((await getBranchStock(mainBranch, nlFefo)).ton, 0);
        });

        // =====================================================================
        // TEST 8: 5-Layer BOM Resolution & Perfect Void Restore
        // =====================================================================
        await runTest(8, '5-Layer BOM Resolution & Perfect Void Restore — Bạc xỉu Mang đi + Đổi sữa yến mạch + Trân châu + Ly nhựa -> Hủy trả lại khớp 100%', async () => {
            const nlCf = await makeNL('B5_CF', 'Cà phê B5', 'g', 10, 0);
            const nlFresh = await makeNL('B5_FRESH', 'Sữa tươi B5', 'ml', 10, 0);
            const nlOat = await makeNL('B5_OAT', 'Sữa yến mạch B5', 'ml', 10, 0);
            const nlPearl = await makeNL('B5_PEARL', 'Trân châu B5', 'g', 10, 0);
            const nlCup = await makeNL('B5_CUP', 'Ly nhựa M B5', 'cái', 10, 0);

            await api('POST', '/api/kho/nhap', {
                token,
                body: {
                    branchId: mainBranch,
                    danhSachNguyenLieu: [
                        { maNL: nlCf, soLuong: 500, donGiaNhap: 200 },
                        { maNL: nlFresh, soLuong: 1000, donGiaNhap: 30 },
                        { maNL: nlOat, soLuong: 1000, donGiaNhap: 60 },
                        { maNL: nlPearl, soLuong: 500, donGiaNhap: 80 },
                        { maNL: nlCup, soLuong: 100, donGiaNhap: 1200 },
                    ],
                },
            });

            // Base BOM Bạc xỉu M: 20g Cà phê + 150ml Sữa tươi
            const spBx = await makeItem('SP_BX5', 'Bạc xỉu 5 lớp', 45000, [
                { maNL: nlCf, khoiLuongTieuHao: 20 },
                { maNL: nlFresh, khoiLuongTieuHao: 150 },
            ]);

            // Modifier Đổi sữa yến mạch (-150ml Sữa tươi, +150ml Sữa yến mạch)
            const grp = await api('POST', '/api/modifiers/groups', {
                token,
                body: {
                    tenGroup: 'Loại sữa B5',
                    loai: 'SINGLE',
                    batBuoc: false,
                    options: [
                        {
                            tenOption: 'Đổi sữa yến mạch',
                            giaCongThem: 12000,
                            bom: [
                                { maNL: nlFresh, khoiLuongDelta: -150 },
                                { maNL: nlOat, khoiLuongDelta: 150 },
                            ],
                        },
                    ],
                },
            });
            assert.strictEqual(grp.status, 201, JSON.stringify(grp.data));
            const grpId = grp.data.group?.id || grp.data.id;
            const optId = grp.data.group?.options?.[0]?.id;
            assert(grpId && optId, `Thiếu groupId/optionId: ${JSON.stringify(grp.data)}`);
            const attRes = await api('POST', `/api/sanpham/${encodeURIComponent(spBx)}/modifiers`, {
                token,
                body: { groupIds: [grpId] },
            });
            assert.strictEqual(attRes.status, 200, JSON.stringify(attRes.data));

            // Topping Trân châu (+30g Trân châu)
            const tpRes = await api('POST', '/api/topping', {
                token,
                body: { maTopping: `TP5_${rand}`, tenTopping: 'Trân châu đen B5', giaTopping: 10000, maNL: nlPearl, khoiLuongTieuHao: 30 },
            });
            assert([200, 201].includes(tpRes.status), JSON.stringify(tpRes.data));
            const maTp = tpRes.data.maTopping || `TP5_${rand}`;

            // Packaging BOM Mang đi Size M (+1 Ly nhựa M)
            const pkRes = await api('POST', '/api/kho/vattu-mangdi', {
                token,
                body: { items: [{ kichThuoc: 'M', maNL: nlCup, soLuongTieuHao: 1 }] },
            });
            assert.strictEqual(pkRes.status, 201, JSON.stringify(pkRes.data));

            // Tạo đơn 1 ly Mang đi + Đổi sữa yến mạch + 1 Trân châu
            const ord = await api('POST', '/api/order', {
                token,
                body: {
                    branchId: mainBranch,
                    loaiDonHang: 'MANG_DI',
                    danhSachMon: [
                        {
                            maMon: spBx,
                            kichThuoc: 'M',
                            soLuong: 1,
                            isTakeaway: true,
                            modifiers: [{ optionId: optId, qty: 1 }],
                            toppings: [{ maTopping: maTp, soLuong: 1 }],
                        },
                    ],
                },
            });
            assert.strictEqual(ord.status, 201, JSON.stringify(ord.data));

            assert.strictEqual((await getBranchStock(mainBranch, nlCf)).ton, 480, 'Cà phê phải trừ 20g');
            assert.strictEqual((await getBranchStock(mainBranch, nlFresh)).ton, 1000, 'Sữa tươi KHÔNG ĐƯỢC trừ vì đã đổi sang sữa yến mạch!');
            assert.strictEqual((await getBranchStock(mainBranch, nlOat)).ton, 850, 'Sữa yến mạch phải trừ 150ml');
            assert.strictEqual((await getBranchStock(mainBranch, nlPearl)).ton, 470, 'Trân châu phải trừ 30g');
            assert.strictEqual((await getBranchStock(mainBranch, nlCup)).ton, 99, 'Ly nhựa mang đi phải trừ 1 cái');

            // Hủy món trước khi pha (ChoPhaChe -> LoaiGD=7 hoàn kho 100% từ BomSnapshotJson!)
            const maCTHD = ord.data.hoaDon.danhSachMon[0].maCTHD;
            const voidRes = await api('POST', '/api/order/huy-mon', {
                token,
                body: { maCTHD, lyDo: 'Khách đổi ý trước khi pha', hoanKho: true },
            });
            assert.strictEqual(voidRes.status, 200, JSON.stringify(voidRes.data));
            assert.strictEqual((await getBranchStock(mainBranch, nlCf)).ton, 500);
            assert.strictEqual((await getBranchStock(mainBranch, nlFresh)).ton, 1000);
            assert.strictEqual((await getBranchStock(mainBranch, nlOat)).ton, 1000);
            assert.strictEqual((await getBranchStock(mainBranch, nlPearl)).ton, 500);
            assert.strictEqual((await getBranchStock(mainBranch, nlCup)).ton, 100);
        });

        // =====================================================================
        // TEST 9: Transfer In-Transit & Delivery Discrepancy (5000g -> nhận 4850g, hao hụt 150g)
        // =====================================================================
        await runTest(9, 'Transfer In-Transit & Delivery Discrepancy — Kho tổng xuất 5000g (IN_TRANSIT), CN2 nhận 4850g -> tự sinh phiếu hao hụt 150g', async () => {
            const nlTr = await makeNL('BEAN_TR', 'Hạt Espresso điều chuyển', 'g', 500, 0);
            await api('POST', '/api/kho/nhap', {
                token,
                body: { branchId: mainBranch, danhSachNguyenLieu: [{ maNL: nlTr, soLuong: 10000, donGiaNhap: 220 }] },
            });

            // 1. Tạo phiếu PENDING 5000g
            const cr = await api('POST', '/api/branches/transfers', {
                token,
                body: { tuBranchId: mainBranch, denBranchId: br2, items: [{ maNL: nlTr, soLuong: 5000 }] },
            });
            assert.strictEqual(cr.status, 201);
            const maPhieu = cr.data.maPhieu;

            // 2. Xuất xe giao hàng (IN_TRANSIT)
            const disp = await api('POST', `/api/branches/transfers/${encodeURIComponent(maPhieu)}/dispatch`, { token });
            assert.strictEqual(disp.status, 200, JSON.stringify(disp.data));
            assert.strictEqual((await getBranchStock(mainBranch, nlTr)).ton, 5000, 'Kho tổng phải trừ ngay 5000g khi xuất xe');
            const br2Mid = await getBranchStock(br2, nlTr);
            assert.strictEqual(br2Mid.ton, 0, 'CN2 chưa được cộng tồn ảo khi xe đang đi đường!');
            assert.strictEqual(br2Mid.inTransit, 5000, 'CN2 phải hiện TonDangChuyen = 5000g');

            // 3. CN2 kiểm nhận chỉ đủ 4850g (hỏng/rơi vãi 150g trên xe)
            const comp = await api('POST', `/api/branches/transfers/${encodeURIComponent(maPhieu)}/complete`, {
                token,
                body: { receivedItems: [{ maNL: nlTr, soLuongThucNhan: 4850, ghiChuChenhLech: 'Rách 1 bao nhỏ 150g' }] },
            });
            assert.strictEqual(comp.status, 200, JSON.stringify(comp.data));
            assert(comp.data.discrepancyReceiptId, 'Phải tự động sinh phiếu hao hụt vận chuyển DAMAGED_DELIVERY!');
            assert.strictEqual(comp.data.discrepancies[0].lostQty, 150);

            const br2End = await getBranchStock(br2, nlTr);
            assert.strictEqual(br2End.ton, 4850);
            assert.strictEqual(br2End.inTransit, 0);
            assert.strictEqual(br2End.wac, 220, 'WAC CN2 phải kế thừa DonGiaVon đóng băng 220đ/g từ Kho tổng');
        });

        // =====================================================================
        // TEST 10: Blind Stocktake + Compound UoM + In-Flight Sales Delta
        // =====================================================================
        await runTest(10, 'Blind Stocktake + Compound UoM + In-Flight Sales Delta — ẩn tồn hệ thống, bán 300ml giữa chừng, đếm 2 Hộp+500ml=2500ml -> tồn cuối 2200ml', async () => {
            const nlBs = await makeNL('MILK_BS', 'Sữa tươi Blind Stock', 'ml', 100, 0);
            await api('PUT', `/api/kho/nguyenlieu/${encodeURIComponent(nlBs)}/thuoctinh`, { token, body: { isKeyItem: true } });
            await api('POST', '/api/kho/quydoi', { token, body: { maNL: nlBs, tenDonVi: 'Hộp', heSoQuyDoi: 1000 } });
            await api('POST', '/api/kho/nhap', {
                token,
                body: { branchId: mainBranch, danhSachNguyenLieu: [{ maNL: nlBs, soLuong: 2500, donGiaNhap: 35 }] },
            });
            const spBs = await makeItem('SP_BS', 'Latte InFlight', 42000, [{ maNL: nlBs, khoiLuongTieuHao: 150 }]);

            // Tạo tài khoản Barista / Ca trưởng (VaiTro = 2)
            const supUser = `barista_${rand.toLowerCase()}`;
            const crStaff = await api('POST', '/api/nhansu/nhanvien', {
                token,
                body: { tenNV: 'Ca Trưởng Kho', tenDangNhap: supUser, matKhau: 'Barista123!', vaiTro: 2 },
            });
            assert([200, 201].includes(crStaff.status), JSON.stringify(crStaff.data));
            const loginSup = await api('POST', '/api/auth/login', {
                body: { tenDangNhap: supUser, matKhau: 'Barista123!', tenantSlug: slug },
            });
            const supToken = loginSup.data.token;

            // 1. Ca trưởng bắt đầu kiểm kho mù -> response TUYỆT ĐỐI KHÔNG chứa tonKhoHeThong!
            const startRes = await api('POST', '/api/kho/kiem-ke/start', { token: supToken, body: { branchId: mainBranch, keyOnly: true } });
            assert.strictEqual(startRes.status, 201, JSON.stringify(startRes.data));
            const foundItem = startRes.data.items.find((i) => i.maNL === nlBs);
            assert(foundItem, 'Phải trả về Key Item cần kiểm!');
            assert.strictEqual(foundItem.tonKhoHeThong, undefined, 'TUYỆT ĐỐI không được lộ tonKhoHeThong cho Ca trưởng!');
            assert.strictEqual(foundItem.soLuongTon, undefined);

            await sleep(50);

            // 2. Trong lúc Ca trưởng đang đếm, quầy POS bán 2 ly tiêu hao 300ml (2500 -> 2200ml)!
            const midSale = await api('POST', '/api/order', {
                token,
                body: { branchId: mainBranch, danhSachMon: [{ maMon: spBs, kichThuoc: 'M', soLuong: 2 }] },
            });
            assert.strictEqual(midSale.status, 201);

            // 3. Ca trưởng nộp kết quả đếm Tổ hợp đơn vị: 2 Hộp (1000ml) + 500ml = 2500ml
            const subRes = await api('POST', '/api/kho/kiem-ke/submit', {
                token: supToken,
                body: {
                    sessionId: startRes.data.sessionId,
                    danhSachNguyenLieu: [
                        {
                            maNL: nlBs,
                            chiTietDonVi: [
                                { tenDonVi: 'Hộp', soLuong: 2, heSoQuyDoi: 1000 },
                                { tenDonVi: 'ml', soLuong: 500, heSoQuyDoi: 1 },
                            ],
                        },
                    ],
                },
            });
            assert.strictEqual(subRes.status, 200, JSON.stringify(subRes.data));
            assert.strictEqual(subRes.data.items[0].countedBase, 2500);
            assert.strictEqual(subRes.data.items[0].inFlightDelta, -300, 'Phải bù trừ đúng -300ml vừa bán giữa chừng!');
            assert.strictEqual(subRes.data.items[0].adjustedActual, 2200);
            assert.strictEqual((await getBranchStock(mainBranch, nlBs)).ton, 2200, 'Tồn kho cuối phải là 2200ml (0ml thất thoát giả)!');
        });

        // =====================================================================
        // TEST 11: Shift AvT Variance & Telegram Alert (Đầu 500g, Bán 100g, Test máy 20g, Cuối 310g -> Unexplained +70g = 70%)
        // =====================================================================
        await runTest(11, 'Shift AvT Variance & Telegram Alert — Đầu 500g, bán 100g, hủy test 20g, cuối 310g -> Actual=190g, Unexplained=+70g (70%) + Telegram Alert', async () => {
            const nlMatcha = await makeNL('MATCHA_AVT', 'Bột Matcha Nhật AvT', 'g', 50, 0);
            await api('PUT', `/api/kho/nguyenlieu/${encodeURIComponent(nlMatcha)}/thuoctinh`, { token, body: { isKeyItem: true } });
            await api('POST', '/api/kho/nhap', {
                token,
                body: { branchId: mainBranch, danhSachNguyenLieu: [{ maNL: nlMatcha, soLuong: 500, donGiaNhap: 1500 }] },
            });
            const spMatcha = await makeItem('SP_MAT', 'Matcha Latte AvT', 55000, [{ maNL: nlMatcha, khoiLuongTieuHao: 20 }]);

            // Chốt ca hiện tại để mở 1 Ca chiều sạch 100% cho phép đo AvT
            const curDs = (await api('GET', '/api/ca/doi-soat', { token })).data.doiSoat;
            await api('POST', '/api/ca/dong-ca', { token, body: { tienMatThucTe: curDs.tienMatLyThuyet, tienGiuLaiKet: 500000 } });
            const openPm = await api('POST', '/api/ca/mo-ca', { token, body: { tienMatDauCa: 500000 } });
            assert.strictEqual(openPm.status, 201);
            const shiftId = openPm.data.ca.maCaThuNgan;

            // 1. Chốt tồn đầu ca = 500g
            const snapOpen = await api('POST', '/api/kho/avt-by-shift/snapshot', {
                token,
                body: { maCaThuNgan: shiftId, branchId: mainBranch, loaiMoc: 'OPENING', items: [{ maNL: nlMatcha, soLuong: 500 }] },
            });
            assert.strictEqual(snapOpen.status, 200);

            // 2. Bán 5 ly Matcha = 100g lý thuyết
            await api('POST', '/api/order', {
                token,
                body: { branchId: mainBranch, danhSachMon: [{ maMon: spMatcha, kichThuoc: 'M', soLuong: 5 }] },
            });

            // 3. Khai báo xuất hủy test máy đầu ca 20g (MACHINE_CALIBRATION)
            await api('POST', '/api/kho/kiemke', {
                token,
                body: {
                    loaiGD: 2,
                    branchId: mainBranch,
                    maLyDoHuy: 'MACHINE_CALIBRATION',
                    danhSachNguyenLieu: [{ maNL: nlMatcha, soLuong: 20 }],
                },
            });

            // 4. Kiểm cuối ca còn 310g (tồn hệ thống đang là 500 - 100 - 20 = 380g -> hụt vô danh 70g!)
            await api('POST', '/api/kho/avt-by-shift/snapshot', {
                token,
                body: { maCaThuNgan: shiftId, branchId: mainBranch, loaiMoc: 'CLOSING', items: [{ maNL: nlMatcha, soLuong: 310 }] },
            });

            const avt = await api('GET', `/api/kho/avt-by-shift?maCaThuNgan=${encodeURIComponent(shiftId)}`, { token });
            assert.strictEqual(avt.status, 200, JSON.stringify(avt.data));
            const mRow = avt.data.items.find((x) => x.maNL === nlMatcha);
            assert(mRow, 'Phải có dòng Matcha trong báo cáo AvT');
            assert.strictEqual(mRow.actualUsage, 190, `Actual phải là 190g, thực tế ${mRow.actualUsage}`);
            assert.strictEqual(mRow.theoreticalUsage, 100, `Theoretical phải là 100g, thực tế ${mRow.theoreticalUsage}`);
            assert.strictEqual(mRow.recordedWaste, 20, `Recorded Waste phải là 20g, thực tế ${mRow.recordedWaste}`);
            assert.strictEqual(mRow.wasteByReason.MACHINE_CALIBRATION, 20);
            assert.strictEqual(mRow.unexplainedVariance, 70, `Unexplained Variance phải là +70g, thực tế ${mRow.unexplainedVariance}`);
            assert.strictEqual(mRow.variancePct, 70, `Variance % phải là 70%, thực tế ${mRow.variancePct}`);
            assert.strictEqual(avt.data.telegramAlertTriggered, true, 'Phải kích hoạt cảnh báo Telegram gian lận AvT!');
        });

        // =====================================================================
        // TEST 12: Price Spike Margin Alert (+12%) & Inventory Period Lock (403 INVENTORY_PERIOD_LOCKED)
        // =====================================================================
        await runTest(12, 'Price Spike Margin Alert (+12% -> danh sách món giảm biên lãi) & Period Lock (khóa 2026-10-31 -> chặn 2026-10-28 với 403)', async () => {
            const nlSpk = await makeNL('MILK_SPK', 'Sữa tươi Tăng Giá', 'ml', 100, 0);
            // Nhập lần 1 giá 50đ/ml
            await api('POST', '/api/kho/nhap', {
                token,
                body: { branchId: mainBranch, danhSachNguyenLieu: [{ maNL: nlSpk, soLuong: 1000, donGiaNhap: 50 }] },
            });
            // Món Latte 35.000đ dùng 300ml sữa (COGS cũ = 15.000đ -> biên cũ 57.1%; tăng +12% lên 56đ -> COGS 16.800đ -> biên mới 52%)
            const spLatte = await makeItem('SP_SPK', 'Latte Margin Watch', 35000, [{ maNL: nlSpk, khoiLuongTieuHao: 300 }]);

            // (a) Nhập lần 2 giá 56đ/ml (+12%)
            const spikeIn = await api('POST', '/api/kho/nhap', {
                token,
                body: { branchId: mainBranch, danhSachNguyenLieu: [{ maNL: nlSpk, soLuong: 1000, donGiaNhap: 56 }] },
            });
            assert.strictEqual(spikeIn.status, 200);
            assert(Array.isArray(spikeIn.data.priceSpikeAlerts) && spikeIn.data.priceSpikeAlerts.length === 1, 'Phải trả về cảnh báo tăng giá >= +5%!');
            assert.strictEqual(spikeIn.data.priceSpikeAlerts[0].pctIncrease, 12);
            const aff = spikeIn.data.priceSpikeAlerts[0].affectedItems.find((x) => x.maMon === spLatte);
            assert(aff && aff.newMarginPct < aff.oldMarginPct, `Phải tính đúng biên lãi giảm: ${JSON.stringify(aff)}`);

            // (b) Khóa sổ kho đến ngày 2026-10-31 -> thử nhập/kiểm kê ngày 2026-10-28 -> chặn 403 INVENTORY_PERIOD_LOCKED!
            const lockRes = await api('POST', '/api/kho/khoa-so', {
                token,
                body: { branchId: mainBranch, ngayKhoaSoDen: '2026-10-31', ghiChu: 'Khóa sổ kế toán tháng 10/2026' },
            });
            assert.strictEqual(lockRes.status, 201, JSON.stringify(lockRes.data));

            const blockedIn = await api('POST', '/api/kho/nhap', {
                token,
                body: {
                    branchId: mainBranch,
                    ngayChungTu: '2026-10-28',
                    danhSachNguyenLieu: [{ maNL: nlSpk, soLuong: 100, donGiaNhap: 56 }],
                },
            });
            assert.strictEqual(blockedIn.status, 403, `Phiếu nhập trong kỳ khóa sổ phải bị chặn 403, thực tế ${blockedIn.status}`);
            assert.strictEqual(blockedIn.data.code, 'INVENTORY_PERIOD_LOCKED');

            const blockedKiem = await api('POST', '/api/kho/kiemke', {
                token,
                body: {
                    loaiGD: 3,
                    branchId: mainBranch,
                    ngayChungTu: '2026-10-28',
                    danhSachNguyenLieu: [{ maNL: nlSpk, soLuong: 500 }],
                },
            });
            assert.strictEqual(blockedKiem.status, 403);
            assert.strictEqual(blockedKiem.data.code, 'INVENTORY_PERIOD_LOCKED');

            // Kiểm chứng thêm Point-in-Time Valuation & Auto-PO
            const pit = await api('GET', `/api/kho/dinh-gia?asOfDate=2026-11-22&branchId=${encodeURIComponent(mainBranch)}`, { token });
            assert.strictEqual(pit.status, 200);
            assert(pit.data.totalValuation > 0);
        });

        console.log(`\n🎉 HOÀN TẤT XUẤT SẮC: ${passed}/${totalTests} BÀI TEST TÍCH HỢP PHÂN HỆ 4 (100/100) ĐỀU PASS!`);
    } finally {
        serverProc.kill('SIGTERM');
        await pool.end().catch(() => {});
        if (passed < totalTests && serverLogs) {
            console.error('\n--- Backend Logs (last 40 lines) ---\n' + serverLogs.split('\n').slice(-40).join('\n'));
        }
    }
}

main().catch((err) => {
    console.error('\n💥 Bộ test Phân hệ 4 dừng do lỗi:', err.message);
    process.exit(1);
});
