'use strict';

const {
    HrPayrollError,
    createTipPoolEntry,
    distributeAndSaveTipPool,
    listTipPools,
    createOvertimeLog,
    listOvertimeLogs,
    getHourlySalesVsLabor,
} = require('./hrPayrollTipsService');

function sendHrError(res, err, fallbackMessage) {
    if (err instanceof HrPayrollError) {
        return res.status(err.status).json({ message: err.message, code: err.code });
    }
    return res.status(500).json({ message: fallbackMessage, error: err?.message || String(err) });
}

function registerHrPayrollTipsRoutes(app, deps) {
    const {
        chayGiaoDich,
        chayTruyVanBaoCao,
        kiemTraToken,
        choPhepVaiTro,
        layTenantId,
        layChiNhanhHienTai,
    } = deps;

    // -------------------------------------------------------------------------
    // 1. TIP POOL (QUỸ TIP & PHÂN BỔ LỆCH 0Đ)
    // -------------------------------------------------------------------------
    app.get('/api/hr/tip-pools', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const pools = await chayGiaoDich(
                (client) =>
                    listTipPools(client, {
                        tenantId,
                        fromDate: req.query.fromDate || null,
                        toDate: req.query.toDate || null,
                    }),
                tenantId
            );
            return res.json({ tipPools: pools });
        } catch (err) {
            return sendHrError(res, err, 'Lỗi tải danh sách Tip Pool');
        }
    });

    app.post('/api/hr/tip-pools', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = layChiNhanhHienTai ? layChiNhanhHienTai(req) : null;
        try {
            const result = await chayGiaoDich(
                (client) =>
                    createTipPoolEntry(client, {
                        ...req.body,
                        tenantId,
                        branchId: req.body?.branchId || branchId,
                        createdBy: req.user?.maNV || null,
                    }),
                tenantId
            );
            return res.status(201).json({ message: 'Tạo quỹ Tip Pool thành công!', ...result });
        } catch (err) {
            return sendHrError(res, err, 'Lỗi tạo quỹ Tip Pool');
        }
    });

    app.post('/api/hr/tip-pools/:id/distribute', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const result = await chayGiaoDich(
                (client) =>
                    distributeAndSaveTipPool(client, {
                        tenantId,
                        tipPoolId: req.params.id,
                        participants: req.body?.participants || [],
                        method: req.body?.allocationMethod || req.body?.method || null,
                    }),
                tenantId
            );
            return res.json({ message: 'Phân bổ Tip Pool thành công!', ...result });
        } catch (err) {
            return sendHrError(res, err, 'Lỗi phân bổ Tip Pool');
        }
    });

    // -------------------------------------------------------------------------
    // 2. TĂNG CA OT 150% / 200% / 300% + PHỤ CẤP CA ĐÊM
    // -------------------------------------------------------------------------
    app.get('/api/hr/ot-logs', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const logs = await chayGiaoDich(
                (client) =>
                    listOvertimeLogs(client, {
                        tenantId,
                        fromDate: req.query.fromDate || null,
                        toDate: req.query.toDate || null,
                        maNV: req.query.maNV || null,
                    }),
                tenantId
            );
            return res.json({ logs });
        } catch (err) {
            return sendHrError(res, err, 'Lỗi tải nhật ký tăng ca OT');
        }
    });

    app.post('/api/hr/ot-logs', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = layChiNhanhHienTai ? layChiNhanhHienTai(req) : null;
        try {
            const result = await chayGiaoDich(
                (client) =>
                    createOvertimeLog(client, {
                        ...req.body,
                        tenantId,
                        branchId: req.body?.branchId || branchId,
                        approvedBy: req.body?.approvedBy || req.user?.maNV || null,
                    }),
                tenantId
            );
            return res.status(201).json({ message: 'Lưu nhật ký tăng ca OT thành công!', ...result });
        } catch (err) {
            return sendHrError(res, err, 'Lỗi lưu nhật ký tăng ca OT');
        }
    });

    // -------------------------------------------------------------------------
    // 3. ANALYTICS: HOURLY SALES VS. LABOR COST %
    // -------------------------------------------------------------------------
    app.get('/api/analytics/hourly-sales-vs-labor', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const runReadOnly = (fn) =>
                typeof chayTruyVanBaoCao === 'function'
                    ? chayTruyVanBaoCao(tenantId, fn)
                    : chayGiaoDich(fn, tenantId);
            const analytics = await runReadOnly((client) =>
                getHourlySalesVsLabor(client, {
                    tenantId,
                    branchId: req.query.branchId || null,
                    fromDate: req.query.fromDate || req.query.tuNgay || null,
                    toDate: req.query.toDate || req.query.denNgay || null,
                })
            );
            return res.json(analytics);
        } catch (err) {
            return sendHrError(res, err, 'Lỗi tổng hợp biểu đồ Doanh thu theo giờ vs Chi phí nhân công');
        }
    });
}

module.exports = { registerHrPayrollTipsRoutes };
