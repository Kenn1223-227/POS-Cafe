'use strict';

const {
    FinanceOpsError,
    createHouseAccount,
    listHouseAccounts,
    chargeHouseAccount,
    repayHouseAccount,
    getHouseAccountStatement,
    createVietQrPaymentAttempt,
    resolveActiveVietQrAttempt,
    performDualPinShiftHandover,
    createAggregatorSettlement,
    listAggregatorSettlements,
    createSupplierApInvoice,
    paySupplierApInvoice,
    listSupplierApInvoices,
} = require('./chainFinanceOpsService');

function sendFinanceError(res, err, fallbackMessage) {
    if (err instanceof FinanceOpsError) {
        return res.status(err.status).json({
            message: err.message,
            code: err.code,
            ...(err.details ? { details: err.details } : {}),
        });
    }
    return res.status(500).json({ message: fallbackMessage, error: err?.message || String(err) });
}

function registerChainFinanceOpsRoutes(app, deps) {
    const {
        chayGiaoDich,
        kiemTraToken,
        choPhepVaiTro,
        layTenantId,
        layChiNhanhHienTai,
        ghiAuditLog,
    } = deps;

    // -------------------------------------------------------------------------
    // 1. HOUSE ACCOUNTS B2B
    // -------------------------------------------------------------------------
    app.get('/api/finance/house-accounts', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const accounts = await chayGiaoDich(
                (client) => listHouseAccounts(client, { tenantId, activeOnly: req.query.activeOnly === 'true' }),
                tenantId
            );
            return res.json({ accounts });
        } catch (err) {
            return sendFinanceError(res, err, 'Lỗi tải danh sách công nợ B2B');
        }
    });

    app.post('/api/finance/house-accounts', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = layChiNhanhHienTai ? layChiNhanhHienTai(req) : null;
        try {
            const account = await chayGiaoDich(
                (client) => createHouseAccount(client, { ...req.body, tenantId, branchId: req.body?.branchId || branchId }),
                tenantId
            );
            return res.status(201).json({ message: 'Tạo tài khoản công nợ B2B thành công!', account });
        } catch (err) {
            return sendFinanceError(res, err, 'Lỗi tạo tài khoản công nợ B2B');
        }
    });

    app.post('/api/finance/house-accounts/:id/charge', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const result = await chayGiaoDich(
                (client) =>
                    chargeHouseAccount(client, {
                        tenantId,
                        houseAccountId: req.params.id,
                        amount: req.body?.amount,
                        maHoaDon: req.body?.maHoaDon,
                        note: req.body?.note,
                        createdBy: req.user?.maNV || null,
                    }),
                tenantId
            );
            return res.status(201).json({ message: 'Ghi nợ B2B thành công!', ...result });
        } catch (err) {
            return sendFinanceError(res, err, 'Lỗi ghi nợ công nợ B2B');
        }
    });

    app.post('/api/finance/house-accounts/:id/repayment', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const result = await chayGiaoDich(
                (client) =>
                    repayHouseAccount(client, {
                        tenantId,
                        houseAccountId: req.params.id,
                        amount: req.body?.amount,
                        note: req.body?.note,
                        createdBy: req.user?.maNV || null,
                    }),
                tenantId
            );
            return res.status(201).json({ message: 'Ghi nhận thanh toán công nợ B2B thành công!', ...result });
        } catch (err) {
            return sendFinanceError(res, err, 'Lỗi thanh toán công nợ B2B');
        }
    });

    app.get('/api/finance/house-accounts/:id/statement', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const statement = await chayGiaoDich(
                (client) =>
                    getHouseAccountStatement(client, {
                        tenantId,
                        houseAccountId: req.params.id,
                        from: req.query.from || null,
                        to: req.query.to || null,
                    }),
                tenantId
            );
            return res.json(statement);
        } catch (err) {
            return sendFinanceError(res, err, 'Lỗi xuất sao kê công nợ B2B');
        }
    });

    // -------------------------------------------------------------------------
    // 2. VIETQR PAYMENT ATTEMPTS (TTL 5 PHÚT)
    // -------------------------------------------------------------------------
    app.post('/api/finance/vietqr-attempts', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = layChiNhanhHienTai ? layChiNhanhHienTai(req) : null;
        try {
            const attempt = await chayGiaoDich(
                (client) =>
                    createVietQrPaymentAttempt(client, {
                        tenantId,
                        branchId: req.body?.branchId || branchId,
                        maHoaDon: req.body?.maHoaDon,
                        amount: req.body?.amount,
                        ttlMinutes: req.body?.ttlMinutes || 5,
                        transferCode: req.body?.transferCode || null,
                    }),
                tenantId
            );
            return res.status(201).json({ message: 'Khởi tạo VietQR Attempt (TTL 5 phút) thành công!', attempt });
        } catch (err) {
            return sendFinanceError(res, err, 'Lỗi khởi tạo VietQR Attempt');
        }
    });

    app.get('/api/finance/vietqr-attempts/:transferCode/resolve', kiemTraToken, choPhepVaiTro(1, 2, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const result = await chayGiaoDich(
                (client) =>
                    resolveActiveVietQrAttempt(client, {
                        tenantId,
                        transferCode: req.params.transferCode,
                    }),
                tenantId
            );
            return res.status(result.status).json(result);
        } catch (err) {
            return sendFinanceError(res, err, 'Lỗi kiểm tra VietQR Attempt');
        }
    });

    // -------------------------------------------------------------------------
    // 3. DUAL-PIN SHIFT HANDOVER
    // -------------------------------------------------------------------------
    app.post('/api/shifts/:maCa/handover', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = layChiNhanhHienTai ? layChiNhanhHienTai(req) : null;
        try {
            const result = await chayGiaoDich(
                (client) =>
                    performDualPinShiftHandover(client, {
                        tenantId,
                        branchId: req.body?.branchId || branchId,
                        maCaThuNgan: req.params.maCa,
                        outgoingStaffId: req.body?.outgoingStaffId,
                        outgoingPin: req.body?.outgoingPin,
                        incomingStaffId: req.body?.incomingStaffId,
                        incomingPin: req.body?.incomingPin,
                        expectedCash: req.body?.expectedCash,
                        countedCash: req.body?.countedCash,
                        note: req.body?.note,
                        ip: req.ip || null,
                        ghiAuditLog,
                    }),
                tenantId
            );
            return res.status(201).json({ message: 'Bàn giao ca 2 PIN thành công!', ...result });
        } catch (err) {
            return sendFinanceError(res, err, 'Lỗi bàn giao ca 2 PIN');
        }
    });

    app.get('/api/shifts/:maCa/handovers', kiemTraToken, choPhepVaiTro(1, 2), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const handovers = await chayGiaoDich(async (client) => {
                const r = await client.query(
                    `SELECT *
                       FROM public.shift_handovers
                      WHERE tenant_id = $1 AND ma_ca_thu_ngan = $2
                      ORDER BY handed_over_at DESC`,
                    [String(tenantId), Number(req.params.maCa)]
                );
                return r.rows;
            }, tenantId);
            return res.json({ handovers });
        } catch (err) {
            return sendFinanceError(res, err, 'Lỗi tải lịch sử bàn giao ca');
        }
    });

    // -------------------------------------------------------------------------
    // 4. AGGREGATOR SETTLEMENTS (ĐỐI SOÁT SÀN)
    // -------------------------------------------------------------------------
    app.get('/api/finance/aggregator-settlements', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const settlements = await chayGiaoDich(
                (client) => listAggregatorSettlements(client, { tenantId, platform: req.query.platform || null }),
                tenantId
            );
            return res.json({ settlements });
        } catch (err) {
            return sendFinanceError(res, err, 'Lỗi tải danh sách đối soát sàn');
        }
    });

    app.post('/api/finance/aggregator-settlements', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = layChiNhanhHienTai ? layChiNhanhHienTai(req) : null;
        try {
            const settlement = await chayGiaoDich(
                (client) =>
                    createAggregatorSettlement(client, {
                        ...req.body,
                        tenantId,
                        branchId: req.body?.branchId || branchId,
                        createdBy: req.user?.maNV || null,
                    }),
                tenantId
            );
            return res.status(201).json({ message: 'Lưu kỳ đối soát sàn thành công!', settlement });
        } catch (err) {
            return sendFinanceError(res, err, 'Lỗi tạo kỳ đối soát sàn');
        }
    });

    // -------------------------------------------------------------------------
    // 5. SUPPLIER AP INVOICES & PAYMENTS (CÔNG NỢ NCC)
    // -------------------------------------------------------------------------
    app.get('/api/finance/supplier-ap', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const invoices = await chayGiaoDich(
                (client) => listSupplierApInvoices(client, { tenantId, status: req.query.status || null }),
                tenantId
            );
            return res.json({ invoices });
        } catch (err) {
            return sendFinanceError(res, err, 'Lỗi tải công nợ nhà cung cấp');
        }
    });

    app.post('/api/finance/supplier-ap', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = layChiNhanhHienTai ? layChiNhanhHienTai(req) : null;
        try {
            const invoice = await chayGiaoDich(
                (client) =>
                    createSupplierApInvoice(client, {
                        ...req.body,
                        tenantId,
                        branchId: req.body?.branchId || branchId,
                        createdBy: req.user?.maNV || null,
                    }),
                tenantId
            );
            return res.status(201).json({ message: 'Tạo hóa đơn công nợ NCC thành công!', invoice });
        } catch (err) {
            return sendFinanceError(res, err, 'Lỗi tạo hóa đơn công nợ NCC');
        }
    });

    app.post('/api/finance/supplier-ap/:id/payments', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const result = await chayGiaoDich(
                (client) =>
                    paySupplierApInvoice(client, {
                        tenantId,
                        apInvoiceId: req.params.id,
                        amount: req.body?.amount,
                        paymentMethod: req.body?.paymentMethod,
                        referenceNo: req.body?.referenceNo,
                        note: req.body?.note,
                        paidBy: req.user?.maNV || null,
                    }),
                tenantId
            );
            return res.status(201).json({ message: 'Ghi nhận thanh toán công nợ NCC thành công!', ...result });
        } catch (err) {
            return sendFinanceError(res, err, 'Lỗi thanh toán công nợ NCC');
        }
    });
}

module.exports = { registerChainFinanceOpsRoutes };
