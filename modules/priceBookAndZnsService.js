'use strict';

const crypto = require('crypto');

const VALID_CHANNELS = new Set(['DINE_IN', 'TAKEAWAY', 'GRABFOOD', 'SHOPEEFOOD', 'BEFOOD', 'VIP']);
const VALID_BLOCK_MINUTES = new Set([1, 5, 10, 15, 30, 60]);

class PriceBookZnsError extends Error {
    constructor(status, message, code = 'PRICEBOOK_ZNS_ERROR', details = null) {
        super(message);
        this.name = 'PriceBookZnsError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

function roundMoney(v) {
    return Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
}

// =============================================================================
// 1. PRICE BOOKS ĐA KÊNH (PURE RESOLVER + DB CRUD)
// =============================================================================

/**
 * Hàm thuần chọn giá hiệu lực theo thứ tự ưu tiên:
 *  1) Price Book riêng chi nhánh > Price Book toàn chuỗi (branchId == null)
 *  2) priority cao nhất trong khung thời gian hiệu lực [effectiveFrom, effectiveTo]
 *  3) Fallback basePrice
 */
function resolveEffectivePrice({
    basePrice,
    priceBookEntries = [],
    channel = 'DINE_IN',
    branchId = null,
    atTime = null,
}) {
    const cleanChannel = String(channel || 'DINE_IN').trim().toUpperCase();
    const cleanBranch = branchId ? String(branchId).trim() : null;
    const atMs = atTime ? new Date(atTime).getTime() : Date.now();
    const fallback = roundMoney(basePrice);

    const eligible = [];
    for (const raw of Array.isArray(priceBookEntries) ? priceBookEntries : []) {
        if (!raw) continue;
        const isActive = raw.isActive ?? raw.is_active;
        if (isActive === false) continue;

        const entryChannel = String(raw.channel || '').trim().toUpperCase();
        if (entryChannel !== cleanChannel) continue;

        const entryBranch = raw.branchId ?? raw.branch_id ?? null;
        if (entryBranch && (!cleanBranch || String(entryBranch).trim() !== cleanBranch)) {
            continue;
        }

        const effFrom = raw.effectiveFrom ?? raw.effective_from ?? null;
        const effTo = raw.effectiveTo ?? raw.effective_to ?? null;
        if (effFrom && atMs < new Date(effFrom).getTime()) continue;
        if (effTo && atMs > new Date(effTo).getTime()) continue;

        const overridePrice = Number(raw.overridePrice ?? raw.override_price);
        if (!Number.isFinite(overridePrice) || overridePrice < 0) continue;

        eligible.push({
            ...raw,
            _branchSpecific: entryBranch ? 1 : 0,
            _priority: Number(raw.priority ?? 10),
            _overridePrice: roundMoney(overridePrice),
        });
    }

    if (eligible.length === 0) {
        return {
            effectivePrice: fallback,
            matchedPriceBook: null,
            source: 'BASE_PRICE',
        };
    }

    eligible.sort((a, b) => {
        if (b._branchSpecific !== a._branchSpecific) return b._branchSpecific - a._branchSpecific;
        return b._priority - a._priority;
    });

    const winner = eligible[0];
    return {
        effectivePrice: winner._overridePrice,
        matchedPriceBook: {
            id: winner.id ?? winner.price_book_id ?? null,
            code: winner.code ?? null,
            name: winner.name ?? null,
            channel: cleanChannel,
            branchId: winner.branchId ?? winner.branch_id ?? null,
            priority: winner._priority,
        },
        source: 'PRICE_BOOK',
    };
}

async function createPriceBook(client, {
    tenantId,
    branchId = null,
    code,
    name,
    channel,
    priority = 10,
    effectiveFrom = null,
    effectiveTo = null,
    isActive = true,
    items = [],
}) {
    const cleanCode = String(code || '').trim().toUpperCase();
    const cleanName = String(name || '').trim();
    const cleanChannel = String(channel || '').trim().toUpperCase();

    if (!cleanCode || !cleanName) {
        throw new PriceBookZnsError(400, 'Thiếu mã bảng giá (code) hoặc tên bảng giá (name)!', 'INVALID_INPUT');
    }
    if (!VALID_CHANNELS.has(cleanChannel)) {
        throw new PriceBookZnsError(400, 'Kênh bảng giá phải thuộc DINE_IN, TAKEAWAY, GRABFOOD, SHOPEEFOOD, BEFOOD, VIP!', 'INVALID_CHANNEL');
    }

    let book;
    try {
        const res = await client.query(
            `INSERT INTO public.price_books
                (tenant_id, branch_id, code, name, channel, priority, effective_from, effective_to, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9)
             RETURNING *`,
            [
                String(tenantId),
                branchId ? String(branchId).trim() : null,
                cleanCode,
                cleanName,
                cleanChannel,
                Number(priority ?? 10),
                effectiveFrom || null,
                effectiveTo || null,
                Boolean(isActive),
            ]
        );
        book = res.rows[0];
    } catch (err) {
        if (err && err.code === '23505') {
            throw new PriceBookZnsError(409, `Mã bảng giá ${cleanCode} đã tồn tại!`, 'DUPLICATE_PRICE_BOOK_CODE');
        }
        throw err;
    }

    const savedItems = [];
    for (const it of Array.isArray(items) ? items : []) {
        const maSp = String(it.maSp ?? it.ma_sp ?? '').trim();
        const price = roundMoney(it.overridePrice ?? it.override_price);
        if (!maSp || !Number.isFinite(price) || price < 0) continue;
        const r = await client.query(
            `INSERT INTO public.price_book_items (tenant_id, price_book_id, ma_sp, override_price)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (price_book_id, ma_sp) DO UPDATE
                 SET override_price = EXCLUDED.override_price, updated_at = now()
             RETURNING *`,
            [String(tenantId), book.id, maSp, price]
        );
        savedItems.push(r.rows[0]);
    }

    return { priceBook: book, items: savedItems };
}

async function upsertPriceBookItems(client, { tenantId, priceBookId, items = [] }) {
    const check = await client.query(
        `SELECT id FROM public.price_books WHERE id = $1 AND tenant_id = $2`,
        [Number(priceBookId), String(tenantId)]
    );
    if (check.rows.length === 0) {
        throw new PriceBookZnsError(404, 'Không tìm thấy bảng giá!', 'PRICE_BOOK_NOT_FOUND');
    }

    const saved = [];
    for (const it of Array.isArray(items) ? items : []) {
        const maSp = String(it.maSp ?? it.ma_sp ?? '').trim();
        const price = roundMoney(it.overridePrice ?? it.override_price);
        if (!maSp || !Number.isFinite(price) || price < 0) continue;
        const r = await client.query(
            `INSERT INTO public.price_book_items (tenant_id, price_book_id, ma_sp, override_price)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (price_book_id, ma_sp) DO UPDATE
                 SET override_price = EXCLUDED.override_price, updated_at = now()
             RETURNING *`,
            [String(tenantId), Number(priceBookId), maSp, price]
        );
        saved.push(r.rows[0]);
    }
    return saved;
}

async function listPriceBooks(client, { tenantId, channel = null }) {
    const cleanChannel = channel ? String(channel).trim().toUpperCase() : null;
    const booksRes = await client.query(
        `SELECT *
           FROM public.price_books
          WHERE tenant_id = $1
            AND ($2::text IS NULL OR channel = $2)
          ORDER BY priority DESC, id DESC`,
        [String(tenantId), cleanChannel]
    );
    const itemsRes = await client.query(
        `SELECT *
           FROM public.price_book_items
          WHERE tenant_id = $1
          ORDER BY id ASC`,
        [String(tenantId)]
    );
    const itemsByBook = new Map();
    for (const it of itemsRes.rows) {
        const list = itemsByBook.get(it.price_book_id) || [];
        list.push(it);
        itemsByBook.set(it.price_book_id, list);
    }
    return booksRes.rows.map((b) => ({ ...b, items: itemsByBook.get(b.id) || [] }));
}

async function resolveProductPriceFromDb(client, {
    tenantId,
    maSp,
    basePrice = 0,
    channel = 'DINE_IN',
    branchId = null,
    atTime = null,
}) {
    const res = await client.query(
        `SELECT pb.id, pb.code, pb.name, pb.channel, pb.branch_id, pb.priority,
                pb.effective_from, pb.effective_to, pb.is_active,
                pbi.override_price
           FROM public.price_book_items pbi
           JOIN public.price_books pb ON pb.id = pbi.price_book_id
          WHERE pbi.tenant_id = $1
            AND pb.tenant_id = $1
            AND pbi.ma_sp = $2
            AND pb.is_active = TRUE`,
        [String(tenantId), String(maSp)]
    );
    return resolveEffectivePrice({
        basePrice,
        priceBookEntries: res.rows,
        channel,
        branchId,
        atTime,
    });
}

// =============================================================================
// 2. ZALO ZNS OUTBOX WORKER THẬT (TUÂN THỦ NĐ 13/2023 + LIVE / MOCK MODE)
// =============================================================================

async function hasCustomerZnsConsent(client, { tenantId, maKh = null, phone = null, purpose = 'ZNS_RECEIPT' }) {
    const cleanTenant = String(tenantId);
    const cleanPurpose = String(purpose || 'ZNS_RECEIPT').trim().toUpperCase();

    // 1. Kiểm tra log đồng thuận mới nhất trong customer_consent_logs (NĐ 13/2023)
    if (maKh || phone) {
        await client.query('SAVEPOINT sp_zns_consent_log');
        try {
            const logRes = await client.query(
                `SELECT granted
                   FROM public.customer_consent_logs
                  WHERE tenant_id = $1
                    AND purpose = $2
                    AND (
                        ($3::text IS NOT NULL AND ma_kh = $3)
                        OR ($4::text IS NOT NULL AND phone = $4)
                    )
                  ORDER BY consented_at DESC, id DESC
                  LIMIT 1`,
                [cleanTenant, cleanPurpose, maKh ? String(maKh) : null, phone ? String(phone) : null]
            );
            await client.query('RELEASE SAVEPOINT sp_zns_consent_log');
            if (logRes.rows.length > 0) {
                return Boolean(logRes.rows[0].granted);
            }
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_zns_consent_log').catch(() => {});
        }
    }

    // 2. Fallback sang cờ ZaloOptIn trên public.khachhang (đọc an toàn qua to_jsonb)
    if (maKh || phone) {
        const khRes = await client.query(
            `SELECT COALESCE((to_jsonb(kh)->>'zalooptin')::boolean, FALSE) AS zalo_opt_in
               FROM public.khachhang kh
              WHERE COALESCE(kh.tenantid, 'DEFAULT') = $1
                AND (
                    ($2::text IS NOT NULL AND kh.makh = $2)
                    OR ($3::text IS NOT NULL AND kh.sodienthoai = $3)
                )
              LIMIT 1`,
            [cleanTenant, maKh ? String(maKh) : null, phone ? String(phone) : null]
        );
        if (khRes.rows.length > 0) {
            return Boolean(khRes.rows[0].zalo_opt_in);
        }
    }

    return false;
}

async function enqueueZnsMessage(client, {
    tenantId,
    maKh = null,
    phone,
    templateId = 'DEFAULT_RECEIPT',
    templateData = {},
    purpose = 'ZNS_RECEIPT',
}) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) {
        throw new PriceBookZnsError(400, 'Thiếu số điện thoại nhận Zalo ZNS (phone)!', 'MISSING_PHONE');
    }

    const res = await client.query(
        `INSERT INTO public.zalo_zns_outbox
            (tenant_id, ma_kh, phone, template_id, template_data, purpose, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'QUEUED')
         RETURNING *`,
        [
            String(tenantId),
            maKh ? String(maKh) : null,
            cleanPhone,
            String(templateId || 'DEFAULT_RECEIPT'),
            JSON.stringify(templateData || {}),
            String(purpose || 'ZNS_RECEIPT').toUpperCase(),
        ]
    );
    return res.rows[0];
}

async function sendViaZaloOpenApi({ phone, templateId, templateData, accessToken, refreshAccessToken = null, fetchImpl = fetch }) {
    const apiUrl = process.env.ZNS_API_URL || 'https://business.openapi.zalo.me/message/template';
    const doSend = async (token) => {
        const resp = await fetchImpl(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                access_token: token,
            },
            body: JSON.stringify({
                phone,
                template_id: templateId,
                template_data: templateData || {},
                tracking_id: `zns_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
            }),
        });
        const body = await resp.json().catch(() => ({}));
        return { ok: resp.ok && Number(body.error ?? 0) === 0, status: resp.status, body };
    };

    let token = accessToken || process.env.ZNS_ACCESS_TOKEN || '';
    if (!token) {
        throw new Error('Thiếu ZNS_ACCESS_TOKEN cho chế độ live!');
    }
    let result = await doSend(token);
    if (!result.ok && (result.status === 401 || Number(result.body?.error) === -216) && typeof refreshAccessToken === 'function') {
        token = await refreshAccessToken();
        result = await doSend(token);
    }
    if (!result.ok) {
        throw new Error(result.body?.message || `Zalo ZNS HTTP ${result.status}`);
    }
    return {
        providerMsgId: String(result.body?.data?.msg_id || `LIVE_ZNS_${Date.now()}`),
    };
}

async function processZnsOutboxBatch(client, {
    tenantId,
    limit = 20,
    providerMode = process.env.ZNS_PROVIDER_MODE || 'mock',
    accessToken = null,
    refreshAccessToken = null,
    fetchImpl = fetch,
}) {
    const mode = String(providerMode || 'mock').trim().toLowerCase();
    const batchLimit = Math.max(1, Math.min(100, Number(limit || 20)));

    const rowsRes = await client.query(
        `SELECT *
           FROM public.zalo_zns_outbox
          WHERE COALESCE(NULLIF(tenant_id, ''), tenantid) = $1
            AND status = 'QUEUED'
            AND (next_retry_at IS NULL OR next_retry_at <= now())
          ORDER BY created_at ASC, id ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [String(tenantId), batchLimit]
    );

    const summary = {
        mode,
        processed: 0,
        sent: 0,
        skippedNoConsent: 0,
        failed: 0,
        results: [],
    };

    for (const row of rowsRes.rows) {
        summary.processed += 1;
        const consented = await hasCustomerZnsConsent(client, {
            tenantId,
            maKh: row.ma_kh || row.makh,
            phone: row.phone || row.sodienthoai,
            purpose: row.purpose || 'ZNS_RECEIPT',
        });

        if (!consented) {
            const upd = await client.query(
                `UPDATE public.zalo_zns_outbox
                    SET status = 'SKIPPED_NO_CONSENT',
                        last_error = 'ND13_NO_CONSENT'
                  WHERE id = $1
                  RETURNING *`,
                [row.id]
            );
            summary.skippedNoConsent += 1;
            summary.results.push(upd.rows[0]);
            continue;
        }

        try {
            let providerMsgId;
            if (mode === 'live') {
                const liveRes = await sendViaZaloOpenApi({
                    phone: row.phone || row.sodienthoai,
                    templateId: row.template_id || 'DEFAULT_RECEIPT',
                    templateData: row.template_data || row.noidung || {},
                    accessToken,
                    refreshAccessToken,
                    fetchImpl,
                });
                providerMsgId = liveRes.providerMsgId;
            } else {
                providerMsgId = `MOCK_ZNS_${row.id}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
            }

            const upd = await client.query(
                `UPDATE public.zalo_zns_outbox
                    SET status = 'SENT',
                        provider_msg_id = $2,
                        sent_at = now(),
                        last_error = NULL
                  WHERE id = $1
                  RETURNING *`,
                [row.id, providerMsgId]
            );
            summary.sent += 1;
            summary.results.push(upd.rows[0]);
        } catch (err) {
            const nextRetryCount = Number(row.retry_count || 0) + 1;
            const backoffMinutes = Math.min(60, Math.pow(2, nextRetryCount));
            const nextStatus = nextRetryCount >= 5 ? 'FAILED' : 'QUEUED';
            const upd = await client.query(
                `UPDATE public.zalo_zns_outbox
                    SET status = $2,
                        retry_count = $3,
                        next_retry_at = now() + ($4::text || ' minutes')::interval,
                        last_error = $5
                  WHERE id = $1
                  RETURNING *`,
                [row.id, nextStatus, nextRetryCount, String(backoffMinutes), String(err?.message || err).slice(0, 500)]
            );
            summary.failed += 1;
            summary.results.push(upd.rows[0]);
        }
    }

    return summary;
}

// =============================================================================
// 3. BIDA TIME-BILLING ENGINE (CHÍNH XÁC TỪNG PHÚT + CAO ĐIỂM + BLOCK LÀM TRÒN)
// =============================================================================

function isPeakHour(hour, peakStartHour, peakEndHour) {
    if (peakStartHour === null || peakStartHour === undefined || peakEndHour === null || peakEndHour === undefined) {
        return false;
    }
    const start = Number(peakStartHour);
    const end = Number(peakEndHour);
    if (start === end) return false;
    if (start < end) {
        return hour >= start && hour < end;
    }
    // Khung qua nửa đêm (VD: 22 -> 02)
    return hour >= start || hour < end;
}

/**
 * Hàm thuần tính tiền phiên Bida:
 *  - Trừ sạch totalPausedSeconds (không bao giờ âm)
 *  - Tách chính xác từng phút giữa khung giờ thường và giờ cao điểm (theo giờ VN UTC+7)
 *  - Làm tròn lên theo billingBlockMinutes (1/5/10/15/30/60)
 *  - Tính tiền bằng số nguyên tránh lệch floating-point
 */
function calculateBidaSessionFee({
    startedAt,
    endedAt,
    totalPausedSeconds = 0,
    hourlyRate,
    peakHourlyRate = null,
    peakStartHour = 18,
    peakEndHour = 23,
    billingBlockMinutes = 15,
    timezoneOffsetHours = 7,
}) {
    const startMs = new Date(startedAt).getTime();
    const endMs = new Date(endedAt).getTime();
    const baseRate = Math.max(0, Number(hourlyRate || 0));
    const peakRate = peakHourlyRate !== null && peakHourlyRate !== undefined
        ? Math.max(0, Number(peakHourlyRate))
        : baseRate;
    const block = VALID_BLOCK_MINUTES.has(Number(billingBlockMinutes)) ? Number(billingBlockMinutes) : 15;
    const tzOffsetMs = Number(timezoneOffsetHours) * 3600 * 1000;

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return {
            rawMinutes: 0,
            pausedMinutes: 0,
            activeMinutes: 0,
            billedMinutes: 0,
            normalMinutes: 0,
            peakMinutes: 0,
            totalAmount: 0,
        };
    }

    const rawSeconds = Math.floor((endMs - startMs) / 1000);
    const pausedSec = Math.max(0, Math.floor(Number(totalPausedSeconds || 0)));
    const activeSeconds = Math.max(0, rawSeconds - pausedSec);

    if (activeSeconds === 0) {
        return {
            rawMinutes: Math.round(rawSeconds / 60),
            pausedMinutes: Math.round(pausedSec / 60),
            activeMinutes: 0,
            billedMinutes: 0,
            normalMinutes: 0,
            peakMinutes: 0,
            totalAmount: 0,
        };
    }

    const activeMinutes = Math.ceil(activeSeconds / 60);
    const billedMinutes = Math.ceil(activeMinutes / block) * block;
    const extraRoundingMinutes = billedMinutes - activeMinutes;

    let normalMinutes = 0;
    let peakMinutes = 0;
    let lastMinuteWasPeak = false;

    for (let m = 0; m < activeMinutes; m += 1) {
        const minuteTs = startMs + m * 60000;
        const localHour = new Date(minuteTs + tzOffsetMs).getUTCHours();
        const peak = isPeakHour(localHour, peakStartHour, peakEndHour);
        if (peak) {
            peakMinutes += 1;
        } else {
            normalMinutes += 1;
        }
        lastMinuteWasPeak = peak;
    }

    if (extraRoundingMinutes > 0) {
        if (lastMinuteWasPeak) {
            peakMinutes += extraRoundingMinutes;
        } else {
            normalMinutes += extraRoundingMinutes;
        }
    }

    // Nhân trước, chia 60 cuối cùng rồi Math.round để không bị lệch dấu phẩy động
    const totalAmount = Math.round((normalMinutes * baseRate + peakMinutes * peakRate) / 60);

    return {
        rawMinutes: Math.round(rawSeconds / 60),
        pausedMinutes: Math.round(pausedSec / 60),
        activeMinutes,
        billedMinutes,
        normalMinutes,
        peakMinutes,
        totalAmount: Math.max(0, totalAmount),
    };
}

async function startBidaSession(client, {
    tenantId,
    branchId = null,
    maBan,
    maHoaDon = null,
    hourlyRate,
    peakHourlyRate = null,
    peakStartHour = 18,
    peakEndHour = 23,
    billingBlockMinutes = 15,
    startedAt = null,
    createdBy = null,
}) {
    const cleanBan = String(maBan || '').trim();
    const rate = roundMoney(hourlyRate);
    const block = Number(billingBlockMinutes || 15);
    if (!cleanBan) throw new PriceBookZnsError(400, 'Thiếu mã bàn (maBan)!', 'INVALID_TABLE');
    if (!Number.isFinite(rate) || rate < 0) throw new PriceBookZnsError(400, 'Đơn giá giờ không hợp lệ!', 'INVALID_RATE');
    if (!VALID_BLOCK_MINUTES.has(block)) {
        throw new PriceBookZnsError(400, 'billingBlockMinutes phải thuộc 1, 5, 10, 15, 30, 60!', 'INVALID_BLOCK');
    }

    const res = await client.query(
        `INSERT INTO public.bida_sessions
            (tenant_id, branch_id, ma_ban, ma_hoa_don, hourly_rate, peak_hourly_rate,
             peak_start_hour, peak_end_hour, billing_block_minutes, started_at, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()), 'RUNNING', $11)
         RETURNING *`,
        [
            String(tenantId),
            branchId ? String(branchId) : null,
            cleanBan,
            maHoaDon ? String(maHoaDon) : null,
            rate,
            peakHourlyRate !== null && peakHourlyRate !== undefined ? roundMoney(peakHourlyRate) : null,
            Number(peakStartHour ?? 18),
            Number(peakEndHour ?? 23),
            block,
            startedAt || null,
            createdBy ? String(createdBy) : null,
        ]
    );
    return res.rows[0];
}

async function pauseBidaSession(client, { tenantId, sessionId }) {
    const res = await client.query(
        `UPDATE public.bida_sessions
            SET status = 'PAUSED', paused_at = now()
          WHERE id = $1 AND tenant_id = $2 AND status = 'RUNNING'
          RETURNING *`,
        [Number(sessionId), String(tenantId)]
    );
    if (res.rows.length === 0) {
        throw new PriceBookZnsError(409, 'Phiên Bida không tồn tại hoặc không ở trạng thái RUNNING!', 'INVALID_SESSION_STATE');
    }
    return res.rows[0];
}

async function resumeBidaSession(client, { tenantId, sessionId }) {
    const res = await client.query(
        `UPDATE public.bida_sessions
            SET status = 'RUNNING',
                total_paused_seconds = total_paused_seconds + GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(paused_at, now())))::int),
                paused_at = NULL
          WHERE id = $1 AND tenant_id = $2 AND status = 'PAUSED'
          RETURNING *`,
        [Number(sessionId), String(tenantId)]
    );
    if (res.rows.length === 0) {
        throw new PriceBookZnsError(409, 'Phiên Bida không tồn tại hoặc không ở trạng thái PAUSED!', 'INVALID_SESSION_STATE');
    }
    return res.rows[0];
}

async function closeBidaSession(client, { tenantId, sessionId, endedAt = null }) {
    const rowRes = await client.query(
        `SELECT * FROM public.bida_sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [Number(sessionId), String(tenantId)]
    );
    const session = rowRes.rows[0];
    if (!session) {
        throw new PriceBookZnsError(404, 'Không tìm thấy phiên Bida!', 'SESSION_NOT_FOUND');
    }
    if (session.status === 'CLOSED') {
        throw new PriceBookZnsError(409, 'Phiên Bida đã đóng trước đó!', 'SESSION_ALREADY_CLOSED');
    }

    const endDate = endedAt ? new Date(endedAt) : new Date();
    let totalPausedSec = Number(session.total_paused_seconds || 0);
    if (session.status === 'PAUSED' && session.paused_at) {
        const extraPause = Math.max(0, Math.floor((endDate.getTime() - new Date(session.paused_at).getTime()) / 1000));
        totalPausedSec += extraPause;
    }

    const billing = calculateBidaSessionFee({
        startedAt: session.started_at,
        endedAt: endDate,
        totalPausedSeconds: totalPausedSec,
        hourlyRate: session.hourly_rate,
        peakHourlyRate: session.peak_hourly_rate,
        peakStartHour: session.peak_start_hour,
        peakEndHour: session.peak_end_hour,
        billingBlockMinutes: session.billing_block_minutes,
    });

    const upd = await client.query(
        `UPDATE public.bida_sessions
            SET status = 'CLOSED',
                paused_at = NULL,
                total_paused_seconds = $3,
                ended_at = $4::timestamptz,
                computed_amount = $5
          WHERE id = $1 AND tenant_id = $2
          RETURNING *`,
        [session.id, String(tenantId), totalPausedSec, endDate.toISOString(), billing.totalAmount]
    );
    return { session: upd.rows[0], billing };
}

module.exports = {
    PriceBookZnsError,
    resolveEffectivePrice,
    createPriceBook,
    upsertPriceBookItems,
    listPriceBooks,
    resolveProductPriceFromDb,
    hasCustomerZnsConsent,
    enqueueZnsMessage,
    processZnsOutboxBatch,
    calculateBidaSessionFee,
    startBidaSession,
    pauseBidaSession,
    resumeBidaSession,
    closeBidaSession,
};
