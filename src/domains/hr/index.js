'use strict';

const crypto = require('crypto');
const {
    TEN_VAI_TRO,
    SHIFT_SUPERVISOR_PERMS,
    VN_TZ,
    ngayHomNayVN,
    LoiNghiepVu,
    guiLoi,
    choPhepVaiTro,
    layTenantId,
} = require('../../core/auditAndSecurity');
const {
    createKioskQrPayload,
    verifyKioskQrToken,
    verifyLocationOrIp,
    isShiftTimeOverlapping,
    calculateLateMinutes,
} = require('../../../modules/hrAntiFraudService');
const {
    normalizeBranchId,
} = require('../../../modules/kdsPhase2Engine');
const {
    todayDateVN,
} = require('../../../modules/inventoryCogsPhase4Engine');

function registerHrDomain(app, deps) {
    const {
        pool,
        io,
        chayGiaoDich,
        qTenant,
        kiemTraToken,
        hashPassword,
        xoaCacheTrangThaiNV,
        layEntitlementTenant,
        ghiAuditLog,
    } = deps;

app.post('/api/nhansu/phanca', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const tenantId = layTenantId(req);

    const { maNV, maCa, ngayLam } = req.body;
    if (!maNV || !maCa || !ngayLam) return res.status(400).json({ message: 'Vui lòng cung cấp đủ maNV, maCa và ngayLam!' });

    try {
        const resultObj = await pool.withTenant(tenantId, async (client) => {
            const [ownNV, ownCa] = await Promise.all([
                client.query("SELECT 1 FROM NhanVien WHERE MaNV = $1 AND COALESCE(TenantId, 'DEFAULT') = $2", [maNV, tenantId]),
                client.query("SELECT MaCa, TenCa, GioBatDau, GioKetThuc FROM CaLamViec WHERE MaCa = $1 AND COALESCE(TenantId, 'DEFAULT') = $2", [maCa, tenantId]),
            ]);
            if (ownNV.rows.length === 0 || ownCa.rows.length === 0) return { notFound: true };

            const targetCa = ownCa.rows[0];
            // [Wave 3B — P1-04] Kiểm tra trùng khung giờ ca trong cùng ngày trước khi lưu
            const existingShifts = await client.query(
                `SELECT pc.MaPhanCa, pc.MaCa, clv.TenCa, clv.GioBatDau, clv.GioKetThuc
                   FROM PhanCa pc
                   JOIN CaLamViec clv ON pc.MaCa = clv.MaCa
                  WHERE pc.MaNV = $1
                    AND pc.NgayLam = $2::date
                    AND COALESCE(pc.TenantId, 'DEFAULT') = $3`,
                [maNV, ngayLam, tenantId]
            );
            for (const row of existingShifts.rows) {
                if (isShiftTimeOverlapping(targetCa.giobatdau, targetCa.gioketthuc, row.giobatdau, row.gioketthuc)) {
                    return {
                        overlap: {
                            maPhanCa: row.maphanca,
                            maCa: row.maca,
                            tenCa: row.tenca,
                            gioBatDau: row.giobatdau,
                            gioKetThuc: row.gioketthuc,
                        },
                    };
                }
            }

            const result = await client.query(
                'INSERT INTO PhanCa (MaNV, MaCa, NgayLam, TrangThai, TenantId) VALUES ($1, $2, $3, 1, $4) RETURNING MaPhanCa',
                [maNV, maCa, ngayLam, tenantId]
            );
            return { maPhanCa: result.rows[0].maphanca };
        });
        if (resultObj.notFound) {
            return res.status(404).json({ message: 'Nhân viên hoặc ca làm việc không thuộc quán hiện tại!' });
        }
        if (resultObj.overlap) {
            return res.status(409).json({
                code: 'SHIFT_OVERLAP_CONFLICT',
                maLoi: 'SHIFT_OVERLAP_CONFLICT',
                message: `Nhân viên đã có ca "${resultObj.overlap.tenCa}" (${resultObj.overlap.gioBatDau} - ${resultObj.overlap.gioKetThuc}) trùng khung giờ trong ngày ${ngayLam}!`,
                conflictShift: resultObj.overlap,
            });
        }
        res.json({ message: 'Xếp lịch phân ca thành công!', maPhanCa: resultObj.maPhanCa });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Phân ca:');
    }
});

// [Wave 3B — P1-04] Lấy hoặc tự sinh bí mật HMAC Kiosk QR cho chi nhánh
async function resolveBranchKioskConfig(client, tenantId, requestedBranchId) {
    const branchId = normalizeBranchId(requestedBranchId || 'DEFAULT');
    let res = await client.query(
        `SELECT branchid, machinhanh, kiosk_hmac_secret, geo_lat, geo_lng, geofence_radius_m, allowed_public_ips
           FROM public.chinhanh
          WHERE tenantid = $1 AND (branchid = $2 OR machinhanh = $2)
          LIMIT 1`,
        [tenantId, branchId]
    );
    if (res.rows.length === 0) {
        res = await client.query(
            `SELECT branchid, machinhanh, kiosk_hmac_secret, geo_lat, geo_lng, geofence_radius_m, allowed_public_ips
               FROM public.chinhanh
              WHERE tenantid = $1
              ORDER BY CASE WHEN trangthai = 'ACTIVE' THEN 0 ELSE 1 END, branchid ASC
              LIMIT 1`,
            [tenantId]
        );
    }
    const row = res.rows[0] || null;
    const resolvedBranchId = row ? row.branchid || row.machinhanh : branchId;
    const fallbackSecret = crypto
        .createHmac('sha256', String(process.env.JWT_SECRET || 'cafe-pos-kiosk-secret'))
        .update(`kiosk:${tenantId}:${resolvedBranchId}`)
        .digest('hex');
    return {
        branchRow: row,
        branchId: resolvedBranchId,
        kioskSecret: row?.kiosk_hmac_secret || null,
        effectiveSecret: row?.kiosk_hmac_secret || fallbackSecret,
        geoLat: row?.geo_lat ?? null,
        geoLng: row?.geo_lng ?? null,
        geofenceRadiusM: Number(row?.geofence_radius_m || 50),
        allowedPublicIps: Array.isArray(row?.allowed_public_ips) ? row.allowed_public_ips : [],
    };
}

// [Wave 3B — P1-04] Endpoint sinh mã QR chấm công động đổi mỗi 30 giây cho màn hình Kiosk quầy
app.get('/api/hr/kiosk-qr-token', kiemTraToken, choPhepVaiTro(1, 4), async (req, res) => {
    const tenantId = layTenantId(req);
    const reqBranchId = req.query.branchId || req.user.maChiNhanh || 'DEFAULT';
    try {
        const payload = await pool.withTenant(tenantId, async (client) => {
            const cfg = await resolveBranchKioskConfig(client, tenantId, reqBranchId);
            let secret = cfg.kioskSecret;
            if (!secret && cfg.branchRow) {
                secret = crypto.randomBytes(24).toString('hex');
                await client.query(
                    `UPDATE public.chinhanh
                        SET kiosk_hmac_secret = $1
                      WHERE tenantid = $2 AND branchid = $3`,
                    [secret, tenantId, cfg.branchId]
                );
            }
            return createKioskQrPayload(tenantId, cfg.branchId, secret || cfg.effectiveSecret, Date.now());
        });
        res.json(payload);
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Kiosk QR Token:');
    }
});

// [Wave 1 — P0-07] Phát hiện và gắn cờ MISSED_CLOCK_OUT cho ca đã qua giờ kết thúc > 2 giờ nhưng chưa Check-out
async function ganCoMissedClockOutChoTenant(client, tenantId) {
    await client.query('SAVEPOINT sp_missed_clockout');
    try {
        const res = await client.query(
            `UPDATE ChamCong cc
                SET trangthai_chamcong = 'MISSED_CLOCK_OUT',
                    auto_flagged_at = now(),
                    GhiChu = COALESCE(cc.GhiChu, '') || ' [MISSED_CLOCK_OUT]'
               FROM PhanCa pc
               JOIN CaLamViec clv ON pc.MaCa = clv.MaCa
              WHERE cc.MaPhanCa = pc.MaPhanCa
                AND COALESCE(pc.TenantId, 'DEFAULT') = $1
                AND cc.ThoiGianCheckOut IS NULL
                AND COALESCE(cc.trangthai_chamcong, 'NORMAL') = 'NORMAL'
                AND ((pc.NgayLam + clv.GioKetThuc)::timestamp AT TIME ZONE '${VN_TZ}') + interval '2 hours' < now()
              RETURNING cc.MaChamCong, cc.MaPhanCa`,
            [tenantId]
        );
        await client.query('RELEASE SAVEPOINT sp_missed_clockout');
        return res.rows;
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_missed_clockout').catch(() => {});
        return [];
    }
}

app.post('/api/nhansu/chamcong', kiemTraToken, async (req, res) => {
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const { maPhanCa, kioskQrToken, checkinLat, checkinLng, branchId } = req.body;
    const maNV = req.user.maNV;
    const tenantId = layTenantId(req);
    if (!maPhanCa) return res.status(400).json({ message: 'Thiếu mã phân ca (maPhanCa)!' });

    try {
        const todayVN = todayDateVN();
        // [Batch 6 — Anti-Spoof] Chỉ dùng req.ip đã qua cơ chế 'trust proxy' của Express, không tin thẳng X-Forwarded-For từ client
        const clientIp = String(req.ip || req.socket?.remoteAddress || '').trim();
        const outcome = await pool.withTenant(tenantId, async (client) => {
            await ganCoMissedClockOutChoTenant(client, tenantId);

            // [Wave 3B — P1-04] Xác thực chấm công 3 lớp (Kiosk QR 30s + GPS Geofencing / IP tĩnh)
            const kioskCfg = await resolveBranchKioskConfig(client, tenantId, branchId || req.user.maChiNhanh);
            const requireQr = Boolean(kioskCfg.kioskSecret) || (kioskQrToken !== undefined && kioskQrToken !== null && String(kioskQrToken).trim() !== '');
            let verifyMethod = 'MANUAL';

            if (requireQr) {
                const qrCheck = verifyKioskQrToken(kioskQrToken, tenantId, kioskCfg.branchId, kioskCfg.effectiveSecret, Date.now());
                if (!qrCheck.valid) {
                    await ghiAuditLog(client, {
                        tenantId,
                        maNV,
                        vaiTro: req.user.vaiTro,
                        hanhDong: 'HR_CHECKIN_REJECTED_QR',
                        doiTuong: 'CHAMCONG',
                        maDoiTuong: String(maPhanCa),
                        giaTriMoi: { branchId: kioskCfg.branchId, reason: qrCheck.reason },
                        lyDo: `Chấm công bị chặn do mã Kiosk QR không hợp lệ/hết hạn (${qrCheck.reason})`,
                        ip: req.ip,
                        batBuoc: true,
                    });
                    return {
                        forbidden: {
                            code: 'INVALID_KIOSK_QR',
                            message: 'Mã QR chấm công không hợp lệ hoặc đã hết hạn (> 60 giây)! Vui lòng quét lại mã mới tại quầy.',
                            reason: qrCheck.reason,
                        },
                    };
                }
                verifyMethod = 'KIOSK_QR';
            }

            const locCheck = verifyLocationOrIp({
                branchGeoLat: kioskCfg.geoLat,
                branchGeoLng: kioskCfg.geoLng,
                geofenceRadiusM: kioskCfg.geofenceRadiusM,
                allowedPublicIps: kioskCfg.allowedPublicIps,
                checkinLat,
                checkinLng,
                clientIp,
            });
            if (!locCheck.ok) {
                await ghiAuditLog(client, {
                    tenantId,
                    maNV,
                    vaiTro: req.user.vaiTro,
                    hanhDong: 'HR_CHECKIN_REJECTED_LOCATION',
                    doiTuong: 'CHAMCONG',
                    maDoiTuong: String(maPhanCa),
                    giaTriMoi: {
                        branchId: kioskCfg.branchId,
                        reason: locCheck.reason,
                        distanceMeters: locCheck.distanceMeters,
                        radiusMeters: kioskCfg.geofenceRadiusM,
                        checkinLat: checkinLat ?? null,
                        checkinLng: checkinLng ?? null,
                    },
                    lyDo: `Chấm công bị chặn do ngoài phạm vi chi nhánh (${locCheck.reason}${locCheck.distanceMeters != null ? `, cách ${locCheck.distanceMeters}m` : ''})`,
                    ip: req.ip,
                    batBuoc: true,
                });
                return {
                    forbidden: {
                        code: 'OUT_OF_GEOFENCE',
                        message: `Bạn đang đứng ngoài bán kính cho phép (${kioskCfg.geofenceRadiusM}m) hoặc không dùng mạng Wi-Fi cửa hàng!`,
                        reason: locCheck.reason,
                        distanceMeters: locCheck.distanceMeters,
                    },
                };
            }
            if (locCheck.method === 'GPS_GEOFENCE' || locCheck.method === 'STATIC_IP') {
                verifyMethod = requireQr ? `QR+${locCheck.method}` : locCheck.method;
            }

            // [Wave 1 — P0-07] Bắt buộc phân ca phải thuộc đúng ngày hôm nay (pc.NgayLam = todayDateVN())
            const caResult = await client.query(`
                SELECT pc.MaPhanCa, pc.NgayLam, clv.GioBatDau,
                       to_char((CURRENT_TIMESTAMP AT TIME ZONE '${VN_TZ}')::time, 'HH24:MI:SS') AS GioHienTaiVN
                FROM PhanCa pc
                JOIN CaLamViec clv ON pc.MaCa = clv.MaCa
                WHERE pc.MaPhanCa = $1
                  AND pc.MaNV = $2
                  AND COALESCE(pc.TenantId, 'DEFAULT') = $3
                  AND pc.NgayLam = $4::date
            `, [maPhanCa, maNV, tenantId, todayVN]);

            if (caResult.rows.length === 0) return { notFound: true };

            const caRow = caResult.rows[0];
            // [Wave 3B — P1-04] Ân hạn đi trễ 5 phút: late_minutes = Math.max(0, diffMin - 5)
            const lateMinutes = calculateLateMinutes(caRow.giobatdau, caRow.giohientaivn, 5);
            const ghiChu = lateMinutes > 0 ? `Đi trễ ${lateMinutes} phút` : 'Đúng giờ';
            const parsedLat = checkinLat !== undefined && checkinLat !== null && checkinLat !== '' && Number.isFinite(Number(checkinLat))
                ? Number(checkinLat) : null;
            const parsedLng = checkinLng !== undefined && checkinLng !== null && checkinLng !== '' && Number.isFinite(Number(checkinLng))
                ? Number(checkinLng) : null;

            const checkInResult = await client.query(
                `INSERT INTO ChamCong (MaPhanCa, ThoiGianCheckIn, GhiChu, verify_method, checkin_lat, checkin_lng, late_minutes)
                 VALUES ($1, CURRENT_TIMESTAMP, $2, $3, $4, $5, $6)
                 RETURNING MaChamCong, ThoiGianCheckIn, GhiChu, verify_method, checkin_lat, checkin_lng, late_minutes`,
                [maPhanCa, ghiChu, verifyMethod, parsedLat, parsedLng, lateMinutes]
            );
            return { chamCong: checkInResult.rows[0] };
        });

        if (outcome.forbidden) {
            return res.status(403).json(outcome.forbidden);
        }
        if (outcome.notFound) {
            return res.status(404).json({ message: 'Không tìm thấy lịch phân ca hợp lệ của bạn trong ngày hôm nay!' });
        }
        res.status(201).json({ message: 'Check-in vào ca thành công!', chamCong: outcome.chamCong });
    } catch (error) {
        if (error && error.code === '23505') {
            return res.status(409).json({
                message: 'Bạn đã chấm công vào ca này rồi (không thể check-in trùng)!',
                maLoi: 'ALREADY_CLOCKED_IN',
                code: 'ALREADY_CLOCKED_IN',
            });
        }
        console.error('Lỗi API Check-in:', error);
        res.status(500).json({ message: 'Lỗi máy chủ khi Check-in' });
    }
});

app.put('/api/nhansu/chamcong', kiemTraToken, async (req, res) => {
    if (!req.body) return res.status(400).json({ message: 'Dữ liệu gửi lên không được để trống!' });
    const { maPhanCa } = req.body;
    const maNV = req.user.maNV;
    const tenantId = layTenantId(req);
    if (!maPhanCa) return res.status(400).json({ message: 'Thiếu mã phân ca (maPhanCa)!' });

    try {
        const chamCong = await chayGiaoDich(async (client) => {
            const caResult = await client.query(`
                SELECT clv.GioKetThuc,
                       CASE WHEN (CURRENT_TIMESTAMP AT TIME ZONE '${VN_TZ}')::time < clv.GioKetThuc THEN ' - Về sớm' ELSE ' - Đủ giờ' END AS TinhTrangRa
                FROM PhanCa pc
                JOIN CaLamViec clv ON pc.MaCa = clv.MaCa
                WHERE pc.MaPhanCa = $1 AND pc.MaNV = $2 AND COALESCE(pc.TenantId, 'DEFAULT') = $3
            `, [maPhanCa, maNV, tenantId]);

            if (caResult.rows.length === 0) throw new LoiNghiepVu(404, 'Không tìm thấy ca làm việc hợp lệ!');

            const tinhTrangRa = caResult.rows[0].tinhtrangra;
            const updateChamCong = await client.query(`
                UPDATE ChamCong 
                SET ThoiGianCheckOut = CURRENT_TIMESTAMP, GhiChu = COALESCE(GhiChu, '') || $1
                WHERE MaPhanCa = $2 AND ThoiGianCheckOut IS NULL
                RETURNING MaChamCong, ThoiGianCheckIn, ThoiGianCheckOut, GhiChu
            `, [tinhTrangRa, maPhanCa]);

            if (updateChamCong.rows.length === 0) throw new LoiNghiepVu(400, 'Chưa Check-in hoặc ca này đã được Check-out từ trước!');

            await client.query('UPDATE PhanCa SET TrangThai = 2 WHERE MaPhanCa = $1', [maPhanCa]);
            return updateChamCong.rows[0];
        }, tenantId);

        res.json({ message: 'Check-out tan ca thành công!', chamCong });
    } catch (error) {
        if (error instanceof LoiNghiepVu) {
            return res.status(error.status).json({ message: error.message });
        }
        console.error('Lỗi API Check-out:', error);
        res.status(400).json({ message: error.message || 'Lỗi máy chủ khi Check-out' });
    }
});

app.get('/api/nhansu/tinhluong', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    let { tuNgay, denNgay, thang, nam, luongTheoGio, donGiaGio } = req.query;
    const donGiaMacDinh = parseFloat(luongTheoGio ?? donGiaGio) || 25000;

    if ((!tuNgay || !denNgay) && thang && nam) {
        const y = Number(nam), m = Number(thang);
        const lastDay = new Date(y, m, 0).getDate();
        tuNgay = `${y}-${String(m).padStart(2, '0')}-01`;
        denNgay = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    }
    if (!tuNgay || !denNgay) {
        return res.status(400).json({ message: 'Vui lòng cung cấp tuNgay/denNgay hoặc thang/nam!' });
    }

    try {
        const result = await qTenant(req, `
            SELECT nv.MaNV, nv.TenNV, nv.VaiTro,
                   COALESCE(NULLIF(nv.MucLuongTheoGio, 0), $3) AS MucLuongApDung,
                   COUNT(cc.MaChamCong) AS SoCaHoanThanh,
                   ROUND(COALESCE(SUM(EXTRACT(EPOCH FROM (cc.ThoiGianCheckOut - cc.ThoiGianCheckIn)) / 3600), 0)::numeric, 2) AS TongSoGio
            FROM NhanVien nv
            LEFT JOIN PhanCa pc ON nv.MaNV = pc.MaNV
                 AND pc.NgayLam BETWEEN $1 AND $2
                 AND COALESCE(pc.TenantId, 'DEFAULT') = $4
            LEFT JOIN ChamCong cc ON pc.MaPhanCa = cc.MaPhanCa
                 AND cc.ThoiGianCheckIn IS NOT NULL AND cc.ThoiGianCheckOut IS NOT NULL
            WHERE COALESCE(nv.TenantId, 'DEFAULT') = $4
              AND (
                  nv.TrangThaiLamViec = TRUE
                  OR EXISTS (
                      SELECT 1 FROM PhanCa pc2
                       WHERE pc2.MaNV = nv.MaNV
                         AND pc2.NgayLam BETWEEN $1 AND $2
                         AND COALESCE(pc2.TenantId, 'DEFAULT') = $4
                  )
              )
            GROUP BY nv.MaNV, nv.TenNV, nv.VaiTro, nv.MucLuongTheoGio
            ORDER BY nv.MaNV ASC
        `, [tuNgay, denNgay, donGiaMacDinh, tenantId]);

        const bangLuong = result.rows.map((row) => {
            const tongGio = parseFloat(row.tongsogio);
            const mucLuong = parseFloat(row.mucluongapdung);
            return {
                maNV: row.manv,
                tenNV: row.tennv,
                vaiTro: row.vaitro,
                soCaHoanThanh: parseInt(row.socahoanthanh, 10),
                tongSoGio: tongGio,
                luongTheoGio: mucLuong,
                tongLuong: Math.round(tongGio * mucLuong),
            };
        });
        res.json({ tuNgay, denNgay, bangLuong });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Tính lương:');
    }
});

app.get('/api/nhansu/phancacuatoi', kiemTraToken, async (req, res) => {
    const maNV = req.user.maNV;
    const tenantId = layTenantId(req);
    const { ngayLam } = req.query;
    try {
        const ngayTruyVan = ngayLam || ngayHomNayVN();
        const result = await qTenant(req, `
            SELECT pc.MaPhanCa, pc.MaCa, clv.TenCa, clv.GioBatDau, clv.GioKetThuc, TO_CHAR(pc.NgayLam, 'YYYY-MM-DD') AS NgayLam, pc.TrangThai
            FROM PhanCa pc
            JOIN CaLamViec clv ON pc.MaCa = clv.MaCa
            WHERE pc.MaNV = $1 AND pc.NgayLam = $2 AND COALESCE(pc.TenantId, 'DEFAULT') = $3
        `, [maNV, ngayTruyVan, tenantId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: `Không tìm thấy lịch phân ca nào cho nhân viên ${maNV} vào ngày ${ngayTruyVan}` });
        }
        res.json({ ngayLam: ngayTruyVan, danhSachPhanCa: result.rows });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Tra cứu phân ca:');
    }
});


// ==========================================
// [v2] DANH MỤC CHO TRANG QUẢN TRỊ
// ==========================================
app.get('/api/nhansu/nhanvien', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const r = await qTenant(
            req,
            `SELECT MaNV, TenNV, TenDangNhap, VaiTro, MucLuongTheoGio, TrangThaiLamViec,
                    (PinHash IS NOT NULL AND PinHash <> '') AS DaDatPin,
                    to_jsonb(NhanVien)->>'email' AS Email,
                    to_jsonb(NhanVien)->>'sodienthoai' AS SoDienThoai,
                    to_jsonb(NhanVien)->>'lastloginat' AS LastLoginAt,
                    COALESCE((to_jsonb(NhanVien)->'permissionsoverride')::jsonb, '{}'::jsonb) AS PermissionsOverride
               FROM NhanVien WHERE COALESCE(TenantId, 'DEFAULT') = $1 ORDER BY MaNV`,
            [tenantId]
        );
        res.json(r.rows.map((n) => {
            const perms = n.permissionsoverride && typeof n.permissionsoverride === 'object' ? n.permissionsoverride : {};
            return {
                maNV: n.manv,
                tenNV: n.tennv,
                tenDangNhap: n.tendangnhap,
                email: n.email || null,
                soDienThoai: n.sodienthoai || null,
                lastLoginAt: n.lastloginat || null,
                vaiTro: n.vaitro,
                mucLuongTheoGio: Number(n.mucluongtheogio),
                trangThaiLamViec: n.trangthailamviec,
                daDatPin: Boolean(n.dadatpin),
                laCaTruong: Boolean(perms.isShiftSupervisor),
                permissionsOverride: perms,
            };
        }));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách nhân viên:');
    }
});

// [P1 - Granular RBAC & Shift Supervisor] Phong/Gỡ Ca trưởng hoặc tinh chỉnh quyền hạn chi tiết (PermissionsOverride)
app.put('/api/nhansu/nhanvien/:maNV/quyen', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    const { maNV } = req.params;
    const { isShiftSupervisor, permissionsOverride = {} } = req.body || {};

    try {
        const updated = await pool.withTenant(tenantId, async (client) => {
            const curRes = await client.query(
                `SELECT MaNV, TenNV, VaiTro,
                        COALESCE((to_jsonb(NhanVien)->'permissionsoverride')::jsonb, '{}'::jsonb) AS PermissionsOverride
                   FROM NhanVien
                  WHERE MaNV = $1 AND COALESCE(TenantId, 'DEFAULT') = $2
                  FOR UPDATE`,
                [maNV, tenantId]
            );
            if (curRes.rows.length === 0) return null;
            const cur = curRes.rows[0];
            const prevPerms = cur.permissionsoverride && typeof cur.permissionsoverride === 'object' ? cur.permissionsoverride : {};

            let nextPerms = {
                ...prevPerms,
                ...(permissionsOverride && typeof permissionsOverride === 'object' ? permissionsOverride : {}),
            };
            if (isShiftSupervisor !== undefined) {
                const flag = Boolean(isShiftSupervisor);
                nextPerms = {
                    ...nextPerms,
                    isShiftSupervisor: flag,
                    'order.item.void_approve': flag,
                    'order.refund.approve': flag,
                    'shift.cash_payout.approve': flag,
                    'inventory.stocktake': flag,
                    'report.view_profit': false,
                    'staff.manage_payroll': false,
                };
            }

            await client.query(
                `UPDATE NhanVien
                    SET PermissionsOverride = $2::jsonb
                  WHERE MaNV = $1 AND COALESCE(TenantId, 'DEFAULT') = $3`,
                [maNV, JSON.stringify(nextPerms), tenantId]
            );

            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'STAFF_PERMISSIONS_UPDATED',
                doiTuong: 'NHANVIEN',
                maDoiTuong: maNV,
                giaTriCu: prevPerms,
                giaTriMoi: nextPerms,
                lyDo: nextPerms.isShiftSupervisor
                    ? `Phong Ca trưởng (Shift Supervisor) cho ${cur.tennv}`
                    : `Cập nhật quyền chi tiết cho ${cur.tennv}`,
                ip: req.ip,
                batBuoc: true,
            });

            return {
                maNV: cur.manv,
                tenNV: cur.tennv,
                vaiTro: Number(cur.vaitro),
                laCaTruong: Boolean(nextPerms.isShiftSupervisor),
                permissionsOverride: nextPerms,
            };
        });
        if (!updated) return res.status(404).json({ message: 'Không tìm thấy nhân viên thuộc quán này!' });
        res.json({
            message: updated.laCaTruong
                ? `🎖️ Đã phong Ca trưởng (Shift Supervisor) cho "${updated.tenNV}" (được duyệt PIN hủy món/hoàn tiền/chi >50k, ẩn báo cáo lãi lỗ)!`
                : `Đã cập nhật phân quyền chi tiết cho "${updated.tenNV}"!`,
            ...updated,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Cập nhật quyền nhân viên:');
    }
});

// [P0] Tạo nhân viên mới thuộc Tenant hiện tại (hỗ trợ username riêng theo từng quán + Email/SĐT tùy chọn)
app.post('/api/nhansu/nhanvien', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    const { tenNV, tenDangNhap, matKhau, vaiTro = 4, mucLuongTheoGio = 28000, email = '', soDienThoai = '' } = req.body || {};
    const cleanName = String(tenNV || '').trim();
    const cleanUser = String(tenDangNhap || '').trim().toLowerCase();
    const cleanPass = String(matKhau || '');
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPhone = String(soDienThoai || '').replace(/[^0-9+]/g, '').trim();
    const cleanPhoneDigits = cleanPhone.replace(/[^0-9]/g, '');
    const roleNum = Number(vaiTro);

    if (cleanName.length < 2) return res.status(400).json({ message: 'Vui lòng nhập họ tên nhân viên!' });
    if (!/^[a-z0-9_.-]{3,32}$/.test(cleanUser)) {
        return res.status(400).json({ message: 'Tên đăng nhập dài 3–32 ký tự (chỉ chữ thường, số, ., _, -)!' });
    }
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
        return res.status(400).json({ message: 'Email không đúng định dạng!' });
    }
    if (cleanPhone && (cleanPhoneDigits.length < 9 || cleanPhoneDigits.length > 15)) {
        return res.status(400).json({ message: 'Số điện thoại phải gồm 9–15 chữ số!' });
    }
    if (cleanPass.length < 6 || cleanPass.length > 128) {
        return res.status(400).json({ message: 'Mật khẩu nhân viên phải từ 6 ký tự trở lên!' });
    }
    if (![1, 2, 3, 4].includes(roleNum)) {
        return res.status(400).json({ message: 'Vai trò không hợp lệ (1 Quản lý | 2 Pha chế | 3 Phục vụ | 4 Thu ngân)!' });
    }

    try {
        // [Phân hệ 7/9] Kiểm tra trùng username theo PHẠM VI TỪNG TENANT (Quán A và Quán B đều tạo được "thungan1")
        let usernameDup = false;
        try {
            const fnDup = await pool.query('SELECT public.fn_tenant_username_exists($1, $2) AS exists', [tenantId, cleanUser]);
            usernameDup = fnDup.rows[0]?.exists === true;
        } catch {
            try {
                const fnDup2 = await pool.query('SELECT public.fn_username_exists($1, $2) AS exists', [cleanUser, tenantId]);
                usernameDup = fnDup2.rows[0]?.exists === true;
            } catch {
                const dup = await pool.queryTenant(
                    tenantId,
                    `SELECT 1 FROM NhanVien WHERE COALESCE(TenantId, 'DEFAULT') = $2 AND LOWER(TenDangNhap) = $1 LIMIT 1`,
                    [cleanUser, tenantId]
                );
                usernameDup = dup.rows.length > 0;
            }
        }
        if (usernameDup) {
            return res.status(409).json({ message: `Tên đăng nhập "${cleanUser}" đã tồn tại trong quán này!` });
        }

        if (cleanEmail || cleanPhoneDigits.length >= 9) {
            try {
                const cRes = await pool.query(
                    'SELECT email_exists, phone_exists FROM public.fn_contact_exists($1, $2)',
                    [cleanEmail || null, cleanPhoneDigits || null]
                );
                if (cRes.rows[0]?.email_exists) {
                    return res.status(409).json({ message: `Email "${cleanEmail}" đã được sử dụng!` });
                }
                if (cRes.rows[0]?.phone_exists) {
                    return res.status(409).json({ message: `Số điện thoại "${cleanPhone}" đã được sử dụng!` });
                }
            } catch {
                // ignore if Migration 020 not yet applied
            }
        }

        const prefix = req.user.maTienTo && tenantId !== 'DEFAULT' ? `${req.user.maTienTo}_` : '';
        const maNV = `${prefix}NV${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const hashed = await hashPassword(cleanPass);

        await pool.withTenant(tenantId, async (client) => {
            await client.query('SAVEPOINT sp_create_staff_ext');
            try {
                await client.query(
                    `INSERT INTO NhanVien (MaNV, TenNV, VaiTro, TenDangNhap, Email, SoDienThoai, MatKhauHash, MucLuongTheoGio, TrangThaiLamViec, TenantId)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9)`,
                    [maNV, cleanName, roleNum, cleanUser, cleanEmail || null, cleanPhone || null, hashed, Math.max(0, Number(mucLuongTheoGio) || 0), tenantId]
                );
                await client.query('RELEASE SAVEPOINT sp_create_staff_ext');
            } catch (insErr) {
                await client.query('ROLLBACK TO SAVEPOINT sp_create_staff_ext');
                if (insErr.code === '23505') throw insErr;
                await client.query(
                    `INSERT INTO NhanVien (MaNV, TenNV, VaiTro, TenDangNhap, MatKhauHash, MucLuongTheoGio, TrangThaiLamViec, TenantId)
                     VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)`,
                    [maNV, cleanName, roleNum, cleanUser, hashed, Math.max(0, Number(mucLuongTheoGio) || 0), tenantId]
                );
            }
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'STAFF_CREATED',
                doiTuong: 'NHANVIEN',
                maDoiTuong: maNV,
                giaTriMoi: { tenNV: cleanName, tenDangNhap: cleanUser, email: cleanEmail || null, soDienThoai: cleanPhone || null, vaiTro: roleNum },
                ip: req.ip,
                batBuoc: true,
            });
        });
        res.status(201).json({ message: `Đã tạo tài khoản nhân viên "${cleanName}" thành công!`, maNV });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `Tên đăng nhập, Email hoặc SĐT đã tồn tại!` });
        guiLoi(res, error, 'Lỗi API Tạo nhân viên:');
    }
});

// [P0] Khóa / Mở khóa nhân viên — thu hồi hiệu lực JWT ngay lập tức!
app.put('/api/nhansu/nhanvien/:maNV/trangthai', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    const { maNV } = req.params;
    const trangThaiLamViec = Boolean(req.body?.trangThaiLamViec);

    if (String(maNV) === String(req.user.maNV) && !trangThaiLamViec) {
        return res.status(400).json({ message: 'Không thể tự khóa tài khoản Quản lý đang đăng nhập!' });
    }
    try {
        const nvRow = await pool.withTenant(tenantId, async (client) => {
            const r = await client.query(
                `UPDATE NhanVien
                    SET TrangThaiLamViec = $2
                  WHERE MaNV = $1 AND COALESCE(TenantId, 'DEFAULT') = $3
                  RETURNING MaNV, TenNV, TrangThaiLamViec`,
                [maNV, trangThaiLamViec, tenantId]
            );
            if (r.rows.length === 0) return null;
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'STAFF_STATUS_CHANGED',
                doiTuong: 'NHANVIEN',
                maDoiTuong: maNV,
                giaTriMoi: { tenNV: r.rows[0].tennv, trangThaiLamViec },
                ip: req.ip,
                batBuoc: true,
            });
            return r.rows[0];
        });
        if (!nvRow) return res.status(404).json({ message: 'Không tìm thấy nhân viên thuộc quán này!' });

        xoaCacheTrangThaiNV(maNV, tenantId); // Thu hồi ngay phiên JWT đang hoạt động (không chờ hết hạn)
        if (!trangThaiLamViec) {
            // Thu hồi toàn bộ Refresh Token của nhân viên bị khóa ngay lập tức
            await pool.query('SELECT public.fn_revoke_staff_refresh_tokens($1, $2)', [tenantId, maNV]).catch(() => {});
            // [Wave 3A — P1-03] Đẩy ngay kết nối Socket.IO đúng tenant (t:{tenantId}:user:{maNV})
            io.in(`t:${tenantId}:user:${maNV}`).disconnectSockets(true);
        }
        res.json({
            message: trangThaiLamViec ? `Đã mở khóa tài khoản ${nvRow.tennv}!` : `Đã khóa ngay tài khoản ${nvRow.tennv}!`,
            maNV,
            trangThaiLamViec,
        });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Khóa/Mở nhân viên:');
    }
});

// [P0] Đặt lại mật khẩu nhân viên (Quản lý)
app.put('/api/nhansu/nhanvien/:maNV/matkhau', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    const { maNV } = req.params;
    const matKhauMoi = String(req.body?.matKhauMoi || '');
    if (matKhauMoi.length < 6 || matKhauMoi.length > 128) {
        return res.status(400).json({ message: 'Mật khẩu mới phải từ 6 đến 128 ký tự!' });
    }
    try {
        const hashed = await hashPassword(matKhauMoi);
        const nvRow = await pool.withTenant(tenantId, async (client) => {
            const r = await client.query(
                "UPDATE NhanVien SET MatKhauHash = $2 WHERE MaNV = $1 AND COALESCE(TenantId, 'DEFAULT') = $3 RETURNING MaNV, TenNV",
                [maNV, hashed, tenantId]
            );
            if (r.rows.length === 0) return null;
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'STAFF_PASSWORD_RESET',
                doiTuong: 'NHANVIEN',
                maDoiTuong: maNV,
                ip: req.ip,
                batBuoc: true,
            });
            return r.rows[0];
        });
        if (!nvRow) return res.status(404).json({ message: 'Không tìm thấy nhân viên!' });
        res.json({ message: `Đã đặt lại mật khẩu cho ${nvRow.tennv}!` });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Đặt lại mật khẩu:');
    }
});

// [P0] Đặt mã PIN duyệt nhanh (4-6 chữ số) cho Quản lý để duyệt hủy món sau in tạm tính / hao hụt ngay tại quầy POS
app.put('/api/nhansu/nhanvien/:maNV/pin', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    const { maNV } = req.params;
    const pin = String(req.body?.pin || '').trim();
    if (!/^\d{4,6}$/.test(pin)) {
        return res.status(400).json({ message: 'Mã PIN Quản lý phải gồm từ 4 đến 6 chữ số!' });
    }
    try {
        const hashed = await hashPassword(pin);
        const nvRow = await pool.withTenant(tenantId, async (client) => {
            const r = await client.query(
                "UPDATE NhanVien SET PinHash = $2 WHERE MaNV = $1 AND COALESCE(TenantId, 'DEFAULT') = $3 RETURNING MaNV, TenNV",
                [maNV, hashed, tenantId]
            );
            if (r.rows.length === 0) return null;
            await ghiAuditLog(client, {
                tenantId,
                maNV: req.user.maNV,
                vaiTro: req.user.vaiTro,
                hanhDong: 'MANAGER_PIN_UPDATED',
                doiTuong: 'NHANVIEN',
                maDoiTuong: maNV,
                ip: req.ip,
                batBuoc: true,
            });
            return r.rows[0];
        });
        if (!nvRow) return res.status(404).json({ message: 'Không tìm thấy nhân viên!' });
        res.json({ message: `Đã thiết lập mã PIN duyệt nhanh cho ${nvRow.tennv}!` });
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Đặt mã PIN Quản lý:');
    }
});

app.get('/api/nhansu/ca', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const tenantId = layTenantId(req);
    try {
        const r = await qTenant(
            req,
            "SELECT MaCa, TenCa, GioBatDau, GioKetThuc FROM CaLamViec WHERE COALESCE(TenantId, 'DEFAULT') = $1 ORDER BY GioBatDau, MaCa",
            [tenantId]
        );
        res.json(r.rows.map((c) => ({ maCa: c.maca, tenCa: c.tenca, gioBatDau: c.giobatdau, gioKetThuc: c.gioketthuc })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Danh sách ca làm việc:');
    }
});

// Lịch phân ca + trạng thái chấm công: ?tuNgay=YYYY-MM-DD&denNgay=YYYY-MM-DD (cô lập TenantId)
app.get('/api/nhansu/phanca', kiemTraToken, choPhepVaiTro(1), async (req, res) => {
    const { tuNgay, denNgay } = req.query;
    const tenantId = layTenantId(req);
    if (!tuNgay || !denNgay) return res.status(400).json({ message: 'Vui lòng cung cấp tham số tuNgay và denNgay (YYYY-MM-DD)!' });
    try {
        const r = await qTenant(
            req,
            `SELECT pc.MaPhanCa, pc.MaNV, nv.TenNV, nv.VaiTro, pc.MaCa, clv.TenCa, clv.GioBatDau, clv.GioKetThuc,
                    TO_CHAR(pc.NgayLam, 'YYYY-MM-DD') AS NgayLam, pc.TrangThai, cc.ThoiGianCheckIn, cc.ThoiGianCheckOut
               FROM PhanCa pc
               JOIN NhanVien nv ON nv.MaNV = pc.MaNV
               JOIN CaLamViec clv ON clv.MaCa = pc.MaCa
               LEFT JOIN ChamCong cc ON cc.MaPhanCa = pc.MaPhanCa
              WHERE pc.NgayLam BETWEEN $1 AND $2
                AND COALESCE(nv.TenantId, 'DEFAULT') = $3
              ORDER BY pc.NgayLam, clv.GioBatDau, nv.TenNV`,
            [tuNgay, denNgay, tenantId]
        );
        res.json(r.rows.map((p) => ({
            maPhanCa: p.maphanca,
            maNV: p.manv,
            tenNV: p.tennv,
            vaiTro: p.vaitro,
            maCa: p.maca,
            tenCa: p.tenca,
            gioBatDau: p.giobatdau,
            gioKetThuc: p.gioketthuc,
            ngayLam: p.ngaylam,
            trangThai: p.trangthai, // 1 đã xếp, 2 hoàn thành, 3 vắng
            checkIn: p.thoigiancheckin,
            checkOut: p.thoigiancheckout,
        })));
    } catch (error) {
        guiLoi(res, error, 'Lỗi API Lịch phân ca:');
    }
});


    return {
        resolveBranchKioskConfig,
        ganCoMissedClockOutChoTenant,
    };
}

module.exports = { registerHrDomain };
