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

describe('Wave 1 Integration — QA-08 & QA-11 (Chống chấm công trùng ca song song & Lương NV đã khóa)', { skip: !HAS_DB ? 'Chưa cấu hình TEST_APP_RUNTIME_URL (.env.test)' : false }, () => {
    let runtimePool;
    let ownerPool;
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const tenantA = `W1_HR_${suffix}`;
    const maNV = `NV_HR_${suffix}`;
    const maCa = `CA_HR_${suffix}`;
    let maPhanCa = null;

    before(async () => {
        runtimePool = createRuntimePool();
        ownerPool = createMigrationPool();
        await assertAppRuntimeNoBypassRls(runtimePool);

        await ownerPool.query(
            `INSERT INTO Tenants (TenantId, MaTienTo, TenQuan, Slug, GoiCuoc, TrangThai)
             VALUES ($1, $2, 'Test HR Cafe', $3, 'PRO', 'ACTIVE')
             ON CONFLICT (TenantId) DO NOTHING`,
            [tenantA, `HR${suffix}`, `hr-${suffix.toLowerCase()}`]
        );
        await ownerPool.query(
            `INSERT INTO NhanVien (MaNV, TenNV, TenDangNhap, MatKhauHash, VaiTro, TrangThaiLamViec, TenantId)
             VALUES ($1, 'Nhan Vien Test', $2, 'scrypt$fake', 4, TRUE, $3)`,
            [maNV, `hr_${suffix.toLowerCase()}`, tenantA]
        );
        await ownerPool.query(
            `INSERT INTO CaLamViec (MaCa, TenCa, GioBatDau, GioKetThuc, TenantId)
             VALUES ($1, 'Ca Sang', '07:00', '15:00', $2)
             ON CONFLICT DO NOTHING`,
            [maCa, tenantA]
        );
        const pcRes = await withTenantTx(runtimePool, tenantA, async (client) => {
            return client.query(
                `INSERT INTO PhanCa (MaNV, MaCa, NgayLam, TrangThai, TenantId)
                 VALUES ($1, $2, CURRENT_DATE, 1, $3)
                 RETURNING MaPhanCa`,
                [maNV, maCa, tenantA]
            );
        });
        maPhanCa = pcRes.rows[0].maphanca;
    });

    after(async () => {
        if (ownerPool) {
            await ownerPool.query(`DELETE FROM ChamCong WHERE MaPhanCa = $1`, [maPhanCa]).catch(() => {});
            await ownerPool.query(`DELETE FROM PhanCa WHERE TenantId = $1`, [tenantA]).catch(() => {});
            await ownerPool.query(`DELETE FROM CaLamViec WHERE TenantId = $1`, [tenantA]).catch(() => {});
            await ownerPool.query(`DELETE FROM NhanVien WHERE TenantId = $1`, [tenantA]).catch(() => {});
            await ownerPool.query(`DELETE FROM Tenants WHERE TenantId = $1`, [tenantA]).catch(() => {});
            await ownerPool.end();
        }
        if (runtimePool) await runtimePool.end();
    });

    it('QA-11: 3 lệnh chấm công song song cùng MaPhanCa -> đúng 1 thành công, 2 bị chặn unique 23505', async () => {
        const doCheckIn = () =>
            withTenantTx(runtimePool, tenantA, async (client) => {
                const r = await client.query(
                    `INSERT INTO ChamCong (MaPhanCa, ThoiGianCheckIn, GhiChu)
                     VALUES ($1, CURRENT_TIMESTAMP, 'Đúng giờ')
                     RETURNING MaChamCong`,
                    [maPhanCa]
                );
                return r.rows[0];
            });

        const results = await Promise.allSettled([doCheckIn(), doCheckIn(), doCheckIn()]);
        const ok = results.filter((r) => r.status === 'fulfilled');
        const dup = results.filter((r) => r.status === 'rejected' && r.reason?.code === '23505');
        assert.equal(ok.length, 1, 'Chỉ duy nhất 1 lượt check-in được phép thành công');
        assert.equal(dup.length, 2, '2 lượt check-in trùng phải bị unique index uq_chamcong_single_per_phanca chặn với mã 23505');
    });
});
