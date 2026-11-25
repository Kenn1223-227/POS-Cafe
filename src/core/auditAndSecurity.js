'use strict';

// [v2] TIỆN ÍCH DÙNG CHUNG & MA TRẬN PHÂN QUYỀN CHI TIẾT (GRANULAR RBAC)
// ==========================================
const TEN_VAI_TRO = { 1: 'Quản lý', 2: 'Pha chế', 3: 'Phục vụ', 4: 'Thu ngân' };
const SHIFT_SUPERVISOR_PERMS = [
    'order.item.void_approve',
    'order.refund.approve',
    'shift.cash_payout.approve',
    'inventory.stocktake',
];

function coQuyenHan(user, permissionKey) {
    if (!user) return false;
    const perms =
        user.permissionsOverride && typeof user.permissionsOverride === 'object'
            ? user.permissionsOverride
            : {};
    if (perms[permissionKey] !== undefined) {
        return Boolean(perms[permissionKey]);
    }
    if (Number(user.vaiTro) === 1) return true;
    if (Boolean(perms.isShiftSupervisor) && SHIFT_SUPERVISOR_PERMS.includes(permissionKey)) {
        return true;
    }
    return false;
}
const SIZE_HOP_LE = ['S', 'M', 'L'];
const TRAM_CHE_BIEN_HOP_LE = ['BAR_CHINH', 'BAR_LANH', 'BEP_BANH'];

function suyLuanTramCheBien({ tramCheBien, nhomMon = '', tenMon = '' } = {}) {
    const clean = String(tramCheBien || '').trim().toUpperCase();
    // [Wave 3A — P1-03] Tôn trọng mọi trạm hợp lệ đã cấu hình rõ (bao gồm cả 'BAR_CHINH'), không ép nhảy trạm bằng regex!
    if (TRAM_CHE_BIEN_HOP_LE.includes(clean)) {
        return clean;
    }
    const text = `${nhomMon || ''} ${tenMon || ''}`.toLowerCase();
    if (/(bánh|bếp|snack|ăn vặt|đồ ăn|croissant|tiramisu|toast|mousse|cookie)/i.test(text)) {
        return 'BEP_BANH';
    }
    if (/(trà|đá xay|sinh tố|nước ép|matcha|freeze|soda|yogurt)/i.test(text)) {
        return 'BAR_LANH';
    }
    return 'BAR_CHINH';
}
const PHUONG_THUC_TT = ['TIEN_MAT', 'CHUYEN_KHOAN', 'THE', 'VOUCHER', 'VI_KHACH', 'VI_DIEN_TU', 'SAN_GIAO_HANG'];
const PHUONG_THUC_LEGACY = ['TIEN_MAT', 'CHUYEN_KHOAN', 'THE'];
const LOAI_GD_TIEU_HAO = 6; // PhieuGiaoDichKho.LoaiGD = 6: tiêu hao nguyên liệu do bán hàng
const LOAI_GD_HOAN_KHO = 7; // PhieuGiaoDichKho.LoaiGD = 7: hoàn kho do hủy món chưa pha chế
const LOAI_GD_HAO_HUT_HUY_MON = 8; // PhieuGiaoDichKho.LoaiGD = 8: hao hụt do hủy món đã pha (không cộng dồn trùng với LoaiGD=6)
const VN_TZ = 'Asia/Ho_Chi_Minh';
const ALLOW_NEGATIVE_STOCK = process.env.ALLOW_NEGATIVE_STOCK !== 'false'; // Mặc định cho phép bán khi chưa kịp nhập kho, kèm cảnh báo
const DIEM_MOI_VND = 10000; // 10.000đ = 1 điểm tích lũy
const CASH_PAYOUT_LIMIT_VND = Math.max(0, Number(process.env.CASH_PAYOUT_LIMIT_VND || 50000)); // Ngưỡng phiếu chi Thu ngân tự lập (vượt ngưỡng cần Quản lý)

const ngayHomNayVN = () => new Intl.DateTimeFormat('en-CA', { timeZone: VN_TZ }).format(new Date());

// Lỗi nghiệp vụ: ném ra trong handler/transaction, guiLoi() sẽ trả về đúng status
class LoiNghiepVu extends Error {
    constructor(status, message, chiTiet = {}) {
        super(message);
        this.status = status;
        this.chiTiet = chiTiet;
    }
}

function guiLoi(res, error, tieuDe) {
    if (error instanceof LoiNghiepVu) {
        return res.status(error.status).json({ message: error.message, ...error.chiTiet });
    }
    console.error(tieuDe, error);
    return res.status(500).json({ message: 'Lỗi máy chủ nội bộ' });
}

// Dùng sau kiemTraToken: choPhepVaiTro(1, 4)
const choPhepVaiTro = (...dsVaiTro) => (req, res, next) => {
    if (dsVaiTro.includes(req.user.vaiTro)) return next();
    const ten = dsVaiTro.map((v) => TEN_VAI_TRO[v]).join(', ');
    return res.status(403).json({ message: `Từ chối truy cập! Chức năng này chỉ dành cho: ${ten}.` });
};

const layTenantId = (req) => String(req?.user?.tenantId || 'DEFAULT');
const roomTen = (tenantId, role) => `t:${tenantId || 'DEFAULT'}:${role}`;


const lam3 = (x) => Math.round(x * 1000) / 1000; // khớp NUMERIC(18,3) của kho

// ---- Idempotency cho POST /api/order --------------------------------------------
// Client gửi header Idempotency-Key (UUID). Gửi lại cùng key + cùng nội dung => trả lại kết quả cũ,
// KHÔNG tạo thêm dòng món / không trừ kho lần nữa.
const IDEM_REGEX = /^[A-Za-z0-9_-]{8,64}$/;

// null = client không gửi key | false = key sai định dạng | string = key hợp lệ
function docKhoaIdempotency(req) {
    const raw = req.get('Idempotency-Key');
    if (raw === undefined) return null;
    return IDEM_REGEX.test(raw) ? raw : false;
}


// [Wave 3B — P1-02] Kiểm tra độ lệch đồng hồ thiết bị Offline (> 10 phút) chống gian lận Happy Hour
const OFFLINE_CLOCK_DRIFT_LIMIT_MS = 10 * 60 * 1000;
function detectOfflineClockDrift(offlineCreatedAt, nowMs = Date.now()) {
    if (!offlineCreatedAt) return { tampered: false, driftMs: 0, offlineCreatedAtMs: null };
    const offlineMs = Date.parse(String(offlineCreatedAt));
    if (!Number.isFinite(offlineMs)) return { tampered: false, driftMs: 0, offlineCreatedAtMs: null };
    const driftMs = Math.abs(nowMs - offlineMs);
    return {
        tampered: driftMs > OFFLINE_CLOCK_DRIFT_LIMIT_MS,
        driftMs,
        driftMinutes: Math.round((driftMs / 60000) * 10) / 10,
        offlineCreatedAtMs: offlineMs,
    };
}

// [v3 - Phân hệ 1 100/100] Tạo order / gọi thêm món (hỗ trợ Modifiers, Combo, Course Firing, Takeaway, Optimistic Locking)

function createCoreRuntime(deps) {
    const {
        pool,
        shouldRunAutoDdl,
        dispatchFraudAlertFromAudit,
        kiemTraCanhBaoTanSuatGianLan,
        verifyPassword,
        logger,
    } = deps;

    const runtimeFlags = {
        idemSanSang: false,
        auditSanSang: false,
        paymentsSanSang: false,
        vietQrLogSanSang: false,
    };

    const qTenant = (req, sql, params = []) => pool.queryTenant(layTenantId(req), sql, params);

    async function chayGiaoDich(fn, tenantId = null) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            if (tenantId) {
                await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [String(tenantId)]);
            }
            const ketQua = await fn(client);
            await client.query('COMMIT');
            return ketQua;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

async function kiemTraBangTonTai(tableName) {
    try {
        const r = await pool.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${String(tableName).toLowerCase()}`]);
        return r.rows[0]?.ok === true;
    } catch {
        return false;
    }
}

async function khoiTaoIdempotency() {
    if (!shouldRunAutoDdl()) {
        runtimeFlags.idemSanSang = await kiemTraBangTonTai('donhang_idempotency');
        return;
    }
    try {
        await pool.query(
            `CREATE TABLE IF NOT EXISTS DonHang_Idempotency (
                KhoaIdem    VARCHAR(64) PRIMARY KEY,
                MaNV        TEXT NOT NULL,
                DauVanTay   CHAR(64) NOT NULL,
                MaHoaDon    TEXT,
                LaHoaDonMoi BOOLEAN,
                DsMaCTHD    JSONB,
                ThoiGianTao TIMESTAMPTZ NOT NULL DEFAULT now()
            )`
        );
        runtimeFlags.idemSanSang = true;
    } catch (error) {
        // Nếu app chạy bằng role app_runtime (không có quyền DDL) nhưng migration đã tạo sẵn bảng -> vẫn bật bình thường
        runtimeFlags.idemSanSang = await kiemTraBangTonTai('donhang_idempotency');
        if (!runtimeFlags.idemSanSang) {
            console.error('⚠️ Không tạo được bảng DonHang_Idempotency, tạm tắt chống đơn trùng:', error.message);
        }
    }
}


async function khoiTaoMoRongSchema() {
    if (!shouldRunAutoDdl()) {
        [runtimeFlags.auditSanSang, runtimeFlags.paymentsSanSang, runtimeFlags.vietQrLogSanSang] = await Promise.all([
            kiemTraBangTonTai('audit_logs'),
            kiemTraBangTonTai('order_payments'),
            kiemTraBangTonTai('vietqr_webhook_events'),
        ]);
        return;
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS Audit_Logs (
                Id           BIGSERIAL PRIMARY KEY,
                MaNV         TEXT NOT NULL,
                VaiTro       INT,
                NguoiDuyet   TEXT,
                HanhDong     VARCHAR(64) NOT NULL,
                DoiTuong     VARCHAR(32) NOT NULL,
                MaDoiTuong   TEXT,
                GiaTriCu     JSONB,
                GiaTriMoi    JSONB,
                LyDo         TEXT,
                DiaChiIP     TEXT,
                ThoiGianTao  TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS idx_audit_logs_thoigian ON Audit_Logs (ThoiGianTao DESC);
        `);
        // Trigger chống sửa/xóa Nhật ký Kiểm toán (Append-only bất biến)
        try {
            await pool.query(`
                CREATE OR REPLACE FUNCTION audit_no_mutation() RETURNS trigger AS $$
                BEGIN
                    RAISE EXCEPTION 'Audit_Logs là nhật ký bất biến (append-only), cấm sửa hoặc xóa!';
                END;
                $$ LANGUAGE plpgsql;
                DROP TRIGGER IF EXISTS trg_audit_immutable ON Audit_Logs;
                CREATE TRIGGER trg_audit_immutable
                    BEFORE UPDATE OR DELETE ON Audit_Logs
                    FOR EACH ROW EXECUTE FUNCTION audit_no_mutation();
            `);
        } catch (trigErr) {
            console.warn('⚠️ Bỏ qua gắn trigger bất biến Audit_Logs:', trigErr.message);
        }
        runtimeFlags.auditSanSang = true;
    } catch (error) {
        runtimeFlags.auditSanSang = await kiemTraBangTonTai('audit_logs');
        if (!runtimeFlags.auditSanSang) console.warn('⚠️ Không tạo được bảng Audit_Logs:', error.message);
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS Order_Payments (
                Id               BIGSERIAL PRIMARY KEY,
                MaHoaDon         TEXT NOT NULL,
                MaCaThuNgan      TEXT,
                PhuongThucTT     VARCHAR(32) NOT NULL,
                SoTien           NUMERIC(15, 2) NOT NULL CHECK (SoTien > 0),
                TienKhachDua     NUMERIC(15, 2),
                TienThua         NUMERIC(15, 2) NOT NULL DEFAULT 0,
                TrangThai        VARCHAR(16) NOT NULL DEFAULT 'PAID',
                MaGiaoDichNgoai  VARCHAR(128) UNIQUE,
                NoiDungCK        TEXT,
                NguonXacNhan     VARCHAR(32) NOT NULL DEFAULT 'POS_MANUAL',
                KhoaIdem         VARCHAR(64) UNIQUE,
                MaNV             TEXT,
                ThoiGianTao      TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS idx_order_payments_hd ON Order_Payments (MaHoaDon, TrangThai);
            CREATE INDEX IF NOT EXISTS idx_order_payments_ca ON Order_Payments (MaCaThuNgan, TrangThai, PhuongThucTT);
            CREATE INDEX IF NOT EXISTS idx_order_payments_thoigian ON Order_Payments (ThoiGianTao DESC);
        `);
        runtimeFlags.paymentsSanSang = true;
    } catch (error) {
        runtimeFlags.paymentsSanSang = await kiemTraBangTonTai('order_payments');
        if (!runtimeFlags.paymentsSanSang) console.warn('⚠️ Không tạo được bảng Order_Payments:', error.message);
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS VietQR_Webhook_Events (
                Id               BIGSERIAL PRIMARY KEY,
                NhaCungCap       VARCHAR(32) NOT NULL,
                MaGiaoDichNgoai  VARCHAR(128) NOT NULL UNIQUE,
                SoTien           NUMERIC(15, 2) NOT NULL,
                NoiDungCK        TEXT,
                MaHoaDonKhop     TEXT,
                TrangThaiXuLy    VARCHAR(32) NOT NULL,
                PayloadGoc       JSONB,
                ThoiGianNhan     TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS idx_vietqr_events_thoigian ON VietQR_Webhook_Events (ThoiGianNhan DESC);
        `);
        runtimeFlags.vietQrLogSanSang = true;
    } catch (error) {
        runtimeFlags.vietQrLogSanSang = await kiemTraBangTonTai('vietqr_webhook_events');
        if (!runtimeFlags.vietQrLogSanSang) console.warn('⚠️ Không tạo được bảng VietQR_Webhook_Events:', error.message);
    }

    const alterStatements = [
        'ALTER TABLE ChiTietHoaDon ADD COLUMN IF NOT EXISTS TenMonSnapshot TEXT',
        'ALTER TABLE ChiTietHoaDon ADD COLUMN IF NOT EXISTS GiaVonSnapshot NUMERIC(15, 2) DEFAULT 0',
        'ALTER TABLE ChiTietHoaDon ADD COLUMN IF NOT EXISTS LyDoHuy TEXT',
        'ALTER TABLE HoaDon ADD COLUMN IF NOT EXISTS SoLanIn INT NOT NULL DEFAULT 0',
        'ALTER TABLE HoaDon ADD COLUMN IF NOT EXISTS DaInTamTinh BOOLEAN NOT NULL DEFAULT FALSE',
        'ALTER TABLE SanPham ADD COLUMN IF NOT EXISTS TamHet BOOLEAN NOT NULL DEFAULT FALSE',
        'ALTER TABLE Topping ADD COLUMN IF NOT EXISTS TamHet BOOLEAN NOT NULL DEFAULT FALSE',
        'ALTER TABLE CaThuNgan ADD COLUMN IF NOT EXISTS GhiChuChenhLech TEXT',
        'ALTER TABLE NhanVien ADD COLUMN IF NOT EXISTS PinHash TEXT',
        'ALTER TABLE Order_Payments ADD COLUMN IF NOT EXISTS TienChuyenThua NUMERIC(15, 2) NOT NULL DEFAULT 0',
        'ALTER TABLE HoaDon ADD COLUMN IF NOT EXISTS SoThuTuNgay INT',
        'ALTER TABLE ChiTietHoaDon ADD COLUMN IF NOT EXISTS ThoiGianXong TIMESTAMPTZ',
        'ALTER TABLE CaThuNgan ADD COLUMN IF NOT EXISTS TongRutKet NUMERIC(15, 2) NOT NULL DEFAULT 0',
        'ALTER TABLE CaThuNgan ADD COLUMN IF NOT EXISTS ChiTietMenhGia JSONB',
        'ALTER TABLE HoaDon ADD COLUMN IF NOT EXISTS MaOfflineClient VARCHAR(64)',
        "ALTER TABLE SanPham ADD COLUMN IF NOT EXISTS TramCheBien VARCHAR(20) NOT NULL DEFAULT 'BAR_CHINH'",
        'ALTER TABLE PhieuThuChiLatVat ADD COLUMN IF NOT EXISTS AnhChungTuUrl TEXT',
        'ALTER TABLE HoaDon ADD COLUMN IF NOT EXISTS SoTienHoan NUMERIC(15, 2) NOT NULL DEFAULT 0',
        'ALTER TABLE ChiTietHoaDon ADD COLUMN IF NOT EXISTS DaHoanTien BOOLEAN NOT NULL DEFAULT FALSE',
        'ALTER TABLE CaThuNgan ADD COLUMN IF NOT EXISTS SoZReport INT',
        'ALTER TABLE ChiTietHoaDon_Topping ADD COLUMN IF NOT EXISTS TenToppingSnapshot VARCHAR(120)',
        'ALTER TABLE ChiTietHoaDon_Topping ADD COLUMN IF NOT EXISTS GiaVonToppingSnapshot NUMERIC(15, 2) NOT NULL DEFAULT 0',
        'ALTER TABLE NguyenLieu ADD COLUMN IF NOT EXISTS LaBanThanhPham BOOLEAN NOT NULL DEFAULT FALSE',
        'ALTER TABLE NguyenLieu ADD COLUMN IF NOT EXISTS SanLuongMeMacDinh NUMERIC(15, 3) NOT NULL DEFAULT 1000',
        'ALTER TABLE NguyenLieu ADD COLUMN IF NOT EXISTS HanSuDungGio INT',
        'ALTER TABLE NguyenLieu ADD COLUMN IF NOT EXISTS IsKeyItem BOOLEAN NOT NULL DEFAULT FALSE',
        "ALTER TABLE NhanVien ADD COLUMN IF NOT EXISTS PermissionsOverride JSONB NOT NULL DEFAULT '{}'::jsonb",
    ];
    for (const sql of alterStatements) {
        try {
            await pool.query(sql);
        } catch (error) {
            console.warn(`⚠️ Bỏ qua nâng cấp cột (${sql.slice(0, 55)}...):`, error.message);
        }
    }

    // Nới lỏng CHECK constraint PhieuThuChiLatVat.LoaiPhieu để hỗ trợ loại 3 = RUT_KET (Safe Drop) & 4 = THOI_CK_DU
    try {
        await pool.query(`
            DO $$
            DECLARE
                con_name text;
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'phieuthuchilatvat') THEN
                    FOR con_name IN
                        SELECT c.conname
                          FROM pg_constraint c
                          JOIN pg_class t ON t.oid = c.conrelid
                          JOIN pg_namespace n ON n.oid = t.relnamespace
                         WHERE n.nspname = 'public'
                           AND t.relname = 'phieuthuchilatvat'
                           AND c.contype = 'c'
                           AND pg_get_constraintdef(c.oid) ILIKE '%loaiphieu%'
                    LOOP
                        EXECUTE format('ALTER TABLE public.phieuthuchilatvat DROP CONSTRAINT IF EXISTS %I', con_name);
                    END LOOP;
                    ALTER TABLE public.phieuthuchilatvat
                        ADD CONSTRAINT chk_phieuthuchi_loaiphieu CHECK (LoaiPhieu IN (1, 2, 3, 4));
                END IF;
            END $$;
        `);
    } catch (error) {
        console.warn('⚠️ Bỏ qua nâng cấp constraint LoaiPhieu (Safe Drop):', error.message);
    }

    // Tạo bảng Quy đổi Đơn vị Kho (UoM), Công thức Topping & Bộ đếm Số thứ tự nguyên tử (Tenant_Daily_Counter)
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS BanThanhPham_CongThuc (
                TenantId          VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
                MaNLThanhPham     VARCHAR(64) NOT NULL REFERENCES NguyenLieu(MaNL) ON DELETE CASCADE,
                MaNLThanhPhan     VARCHAR(64) NOT NULL REFERENCES NguyenLieu(MaNL) ON DELETE CASCADE,
                KhoiLuongTieuHao  NUMERIC(15, 3) NOT NULL CHECK (KhoiLuongTieuHao > 0),
                PRIMARY KEY (TenantId, MaNLThanhPham, MaNLThanhPhan),
                CHECK (MaNLThanhPham <> MaNLThanhPhan)
            );
        `).catch(() => {});
        await pool.query(`
            CREATE TABLE IF NOT EXISTS Tenant_Daily_Counter (
                TenantId VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
                NgayVN   DATE NOT NULL,
                LastSeq  INT NOT NULL DEFAULT 0,
                PRIMARY KEY (TenantId, NgayVN)
            );

            CREATE TABLE IF NOT EXISTS NguyenLieu_DonViQuyDoi (
                Id          BIGSERIAL PRIMARY KEY,
                TenantId    VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
                MaNL        VARCHAR(64) NOT NULL,
                TenDonVi    VARCHAR(32) NOT NULL,
                HeSoQuyDoi  NUMERIC(15, 4) NOT NULL CHECK (HeSoQuyDoi > 0),
                ThoiGianTao TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE (TenantId, MaNL, TenDonVi)
            );
            CREATE INDEX IF NOT EXISTS idx_nl_quydoi_tenant ON NguyenLieu_DonViQuyDoi (TenantId, MaNL);

            CREATE TABLE IF NOT EXISTS Topping_CongThuc (
                TenantId          VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
                MaTopping         VARCHAR(64) NOT NULL,
                MaNL              VARCHAR(64) NOT NULL,
                KhoiLuongTieuHao  NUMERIC(15, 4) NOT NULL CHECK (KhoiLuongTieuHao > 0),
                PRIMARY KEY (TenantId, MaTopping, MaNL)
            );
            CREATE INDEX IF NOT EXISTS idx_topping_ct_tenant ON Topping_CongThuc (TenantId, MaTopping);
        `);
    } catch (error) {
        console.warn('⚠️ Bỏ qua tạo bảng UoM / Topping_CongThuc:', error.message);
    }
}

async function ghiAuditLog(
    db,
    {
        tenantId = 'DEFAULT',
        maNV,
        vaiTro = null,
        nguoiDuyet = null,
        hanhDong,
        doiTuong,
        maDoiTuong = null,
        giaTriCu = null,
        giaTriMoi = null,
        lyDo = null,
        ip = null,
        batBuoc = false,
    }
) {
    if (!runtimeFlags.auditSanSang) return;
    try {
        await db.query(
            `INSERT INTO Audit_Logs (TenantId, MaNV, VaiTro, NguoiDuyet, HanhDong, DoiTuong, MaDoiTuong, GiaTriCu, GiaTriMoi, LyDo, DiaChiIP)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
            [
                String(tenantId || 'DEFAULT'),
                String(maNV || 'SYSTEM'),
                vaiTro !== null ? Number(vaiTro) : null,
                nguoiDuyet ? String(nguoiDuyet) : null,
                hanhDong,
                doiTuong,
                maDoiTuong !== null ? String(maDoiTuong) : null,
                giaTriCu !== null ? JSON.stringify(giaTriCu) : null,
                giaTriMoi !== null ? JSON.stringify(giaTriMoi) : null,
                lyDo ? String(lyDo).slice(0, 500) : null,
                ip ? String(ip).slice(0, 64) : null,
            ]
        );
        // [P1 Anti-Fraud] Bắn cảnh báo tức thời về Telegram / Webhook chủ quán (non-blocking, ngoài DB transaction)
        setImmediate(() => {
            void dispatchFraudAlertFromAudit(pool, {
                tenantId: String(tenantId || 'DEFAULT'),
                maNV: String(maNV || 'SYSTEM'),
                vaiTro: vaiTro !== null ? Number(vaiTro) : null,
                nguoiDuyet: nguoiDuyet ? String(nguoiDuyet) : null,
                hanhDong,
                doiTuong,
                maDoiTuong: maDoiTuong !== null ? String(maDoiTuong) : null,
                giaTriCu,
                giaTriMoi,
                lyDo: lyDo ? String(lyDo).slice(0, 500) : null,
                ip: ip ? String(ip).slice(0, 64) : null,
            });
        });
    } catch (error) {
        console.warn('⚠️ Không ghi được Audit_Logs:', error.message);
        if (batBuoc) throw error;
    }
}

async function donDepIdempotency() {
    try {
        try {
            // [P0 FIX NOBYPASSRLS] Dùng hàm SECURITY DEFINER để dọn rác DonHang_Idempotency dưới Fail-Closed RLS
            await pool.query(`SELECT public.fn_cleanup_old_idempotency()`);
        } catch {
            await pool.query(`DELETE FROM DonHang_Idempotency WHERE ThoiGianTao < now() - interval '2 days'`);
        }
    } catch (error) {
        console.error('Lỗi dọn bảng DonHang_Idempotency:', error.message);
    }
}


// Chống brute-force mã PIN Quản lý (4-6 chữ số): tối đa 5 lần nhập sai / 5 phút trên mỗi (tenant + IP)
const PIN_FAIL_WINDOW_MS = 5 * 60 * 1000;
const PIN_MAX_FAILS = 5;
const pinFailMap = new Map(); // key -> { count, resetAt }

function kiemTraGioiHanPin(tenantId, ip) {
    const key = `${tenantId}|${ip || 'unknown'}`;
    const entry = pinFailMap.get(key);
    if (!entry) return null;
    if (entry.resetAt <= Date.now()) {
        pinFailMap.delete(key);
        return null;
    }
    if (entry.count >= PIN_MAX_FAILS) {
        const secs = Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
        return `Nhập sai mã PIN Quản lý quá ${PIN_MAX_FAILS} lần! Vui lòng thử lại sau ${Math.ceil(secs / 60)} phút.`;
    }
    return null;
}

function ghiNhanPinSai(tenantId, ip) {
    const key = `${tenantId}|${ip || 'unknown'}`;
    const cur = pinFailMap.get(key);
    if (cur && cur.resetAt > Date.now()) cur.count += 1;
    else pinFailMap.set(key, { count: 1, resetAt: Date.now() + PIN_FAIL_WINDOW_MS });
}

function xoaDemPinSai(tenantId, ip) {
    pinFailMap.delete(`${tenantId}|${ip || 'unknown'}`);
}

// Helper xác thực Manager / Shift Supervisor Override PIN (4-6 chữ số) — Tối ưu O(1) khi truyền maNVDuyet!
async function xacThucPinQuanLy(
    db,
    tenantId,
    rawPin,
    ip = null,
    maNVDuyet = null,
    requiredPerm = 'order.item.void_approve'
) {
    const blockedMsg = kiemTraGioiHanPin(tenantId, ip);
    if (blockedMsg) {
        throw new LoiNghiepVu(429, blockedMsg, { maLoi: 'PIN_RATE_LIMITED' });
    }
    const pin = String(rawPin || '').trim();
    if (!/^\d{4,6}$/.test(pin)) {
        ghiNhanPinSai(tenantId, ip);
        return null;
    }
    const targetMaNV = typeof maNVDuyet === 'string' && maNVDuyet.trim() ? maNVDuyet.trim() : null;
    try {
        // [P1 O(1) Optimization] Khi POS gửi kèm maNVDuyet (chọn Quản lý / Ca trưởng từ danh sách) -> chỉ băm scrypt đúng 1 dòng O(1)!
        // Nếu không truyền maNVDuyet, giới hạn tối đa LIMIT 3 để chống DoS CPU/RAM khi nhập sai PIN.
        const managers = await db.query(
            `SELECT MaNV, TenNV, VaiTro, PinHash,
                    COALESCE((to_jsonb(NhanVien)->'permissionsoverride')::jsonb, '{}'::jsonb) AS PermissionsOverride
               FROM NhanVien
              WHERE TrangThaiLamViec = TRUE
                AND COALESCE(TenantId, 'DEFAULT') = $1
                AND PinHash IS NOT NULL
                AND ($2::text IS NULL OR MaNV = $2)
                AND (
                    VaiTro = 1
                    OR COALESCE((to_jsonb(NhanVien)->'permissionsoverride'->>'isShiftSupervisor')::boolean, FALSE) = TRUE
                    OR COALESCE((to_jsonb(NhanVien)->'permissionsoverride'->>$3)::boolean, FALSE) = TRUE
                )
              ORDER BY VaiTro ASC, MaNV ASC
              LIMIT $4`,
            [tenantId, targetMaNV, requiredPerm, targetMaNV ? 1 : 3]
        );
        for (const mgr of managers.rows) {
            const { ok } = await verifyPassword(pin, mgr.pinhash);
            if (ok) {
                xoaDemPinSai(tenantId, ip);
                return { maNV: mgr.manv, tenNV: mgr.tennv, vaiTro: Number(mgr.vaitro) };
            }
        }
    } catch {
        return null;
    }
    ghiNhanPinSai(tenantId, ip);
    return null;
}


    return {
        runtimeFlags,
        qTenant,
        chayGiaoDich,
        kiemTraBangTonTai,
        khoiTaoIdempotency,
        khoiTaoMoRongSchema,
        ghiAuditLog,
        donDepIdempotency,
        kiemTraGioiHanPin,
        ghiNhanPinSai,
        xoaDemPinSai,
        xacThucPinQuanLy,
    };
}

module.exports = {
    TEN_VAI_TRO,
    SHIFT_SUPERVISOR_PERMS,
    SIZE_HOP_LE,
    TRAM_CHE_BIEN_HOP_LE,
    PHUONG_THUC_TT,
    PHUONG_THUC_LEGACY,
    LOAI_GD_TIEU_HAO,
    LOAI_GD_HOAN_KHO,
    LOAI_GD_HAO_HUT_HUY_MON,
    VN_TZ,
    ALLOW_NEGATIVE_STOCK,
    DIEM_MOI_VND,
    CASH_PAYOUT_LIMIT_VND,
    IDEM_REGEX,
    OFFLINE_CLOCK_DRIFT_LIMIT_MS,
    coQuyenHan,
    suyLuanTramCheBien,
    ngayHomNayVN,
    LoiNghiepVu,
    guiLoi,
    choPhepVaiTro,
    layTenantId,
    roomTen,
    lam3,
    docKhoaIdempotency,
    detectOfflineClockDrift,
    createCoreRuntime,
};
