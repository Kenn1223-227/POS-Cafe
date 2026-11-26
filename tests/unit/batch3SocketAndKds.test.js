'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../..');
const {
    emitToBranch,
    emitToRole,
    emitToTenant,
    roomTenantRole,
    resolveBranchRooms,
} = require('../../src/core/socketRooms');
const {
    buildBatchSummary,
    buildExpoTickets,
    VALID_STATIONS,
} = require('../../modules/kdsPhase2Engine');
const { buildCupLabelsTspl } = require('../../local-print-bridge/tsplBuilder');

function collectJsFiles(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) collectJsFiles(full, out);
        else if (ent.isFile() && ent.name.endsWith('.js')) out.push(full);
    }
    return out;
}

function createMockIo() {
    const emissions = [];
    const io = {
        to(target) {
            const rooms = Array.isArray(target) ? [...target] : [target];
            const chain = {
                to(next) {
                    if (Array.isArray(next)) rooms.push(...next);
                    else rooms.push(next);
                    return chain;
                },
                emit(event, payload) {
                    emissions.push({ rooms: [...rooms], event, payload });
                },
            };
            return chain;
        },
    };
    return { io, emissions };
}

describe('Batch 3 Remediation — Real-time 3-Tier Socket Engine & KDS Rush/Remake', () => {
    it('1. [Chốt chặn chống tái diễn] Cấm gọi trực tiếp roomTen() ngoài src/core/socketRooms.js & auditAndSecurity.js, cấm phát sự kiện DON_MOI', () => {
        const allowedRoomTenCallers = new Set([
            path.normalize(path.join(ROOT_DIR, 'src', 'core', 'socketRooms.js')),
            path.normalize(path.join(ROOT_DIR, 'src', 'core', 'auditAndSecurity.js')),
        ]);

        const files = [
            ...collectJsFiles(path.join(ROOT_DIR, 'src')),
            ...collectJsFiles(path.join(ROOT_DIR, 'modules')),
        ];

        const roomTenViolations = [];
        const donMoiViolations = [];

        for (const file of files) {
            const normFile = path.normalize(file);
            const rel = path.relative(ROOT_DIR, normFile);
            const src = fs.readFileSync(normFile, 'utf8');

            if (!allowedRoomTenCallers.has(normFile) && /\broomTen\s*\(/.test(src)) {
                roomTenViolations.push(rel);
            }
            if (/\.emit\s*\(\s*['"]DON_MOI['"]/.test(src)) {
                donMoiViolations.push(rel);
            }
        }

        assert.deepEqual(
            roomTenViolations,
            [],
            `Phát hiện gọi trực tiếp roomTen() ngoài socketRooms.js: ${roomTenViolations.join(', ')}. Bắt buộc dùng emitToBranch / emitToRole / emitToTenant!`
        );
        assert.deepEqual(
            donMoiViolations,
            [],
            `Phát hiện bắn sai tên sự kiện 'DON_MOI' tại: ${donMoiViolations.join(', ')}. Bắt buộc dùng 'order:new' & 'CO_DON_MOI'!`
        );
    });

    it('2. Helper tập trung emitToBranch / emitToRole / emitToTenant bắn chuẩn phòng 3 tầng, cô lập đa chi nhánh & không bắn trùng', () => {
        // 2a. Chi nhánh cụ thể (CN1): cô lập hoàn toàn, KHÔNG bắn vào legacy 2-tier room hay chi nhánh CN2
        const mock1 = createMockIo();
        const roomsCn1 = emitToBranch(mock1.io, {
            tenantId: 'T1',
            branchId: 'CN1',
            roles: ['POS', 'WAITER'],
            event: 'VIETQR_DA_NHAN',
            payload: { maHoaDon: 'HD-1' },
        });
        assert.equal(mock1.emissions.length, 1, 'Phải gom vào đúng 1 lần gọi io.to(rooms).emit()');
        assert.ok(roomsCn1.includes('t:T1:b:CN1:pos'));
        assert.ok(roomsCn1.includes('t:T1:b:CN1:waiter'));
        assert.equal(roomsCn1.includes('t:T1:thungan'), false, 'Chi nhánh CN1 không được rò sang legacy room t:T1:thungan');
        assert.equal(roomsCn1.includes('t:T1:b:CN2:pos'), false, 'Chi nhánh CN1 không được rò sang CN2');
        assert.equal(roomsCn1.includes('t:T1:role:POS'), false, 'emitToBranch không được bắn vào phòng toàn tenant');

        // 2b. Chi nhánh DEFAULT / T1_MAIN: đồng bộ cả DEFAULT + T1_MAIN + fallback legacy trong 1 lệnh emit duy nhất (Socket.IO tự deduplicate)
        const mock2 = createMockIo();
        const roomsDef = emitToBranch(mock2.io, {
            tenantId: 'T1',
            branchId: 'T1_MAIN',
            roles: ['POS'],
            event: 'HOADON_DA_TT',
            payload: { maHoaDon: 'HD-2' },
        });
        assert.equal(mock2.emissions.length, 1);
        assert.ok(roomsDef.includes('t:T1:b:DEFAULT:pos'));
        assert.ok(roomsDef.includes('t:T1:b:T1_MAIN:pos'));
        assert.ok(roomsDef.includes('t:T1:thungan'));
        assert.equal(new Set(roomsDef).size, roomsDef.length, 'Danh sách phòng không được chứa phần tử trùng lặp');

        // 2c. KDS station='ALL' phủ đủ 3 trạm + kds:ALL + expo trong 1 lệnh emit duy nhất
        const mock3 = createMockIo();
        const roomsKds = emitToBranch(mock3.io, {
            tenantId: 'T1',
            branchId: 'CN1',
            roles: ['KDS', 'EXPO'],
            station: 'ALL',
            event: 'order:new',
            payload: { maHoaDon: 'HD-3' },
        });
        assert.equal(mock3.emissions.length, 1);
        for (const st of VALID_STATIONS) {
            assert.ok(roomsKds.includes(`t:T1:b:CN1:kds:${st}`), `Thiếu phòng trạm ${st}`);
        }
        assert.ok(roomsKds.includes('t:T1:b:CN1:kds:ALL'));
        assert.ok(roomsKds.includes('t:T1:b:CN1:expo'));

        // 2d. emitToTenant phát tới phòng role toàn tenant + DEFAULT 3 tầng
        const mock4 = createMockIo();
        const roomsTen = emitToTenant(mock4.io, {
            tenantId: 'T1',
            roles: ['POS'],
            event: 'payment:vietqr_unmatched',
            payload: { soTienNhan: 50000 },
        });
        assert.equal(mock4.emissions.length, 1);
        assert.ok(roomsTen.includes(roomTenantRole('T1', 'POS')));
        assert.ok(roomsTen.includes('t:T1:b:DEFAULT:pos'));

        // 2e. emitToRole định tuyến theo branchId (có branchId -> branch; không có -> tenant)
        const mock5 = createMockIo();
        const rRoleBranch = emitToRole(mock5.io, {
            tenantId: 'T1',
            branchId: 'CN2',
            role: 'WAITER',
            event: 'BAN_THAY_DOI',
            payload: { maBan: 'B01', trangThai: 2 },
        });
        assert.deepEqual(rRoleBranch, ['t:T1:b:CN2:waiter']);

        const rRoleTenant = emitToRole(mock5.io, {
            tenantId: 'T1',
            branchId: null,
            role: 'POS',
            event: 'TOPPING_THAY_DOI',
            payload: { maTopping: 'TP01' },
        });
        assert.ok(rRoleTenant.includes('t:T1:role:POS'));
        assert.equal(resolveBranchRooms('T1', 'CN1', ['POS'], { includeLegacy: false }).includes('t:T1:thungan'), false);
    });

    it('3. Đối chiếu 1-1 tên sự kiện + phòng 3 tầng giữa BE emit và FE listener cho 5 sự kiện cốt lõi', () => {
        const systemSrc = fs.readFileSync(path.join(ROOT_DIR, 'src', 'domains', 'system', 'index.js'), 'utf8');
        const ordersSrc = fs.readFileSync(path.join(ROOT_DIR, 'src', 'domains', 'orders', 'index.js'), 'utf8');
        const ecoSrc = fs.readFileSync(path.join(ROOT_DIR, 'modules', 'ecosystemPhase8Routes.js'), 'utf8');
        const posSrc = fs.readFileSync(path.join(ROOT_DIR, 'frontend', 'src', 'pages', 'pos', 'PosPage.jsx'), 'utf8');
        const baristaSrc = fs.readFileSync(path.join(ROOT_DIR, 'frontend', 'src', 'pages', 'barista', 'BaristaPage.jsx'), 'utf8');

        // 1) VIETQR_DA_NHAN
        assert.match(systemSrc, /emitToBranch\s*\(\s*io\s*,\s*\{[\s\S]*roles:\s*\['POS',\s*'WAITER'\][\s\S]*event:\s*'VIETQR_DA_NHAN'/);
        assert.match(posSrc, /VIETQR_DA_NHAN:\s*\(/);

        // 2) BAN_THAY_DOI
        assert.match(ordersSrc, /emitToBranch\s*\(\s*io\s*,\s*\{[\s\S]*roles:\s*\['POS',\s*'WAITER'\][\s\S]*event:\s*'BAN_THAY_DOI'/);
        assert.match(posSrc, /BAN_THAY_DOI:\s*\(/);

        // 3) HOADON_DA_TT
        assert.match(ordersSrc, /emitToBranch\s*\(\s*io\s*,\s*\{[\s\S]*roles:\s*\['POS'\][\s\S]*event:\s*'HOADON_DA_TT'/);
        assert.match(systemSrc, /emitToBranch\s*\(\s*io\s*,\s*\{[\s\S]*roles:\s*\['POS'\][\s\S]*event:\s*'HOADON_DA_TT'/);
        assert.match(posSrc, /HOADON_DA_TT:\s*\(/);

        // 4) QR_ORDER_MOI & QR_ORDER_CAP_NHAT
        assert.match(ecoSrc, /emitToBranch\s*\(\s*io\s*,\s*\{[\s\S]*roles:\s*\['POS',\s*'WAITER'\][\s\S]*event:\s*'QR_ORDER_MOI'/);
        assert.match(ecoSrc, /emitToBranch\s*\(\s*io\s*,\s*\{[\s\S]*roles:\s*\['POS',\s*'WAITER'\][\s\S]*event:\s*'QR_ORDER_CAP_NHAT'/);
        assert.match(posSrc, /QR_ORDER_MOI:\s*\(/);
        assert.match(posSrc, /QR_ORDER_CAP_NHAT:\s*\(/);

        // 5) Đơn mới KDS (order:new & CO_DON_MOI) trên QR/App Sàn
        assert.match(ecoSrc, /ketQua\.kdsEmitPlan\.flush\(\)/);
        assert.match(ecoSrc, /event:\s*'order:new'/);
        assert.match(ecoSrc, /event:\s*'CO_DON_MOI'/);
        assert.match(baristaSrc, /'order:new':\s*\(/);
        assert.match(baristaSrc, /CO_DON_MOI:/);
    });

    it('4. Tách biệt tuyệt đối nhãn GẤP / RUSH và LÀM LẠI / REMAKE trên BE Engine, FE KDS/BDS và TSPL Print Bridge', () => {
        // 4a. TSPL cup label: đơn Rush (mucDoUuTien=2, remakeOfCTHD=null) KHÔNG được in [LAM LAI] mà phải in [GAP/RUSH]
        const built = buildCupLabelsTspl({
            hoaDon: {
                maHoaDon: 'HD-RUSH-REMAKE-01',
                soThuTuNgay: 12,
                loaiDonHang: 'TAI_QUAN',
                ban: [{ maBan: 'B01', tenBan: 'Ban 1' }],
                danhSachMon: [
                    {
                        maCTHD: 1,
                        maMon: 'CF01',
                        tenMon: 'Cà Phê Sữa Đá',
                        kichThuoc: 'M',
                        soLuong: 1,
                        mucDoUuTien: 2,
                        remakeOfCTHD: null,
                    },
                    {
                        maCTHD: 2,
                        maMon: 'CF02',
                        tenMon: 'Bạc Xỉu',
                        kichThuoc: 'L',
                        soLuong: 1,
                        mucDoUuTien: 2,
                        remakeOfCTHD: 'CTHD-ORIG-1',
                    },
                ],
            },
            renderMode: 'ASCII_FALLBACK',
        });

        assert.equal(built.cupCount, 2);
        const rushCup = built.cups[0];
        const remakeCup = built.cups[1];
        assert.equal(rushCup.badge, '[GAP/RUSH]', 'Đơn Rush phải in badge [GAP/RUSH], không được gắn nhầm [LAM LAI]');
        assert.equal(remakeCup.badge, '[LAM LAI]', 'Vé Remake phải in badge [LAM LAI]');

        // 4b. KDS Engine buildBatchSummary & buildExpoTickets tách rõ hasRush vs hasRemake
        const kdsItems = [
            {
                maCTHD: 'C1',
                maHoaDon: 'HD-RUSH',
                maMon: 'M1',
                tenMon: 'Latte',
                kichThuoc: 'M',
                soLuong: 1,
                tramCheBien: 'BAR_CHINH',
                trangThaiPhaChe: 'ChoPhaChe',
                mucDoUuTien: 2,
                remakeOfCTHD: null,
                thoiGianGoi: new Date().toISOString(),
            },
            {
                maCTHD: 'C2',
                maHoaDon: 'HD-REMAKE',
                maMon: 'M2',
                tenMon: 'Matcha',
                kichThuoc: 'L',
                soLuong: 1,
                tramCheBien: 'BAR_LANH',
                trangThaiPhaChe: 'ChoPhaChe',
                mucDoUuTien: 2,
                remakeOfCTHD: 'C0',
                thoiGianGoi: new Date().toISOString(),
            },
        ];

        const batches = buildBatchSummary(kdsItems);
        const latteBatch = batches.find((b) => b.maMon === 'M1');
        const matchaBatch = batches.find((b) => b.maMon === 'M2');
        assert.equal(latteBatch.hasRush, true);
        assert.equal(latteBatch.hasRemake, false);
        assert.equal(latteBatch.fifoItems[0].isRush, true);
        assert.equal(latteBatch.fifoItems[0].isRemake, false);
        assert.equal(matchaBatch.hasRemake, true);
        assert.equal(matchaBatch.hasRush, false);
        assert.equal(matchaBatch.fifoItems[0].isRemake, true);
        assert.equal(matchaBatch.fifoItems[0].isRush, false);

        const expo = buildExpoTickets(kdsItems);
        const rushTicket = expo.find((t) => t.maHoaDon === 'HD-RUSH');
        const remakeTicket = expo.find((t) => t.maHoaDon === 'HD-REMAKE');
        assert.equal(rushTicket.hasRush, true);
        assert.equal(rushTicket.hasRemake, false);
        assert.equal(remakeTicket.hasRemake, true);
        assert.equal(remakeTicket.hasRush, false);

        // 4c. Frontend BaristaPage.jsx tách rõ isRemake vs isRush, không còn gộp mucDoUuTien >= 2 vào isRemake
        const baristaSrc = fs.readFileSync(
            path.join(ROOT_DIR, 'frontend', 'src', 'pages', 'barista', 'BaristaPage.jsx'),
            'utf8'
        );
        assert.doesNotMatch(
            baristaSrc,
            /const\s+isRemake\s*=\s*Boolean\(item\.remakeOfCTHD\)\s*\|\|\s*Number\(item\.mucDoUuTien\)\s*>=\s*2/,
            'BaristaPage.jsx không được gộp mucDoUuTien >= 2 vào isRemake'
        );
        assert.match(baristaSrc, /GẤP \/ RUSH/, 'BaristaPage.jsx phải hiển thị nhãn GẤP / RUSH riêng cho đơn Rush');
        assert.match(baristaSrc, /LÀM LẠI \/ REMAKE/, 'BaristaPage.jsx phải hiển thị nhãn LÀM LẠI / REMAKE riêng cho vé Làm lại');
    });
});
