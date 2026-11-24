const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
    createRuntimePool,
    assertAppRuntimeNoBypassRls,
    withTenantTx,
} = require('../helpers/dbHarness');
const { insertKdsEventLog } = require('../../modules/kdsPhase2Engine');

describe('Wave 3A Realtime [Tầng 3 — KDS Delta Sync]: TC-W3A-06', () => {
    let runtimePool;
    const tenantId = `W3A_DELTA_${Date.now()}`;
    const branchId = 'CN_DELTA';

    before(async () => {
        runtimePool = createRuntimePool();
        await assertAppRuntimeNoBypassRls(runtimePool);
    });

    after(async () => {
        if (runtimePool) await runtimePool.end();
    });

    it('TC-W3A-06: Ghi 3 sự kiện kds_event_log (seq = N+1..N+3) trong lúc mất kết nối -> delta sync với lastSeq = N trả đủ 3 sự kiện tăng dần, 0 trùng lặp', async () => {
        await withTenantTx(runtimePool, tenantId, async (client) => {
            // Ghi mốc ban đầu N
            const baseEv = await insertKdsEventLog(client, {
                tenantId,
                branchId,
                station: 'BAR_CHINH',
                eventType: 'ORDER_NEW',
                maHoaDon: 'HD-BASE',
                payload: { step: 0 },
            });
            const lastSeq = baseEv.seq;

            // Giả lập KDS mất kết nối: hệ thống ghi thêm 3 sự kiện liên tiếp N+1, N+2, N+3
            const ev1 = await insertKdsEventLog(client, {
                tenantId,
                branchId,
                station: 'BAR_CHINH',
                eventType: 'ORDER_NEW',
                maHoaDon: 'HD-1',
                payload: { step: 1 },
            });
            const ev2 = await insertKdsEventLog(client, {
                tenantId,
                branchId,
                station: 'BAR_CHINH',
                eventType: 'ORDER_RUSH_UPDATED',
                maHoaDon: 'HD-1',
                payload: { step: 2, rush: true },
            });
            const ev3 = await insertKdsEventLog(client, {
                tenantId,
                branchId,
                station: 'ALL',
                eventType: 'MENU_86_UPDATED',
                maHoaDon: null,
                payload: { step: 3, maNL: 'NL01' },
            });

            // Sự kiện của chi nhánh khác (CN_OTHER) không được lẫn vào delta sync của CN_DELTA
            await insertKdsEventLog(client, {
                tenantId,
                branchId: 'CN_OTHER',
                station: 'BAR_CHINH',
                eventType: 'ORDER_NEW',
                maHoaDon: 'HD-OTHER',
                payload: { step: 99 },
            });

            // Truy vấn Delta Sync như GET /api/kds/sync?branchId=CN_DELTA&station=BAR_CHINH&lastSeq=N
            const deltaRes = await client.query(
                `SELECT seq, eventtype, mahoadon, station, payload
                   FROM public.kds_event_log
                  WHERE tenantid = $1
                    AND branchid = $2
                    AND (station = $3 OR station = 'ALL')
                    AND seq > $4
                  ORDER BY seq ASC`,
                [tenantId, branchId, 'BAR_CHINH', lastSeq]
            );

            assert.equal(deltaRes.rows.length, 3, 'Delta sync phải trả về đúng đủ 3 sự kiện đã bỏ lỡ');
            const seqs = deltaRes.rows.map((r) => Number(r.seq));
            assert.deepEqual(seqs, [ev1.seq, ev2.seq, ev3.seq]);
            assert.ok(seqs[0] < seqs[1] && seqs[1] < seqs[2], 'seq phải tăng dần nghiêm ngặt');
            assert.equal(new Set(seqs).size, 3, 'Tuyệt đối 0 trùng lặp');
            assert.deepEqual(
                deltaRes.rows.map((r) => r.eventtype),
                ['ORDER_NEW', 'ORDER_RUSH_UPDATED', 'MENU_86_UPDATED']
            );
        });
    });
});
