const crypto = require('crypto');
const { PLAN_FEATURES } = require('./industryTemplates');
const { danhGiaTrangThaiGoi, SAAS_BANK_CONFIG, tinhTienGoi } = require('./saasRoutes');

const FEATURE_METADATA = {
    inventory_bom: {
        label: 'Kho định lượng BOM, Sub-Recipes & Ma trận BCG',
        requiredPlan: 'PRO',
    },
    vietqr_webhook: {
        label: 'VietQR Auto Webhook (SePay / PayOS)',
        requiredPlan: 'PRO',
    },
    audit_logs: {
        label: 'Nhật ký Kiểm toán Anti-Fraud & Telegram',
        requiredPlan: 'PRO',
    },
    ai_menu_importer: {
        label: 'AI Menu Importer (Ảnh / Zalo / CSV)',
        requiredPlan: 'STARTER',
    },
    offline_pwa: {
        label: 'Bán hàng ngoại tuyến (Offline-First PWA)',
        requiredPlan: 'STARTER',
    },
    multi_branch: {
        label: 'Quản trị Chuỗi đa chi nhánh',
        requiredPlan: 'ENTERPRISE',
    },
    qr_order: {
        label: 'QR Order tại bàn cho khách',
        requiredPlan: 'PRO',
    },
    crm_tiers: {
        label: 'CRM Loyalty & Hạng thành viên',
        requiredPlan: 'PRO',
    },
    aggregator_hub: {
        label: 'Đồng bộ App Giao đồ ăn (Grab/ShopeeFood)',
        requiredPlan: 'PRO',
    },
    horizontal_fnb: {
        label: 'Mở rộng F&B (Phiên bàn / Combo / Trạm bếp)',
        requiredPlan: 'PRO',
    },
    ai_forecast_upsell: {
        label: 'Dự báo nguyên liệu & Gợi ý Upsell AI',
        requiredPlan: 'PRO',
    },
    receipt_watermark: {
        label: 'Watermark + QR dùng thử ở chân hóa đơn K80 (PLG Loop)',
        requiredPlan: 'FREE',
    },
};

const TOGGLEABLE_BOOLEAN_FLAGS = [
    'inventory_bom',
    'vietqr_webhook',
    'offline_pwa',
    'ai_menu_importer',
    'audit_logs',
    'multi_branch',
    'qr_order',
    'crm_tiers',
    'aggregator_hub',
    'horizontal_fnb',
    'ai_forecast_upsell',
    'receipt_watermark',
];

const ENTITLEMENT_TTL_MS = 30 * 1000;
const entitlementCache = new Map(); // tenantId -> { goiCuoc, trangThai, flags, expiresAt }
const platformAdminCache = new Map(); // adminId -> { active, role, username, fullName, expiresAt }

function hopNhatFeatureFlags(goiCuoc, rawFlags) {
    const planKey = PLAN_FEATURES[goiCuoc] ? goiCuoc : 'PRO';
    const defaults = PLAN_FEATURES[planKey];
    const custom = rawFlags && typeof rawFlags === 'object' ? rawFlags : {};

    const merged = {
        maxOrdersPerMonth:
            typeof custom.maxOrdersPerMonth === 'number'
                ? custom.maxOrdersPerMonth
                : defaults.maxOrdersPerMonth,
        maxBranches:
            typeof custom.maxBranches === 'number'
                ? custom.maxBranches
                : defaults.maxBranches,
        maxDevices:
            typeof custom.maxDevices === 'number'
                ? custom.maxDevices
                : (defaults.maxDevices ?? -1),
        reportHistoryDays:
            typeof custom.reportHistoryDays === 'number'
                ? custom.reportHistoryDays
                : (defaults.reportHistoryDays ?? -1),
    };

    for (const key of TOGGLEABLE_BOOLEAN_FLAGS) {
        merged[key] = typeof custom[key] === 'boolean' ? custom[key] : Boolean(defaults[key]);
    }
    return merged;
}

// [PHÂN HỆ 9] Bộ tính điểm Sức khỏe Tenant & Churn Radar 3 Màu (🟢 Khỏe mạnh / 🟡 Cảnh báo sớm / 🔴 Sắp hết hạn)
function tinhSucKhoeTenant(row, sub, flags) {
    const now = Date.now();
    const createdMs = row.thoigiantao ? new Date(row.thoigiantao).getTime() : now;
    const daysSinceSignup = Math.max(0, Math.floor((now - createdMs) / 86400000));

    const ordersTotal = Number(row.so_don || 0);
    const ordersMonth = Number(row.so_don_thang_nay || 0);
    const orders3d = Number(row.so_don_3_ngay || 0);
    const orders7d = Number(row.so_don_7_ngay || 0);
    const ordersPrev7d = Number(row.so_don_7_14_ngay || 0);
    const orders14d = Number(row.so_don_14_ngay || (orders7d + ordersPrev7d));

    const dailyAvg3d = Math.round((orders3d / 3) * 10) / 10;
    const dailyAvg14d = Math.round((orders14d / 14) * 10) / 10;
    const weekOverWeekPct =
        ordersPrev7d > 0 ? Math.round(((orders7d - ordersPrev7d) / ordersPrev7d) * 100) : null;

    const offlineFailedCount = Number(row.offline_failed_count || 0);
    const offlineTotalSyncCount = Number(row.offline_total_sync_count || 0);
    const offlineDenom = offlineFailedCount + offlineTotalSyncCount;
    const offlineFailRate = offlineDenom > 0 ? Math.round((offlineFailedCount / offlineDenom) * 1000) / 10 : 0;

    const lastLoginAt = row.last_login_at || row.lan_ban_cuoi || null;
    const daysSinceLogin = lastLoginAt
        ? Math.max(0, Math.floor((now - new Date(lastLoginAt).getTime()) / 86400000))
        : daysSinceSignup;

    const maxOrders = Number(flags?.maxOrdersPerMonth || -1);
    const quotaUsagePct = maxOrders > 0 ? Math.min(100, Math.round((ordersMonth / maxOrders) * 100)) : 0;

    const reasons = [];
    let healthColor = 'GREEN';
    let healthLabel = 'Khỏe mạnh';
    let recommendedAction = 'Duy trì chăm sóc định kỳ';
    let score = 90;

    if (row.tenantid === 'DEFAULT') {
        return {
            healthColor: 'GREEN',
            healthScore: 100,
            healthLabel: 'Quán gốc hệ thống',
            healthReasons: ['Tenant vận hành mặc định'],
            recommendedAction: 'Hoạt động ổn định',
            upsellOpportunity: false,
            upsellTargetPlan: null,
            quotaUsagePct,
            daysSinceSignup,
            daysSinceLogin,
            orders3d,
            orders7d,
            ordersPrev7d,
            orders14d,
            dailyAvg3d,
            dailyAvg14d,
            weekOverWeekPct,
            offlineFailedCount,
            offlineFailRate,
            lastLoginAt,
            ownerContact: row.owner_contact || null,
            referredBy: row.referred_by || null,
        };
    }

    // 🔴 ĐỎ: Sắp hết hạn (≤ 5 ngày dùng thử / bản quyền) hoặc đang trong 5 ngày Ân hạn / Hết hạn
    const isExpiringSoon =
        sub.trangThai === 'GRACE_PERIOD' ||
        sub.trangThai === 'EXPIRED' ||
        sub.trangThai === 'SUSPENDED' ||
        (sub.soNgayConLai !== null && sub.soNgayConLai <= 5);

    // 🟡 VÀNG: Cảnh báo sớm rời bỏ (Onboarding chưa có đơn >3 ngày, giảm >50% đơn, lỗi Offline Queue cao, lười đăng nhập)
    const noFirstOrderAfter3d = daysSinceSignup >= 3 && ordersTotal === 0;
    const sharpWeeklyDrop = ordersPrev7d >= 5 && orders7d < ordersPrev7d * 0.5;
    const sharp3dDrop = dailyAvg14d >= 1 && dailyAvg3d < dailyAvg14d * 0.5;
    const highOfflineFailures = offlineFailedCount >= 3 || offlineFailRate >= 15;
    const inactive5d = daysSinceSignup >= 3 && daysSinceLogin >= 5;

    if (isExpiringSoon) {
        healthColor = 'RED';
        healthLabel = sub.trangThai === 'GRACE_PERIOD' ? 'Đang ân hạn 5 ngày' : sub.hetHan ? 'Đã hết hạn' : `Sắp hết hạn (${sub.soNgayConLai}n)`;
        score = sub.hetHan ? 15 : sub.trangThai === 'GRACE_PERIOD' ? 25 : 35;
        if (sub.trangThai === 'GRACE_PERIOD') {
            reasons.push(`Đang trong ${sub.soNgayAnHanConLai || 5} ngày ân hạn`);
        } else if (sub.hetHan) {
            reasons.push('Gói dùng thử / bản quyền đã hết hạn');
        } else {
            reasons.push(`Chỉ còn ${sub.soNgayConLai} ngày sử dụng`);
        }
        recommendedAction = 'Gửi ngay link VietQR gia hạn ưu đãi 12 tháng (-20%)!';
    } else if (noFirstOrderAfter3d || sharpWeeklyDrop || sharp3dDrop || highOfflineFailures || inactive5d) {
        healthColor = 'YELLOW';
        healthLabel = 'Cảnh báo sớm';
        score = 55;
        if (noFirstOrderAfter3d) {
            reasons.push(`Đăng ký ${daysSinceSignup} ngày chưa tạo đơn đầu tiên`);
            score -= 15;
        }
        if (sharpWeeklyDrop) {
            reasons.push(`Đơn 7 ngày giảm ${Math.abs(weekOverWeekPct)}% so với tuần trước (${orders7d} vs ${ordersPrev7d})`);
            score -= 15;
        } else if (sharp3dDrop) {
            reasons.push(`TB 3 ngày (${dailyAvg3d}/n) giảm >50% so với TB 14 ngày (${dailyAvg14d}/n)`);
            score -= 10;
        }
        if (highOfflineFailures) {
            reasons.push(`Offline Queue kẹt ${offlineFailedCount} đơn FAILED (${offlineFailRate}%)`);
            score -= 10;
        }
        if (inactive5d) {
            reasons.push(`${daysSinceLogin} ngày chưa đăng nhập hệ thống`);
            score -= 10;
        }
        recommendedAction = noFirstOrderAfter3d
            ? 'Gọi hỗ trợ Onboarding & nhập menu AI ngay!'
            : highOfflineFailures
            ? 'Kỹ thuật liên hệ xử lý hàng đợi Offline FAILED ngay!'
            : 'Gọi CS hỏi thăm tình hình kinh doanh của quán!';
    } else {
        healthColor = 'GREEN';
        healthLabel = 'Khỏe mạnh';
        score = Math.min(100, 80 + Math.min(20, Math.round(dailyAvg3d * 2)));
        if (orders3d > 0) {
            reasons.push(`Bán đều ${dailyAvg3d} đơn/ngày (3N gần nhất)`);
        } else {
            reasons.push('Quán mới đăng ký, đang thiết lập');
        }
    }

    // 🔥 Cơ hội Upsell: Quán FREE/STARTER đang bán khỏe hoặc sắp chạm 80% quota!
    let upsellOpportunity = false;
    let upsellTargetPlan = null;
    if (healthColor === 'GREEN' && ['FREE', 'STARTER'].includes(row.goicuoc)) {
        if (row.goicuoc === 'FREE' && (quotaUsagePct >= 80 || orders7d >= 60)) {
            upsellOpportunity = true;
            upsellTargetPlan = 'STARTER';
            reasons.push(`Đã dùng ${quotaUsagePct}% hạn mức FREE (${ordersMonth}/${maxOrders} đơn) → Sẵn sàng lên STARTER/PRO!`);
            recommendedAction = '🔥 Gọi Upsell lên STARTER (149k) hoặc PRO (399k)!';
        } else if (row.goicuoc === 'STARTER' && (quotaUsagePct >= 80 || orders7d >= 100)) {
            upsellOpportunity = true;
            upsellTargetPlan = 'PRO';
            reasons.push(`Đơn tăng trưởng tốt (${orders7d} đơn/7N) → Cơ hội Upsell lên PRO!`);
            recommendedAction = '🔥 Đề xuất nâng cấp PRO (Kho BOM + VietQR Auto)!';
        }
    }

    return {
        healthColor,
        healthScore: Math.max(0, Math.min(100, score)),
        healthLabel,
        healthReasons: reasons,
        recommendedAction,
        upsellOpportunity,
        upsellTargetPlan,
        quotaUsagePct,
        daysSinceSignup,
        daysSinceLogin,
        orders3d,
        orders7d,
        ordersPrev7d,
        orders14d,
        dailyAvg3d,
        dailyAvg14d,
        weekOverWeekPct,
        offlineFailedCount,
        offlineFailRate,
        lastLoginAt,
        ownerContact: row.owner_contact || null,
        referredBy: row.referred_by || null,
    };
}

function xoaCacheEntitlement(tenantId) {
    if (tenantId) entitlementCache.delete(String(tenantId));
    else entitlementCache.clear();
}

async function layEntitlementTenant(pool, tenantId) {
    const key = String(tenantId || 'DEFAULT');
    const cached = entitlementCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached;
    }

    try {
        const r = await pool.query(
            'SELECT GoiCuoc, TrangThai, FeatureFlags FROM Tenants WHERE TenantId = $1',
            [key]
        );
        if (r.rows.length === 0) {
            const fallback = {
                goiCuoc: 'PRO',
                trangThai: 'ACTIVE',
                flags: hopNhatFeatureFlags('PRO', null),
                expiresAt: Date.now() + ENTITLEMENT_TTL_MS,
            };
            entitlementCache.set(key, fallback);
            return fallback;
        }
        const row = r.rows[0];
        const goiCuoc = PLAN_FEATURES[row.goicuoc] ? row.goicuoc : 'PRO';
        const data = {
            goiCuoc,
            trangThai: row.trangthai || 'ACTIVE',
            flags: hopNhatFeatureFlags(goiCuoc, row.featureflags),
            expiresAt: Date.now() + ENTITLEMENT_TTL_MS,
        };
        entitlementCache.set(key, data);
        return data;
    } catch {
        // Khi DB chưa khởi tạo xong bảng Tenants, không chặn sai luồng lõi
        return {
            goiCuoc: 'PRO',
            trangThai: 'ACTIVE',
            flags: hopNhatFeatureFlags('PRO', null),
            expiresAt: Date.now() + 5000,
        };
    }
}

function taoMiddlewareTinhNang(pool) {
    return (featureKey) => async (req, res, next) => {
        const tenantId = String(req?.user?.tenantId || 'DEFAULT');
        const ent = await layEntitlementTenant(pool, tenantId);
        if (ent.flags[featureKey] === false) {
            const meta = FEATURE_METADATA[featureKey] || {
                label: featureKey,
                requiredPlan: 'PRO',
            };
            return res.status(403).json({
                code: 'FEATURE_NOT_IN_PLAN',
                feature: featureKey,
                currentPlan: ent.goiCuoc,
                requiredPlan: meta.requiredPlan,
                message: `Tính năng "${meta.label}" không nằm trong gói ${ent.goiCuoc} hiện tại. Vui lòng nâng cấp lên gói ${meta.requiredPlan} tại mục Bản quyền & Gói cước!`,
            });
        }
        return next();
    };
}

function taoMiddlewareHanMucDonThang(pool) {
    return async (req, res, next) => {
        const tenantId = String(req?.user?.tenantId || 'DEFAULT');
        if (tenantId === 'DEFAULT') return next();
        // Gọi thêm món vào hóa đơn đang mở không bị tính là đơn mới
        if (req.body?.maHoaDon) return next();

        try {
            const ent = await layEntitlementTenant(pool, tenantId);
            const limit = Number(ent.flags.maxOrdersPerMonth);
            if (!Number.isFinite(limit) || limit <= 0) return next();

            const runTenantQuery = (sql, params) =>
                typeof pool.queryTenant === 'function'
                    ? pool.queryTenant(tenantId, sql, params)
                    : pool.query(sql, params);

            // Nếu đang gọi thêm món vào bàn đang có hóa đơn chưa thanh toán thì cũng không tính đơn mới
            if (req.body?.maBan) {
                const openBan = await runTenantQuery(
                    `SELECT 1
                       FROM HoaDon hd
                       JOIN HoaDon_Ban hb ON hb.MaHoaDon = hd.MaHoaDon
                      WHERE hb.MaBan = $1
                        AND hd.TrangThaiTT = 0
                        AND COALESCE(hd.TenantId, 'DEFAULT') = $2
                      LIMIT 1`,
                    [req.body.maBan, tenantId]
                );
                if (openBan.rows.length > 0) return next();
            }

            const cnt = await runTenantQuery(
                `SELECT COUNT(*) AS so_don
                   FROM HoaDon
                  WHERE COALESCE(TenantId, 'DEFAULT') = $1
                    AND date_trunc('month', ThoiGianTao::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')
                        = date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')`,
                [tenantId]
            );
            const used = Number(cnt.rows[0]?.so_don || 0);
            if (used >= limit) {
                const targetPlan = ent.goiCuoc === 'FREE' ? 'STARTER' : 'PRO';
                return res.status(402).json({
                    code: 'ORDER_QUOTA_EXCEEDED',
                    limit,
                    used,
                    currentPlan: ent.goiCuoc,
                    requiredPlan: targetPlan,
                    message:
                        ent.goiCuoc === 'FREE'
                            ? `Quán đã đạt hạn mức ${limit.toLocaleString('vi-VN')} đơn/tháng của gói FREE (${used}/${limit}). Nâng cấp gói STARTER (chỉ 149.000đ/tháng — không giới hạn đơn POS) tại Bản quyền & Gói cước để bán tiếp ngay!`
                            : `Quán đã đạt hạn mức ${limit.toLocaleString('vi-VN')} đơn/tháng của gói ${ent.goiCuoc} (${used}/${limit}). Vui lòng nâng cấp lên gói PRO (không giới hạn đơn) để tiếp tục bán hàng!`,
                });
            }
            return next();
        } catch (err) {
            console.warn('⚠️ Không kiểm tra được hạn mức đơn tháng:', err.message);
            return next();
        }
    };
}

async function khoiTaoPlatformAdmins(pool, hashPassword) {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS Platform_Admins (
                Id           BIGSERIAL PRIMARY KEY,
                Username     VARCHAR(64) NOT NULL UNIQUE,
                FullName     VARCHAR(120) NOT NULL,
                PasswordHash TEXT NOT NULL,
                Role         VARCHAR(32) NOT NULL DEFAULT 'SUPER_ADMIN',
                IsActive     BOOLEAN NOT NULL DEFAULT TRUE,
                LastLoginAt  TIMESTAMPTZ,
                CreatedAt    TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        await pool.query(
            'CREATE INDEX IF NOT EXISTS idx_hoadon_tenant_created_quota ON HoaDon (TenantId, ThoiGianTao DESC)'
        );

        const countRes = await pool.query('SELECT COUNT(*) AS c FROM Platform_Admins');
        if (Number(countRes.rows[0]?.c || 0) === 0) {
            const username = String(process.env.PLATFORM_ADMIN_USERNAME || 'superadmin')
                .trim()
                .toLowerCase();
            const password = String(process.env.PLATFORM_ADMIN_PASSWORD || 'SuperAdmin@2026');
            const fullName = String(process.env.PLATFORM_ADMIN_NAME || 'Platform Super Admin').trim();
            const hash = await hashPassword(password);

            await pool.query(
                `INSERT INTO Platform_Admins (Username, FullName, PasswordHash, Role, IsActive)
                 VALUES ($1, $2, $3, 'SUPER_ADMIN', TRUE)
                 ON CONFLICT (Username) DO NOTHING`,
                [username, fullName, hash]
            );
            if (!process.env.PLATFORM_ADMIN_PASSWORD) {
                console.warn(
                    `⚠️ [Platform Admin] Đã khởi tạo tài khoản mặc định "${username}" (mật khẩu mặc định "SuperAdmin@2026"). Hãy đặt PLATFORM_ADMIN_PASSWORD trong .env hoặc đổi mật khẩu ngay tại /super-admin!`
                );
            } else {
                console.log(`✅ [Platform Admin] Đã khởi tạo tài khoản Super Admin "${username}" từ biến môi trường.`);
            }
        }
    } catch (error) {
        console.warn('⚠️ Không khởi tạo được bảng Platform_Admins:', error.message);
    }
}

function taoMiddlewarePlatformAdmin(pool, jwt, JWT_VERIFY_OPTIONS) {
    return (req, res, next) => {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) {
            return res.status(401).json({ message: 'Vui lòng đăng nhập tài khoản Platform Super Admin!' });
        }

        jwt.verify(token, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS, async (err, payload) => {
            if (err) {
                return res.status(403).json({ message: 'Token Platform Admin không hợp lệ hoặc đã hết hạn!' });
            }
            if (payload?.type !== 'PLATFORM_ADMIN' || payload?.role !== 'SUPER_ADMIN') {
                return res.status(403).json({
                    code: 'PLATFORM_ADMIN_ONLY',
                    message: 'Từ chối truy cập! Khu vực này chỉ dành riêng cho tài khoản Platform Super Admin độc lập (không dùng tài khoản quán).',
                });
            }

            const key = String(payload.adminId || '');
            const cached = platformAdminCache.get(key);
            if (cached && cached.expiresAt > Date.now()) {
                if (!cached.active) {
                    return res.status(401).json({ message: 'Tài khoản Platform Admin đã bị vô hiệu hóa!' });
                }
                req.platformAdmin = {
                    adminId: payload.adminId,
                    username: cached.username,
                    fullName: cached.fullName,
                    role: cached.role,
                };
                return next();
            }

            try {
                const r = await pool.query(
                    'SELECT Id, Username, FullName, Role, IsActive FROM Platform_Admins WHERE Id = $1',
                    [payload.adminId]
                );
                const row = r.rows[0];
                const active = Boolean(row && row.isactive);
                platformAdminCache.set(key, {
                    active,
                    username: row?.username || payload.username,
                    fullName: row?.fullname || payload.fullName,
                    role: row?.role || 'SUPER_ADMIN',
                    expiresAt: Date.now() + 30000,
                });
                if (!active) {
                    return res.status(401).json({ message: 'Tài khoản Platform Admin không tồn tại hoặc đã bị khóa!' });
                }
                req.platformAdmin = {
                    adminId: Number(row.id),
                    username: row.username,
                    fullName: row.fullname,
                    role: row.role,
                };
                return next();
            } catch (dbErr) {
                console.error('Lỗi xác thực Platform Admin:', dbErr.message);
                return res.status(500).json({ message: 'Không kiểm tra được phiên Platform Admin!' });
            }
        });
    };
}

function registerPlatformAdminRoutes(
    app,
    {
        pool,
        chayGiaoDich,
        gioiHanDangNhap,
        ghiNhanDangNhapSai,
        xoaDangNhapSai,
        hashPassword,
        verifyPassword,
        jwt,
        JWT_VERIFY_OPTIONS,
        ghiAuditLog,
        guiLoi,
    }
) {
    const kiemTraPlatformAdmin = taoMiddlewarePlatformAdmin(pool, jwt, JWT_VERIFY_OPTIONS);

    // 1. Đăng nhập riêng cho Platform Super Admin (tách biệt 100% khỏi /api/auth/login của quán)
    app.post('/api/platform/auth/login', gioiHanDangNhap, async (req, res) => {
        const username = String(req.body?.username || req.body?.tenDangNhap || '').trim().toLowerCase();
        const password = String(req.body?.password || req.body?.matKhau || '');
        if (!username || !password || username.length > 64 || password.length > 128) {
            return res.status(400).json({ message: 'Vui lòng nhập tên đăng nhập và mật khẩu Platform Admin!' });
        }

        try {
            const r = await pool.query(
                `SELECT Id, Username, FullName, PasswordHash, Role, IsActive
                   FROM Platform_Admins
                  WHERE LOWER(Username) = $1`,
                [username]
            );
            const admin = r.rows[0];
            const { ok, canBamLai } = await verifyPassword(password, admin ? admin.passwordhash : null);
            if (!admin || !admin.isactive || !ok) {
                ghiNhanDangNhapSai(req, `platform:${username}`);
                return res.status(401).json({ message: 'Sai tài khoản hoặc mật khẩu Platform Super Admin!' });
            }
            xoaDangNhapSai(req, `platform:${username}`);

            if (canBamLai) {
                await pool
                    .query('UPDATE Platform_Admins SET PasswordHash = $1 WHERE Id = $2', [
                        await hashPassword(password),
                        admin.id,
                    ])
                    .catch(() => {});
            }
            await pool.query('UPDATE Platform_Admins SET LastLoginAt = now() WHERE Id = $1', [admin.id]);

            const token = jwt.sign(
                {
                    type: 'PLATFORM_ADMIN',
                    adminId: Number(admin.id),
                    username: admin.username,
                    fullName: admin.fullname,
                    role: admin.role || 'SUPER_ADMIN',
                },
                process.env.JWT_SECRET,
                { expiresIn: '8h' }
            );

            res.json({
                message: 'Đăng nhập Platform Super Admin thành công!',
                token,
                admin: {
                    id: Number(admin.id),
                    username: admin.username,
                    fullName: admin.fullname,
                    role: admin.role || 'SUPER_ADMIN',
                },
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Platform Admin Login:');
        }
    });

    // 2. Thông tin phiên Platform Admin hiện tại
    app.get('/api/platform/me', kiemTraPlatformAdmin, (req, res) => {
        res.json({
            admin: req.platformAdmin,
            featureMetadata: FEATURE_METADATA,
            plans: PLAN_FEATURES,
        });
    });

    // 3. Đổi mật khẩu Platform Super Admin
    app.put('/api/platform/auth/password', kiemTraPlatformAdmin, async (req, res) => {
        const currentPassword = String(req.body?.currentPassword || '');
        const newPassword = String(req.body?.newPassword || '');
        if (newPassword.length < 8 || newPassword.length > 128) {
            return res.status(400).json({ message: 'Mật khẩu mới của Platform Admin phải dài ít nhất 8 ký tự!' });
        }
        try {
            const r = await pool.query('SELECT PasswordHash FROM Platform_Admins WHERE Id = $1', [
                req.platformAdmin.adminId,
            ]);
            const { ok } = await verifyPassword(currentPassword, r.rows[0]?.passwordhash || null);
            if (!ok) {
                return res.status(401).json({ message: 'Mật khẩu hiện tại không đúng!' });
            }
            await pool.query('UPDATE Platform_Admins SET PasswordHash = $1 WHERE Id = $2', [
                await hashPassword(newPassword),
                req.platformAdmin.adminId,
            ]);
            res.json({ message: 'Đã đổi mật khẩu Platform Super Admin thành công!' });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Đổi mật khẩu Platform Admin:');
        }
    });

    // 4. Tổng quan sức khỏe toàn nền tảng SaaS (Overview KPIs + Churn Radar 3 Màu + Upsell Signals)
    app.get('/api/platform/overview', kiemTraPlatformAdmin, async (req, res) => {
        try {
            // [Wave 1 — P0-04] Dùng SECURITY DEFINER RPCs để chạy chuẩn xác dưới app_runtime (NOBYPASSRLS + FORCE RLS)
            const [tRes, billRes] = await Promise.all([
                pool.query('SELECT * FROM public.fn_platform_overview_tenants()'),
                pool.query('SELECT * FROM public.fn_platform_overview_billing()'),
            ]);

            let activePaid = 0;
            let activeFree = 0;
            let activeTrial = 0;
            let gracePeriod = 0;
            let expiredOrSuspended = 0;
            let mrrEstimate = 0;
            let totalOrders7d = 0;
            let viralReferralCount = 0;
            const healthSummary = { GREEN: 0, YELLOW: 0, RED: 0, UPSELL: 0 };
            const churnRiskTenants = [];
            const upsellTenants = [];

            for (const row of tRes.rows) {
                const sub = danhGiaTrangThaiGoi(row);
                const flags = hopNhatFeatureFlags(row.goicuoc, row.featureflags);
                const health = tinhSucKhoeTenant(row, sub, flags);
                const don7d = Number(row.so_don_7_ngay || 0);
                totalOrders7d += don7d;
                if (row.referred_by) viralReferralCount += 1;

                if (sub.isFreeForever) {
                    activeFree += 1;
                } else if (sub.trangThai === 'ACTIVE') {
                    activePaid += 1;
                    if (row.tenantid !== 'DEFAULT') {
                        mrrEstimate += Number(PLAN_FEATURES[row.goicuoc]?.priceVnd || 0);
                    }
                } else if (sub.trangThai === 'TRIAL') {
                    activeTrial += 1;
                } else if (sub.trangThai === 'GRACE_PERIOD') {
                    gracePeriod += 1;
                } else {
                    expiredOrSuspended += 1;
                }

                if (row.tenantid !== 'DEFAULT') {
                    healthSummary[health.healthColor] = (healthSummary[health.healthColor] || 0) + 1;
                    if (health.upsellOpportunity) {
                        healthSummary.UPSELL += 1;
                        upsellTenants.push({
                            tenantId: row.tenantid,
                            tenQuan: row.tenquan,
                            goiCuoc: row.goicuoc,
                            upsellTargetPlan: health.upsellTargetPlan,
                            quotaUsagePct: health.quotaUsagePct,
                            orders7d: health.orders7d,
                            ownerContact: health.ownerContact,
                            recommendedAction: health.recommendedAction,
                        });
                    }
                    if (health.healthColor === 'RED' || health.healthColor === 'YELLOW') {
                        churnRiskTenants.push({
                            tenantId: row.tenantid,
                            tenQuan: row.tenquan,
                            goiCuoc: row.goicuoc,
                            trangThai: sub.trangThai,
                            soNgayConLai: sub.soNgayConLai,
                            lanBanCuoi: row.lan_ban_cuoi || null,
                            healthColor: health.healthColor,
                            healthScore: health.healthScore,
                            healthLabel: health.healthLabel,
                            healthReasons: health.healthReasons,
                            recommendedAction: health.recommendedAction,
                            ownerContact: health.ownerContact,
                            offlineFailedCount: health.offlineFailedCount,
                        });
                    }
                }
            }

            // Ưu tiên hiển thị ĐỎ (khẩn cấp) trước VÀNG, điểm sức khỏe thấp nhất lên đầu
            churnRiskTenants.sort((a, b) => {
                if (a.healthColor !== b.healthColor) return a.healthColor === 'RED' ? -1 : 1;
                return a.healthScore - b.healthScore;
            });

            const b = billRes.rows[0] || {};
            res.json({
                kpi: {
                    totalTenants: tRes.rows.length,
                    activePaid,
                    activeFree,
                    activeTrial,
                    gracePeriod,
                    expiredOrSuspended,
                    mrrEstimate,
                    totalOrders7d,
                    viralReferralCount,
                    pendingBillingCount: Number(b.don_cho_duyet || 0),
                    pendingBillingAmount: Number(b.tien_cho_duyet || 0),
                    totalBillingRevenue: Number(b.tong_thu_goi || 0),
                },
                healthSummary,
                churnRiskTenants: churnRiskTenants.slice(0, 20),
                upsellTenants: upsellTenants.slice(0, 15),
                featureMetadata: FEATURE_METADATA,
                plans: PLAN_FEATURES,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Platform Overview:');
        }
    });

    // 5. Danh sách toàn bộ Tenants kèm Health Metrics 3 màu, Offline Telemetry & Feature Flags
    app.get('/api/platform/tenants', kiemTraPlatformAdmin, async (req, res) => {
        try {
            const r = await pool.query('SELECT * FROM public.fn_platform_list_tenants($1)', [200]);

            res.json(
                r.rows.map((row) => {
                    const sub = danhGiaTrangThaiGoi(row);
                    const flags = hopNhatFeatureFlags(row.goicuoc, row.featureflags);
                    const health = tinhSucKhoeTenant(row, sub, flags);
                    return {
                        tenantId: row.tenantid,
                        maTienTo: row.matiento,
                        tenQuan: row.tenquan,
                        slug: row.slug,
                        moHinh: row.mohinh,
                        goiCuoc: row.goicuoc,
                        trangThaiGoc: row.trangthai,
                        trangThai: sub.trangThai,
                        isFreeForever: Boolean(sub.isFreeForever),
                        soNgayConLai: sub.soNgayConLai,
                        trongAnHan: Boolean(sub.trongAnHan),
                        trialEndsAt: sub.trialEndsAt,
                        subscriptionEndsAt: sub.subscriptionEndsAt,
                        lastPaymentAt: row.lastpaymentat || null,
                        thoiGianTao: row.thoigiantao,
                        featureFlags: flags,
                        soMon: Number(row.so_mon || 0),
                        soNV: Number(row.so_nv || 0),
                        soDon: Number(row.so_don || 0),
                        soDonThangNay: Number(row.so_don_thang_nay || 0),
                        soDon3Ngay: Number(row.so_don_3_ngay || 0),
                        soDon7Ngay: Number(row.so_don_7_ngay || 0),
                        soDon14Ngay: Number(row.so_don_14_ngay || 0),
                        tongDoanhThu: Number(row.tong_doanh_thu || 0),
                        lanBanCuoi: row.lan_ban_cuoi || null,
                        health,
                    };
                })
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Platform Tenants:');
        }
    });

    // 6. Cập nhật Gói cước, Feature Flags override, Trạng thái hoặc Gia hạn ngày cho 1 Tenant
    app.put('/api/platform/tenants/:tenantId/entitlements', kiemTraPlatformAdmin, async (req, res) => {
        const tenantId = String(req.params.tenantId || '').trim();
        const { goiCuoc, featureFlags, trangThai, extendDays = 0, lyDo = '' } = req.body || {};

        if (!tenantId) {
            return res.status(400).json({ message: 'Thiếu mã TenantId!' });
        }
        if (goiCuoc && !PLAN_FEATURES[goiCuoc]) {
            return res.status(400).json({ message: 'Gói cước không hợp lệ (FREE | STARTER | PRO | ENTERPRISE)!' });
        }
        const allowedStatuses = ['TRIAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED'];
        if (trangThai && !allowedStatuses.includes(trangThai)) {
            return res.status(400).json({ message: `Trạng thái phải thuộc: ${allowedStatuses.join(', ')}` });
        }

        try {
            const result = await chayGiaoDich(async (client) => {
                const cur = await client.query(
                    `SELECT TenantId, TenQuan, GoiCuoc, TrangThai, TrialEndsAt, SubscriptionEndsAt, FeatureFlags
                       FROM Tenants WHERE TenantId = $1 FOR UPDATE`,
                    [tenantId]
                );
                if (cur.rows.length === 0) return null;
                const old = cur.rows[0];

                const nextPlan = goiCuoc || old.goicuoc || 'PRO';
                const nextStatus =
                    tenantId === 'DEFAULT' ? 'ACTIVE' : trangThai || old.trangthai || 'TRIAL';

                // Nếu đổi gói và không gửi featureFlags tùy chỉnh -> reset về mặc định gói mới; nếu có gửi featureFlags -> merge lên gói đích
                const baseFlags =
                    goiCuoc && goiCuoc !== old.goicuoc && !featureFlags
                        ? hopNhatFeatureFlags(nextPlan, null)
                        : hopNhatFeatureFlags(nextPlan, featureFlags || old.featureflags);

                let nextTrialEndsAt = old.trialendsat;
                let nextSubEndsAt = old.subscriptionendsat;
                const extraDays = parseInt(extendDays, 10) || 0;
                if (extraDays > 0 && extraDays <= 3650) {
                    if (nextStatus === 'TRIAL') {
                        const base =
                            old.trialendsat && new Date(old.trialendsat).getTime() > Date.now()
                                ? new Date(old.trialendsat).getTime()
                                : Date.now();
                        nextTrialEndsAt = new Date(base + extraDays * 86400000).toISOString();
                    } else if (nextStatus === 'ACTIVE') {
                        const base =
                            old.subscriptionendsat && new Date(old.subscriptionendsat).getTime() > Date.now()
                                ? new Date(old.subscriptionendsat).getTime()
                                : Date.now();
                        nextSubEndsAt = new Date(base + extraDays * 86400000).toISOString();
                    }
                }

                await client.query(
                    `UPDATE Tenants
                        SET GoiCuoc = $2,
                            TrangThai = $3,
                            FeatureFlags = $4::jsonb,
                            TrialEndsAt = $5,
                            SubscriptionEndsAt = $6
                      WHERE TenantId = $1`,
                    [
                        tenantId,
                        nextPlan,
                        nextStatus,
                        JSON.stringify(baseFlags),
                        nextTrialEndsAt,
                        nextSubEndsAt,
                    ]
                );

                await ghiAuditLog(client, {
                    tenantId,
                    maNV: `PLATFORM:${req.platformAdmin.username}`,
                    nguoiDuyet: req.platformAdmin.username,
                    hanhDong: 'PLATFORM_TENANT_UPDATED',
                    doiTuong: 'TENANT',
                    maDoiTuong: tenantId,
                    giaTriCu: {
                        goiCuoc: old.goicuoc,
                        trangThai: old.trangthai,
                        featureFlags: old.featureflags,
                    },
                    giaTriMoi: {
                        goiCuoc: nextPlan,
                        trangThai: nextStatus,
                        featureFlags: baseFlags,
                        extendDays: extraDays,
                    },
                    lyDo: String(lyDo || '').trim() || 'Cập nhật quyền & gói cước từ Platform Console',
                    ip: req.ip,
                    batBuoc: true,
                });

                return {
                    tenantId,
                    tenQuan: old.tenquan,
                    goiCuoc: nextPlan,
                    trangThai: nextStatus,
                    featureFlags: baseFlags,
                    subscription: danhGiaTrangThaiGoi({
                        tenantId,
                        trangThai: nextStatus,
                        trialEndsAt: nextTrialEndsAt,
                        subscriptionEndsAt: nextSubEndsAt,
                    }),
                };
            }, tenantId);

            if (!result) {
                return res.status(404).json({ message: 'Không tìm thấy quán (Tenant)!' });
            }
            xoaCacheEntitlement(tenantId);

            res.json({
                message: `✅ Đã cập nhật quyền tính năng & gói cước cho "${result.tenQuan}"!`,
                tenant: result,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Cập nhật Entitlements Tenant:');
        }
    });

    // 7. Danh sách tất cả đơn thanh toán gói bản quyền trên toàn nền tảng
    app.get('/api/platform/billing/orders', kiemTraPlatformAdmin, async (req, res) => {
        try {
            const statusFilter = req.query?.status ? String(req.query.status).trim().toUpperCase() : null;
            const r = await pool.query('SELECT * FROM public.fn_platform_list_billing_orders($1, $2)', [statusFilter, 100]);
            res.json(
                r.rows.map((o) => ({
                    maDonThanhToan: o.madonthanhtoan,
                    tenantId: o.tenantid,
                    tenQuan: o.tenquan,
                    goiCuoc: o.goicuoc,
                    soThang: Number(o.sothang),
                    soTien: Number(o.sotien),
                    trangThai: o.trangthai,
                    phuongThucTT: o.phuongthuctt,
                    maGiaoDichNgoai: o.magiaodichngoai || null,
                    ghiChu: o.ghichu || null,
                    thoiGianTao: o.thoigiantao,
                    thoiGianThanhToan: o.thoigianthanhtoan,
                }))
            );
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Platform Billing Orders:');
        }
    });

    // 8. Duyệt thủ công đơn nâng cấp gói cước sau khi đối soát sao kê ngân hàng (bắt buộc nhập bankTxRef)
    app.post('/api/platform/billing/manual-approve', kiemTraPlatformAdmin, async (req, res) => {
        const maDonThanhToan = String(req.body?.maDonThanhToan || '').trim();
        const bankTxRef = String(req.body?.bankTxRef || req.body?.maGiaoDichNgoai || '').trim();
        const ghiChu = String(req.body?.ghiChu || '').trim().slice(0, 250);

        if (!maDonThanhToan) {
            return res.status(400).json({ message: 'Thiếu mã đơn thanh toán (maDonThanhToan)!' });
        }
        if (bankTxRef.length < 3) {
            return res.status(400).json({
                message: 'Bắt buộc nhập mã giao dịch sao kê ngân hàng (bankTxRef, tối thiểu 3 ký tự) để lưu vết đối soát!',
            });
        }

        try {
            // [Wave 1 — P0-04] Dùng SECURITY DEFINER RPC fn_platform_manual_approve_billing (hoạt động an toàn dưới app_runtime NOBYPASSRLS + ghi Audit_Logs)
            const lookup = await pool.query('SELECT * FROM public.fn_lookup_billing_order($1)', [maDonThanhToan]);
            if (lookup.rows.length === 0) {
                return res.status(404).json({ message: 'Không tìm thấy đơn thanh toán!' });
            }
            const flags = hopNhatFeatureFlags(lookup.rows[0].goicuoc, null);
            const rpcRes = await pool.query(
                `SELECT * FROM public.fn_platform_manual_approve_billing($1, $2, $3, $4::jsonb, $5, $6)`,
                [
                    maDonThanhToan,
                    bankTxRef,
                    ghiChu,
                    JSON.stringify(flags),
                    req.platformAdmin.username,
                    req.ip || null,
                ]
            );
            const row = rpcRes.rows[0];
            if (!row || row.status === 'NOT_FOUND') {
                return res.status(404).json({ message: 'Không tìm thấy đơn thanh toán!' });
            }
            if (row.status === 'ALREADY_PAID') {
                return res.json({ message: 'Đơn thanh toán này đã được duyệt trước đó!' });
            }
            const result = {
                alreadyPaid: false,
                targetTenantId: row.target_tenant_id,
                tenQuan: row.ten_quan || row.target_tenant_id,
                goiCuoc: row.goi_cuoc,
                soThang: Number(row.so_thang),
                subscriptionEndsAt: row.subscription_ends_at,
            };
            xoaCacheEntitlement(result.targetTenantId);

            res.json({
                message: `🎉 Đã đối soát sao kê (${bankTxRef}) & kích hoạt gói ${result.goiCuoc} (${result.soThang} tháng) cho "${result.tenQuan}"!`,
                result,
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Platform Manual Billing Approve:');
        }
    });

    // 9. Phiên Hỗ trợ Kỹ thuật Giả lập (Impersonate 15 phút) — có ghi Audit Log bắt buộc
    app.post('/api/platform/tenants/:tenantId/impersonate', kiemTraPlatformAdmin, async (req, res) => {
        const tenantId = String(req.params.tenantId || '').trim();
        const lyDo = String(req.body?.lyDo || 'Hỗ trợ kỹ thuật trực tiếp theo yêu cầu chủ quán').trim().slice(0, 200);
        if (!tenantId) {
            return res.status(400).json({ message: 'Thiếu TenantId cần hỗ trợ!' });
        }

        try {
            const expiresInSeconds = 15 * 60;
            const impersonatedExpiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

            // [Wave 1 — P0-04] Dùng SECURITY DEFINER RPC fn_platform_impersonate_prepare (tra cứu NV + ghi Audit_Logs dưới NOBYPASSRLS)
            const impRes = await pool.query(
                `SELECT * FROM public.fn_platform_impersonate_prepare($1, $2, $3, $4::timestamptz, $5)`,
                [tenantId, req.platformAdmin.username, lyDo, impersonatedExpiresAt, req.ip || null]
            );
            const row = impRes.rows[0];
            if (!row || row.status === 'TENANT_NOT_FOUND') {
                return res.status(404).json({ message: 'Không tìm thấy quán cần hỗ trợ!' });
            }
            if (row.status === 'NO_ACTIVE_STAFF') {
                return res.status(409).json({
                    message: 'Quán này chưa có tài khoản nhân viên đang hoạt động để mở phiên hỗ trợ!',
                });
            }
            const t = row;
            const nv = { manv: row.manv, tennv: row.tennv, vaitro: row.vaitro };
            const subscription = danhGiaTrangThaiGoi(t);
            const featureFlags = hopNhatFeatureFlags(t.goicuoc, t.featureflags);

            const token = jwt.sign(
                {
                    maNV: nv.manv,
                    vaiTro: 1,
                    tenantId: t.tenantid,
                    maTienTo: t.matiento || 'DEF',
                    tenQuan: t.tenquan,
                    goiCuoc: t.goicuoc || 'PRO',
                    trangThaiGoi: subscription.trangThai,
                    impersonatedBy: req.platformAdmin.username,
                    impersonatedExpiresAt,
                },
                process.env.JWT_SECRET,
                { expiresIn: '15m' }
            );

            res.json({
                message: `🕵️ Đã mở phiên hỗ trợ 15 phút cho "${t.tenquan}" (được ghi nhật ký kiểm toán).`,
                token,
                user: {
                    maNV: nv.manv,
                    tenNV: `${nv.tennv} [Hỗ trợ: ${req.platformAdmin.username}]`,
                    vaiTro: 1,
                    tenantId: t.tenantid,
                    maTienTo: t.matiento || 'DEF',
                    tenQuan: t.tenquan,
                    goiCuoc: t.goicuoc || 'PRO',
                    featureFlags,
                    subscription,
                    impersonatedBy: req.platformAdmin.username,
                    impersonatedExpiresAt,
                },
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Platform Impersonate:');
        }
    });

    // 10. [PHÂN HỆ 9] Tạo link VietQR gia hạn ưu đãi 12 tháng (-20%) từ Churn Radar để gửi CS / Zalo cho chủ quán
    app.post('/api/platform/tenants/:tenantId/create-renewal-link', kiemTraPlatformAdmin, async (req, res) => {
        const tenantId = String(req.params.tenantId || '').trim();
        const soThang = [1, 6, 12].includes(Number(req.body?.soThang)) ? Number(req.body.soThang) : 12;
        if (!tenantId || tenantId === 'DEFAULT') {
            return res.status(400).json({ message: 'TenantId không hợp lệ để tạo link gia hạn!' });
        }
        try {
            const tRes = await pool.query(
                `SELECT TenantId, TenQuan, GoiCuoc, to_jsonb(Tenants)->>'ownercontact' AS owner_contact
                   FROM Tenants WHERE TenantId = $1`,
                [tenantId]
            );
            if (tRes.rows.length === 0) {
                return res.status(404).json({ message: 'Không tìm thấy quán!' });
            }
            const t = tRes.rows[0];
            const requestedPlan = String(req.body?.goiCuoc || '').toUpperCase();
            const targetPlan =
                PLAN_FEATURES[requestedPlan] && PLAN_FEATURES[requestedPlan].priceVnd > 0
                    ? requestedPlan
                    : t.goicuoc === 'FREE'
                    ? 'STARTER'
                    : PLAN_FEATURES[t.goicuoc]?.priceVnd > 0
                    ? t.goicuoc
                    : 'PRO';

            const calc = tinhTienGoi(targetPlan, soThang);
            const maDonThanhToan = `SUB${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            await pool.queryTenant(
                tenantId,
                `INSERT INTO Tenant_Billing_Orders (MaDonThanhToan, TenantId, GoiCuoc, SoThang, SoTien, TrangThai, PhuongThucTT, GhiChu)
                 VALUES ($1, $2, $3, $4, $5, 'PENDING', 'VIETQR', $6)`,
                [
                    maDonThanhToan,
                    tenantId,
                    targetPlan,
                    calc.months,
                    calc.soTien,
                    `Ưu đãi Churn Radar tạo bởi @${req.platformAdmin.username}`,
                ]
            );

            const noiDungCK = `${maDonThanhToan} ${targetPlan} ${calc.months}T`;
            const vietQrUrl = `https://img.vietqr.io/image/${SAAS_BANK_CONFIG.bankId}-${SAAS_BANK_CONFIG.accountNo}-compact2.png?amount=${calc.soTien}&addInfo=${encodeURIComponent(noiDungCK)}&accountName=${encodeURIComponent(SAAS_BANK_CONFIG.accountName)}`;
            const discountPct = Math.round(calc.discount * 100);
            const zaloMessage = `Chào chủ quán ${t.tenquan}! ☕ Hệ thống CafePOS gửi ưu đãi gia hạn gói ${targetPlan} (${calc.months} tháng${discountPct > 0 ? `, giảm ngay ${discountPct}%` : ''}): chỉ còn ${calc.soTien.toLocaleString('vi-VN')}đ (giá gốc ${calc.goc.toLocaleString('vi-VN')}đ).\nQuét mã VietQR tại: ${vietQrUrl}\nHoặc chuyển khoản ${SAAS_BANK_CONFIG.bankId} - ${SAAS_BANK_CONFIG.accountNo} (${SAAS_BANK_CONFIG.accountName}), nội dung: "${noiDungCK}" để kích hoạt tự động trong 10 giây!`;

            res.status(201).json({
                message: `🎁 Đã tạo mã VietQR ưu đãi ${calc.months} tháng (-${discountPct}%) cho "${t.tenquan}"!`,
                offer: {
                    maDonThanhToan,
                    tenantId,
                    tenQuan: t.tenquan,
                    ownerContact: t.owner_contact || null,
                    goiCuoc: targetPlan,
                    soThang: calc.months,
                    giamGiaPhanTram: discountPct,
                    soTienGoc: calc.goc,
                    soTien: calc.soTien,
                    noiDungCK,
                    vietQrUrl,
                    bank: SAAS_BANK_CONFIG,
                    zaloMessage,
                },
            });
        } catch (error) {
            guiLoi(res, error, 'Lỗi API Tạo link VietQR gia hạn:');
        }
    });

    // 11. [PHÂN HỆ 9] Danh sách yêu cầu Combo Phần cứng / Zalo ZNS / Fintech Soundbox toàn nền tảng
    app.get('/api/platform/expansion/requests', kiemTraPlatformAdmin, async (req, res) => {
        try {
            const r = await pool.query(`
                SELECT r.Id, r.TenantId, t.TenQuan, r.LoaiDichVu, r.GoiQuanTam, r.SoLuong,
                       r.LienHe, r.GhiChu, r.TrangThai, r.ThoiGianTao
                  FROM Tenant_Expansion_Requests r
                  JOIN Tenants t ON t.TenantId = r.TenantId
                 ORDER BY r.ThoiGianTao DESC
                 LIMIT 100
            `);
            res.json(
                r.rows.map((x) => ({
                    id: Number(x.id),
                    tenantId: x.tenantid,
                    tenQuan: x.tenquan,
                    loaiDichVu: x.loaidichvu,
                    goiQuanTam: x.goiquantam,
                    soLuong: Number(x.soluong || 1),
                    lienHe: x.lienhe || null,
                    ghiChu: x.ghichu || null,
                    trangThai: x.trangthai,
                    thoiGianTao: x.thoigiantao,
                }))
            );
        } catch {
            res.json([]);
        }
    });
}

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of entitlementCache) if (v.expiresAt <= now) entitlementCache.delete(k);
    for (const [k, v] of platformAdminCache) if (v.expiresAt <= now) platformAdminCache.delete(k);
}, 5 * 60 * 1000).unref();

module.exports = {
    FEATURE_METADATA,
    TOGGLEABLE_BOOLEAN_FLAGS,
    hopNhatFeatureFlags,
    layEntitlementTenant,
    xoaCacheEntitlement,
    taoMiddlewareTinhNang,
    taoMiddlewareHanMucDonThang,
    khoiTaoPlatformAdmins,
    registerPlatformAdminRoutes,
};
