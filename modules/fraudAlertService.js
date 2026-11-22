const crypto = require('crypto');

const CACHE_TTL_MS = 30 * 1000;
const HTTP_TIMEOUT_MS = 4500;
const MAX_HISTORY_PER_TENANT = 20;

const configCache = new Map(); // tenantId -> { expiresAt, tenQuan, config }
const deliveryHistory = new Map(); // tenantId -> Array<{ at, eventKey, channels }>

const ALERT_EVENT_META = [
    {
        key: 'DRAWER_NO_SALE_KICK',
        label: '💰 Mở két tiền không bán hàng (No-Sale RJ11)',
        severity: 'HIGH',
        defaultEnabled: true,
    },
    {
        key: 'RECEIPT_REPRINT',
        label: '⚠️ In lại hóa đơn (Reprint lần 2+)',
        severity: 'MEDIUM',
        defaultEnabled: true,
    },
    {
        key: 'ITEM_VOID_WASTE',
        label: '🗑️ Hủy món đã pha chế (Hao hụt kho)',
        severity: 'HIGH',
        defaultEnabled: true,
    },
    {
        key: 'MANUAL_TRANSFER_CONFIRMED',
        label: '⚠️ Xác nhận chuyển khoản thủ công tại quầy',
        severity: 'HIGH',
        defaultEnabled: true,
    },
    {
        key: 'SHIFT_CLOSE_DIFF',
        label: '🚨 Chốt ca lệch quỹ tiền mặt',
        severity: 'CRITICAL',
        defaultEnabled: true,
    },
    {
        key: 'ORDER_POST_PAYMENT_REFUND',
        label: '↩️ Hoàn tiền / Hủy đơn sau thanh toán',
        severity: 'CRITICAL',
        defaultEnabled: true,
    },
    {
        key: 'CASH_SAFE_DROP',
        label: '🏦 Rút két an toàn (Safe Drop)',
        severity: 'INFO',
        defaultEnabled: true,
    },
    {
        key: 'LOYALTY_HARVESTING_SUSPECTED',
        label: '🎯 Nghi vấn tích điểm khống (1 SĐT tích ≥ 4 đơn tiền mặt trong ca)',
        severity: 'HIGH',
        defaultEnabled: true,
    },
    {
        key: 'DISCOUNT_VELOCITY_ABUSE',
        label: '📉 Nghi vấn lạm dụng mã giảm giá (Tỷ lệ đơn giảm giá của thu ngân bất thường)',
        severity: 'HIGH',
        defaultEnabled: true,
    },
];

const DEFAULT_EVENTS = Object.fromEntries(ALERT_EVENT_META.map((e) => [e.key, e.defaultEnabled]));

function defaultConfig() {
    return {
        enabled: false,
        telegramBotToken: '',
        telegramChatId: '',
        webhookUrl: '',
        webhookSecret: '',
        shiftDiffThresholdVnd: 1000,
        events: { ...DEFAULT_EVENTS },
    };
}

function normalizeConfig(raw) {
    const base = defaultConfig();
    if (!raw || typeof raw !== 'object') return base;
    const mergedEvents = { ...DEFAULT_EVENTS };
    if (raw.events && typeof raw.events === 'object') {
        for (const meta of ALERT_EVENT_META) {
            if (raw.events[meta.key] !== undefined) {
                mergedEvents[meta.key] = Boolean(raw.events[meta.key]);
            }
        }
    }
    const threshold = Number(raw.shiftDiffThresholdVnd);
    return {
        enabled: Boolean(raw.enabled),
        telegramBotToken: typeof raw.telegramBotToken === 'string' ? raw.telegramBotToken.trim() : '',
        telegramChatId: typeof raw.telegramChatId === 'string' ? raw.telegramChatId.trim() : '',
        webhookUrl: typeof raw.webhookUrl === 'string' ? raw.webhookUrl.trim() : '',
        webhookSecret: typeof raw.webhookSecret === 'string' ? raw.webhookSecret.trim() : '',
        shiftDiffThresholdVnd: Number.isFinite(threshold) && threshold >= 0 ? Math.round(threshold) : 1000,
        events: mergedEvents,
    };
}

function maskSecret(str) {
    if (!str) return '';
    if (str.length <= 8) return '****';
    return `${str.slice(0, 4)}••••${str.slice(-4)}`;
}

function sanitizeConfigForClient(cfg) {
    const c = normalizeConfig(cfg);
    return {
        enabled: c.enabled,
        telegramChatId: c.telegramChatId,
        hasTelegramBotToken: Boolean(c.telegramBotToken),
        telegramBotTokenMasked: maskSecret(c.telegramBotToken),
        webhookUrl: c.webhookUrl,
        hasWebhookSecret: Boolean(c.webhookSecret),
        webhookSecretMasked: maskSecret(c.webhookSecret),
        shiftDiffThresholdVnd: c.shiftDiffThresholdVnd,
        events: c.events,
    };
}

function escapeHtml(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatVnd(n) {
    const num = Math.round(Number(n) || 0);
    return `${num.toLocaleString('vi-VN')}đ`;
}

// Chống SSRF: chỉ cho phép Webhook ra Internet công cộng (https:// hoặc http:// non-private), chặn loopback/metadata/LAN
function kiemTraUrlWebhookAnToan(rawUrl) {
    if (!rawUrl || !String(rawUrl).trim()) return { ok: true, url: '' };
    let parsed;
    try {
        parsed = new URL(String(rawUrl).trim());
    } catch {
        return { ok: false, message: 'URL Webhook không hợp lệ!' };
    }
    if (!['https:', 'http:'].includes(parsed.protocol)) {
        return { ok: false, message: 'URL Webhook chỉ hỗ trợ giao thức https:// hoặc http://!' };
    }
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host.endsWith('.internal') ||
        host === '0.0.0.0' ||
        host === '::1' ||
        host.startsWith('fe80:') ||
        host.startsWith('fc') ||
        host.startsWith('fd')
    ) {
        return { ok: false, message: 'Không được phép trỏ Webhook tới địa chỉ nội bộ (localhost/LAN)!' };
    }
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
        if (
            a === 127 ||
            a === 10 ||
            a === 0 ||
            (a === 169 && b === 254) ||
            (a === 192 && b === 168) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 100 && b >= 64 && b <= 127)
        ) {
            return { ok: false, message: 'Không được phép trỏ Webhook tới dải IP nội bộ / cloud metadata!' };
        }
    }
    return { ok: true, url: parsed.toString() };
}

function pushHistory(tenantId, entry) {
    const key = String(tenantId || 'DEFAULT');
    const list = deliveryHistory.get(key) || [];
    list.unshift(entry);
    if (list.length > MAX_HISTORY_PER_TENANT) list.pop();
    deliveryHistory.set(key, list);
}

function getHistory(tenantId) {
    return deliveryHistory.get(String(tenantId || 'DEFAULT')) || [];
}

function invalidateAlertCache(tenantId) {
    configCache.delete(String(tenantId || 'DEFAULT'));
}

async function khoiTaoCanhBaoGianLan(pool) {
    if (process.env.SKIP_AUTO_DDL === 'true') return;
    try {
        await pool.query(`
            ALTER TABLE IF EXISTS public.tenants
                ADD COLUMN IF NOT EXISTS CauHinhCanhBao JSONB NOT NULL DEFAULT '{}'::jsonb;
        `);
    } catch (error) {
        console.warn('⚠️ Bỏ qua nâng cấp cột CauHinhCanhBao:', error.message);
    }
}

async function loadTenantAlertConfig(pool, tenantId) {
    const tId = String(tenantId || 'DEFAULT');
    const cached = configCache.get(tId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached;
    }
    try {
        const r = await pool.query(
            `SELECT TenQuan, CauHinhCanhBao FROM Tenants WHERE TenantId = $1 LIMIT 1`,
            [tId]
        );
        const row = r.rows[0] || {};
        const entry = {
            expiresAt: Date.now() + CACHE_TTL_MS,
            tenQuan: row.tenquan || (tId === 'DEFAULT' ? 'POS Cafe Chính' : tId),
            config: normalizeConfig(row.cauhinhcanhbao),
        };
        configCache.set(tId, entry);
        return entry;
    } catch {
        return {
            expiresAt: Date.now() + 5000,
            tenQuan: tId,
            config: defaultConfig(),
        };
    }
}

function resolveAlertEventKey(audit) {
    const action = String(audit?.hanhDong || '');
    if (action === 'SHIFT_CLOSE') {
        const chenhLech = Number(audit?.giaTriMoi?.chenhLech || 0);
        if (chenhLech === 0) return null;
        return 'SHIFT_CLOSE_DIFF';
    }
    const matched = ALERT_EVENT_META.find((e) => e.key === action);
    return matched ? matched.key : null;
}

function buildDetailLines(eventKey, audit) {
    const gm = audit?.giaTriMoi && typeof audit.giaTriMoi === 'object' ? audit.giaTriMoi : {};
    const lines = [];
    if (eventKey === 'SHIFT_CLOSE_DIFF') {
        const diff = Number(gm.chenhLech || 0);
        lines.push(`Chênh lệch quỹ: ${diff > 0 ? '+' : ''}${formatVnd(diff)} (${diff < 0 ? 'HỤT QUỸ' : 'DƯ QUỸ'})`);
        lines.push(`Quỹ lý thuyết: ${formatVnd(gm.tienMatLyThuyet)} | Thực đếm: ${formatVnd(gm.tienMatThucTe)}`);
        if (Number(gm.rutKet || 0) > 0) lines.push(`Rút két trong ca: ${formatVnd(gm.rutKet)}`);
    } else if (eventKey === 'RECEIPT_REPRINT') {
        lines.push(`Hóa đơn: #${audit.maDoiTuong || '-'} (In lại lần ${Number(gm.soLanIn || 2)})`);
    } else if (eventKey === 'ITEM_VOID_WASTE') {
        lines.push(`Món bị hủy (Hao hụt): #${audit.maDoiTuong || '-'}`);
    } else if (eventKey === 'MANUAL_TRANSFER_CONFIRMED') {
        lines.push(`Hóa đơn: #${audit.maDoiTuong || '-'}`);
        if (gm.soTien !== undefined) lines.push(`Số tiền xác nhận tay: ${formatVnd(gm.soTien)}`);
    } else if (eventKey === 'ORDER_POST_PAYMENT_REFUND') {
        lines.push(`Hóa đơn hoàn tiền: #${audit.maDoiTuong || '-'}`);
        if (gm.tongHoan !== undefined) lines.push(`Số tiền hoàn: ${formatVnd(gm.tongHoan)} (${gm.phuongThucHoan || 'TIEN_MAT'})`);
    } else if (eventKey === 'CASH_SAFE_DROP') {
        lines.push(`Số tiền rút két: ${formatVnd(gm.soTien)} (Ca #${audit.maDoiTuong || '-'})`);
    } else if (eventKey === 'DRAWER_NO_SALE_KICK') {
        lines.push('Thao tác: Mở ngăn kéo tiền mặt ngoài giao dịch bán hàng (No-Sale)');
    } else if (eventKey === 'LOYALTY_HARVESTING_SUSPECTED') {
        lines.push(
            `Khách hàng: ${gm.tenKH || gm.maKH || '-'} (${gm.soDienThoai || '-'}) đã tích điểm ${gm.soDonTienMatTrongCa || 4} đơn TIỀN MẶT trong cùng Ca #${gm.maCaThuNgan || '-'}`
        );
    } else if (eventKey === 'DISCOUNT_VELOCITY_ABUSE') {
        lines.push(
            `Thu ngân đã áp giảm giá trên ${gm.soDonGiamNV || 0}/${gm.tongDonNV || 0} đơn (${gm.tyLeGiamNVPct || 0}% — vượt gấp >2 lần trung bình quán ${gm.tyLeTrungBinhQuanPct || 0}%)`
        );
    }
    if (audit?.lyDo) {
        lines.push(`Lý do / Ghi chú: ${audit.lyDo}`);
    }
    return lines;
}

function formatFraudAlertMessage({ tenQuan, tenantId, eventKey, audit, isTest = false }) {
    const meta = ALERT_EVENT_META.find((e) => e.key === eventKey) || {
        key: eventKey,
        label: '🔔 Cảnh báo hệ thống POS',
        severity: 'INFO',
    };
    const nowStr = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const detailLines = isTest
        ? ['Đây là tin nhắn kiểm tra kết nối cảnh báo gian lận tức thời từ POS Cafe.', 'Nếu bạn nhận được tin nhắn này, kênh cảnh báo đã sẵn sàng!']
        : buildDetailLines(eventKey, audit);

    const actor = audit?.tenNV ? `${audit.tenNV} (${audit.maNV || ''})` : audit?.maNV || 'SYSTEM';
    const title = isTest ? '🧪 [TEST] KẾT NỐI CẢNH BÁO GIAN LẬN POS' : `🚨 CẢNH BÁO ANTI-FRAUD: ${meta.label}`;

    const telegramHtml = [
        `<b>${escapeHtml(title)}</b>`,
        `🏪 Quán: <b>${escapeHtml(tenQuan)}</b> (<code>${escapeHtml(tenantId)}</code>)`,
        `👤 Nhân viên: <b>${escapeHtml(actor)}</b>`,
        `🕒 Thời gian: ${escapeHtml(nowStr)}`,
        ...detailLines.map((l) => `• ${escapeHtml(l)}`),
        audit?.ip ? `🌐 IP: <code>${escapeHtml(audit.ip)}</code>` : null,
    ]
        .filter(Boolean)
        .join('\n');

    const plainText = [
        title,
        `Quán: ${tenQuan} (${tenantId})`,
        `Nhân viên: ${actor}`,
        `Thời gian: ${nowStr}`,
        ...detailLines.map((l) => `- ${l}`),
    ].join('\n');

    const webhookPayload = {
        type: isTest ? 'FRAUD_ALERT_TEST' : 'FRAUD_ALERT',
        event: eventKey,
        severity: meta.severity,
        title,
        text: plainText, // Tương thích sẵn Slack / Mattermost / Google Chat Incoming Webhook
        content: plainText, // Tương thích sẵn Discord Webhook
        tenantId,
        tenQuan,
        actor: {
            maNV: audit?.maNV || null,
            tenNV: audit?.tenNV || null,
            vaiTro: audit?.vaiTro ?? null,
        },
        target: {
            doiTuong: audit?.doiTuong || null,
            maDoiTuong: audit?.maDoiTuong ?? null,
        },
        reason: audit?.lyDo || null,
        details: audit?.giaTriMoi || null,
        timestamp: new Date().toISOString(),
    };

    return { telegramHtml, plainText, webhookPayload };
}

async function sendTelegramMessage(botToken, chatId, htmlText) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
        const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: htmlText,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            }),
            signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) {
            return { ok: false, status: res.status, error: data.description || `HTTP ${res.status}` };
        }
        return { ok: true, status: res.status, messageId: data.result?.message_id || null };
    } catch (err) {
        return { ok: false, error: err.name === 'AbortError' ? 'Hết thời gian chờ Telegram API (timeout)' : err.message };
    } finally {
        clearTimeout(timer);
    }
}

async function sendCustomWebhook(webhookUrl, webhookSecret, payload) {
    const check = kiemTraUrlWebhookAnToan(webhookUrl);
    if (!check.ok) return { ok: false, error: check.message };

    const bodyStr = JSON.stringify(payload);
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'CafePOS-AntiFraud-Alert/1.0',
    };
    if (webhookSecret) {
        const sig = crypto.createHmac('sha256', webhookSecret).update(bodyStr).digest('hex');
        headers['X-POS-Alert-Signature'] = `sha256=${sig}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
        const res = await fetch(check.url, {
            method: 'POST',
            headers,
            body: bodyStr,
            signal: controller.signal,
        });
        if (!res.ok) {
            return { ok: false, status: res.status, error: `Webhook trả về HTTP ${res.status}` };
        }
        return { ok: true, status: res.status };
    } catch (err) {
        return { ok: false, error: err.name === 'AbortError' ? 'Hết thời gian chờ Webhook (timeout)' : err.message };
    } finally {
        clearTimeout(timer);
    }
}

async function deliverToChannels(config, formatted) {
    const tasks = {};
    if (config.telegramBotToken && config.telegramChatId) {
        tasks.telegram = sendTelegramMessage(config.telegramBotToken, config.telegramChatId, formatted.telegramHtml);
    }
    if (config.webhookUrl) {
        tasks.webhook = sendCustomWebhook(config.webhookUrl, config.webhookSecret, formatted.webhookPayload);
    }
    const keys = Object.keys(tasks);
    if (keys.length === 0) return {};
    const settled = await Promise.all(keys.map((k) => tasks[k]));
    const out = {};
    keys.forEach((k, idx) => {
        out[k] = settled[idx];
    });
    return out;
}

async function dispatchFraudAlertFromAudit(pool, audit) {
    try {
        const eventKey = resolveAlertEventKey(audit);
        if (!eventKey) return;

        const tenantId = String(audit?.tenantId || 'DEFAULT');
        const loaded = await loadTenantAlertConfig(pool, tenantId);
        const cfg = loaded.config;
        if (!cfg.enabled) return;
        if (!cfg.events[eventKey]) return;
        if (!((cfg.telegramBotToken && cfg.telegramChatId) || cfg.webhookUrl)) return;

        if (eventKey === 'SHIFT_CLOSE_DIFF') {
            const absDiff = Math.abs(Number(audit?.giaTriMoi?.chenhLech || 0));
            if (absDiff < Number(cfg.shiftDiffThresholdVnd || 0)) return;
        }

        // Bổ sung tên nhân viên để tin nhắn gửi chủ quán dễ đọc
        let tenNV = audit.tenNV || null;
        if (!tenNV && audit.maNV && audit.maNV !== 'SYSTEM' && audit.maNV !== 'VIETQR_BOT') {
            try {
                const nvRes = await pool.query(`SELECT TenNV FROM NhanVien WHERE MaNV = $1 LIMIT 1`, [audit.maNV]);
                tenNV = nvRes.rows[0]?.tennv || null;
            } catch {
                // ignore
            }
        }

        const formatted = formatFraudAlertMessage({
            tenQuan: loaded.tenQuan,
            tenantId,
            eventKey,
            audit: { ...audit, tenNV },
        });
        const channels = await deliverToChannels(cfg, formatted);
        pushHistory(tenantId, {
            at: new Date().toISOString(),
            eventKey,
            maNV: audit.maNV || 'SYSTEM',
            channels,
        });
    } catch (err) {
        console.warn('⚠️ Lỗi nền khi gửi cảnh báo gian lận:', err.message);
    }
}

function registerFraudAlertRoutes(app, { pool, kiemTraToken, choPhepVaiTro, yeuCauTinhNang, ghiAuditLog, guiLoi }) {
    const layTenantId = (req) => String(req.user?.tenantId || 'DEFAULT');

    app.get('/api/alerts/config', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('audit_logs'), async (req, res) => {
        const tenantId = layTenantId(req);
        try {
            const loaded = await loadTenantAlertConfig(pool, tenantId);
            res.json({
                config: sanitizeConfigForClient(loaded.config),
                eventMeta: ALERT_EVENT_META,
                recentDeliveries: getHistory(tenantId),
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Đọc cấu hình cảnh báo gian lận:');
        }
    });

    app.put('/api/alerts/config', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('audit_logs'), async (req, res) => {
        const tenantId = layTenantId(req);
        const body = req.body || {};

        const urlCheck = kiemTraUrlWebhookAnToan(body.webhookUrl);
        if (!urlCheck.ok) {
            return res.status(400).json({ message: urlCheck.message });
        }

        const threshold = Number(body.shiftDiffThresholdVnd ?? 1000);
        if (!Number.isFinite(threshold) || threshold < 0) {
            return res.status(400).json({ message: 'Ngưỡng cảnh báo lệch ca phải là số >= 0!' });
        }

        try {
            const current = (await loadTenantAlertConfig(pool, tenantId)).config;

            const nextTelegramToken = body.clearTelegramToken
                ? ''
                : typeof body.telegramBotToken === 'string' && body.telegramBotToken.trim()
                ? body.telegramBotToken.trim()
                : current.telegramBotToken;

            const nextWebhookSecret = body.clearWebhookSecret
                ? ''
                : typeof body.webhookSecret === 'string' && body.webhookSecret.trim()
                ? body.webhookSecret.trim()
                : current.webhookSecret;

            const nextConfig = normalizeConfig({
                enabled: Boolean(body.enabled),
                telegramBotToken: nextTelegramToken,
                telegramChatId: typeof body.telegramChatId === 'string' ? body.telegramChatId.trim() : current.telegramChatId,
                webhookUrl: urlCheck.url,
                webhookSecret: nextWebhookSecret,
                shiftDiffThresholdVnd: Math.round(threshold),
                events: body.events || current.events,
            });

            await pool.query(
                `UPDATE Tenants SET CauHinhCanhBao = $2::jsonb WHERE TenantId = $1`,
                [tenantId, JSON.stringify(nextConfig)]
            );
            invalidateAlertCache(tenantId);

            await pool.withTenant(tenantId, (client) =>
                ghiAuditLog(client, {
                    tenantId,
                    maNV: req.user.maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'FRAUD_ALERT_CONFIG_UPDATED',
                    doiTuong: 'TENANT',
                    maDoiTuong: tenantId,
                    giaTriMoi: sanitizeConfigForClient(nextConfig),
                    lyDo: `Cập nhật cảnh báo gian lận (${nextConfig.enabled ? 'BẬT' : 'TẮT'})`,
                    ip: req.ip,
                })
            );

            res.json({
                message: 'Đã lưu cấu hình cảnh báo gian lận tức thời!',
                config: sanitizeConfigForClient(nextConfig),
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Lưu cấu hình cảnh báo gian lận:');
        }
    });

    app.post('/api/alerts/test', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('audit_logs'), async (req, res) => {
        const tenantId = layTenantId(req);
        const body = req.body || {};
        try {
            const loaded = await loadTenantAlertConfig(pool, tenantId);
            const merged = normalizeConfig({
                ...loaded.config,
                telegramBotToken:
                    typeof body.telegramBotToken === 'string' && body.telegramBotToken.trim()
                        ? body.telegramBotToken.trim()
                        : loaded.config.telegramBotToken,
                telegramChatId:
                    typeof body.telegramChatId === 'string' && body.telegramChatId.trim()
                        ? body.telegramChatId.trim()
                        : loaded.config.telegramChatId,
                webhookUrl:
                    typeof body.webhookUrl === 'string' && body.webhookUrl.trim()
                        ? body.webhookUrl.trim()
                        : loaded.config.webhookUrl,
                webhookSecret:
                    typeof body.webhookSecret === 'string' && body.webhookSecret.trim()
                        ? body.webhookSecret.trim()
                        : loaded.config.webhookSecret,
            });

            if (merged.webhookUrl) {
                const urlCheck = kiemTraUrlWebhookAnToan(merged.webhookUrl);
                if (!urlCheck.ok) return res.status(400).json({ message: urlCheck.message });
            }

            if (!((merged.telegramBotToken && merged.telegramChatId) || merged.webhookUrl)) {
                return res.status(400).json({
                    message: 'Vui lòng nhập ít nhất Telegram (Bot Token + Chat ID) hoặc Webhook URL trước khi gửi thử!',
                });
            }

            const formatted = formatFraudAlertMessage({
                tenQuan: loaded.tenQuan,
                tenantId,
                eventKey: 'TEST_ALERT',
                audit: { maNV: req.user.maNV, tenNV: req.user.tenNV, vaiTro: req.user.vaiTro, ip: req.ip },
                isTest: true,
            });
            const channels = await deliverToChannels(merged, formatted);
            pushHistory(tenantId, {
                at: new Date().toISOString(),
                eventKey: 'TEST_ALERT',
                maNV: req.user.maNV,
                channels,
            });

            const allOk = Object.values(channels).length > 0 && Object.values(channels).every((c) => c.ok);
            res.json({
                ok: allOk,
                message: allOk
                    ? '✅ Đã gửi cảnh báo thử nghiệm thành công!'
                    : '⚠️ Một số kênh gửi thất bại — vui lòng kiểm tra chi tiết bên dưới.',
                channels,
                recentDeliveries: getHistory(tenantId),
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Gửi thử cảnh báo gian lận:');
        }
    });
}

// [P1 - Fraud Velocity Rules] Phát hiện tự động Tích điểm khống (Loyalty Harvesting >= 4 đơn tiền mặt/ca)
// & Lạm dụng tần suất mã giảm giá (Discount Velocity > 2x trung bình quán)
async function kiemTraCanhBaoTanSuatGianLan(
    pool,
    { tenantId, maCaThuNgan, maNV, vaiTro = 4, maKH = null, phuongThucTT = 'TIEN_MAT', coGiamGia = false, maHoaDon = null, ghiAuditLog = null, ip = null }
) {
    if (!pool || !tenantId || !maCaThuNgan || typeof ghiAuditLog !== 'function') return;
    try {
        await pool.withTenant(tenantId, async (client) => {
            // 1. Loyalty Harvesting Rule: 1 MaKH xuất hiện >= 4 giao dịch TIEN_MAT trong cùng 1 ca thu ngân
            if (maKH && phuongThucTT === 'TIEN_MAT') {
                const khCashRes = await client.query(
                    `SELECT COUNT(*)::int AS so_don,
                            MAX(kh.TenKH) AS ten_kh,
                            MAX(kh.SoDienThoai) AS sdt
                       FROM HoaDon hd
                       LEFT JOIN KhachHang kh ON kh.MaKH = hd.MaKH
                      WHERE COALESCE(hd.TenantId, 'DEFAULT') = $1
                        AND hd.MaCaThuNgan = $2
                        AND hd.MaKH = $3
                        AND hd.TrangThaiTT = 1
                        AND COALESCE(hd.PhuongThucTT, 'TIEN_MAT') = 'TIEN_MAT'`,
                    [tenantId, maCaThuNgan, maKH]
                );
                const soDon = Number(khCashRes.rows[0]?.so_don || 0);
                if (soDon === 4 || (soDon > 4 && soDon % 4 === 0)) {
                    await ghiAuditLog(client, {
                        tenantId,
                        maNV,
                        vaiTro,
                        hanhDong: 'LOYALTY_HARVESTING_SUSPECTED',
                        doiTuong: 'KHACHHANG',
                        maDoiTuong: maKH,
                        giaTriMoi: {
                            maKH,
                            tenKH: khCashRes.rows[0]?.ten_kh || null,
                            soDienThoai: khCashRes.rows[0]?.sdt || null,
                            maCaThuNgan,
                            maHoaDonMoiNhat: maHoaDon,
                            soDonTienMatTrongCa: soDon,
                        },
                        lyDo: `Cảnh báo tự động: Khách hàng ${maKH} tích điểm ${soDon} đơn tiền mặt trong cùng Ca #${maCaThuNgan}`,
                        ip,
                    });
                }
            }

            // 2. Discount Velocity Rule: Tỷ lệ đơn áp giảm giá của thu ngân cao gấp > 2 lần trung bình quán trong ngày (khi đã có >= 4 đơn giảm giá)
            if (coGiamGia && maNV) {
                await client.query('SAVEPOINT sp_vel_disc');
                try {
                    const velRes = await client.query(
                        `SELECT
                            COUNT(*) FILTER (WHERE MaNV = $2)::int AS tong_don_nv,
                            COUNT(*) FILTER (WHERE MaNV = $2 AND (COALESCE(TienGiamKM, 0) > 0 OR COALESCE(TienGiamDiem, 0) > 0))::int AS don_giam_nv,
                            COUNT(*)::int AS tong_don_quan,
                            COUNT(*) FILTER (WHERE COALESCE(TienGiamKM, 0) > 0 OR COALESCE(TienGiamDiem, 0) > 0)::int AS don_giam_quan
                           FROM HoaDon
                          WHERE COALESCE(TenantId, 'DEFAULT') = $1
                            AND TrangThaiTT = 1
                            AND ThoiGianThanhToan >= (date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh')`,
                        [tenantId, maNV]
                    );
                    await client.query('RELEASE SAVEPOINT sp_vel_disc');
                    const r = velRes.rows[0] || {};
                    const tongNV = Number(r.tong_don_nv || 0);
                    const giamNV = Number(r.don_giam_nv || 0);
                    const tongQuan = Number(r.tong_don_quan || 0);
                    const giamQuan = Number(r.don_giam_quan || 0);

                    if (giamNV >= 4 && tongNV >= 4) {
                        const tyLeNV = giamNV / tongNV;
                        const donKhac = Math.max(0, tongQuan - tongNV);
                        const giamKhac = Math.max(0, giamQuan - giamNV);
                        const tyLeTB = donKhac >= 3 ? giamKhac / donKhac : 0.25; // Mặc định baseline 25% nếu đầu ngày chỉ có 1 thu ngân
                        if (tyLeNV > Math.max(0.5, tyLeTB * 2) && giamNV % 4 === 0) {
                            await ghiAuditLog(client, {
                                tenantId,
                                maNV,
                                vaiTro,
                                hanhDong: 'DISCOUNT_VELOCITY_ABUSE',
                                doiTuong: 'NHANVIEN',
                                maDoiTuong: maNV,
                                giaTriMoi: {
                                    maCaThuNgan,
                                    maHoaDonMoiNhat: maHoaDon,
                                    soDonGiamNV: giamNV,
                                    tongDonNV: tongNV,
                                    tyLeGiamNVPct: Math.round(tyLeNV * 1000) / 10,
                                    tyLeTrungBinhQuanPct: Math.round(tyLeTB * 1000) / 10,
                                },
                                lyDo: `Cảnh báo tự động: Tỷ lệ áp ưu đãi của ${maNV} đạt ${Math.round(tyLeNV * 100)}% (${giamNV}/${tongNV} đơn)`,
                                ip,
                            });
                        }
                    }
                } catch {
                    await client.query('ROLLBACK TO SAVEPOINT sp_vel_disc').catch(() => {});
                }
            }
        });
    } catch {
        // Không làm gián đoạn luồng bán hàng nếu truy vấn thống kê phụ gặp lỗi
    }
}

module.exports = {
    ALERT_EVENT_META,
    kiemTraUrlWebhookAnToan,
    formatFraudAlertMessage,
    resolveAlertEventKey,
    khoiTaoCanhBaoGianLan,
    dispatchFraudAlertFromAudit,
    kiemTraCanhBaoTanSuatGianLan,
    registerFraudAlertRoutes,
};
