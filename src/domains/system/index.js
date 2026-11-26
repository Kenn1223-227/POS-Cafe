'use strict';

const crypto = require('crypto');
const {
    LoiNghiepVu,
    guiLoi,
    choPhepVaiTro,
    layTenantId,
} = require('../../core/auditAndSecurity');
const {
    emitToBranch,
    emitToTenant,
} = require('../../core/socketRooms');
const {
    xuLyThanhToanGoiTuWebhook,
    timTenantWebhookConfig,
} = require('../../../modules/saasRoutes');

function registerSystemDomain(app, deps) {
    const {
        pool,
        io,
        runtimeFlags,
        chayGiaoDich,
        qTenant,
        kiemTraToken,
        yeuCauTinhNang,
        xoaCacheEntitlement,
        ghiAuditLog,
        dispatchFraudAlertFromAudit,
        kiemTraCanhBaoTanSuatGianLan,
        xacThucPinQuanLy,
        layCaDangMo,
        layHoaDonChiTiet,
        ghiNhanThanhToanTrongGiaoDich,
    } = deps;

// ============================================================================
// [PHÂN HỆ 6] CLOUD-TO-LOCAL PRINT RELAY (Giải quyết triệt để Mixed Content HTTPS & PNA cho iPad / Android Tablet)
// Thiết bị iPad / Android Tablet chạy trên HTTPS gửi lệnh in lên Backend (/api/print-relay/dispatch),
// Local Print Bridge Agent tại quán chủ động kéo outbound (/api/print-relay/pull) về in qua LAN/USB!
// ============================================================================
const printRelayTenants = new Map(); // tenantId -> { seq: 1, lastHeartbeatAt: null, jobs: [] }

function layPrintRelayState(tenantId) {
    const key = String(tenantId || 'DEFAULT');
    let st = printRelayTenants.get(key);
    if (!st) {
        st = { seq: 1, lastHeartbeatAt: null, jobs: [], usedPrintTokens: new Set() };
        printRelayTenants.set(key, st);
    }
    return st;
}

function maskPhoneLast3ForPrint(sdt) {
    if (sdt === null || sdt === undefined) return sdt;
    const raw = String(sdt).trim();
    if (!raw) return '';
    if (raw.length <= 3) return '***';
    return `${'*'.repeat(raw.length - 3)}${raw.slice(-3)}`;
}

function sanitizePrintRelayPayloadPii(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const clone = { ...payload };
    if (clone.hoaDon && typeof clone.hoaDon === 'object') {
        clone.hoaDon = { ...clone.hoaDon };
        if (clone.hoaDon.khachHang && typeof clone.hoaDon.khachHang === 'object' && clone.hoaDon.khachHang.soDienThoai) {
            clone.hoaDon.khachHang = {
                ...clone.hoaDon.khachHang,
                soDienThoai: maskPhoneLast3ForPrint(clone.hoaDon.khachHang.soDienThoai),
            };
        }
    }
    if (clone.khachHang && typeof clone.khachHang === 'object' && clone.khachHang.soDienThoai) {
        clone.khachHang = {
            ...clone.khachHang,
            soDienThoai: maskPhoneLast3ForPrint(clone.khachHang.soDienThoai),
        };
    }
    return clone;
}

app.post('/api/print-relay/dispatch', kiemTraToken, choPhepVaiTro(1, 2, 3, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    const { kind = 'RECEIPT', payload = {} } = req.body || {};
    const validKinds = ['RECEIPT', 'LABEL', 'Z_REPORT', 'DRAWER_KICK'];
    const cleanKind = String(kind).toUpperCase();
    if (!validKinds.includes(cleanKind)) {
        return res.status(400).json({ ok: false, message: 'Loại lệnh in Relay không hợp lệ!' });
    }

    const relayBranchId = String(
        req.body?.branchId || payload?.branchId || req.headers['x-branch-id'] || req.user?.branchId || req.user?.maChiNhanh || 'DEFAULT'
    ).trim();
    const isDrawerKick = cleanKind === 'DRAWER_KICK' || Boolean(payload?.kickDrawer);
    if (isDrawerKick && ![1, 4].includes(Number(req.user?.vaiTro))) {
        return res.status(403).json({
            ok: false,
            code: 'DRAWER_KICK_FORBIDDEN',
            message: 'Chỉ Quản lý hoặc Thu ngân mới được phép gửi lệnh mở két tiền!',
        });
    }

    const st = layPrintRelayState(tenantId);

    // [P0-3] Khi kind === 'RECEIPT', bắt buộc xác thực printToken hợp lệ (khớp hóa đơn/tenant & chống tái sử dụng lách REPRINT)
    if (cleanKind === 'RECEIPT') {
        const printToken = String(req.body?.printToken || payload?.printToken || '').trim();
        const match = printToken.match(/^PRT-(.+)-(\d+)-(\d+)$/);
        if (!match) {
            return res.status(403).json({
                ok: false,
                code: 'PRINT_TOKEN_REQUIRED',
                message: 'In hóa đơn qua Print Relay bắt buộc phải có printToken hợp lệ từ /print-token!',
            });
        }
        const [, tokenMaHoaDon, tokenSoLanInStr] = match;
        const tokenSoLanIn = Number(tokenSoLanInStr);
        const payloadMaHoaDon = String(payload?.maHoaDon || payload?.hoaDon?.maHoaDon || req.body?.maHoaDon || '').trim();
        if (payloadMaHoaDon && payloadMaHoaDon !== tokenMaHoaDon) {
            return res.status(403).json({
                ok: false,
                code: 'PRINT_TOKEN_MISMATCH',
                message: 'printToken không khớp với mã hóa đơn cần in!',
            });
        }
        if (st.usedPrintTokens.has(printToken)) {
            return res.status(403).json({
                ok: false,
                code: 'PRINT_TOKEN_ALREADY_USED',
                message: 'printToken đã được sử dụng — vui lòng xin cấp lại lệnh in mới để đảm bảo watermark REPRINT!',
            });
        }
        try {
            const verifyHd = async (client) =>
                client.query(
                    `SELECT MaHoaDon, COALESCE(SoLanIn, 0) AS SoLanIn
                       FROM HoaDon
                      WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2`,
                    [tokenMaHoaDon, tenantId]
                );
            const hdRes = typeof pool?.withTenant === 'function' ? await pool.withTenant(tenantId, verifyHd) : await verifyHd(pool);
            if (!hdRes || hdRes.rows.length === 0) {
                return res.status(403).json({
                    ok: false,
                    code: 'PRINT_TOKEN_INVALID_INVOICE',
                    message: 'Hóa đơn của printToken không tồn tại trong quán hiện tại!',
                });
            }
            const currentSoLanIn = Number(hdRes.rows[0].solanin || 0);
            if (currentSoLanIn < 1 || tokenSoLanIn !== currentSoLanIn) {
                return res.status(403).json({
                    ok: false,
                    code: 'PRINT_TOKEN_STALE',
                    message: 'printToken không khớp số lần in hiện tại của hóa đơn (chống lách watermark REPRINT)!',
                });
            }
            st.usedPrintTokens.add(printToken);
            if (st.usedPrintTokens.size > 500) {
                const first = st.usedPrintTokens.values().next().value;
                st.usedPrintTokens.delete(first);
            }
        } catch (error) {
            return guiLoi(res, error, 'Lỗi xác thực printToken khi đẩy lệnh in Print Relay:');
        }
    }

    const sanitizedPayload = sanitizePrintRelayPayloadPii(payload);
    const createdAt = new Date().toISOString();
    const jobId = st.seq++;

    // [Batch 6 — Anti-Fraud] Bắt buộc ghi Audit Log mỗi lần có lệnh mở két tiền (cash drawer kick)
    if (isDrawerKick) {
        const drawerReason = String(
            req.body?.reason ||
                req.body?.lyDo ||
                payload?.reason ||
                payload?.lyDo ||
                (cleanKind === 'DRAWER_KICK' ? 'NO_SALE_RELAY' : 'CASH_RECEIPT_DRAWER_KICK')
        ).trim();
        const userId = String(req.user?.maNV || 'POS');
        const auditData = {
            userId,
            branchId: relayBranchId,
            reason: drawerReason,
            timestamp: createdAt,
            kind: cleanKind,
            jobId,
            source: 'PRINT_RELAY_DISPATCH',
        };
        try {
            const writeAudit = (client) =>
                ghiAuditLog(client, {
                    tenantId,
                    maNV: userId,
                    vaiTro: req.user?.vaiTro,
                    hanhDong: cleanKind === 'DRAWER_KICK' ? 'DRAWER_NO_SALE_KICK' : 'DRAWER_RECEIPT_KICK',
                    doiTuong: 'KET_TIEN',
                    maDoiTuong: `RELAY_${jobId}`,
                    giaTriMoi: auditData,
                    lyDo: drawerReason,
                    ip: req.ip,
                    batBuoc: true,
                });
            if (typeof pool?.withTenant === 'function') {
                await pool.withTenant(tenantId, writeAudit);
            } else {
                await writeAudit(pool);
            }
        } catch (error) {
            return guiLoi(res, error, 'Lỗi ghi Audit Log khi mở két tiền qua Print Relay:');
        }
    }

    const job = {
        id: jobId,
        tenantId,
        branchId: relayBranchId,
        kind: cleanKind,
        payload: sanitizedPayload,
        status: 'PENDING',
        createdBy: req.user?.maNV || 'POS',
        createdAt,
        pulledAt: null,
        completedAt: null,
        error: null,
    };
    st.jobs.unshift(job);
    if (st.jobs.length > 50) st.jobs.pop();

    if (relayBranchId && relayBranchId !== 'DEFAULT') {
        emitToBranch(io, {
            tenantId,
            branchId: relayBranchId,
            roles: ['POS', 'KDS'],
            event: 'PRINT_RELAY_JOB',
            payload: {
                id: job.id,
                kind: job.kind,
                createdAt: job.createdAt,
            },
        });
    } else {
        emitToTenant(io, {
            tenantId,
            roles: ['POS', 'KDS'],
            event: 'PRINT_RELAY_JOB',
            payload: {
                id: job.id,
                kind: job.kind,
                createdAt: job.createdAt,
            },
        });
    }

    res.status(201).json({
        ok: true,
        mode: 'CLOUD_RELAY',
        auditLogged: isDrawerKick,
        message: 'Đã đẩy lệnh in qua Cloud Print Relay về máy in tại quán!',
        job: { id: job.id, kind: job.kind, status: job.status, createdAt: job.createdAt },
    });
});

app.get('/api/print-relay/pull', kiemTraToken, choPhepVaiTro(1, 2, 3, 4), (req, res) => {
    const tenantId = layTenantId(req);
    const st = layPrintRelayState(tenantId);
    st.lastHeartbeatAt = Date.now();
    const nowIso = new Date().toISOString();
    const pending = st.jobs
        .filter((j) => j.status === 'PENDING')
        .slice(0, 10)
        .reverse(); // In theo thứ tự FIFO
    for (const j of pending) {
        j.status = 'PULLED';
        j.pulledAt = nowIso;
    }
    res.json({ ok: true, jobs: pending });
});

app.post('/api/print-relay/ack', kiemTraToken, choPhepVaiTro(1, 2, 3, 4), (req, res) => {
    const tenantId = layTenantId(req);
    const { jobId, status = 'DONE', error = null, transport = null, bytes = 0 } = req.body || {};
    const st = layPrintRelayState(tenantId);
    st.lastHeartbeatAt = Date.now();
    const job = st.jobs.find((j) => Number(j.id) === Number(jobId));
    if (!job) {
        return res.status(404).json({ ok: false, message: 'Không tìm thấy lệnh in Relay!' });
    }
    job.status = status === 'FAILED' ? 'FAILED' : 'DONE';
    job.completedAt = new Date().toISOString();
    job.error = error || null;
    job.transport = transport || null;
    job.bytes = Number(bytes || 0);
    res.json({ ok: true, job: { id: job.id, kind: job.kind, status: job.status } });
});

app.get('/api/print-relay/status', kiemTraToken, choPhepVaiTro(1, 2, 3, 4), (req, res) => {
    const tenantId = layTenantId(req);
    const st = layPrintRelayState(tenantId);
    const bridgeActive = Boolean(st.lastHeartbeatAt && Date.now() - st.lastHeartbeatAt < 15000);
    res.json({
        ok: true,
        bridgeActive,
        lastHeartbeatAt: st.lastHeartbeatAt ? new Date(st.lastHeartbeatAt).toISOString() : null,
        pendingCount: st.jobs.filter((j) => j.status === 'PENDING').length,
        jobs: st.jobs.slice(0, 20).map(({ payload: _p, ...meta }) => meta),
    });
});


// ==========================================
// WEBHOOK VIETQR TỰ ĐỘNG (SEPAY & PAYOS) — XÁC NHẬN KHÔNG CẦN BẤM TAY
// ==========================================
function soSanhHangThoiGian(a, b) {
    const ba = Buffer.from(String(a || ''), 'utf8');
    const bb = Buffer.from(String(b || ''), 'utf8');
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

// Xác thực SePay: Header "Authorization: Apikey <SEPAY_API_KEY>" (nếu có :tenantSlug thì bắt buộc khóa riêng của quán, không fallback global)
function xacThucSePay(req, expectedKeyOverride = null, { allowGlobalFallback = true } = {}) {
    if (!allowGlobalFallback && !expectedKeyOverride) {
        return { ok: false, status: 401, message: 'Quán chưa cấu hình SEPAY_API_KEY riêng!' };
    }
    const expected = expectedKeyOverride || (allowGlobalFallback ? process.env.SEPAY_API_KEY : null);
    if (!expected) return { ok: false, status: 503, message: 'Chưa cấu hình SEPAY_API_KEY cho quán hoặc trên máy chủ!' };
    const auth = String(req.headers['authorization'] || '').trim();
    const match = auth.match(/^(?:Apikey|Bearer)\s+(.+)$/i);
    if (!match || !soSanhHangThoiGian(match[1].trim(), expected)) {
        return { ok: false, status: 401, message: 'SePay API Key không hợp lệ!' };
    }
    return { ok: true };
}

// Xác thực PayOS: HMAC-SHA256 của các trường data sắp xếp alphabet (nếu có :tenantSlug thì bắt buộc khóa riêng của quán, không fallback global)
function xacThucPayOS(body, checksumKeyOverride = null, { allowGlobalFallback = true } = {}) {
    if (!allowGlobalFallback && !checksumKeyOverride) {
        return { ok: false, status: 401, message: 'Quán chưa cấu hình PAYOS_CHECKSUM_KEY riêng!' };
    }
    const checksumKey = checksumKeyOverride || (allowGlobalFallback ? process.env.PAYOS_CHECKSUM_KEY : null);
    if (!checksumKey) return { ok: false, status: 503, message: 'Chưa cấu hình PAYOS_CHECKSUM_KEY cho quán hoặc trên máy chủ!' };
    if (!body || typeof body.data !== 'object' || !body.data || typeof body.signature !== 'string') {
        return { ok: false, status: 400, message: 'Thiếu data hoặc signature PayOS!' };
    }
    const sortedKeys = Object.keys(body.data).sort();
    const queryStr = sortedKeys
        .map((k) => {
            let v = body.data[k];
            if (v === null || v === undefined || v === 'null' || v === 'undefined') v = '';
            else if (typeof v === 'object') v = JSON.stringify(v);
            return `${k}=${v}`;
        })
        .join('&');
    const computed = crypto.createHmac('sha256', checksumKey).update(queryStr).digest('hex');
    if (!soSanhHangThoiGian(computed.toLowerCase(), body.signature.toLowerCase())) {
        return { ok: false, status: 401, message: 'Chữ ký HMAC-SHA256 PayOS không hợp lệ!' };
    }
    return { ok: true };
}

// Khớp hóa đơn đang mở (TrangThaiTT = 0) từ nội dung chuyển khoản (VD: "POSHD1024", "POS HD-1024", "HD1024"), có lọc cứng theo expectedTenantId
async function timHoaDonMoTuNoiDungCK(client, noiDungCK, fallbackOrderCode = null, expectedTenantId = null) {
    const raw = String(noiDungCK || '').toUpperCase();
    const candidates = new Set();

    const regexes = [
        /POS[\s\-_]*HD[\s\-_]*([A-Z0-9](?:[A-Z0-9\-_]{0,35}[A-Z0-9])?)/g,
        /\bHD[\s\-_]*([A-Z0-9](?:[A-Z0-9\-_]{0,35}[A-Z0-9])?)\b/g,
    ];
    for (const rx of regexes) {
        let m;
        while ((m = rx.exec(raw)) !== null) {
            if (m[1]) {
                candidates.add(m[1]);
                candidates.add(`HD${m[1]}`);
                const firstSeg = m[1].split('-')[0];
                if (firstSeg && firstSeg !== m[1]) {
                    candidates.add(firstSeg);
                    candidates.add(`HD${firstSeg}`);
                }
            }
        }
    }
    if (fallbackOrderCode !== null && fallbackOrderCode !== undefined && String(fallbackOrderCode).trim()) {
        candidates.add(String(fallbackOrderCode).trim().toUpperCase());
    }

    if (candidates.size === 0) return null;
    const normalizedList = [...candidates].map((c) => c.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
    if (normalizedList.length === 0) return null;

    if (expectedTenantId) {
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [String(expectedTenantId)]);
    }

    let r;
    try {
        await client.query('SAVEPOINT sp_lookup_inv');
        if (expectedTenantId) {
            r = await client.query(
                'SELECT MaHoaDon, TenantId FROM public.fn_lookup_open_invoice_by_codes($1::text[], $2::text)',
                [normalizedList, String(expectedTenantId)]
            );
        } else {
            // [P0 FIX Phân hệ 7] Truyền tường minh $2 = NULL::text để tuyệt đối không mơ hồ overload PostgreSQL
            r = await client.query(
                'SELECT MaHoaDon, TenantId FROM public.fn_lookup_open_invoice_by_codes($1::text[], NULL::text)',
                [normalizedList]
            );
        }
        await client.query('RELEASE SAVEPOINT sp_lookup_inv');
        if (r.rows.length && r.rows[0].tenantid) {
            await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [String(r.rows[0].tenantid)]);
        }
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_lookup_inv').catch(() => {});
        r = await client.query(
            `SELECT MaHoaDon
               FROM HoaDon
              WHERE TrangThaiTT = 0
                AND ($2::text IS NULL OR COALESCE(TenantId, 'DEFAULT') = $2)
                AND (
                    UPPER(MaHoaDon::text) = ANY($1::text[])
                    OR REGEXP_REPLACE(UPPER(MaHoaDon::text), '[^A-Z0-9]', '', 'g') = ANY($1::text[])
                )
              ORDER BY ThoiGianTao DESC
              LIMIT 1`,
            [normalizedList, expectedTenantId ? String(expectedTenantId) : null]
        );
    }
    return r.rows.length ? r.rows[0].mahoadon : null;
}

// Khớp hóa đơn bất kỳ (TrangThaiTT IN (0, 1)) từ nội dung CK để phân biệt chính xác ca Chuyển trùng (ALREADY_PAID) vs Chưa khớp (UNMATCHED)
async function timHoaDonBatKyTuNoiDungCK(client, noiDungCK, fallbackOrderCode = null, expectedTenantId = null) {
    const raw = String(noiDungCK || '').toUpperCase();
    const candidates = new Set();

    const regexes = [
        /(?:POS|TT)[\s\-_]*HD[\s\-_]*([A-Z0-9](?:[A-Z0-9\-_]{0,35}[A-Z0-9])?)/g,
        /\bTT([A-Z0-9_]{2,36})\b/g,
        /\bHD[\s\-_]*([A-Z0-9](?:[A-Z0-9\-_]{0,35}[A-Z0-9])?)\b/g,
    ];
    for (const rx of regexes) {
        let m;
        while ((m = rx.exec(raw)) !== null) {
            if (m[1]) {
                candidates.add(m[1]);
                candidates.add(`HD${m[1]}`);
                const firstSeg = m[1].split('-')[0];
                if (firstSeg && firstSeg !== m[1]) {
                    candidates.add(firstSeg);
                    candidates.add(`HD${firstSeg}`);
                }
            }
        }
    }
    if (fallbackOrderCode !== null && fallbackOrderCode !== undefined && String(fallbackOrderCode).trim()) {
        candidates.add(String(fallbackOrderCode).trim().toUpperCase());
    }

    if (candidates.size === 0) return null;
    const normalizedList = [...candidates].map((c) => c.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
    if (normalizedList.length === 0) return null;

    if (expectedTenantId) {
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [String(expectedTenantId)]);
    }

    let r;
    try {
        await client.query('SAVEPOINT sp_lookup_any_inv');
        r = await client.query(
            'SELECT MaHoaDon, TenantId, TrangThaiTT, BranchId FROM public.fn_lookup_any_invoice_by_codes($1::text[], $2::text)',
            [normalizedList, expectedTenantId ? String(expectedTenantId) : null]
        );
        await client.query('RELEASE SAVEPOINT sp_lookup_any_inv');
        if (r.rows.length && r.rows[0].tenantid) {
            await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [String(r.rows[0].tenantid)]);
        }
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_lookup_any_inv').catch(() => {});
        const maHD = await timHoaDonMoTuNoiDungCK(client, noiDungCK, fallbackOrderCode, expectedTenantId);
        return maHD ? { maHoaDon: maHD, tenantId: expectedTenantId || 'DEFAULT', trangThaiTT: 0, branchId: null } : null;
    }
    if (!r.rows.length) return null;
    return {
        maHoaDon: r.rows[0].mahoadon,
        tenantId: r.rows[0].tenantid || expectedTenantId || 'DEFAULT',
        trangThaiTT: Number(r.rows[0].trangthaitt || 0),
        branchId: r.rows[0].branchid || null,
    };
}

// Bộ xử lý lõi biến động số dư VietQR (Phân hệ 3: Multi-Tenant STK + Đủ 5 ca biên Exact/Partial/Overpay/DoublePay/Unmatched)
async function xuLyBienDongSoDuVietQR({
    nhaCungCap,
    maGiaoDichNgoai,
    soTien,
    noiDungCK,
    soTaiKhoanNhan = null,
    fallbackOrderCode = null,
    expectedTenantId = null,
    expectedAccountNo = null,
    payloadGoc = null,
    maNV = 'VIETQR_BOT',
    ip = null,
}) {
    const extId = String(maGiaoDichNgoai || '').trim().slice(0, 128);
    const amount = Math.round(Number(soTien) * 100) / 100;
    const accNoKey = String(soTaiKhoanNhan || expectedAccountNo || expectedTenantId || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 64);
    if (!extId || !(amount > 0)) {
        throw new LoiNghiepVu(400, 'Thiếu mã giao dịch ngoài hoặc số tiền chuyển khoản không hợp lệ!');
    }

    const capNhatWebhookLog = async (
        client,
        eventId,
        trangThai,
        maHdKhop = null,
        tId = null,
        { soTienConLai = null, trangThaiXuLyDu = null } = {}
    ) => {
        if (!runtimeFlags.vietQrLogSanSang || !eventId) return;
        await client.query('SAVEPOINT sp_upd_wh_evt');
        try {
            await client.query(
                `SELECT public.fn_update_webhook_event_v2($1::bigint, $2::varchar, $3::text, $4::varchar, $5::numeric, $6::varchar)`,
                [
                    Number(eventId),
                    trangThai,
                    maHdKhop ? String(maHdKhop) : null,
                    tId ? String(tId) : null,
                    soTienConLai !== null ? Number(soTienConLai) : null,
                    trangThaiXuLyDu || null,
                ]
            );
            await client.query('RELEASE SAVEPOINT sp_upd_wh_evt');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_upd_wh_evt').catch(() => {});
            await client.query(
                `UPDATE VietQR_Webhook_Events
                    SET TrangThaiXuLy = $2,
                        MaHoaDonKhop = COALESCE($3, MaHoaDonKhop),
                        TenantId = COALESCE($4, TenantId),
                        SoTienConLai = COALESCE($5, SoTienConLai),
                        TrangThaiXuLyDu = COALESCE($6, TrangThaiXuLyDu)
                  WHERE Id = $1`,
                [
                    Number(eventId),
                    trangThai,
                    maHdKhop ? String(maHdKhop) : null,
                    tId ? String(tId) : null,
                    soTienConLai !== null ? Number(soTienConLai) : null,
                    trangThaiXuLyDu || null,
                ]
            ).catch(() => {});
        }
    };

    const ketQua = await chayGiaoDich(async (client) => {
        let webhookEventId = null;
        if (runtimeFlags.vietQrLogSanSang) {
            await client.query('SAVEPOINT sp_ins_wh_evt');
            try {
                // [Phân hệ 3 FIX] Chống trùng theo (NhaCungCap, SoTaiKhoanNhan, MaGiaoDichNgoai) — không bao giờ nuốt tiền quán khác!
                const fnIns = await client.query(
                    `SELECT public.fn_record_webhook_event_v2($1::varchar, $2::varchar, $3::varchar, $4::numeric, $5::text, $6::jsonb, $7::varchar, NULL::varchar) AS event_id`,
                    [
                        nhaCungCap,
                        accNoKey,
                        extId,
                        amount,
                        noiDungCK || '',
                        JSON.stringify(payloadGoc || {}),
                        expectedTenantId || 'SYSTEM_UNMATCHED',
                    ]
                );
                await client.query('RELEASE SAVEPOINT sp_ins_wh_evt');
                webhookEventId = fnIns.rows[0]?.event_id ? Number(fnIns.rows[0].event_id) : null;
            } catch {
                await client.query('ROLLBACK TO SAVEPOINT sp_ins_wh_evt').catch(() => {});
                const ins = await client.query(
                    `INSERT INTO VietQR_Webhook_Events
                        (NhaCungCap, SoTaiKhoanNhan, MaGiaoDichNgoai, SoTien, NoiDungCK, TrangThaiXuLy, PayloadGoc, TenantId)
                     VALUES ($1, $2, $3, $4, $5, 'PROCESSING', $6::jsonb, $7)
                     ON CONFLICT (nhacungcap, sotaikhoannhan, magiaodichngoai) DO NOTHING
                     RETURNING Id`,
                    [nhaCungCap, accNoKey, extId, amount, noiDungCK || '', JSON.stringify(payloadGoc || {}), expectedTenantId || 'SYSTEM_UNMATCHED']
                );
                webhookEventId = ins.rows[0]?.id ? Number(ins.rows[0].id) : null;
            }
            if (!webhookEventId) {
                return { duplicate: true, trangThaiXuLy: 'DUPLICATE_IGNORED' };
            }
        }

        // Kiểm tra khớp STK thụ hưởng nếu có cấu hình riêng cho quán
        if (expectedTenantId && expectedAccountNo && soTaiKhoanNhan) {
            const expAccClean = String(expectedAccountNo).replace(/[^0-9A-Za-z]/g, '');
            const incAccClean = String(soTaiKhoanNhan).replace(/[^0-9A-Za-z]/g, '');
            if (expAccClean && incAccClean && expAccClean !== incAccClean) {
                await capNhatWebhookLog(client, webhookEventId, 'ACCOUNT_MISMATCH', null, expectedTenantId);
                return {
                    duplicate: false,
                    matched: false,
                    webhookEventId,
                    trangThaiXuLy: 'ACCOUNT_MISMATCH',
                    message: 'Số tài khoản nhận tiền không khớp với cấu hình VietQR của quán!',
                };
            }
        }

        // Kiểm tra thanh toán nâng cấp gói SaaS (SUB...) nếu gọi qua webhook toàn cục
        if (!expectedTenantId) {
            const subPay = await xuLyThanhToanGoiTuWebhook(client, {
                noiDungCK,
                soTien: amount,
                maGiaoDichNgoai: extId,
                nhaCungCap,
                ghiAuditLog,
                ip,
            });
            if (subPay?.matched) {
                const st = subPay.activated ? 'SUBSCRIPTION_PAID' : subPay.insufficient ? 'SUBSCRIPTION_PARTIAL' : 'SUBSCRIPTION_DUP';
                await capNhatWebhookLog(client, webhookEventId, st, subPay.maDon, subPay.tenantId || 'DEFAULT');
                if (subPay.activated && subPay.tenantId) xoaCacheEntitlement(subPay.tenantId);
                return { duplicate: false, matched: true, webhookEventId, isSubscription: true, trangThaiXuLy: st, ...subPay };
            }
        }

        // Tra cứu hóa đơn bất kể trạng thái 0 hoặc 1 để bắt trúng ca Chuyển trùng giây thu Tiền mặt!
        const found = await timHoaDonBatKyTuNoiDungCK(client, noiDungCK, fallbackOrderCode, expectedTenantId);
        if (!found) {
            await capNhatWebhookLog(client, webhookEventId, 'UNMATCHED', null, expectedTenantId || 'SYSTEM_UNMATCHED', {
                soTienConLai: amount,
                trangThaiXuLyDu: 'NONE',
            });
            return {
                duplicate: false,
                matched: false,
                webhookEventId,
                tenantId: expectedTenantId || null,
                trangThaiXuLy: 'UNMATCHED',
                soTienNhan: amount,
                noiDungCK,
            };
        }

        const maHoaDon = found.maHoaDon;
        // [Wave 1 — P0-03] Dùng SECURITY DEFINER fn_resolve_invoice_for_webhook để đọc đúng tenantId & bankAccountNo dưới FORCE RLS
        let resolvedInv = null;
        await client.query('SAVEPOINT sp_resolve_wh_inv');
        try {
            const fnRes = await client.query(
                `SELECT tenant_id, ma_hoa_don, lifecycle_status, trang_thai_tt, tong_tien, da_thanh_toan, bank_account_no, bank_bin
                   FROM public.fn_resolve_invoice_for_webhook($1::varchar)`,
                [String(maHoaDon)]
            );
            await client.query('RELEASE SAVEPOINT sp_resolve_wh_inv');
            resolvedInv = fnRes.rows[0] || null;
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_resolve_wh_inv').catch(() => {});
            const fallbackRes = await client.query(
                `SELECT COALESCE(hd.TenantId, 'DEFAULT') AS tenant_id,
                        hd.MaHoaDon AS ma_hoa_don,
                        COALESCE(to_jsonb(hd)->>'lifecycle_status', 'OPEN') AS lifecycle_status,
                        hd.TrangThaiTT AS trang_thai_tt,
                        COALESCE(t.ThongTinNganHang->>'soTaiKhoan', t.ThongTinNganHang->>'accountNo', '') AS bank_account_no
                   FROM HoaDon hd
                   LEFT JOIN Tenants t ON t.TenantId = COALESCE(hd.TenantId, 'DEFAULT')
                  WHERE hd.MaHoaDon = $1`,
                [maHoaDon]
            );
            resolvedInv = fallbackRes.rows[0] || null;
        }

        const hdTenantId = resolvedInv?.tenant_id || found.tenantId || 'DEFAULT';
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [hdTenantId]);
        let hdBranchId = 'DEFAULT';
        try {
            const brRes = await client.query(
                `SELECT COALESCE(NULLIF(to_jsonb(HoaDon)->>'branchid', ''), 'DEFAULT') AS branchid
                   FROM HoaDon
                  WHERE MaHoaDon = $1`,
                [maHoaDon]
            );
            hdBranchId = brRes.rows[0]?.branchid || 'DEFAULT';
        } catch {
            hdBranchId = 'DEFAULT';
        }
        const expectedAcc = String(resolvedInv?.bank_account_no || '').replace(/[^0-9A-Za-z]/g, '');
        const incomingAcc = String(soTaiKhoanNhan || '').replace(/[^0-9A-Za-z]/g, '');
        if (expectedAcc && incomingAcc && expectedAcc !== incomingAcc) {
            await capNhatWebhookLog(client, webhookEventId, 'ACCOUNT_MISMATCH', maHoaDon, hdTenantId);
            return {
                duplicate: false,
                matched: false,
                webhookEventId,
                trangThaiXuLy: 'ACCOUNT_MISMATCH',
                message: 'Số tài khoản nhận tiền không khớp với cấu hình VietQR của quán sở hữu hóa đơn!',
            };
        }

        const handlePendingAction = async (trangThaiLog = 'PENDING_ACTION', lyDoCanhBao = null) => {
            await capNhatWebhookLog(client, webhookEventId, trangThaiLog, maHoaDon, hdTenantId, {
                soTienConLai: amount,
                trangThaiXuLyDu: 'PENDING_ACTION',
            });
            await ghiAuditLog(client, {
                tenantId: hdTenantId,
                maNV,
                hanhDong: trangThaiLog === 'ALREADY_PAID' ? 'VIETQR_DOUBLE_PAID_PENDING' : 'VIETQR_SETTLE_PENDING_ACTION',
                doiTuong: 'HOADON',
                maDoiTuong: maHoaDon,
                giaTriMoi: { webhookEventId, nhaCungCap, maGiaoDichNgoai: extId, soTienNhan: amount, trangThaiLog },
                lyDo: lyDoCanhBao || `Webhook VietQR cho HĐ #${maHoaDon} cần Thu ngân kiểm tra & xử lý (PENDING_ACTION)`,
                ip,
                batBuoc: true,
            });
            return {
                duplicate: false,
                matched: true,
                doublePaid: trangThaiLog === 'ALREADY_PAID',
                pendingAction: true,
                webhookEventId,
                tenantId: hdTenantId,
                branchId: hdBranchId,
                trangThaiXuLy: trangThaiLog,
                trangThaiXuLyDu: 'PENDING_ACTION',
                nhaCungCap,
                maHoaDon,
                soTienNhan: amount,
                soTienConLai: amount,
                daHoanTat: trangThaiLog === 'ALREADY_PAID',
                lyDoCanhBao,
            };
        };

        // [Wave 1 — P0-03] Nếu hóa đơn đã chốt trước bằng POS_MANUAL_PROVISIONAL và khớp số tiền -> NÂNG CẤP thành WEBHOOK_VERIFIED!
        if (Number(resolvedInv?.trang_thai_tt) === 1 && runtimeFlags.paymentsSanSang) {
            const provRes = await client.query(
                `SELECT Id, SoTien
                   FROM Order_Payments
                  WHERE MaHoaDon = $1
                    AND COALESCE(TenantId, 'DEFAULT') = $2
                    AND NguonXacNhan = 'POS_MANUAL_PROVISIONAL'
                    AND ABS(COALESCE(SoTien, 0) - $3) <= 1000
                  ORDER BY Id ASC
                  LIMIT 1
                  FOR UPDATE`,
                [String(maHoaDon), hdTenantId, amount]
            );
            if (provRes.rows.length > 0) {
                const provRow = provRes.rows[0];
                await client.query(
                    `UPDATE Order_Payments
                        SET NguonXacNhan = 'WEBHOOK_VERIFIED',
                            MaGiaoDichNgoai = $2
                      WHERE Id = $1`,
                    [provRow.id, extId]
                );
                await capNhatWebhookLog(client, webhookEventId, 'MATCHED_PAID', maHoaDon, hdTenantId, {
                    soTienConLai: 0,
                    trangThaiXuLyDu: 'NONE',
                });
                await ghiAuditLog(client, {
                    tenantId: hdTenantId,
                    maNV,
                    hanhDong: 'VIETQR_PROVISIONAL_VERIFIED',
                    doiTuong: 'HOADON',
                    maDoiTuong: maHoaDon,
                    giaTriMoi: { paymentId: provRow.id, webhookEventId, maGiaoDichNgoai: extId, soTienNhan: amount },
                    lyDo: `Webhook ${nhaCungCap} về trễ đã đối soát nâng cấp dòng POS_MANUAL_PROVISIONAL -> WEBHOOK_VERIFIED`,
                    ip,
                });
                return {
                    duplicate: false,
                    matched: true,
                    upgradedProvisional: true,
                    webhookEventId,
                    tenantId: hdTenantId,
                    trangThaiXuLy: 'MATCHED_PAID',
                    trangThaiXuLyDu: 'NONE',
                    nhaCungCap,
                    maHoaDon,
                    soTienNhan: amount,
                    daHoanTat: true,
                };
            }
            return handlePendingAction('ALREADY_PAID', `Khách chuyển khoản trùng sau khi HĐ #${maHoaDon} đã thu tiền — chờ xử lý hoàn/thối/nạp ví`);
        }

        // Nếu hóa đơn đã VOIDED / MERGED / REFUNDED -> vẫn COMMIT dòng webhook với PENDING_ACTION (tuyệt đối không rollback mất log tiền vào!)
        if (['VOIDED', 'MERGED', 'REFUNDED'].includes(String(resolvedInv?.lifecycle_status || '').toUpperCase())) {
            return handlePendingAction(
                'PENDING_ACTION',
                `Tiền chuyển khoản ${amount.toLocaleString('vi-VN')}đ đổ vào HĐ #${maHoaDon} đang ở trạng thái ${resolvedInv.lifecycle_status}`
            );
        }

        const ca = await layCaDangMo(client, 'SHARE', hdTenantId, { branchId: hdBranchId });

        let ttRes;
        await client.query('SAVEPOINT sp_vietqr_settle');
        try {
            ttRes = await ghiNhanThanhToanTrongGiaoDich(client, {
                maHoaDon,
                expectedTenantId: hdTenantId,
                mandatoryVersion: false,
                ca,
                maNV,
                cacKhoanTT: [
                    {
                        phuongThucTT: 'CHUYEN_KHOAN',
                        soTien: amount,
                        maGiaoDichNgoai: extId,
                        noiDungCK: noiDungCK || '',
                        nguonXacNhan: nhaCungCap,
                    },
                ],
                choPhepThuMotPhan: true,
                ip,
            });
            await client.query('RELEASE SAVEPOINT sp_vietqr_settle');
        } catch (settleErr) {
            await client.query('ROLLBACK TO SAVEPOINT sp_vietqr_settle').catch(() => {});
            // Bắt mọi lỗi nghiệp vụ (400/404/409) & DB để COMMIT dòng vietqr_webhook_events với PENDING_ACTION + cảnh báo đỏ POS!
            const isAlreadyPaid = settleErr instanceof LoiNghiepVu && (settleErr.chiTiet?.code ?? settleErr.details?.code) === 'ALREADY_PAID';
            return handlePendingAction(
                isAlreadyPaid ? 'ALREADY_PAID' : 'PENDING_ACTION',
                settleErr?.message || `Lỗi đối soát tự động HĐ #${maHoaDon}`
            );
        }

        const overpay = Number(ttRes.tienChuyenThua || 0);
        const trangThaiXuLy = ttRes.daHoanTat ? 'MATCHED_PAID' : 'PARTIAL_PAID';
        const trangThaiXuLyDu = overpay > 0 ? 'PENDING_ACTION' : 'NONE';
        await capNhatWebhookLog(client, webhookEventId, trangThaiXuLy, maHoaDon, hdTenantId, {
            soTienConLai: overpay,
            trangThaiXuLyDu,
        });

        await ghiAuditLog(client, {
            tenantId: hdTenantId,
            maNV,
            hanhDong: ttRes.daHoanTat ? 'VIETQR_AUTO_SETTLED' : 'VIETQR_PARTIAL_RECEIVED',
            doiTuong: 'HOADON',
            maDoiTuong: maHoaDon,
            giaTriMoi: {
                webhookEventId,
                nhaCungCap,
                maGiaoDichNgoai: extId,
                soTienNhan: amount,
                tienChuyenThua: overpay,
                tongDaThu: ttRes.tongSauThu,
                conLai: ttRes.conLai,
                daHoanTat: ttRes.daHoanTat,
            },
            lyDo: noiDungCK || `Tự động đối soát ${nhaCungCap}`,
            ip,
        });

        return {
            duplicate: false,
            matched: true,
            webhookEventId,
            tenantId: hdTenantId,
            branchId: ttRes.branchId || ttRes.hoaDon?.branchId || hdBranchId,
            trangThaiXuLy,
            trangThaiXuLyDu,
            nhaCungCap,
            maHoaDon,
            soTienNhan: amount,
            ...ttRes,
        };
    });

    if (!ketQua.duplicate && !ketQua.isSubscription) {
        const tId = ketQua.tenantId || ketQua.hoaDon?.tenantId || expectedTenantId || 'DEFAULT';
        const bId = ketQua.branchId || ketQua.hoaDon?.branchId || 'DEFAULT';
        if (ketQua.doublePaid || ketQua.pendingAction) {
            emitToBranch(io, {
                tenantId: tId,
                branchId: bId,
                roles: ['POS'],
                event: 'payment:vietqr_double_paid',
                payload: {
                    webhookEventId: ketQua.webhookEventId,
                    maHoaDon: ketQua.maHoaDon,
                    soTienNhan: ketQua.soTienNhan,
                    trangThaiXuLy: ketQua.trangThaiXuLy,
                    trangThaiXuLyDu: 'PENDING_ACTION',
                    message:
                        ketQua.lyDoCanhBao ||
                        `⚠️ Tiền chuyển khoản ${ketQua.soTienNhan.toLocaleString('vi-VN')}đ cho HĐ #${ketQua.maHoaDon} cần Thu ngân xử lý ngay!`,
                },
            });
        } else if (ketQua.trangThaiXuLy === 'UNMATCHED' && tId && tId !== 'SYSTEM_UNMATCHED') {
            emitToTenant(io, {
                tenantId: tId,
                roles: ['POS'],
                event: 'payment:vietqr_unmatched',
                payload: {
                    webhookEventId: ketQua.webhookEventId,
                    soTienNhan: ketQua.soTienNhan,
                    noiDungCK: ketQua.noiDungCK,
                },
            });
        } else if (ketQua.matched) {
            for (const maBan of ketQua.banDaTrong || []) {
                emitToBranch(io, {
                    tenantId: tId,
                    branchId: bId,
                    roles: ['POS', 'WAITER'],
                    event: 'BAN_THAY_DOI',
                    payload: { maBan, trangThai: 3 },
                });
            }
            if (ketQua.daHoanTat) {
                if (ketQua.kdsEmitPlan && typeof ketQua.kdsEmitPlan.flush === 'function') {
                    ketQua.kdsEmitPlan.flush();
                }
                emitToBranch(io, {
                    tenantId: tId,
                    branchId: bId,
                    roles: ['POS'],
                    event: 'HOADON_DA_TT',
                    payload: { maHoaDon: ketQua.maHoaDon },
                });
            }
            const payloadEmit = {
                webhookEventId: ketQua.webhookEventId,
                nhaCungCap: ketQua.nhaCungCap,
                maHoaDon: ketQua.maHoaDon,
                branchId: bId,
                tenBan: ketQua.hoaDon?.ban?.map((b) => b.tenBan).join(', ') || 'Mang đi',
                soTienNhan: ketQua.soTienNhan,
                tienChuyenThua: ketQua.tienChuyenThua || 0,
                trangThaiXuLyDu: ketQua.trangThaiXuLyDu || 'NONE',
                chuaGanCa: !ketQua.maCaThuNgan,
                tongDaThu: ketQua.tongSauThu,
                conLai: ketQua.conLai,
                daHoanTat: ketQua.daHoanTat,
                diemCong: ketQua.diemCong,
                hoaDon: ketQua.hoaDon,
            };
            emitToBranch(io, {
                tenantId: tId,
                branchId: bId,
                roles: ['POS', 'WAITER'],
                event: 'VIETQR_DA_NHAN',
                payload: payloadEmit,
            });
            if (ketQua.tienChuyenThua > 0) {
                emitToBranch(io, {
                    tenantId: tId,
                    branchId: bId,
                    roles: ['POS'],
                    event: 'payment:vietqr_overpaid',
                    payload: payloadEmit,
                });
            } else if (ketQua.daHoanTat) {
                emitToBranch(io, {
                    tenantId: tId,
                    branchId: bId,
                    roles: ['POS'],
                    event: 'payment:vietqr_settled',
                    payload: payloadEmit,
                });
            } else {
                emitToBranch(io, {
                    tenantId: tId,
                    branchId: bId,
                    roles: ['POS'],
                    event: 'payment:vietqr_partial',
                    payload: payloadEmit,
                });
            }
        }
    }

    return ketQua;
}

// Endpoint Webhook SePay (hỗ trợ cả /api/webhooks/sepay/:tenantSlug theo từng quán & /api/webhooks/sepay toàn cục)
app.post(['/api/webhooks/sepay', '/api/webhooks/sepay/:tenantSlug'], async (req, res) => {
    let tenantCfg = null;
    if (req.params.tenantSlug) {
        tenantCfg = await timTenantWebhookConfig(pool, req.params.tenantSlug);
        if (!tenantCfg) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy quán tương ứng với đường dẫn Webhook này!' });
        }
    }

    const auth = xacThucSePay(req, tenantCfg?.sepayApiKey || null, {
        allowGlobalFallback: !req.params.tenantSlug,
    });
    if (!auth.ok) return res.status(auth.status).json({ success: false, message: auth.message });

    const body = req.body || {};
    if (body.transferType && body.transferType !== 'in') {
        return res.status(200).json({ success: true, ignored: true, reason: 'OUTGOING_TRANSFER' });
    }

    const maGD = body.id ? `SEPAY_${body.id}` : body.referenceCode ? `SEPAY_${body.referenceCode}` : null;
    try {
        const result = await xuLyBienDongSoDuVietQR({
            nhaCungCap: 'SEPAY_WEBHOOK',
            maGiaoDichNgoai: maGD,
            soTien: body.transferAmount,
            noiDungCK: body.content || body.description || '',
            soTaiKhoanNhan: body.accountNumber || body.subAccount || null,
            fallbackOrderCode: body.code || null,
            expectedTenantId: tenantCfg?.tenantId || null,
            expectedAccountNo: tenantCfg?.accountNo || null,
            payloadGoc: body,
            ip: req.ip,
        });
        res.status(200).json({ success: true, ...result });
    } catch (error) {
        guiLoi(res, error, 'Lỗi Webhook SePay:');
    }
});

// Endpoint Webhook PayOS (hỗ trợ cả /api/webhooks/payos/:tenantSlug theo từng quán & /api/webhooks/payos toàn cục)
app.post(['/api/webhooks/payos', '/api/webhooks/payos/:tenantSlug'], async (req, res) => {
    const body = req.body || {};
    if (body.code === '00' && body.data && body.data.orderCode === 123 && body.data.description === 'VQRIO123') {
        return res.status(200).json({ success: true, message: 'PayOS webhook verified' });
    }

    let tenantCfg = null;
    if (req.params.tenantSlug) {
        tenantCfg = await timTenantWebhookConfig(pool, req.params.tenantSlug);
        if (!tenantCfg) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy quán tương ứng với đường dẫn Webhook này!' });
        }
    }

    const auth = xacThucPayOS(body, tenantCfg?.payosChecksumKey || null, {
        allowGlobalFallback: !req.params.tenantSlug,
    });
    if (!auth.ok) return res.status(auth.status).json({ success: false, message: auth.message });
    if (body.code !== '00' || body.success === false) {
        return res.status(200).json({ success: true, ignored: true });
    }

    const data = body.data || {};
    const maGD = `PAYOS_${data.reference || data.paymentLinkId || data.orderCode}_${data.amount}`;
    try {
        const result = await xuLyBienDongSoDuVietQR({
            nhaCungCap: 'PAYOS_WEBHOOK',
            maGiaoDichNgoai: maGD,
            soTien: data.amount,
            noiDungCK: data.description || '',
            soTaiKhoanNhan: data.accountNumber || null,
            fallbackOrderCode: data.orderCode || null,
            expectedTenantId: tenantCfg?.tenantId || null,
            expectedAccountNo: tenantCfg?.accountNo || null,
            payloadGoc: body,
            ip: req.ip,
        });
        res.status(200).json({ success: true, ...result });
    } catch (error) {
        guiLoi(res, error, 'Lỗi Webhook PayOS:');
    }
});

// [Demo/QA] Giả lập nhận biến động số dư VietQR — CHỈ QUẢN LÝ (cô lập TenantId)
app.post('/api/webhooks/vietqr/test-simulate', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('vietqr_webhook'), async (req, res) => {
    const { maHoaDon, soTien, nhaCungCap = 'SEPAY_WEBHOOK' } = req.body || {};
    const tenantId = layTenantId(req);
    if (!maHoaDon) return res.status(400).json({ message: 'Vui lòng cung cấp maHoaDon!' });

    try {
        const hd = await pool.withTenant(tenantId, async (client) => {
            const own = await client.query(
                "SELECT 1 FROM HoaDon WHERE MaHoaDon = $1 AND COALESCE(TenantId, 'DEFAULT') = $2",
                [maHoaDon, tenantId]
            );
            if (own.rows.length === 0) return null;
            return layHoaDonChiTiet(client, maHoaDon);
        });
        if (!hd) return res.status(404).json({ message: 'Không tìm thấy hóa đơn!' });
        const amount = soTien !== undefined && Number(soTien) > 0 ? Number(soTien) : hd.conLaiCanThu;
        if (!(amount > 0)) return res.status(409).json({ message: 'Hóa đơn này đã thu đủ tiền!' });

        const result = await xuLyBienDongSoDuVietQR({
            nhaCungCap: ['SEPAY_WEBHOOK', 'PAYOS_WEBHOOK'].includes(nhaCungCap) ? nhaCungCap : 'WEBHOOK_SIMULATOR',
            maGiaoDichNgoai: `SIM_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
            soTien: amount,
            noiDungCK: `POSHD${maHoaDon}`,
            fallbackOrderCode: maHoaDon,
            payloadGoc: { simulatedBy: req.user.maNV, maHoaDon, amount },
            maNV: req.user.maNV,
            ip: req.ip,
        });
        res.json({
            message: result.daHoanTat
                ? `Đã giả lập nhận CK ${amount.toLocaleString('vi-VN')}đ & tự động chốt HĐ #${maHoaDon}!`
                : `Đã giả lập nhận CK 1 phần ${amount.toLocaleString('vi-VN')}đ (còn thiếu ${result.conLai.toLocaleString('vi-VN')}đ)!`,
            ...result,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi Giả lập Webhook VietQR:');
    }
});

// Danh sách log biến động số dư VietQR cho Quản lý đối soát (cô lập theo TenantId)
app.get('/api/webhooks/vietqr/logs', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('vietqr_webhook'), async (req, res) => {
    if (!runtimeFlags.vietQrLogSanSang) return res.json([]);
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    const tenantId = layTenantId(req);
    try {
        const r = await qTenant(
            req,
            `SELECT Id, NhaCungCap, MaGiaoDichNgoai, SoTien, NoiDungCK, MaHoaDonKhop, TrangThaiXuLy, ThoiGianNhan
               FROM VietQR_Webhook_Events
              WHERE COALESCE(TenantId, 'DEFAULT') = $2
              ORDER BY ThoiGianNhan DESC
              LIMIT $1`,
            [limit, tenantId]
        );
        res.json(r.rows.map((row) => ({
            id: row.id,
            nhaCungCap: row.nhacungcap,
            maGiaoDichNgoai: row.magiaodichngoai,
            soTien: Number(row.sotien),
            noiDungCK: row.noidungck,
            maHoaDonKhop: row.mahoadonkhop || null,
            trangThaiXuLy: row.trangthaixuly,
            thoiGianNhan: row.thoigiannhan,
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Log Webhook VietQR:');
    }
});


// [Batch 6 — Anti-Fraud] Xác thực mã PIN Quản lý cho thao tác nhạy cảm trên POS (VD: Xóa đơn Offline Queue) + ghi Audit Log
app.post('/api/pos/verify-manager-pin', kiemTraToken, choPhepVaiTro(1, 2, 3, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    const {
        managerPin = '',
        maNVDuyet = null,
        action = 'OFFLINE_QUEUE_ITEM_DELETED',
        lyDo = 'Xác thực PIN Quản lý thao tác POS nhạy cảm',
        details = {},
    } = req.body || {};

    if (!String(managerPin || '').trim()) {
        return res.status(403).json({
            ok: false,
            code: 'CAN_PIN_QUAN_LY',
            maLoi: 'CAN_PIN_QUAN_LY',
            message: 'Vui lòng nhập mã PIN Quản lý hoặc Ca trưởng để xác thực thao tác này!',
        });
    }

    try {
        const mgr = await pool.withTenant(tenantId, async (client) => {
            const verified = await xacThucPinQuanLy(
                client,
                tenantId,
                managerPin,
                req.ip,
                maNVDuyet,
                'order.item.void_approve'
            );
            if (!verified) return null;

            const cleanAction = String(action || 'MANAGER_PIN_VERIFIED')
                .trim()
                .toUpperCase()
                .replace(/[^A-Z0-9_]/g, '_')
                .slice(0, 64) || 'MANAGER_PIN_VERIFIED';

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                nguoiDuyet: verified.maNV,
                hanhDong: cleanAction,
                doiTuong: 'POS_SECURITY',
                maDoiTuong: String(details?.offlineClientId || details?.jobId || req.user.maNV).slice(0, 64),
                giaTriMoi: {
                    ...details,
                    nguoiDuyet: verified.maNV,
                    tenNguoiDuyet: verified.tenNV,
                    branchId: req.headers['x-branch-id'] || req.user?.branchId || 'DEFAULT',
                    timestamp: new Date().toISOString(),
                },
                lyDo: String(lyDo || '').trim(),
                ip: req.ip,
                batBuoc: true,
            });
            return verified;
        });

        if (!mgr) {
            return res.status(403).json({
                ok: false,
                code: 'INVALID_MANAGER_PIN',
                maLoi: 'CAN_PIN_QUAN_LY',
                message: 'Mã PIN Quản lý không đúng hoặc không có quyền duyệt!',
            });
        }

        res.json({
            ok: true,
            message: `Đã xác thực PIN Quản lý (${mgr.tenNV || mgr.maNV})!`,
            nguoiDuyet: mgr,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Xác thực PIN Quản lý:');
    }
});

// [P0 Hardware Anti-Fraud] Ghi nhận sự kiện Mở két tiền không bán hàng (No-Sale RJ11 Drawer Kick) vào Audit Log bất biến
app.post('/api/pos/drawer-kick', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    const lyDo = String(req.body?.lyDo || '').trim();
    if (lyDo.length < 3) {
        return res.status(400).json({ message: 'Vui lòng nhập lý do mở két tiền không bán hàng (tối thiểu 3 ký tự)!' });
    }
    try {
        await pool.withTenant(tenantId, (client) =>
            ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'DRAWER_NO_SALE_KICK',
                doiTuong: 'KET_TIEN',
                maDoiTuong: 'RJ11',
                giaTriMoi: { lyDo },
                lyDo,
                ip: req.ip,
                batBuoc: true,
            })
        );
        res.json({ ok: true, message: 'Đã ghi nhận nhật ký mở két tiền (No-Sale)!' });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Ghi nhận mở két tiền:');
    }
});

// [P0] Nhật ký Kiểm toán Anti-Fraud cho Quản lý (cô lập theo TenantId + kiểm soát theo gói cước)
app.get('/api/audit-logs', kiemTraToken, choPhepVaiTro(1), yeuCauTinhNang('audit_logs'), async (req, res) => {
    if (!runtimeFlags.auditSanSang) return res.json([]);
    const tenantId = layTenantId(req);
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    try {
        const r = await qTenant(
            req,
            `SELECT a.Id, a.MaNV, nv.TenNV, a.VaiTro, a.HanhDong, a.DoiTuong, a.MaDoiTuong,
                    a.GiaTriCu, a.GiaTriMoi, a.LyDo, a.DiaChiIP, a.ThoiGianTao
               FROM Audit_Logs a
               LEFT JOIN NhanVien nv ON nv.MaNV = a.MaNV
              WHERE COALESCE(a.TenantId, 'DEFAULT') = $2
              ORDER BY a.ThoiGianTao DESC
              LIMIT $1`,
            [limit, tenantId]
        );
        res.json(r.rows.map((row) => ({
            id: row.id,
            maNV: row.manv,
            tenNV: row.tennv || row.manv,
            vaiTro: row.vaitro,
            hanhDong: row.hanhdong,
            doiTuong: row.doituong,
            maDoiTuong: row.madoituong,
            giaTriCu: row.giatricu,
            giaTriMoi: row.giatrimoi,
            lyDo: row.lydo,
            diaChiIP: row.diachiip,
            thoiGianTao: row.thoigiantao,
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Nhật ký kiểm toán:');
    }
});


    return {
        layPrintRelayState,
        soSanhHangThoiGian,
        xacThucSePay,
        xacThucPayOS,
        xuLyBienDongSoDuVietQR,
    };
}

module.exports = { registerSystemDomain };
