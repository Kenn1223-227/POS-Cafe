'use strict';

const crypto = require('crypto');
const { verifyPassword } = require('../password');

const VALID_PLATFORMS = new Set(['GRABFOOD', 'SHOPEEFOOD', 'BEFOOD', 'XANHSM']);
const VALID_SETTLEMENT_STATUSES = new Set(['DRAFT', 'RECONCILED', 'DISPUTED']);

function roundMoney(v) {
    return Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
}

class FinanceOpsError extends Error {
    constructor(status, message, code = 'FINANCE_OPS_ERROR', details = null) {
        super(message);
        this.name = 'FinanceOpsError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

// =============================================================================
// 1. HOUSE ACCOUNT B2B (CÔNG NỢ KHÁCH DOANH NGHIỆP / KHÁCH QUEN)
// =============================================================================

async function createHouseAccount(client, {
    tenantId,
    branchId = null,
    accountCode,
    companyName,
    taxCode = null,
    contactPhone = null,
    creditLimit = 0,
    paymentTermDays = 30,
}) {
    const cleanCode = String(accountCode || '').trim().toUpperCase();
    const cleanName = String(companyName || '').trim();
    const limitNum = roundMoney(creditLimit);
    const termDays = Math.max(0, Math.floor(Number(paymentTermDays ?? 30)));

    if (!cleanCode || !cleanName) {
        throw new FinanceOpsError(400, 'Thiếu mã tài khoản (accountCode) hoặc tên doanh nghiệp (companyName)!', 'INVALID_INPUT');
    }
    if (!Number.isFinite(limitNum) || limitNum < 0) {
        throw new FinanceOpsError(400, 'Hạn mức công nợ (creditLimit) phải >= 0!', 'INVALID_CREDIT_LIMIT');
    }

    try {
        const res = await client.query(
            `INSERT INTO public.house_accounts
                (tenant_id, branch_id, account_code, company_name, tax_code, contact_phone, credit_limit, payment_term_days)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
                String(tenantId),
                branchId ? String(branchId) : null,
                cleanCode,
                cleanName,
                taxCode ? String(taxCode).trim() : null,
                contactPhone ? String(contactPhone).trim() : null,
                limitNum,
                termDays,
            ]
        );
        return res.rows[0];
    } catch (err) {
        if (err && err.code === '23505') {
            throw new FinanceOpsError(409, `Mã tài khoản công nợ ${cleanCode} đã tồn tại!`, 'DUPLICATE_ACCOUNT_CODE');
        }
        throw err;
    }
}

async function listHouseAccounts(client, { tenantId, activeOnly = false }) {
    const res = await client.query(
        `SELECT *
           FROM public.house_accounts
          WHERE tenant_id = $1
            AND ($2::boolean = FALSE OR is_active = TRUE)
          ORDER BY is_active DESC, company_name ASC`,
        [String(tenantId), Boolean(activeOnly)]
    );
    return res.rows;
}

async function chargeHouseAccount(client, {
    tenantId,
    houseAccountId,
    amount,
    maHoaDon = null,
    note = null,
    createdBy = null,
}) {
    const amt = roundMoney(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
        throw new FinanceOpsError(400, 'Số tiền ghi nợ phải lớn hơn 0!', 'INVALID_AMOUNT');
    }

    const acctRes = await client.query(
        `SELECT *
           FROM public.house_accounts
          WHERE id = $1 AND tenant_id = $2
          FOR UPDATE`,
        [Number(houseAccountId), String(tenantId)]
    );
    const acct = acctRes.rows[0];
    if (!acct) {
        throw new FinanceOpsError(404, 'Không tìm thấy tài khoản công nợ B2B!', 'HOUSE_ACCOUNT_NOT_FOUND');
    }
    if (!acct.is_active) {
        throw new FinanceOpsError(409, 'Tài khoản công nợ B2B đã bị khóa!', 'HOUSE_ACCOUNT_INACTIVE');
    }

    const currentBalance = roundMoney(acct.current_balance);
    const creditLimit = roundMoney(acct.credit_limit);
    const newBalance = roundMoney(currentBalance + amt);

    if (newBalance > creditLimit) {
        throw new FinanceOpsError(
            409,
            `Vượt hạn mức công nợ B2B! Dư nợ hiện tại ${currentBalance}, phát sinh ${amt}, hạn mức tối đa ${creditLimit}.`,
            'CREDIT_LIMIT_EXCEEDED',
            { currentBalance, requestedAmount: amt, creditLimit, projectedBalance: newBalance }
        );
    }

    const updRes = await client.query(
        `UPDATE public.house_accounts
            SET current_balance = $1, updated_at = now()
          WHERE id = $2 AND tenant_id = $3
          RETURNING *`,
        [newBalance, acct.id, String(tenantId)]
    );

    const ledgerRes = await client.query(
        `INSERT INTO public.house_account_ledger
            (tenant_id, house_account_id, entry_type, ma_hoa_don, amount, balance_after, note, created_by)
         VALUES ($1, $2, 'CHARGE', $3, $4, $5, $6, $7)
         RETURNING *`,
        [
            String(tenantId),
            acct.id,
            maHoaDon ? String(maHoaDon) : null,
            amt,
            newBalance,
            note ? String(note) : null,
            createdBy ? String(createdBy) : null,
        ]
    );

    return { account: updRes.rows[0], ledgerEntry: ledgerRes.rows[0] };
}

async function repayHouseAccount(client, {
    tenantId,
    houseAccountId,
    amount,
    note = null,
    createdBy = null,
}) {
    const amt = roundMoney(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
        throw new FinanceOpsError(400, 'Số tiền thanh toán công nợ phải lớn hơn 0!', 'INVALID_AMOUNT');
    }

    const acctRes = await client.query(
        `SELECT *
           FROM public.house_accounts
          WHERE id = $1 AND tenant_id = $2
          FOR UPDATE`,
        [Number(houseAccountId), String(tenantId)]
    );
    const acct = acctRes.rows[0];
    if (!acct) {
        throw new FinanceOpsError(404, 'Không tìm thấy tài khoản công nợ B2B!', 'HOUSE_ACCOUNT_NOT_FOUND');
    }

    const currentBalance = roundMoney(acct.current_balance);
    const newBalance = roundMoney(currentBalance - amt);

    const updRes = await client.query(
        `UPDATE public.house_accounts
            SET current_balance = $1, updated_at = now()
          WHERE id = $2 AND tenant_id = $3
          RETURNING *`,
        [newBalance, acct.id, String(tenantId)]
    );

    const ledgerRes = await client.query(
        `INSERT INTO public.house_account_ledger
            (tenant_id, house_account_id, entry_type, ma_hoa_don, amount, balance_after, note, created_by)
         VALUES ($1, $2, 'REPAYMENT', NULL, $3, $4, $5, $6)
         RETURNING *`,
        [
            String(tenantId),
            acct.id,
            amt,
            newBalance,
            note ? String(note) : null,
            createdBy ? String(createdBy) : null,
        ]
    );

    return { account: updRes.rows[0], ledgerEntry: ledgerRes.rows[0] };
}

async function getHouseAccountStatement(client, { tenantId, houseAccountId, from = null, to = null }) {
    const acctRes = await client.query(
        `SELECT * FROM public.house_accounts WHERE id = $1 AND tenant_id = $2`,
        [Number(houseAccountId), String(tenantId)]
    );
    const acct = acctRes.rows[0];
    if (!acct) {
        throw new FinanceOpsError(404, 'Không tìm thấy tài khoản công nợ B2B!', 'HOUSE_ACCOUNT_NOT_FOUND');
    }

    const ledgerRes = await client.query(
        `SELECT *
           FROM public.house_account_ledger
          WHERE tenant_id = $1
            AND house_account_id = $2
            AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
            AND ($4::timestamptz IS NULL OR created_at <= $4::timestamptz)
          ORDER BY created_at ASC, id ASC`,
        [String(tenantId), acct.id, from || null, to || null]
    );

    let totalCharged = 0;
    let totalRepaid = 0;
    for (const row of ledgerRes.rows) {
        if (row.entry_type === 'CHARGE') totalCharged = roundMoney(totalCharged + Number(row.amount));
        if (row.entry_type === 'REPAYMENT') totalRepaid = roundMoney(totalRepaid + Number(row.amount));
    }

    return {
        account: acct,
        summary: {
            totalCharged,
            totalRepaid,
            closingBalance: roundMoney(acct.current_balance),
            entryCount: ledgerRes.rows.length,
        },
        entries: ledgerRes.rows,
    };
}

// =============================================================================
// 2. VIETQR PAYMENT ATTEMPTS (TTL 5 PHÚT + CHỐNG TRÙNG QR ĐỘNG)
// =============================================================================

async function createVietQrPaymentAttempt(client, {
    tenantId,
    branchId = null,
    maHoaDon,
    amount,
    ttlMinutes = 5,
    transferCode = null,
}) {
    const cleanOrderId = String(maHoaDon || '').trim();
    const amt = roundMoney(amount);
    const ttl = Math.max(1, Math.min(60, Number(ttlMinutes || 5)));

    if (!cleanOrderId) {
        throw new FinanceOpsError(400, 'Thiếu mã hóa đơn (maHoaDon)!', 'INVALID_ORDER_ID');
    }
    if (!Number.isFinite(amt) || amt <= 0) {
        throw new FinanceOpsError(400, 'Số tiền VietQR phải lớn hơn 0!', 'INVALID_AMOUNT');
    }

    // Đánh dấu SUPERSEDED toàn bộ attempt ACTIVE cũ trên cùng hóa đơn
    await client.query(
        `UPDATE public.vietqr_payment_attempts
            SET status = 'SUPERSEDED'
          WHERE tenant_id = $1
            AND ma_hoa_don = $2
            AND status = 'ACTIVE'`,
        [String(tenantId), cleanOrderId]
    );

    const code =
        (transferCode && String(transferCode).trim()) ||
        `VQR${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    const insRes = await client.query(
        `INSERT INTO public.vietqr_payment_attempts
            (tenant_id, branch_id, ma_hoa_don, transfer_code, amount, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', now() + ($6::text || ' minutes')::interval)
         RETURNING *`,
        [String(tenantId), branchId ? String(branchId) : null, cleanOrderId, code, amt, String(ttl)]
    );

    return insRes.rows[0];
}

async function resolveActiveVietQrAttempt(client, {
    tenantId,
    transferCode = null,
    maHoaDon = null,
    nowDate = null,
}) {
    const nowMs = nowDate ? new Date(nowDate).getTime() : Date.now();
    let res;
    if (transferCode) {
        res = await client.query(
            `SELECT *
               FROM public.vietqr_payment_attempts
              WHERE tenant_id = $1 AND transfer_code = $2
              FOR UPDATE`,
            [String(tenantId), String(transferCode).trim()]
        );
    } else if (maHoaDon) {
        res = await client.query(
            `SELECT *
               FROM public.vietqr_payment_attempts
              WHERE tenant_id = $1 AND ma_hoa_don = $2
              ORDER BY created_at DESC, id DESC
              LIMIT 1
              FOR UPDATE`,
            [String(tenantId), String(maHoaDon).trim()]
        );
    } else {
        throw new FinanceOpsError(400, 'Cần truyền transferCode hoặc maHoaDon!', 'INVALID_INPUT');
    }

    const attempt = res.rows[0];
    if (!attempt) {
        return { ok: false, status: 404, code: 'VIETQR_ATTEMPT_NOT_FOUND', attempt: null };
    }
    if (attempt.status !== 'ACTIVE') {
        return { ok: false, status: 409, code: `VIETQR_ATTEMPT_${attempt.status}`, attempt };
    }
    if (new Date(attempt.expires_at).getTime() <= nowMs) {
        const expRes = await client.query(
            `UPDATE public.vietqr_payment_attempts
                SET status = 'EXPIRED'
              WHERE id = $1 AND tenant_id = $2
              RETURNING *`,
            [attempt.id, String(tenantId)]
        );
        return { ok: false, status: 410, code: 'VIETQR_ATTEMPT_EXPIRED', attempt: expRes.rows[0] };
    }

    return { ok: true, status: 200, code: 'ACTIVE', attempt };
}

// =============================================================================
// 3. DUAL-PIN SHIFT HANDOVER (BÀN GIAO CA 2 PIN)
// =============================================================================

async function verifyStaffPin(client, tenantId, maNV, rawPin) {
    const cleanPin = String(rawPin || '').trim();
    if (!maNV || !/^\d{4,6}$/.test(cleanPin)) {
        return null;
    }
    const res = await client.query(
        `SELECT MaNV, TenNV, VaiTro, PinHash, TrangThaiLamViec
           FROM public.nhanvien
          WHERE MaNV = $1
            AND COALESCE(TenantId, 'DEFAULT') = $2
            AND TrangThaiLamViec = TRUE
          LIMIT 1`,
        [String(maNV).trim(), String(tenantId)]
    );
    const staff = res.rows[0];
    if (!staff || !staff.pinhash) return null;

    const { ok } = await verifyPassword(cleanPin, staff.pinhash);
    if (!ok) return null;
    return { maNV: staff.manv, tenNV: staff.tennv, vaiTro: Number(staff.vaitro) };
}

async function performDualPinShiftHandover(client, {
    tenantId,
    branchId = null,
    maCaThuNgan,
    outgoingStaffId,
    outgoingPin,
    incomingStaffId,
    incomingPin,
    expectedCash = 0,
    countedCash = 0,
    note = null,
    ip = null,
    ghiAuditLog = null,
}) {
    const outId = String(outgoingStaffId || '').trim();
    const inId = String(incomingStaffId || '').trim();
    const caId = Number(maCaThuNgan);

    if (!Number.isInteger(caId) || caId <= 0) {
        throw new FinanceOpsError(400, 'Mã ca thu ngân không hợp lệ!', 'INVALID_SHIFT_ID');
    }
    if (!outId || !inId) {
        throw new FinanceOpsError(400, 'Bắt buộc nhập đủ mã nhân viên giao ca và nhận ca!', 'MISSING_STAFF_ID');
    }
    if (outId === inId) {
        throw new FinanceOpsError(400, 'Người giao ca và người nhận ca phải là 2 nhân viên khác nhau!', 'SAME_STAFF_HANDOVER');
    }

    const outgoingStaff = await verifyStaffPin(client, tenantId, outId, outgoingPin);
    if (!outgoingStaff) {
        throw new FinanceOpsError(403, 'PIN của nhân viên giao ca không hợp lệ!', 'INVALID_OUTGOING_PIN');
    }

    const incomingStaff = await verifyStaffPin(client, tenantId, inId, incomingPin);
    if (!incomingStaff) {
        throw new FinanceOpsError(403, 'PIN của nhân viên nhận ca không hợp lệ!', 'INVALID_INCOMING_PIN');
    }

    const expCash = roundMoney(expectedCash);
    const cntCash = roundMoney(countedCash);
    const varianceAmount = roundMoney(cntCash - expCash);

    const insRes = await client.query(
        `INSERT INTO public.shift_handovers
            (tenant_id, branch_id, ma_ca_thu_ngan, outgoing_staff_id, incoming_staff_id,
             expected_cash, counted_cash, variance_amount, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
            String(tenantId),
            branchId ? String(branchId) : null,
            caId,
            outId,
            inId,
            expCash,
            cntCash,
            varianceAmount,
            note ? String(note).slice(0, 500) : null,
        ]
    );
    const handover = insRes.rows[0];

    const auditPayload = {
        tenantId: String(tenantId),
        maNV: outId,
        vaiTro: outgoingStaff.vaiTro,
        nguoiDuyet: inId,
        hanhDong: 'SHIFT_DUAL_PIN_HANDOVER',
        doiTuong: 'CaThuNgan',
        maDoiTuong: String(caId),
        giaTriCu: { outgoingStaffId: outId, expectedCash: expCash },
        giaTriMoi: {
            handoverId: handover.id,
            incomingStaffId: inId,
            countedCash: cntCash,
            varianceAmount,
        },
        lyDo: note ? String(note).slice(0, 500) : 'Bàn giao ca 2 PIN',
        ip: ip || null,
    };

    if (typeof ghiAuditLog === 'function') {
        await ghiAuditLog(client, auditPayload);
    } else {
        await client.query(
            `INSERT INTO public.audit_logs
                (tenantid, manv, vaitro, nguoiduyet, hanhdong, doituong, madoituong, giatricu, giatrimoi, lydo, diachiip)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
            [
                auditPayload.tenantId,
                auditPayload.maNV,
                auditPayload.vaiTro,
                auditPayload.nguoiDuyet,
                auditPayload.hanhDong,
                auditPayload.doiTuong,
                auditPayload.maDoiTuong,
                JSON.stringify(auditPayload.giaTriCu),
                JSON.stringify(auditPayload.giaTriMoi),
                auditPayload.lyDo,
                auditPayload.ip,
            ]
        );
    }

    return { handover, outgoingStaff, incomingStaff };
}

// =============================================================================
// 4. AGGREGATOR SETTLEMENTS (ĐỐI SOÁT SÀN GRABFOOD / SHOPEEFOOD / BEFOOD)
// =============================================================================

function computeAggregatorSettlement({
    grossSales = 0,
    commissionRatePct = 0,
    promoSubsidy = 0,
    netReceived = 0,
}) {
    const gross = roundMoney(grossSales);
    const rate = roundMoney(commissionRatePct);
    const promo = roundMoney(promoSubsidy);
    const received = roundMoney(netReceived);
    const commissionFee = roundMoney((gross * rate) / 100);
    const netExpected = roundMoney(gross - commissionFee - promo);
    const varianceAmount = roundMoney(received - netExpected);
    return {
        grossSales: gross,
        commissionRatePct: rate,
        commissionFee,
        promoSubsidy: promo,
        netExpected,
        netReceived: received,
        varianceAmount,
    };
}

async function createAggregatorSettlement(client, {
    tenantId,
    branchId = null,
    platform,
    periodFrom,
    periodTo,
    grossSales = 0,
    commissionRatePct = 0,
    promoSubsidy = 0,
    netReceived = 0,
    status = null,
    note = null,
    createdBy = null,
}) {
    const plat = String(platform || '').trim().toUpperCase();
    if (!VALID_PLATFORMS.has(plat)) {
        throw new FinanceOpsError(400, 'Nền tảng sàn phải thuộc GRABFOOD, SHOPEEFOOD, BEFOOD, XANHSM!', 'INVALID_PLATFORM');
    }
    if (!periodFrom || !periodTo) {
        throw new FinanceOpsError(400, 'Thiếu kỳ đối soát (periodFrom, periodTo)!', 'INVALID_PERIOD');
    }

    const calc = computeAggregatorSettlement({ grossSales, commissionRatePct, promoSubsidy, netReceived });
    const cleanStatus = status && VALID_SETTLEMENT_STATUSES.has(String(status).toUpperCase())
        ? String(status).toUpperCase()
        : (calc.varianceAmount === 0 ? 'RECONCILED' : 'DISPUTED');

    const res = await client.query(
        `INSERT INTO public.aggregator_settlements
            (tenant_id, branch_id, platform, period_from, period_to,
             gross_sales, commission_rate_pct, commission_fee, promo_subsidy,
             net_expected, net_received, variance_amount, status, note, created_by)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [
            String(tenantId),
            branchId ? String(branchId) : null,
            plat,
            periodFrom,
            periodTo,
            calc.grossSales,
            calc.commissionRatePct,
            calc.commissionFee,
            calc.promoSubsidy,
            calc.netExpected,
            calc.netReceived,
            calc.varianceAmount,
            cleanStatus,
            note ? String(note) : null,
            createdBy ? String(createdBy) : null,
        ]
    );
    return res.rows[0];
}

async function listAggregatorSettlements(client, { tenantId, platform = null }) {
    const plat = platform ? String(platform).trim().toUpperCase() : null;
    const res = await client.query(
        `SELECT *
           FROM public.aggregator_settlements
          WHERE tenant_id = $1
            AND ($2::text IS NULL OR platform = $2)
          ORDER BY period_from DESC, id DESC`,
        [String(tenantId), plat]
    );
    return res.rows;
}

// =============================================================================
// 5. SUPPLIER AP INVOICES & PAYMENTS (CÔNG NỢ PHẢI TRẢ NHÀ CUNG CẤP)
// =============================================================================

async function createSupplierApInvoice(client, {
    tenantId,
    branchId = null,
    invoiceNo,
    supplierName,
    totalAmount,
    dueDate = null,
    note = null,
    createdBy = null,
}) {
    const invNo = String(invoiceNo || '').trim().toUpperCase();
    const supName = String(supplierName || '').trim();
    const total = roundMoney(totalAmount);

    if (!invNo || !supName) {
        throw new FinanceOpsError(400, 'Thiếu số hóa đơn NCC (invoiceNo) hoặc tên nhà cung cấp (supplierName)!', 'INVALID_INPUT');
    }
    if (!Number.isFinite(total) || total < 0) {
        throw new FinanceOpsError(400, 'Tổng tiền hóa đơn NCC phải >= 0!', 'INVALID_AMOUNT');
    }

    const initialStatus = total === 0 ? 'PAID' : 'OPEN';
    try {
        const res = await client.query(
            `INSERT INTO public.supplier_ap_invoices
                (tenant_id, branch_id, invoice_no, supplier_name, total_amount, paid_amount, due_date, status, note, created_by)
             VALUES ($1, $2, $3, $4, $5, 0, $6::date, $7, $8, $9)
             RETURNING *`,
            [
                String(tenantId),
                branchId ? String(branchId) : null,
                invNo,
                supName,
                total,
                dueDate || null,
                initialStatus,
                note ? String(note) : null,
                createdBy ? String(createdBy) : null,
            ]
        );
        return res.rows[0];
    } catch (err) {
        if (err && err.code === '23505') {
            throw new FinanceOpsError(409, `Số hóa đơn NCC ${invNo} đã tồn tại!`, 'DUPLICATE_INVOICE_NO');
        }
        throw err;
    }
}

async function paySupplierApInvoice(client, {
    tenantId,
    apInvoiceId,
    amount,
    paymentMethod = 'BANK_TRANSFER',
    referenceNo = null,
    note = null,
    paidBy = null,
}) {
    const amt = roundMoney(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
        throw new FinanceOpsError(400, 'Số tiền thanh toán NCC phải lớn hơn 0!', 'INVALID_AMOUNT');
    }

    const invRes = await client.query(
        `SELECT *
           FROM public.supplier_ap_invoices
          WHERE id = $1 AND tenant_id = $2
          FOR UPDATE`,
        [Number(apInvoiceId), String(tenantId)]
    );
    const inv = invRes.rows[0];
    if (!inv) {
        throw new FinanceOpsError(404, 'Không tìm thấy hóa đơn công nợ NCC!', 'AP_INVOICE_NOT_FOUND');
    }

    const totalAmount = roundMoney(inv.total_amount);
    const prevPaid = roundMoney(inv.paid_amount);
    const nextPaid = roundMoney(prevPaid + amt);

    if (nextPaid > totalAmount) {
        throw new FinanceOpsError(
            409,
            `Số tiền thanh toán (${amt}) vượt quá phần còn nợ (${roundMoney(totalAmount - prevPaid)})!`,
            'AP_OVERPAYMENT_NOT_ALLOWED'
        );
    }

    const nextStatus = nextPaid >= totalAmount ? 'PAID' : 'PARTIAL';

    const payRes = await client.query(
        `INSERT INTO public.supplier_ap_payments
            (tenant_id, ap_invoice_id, amount, payment_method, reference_no, note, paid_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
            String(tenantId),
            inv.id,
            amt,
            String(paymentMethod || 'BANK_TRANSFER').toUpperCase(),
            referenceNo ? String(referenceNo) : null,
            note ? String(note) : null,
            paidBy ? String(paidBy) : null,
        ]
    );

    const updRes = await client.query(
        `UPDATE public.supplier_ap_invoices
            SET paid_amount = $1, status = $2, updated_at = now()
          WHERE id = $3 AND tenant_id = $4
          RETURNING *`,
        [nextPaid, nextStatus, inv.id, String(tenantId)]
    );

    return { invoice: updRes.rows[0], payment: payRes.rows[0] };
}

async function listSupplierApInvoices(client, { tenantId, status = null }) {
    const cleanStatus = status ? String(status).trim().toUpperCase() : null;
    const res = await client.query(
        `SELECT *
           FROM public.supplier_ap_invoices
          WHERE tenant_id = $1
            AND ($2::text IS NULL OR status = $2)
          ORDER BY created_at DESC, id DESC`,
        [String(tenantId), cleanStatus]
    );
    return res.rows;
}

module.exports = {
    FinanceOpsError,
    roundMoney,
    createHouseAccount,
    listHouseAccounts,
    chargeHouseAccount,
    repayHouseAccount,
    getHouseAccountStatement,
    createVietQrPaymentAttempt,
    resolveActiveVietQrAttempt,
    verifyStaffPin,
    performDualPinShiftHandover,
    computeAggregatorSettlement,
    createAggregatorSettlement,
    listAggregatorSettlements,
    createSupplierApInvoice,
    paySupplierApInvoice,
    listSupplierApInvoices,
};
