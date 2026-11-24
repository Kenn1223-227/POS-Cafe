/**
 * =============================================================================
 * PHÂN HỆ 3 (82 -> 100/100): PAYMENT, VIETQR, BLIND SHIFT, SAFE DROP & Z-REPORT
 * Core Engine (Pure + DB helpers)
 * =============================================================================
 */

const DEFAULT_SHIFT_POLICY = {
    preCloseMode: 'CARRY_OVER', // 'STRICT' | 'CARRY_OVER'
    nguongBatBuocChungTu: 50000,
    nguongPinPhieuChi: 200000,
    hanMucKetTienMat: 5000000,
    nguongLechCaRecount: 10000,
    strictDenomination: false,
};

const VALID_DENOMINATIONS = [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000, 500];

function normalizeBranchForShift(tenantId = 'DEFAULT', branchId = null) {
    const clean = String(branchId || '').trim();
    if (clean) return clean.slice(0, 64);
    return `${String(tenantId || 'DEFAULT')}_MAIN`;
}

function normalizeTerminalId(terminalId = null) {
    const clean = String(terminalId || '').trim().toUpperCase();
    return clean ? clean.slice(0, 64) : 'POS_01';
}

function computeDenominationTotal(chiTietMenhGia) {
    if (!chiTietMenhGia || typeof chiTietMenhGia !== 'object' || Array.isArray(chiTietMenhGia)) {
        return { cleanMap: null, total: null };
    }
    const clean = {};
    let total = 0;
    for (const [k, v] of Object.entries(chiTietMenhGia)) {
        const denom = Number(k);
        const qty = Math.floor(Number(v));
        if (Number.isFinite(denom) && denom > 0 && Number.isFinite(qty) && qty > 0) {
            clean[String(denom)] = qty;
            total += denom * qty;
        }
    }
    if (Object.keys(clean).length === 0) return { cleanMap: null, total: 0 };
    return { cleanMap: clean, total: Math.round(total * 100) / 100 };
}

async function getTenantShiftPolicy(client, tenantId = 'DEFAULT') {
    await client.query('SAVEPOINT sp_get_shift_policy');
    try {
        const r = await client.query(
            `SELECT COALESCE(to_jsonb(Tenants)->'cauhinhca', '{}'::jsonb) AS cfg
               FROM Tenants WHERE TenantId = $1 LIMIT 1`,
            [String(tenantId || 'DEFAULT')]
        );
        await client.query('RELEASE SAVEPOINT sp_get_shift_policy');
        const raw = r.rows[0]?.cfg || {};
        return {
            ...DEFAULT_SHIFT_POLICY,
            ...(typeof raw === 'object' && raw ? raw : {}),
        };
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_get_shift_policy').catch(() => {});
        return { ...DEFAULT_SHIFT_POLICY };
    }
}

/**
 * Đánh số Z-Report nguyên tử theo (TenantId, BranchId) -> Z-0001, Z-0002...
 * Tuyệt đối không trùng dù 2 máy ở 2 chi nhánh chốt ca đồng thời!
 */
async function nextAtomicZReportNumber(client, tenantId = 'DEFAULT', branchId = null) {
    const tId = String(tenantId || 'DEFAULT');
    const bId = normalizeBranchForShift(tId, branchId);
    const r = await client.query(
        `INSERT INTO public.branch_zreport_counter (tenantid, branchid, lastz)
         VALUES ($1, $2, 1)
         ON CONFLICT (tenantid, branchid)
         DO UPDATE SET lastz = public.branch_zreport_counter.lastz + 1
         RETURNING lastz`,
        [tId, bId]
    );
    const zInt = Number(r.rows[0].lastz || 1);
    return {
        zInt,
        zNumber: `Z-${String(zInt).padStart(4, '0')}`,
        branchId: bId,
    };
}

/**
 * Cổng kiểm tra an toàn trước khi chốt ca (5 mục treo):
 *  1. Hóa đơn đang mở (TrangThaiTT = 0)
 *  2. Đơn lưu nháp (TrangThaiTT = -1)
 *  3. Đơn Offline còn kẹt trong IndexedDB Outbox trên máy POS (outboxPendingCount)
 *  4. Giao dịch VietQR UNMATCHED hoặc Overpayment/Double-Pay PENDING_ACTION
 *  5. Phiên tính giờ Bida/Boardgame đang RUNNING
 */
async function computePreCloseChecklist(
    client,
    { tenantId = 'DEFAULT', branchId = null, maCaThuNgan = null, outboxPendingCount = 0 }
) {
    const tId = String(tenantId || 'DEFAULT');
    const policy = await getTenantShiftPolicy(client, tId);

    const openOrdersRes = await client.query(
        `SELECT hd.MaHoaDon, hd.ThoiGianTao,
                (SELECT string_agg(b.TenBan, ', ' ORDER BY b.TenBan)
                   FROM HoaDon_Ban hb JOIN Ban b ON b.MaBan = hb.MaBan
                  WHERE hb.MaHoaDon = hd.MaHoaDon) AS TenBan,
                COALESCE((SELECT SUM((c.DonGia + COALESCE(c.GiaModifiers, 0)) * c.SoLuong - COALESCE(c.GiaGiam, 0))
                            FROM ChiTietHoaDon c WHERE c.MaHoaDon = hd.MaHoaDon AND c.TrangThaiPhaChe <> 'DaHuy'), 0)
                + COALESCE((SELECT SUM(tp.SoLuong * tp.DonGia)
                              FROM ChiTietHoaDon c2 JOIN ChiTietHoaDon_Topping tp ON tp.MaCTHD = c2.MaCTHD
                             WHERE c2.MaHoaDon = hd.MaHoaDon AND c2.TrangThaiPhaChe <> 'DaHuy'), 0) AS UocTinh
           FROM HoaDon hd
          WHERE COALESCE(hd.TenantId::text, 'DEFAULT') = $1::text
            AND hd.TrangThaiTT = 0
            AND (
                $2::text IS NULL
                OR COALESCE(NULLIF(NULLIF(to_jsonb(hd)->>'branchid', ''), 'DEFAULT'), $1::text || '_MAIN') = $2::text
            )
          ORDER BY hd.ThoiGianTao ASC`,
        [tId, branchId || null]
    );
    const openOrders = openOrdersRes.rows.map((r) => ({
        maHoaDon: r.mahoadon,
        tenBan: r.tenban || 'Mang đi',
        thoiGianTao: r.thoigiantao,
        uocTinh: Math.round(Number(r.uoctinh || 0)),
    }));
    const openTablesEstimatedTotal = openOrders.reduce((s, o) => s + o.uocTinh, 0);

    const parkedRes = await client.query(
        `SELECT COUNT(*) AS cnt FROM HoaDon WHERE COALESCE(TenantId, 'DEFAULT') = $1 AND TrangThaiTT = -1`,
        [tId]
    );
    const parkedOrdersCount = Number(parkedRes.rows[0]?.cnt || 0);

    let pendingVietQrEvents = [];
    await client.query('SAVEPOINT sp_preclose_vqr');
    try {
        const vqrRes = await client.query(
            `SELECT Id, NhaCungCap, MaGiaoDichNgoai, SoTien, SoTienConLai, TrangThaiXuLy, TrangThaiXuLyDu, NoiDungCK, ThoiGianNhan
               FROM public.vietqr_webhook_events
              WHERE COALESCE(TenantId, 'DEFAULT') = $1
                AND (TrangThaiXuLy = 'UNMATCHED' OR TrangThaiXuLyDu = 'PENDING_ACTION')
                AND ThoiGianNhan >= now() - interval '24 hours'
              ORDER BY ThoiGianNhan DESC
              LIMIT 30`,
            [tId]
        );
        pendingVietQrEvents = vqrRes.rows.map((r) => ({
            id: Number(r.id),
            nhaCungCap: r.nhacungcap,
            maGiaoDichNgoai: r.magiaodichngoai,
            soTien: Number(r.sotien || 0),
            soTienConLai: Number(r.sotienconlai || 0),
            trangThaiXuLy: r.trangthaixuly,
            trangThaiXuLyDu: r.trangthaixulydu,
            noiDungCK: r.noidungck,
            thoiGianNhan: r.thoigiannhan,
        }));
        await client.query('RELEASE SAVEPOINT sp_preclose_vqr');
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_preclose_vqr').catch(() => {});
    }

    let runningTimeSessionsCount = 0;
    await client.query('SAVEPOINT sp_preclose_time');
    try {
        const tsRes = await client.query(
            `SELECT COUNT(*) AS cnt FROM public.phientinhgio WHERE tenantid = $1 AND trangthai = 'RUNNING'`,
            [tId]
        );
        runningTimeSessionsCount = Number(tsRes.rows[0]?.cnt || 0);
        await client.query('RELEASE SAVEPOINT sp_preclose_time');
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_preclose_time').catch(() => {});
    }

    const outboxCnt = Math.max(0, Math.floor(Number(outboxPendingCount || 0)));
    const blockingReasons = [];
    if (policy.preCloseMode === 'STRICT') {
        if (openOrders.length > 0) {
            blockingReasons.push(`Còn ${openOrders.length} hóa đơn/bàn chưa thanh toán (${openTablesEstimatedTotal.toLocaleString('vi-VN')}đ).`);
        }
        if (outboxCnt > 0) {
            blockingReasons.push(`Còn ${outboxCnt} đơn Offline chưa đồng bộ trong Outbox trên máy POS.`);
        }
        if (pendingVietQrEvents.length > 0) {
            blockingReasons.push(`Còn ${pendingVietQrEvents.length} giao dịch VietQR chưa khớp hoặc chuyển dư/trùng chờ xử lý.`);
        }
    }

    return {
        maCaThuNgan,
        policyMode: policy.preCloseMode,
        canClose: blockingReasons.length === 0,
        blockingReasons,
        openOrders,
        openTablesEstimatedTotal,
        parkedOrdersCount,
        outboxPendingCount: outboxCnt,
        pendingVietQrEvents,
        runningTimeSessionsCount,
    };
}

/**
 * Xây dựng ZReportSnapshot JSONB bất biến tại thời điểm chốt ca.
 * Lưu cố định trong CaThuNgan.ZReportSnapshot để mọi lần in lại về sau khớp 100%, không bị tác động bởi hoàn tiền ca sau!
 */
async function buildImmutableZReportSnapshot(
    client,
    {
        tenantId = 'DEFAULT',
        maCaThuNgan,
        caRow,
        ds,
        zNumber,
        branchId,
        terminalId,
        closeByName = '',
        carryOverFloatNextShift = 0,
        carriedOverOpenTables = { count: 0, estimatedTotal: 0 },
        recountAttempts = 0,
    }
) {
    const tId = String(tenantId || 'DEFAULT');

    // 1. Phân tích phương thức thanh toán chi tiết (tách riêng Auto Webhook vs Manual CK + Late Offline Sync)
    const payDetailRes = await client.query(
        `SELECT PhuongThucTT,
                NguonXacNhan,
                COALESCE((to_jsonb(Order_Payments)->>'laofflinelechca')::boolean, FALSE) AS LaOfflineLechCa,
                COUNT(*) AS cnt,
                COALESCE(SUM(SoTien), 0) AS tong
           FROM Order_Payments
          WHERE MaCaThuNgan = $1::text AND TrangThai = 'PAID'
          GROUP BY PhuongThucTT, NguonXacNhan, COALESCE((to_jsonb(Order_Payments)->>'laofflinelechca')::boolean, FALSE)`,
        [String(maCaThuNgan)]
    );

    const paymentsByMethod = {
        TIEN_MAT: 0,
        CHUYEN_KHOAN_AUTO_WEBHOOK: 0,
        CHUYEN_KHOAN_MANUAL: 0,
        THE: 0,
        VI_KHACH: 0,
        VI_DIEN_TU: 0,
        SAN_GIAO_HANG: 0,
        VOUCHER: 0,
    };
    const lateOfflineSyncedFromPrevShift = { count: 0, total: 0, cash: 0 };

    for (const r of payDetailRes.rows) {
        const amt = Number(r.tong || 0);
        const cnt = Number(r.cnt || 0);
        const pt = r.phuongthuctt || 'TIEN_MAT';
        const src = String(r.nguonxacnhan || 'POS_MANUAL').toUpperCase();
        if (pt === 'CHUYEN_KHOAN') {
            if (src.includes('WEBHOOK') || src.includes('SEPAY') || src.includes('PAYOS')) {
                paymentsByMethod.CHUYEN_KHOAN_AUTO_WEBHOOK += amt;
            } else {
                paymentsByMethod.CHUYEN_KHOAN_MANUAL += amt;
            }
        } else if (paymentsByMethod[pt] !== undefined) {
            paymentsByMethod[pt] += amt;
        } else {
            paymentsByMethod.TIEN_MAT += amt;
        }
        if (r.laofflinelechca) {
            lateOfflineSyncedFromPrevShift.count += cnt;
            lateOfflineSyncedFromPrevShift.total += amt;
            if (pt === 'TIEN_MAT') lateOfflineSyncedFromPrevShift.cash += amt;
        }
    }

    // 2. Chi tiết doanh số hóa đơn (giảm giá, VAT, phí phục vụ)
    let salesExtra = { promoDiscounts: 0, loyaltyDiscounts: 0, serviceCharge: 0, vatCollected: 0, itemDiscounts: 0 };
    await client.query('SAVEPOINT sp_z_sales_extra');
    try {
        const sRes = await client.query(
            `SELECT COALESCE(SUM(COALESCE((to_jsonb(hd)->>'tiengiamkm')::numeric, 0)), 0) AS promo_disc,
                    COALESCE(SUM(COALESCE((to_jsonb(hd)->>'tiengiamdiem')::numeric, 0)), 0) AS loyalty_disc,
                    COALESCE(SUM(COALESCE((to_jsonb(hd)->>'tienphiphucvu')::numeric, 0)), 0) AS svc_fee,
                    COALESCE(SUM(COALESCE((to_jsonb(hd)->>'tienthuevat')::numeric, 0)), 0) AS vat_amt
               FROM HoaDon hd
              WHERE hd.MaCaThuNgan = $1 AND hd.TrangThaiTT IN (1, 2)`,
            [maCaThuNgan]
        );
        const idRes = await client.query(
            `SELECT COALESCE(SUM(COALESCE(c.GiaGiam, 0) + COALESCE((to_jsonb(c)->>'chietkhaumon')::numeric, 0)), 0) AS item_disc
               FROM ChiTietHoaDon c
               JOIN HoaDon hd ON hd.MaHoaDon = c.MaHoaDon
              WHERE hd.MaCaThuNgan = $1 AND c.TrangThaiPhaChe <> 'DaHuy'`,
            [maCaThuNgan]
        );
        salesExtra = {
            promoDiscounts: Math.round(Number(sRes.rows[0]?.promo_disc || 0)),
            loyaltyDiscounts: Math.round(Number(sRes.rows[0]?.loyalty_disc || 0)),
            serviceCharge: Math.round(Number(sRes.rows[0]?.svc_fee || 0)),
            vatCollected: Math.round(Number(sRes.rows[0]?.vat_amt || 0)),
            itemDiscounts: Math.round(Number(idRes.rows[0]?.item_disc || 0)),
        };
        await client.query('RELEASE SAVEPOINT sp_z_sales_extra');
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_z_sales_extra').catch(() => {});
    }

    // 3. Chỉ số rủi ro gian lận trong khung giờ ca
    let riskMetrics = {
        voidBeforePrepCount: 0,
        voidWasteCount: 0,
        voidWasteValue: 0,
        reprintCount: 0,
        noSaleDrawerKicks: 0,
        recountAttempts: Number(recountAttempts || 0),
        carriedOverOpenTables,
    };
    await client.query('SAVEPOINT sp_z_risk');
    try {
        const openedAt = caRow.thoigianmoca || new Date(Date.now() - 8 * 3600000);
        const rRes = await client.query(
            `SELECT HanhDong, COUNT(*) AS cnt,
                    COALESCE(SUM(COALESCE((GiaTriCu->>'giaVonHaoHut')::numeric, 0)), 0) AS waste_val
               FROM Audit_Logs
              WHERE COALESCE(TenantId, 'DEFAULT') = $1
                AND ThoiGianTao >= $2
                AND HanhDong IN ('ITEM_VOID_RETURN_STOCK', 'ITEM_VOID_WASTE', 'RECEIPT_REPRINT', 'DRAWER_NO_SALE_KICK')
              GROUP BY HanhDong`,
            [tId, openedAt]
        );
        for (const r of rRes.rows) {
            if (r.hanhdong === 'ITEM_VOID_RETURN_STOCK') riskMetrics.voidBeforePrepCount = Number(r.cnt || 0);
            else if (r.hanhdong === 'ITEM_VOID_WASTE') {
                riskMetrics.voidWasteCount = Number(r.cnt || 0);
                riskMetrics.voidWasteValue = Math.round(Number(r.waste_val || 0));
            } else if (r.hanhdong === 'RECEIPT_REPRINT') riskMetrics.reprintCount = Number(r.cnt || 0);
            else if (r.hanhdong === 'DRAWER_NO_SALE_KICK') riskMetrics.noSaleDrawerKicks = Number(r.cnt || 0);
        }
        await client.query('RELEASE SAVEPOINT sp_z_risk');
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_z_risk').catch(() => {});
    }

    const netSales = Math.round(Number(ds.doanhThu?.tong || 0));
    const totalDiscounts = salesExtra.itemDiscounts + salesExtra.promoDiscounts + salesExtra.loyaltyDiscounts;
    const grossSales = netSales + totalDiscounts;
    const orderCount = Number(ds.doanhThu?.soHoaDon || 0);
    const actualCountedCash = Number(ds.tienMatThucTe || 0);
    const carryFloat = Math.max(0, Math.min(actualCountedCash, Number(carryOverFloatNextShift || 0)));

    return {
        zNumber,
        branchId,
        terminalId,
        openedAt: caRow.thoigianmoca,
        closedAt: new Date().toISOString(),
        staff: {
            openBy: ds.tenNV || caRow.manv,
            closeBy: closeByName || ds.tenNV || caRow.manv,
        },
        sales: {
            grossSales,
            itemDiscounts: salesExtra.itemDiscounts,
            promoDiscounts: salesExtra.promoDiscounts,
            loyaltyDiscounts: salesExtra.loyaltyDiscounts,
            netSales,
            serviceCharge: salesExtra.serviceCharge,
            vatCollected: salesExtra.vatCollected,
            orderCount,
            avgTicket: orderCount > 0 ? Math.round(netSales / orderCount) : 0,
        },
        paymentsByMethod,
        lateOfflineSyncedFromPrevShift,
        refunds: {
            count: Number(ds.hoanTien?.soLuot || 0),
            cash: Number(ds.hoanTien?.tienMat || 0),
            bank: Number(ds.hoanTien?.chuyenKhoan || 0),
            card: Number(ds.hoanTien?.the || 0),
            wallet: Number(ds.hoanTien?.viKhach || 0),
            total: Number(ds.hoanTien?.tong || 0),
        },
        cashFlow: {
            openingFloat: Number(ds.tienMatDauCa || 0),
            cashSales: Number(ds.doanhThu?.tienMat || 0),
            payIn: Number(ds.thuLatVat || 0),
            payOut: Number(ds.chiLatVat || 0),
            safeDrop: Number(ds.rutKet || 0),
            overpaymentCashChange: Number(ds.thoiCkDu || 0),
            cashRefunds: Number(ds.hoanTien?.tienMat || 0),
            expectedCash: Number(ds.tienMatLyThuyet || 0),
            actualCountedCash,
            variance: Number(ds.chenhLech || 0),
            carryOverFloatNextShift: carryFloat,
            netCashToOwner: Math.max(0, Math.round((actualCountedCash - carryFloat) * 100) / 100),
        },
        riskMetrics,
    };
}

/**
 * Đối soát 3 chiều cuối ngày (End-of-Day Settlement):
 *   1. Ngân hàng: Order_Payments (CHUYEN_KHOAN: auto webhook vs manual) <-> VietQR_Webhook_Events
 *   2. Máy quẹt thẻ EDC: Order_Payments (THE) <-> TongChotLoEDC (Batch Settlement)
 */
async function computeEndOfDayReconciliation(
    client,
    { tenantId = 'DEFAULT', tuNgay = null, denNgay = null, maCaThuNgan = null, tongChotLoEDC = null }
) {
    const tId = String(tenantId || 'DEFAULT');
    const vnTz = 'Asia/Ho_Chi_Minh';
    const filterByShift = Boolean(maCaThuNgan);

    const payRes = await client.query(
        filterByShift
            ? `SELECT PhuongThucTT, NguonXacNhan, COUNT(*) AS cnt, COALESCE(SUM(SoTien), 0) AS tong
                 FROM Order_Payments
                WHERE COALESCE(TenantId, 'DEFAULT') = $1
                  AND MaCaThuNgan = $2::text
                  AND TrangThai = 'PAID'
                GROUP BY PhuongThucTT, NguonXacNhan`
            : `SELECT PhuongThucTT, NguonXacNhan, COUNT(*) AS cnt, COALESCE(SUM(SoTien), 0) AS tong
                 FROM Order_Payments
                WHERE COALESCE(TenantId, 'DEFAULT') = $1
                  AND TrangThai = 'PAID'
                  AND ThoiGianTao >= ($2::timestamp AT TIME ZONE '${vnTz}')
                  AND ThoiGianTao < (($3::date + 1)::timestamp AT TIME ZONE '${vnTz}')
                GROUP BY PhuongThucTT, NguonXacNhan`,
        filterByShift ? [tId, String(maCaThuNgan)] : [tId, tuNgay, denNgay]
    );

    let posBankAuto = 0;
    let posBankManual = 0;
    let posBankManualCount = 0;
    let posCardTotal = 0;
    let posCardCount = 0;

    for (const r of payRes.rows) {
        const amt = Number(r.tong || 0);
        const cnt = Number(r.cnt || 0);
        const src = String(r.nguonxacnhan || '').toUpperCase();
        if (r.phuongthuctt === 'CHUYEN_KHOAN') {
            if (src.includes('WEBHOOK') || src.includes('SEPAY') || src.includes('PAYOS') || src === 'MANUAL_BANK_MATCH') {
                posBankAuto += amt;
            } else {
                posBankManual += amt;
                posBankManualCount += cnt;
            }
        } else if (r.phuongthuctt === 'THE') {
            posCardTotal += amt;
            posCardCount += cnt;
        }
    }

    // [Wave 1 — P0-07] Khi đối soát theo ca, lọc vietqr_webhook_events theo đúng khung [ThoiGianMoCa, COALESCE(ThoiGianDongCa, now())]
    let whRes;
    if (filterByShift) {
        const shiftWindowRes = await client.query(
            `SELECT ThoiGianMoCa, COALESCE(ThoiGianDongCa, now()) AS ThoiGianKetThuc
               FROM CaThuNgan
              WHERE MaCaThuNgan = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
            [maCaThuNgan, tId]
        );
        const win = shiftWindowRes.rows[0];
        if (win) {
            whRes = await client.query(
                `SELECT TrangThaiXuLy, TrangThaiXuLyDu, COUNT(*) AS cnt,
                        COALESCE(SUM(SoTien), 0) AS tong_nhan,
                        COALESCE(SUM(SoTienConLai), 0) AS tong_du
                   FROM public.vietqr_webhook_events
                  WHERE COALESCE(TenantId, 'DEFAULT') = $1
                    AND ThoiGianNhan >= $2::timestamptz
                    AND ThoiGianNhan <= $3::timestamptz
                  GROUP BY TrangThaiXuLy, TrangThaiXuLyDu`,
                [tId, win.thoigianmoca, win.thoigianketthuc]
            );
        } else {
            whRes = { rows: [] };
        }
    } else {
        whRes = await client.query(
            `SELECT TrangThaiXuLy, TrangThaiXuLyDu, COUNT(*) AS cnt,
                    COALESCE(SUM(SoTien), 0) AS tong_nhan,
                    COALESCE(SUM(SoTienConLai), 0) AS tong_du
               FROM public.vietqr_webhook_events
              WHERE COALESCE(TenantId, 'DEFAULT') = $1
                AND ($2::text IS NULL OR ThoiGianNhan >= ($2::text::timestamp AT TIME ZONE '${vnTz}'))
                AND ($3::text IS NULL OR ThoiGianNhan < (($3::text::date + 1)::timestamp AT TIME ZONE '${vnTz}'))
              GROUP BY TrangThaiXuLy, TrangThaiXuLyDu`,
            [tId, tuNgay, denNgay]
        );
    }

    let webhookMatchedTotal = 0;
    let webhookUnmatchedTotal = 0;
    let webhookUnmatchedCount = 0;
    let webhookPendingOverpayTotal = 0;

    for (const r of whRes.rows) {
        if (['MATCHED_PAID', 'PARTIAL_PAID', 'MANUALLY_MATCHED'].includes(r.trangthaixuly)) {
            webhookMatchedTotal += Number(r.tong_nhan || 0);
        } else if (r.trangthaixuly === 'UNMATCHED') {
            webhookUnmatchedTotal += Number(r.tong_nhan || 0);
            webhookUnmatchedCount += Number(r.cnt || 0);
        }
        if (r.trangthaixulydu === 'PENDING_ACTION') {
            webhookPendingOverpayTotal += Number(r.tong_du || 0);
        }
    }

    const posBankTotal = posBankAuto + posBankManual;
    const bankVariance = Math.round((posBankTotal - webhookMatchedTotal) * 100) / 100;
    const edcDeclared = tongChotLoEDC !== null && tongChotLoEDC !== undefined && tongChotLoEDC !== '' ? Number(tongChotLoEDC) : null;
    const edcVariance = edcDeclared === null ? null : Math.round((edcDeclared - posCardTotal) * 100) / 100;

    return {
        bankReconciliation: {
            posBankTotal,
            posBankAutoWebhook: posBankAuto,
            posBankManual,
            posBankManualCount,
            webhookMatchedTotal,
            webhookUnmatchedCount,
            webhookUnmatchedTotal,
            webhookPendingOverpayTotal,
            variance: bankVariance,
            hasManualRisk: posBankManual > 0,
        },
        edcReconciliation: {
            posCardTotal,
            posCardCount,
            tongChotLoEDC: edcDeclared,
            variance: edcVariance,
            matched: edcVariance !== null ? Math.abs(edcVariance) < 1 : null,
        },
    };
}

module.exports = {
    DEFAULT_SHIFT_POLICY,
    VALID_DENOMINATIONS,
    normalizeBranchForShift,
    normalizeTerminalId,
    computeDenominationTotal,
    getTenantShiftPolicy,
    nextAtomicZReportNumber,
    computePreCloseChecklist,
    buildImmutableZReportSnapshot,
    computeEndOfDayReconciliation,
};
