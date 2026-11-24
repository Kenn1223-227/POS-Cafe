const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
    getRuntimeConnectionString,
    createRuntimePool,
    createMigrationPool,
    assertAppRuntimeNoBypassRls,
    withTenantTx,
} = require('../helpers/dbHarness');

const HAS_DB = Boolean(getRuntimeConnectionString());

describe('Wave 1 Integration — QA-13 (Super Admin SECURITY DEFINER dưới app_runtime NOBYPASSRLS & Tenant Isolation)', { skip: !HAS_DB ? 'Chưa cấu hình TEST_APP_RUNTIME_URL (.env.test)' : false }, () => {
    let runtimePool;
    let ownerPool;
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const tenantA = `W1_PA_${suffix}`;
    const tenantB = `W1_PB_${suffix}`;
    const maDonSub = `SUB_W1_${suffix}`;
    const hdB = `HD_PB_${suffix}`;
    const nvB = `NV_PB_${suffix}`;

    before(async () => {
        runtimePool = createRuntimePool();
        ownerPool = createMigrationPool();
        await assertAppRuntimeNoBypassRls(runtimePool);

        await ownerPool.query(
            `INSERT INTO Tenants (TenantId, MaTienTo, TenQuan, Slug, GoiCuoc, TrangThai)
             VALUES ($1, $2, 'Tenant A Isolation', $3, 'PRO', 'ACTIVE'),
                    ($4, $5, 'Tenant B Billing', $6, 'STARTER', 'TRIAL')
             ON CONFLICT (TenantId) DO NOTHING`,
            [tenantA, `PA${suffix}`, `pa-${suffix.toLowerCase()}`, tenantB, `PB${suffix}`, `pb-${suffix.toLowerCase()}`]
        );
        await ownerPool.query(
            `INSERT INTO NhanVien (MaNV, TenNV, TenDangNhap, MatKhauHash, VaiTro, TrangThaiLamViec, TenantId)
             VALUES ($1, 'Chu Quan B', $2, 'scrypt$fake', 1, TRUE, $3)`,
            [nvB, `ownerb_${suffix.toLowerCase()}`, tenantB]
        );
        await withTenantTx(runtimePool, tenantB, async (client) => {
            await client.query(
                `INSERT INTO HoaDon (MaHoaDon, TenantId, TrangThaiTT, lifecycle_status, TongTienThanhToan)
                 VALUES ($1, $2, 1, 'PAID', 120000)`,
                [hdB, tenantB]
            );
        });
        await ownerPool.query(
            `INSERT INTO Tenant_Billing_Orders (MaDonThanhToan, TenantId, GoiCuoc, SoThang, SoTien, TrangThai)
             VALUES ($1, $2, 'PRO', 3, 1497000, 'PENDING')`,
            [maDonSub, tenantB]
        );
    });

    after(async () => {
        if (ownerPool) {
            await ownerPool.query(`DELETE FROM Audit_Logs WHERE TenantId IN ($1, $2)`, [tenantA, tenantB]).catch(() => {});
            await ownerPool.query(`DELETE FROM Tenant_Billing_Orders WHERE MaDonThanhToan = $1`, [maDonSub]).catch(() => {});
            await ownerPool.query(`DELETE FROM HoaDon WHERE TenantId IN ($1, $2)`, [tenantA, tenantB]).catch(() => {});
            await ownerPool.query(`DELETE FROM NhanVien WHERE TenantId IN ($1, $2)`, [tenantA, tenantB]).catch(() => {});
            await ownerPool.query(`DELETE FROM Tenants WHERE TenantId IN ($1, $2)`, [tenantA, tenantB]).catch(() => {});
            await ownerPool.end();
        }
        if (runtimePool) await runtimePool.end();
    });

    it('QA-13: Tenant A không thể đọc dữ liệu của Tenant B dưới FORCE RLS', async () => {
        const leakRows = await withTenantTx(runtimePool, tenantA, async (client) => {
            const r = await client.query(`SELECT MaHoaDon FROM HoaDon WHERE MaHoaDon = $1`, [hdB]);
            return r.rows;
        });
        assert.equal(leakRows.length, 0, 'Tenant A tuyệt đối không được thấy hóa đơn của Tenant B');
    });

    it('QA-13: Super Admin RPCs dưới app_runtime đọc được KPI thật > 0, duyệt gói Tenant B và Impersonate có ghi Audit_Logs', async () => {
        const ovRes = await runtimePool.query('SELECT * FROM public.fn_platform_overview_tenants()');
        const rowB = ovRes.rows.find((r) => r.tenantid === tenantB);
        assert.ok(rowB, 'fn_platform_overview_tenants phải thấy Tenant B dưới NOBYPASSRLS');
        assert.ok(Number(rowB.so_don) >= 1, 'KPI so_don của Tenant B phải >= 1');

        const approveRes = await runtimePool.query(
            `SELECT * FROM public.fn_platform_manual_approve_billing($1, $2, $3, $4::jsonb, $5, $6)`,
            [maDonSub, `FT_BANK_${suffix}`, 'Test duyet goi Wave 1', '{"inventory_bom":true}', 'superadmin_test', '127.0.0.1']
        );
        assert.equal(approveRes.rows[0]?.status, 'APPROVED');
        assert.equal(approveRes.rows[0]?.target_tenant_id, tenantB);

        const impRes = await runtimePool.query(
            `SELECT * FROM public.fn_platform_impersonate_prepare($1, $2, $3, now() + interval '15 minutes', $4)`,
            [tenantB, 'superadmin_test', 'Kiem thu Impersonate Wave 1', '127.0.0.1']
        );
        assert.equal(impRes.rows[0]?.status, 'OK');
        assert.equal(impRes.rows[0]?.manv, nvB);

        const auditRows = await withTenantTx(runtimePool, tenantB, async (client) => {
            const r = await client.query(
                `SELECT HanhDong FROM Audit_Logs WHERE TenantId = $1 ORDER BY Id ASC`,
                [tenantB]
            );
            return r.rows.map((x) => x.hanhdong);
        });
        assert.ok(auditRows.includes('PLATFORM_BILLING_APPROVED'), 'Phải ghi Audit_Logs PLATFORM_BILLING_APPROVED');
        assert.ok(auditRows.includes('PLATFORM_IMPERSONATION_STARTED'), 'Phải ghi Audit_Logs PLATFORM_IMPERSONATION_STARTED');
    });
});
