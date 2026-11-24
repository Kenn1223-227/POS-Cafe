const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const {
    getRuntimeConnectionString,
    createRuntimePool,
    createMigrationPool,
    assertAppRuntimeNoBypassRls,
    withTenantTx,
} = require('../helpers/dbHarness');
const {
    acquireIdempotencyLock,
    completeIdempotencyLock,
} = require('../../modules/kdsPhase2Engine');
const {
    recordCogsAdjustment,
    computeShiftAvtReport,
    normalizeInventoryBranch,
} = require('../../modules/inventoryCogsPhase4Engine');

const HAS_DB = Boolean(getRuntimeConnectionString());

describe(
    'Wave 2 Integration — TC-W2-01 (Idempotency Lease 60s), TC-W2-02 (P&L & Shift AvT), TC-W2-03 (COGS Journal RLS & Payout)',
    { skip: !HAS_DB ? 'Chưa cấu hình TEST_APP_RUNTIME_URL (.env.test)' : false },
    () => {
        let runtimePool;
        let migrationPool;

        after(async () => {
            if (runtimePool) await runtimePool.end();
            if (migrationPool) await migrationPool.end();
        });

        it('TC-W2-01 (QA-02): Composite PK (tenantid, khoaidem), chặn đúp Idempotency-Key & tự thu hồi zombie lease > 60s', async () => {
            runtimePool = createRuntimePool();
            migrationPool = createMigrationPool();
            await assertAppRuntimeNoBypassRls(runtimePool);

            // Kiểm tra PK composite (tenantid, khoaidem) từ Migration 030
            const pkRes = await runtimePool.query(`
                SELECT string_agg(a.attname, ',' ORDER BY k.ord) AS pk_cols
                  FROM pg_constraint c
                  JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                 WHERE c.conrelid = 'public.donhang_idempotency'::regclass
                   AND c.contype = 'p'
            `);
            assert.equal(pkRes.rows[0]?.pk_cols, 'tenantid,khoaidem');

            const tenantId = `W2_IDEM_${Date.now()}`;
            const key = `IDEM-PAY-${Date.now()}`;
            const poolAdapter = {
                withTenant: (tId, fn) => withTenantTx(runtimePool, tId, fn),
            };

            // 1. Request #1 chiếm khóa thành công
            const lock1 = await acquireIdempotencyLock(poolAdapter, {
                tenantId,
                khoaIdem: key,
                maNV: 'NV01',
                dauVanTay: 'fp-pay-1',
            });
            assert.equal(lock1.acquired, true);

            // 2. Request #2 gửi trùng key khi lease còn hạn -> bị chặn IN_FLIGHT
            const lock2 = await acquireIdempotencyLock(poolAdapter, {
                tenantId,
                khoaIdem: key,
                maNV: 'NV01',
                dauVanTay: 'fp-pay-1',
            });
            assert.equal(lock2.acquired, false);
            assert.equal(lock2.state, 'IN_FLIGHT');

            // 3. Mô phỏng crash để lại zombie PROCESSING với lease_expires_at < now() - 61s
            await withTenantTx(runtimePool, tenantId, async (client) => {
                await client.query(
                    `UPDATE public.donhang_idempotency
                        SET lease_expires_at = now() - interval '61 seconds'
                      WHERE tenantid = $1 AND khoaidem = $2`,
                    [tenantId, key]
                );
            });

            // 4. Retry cùng key -> tự thu hồi zombie lease thành công!
            const lockReclaimed = await acquireIdempotencyLock(poolAdapter, {
                tenantId,
                khoaIdem: key,
                maNV: 'NV01',
                dauVanTay: 'fp-pay-1',
            });
            assert.equal(lockReclaimed.acquired, true);

            // 5. Complete khóa -> gửi lại lần nữa trả DONE kèm đúng 1 kết quả
            await completeIdempotencyLock(poolAdapter, {
                tenantId,
                khoaIdem: key,
                maHoaDon: 'HD-W2-01',
                responseJson: { ok: true, maHoaDon: 'HD-W2-01' },
                httpStatus: 200,
            });
            const lockDone = await acquireIdempotencyLock(poolAdapter, {
                tenantId,
                khoaIdem: key,
                maNV: 'NV01',
                dauVanTay: 'fp-pay-1',
            });
            assert.equal(lockDone.acquired, false);
            assert.equal(lockDone.state, 'DONE');
            assert.equal(lockDone.record?.maHoaDon, 'HD-W2-01');
        });

        it('TC-W2-02 (QA-09) & TC-W2-03 (QA-07): cogs_adjustment_journal FORCE RLS, P&L 100% & Shift AvT không báo thất thoát oan khi Transfer Out', async () => {
            if (!runtimePool) runtimePool = createRuntimePool();
            const rlsRes = await runtimePool.query(`
                SELECT relrowsecurity, relforcerowsecurity
                  FROM pg_class
                 WHERE oid = 'public.cogs_adjustment_journal'::regclass
            `);
            assert.equal(rlsRes.rows[0]?.relrowsecurity, true, 'cogs_adjustment_journal phải bật ENABLE RLS');
            assert.equal(rlsRes.rows[0]?.relforcerowsecurity, true, 'cogs_adjustment_journal phải bật FORCE RLS');

            const tenantA = `W2_PNL_A_${Date.now()}`;
            const tenantB = `W2_PNL_B_${Date.now()}`;
            const branchA = normalizeInventoryBranch(tenantA);
            const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

            // Ghi bút toán COGS adjustment +10.000đ ở Tenant A
            await withTenantTx(runtimePool, tenantA, async (client) => {
                const inserted = await recordCogsAdjustment(client, {
                    tenantId: tenantA,
                    branchId: branchA,
                    businessDate: today,
                    maNL: 'NL_CAFE_W2',
                    sourceType: 'NEGATIVE_STOCK_CATCHUP',
                    refMaGiaoDich: 'GD-W2-1',
                    qtyAffected: 100,
                    oldUnitCost: 200,
                    newUnitCost: 300,
                    adjustmentAmount: 10000,
                    createdBy: 'NV_TEST',
                });
                assert.ok(inserted?.id);
                assert.equal(Number(inserted.adjustment_amount), 10000);
            });

            // Tenant B KHÔNG thể đọc thấy dòng của Tenant A (FORCE RLS under app_runtime NOBYPASSRLS)
            await withTenantTx(runtimePool, tenantB, async (client) => {
                const leakRes = await client.query(`SELECT COUNT(*)::int AS cnt FROM public.cogs_adjustment_journal`);
                assert.equal(leakRes.rows[0].cnt, 0, 'Vi phạm RLS: Tenant B đọc được cogs_adjustment_journal của Tenant A!');
            });

            // Kiểm tra công thức Shift AvT khi có TRANSFER_OUT (LoaiGD = 4) giữa ca
            // Mock client tối giản kiểm chứng phương trình actualUsage = tonDauCa + nhap + transferIn - transferOut - daoNhap - tonCuoiCa
            const fakeClient = {
                query: async (sql) => {
                    if (sql.includes('FROM public.cathungan')) {
                        return {
                            rows: [{
                                macathungan: 'CA-W2-1',
                                manv: 'NV01',
                                tennv: 'Thu Ngân A',
                                thoigianmoca: new Date(Date.now() - 3600000).toISOString(),
                                thoigiandongca: null,
                                branchid: branchA,
                            }],
                        };
                    }
                    if (sql.includes('FROM public.chotton_ca')) {
                        return {
                            rows: [{
                                manl: 'NL_SUA',
                                tennl: 'Sữa tươi',
                                donvitinh: 'ml',
                                iskeyitem: true,
                                tondauca: 1000,
                                toncuoica: 500,
                                tonhientai: 500,
                                giavon: 35,
                            }],
                        };
                    }
                    return {
                        rows: [
                            { manl: 'NL_SUA', loaigd: 4, malydohuy: 'KHAC', tong_sl: 300 }, // TRANSFER_OUT cứu chi nhánh
                            { manl: 'NL_SUA', loaigd: 6, malydohuy: 'KHAC', tong_sl: 200 }, // Bán hàng
                        ],
                    };
                },
            };

            const avt = await computeShiftAvtReport(fakeClient, {
                tenantId: tenantA,
                branchId: branchA,
                maCaThuNgan: 'CA-W2-1',
            });
            assert.equal(avt.items.length, 1);
            assert.equal(avt.items[0].transferOutTrongCa, 300);
            assert.equal(avt.items[0].actualUsage, 200);
            assert.equal(avt.items[0].theoreticalUsage, 200);
            assert.equal(avt.items[0].unexplainedVariance, 0);
            assert.equal(avt.items[0].isAlert, false);
        });
    }
);
