#!/usr/bin/env node
/**
 * Bộ kiểm thử tự động Chống IDOR Xuyên Tenant, Khóa Thu Tiền SaaS & 5 Kịch Bản Tích Hợp Pilot
 * Chạy: npm run test:security  (yêu cầu server đang chạy tại API_URL, mặc định http://localhost:3000/api)
 * Tùy chọn:
 *   APP_RUNTIME_DATABASE_URL=postgres://app_runtime:...  (để kiểm tra trực tiếp Fail-Closed RLS NOBYPASSRLS ở tầng DB)
 *   SEPAY_API_KEY=...                                    (để kiểm tra đầy đủ Webhook SePay không JWT & tự mở khóa gói SUB...)
 */
require('dotenv').config();
const { Pool } = require('pg');
const { xuLyThanhToanGoiTuWebhook } = require('../modules/saasRoutes');

const API = (process.env.API_URL || 'http://localhost:3000/api').replace(/\/+$/, '');
const SEPAY_API_KEY = process.env.SEPAY_API_KEY || '';
const TODAY_VN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());

async function req(path, { method = 'GET', token = null, body = null, headers: extraHeaders = {} } = {}) {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
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

function assert(cond, msg) {
    if (!cond) {
        console.error(`❌ FAIL: ${msg}`);
        process.exit(1);
    }
    console.log(`✅ PASS: ${msg}`);
}

async function testDbLevelRls() {
    const connStr = process.env.APP_RUNTIME_DATABASE_URL || process.env.DATABASE_URL;
    if (!connStr) {
        console.log('ℹ️ Bỏ qua kiểm tra RLS tầng DB trực tiếp (chưa có APP_RUNTIME_DATABASE_URL / DATABASE_URL)');
        return;
    }
    const ssl = connStr.includes('localhost') ? false : { rejectUnauthorized: false };
    const testPool = new Pool({ connectionString: connStr, ssl, max: 2, connectionTimeoutMillis: 5000 });
    const tables = [
        'khuyenmai',
        'phieuthuchilatvat',
        'chitiethoadon_topping',
        'chitietgiaodichkho',
        'chamcong',
        'donhang_idempotency',
    ];
    try {
        const roleRes = await testPool.query(
            `SELECT CURRENT_USER AS u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = CURRENT_USER`
        );
        const role = roleRes.rows[0] || {};
        const isRestrictedRuntime = !role.rolsuper && !role.rolbypassrls;

        // Kiểm tra toàn bộ 6 bảng đều bật ENABLE + FORCE ROW LEVEL SECURITY và có policy dùng app.current_tenant_id
        const metaRes = await testPool.query(
            `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
                    COALESCE((
                        SELECT string_agg(COALESCE(p.qual, '') || ' ' || COALESCE(p.with_check, ''), ' ')
                          FROM pg_policies p
                         WHERE p.schemaname = 'public' AND p.tablename = c.relname
                    ), '') AS pol_def
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
            [tables]
        );
        for (const tbl of tables) {
            const row = metaRes.rows.find((r) => r.relname === tbl);
            assert(
                row && row.relrowsecurity && row.relforcerowsecurity && row.pol_def.includes('app.current_tenant_id'),
                `Bảng "${tbl}" đã bật FORCE ROW LEVEL SECURITY & policy app.current_tenant_id`
            );
        }

        if (isRestrictedRuntime) {
            // Chạy SELECT KHÔNG gọi set_config dưới role app_runtime NOBYPASSRLS -> bắt buộc 0 dòng trên cả 6 bảng
            for (const tbl of tables) {
                const cnt = await testPool.query(`SELECT COUNT(*)::int AS n FROM public.${tbl}`);
                assert(
                    cnt.rows[0].n === 0,
                    `[NOBYPASSRLS ${role.u}] SELECT public.${tbl} không có set_config trả về đúng 0 dòng (n=${cnt.rows[0].n})`
                );
            }
        } else {
            // Tự động chuyển sang role app_runtime (NOBYPASSRLS) ngay trong transaction bằng SET LOCAL ROLE app_runtime!
            const hasAppRuntime = await testPool.query(
                `SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime' AND rolsuper = FALSE AND rolbypassrls = FALSE`
            );
            if (hasAppRuntime.rows.length > 0) {
                const client = await testPool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query('SET LOCAL ROLE app_runtime');
                    for (const tbl of tables) {
                        const cnt = await client.query(`SELECT COUNT(*)::int AS n FROM public.${tbl}`);
                        assert(
                            cnt.rows[0].n === 0,
                            `[SET LOCAL ROLE app_runtime NOBYPASSRLS] SELECT public.${tbl} không có set_config trả về đúng 0 dòng (n=${cnt.rows[0].n})`
                        );
                    }
                    await client.query('COMMIT');
                } finally {
                    client.release();
                }
            } else {
                console.log(
                    `ℹ️ Chưa có role app_runtime (hãy chạy Migration 013 để tự tạo role app_runtime NOBYPASSRLS và kiểm thử 0 dòng trực tiếp).`
                );
            }
        }

        // Kiểm tra hàm SECURITY DEFINER dọn rác DonHang_Idempotency tồn tại & chạy được
        const cleanRes = await testPool.query('SELECT public.fn_cleanup_old_idempotency() AS deleted');
        assert(
            Number.isInteger(Number(cleanRes.rows[0]?.deleted)),
            `Hàm SECURITY DEFINER fn_cleanup_old_idempotency() hoạt động bình thường (deleted=${cleanRes.rows[0]?.deleted})`
        );

        // [P0 FIX Phân hệ 7] Kiểm tra chỉ tồn tại DUY NHẤT 1 bản fn_lookup_open_invoice_by_codes (không còn xung đột overload 1 vs 2 tham số)
        const ovRes = await testPool.query(
            `SELECT COUNT(*)::int AS cnt
               FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'fn_lookup_open_invoice_by_codes'`
        );
        assert(
            ovRes.rows[0]?.cnt === 1,
            `Không có xung đột overload trên fn_lookup_open_invoice_by_codes (số hàm hiện tại = ${ovRes.rows[0]?.cnt})`
        );

        // [Phân hệ 7] Kiểm tra bảng Refresh_Tokens đã bật FORCE ROW LEVEL SECURITY Fail-Closed
        const rtMeta = await testPool.query(
            `SELECT c.relrowsecurity, c.relforcerowsecurity
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'refresh_tokens'`
        );
        if (rtMeta.rows.length > 0) {
            assert(
                rtMeta.rows[0].relrowsecurity && rtMeta.rows[0].relforcerowsecurity,
                'Bảng "refresh_tokens" đã bật ENABLE + FORCE ROW LEVEL SECURITY'
            );
        }
    } finally {
        await testPool.end();
    }
}

async function main() {
    console.log(`🔐 Bắt đầu kiểm thử bảo mật Multi-Tenant, SaaS & 5 Kịch Bản Tích Hợp Pilot tại ${API}...\n`);

    try {
        const health = await req('');
        assert(health.status === 200, `Kết nối Backend tại ${API} thành công`);
    } catch (err) {
        const cause = err?.cause?.code || err?.message || 'fetch failed';
        console.error(`❌ Không kết nối được tới Backend tại ${API} (${cause}).`);
        console.error('👉 Hãy mở một terminal khác trong thư mục cafe-pos-backend và chạy: node server.js');
        console.error('   Sau khi thấy dòng "Server Backend & Socket.IO ... đang chạy tại http://localhost:3000", hãy chạy lại: npm run test:security');
        process.exit(1);
    }

    const rand = Math.random().toString(36).slice(2, 8);
    // 1. Tạo 2 quán độc lập (Tenant A = PRO & Tenant B = STARTER)
    const emailA = `seca_${rand}@test.local`;
    const regA = await req('/saas/register', {
        method: 'POST',
        body: {
            tenQuan: `Test Cafe A ${rand}`,
            moHinh: 'CAFE_TAKEAWAY',
            soBan: 2,
            tenChuQuan: 'Chủ Quán A',
            tenDangNhap: `seca_${rand}`,
            email: emailA,
            matKhau: 'TestPass123!',
            goiCuoc: 'PRO',
        },
    });
    assert(regA.status === 201 && regA.data?.token, 'Đăng ký Tenant A (dùng thử 30 ngày) thành công');

    const regB = await req('/saas/register', {
        method: 'POST',
        body: {
            tenQuan: `Test Cafe B ${rand}`,
            moHinh: 'TRA_SUA',
            soBan: 2,
            tenChuQuan: 'Chủ Quán B',
            tenDangNhap: `secb_${rand}`,
            email: `secb_${rand}@test.local`,
            matKhau: 'TestPass123!',
            goiCuoc: 'STARTER',
        },
    });
    assert(regB.status === 201 && regB.data?.token, 'Đăng ký Tenant B (dùng thử 30 ngày) thành công');

    const tokenA = regA.data.token;
    const tokenB = regB.data.token;

    // Kiểm tra chặn trùng định danh chủ quán (Email toàn hệ thống qua fn_contact_exists dưới NOBYPASSRLS)
    const dupReg = await req('/saas/register', {
        method: 'POST',
        body: {
            tenQuan: `Test Dup ${rand}`,
            moHinh: 'CAFE_TAKEAWAY',
            soBan: 1,
            tenChuQuan: 'Dup',
            tenDangNhap: `seca_${rand}`,
            email: emailA,
            matKhau: 'TestPass123!',
            goiCuoc: 'STARTER',
        },
    });
    assert(dupReg.status === 409, `Chặn trùng Email chủ quán khi đăng ký quán trả về 409 (status=${dupReg.status})`);

    // Kiểm tra chặn trùng username trong cùng 1 Tenant (fn_tenant_username_exists dưới NOBYPASSRLS)
    const dupSameTenantUser = await req('/nhansu/nhanvien', {
        method: 'POST',
        token: tokenA,
        body: {
            tenNV: 'Nhân viên trùng username',
            tenDangNhap: `seca_${rand}`,
            matKhau: 'TestPass123!',
            vaiTro: 4,
        },
    });
    assert(
        dupSameTenantUser.status === 409,
        `Chặn trùng username trong cùng Tenant A trả về 409 (status=${dupSameTenantUser.status})`
    );

    // 2. Lấy 1 món của Tenant A & tạo 1 hóa đơn mở của Tenant A
    const menuA = await req('/sanpham', { token: tokenA });
    assert(menuA.status === 200 && menuA.data.length > 0, 'Tenant A đọc được thực đơn của mình');
    const monA = menuA.data[0];

    const orderA = await req('/order', {
        method: 'POST',
        token: tokenA,
        body: { danhSachMon: [{ maMon: monA.maMon, kichThuoc: 'M', soLuong: 1 }] },
    });
    assert(orderA.status === 201 && orderA.data?.maHoaDon, 'Tenant A tạo đơn hàng thành công');
    const hdA = orderA.data.maHoaDon;

    // 3. Kiểm thử IDOR: Tenant B cố tấn công tài nguyên của Tenant A
    const readHdA = await req(`/hoadon/${hdA}`, { token: tokenB });
    assert(readHdA.status === 404, `Tenant B KHÔNG đọc được hóa đơn của Tenant A (status=${readHdA.status})`);

    const lockMonA = await req(`/sanpham/${monA.maMon}/tamhet`, {
        method: 'PUT',
        token: tokenB,
        body: { tamHet: true },
    });
    assert(lockMonA.status === 404, `Tenant B KHÔNG khóa 86 được món của Tenant A (status=${lockMonA.status})`);

    const payHdA = await req('/order/thanhtoan', {
        method: 'POST',
        token: tokenB,
        body: { maHoaDon: hdA, phuongThucTT: 'TIEN_MAT' },
    });
    assert(payHdA.status === 404, `Tenant B KHÔNG thanh toán hộ/phá đơn của Tenant A (status=${payHdA.status})`);

    const recipeA = await req(`/congthuc/${monA.maMon}`, { token: tokenB });
    assert(recipeA.status === 404, `Tenant B KHÔNG đọc được công thức BOM của Tenant A (status=${recipeA.status})`);

    const luongB = await req('/nhansu/tinhluong?tuNgay=2026-01-01&denNgay=2026-12-31', { token: tokenB });
    const maNVA = regA.data?.user?.maNV;
    const leakedAInB = Array.isArray(luongB.data?.bangLuong) && luongB.data.bangLuong.some((n) => n.maNV === maNVA);
    assert(
        luongB.status === 200 && !leakedAInB,
        `Tenant B KHÔNG đọc lậu được nhân viên của Tenant A qua /api/nhansu/tinhluong (status=${luongB.status})`
    );

    const refundHdA = await req(`/order/${hdA}/hoan-tien`, {
        method: 'POST',
        token: tokenB,
        body: { lyDo: 'Test IDOR hoàn tiền chéo quán', phuongThucHoan: 'TIEN_MAT' },
    });
    assert(refundHdA.status === 404, `Tenant B KHÔNG hoàn tiền được đơn của Tenant A (status=${refundHdA.status})`);

    // 4. Kiểm thử khóa thu tiền SaaS: Tenant B KHÔNG tự xác nhận thanh toán hay tự nâng gói miễn phí
    const billB = await req('/saas/billing/create-order', {
        method: 'POST',
        token: tokenB,
        body: { goiCuoc: 'ENTERPRISE', soThang: 1 },
    });
    assert(billB.status === 201 && billB.data?.order?.maDonThanhToan, 'Tenant B tạo đơn thanh toán nâng gói thành công');

    const selfConfirm = await req('/saas/billing/confirm', {
        method: 'POST',
        token: tokenB,
        body: { maDonThanhToan: billB.data.order.maDonThanhToan },
    });
    assert(selfConfirm.status === 403, `Tenant B bị CHẶN tự xác nhận thanh toán gói cước (status=${selfConfirm.status})`);

    const freeUpgrade = await req('/saas/plan', {
        method: 'PUT',
        token: tokenB,
        body: { goiCuoc: 'ENTERPRISE' },
    });
    assert(freeUpgrade.status === 402, `Tenant B bị CHẶN tự nâng gói miễn phí (status=${freeUpgrade.status})`);

    // 5. Kiểm thử Feature Flags Enforcement theo gói cước (Tenant B = STARTER vs Tenant A = PRO)
    const auditB = await req('/audit-logs', { token: tokenB });
    assert(
        auditB.status === 403 && auditB.data?.code === 'FEATURE_NOT_IN_PLAN',
        `Tenant B (STARTER) bị CHẶN Audit Logs theo Feature Flag (status=${auditB.status}, code=${auditB.data?.code})`
    );
    const auditA = await req('/audit-logs', { token: tokenA });
    assert(auditA.status === 200, `Tenant A (PRO) đọc được Audit Logs (status=${auditA.status})`);

    const bcgB = await req('/baocao/menu-engineering', { token: tokenB });
    assert(
        bcgB.status === 403 && bcgB.data?.code === 'FEATURE_NOT_IN_PLAN',
        `Tenant B (STARTER) bị CHẶN Ma trận BCG theo Feature Flag (status=${bcgB.status}, code=${bcgB.data?.code})`
    );
    const vqrB = await req('/webhooks/vietqr/logs', { token: tokenB });
    assert(
        vqrB.status === 403 && vqrB.data?.code === 'FEATURE_NOT_IN_PLAN',
        `Tenant B (STARTER) bị CHẶN VietQR Webhook Logs theo Feature Flag (status=${vqrB.status}, code=${vqrB.data?.code})`
    );

    // 6. Kiểm thử tách riêng Platform Super Admin (/api/platform/*): Tenant JWT bị chặn tuyệt đối
    const platFromTenantA = await req('/platform/tenants', { token: tokenA });
    assert(
        platFromTenantA.status === 403 && platFromTenantA.data?.code === 'PLATFORM_ADMIN_ONLY',
        `Tenant JWT bị CHẶN truy cập /api/platform/tenants (status=${platFromTenantA.status})`
    );

    // =========================================================================
    // 5 KỊCH BẢN KIỂM THỬ TÍCH HỢP PILOT (P0 HARDENING)
    // =========================================================================
    console.log('\n🧪 Bắt đầu 5 kịch bản kiểm thử tích hợp Pilot...\n');

    // [Kịch bản 1] Kiểm tra Fail-Closed RLS tầng DB trên KhuyenMai + 5 bảng con & fn_cleanup_old_idempotency
    await testDbLevelRls();

    // [Kịch bản 2] VietQR Webhook + Ưu đãi end-to-end & Chặn sửa/hủy đơn đang khóa ưu đãi (409 CO_UU_DAI_CHUA_GO)
    const codeA = `PROMO20_${rand}`.toUpperCase().slice(0, 20);
    const kmA = await req('/khuyenmai', {
        method: 'POST',
        token: tokenA,
        body: {
            loaiKM: 'CODE',
            maCode: codeA,
            tenChuongTrinh: 'Giảm 20% Test Webhook',
            kieuGiam: 'PERCENT',
            giaTriGiam: 20,
            donToiThieu: 0,
        },
    });
    assert(kmA.status === 201, `[KB2] Tenant A tạo mã giảm giá ${codeA} (-20%) thành công`);

    const ordPromo = await req('/order', {
        method: 'POST',
        token: tokenA,
        body: { danhSachMon: [{ maMon: monA.maMon, kichThuoc: 'M', soLuong: 2 }] },
    });
    assert(ordPromo.status === 201 && ordPromo.data?.maHoaDon, '[KB2] Tạo đơn mở để áp ưu đãi thành công');
    const hdPromoId = ordPromo.data.maHoaDon;
    const cthdPromoId = ordPromo.data.danhSachMon?.[0]?.maCTHD;
    const rawTotal = Number(ordPromo.data.hoaDon?.tongTamTinh || 0);
    const expectedNet = Math.max(0, rawTotal - Math.round((rawTotal * 20) / 100));

    const apUuDaiRes = await req(`/order/${hdPromoId}/ap-uu-dai`, {
        method: 'POST',
        token: tokenA,
        body: { maKhuyenMai: codeA, tuDongHappyHour: false },
    });
    assert(
        apUuDaiRes.status === 200 && Number(apUuDaiRes.data?.hoaDon?.conLaiCanThu) === expectedNet,
        `[KB2] Khóa ưu đãi xuống HoaDon thành công (gốc=${rawTotal}đ -> còn thu=${apUuDaiRes.data?.hoaDon?.conLaiCanThu}đ)`
    );

    // Chặn hủy món & gọi thêm món khi đang khóa ưu đãi (Bẫy ẩn #1)
    const blockVoid = await req('/order/huy-mon', {
        method: 'POST',
        token: tokenA,
        body: { maCTHD: cthdPromoId, lyDo: 'Thử hủy khi đang áp mã KM' },
    });
    assert(
        blockVoid.status === 409 && blockVoid.data?.maLoi === 'CO_UU_DAI_CHUA_GO',
        `[KB2] Chặn hủy món khi hóa đơn đang khóa ưu đãi (status=${blockVoid.status}, maLoi=${blockVoid.data?.maLoi})`
    );
    const blockAdd = await req('/order', {
        method: 'POST',
        token: tokenA,
        body: { maHoaDon: hdPromoId, danhSachMon: [{ maMon: monA.maMon, kichThuoc: 'M', soLuong: 1 }] },
    });
    assert(
        blockAdd.status === 409 && blockAdd.data?.maLoi === 'CO_UU_DAI_CHUA_GO',
        `[KB2] Chặn gọi thêm món vào đơn đang khóa ưu đãi (status=${blockAdd.status}, maLoi=${blockAdd.data?.maLoi})`
    );

    // Thanh toán đúng số tiền sau giảm qua SePay Webhook (không JWT) hoặc test-simulate
    if (SEPAY_API_KEY) {
        const whRes = await req('/webhooks/sepay', {
            method: 'POST',
            headers: { Authorization: `Apikey ${SEPAY_API_KEY}` },
            body: {
                id: `TEST_HD_${rand}_${Date.now()}`,
                transferType: 'in',
                transferAmount: expectedNet,
                content: `POSHD${hdPromoId}`,
            },
        });
        assert(
            whRes.status === 200 && whRes.data?.trangThaiXuLy === 'MATCHED_PAID' && whRes.data?.daHoanTat === true,
            `[KB2] SePay Webhook (không JWT) chốt đơn ưu đãi đúng ${expectedNet}đ -> MATCHED_PAID`
        );
    } else {
        const simRes = await req('/webhooks/vietqr/test-simulate', {
            method: 'POST',
            token: tokenA,
            body: { maHoaDon: hdPromoId, soTien: expectedNet },
        });
        assert(
            simRes.status === 200 && simRes.data?.trangThaiXuLy === 'MATCHED_PAID' && simRes.data?.daHoanTat === true,
            `[KB2] VietQR Webhook simulate chốt đơn ưu đãi đúng ${expectedNet}đ -> MATCHED_PAID`
        );
    }
    const hdAfterWh = await req(`/hoadon/${hdPromoId}`, { token: tokenA });
    assert(
        hdAfterWh.status === 200 && hdAfterWh.data?.hoaDon?.trangThaiTT === 1,
        `[KB2] Hóa đơn #${hdPromoId} đã chuyển TrangThaiTT = 1 khớp hoàn toàn với Webhook`
    );

    // [Kịch bản 3] Tự kích hoạt gói SaaS SUB... qua SePay Webhook (không JWT, dưới NOBYPASSRLS)
    const subOrder = billB.data.order;
    if (SEPAY_API_KEY) {
        const whSub = await req('/webhooks/sepay', {
            method: 'POST',
            headers: { Authorization: `Apikey ${SEPAY_API_KEY}` },
            body: {
                id: `TEST_SUB_${rand}_${Date.now()}`,
                transferType: 'in',
                transferAmount: Number(subOrder.soTien),
                content: `Nang goi ${subOrder.maDonThanhToan}`,
            },
        });
        assert(
            whSub.status === 200 && whSub.data?.trangThaiXuLy === 'SUBSCRIPTION_PAID' && whSub.data?.activated === true,
            `[KB3] SePay Webhook tự động kích hoạt đơn gói ${subOrder.maDonThanhToan} thành công (không lỗi RLS)`
        );
        const auditBAfterUpgrade = await req('/audit-logs', { token: tokenB });
        assert(
            auditBAfterUpgrade.status === 200,
            `[KB3] Tenant B lập tức mở khóa Feature Flag Audit Logs sau khi nâng gói tự động (status=${auditBAfterUpgrade.status})`
        );
    } else if (process.env.APP_RUNTIME_DATABASE_URL || process.env.DATABASE_URL) {
        // Khi chưa set SEPAY_API_KEY trong .env: kiểm thử trực tiếp xuLyThanhToanGoiTuWebhook dưới role app_runtime (NOBYPASSRLS) khi app.current_tenant_id đang rỗng!
        const connStr = process.env.APP_RUNTIME_DATABASE_URL || process.env.DATABASE_URL;
        const ssl = connStr.includes('localhost') ? false : { rejectUnauthorized: false };
        const subPool = new Pool({ connectionString: connStr, ssl, max: 1, connectionTimeoutMillis: 5000 });
        const client = await subPool.connect();
        try {
            await client.query('BEGIN');
            const hasAppRuntime = await client.query(
                `SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime' AND rolsuper = FALSE AND rolbypassrls = FALSE`
            );
            if (hasAppRuntime.rows.length > 0) {
                await client.query('SET LOCAL ROLE app_runtime');
            }
            const subPay = await xuLyThanhToanGoiTuWebhook(client, {
                noiDungCK: `Thanh toan goi ${subOrder.maDonThanhToan}`,
                soTien: Number(subOrder.soTien),
                maGiaoDichNgoai: `TEST_SUB_${rand}_${Date.now()}`,
                nhaCungCap: 'SEPAY_WEBHOOK',
                ghiAuditLog: null,
                ip: '127.0.0.1',
            });
            await client.query('COMMIT');
            assert(
                subPay && subPay.matched === true && subPay.activated === true && subPay.goiCuoc === 'ENTERPRISE',
                `[KB3] xuLyThanhToanGoiTuWebhook tự kích hoạt đơn ${subOrder.maDonThanhToan} thành công dưới NOBYPASSRLS`
            );
        } finally {
            client.release();
            await subPool.end();
        }
    }

    // [Kịch bản 4] Hoàn tiền đơn có Giảm giá + Điểm Loyalty & Hoàn tiền đơn 0đ (không lỗi CHECK SoTien > 0) + Dashboard thuần
    const regC = await req('/saas/register', {
        method: 'POST',
        body: {
            tenQuan: `Test Cafe C ${rand}`,
            moHinh: 'CAFE_TAKEAWAY',
            soBan: 2,
            tenChuQuan: 'Chủ Quán C',
            tenDangNhap: `secc_${rand}`,
            matKhau: 'TestPass123!',
            goiCuoc: 'PRO',
        },
    });
    assert(regC.status === 201 && regC.data?.token, '[KB4] Tạo Tenant C độc lập cho kiểm thử Hoàn tiền & Dashboard');
    const tokenC = regC.data.token;
    const menuC = await req('/sanpham', { token: tokenC });
    const monC = menuC.data[0];

    const sdtC = `098${Math.floor(1000000 + Math.random() * 8999999)}`;
    const khCRes = await req('/khachhang', {
        method: 'POST',
        token: tokenC,
        body: { soDienThoai: sdtC, tenKH: 'Khách Loyalty Test' },
    });
    const maKHC = khCRes.data?.khachHang?.makh || khCRes.data?.khachHang?.maKH;
    assert(khCRes.status === 200 && maKHC, `[KB4] Tạo khách hàng thành viên (${maKHC}) thành công`);

    // Đơn #1 (10 ly -> chắc chắn tích >= 20 điểm)
    const ordEarn = await req('/order/quick-checkout', {
        method: 'POST',
        token: tokenC,
        body: {
            maKH: maKHC,
            phuongThucTT: 'TIEN_MAT',
            danhSachMon: [{ maMon: monC.maMon, kichThuoc: 'M', soLuong: 10 }],
        },
    });
    assert(ordEarn.status === 201 && ordEarn.data?.diemCong > 0, `[KB4] Đơn #1 tích được ${ordEarn.data?.diemCong} điểm Loyalty`);
    const earnPaidTotal = Number(ordEarn.data.hoaDon?.tongTienThanhToan || 0);
    const diemSauDon1 = Number(ordEarn.data.hoaDon?.khachHang?.diemTichLuy || ordEarn.data.diemCong || 0);

    // Tạo mã SALE20 (-20%) và mã FREE100 (-100%)
    const codeSale = `SALE20_${rand}`.toUpperCase().slice(0, 20);
    const codeFree = `FREE100_${rand}`.toUpperCase().slice(0, 20);
    await req('/khuyenmai', {
        method: 'POST',
        token: tokenC,
        body: { loaiKM: 'CODE', maCode: codeSale, tenChuongTrinh: 'Giảm 20%', kieuGiam: 'PERCENT', giaTriGiam: 20 },
    });
    await req('/khuyenmai', {
        method: 'POST',
        token: tokenC,
        body: { loaiKM: 'CODE', maCode: codeFree, tenChuongTrinh: 'Miễn phí 100%', kieuGiam: 'PERCENT', giaTriGiam: 100 },
    });

    // Đơn #2: dùng mã SALE20 + đổi 5 điểm Loyalty
    const diemDoi = Math.min(5, diemSauDon1);
    const ordDisc = await req('/order/quick-checkout', {
        method: 'POST',
        token: tokenC,
        body: {
            maKH: maKHC,
            maKhuyenMai: codeSale,
            diemSuDung: diemDoi,
            tuDongHappyHour: false,
            phuongThucTT: 'TIEN_MAT',
            danhSachMon: [{ maMon: monC.maMon, kichThuoc: 'M', soLuong: 2 }],
        },
    });
    assert(
        ordDisc.status === 201 &&
            Number(ordDisc.data.hoaDon?.tienGiamKM) > 0 &&
            Number(ordDisc.data.hoaDon?.tienGiamDiem) === diemDoi * 1000,
        `[KB4] Đơn #2 áp đồng thời ${codeSale} (-${ordDisc.data.hoaDon?.tienGiamKM}đ) + đổi ${diemDoi} điểm (-${ordDisc.data.hoaDon?.tienGiamDiem}đ)`
    );
    const hdDiscId = ordDisc.data.hoaDon?.maHoaDon || ordDisc.data.maHoaDon;
    const paidDisc = Number(ordDisc.data.hoaDon?.tongTienThanhToan || 0);

    // Hoàn tiền Đơn #2 -> kiểm tra hoàn đúng paidDisc (KHÔNG phải tongTamTinh!), khôi phục điểm ròng & lượt KM
    const refDisc = await req(`/order/${hdDiscId}/hoan-tien`, {
        method: 'POST',
        token: tokenC,
        body: { lyDo: 'Test hoàn đơn có giảm giá + điểm', phuongThucHoan: 'TIEN_MAT', hoanKho: false },
    });
    assert(
        refDisc.status === 200 && Number(refDisc.data?.tongHoan) === paidDisc,
        `[KB4] Hoàn tiền Đơn #2 khớp chính xác số tiền thực thu (${refDisc.data?.tongHoan}đ === ${paidDisc}đ, status=${refDisc.status}, không hoàn thừa)`
    );

    const khCheck = await req(`/khachhang?soDienThoai=${encodeURIComponent(sdtC)}`, { token: tokenC });
    const diemSauHoan = Number(khCheck.data?.khachHang?.diemTichLuy ?? khCheck.data?.diemTichLuy ?? -1);
    assert(
        diemSauHoan === diemSauDon1,
        `[KB4] Điểm Loyalty của khách được khôi phục chính xác về ${diemSauHoan} điểm (trước đơn #2: ${diemSauDon1})`
    );

    const kmListC = await req('/khuyenmai', { token: tokenC });
    const saleKmAfter = (kmListC.data || []).find((k) => k.maCode === codeSale);
    assert(
        saleKmAfter && Number(saleKmAfter.soLuotDaDung) === 0,
        `[KB4] SoLuotDaDung của mã ${codeSale} giảm về 0 sau khi hoàn đơn`
    );

    // Đơn #3: thanh toán 0đ (100% ưu đãi) -> hoàn tiền không văng lỗi CHECK (SoTien > 0) trên Order_Payments
    const ordZero = await req('/order/quick-checkout', {
        method: 'POST',
        token: tokenC,
        body: {
            maKH: maKHC,
            maKhuyenMai: codeFree,
            tuDongHappyHour: false,
            phuongThucTT: 'TIEN_MAT',
            danhSachMon: [{ maMon: monC.maMon, kichThuoc: 'M', soLuong: 1 }],
        },
    });
    const hdZeroId = ordZero.data.hoaDon?.maHoaDon || ordZero.data.maHoaDon;
    assert(
        ordZero.status === 201 && hdZeroId && Number(ordZero.data.hoaDon?.tongTienThanhToan) === 0,
        '[KB4] Tạo đơn 0đ (100% ưu đãi) thành công không lỗi CHECK Order_Payments'
    );
    const refZero = await req(`/order/${hdZeroId}/hoan-tien`, {
        method: 'POST',
        token: tokenC,
        body: { lyDo: 'Test hoàn đơn 0đ mã 100% không lỗi 23514', phuongThucHoan: 'TIEN_MAT', hoanKho: true },
    });
    assert(
        refZero.status === 200 && Number(refZero.data?.tongHoan) === 0,
        `[KB4] Hoàn đơn 0đ (100% mã KM) thành công không dính lỗi CHECK 23514 (status=${refZero.status})`
    );
    const monGiaM = Number(monC.sizes?.find((s) => s.kichThuoc === 'M')?.giaBan || monC.giaBan || 30000);
    const diemCanCho1Ly = Math.ceil(monGiaM / 1000);
    if (diemSauHoan >= diemCanCho1Ly) {
        const ordZeroPts = await req('/order/quick-checkout', {
            method: 'POST',
            token: tokenC,
            body: {
                maKH: maKHC,
                diemSuDung: diemCanCho1Ly,
                tuDongHappyHour: false,
                phuongThucTT: 'TIEN_MAT',
                danhSachMon: [{ maMon: monC.maMon, kichThuoc: 'M', soLuong: 1 }],
            },
        });
        const hdZeroPtsId = ordZeroPts.data.hoaDon?.maHoaDon || ordZeroPts.data.maHoaDon;
        assert(
            ordZeroPts.status === 201 && hdZeroPtsId && Number(ordZeroPts.data.hoaDon?.tongTienThanhToan) === 0,
            `[KB4] Thanh toán đơn 0đ bằng đổi 100% điểm (${diemCanCho1Ly} điểm) thành công`
        );
        const refZeroPts = await req(`/order/${hdZeroPtsId}/hoan-tien`, {
            method: 'POST',
            token: tokenC,
            body: { lyDo: 'Test hoàn đơn 0đ đổi điểm 100%', phuongThucHoan: 'TIEN_MAT', hoanKho: true },
        });
        assert(
            refZeroPts.status === 200 && Number(refZeroPts.data?.tongHoan) === 0,
            `[KB4] Hoàn tiền đơn 0đ đổi điểm 100% thành công không dính lỗi CHECK 23514 (status=${refZeroPts.status})`
        );
    }

    // Kiểm tra Dashboard tongDoanhThu thuần trên Tenant C khớp đúng Đơn #1 (không bị thổi phồng & loại trừ đơn đã hoàn)
    const dashC = await req(`/baocao/dashboard?tuNgay=${TODAY_VN}&denNgay=${TODAY_VN}`, { token: tokenC });
    assert(
        dashC.status === 200 && Number(dashC.data?.tongQuan?.tongDoanhThu) === earnPaidTotal,
        `[KB4] Dashboard tongDoanhThu thuần (${dashC.data?.tongQuan?.tongDoanhThu}đ) khớp 100% thực thu (${earnPaidTotal}đ)`
    );

    // [Kịch bản 5] Đồng bộ Offline lệch ca (MaOfflineClient + cờ lechCaDongBo trong Audit_Logs)
    const ca1Res = await req('/ca/hientai', { token: tokenC });
    const ca1Id = ca1Res.data?.caHienTai?.maCaThuNgan;
    assert(ca1Res.status === 200 && ca1Id, `[KB5] Đọc Ca 1 hiện tại (#${ca1Id}) thành công`);

    const closeCa1 = await req('/ca/dong', {
        method: 'POST',
        token: tokenC,
        body: { tienMatThucTe: 500000 + earnPaidTotal },
    });
    assert(closeCa1.status === 200, `[KB5] Đóng Ca 1 (#${ca1Id}) thành công`);

    const openCa2 = await req('/ca/mo', {
        method: 'POST',
        token: tokenC,
        body: { tienMatDauCa: 500000 },
    });
    const ca2Id = openCa2.data?.ca?.maCaThuNgan;
    assert(openCa2.status === 201 && ca2Id && String(ca2Id) !== String(ca1Id), `[KB5] Mở Ca 2 (#${ca2Id}) thành công`);

    const offlineClientId = `OFF-${Date.now().toString().slice(-6)}`;
    const idemOffline = `idem_off_${rand}_${Date.now()}`;
    const syncRes = await req('/order/quick-checkout', {
        method: 'POST',
        token: tokenC,
        headers: {
            'X-Offline-Sync': '1',
            'Idempotency-Key': idemOffline,
        },
        body: {
            phuongThucTT: 'TIEN_MAT',
            offlineClientId,
            offlineCreatedAt: new Date(Date.now() - 600000).toISOString(),
            maCaThuNganGoc: ca1Id,
            danhSachMon: [{ maMon: monC.maMon, kichThuoc: 'M', soLuong: 1 }],
        },
    });
    const hdSyncId = syncRes.data?.hoaDon?.maHoaDon || syncRes.data?.maHoaDon;
    assert(syncRes.status === 201 && hdSyncId, `[KB5] Đồng bộ đơn Offline ${offlineClientId} sang Ca 2 thành công`);

    const logsC = await req('/audit-logs?limit=30', { token: tokenC });
    const offLog = (logsC.data || []).find(
        (l) => l.hanhDong === 'OFFLINE_ORDER_SYNCED' && String(l.maDoiTuong) === String(hdSyncId)
    );
    assert(
        offLog &&
            offLog.giaTriMoi?.offlineClientId === offlineClientId &&
            String(offLog.giaTriMoi?.maCaThuNganGoc) === String(ca1Id) &&
            offLog.giaTriMoi?.lechCaDongBo === true,
        `[KB5] Audit Log ghi nhận đủ MaOfflineClient=${offlineClientId}, Ca gốc #${ca1Id} & cờ lechCaDongBo=true`
    );

    // [Kịch bản 6] FOH & Order Engine: Tách lẻ theo số lượng ly (Partial Split) + Chuyển ghép món sang bàn đang có khách + Trạng thái bàn Chờ dọn (3)
    const banCRes = await req('/ban', { token: tokenC });
    const dsBanC = Array.isArray(banCRes.data) ? banCRes.data : [];
    const ban1 = dsBanC[0];
    const ban2 = dsBanC[1];
    if (ban1 && ban2) {
        const maBan1 = ban1.maBan || ban1.maban;
        const maBan2 = ban2.maBan || ban2.maban;

        // Mở đơn trên Bàn 1 với 1 dòng x 3 ly
        const ordBan1 = await req('/order', {
            method: 'POST',
            token: tokenC,
            body: {
                maBan: maBan1,
                danhSachMon: [{ maMon: monC.maMon, kichThuoc: 'M', soLuong: 3 }],
            },
        });
        const hdBan1Id = ordBan1.data?.maHoaDon;
        const cthdBan1 = ordBan1.data?.danhSachMon?.[0];
        const orig3Total = Number(ordBan1.data?.hoaDon?.tongTamTinh || 0);
        assert(
            ordBan1.status === 201 && hdBan1Id && Number(cthdBan1?.soLuong) === 3,
            `[KB6] Mở đơn Bàn 1 (#${hdBan1Id}) với 1 dòng × 3 ly thành công (STT #${ordBan1.data?.hoaDon?.soThuTuNgay})`
        );

        // 1. Tách lẻ 1 ly ra hóa đơn mới (Partial Quantity Split: 3 ly -> còn 2 ly + đơn mới 1 ly)
        const splitPartial = await req(`/order/${hdBan1Id}/tach`, {
            method: 'POST',
            token: tokenC,
            body: {
                splitItems: [{ maCTHD: cthdBan1.maCTHD, soLuong: 1 }],
                mode: 'NEW_INVOICE',
            },
        });
        const remAfter1 = Number(splitPartial.data?.hoaDonGoc?.tongTamTinh || 0);
        const new1Total = Number(splitPartial.data?.hoaDonMoi?.tongTamTinh || 0);
        const remQty1 = Number(splitPartial.data?.hoaDonGoc?.danhSachMon?.[0]?.soLuong || 0);
        assert(
            [200, 201].includes(splitPartial.status) && remQty1 === 2 && remAfter1 + new1Total === orig3Total,
            `[KB6] Tách lẻ 1/3 ly thành công: HĐ gốc còn ${remQty1} ly (${remAfter1}đ) + HĐ tách 1 ly (${new1Total}đ) = ${orig3Total}đ`
        );

        // 2. Mở đơn trên Bàn 2 (1 ly), sau đó chuyển ghép 1 ly từ Bàn 1 sang Bàn 2 đang có khách (mode: TRANSFER_TO_TABLE)
        const ordBan2 = await req('/order', {
            method: 'POST',
            token: tokenC,
            body: {
                maBan: maBan2,
                danhSachMon: [{ maMon: monC.maMon, kichThuoc: 'M', soLuong: 1 }],
            },
        });
        const hdBan2Id = ordBan2.data?.maHoaDon;
        assert(ordBan2.status === 201 && hdBan2Id, `[KB6] Mở đơn Bàn 2 (#${hdBan2Id}) thành công`);

        const transferItem = await req(`/order/${hdBan1Id}/tach`, {
            method: 'POST',
            token: tokenC,
            body: {
                splitItems: [{ maCTHD: cthdBan1.maCTHD, soLuong: 1 }],
                toMaBan: maBan2,
                mode: 'TRANSFER_TO_TABLE',
            },
        });
        const remQty2 = Number(transferItem.data?.hoaDonGoc?.danhSachMon?.[0]?.soLuong || 0);
        const ban2Cups = (transferItem.data?.hoaDonMoi?.danhSachMon || []).reduce(
            (s, m) => s + Number(m.soLuong || 0),
            0
        );
        assert(
            [200, 201].includes(transferItem.status) &&
                String(transferItem.data?.maHoaDonMoi) === String(hdBan2Id) &&
                remQty2 === 1 &&
                ban2Cups === 2,
            `[KB6] Chuyển ghép 1 ly từ Bàn 1 sang Bàn 2 đang có khách (#${hdBan2Id}) thành công (Bàn 1 còn ${remQty2} ly, Bàn 2 có ${ban2Cups} ly)`
        );

        // 3. Kiểm tra chặn đổi trạng thái bàn khi bàn đang có hóa đơn chưa thanh toán (409 BAN_DANG_CO_KHACH)
        const blockClean = await req(`/ban/${maBan1}/trangthai`, {
            method: 'PUT',
            token: tokenC,
            body: { trangThai: 3 },
        });
        assert(
            blockClean.status === 409 && blockClean.data?.code === 'BAN_DANG_CO_KHACH',
            `[KB6] Chặn đổi trạng thái bàn sang Chờ dọn khi bàn vẫn còn hóa đơn chưa thanh toán (status=${blockClean.status})`
        );

        // Thanh toán Bàn 1 rồi đánh dấu Bàn 1 sang 3 = Chờ dọn -> 1 = Trống
        await req('/order/thanhtoan', {
            method: 'POST',
            token: tokenC,
            body: { maHoaDon: hdBan1Id, phuongThucTT: 'TIEN_MAT' },
        });
        const markClean = await req(`/ban/${maBan1}/trangthai`, {
            method: 'PUT',
            token: tokenC,
            body: { trangThai: 3 },
        });
        const markReady = await req(`/ban/${maBan1}/trangthai`, {
            method: 'PUT',
            token: tokenC,
            body: { trangThai: 1 },
        });
        assert(
            markClean.status === 200 && markReady.status === 200,
            `[KB6] Đổi trạng thái Bàn 1 sang 3 (Chờ dọn) -> 1 (Trống) thành công sau khi thanh toán`
        );
    }

    // [Kịch bản 7] Real-Time Engine & BDS: Phân tuyến Trạm KDS (TramCheBien) + Đổi món sau thanh toán (POST /api/order/:maHoaDon/doi-mon)
    const addPastry = await req('/sanpham', {
        method: 'POST',
        token: tokenC,
        body: {
            maMon: `BANH_${rand}`,
            tenMon: 'Bánh Croissant Bơ Pháp',
            nhomMon: 'Bánh ngọt',
            tramCheBien: 'BEP_BANH',
            giaGoc: 45000,
            sizes: [
                { kichThuoc: 'S', giaBan: 45000 },
                { kichThuoc: 'M', giaBan: 55000 },
                { kichThuoc: 'L', giaBan: 65000 },
            ],
        },
    });
    const maMonPastry = addPastry.data?.maMon;
    assert(
        addPastry.status === 200 && maMonPastry && addPastry.data?.tramCheBien === 'BEP_BANH',
        `[KB7] Tạo món "${maMonPastry}" gắn Trạm KDS = BEP_BANH thành công`
    );

    // Tạo đơn đã thanh toán (Size S), sau đó khách xin đổi sang món Bánh Croissant Size M (tự tính bù chênh lệch!)
    const ordSwap = await req('/order/quick-checkout', {
        method: 'POST',
        token: tokenC,
        body: {
            phuongThucTT: 'TIEN_MAT',
            danhSachMon: [{ maMon: monC.maMon, kichThuoc: 'S', soLuong: 1 }],
        },
    });
    const hdSwapId = ordSwap.data?.hoaDon?.maHoaDon || ordSwap.data?.maHoaDon;
    const cthdSwap = ordSwap.data?.hoaDon?.danhSachMon?.[0] || ordSwap.data?.danhSachMon?.[0];
    const giaCuSwap = Number(ordSwap.data?.hoaDon?.tongTienThanhToan || 0);
    assert(ordSwap.status === 201 && hdSwapId && cthdSwap?.maCTHD, `[KB7] Tạo đơn đã thanh toán #${hdSwapId} (${giaCuSwap}đ) thành công`);

    const swapRes = await req(`/order/${hdSwapId}/doi-mon`, {
        method: 'POST',
        token: tokenC,
        body: {
            maCTHD: cthdSwap.maCTHD,
            maMonMoi: maMonPastry,
            kichThuocMoi: 'M',
            soLuongMoi: 1,
            ghiChuMoi: 'Nướng nóng giòn',
            phuongThucTTChenhLech: 'TIEN_MAT',
            lyDo: 'Khách xin đổi sang Bánh Croissant size M',
        },
    });
    const expectedDiff = 55000 - giaCuSwap;
    assert(
        swapRes.status === 200 &&
            Number(swapRes.data?.chenhLech) === expectedDiff &&
            Number(swapRes.data?.hoaDon?.tongTienThanhToan) === 55000,
        `[KB7] Đổi món sau thanh toán thành công: chênh lệch ${swapRes.data?.chenhLech}đ, tổng thanh toán mới = ${swapRes.data?.hoaDon?.tongTienThanhToan}đ`
    );

    const swappedMaCTHD = swapRes.data?.newMaCTHD || cthdSwap.maCTHD;

    // Kiểm tra lọc hàng đợi KDS theo trạm ?tram=BEP_BANH
    const kdsBep = await req('/order/dangcho?tram=BEP_BANH', { token: tokenC });
    assert(
        kdsBep.status === 200 &&
            Array.isArray(kdsBep.data) &&
            kdsBep.data.some((m) => String(m.maCTHD) === String(swappedMaCTHD) && m.tramCheBien === 'BEP_BANH'),
        `[KB7] Bộ lọc KDS Multi-Station (/api/order/dangcho?tram=BEP_BANH) trả về đúng món vừa đổi sang Bếp Bánh`
    );

    // Barista bấm Nhận làm (DangLam) -> Thu ngân thử đổi món lần nữa phải bị chặn 409 ITEM_ALREADY_STARTED
    await req('/order/danglam', {
        method: 'PUT',
        token: tokenC,
        body: { maCTHD: swappedMaCTHD },
    });
    const blockSwapAfterStart = await req(`/order/${hdSwapId}/doi-mon`, {
        method: 'POST',
        token: tokenC,
        body: {
            maCTHD: swappedMaCTHD,
            maMonMoi: monC.maMon,
            kichThuocMoi: 'S',
        },
    });
    assert(
        blockSwapAfterStart.status === 409 && ['ITEM_ALREADY_STARTED', 'MON_DA_PHA_CHE'].includes(blockSwapAfterStart.data?.code),
        `[KB7] Chặn đổi món khi Barista đã bấm Nhận làm (status=${blockSwapAfterStart.status}, code=${blockSwapAfterStart.data?.code})`
    );

    // [Kịch bản 8] Payment, Shift & Cash Reconciliation: Webhook VietQR riêng từng Tenant (/api/webhooks/sepay/:tenantSlug) + Hoàn tiền 1 phần từng món (dsMaCTHDHoan) + Ảnh chứng từ Phiếu chi (AnhChungTuUrl)
    const secretSepayC = `SEPAY_TENANT_C_SECRET_${rand}`;
    const saveBankC = await req('/settings/bank', {
        method: 'PUT',
        token: tokenC,
        body: {
            bankId: 'MB',
            accountNo: '0999888777',
            accountName: 'CAFE C',
            sepayApiKey: secretSepayC,
        },
    });
    const slugC = saveBankC.data?.bank?.slug;
    assert(
        saveBankC.status === 200 && slugC && saveBankC.data?.bank?.hasSepayKey === true,
        `[KB8] Lưu cấu hình STK & khóa SePay mã hóa AES-256-GCM cho Tenant C (slug=${slugC}) thành công`
    );

    // 1. Gọi /api/webhooks/sepay/:tenantSlug với sai khóa -> bị chặn 401
    const wrongKeyWh = await req(`/webhooks/sepay/${slugC}`, {
        method: 'POST',
        headers: { Authorization: 'Apikey WRONG_KEY_123' },
        body: { id: `W_${rand}`, transferType: 'in', transferAmount: 50000, content: 'POSHD999' },
    });
    assert(wrongKeyWh.status === 401, `[KB8] Webhook /api/webhooks/sepay/${slugC} chặn khóa giả mạo (status=401)`);

    // 2. Tạo đơn mở trên Tenant A và Tenant C -> gọi webhook của Tenant C với mã đơn của Tenant A phải bị từ chối khớp (UNMATCHED)
    const ordOpenA = await req('/order', {
        method: 'POST',
        token: tokenA,
        body: { danhSachMon: [{ maMon: monA.maMon, kichThuoc: 'M', soLuong: 1 }] },
    });
    const hdOpenAId = ordOpenA.data?.maHoaDon;

    const crossWh = await req(`/webhooks/sepay/${slugC}`, {
        method: 'POST',
        headers: { Authorization: `Apikey ${secretSepayC}` },
        body: {
            id: `CROSS_${rand}_${Date.now()}`,
            transferType: 'in',
            transferAmount: 50000,
            accountNumber: '0999888777',
            content: `POSHD${hdOpenAId}`,
        },
    });
    assert(
        crossWh.status === 200 && crossWh.data?.matched === false && crossWh.data?.trangThaiXuLy === 'UNMATCHED',
        `[KB8] Webhook riêng của Tenant C (/api/webhooks/sepay/${slugC}) KHÔNG khớp chéo sang hóa đơn của Tenant A (trangThai=${crossWh.data?.trangThaiXuLy})`
    );

    // 3. Tạo đơn mở trên Tenant C và gọi đúng /api/webhooks/sepay/:slugC -> khớp và chốt đơn tự động
    const ordOpenC = await req('/order', {
        method: 'POST',
        token: tokenC,
        body: { danhSachMon: [{ maMon: monC.maMon, kichThuoc: 'M', soLuong: 1 }] },
    });
    const hdOpenCId = ordOpenC.data?.maHoaDon;
    const needPayC = Number(ordOpenC.data?.hoaDon?.conLaiCanThu || ordOpenC.data?.hoaDon?.tongTamTinh || 30000);
    const validWhC = await req(`/webhooks/sepay/${slugC}`, {
        method: 'POST',
        headers: { Authorization: `Apikey ${secretSepayC}` },
        body: {
            id: `OKC_${rand}_${Date.now()}`,
            transferType: 'in',
            transferAmount: needPayC,
            accountNumber: '0999888777',
            content: `POSHD${hdOpenCId}`,
        },
    });
    assert(
        validWhC.status === 200 && validWhC.data?.matched === true && validWhC.data?.daHoanTat === true,
        `[KB8] Webhook riêng /api/webhooks/sepay/${slugC} xác thực khóa AES-256-GCM & tự chốt HĐ #${hdOpenCId} thành công`
    );

    // 4. Hoàn tiền một phần từng món (Partial Post-Payment Refund qua dsMaCTHDHoan)
    const ordMultiPaid = await req('/order/quick-checkout', {
        method: 'POST',
        token: tokenC,
        body: {
            phuongThucTT: 'TIEN_MAT',
            danhSachMon: [
                { maMon: monC.maMon, kichThuoc: 'S', soLuong: 1 },
                { maMon: maMonPastry, kichThuoc: 'M', soLuong: 1 },
            ],
        },
    });
    const hdMultiId = ordMultiPaid.data?.hoaDon?.maHoaDon || ordMultiPaid.data?.maHoaDon;
    const dsMonMulti = ordMultiPaid.data?.hoaDon?.danhSachMon || [];
    const monPastryLine = dsMonMulti.find((m) => m.maMon === maMonPastry) || dsMonMulti[1];
    const totalBeforePartial = Number(ordMultiPaid.data?.hoaDon?.tongTienThanhToan || 0);

    const partialRef = await req(`/order/${hdMultiId}/hoan-tien`, {
        method: 'POST',
        token: tokenC,
        body: {
            lyDo: 'Hoàn tiền riêng 1 phần món Bánh Croissant',
            phuongThucHoan: 'TIEN_MAT',
            hoanKho: false,
            dsMaCTHDHoan: [monPastryLine.maCTHD],
        },
    });
    assert(
        partialRef.status === 200 &&
            partialRef.data?.laHoanMotPhan === true &&
            Number(partialRef.data?.tongHoan) === Number(monPastryLine.thanhTien),
        `[KB8] Hoàn tiền 1 phần riêng món Bánh (${partialRef.data?.tongHoan}đ / ${totalBeforePartial}đ) thành công, giữ nguyên các món còn lại`
    );

    // 5. Lập phiếu chi kèm ảnh chụp chứng từ (AnhChungTuUrl)
    const fakePhoto = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
    const tcPhoto = await req('/ca/thuchi', {
        method: 'POST',
        token: tokenC,
        body: {
            loaiThuChi: 'CHI',
            soTien: 25000,
            lyDo: 'Mua đá viên khẩn cấp có ảnh hóa đơn',
            anhChungTuUrl: fakePhoto,
        },
    });
    assert(
        tcPhoto.status === 201 && tcPhoto.data?.anhChungTuUrl === fakePhoto,
        '[KB8] Lập phiếu chi tại quầy kèm ảnh chụp chứng từ (AnhChungTuUrl) thành công'
    );

    // [Kịch bản 9] Inventory, Sub-Recipes (Bán thành phẩm / Sơ chế mẻ) & Quick 60s Key-Item Stocktake
    const nlRawRes = await req('/kho/nguyenlieu', {
        method: 'POST',
        token: tokenC,
        body: {
            maNL: `TRA_KHO_${rand}`,
            tenNL: 'Lá Trà Ô Long Khô',
            donViTinh: 'g',
            hanMucCanhBao: 200,
            giaVonDonVi: 500, // 500đ / 1g
        },
    });
    const maNLRaw = nlRawRes.data?.maNL;
    const nlBtpRes = await req('/kho/nguyenlieu', {
        method: 'POST',
        token: tokenC,
        body: {
            maNL: `COT_TRA_${rand}`,
            tenNL: 'Cốt Trà Ô Long Ủ Lạnh',
            donViTinh: 'ml',
            hanMucCanhBao: 1000,
            giaVonDonVi: 0,
        },
    });
    const maNLBtp = nlBtpRes.data?.maNL;
    assert(nlRawRes.status === 201 && nlBtpRes.status === 201 && maNLRaw && maNLBtp, '[KB9] Tạo nguyên liệu thô & bán thành phẩm thành công');

    // Thiết lập Công thức Cấp 2: 1 mẻ 2000ml Cốt trà = 100g Lá trà khô (500đ/g -> tổng vốn mẻ 50.000đ -> 25đ/ml)
    const saveBtpBom = await req(`/kho/ban-thanh-pham/${encodeURIComponent(maNLBtp)}/congthuc`, {
        method: 'POST',
        token: tokenC,
        body: {
            sanLuongMeMacDinh: 2000,
            hanSuDungGio: 6,
            dinhMuc: [{ maNLThanhPhan: maNLRaw, khoiLuongTieuHao: 100 }],
        },
    });
    assert(saveBtpBom.status === 200, '[KB9] Thiết lập công thức Bán thành phẩm Cấp 2 (2000ml/mẻ, HSD 6h) thành công');

    // Chạy sản xuất 1 mẻ Bán thành phẩm
    const prodBatch = await req('/kho/san-xuat-me', {
        method: 'POST',
        token: tokenC,
        body: { maNLThanhPham: maNLBtp, soMe: 1 },
    });
    assert(
        prodBatch.status === 201 &&
            Number(prodBatch.data?.sanLuongMe) === 2000 &&
            Number(prodBatch.data?.giaVonDonViMoi) === 25 &&
            Boolean(prodBatch.data?.hanSuDungDen),
        `[KB9] Nấu/Ủ 1 mẻ Bán thành phẩm thành công: +${prodBatch.data?.sanLuongMe}ml, giá vốn WAC tự tính = ${prodBatch.data?.giaVonDonViMoi}đ/ml`
    );

    // Đánh dấu mặt hàng nhạy cảm thất thoát cao (IsKeyItem = TRUE) cho Kiểm kê nhanh 60s cuối ca
    const keyItemRes = await req(`/kho/nguyenlieu/${encodeURIComponent(maNLRaw)}/thuoctinh`, {
        method: 'PUT',
        token: tokenC,
        body: { isKeyItem: true },
    });
    assert(
        keyItemRes.status === 200 && keyItemRes.data?.isKeyItem === true,
        '[KB9] Đánh dấu mặt hàng nhạy cảm (IsKeyItem = TRUE) phục vụ Kiểm kê nhanh 60s cuối ca thành công'
    );

    // [Kịch bản 10] Granular RBAC (Ca trưởng / Shift Supervisor) & Xác thực PIN O(1) (maNVDuyet)
    const supUser = `catruong_${rand}`;
    const cashUser = `thungan_${rand}`;
    const createSup = await req('/nhansu/nhanvien', {
        method: 'POST',
        token: tokenC,
        body: {
            tenNV: 'Ca Trưởng Minh',
            tenDangNhap: supUser,
            matKhau: 'Pass123!',
            vaiTro: 4, // Thu ngân gốc
            mucLuongTheoGio: 32000,
        },
    });
    const createCash = await req('/nhansu/nhanvien', {
        method: 'POST',
        token: tokenC,
        body: {
            tenNV: 'Thu Ngân Hoa',
            tenDangNhap: cashUser,
            matKhau: 'Pass123!',
            vaiTro: 4,
            mucLuongTheoGio: 25000,
        },
    });
    const maNVSup = createSup.data?.maNV || createSup.data?.nhanVien?.maNV;
    const maNVCash = createCash.data?.maNV || createCash.data?.nhanVien?.maNV;
    assert(createSup.status === 201 && createCash.status === 201 && maNVSup && maNVCash, '[KB10] Tạo 2 nhân viên Thu ngân phục vụ kiểm thử Ca trưởng thành công');

    // Phong Ca Trưởng cho maNVSup + đặt mã PIN 2468
    const grantSup = await req(`/nhansu/nhanvien/${encodeURIComponent(maNVSup)}/quyen`, {
        method: 'PUT',
        token: tokenC,
        body: { isShiftSupervisor: true },
    });
    assert(
        grantSup.status === 200 && grantSup.data?.laCaTruong === true,
        '[KB10] Phong quyền Ca trưởng (PermissionsOverride JSONB) thành công'
    );
    const setSupPin = await req(`/nhansu/nhanvien/${encodeURIComponent(maNVSup)}/pin`, {
        method: 'PUT',
        token: tokenC,
        body: { pin: '2468' },
    });
    assert(setSupPin.status === 200, '[KB10] Đặt mã PIN 2468 cho Ca trưởng thành công');

    // Đăng nhập bằng tài khoản Thu Ngân Hoa (không có quyền Ca trưởng) và tài khoản Ca Trưởng Minh
    const loginCash = await req('/auth/login', {
        method: 'POST',
        body: { tenDangNhap: cashUser, matKhau: 'Pass123!' },
    });
    const loginSup = await req('/auth/login', {
        method: 'POST',
        body: { tenDangNhap: supUser, matKhau: 'Pass123!' },
    });
    const tokenCash = loginCash.data?.token;
    const tokenSup = loginSup.data?.token;
    assert(loginCash.status === 200 && loginSup.status === 200 && tokenCash && tokenSup, '[KB10] Đăng nhập tài khoản Thu ngân & Ca trưởng thành công');

    // Tạo đơn mở với 2 món, đánh dấu ĐÃ IN TẠM TÍNH (DaInTamTinh = TRUE)
    const ordPrebill = await req('/order', {
        method: 'POST',
        token: tokenCash,
        body: {
            maBan: null,
            danhSachMon: [
                { maMon: monC.maMon, kichThuoc: 'M', soLuong: 1 },
                { maMon: maMonPastry, kichThuoc: 'M', soLuong: 1 },
            ],
        },
    });
    const hdPreId = ordPrebill.data?.hoaDon?.maHoaDon || ordPrebill.data?.maHoaDon;
    const cthdVoidTarget = ordPrebill.data?.hoaDon?.danhSachMon?.[0]?.maCTHD;
    await req(`/hoadon/${hdPreId}/in`, { method: 'POST', token: tokenCash });

    // Thu ngân thường tự hủy món sau khi in tạm tính mà không có PIN -> BỊ CHẶN 403
    const voidNoPin = await req('/order/huy-mon', {
        method: 'POST',
        token: tokenCash,
        body: { maCTHD: cthdVoidTarget, lyDo: 'Thu ngân tự ý xóa sau in bill', hoanKho: true },
    });
    assert(voidNoPin.status === 403, `[KB10] Chặn Thu ngân thường tự ý hủy món sau khi đã in tạm tính (status=${voidNoPin.status})`);

    // Thu ngân thường hủy món có chọn Người duyệt O(1) là Ca Trưởng Minh (maNVDuyet = maNVSup) + PIN 2468 -> THÀNH CÔNG
    const voidWithSupPin = await req('/order/huy-mon', {
        method: 'POST',
        token: tokenCash,
        body: {
            maCTHD: cthdVoidTarget,
            lyDo: 'Khách đổi ý, Ca trưởng duyệt PIN O(1)',
            hoanKho: true,
            maNVDuyet: maNVSup,
            managerPin: '2468',
        },
    });
    assert(
        voidWithSupPin.status === 200,
        '[KB10] Ca trưởng duyệt PIN O(1) (maNVDuyet + managerPin) cho phép hủy món sau in tạm tính thành công'
    );

    // Ca trưởng vẫn bị CHẶN (403) khi cố truy cập Báo cáo Lãi gộp / Dashboard tài chính hoặc Tính lương của Chủ quán!
    const supTryDashboard = await req('/baocao/dashboard', { token: tokenSup });
    const supTryPayroll = await req('/nhansu/tinhluong?thang=11&nam=2026', { token: tokenSup });
    assert(
        supTryDashboard.status === 403 && supTryPayroll.status === 403,
        `[KB10] Ca trưởng bị chặn tuyệt đối (403) khỏi Báo cáo Tài chính/Lãi gộp (${supTryDashboard.status}) & Bảng lương (${supTryPayroll.status})`
    );

    // [Kịch bản 11] Cloud-to-Local Print Relay (iPad / Android Tablet chạy HTTPS -> Backend -> LAN Print Bridge) & Cô lập Multi-Tenant
    const relayDispatch = await req('/print-relay/dispatch', {
        method: 'POST',
        token: tokenCash,
        body: {
            kind: 'RECEIPT',
            payload: {
                hoaDon: { maHoaDon: hdPreId, soThuTuNgay: 1, tongTienThanhToan: 35000, danhSachMon: [] },
                tenQuan: 'Quán Pilot C',
                isCashPayment: true,
            },
        },
    });
    const relayJobId = relayDispatch.data?.job?.id;
    assert(
        relayDispatch.status === 201 && relayDispatch.data?.ok === true && relayJobId,
        '[KB11] iPad/Tablet đẩy lệnh in Bill K80 lên Cloud Print Relay (/api/print-relay/dispatch) thành công'
    );

    // Tenant B cố tình pull lệnh in của Tenant C -> Phải trả về mảng rỗng (Cô lập hàng đợi in tuyệt đối giữa các quán!)
    const pullCrossTenant = await req('/print-relay/pull', { token: tokenB });
    assert(
        pullCrossTenant.status === 200 && Array.isArray(pullCrossTenant.data?.jobs) && pullCrossTenant.data.jobs.length === 0,
        '[KB11] Cô lập Multi-Tenant: Print Bridge của Tenant B KHÔNG thể kéo trộm lệnh in của Tenant C'
    );

    // Print Bridge của Tenant C kéo outbound (/api/print-relay/pull) và xác nhận hoàn tất (/api/print-relay/ack)
    const pullOwn = await req('/print-relay/pull', { token: tokenC });
    assert(
        pullOwn.status === 200 && pullOwn.data?.jobs?.some((j) => Number(j.id) === Number(relayJobId)),
        '[KB11] Local Print Bridge của Tenant C kéo outbound lệnh in từ Cloud Print Relay thành công'
    );

    const ackRelay = await req('/print-relay/ack', {
        method: 'POST',
        token: tokenC,
        body: { jobId: relayJobId, status: 'DONE', transport: 'LAN_TCP', bytes: 512 },
    });
    const statusRelay = await req('/print-relay/status', { token: tokenC });
    assert(
        ackRelay.status === 200 && statusRelay.data?.bridgeActive === true && statusRelay.data?.pendingCount === 0,
        '[KB11] Xác nhận hoàn tất lệnh in Cloud Relay & ghi nhận trạng thái Bridge Online thành công'
    );

    // [Kịch bản 12] Phân hệ 7: Observability (/api/health + X-Request-Id), Refresh Token Rotation + Reuse Detection,
    //               Per-Tenant Staff Username (Quán A & Quán B cùng tạo được thungan_shared) & Cache KH Offline
    const healthRes = await fetch(`${API}/health`);
    const healthJson = await healthRes.json();
    const xReqId = healthRes.headers.get('x-request-id');
    assert(
        healthRes.status === 200 && healthJson.status === 'ok' && Boolean(xReqId) && healthJson.db?.ok === true,
        `[KB12] /api/health trả status=ok, db.pingMs=${healthJson.db?.pingMs}ms & header X-Request-Id=${xReqId}`
    );

    // Per-Tenant Staff Username: Cả Tenant A và Tenant B cùng tạo được tài khoản "thungan_shared_<rand>"
    const sharedStaffUser = `tn_${rand}`;
    const staffA = await req('/nhansu/nhanvien', {
        method: 'POST',
        token: tokenA,
        body: { tenNV: 'Thu ngân Shared A', tenDangNhap: sharedStaffUser, matKhau: 'Pass1234!', vaiTro: 4 },
    });
    const staffB = await req('/nhansu/nhanvien', {
        method: 'POST',
        token: tokenB,
        body: { tenNV: 'Thu ngân Shared B', tenDangNhap: sharedStaffUser, matKhau: 'Pass1234!', vaiTro: 4 },
    });
    assert(
        staffA.status === 201 && staffB.status === 201,
        `[KB12] Per-Tenant Username: Cả Tenant A và Tenant B đều tạo được "${sharedStaffUser}" không xung đột toàn cục`
    );

    // Đăng nhập không có Mã quán khi trùng tên giữa 2 quán -> trả 409 AMBIGUOUS_TENANT_LOGIN
    const ambigLogin = await req('/auth/login', {
        method: 'POST',
        body: { tenDangNhap: sharedStaffUser, matKhau: 'Pass1234!' },
    });
    assert(
        ambigLogin.status === 409 && ambigLogin.data?.code === 'AMBIGUOUS_TENANT_LOGIN',
        `[KB12] Đăng nhập trùng username đa quán yêu cầu Mã quán (status=${ambigLogin.status}, code=${ambigLogin.data?.code})`
    );

    // Đăng nhập có Mã quán (maTienTo của Tenant A) -> thành công + nhận Set-Cookie HttpOnly pos_refresh_token!
    const maTienToA = regA.data?.user?.maTienTo || regA.data?.tenant?.maTienTo;
    const loginCookieRes = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            tenDangNhap: sharedStaffUser,
            matKhau: 'Pass1234!',
            maQuan: maTienToA,
            rememberDevice: true,
        }),
    });
    const loginCookieJson = await loginCookieRes.json();
    const setCookie1 = loginCookieRes.headers.get('set-cookie') || '';
    const rawCookieMatch1 = setCookie1.match(/pos_refresh_token=([^;]+)/);
    assert(
        loginCookieRes.status === 200 && Boolean(loginCookieJson.token) && Boolean(rawCookieMatch1),
        '[KB12] Đăng nhập kèm Mã quán cấp Access Token ngắn hạn + HttpOnly Refresh Cookie thành công'
    );

    // Kiểm tra Refresh Token Rotation + Reuse Detection
    if (rawCookieMatch1) {
        const cookie1 = `pos_refresh_token=${rawCookieMatch1[1]}`;
        const ref1 = await fetch(`${API}/auth/refresh`, {
            method: 'POST',
            headers: { Cookie: cookie1 },
        });
        const ref1Json = await ref1.json();
        const setCookie2 = ref1.headers.get('set-cookie') || '';
        const rawCookieMatch2 = setCookie2.match(/pos_refresh_token=([^;]+)/);
        assert(
            ref1.status === 200 && Boolean(ref1Json.token) && Boolean(rawCookieMatch2) && rawCookieMatch2[1] !== rawCookieMatch1[1],
            '[KB12] POST /api/auth/refresh xoay vòng sang Refresh Cookie mới & cấp Access Token mới'
        );

        // Reuse Detection: phát lại cookie1 đã bị thu hồi -> bắt buộc bị chặn 401 REFRESH_TOKEN_REUSED & khóa luôn cookie2!
        const reuseRes = await fetch(`${API}/auth/refresh`, {
            method: 'POST',
            headers: { Cookie: cookie1 },
        });
        const reuseJson = await reuseRes.json();
        assert(
            reuseRes.status === 401 && reuseJson.code === 'REFRESH_TOKEN_REUSED',
            `[KB12] Reuse Detection chặn phát lại Refresh Cookie cũ (status=${reuseRes.status}, code=${reuseJson.code})`
        );

        const afterReuseRes = await fetch(`${API}/auth/refresh`, {
            method: 'POST',
            headers: { Cookie: `pos_refresh_token=${rawCookieMatch2[1]}` },
        });
        assert(
            afterReuseRes.status === 401,
            `[KB12] Toàn bộ chuỗi FamilyId đã bị thu hồi sau sự cố Reuse (cookie2 cũng bị chặn status=${afterReuseRes.status})`
        );
    }

    // Kiểm tra endpoint Cache Khách hàng Offline
    const khCacheRes = await req('/khachhang/cache', { token: tokenC });
    assert(
        khCacheRes.status === 200 && Array.isArray(khCacheRes.data?.customers) && khCacheRes.data.customers.length >= 1,
        `[KB12] GET /api/khachhang/cache trả về ${khCacheRes.data?.customers?.length || 0} khách hàng để lưu IndexedDB Offline`
    );

    console.log('\n🎉 TOÀN BỘ KIỂM THỬ BẢO MẬT MULTI-TENANT, FEATURE FLAGS, PLATFORM ADMIN & 12 KỊCH BẢN TÍCH HỢP ĐỀU ĐẠT!');
}

main().catch((err) => {
    console.error('❌ Lỗi khi chạy test bảo mật:', err.message);
    process.exit(1);
});
