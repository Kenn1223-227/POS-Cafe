'use strict';

const {
    PriceBookZnsError,
    createPriceBook,
    upsertPriceBookItems,
    listPriceBooks,
    resolveProductPriceFromDb,
    enqueueZnsMessage,
    processZnsOutboxBatch,
    startBidaSession,
    pauseBidaSession,
    resumeBidaSession,
    closeBidaSession,
} = require('./priceBookAndZnsService');

function sendPbError(res, err, fallbackMessage) {
    if (err instanceof PriceBookZnsError) {
        return res.status(err.status).json({
            message: err.message,
            code: err.code,
            ...(err.details ? { details: err.details } : {}),
        });
    }
    return res.status(500).json({ message: fallbackMessage, error: err?.message || String(err) });
}

function registerPriceBookAndZnsRoutes(app, deps) {
    const {
        chayGiaoDich,
        kiemTraToken,
        choPhepVaiTro,
        yeuCauTinhNang,
        layTenantId,
        layChiNhanhHienTai,
    } = deps;
    const gate = (flag) => (typeof yeuCauTinhNang === 'function' ? yeuCauTinhNang(flag) : (_req, _res, next) => next());
    const gatePriceBooks = gate('aggregator_hub');
    const gateZns = gate('crm_tiers');
    const gateBida = gate('horizontal_fnb');

    // -------------------------------------------------------------------------
    // 1. PRICE BOOKS ĐA KÊNH
    // -------------------------------------------------------------------------
    app.get('/api/price-books', kiemTraToken, choPhepVaiTro(1, 4), gatePriceBooks, async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const priceBooks = await chayGiaoDich(
                (client) => listPriceBooks(client, { tenantId, channel: req.query.channel || null }),
                tenantId
            );
            return res.json({ priceBooks });
        } catch (err) {
            return sendPbError(res, err, 'Lỗi tải danh sách bảng giá đa kênh');
        }
    });

    app.post('/api/price-books', kiemTraToken, choPhepVaiTro(1), gatePriceBooks, async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const result = await chayGiaoDich(
                (client) => createPriceBook(client, { ...req.body, tenantId }),
                tenantId
            );
            return res.status(201).json({ message: 'Tạo bảng giá đa kênh thành công!', ...result });
        } catch (err) {
            return sendPbError(res, err, 'Lỗi tạo bảng giá đa kênh');
        }
    });

    app.post('/api/price-books/:id/items', kiemTraToken, choPhepVaiTro(1), gatePriceBooks, async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const items = await chayGiaoDich(
                (client) =>
                    upsertPriceBookItems(client, {
                        tenantId,
                        priceBookId: req.params.id,
                        items: req.body?.items || [],
                    }),
                tenantId
            );
            return res.status(201).json({ message: 'Cập nhật giá món thành công!', items });
        } catch (err) {
            return sendPbError(res, err, 'Lỗi cập nhật giá món theo bảng giá');
        }
    });

    app.get('/api/price-books/resolve', kiemTraToken, gatePriceBooks, async (req, res) => {
        const tenantId = layTenantId(req);
        const maSp = String(req.query.maSp || '').trim();
        if (!maSp) {
            return res.status(400).json({ message: 'Thiếu mã sản phẩm (maSp)!' });
        }
        try {
            const resolved = await chayGiaoDich(
                (client) =>
                    resolveProductPriceFromDb(client, {
                        tenantId,
                        maSp,
                        basePrice: Number(req.query.basePrice || 0),
                        channel: req.query.channel || 'DINE_IN',
                        branchId: req.query.branchId || (layChiNhanhHienTai ? layChiNhanhHienTai(req) : null),
                        atTime: req.query.atTime || null,
                    }),
                tenantId
            );
            return res.json(resolved);
        } catch (err) {
            return sendPbError(res, err, 'Lỗi tính giá hiệu lực theo kênh');
        }
    });

    // -------------------------------------------------------------------------
    // 2. ZALO ZNS OUTBOX WORKER THẬT (NĐ 13/2023)
    // -------------------------------------------------------------------------
    app.get('/api/zns/outbox', kiemTraToken, choPhepVaiTro(1), gateZns, async (req, res) => {
        const tenantId = layTenantId(req);
        const status = req.query.status ? String(req.query.status).toUpperCase() : null;
        try {
            const items = await chayGiaoDich(async (client) => {
                const r = await client.query(
                    `SELECT id, tenant_id, ma_kh, phone, template_id, template_data, purpose,
                            status, retry_count, next_retry_at, provider_msg_id, last_error, sent_at, created_at
                       FROM public.zalo_zns_outbox
                      WHERE COALESCE(NULLIF(tenant_id, ''), tenantid) = $1
                        AND ($2::text IS NULL OR status = $2)
                      ORDER BY created_at DESC, id DESC
                      LIMIT 100`,
                    [String(tenantId), status]
                );
                return r.rows;
            }, tenantId);
            return res.json({
                providerMode: String(process.env.ZNS_PROVIDER_MODE || 'mock').toLowerCase(),
                items,
            });
        } catch (err) {
            return sendPbError(res, err, 'Lỗi tải hàng đợi Zalo ZNS');
        }
    });

    app.post('/api/zns/outbox', kiemTraToken, choPhepVaiTro(1, 4), gateZns, async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const item = await chayGiaoDich(
                (client) => enqueueZnsMessage(client, { ...req.body, tenantId }),
                tenantId
            );
            return res.status(201).json({ message: 'Đã đưa tin nhắn Zalo ZNS vào hàng đợi!', item });
        } catch (err) {
            return sendPbError(res, err, 'Lỗi đưa tin Zalo ZNS vào hàng đợi');
        }
    });

    app.post('/api/zns/outbox/process', kiemTraToken, choPhepVaiTro(1), gateZns, async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const summary = await chayGiaoDich(
                (client) =>
                    processZnsOutboxBatch(client, {
                        tenantId,
                        limit: req.body?.limit || 20,
                        providerMode: req.body?.providerMode || process.env.ZNS_PROVIDER_MODE || 'mock',
                    }),
                tenantId
            );
            return res.json({ message: 'Chạy Zalo ZNS Worker hoàn tất!', ...summary });
        } catch (err) {
            return sendPbError(res, err, 'Lỗi chạy Zalo ZNS Worker');
        }
    });

    // -------------------------------------------------------------------------
    // 3. BIDA TIME-BILLING SESSIONS
    // -------------------------------------------------------------------------
    app.get('/api/bida/sessions', kiemTraToken, choPhepVaiTro(1, 3, 4), gateBida, async (req, res) => {
        const tenantId = layTenantId(req);
        const status = req.query.status ? String(req.query.status).toUpperCase() : null;
        try {
            const sessions = await chayGiaoDich(async (client) => {
                const r = await client.query(
                    `SELECT *
                       FROM public.bida_sessions
                      WHERE tenant_id = $1
                        AND ($2::text IS NULL OR status = $2)
                      ORDER BY started_at DESC, id DESC
                      LIMIT 100`,
                    [String(tenantId), status]
                );
                return r.rows;
            }, tenantId);
            return res.json({ sessions });
        } catch (err) {
            return sendPbError(res, err, 'Lỗi tải danh sách phiên Bida');
        }
    });

    app.post('/api/bida/sessions/start', kiemTraToken, choPhepVaiTro(1, 3, 4), gateBida, async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = layChiNhanhHienTai ? layChiNhanhHienTai(req) : null;
        try {
            const session = await chayGiaoDich(
                (client) =>
                    startBidaSession(client, {
                        ...req.body,
                        tenantId,
                        branchId: req.body?.branchId || branchId,
                        createdBy: req.user?.maNV || null,
                    }),
                tenantId
            );
            return res.status(201).json({ message: 'Bắt đầu tính giờ Bida thành công!', session });
        } catch (err) {
            return sendPbError(res, err, 'Lỗi bắt đầu phiên Bida');
        }
    });

    app.post('/api/bida/sessions/:id/pause', kiemTraToken, choPhepVaiTro(1, 3, 4), gateBida, async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const session = await chayGiaoDich(
                (client) => pauseBidaSession(client, { tenantId, sessionId: req.params.id }),
                tenantId
            );
            return res.json({ message: 'Đã tạm dừng phiên Bida!', session });
        } catch (err) {
            return sendPbError(res, err, 'Lỗi tạm dừng phiên Bida');
        }
    });

    app.post('/api/bida/sessions/:id/resume', kiemTraToken, choPhepVaiTro(1, 3, 4), gateBida, async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const session = await chayGiaoDich(
                (client) => resumeBidaSession(client, { tenantId, sessionId: req.params.id }),
                tenantId
            );
            return res.json({ message: 'Đã tiếp tục phiên Bida!', session });
        } catch (err) {
            return sendPbError(res, err, 'Lỗi tiếp tục phiên Bida');
        }
    });

    app.post('/api/bida/sessions/:id/close', kiemTraToken, choPhepVaiTro(1, 3, 4), gateBida, async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const result = await chayGiaoDich(
                (client) =>
                    closeBidaSession(client, {
                        tenantId,
                        sessionId: req.params.id,
                        endedAt: req.body?.endedAt || null,
                    }),
                tenantId
            );
            return res.json({ message: 'Đã chốt giờ Bida thành công!', ...result });
        } catch (err) {
            return sendPbError(res, err, 'Lỗi chốt giờ Bida');
        }
    });
}

module.exports = { registerPriceBookAndZnsRoutes };
