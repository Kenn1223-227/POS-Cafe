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
const { capSoThuTuNgayKhongTrung, kiemTraVaTangVersionHoaDon } = require('../../modules/fohEngineService');

const HAS_DB = Boolean(getRuntimeConnectionString());

class TestLoiNghiepVu extends Error {
    constructor(status, message, details = null) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

describe('Wave 1 Integration — QA-03, QA-04, QA-05 (Dual FSM, Optimistic Locking, Branch Counter, Combo PK)', { skip: !HAS_DB ? 'Chưa cấu hình TEST_APP_RUNTIME_URL (.env.test)' : false }, () => {
    let runtimePool;
    let ownerPool;
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const tenantA = `W1_TA_${suffix}`;
    const tenantB = `W1_TB_${suffix}`;
    const hdVoidId = `HD_VOID_${suffix}`;
    const hdPaidId = `HD_PAID_${suffix}`;
    const hdRaceId = `HD_RACE_${suffix}`;

    before(async () => {
        runtimePool = createRuntimePool();
        ownerPool = createMigrationPool();
        await assertAppRuntimeNoBypassRls(runtimePool);

        await ownerPool.query(
            `INSERT INTO Tenants (TenantId, MaTienTo, TenQuan, Slug, GoiCuoc, TrangThai)
             VALUES ($1, $2, 'Test Tenant A', $3, 'PRO', 'ACTIVE'),
                    ($4, $5, 'Test Tenant B', $6, 'PRO', 'ACTIVE')
             ON CONFLICT (TenantId) DO NOTHING`,
            [tenantA, `QA${suffix}`, `ta-${suffix.toLowerCase()}`, tenantB, `QB${suffix}`, `tb-${suffix.toLowerCase()}`]
        );
    });

    after(async () => {
        if (ownerPool) {
            await ownerPool.query(`DELETE FROM HoaDon WHERE TenantId IN ($1, $2)`, [tenantA, tenantB]).catch(() => {});
            await ownerPool.query(`DELETE FROM public.combo WHERE tenantid IN ($1, $2)`, [tenantA, tenantB]).catch(() => {});
            await ownerPool.query(`DELETE FROM public.branch_daily_counter WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]).catch(() => {});
            await ownerPool.query(`DELETE FROM Tenants WHERE TenantId IN ($1, $2)`, [tenantA, tenantB]).catch(() => {});
            await ownerPool.end();
        }
        if (runtimePool) await runtimePool.end();
    });

    it('QA-04: Trigger trg_guard_hoadon_fsm chặn mở lại đơn VOIDED và chặn quay ngược đơn PAID về OPEN', async () => {
        await withTenantTx(runtimePool, tenantA, async (client) => {
            await client.query(
                `INSERT INTO HoaDon (MaHoaDon, TenantId, TrangThaiTT, lifecycle_status)
                 VALUES ($1, $2, 0, 'VOIDED'), ($3, $2, 1, 'PAID')`,
                [hdVoidId, tenantA, hdPaidId]
            );
        });

        await assert.rejects(
            () =>
                withTenantTx(runtimePool, tenantA, async (client) => {
                    await client.query(`UPDATE HoaDon SET lifecycle_status = 'OPEN' WHERE MaHoaDon = $1`, [hdVoidId]);
                }),
            /FSM_VIOLATION/
        );

        await assert.rejects(
            () =>
                withTenantTx(runtimePool, tenantA, async (client) => {
                    await client.query(`UPDATE HoaDon SET lifecycle_status = 'OPEN' WHERE MaHoaDon = $1`, [hdPaidId]);
                }),
            /FSM_VIOLATION/
        );
    });

    it('QA-03: Race condition Promise.all với cùng expectedVersion=1 -> đúng 1 thành công, 1 bị 409 ORDER_CONCURRENT_MODIFIED', async () => {
        await withTenantTx(runtimePool, tenantA, async (client) => {
            await client.query(
                `INSERT INTO HoaDon (MaHoaDon, TenantId, TrangThaiTT, lifecycle_status, Version)
                 VALUES ($1, $2, 0, 'OPEN', 1)`,
                [hdRaceId, tenantA]
            );
        });

        const runAttempt = () =>
            withTenantTx(runtimePool, tenantA, async (client) => {
                return kiemTraVaTangVersionHoaDon(client, {
                    maHoaDon: hdRaceId,
                    tenantId: tenantA,
                    expectedVersion: 1,
                    LoiNghiepVu: TestLoiNghiepVu,
                });
            });

        const results = await Promise.allSettled([runAttempt(), runAttempt()]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        assert.equal(fulfilled.length, 1, 'Phải có đúng 1 giao dịch thắng khóa lạc quan');
        assert.equal(rejected.length, 1, 'Phải có đúng 1 giao dịch bị chặn 409');
        assert.equal(rejected[0].reason.status, 409);
        assert.equal(rejected[0].reason.details?.code, 'ORDER_CONCURRENT_MODIFIED');
    });

    it('P0-01: branch_daily_counter cấp số thứ tự độc lập theo chi nhánh & Combo PK (tenantid, macombo) cho phép trùng mã giữa 2 tenant', async () => {
        const [seqCn1, seqCn2] = await withTenantTx(runtimePool, tenantA, async (client) => {
            const c1 = await capSoThuTuNgayKhongTrung(client, tenantA, 'CN_1');
            const c2 = await capSoThuTuNgayKhongTrung(client, tenantA, 'CN_2');
            return [c1.seq, c2.seq];
        });
        assert.equal(seqCn1, 1);
        assert.equal(seqCn2, 1);

        await withTenantTx(runtimePool, tenantA, async (client) => {
            await client.query(
                `INSERT INTO public.combo (tenantid, macombo, tencombo, giabancombo) VALUES ($1, 'CB_SANG', 'Combo Sang A', 49000)`,
                [tenantA]
            );
        });
        await withTenantTx(runtimePool, tenantB, async (client) => {
            await client.query(
                `INSERT INTO public.combo (tenantid, macombo, tencombo, giabancombo) VALUES ($1, 'CB_SANG', 'Combo Sang B', 55000)`,
                [tenantB]
            );
        });
    });
});
