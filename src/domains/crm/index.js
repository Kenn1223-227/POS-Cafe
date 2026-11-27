'use strict';

const crypto = require('crypto');
const {
    LoiNghiepVu,
    guiLoi,
    choPhepVaiTro,
    layTenantId,
} = require('../../core/auditAndSecurity');
const {
    tinhHangThanhVien,
} = require('../../../modules/ecosystemPhase8Routes');
const {
    maskPhoneForRole,
} = require('../../../modules/vnTaxAndEInvoiceService');

function registerCrmDomain(app, deps) {
    const {
        pool,
        qTenant,
        kiemTraToken,
        ghiAuditLog,
    } = deps;

// [Phân hệ 7] Snapshot danh sách khách hàng thân thiết để POS cache xuống IndexedDB phục vụ tra cứu Offline
app.get('/api/khachhang/cache', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    const isManager = Number(req.user?.vaiTro) === 1;
    const limit = isManager ? Math.min(2000, Math.max(50, Number(req.query.limit) || 1000)) : 5;
    if (!isManager) {
        return res.status(403).json({
            message: 'Thu ngân không được phép tải toàn bộ tệp khách hàng (NĐ 13/2023/NĐ-CP)!',
            customers: [],
        });
    }
    try {
        const r = await qTenant(
            req,
            `SELECT MaKH, COALESCE(to_jsonb(KhachHang)->>'tenkh', to_jsonb(KhachHang)->>'hoten', '') AS TenKH,
                    SoDienThoai, DiemTichLuy
               FROM KhachHang
              WHERE COALESCE(TenantId, 'DEFAULT') = $1
              ORDER BY DiemTichLuy DESC NULLS LAST, TenKH ASC
              LIMIT $2`,
            [tenantId, limit]
        );
        res.json({
            updatedAt: new Date().toISOString(),
            total: r.rows.length,
            customers: r.rows.map((k) => ({
                maKH: k.makh,
                tenKH: k.tenkh,
                soDienThoai: maskPhoneForRole(k.sodienthoai, req.user?.vaiTro),
                diemTichLuy: Number(k.diemtichluy || 0),
            })),
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Cache khách hàng Offline:');
    }
});

app.get('/api/khachhang', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    const rawQuery = String(req.query.soDienThoai || req.query.sdt || req.query.q || '').trim();
    const tenantId = layTenantId(req);
    const isManager = Number(req.user?.vaiTro) === 1;
    const rowLimit = isManager ? 10 : 5;
    if (!rawQuery) return res.status(400).json({ message: 'Vui lòng cung cấp soDienThoai (hoặc 4 số cuối SĐT)!' });
    const digitsOnly = rawQuery.replace(/[^0-9]/g, '');
    try {
        const selectCols = `
            MaKH,
            COALESCE(to_jsonb(KhachHang)->>'tenkh', to_jsonb(KhachHang)->>'hoten', '') AS TenKH,
            SoDienThoai, COALESCE(DiemTichLuy, 0) AS DiemTichLuy,
            COALESCE(to_jsonb(KhachHang)->>'hangthanhvien', 'DONG') AS HangThanhVien,
            COALESCE((to_jsonb(KhachHang)->>'tongchitieu')::numeric, 0) AS TongChiTieu,
            COALESCE((to_jsonb(KhachHang)->>'soduvi')::numeric, 0) AS SoDuVi
        `;
        let r;
        if (digitsOnly.length === 4 && /^\d{4}$/.test(rawQuery)) {
            // [PHÂN HỆ 8] Tra cứu 2 giây bằng 4 số cuối SĐT tận dụng functional index RIGHT(SoDienThoai, 4)
            r = await qTenant(
                req,
                `SELECT ${selectCols}
                   FROM KhachHang
                  WHERE COALESCE(TenantId, 'DEFAULT') = $2
                    AND (RIGHT(SoDienThoai, 4) = $1 OR RIGHT(REGEXP_REPLACE(COALESCE(SoDienThoai, ''), '[^0-9]', '', 'g'), 4) = $1)
                  ORDER BY DiemTichLuy DESC, TenKH ASC
                  LIMIT $3`,
                [digitsOnly, tenantId, rowLimit]
            );
        } else {
            r = await qTenant(
                req,
                `SELECT ${selectCols}
                   FROM KhachHang
                  WHERE COALESCE(TenantId, 'DEFAULT') = $2
                    AND (SoDienThoai = $1 OR ($3 <> '' AND RIGHT(SoDienThoai, 4) = $3))
                  ORDER BY CASE WHEN SoDienThoai = $1 THEN 0 ELSE 1 END, TenKH ASC
                  LIMIT $4`,
                [rawQuery, tenantId, digitsOnly.length === 4 ? digitsOnly : '', rowLimit]
            );
        }
        const danhSach = r.rows.map((k) => {
            const tier = tinhHangThanhVien(Number(k.tongchitieu || 0));
            return {
                maKH: k.makh,
                tenKH: k.tenkh,
                soDienThoai: maskPhoneForRole(k.sodienthoai, req.user?.vaiTro),
                diemTichLuy: Number(k.diemtichluy || 0),
                hangThanhVien: k.hangthanhvien || tier.hang,
                tenHang: tier.tenHang,
                cashbackPct: tier.cashbackPct,
                tongChiTieu: Number(k.tongchitieu || 0),
                soDuVi: Number(k.soduvi || 0),
            };
        });
        res.json({
            khachHang: danhSach[0] || null,
            danhSach,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Tra cứu khách hàng:');
    }
});

app.post('/api/khachhang', kiemTraToken, choPhepVaiTro(1, 3, 4), async (req, res) => {
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const { soDienThoai, tenKH } = req.body;
    const tenantId = layTenantId(req);

    if (!soDienThoai || !tenKH) {
        return res.status(400).json({ message: 'Vui lòng cung cấp số điện thoại và tên khách hàng!' });
    }

    try {
        const out = await pool.withTenant(tenantId, async (client) => {
            const result = await client.query(
                "SELECT MaKH, COALESCE(to_jsonb(KhachHang)->>'tenkh', to_jsonb(KhachHang)->>'hoten') AS TenKH, SoDienThoai, DiemTichLuy FROM KhachHang WHERE COALESCE(TenantId, 'DEFAULT') = $2 AND SoDienThoai = $1",
                [String(soDienThoai).trim(), tenantId]
            );
            if (result.rows.length > 0) {
                const k = result.rows[0];
                return {
                    existing: true,
                    khachHang: {
                        maKH: k.makh,
                        tenKH: k.tenkh,
                        soDienThoai: maskPhoneForRole(k.sodienthoai, req.user?.vaiTro),
                        diemTichLuy: Number(k.diemtichluy || 0),
                    },
                };
            }

            const maKH = 'KH' + crypto.randomBytes(4).toString('hex').toUpperCase();
            const cleanTen = String(tenKH).trim().slice(0, 100);
            const cleanSdt = String(soDienThoai).trim().slice(0, 20);
            let insertResult;
            await client.query('SAVEPOINT sp_ins_kh_tenkh');
            try {
                insertResult = await client.query(
                    'INSERT INTO KhachHang (MaKH, TenKH, SoDienThoai, DiemTichLuy, TenantId) VALUES ($1, $2, $3, 0, $4) RETURNING MaKH, TenKH, SoDienThoai, DiemTichLuy',
                    [maKH, cleanTen, cleanSdt, tenantId]
                );
                await client.query('RELEASE SAVEPOINT sp_ins_kh_tenkh');
            } catch (insErr) {
                await client.query('ROLLBACK TO SAVEPOINT sp_ins_kh_tenkh').catch(() => {});
                if (insErr && insErr.code === '42703') {
                    insertResult = await client.query(
                        'INSERT INTO KhachHang (MaKH, HoTen, SoDienThoai, DiemTichLuy, TenantId) VALUES ($1, $2, $3, 0, $4) RETURNING MaKH, HoTen AS TenKH, SoDienThoai, DiemTichLuy',
                        [maKH, cleanTen, cleanSdt, tenantId]
                    );
                } else {
                    throw insErr;
                }
            }
            const ins = insertResult.rows[0];
            return {
                existing: false,
                khachHang: {
                    maKH: ins.makh,
                    tenKH: ins.tenkh,
                    soDienThoai: maskPhoneForRole(ins.sodienthoai, req.user?.vaiTro),
                    diemTichLuy: Number(ins.diemtichluy || 0),
                },
            };
        });
        res.json({
            message: out.existing ? 'Tìm thấy thông tin khách hàng!' : 'Đăng ký khách hàng thành công!',
            khachHang: out.khachHang,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Khách hàng:');
    }
});

}

module.exports = { registerCrmDomain };
