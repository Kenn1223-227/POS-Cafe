const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const dotenv = require('dotenv');
const { Server } = require('socket.io');
const { io: ioClient } = require('../../frontend/node_modules/socket.io-client');
const Redis = require('ioredis');
const { createAdapter } = require('@socket.io/redis-adapter');
const {
    emitScopedKdsEvent,
    roomBranchPos,
    roomBranchKds,
    roomBranchWaiter,
    normalizeBranchId,
    normalizeStation,
    VALID_STATIONS,
} = require('../../modules/kdsPhase2Engine');

const envTestPath = path.join(__dirname, '..', '..', '.env.test');
if (fs.existsSync(envTestPath)) {
    dotenv.config({ path: envTestPath, quiet: true });
} else {
    dotenv.config({ quiet: true });
}

const REDIS_URL = String(process.env.TEST_REDIS_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6380').trim();

function attachWave3aSocketHandlers(io) {
    io.on('connection', (socket) => {
        const tenantId = String(socket.handshake.auth?.tenantId || 'DEFAULT');
        const maNV = String(socket.handshake.auth?.maNV || 'NV01');

        // Phòng cá nhân cô lập đa tenant: t:{tenantId}:user:{maNV}
        socket.join(`t:${tenantId}:user:${maNV}`);

        socket.on('room:subscribe', (opts = {}, ack) => {
            const role = String(opts.role || 'POS').toUpperCase();
            const branchId = normalizeBranchId(opts.branchId || 'DEFAULT');
            const station = normalizeStation(opts.station || 'ALL');

            for (const r of [...socket.rooms]) {
                if (r === socket.id || r === `t:${tenantId}:user:${maNV}`) continue;
                socket.leave(r);
            }

            if (role === 'POS') socket.join(roomBranchPos(tenantId, branchId));
            else if (role === 'WAITER') socket.join(roomBranchWaiter(tenantId, branchId));
            else if (role === 'KDS') {
                if (station === 'ALL') {
                    for (const st of VALID_STATIONS) socket.join(roomBranchKds(tenantId, branchId, st));
                    socket.join(roomBranchKds(tenantId, branchId, 'ALL'));
                } else {
                    socket.join(roomBranchKds(tenantId, branchId, station));
                }
            }
            if (typeof ack === 'function') ack({ ok: true, tenantId, branchId, role, station });
        });
    });
}

async function createClusterInstance() {
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, { cors: { origin: '*' } });
    const pub = new Redis(REDIS_URL);
    const sub = pub.duplicate();
    io.adapter(createAdapter(pub, sub));
    attachWave3aSocketHandlers(io);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        io,
        close: async () => {
            await Promise.allSettled([
                new Promise((r) => io.close(r)),
                new Promise((r) => server.close(r)),
                pub.quit(),
                sub.quit(),
            ]);
        },
    };
}

function connectClient(url, auth) {
    return new Promise((resolve, reject) => {
        const client = ioClient(url, {
            transports: ['websocket'],
            auth,
            reconnection: false,
        });
        const t = setTimeout(() => reject(new Error('Timeout connecting socket.io-client')), 4000);
        client.once('connect', () => {
            clearTimeout(t);
            resolve(client);
        });
        client.once('connect_error', (err) => {
            clearTimeout(t);
            reject(err);
        });
    });
}

describe('Wave 3A Realtime [Tầng 3 — 2 Instances + Live Redis]: TC-W3A-04 & TC-W3A-05', () => {
    it('TC-W3A-04 (QA-10): Cô lập 3 tầng qua Redis — CN1 (Instance #2) nhận menu:86_updated & ORDER_RUSH_UPDATED < 500ms, CN2 nhận 0 sự kiện', async () => {
        const inst1 = await createClusterInstance();
        const inst2 = await createClusterInstance();

        const tenantId = `T_ISO_${Date.now()}`;
        const clientCN1Pos = await connectClient(inst2.url, { tenantId, maNV: 'NV_CN1_POS' });
        const clientCN1Kds = await connectClient(inst2.url, { tenantId, maNV: 'NV_CN1_KDS' });
        const clientCN2Pos = await connectClient(inst2.url, { tenantId, maNV: 'NV_CN2_POS' });
        const clientCN2Kds = await connectClient(inst2.url, { tenantId, maNV: 'NV_CN2_KDS' });

        try {
            await Promise.all([
                new Promise((r) => clientCN1Pos.emit('room:subscribe', { branchId: 'CN1', role: 'POS' }, r)),
                new Promise((r) => clientCN1Kds.emit('room:subscribe', { branchId: 'CN1', role: 'KDS', station: 'BAR_CHINH' }, r)),
                new Promise((r) => clientCN2Pos.emit('room:subscribe', { branchId: 'CN2', role: 'POS' }, r)),
                new Promise((r) => clientCN2Kds.emit('room:subscribe', { branchId: 'CN2', role: 'KDS', station: 'BAR_CHINH' }, r)),
            ]);

            const cn2Received = [];
            clientCN2Pos.on('menu:86_updated', (d) => cn2Received.push(d));
            clientCN2Pos.on('ORDER_RUSH_UPDATED', (d) => cn2Received.push(d));
            clientCN2Kds.on('menu:86_updated', (d) => cn2Received.push(d));
            clientCN2Kds.on('ORDER_RUSH_UPDATED', (d) => cn2Received.push(d));

            const t0 = Date.now();
            const p86 = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Quá 500ms CN1 POS không nhận menu:86_updated')), 500);
                clientCN1Pos.once('menu:86_updated', (data) => {
                    clearTimeout(timer);
                    resolve({ data, latencyMs: Date.now() - t0 });
                });
            });
            const pRush = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Quá 500ms CN1 KDS không nhận ORDER_RUSH_UPDATED')), 500);
                clientCN1Kds.once('ORDER_RUSH_UPDATED', (data) => {
                    clearTimeout(timer);
                    resolve({ data, latencyMs: Date.now() - t0 });
                });
            });

            // Phát sự kiện từ Instance #1 cho CN1
            emitScopedKdsEvent(inst1.io, {
                tenantId,
                branchId: 'CN1',
                station: 'ALL',
                eventType: 'MENU_86_UPDATED',
                socketEvents: ['menu:86_updated'],
                payload: { maNL: 'NL01', branchId: 'CN1', tamHet: true },
                includePos: true,
                includeWaiter: true,
            });
            emitScopedKdsEvent(inst1.io, {
                tenantId,
                branchId: 'CN1',
                station: 'BAR_CHINH',
                eventType: 'ORDER_RUSH_UPDATED',
                socketEvents: ['ORDER_RUSH_UPDATED'],
                payload: { maHoaDon: 'HD-RUSH-1', branchId: 'CN1', rush: true },
                includePos: true,
            });

            const [r86, rRush] = await Promise.all([p86, pRush]);
            assert.ok(r86.latencyMs < 500, `Latency menu:86_updated phải < 500ms, thực tế ${r86.latencyMs}ms`);
            assert.ok(rRush.latencyMs < 500, `Latency ORDER_RUSH_UPDATED phải < 500ms, thực tế ${rRush.latencyMs}ms`);
            assert.equal(r86.data.branchId, 'CN1');
            assert.equal(rRush.data.rush, true);

            // Chờ 150ms xác nhận CN2 nhận đúng 0 sự kiện
            await new Promise((r) => setTimeout(r, 150));
            assert.equal(cn2Received.length, 0, `CN2 phải nhận 0 sự kiện, thực tế nhận ${cn2Received.length}`);
        } finally {
            clientCN1Pos.disconnect();
            clientCN1Kds.disconnect();
            clientCN2Pos.disconnect();
            clientCN2Kds.disconnect();
            await Promise.all([inst1.close(), inst2.close()]);
        }
    });

    it('TC-W3A-05 (QA-10b): Cross-Tenant User Disconnect — ngắt t:TENANT_A:user:NV01 KHÔNG làm rớt kết nối NV01 của TENANT_B', async () => {
        const inst1 = await createClusterInstance();
        const inst2 = await createClusterInstance();

        const tenantA = `TENANT_A_${Date.now()}`;
        const tenantB = `TENANT_B_${Date.now()}`;

        const nv01TenantA = await connectClient(inst1.url, { tenantId: tenantA, maNV: 'NV01' });
        const nv01TenantB = await connectClient(inst2.url, { tenantId: tenantB, maNV: 'NV01' });

        try {
            let bDisconnected = false;
            nv01TenantB.on('disconnect', () => {
                bDisconnected = true;
            });

            const aDisconnectedPromise = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('NV01 của TENANT_A không bị ngắt kết nối')), 1500);
                nv01TenantA.once('disconnect', () => {
                    clearTimeout(timer);
                    resolve(true);
                });
            });

            // Phát lệnh ngắt kết nối từ Instance #2 (xuyên Redis cluster) tới đúng phòng t:TENANT_A:user:NV01
            inst2.io.in(`t:${tenantA}:user:NV01`).disconnectSockets(true);

            const aWasDisconnected = await aDisconnectedPromise;
            assert.equal(aWasDisconnected, true);

            await new Promise((r) => setTimeout(r, 200));
            assert.equal(bDisconnected, false, 'NV01 của TENANT_B tuyệt đối KHÔNG được bị đá văng!');
            assert.equal(nv01TenantB.connected, true);
        } finally {
            nv01TenantA.disconnect();
            nv01TenantB.disconnect();
            await Promise.all([inst1.close(), inst2.close()]);
        }
    });
});
