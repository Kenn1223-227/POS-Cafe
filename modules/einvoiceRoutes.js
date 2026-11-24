const {
    DEFAULT_TAX_CATEGORIES,
    issueEInvoiceForOrder,
    processPendingEInvoices,
} = require('./vnTaxAndEInvoiceService');

function registerEInvoiceRoutes(app, deps) {
    const {
        pool,
        chayGiaoDich,
        kiemTraToken,
        choPhepVaiTro,
        layTenantId,
        layChiNhanhHienTai,
    } = deps;

    // 1. Danh mục nhóm thuế VAT của Tenant
    app.get('/api/tax/categories', kiemTraToken, async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const rows = await chayGiaoDich(async (client) => {
                const r = await client.query(
                    `SELECT id, code, name, vat_rate, is_kct, effective_from, effective_to, is_default
                       FROM public.tax_categories
                      WHERE tenant_id = $1
                      ORDER BY is_default DESC, vat_rate ASC, effective_from DESC`,
                    [tenantId]
                );
                return r.rows;
            });
            return res.json({
                categories: rows.length > 0 ? rows : Object.values(DEFAULT_TAX_CATEGORIES),
                defaults: Object.values(DEFAULT_TAX_CATEGORIES),
            });
        } catch (err) {
            return res.status(500).json({ message: 'Lỗi đọc danh mục thuế VAT', error: err.message });
        }
    });

    app.post('/api/tax/categories', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const {
            code,
            name,
            vatRate,
            isKct = false,
            effectiveFrom = null,
            effectiveTo = null,
            isDefault = false,
        } = req.body || {};

        const cleanCode = String(code || '').trim().toUpperCase();
        const cleanName = String(name || '').trim();
        const rateNum = Number(vatRate);

        if (!cleanCode || !cleanName) {
            return res.status(400).json({ message: 'Thiếu mã nhóm thuế (code) hoặc tên nhóm thuế (name)!' });
        }
        if (![0, 5, 8, 10].includes(rateNum)) {
            return res.status(400).json({ message: 'Thuế suất VAT Việt Nam hợp lệ chỉ thuộc: 0, 5, 8, 10!' });
        }

        try {
            const saved = await chayGiaoDich(async (client) => {
                if (isDefault) {
                    await client.query(
                        `UPDATE public.tax_categories SET is_default = FALSE WHERE tenant_id = $1`,
                        [tenantId]
                    );
                }
                const ins = await client.query(
                    `INSERT INTO public.tax_categories
                        (tenant_id, code, name, vat_rate, is_kct, effective_from, effective_to, is_default)
                     VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7::date, $8)
                     ON CONFLICT (tenant_id, code, effective_from) DO UPDATE
                         SET name = EXCLUDED.name,
                             vat_rate = EXCLUDED.vat_rate,
                             is_kct = EXCLUDED.is_kct,
                             effective_to = EXCLUDED.effective_to,
                             is_default = EXCLUDED.is_default
                     RETURNING *`,
                    [
                        tenantId,
                        cleanCode,
                        cleanName,
                        rateNum,
                        Boolean(isKct),
                        effectiveFrom,
                        effectiveTo,
                        Boolean(isDefault),
                    ]
                );
                return ins.rows[0];
            });
            return res.status(201).json({ message: 'Lưu nhóm thuế VAT thành công!', category: saved });
        } catch (err) {
            return res.status(500).json({ message: 'Lỗi lưu nhóm thuế VAT', error: err.message });
        }
    });

    // 2. Danh sách HĐĐT nội bộ
    app.get('/api/einvoices', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const status = req.query.status ? String(req.query.status).toUpperCase() : null;
        const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
        try {
            const rows = await chayGiaoDich(async (client) => {
                const r = await client.query(
                    `SELECT *
                       FROM public.einvoices
                      WHERE tenant_id = $1
                        AND ($2::text IS NULL OR status = $2)
                      ORDER BY created_at DESC
                      LIMIT $3`,
                    [tenantId, status, limit]
                );
                return r.rows;
            });
            return res.json({ einvoices: rows });
        } catch (err) {
            return res.status(500).json({ message: 'Lỗi tải danh sách hóa đơn điện tử', error: err.message });
        }
    });

    // 3. Phát hành HĐĐT cho 1 hóa đơn POS
    app.post('/api/einvoices/:maHoaDon/issue', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
        const tenantId = layTenantId(req);
        const branchId = typeof layChiNhanhHienTai === 'function' ? layChiNhanhHienTai(req) : 'CN01';
        const { maHoaDon } = req.params;
        const {
            buyerTaxCode,
            buyerCompanyName,
            buyerAddress,
            buyerEmail,
            provider,
            immediate = true,
        } = req.body || {};

        try {
            const einvoice = await chayGiaoDich(async (client) => {
                return issueEInvoiceForOrder(client, {
                    tenantId,
                    branchId,
                    maHoaDon,
                    buyer: {
                        taxCode: buyerTaxCode,
                        companyName: buyerCompanyName,
                        address: buyerAddress,
                        email: buyerEmail,
                    },
                    provider,
                    immediate: Boolean(immediate),
                });
            });
            return res.json({ message: 'Đã xử lý phát hành hóa đơn điện tử!', einvoice });
        } catch (err) {
            return res.status(err.statusCode || 400).json({
                message: err.message || 'Lỗi phát hành hóa đơn điện tử',
            });
        }
    });

    // 4. Chạy Outbox Worker xử lý hàng đợi phát hành / điều chỉnh HĐĐT
    app.post('/api/einvoices/process-queue', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
        const tenantId = layTenantId(req);
        const { limit = 20, provider = null } = req.body || {};
        try {
            const processed = await chayGiaoDich(async (client) => {
                return processPendingEInvoices(client, {
                    tenantId,
                    limit,
                    providerOverride: provider,
                });
            });
            return res.json({
                message: `Đã xử lý ${processed.length} hóa đơn điện tử trong hàng đợi`,
                count: processed.length,
                einvoices: processed,
            });
        } catch (err) {
            return res.status(500).json({ message: 'Lỗi chạy hàng đợi HĐĐT', error: err.message });
        }
    });

    // 5. Public Self-Service E-Invoice QR Lookup (không cần JWT, dùng RPC SECURITY DEFINER)
    app.get('/api/public/einvoice/:lookupCode', async (req, res) => {
        const lookupCode = String(req.params.lookupCode || '').trim().toUpperCase();
        if (!lookupCode) {
            return res.status(400).json({ message: 'Thiếu mã tra cứu hóa đơn!' });
        }
        try {
            const r = await pool.query(`SELECT * FROM public.fn_public_lookup_einvoice($1)`, [lookupCode]);
            if (r.rows.length === 0) {
                return res.status(404).json({ message: 'Không tìm thấy hóa đơn khớp mã tra cứu!' });
            }
            return res.json({ einvoice: r.rows[0] });
        } catch (err) {
            return res.status(500).json({ message: 'Lỗi tra cứu hóa đơn điện tử', error: err.message });
        }
    });

    // 6. Public Self-Service E-Invoice Request (không cần JWT, dùng RPC SECURITY DEFINER)
    app.post('/api/public/einvoice/request', async (req, res) => {
        const {
            lookupCode,
            buyerTaxCode = '',
            buyerCompanyName = '',
            buyerAddress = '',
            buyerEmail = '',
        } = req.body || {};

        const cleanCode = String(lookupCode || '').trim().toUpperCase();
        if (!cleanCode) {
            return res.status(400).json({ message: 'Vui lòng cung cấp mã tra cứu hóa đơn (lookupCode)!' });
        }
        if (!String(buyerCompanyName || '').trim() && !String(buyerTaxCode || '').trim()) {
            return res.status(400).json({ message: 'Vui lòng nhập tên đơn vị hoặc mã số thuế!' });
        }

        try {
            const r = await pool.query(
                `SELECT * FROM public.fn_public_request_einvoice($1, $2, $3, $4, $5)`,
                [cleanCode, buyerTaxCode, buyerCompanyName, buyerAddress, buyerEmail]
            );
            return res.json({
                message: r.rows[0]?.already_issued
                    ? 'Hóa đơn điện tử đã được phát hành trước đó!'
                    : 'Đã tiếp nhận yêu cầu xuất hóa đơn điện tử vào hàng đợi phát hành!',
                einvoice: r.rows[0] || null,
            });
        } catch (err) {
            return res.status(400).json({ message: err.message || 'Không thể tiếp nhận yêu cầu xuất HĐĐT' });
        }
    });
}

module.exports = { registerEInvoiceRoutes };
