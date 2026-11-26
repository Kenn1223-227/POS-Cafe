/**
 * =============================================================================
 * PHÂN HỆ 2 - TRỤ CỘT 3: LỚP TRUYỀN TẢI & CẢM BIẾN MÁY IN (ESC/POS + TSPL)
 * - Truyền lệnh nhị phân: LAN TCP (9100), Windows Shared USB Printer, SIMULATOR
 * - Hỏi trạng thái cảm biến giấy/kẹt/mở nắp:
 *     + ESC/POS: DLE EOT 4 (0x10 0x04 0x04) & DLE EOT 2 (0x10 0x04 0x02)
 *     + TSPL:    <ESC>!? (0x1B 0x21 0x3F) -> 0x00 Ready / 0x01 Head Open / 0x02 Paper Jam / 0x04 Out of Paper / 0x08 Ribbon
 * - Hỗ trợ giả lập cảm biến kẹt giấy theo từng Cup Index cho kiểm thử tự động & failover!
 * =============================================================================
 */
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const TSPL_STATUS_LABELS = {
    0x00: 'READY',
    0x01: 'HEAD_OPEN',
    0x02: 'PAPER_JAM',
    0x04: 'OUT_OF_PAPER',
    0x08: 'OUT_OF_RIBBON',
    0x10: 'PAUSED',
};

// Trạng thái giả lập cảm biến (dùng trong SIMULATOR mode hoặc bài test tự động kẹt giấy giữa chừng)
const simulatedSensors = {
    receipt: { statusCode: 0x00, offline: false },
    label: { statusCode: 0x00, offline: false, jamAtCupIndex: null },
};

function setSimulatedSensorStatus(printerKey, patch = {}) {
    const key = String(printerKey || 'label').toLowerCase() === 'receipt' ? 'receipt' : 'label';
    simulatedSensors[key] = { ...simulatedSensors[key], ...patch };
    return simulatedSensors[key];
}

function getSimulatedSensorStatus(printerKey = null) {
    if (!printerKey) return JSON.parse(JSON.stringify(simulatedSensors));
    const key = String(printerKey).toLowerCase() === 'receipt' ? 'receipt' : 'label';
    return { ...simulatedSensors[key] };
}

function resetSimulatedSensors() {
    simulatedSensors.receipt = { statusCode: 0x00, offline: false };
    simulatedSensors.label = { statusCode: 0x00, offline: false, jamAtCupIndex: null };
}

function sendViaLanTcp(buffer, { host, port = 9100, timeoutMs = 5000 }) {
    return new Promise((resolve, reject) => {
        if (!host) return reject(new Error('Chưa cấu hình IP máy in LAN (host)!'));
        const socket = new net.Socket();
        let finished = false;
        const done = (err) => {
            if (finished) return;
            finished = true;
            socket.destroy();
            if (err) reject(err);
            else resolve({ transport: 'LAN_TCP', target: `${host}:${port}`, bytes: buffer.length });
        };

        socket.setTimeout(timeoutMs);
        socket.on('timeout', () => done(new Error(`Máy in LAN ${host}:${port} không phản hồi (timeout ${timeoutMs}ms)`)));
        socket.on('error', (err) => done(new Error(`Lỗi kết nối máy in LAN ${host}:${port}: ${err.message}`)));
        socket.connect(Number(port) || 9100, host, () => {
            socket.write(buffer, () => {
                socket.end();
                done(null);
            });
        });
    });
}

function querySingleByteOverTcp(commandBuf, { host, port = 9100, timeoutMs = 1500 }) {
    return new Promise((resolve, reject) => {
        if (!host) return reject(new Error('Thiếu IP máy in'));
        const socket = new net.Socket();
        let settled = false;
        const finish = (err, byteVal) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            if (err) reject(err);
            else resolve(byteVal);
        };
        socket.setTimeout(timeoutMs);
        socket.on('timeout', () => finish(new Error('Printer sensor timeout')));
        socket.on('error', (e) => finish(e));
        socket.on('data', (chunk) => {
            if (chunk && chunk.length > 0) finish(null, chunk[0]);
        });
        socket.connect(Number(port) || 9100, host, () => {
            socket.write(commandBuf);
        });
    });
}

/**
 * Kiểm tra cảm biến ESC/POS (Bill K80):
 * - DLE EOT 4 (0x10 0x04 0x04): Paper roll sensor (bit 5,6 = 1 => hết giấy)
 * - DLE EOT 2 (0x10 0x04 0x02): Offline/Cover status (bit 2 = mở nắp, bit 5 = dừng lỗi)
 */
async function queryEscPosStatus(printerConfig) {
    const mode = String(printerConfig?.mode || 'SIMULATOR').toUpperCase();
    if (mode === 'SIMULATOR') {
        const sim = simulatedSensors.receipt;
        if (sim.offline) {
            return { ready: false, statusCode: 0xff, label: 'PRINTER_OFFLINE', message: 'Máy in Bill mất kết nối (mô phỏng)' };
        }
        if (sim.statusCode !== 0x00) {
            return {
                ready: false,
                statusCode: sim.statusCode,
                label: TSPL_STATUS_LABELS[sim.statusCode] || 'ERROR',
                message: `Cảm biến máy in Bill báo lỗi (0x${sim.statusCode.toString(16).padStart(2, '0')})`,
            };
        }
        return { ready: true, statusCode: 0x00, label: 'READY', message: 'Sẵn sàng' };
    }
    if (mode !== 'LAN_TCP') {
        return { ready: true, statusCode: 0x00, label: 'READY', message: 'Bỏ qua sensor cho Windows Share' };
    }
    if (printerConfig?.sensorProbeEnabled !== true) {
        return { ready: true, statusCode: 0x00, label: 'READY', message: 'Bỏ qua sensor probe LAN (sensorProbeEnabled=false)' };
    }
    try {
        const bPaper = await querySingleByteOverTcp(Buffer.from([0x10, 0x04, 0x04]), printerConfig);
        if ((bPaper & 0x60) === 0x60) {
            return { ready: false, statusCode: 0x04, label: 'OUT_OF_PAPER', message: 'Máy in Bill K80 hết giấy!' };
        }
        const bCover = await querySingleByteOverTcp(Buffer.from([0x10, 0x04, 0x02]), printerConfig);
        if ((bCover & 0x04) !== 0) {
            return { ready: false, statusCode: 0x01, label: 'HEAD_OPEN', message: 'Nắp máy in Bill K80 đang mở!' };
        }
        return { ready: true, statusCode: 0x00, label: 'READY', message: 'Sẵn sàng' };
    } catch (err) {
        return { ready: false, statusCode: 0xff, label: 'PRINTER_OFFLINE', message: err.message };
    }
}

/**
 * Kiểm tra cảm biến máy in tem TSPL (<ESC>!? -> 0x1B 0x21 0x3F):
 *   0x00 = Ready
 *   0x01 = Head open
 *   0x02 = Paper jam
 *   0x04 = Out of paper
 *   0x08 = Out of ribbon
 */
async function queryTsplStatus(printerConfig, { cupIndex = null } = {}) {
    const mode = String(printerConfig?.mode || 'SIMULATOR').toUpperCase();
    if (mode === 'SIMULATOR') {
        const sim = simulatedSensors.label;
        if (sim.offline) {
            return { ready: false, statusCode: 0xff, label: 'PRINTER_OFFLINE', message: 'Máy in tem mất kết nối (mô phỏng)' };
        }
        // Nếu test cấu hình kẹt giấy tại đúng cupIndex (VD: kẹt tại ly 3/4) -> tự động bật statusCode 0x02!
        if (sim.jamAtCupIndex !== null && cupIndex !== null && Number(cupIndex) === Number(sim.jamAtCupIndex)) {
            sim.statusCode = 0x02;
            sim.jamAtCupIndex = null;
        }
        if (sim.statusCode !== 0x00) {
            const lbl = TSPL_STATUS_LABELS[sim.statusCode] || 'SENSOR_ERROR';
            return {
                ready: false,
                statusCode: sim.statusCode,
                label: lbl,
                message: `Máy in tem TSPL báo lỗi cảm biến: ${lbl} (0x${sim.statusCode.toString(16).padStart(2, '0')})`,
            };
        }
        return { ready: true, statusCode: 0x00, label: 'READY', message: 'Sẵn sàng' };
    }
    if (mode !== 'LAN_TCP') {
        return { ready: true, statusCode: 0x00, label: 'READY', message: 'Bỏ qua sensor cho Windows Share' };
    }
    if (printerConfig?.sensorProbeEnabled !== true) {
        return { ready: true, statusCode: 0x00, label: 'READY', message: 'Bỏ qua sensor probe LAN (sensorProbeEnabled=false)' };
    }
    try {
        const statusByte = await querySingleByteOverTcp(Buffer.from([0x1b, 0x21, 0x3f]), printerConfig);
        const ready = statusByte === 0x00;
        const label = TSPL_STATUS_LABELS[statusByte] || (ready ? 'READY' : 'SENSOR_ERROR');
        return {
            ready,
            statusCode: statusByte,
            label,
            message: ready ? 'Sẵn sàng' : `Máy in tem TSPL báo lỗi: ${label} (0x${statusByte.toString(16).padStart(2, '0')})`,
        };
    } catch (err) {
        return { ready: false, statusCode: 0xff, label: 'PRINTER_OFFLINE', message: err.message };
    }
}

function sendViaWindowsShare(buffer, { shareName }) {
    return new Promise((resolve, reject) => {
        if (!shareName) return reject(new Error('Chưa nhập tên chia sẻ máy in Windows (shareName)!'));
        const rawShare = String(shareName).trim();
        if (rawShare.startsWith('\\\\') || rawShare.startsWith('//') || rawShare.includes('\\') || rawShare.includes('/')) {
            return reject(new Error('Tên chia sẻ máy in Windows (shareName) không hợp lệ — từ chối đường dẫn UNC từ xa!'));
        }
        const safeShare = rawShare.replace(/[^a-zA-Z0-9._\-\s]/g, '').trim();
        if (!safeShare) {
            return reject(new Error('Tên chia sẻ máy in Windows (shareName) không hợp lệ!'));
        }
        if (process.platform !== 'win32') {
            return reject(new Error('Chế độ WINDOWS_SHARE chỉ chạy trên Windows!'));
        }
        const uncPath = `\\\\localhost\\${safeShare}`;
        const tmpFile = path.join(os.tmpdir(), `pos-print-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.bin`);

        fs.writeFile(tmpFile, buffer, (writeErr) => {
            if (writeErr) return reject(writeErr);
            execFile('cmd.exe', ['/c', 'copy', '/b', tmpFile, uncPath], { timeout: 8000 }, (err, stdout, stderr) => {
                fs.unlink(tmpFile, () => {});
                if (err) {
                    return reject(new Error(`Lỗi gửi máy in Windows (${uncPath}): ${stderr || err.message}`));
                }
                resolve({ transport: 'WINDOWS_SHARE', target: uncPath, bytes: buffer.length, output: stdout.trim() });
            });
        });
    });
}

async function dispatchRawBuffer(buffer, printerConfig) {
    const mode = String(printerConfig?.mode || 'SIMULATOR').toUpperCase();
    if (mode === 'LAN_TCP') {
        return sendViaLanTcp(buffer, printerConfig);
    }
    if (mode === 'WINDOWS_SHARE') {
        return sendViaWindowsShare(buffer, printerConfig);
    }
    return {
        transport: 'SIMULATOR',
        target: printerConfig?.name || 'VIRTUAL_THERMAL_PRINTER',
        bytes: buffer.length,
    };
}

module.exports = {
    TSPL_STATUS_LABELS,
    dispatchRawBuffer,
    queryEscPosStatus,
    queryTsplStatus,
    setSimulatedSensorStatus,
    getSimulatedSensorStatus,
    resetSimulatedSensors,
};
