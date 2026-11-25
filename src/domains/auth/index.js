'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
    TEN_VAI_TRO,
    guiLoi,
} = require('../../core/auditAndSecurity');
const {
    logger,
    captureException,
} = require('../../../modules/observability');

function registerAuthDomain(app, deps) {
    const {
        pool,
        hashPassword,
        verifyPassword,
        gioiHanDangNhap,
        ghiNhanDangNhapSai,
        xoaDangNhapSai,
        JWT_VERIFY_OPTIONS,
        ACCESS_TOKEN_TTL,
        REFRESH_TTL_STANDARD_DAYS,
        REFRESH_TTL_DEVICE_DAYS,
        getRefreshCookie,
        setRefreshCookie,
        clearRefreshCookie,
        generateRefreshToken,
        hashRefreshToken,
        danhGiaTrangThaiGoi,
        layEntitlementTenant,
        ghiAuditLog,
    } = deps;

// ==========================================
// PHÂN HỆ: XÁC THỰC (AUTH - MULTI-TENANT JWT + REFRESH TOKEN ROTATION + STORE DEVICE SESSION)
// ==========================================
function kyAccessToken({
    maNV,
    vaiTro,
    permissionsOverride = {},
    tenantId = 'DEFAULT',
    maTienTo = 'DEF',
    tenQuan = 'Quán Cà Phê POS',
    goiCuoc = 'PRO',
    trangThaiGoi = 'ACTIVE',
}) {
    return jwt.sign(
        {
            maNV,
            vaiTro: Number(vaiTro),
            permissionsOverride,
            tenantId,
            maTienTo,
            tenQuan,
            goiCuoc,
            trangThaiGoi,
        },
        process.env.JWT_SECRET,
        { expiresIn: ACCESS_TOKEN_TTL }
    );
}

async function taoVaGanRefreshTokenCookie({
    req,
    res,
    tenantId,
    maNV,
    deviceId = null,
    deviceLabel = null,
    rememberDevice = false,
}) {
    const rawRefresh = generateRefreshToken();
    const tokenHash = hashRefreshToken(rawRefresh);
    const familyId = `FAM_${crypto.randomBytes(12).toString('hex')}`;
    const ttlDays = rememberDevice ? REFRESH_TTL_DEVICE_DAYS : REFRESH_TTL_STANDARD_DAYS;
    const expiresAt = new Date(Date.now() + ttlDays * 86400 * 1000);
    const cleanDeviceId = String(deviceId || req.headers['x-device-id'] || '').trim().slice(0, 64) || null;
    const cleanDeviceLabel = String(deviceLabel || '').trim().slice(0, 120) || null;
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 300) || null;

    try {
        await pool.query(
            `SELECT public.fn_create_refresh_token($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10)`,
            [
                tokenHash,
                familyId,
                String(tenantId || 'DEFAULT'),
                String(maNV),
                cleanDeviceId,
                cleanDeviceLabel,
                Boolean(rememberDevice),
                expiresAt.toISOString(),
                userAgent,
                req.ip || null,
            ]
        );
        setRefreshCookie(res, req, rawRefresh, ttlDays * 86400);
        return { issued: true, expiresAt: expiresAt.toISOString(), isStoreDeviceSession: Boolean(rememberDevice) };
    } catch (err) {
        // Tương thích ngược nếu Migration 019 chưa được chạy trên môi trường DB cũ
        logger.warn('Chưa lưu được Refresh Token (có thể chưa chạy Migration 019)', {
            event: 'REFRESH_TOKEN_CREATE_FALLBACK',
            error: err?.message,
        });
        return { issued: false, expiresAt: null, isStoreDeviceSession: false };
    }
}

async function xoayVongRefreshTokenCookie({ req, res, oldRawToken, newMaNV = null, isStoreDevice = false }) {
    const oldHash = hashRefreshToken(oldRawToken);
    const newRaw = generateRefreshToken();
    const newHash = hashRefreshToken(newRaw);
    const ttlDays = isStoreDevice ? REFRESH_TTL_DEVICE_DAYS : REFRESH_TTL_STANDARD_DAYS;
    const newExpires = new Date(Date.now() + ttlDays * 86400 * 1000);
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 300) || null;

    const rotRes = await pool.query(
        `SELECT public.fn_rotate_refresh_token($1, $2, $3::timestamptz, $4, $5, $6) AS ok`,
        [oldHash, newHash, newExpires.toISOString(), newMaNV ? String(newMaNV) : null, userAgent, req.ip || null]
    );
    if (rotRes.rows[0]?.ok !== true) {
        return { ok: false };
    }
    setRefreshCookie(res, req, newRaw, ttlDays * 86400);
    return { ok: true, expiresAt: newExpires.toISOString() };
}

function phanTichDangNhapVaMaQuan(tenDangNhapRaw, maQuanRaw = '') {
    const cleanInput = String(tenDangNhapRaw || '').trim();
    let username = cleanInput;
    let tenantSlug = String(maQuanRaw || '').trim();

    // Hỗ trợ cú pháp nhanh: thungan1@slug-quan (khi không nhập ô Mã quán riêng)
    if (!tenantSlug && cleanInput.includes('@')) {
        const atIdx = cleanInput.lastIndexOf('@');
        const left = cleanInput.slice(0, atIdx).trim();
        const right = cleanInput.slice(atIdx + 1).trim();
        // Chỉ tách nếu không giống email domain có dấu chấm ở phần sau (vd .com/.vn)
        if (left && right && !right.includes('.')) {
            username = left;
            tenantSlug = right;
        }
    }
    return { username, tenantSlug: tenantSlug || null };
}

// [PHÂN HỆ 9] Tra cứu công khai thông tin quán cho trang đăng nhập riêng (/login?shop=<slug-hoac-ma-quan>)
app.get('/api/auth/shop/:shopCode', async (req, res) => {
    const shopCode = String(req.params.shopCode || '').trim().slice(0, 100);
    if (!shopCode) {
        return res.status(400).json({ message: 'Vui lòng cung cấp mã quán hoặc đường dẫn quán!' });
    }
    try {
        let row = null;
        try {
            const r = await pool.query('SELECT * FROM public.fn_lookup_tenant_public($1)', [shopCode]);
            row = r.rows[0] || null;
        } catch {
            const r = await pool.query(
                `SELECT TenantId, MaTienTo, TenQuan, Slug, GoiCuoc, TrangThai
                   FROM Tenants
                  WHERE LOWER(COALESCE(Slug, '')) = LOWER($1)
                     OR UPPER(COALESCE(MaTienTo, '')) = UPPER($1)
                     OR UPPER(TenantId) = UPPER($1)
                  LIMIT 1`,
                [shopCode]
            );
            row = r.rows[0] || null;
        }
        if (!row) {
            return res.status(404).json({ message: `Không tìm thấy quán với mã "${shopCode}"!` });
        }
        res.json({
            tenantId: row.tenantid,
            maTienTo: row.matiento || 'DEF',
            tenQuan: row.tenquan,
            slug: row.slug || shopCode.toLowerCase(),
            goiCuoc: row.goicuoc || 'PRO',
            trangThai: row.trangthai || 'ACTIVE',
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Tra cứu quán:');
    }
});

app.post('/api/auth/login', gioiHanDangNhap, async (req, res) => {
    const {
        tenDangNhap,
        matKhau,
        maQuan = '',
        tenantSlug: tenantSlugBody = '',
        deviceId = null,
        deviceLabel = null,
        rememberDevice = true,
    } = req.body || {};
    if (
        typeof tenDangNhap !== 'string' || typeof matKhau !== 'string' ||
        !tenDangNhap.trim() || !matKhau || tenDangNhap.length > 160 || matKhau.length > 128
    ) {
        return res.status(400).json({ message: 'Vui lòng nhập Email / SĐT / Tên đăng nhập và mật khẩu hợp lệ!' });
    }

    const { username, tenantSlug } = phanTichDangNhapVaMaQuan(tenDangNhap, maQuan || tenantSlugBody);

    try {
        let result;
        try {
            // Ưu tiên hàm SECURITY DEFINER V2 (Phân hệ 9: Chủ quán bằng Email/SĐT duy nhất toàn hệ thống; NV theo /login?shop=slug hoặc Mã quán)
            result = await pool.query('SELECT * FROM public.fn_lookup_login_user_v2($1, $2)', [username, tenantSlug]);
        } catch {
            try {
                // Fallback Phân hệ 7: 2 tham số
                result = await pool.query('SELECT * FROM public.fn_lookup_login_user($1, $2)', [username, tenantSlug]);
            } catch {
                try {
                    // Fallback tương thích bản Migration 004 (1 tham số)
                    result = await pool.query('SELECT * FROM public.fn_lookup_login_user($1)', [username]);
                } catch {
                    try {
                        result = await pool.query(
                            `SELECT nv.MaNV, nv.TenNV, nv.VaiTro, nv.MatKhauHash,
                                    COALESCE(nv.TenantId, 'DEFAULT') AS TenantId,
                                    COALESCE(t.MaTienTo, 'DEF') AS MaTienTo,
                                    COALESCE(t.TenQuan, 'Quán Cà Phê POS') AS TenQuan,
                                    COALESCE(t.Slug, 'default-cafe') AS TenantSlug,
                                    COALESCE(t.GoiCuoc, 'PRO') AS GoiCuoc,
                                    COALESCE(t.TrangThai, 'ACTIVE') AS TrangThaiGoi,
                                    t.TrialEndsAt,
                                    t.SubscriptionEndsAt
                               FROM NhanVien nv
                               LEFT JOIN Tenants t ON t.TenantId = COALESCE(nv.TenantId, 'DEFAULT')
                              WHERE LOWER(nv.TenDangNhap) = LOWER($1) AND nv.TrangThaiLamViec = TRUE
                                AND ($2::text IS NULL OR LOWER(COALESCE(t.Slug, '')) = LOWER($2) OR UPPER(COALESCE(t.MaTienTo, '')) = UPPER($2) OR UPPER(COALESCE(nv.TenantId, 'DEFAULT')) = UPPER($2))
                              LIMIT 2`,
                            [username, tenantSlug]
                        );
                    } catch (schemaErr) {
                        // Tương thích ngược nếu bảng Tenants / cột TenantId chưa kịp khởi tạo khi server vừa boot
                        logger.warn('Login fallback về schema gốc (chưa có Tenants/TenantId)', { error: schemaErr.message });
                        result = await pool.query(
                            `SELECT MaNV, TenNV, VaiTro, MatKhauHash
                               FROM NhanVien
                              WHERE LOWER(TenDangNhap) = LOWER($1) AND TrangThaiLamViec = TRUE
                              LIMIT 2`,
                            [username]
                        );
                    }
                }
            }
        }

        // Nếu có từ 2 quán trở lên dùng chung tên đăng nhập (vd: thungan) mà người dùng chưa nhập Mã quán -> yêu cầu nhập Mã quán / link riêng
        if (result.rows.length > 1 && !tenantSlug) {
            return res.status(409).json({
                code: 'AMBIGUOUS_TENANT_LOGIN',
                message: `Tên đăng nhập "${username}" tồn tại ở nhiều quán. Nhân viên vui lòng mở đường dẫn riêng (/login?shop=ma-quan) hoặc nhập thêm Mã quán; Chủ quán có thể đăng nhập bằng Email / SĐT!`,
            });
        }

        const user = result.rows[0];
        const { ok, canBamLai } = await verifyPassword(matKhau, user ? user.matkhauhash : null);

        if (!user || !ok) {
            ghiNhanDangNhapSai(req, tenDangNhap);
            return res.status(401).json({ message: 'Sai tài khoản, mật khẩu hoặc tài khoản đã bị khóa!' });
        }
        xoaDangNhapSai(req, tenDangNhap);

        if (canBamLai) {
            try {
                await pool.queryTenant(
                    user.tenantid || 'DEFAULT',
                    'UPDATE NhanVien SET MatKhauHash = $1 WHERE MaNV = $2 AND MatKhauHash = $3',
                    [await hashPassword(matKhau), user.manv, user.matkhauhash]
                );
            } catch (error) {
                logger.warn(`Chưa nâng cấp được hash mật khẩu cho NV ${user.manv}`, { error: error.message });
            }
        }

        const tenantId = user.tenantid || 'DEFAULT';
        let permissionsOverride = {};
        try {
            const permRes = await pool.withTenant(tenantId, (client) =>
                client.query(
                    `SELECT COALESCE((to_jsonb(NhanVien)->'permissionsoverride')::jsonb, '{}'::jsonb) AS Perms
                       FROM NhanVien WHERE MaNV = $1 LIMIT 1`,
                    [user.manv]
                )
            );
            if (permRes.rows[0]?.perms && typeof permRes.rows[0].perms === 'object') {
                permissionsOverride = permRes.rows[0].perms;
            }
        } catch {
            // ignore if column not yet migrated
        }
        const ent = await layEntitlementTenant(pool, tenantId);
        const subscription = danhGiaTrangThaiGoi({
            tenantId,
            goiCuoc: ent.goiCuoc || user.goicuoc || 'PRO',
            trangThai: user.trangthaigoi || 'ACTIVE',
            trialEndsAt: user.trialendsat || null,
            subscriptionEndsAt: user.subscriptionendsat || null,
        });
        const resolvedSlug = user.slug || user.tenantslug || null;

        // Cập nhật LastLoginAt (không chặn luồng đăng nhập nếu Migration 020 chưa chạy)
        pool.query('SELECT public.fn_touch_login_activity($1, $2)', [user.manv, tenantId]).catch(() => {});

        const token = kyAccessToken({
            maNV: user.manv,
            vaiTro: user.vaitro,
            permissionsOverride,
            tenantId,
            maTienTo: user.matiento || 'DEF',
            slug: resolvedSlug,
            tenQuan: user.tenquan || 'Quán Cà Phê POS',
            goiCuoc: ent.goiCuoc || user.goicuoc || 'PRO',
            trangThaiGoi: subscription.trangThai,
        });

        // Cấp Refresh Token Rotation trong HttpOnly Cookie (mặc định bật Store Device Session cho máy quầy POS)
        const refreshMeta = await taoVaGanRefreshTokenCookie({
            req,
            res,
            tenantId,
            maNV: user.manv,
            deviceId,
            deviceLabel,
            rememberDevice: Boolean(rememberDevice),
        });

        res.json({
            message: 'Đăng nhập thành công',
            token,
            accessTokenExpiresIn: ACCESS_TOKEN_TTL,
            deviceSession: refreshMeta,
            user: {
                maNV: user.manv,
                tenNV: user.tennv,
                vaiTro: user.vaitro,
                email: user.email || null,
                soDienThoai: user.sodienthoai || null,
                laCaTruong: Boolean(permissionsOverride?.isShiftSupervisor),
                permissionsOverride,
                tenantId,
                maTienTo: user.matiento || 'DEF',
                tenQuan: user.tenquan || 'Quán Cà Phê POS',
                slug: resolvedSlug,
                tenantSlug: resolvedSlug,
                goiCuoc: ent.goiCuoc || user.goicuoc || 'PRO',
                featureFlags: ent.flags,
                subscription,
            },
        });
    } catch (error) {
        captureException(error, { route: '/api/auth/login', requestId: req.requestId });
        res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
    }
});

// [Phân hệ 7] Refresh Token Rotation (HttpOnly Cookie -> cấp Access Token mới + xoay vòng cookie mới + phát hiện Reuse Token)
app.post('/api/auth/refresh', async (req, res) => {
    const rawRefresh = getRefreshCookie(req);
    if (!rawRefresh) {
        return res.status(401).json({ code: 'NO_REFRESH_COOKIE', message: 'Chưa có phiên thiết bị (Refresh Cookie)!' });
    }

    try {
        const tokenHash = hashRefreshToken(rawRefresh);
        const lookupRes = await pool.query('SELECT * FROM public.fn_lookup_refresh_token($1)', [tokenHash]);
        const row = lookupRes.rows[0];

        if (!row) {
            clearRefreshCookie(res, req);
            return res.status(401).json({ code: 'INVALID_REFRESH_TOKEN', message: 'Phiên đăng nhập không hợp lệ!' });
        }

        // Reuse Detection: Nếu token đã bị thu hồi trước đó mà vẫn được gửi lại -> thu hồi toàn bộ chuỗi FamilyId!
        if (row.revokedat) {
            await pool.query('SELECT public.fn_revoke_refresh_family($1)', [row.familyid]).catch(() => {});
            clearRefreshCookie(res, req);
            logger.warn('Phát hiện tái sử dụng Refresh Token đã thu hồi — đã khóa toàn bộ family', {
                event: 'REFRESH_TOKEN_REUSE_DETECTED',
                tenantId: row.tenantid,
                maNV: row.manv,
                familyId: row.familyid,
                ip: req.ip,
            });
            return res.status(401).json({
                code: 'REFRESH_TOKEN_REUSED',
                message: 'Phát hiện phiên bất thường! Vui lòng đăng nhập lại để đảm bảo an toàn.',
            });
        }

        if (new Date(row.expiresat).getTime() <= Date.now()) {
            clearRefreshCookie(res, req);
            return res.status(401).json({ code: 'REFRESH_TOKEN_EXPIRED', message: 'Phiên thiết bị đã hết hạn, vui lòng đăng nhập lại!' });
        }

        if (!row.trangthailamviec) {
            await pool.query('SELECT public.fn_revoke_refresh_family($1)', [row.familyid]).catch(() => {});
            clearRefreshCookie(res, req);
            return res.status(401).json({ code: 'STAFF_DISABLED', message: 'Tài khoản nhân viên đã bị khóa hoặc ngừng làm việc!' });
        }

        const rotated = await xoayVongRefreshTokenCookie({
            req,
            res,
            oldRawToken: rawRefresh,
            isStoreDevice: Boolean(row.isstoredevicesession),
        });
        if (!rotated.ok) {
            clearRefreshCookie(res, req);
            return res.status(401).json({ code: 'REFRESH_ROTATION_FAILED', message: 'Không thể gia hạn phiên, vui lòng đăng nhập lại!' });
        }

        const tenantId = row.tenantid || 'DEFAULT';
        const perms = row.permissionsoverride && typeof row.permissionsoverride === 'object' ? row.permissionsoverride : {};
        const subscription = danhGiaTrangThaiGoi({
            tenantId,
            trangThai: row.trangthaigoi || 'ACTIVE',
            trialEndsAt: row.trialendsat || null,
            subscriptionEndsAt: row.subscriptionendsat || null,
        });
        const ent = await layEntitlementTenant(pool, tenantId);
        const token = kyAccessToken({
            maNV: row.manv,
            vaiTro: row.vaitro,
            permissionsOverride: perms,
            tenantId,
            maTienTo: row.matiento || 'DEF',
            tenQuan: row.tenquan || 'Quán Cà Phê POS',
            goiCuoc: ent.goiCuoc || row.goicuoc || 'PRO',
            trangThaiGoi: subscription.trangThai,
        });

        res.json({
            message: 'Gia hạn phiên thành công',
            token,
            accessTokenExpiresIn: ACCESS_TOKEN_TTL,
            deviceSession: {
                active: true,
                isStoreDeviceSession: Boolean(row.isstoredevicesession),
                expiresAt: rotated.expiresAt,
            },
            user: {
                maNV: row.manv,
                tenNV: row.tennv,
                vaiTro: Number(row.vaitro),
                laCaTruong: Boolean(perms?.isShiftSupervisor),
                permissionsOverride: perms,
                tenantId,
                maTienTo: row.matiento || 'DEF',
                tenQuan: row.tenquan || 'Quán Cà Phê POS',
                tenantSlug: row.tenantslug || null,
                goiCuoc: ent.goiCuoc || row.goicuoc || 'PRO',
                featureFlags: ent.flags,
                subscription,
            },
        });
    } catch (error) {
        captureException(error, { route: '/api/auth/refresh', requestId: req.requestId });
        res.status(500).json({ message: 'Không thể gia hạn phiên đăng nhập!' });
    }
});

// [Phân hệ 7] Đăng xuất chuẩn: Thu hồi Refresh Token trên DB + Xóa HttpOnly Cookie
app.post('/api/auth/logout', async (req, res) => {
    const rawRefresh = getRefreshCookie(req);
    if (rawRefresh) {
        try {
            await pool.query('SELECT public.fn_revoke_refresh_token($1)', [hashRefreshToken(rawRefresh)]);
        } catch {
            // ignore if table not migrated yet
        }
    }
    clearRefreshCookie(res, req);
    res.json({ message: 'Đã đăng xuất an toàn!' });
});

// [Phân hệ 7] Fast Store Device Session: Kiểm tra máy quầy đã đăng nhập sẵn bằng HttpOnly Cookie để nhân viên mở khóa / chuyển ca nhanh bằng mã PIN
app.get('/api/auth/device-session', async (req, res) => {
    const rawRefresh = getRefreshCookie(req);
    if (!rawRefresh) {
        return res.json({ active: false, staff: [] });
    }
    try {
        const lookupRes = await pool.query('SELECT * FROM public.fn_lookup_refresh_token($1)', [hashRefreshToken(rawRefresh)]);
        const row = lookupRes.rows[0];
        if (!row || row.revokedat || new Date(row.expiresat).getTime() <= Date.now()) {
            return res.json({ active: false, staff: [] });
        }
        const tenantId = row.tenantid || 'DEFAULT';
        const staffRows = await pool.withTenant(tenantId, async (client) => {
            const r = await client.query(
                `SELECT MaNV, TenNV, VaiTro, (PinHash IS NOT NULL AND PinHash <> '') AS DaDatPin
                   FROM NhanVien
                  WHERE COALESCE(TenantId, 'DEFAULT') = $1
                    AND TrangThaiLamViec = TRUE
                  ORDER BY VaiTro ASC, TenNV ASC`,
                [tenantId]
            );
            return r.rows;
        });
        res.json({
            active: true,
            isStoreDeviceSession: Boolean(row.isstoredevicesession),
            tenantId,
            tenQuan: row.tenquan || 'Quán Cà Phê POS',
            maTienTo: row.matiento || 'DEF',
            tenantSlug: row.tenantslug || null,
            lastStaff: { maNV: row.manv, tenNV: row.tennv, vaiTro: Number(row.vaitro) },
            staff: staffRows.map((s) => ({
                maNV: s.manv,
                tenNV: s.tennv,
                vaiTro: Number(s.vaitro),
                daDatPin: Boolean(s.dadatpin),
            })),
        });
    } catch {
        res.json({ active: false, staff: [] });
    }
});


    return {
        kyAccessToken,
        taoVaGanRefreshTokenCookie,
        xoayVongRefreshTokenCookie,
        phanTichDangNhapVaMaQuan,
    };
}

module.exports = { registerAuthDomain };
