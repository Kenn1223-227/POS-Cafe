const crypto = require('crypto');

const DEFAULT_TAX_CATEGORIES = {
    VAT_8_FB: { code: 'VAT_8_FB', name: 'Thuế GTGT 8% (F&B)', vatRate: 8, isKct: false, isDefault: true },
    VAT_10_STD: { code: 'VAT_10_STD', name: 'Thuế GTGT 10% (Bia/Rượu/Tiêu chuẩn)', vatRate: 10, isKct: false, isDefault: false },
    VAT_5: { code: 'VAT_5', name: 'Thuế GTGT 5%', vatRate: 5, isKct: false, isDefault: false },
    VAT_0: { code: 'VAT_0', name: 'Thuế GTGT 0%', vatRate: 0, isKct: false, isDefault: false },
    KCT: { code: 'KCT', name: 'Không chịu thuế (KCT)', vatRate: 0, isKct: true, isDefault: false },
};

function roundVnd(val) {
    return Math.round(Number(val || 0));
}

function generateEInvoiceLookupCode() {
    return `EINV${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

/**
 * Nghị định 13/2023/NĐ-CP: Che số điện thoại khách hàng đối với nhân viên không phải Quản lý (vaiTro !== 1).
 * Giữ 4 ký tự đầu và 3 ký tự cuối: 0905123892 -> 0905***892.
 */
function maskPhoneForRole(sdt, vaiTro) {
    if (sdt === null || sdt === undefined) return '';
    const raw = String(sdt).trim();
    if (!raw) return '';
    if (Number(vaiTro) === 1) return raw;
    if (raw.length < 7) {
        if (raw.length <= 2) return '***';
        return `${raw.slice(0, 1)}***${raw.slice(-1)}`;
    }
    return `${raw.slice(0, 4)}***${raw.slice(-3)}`;
}

/**
 * Tính thuế GTGT đa mức Việt Nam (0%, 5%, 8%, 10%, KCT) chuẩn kế toán & HĐĐT Máy Tính Tiền:
 *  1. Phân bổ chiết khấu cấp hóa đơn (Voucher/Điểm) Pro-rata về từng dòng món (dòng cuối gánh dư làm tròn => lệch 0đ).
 *  2. Phí phục vụ (serviceChargePct) tính trên doanh thu sau giảm giá và cộng vào bucket serviceChargeVatRate (mặc định 8%).
 *  3. Hỗ trợ cả EXCLUDED (chưa gồm thuế) và INCLUDED (đã gồm thuế) với totalBeforeTax + totalTax === grandTotal (lệch 0đ).
 */
function calculateMixedRateVietnamTax({
    items = [],
    orderDiscountTotal = 0,
    serviceChargePct = 0,
    serviceChargeVatRate = 8,
    taxMode = 'EXCLUDED',
} = {}) {
    const mode = String(taxMode || 'EXCLUDED').toUpperCase() === 'INCLUDED' ? 'INCLUDED' : 'EXCLUDED';
    const normalizedItems = (Array.isArray(items) ? items : []).map((it, idx) => {
        const qty = Math.max(0, Number(it?.qty ?? it?.soLuong ?? 1));
        const unitPrice = Math.max(0, Number(it?.unitPrice ?? it?.donGia ?? 0));
        const rawGross =
            it?.lineAmount !== undefined && it?.lineAmount !== null
                ? Number(it.lineAmount)
                : qty * unitPrice;
        const grossAmount = Math.max(0, roundVnd(rawGross));
        const code = String(it?.taxCategoryCode || it?.tax_category_code || 'VAT_8_FB').toUpperCase();
        const fallbackCat = DEFAULT_TAX_CATEGORIES[code] || DEFAULT_TAX_CATEGORIES.VAT_8_FB;
        const isKct = Boolean(it?.isKct ?? it?.is_kct ?? fallbackCat.isKct);
        const vatRate = isKct
            ? 0
            : Number(
                  it?.vatRate !== undefined && it?.vatRate !== null
                      ? it.vatRate
                      : fallbackCat.vatRate
              );
        return {
            ...it,
            _index: idx,
            taxCategoryCode: code,
            vatRate,
            isKct,
            grossAmount,
        };
    });

    const totalGross = normalizedItems.reduce((s, it) => s + it.grossAmount, 0);
    const appliedDiscount = Math.min(totalGross, Math.max(0, roundVnd(orderDiscountTotal)));

    // Bước 1: Phân bổ chiết khấu Pro-rata theo tỷ trọng grossAmount, dòng dương cuối cùng gánh phần dư làm tròn
    let allocatedSoFar = 0;
    const positiveIndices = normalizedItems
        .map((it, i) => (it.grossAmount > 0 ? i : -1))
        .filter((i) => i >= 0);
    const lastPositiveIdx = positiveIndices.length > 0 ? positiveIndices[positiveIndices.length - 1] : -1;

    const itemsAfterDiscount = normalizedItems.map((it, idx) => {
        let allocatedDiscount = 0;
        if (appliedDiscount > 0 && totalGross > 0 && it.grossAmount > 0) {
            if (idx === lastPositiveIdx) {
                allocatedDiscount = Math.min(it.grossAmount, Math.max(0, appliedDiscount - allocatedSoFar));
            } else {
                allocatedDiscount = Math.min(
                    it.grossAmount,
                    roundVnd((appliedDiscount * it.grossAmount) / totalGross)
                );
                allocatedSoFar += allocatedDiscount;
            }
        }
        const netAmount = Math.max(0, it.grossAmount - allocatedDiscount);
        return {
            ...it,
            allocatedDiscount,
            netAmount,
        };
    });

    const netAfterDiscount = itemsAfterDiscount.reduce((s, it) => s + it.netAmount, 0);

    // Bước 2: Phí phục vụ tính trên doanh thu sau giảm giá
    const svcPct = Math.max(0, Number(serviceChargePct || 0));
    const svcVatRate = Number(serviceChargeVatRate ?? 8);
    const serviceChargeAmt = svcPct > 0 ? roundVnd((netAfterDiscount * svcPct) / 100) : 0;

    // Bước 3: Gom theo từng Tax Bucket (vatRate + isKct) và tính thuế cho từng dòng
    const bucketMap = new Map();
    const ensureBucket = (vatRate, isKct) => {
        const key = isKct ? 'KCT' : `VAT_${vatRate}`;
        if (!bucketMap.has(key)) {
            bucketMap.set(key, {
                vatRate: isKct ? 0 : Number(vatRate),
                isKct: Boolean(isKct),
                rawSum: 0,
            });
        }
        return bucketMap.get(key);
    };

    const detailedItems = itemsAfterDiscount.map((it) => {
        const b = ensureBucket(it.vatRate, it.isKct);
        b.rawSum += it.netAmount;

        let taxableBase = 0;
        let vatAmount = 0;
        if (it.isKct || it.vatRate === 0) {
            taxableBase = it.netAmount;
            vatAmount = 0;
        } else if (mode === 'INCLUDED') {
            taxableBase = roundVnd(it.netAmount / (1 + it.vatRate / 100));
            vatAmount = it.netAmount - taxableBase;
        } else {
            taxableBase = it.netAmount;
            vatAmount = roundVnd((it.netAmount * it.vatRate) / 100);
        }

        return {
            ...it,
            taxableBase,
            vatAmount,
        };
    });

    if (serviceChargeAmt > 0) {
        const svcBucket = ensureBucket(svcVatRate, false);
        svcBucket.rawSum += serviceChargeAmt;
    }

    const taxBreakdown = [...bucketMap.values()]
        .map((b) => {
            let taxableBase = 0;
            let vatAmount = 0;
            if (b.isKct || b.vatRate === 0) {
                taxableBase = b.rawSum;
                vatAmount = 0;
            } else if (mode === 'INCLUDED') {
                taxableBase = roundVnd(b.rawSum / (1 + b.vatRate / 100));
                vatAmount = b.rawSum - taxableBase;
            } else {
                taxableBase = b.rawSum;
                vatAmount = roundVnd((b.rawSum * b.vatRate) / 100);
            }
            return {
                vatRate: b.vatRate,
                isKct: b.isKct,
                taxableBase,
                vatAmount,
            };
        })
        .sort((a, b) => {
            if (a.isKct !== b.isKct) return a.isKct ? -1 : 1;
            return a.vatRate - b.vatRate;
        });

    const totalBeforeTax = taxBreakdown.reduce((s, b) => s + b.taxableBase, 0);
    const totalTax = taxBreakdown.reduce((s, b) => s + b.vatAmount, 0);
    const grandTotal = totalBeforeTax + totalTax;

    return {
        taxMode: mode,
        totalGross,
        orderDiscountTotal: appliedDiscount,
        netAfterDiscount,
        serviceChargePct: svcPct,
        serviceChargeVatRate: svcVatRate,
        serviceChargeAmt,
        totalBeforeTax,
        totalTax,
        grandTotal,
        taxBreakdown,
        items: detailedItems,
    };
}

async function loadTenantTaxCategoryMap(client, tenantId = 'DEFAULT') {
    const map = new Map();
    for (const [code, def] of Object.entries(DEFAULT_TAX_CATEGORIES)) {
        map.set(code, { ...def });
    }
    try {
        await client.query('SAVEPOINT sp_load_tax_cats');
        const res = await client.query(
            `SELECT code, name, vat_rate, is_kct, effective_from, effective_to, is_default
               FROM public.tax_categories
              WHERE tenant_id = $1
                AND effective_from <= CURRENT_DATE
                AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
              ORDER BY effective_from ASC`,
            [tenantId]
        );
        await client.query('RELEASE SAVEPOINT sp_load_tax_cats');
        for (const r of res.rows) {
            const code = String(r.code || '').toUpperCase();
            if (!code) continue;
            map.set(code, {
                code,
                name: r.name,
                vatRate: Number(r.vat_rate || 0),
                isKct: Boolean(r.is_kct),
                isDefault: Boolean(r.is_default),
            });
        }
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_load_tax_cats').catch(() => {});
    }
    return map;
}

/**
 * Đọc toàn bộ dòng món hợp lệ của hóa đơn, tính thuế đa mức và lưu snapshot vào
 * ChiTietHoaDon (tax_category_code, tax_rate_snapshot, taxable_base_amount, vat_amount_snapshot)
 * cùng HoaDon (tax_breakdown_json, einvoice_lookup_code).
 */
async function applyMixedRateTaxToOrder(
    client,
    {
        tenantId = 'DEFAULT',
        maHoaDon,
        orderDiscountTotal = null,
        serviceChargePct = null,
        serviceChargeVatRate = 8,
        taxMode = null,
    }
) {
    const hdRes = await client.query(
        `SELECT MaHoaDon,
                COALESCE(TienGiamKM, 0) AS TienGiamKM,
                COALESCE(TienGiamDiem, 0) AS TienGiamDiem,
                COALESCE(to_jsonb(HoaDon)->>'cachtinhthue', 'INCLUDED') AS CachTinhThue,
                COALESCE((to_jsonb(HoaDon)->>'phiphucvuphantram')::numeric, 0) AS PhiPhucVuPhanTram,
                to_jsonb(HoaDon)->>'einvoice_lookup_code' AS einvoice_lookup_code
           FROM public.HoaDon
          WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
        [maHoaDon, tenantId]
    );
    if (hdRes.rows.length === 0) return null;
    const hd = hdRes.rows[0];

    const taxCatMap = await loadTenantTaxCategoryMap(client, tenantId);

    const monRes = await client.query(
        `SELECT c.MaCTHD, c.MaMon, c.SoLuong, c.DonGia,
                COALESCE((to_jsonb(c)->>'giagiam')::numeric, 0) AS GiaGiam,
                COALESCE((to_jsonb(c)->>'giamodifiers')::numeric, 0) AS GiaModifiers,
                COALESCE((to_jsonb(c)->>'chietkhaumon')::numeric, 0) AS ChietKhauMon,
                COALESCE((to_jsonb(c)->>'lamontang')::boolean, FALSE) AS LaMonTang,
                COALESCE(
                    NULLIF(to_jsonb(s)->>'tax_category_code', ''),
                    NULLIF(to_jsonb(c)->>'tax_category_code', ''),
                    'VAT_8_FB'
                ) AS tax_category_code,
                COALESCE((
                    SELECT SUM(t.SoLuong * t.DonGia)
                      FROM public.ChiTietHoaDon_Topping t
                     WHERE t.MaCTHD = c.MaCTHD
                ), 0) AS TienTopping
           FROM public.ChiTietHoaDon c
           LEFT JOIN public.SanPham s
             ON s.MaMon = c.MaMon AND COALESCE(s.TenantId, 'DEFAULT') = $2
          WHERE c.MaHoaDon = $1 AND c.TrangThaiPhaChe <> 'DaHuy'
          ORDER BY c.MaCTHD ASC`,
        [maHoaDon, tenantId]
    );

    const calcItems = monRes.rows.map((r) => {
        const code = String(r.tax_category_code || 'VAT_8_FB').toUpperCase();
        const cat = taxCatMap.get(code) || DEFAULT_TAX_CATEGORIES.VAT_8_FB;
        const lineAmount = r.lamontang
            ? 0
            : Math.max(
                  0,
                  Number(r.soluong || 0) * (Number(r.dongia || 0) + Number(r.giamodifiers || 0)) +
                      Number(r.tientopping || 0) -
                      Number(r.giagiam || 0) -
                      Number(r.chietkhaumon || 0)
              );
        return {
            maCTHD: r.macthd,
            maMon: r.mamon,
            taxCategoryCode: cat.code,
            vatRate: cat.vatRate,
            isKct: cat.isKct,
            lineAmount,
        };
    });

    const discount =
        orderDiscountTotal !== null
            ? Number(orderDiscountTotal)
            : Number(hd.tiengiamkm || 0) + Number(hd.tiengiamdiem || 0);
    const svcPct =
        serviceChargePct !== null ? Number(serviceChargePct) : Number(hd.phiphucvuphantram || 0);
    const resolvedTaxMode = taxMode || hd.cachtinhthue || 'INCLUDED';

    const taxResult = calculateMixedRateVietnamTax({
        items: calcItems,
        orderDiscountTotal: discount,
        serviceChargePct: svcPct,
        serviceChargeVatRate,
        taxMode: resolvedTaxMode,
    });

    // Lưu snapshot từng dòng món trên ChiTietHoaDon
    await client.query('SAVEPOINT sp_save_item_tax_snap');
    try {
        for (const it of taxResult.items) {
            await client.query(
                `UPDATE public.ChiTietHoaDon
                    SET tax_category_code = $2,
                        tax_rate_snapshot = $3,
                        taxable_base_amount = $4,
                        vat_amount_snapshot = $5
                  WHERE MaCTHD = $1`,
                [it.maCTHD, it.taxCategoryCode, it.vatRate, it.taxableBase, it.vatAmount]
            );
        }
        await client.query('RELEASE SAVEPOINT sp_save_item_tax_snap');
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_save_item_tax_snap').catch(() => {});
    }

    const lookupCode = hd.einvoice_lookup_code || generateEInvoiceLookupCode();

    await client.query('SAVEPOINT sp_save_hd_tax_breakdown');
    try {
        await client.query(
            `UPDATE public.HoaDon
                SET tax_breakdown_json = $2::jsonb,
                    einvoice_lookup_code = COALESCE(einvoice_lookup_code, $3),
                    TienThueVAT = $4
              WHERE MaHoaDon = $1`,
            [maHoaDon, JSON.stringify(taxResult.taxBreakdown), lookupCode, taxResult.totalTax]
        );
        await client.query('RELEASE SAVEPOINT sp_save_hd_tax_breakdown');
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_save_hd_tax_breakdown').catch(() => {});
        await client.query('SAVEPOINT sp_save_hd_tax_breakdown_min');
        try {
            await client.query(
                `UPDATE public.HoaDon
                    SET tax_breakdown_json = $2::jsonb,
                        einvoice_lookup_code = COALESCE(einvoice_lookup_code, $3)
                  WHERE MaHoaDon = $1`,
                [maHoaDon, JSON.stringify(taxResult.taxBreakdown), lookupCode]
            );
            await client.query('RELEASE SAVEPOINT sp_save_hd_tax_breakdown_min');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_save_hd_tax_breakdown_min').catch(() => {});
        }
    }

    return {
        ...taxResult,
        lookupCode,
    };
}

// =============================================================================
// KIẾN TRÚC E-INVOICE PROVIDER ADAPTER (HĐĐT MÁY TÍNH TIỀN - NĐ 123 / TT 78)
// =============================================================================
class EInvoiceProviderAdapter {
    constructor(providerName, config = {}) {
        this.providerName = providerName;
        this.config = config;
    }
    async issueInvoice(_payload) {
        throw new Error(`${this.providerName}: issueInvoice chưa được triển khai`);
    }
    async issueAdjustment(_payload) {
        throw new Error(`${this.providerName}: issueAdjustment chưa được triển khai`);
    }
    async cancelInvoice(_payload) {
        throw new Error(`${this.providerName}: cancelInvoice chưa được triển khai`);
    }
    async lookupTaxCode(_taxCode) {
        throw new Error(`${this.providerName}: lookupTaxCode chưa được triển khai`);
    }
}

class MisaMeInvoiceAdapter extends EInvoiceProviderAdapter {
    constructor(config = {}) {
        super('MISA', config);
        this.baseUrl = config.baseUrl || process.env.MISA_EINVOICE_API_URL || '';
        this.appId = config.appId || process.env.MISA_EINVOICE_APP_ID || '';
        this.taxCode = config.taxCode || process.env.MISA_EINVOICE_TAX_CODE || '';
        this.token = config.token || process.env.MISA_EINVOICE_TOKEN || '';
    }

    buildPayload(payload, invoiceType = 'ORIGINAL') {
        return {
            AppID: this.appId,
            TaxCode: this.taxCode,
            RefID: payload.lookupCode,
            InvSeries: payload.invoiceSeries || this.config.invoiceSeries || '1C26MTT',
            InvoiceType: invoiceType,
            OriginalInvoiceNo: payload.parentInvoiceNumber || null,
            BuyerTaxCode: payload.buyerTaxCode || '',
            BuyerLegalName: payload.buyerCompanyName || 'Khách lẻ không lấy hóa đơn',
            BuyerAddress: payload.buyerAddress || '',
            BuyerEmail: payload.buyerEmail || '',
            TotalSaleAmount: payload.totalBeforeTax,
            TotalVATAmount: payload.totalTax,
            TotalAmount: payload.totalAmount,
            TaxRateInfo: (payload.taxBreakdown || []).map((b) => ({
                VATRateName: b.isKct ? 'KCT' : `${b.vatRate}%`,
                AmountWithoutVAT: b.taxableBase,
                VATAmount: b.vatAmount,
            })),
        };
    }

    async _post(endpoint, body) {
        if (!this.baseUrl || !this.token) {
            throw new Error('Thiếu cấu hình MISA_EINVOICE_API_URL hoặc MISA_EINVOICE_TOKEN');
        }
        const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.token}`,
            },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.ErrorMessage || data.message || `MISA HTTP ${res.status}`);
        }
        return data;
    }

    async issueInvoice(payload) {
        const body = this.buildPayload(payload, 'ORIGINAL');
        const data = await this._post('/api/v3/itg/invoicepublishing/publish-mtt', body);
        return {
            provider: 'MISA',
            invoiceSeries: data.InvSeries || body.InvSeries,
            invoiceNumber: String(data.InvNo || ''),
            taxAuthorityCode: String(data.TransactionID || data.TaxAuthorityCode || ''),
            rawResponse: data,
        };
    }

    async issueAdjustment(payload) {
        const body = this.buildPayload(payload, 'ADJUSTMENT_DECREASE');
        const data = await this._post('/api/v3/itg/invoicepublishing/adjust-mtt', body);
        return {
            provider: 'MISA',
            invoiceSeries: data.InvSeries || body.InvSeries,
            invoiceNumber: String(data.InvNo || ''),
            taxAuthorityCode: String(data.TransactionID || data.TaxAuthorityCode || ''),
            rawResponse: data,
        };
    }

    async cancelInvoice(payload) {
        return this._post('/api/v3/itg/invoicepublishing/cancel', {
            RefID: payload.lookupCode,
            Reason: payload.reason || 'Hủy hóa đơn',
        });
    }

    async lookupTaxCode(taxCode) {
        if (!this.baseUrl) {
            throw new Error('Thiếu cấu hình MISA_EINVOICE_API_URL');
        }
        const res = await fetch(
            `${this.baseUrl.replace(/\/$/, '')}/api/v3/business/taxcode/${encodeURIComponent(taxCode)}`,
            { headers: { Authorization: `Bearer ${this.token}` } }
        );
        return res.json();
    }
}

class ViettelSInvoiceAdapter extends EInvoiceProviderAdapter {
    constructor(config = {}) {
        super('VIETTEL', config);
        this.baseUrl = config.baseUrl || process.env.VIETTEL_EINVOICE_API_URL || '';
        this.username = config.username || process.env.VIETTEL_EINVOICE_USERNAME || '';
        this.password = config.password || process.env.VIETTEL_EINVOICE_PASSWORD || '';
        this.taxCode = config.taxCode || process.env.VIETTEL_EINVOICE_TAX_CODE || '';
    }

    buildPayload(payload, adjustmentType = '1') {
        return {
            generalInvoiceInfo: {
                invoiceType: '1',
                templateCode: this.config.templateCode || '1/001',
                invoiceSeries: payload.invoiceSeries || this.config.invoiceSeries || 'C26MTT',
                currencyCode: 'VND',
                adjustmentType,
                originalInvoiceId: payload.parentInvoiceNumber || undefined,
                transactionUuid: payload.lookupCode,
            },
            buyerInfo: {
                buyerName: payload.buyerCompanyName || 'Khách lẻ',
                buyerTaxCode: payload.buyerTaxCode || '',
                buyerAddressLine: payload.buyerAddress || '',
                buyerEmail: payload.buyerEmail || '',
            },
            summarizeInfo: {
                totalAmountWithoutTax: payload.totalBeforeTax,
                totalTaxAmount: payload.totalTax,
                totalAmountWithTax: payload.totalAmount,
            },
            taxBreakdowns: (payload.taxBreakdown || []).map((b) => ({
                taxPercentage: b.isKct ? -1 : b.vatRate,
                taxableAmount: b.taxableBase,
                taxAmount: b.vatAmount,
            })),
        };
    }

    async _post(endpoint, body) {
        if (!this.baseUrl || !this.username || !this.password) {
            throw new Error('Thiếu cấu hình VIETTEL_EINVOICE_API_URL / USERNAME / PASSWORD');
        }
        const basicAuth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
        const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Basic ${basicAuth}`,
            },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.description || data.message || `Viettel S-Invoice HTTP ${res.status}`);
        }
        return data;
    }

    async issueInvoice(payload) {
        const body = this.buildPayload(payload, '1');
        const data = await this._post(`/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createInvoice/${this.taxCode}`, body);
        return {
            provider: 'VIETTEL',
            invoiceSeries: data.result?.invoiceSeries || body.generalInvoiceInfo.invoiceSeries,
            invoiceNumber: String(data.result?.invoiceNo || ''),
            taxAuthorityCode: String(data.result?.codeOfTax || data.result?.transactionID || ''),
            rawResponse: data,
        };
    }

    async issueAdjustment(payload) {
        const body = this.buildPayload(payload, '5');
        const data = await this._post(`/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createInvoice/${this.taxCode}`, body);
        return {
            provider: 'VIETTEL',
            invoiceSeries: data.result?.invoiceSeries || body.generalInvoiceInfo.invoiceSeries,
            invoiceNumber: String(data.result?.invoiceNo || ''),
            taxAuthorityCode: String(data.result?.codeOfTax || data.result?.transactionID || ''),
            rawResponse: data,
        };
    }

    async cancelInvoice(payload) {
        return this._post(`/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/cancelTransactionInvoice`, {
            supplierTaxCode: this.taxCode,
            invoiceNo: payload.invoiceNumber,
            additionalReferenceDesc: payload.reason || 'Hủy hóa đơn',
        });
    }

    async lookupTaxCode(taxCode) {
        return { taxCode, provider: 'VIETTEL', status: 'NOT_CONFIGURED' };
    }
}

class MockEInvoiceAdapter extends EInvoiceProviderAdapter {
    constructor(config = {}) {
        super('MOCK', config);
    }

    _generateMockResult(prefix, payload) {
        const yy = String(new Date().getFullYear()).slice(-2);
        const randHex = crypto.randomBytes(4).toString('hex').toUpperCase();
        const seqNum = String(Math.floor(10000000 + Math.random() * 89999999));
        return {
            provider: 'MOCK',
            invoiceSeries: payload.invoiceSeries || `1C${yy}MTT`,
            invoiceNumber: seqNum,
            taxAuthorityCode: `M1-${yy}-${prefix}-${randHex}`,
            rawResponse: {
                mock: true,
                lookupCode: payload.lookupCode,
                invoiceType: prefix === 'ADJ' ? 'ADJUSTMENT_DECREASE' : 'ORIGINAL',
                issuedAt: new Date().toISOString(),
            },
        };
    }

    async issueInvoice(payload) {
        return this._generateMockResult('MTT', payload);
    }

    async issueAdjustment(payload) {
        return this._generateMockResult('ADJ', payload);
    }

    async cancelInvoice(payload) {
        return { cancelled: true, lookupCode: payload.lookupCode, mock: true };
    }

    async lookupTaxCode(taxCode) {
        return {
            taxCode: String(taxCode || '').trim(),
            companyName: `Công ty TNHH Demo (${String(taxCode || '').trim()})`,
            address: '123 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh',
            mock: true,
        };
    }
}

function getEInvoiceAdapter(providerName, config = {}) {
    const requested = String(providerName || process.env.EINVOICE_PROVIDER || 'MOCK').toUpperCase();
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

    if (requested === 'MISA') return new MisaMeInvoiceAdapter(config);
    if (requested === 'VIETTEL') return new ViettelSInvoiceAdapter(config);
    if (requested === 'MOCK') {
        if (isProd && String(process.env.EINVOICE_PROVIDER || '').toLowerCase() !== 'mock') {
            throw new Error('MockEInvoiceAdapter bị cấm ở môi trường production!');
        }
        return new MockEInvoiceAdapter(config);
    }
    throw new Error(`Nhà cung cấp HĐĐT "${requested}" chưa được hỗ trợ!`);
}

async function issueEInvoiceForOrder(
    client,
    {
        tenantId = 'DEFAULT',
        branchId = 'CN01',
        maHoaDon,
        buyer = {},
        provider = null,
        immediate = true,
    }
) {
    // Đảm bảo đã có snapshot thuế đa mức & lookup_code trên HoaDon
    let taxInfo = await applyMixedRateTaxToOrder(client, { tenantId, maHoaDon });
    if (!taxInfo) {
        throw new Error(`Không tìm thấy hóa đơn ${maHoaDon}`);
    }

    const hdRes = await client.query(
        `SELECT MaHoaDon,
                COALESCE(to_jsonb(HoaDon)->>'machinhanh', $3) AS branch_id,
                COALESCE(tax_breakdown_json, '[]'::jsonb) AS tax_breakdown_json,
                einvoice_lookup_code,
                COALESCE(TienThueVAT, 0) AS total_tax,
                COALESCE(TongTienThanhToan, ThanhTien, TongTien, 0) AS total_amount
           FROM public.HoaDon
          WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
        [maHoaDon, tenantId, branchId]
    );
    const hd = hdRes.rows[0];
    const lookupCode = hd.einvoice_lookup_code || taxInfo.lookupCode || generateEInvoiceLookupCode();
    const resolvedProvider = String(provider || process.env.EINVOICE_PROVIDER || 'MOCK').toUpperCase();
    const totalAmount = Number(hd.total_amount || taxInfo.grandTotal || 0);
    const totalTax = Number(taxInfo.totalTax ?? hd.total_tax ?? 0);
    const totalBeforeTax = Math.max(0, roundVnd(totalAmount - totalTax));

    // Kiểm tra xem đã có ORIGINAL chưa hủy cho đơn này chưa
    const existRes = await client.query(
        `SELECT * FROM public.einvoices
          WHERE tenant_id = $1 AND ma_hoa_don = $2
            AND invoice_type = 'ORIGINAL' AND status <> 'CANCELLED'
          LIMIT 1`,
        [tenantId, maHoaDon]
    );

    let einvoiceRow;
    if (existRes.rows.length > 0) {
        einvoiceRow = existRes.rows[0];
        if (einvoiceRow.status === 'ISSUED') {
            return einvoiceRow;
        }
        const upd = await client.query(
            `UPDATE public.einvoices
                SET buyer_tax_code = COALESCE($2, buyer_tax_code),
                    buyer_company_name = COALESCE($3, buyer_company_name),
                    buyer_address = COALESCE($4, buyer_address),
                    buyer_email = COALESCE($5, buyer_email),
                    tax_breakdown_json = $6::jsonb,
                    total_before_tax = $7,
                    total_tax = $8,
                    total_amount = $9,
                    provider = $10,
                    status = 'QUEUED',
                    next_retry_at = now()
              WHERE id = $1
              RETURNING *`,
            [
                einvoiceRow.id,
                buyer.taxCode || buyer.buyerTaxCode || null,
                buyer.companyName || buyer.buyerCompanyName || null,
                buyer.address || buyer.buyerAddress || null,
                buyer.email || buyer.buyerEmail || null,
                JSON.stringify(taxInfo.taxBreakdown),
                totalBeforeTax,
                totalTax,
                totalAmount,
                resolvedProvider,
            ]
        );
        einvoiceRow = upd.rows[0];
    } else {
        const ins = await client.query(
            `INSERT INTO public.einvoices (
                tenant_id, branch_id, ma_hoa_don, lookup_code, provider, invoice_type,
                buyer_tax_code, buyer_company_name, buyer_address, buyer_email,
                tax_breakdown_json, total_before_tax, total_tax, total_amount,
                status, next_retry_at
             ) VALUES ($1, $2, $3, $4, $5, 'ORIGINAL', $6, $7, $8, $9, $10::jsonb, $11, $12, $13, 'QUEUED', now())
             RETURNING *`,
            [
                tenantId,
                hd.branch_id || branchId,
                maHoaDon,
                lookupCode,
                resolvedProvider,
                buyer.taxCode || buyer.buyerTaxCode || null,
                buyer.companyName || buyer.buyerCompanyName || null,
                buyer.address || buyer.buyerAddress || null,
                buyer.email || buyer.buyerEmail || null,
                JSON.stringify(taxInfo.taxBreakdown),
                totalBeforeTax,
                totalTax,
                totalAmount,
            ]
        );
        einvoiceRow = ins.rows[0];
    }

    if (!immediate) return einvoiceRow;

    return dispatchSingleEInvoice(client, einvoiceRow);
}

async function dispatchSingleEInvoice(client, einvoiceRow, providerOverride = null) {
    const adapter = getEInvoiceAdapter(providerOverride || einvoiceRow.provider);
    const payload = {
        lookupCode: einvoiceRow.lookup_code,
        maHoaDon: einvoiceRow.ma_hoa_don,
        buyerTaxCode: einvoiceRow.buyer_tax_code,
        buyerCompanyName: einvoiceRow.buyer_company_name,
        buyerAddress: einvoiceRow.buyer_address,
        buyerEmail: einvoiceRow.buyer_email,
        taxBreakdown: Array.isArray(einvoiceRow.tax_breakdown_json) ? einvoiceRow.tax_breakdown_json : [],
        totalBeforeTax: Number(einvoiceRow.total_before_tax || 0),
        totalTax: Number(einvoiceRow.total_tax || 0),
        totalAmount: Number(einvoiceRow.total_amount || 0),
        invoiceSeries: einvoiceRow.invoice_series,
    };

    try {
        const result =
            einvoiceRow.invoice_type === 'ADJUSTMENT_DECREASE'
                ? await adapter.issueAdjustment(payload)
                : await adapter.issueInvoice(payload);

        const upd = await client.query(
            `UPDATE public.einvoices
                SET status = 'ISSUED',
                    invoice_series = $2,
                    invoice_number = $3,
                    tax_authority_code = $4,
                    provider_response_json = $5::jsonb,
                    last_error = NULL,
                    issued_at = now()
              WHERE id = $1
              RETURNING *`,
            [
                einvoiceRow.id,
                result.invoiceSeries || null,
                result.invoiceNumber || null,
                result.taxAuthorityCode || null,
                JSON.stringify(result.rawResponse || {}),
            ]
        );
        return upd.rows[0];
    } catch (err) {
        const nextRetryCount = Number(einvoiceRow.retry_count || 0) + 1;
        const backoffSec = Math.min(3600, Math.pow(2, nextRetryCount) * 30);
        const upd = await client.query(
            `UPDATE public.einvoices
                SET status = 'FAILED',
                    retry_count = $2,
                    next_retry_at = now() + ($3 || ' seconds')::interval,
                    last_error = $4
              WHERE id = $1
              RETURNING *`,
            [einvoiceRow.id, nextRetryCount, String(backoffSec), String(err.message || err).slice(0, 500)]
        );
        return upd.rows[0];
    }
}

/**
 * Hook hoàn tiền: nếu hóa đơn đã có HĐĐT ORIGINAL ở trạng thái ISSUED,
 * tự động tạo bản ghi ADJUSTMENT_DECREASE (Credit Note) trỏ parent_einvoice_id và đưa vào hàng đợi QUEUED.
 */
async function createAdjustmentDecreaseOnRefund(
    client,
    { tenantId = 'DEFAULT', branchId = 'CN01', maHoaDon, refundAmount = 0, reason = '' }
) {
    const origRes = await client.query(
        `SELECT *
           FROM public.einvoices
          WHERE tenant_id = $1
            AND ma_hoa_don = $2
            AND invoice_type = 'ORIGINAL'
            AND status = 'ISSUED'
          ORDER BY id DESC
          LIMIT 1`,
        [tenantId, maHoaDon]
    );
    if (origRes.rows.length === 0) return null;
    const orig = origRes.rows[0];

    const origTotal = Math.max(1, Number(orig.total_amount || 0));
    const adjTotal = Math.min(origTotal, Math.max(0, roundVnd(refundAmount || origTotal)));
    const ratio = adjTotal / origTotal;
    const adjTax = roundVnd(Number(orig.total_tax || 0) * ratio);
    const adjBeforeTax = Math.max(0, adjTotal - adjTax);

    const origBreakdown = Array.isArray(orig.tax_breakdown_json) ? orig.tax_breakdown_json : [];
    const adjBreakdown = origBreakdown.map((b) => ({
        vatRate: Number(b.vatRate || 0),
        isKct: Boolean(b.isKct),
        taxableBase: -roundVnd(Number(b.taxableBase || 0) * ratio),
        vatAmount: -roundVnd(Number(b.vatAmount || 0) * ratio),
    }));

    const adjLookupCode = generateEInvoiceLookupCode();
    const ins = await client.query(
        `INSERT INTO public.einvoices (
            tenant_id, branch_id, ma_hoa_don, lookup_code, provider,
            invoice_type, parent_einvoice_id,
            buyer_tax_code, buyer_company_name, buyer_address, buyer_email,
            tax_breakdown_json, total_before_tax, total_tax, total_amount,
            status, next_retry_at, last_error
         ) VALUES (
            $1, $2, $3, $4, $5,
            'ADJUSTMENT_DECREASE', $6,
            $7, $8, $9, $10,
            $11::jsonb, $12, $13, $14,
            'QUEUED', now(), $15
         )
         RETURNING *`,
        [
            tenantId,
            orig.branch_id || branchId,
            maHoaDon,
            adjLookupCode,
            orig.provider || 'MOCK',
            orig.id,
            orig.buyer_tax_code,
            orig.buyer_company_name,
            orig.buyer_address,
            orig.buyer_email,
            JSON.stringify(adjBreakdown),
            -adjBeforeTax,
            -adjTax,
            -adjTotal,
            reason ? `Điều chỉnh giảm do hoàn tiền: ${String(reason).slice(0, 200)}` : null,
        ]
    );
    return ins.rows[0];
}

/**
 * Outbox Worker: xử lý các bản ghi einvoices ở trạng thái QUEUED / FAILED đến hạn retry.
 */
async function processPendingEInvoices(client, { tenantId = 'DEFAULT', limit = 20, providerOverride = null } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit || 20)));
    const rowsRes = await client.query(
        `SELECT *
           FROM public.einvoices
          WHERE tenant_id = $1
            AND status IN ('QUEUED', 'FAILED')
            AND (next_retry_at IS NULL OR next_retry_at <= now())
          ORDER BY created_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [tenantId, safeLimit]
    );

    const processed = [];
    for (const row of rowsRes.rows) {
        const updated = await dispatchSingleEInvoice(client, row, providerOverride);
        processed.push(updated);
    }
    return processed;
}

module.exports = {
    DEFAULT_TAX_CATEGORIES,
    calculateMixedRateVietnamTax,
    maskPhoneForRole,
    generateEInvoiceLookupCode,
    loadTenantTaxCategoryMap,
    applyMixedRateTaxToOrder,
    EInvoiceProviderAdapter,
    MisaMeInvoiceAdapter,
    ViettelSInvoiceAdapter,
    MockEInvoiceAdapter,
    getEInvoiceAdapter,
    issueEInvoiceForOrder,
    createAdjustmentDecreaseOnRefund,
    processPendingEInvoices,
};
