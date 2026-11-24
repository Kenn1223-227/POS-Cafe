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

describe('Wave 1 Integration — QA-06 & QA-07 (VietQR fn_resolve_invoice_for_webhook & SAVEPOINT sp_vietqr_settle)', { skip: !HAS_DB ? 'Chưa cấu hình TEST_APP_RUNTIME_URL (.env.test)' : false }, () => {
    let runtimePool;
    let ownerPool;
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const tenantA = `W1_QR_${suffix}`;
    const hdVoidId = `HD_QR_VOID_${suffix}`;
    const extTxId = `SEPAY_TX_${suffix}`;

    before(async () => {
        runtimePool = createRuntimePool();
        ownerPool = createMigrationPool();
        await assertAppRuntimeNoBypassRls(runtimePool);

        await ownerPool.query(
            `INSERT INTO Tenants (TenantId, MaTienTo, TenQuan, Slug, GoiCuoc, TrangThai, ThongTinNganHang)
             VALUES ($1, $2, 'Test VietQR Cafe', $3, 'PRO', 'ACTIVE', '{"bankId":"VCB","accountNo":"0123456789"}'::jsonb)
             ON CONFLICT (TenantId) DO NOTHING`,
            [tenantA, `QR${suffix}`, `qr-${suffix.toLowerCase()}`]
        );
        await withTenantTx(runtimePool, tenantA, async (client) => {
            await client.query(
                `INSERT INTO HoaDon (MaHoaDon, TenantId, TrangThaiTT, lifecycle_status, TongTienThanhToan)
                 VALUES ($1, $2, 0, 'VOIDED', 75000)`,
                [hdVoidId, tenantA]
            );
        });
    });

    after(async () => {
        if (ownerPool) {
            await ownerPool.query(`DELETE FROM VietQR_Webhook_Events WHERE MaGiaoDichNgoai = $1`, [extTxId]).catch(() => {});
            await ownerPool.query(`DELETE FROM HoaDon WHERE TenantId = $1`, [tenantA]).catch(() => {});
            await ownerPool.query(`DELETE FROM Tenants WHERE TenantId = $1`, [tenantA]).catch(() => {});
            await ownerPool.end();
        }
        if (runtimePool) await runtimePool.end();
    });

    it('QA-06: fn_resolve_invoice_for_webhook chạy dưới app_runtime (NOBYPASSRLS) trả đúng tenant_id & bank_account_no', async () => {
        const res = await runtimePool.query(
            `SELECT * FROM public.fn_resolve_invoice_for_webhook($1::varchar)`,
            [hdVoidId]
        );
        assert.equal(res.rows.length, 1);
        assert.equal(res.rows[0].tenant_id, tenantA);
        assert.equal(res.rows[0].lifecycle_status, 'VOIDED');
        assert.equal(res.rows[0].bank_account_no, '0123456789');
    });

    it('QA-06: SAVEPOINT sp_vietqr_settle rollback lỗi khi đơn VOIDED nhưng VẪN COMMIT vietqr_webhook_events với PENDING_ACTION', async () => {
        await withTenantTx(runtimePool, tenantA, async (client) => {
            await client.query(
                `INSERT INTO VietQR_Webhook_Events (NhaCungCap, MaGiaoDichNgoai, SoTien, NoiDungCK, TrangThaiXuLy, MaHoaDonKhop, TenantId)
                 VALUES ('SEPAY', $1, 75000, $2, 'PROCESSING', $3, $4)`,
                [extTxId, `POSHD${hdVoidId}`, hdVoidId, tenantA]
            );
            await client.query('SAVEPOINT sp_vietqr_settle');
            try {
                // Cố tình chuyển VOIDED -> PAID để trigger FSM báo lỗi
                await client.query(`UPDATE HoaDon SET TrangThaiTT = 1, lifecycle_status = 'PAID' WHERE MaHoaDon = $1`, [hdVoidId]);
                await client.query('RELEASE SAVEPOINT sp_vietqr_settle');
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_vietqr_settle');
                await client.query(
                    `UPDATE VietQR_Webhook_Events SET TrangThaiXuLy = 'PENDING_ACTION' WHERE MaGiaoDichNgoai = $1`,
                    [extTxId]
                );
            }
        });

        const verify = await withTenantTx(runtimePool, tenantA, async (client) => {
            const r = await client.query(
                `SELECT TrangThaiXuLy, MaHoaDonKhop FROM VietQR_Webhook_Events WHERE MaGiaoDichNgoai = $1`,
                [extTxId]
            );
            return r.rows[0];
        });
        assert.equal(verify?.trangthaixuly, 'PENDING_ACTION');
        assert.equal(verify?.mahoadonkhop, hdVoidId);
    });
});
