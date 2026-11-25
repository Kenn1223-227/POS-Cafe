'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
    createRuntimePool,
    createMigrationPool,
    assertAppRuntimeNoBypassRls,
    withTenantTx,
} = require('../helpers/dbHarness');
const { chayTruyVanBaoCao } = require('../../db');
const {
    refreshDailyBranchFinancialSummary,
    getDailyBranchFinancialSummary,
} = require('../../src/domains/reports/businessDaySummaryService');

describe('Wave 4B Integration [Tầng 2] — Business Day 04:00, Materialized Summary, FORCE RLS & Read-Replica Guard', () => {
    let runtimePool;
    let migrationPool;
    const suffix = Date.now().toString().slice(-6);
    const tenantA = `W4B_TA_${suffix}`;
    const tenantB = `W4B_TB_${suffix}`;
    const branchId = 'CN01';
    const orderIds = [
        `HD_W4B_${suffix}_1`,
        `HD_W4B_${suffix}_2`,
        `HD_W4B_${suffix}_3`,
    ];

    before(async () => {
        runtimePool = createRuntimePool();
        migrationPool = createMigrationPool();

        // Kiểm chứng app_runtime NOBYPASSRLS và migration 038 đã áp dụng
        const roleRow = await assertAppRuntimeNoBypassRls(runtimePool);
        assert.equal(roleRow.rolbypassrls, false);

        const migRes = await migrationPool.query(
            `SELECT version FROM public.schema_migrations WHERE version = '038'`
        );
        assert.equal(migRes.rows.length, 1, 'Migration 038 phải đã được áp dụng trong public.schema_migrations');

        // Seed 3 hóa đơn đã thanh toán cho Tenant A / CN01 tại 3 mốc quanh cutoff 04:00
        await withTenantTx(runtimePool, tenantA, async (client) => {
            // Đơn 1: 2026-11-24 23:30+07 -> thuộc ngày kinh doanh 2026-11-24
            await client.query(
                `INSERT INTO public.hoadon (
                    mahoadon, tenantid, branchid,
                    tongtien, giamgia, thanhtien, tongtienthanhtoan, dathanhtoan,
                    tienthuevat, tienphiphucvu, phuongthuctt, trangthaitt, lifecycle_status,
                    thoigiantao, thoigianthanhtoan
                 ) VALUES (
                    $1, $2, $3,
                    100000, 0, 100000, 108000, 108000,
                    8000, 0, 'TIEN_MAT', 1, 'PAID',
                    '2026-11-24T23:25:00+07:00'::timestamptz,
                    '2026-11-24T23:30:00+07:00'::timestamptz
                 )`,
                [orderIds[0], tenantA, branchId]
            );

            // Đơn 2: 2026-11-25 02:15+07 (bán khuya trước 04:00) -> vẫn thuộc ngày kinh doanh 2026-11-24
            await client.query(
                `INSERT INTO public.hoadon (
                    mahoadon, tenantid, branchid,
                    tongtien, giamgia, thanhtien, tongtienthanhtoan, dathanhtoan,
                    tienthuevat, tienphiphucvu, phuongthuctt, trangthaitt, lifecycle_status,
                    thoigiantao, thoigianthanhtoan
                 ) VALUES (
                    $1, $2, $3,
                    200000, 10000, 190000, 205200, 205200,
                    15200, 0, 'CHUYEN_KHOAN', 1, 'PAID',
                    '2026-11-25T02:10:00+07:00'::timestamptz,
                    '2026-11-25T02:15:00+07:00'::timestamptz
                 )`,
                [orderIds[1], tenantA, branchId]
            );

            // Đơn 3: 2026-11-25 04:10+07 (sau 04:00) -> thuộc ngày kinh doanh 2026-11-25
            await client.query(
                `INSERT INTO public.hoadon (
                    mahoadon, tenantid, branchid,
                    tongtien, giamgia, thanhtien, tongtienthanhtoan, dathanhtoan,
                    tienthuevat, tienphiphucvu, phuongthuctt, trangthaitt, lifecycle_status,
                    thoigiantao, thoigianthanhtoan
                 ) VALUES (
                    $1, $2, $3,
                    50000, 0, 50000, 54000, 54000,
                    4000, 0, 'TIEN_MAT', 1, 'PAID',
                    '2026-11-25T04:05:00+07:00'::timestamptz,
                    '2026-11-25T04:10:00+07:00'::timestamptz
                 )`,
                [orderIds[2], tenantA, branchId]
            );
        });
    });

    after(async () => {
        if (runtimePool) {
            await withTenantTx(runtimePool, tenantA, async (client) => {
                await client.query(
                    `DELETE FROM public.daily_branch_financial_summary WHERE tenant_id = $1`,
                    [tenantA]
                );
                await client.query(
                    `DELETE FROM public.hoadon WHERE mahoadon = ANY($1::varchar[])`,
                    [orderIds]
                );
            }).catch(() => {});
            await runtimePool.end().catch(() => {});
        }
        if (migrationPool) {
            await migrationPool.end().catch(() => {});
        }
    });

    it('PostgreSQL fn_compute_business_date chạy đúng dưới app_runtime với mốc cutoff 04:00', async () => {
        const res = await runtimePool.query(
            `SELECT
                TO_CHAR(public.fn_compute_business_date('2026-11-25T02:15:00+07:00'::timestamptz, 4, 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD') AS d_late_night,
                TO_CHAR(public.fn_compute_business_date('2026-11-25T04:00:00+07:00'::timestamptz, 4, 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD') AS d_new_day`
        );
        assert.equal(res.rows[0].d_late_night, '2026-11-24');
        assert.equal(res.rows[0].d_new_day, '2026-11-25');
    });

    it('TC-W4B-01: Business Day Cutoff 04:00 gom đúng 2 đơn đầu vào 2026-11-24 và 1 đơn sau vào 2026-11-25', async () => {
        const sum24 = await withTenantTx(runtimePool, tenantA, (client) =>
            refreshDailyBranchFinancialSummary(client, {
                tenantId: tenantA,
                branchId,
                businessDate: '2026-11-24',
                cutoffHour: 4,
            })
        );

        const sum25 = await withTenantTx(runtimePool, tenantA, (client) =>
            refreshDailyBranchFinancialSummary(client, {
                tenantId: tenantA,
                branchId,
                businessDate: '2026-11-25',
                cutoffHour: 4,
            })
        );

        // 2026-11-24 = Đơn 1 (108,000; tax 8,000) + Đơn 2 (205,200; tax 15,200)
        assert.equal(sum24.businessDate, '2026-11-24');
        assert.equal(sum24.ordersCount, 2);
        assert.equal(sum24.paidOrdersCount, 2);
        assert.equal(sum24.netSales, 313200);
        assert.equal(sum24.taxTotal, 23200);
        assert.equal(sum24.discountTotal, 10000);

        // 2026-11-25 = Đơn 3 (54,000; tax 4,000)
        assert.equal(sum25.businessDate, '2026-11-25');
        assert.equal(sum25.ordersCount, 1);
        assert.equal(sum25.paidOrdersCount, 1);
        assert.equal(sum25.netSales, 54000);
        assert.equal(sum25.taxTotal, 4000);
    });

    it('TC-W4B-02: FORCE RLS cô lập tuyệt đối daily_branch_financial_summary — Tenant B đọc nhận 0 dòng của Tenant A', async () => {
        const rowsForTenantB = await withTenantTx(runtimePool, tenantB, async (client) => {
            const r = await client.query(
                `SELECT * FROM public.daily_branch_financial_summary WHERE tenant_id = $1`,
                [tenantA]
            );
            return r.rows;
        });
        assert.equal(rowsForTenantB.length, 0, 'Tenant B tuyệt đối không được thấy dữ liệu tài chính của Tenant A');

        // Đọc tổng quát không truyền WHERE tenant_id cũng phải nhận 0 dòng của Tenant A
        const allVisibleToB = await withTenantTx(runtimePool, tenantB, async (client) => {
            const r = await client.query(`SELECT tenant_id FROM public.daily_branch_financial_summary`);
            return r.rows.filter((x) => x.tenant_id === tenantA);
        });
        assert.equal(allVisibleToB.length, 0);
    });

    it('TC-W4B-03: chayTruyVanBaoCao đọc thành công trong READ ONLY tx và PostgreSQL từ chối INSERT/UPDATE bằng mã lỗi 25006', async () => {
        // 1. Đọc thành công qua chayTruyVanBaoCao (BEGIN TRANSACTION READ ONLY + SET LOCAL tenant)
        const report = await chayTruyVanBaoCao(
            tenantA,
            (client) =>
                getDailyBranchFinancialSummary(client, {
                    tenantId: tenantA,
                    branchId,
                    fromDate: '2026-11-24',
                    toDate: '2026-11-25',
                }),
            runtimePool
        );
        assert.equal(report.rows.length, 2);
        assert.equal(report.totals.ordersCount, 3);
        assert.equal(report.totals.netSales, 367200);
        assert.equal(report.totals.taxTotal, 27200);

        // 2. Thử thực thi INSERT bên trong chayTruyVanBaoCao -> BẮT BUỘC thất bại với PG error code 25006
        await assert.rejects(
            () =>
                chayTruyVanBaoCao(
                    tenantA,
                    (client) =>
                        client.query(
                            `INSERT INTO public.daily_branch_financial_summary
                                (tenant_id, branch_id, business_date, orders_count)
                             VALUES ($1, $2, '2026-11-26'::date, 1)`,
                            [tenantA, branchId]
                        ),
                    runtimePool
                ),
            (err) => {
                assert.equal(
                    err.code,
                    '25006',
                    `Phải từ chối ghi bằng mã lỗi PostgreSQL 25006 (read_only_sql_transaction), thực tế nhận: ${err.code} (${err.message})`
                );
                return true;
            }
        );

        // 3. Thử thực thi UPDATE bên trong chayTruyVanBaoCao -> cũng phải bị chặn với 25006
        await assert.rejects(
            () =>
                chayTruyVanBaoCao(
                    tenantA,
                    (client) =>
                        client.query(
                            `UPDATE public.daily_branch_financial_summary
                                SET orders_count = 999
                              WHERE tenant_id = $1 AND branch_id = $2 AND business_date = '2026-11-24'::date`,
                            [tenantA, branchId]
                        ),
                    runtimePool
                ),
            (err) => err.code === '25006'
        );
    });
});
