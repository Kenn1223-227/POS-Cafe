/**
 * =============================================================================
 * PHÂN HỆ 4 (81 -> 100/100): INVENTORY SINGLE-SOURCE, SAFE WAC + LANDED COST,
 * FEFO BATCHES, 5-LAYER BOM + DAG CYCLE CHECK, BLIND STOCKTAKE, SHIFT AvT & PO
 * =============================================================================
 */
const crypto = require('crypto');

const WASTAGE_TAXONOMY = {
    MACHINE_CALIBRATION: 'Hiệu chỉnh cối xay / test shot đầu ca',
    EXPIRED_BATCH: 'Hủy bán thành phẩm / nguyên liệu quá HSD',
    BARISTA_SPILL: 'Đổ vỡ / đánh sữa hỏng trong quầy',
    CUSTOMER_REMAKE: 'Pha lại / hủy món đã pha theo yêu cầu khách',
    DAMAGED_DELIVERY: 'Hỏng vận chuyển / thiếu hụt khi giao nhận',
    STAFF_DRINK: 'Đồ uống nội bộ nhân viên trong ca',
};

const VALID_WASTAGE_CODES = Object.keys(WASTAGE_TAXONOMY);

const lam3 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 1000) / 1000;
const lam4 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 10000) / 10000;
const lam2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

function normalizeInventoryBranch(tenantId = 'DEFAULT', branchId = null) {
    const tId = String(tenantId || 'DEFAULT').trim() || 'DEFAULT';
    const raw = String(branchId || '').trim();
    if (!raw || raw.toUpperCase() === 'DEFAULT') return `${tId}_MAIN`;
    return raw.slice(0, 64);
}

function isMainBranch(tenantId = 'DEFAULT', branchId = null) {
    const tId = String(tenantId || 'DEFAULT').trim() || 'DEFAULT';
    return normalizeInventoryBranch(tId, branchId) === `${tId}_MAIN`;
}

function todayDateVN() {
    return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
}

/**
 * Đảm bảo Chi nhánh tồn tại trong bảng public.chinhanh trước khi ghi TonKhoChiNhanh
 * (Tự động tạo ${tenantId}_MAIN nếu Tenant mới đăng ký chưa có dòng ChiNhanh)
 */
async function ensureBranchRecord(client, tenantId = 'DEFAULT', branchId = null) {
    const tId = String(tenantId || 'DEFAULT');
    const bId = normalizeInventoryBranch(tId, branchId);
    if (bId === `${tId}_MAIN`) {
        await client.query(
            `INSERT INTO public.chinhanh (branchid, tenantid, machinhanh, tenchinhanh, khuvucgia, lakhotong, tylephinhuongquyen)
             VALUES ($1::varchar, $2::varchar, 'CN01', 'Cơ sở 1 (Kho tổng)', 'DEFAULT', TRUE, 0)
             ON CONFLICT (branchid) DO NOTHING`,
            [bId, tId]
        );
    }
    return bId;
}

/**
 * Tính WAC an toàn tuyệt đối khi tồn kho âm, hỗ trợ phân bổ Landed Cost (cước ship/VAT)
 * và trả về khoản điều chỉnh COGS (cogsAdjustment) cho phần hàng đã bán lúc âm kho.
 */
function computeSafeWacOnStockIn({
    tonCu,
    giaVonCu,
    slNhapBase,
    tongTienHang,
    chiPhiPhanBo = 0,
}) {
    const qty = Number(slNhapBase || 0);
    const oldStock = Number(tonCu || 0);
    const oldCost = Number(giaVonCu || 0);
    const goodsTotal = Number(tongTienHang || 0);
    const landed = Number(chiPhiPhanBo || 0);

    if (!(qty > 0)) {
        return { giaVonMoi: lam4(oldCost), donGiaNhapThucTe: 0, cogsAdjustment: 0 };
    }
    const donGiaNhapThucTeRaw = Math.max(0, (goodsTotal + landed) / qty);
    const donGiaNhapThucTe = lam4(donGiaNhapThucTeRaw);

    if (oldStock < 0) {
        const slBuAm = Math.min(Math.abs(oldStock), qty);
        const cogsAdjustment = lam2(slBuAm * (donGiaNhapThucTeRaw - oldCost));
        return {
            giaVonMoi: donGiaNhapThucTe,
            donGiaNhapThucTe,
            cogsAdjustment,
        };
    }

    if (oldStock === 0) {
        return {
            giaVonMoi: donGiaNhapThucTe,
            donGiaNhapThucTe,
            cogsAdjustment: 0,
        };
    }

    const nextWac = (oldStock * oldCost + qty * donGiaNhapThucTeRaw) / (oldStock + qty);
    return {
        giaVonMoi: lam4(nextWac),
        donGiaNhapThucTe,
        cogsAdjustment: 0,
    };
}

/**
 * Phân bổ chi phí vận chuyển / giảm giá NCC (Landed Cost) theo tỷ trọng tiền hàng từng dòng.
 * Dòng cuối gánh phần làm tròn dư để tổng phân bổ khớp tuyệt đối 0đ sai số.
 */
function allocateLandedCost(itemsWithTotal, chiPhiVanChuyen = 0, giamGiaNCC = 0) {
    const netLanded = lam2(Number(chiPhiVanChuyen || 0) - Number(giamGiaNCC || 0));
    if (!Array.isArray(itemsWithTotal) || itemsWithTotal.length === 0 || netLanded === 0) {
        return itemsWithTotal.map(() => 0);
    }
    const sumGoods = itemsWithTotal.reduce((s, it) => s + Math.max(0, Number(it.tongTienHang || 0)), 0);
    const alloc = [];
    let allocated = 0;
    for (let i = 0; i < itemsWithTotal.length; i++) {
        if (i === itemsWithTotal.length - 1) {
            alloc.push(lam2(netLanded - allocated));
        } else {
            const weight =
                sumGoods > 0
                    ? Math.max(0, Number(itemsWithTotal[i].tongTienHang || 0)) / sumGoods
                    : 1 / itemsWithTotal.length;
            const part = lam2(netLanded * weight);
            alloc.push(part);
            allocated = lam2(allocated + part);
        }
    }
    return alloc;
}

/**
 * Khóa tồn kho chi nhánh theo thứ tự ORDER BY MaNL ASC FOR UPDATE -> 0% Deadlock (40P01).
 * Tự động khởi tạo dòng TonKhoChiNhanh nếu chưa có:
 *   - Chi nhánh chính (${tenantId}_MAIN): kế thừa tồn & WAC từ NguyenLieu (tương thích ngược tuyệt đối).
 *   - Chi nhánh phụ: khởi tạo SoLuongTon = 0 (cô lập tuyệt đối, không bao giờ lấy nhầm tồn Chi nhánh 1!),
 *     GiaVonDonVi tham chiếu từ NguyenLieu.
 */
async function lockBranchStockOrdered(client, tenantId = 'DEFAULT', branchId = null, maNLList = []) {
    const tId = String(tenantId || 'DEFAULT');
    const bId = await ensureBranchRecord(client, tId, branchId);
    const sortedIds = [...new Set((maNLList || []).map((x) => String(x || '').trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
    );
    if (sortedIds.length === 0) return { branchId: bId, stockMap: new Map() };

    const mainBr = isMainBranch(tId, bId);

    // Chèn dòng còn thiếu theo thứ tự ASC để tránh deadlock khi 2 transaction khởi tạo cùng lúc
    await client.query(
        `INSERT INTO public.tonkhochinhanh (tenantid, branchid, manl, soluongton, hanmuccanhbao, giavondonvi)
         SELECT $1::text,
                $2::text,
                nl.manl,
                CASE WHEN $4::boolean THEN COALESCE(nl.soluongton, 0) ELSE 0 END,
                COALESCE(nl.hanmuccanhbao, 0),
                COALESCE(nl.giavondonvi, 0)
           FROM public.nguyenlieu nl
          WHERE COALESCE(nl.tenantid::text, 'DEFAULT') = $1::text
            AND nl.manl = ANY($3::text[])
            AND COALESCE(nl.daxoa, FALSE) = FALSE
          ORDER BY nl.manl ASC
         ON CONFLICT (branchid, manl) DO NOTHING`,
        [tId, bId, sortedIds, mainBr]
    );

    // Khóa cứng dòng tồn kho theo đúng thứ tự ORDER BY tk.manl ASC
    const lockedRes = await client.query(
        `SELECT tk.manl,
                tk.soluongton,
                COALESCE(tk.giavondonvi, 0) AS giavondonvi,
                COALESCE(tk.hanmuccanhbao, 0) AS hanmuccanhbao,
                COALESCE(tk.tondangchuyen, 0) AS tondangchuyen,
                nl.tennl,
                nl.donvitinh,
                COALESCE(nl.theodoihandung, FALSE) AS theodoihandung,
                COALESCE(nl.iskeyitem, FALSE) AS iskeyitem,
                COALESCE(nl.labanthanhpham, FALSE) AS labanthanhpham,
                COALESCE(nl.sanluongmemacdinh, 1000) AS sanluongmemacdinh,
                nl.hansudunggio
           FROM public.tonkhochinhanh tk
           JOIN public.nguyenlieu nl
             ON nl.manl = tk.manl
            AND COALESCE(nl.tenantid::text, 'DEFAULT') = $1::text
          WHERE tk.tenantid = $1::text
            AND tk.branchid = $2::text
            AND tk.manl = ANY($3::text[])
          ORDER BY tk.manl ASC
          FOR UPDATE OF tk`,
        [tId, bId, sortedIds]
    );

    const stockMap = new Map();
    for (const r of lockedRes.rows) {
        stockMap.set(r.manl, {
            maNL: r.manl,
            tenNL: r.tennl,
            donViTinh: r.donvitinh,
            soLuongTon: Number(r.soluongton || 0),
            giaVonDonVi: Number(r.giavondonvi || 0),
            hanMucCanhBao: Number(r.hanmuccanhbao || 0),
            tonDangChuyen: Number(r.tondangchuyen || 0),
            theoDoiHanDung: Boolean(r.theodoihandung),
            isKeyItem: Boolean(r.iskeyitem),
            laBanThanhPham: Boolean(r.labanthanhpham),
            sanLuongMeMacDinh: Number(r.sanluongmemacdinh || 1000),
            hanSuDungGio: r.hansudunggio ? Number(r.hansudunggio) : null,
        });
    }
    return { branchId: bId, stockMap };
}

/**
 * Cập nhật tồn kho & WAC trên Single-Source TonKhoChiNhanh;
 * chỉ mirror về NguyenLieu khi là Chi nhánh chính (${tenantId}_MAIN) để tương thích ngược.
 */
async function updateBranchStockRow(
    client,
    { tenantId = 'DEFAULT', branchId = null, maNL, nextQty, nextWac = null }
) {
    const tId = String(tenantId || 'DEFAULT');
    const bId = normalizeInventoryBranch(tId, branchId);
    const cleanQty = lam3(nextQty);
    const hasWac = nextWac !== null && nextWac !== undefined && Number.isFinite(Number(nextWac));
    const cleanWac = hasWac ? lam4(Number(nextWac)) : null;

    if (hasWac) {
        await client.query(
            `UPDATE public.tonkhochinhanh
                SET soluongton = $4::numeric,
                    giavondonvi = $5::numeric,
                    capnhatluc = now()
              WHERE tenantid = $1::text AND branchid = $2::text AND manl = $3::text`,
            [tId, bId, maNL, cleanQty, cleanWac]
        );
    } else {
        await client.query(
            `UPDATE public.tonkhochinhanh
                SET soluongton = $4::numeric,
                    capnhatluc = now()
              WHERE tenantid = $1::text AND branchid = $2::text AND manl = $3::text`,
            [tId, bId, maNL, cleanQty]
        );
    }

    if (isMainBranch(tId, bId)) {
        if (hasWac) {
            await client.query(
                `UPDATE public.nguyenlieu
                    SET soluongton = $3::numeric,
                        giavondonvi = $4::numeric
                  WHERE manl = $1::text AND COALESCE(tenantid::text, 'DEFAULT') = $2::text`,
                [maNL, tId, cleanQty, cleanWac]
            );
        } else {
            await client.query(
                `UPDATE public.nguyenlieu
                    SET soluongton = $3::numeric
                  WHERE manl = $1::text AND COALESCE(tenantid::text, 'DEFAULT') = $2::text`,
                [maNL, tId, cleanQty]
            );
        }
    }
}

/**
 * Ghi 1 dòng sổ cái bất biến ChiTietGiaoDichKho (có đầy đủ TonTruoc / TonSau / GiaVonTruoc / GiaVonSau / LandedCost)
 */
async function insertLedgerLine(
    client,
    {
        maGiaoDich,
        maNL,
        soLuong,
        donGiaNhap = 0,
        tinhTrang = 'Tốt',
        tonTruoc = null,
        tonSau = null,
        giaVonTruoc = null,
        giaVonSau = null,
        donViNhap = null,
        heSoQuyDoi = 1,
        soLuongTheoDonVi = null,
        chiPhiPhanBo = 0,
    }
) {
    await client.query(
        `INSERT INTO public.chitietgiaodichkho
            (magiaodich, manl, soluong, dongianhap, tinhtrang,
             tontruoc, tonsau, giavontruoc, giavonsau,
             donvinhap, hesoquydoi, soluongtheodonvi, chiphiphanbo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
            maGiaoDich,
            maNL,
            lam3(soLuong),
            lam4(donGiaNhap),
            String(tinhTrang || 'Tốt').slice(0, 255),
            tonTruoc !== null && tonTruoc !== undefined ? lam3(tonTruoc) : null,
            tonSau !== null && tonSau !== undefined ? lam3(tonSau) : null,
            giaVonTruoc !== null && giaVonTruoc !== undefined ? lam4(giaVonTruoc) : null,
            giaVonSau !== null && giaVonSau !== undefined ? lam4(giaVonSau) : null,
            donViNhap ? String(donViNhap).slice(0, 32) : null,
            Number(heSoQuyDoi) > 0 ? lam4(heSoQuyDoi) : 1,
            soLuongTheoDonVi !== null && soLuongTheoDonVi !== undefined ? lam3(soLuongTheoDonVi) : null,
            lam2(chiPhiPhanBo),
        ]
    );
}

/**
 * Kiểm tra Khóa Sổ Kho Định Kỳ (Inventory Period Lock).
 * Chặn mọi giao dịch có ngày chứng từ <= ngaykhoasoden bằng HTTP 403 INVENTORY_PERIOD_LOCKED!
 */
async function assertPeriodNotLocked(client, tenantId = 'DEFAULT', branchId = null, docDateStr = null, LoiNghiepVu) {
    const tId = String(tenantId || 'DEFAULT');
    const bId = normalizeInventoryBranch(tId, branchId);
    const checkDate =
        docDateStr && /^\d{4}-\d{2}-\d{2}$/.test(String(docDateStr).slice(0, 10))
            ? String(docDateStr).slice(0, 10)
            : todayDateVN();

    const r = await client.query(
        `SELECT MAX(ngaykhoasoden)::text AS locked_until
           FROM public.khoaso_kho
          WHERE tenantid = $1::text AND branchid = $2::text`,
        [tId, bId]
    );
    const lockedUntil = r.rows[0]?.locked_until || null;
    if (lockedUntil && checkDate <= lockedUntil) {
        const msg = `Kỳ kế toán kho đến hết ngày ${lockedUntil} đã được khóa sổ! Không thể lập hoặc sửa chứng từ ngày ${checkDate}.`;
        if (LoiNghiepVu) {
            throw new LoiNghiepVu(403, msg, {
                code: 'INVENTORY_PERIOD_LOCKED',
                maLoi: 'INVENTORY_PERIOD_LOCKED',
                lockedUntil,
                docDate: checkDate,
            });
        }
        const err = new Error(msg);
        err.status = 403;
        err.code = 'INVENTORY_PERIOD_LOCKED';
        throw err;
    }
    return checkDate;
}

/**
 * Tạo Lô Tồn Kho (FEFO) khi nhập mua hàng (PURCHASE), nấu Bán thành phẩm (SUBRECIPE) hoặc nhận điều chuyển (TRANSFER)
 */
async function createFefoLot(
    client,
    {
        tenantId = 'DEFAULT',
        branchId = null,
        maNL,
        maLo = null,
        nguonLo = 'PURCHASE',
        maGiaoDichNguon = null,
        soLuong,
        giaVonLo = 0,
        thoiGianHetHan = null,
    }
) {
    const qty = lam3(soLuong);
    if (!(qty > 0)) return null;
    const tId = String(tenantId || 'DEFAULT');
    const bId = normalizeInventoryBranch(tId, branchId);
    const lotCode =
        maLo && String(maLo).trim()
            ? String(maLo).trim().slice(0, 64)
            : `${nguonLo === 'SUBRECIPE' ? 'BTP' : 'LOT'}-${todayDateVN().replace(/-/g, '')}-${crypto
                  .randomBytes(2)
                  .toString('hex')
                  .toUpperCase()}`;

    const r = await client.query(
        `INSERT INTO public.lo_tonkho
            (tenantid, branchid, manl, malo, nguonlo, magiaodichnguon, soluongbandau, soluongconlai, giavonlo, thoigianhethan, trangthai)
         VALUES ($1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::varchar, $6::varchar, $7::numeric, $7::numeric, $8::numeric, $9::timestamptz, 'ACTIVE')
         RETURNING id, malo, soluongbandau, soluongconlai, giavonlo, ngaysanxuat, thoigianhethan, trangthai`,
        [
            tId,
            bId,
            maNL,
            lotCode,
            ['PURCHASE', 'SUBRECIPE', 'TRANSFER'].includes(nguonLo) ? nguonLo : 'PURCHASE',
            maGiaoDichNguon ? String(maGiaoDichNguon) : null,
            qty,
            lam4(giaVonLo),
            thoiGianHetHan || null,
        ]
    );
    return r.rows[0];
}

/**
 * Tiêu hao Lô tồn kho tự động theo thứ tự FEFO (First Expired, First Out):
 * ORDER BY thoigianhethan ASC NULLS LAST, id ASC FOR UPDATE
 */
async function consumeFefoBatches(client, { tenantId = 'DEFAULT', branchId = null, maNL, qty }) {
    let remaining = lam3(qty);
    if (!(remaining > 0)) return { consumedTotal: 0, batches: [], weightedCost: null };

    const tId = String(tenantId || 'DEFAULT');
    const bId = normalizeInventoryBranch(tId, branchId);

    const lotsRes = await client.query(
        `SELECT id, malo, soluongconlai, giavonlo, thoigianhethan
           FROM public.lo_tonkho
          WHERE tenantid = $1::text
            AND branchid = $2::text
            AND manl = $3::text
            AND trangthai = 'ACTIVE'
            AND soluongconlai > 0
          ORDER BY thoigianhethan ASC NULLS LAST, id ASC
          FOR UPDATE`,
        [tId, bId, maNL]
    );

    if (lotsRes.rows.length === 0) {
        return { consumedTotal: 0, batches: [], weightedCost: null };
    }

    const batches = [];
    let consumedTotal = 0;
    let costSum = 0;

    for (const lot of lotsRes.rows) {
        if (remaining <= 0) break;
        const avail = lam3(lot.soluongconlai);
        const take = lam3(Math.min(avail, remaining));
        const nextRem = lam3(avail - take);
        const nextStatus = nextRem <= 0 ? 'DEPLETED' : 'ACTIVE';

        await client.query(
            `UPDATE public.lo_tonkho
                SET soluongconlai = $2::numeric,
                    trangthai = $3::varchar
              WHERE id = $1::bigint`,
            [Number(lot.id), Math.max(0, nextRem), nextStatus]
        );

        consumedTotal = lam3(consumedTotal + take);
        costSum += take * Number(lot.giavonlo || 0);
        remaining = lam3(remaining - take);
        batches.push({
            id: Number(lot.id),
            maLo: lot.malo,
            consumed: take,
            remainingAfter: Math.max(0, nextRem),
            statusAfter: nextStatus,
            giaVonLo: Number(lot.giavonlo || 0),
            thoiGianHetHan: lot.thoigianhethan,
        });
    }

    return {
        consumedTotal,
        batches,
        weightedCost: consumedTotal > 0 ? lam4(costSum / consumedTotal) : null,
    };
}

/**
 * Kiểm tra Chu trình Đồ thị Công thức Đa Cấp (Cycle Detection DAG - sâu tối đa 5 tầng).
 * Chặn triệt để A -> A và A -> B -> C -> A với mã lỗi 400 CIRCULAR_SUBRECIPE_DETECTED!
 */
async function detectSubRecipeCycle(client, tenantId = 'DEFAULT', maNLThanhPham, compIds = [], LoiNghiepVu) {
    const tId = String(tenantId || 'DEFAULT');
    const target = String(maNLThanhPham || '').trim();
    const cleanComps = [...new Set((compIds || []).map((x) => String(x || '').trim()).filter(Boolean))];

    if (cleanComps.includes(target)) {
        const msg = `Phát hiện vòng lặp công thức: Bán thành phẩm "${target}" không thể chứa chính nó!`;
        if (LoiNghiepVu) {
            throw new LoiNghiepVu(400, msg, { code: 'CIRCULAR_SUBRECIPE_DETECTED', maLoi: 'CIRCULAR_SUBRECIPE_DETECTED' });
        }
        throw Object.assign(new Error(msg), { status: 400, code: 'CIRCULAR_SUBRECIPE_DETECTED' });
    }
    if (cleanComps.length === 0) return;

    const r = await client.query(
        `WITH RECURSIVE graph AS (
            SELECT manlthanhpham::text AS src,
                   manlthanhphan::text AS dst,
                   1 AS depth,
                   ARRAY[manlthanhpham::text, manlthanhphan::text] AS path
              FROM public.banthanhpham_congthuc
             WHERE tenantid = $1::text
               AND manlthanhpham = ANY($2::text[])
            UNION ALL
            SELECT g.src,
                   b.manlthanhphan::text,
                   g.depth + 1,
                   g.path || b.manlthanhphan::text
              FROM graph g
              JOIN public.banthanhpham_congthuc b
                ON b.tenantid = $1::text
               AND b.manlthanhpham = g.dst
             WHERE g.depth < 5
               AND NOT (b.manlthanhphan::text = ANY(g.path))
        )
        SELECT path FROM graph WHERE dst = $3::text LIMIT 1`,
        [tId, cleanComps, target]
    );

    if (r.rows.length > 0) {
        const cyclePath = [target, ...(r.rows[0].path || [])].join(' → ');
        const msg = `Phát hiện vòng lặp công thức đệ quy (${cyclePath})! Không thể lưu công thức tạo chu trình.`;
        if (LoiNghiepVu) {
            throw new LoiNghiepVu(400, msg, {
                code: 'CIRCULAR_SUBRECIPE_DETECTED',
                maLoi: 'CIRCULAR_SUBRECIPE_DETECTED',
                cyclePath,
            });
        }
        throw Object.assign(new Error(msg), { status: 400, code: 'CIRCULAR_SUBRECIPE_DETECTED' });
    }
}

/**
 * Chạy lại lịch sử WAC (WAC Replay) sau khi lập phiếu đảo (LoaiGD = 9) cho 1 phiếu nhập sai giá!
 * Tự động loại bỏ cặp (phiếu nhập sai + phiếu đảo) và tính lại đúng GiaVonDonVi tuần tự cho nguyên liệu.
 */
async function replayWacForBranchIngredient(client, { tenantId = 'DEFAULT', branchId = null, maNL }) {
    const tId = String(tenantId || 'DEFAULT');
    const bId = normalizeInventoryBranch(tId, branchId);

    // Lấy danh sách các phiếu nhập gốc đã bị đảo (LoaiGD = 9)
    const revRes = await client.query(
        `SELECT DISTINCT magdthamchieu
           FROM public.phieugiaodichkho
          WHERE COALESCE(tenantid::text, 'DEFAULT') = $1::text
            AND COALESCE(NULLIF(NULLIF(branchid::text, ''), 'DEFAULT'), $1::text || '_MAIN') = $2::text
            AND loaigd = 9
            AND magdthamchieu IS NOT NULL`,
        [tId, bId]
    );
    const reversedIds = new Set(revRes.rows.map((r) => String(r.magdthamchieu)));

    // Kéo toàn bộ lịch sử giao dịch POSTED của nguyên liệu tại chi nhánh này
    const histRes = await client.query(
        `SELECT p.magiaodich, p.loaigd, p.thoigiantao,
                ct.soluong, COALESCE(ct.dongianhap, 0) AS dongianhap,
                COALESCE(ct.chiphiphanbo, 0) AS chiphiphanbo
           FROM public.chitietgiaodichkho ct
           JOIN public.phieugiaodichkho p ON p.magiaodich = ct.magiaodich
          WHERE COALESCE(p.tenantid::text, 'DEFAULT') = $1::text
            AND COALESCE(NULLIF(NULLIF(p.branchid::text, ''), 'DEFAULT'), $1::text || '_MAIN') = $2::text
            AND ct.manl = $3::text
            AND COALESCE(p.trangthaiduyet, 'POSTED') = 'POSTED'
          ORDER BY p.thoigiantao ASC, p.magiaodich ASC`,
        [tId, bId, maNL]
    );

    let runningStock = 0;
    let runningWac = 0;

    for (const row of histRes.rows) {
        const gdId = String(row.magiaodich);
        const loai = Number(row.loaigd);
        const qty = Number(row.soluong || 0);
        const unitPrice = Number(row.dongianhap || 0);
        const landed = Number(row.chiphiphanbo || 0);

        // Bỏ qua cặp phiếu nhập bị đảo & phiếu đảo (triệt tiêu hoàn toàn ảnh hưởng của giá nhập sai!)
        if (loai === 9 || reversedIds.has(gdId)) continue;

        if (loai === 1 || loai === 10) {
            const wac = computeSafeWacOnStockIn({
                tonCu: runningStock,
                giaVonCu: runningWac,
                slNhapBase: qty,
                tongTienHang: qty * unitPrice,
                chiPhiPhanBo: 0, // unitPrice đã bao gồm landed cost thực tế trên dòng nhập
            });
            runningStock = lam3(runningStock + qty);
            runningWac = wac.giaVonMoi;
        } else if (loai === 2 || loai === 6) {
            runningStock = lam3(runningStock - qty);
        } else if (loai === 7) {
            runningStock = lam3(runningStock + qty);
        } else if (loai === 3) {
            runningStock = lam3(runningStock + qty);
        }
        // LoaiGD = 8 (Hao hụt hủy món đã pha): tồn đã trừ ở LoaiGD = 6
        void landed;
    }

    const curTk = await client.query(
        `SELECT soluongton FROM public.tonkhochinhanh
          WHERE tenantid = $1::text AND branchid = $2::text AND manl = $3::text`,
        [tId, bId, maNL]
    );
    const actualStock = curTk.rows.length > 0 ? Number(curTk.rows[0].soluongton || 0) : runningStock;

    await updateBranchStockRow(client, {
        tenantId: tId,
        branchId: bId,
        maNL,
        nextQty: actualStock,
        nextWac: runningWac,
    });

    return { maNL, replayedWac: runningWac, currentStock: actualStock };
}

/**
 * Tra cứu Giá vốn WAC lịch sử tại một mốc thời gian (dùng cho đơn Offline đồng bộ trễ)
 */
async function lookupHistoricalWac(client, { tenantId = 'DEFAULT', branchId = null, maNL, atTimestamp, fallbackWac = 0 }) {
    if (!atTimestamp) return Number(fallbackWac || 0);
    const tId = String(tenantId || 'DEFAULT');
    const bId = normalizeInventoryBranch(tId, branchId);
    const r = await client.query(
        `SELECT ct.giavonsau
           FROM public.chitietgiaodichkho ct
           JOIN public.phieugiaodichkho p ON p.magiaodich = ct.magiaodich
          WHERE COALESCE(p.tenantid::text, 'DEFAULT') = $1::text
            AND COALESCE(NULLIF(NULLIF(p.branchid::text, ''), 'DEFAULT'), $1::text || '_MAIN') = $2::text
            AND ct.manl = $3::text
            AND ct.giavonsau IS NOT NULL
            AND p.thoigiantao <= $4::timestamptz
            AND COALESCE(p.trangthaiduyet, 'POSTED') = 'POSTED'
          ORDER BY p.thoigiantao DESC
          LIMIT 1`,
        [tId, bId, maNL, atTimestamp]
    );
    if (r.rows.length > 0 && r.rows[0].giavonsau !== null) {
        return Number(r.rows[0].giavonsau);
    }
    return Number(fallbackWac || 0);
}

/**
 * Cảnh báo Tăng Giá Nhập (>= +5% so với trung bình 3 lần gần nhất) & Phân tích Xói mòn Biên lợi nhuận món
 */
async function detectPriceSpikeAndMarginImpact(
    client,
    { tenantId = 'DEFAULT', branchId = null, maNL, tenNL = '', donViTinh = '', newUnitCost = 0, excludeMaGD = null }
) {
    const tId = String(tenantId || 'DEFAULT');
    const bId = normalizeInventoryBranch(tId, branchId);
    const currentPrice = Number(newUnitCost || 0);
    if (!(currentPrice > 0)) return null;

    const prevRes = await client.query(
        `SELECT ct.dongianhap
           FROM public.chitietgiaodichkho ct
           JOIN public.phieugiaodichkho p ON p.magiaodich = ct.magiaodich
          WHERE COALESCE(p.tenantid::text, 'DEFAULT') = $1::text
            AND COALESCE(NULLIF(NULLIF(p.branchid::text, ''), 'DEFAULT'), $1::text || '_MAIN') = $2::text
            AND ct.manl = $3::text
            AND p.loaigd = 1
            AND COALESCE(p.trangthaiduyet, 'POSTED') = 'POSTED'
            AND ($4::text IS NULL OR p.magiaodich::text <> $4::text)
            AND COALESCE(ct.dongianhap, 0) > 0
          ORDER BY p.thoigiantao DESC
          LIMIT 3`,
        [tId, bId, maNL, excludeMaGD ? String(excludeMaGD) : null]
    );

    if (prevRes.rows.length === 0) return null;
    const avgPrev =
        prevRes.rows.reduce((s, r) => s + Number(r.dongianhap || 0), 0) / prevRes.rows.length;
    if (!(avgPrev > 0)) return null;

    const pctIncrease = ((currentPrice - avgPrev) / avgPrev) * 100;
    if (pctIncrease < 5) return null;

    // Tìm các món đang dùng nguyên liệu này trong CongThuc và tính biến động biên lãi gộp
    const menuRes = await client.query(
        `SELECT sp.mamon, sp.tenmon, sps.kichthuoc, sps.giaban,
                ct_target.khoiluongtieuhao AS qty_target,
                COALESCE((
                    SELECT SUM(c2.khoiluongtieuhao * COALESCE(tk2.giavondonvi, nl2.giavondonvi, 0))
                      FROM public.congthuc c2
                      JOIN public.nguyenlieu nl2 ON nl2.manl = c2.manl
                      LEFT JOIN public.tonkhochinhanh tk2
                        ON tk2.branchid = $2::text AND tk2.manl = c2.manl
                     WHERE c2.mamon = sp.mamon AND c2.kichthuoc = sps.kichthuoc
                ), 0) AS new_cogs
           FROM public.congthuc ct_target
           JOIN public.sanpham sp ON sp.mamon = ct_target.mamon
           JOIN public.sanpham_size sps ON sps.mamon = sp.mamon AND sps.kichthuoc = ct_target.kichthuoc
          WHERE COALESCE(sp.tenantid::text, 'DEFAULT') = $1::text
            AND ct_target.manl = $3::text
            AND COALESCE(sp.dangkinhdoanh, TRUE) = TRUE`,
        [tId, bId, maNL]
    );

    const affectedItems = menuRes.rows.map((m) => {
        const price = Number(m.giaban || 0);
        const qtyTarget = Number(m.qty_target || 0);
        const newCogs = Number(m.new_cogs || 0);
        const oldCogs = Math.max(0, newCogs - qtyTarget * (currentPrice - avgPrev));
        const oldMarginPct = price > 0 ? Math.round(((price - oldCogs) / price) * 1000) / 10 : 0;
        const newMarginPct = price > 0 ? Math.round(((price - newCogs) / price) * 1000) / 10 : 0;
        return {
            maMon: m.mamon,
            tenMon: m.tenmon,
            kichThuoc: m.kichthuoc,
            giaBan: price,
            oldMarginPct,
            newMarginPct,
            belowTarget60: newMarginPct < 60,
        };
    });

    return {
        maNL,
        tenNL: tenNL || maNL,
        donViTinh,
        avgPrevPrice: lam4(avgPrev),
        newPrice: lam4(currentPrice),
        pctIncrease: Math.round(pctIncrease * 10) / 10,
        affectedItems,
        message: `${tenNL || maNL} tăng giá +${Math.round(pctIncrease * 10) / 10}% (${lam2(avgPrev)} → ${lam2(currentPrice)}đ/${donViTinh})`,
    };
}

/**
 * Định giá Tồn Kho tại 1 ngày quá khứ (Point-in-Time Inventory Valuation)
 */
async function computePointInTimeValuation(client, { tenantId = 'DEFAULT', branchId = null, asOfDate }) {
    const tId = String(tenantId || 'DEFAULT');
    const bId = normalizeInventoryBranch(tId, branchId);
    const vnTz = 'Asia/Ho_Chi_Minh';
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(String(asOfDate || '')) ? asOfDate : todayDateVN();

    const r = await client.query(
        `SELECT DISTINCT ON (ct.manl)
                ct.manl, nl.tennl, nl.donvitinh,
                COALESCE(ct.tonsau, 0) AS tonsau,
                COALESCE(ct.giavonsau, ct.dongianhap, 0) AS giavonsau,
                p.thoigiantao AS moccapnhat
           FROM public.chitietgiaodichkho ct
           JOIN public.phieugiaodichkho p ON p.magiaodich = ct.magiaodich
           JOIN public.nguyenlieu nl ON nl.manl = ct.manl
          WHERE COALESCE(p.tenantid::text, 'DEFAULT') = $1::text
            AND COALESCE(NULLIF(NULLIF(p.branchid::text, ''), 'DEFAULT'), $1::text || '_MAIN') = $2::text
            AND COALESCE(p.trangthaiduyet, 'POSTED') = 'POSTED'
            AND p.thoigiantao < (($3::text::date + 1)::timestamp AT TIME ZONE '${vnTz}')
          ORDER BY ct.manl ASC, p.thoigiantao DESC, p.magiaodich DESC`,
        [tId, bId, targetDate]
    );

    const items = r.rows.map((row) => {
        const qty = lam3(row.tonsau);
        const wac = lam4(row.giavonsau);
        const value = Math.round(qty * wac);
        return {
            maNL: row.manl,
            tenNL: row.tennl,
            donViTinh: row.donvitinh,
            soLuongTon: qty,
            giaVonDonVi: wac,
            giaTriTon: value,
            mocCapNhat: row.moccapnhat,
        };
    });
    const totalValuation = items.reduce((s, x) => s + x.giaTriTon, 0);
    return { asOfDate: targetDate, branchId: bId, totalValuation, items };
}

/**
 * Báo cáo AvT (Actual vs. Theoretical) Theo Từng Ca Thu Ngân + Phân loại 6 mã Hao hụt
 */
async function computeShiftAvtReport(client, { tenantId = 'DEFAULT', branchId = null, maCaThuNgan }) {
    const tId = String(tenantId || 'DEFAULT');

    const caRes = await client.query(
        `SELECT ca.macathungan, ca.manv, nv.tennv, ca.thoigianmoca, ca.thoigiandongca,
                COALESCE(NULLIF(NULLIF(to_jsonb(ca)->>'branchid', ''), 'DEFAULT'), $1::text || '_MAIN') AS branchid
           FROM public.cathungan ca
           LEFT JOIN public.nhanvien nv ON nv.manv = ca.manv
          WHERE ca.macathungan = $2 AND COALESCE(ca.tenantid::text, 'DEFAULT') = $1::text`,
        [tId, maCaThuNgan]
    );
    if (caRes.rows.length === 0) return null;
    const ca = caRes.rows[0];
    const bId = branchId ? normalizeInventoryBranch(tId, branchId) : ca.branchid;
    const startTs = ca.thoigianmoca;
    const endTs = ca.thoigiandongca || new Date().toISOString();

    // 1. Lấy các mốc chốt tồn đầu/cuối ca trong bảng chotton_ca
    const snapRes = await client.query(
        `SELECT c.manl, nl.tennl, nl.donvitinh, nl.iskeyitem,
                c.tondauca, c.toncuoica,
                COALESCE(tk.soluongton, nl.soluongton, 0) AS tonhientai,
                COALESCE(NULLIF(c.giavonca, 0), tk.giavondonvi, nl.giavondonvi, 0) AS giavon
           FROM public.chotton_ca c
           JOIN public.nguyenlieu nl ON nl.manl = c.manl
           LEFT JOIN public.tonkhochinhanh tk ON tk.branchid = $2::text AND tk.manl = c.manl
          WHERE c.tenantid = $1::text AND c.macathungan = $3::text
          ORDER BY c.manl ASC`,
        [tId, bId, String(maCaThuNgan)]
    );

    // 2. Lấy toàn bộ giao dịch kho trong khung giờ ca (hoặc gắn đúng macathungan)
    const txRes = await client.query(
        `SELECT ct.manl, p.loaigd, COALESCE(p.malydohuy, 'KHAC') AS malydohuy,
                COALESCE(SUM(ct.soluong), 0) AS tong_sl
           FROM public.chitietgiaodichkho ct
           JOIN public.phieugiaodichkho p ON p.magiaodich = ct.magiaodich
          WHERE COALESCE(p.tenantid::text, 'DEFAULT') = $1::text
            AND COALESCE(NULLIF(NULLIF(p.branchid::text, ''), 'DEFAULT'), $1::text || '_MAIN') = $2::text
            AND COALESCE(p.trangthaiduyet, 'POSTED') = 'POSTED'
            AND (
                p.macathungan = $3::text
                OR (p.macathungan IS NULL AND p.thoigiantao >= $4::timestamptz AND p.thoigiantao <= $5::timestamptz)
            )
          GROUP BY ct.manl, p.loaigd, COALESCE(p.malydohuy, 'KHAC')`,
        [tId, bId, String(maCaThuNgan), startTs, endTs]
    );

    const txByNl = new Map();
    const allNlIds = new Set(snapRes.rows.map((r) => r.manl));
    for (const r of txRes.rows) {
        allNlIds.add(r.manl);
        if (!txByNl.has(r.manl)) {
            txByNl.set(r.manl, { nhapNau: 0, banHang: 0, hoanKho: 0, xuatHuy: 0, haoHutHuyMon: 0, wasteByReason: {} });
        }
        const entry = txByNl.get(r.manl);
        const loai = Number(r.loaigd);
        const qty = Number(r.tong_sl || 0);
        if (loai === 1 || loai === 10) entry.nhapNau = lam3(entry.nhapNau + qty);
        else if (loai === 6) entry.banHang = lam3(entry.banHang + qty);
        else if (loai === 7) entry.hoanKho = lam3(entry.hoanKho + qty);
        else if (loai === 2) {
            entry.xuatHuy = lam3(entry.xuatHuy + qty);
            const code = r.malydohuy || 'KHAC';
            entry.wasteByReason[code] = lam3((entry.wasteByReason[code] || 0) + qty);
        } else if (loai === 8) {
            entry.haoHutHuyMon = lam3(entry.haoHutHuyMon + qty);
            entry.wasteByReason.CUSTOMER_REMAKE = lam3((entry.wasteByReason.CUSTOMER_REMAKE || 0) + qty);
        }
    }

    const snapMap = new Map(snapRes.rows.map((r) => [r.manl, r]));
    const items = [];
    const flaggedItems = [];

    for (const maNL of [...allNlIds].sort()) {
        const snap = snapMap.get(maNL);
        const tx = txByNl.get(maNL) || { nhapNau: 0, banHang: 0, hoanKho: 0, xuatHuy: 0, haoHutHuyMon: 0, wasteByReason: {} };
        if (!snap) continue; // Chỉ tính AvT chính xác trên các nguyên liệu đã chốt tồn đầu/cuối ca

        const tonDauCa = lam3(snap.tondauca);
        const tonCuoiCa = snap.toncuoica !== null && snap.toncuoica !== undefined ? lam3(snap.toncuoica) : lam3(snap.tonhientai);
        const giaVon = Number(snap.giavon || 0);

        const actualUsage = lam3(tonDauCa + tx.nhapNau - tonCuoiCa);
        // Loại trừ hoàn kho (7) & hao hụt hủy món đã pha (8) khỏi tổng tiêu hao bán hàng (6) để không đếm trùng
        const theoreticalUsage = lam3(Math.max(0, tx.banHang - tx.hoanKho - tx.haoHutHuyMon));
        const recordedWaste = lam3(tx.xuatHuy + tx.haoHutHuyMon);
        const unexplainedVariance = lam3(actualUsage - (theoreticalUsage + recordedWaste));
        const variancePct =
            Math.round((unexplainedVariance / Math.max(theoreticalUsage, 1)) * 1000) / 10;
        const varianceValue = Math.round(unexplainedVariance * giaVon);
        const isAlert = unexplainedVariance > 0 && (variancePct > 3 || varianceValue > 50000);

        const row = {
            maNL,
            tenNL: snap.tennl,
            donViTinh: snap.donvitinh,
            isKeyItem: Boolean(snap.iskeyitem),
            giaVonDonVi: giaVon,
            tonDauCa,
            nhapHoacNauTrongCa: tx.nhapNau,
            tonKiemCuoiCa: tonCuoiCa,
            actualUsage,
            theoreticalUsage,
            recordedWaste,
            wasteByReason: tx.wasteByReason,
            unexplainedVariance,
            variancePct,
            varianceValue,
            isAlert,
        };
        items.push(row);
        if (isAlert) flaggedItems.push(row);
    }

    return {
        maCaThuNgan: ca.macathungan,
        branchId: bId,
        tenNV: ca.tennv || ca.manv,
        thoiGianMoCa: ca.thoigianmoca,
        thoiGianDongCa: ca.thoigiandongca,
        wastageTaxonomy: WASTAGE_TAXONOMY,
        items,
        flaggedItems,
        totalUnexplainedValue: items.reduce((s, x) => s + Math.max(0, x.varianceValue), 0),
    };
}

module.exports = {
    WASTAGE_TAXONOMY,
    VALID_WASTAGE_CODES,
    lam3,
    lam4,
    lam2,
    normalizeInventoryBranch,
    isMainBranch,
    todayDateVN,
    ensureBranchRecord,
    computeSafeWacOnStockIn,
    allocateLandedCost,
    lockBranchStockOrdered,
    updateBranchStockRow,
    insertLedgerLine,
    assertPeriodNotLocked,
    createFefoLot,
    consumeFefoBatches,
    detectSubRecipeCycle,
    replayWacForBranchIngredient,
    lookupHistoricalWac,
    detectPriceSpikeAndMarginImpact,
    computePointInTimeValuation,
    computeShiftAvtReport,
};
