'use strict';

const jwt = require('jsonwebtoken');
const {
    TRAM_CHE_BIEN_HOP_LE,
    roomTen,
} = require('./auditAndSecurity');
const {
    VALID_STATIONS,
    normalizeBranchId,
    normalizeStation,
    roomBranchPos,
    roomBranchKds,
    roomBranchExpo,
    roomBranchWaiter,
    roomBranchQr,
} = require('../../modules/kdsPhase2Engine');

function registerSocketHandlers(io, deps) {
    const {
        pool,
        JWT_VERIFY_OPTIONS,
        kiemTraNhanVienConHoatDong,
    } = deps;

// ==========================================
// CẤU HÌNH SOCKET.IO CHO BARISTA & PHỤC VỤ
// ==========================================
io.use((socket, next) => {
    // Không đọc JWT từ query string để tránh lộ token vào access logs proxy/server
    const token = socket.handshake.auth?.token
               || (socket.handshake.headers['authorization'] ? socket.handshake.headers['authorization'].split(' ')[1] : null)
               || socket.handshake.headers['token'];

    if (!token) return next(new Error('Từ chối kết nối: Thiếu Token!'));

    jwt.verify(token, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS, async (err, user) => {
        if (err) return next(new Error('Từ chối kết nối: Token sai hoặc đã hết hạn!'));
        if (user?.type === 'PLATFORM_ADMIN') {
            return next(new Error('Từ chối kết nối: Token Platform Admin không dùng cho Socket quán!'));
        }
        // [P0 FIX] Kiểm tra trạng thái hoạt động của nhân viên ngay tại Socket handshake (chặn NV bị khóa kết nối lại!)
        const conHoatDong = await kiemTraNhanVienConHoatDong(user.maNV);
        if (!conHoatDong) {
            return next(new Error('Từ chối kết nối: Tài khoản nhân viên đã bị khóa hoặc ngừng làm việc!'));
        }
        // Tải branchId thẩm quyền từ DB (chống client giả mạo branchId khi room:subscribe)
        let resolvedBranchId = user.branchId ? String(user.branchId).trim() : null;
        if (!resolvedBranchId && user.maNV) {
            try {
                const tId = String(user.tenantId || 'DEFAULT');
                const brRes = await pool.withTenant(tId, (client) =>
                    client.query(
                        `SELECT NULLIF(TRIM(COALESCE(to_jsonb(NhanVien)->>'branchid', '')), '') AS branchid
                           FROM NhanVien
                          WHERE MaNV = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                          LIMIT 1`,
                        [user.maNV, tId]
                    )
                );
                resolvedBranchId = brRes.rows[0]?.branchid || null;
            } catch {
                // ignore if schema has no branchid column yet
            }
        }
        socket.user = { ...user, branchId: resolvedBranchId };
        next();
    });
});

io.on('connection', (socket) => {
    const vaiTro = Number(socket.user.vaiTro);
    const tenantId = String(socket.user.tenantId || 'DEFAULT');
    console.log(`Client kết nối Socket [${tenantId}]:`, socket.id);

    // [Wave 3A — P1-03] Phòng cá nhân cô lập đa tenant: t:{tenantId}:user:{maNV}
    if (socket.user.maNV) {
        socket.join(`t:${tenantId}:user:${socket.user.maNV}`);
    }

    if (vaiTro === 1) {
        socket.join([
            roomTen(tenantId, 'thungan'),
            roomTen(tenantId, 'phucvu'),
            roomTen(tenantId, 'barista'),
            ...TRAM_CHE_BIEN_HOP_LE.map((tr) => `t:${tenantId}:station:${tr}`),
        ]);
    } else if (vaiTro === 2) {
        socket.join(roomTen(tenantId, 'barista'));
    } else if (vaiTro === 3) {
        socket.join(roomTen(tenantId, 'phucvu'));
    } else if (vaiTro === 4) {
        socket.join(roomTen(tenantId, 'thungan'));
    }

    // [Phân hệ 2 - Topology Room 3 tầng] Đăng ký cô lập nghiêm ngặt theo Tenant -> Branch -> Station / Role
    // Bảo mật L2.1: Xác thực role & branchId theo socket.user (JWT + DB), tuyệt đối không tin mù quáng từ client!
    const ALLOWED_SOCKET_ROLES = {
        1: ['KDS', 'EXPO', 'WAITER', 'POS', 'QR'],
        2: ['KDS', 'EXPO'],
        3: ['WAITER', 'EXPO', 'QR'],
        4: ['POS', 'QR', 'EXPO'],
    };
    const DEFAULT_SOCKET_ROLE = { 1: 'KDS', 2: 'KDS', 3: 'WAITER', 4: 'POS' };

    // [Wave 1 — P0-01] Soft-Lock bàn đang mở modal thanh toán qua Socket (TTL 45s)
    if (!io._tableCheckoutLocks) io._tableCheckoutLocks = new Map();
    const broadcastTableLocks = () => {
        const now = Date.now();
        const active = [];
        for (const [key, entry] of io._tableCheckoutLocks.entries()) {
            if (entry.expiresAt <= now) {
                io._tableCheckoutLocks.delete(key);
                continue;
            }
            if (entry.tenantId === tenantId) active.push(entry);
        }
        io.to(roomTen(tenantId, 'thungan')).to(roomTen(tenantId, 'phucvu')).emit('table:checkout_locks', active);
    };

    socket.on('table:checkout_lock', (payload = {}, ack) => {
        const maBan = String(payload?.maBan || '').trim();
        if (!maBan) return typeof ack === 'function' ? ack({ ok: false, message: 'Thiếu maBan' }) : undefined;
        const lockKey = `${tenantId}:${maBan}`;
        const now = Date.now();
        const existing = io._tableCheckoutLocks.get(lockKey);
        if (existing && existing.expiresAt > now && existing.socketId !== socket.id && existing.maNV !== socket.user.maNV) {
            const reply = {
                ok: false,
                code: 'TABLE_CHECKOUT_LOCKED',
                lockedBy: existing.tenNV || existing.maNV,
                expiresAt: existing.expiresAt,
            };
            if (typeof ack === 'function') ack(reply);
            return;
        }
        const entry = {
            tenantId,
            maBan,
            maNV: socket.user.maNV,
            tenNV: socket.user.tenNV || socket.user.maNV,
            socketId: socket.id,
            expiresAt: now + 45 * 1000,
        };
        io._tableCheckoutLocks.set(lockKey, entry);
        broadcastTableLocks();
        if (typeof ack === 'function') ack({ ok: true, lock: entry });
    });

    socket.on('table:checkout_unlock', (payload = {}) => {
        const maBan = String(payload?.maBan || '').trim();
        if (!maBan) return;
        const lockKey = `${tenantId}:${maBan}`;
        const existing = io._tableCheckoutLocks.get(lockKey);
        if (existing && (existing.socketId === socket.id || existing.maNV === socket.user.maNV)) {
            io._tableCheckoutLocks.delete(lockKey);
            broadcastTableLocks();
        }
    });

    socket.on('disconnect', () => {
        let changed = false;
        for (const [k, entry] of io._tableCheckoutLocks.entries()) {
            if (entry.socketId === socket.id) {
                io._tableCheckoutLocks.delete(k);
                changed = true;
            }
        }
        if (changed) broadcastTableLocks();
    });

    socket.on('room:subscribe', (opts = {}, ack) => {
        const allowedRoles = ALLOWED_SOCKET_ROLES[vaiTro] || [];
        const requestedRole = String(opts?.role || '').trim().toUpperCase();
        const role = requestedRole || DEFAULT_SOCKET_ROLE[vaiTro] || 'KDS';

        if (!allowedRoles.includes(role)) {
            const errReply = {
                ok: false,
                code: 'FORBIDDEN_ROOM_ROLE',
                error: `Vai trò của bạn không được phép đăng ký phòng ${role}!`,
            };
            socket.emit('room:subscribe_error', errReply);
            if (typeof ack === 'function') ack(errReply);
            return;
        }

        const assignedBranch = socket.user.branchId ? normalizeBranchId(socket.user.branchId) : null;
        const requestedBranch = opts?.branchId ? normalizeBranchId(opts.branchId) : null;
        const isHqManager = vaiTro === 1 && (!assignedBranch || assignedBranch === 'DEFAULT' || assignedBranch === 'ALL');

        let branchId;
        if (isHqManager) {
            branchId = requestedBranch || assignedBranch || 'DEFAULT';
        } else {
            const authoritativeBranch = assignedBranch || 'DEFAULT';
            if (requestedBranch && requestedBranch !== authoritativeBranch) {
                const errReply = {
                    ok: false,
                    code: 'FORBIDDEN_BRANCH',
                    error: `Bạn không có quyền đăng ký phòng của chi nhánh ${requestedBranch}!`,
                };
                socket.emit('room:subscribe_error', errReply);
                if (typeof ack === 'function') ack(errReply);
                return;
            }
            branchId = authoritativeBranch;
        }

        const station = normalizeStation(opts?.station || opts?.tram || 'ALL');

        // Rời toàn bộ các phòng legacy & phòng 3 tầng cũ để đảm bảo cô lập tuyệt đối theo Branch + Station!
        for (const room of [...socket.rooms]) {
            if (room === socket.id || room === `t:${tenantId}:user:${socket.user.maNV}`) continue;
            socket.leave(room);
        }

        const joinedRooms = [];
        const addRoom = (r) => {
            socket.join(r);
            joinedRooms.push(r);
        };

        if (role === 'EXPO') {
            addRoom(roomBranchExpo(tenantId, branchId));
        } else if (role === 'WAITER') {
            addRoom(roomBranchWaiter(tenantId, branchId));
        } else if (role === 'POS') {
            addRoom(roomBranchPos(tenantId, branchId));
        } else if (role === 'QR') {
            addRoom(roomBranchQr(tenantId, branchId));
        } else {
            // Mặc định KDS theo trạm pha chế cụ thể (hoặc ALL cho màn hình KDS tổng của đúng Chi nhánh)
            if (station === 'ALL') {
                for (const st of VALID_STATIONS) addRoom(roomBranchKds(tenantId, branchId, st));
                addRoom(roomBranchKds(tenantId, branchId, 'ALL'));
            } else {
                addRoom(roomBranchKds(tenantId, branchId, station));
            }
        }

        const reply = {
            ok: true,
            tenantId,
            branchId,
            station,
            role,
            rooms: joinedRooms,
            serverNowMs: Date.now(),
        };
        socket.emit('room:subscribed', reply);
        if (typeof ack === 'function') ack(reply);
    });

    // Cho phép màn hình KDS Barista đăng ký nhận thông báo theo Trạm pha chế / Bếp (legacy)
    socket.on('CHON_TRAM_KDS', (tram) => {
        if (vaiTro !== 1 && vaiTro !== 2) return;
        for (const tr of TRAM_CHE_BIEN_HOP_LE) {
            socket.leave(`t:${tenantId}:station:${tr}`);
        }
        const cleanTram = String(tram || '').trim().toUpperCase();
        if (TRAM_CHE_BIEN_HOP_LE.includes(cleanTram)) {
            socket.join(`t:${tenantId}:station:${cleanTram}`);
        } else {
            for (const tr of TRAM_CHE_BIEN_HOP_LE) {
                socket.join(`t:${tenantId}:station:${tr}`);
            }
        }
    });
});

}

module.exports = { registerSocketHandlers };
