'use strict';

/**
 * [Wave 4B — P2-01] Business Day Cutoff (mặc định 04:00) &
 * Tổng hợp Tài chính Vật hóa theo Chi nhánh / Ngày kinh doanh (`daily_branch_financial_summary`).
 */

function round2(n) {
    const num = Number(n || 0);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num * 100) / 100;
}

/**
 * Hàm thuần tính Ngày Kinh Doanh (Business Date) dựa trên mốc cắt ngày (cutoffHour, mặc định 04:00)
 * và lệch múi giờ (tzOffsetMinutes, mặc định 420 = UTC+7 Asia/Ho_Chi_Minh).
 *
 * Ví dụ (cutoffHour = 4, UTC+7):
 * - 2026-11-24T23:30:00+07:00 => '2026-11-24'
 * - 2026-11-25T03:59:59+07:00 => '2026-11-24'
 * - 2026-11-25T04:00:00+07:00 => '2026-11-25'
 */
function computeBusinessDate(dateInput, cutoffHour = 4, tzOffsetMinutes = 420) {
    const tsMs = dateInput instanceof Date ? dateInput.getTime() : new Date(dateInput).getTime();
    if (!Number.isFinite(tsMs)) {
        throw new Error('Thời gian đầu vào không hợp lệ cho computeBusinessDate');
    }
    const parsedCutoff = Number(cutoffHour);
    const safeCutoff = Number.isFinite(parsedCutoff)
        ? Math.max(0, Math.min(12, Math.floor(parsedCutoff)))
        : 4;
    const parsedTz = Number(tzOffsetMinutes);
    const safeTzMinutes = Number.isFinite(parsedTz) ? parsedTz : 420;

    const shiftedMs = tsMs + safeTzMinutes * 60 * 1000 - safeCutoff * 3600 * 1000;
    const d = new Date(shiftedMs);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

async function resolveBranchBusinessDayConfig(client, { tenantId, branchId, cutoffHour, timezone }) {
    let resolvedCutoff = cutoffHour !== undefined && cutoffHour !== null ? Number(cutoffHour) : null;
    let resolvedTz = timezone ? String(timezone).trim() : null;

    if (resolvedCutoff === null || !resolvedTz) {
        await client.query('SAVEPOINT sp_bday_cfg_branch');
        try {
            const brRes = await client.query(
                `SELECT (to_jsonb(c)->>'business_day_cutoff_hour')::int AS cutoff_hour,
                        NULLIF(BTRIM(to_jsonb(c)->>'timezone'), '') AS tz
                   FROM public.chinhanh c
                  WHERE COALESCE(to_jsonb(c)->>'tenantid', 'DEFAULT') = $1
                    AND (
                        COALESCE(to_jsonb(c)->>'branchid', '') = $2
                        OR COALESCE(to_jsonb(c)->>'machinhanh', '') = $2
                    )
                  LIMIT 1`,
                [tenantId, branchId]
            );
            await client.query('RELEASE SAVEPOINT sp_bday_cfg_branch');
            if (brRes.rows.length > 0) {
                if (resolvedCutoff === null && brRes.rows[0].cutoff_hour !== null) {
                    resolvedCutoff = Number(brRes.rows[0].cutoff_hour);
                }
                if (!resolvedTz && brRes.rows[0].tz) {
                    resolvedTz = brRes.rows[0].tz;
                }
            }
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_bday_cfg_branch').catch(() => {});
        }
    }

    if (resolvedCutoff === null || !resolvedTz) {
        await client.query('SAVEPOINT sp_bday_cfg_tenant');
        try {
            const tRes = await client.query(
                `SELECT (to_jsonb(t)->>'business_day_cutoff_hour')::int AS cutoff_hour,
                        NULLIF(BTRIM(to_jsonb(t)->>'timezone'), '') AS tz
                   FROM public.tenants t
                  WHERE COALESCE(to_jsonb(t)->>'tenantid', '') = $1
                  LIMIT 1`,
                [tenantId]
            );
            await client.query('RELEASE SAVEPOINT sp_bday_cfg_tenant');
            if (tRes.rows.length > 0) {
                if (resolvedCutoff === null && tRes.rows[0].cutoff_hour !== null) {
                    resolvedCutoff = Number(tRes.rows[0].cutoff_hour);
                }
                if (!resolvedTz && tRes.rows[0].tz) {
                    resolvedTz = tRes.rows[0].tz;
                }
            }
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_bday_cfg_tenant').catch(() => {});
        }
    }

    const safeCutoff = Number.isFinite(resolvedCutoff)
        ? Math.max(0, Math.min(12, Math.floor(resolvedCutoff)))
        : 4;
    const safeTz = resolvedTz || 'Asia/Ho_Chi_Minh';
    return { cutoffHour: safeCutoff, timezone: safeTz };
}

/**
 * Tổng hợp & vật hóa (UPSERT) bảng `public.daily_branch_financial_summary`
 * cho 1 chi nhánh trong khung ngày kinh doanh `[businessDate cutoff, businessDate+1 cutoff)`.
 * Mọi truy vấn vào bảng cũ đều đọc an toàn qua `to_jsonb(...)` để tương thích 100% Supabase.
 */
async function refreshDailyBranchFinancialSummary(
    client,
    { tenantId, branchId = 'CN01', businessDate, cutoffHour = null, timezone = null }
) {
    const cleanTenant = String(tenantId || 'DEFAULT').trim();
    const cleanBranch = String(branchId || 'DEFAULT').trim();
    const cleanDate = String(businessDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
        throw new Error('businessDate bắt buộc định dạng YYYY-MM-DD');
    }

    const cfg = await resolveBranchBusinessDayConfig(client, {
        tenantId: cleanTenant,
        branchId: cleanBranch,
        cutoffHour,
        timezone,
    });

    // 1. Tổng hợp đơn hàng trong cửa sổ [businessDate cutoffHour:00, businessDate+1 cutoffHour:00) theo múi giờ chi nhánh
    const ordersAggRes = await client.query(
        `WITH bounds AS (
            SELECT (($3::date + make_interval(hours => $4)) AT TIME ZONE $5) AS win_start,
                   ((($3::date + 1) + make_interval(hours => $4)) AT TIME ZONE $5) AS win_end
         ),
         scoped_orders AS (
            SELECT
                hd.mahoadon,
                COALESCE((to_jsonb(hd)->>'trangthaitt')::int, 0) AS trangthaitt,
                UPPER(COALESCE(to_jsonb(hd)->>'lifecycle_status', '')) AS lifecycle_status,
                COALESCE(
                    NULLIF(to_jsonb(hd)->>'tongtien', '')::numeric,
                    NULLIF(to_jsonb(hd)->>'tongtienthanhtoan', '')::numeric,
                    NULLIF(to_jsonb(hd)->>'thanhtien', '')::numeric,
                    0
                ) AS gross_amount,
                COALESCE(NULLIF(to_jsonb(hd)->>'giamgia', '')::numeric, 0)
                    + COALESCE(NULLIF(to_jsonb(hd)->>'tiengiamkm', '')::numeric, 0)
                    + COALESCE(NULLIF(to_jsonb(hd)->>'tiengiamdiem', '')::numeric, 0) AS discount_amount,
                -- [P0-4] TongTienThanhToan đã được orders/index.js trừ sẵn khi hoàn 1 phần; không trừ SoTienHoan lần thứ 2
                GREATEST(
                    0,
                    COALESCE(
                        NULLIF(to_jsonb(hd)->>'tongtienthanhtoan', '')::numeric,
                        NULLIF(to_jsonb(hd)->>'thanhtien', '')::numeric,
                        NULLIF(to_jsonb(hd)->>'tongtien', '')::numeric,
                        0
                    )
                ) AS net_amount,
                COALESCE(NULLIF(to_jsonb(hd)->>'tienthuevat', '')::numeric, 0) AS tax_amount,
                COALESCE(NULLIF(to_jsonb(hd)->>'tienphiphucvu', '')::numeric, 0) AS service_charge_amount,
                COALESCE(NULLIF(BTRIM(to_jsonb(hd)->>'phuongthuctt'), ''), 'TIEN_MAT') AS phuongthuctt
              FROM public.hoadon hd
              CROSS JOIN bounds b
             WHERE COALESCE(NULLIF(BTRIM(to_jsonb(hd)->>'tenantid'), ''), 'DEFAULT') = $1
               AND COALESCE(NULLIF(BTRIM(to_jsonb(hd)->>'branchid'), ''), 'DEFAULT') = $2
               AND COALESCE(hd.thoigianthanhtoan, hd.thoigiantao) >= b.win_start
               AND COALESCE(hd.thoigianthanhtoan, hd.thoigiantao) < b.win_end
         )
         SELECT
            COUNT(*)::int AS orders_count,
            COUNT(*) FILTER (WHERE trangthaitt = 1 AND lifecycle_status <> 'VOIDED')::int AS paid_orders_count,
            COUNT(*) FILTER (WHERE trangthaitt = 2 OR lifecycle_status = 'VOIDED')::int AS voided_orders_count,
            COALESCE(SUM(gross_amount) FILTER (WHERE trangthaitt = 1 AND lifecycle_status <> 'VOIDED'), 0) AS gross_sales,
            COALESCE(SUM(discount_amount) FILTER (WHERE trangthaitt = 1 AND lifecycle_status <> 'VOIDED'), 0) AS discount_total,
            COALESCE(SUM(net_amount) FILTER (WHERE trangthaitt = 1 AND lifecycle_status <> 'VOIDED'), 0) AS net_sales,
            COALESCE(SUM(tax_amount) FILTER (WHERE trangthaitt = 1 AND lifecycle_status <> 'VOIDED'), 0) AS tax_total,
            COALESCE(SUM(service_charge_amount) FILTER (WHERE trangthaitt = 1 AND lifecycle_status <> 'VOIDED'), 0) AS service_charge_total
           FROM scoped_orders`,
        [cleanTenant, cleanBranch, cleanDate, cfg.cutoffHour, cfg.timezone]
    );
    const oRow = ordersAggRes.rows[0] || {};

    // 2. Tổng giá vốn (COGS) của các món hiệu lực thuộc đơn đã thanh toán trong cửa sổ
    let cogsTotal = 0;
    await client.query('SAVEPOINT sp_bday_cogs');
    try {
        const cogsRes = await client.query(
            `WITH bounds AS (
                SELECT (($3::date + make_interval(hours => $4)) AT TIME ZONE $5) AS win_start,
                       ((($3::date + 1) + make_interval(hours => $4)) AT TIME ZONE $5) AS win_end
             )
             SELECT COALESCE(
                        SUM(
                            COALESCE((to_jsonb(ct)->>'soluong')::numeric, 0)
                            * COALESCE((to_jsonb(ct)->>'giavonsnapshot')::numeric, 0)
                        ),
                        0
                    ) AS cogs_total
               FROM public.chitiethoadon ct
               JOIN public.hoadon hd ON hd.mahoadon = ct.mahoadon
               CROSS JOIN bounds b
              WHERE COALESCE(NULLIF(BTRIM(to_jsonb(hd)->>'tenantid'), ''), 'DEFAULT') = $1
                AND COALESCE(NULLIF(BTRIM(to_jsonb(hd)->>'branchid'), ''), 'DEFAULT') = $2
                AND COALESCE((to_jsonb(hd)->>'trangthaitt')::int, 0) = 1
                AND UPPER(COALESCE(to_jsonb(hd)->>'lifecycle_status', '')) <> 'VOIDED'
                AND COALESCE(to_jsonb(ct)->>'trangthaiphache', '') <> 'DaHuy'
                AND COALESCE(hd.thoigianthanhtoan, hd.thoigiantao) >= b.win_start
                AND COALESCE(hd.thoigianthanhtoan, hd.thoigiantao) < b.win_end`,
            [cleanTenant, cleanBranch, cleanDate, cfg.cutoffHour, cfg.timezone]
        );
        await client.query('RELEASE SAVEPOINT sp_bday_cogs');
        cogsTotal = round2(cogsRes.rows[0]?.cogs_total || 0);
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_bday_cogs').catch(() => {});
    }

    // 3. Điều chỉnh giá vốn từ cogs_adjustment_journal (Wave 2 Safe WAC / Replay)
    let cogsAdjustmentTotal = 0;
    await client.query('SAVEPOINT sp_bday_cogs_adj');
    try {
        const adjRes = await client.query(
            `SELECT COALESCE(SUM(adjustment_amount), 0) AS adj_total
               FROM public.cogs_adjustment_journal
              WHERE tenant_id = $1
                AND COALESCE(NULLIF(BTRIM(branch_id), ''), 'DEFAULT') = $2
                AND business_date = $3::date`,
            [cleanTenant, cleanBranch, cleanDate]
        );
        await client.query('RELEASE SAVEPOINT sp_bday_cogs_adj');
        cogsAdjustmentTotal = round2(adjRes.rows[0]?.adj_total || 0);
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_bday_cogs_adj').catch(() => {});
    }

    // 4. Chi phí nhân công trong ngày kinh doanh (chấm công thường + payroll_ot_logs)
    let laborCostTotal = 0;
    await client.query('SAVEPOINT sp_bday_labor_base');
    try {
        const laborRes = await client.query(
            `WITH bounds AS (
                SELECT (($3::date + make_interval(hours => $4)) AT TIME ZONE $5) AS win_start,
                       ((($3::date + 1) + make_interval(hours => $4)) AT TIME ZONE $5) AS win_end
             )
             SELECT COALESCE(
                        SUM(
                            GREATEST(
                                0,
                                EXTRACT(EPOCH FROM (
                                    COALESCE(cc.thoigiancheckout, cc.giorathucte)
                                    - COALESCE(cc.thoigiancheckin, cc.giovaothucte)
                                )) / 3600.0
                            ) * COALESCE(
                                NULLIF((to_jsonb(nv)->>'mucluongtheogio')::numeric, 0),
                                NULLIF((to_jsonb(nv)->>'mucluonggio')::numeric, 0),
                                0
                            )
                        ),
                        0
                    ) AS base_labor
               FROM public.chamcong cc
               JOIN public.phanca pc ON pc.maphanca = cc.maphanca
               JOIN public.nhanvien nv ON nv.manv = COALESCE(cc.manv, pc.manv)
               CROSS JOIN bounds b
              WHERE COALESCE(NULLIF(BTRIM(to_jsonb(pc)->>'tenantid'), ''), 'DEFAULT') = $1
                AND COALESCE(NULLIF(BTRIM(to_jsonb(nv)->>'branchid'), ''), 'DEFAULT') = $2
                AND COALESCE(cc.thoigiancheckin, cc.giovaothucte) >= b.win_start
                AND COALESCE(cc.thoigiancheckin, cc.giovaothucte) < b.win_end
                AND COALESCE(cc.thoigiancheckout, cc.giorathucte) IS NOT NULL`,
            [cleanTenant, cleanBranch, cleanDate, cfg.cutoffHour, cfg.timezone]
        );
        await client.query('RELEASE SAVEPOINT sp_bday_labor_base');
        laborCostTotal += Number(laborRes.rows[0]?.base_labor || 0);
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_bday_labor_base').catch(() => {});
    }

    await client.query('SAVEPOINT sp_bday_labor_ot');
    try {
        const otRes = await client.query(
            `SELECT COALESCE(SUM(COALESCE(ot_pay, 0) + COALESCE(night_allowance, 0)), 0) AS ot_labor
               FROM public.payroll_ot_logs
              WHERE tenant_id = $1
                AND COALESCE(NULLIF(BTRIM(branch_id), ''), 'DEFAULT') = $2
                AND work_date = $3::date`,
            [cleanTenant, cleanBranch, cleanDate]
        );
        await client.query('RELEASE SAVEPOINT sp_bday_labor_ot');
        laborCostTotal += Number(otRes.rows[0]?.ot_labor || 0);
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_bday_labor_ot').catch(() => {});
    }
    laborCostTotal = round2(laborCostTotal);

    // 5. Phân bổ theo phương thức thanh toán (order_payments hoặc fallback HoaDon.PhuongThucTT)
    const paymentBreakdown = {};
    await client.query('SAVEPOINT sp_bday_payments');
    try {
        const payRes = await client.query(
            `WITH bounds AS (
                SELECT (($3::date + make_interval(hours => $4)) AT TIME ZONE $5) AS win_start,
                       ((($3::date + 1) + make_interval(hours => $4)) AT TIME ZONE $5) AS win_end
             )
             SELECT method, COALESCE(SUM(amount), 0) AS total_amount
               FROM (
                   SELECT COALESCE(NULLIF(BTRIM(to_jsonb(op)->>'phuongthuctt'), ''), 'TIEN_MAT') AS method,
                          CASE
                              WHEN UPPER(COALESCE(to_jsonb(op)->>'trangthai', '')) = 'REFUNDED'
                                  THEN -COALESCE((to_jsonb(op)->>'sotien')::numeric, 0)
                              ELSE COALESCE((to_jsonb(op)->>'sotien')::numeric, 0)
                          END AS amount
                     FROM public.order_payments op
                     JOIN public.hoadon hd ON hd.mahoadon::text = op.mahoadon::text
                     CROSS JOIN bounds b
                    WHERE COALESCE(NULLIF(BTRIM(to_jsonb(op)->>'tenantid'), ''), 'DEFAULT') = $1
                      AND COALESCE(NULLIF(BTRIM(to_jsonb(hd)->>'branchid'), ''), 'DEFAULT') = $2
                      AND UPPER(COALESCE(to_jsonb(op)->>'trangthai', '')) IN ('PAID', 'REFUNDED')
                      AND COALESCE(hd.thoigianthanhtoan, hd.thoigiantao) >= b.win_start
                      AND COALESCE(hd.thoigianthanhtoan, hd.thoigiantao) < b.win_end
                   UNION ALL
                   SELECT COALESCE(NULLIF(BTRIM(to_jsonb(hd)->>'phuongthuctt'), ''), 'TIEN_MAT') AS method,
                          GREATEST(
                              0,
                              COALESCE(
                                  NULLIF(to_jsonb(hd)->>'tongtienthanhtoan', '')::numeric,
                                  NULLIF(to_jsonb(hd)->>'thanhtien', '')::numeric,
                                  NULLIF(to_jsonb(hd)->>'tongtien', '')::numeric,
                                  0
                              ) - COALESCE(NULLIF(to_jsonb(hd)->>'sotienhoan', '')::numeric, 0)
                          ) AS amount
                     FROM public.hoadon hd
                     CROSS JOIN bounds b
                    WHERE COALESCE(NULLIF(BTRIM(to_jsonb(hd)->>'tenantid'), ''), 'DEFAULT') = $1
                      AND COALESCE(NULLIF(BTRIM(to_jsonb(hd)->>'branchid'), ''), 'DEFAULT') = $2
                      AND COALESCE((to_jsonb(hd)->>'trangthaitt')::int, 0) = 1
                      AND UPPER(COALESCE(to_jsonb(hd)->>'lifecycle_status', '')) <> 'VOIDED'
                      AND COALESCE(hd.thoigianthanhtoan, hd.thoigiantao) >= b.win_start
                      AND COALESCE(hd.thoigianthanhtoan, hd.thoigiantao) < b.win_end
                      AND NOT EXISTS (
                          SELECT 1 FROM public.order_payments op2
                           WHERE op2.mahoadon::text = hd.mahoadon::text
                             AND UPPER(COALESCE(to_jsonb(op2)->>'trangthai', '')) = 'PAID'
                      )
               ) combined
              GROUP BY method`,
            [cleanTenant, cleanBranch, cleanDate, cfg.cutoffHour, cfg.timezone]
        );
        await client.query('RELEASE SAVEPOINT sp_bday_payments');
        for (const row of payRes.rows) {
            paymentBreakdown[row.method] = round2(row.total_amount);
        }
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_bday_payments').catch(() => {});
    }

    const ordersCount = Number(oRow.orders_count || 0);
    const paidOrdersCount = Number(oRow.paid_orders_count || 0);
    const voidedOrdersCount = Number(oRow.voided_orders_count || 0);
    const grossSales = round2(oRow.gross_sales || 0);
    const discountTotal = round2(oRow.discount_total || 0);
    const netSales = round2(oRow.net_sales || 0);
    const taxTotal = round2(oRow.tax_total || 0);
    const serviceChargeTotal = round2(oRow.service_charge_total || 0);
    const grossProfit = round2(netSales - (cogsTotal + cogsAdjustmentTotal));
    const netProfit = round2(grossProfit - laborCostTotal);

    const upsertRes = await client.query(
        `INSERT INTO public.daily_branch_financial_summary (
            tenant_id, branch_id, business_date,
            orders_count, paid_orders_count, voided_orders_count,
            gross_sales, discount_total, net_sales,
            tax_total, service_charge_total,
            cogs_total, cogs_adjustment_total, labor_cost_total,
            gross_profit, net_profit,
            payment_breakdown_json, last_refreshed_at
         )
         VALUES (
            $1, $2, $3::date,
            $4, $5, $6,
            $7, $8, $9,
            $10, $11,
            $12, $13, $14,
            $15, $16,
            $17::jsonb, now()
         )
         ON CONFLICT (tenant_id, branch_id, business_date)
         DO UPDATE SET
            orders_count           = EXCLUDED.orders_count,
            paid_orders_count      = EXCLUDED.paid_orders_count,
            voided_orders_count    = EXCLUDED.voided_orders_count,
            gross_sales            = EXCLUDED.gross_sales,
            discount_total         = EXCLUDED.discount_total,
            net_sales              = EXCLUDED.net_sales,
            tax_total              = EXCLUDED.tax_total,
            service_charge_total   = EXCLUDED.service_charge_total,
            cogs_total             = EXCLUDED.cogs_total,
            cogs_adjustment_total  = EXCLUDED.cogs_adjustment_total,
            labor_cost_total       = EXCLUDED.labor_cost_total,
            gross_profit           = EXCLUDED.gross_profit,
            net_profit             = EXCLUDED.net_profit,
            payment_breakdown_json = EXCLUDED.payment_breakdown_json,
            last_refreshed_at      = now()
         RETURNING *, TO_CHAR(business_date, 'YYYY-MM-DD') AS business_date_str`,
        [
            cleanTenant,
            cleanBranch,
            cleanDate,
            ordersCount,
            paidOrdersCount,
            voidedOrdersCount,
            grossSales,
            discountTotal,
            netSales,
            taxTotal,
            serviceChargeTotal,
            cogsTotal,
            cogsAdjustmentTotal,
            laborCostTotal,
            grossProfit,
            netProfit,
            JSON.stringify(paymentBreakdown),
        ]
    );

    const saved = upsertRes.rows[0];
    return {
        tenantId: saved.tenant_id,
        branchId: saved.branch_id,
        businessDate: saved.business_date_str || cleanDate,
        cutoffHour: cfg.cutoffHour,
        timezone: cfg.timezone,
        ordersCount: Number(saved.orders_count),
        paidOrdersCount: Number(saved.paid_orders_count),
        voidedOrdersCount: Number(saved.voided_orders_count),
        grossSales: Number(saved.gross_sales),
        discountTotal: Number(saved.discount_total),
        netSales: Number(saved.net_sales),
        taxTotal: Number(saved.tax_total),
        serviceChargeTotal: Number(saved.service_charge_total),
        cogsTotal: Number(saved.cogs_total),
        cogsAdjustmentTotal: Number(saved.cogs_adjustment_total),
        laborCostTotal: Number(saved.labor_cost_total),
        grossProfit: Number(saved.gross_profit),
        netProfit: Number(saved.net_profit),
        paymentBreakdown: saved.payment_breakdown_json || {},
        lastRefreshedAt: saved.last_refreshed_at,
    };
}

async function getDailyBranchFinancialSummary(
    client,
    { tenantId, branchId = null, fromDate = null, toDate = null, limit = 90 }
) {
    const cleanTenant = String(tenantId || 'DEFAULT').trim();
    const params = [cleanTenant];
    const conds = ['tenant_id = $1'];

    if (branchId && String(branchId).trim() && String(branchId).trim().toUpperCase() !== 'ALL') {
        params.push(String(branchId).trim());
        conds.push(`branch_id = $${params.length}`);
    }
    if (fromDate && /^\d{4}-\d{2}-\d{2}$/.test(String(fromDate).trim())) {
        params.push(String(fromDate).trim());
        conds.push(`business_date >= $${params.length}::date`);
    }
    if (toDate && /^\d{4}-\d{2}-\d{2}$/.test(String(toDate).trim())) {
        params.push(String(toDate).trim());
        conds.push(`business_date <= $${params.length}::date`);
    }
    const safeLimit = Math.max(1, Math.min(365, Number(limit) || 90));
    params.push(safeLimit);

    const r = await client.query(
        `SELECT tenant_id, branch_id, TO_CHAR(business_date, 'YYYY-MM-DD') AS business_date,
                orders_count, paid_orders_count, voided_orders_count,
                gross_sales, discount_total, net_sales,
                tax_total, service_charge_total,
                cogs_total, cogs_adjustment_total, labor_cost_total,
                gross_profit, net_profit,
                payment_breakdown_json, last_refreshed_at
           FROM public.daily_branch_financial_summary
          WHERE ${conds.join(' AND ')}
          ORDER BY business_date DESC, branch_id ASC
          LIMIT $${params.length}`,
        params
    );

    const rows = r.rows.map((row) => ({
        tenantId: row.tenant_id,
        branchId: row.branch_id,
        businessDate: row.business_date,
        ordersCount: Number(row.orders_count),
        paidOrdersCount: Number(row.paid_orders_count),
        voidedOrdersCount: Number(row.voided_orders_count),
        grossSales: Number(row.gross_sales),
        discountTotal: Number(row.discount_total),
        netSales: Number(row.net_sales),
        taxTotal: Number(row.tax_total),
        serviceChargeTotal: Number(row.service_charge_total),
        cogsTotal: Number(row.cogs_total),
        cogsAdjustmentTotal: Number(row.cogs_adjustment_total),
        laborCostTotal: Number(row.labor_cost_total),
        grossProfit: Number(row.gross_profit),
        netProfit: Number(row.net_profit),
        paymentBreakdown: row.payment_breakdown_json || {},
        lastRefreshedAt: row.last_refreshed_at,
    }));

    const totals = rows.reduce(
        (acc, it) => ({
            ordersCount: acc.ordersCount + it.ordersCount,
            paidOrdersCount: acc.paidOrdersCount + it.paidOrdersCount,
            voidedOrdersCount: acc.voidedOrdersCount + it.voidedOrdersCount,
            grossSales: round2(acc.grossSales + it.grossSales),
            discountTotal: round2(acc.discountTotal + it.discountTotal),
            netSales: round2(acc.netSales + it.netSales),
            taxTotal: round2(acc.taxTotal + it.taxTotal),
            serviceChargeTotal: round2(acc.serviceChargeTotal + it.serviceChargeTotal),
            cogsTotal: round2(acc.cogsTotal + it.cogsTotal),
            cogsAdjustmentTotal: round2(acc.cogsAdjustmentTotal + it.cogsAdjustmentTotal),
            laborCostTotal: round2(acc.laborCostTotal + it.laborCostTotal),
            grossProfit: round2(acc.grossProfit + it.grossProfit),
            netProfit: round2(acc.netProfit + it.netProfit),
        }),
        {
            ordersCount: 0,
            paidOrdersCount: 0,
            voidedOrdersCount: 0,
            grossSales: 0,
            discountTotal: 0,
            netSales: 0,
            taxTotal: 0,
            serviceChargeTotal: 0,
            cogsTotal: 0,
            cogsAdjustmentTotal: 0,
            laborCostTotal: 0,
            grossProfit: 0,
            netProfit: 0,
        }
    );

    return { rows, totals };
}

module.exports = {
    computeBusinessDate,
    refreshDailyBranchFinancialSummary,
    getDailyBranchFinancialSummary,
};
