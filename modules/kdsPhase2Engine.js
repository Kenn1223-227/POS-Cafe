/**
 * =============================================================================
 * PHÂN HỆ 2: KDS / BDS REAL-TIME, IDEMPOTENCY 2-PHA, CASCADE 86'ING & TELEMETRY
 * Pure & DB Core Engine (Zero circular deps with server.js)
 * =============================================================================
 */

const VALID_STATIONS = ['BAR_CHINH', 'BAR_LANH', 'BEP_BANH'];

function normalizeBranchId(branchId) {
    const clean = String(branchId || '').trim();
    return clean || 'DEFAULT';
}

function normalizeStation(station) {
    const clean = String(station || '').trim().toUpperCase();
    if (VALID_STATIONS.includes(clean)) return clean;
    return 'ALL';
}

// -----------------------------------------------------------------------------
// TRỤ CỘT 1: TOPOLOGY ROOM 3 TẦNG (Tenant -> Branch -> Station/Role) & EVENT LOG
// -----------------------------------------------------------------------------
const roomBranchPos = (tenantId, branchId) => `t:${tenantId}:b:${normalizeBranchId(branchId)}:pos`;
const roomBranchKds = (tenantId, branchId, station) =>
    `t:${tenantId}:b:${normalizeBranchId(branchId)}:kds:${normalizeStation(station)}`;
const roomBranchExpo = (tenantId, branchId) => `t:${tenantId}:b:${normalizeBranchId(branchId)}:expo`;
const roomBranchWaiter = (tenantId, branchId) => `t:${tenantId}:b:${normalizeBranchId(branchId)}:waiter`;
const roomBranchQr = (tenantId, branchId) => `t:${tenantId}:b:${normalizeBranchId(branchId)}:qr`;

async function insertKdsEventLog(
    db,
    { tenantId = 'DEFAULT', branchId = 'DEFAULT', station = 'ALL', eventType, maHoaDon = null, payload = {} }
) {
    const cleanBranch = normalizeBranchId(branchId);
    const cleanStation = normalizeStation(station);
    const res = await db.query(
        `INSERT INTO public.kds_event_log (tenantid, branchid, station, eventtype, mahoadon, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING seq, thoigiantao`,
        [String(tenantId || 'DEFAULT'), cleanBranch, cleanStation, String(eventType || 'UNKNOWN'), maHoaDon || null, JSON.stringify(payload || {})]
    );
    return {
        seq: Number(res.rows[0].seq),
        thoiGianTao: res.rows[0].thoigiantao,
        branchId: cleanBranch,
        station: cleanStation,
    };
}

/**
 * Phát sự kiện KDS chuẩn 3 tầng (Tenant -> Branch -> Station/Role) kèm seq tăng đơn điệu & serverNowMs.
 * Đảm bảo cô lập tuyệt đối giữa các Chi nhánh & các Trạm pha chế.
 */
function emitScopedKdsEvent(
    io,
    {
        tenantId = 'DEFAULT',
        branchId = 'DEFAULT',
        station = 'ALL',
        seq = null,
        eventType,
        socketEvents = [],
        payload = {},
        includeExpo = false,
        includeWaiter = false,
        includePos = false,
        includeQr = false,
        legacyBaristaEvent = null,
        legacyWaiterEvent = null,
        legacyPosEvent = null,
    }
) {
    if (!io) return;
    const tId = String(tenantId || 'DEFAULT');
    const bId = normalizeBranchId(branchId);
    const st = normalizeStation(station);
    const envelope = {
        ...payload,
        seq,
        eventType,
        branchId: bId,
        station: st,
        serverNowMs: Date.now(),
    };

    const events = Array.isArray(socketEvents) ? socketEvents.filter(Boolean) : [socketEvents].filter(Boolean);

    // 1. Gửi tới đúng phòng KDS của chi nhánh & trạm
    const kdsRooms =
        st === 'ALL'
            ? VALID_STATIONS.map((s) => roomBranchKds(tId, bId, s))
            : [roomBranchKds(tId, bId, st)];

    for (const room of kdsRooms) {
        for (const ev of events) {
            io.to(room).emit(ev, envelope);
        }
    }
    if (st === 'ALL') {
        for (const ev of events) {
            io.to(roomBranchKds(tId, bId, 'ALL')).emit(ev, envelope);
        }
    }

    // 2. Gửi tới Expo / Waiter / POS / QR của đúng chi nhánh
    if (includeExpo) {
        for (const ev of events) io.to(roomBranchExpo(tId, bId)).emit(ev, envelope);
    }
    if (includeWaiter) {
        for (const ev of events) io.to(roomBranchWaiter(tId, bId)).emit(ev, envelope);
    }
    if (includePos) {
        for (const ev of events) io.to(roomBranchPos(tId, bId)).emit(ev, envelope);
    }
    if (includeQr) {
        for (const ev of events) io.to(roomBranchQr(tId, bId)).emit(ev, envelope);
    }

    // 3. Tương thích ngược với client cũ chưa gọi room:subscribe (client đã subscribe sẽ rời room legacy)
    if (legacyBaristaEvent) {
        io.to(`t:${tId}:barista`).emit(legacyBaristaEvent, envelope);
    }
    if (legacyWaiterEvent) {
        io.to(`t:${tId}:phucvu`).emit(legacyWaiterEvent, envelope);
    }
    if (legacyPosEvent) {
        io.to(`t:${tId}:thungan`).emit(legacyPosEvent, envelope);
    }
}

/**
 * Ghi log sự kiện ORDER_NEW tách riêng từng Trạm (BAR_CHINH / BAR_LANH / BEP_BANH) cho 1 chi nhánh
 * và phát đúng các món thuộc trạm đó tới phòng `t:{tenant}:b:{branch}:kds:{station}` + tổng hợp tới `expo`.
 */
async function recordAndEmitOrderNewByStation(
    client,
    io,
    {
        tenantId = 'DEFAULT',
        branchId = 'DEFAULT',
        maHoaDon,
        maBan = null,
        tenBan = null,
        mangDi = false,
        themMon = false,
        dotGoi = 1,
        clientOrderUid = null,
        monMoiFired = [],
    }
) {
    if (!Array.isArray(monMoiFired) || monMoiFired.length === 0) return [];
    const bId = normalizeBranchId(branchId);
    const byStation = new Map();
    for (const m of monMoiFired) {
        const st = normalizeStation(m.tramCheBien);
        const targetSt = st === 'ALL' ? 'BAR_CHINH' : st;
        if (!byStation.has(targetSt)) byStation.set(targetSt, []);
        byStation.get(targetSt).push(m);
    }

    const emitted = [];
    for (const [st, items] of byStation.entries()) {
        const stationPayload = {
            maHoaDon,
            maBan: maBan || null,
            tenBan: tenBan || items[0]?.tenBan || null,
            mangDi: Boolean(mangDi),
            themMon: Boolean(themMon),
            dotGoi: Number(dotGoi || 1),
            clientOrderUid: clientOrderUid || null,
            station: st,
            branchId: bId,
            danhSachMon: items,
        };
        const logInfo = await insertKdsEventLog(client, {
            tenantId,
            branchId: bId,
            station: st,
            eventType: 'ORDER_NEW',
            maHoaDon,
            payload: stationPayload,
        });
        emitted.push({ ...logInfo, payload: stationPayload });
    }

    // Sau khi insert event log (trong transaction hoặc ngoài), caller gọi flush sau commit hoặc gọi ngay nếu ngoài tx
    const flush = () => {
        if (!io) return;
        for (const e of emitted) {
            emitScopedKdsEvent(io, {
                tenantId,
                branchId: bId,
                station: e.station,
                seq: e.seq,
                eventType: 'ORDER_NEW',
                socketEvents: ['order:new', 'CO_DON_MOI'],
                payload: e.payload,
            });
        }
        // Gửi trọn đơn lên màn hình Expo của đúng Chi nhánh
        const fullPayload = {
            maHoaDon,
            maBan: maBan || null,
            tenBan: tenBan || monMoiFired[0]?.tenBan || null,
            mangDi: Boolean(mangDi),
            themMon: Boolean(themMon),
            dotGoi: Number(dotGoi || 1),
            clientOrderUid: clientOrderUid || null,
            branchId: bId,
            danhSachMon: monMoiFired,
            seq: emitted[emitted.length - 1]?.seq || null,
            eventType: 'ORDER_NEW',
            serverNowMs: Date.now(),
        };
        io.to(roomBranchExpo(tenantId, bId)).emit('order:new', fullPayload);
        io.to(roomBranchExpo(tenantId, bId)).emit('CO_DON_MOI', fullPayload);
        // Legacy fallback cho client cũ chưa subscribe 3-tier
        io.to(`t:${tenantId}:barista`).emit('CO_DON_MOI', fullPayload);
    };

    return { emitted, flush };
}

// -----------------------------------------------------------------------------
// TRỤ CỘT 1.2: KHÓA IDEMPOTENCY 2-PHA (PROCESSING -> DONE / FAILED)
// Chạy ngoài business transaction để các request đúp cách nhau 50ms thấy ngay PROCESSING!
// -----------------------------------------------------------------------------
async function acquireIdempotencyLock(
    pool,
    { tenantId = 'DEFAULT', khoaIdem, maNV, dauVanTay, requestFingerprint = null, leaseSeconds = 60 }
) {
    if (!khoaIdem) return { acquired: true, disabled: true };
    const tId = String(tenantId || 'DEFAULT');
    const fp = requestFingerprint ? String(requestFingerprint).slice(0, 64) : (dauVanTay ? String(dauVanTay).slice(0, 64) : null);
    const ttlSec = Math.max(5, Math.min(300, Number(leaseSeconds) || 60));

    return pool.withTenant(tId, async (client) => {
        // 1 câu SQL nguyên tử: chiếm khóa mới HOẶC thu hồi khóa FAILED / zombie PROCESSING quá hạn lease (60s)
        const ins = await client.query(
            `INSERT INTO public.donhang_idempotency (
                 tenantid, khoaidem, manv, dauvantay, request_fingerprint, trangthai, lease_expires_at, thoigiantao
             )
             VALUES ($1, $2, $3, $4, $5, 'PROCESSING', now() + ($6::int * interval '1 second'), now())
             ON CONFLICT (tenantid, khoaidem) DO UPDATE
                SET trangthai = 'PROCESSING',
                    manv = EXCLUDED.manv,
                    dauvantay = EXCLUDED.dauvantay,
                    request_fingerprint = EXCLUDED.request_fingerprint,
                    lease_expires_at = now() + ($6::int * interval '1 second'),
                    thoigiantao = now()
              WHERE public.donhang_idempotency.trangthai = 'FAILED'
                 OR (
                     public.donhang_idempotency.trangthai = 'PROCESSING'
                     AND public.donhang_idempotency.lease_expires_at < now()
                 )
             RETURNING khoaidem`,
            [tId, khoaIdem, String(maNV), dauVanTay || null, fp, ttlSec]
        );
        if (ins.rows.length > 0) {
            return { acquired: true, state: 'PROCESSING' };
        }

        // Đọc trạng thái bản ghi đang có trong đúng tenant
        const curRes = await client.query(
            `SELECT manv, dauvantay, request_fingerprint, trangthai, mahoadon, mahoadonkq, lahoadonmoi, dsmacthd, responsejson, httpstatus
               FROM public.donhang_idempotency
              WHERE tenantid = $1 AND khoaidem = $2`,
            [tId, khoaIdem]
        );
        const k = curRes.rows[0];
        if (!k) {
            return { acquired: false, state: 'IN_FLIGHT' };
        }

        if (String(k.manv) !== String(maNV) || (dauVanTay && k.dauvantay && k.dauvantay !== dauVanTay)) {
            return { acquired: false, state: 'KEY_REUSED' };
        }
        if (k.trangthai === 'PROCESSING' || (!k.mahoadon && !k.mahoadonkq && !k.responsejson)) {
            return { acquired: false, state: 'IN_FLIGHT' };
        }
        return {
            acquired: false,
            state: 'DONE',
            record: {
                maHoaDon: k.mahoadonkq || k.mahoadon,
                laHoaDonMoi: Boolean(k.lahoadonmoi),
                dsMaCTHD: Array.isArray(k.dsmacthd) ? k.dsmacthd : [],
                responseJson: k.responsejson || null,
                httpStatus: Number(k.httpstatus || 200),
            },
        };
    });
}

async function completeIdempotencyLock(
    pool,
    { tenantId = 'DEFAULT', khoaIdem, maHoaDon, laHoaDonMoi = true, dsMaCTHD = [], responseJson = null, httpStatus = 200 }
) {
    if (!khoaIdem) return;
    const tId = String(tenantId || 'DEFAULT');
    await pool.withTenant(tId, async (client) => {
        await client.query(
            `UPDATE public.donhang_idempotency
                SET trangthai = 'DONE',
                    mahoadon = $3::text,
                    mahoadonkq = $4::varchar,
                    lahoadonmoi = $5,
                    dsmacthd = $6::jsonb,
                    responsejson = $7::jsonb,
                    httpstatus = $8
              WHERE tenantid = $1 AND khoaidem = $2`,
            [
                tId,
                khoaIdem,
                String(maHoaDon),
                String(maHoaDon),
                Boolean(laHoaDonMoi),
                JSON.stringify(dsMaCTHD || []),
                responseJson ? JSON.stringify(responseJson) : null,
                Number(httpStatus || 200),
            ]
        );
    });
}

async function failIdempotencyLock(pool, { tenantId = 'DEFAULT', khoaIdem }) {
    if (!khoaIdem) return;
    const tId = String(tenantId || 'DEFAULT');
    await pool
        .withTenant(tId, async (client) => {
            await client.query(
                `UPDATE public.donhang_idempotency
                    SET trangthai = 'FAILED'
                  WHERE tenantid = $1 AND khoaidem = $2 AND trangthai = 'PROCESSING'`,
                [tId, khoaIdem]
            );
        })
        .catch(() => {});
}

// -----------------------------------------------------------------------------
// TRỤ CỘT 2: KDS BATCH SUMMARY VIEW & EXPO / PASS SCREEN AGGREGATORS
// -----------------------------------------------------------------------------
function formatModifierTag(item) {
    const parts = [];
    if (Array.isArray(item.modifiersSnapshot) && item.modifiersSnapshot.length > 0) {
        for (const m of item.modifiersSnapshot) {
            const label = m.tenInNgan || m.tenOption || '';
            if (label) parts.push(m.soLuong > 1 ? `${label} x${m.soLuong}` : label);
        }
    }
    if (Array.isArray(item.toppings) && item.toppings.length > 0) {
        for (const tp of item.toppings) {
            if (tp?.tenTopping) {
                const perCup = Number(tp.soLuongMoiLy || 1);
                parts.push(perCup > 1 ? `+${tp.tenTopping} x${perCup}` : `+${tp.tenTopping}`);
            }
        }
    }
    if (item.ghiChu) parts.push(String(item.ghiChu).trim());
    return parts.length > 0 ? parts.join(', ') : 'Tiêu chuẩn';
}

function buildBatchSummary(items = []) {
    const groups = new Map();
    // Sắp xếp FIFO theo ưu tiên (Remake/Rush lên đầu) rồi theo thời gian gọi cũ nhất trước
    const sorted = [...items].sort((a, b) => {
        const pa = Number(a.mucDoUuTien || 0);
        const pb = Number(b.mucDoUuTien || 0);
        if (pb !== pa) return pb - pa;
        return new Date(a.firedAt || a.thoiGianGoi || 0).getTime() - new Date(b.firedAt || b.thoiGianGoi || 0).getTime();
    });

    for (const item of sorted) {
        if (!['ChoPhaChe', 'DangLam'].includes(item.trangThaiPhaChe)) continue;
        const key = `${item.maMon}|${item.kichThuoc || 'M'}`;
        if (!groups.has(key)) {
            groups.set(key, {
                batchKey: key,
                maMon: item.maMon,
                tenMon: item.tenMon,
                kichThuoc: item.kichThuoc || 'M',
                tramCheBien: item.tramCheBien || 'BAR_CHINH',
                totalQty: 0,
                choPhaCheQty: 0,
                dangLamQty: 0,
                hasRemakeOrRush: false,
                oldestTime: item.firedAt || item.thoiGianGoi || null,
                modifierBreakdown: new Map(),
                fifoItems: [],
            });
        }
        const g = groups.get(key);
        const qty = Number(item.soLuong || 1);
        g.totalQty += qty;
        if (item.trangThaiPhaChe === 'ChoPhaChe') g.choPhaCheQty += qty;
        if (item.trangThaiPhaChe === 'DangLam') g.dangLamQty += qty;
        if (Number(item.mucDoUuTien || 0) > 0 || item.remakeOfCTHD) g.hasRemakeOrRush = true;

        const modTag = formatModifierTag(item);
        g.modifierBreakdown.set(modTag, (g.modifierBreakdown.get(modTag) || 0) + qty);
        g.fifoItems.push({
            maCTHD: item.maCTHD,
            maHoaDon: item.maHoaDon,
            soThuTuHienThi: item.soThuTuHienThi,
            tenBan: item.tenBan,
            mangDi: item.mangDi,
            soLuong: qty,
            trangThaiPhaChe: item.trangThaiPhaChe,
            mucDoUuTien: Number(item.mucDoUuTien || 0),
            remakeOfCTHD: item.remakeOfCTHD || null,
            modTag,
            thoiGianGoi: item.firedAt || item.thoiGianGoi,
        });
    }

    return [...groups.values()]
        .map((g) => ({
            batchKey: g.batchKey,
            maMon: g.maMon,
            tenMon: g.tenMon,
            kichThuoc: g.kichThuoc,
            tramCheBien: g.tramCheBien,
            totalQty: g.totalQty,
            choPhaCheQty: g.choPhaCheQty,
            dangLamQty: g.dangLamQty,
            hasRemakeOrRush: g.hasRemakeOrRush,
            oldestTime: g.oldestTime,
            modifierBreakdown: [...g.modifierBreakdown.entries()].map(([label, qty]) => ({ label, qty })),
            fifoItems: g.fifoItems,
        }))
        .sort((a, b) => {
            if (b.hasRemakeOrRush !== a.hasRemakeOrRush) return b.hasRemakeOrRush ? 1 : -1;
            if (b.totalQty !== a.totalQty) return b.totalQty - a.totalQty;
            return new Date(a.oldestTime || 0).getTime() - new Date(b.oldestTime || 0).getTime();
        });
}

function buildExpoTickets(items = []) {
    const map = new Map();
    for (const item of items) {
        if (item.trangThaiPhaChe === 'DaHuy') continue;
        const dotGoi = Number(item.dotGoi || 1);
        const key = `${item.maHoaDon}|${dotGoi}`;
        if (!map.has(key)) {
            map.set(key, {
                ticketKey: key,
                maHoaDon: item.maHoaDon,
                dotGoi,
                soThuTuNgay: item.soThuTuNgay,
                soThuTuHienThi: item.soThuTuHienThi,
                soTheRung: item.soTheRung,
                tenKhachVangLai: item.tenKhachVangLai,
                loaiDonHang: item.loaiDonHang,
                maBan: item.maBan,
                tenBan: item.tenBan,
                mangDi: item.mangDi,
                clientOrderUid: item.clientOrderUid || null,
                oldestTime: item.firedAt || item.thoiGianGoi,
                maxPriority: Number(item.mucDoUuTien || 0),
                stationsMap: new Map(),
                items: [],
            });
        }
        const t = map.get(key);
        const st = item.tramCheBien || 'BAR_CHINH';
        if (!t.stationsMap.has(st)) {
            t.stationsMap.set(st, { station: st, total: 0, done: 0, served: 0, inProgress: 0, pending: 0 });
        }
        const stStat = t.stationsMap.get(st);
        stStat.total += 1;
        if (item.trangThaiPhaChe === 'DaPhucVu') {
            stStat.done += 1;
            stStat.served += 1;
        } else if (item.trangThaiPhaChe === 'DaXong') {
            stStat.done += 1;
        } else if (item.trangThaiPhaChe === 'DangLam') {
            stStat.inProgress += 1;
        } else {
            stStat.pending += 1;
        }
        if (Number(item.mucDoUuTien || 0) > t.maxPriority) t.maxPriority = Number(item.mucDoUuTien || 0);
        const itemMs = new Date(item.firedAt || item.thoiGianGoi || 0).getTime();
        if (itemMs && itemMs < new Date(t.oldestTime || 0).getTime()) t.oldestTime = item.firedAt || item.thoiGianGoi;
        t.items.push(item);
    }

    const tickets = [];
    for (const t of map.values()) {
        const stations = [...t.stationsMap.values()].map((s) => ({
            ...s,
            ready: s.total > 0 && s.done === s.total,
        }));
        const totalItems = t.items.length;
        const doneItems = t.items.filter((i) => i.trangThaiPhaChe === 'DaXong' || i.trangThaiPhaChe === 'DaPhucVu').length;
        const servedItems = t.items.filter((i) => i.trangThaiPhaChe === 'DaPhucVu').length;
        // Chỉ hiển thị trên Expo những đơn chưa phục vụ hết 100%
        if (servedItems === totalItems && totalItems > 0) continue;
        tickets.push({
            ticketKey: t.ticketKey,
            maHoaDon: t.maHoaDon,
            dotGoi: t.dotGoi,
            soThuTuNgay: t.soThuTuNgay,
            soThuTuHienThi: t.soThuTuHienThi,
            soTheRung: t.soTheRung,
            tenKhachVangLai: t.tenKhachVangLai,
            loaiDonHang: t.loaiDonHang,
            maBan: t.maBan,
            tenBan: t.tenBan,
            mangDi: t.mangDi,
            clientOrderUid: t.clientOrderUid,
            oldestTime: t.oldestTime,
            maxPriority: t.maxPriority,
            totalItems,
            doneItems,
            allStationsReady: stations.length > 0 && stations.every((s) => s.ready),
            stations,
            items: t.items,
        });
    }

    return tickets.sort((a, b) => {
        if (b.allStationsReady !== a.allStationsReady) return b.allStationsReady ? 1 : -1;
        if (b.maxPriority !== a.maxPriority) return b.maxPriority - a.maxPriority;
        return new Date(a.oldestTime || 0).getTime() - new Date(b.oldestTime || 0).getTime();
    });
}

// -----------------------------------------------------------------------------
// TRỤ CỘT 5: ĐỘNG CƠ 86'ING TOÀN DIỆN 5 LỚP (ĐỆ QUY SUB-RECIPE) & AUTO UN-86
//   Lớp 1: Nguyên liệu & Bán thành phẩm đệ quy (BanThanhPham_CongThuc)
//   Lớp 2: Món (SanPham via CongThuc)
//   Lớp 3: Topping (Topping.MaNL + Topping_CongThuc)
//   Lớp 4: Modifier Option (modifier_option_bom với khoiluongdelta > 0)
//   Lớp 5: Combo (combo_slots + combo_slot_items -> khóa khi 1 slot hết sạch món chọn)
// -----------------------------------------------------------------------------
async function cascadeIngredient86(client, { tenantId = 'DEFAULT', maNL, action = 'LOCK' }) {
    const tId = String(tenantId || 'DEFAULT');
    const act = String(action || 'LOCK').toUpperCase() === 'UNLOCK' ? 'UNLOCK' : 'LOCK';

    // Bước 1: Duyệt đệ quy đồ thị Bán thành phẩm (chỉ lan truyền qua BTP có SoLuongTon <= 0 khi LOCK!)
    let affectedIngredients = [maNL];
    await client.query('SAVEPOINT sp_86_recursive');
    try {
        const recRes = await client.query(
            `WITH RECURSIVE affected_nl(manl) AS (
                 SELECT $1::varchar
                 UNION
                 SELECT b.manlthanhpham
                   FROM public.banthanhpham_congthuc b
                   JOIN affected_nl a ON a.manl = b.manlthanhphan
                   JOIN public.nguyenlieu nl_tp ON nl_tp.manl = b.manlthanhpham
                    AND COALESCE(nl_tp.tenantid, 'DEFAULT') = $2
                  WHERE b.tenantid = $2
                    AND ($3::text = 'UNLOCK' OR COALESCE(nl_tp.soluongton, 0) <= 0)
             )
             SELECT DISTINCT manl FROM affected_nl`,
            [maNL, tId, act]
        );
        if (recRes.rows.length > 0) {
            affectedIngredients = recRes.rows.map((r) => r.manl);
        }
        await client.query('RELEASE SAVEPOINT sp_86_recursive');
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_86_recursive').catch(() => {});
        affectedIngredients = [maNL];
    }

    const cascadedSubRecipes = affectedIngredients.filter((code) => code !== maNL);

    let affectedProducts = [];
    let affectedToppings = [];
    let affectedModifiers = [];
    let affectedCombos = [];

    if (act === 'LOCK') {
        // Lớp 2: SanPham
        const spRes = await client.query(
            `UPDATE public.sanpham
                SET tamhettudong = CASE WHEN COALESCE(tamhet, FALSE) = FALSE OR COALESCE(tamhettudong, FALSE) = TRUE THEN TRUE ELSE FALSE END,
                    tamhet = TRUE,
                    tamhetboimanl = (
                        SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tamhetboimanl, '{}'::text[]) || $1::text[]))
                    )
              WHERE COALESCE(tenantid, 'DEFAULT') = $2
                AND mamon IN (
                    SELECT DISTINCT ct.mamon
                      FROM public.congthuc ct
                     WHERE ct.manl::text = ANY($1::text[])
                )
              RETURNING mamon, tenmon, tamhet, tamhettudong, tamhetboimanl`,
            [affectedIngredients, tId]
        );
        affectedProducts = spRes.rows.map((r) => ({
            maMon: r.mamon,
            tenMon: r.tenmon,
            tamHet: Boolean(r.tamhet),
            tamHetTuDong: Boolean(r.tamhettudong),
            tamHetBoiMaNL: r.tamhetboimanl || [],
        }));

        // Lớp 3: Topping
        await client.query('SAVEPOINT sp_86_tp_lock');
        try {
            const tpRes = await client.query(
                `UPDATE public.topping
                    SET tamhettudong = CASE WHEN COALESCE(tamhet, FALSE) = FALSE OR COALESCE(tamhettudong, FALSE) = TRUE THEN TRUE ELSE FALSE END,
                        tamhet = TRUE,
                        tamhetboimanl = (
                            SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tamhetboimanl, '{}'::text[]) || $1::text[]))
                        )
                  WHERE COALESCE(tenantid, 'DEFAULT') = $2
                    AND (
                        manl::text = ANY($1::text[])
                        OR matopping IN (
                            SELECT DISTINCT matopping FROM public.topping_congthuc
                             WHERE tenantid = $2 AND manl::text = ANY($1::text[])
                        )
                    )
                  RETURNING matopping, tentopping, tamhet, tamhettudong, tamhetboimanl`,
                [affectedIngredients, tId]
            );
            affectedToppings = tpRes.rows.map((r) => ({
                maTopping: r.matopping,
                tenTopping: r.tentopping,
                tamHet: Boolean(r.tamhet),
                tamHetTuDong: Boolean(r.tamhettudong),
                tamHetBoiMaNL: r.tamhetboimanl || [],
            }));
            await client.query('RELEASE SAVEPOINT sp_86_tp_lock');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_86_tp_lock').catch(() => {});
        }

        // Lớp 4: Modifier Options (chỉ những option cộng thêm/thay thế dùng nguyên liệu này: khoiluongdelta > 0)
        await client.query('SAVEPOINT sp_86_mod_lock');
        try {
            const modRes = await client.query(
                `UPDATE public.modifier_options
                    SET tamhettudong = CASE WHEN COALESCE(tamhet, FALSE) = FALSE OR COALESCE(tamhettudong, FALSE) = TRUE THEN TRUE ELSE FALSE END,
                        tamhet = TRUE,
                        tamhetboimanl = (
                            SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tamhetboimanl, '{}'::text[]) || $1::text[]))
                        )
                  WHERE tenantid = $2
                    AND id IN (
                        SELECT DISTINCT optionid FROM public.modifier_option_bom
                         WHERE tenantid = $2
                           AND manl::text = ANY($1::text[])
                           AND khoiluongdelta > 0
                    )
                  RETURNING id, groupid, tenoption, tamhet, tamhettudong, tamhetboimanl`,
                [affectedIngredients, tId]
            );
            affectedModifiers = modRes.rows.map((r) => ({
                optionId: Number(r.id),
                groupId: Number(r.groupid),
                tenOption: r.tenoption,
                tamHet: Boolean(r.tamhet),
                tamHetTuDong: Boolean(r.tamhettudong),
            }));
            await client.query('RELEASE SAVEPOINT sp_86_mod_lock');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_86_mod_lock').catch(() => {});
        }

        // Lớp 5: Combo (khóa Combo nếu bất kỳ slot nào không còn món khả dụng nào)
        await client.query('SAVEPOINT sp_86_cmb_lock');
        try {
            const cmbRes = await client.query(
                `UPDATE public.combo c
                    SET tamhettudong = CASE WHEN COALESCE(c.tamhet, FALSE) = FALSE OR COALESCE(c.tamhettudong, FALSE) = TRUE THEN TRUE ELSE FALSE END,
                        tamhet = TRUE,
                        tamhetboimanl = (
                            SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(c.tamhetboimanl, '{}'::text[]) || $1::text[]))
                        )
                  WHERE c.tenantid = $2
                    AND c.dangkinhdoanh = TRUE
                    AND EXISTS (
                        SELECT 1
                          FROM public.combo_slots cs
                         WHERE cs.tenantid = $2
                           AND cs.macombo = c.macombo
                           AND NOT EXISTS (
                               SELECT 1
                                 FROM public.combo_slot_items csi
                                 JOIN public.sanpham sp ON sp.mamon = csi.mamon
                                  AND COALESCE(sp.tenantid, 'DEFAULT') = $2
                                WHERE csi.slotid = cs.id
                                  AND sp.dangkinhdoanh = TRUE
                                  AND COALESCE(sp.tamhet, FALSE) = FALSE
                           )
                    )
                  RETURNING c.macombo, c.tencombo, c.tamhet, c.tamhettudong`,
                [affectedIngredients, tId]
            );
            affectedCombos = cmbRes.rows.map((r) => ({
                maCombo: r.macombo,
                tenCombo: r.tencombo,
                tamHet: Boolean(r.tamhet),
                tamHetTuDong: Boolean(r.tamhettudong),
            }));
            await client.query('RELEASE SAVEPOINT sp_86_cmb_lock');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_86_cmb_lock').catch(() => {});
        }
    } else {
        // UNLOCK thông minh: gỡ danh sách affectedIngredients khỏi tamhetboimanl;
        // CHỈ tự mở khóa (tamhet = FALSE) nếu tamhettudong = TRUE và mảng nguyên nhân trống (cardinality = 0)
        // Bảo toàn 100% các món quản lý khóa tay (tamhettudong = FALSE)!
        const spRes = await client.query(
            `WITH cleaned AS (
                 SELECT mamon,
                        ARRAY(
                            SELECT elem FROM unnest(COALESCE(tamhetboimanl, '{}'::text[])) AS elem
                             WHERE NOT (elem = ANY($1::text[]))
                        ) AS remaining_nl
                   FROM public.sanpham
                  WHERE COALESCE(tenantid, 'DEFAULT') = $2
                    AND (
                        tamhetboimanl && $1::text[]
                        OR (tamhet = TRUE AND mamon IN (SELECT DISTINCT mamon FROM public.congthuc WHERE manl::text = ANY($1::text[])))
                    )
             )
             UPDATE public.sanpham sp
                SET tamhetboimanl = c.remaining_nl,
                    tamhet = CASE
                        WHEN COALESCE(sp.tamhettudong, FALSE) = TRUE AND COALESCE(cardinality(c.remaining_nl), 0) = 0 THEN FALSE
                        ELSE sp.tamhet
                    END,
                    tamhettudong = CASE
                        WHEN COALESCE(sp.tamhettudong, FALSE) = TRUE AND COALESCE(cardinality(c.remaining_nl), 0) = 0 THEN FALSE
                        ELSE sp.tamhettudong
                    END
               FROM cleaned c
              WHERE sp.mamon = c.mamon
              RETURNING sp.mamon, sp.tenmon, sp.tamhet, sp.tamhettudong, sp.tamhetboimanl`,
            [affectedIngredients, tId]
        );
        affectedProducts = spRes.rows.map((r) => ({
            maMon: r.mamon,
            tenMon: r.tenmon,
            tamHet: Boolean(r.tamhet),
            tamHetTuDong: Boolean(r.tamhettudong),
            tamHetBoiMaNL: r.tamhetboimanl || [],
        }));

        await client.query('SAVEPOINT sp_86_tp_unlock');
        try {
            const tpRes = await client.query(
                `WITH cleaned AS (
                     SELECT matopping,
                            ARRAY(
                                SELECT elem FROM unnest(COALESCE(tamhetboimanl, '{}'::text[])) AS elem
                                 WHERE NOT (elem = ANY($1::text[]))
                            ) AS remaining_nl
                       FROM public.topping
                      WHERE COALESCE(tenantid, 'DEFAULT') = $2
                        AND (
                            tamhetboimanl && $1::text[]
                            OR manl::text = ANY($1::text[])
                            OR matopping IN (SELECT DISTINCT matopping FROM public.topping_congthuc WHERE tenantid = $2 AND manl::text = ANY($1::text[]))
                        )
                 )
                 UPDATE public.topping tp
                    SET tamhetboimanl = c.remaining_nl,
                        tamhet = CASE
                            WHEN COALESCE(tp.tamhettudong, FALSE) = TRUE AND COALESCE(cardinality(c.remaining_nl), 0) = 0 THEN FALSE
                            ELSE tp.tamhet
                        END,
                        tamhettudong = CASE
                            WHEN COALESCE(tp.tamhettudong, FALSE) = TRUE AND COALESCE(cardinality(c.remaining_nl), 0) = 0 THEN FALSE
                            ELSE tp.tamhettudong
                        END
                   FROM cleaned c
                  WHERE tp.matopping = c.matopping
                  RETURNING tp.matopping, tp.tentopping, tp.tamhet, tp.tamhettudong`,
                [affectedIngredients, tId]
            );
            affectedToppings = tpRes.rows.map((r) => ({
                maTopping: r.matopping,
                tenTopping: r.tentopping,
                tamHet: Boolean(r.tamhet),
                tamHetTuDong: Boolean(r.tamhettudong),
            }));
            await client.query('RELEASE SAVEPOINT sp_86_tp_unlock');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_86_tp_unlock').catch(() => {});
        }

        await client.query('SAVEPOINT sp_86_mod_unlock');
        try {
            const modRes = await client.query(
                `WITH cleaned AS (
                     SELECT id,
                            ARRAY(
                                SELECT elem FROM unnest(COALESCE(tamhetboimanl, '{}'::text[])) AS elem
                                 WHERE NOT (elem = ANY($1::text[]))
                            ) AS remaining_nl
                       FROM public.modifier_options
                      WHERE tenantid = $2
                        AND (
                            tamhetboimanl && $1::text[]
                            OR id IN (SELECT DISTINCT optionid FROM public.modifier_option_bom WHERE tenantid = $2 AND manl::text = ANY($1::text[]) AND khoiluongdelta > 0)
                        )
                 )
                 UPDATE public.modifier_options mo
                    SET tamhetboimanl = c.remaining_nl,
                        tamhet = CASE
                            WHEN COALESCE(mo.tamhettudong, FALSE) = TRUE AND COALESCE(cardinality(c.remaining_nl), 0) = 0 THEN FALSE
                            ELSE mo.tamhet
                        END,
                        tamhettudong = CASE
                            WHEN COALESCE(mo.tamhettudong, FALSE) = TRUE AND COALESCE(cardinality(c.remaining_nl), 0) = 0 THEN FALSE
                            ELSE mo.tamhettudong
                        END
                   FROM cleaned c
                  WHERE mo.id = c.id
                  RETURNING mo.id, mo.groupid, mo.tenoption, mo.tamhet, mo.tamhettudong`,
                [affectedIngredients, tId]
            );
            affectedModifiers = modRes.rows.map((r) => ({
                optionId: Number(r.id),
                groupId: Number(r.groupid),
                tenOption: r.tenoption,
                tamHet: Boolean(r.tamhet),
                tamHetTuDong: Boolean(r.tamhettudong),
            }));
            await client.query('RELEASE SAVEPOINT sp_86_mod_unlock');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_86_mod_unlock').catch(() => {});
        }

        await client.query('SAVEPOINT sp_86_cmb_unlock');
        try {
            const cmbRes = await client.query(
                `UPDATE public.combo c
                    SET tamhet = FALSE,
                        tamhettudong = FALSE,
                        tamhetboimanl = '{}'::text[]
                  WHERE c.tenantid = $1
                    AND COALESCE(c.tamhet, FALSE) = TRUE
                    AND COALESCE(c.tamhettudong, FALSE) = TRUE
                    AND NOT EXISTS (
                        SELECT 1
                          FROM public.combo_slots cs
                         WHERE cs.tenantid = $1
                           AND cs.macombo = c.macombo
                           AND NOT EXISTS (
                               SELECT 1
                                 FROM public.combo_slot_items csi
                                 JOIN public.sanpham sp ON sp.mamon = csi.mamon
                                  AND COALESCE(sp.tenantid, 'DEFAULT') = $1
                                WHERE csi.slotid = cs.id
                                  AND sp.dangkinhdoanh = TRUE
                                  AND COALESCE(sp.tamhet, FALSE) = FALSE
                           )
                    )
                  RETURNING c.macombo, c.tencombo, c.tamhet, c.tamhettudong`,
                [tId]
            );
            affectedCombos = cmbRes.rows.map((r) => ({
                maCombo: r.macombo,
                tenCombo: r.tencombo,
                tamHet: Boolean(r.tamhet),
                tamHetTuDong: Boolean(r.tamhettudong),
            }));
            await client.query('RELEASE SAVEPOINT sp_86_cmb_unlock');
        } catch {
            await client.query('ROLLBACK TO SAVEPOINT sp_86_cmb_unlock').catch(() => {});
        }
    }

    return {
        maNL,
        action: act,
        affectedIngredients,
        cascadedSubRecipes,
        affectedProducts,
        affectedToppings,
        affectedModifiers,
        affectedCombos,
    };
}

async function autoUn86OnRestock(client, { tenantId = 'DEFAULT', maNLList = [] }) {
    const cleanList = [...new Set((maNLList || []).filter(Boolean))];
    if (cleanList.length === 0) {
        return { unlockedProducts: [], unlockedToppings: [], unlockedModifiers: [], unlockedCombos: [] };
    }

    // Chỉ mở khóa cho những nguyên liệu hiện có SoLuongTon > 0
    const nlRes = await client.query(
        `SELECT manl FROM public.nguyenlieu
          WHERE COALESCE(tenantid, 'DEFAULT') = $1
            AND manl = ANY($2::varchar[])
            AND COALESCE(soluongton, 0) > 0`,
        [String(tenantId || 'DEFAULT'), cleanList]
    );
    const availableNLs = nlRes.rows.map((r) => r.manl);

    const unlockedProductsMap = new Map();
    const unlockedToppingsMap = new Map();
    const unlockedModifiersMap = new Map();
    const unlockedCombosMap = new Map();

    for (const maNL of availableNLs) {
        const res = await cascadeIngredient86(client, { tenantId, maNL, action: 'UNLOCK' });
        for (const p of res.affectedProducts) {
            if (!p.tamHet) unlockedProductsMap.set(p.maMon, p);
        }
        for (const t of res.affectedToppings) {
            if (!t.tamHet) unlockedToppingsMap.set(t.maTopping, t);
        }
        for (const m of res.affectedModifiers) {
            if (!m.tamHet) unlockedModifiersMap.set(m.optionId, m);
        }
        for (const c of res.affectedCombos) {
            if (!c.tamHet) unlockedCombosMap.set(c.maCombo, c);
        }
    }

    return {
        unlockedProducts: [...unlockedProductsMap.values()],
        unlockedToppings: [...unlockedToppingsMap.values()],
        unlockedModifiers: [...unlockedModifiersMap.values()],
        unlockedCombos: [...unlockedCombosMap.values()],
    };
}

// -----------------------------------------------------------------------------
// TRỤ CỘT 6: ĐO LƯỜNG NÚT THẮT PHA CHẾ KDS (3 MỐC THỜI GIAN)
//   - Chờ pha (Queue Wait):    ThoiGianBatDauLam - COALESCE(FiredAt, ThoiGianGoi)
//   - Thời gian pha (Prep):    ThoiGianXong - ThoiGianBatDauLam
//   - Chờ bưng (Pickup Delay): ThoiGianPhucVu - ThoiGianXong
// -----------------------------------------------------------------------------
function avg(arr) {
    if (!arr.length) return 0;
    return Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10;
}

function p95(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.floor(s.length * 0.95));
    return Math.round(s[idx] * 10) / 10;
}

function computeKdsBottleneckTelemetry(rows = []) {
    const byStation = new Map();
    const allQueue = [];
    const allPrep = [];
    const allPickup = [];
    let remakeCount = 0;

    for (const r of rows) {
        const st = r.tramCheBien || 'BAR_CHINH';
        if (!byStation.has(st)) {
            byStation.set(st, { station: st, totalItems: 0, remakeCount: 0, queue: [], prep: [], pickup: [] });
        }
        const bucket = byStation.get(st);
        bucket.totalItems += 1;
        if (r.remakeOfCTHD) {
            bucket.remakeCount += 1;
            remakeCount += 1;
        }

        const tOrder = r.firedAt || r.thoiGianGoi ? new Date(r.firedAt || r.thoiGianGoi).getTime() : null;
        const tStart = r.thoiGianBatDauLam ? new Date(r.thoiGianBatDauLam).getTime() : null;
        const tDone = r.thoiGianXong ? new Date(r.thoiGianXong).getTime() : null;
        const tServed = r.thoiGianPhucVu ? new Date(r.thoiGianPhucVu).getTime() : null;

        if (tOrder && tStart && tStart >= tOrder) {
            const sec = (tStart - tOrder) / 1000;
            bucket.queue.push(sec);
            allQueue.push(sec);
        }
        if (tStart && tDone && tDone >= tStart) {
            const sec = (tDone - tStart) / 1000;
            bucket.prep.push(sec);
            allPrep.push(sec);
        } else if (!tStart && tOrder && tDone && tDone >= tOrder) {
            const sec = (tDone - tOrder) / 1000;
            bucket.prep.push(sec);
            allPrep.push(sec);
        }
        if (tDone && tServed && tServed >= tDone) {
            const sec = (tServed - tDone) / 1000;
            bucket.pickup.push(sec);
            allPickup.push(sec);
        }
    }

    const stations = [...byStation.values()].map((b) => {
        const avgQueueWaitSec = avg(b.queue);
        const avgActivePrepSec = avg(b.prep);
        const avgPickupDelaySec = avg(b.pickup);
        return {
            station: b.station,
            totalItems: b.totalItems,
            remakeCount: b.remakeCount,
            avgQueueWaitSec,
            p95QueueWaitSec: p95(b.queue),
            avgActivePrepSec,
            p95ActivePrepSec: p95(b.prep),
            avgPickupDelaySec,
            p95PickupDelaySec: p95(b.pickup),
            avgTotalSec: Math.round((avgQueueWaitSec + avgActivePrepSec + avgPickupDelaySec) * 10) / 10,
        };
    });

    stations.sort((a, b) => b.avgTotalSec - a.avgTotalSec);

    return {
        overall: {
            totalItems: rows.length,
            remakeCount,
            avgQueueWaitSec: avg(allQueue),
            avgActivePrepSec: avg(allPrep),
            avgPickupDelaySec: avg(allPickup),
            bottleneckStation: stations[0]?.station || null,
        },
        stations,
    };
}

module.exports = {
    VALID_STATIONS,
    normalizeBranchId,
    normalizeStation,
    roomBranchPos,
    roomBranchKds,
    roomBranchExpo,
    roomBranchWaiter,
    roomBranchQr,
    insertKdsEventLog,
    emitScopedKdsEvent,
    recordAndEmitOrderNewByStation,
    acquireIdempotencyLock,
    completeIdempotencyLock,
    failIdempotencyLock,
    buildBatchSummary,
    buildExpoTickets,
    cascadeIngredient86,
    autoUn86OnRestock,
    computeKdsBottleneckTelemetry,
};
