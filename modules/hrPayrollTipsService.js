'use strict';

const OT_MULTIPLIERS = {
    WEEKDAY: 1.5,
    WEEKEND: 2.0,
    HOLIDAY: 3.0,
};

const VALID_TIP_SOURCES = new Set(['CASH_JAR', 'CARD_TIP', 'VIETQR_TIP']);
const VALID_ALLOCATION_METHODS = new Set(['BY_HOURS', 'BY_ROLE_WEIGHT', 'EQUAL']);

class HrPayrollError extends Error {
    constructor(status, message, code = 'HR_PAYROLL_ERROR') {
        super(message);
        this.name = 'HrPayrollError';
        this.status = status;
        this.code = code;
    }
}

// =============================================================================
// 1. TIP POOL ENGINE (PHÂN BỔ CHÍNH XÁC — LỆCH 0Đ)
// =============================================================================

/**
 * Hàm thuần phân bổ quỹ Tip theo giờ công / trọng số vai trò / chia đều.
 * Người cuối cùng nhận phần dư làm tròn để SUM(allocatedAmount) === totalAmount (lệch 0đ).
 */
function distributeTipPool(totalAmount, participants = [], method = 'BY_HOURS') {
    const cleanMethod = VALID_ALLOCATION_METHODS.has(String(method || '').toUpperCase())
        ? String(method).toUpperCase()
        : 'BY_HOURS';
    const total = Math.max(0, Math.round(Number(totalAmount || 0)));
    const list = (Array.isArray(participants) ? participants : [])
        .map((p) => ({
            maNV: String(p.maNV ?? p.ma_nv ?? '').trim(),
            hoursWorked: Math.max(0, Number(p.hoursWorked ?? p.hours_worked ?? 0)),
            weight: Math.max(0, Number(p.weight ?? 1)),
        }))
        .filter((p) => p.maNV.length > 0);

    if (list.length === 0) {
        return {
            totalAmount: total,
            allocatedTotal: 0,
            diff: total,
            method: cleanMethod,
            allocations: [],
        };
    }

    const rawScores = list.map((p) => {
        if (cleanMethod === 'EQUAL') return 1;
        if (cleanMethod === 'BY_ROLE_WEIGHT') {
            const hrs = p.hoursWorked > 0 ? p.hoursWorked : 1;
            return p.weight * hrs;
        }
        return p.hoursWorked;
    });

    const sumScore = rawScores.reduce((acc, s) => acc + s, 0);
    const effectiveScores = sumScore > 0 ? rawScores : list.map(() => 1);
    const effectiveSum = effectiveScores.reduce((acc, s) => acc + s, 0);

    let runningAllocated = 0;
    const allocations = list.map((p, idx) => {
        let allocatedAmount;
        if (idx === list.length - 1) {
            allocatedAmount = total - runningAllocated;
        } else {
            allocatedAmount = Math.floor((total * effectiveScores[idx]) / effectiveSum);
            runningAllocated += allocatedAmount;
        }
        return {
            maNV: p.maNV,
            hoursWorked: p.hoursWorked,
            weight: p.weight,
            allocatedAmount,
        };
    });

    const allocatedTotal = allocations.reduce((acc, a) => acc + a.allocatedAmount, 0);
    return {
        totalAmount: total,
        allocatedTotal,
        diff: total - allocatedTotal,
        method: cleanMethod,
        allocations,
    };
}

// =============================================================================
// 2. TĂNG CA OT 150% / 200% / 300% + PHỤ CẤP CA ĐÊM (BỘ LUẬT LAO ĐỘNG VN)
// =============================================================================

function calculateVietnamOvertimePay({
    baseHourlyRate,
    otHours = 0,
    dayType = 'WEEKDAY',
    nightHours = 0,
}) {
    const cleanDayType = String(dayType || 'WEEKDAY').trim().toUpperCase();
    const multiplier = OT_MULTIPLIERS[cleanDayType];
    if (!multiplier) {
        throw new HrPayrollError(400, 'dayType phải thuộc WEEKDAY, WEEKEND hoặc HOLIDAY!', 'INVALID_DAY_TYPE');
    }

    const rate = Math.max(0, Number(baseHourlyRate || 0));
    const ot = Math.max(0, Number(otHours || 0));
    const night = Math.max(0, Number(nightHours || 0));

    const otPay = Math.round(rate * ot * multiplier);
    const nightBaseAllowance = Math.round(rate * night * 0.30);
    const nightOtOverlapHours = Math.min(ot, night);
    const nightOtExtraAllowance = Math.round(rate * nightOtOverlapHours * 0.20);
    const nightAllowance = nightBaseAllowance + nightOtExtraAllowance;
    const totalPay = otPay + nightAllowance;

    return {
        dayType: cleanDayType,
        baseHourlyRate: rate,
        otHours: ot,
        nightHours: night,
        otMultiplier: multiplier,
        otPay,
        nightBaseAllowance,
        nightOtExtraAllowance,
        nightAllowance,
        totalPay,
    };
}

// =============================================================================
// 3. DB OPERATIONS: TIP POOL & OT LOGS
// =============================================================================

async function createTipPoolEntry(client, {
    tenantId,
    branchId = null,
    businessDate,
    shiftCode = null,
    source = 'CASH_JAR',
    totalAmount = 0,
    allocationMethod = 'BY_HOURS',
    note = null,
    createdBy = null,
    participants = [],
}) {
    const cleanSource = String(source || 'CASH_JAR').trim().toUpperCase();
    const cleanMethod = String(allocationMethod || 'BY_HOURS').trim().toUpperCase();
    const total = Math.round(Number(totalAmount || 0));

    if (!businessDate) {
        throw new HrPayrollError(400, 'Thiếu ngày kinh doanh (businessDate)!', 'INVALID_DATE');
    }
    if (!VALID_TIP_SOURCES.has(cleanSource)) {
        throw new HrPayrollError(400, 'source phải thuộc CASH_JAR, CARD_TIP, VIETQR_TIP!', 'INVALID_SOURCE');
    }
    if (!VALID_ALLOCATION_METHODS.has(cleanMethod)) {
        throw new HrPayrollError(400, 'allocationMethod phải thuộc BY_HOURS, BY_ROLE_WEIGHT, EQUAL!', 'INVALID_METHOD');
    }
    if (!Number.isFinite(total) || total < 0) {
        throw new HrPayrollError(400, 'totalAmount phải >= 0!', 'INVALID_AMOUNT');
    }

    const insRes = await client.query(
        `INSERT INTO public.tip_pool_entries
            (tenant_id, branch_id, business_date, shift_code, source, total_amount, allocation_method, status, note, created_by)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, 'OPEN', $8, $9)
         RETURNING *`,
        [
            String(tenantId),
            branchId ? String(branchId) : null,
            businessDate,
            shiftCode ? String(shiftCode) : null,
            cleanSource,
            total,
            cleanMethod,
            note ? String(note) : null,
            createdBy ? String(createdBy) : null,
        ]
    );
    const entry = insRes.rows[0];

    if (Array.isArray(participants) && participants.length > 0) {
        return distributeAndSaveTipPool(client, {
            tenantId,
            tipPoolId: entry.id,
            participants,
            method: cleanMethod,
        });
    }

    return { entry, distributions: [] };
}

async function distributeAndSaveTipPool(client, {
    tenantId,
    tipPoolId,
    participants = [],
    method = null,
}) {
    const rowRes = await client.query(
        `SELECT * FROM public.tip_pool_entries WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [Number(tipPoolId), String(tenantId)]
    );
    const entry = rowRes.rows[0];
    if (!entry) {
        throw new HrPayrollError(404, 'Không tìm thấy quỹ Tip Pool!', 'TIP_POOL_NOT_FOUND');
    }

    const usedMethod = method || entry.allocation_method || 'BY_HOURS';
    const result = distributeTipPool(entry.total_amount, participants, usedMethod);
    if (result.allocations.length === 0) {
        throw new HrPayrollError(400, 'Danh sách nhân viên nhận tip (participants) không được rỗng!', 'EMPTY_PARTICIPANTS');
    }

    await client.query(
        `DELETE FROM public.tip_pool_distributions WHERE tip_pool_id = $1 AND tenant_id = $2`,
        [entry.id, String(tenantId)]
    );

    const savedDistributions = [];
    for (const a of result.allocations) {
        const dRes = await client.query(
            `INSERT INTO public.tip_pool_distributions
                (tenant_id, tip_pool_id, ma_nv, hours_worked, weight, allocated_amount)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [String(tenantId), entry.id, a.maNV, a.hoursWorked, a.weight, a.allocatedAmount]
        );
        savedDistributions.push(dRes.rows[0]);
    }

    const updRes = await client.query(
        `UPDATE public.tip_pool_entries
            SET status = 'DISTRIBUTED', allocation_method = $3
          WHERE id = $1 AND tenant_id = $2
          RETURNING *`,
        [entry.id, String(tenantId), result.method]
    );

    return {
        entry: updRes.rows[0],
        summary: {
            totalAmount: result.totalAmount,
            allocatedTotal: result.allocatedTotal,
            diff: result.diff,
        },
        distributions: savedDistributions,
    };
}

async function listTipPools(client, { tenantId, fromDate = null, toDate = null }) {
    const entriesRes = await client.query(
        `SELECT *
           FROM public.tip_pool_entries
          WHERE tenant_id = $1
            AND ($2::date IS NULL OR business_date >= $2::date)
            AND ($3::date IS NULL OR business_date <= $3::date)
          ORDER BY business_date DESC, id DESC
          LIMIT 100`,
        [String(tenantId), fromDate || null, toDate || null]
    );
    const distRes = await client.query(
        `SELECT *
           FROM public.tip_pool_distributions
          WHERE tenant_id = $1
          ORDER BY id ASC`,
        [String(tenantId)]
    );
    const byPool = new Map();
    for (const d of distRes.rows) {
        const list = byPool.get(d.tip_pool_id) || [];
        list.push(d);
        byPool.set(d.tip_pool_id, list);
    }
    return entriesRes.rows.map((e) => ({ ...e, distributions: byPool.get(e.id) || [] }));
}

async function createOvertimeLog(client, {
    tenantId,
    branchId = null,
    maNV,
    workDate,
    dayType = 'WEEKDAY',
    otHours = 0,
    nightHours = 0,
    baseHourlyRate,
    approvedBy = null,
    note = null,
}) {
    const cleanNV = String(maNV || '').trim();
    if (!cleanNV || !workDate) {
        throw new HrPayrollError(400, 'Thiếu mã nhân viên (maNV) hoặc ngày làm (workDate)!', 'INVALID_INPUT');
    }

    const calc = calculateVietnamOvertimePay({
        baseHourlyRate,
        otHours,
        dayType,
        nightHours,
    });

    const res = await client.query(
        `INSERT INTO public.payroll_ot_logs
            (tenant_id, branch_id, ma_nv, work_date, day_type, ot_hours, night_hours,
             base_hourly_rate, ot_multiplier, ot_pay, night_allowance, approved_by, note)
         VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
            String(tenantId),
            branchId ? String(branchId) : null,
            cleanNV,
            workDate,
            calc.dayType,
            calc.otHours,
            calc.nightHours,
            calc.baseHourlyRate,
            calc.otMultiplier,
            calc.otPay,
            calc.nightAllowance,
            approvedBy ? String(approvedBy) : null,
            note ? String(note) : null,
        ]
    );
    return { log: res.rows[0], breakdown: calc };
}

async function listOvertimeLogs(client, { tenantId, fromDate = null, toDate = null, maNV = null }) {
    const res = await client.query(
        `SELECT *
           FROM public.payroll_ot_logs
          WHERE tenant_id = $1
            AND ($2::date IS NULL OR work_date >= $2::date)
            AND ($3::date IS NULL OR work_date <= $3::date)
            AND ($4::text IS NULL OR ma_nv = $4)
          ORDER BY work_date DESC, id DESC
          LIMIT 200`,
        [String(tenantId), fromDate || null, toDate || null, maNV ? String(maNV) : null]
    );
    return res.rows;
}

// =============================================================================
// 4. ANALYTICS: HOURLY SALES VS. LABOR COST % (24 KHUNG GIỜ 00 -> 23)
// =============================================================================

async function getHourlySalesVsLabor(client, {
    tenantId,
    branchId = null,
    fromDate,
    toDate = null,
}) {
    const startDay = fromDate || new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    const endDay = toDate || startDay;
    const cleanBranch = branchId ? String(branchId).trim() : null;

    // Khởi tạo đủ 24 khung giờ 00 -> 23
    const buckets = Array.from({ length: 24 }, (_, hour) => ({
        hour,
        label: `${String(hour).padStart(2, '0')}:00`,
        orderCount: 0,
        netSales: 0,
        activeStaffSet: new Set(),
        laborCost: 0,
    }));

    // 1. Doanh thu theo giờ (múi giờ Asia/Ho_Chi_Minh)
    const salesRes = await client.query(
        `SELECT EXTRACT(HOUR FROM (COALESCE(hd.thoigianthanhtoan, hd.thoigiantao) AT TIME ZONE 'Asia/Ho_Chi_Minh'))::int AS hr,
                COUNT(*)::int AS order_count,
                COALESCE(SUM(COALESCE(hd.tongtienthanhtoan, hd.thanhtien, hd.tongtien, 0)), 0)::numeric AS net_sales
           FROM public.hoadon hd
          WHERE COALESCE(hd.tenantid, 'DEFAULT') = $1
            AND hd.trangthaitt = 1
            AND (COALESCE(hd.thoigianthanhtoan, hd.thoigiantao) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date
            AND ($4::text IS NULL OR COALESCE(to_jsonb(hd)->>'branchid', '') = $4)
          GROUP BY hr`,
        [String(tenantId), startDay, endDay, cleanBranch]
    );

    for (const row of salesRes.rows) {
        const hr = Number(row.hr);
        if (hr >= 0 && hr < 24) {
            buckets[hr].orderCount = Number(row.order_count || 0);
            buckets[hr].netSales = Math.round(Number(row.net_sales || 0));
        }
    }

    // 2. Chi phí nhân công theo giờ từ ChamCong + NhanVien.MucLuongGio
    const rangeStartMs = new Date(`${startDay}T00:00:00+07:00`).getTime();
    const rangeEndMs = new Date(`${endDay}T23:59:59.999+07:00`).getTime();

    await client.query('SAVEPOINT sp_hourly_labor');
    try {
        const laborRes = await client.query(
            `SELECT cc.manv,
                    COALESCE(cc.giovaothucte, cc.thoigiancheckin) AS check_in,
                    COALESCE(cc.giorathucte, cc.thoigiancheckout, now()) AS check_out,
                    COALESCE(nv.mucluonggio, 0)::numeric AS hourly_rate
               FROM public.chamcong cc
               LEFT JOIN public.nhanvien nv
                 ON nv.manv = cc.manv
                AND COALESCE(nv.tenantid, 'DEFAULT') = COALESCE(cc.tenantid, 'DEFAULT')
              WHERE COALESCE(cc.tenantid, 'DEFAULT') = $1
                AND COALESCE(cc.giovaothucte, cc.thoigiancheckin) IS NOT NULL
                AND COALESCE(cc.giovaothucte, cc.thoigiancheckin) <= $3::timestamptz
                AND COALESCE(cc.giorathucte, cc.thoigiancheckout, now()) >= $2::timestamptz`,
            [String(tenantId), new Date(rangeStartMs).toISOString(), new Date(rangeEndMs).toISOString()]
        );
        await client.query('RELEASE SAVEPOINT sp_hourly_labor');

        const tzOffsetMs = 7 * 3600 * 1000;
        for (const row of laborRes.rows) {
            const inMs = Math.max(rangeStartMs, new Date(row.check_in).getTime());
            const outMs = Math.min(rangeEndMs, new Date(row.check_out).getTime());
            if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || outMs <= inMs) continue;

            const hourlyRate = Math.max(0, Number(row.hourly_rate || 0));
            // Duyệt từng block giờ mà ca làm việc giao cắt
            let cursor = inMs;
            while (cursor < outMs) {
                const localMs = cursor + tzOffsetMs;
                const localHour = new Date(localMs).getUTCHours();
                const nextHourBoundaryMs = (Math.floor(localMs / 3600000) + 1) * 3600000 - tzOffsetMs;
                const segEnd = Math.min(outMs, nextHourBoundaryMs);
                const overlapHours = Math.max(0, (segEnd - cursor) / 3600000);
                if (overlapHours > 0 && localHour >= 0 && localHour < 24) {
                    buckets[localHour].activeStaffSet.add(String(row.manv || 'STAFF'));
                    buckets[localHour].laborCost += overlapHours * hourlyRate;
                }
                cursor = segEnd;
            }
        }
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_hourly_labor').catch(() => {});
    }

    const hours = buckets.map((b) => {
        const laborCost = Math.round(b.laborCost);
        const laborCostPct = b.netSales > 0 ? Math.round((laborCost / b.netSales) * 10000) / 100 : 0;
        return {
            hour: b.hour,
            label: b.label,
            orderCount: b.orderCount,
            netSales: b.netSales,
            activeStaffCount: b.activeStaffSet.size,
            laborCost,
            laborCostPct,
            isHighLaborCost: laborCostPct > 30,
        };
    });

    const totalNetSales = hours.reduce((s, h) => s + h.netSales, 0);
    const totalLaborCost = hours.reduce((s, h) => s + h.laborCost, 0);
    const overallLaborCostPct = totalNetSales > 0 ? Math.round((totalLaborCost / totalNetSales) * 10000) / 100 : 0;

    return {
        period: { fromDate: startDay, toDate: endDay, branchId: cleanBranch },
        summary: {
            totalNetSales,
            totalLaborCost,
            overallLaborCostPct,
            highLaborHoursCount: hours.filter((h) => h.isHighLaborCost).length,
        },
        hours,
    };
}

module.exports = {
    OT_MULTIPLIERS,
    HrPayrollError,
    distributeTipPool,
    calculateVietnamOvertimePay,
    createTipPoolEntry,
    distributeAndSaveTipPool,
    listTipPools,
    createOvertimeLog,
    listOvertimeLogs,
    getHourlySalesVsLabor,
};
