const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const {
    createRuntimePool,
    createMigrationPool,
    assertAppRuntimeNoBypassRls,
    withTenantTx,
} = require('../helpers/dbHarness');
const {
    applyMixedRateTaxToOrder,
    issueEInvoiceForOrder,
    createAdjustmentDecreaseOnRefund,
    processPendingEInvoices,
} = require('../../modules/vnTaxAndEInvoiceService');
const {
    cascadeIngredient86,
    loadBranchAvailability86Map,
    suyLuanTramCheBien,
} = require('../../modules/kdsPhase2Engine');
const { registerEcosystemPhase8Routes } = require('../../modules/ecosystemPhase8Routes');
const { registerKdsPhase2Routes } = require('../../modules/kdsPhase2Routes');

async function startMiniServer(registerFn) {
    const app = express();
    app.use(express.json());
    registerFn(app);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

describe('Wave 3A Integration [Tầng 2 — app_runtime NOBYPASSRLS]: TC-W3A-01, TC-W3A-02, TC-W3A-03', () => {
    let runtimePool;
    let migrationPool;
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const tenantA = `W3A_TA_${suffix}`;
    const tenantB = `W3A_TB_${suffix}`;

    before(async () => {
        runtimePool = createRuntimePool();
        migrationPool = createMigrationPool();
        await assertAppRuntimeNoBypassRls(runtimePool);

        // Xác nhận migration 032 và 033 đã được áp dụng trong schema_migrations
        const migRes = await runtimePool.query(
            `SELECT version FROM public.schema_migrations WHERE version IN ('032', '033') ORDER BY version`
        );
        const versions = migRes.rows.map((r) => r.version);
        assert.deepEqual(versions, ['032', '033'], `Thiếu migration 032/033 trong schema_migrations: ${JSON.stringify(versions)}`);

        // Seed 2 tenant tối thiểu bằng migrationPool
        const pairs = [
            [tenantA, `A${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`],
            [tenantB, `B${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`],
        ];
        for (const [tId, maTienTo] of pairs) {
            await migrationPool.query(
                `INSERT INTO public.tenants (tenantid, matiento, tenquan, slug, goicuoc, trangthai)
                 VALUES ($1, $2, $3, $4, 'PRO', 'ACTIVE')
                 ON CONFLICT (tenantid) DO NOTHING`,
                [tId, maTienTo, `Quán ${tId}`, tId.toLowerCase()]
            );
        }
    });

    after(async () => {
        if (runtimePool) await runtimePool.end();
        if (migrationPool) await migrationPool.end();
    });

    it('TC-W3A-01 (QA-14): Thuế đa mức 8%/10% + HĐĐT MTT + RPC công khai SECURITY DEFINER + Credit Note khi hoàn tiền', async () => {
        const maMon8 = `M8_${suffix}`;
        const maMon10 = `M10_${suffix}`;
        const maHoaDon = `HD_W3A_${suffix}`;

        await withTenantTx(runtimePool, tenantA, async (client) => {
            await client.query(
                `INSERT INTO public.sanpham (mamon, tenmon, nhommon, dangkinhdoanh, tenantid, tax_category_code)
                 VALUES ($1, 'Cafe Sữa 8%', 'Cà phê', TRUE, $3, 'VAT_8_FB'),
                        ($2, 'Bia Thủ Công 10%', 'Đồ uống cồn', TRUE, $3, 'VAT_10_STD')`,
                [maMon8, maMon10, tenantA]
            );
            await client.query(
                `INSERT INTO public.hoadon (mahoadon, manv, tongtien, thanhtien, tongtienthanhtoan, trangthaitt, tenantid, cachtinhthue)
                 VALUES ($1, 'NV01', 120000, 120000, 120000, 1, $2, 'EXCLUDED')`,
                [maHoaDon, tenantA]
            );
            await client.query(
                `INSERT INTO public.chitiethoadon (mahoadon, mamon, kichthuoc, soluong, dongia, trangthaiphache)
                 VALUES ($1, $2, 'M', 1, 40000, 'DaXong'),
                        ($1, $3, 'M', 1, 80000, 'DaXong')`,
                [maHoaDon, maMon8, maMon10]
            );

            // 1. Tính & lưu snapshot thuế đa mức trên ChiTietHoaDon và HoaDon
            const taxRes = await applyMixedRateTaxToOrder(client, {
                tenantId: tenantA,
                maHoaDon,
                taxMode: 'EXCLUDED',
            });
            assert.equal(taxRes.taxBreakdown.length, 2);
            assert.equal(taxRes.totalTax, 40000 * 0.08 + 80000 * 0.10); // 3200 + 8000 = 11200
            assert.ok(taxRes.lookupCode && taxRes.lookupCode.startsWith('EINV'));

            const cthdSnap = await client.query(
                `SELECT mamon, tax_category_code, tax_rate_snapshot, taxable_base_amount, vat_amount_snapshot
                   FROM public.chitiethoadon
                  WHERE mahoadon = $1
                  ORDER BY mamon`,
                [maHoaDon]
            );
            const row8 = cthdSnap.rows.find((r) => r.mamon === maMon8);
            const row10 = cthdSnap.rows.find((r) => r.mamon === maMon10);
            assert.equal(Number(row8.tax_rate_snapshot), 8);
            assert.equal(Number(row8.vat_amount_snapshot), 3200);
            assert.equal(Number(row10.tax_rate_snapshot), 10);
            assert.equal(Number(row10.vat_amount_snapshot), 8000);

            const hdSnap = await client.query(
                `SELECT tax_breakdown_json, einvoice_lookup_code FROM public.hoadon WHERE mahoadon = $1`,
                [maHoaDon]
            );
            assert.equal(hdSnap.rows[0].tax_breakdown_json.length, 2);
            const lookupCode = hdSnap.rows[0].einvoice_lookup_code;

            // 2. Phát hành HĐĐT qua MockEInvoiceAdapter
            const origEinv = await issueEInvoiceForOrder(client, {
                tenantId: tenantA,
                branchId: 'CN01',
                maHoaDon,
                buyer: { companyName: 'Khách lẻ' },
                provider: 'MOCK',
                immediate: true,
            });
            assert.equal(origEinv.status, 'ISSUED');
            assert.ok(String(origEinv.tax_authority_code || '').startsWith('M1-'));

            // 3. Tự động sinh ADJUSTMENT_DECREASE (Credit Note) khi hoàn tiền 1 phần
            const creditNote = await createAdjustmentDecreaseOnRefund(client, {
                tenantId: tenantA,
                branchId: 'CN01',
                maHoaDon,
                refundAmount: 40000,
                reason: 'Hoàn 1 phần món Cafe',
            });
            assert.ok(creditNote, 'Phải sinh bản ghi ADJUSTMENT_DECREASE khi hoàn tiền đơn đã xuất HĐĐT');
            assert.equal(creditNote.invoice_type, 'ADJUSTMENT_DECREASE');
            assert.equal(Number(creditNote.parent_einvoice_id), Number(origEinv.id));
            assert.equal(creditNote.status, 'QUEUED');

            // Outbox worker phát hành Credit Note thành công
            const processed = await processPendingEInvoices(client, { tenantId: tenantA, providerOverride: 'MOCK' });
            assert.equal(processed.length, 1);
            assert.equal(processed[0].status, 'ISSUED');
            assert.equal(processed[0].invoice_type, 'ADJUSTMENT_DECREASE');

            // Trả lookupCode ra ngoài để test RPC công khai không cần session tenant
            return lookupCode;
        }).then(async (lookupCode) => {
            // 4. Gọi RPC SECURITY DEFINER công khai dưới app_runtime (không set app.current_tenant_id!)
            const pubLookup = await runtimePool.query(
                `SELECT * FROM public.fn_public_lookup_einvoice($1)`,
                [lookupCode]
            );
            assert.equal(pubLookup.rows.length, 1);
            assert.equal(pubLookup.rows[0].ma_hoa_don, maHoaDon);
            assert.equal(pubLookup.rows[0].status, 'ISSUED');

            const pubReq = await runtimePool.query(
                `SELECT * FROM public.fn_public_request_einvoice($1, $2, $3, $4, $5)`,
                [lookupCode, '0312345678', 'Công ty TNHH Test', 'Quận 1, TP.HCM', 'ketoan@test.vn']
            );
            assert.equal(pubReq.rows.length, 1);
            assert.equal(pubReq.rows[0].already_issued, true);
            assert.equal(pubReq.rows[0].buyer_email, 'ketoan@test.vn');
        });
    });

    it('TC-W3A-02 (QA-14b): NĐ 13/2023 Privacy (Thu ngân LIMIT 5 + mask SĐT, cấm dump), Consent RLS & Anonymize + Audit_Logs', async () => {
        // Seed 10 khách hàng cho tenantA
        await withTenantTx(runtimePool, tenantA, async (client) => {
            for (let i = 1; i <= 10; i += 1) {
                const maKH = `KH_${suffix}_${i}`;
                const sdt = `09051238${String(i).padStart(2, '0')}`;
                await client.query(
                    `INSERT INTO public.khachhang (makh, hoten, sodienthoai, diemtichluy, tenantid)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [maKH, `Khách Hàng ${i}`, sdt, i * 10, tenantA]
                );
            }
        });

        // Dựng mini Express app gắn ecosystemPhase8Routes chạy trực tiếp trên runtimePool
        const srv = await startMiniServer((app) => {
            const fakeAuth = (req, _res, next) => {
                req.user = {
                    maNV: req.headers['x-manv'] || 'NV04',
                    vaiTro: Number(req.headers['x-role'] || 4),
                    tenantId: req.headers['x-tenant'] || tenantA,
                };
                next();
            };
            const allowRoles = (...roles) => (req, res, next) => {
                if (!roles.includes(Number(req.user?.vaiTro))) {
                    return res.status(403).json({ message: 'Forbidden' });
                }
                next();
            };
            registerEcosystemPhase8Routes(app, {
                pool: runtimePool,
                chayGiaoDich: (fn, tId = tenantA) => withTenantTx(runtimePool, tId, fn),
                qTenant: (req, sql, params) => withTenantTx(runtimePool, req.user.tenantId, (c) => c.query(sql, params)),
                layTenantId: (req) => req.user.tenantId,
                kiemTraToken: fakeAuth,
                choPhepVaiTro: allowRoles,
                ghiAuditLog: async (client, entry) => {
                    await client.query(
                        `INSERT INTO public.audit_logs (tenantid, manv, vaitro, hanhdong, doituong, madoituong, giatricu, giatrimoi, lydo, diachiip)
                         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
                        [
                            entry.tenantId,
                            entry.maNV,
                            entry.vaiTro,
                            entry.hanhDong,
                            entry.doiTuong,
                            entry.maDoiTuong,
                            JSON.stringify(entry.giaTriCu || null),
                            JSON.stringify(entry.giaTriMoi || null),
                            entry.lyDo || null,
                            entry.ip || null,
                        ]
                    );
                },
                guiLoi: (res, err) => res.status(err.status || 500).json({ message: err.message }),
                LoiNghiepVu: class extends Error {
                    constructor(status, message) {
                        super(message);
                        this.status = status;
                    }
                },
                io: null,
                roomTen: (t, r) => `t:${t}:${r}`,
                taoDonHangTrongGiaoDich: async () => ({}),
            });
        });

        try {
            // 1. Thu ngân (vaiTro = 4) gọi không có từ khóa -> 403 cấm tải hàng loạt
            const bulkRes = await fetch(`${srv.baseUrl}/api/crm/customers`, {
                headers: { 'x-role': '4', 'x-tenant': tenantA },
            });
            assert.equal(bulkRes.status, 403);

            // 2. Thu ngân tra cứu có từ khóa '0905' -> tối đa 5 dòng và toàn bộ SĐT bị che dạng 0905***8xx
            const searchRes = await fetch(`${srv.baseUrl}/api/crm/customers?q=0905`, {
                headers: { 'x-role': '4', 'x-tenant': tenantA },
            });
            assert.equal(searchRes.status, 200);
            const searchJson = await searchRes.json();
            assert.equal(searchJson.customers.length, 5, 'Thu ngân chỉ được nhận tối đa LIMIT 5');
            for (const c of searchJson.customers) {
                assert.match(c.soDienThoai, /^0905\*\*\*\d{3}$/, `SĐT phải được che dạng 0905***xxx, nhận được: ${c.soDienThoai}`);
            }

            // 3. Ghi nhận đồng thuận (customer_consent_logs) & xác nhận Tenant B KHÔNG đọc được dưới FORCE RLS
            const targetMaKH = `KH_${suffix}_1`;
            const consentRes = await fetch(`${srv.baseUrl}/api/crm/customers/${targetMaKH}/consent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-role': '4', 'x-tenant': tenantA },
                body: JSON.stringify({ channel: 'POS_COUNTER', purpose: 'ZNS_RECEIPT', granted: true }),
            });
            assert.equal(consentRes.status, 201);

            await withTenantTx(runtimePool, tenantB, async (client) => {
                const crossRead = await client.query(
                    `SELECT * FROM public.customer_consent_logs WHERE ma_kh = $1`,
                    [targetMaKH]
                );
                assert.equal(crossRead.rows.length, 0, 'FORCE RLS phải chặn tuyệt đối Tenant B đọc customer_consent_logs của Tenant A');
            });

            // 4. Anonymize (chỉ Quản lý vaiTro = 1) -> xóa PII + ghi Audit_Logs
            const anonCashier = await fetch(`${srv.baseUrl}/api/crm/customers/${targetMaKH}/anonymize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-role': '4', 'x-tenant': tenantA },
                body: JSON.stringify({ lyDo: 'Thu ngân thử xóa' }),
            });
            assert.equal(anonCashier.status, 403);

            const anonMgr = await fetch(`${srv.baseUrl}/api/crm/customers/${targetMaKH}/anonymize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-role': '1', 'x-manv': 'NV01', 'x-tenant': tenantA },
                body: JSON.stringify({ lyDo: 'Khách yêu cầu xóa PII theo NĐ 13' }),
            });
            assert.equal(anonMgr.status, 200);

            await withTenantTx(runtimePool, tenantA, async (client) => {
                const khRow = await client.query(
                    `SELECT hoten, sodienthoai, zalooptin, anonymized_at FROM public.khachhang WHERE makh = $1`,
                    [targetMaKH]
                );
                assert.ok(khRow.rows[0].anonymized_at, 'anonymized_at phải được điền');
                assert.equal(khRow.rows[0].zalooptin, false);
                assert.ok(String(khRow.rows[0].sodienthoai).startsWith('ANON-'));

                const auditRow = await client.query(
                    `SELECT hanhdong FROM public.audit_logs WHERE tenantid = $1 AND madoituong = $2 AND hanhdong = 'CUSTOMER_PII_ANONYMIZED'`,
                    [tenantA, targetMaKH]
                );
                assert.equal(auditRow.rows.length, 1, 'Phải có bản ghi Audit_Logs cho CUSTOMER_PII_ANONYMIZED');
            });
        } finally {
            await srv.close();
        }
    });

    it('TC-W3A-03: Branch 86 Isolation (CN1 khóa không ảnh hưởng CN2 & sanpham.tamhet) & Item-Swap cập nhật đúng TonKhoChiNhanh CN1', async () => {
        const branch1 = `CN1_${suffix}`;
        const branch2 = `CN2_${suffix}`;
        const maNL = `NL_SUA_${suffix}`;
        const maNL2 = `NL_TRA_${suffix}`;
        const maMon1 = `MON_LATTE_${suffix}`;
        const maMon2 = `MON_TRA_${suffix}`;
        const maHD = `HD_SWAP_${suffix}`;

        // Seed ChiNhanh + NguyenLieu + TonKhoChiNhanh + SanPham + CongThuc + HoaDon + ChiTietHoaDon
        let oldMaCTHD;
        await withTenantTx(runtimePool, tenantA, async (client) => {
            await client.query(
                `INSERT INTO public.chinhanh (branchid, tenantid, machinhanh, tenchinhanh)
                 VALUES ($1, $3, $1, 'Chi nhánh 1'), ($2, $3, $2, 'Chi nhánh 2')`,
                [branch1, branch2, tenantA]
            );
            await client.query(
                `INSERT INTO public.nguyenlieu (manl, tennl, donvitinh, soluongton, giavondonvi, tenantid)
                 VALUES ($1, 'Sữa tươi', 'ml', 5000, 30, $3),
                        ($2, 'Trà đào', 'ml', 5000, 20, $3)`,
                [maNL, maNL2, tenantA]
            );
            await client.query(
                `INSERT INTO public.tonkhochinhanh (tenantid, branchid, manl, soluongton)
                 VALUES ($1, $2, $4, 1000),
                        ($1, $2, $5, 1000),
                        ($1, $3, $4, 2000)`,
                [tenantA, branch1, branch2, maNL, maNL2]
            );
            await client.query(
                `INSERT INTO public.sanpham (mamon, tenmon, nhommon, dangkinhdoanh, tamhet, tenantid)
                 VALUES ($1, 'Latte Sữa Tươi', 'Cà phê', TRUE, FALSE, $3),
                        ($2, 'Trà Đào Cam Sả', 'Trà', TRUE, FALSE, $3)`,
                [maMon1, maMon2, tenantA]
            );
            await client.query(
                `INSERT INTO public.sanpham_size (mamon, kichthuoc, giaban)
                 VALUES ($1, 'M', 45000), ($2, 'M', 45000)`,
                [maMon1, maMon2]
            );
            await client.query(
                `INSERT INTO public.congthuc (mamon, kichthuoc, manl, khoiluongtieuhao)
                 VALUES ($1, 'M', $3, 150), ($2, 'M', $4, 200)`,
                [maMon1, maMon2, maNL, maNL2]
            );

            // 1. Gọi cascadeIngredient86 tại CN1
            const cascadeRes = await cascadeIngredient86(client, {
                tenantId: tenantA,
                branchId: branch1,
                maNL,
                action: 'LOCK',
                updatedBy: 'NV01',
            });
            assert.equal(cascadeRes.branchId, branch1);
            assert.equal(cascadeRes.affectedProducts.length, 1);
            assert.equal(cascadeRes.affectedProducts[0].maMon, maMon1);

            // Kiểm tra branch_availability_86 của CN1 vs CN2 và sanpham.tamhet toàn chuỗi
            const b1Map = await loadBranchAvailability86Map(client, tenantA, branch1);
            const b2Map = await loadBranchAvailability86Map(client, tenantA, branch2);
            assert.equal(b1Map.products.get(maMon1)?.isSoldOut, true, 'CN1 phải bị khóa món Latte');
            assert.equal(b2Map.products.get(maMon1), undefined, 'CN2 tuyệt đối KHÔNG bị khóa món Latte');

            const globalSp = await client.query(`SELECT tamhet FROM public.sanpham WHERE mamon = $1`, [maMon1]);
            assert.equal(globalSp.rows[0].tamhet, false, 'sanpham.tamhet toàn chuỗi KHÔNG được bị sửa thành TRUE');

            // 2. Tạo đơn tại CN1 (món Latte đang ChoPhaChe) để test item-swap trừ/hoàn đúng TonKhoChiNhanh CN1
            await client.query(
                `INSERT INTO public.hoadon (mahoadon, manv, tongtien, thanhtien, tongtienthanhtoan, trangthaitt, tenantid, branchid)
                 VALUES ($1, 'NV01', 45000, 45000, 45000, 0, $2, $3)`,
                [maHD, tenantA, branch1]
            );
            const ctIns = await client.query(
                `INSERT INTO public.chitiethoadon (mahoadon, mamon, kichthuoc, soluong, dongia, trangthaiphache)
                 VALUES ($1, $2, 'M', 1, 45000, 'ChoPhaChe')
                 RETURNING macthd`,
                [maHD, maMon1]
            );
            oldMaCTHD = ctIns.rows[0].macthd;
        });

        // Gọi POST /api/order/item-swap qua mini server gắn kdsPhase2Routes
        const srv = await startMiniServer((app) => {
            registerKdsPhase2Routes(app, {
                pool: runtimePool,
                chayGiaoDich: (fn, tId = tenantA) => withTenantTx(runtimePool, tId, fn),
                kiemTraToken: (req, _res, next) => {
                    req.user = { maNV: 'NV01', vaiTro: 1, tenantId: tenantA, branchId: branch1 };
                    next();
                },
                choPhepVaiTro: () => (_req, _res, next) => next(),
                coQuyenHan: () => true,
                layTenantId: () => tenantA,
                guiLoi: (res, err) => res.status(err.status || 500).json({ message: err.message }),
                LoiNghiepVu: class extends Error {
                    constructor(status, message) {
                        super(message);
                        this.status = status;
                    }
                },
                io: null,
                roomTen: (t, r) => `t:${t}:${r}`,
                ghiAuditLog: async () => {},
                xacThucPinQuanLy: async () => ({ maNV: 'NV01' }),
                suyLuanTramCheBien,
                layMonTheoMa: async (_c, ids) => ids.map((id) => ({ maCTHD: id, tramCheBien: 'BAR_LANH' })),
                layHoaDonChiTiet: async (_c, id) => ({ maHoaDon: id }),
                congDinhLuongNguyenLieuDongMon: async (client, _tId, item, map) => {
                    const r = await client.query(
                        `SELECT manl, khoiluongtieuhao FROM public.congthuc WHERE mamon = $1 AND kichthuoc = $2`,
                        [item.maMon, item.kichThuoc]
                    );
                    for (const row of r.rows) {
                        map.set(row.manl, Number(row.khoiluongtieuhao) * Number(item.soLuong));
                    }
                },
                layMapGiaVonNguyenLieu: async () => new Map([[maNL, 30], [maNL2, 20]]),
                layCaDangMo: async () => null,
                LOAI_GD_BAN_HANG: 6,
                LOAI_GD_HOAN_KHO: 7,
                LOAI_GD_HAO_HUT_HUY_MON: 8,
            });
        });

        try {
            const swapRes = await fetch(`${srv.baseUrl}/api/order/item-swap`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    maCTHD: oldMaCTHD,
                    newItem: { maMon: maMon2, kichThuoc: 'M', soLuong: 1 },
                    lyDo: 'Khách đổi sang Trà Đào',
                }),
            });
            assert.equal(swapRes.status, 200, `Item-swap phải thành công 200, nhận được ${swapRes.status}: ${await swapRes.clone().text()}`);

            await withTenantTx(runtimePool, tenantA, async (client) => {
                const tkRes = await client.query(
                    `SELECT branchid, manl, soluongton FROM public.tonkhochinhanh WHERE tenantid = $1 AND branchid IN ($2, $3)`,
                    [tenantA, branch1, branch2]
                );
                const findStock = (b, nl) => Number(tkRes.rows.find((r) => r.branchid === b && r.manl === nl)?.soluongton);
                // CN1: maNL (Sữa) được hoàn +150 -> 1150; maNL2 (Trà) bị trừ -200 -> 800
                assert.equal(findStock(branch1, maNL), 1150, 'TonKhoChiNhanh CN1 phải hoàn +150ml Sữa');
                assert.equal(findStock(branch1, maNL2), 800, 'TonKhoChiNhanh CN1 phải trừ -200ml Trà');
                // CN2 không bị ảnh hưởng
                assert.equal(findStock(branch2, maNL), 2000, 'TonKhoChiNhanh CN2 tuyệt đối không bị ảnh hưởng');
            });
        } finally {
            await srv.close();
        }
    });
});
