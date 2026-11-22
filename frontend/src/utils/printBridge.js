// Hệ thống Điều phối Phần cứng In Ấn & Ngăn Kéo Tiền RJ11 Đa Tầng (Multi-Tier Hardware Print Transport):
// 1. LOCAL_BRIDGE: Silent Print qua Local Print Bridge Agent (http://127.0.0.1:9100)
// 2. CLOUD_RELAY: Cloud-to-Local Print Relay qua HTTPS Backend (/api/print-relay/dispatch) — giải quyết triệt để Mixed Content & PNA cho iPad / Android Tablet!
// 3. WEB_SERIAL / WEB_USB: Driver in trực tiếp từ trình duyệt Chrome/Edge xuống máy in nhiệt USB/COM không cần cài phần mềm
// 4. ANDROID_RAWBT: In ngầm không hộp thoại trên máy tính bảng Android / máy POS cầm tay Sunmi qua giao thức rawbt:base64

import axiosClient from '../api/axiosClient'

const BRIDGE_SETTINGS_KEY = 'pos_print_bridge_settings'

let activeSerialPort = null
let activeUsbDevice = null
let activeBleCharacteristic = null

const BLE_PRINTER_SERVICE_UUIDS = [
  '000018f0-0000-1000-8000-00805f9b34fb', // Chuẩn máy in nhiệt BLE phổ biến (Xprinter / HPRT / Gprinter)
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC / Microchip BLE UART
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Star / POS Thermal BLE
  '0000ff00-0000-1000-8000-00805f9b34fb', // Generic BLE Thermal Printer
]

export function getBridgeClientSettings() {
  try {
    const raw = localStorage.getItem(BRIDGE_SETTINGS_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return {
      enabled: parsed.enabled !== false,
      url: (parsed.url || 'http://127.0.0.1:9100').replace(/\/+$/, ''),
      token: String(parsed.token || '').trim(),
      transportMode: parsed.transportMode || 'AUTO', // 'AUTO' | 'LOCAL_BRIDGE' | 'CLOUD_RELAY' | 'WEB_SERIAL' | 'WEB_USB' | 'ANDROID_RAWBT'
      cloudRelayFallback: Boolean(parsed.cloudRelayFallback),
      serialBaudRate: Number(parsed.serialBaudRate || 9600),
    }
  } catch {
    return {
      enabled: true,
      url: 'http://127.0.0.1:9100',
      token: '',
      transportMode: 'AUTO',
      cloudRelayFallback: false,
      serialBaudRate: 9600,
    }
  }
}

export function saveBridgeClientSettings(settings) {
  const prev = getBridgeClientSettings()
  const next = {
    ...prev,
    ...settings,
    enabled: settings.enabled !== false,
    url: String(settings.url || prev.url || 'http://127.0.0.1:9100').replace(/\/+$/, ''),
    token: String(settings.token !== undefined ? settings.token : prev.token || '').trim(),
    transportMode: settings.transportMode || prev.transportMode || 'AUTO',
    cloudRelayFallback:
      settings.cloudRelayFallback !== undefined
        ? Boolean(settings.cloudRelayFallback)
        : prev.cloudRelayFallback,
    serialBaudRate: Number(settings.serialBaudRate || prev.serialBaudRate || 9600),
  }
  localStorage.setItem(BRIDGE_SETTINGS_KEY, JSON.stringify(next))
  return next
}

// ============================================================================
// BỘ DỰNG LỆNH NHỊ PHÂN ESC/POS TRỰC TIẾP TRÊN TRÌNH DUYỆT (Cho WebSerial / WebUSB / Android RawBT)
// ============================================================================
function boDauAscii(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^\x20-\x7E\n]/g, ' ')
}

function fmtMoneyAscii(n) {
  const num = Math.round(Number(n) || 0)
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + 'd'
}

function padTwoColsAscii(left, right, width = 48) {
  const l = boDauAscii(left)
  const r = boDauAscii(right)
  const space = Math.max(1, width - l.length - r.length)
  if (l.length + r.length + 1 > width) {
    return l.slice(0, Math.max(1, width - r.length - 1)) + ' ' + r
  }
  return l + ' '.repeat(space) + r
}

export function buildBrowserCashDrawerKickBytes() {
  // ESC @ (init) + ESC p 0 25 250 (xung mở két RJ11)
  return new Uint8Array([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa])
}

export function buildBrowserEscPosReceiptBytes({
  hoaDon,
  tenQuan = 'QUAN CA PHE POS',
  soLanIn = 1,
  laBanSao = false,
  laTamTinh = false,
  laDonOffline = false,
  thuNgan = '',
  isCashPayment = false,
  kickDrawer = undefined,
  showPlgWatermark = false,
  plgReferralUrl = '',
}) {
  const encoder = new TextEncoder()
  const byteList = []
  const LINE = '-'.repeat(48)

  const pushBytes = (...bytes) => byteList.push(...bytes)
  const pushLine = (text = '') => {
    const encoded = encoder.encode(boDauAscii(text) + '\n')
    for (let i = 0; i < encoded.length; i++) byteList.push(encoded[i])
  }

  const shouldKick = kickDrawer !== undefined ? Boolean(kickDrawer) : Boolean(isCashPayment)
  pushBytes(0x1b, 0x40) // ESC @ Init
  if (shouldKick) {
    pushBytes(0x1b, 0x70, 0x00, 0x19, 0xfa) // RJ11 Cash Drawer Kick
  }

  // Header
  pushBytes(0x1b, 0x61, 0x01) // Center
  pushBytes(0x1b, 0x45, 0x01) // Bold ON
  pushBytes(0x1d, 0x21, 0x11) // Double width & height
  pushLine(boDauAscii(tenQuan).toUpperCase())
  pushBytes(0x1d, 0x21, 0x00)
  pushBytes(0x1b, 0x45, 0x00)

  const maHD = hoaDon?.maHoaDon || 'TEST'
  const tenBan = hoaDon?.ban?.map((b) => b.tenBan).join(', ') || 'Mang di'
  const sttNum = Number(hoaDon?.soThuTuNgay)
  if (Number.isInteger(sttNum) && sttNum > 0) {
    pushBytes(0x1b, 0x45, 0x01)
    pushBytes(0x1d, 0x21, 0x11)
    pushLine(`SO #${String(sttNum).padStart(2, '0')}`)
    pushBytes(0x1d, 0x21, 0x00)
    pushBytes(0x1b, 0x45, 0x00)
  }
  pushLine(`HD: #${maHD} | ${tenBan}`)

  if (laDonOffline || hoaDon?.offline) {
    pushBytes(0x1b, 0x45, 0x01)
    pushLine('*** DON OFFLINE - DANG CHO DONG BO ***')
    pushBytes(0x1b, 0x45, 0x00)
  } else if (laTamTinh) {
    pushBytes(0x1b, 0x45, 0x01)
    pushLine('*** PHIEU TAM TINH (CHUA THANH TOAN) ***')
    pushBytes(0x1b, 0x45, 0x00)
  } else if (laBanSao) {
    pushBytes(0x1b, 0x45, 0x01)
    pushLine(`*** BAN SAO - REPRINT (LAN ${Number(soLanIn)}) ***`)
    pushBytes(0x1b, 0x45, 0x00)
  }

  pushBytes(0x1b, 0x61, 0x00) // Align Left
  const gio = new Date(hoaDon?.thoiGianTao || hoaDon?.thoigiantao || Date.now()).toLocaleString('vi-VN')
  pushLine(`Gio: ${gio}`)
  if (thuNgan) pushLine(`Thu ngan: ${thuNgan}`)
  pushLine(LINE)
  pushBytes(0x1b, 0x45, 0x01)
  pushLine(padTwoColsAscii('MON / SL', 'THANH TIEN'))
  pushBytes(0x1b, 0x45, 0x00)
  pushLine(LINE)

  const items = (hoaDon?.danhSachMon || []).filter((m) => !m.daHuy && m.trangThaiPhaChe !== 'DaHuy')
  for (const m of items) {
    pushLine(padTwoColsAscii(`${m.tenMon} (${m.kichThuoc}) x${m.soLuong}`, fmtMoneyAscii(m.thanhTien)))
    if (m.toppings?.length) {
      pushLine('  + ' + m.toppings.map((t) => `${t.tenTopping} x${t.soLuong}`).join(', '))
    }
    if (m.ghiChu) {
      pushLine(`  (${m.ghiChu})`)
    }
  }

  pushLine(LINE)
  const tongCong = hoaDon?.tongTienThanhToan ?? hoaDon?.tongSauGiam ?? hoaDon?.tongTamTinh ?? 0
  pushBytes(0x1b, 0x45, 0x01)
  pushBytes(0x1d, 0x21, 0x01)
  pushLine(padTwoColsAscii('TONG CONG:', fmtMoneyAscii(tongCong)))
  pushBytes(0x1d, 0x21, 0x00)
  pushBytes(0x1b, 0x45, 0x00)

  pushLine(LINE)
  pushBytes(0x1b, 0x61, 0x01)
  const maDoiChieu = String(maHD).slice(-4).toUpperCase()
  const gioIn = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  pushBytes(0x1b, 0x45, 0x01)
  pushLine(`MA DOI CHIEU: #${maDoiChieu} | GIO IN: ${gioIn}`)
  pushBytes(0x1b, 0x45, 0x00)
  pushLine('Quy khach vui long kiem tra DUNG GIO IN & STT')
  pushLine('Cam on Quy khach & Hen gap lai!')
  if (showPlgWatermark) {
    const refUrl = String(plgReferralUrl || 'https://cafepos.vn/onboarding').trim()
    pushLine(LINE)
    pushBytes(0x1b, 0x45, 0x01)
    pushLine('Phan mem CafePOS - MIEN PHI 400 don/thang')
    pushBytes(0x1b, 0x45, 0x00)
    pushLine('Quet QR dung thu 30s cho chu quan:')
    const qrBytes = encoder.encode(refUrl)
    const storeLen = qrBytes.length + 3
    pushBytes(0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00)
    pushBytes(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x04)
    pushBytes(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31)
    pushBytes(0x1d, 0x28, 0x6b, storeLen & 0xff, (storeLen >> 8) & 0xff, 0x31, 0x50, 0x30)
    for (let i = 0; i < qrBytes.length; i++) byteList.push(qrBytes[i])
    pushBytes(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30)
    pushLine(refUrl.replace(/^https?:\/\//i, '').slice(0, 48))
  }
  pushLine('')
  pushLine('')
  pushLine('')
  pushBytes(0x1d, 0x56, 0x42, 0x00) // GS V 66 0 Auto-cut

  return new Uint8Array(byteList)
}

// ============================================================================
// DRIVER TRÌNH DUYỆT: WebSerial, WebUSB & Android RawBT Intent
// ============================================================================
export function isWebSerialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator
}

export function isWebUsbSupported() {
  return typeof navigator !== 'undefined' && 'usb' in navigator
}

export function isWebBluetoothSupported() {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator
}

export async function connectWebBluetoothPrinter() {
  if (!isWebBluetoothSupported()) {
    throw new Error('Trình duyệt này không hỗ trợ WebBluetooth (Hãy dùng Chrome trên Android hoặc PC)!')
  }
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: BLE_PRINTER_SERVICE_UUIDS,
  })
  const server = await device.gatt.connect()
  let writableChar = null
  for (const uuid of BLE_PRINTER_SERVICE_UUIDS) {
    try {
      const service = await server.getPrimaryService(uuid)
      const chars = await service.getCharacteristics()
      writableChar = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse)
      if (writableChar) break
    } catch {
      // Thử UUID dịch vụ tiếp theo
    }
  }
  if (!writableChar) {
    throw new Error('Không tìm thấy GATT Characteristic ghi dữ liệu trên máy in Bluetooth này!')
  }
  activeBleCharacteristic = writableChar
  return {
    ok: true,
    mode: 'WEB_BLUETOOTH',
    deviceName: device.name || 'Bluetooth Thermal Printer',
  }
}

async function sendViaWebBluetooth(uint8Bytes) {
  if (!activeBleCharacteristic) {
    throw new Error('Chưa ghép nối máy in WebBluetooth! Hãy mở mục Máy in -> Ghép máy in Bluetooth.')
  }
  // Chia gói 100 byte (hoặc 20 byte an toàn MTU BLE) để tránh tràn bộ đệm Bluetooth
  const CHUNK_SIZE = 80
  for (let offset = 0; offset < uint8Bytes.byteLength; offset += CHUNK_SIZE) {
    const chunk = uint8Bytes.slice(offset, offset + CHUNK_SIZE)
    if (activeBleCharacteristic.properties.writeWithoutResponse) {
      await activeBleCharacteristic.writeValueWithoutResponse(chunk)
    } else {
      await activeBleCharacteristic.writeValue(chunk)
    }
  }
  return {
    ok: true,
    mode: 'WEB_BLUETOOTH',
    job: { transport: 'WEB_BLUETOOTH', bytes: uint8Bytes.byteLength },
  }
}

export async function connectWebSerialPrinter() {
  if (!isWebSerialSupported()) {
    throw new Error('Trình duyệt này không hỗ trợ WebSerial (Hãy dùng Chrome hoặc Edge trên PC/Android)!')
  }
  const port = await navigator.serial.requestPort()
  const { serialBaudRate } = getBridgeClientSettings()
  if (!port.readable && !port.writable) {
    await port.open({ baudRate: Number(serialBaudRate || 9600) })
  }
  activeSerialPort = port
  return { ok: true, mode: 'WEB_SERIAL' }
}

async function sendViaWebSerial(uint8Bytes) {
  if (!isWebSerialSupported()) {
    throw new Error('Trình duyệt không hỗ trợ WebSerial')
  }
  let port = activeSerialPort
  if (!port) {
    const ports = await navigator.serial.getPorts()
    port = ports[0] || null
  }
  if (!port) {
    throw new Error('Chưa cấp quyền cổng COM/USB WebSerial cho máy in!')
  }
  const { serialBaudRate } = getBridgeClientSettings()
  if (!port.writable) {
    await port.open({ baudRate: Number(serialBaudRate || 9600) })
  }
  const writer = port.writable.getWriter()
  try {
    await writer.write(uint8Bytes)
  } finally {
    writer.releaseLock()
  }
  activeSerialPort = port
  return { ok: true, mode: 'WEB_SERIAL', job: { transport: 'WEB_SERIAL', bytes: uint8Bytes.byteLength } }
}

export async function connectWebUsbPrinter() {
  if (!isWebUsbSupported()) {
    throw new Error('Trình duyệt này không hỗ trợ WebUSB (Hãy dùng Chrome hoặc Edge)!')
  }
  const device = await navigator.usb.requestDevice({ filters: [] })
  await device.open()
  if (device.configuration === null) {
    await device.selectConfiguration(1)
  }
  await device.claimInterface(0)
  activeUsbDevice = device
  return {
    ok: true,
    mode: 'WEB_USB',
    productName: device.productName || 'USB Thermal Printer',
  }
}

async function sendViaWebUsb(uint8Bytes) {
  if (!isWebUsbSupported()) {
    throw new Error('Trình duyệt không hỗ trợ WebUSB')
  }
  let device = activeUsbDevice
  if (!device) {
    const devices = await navigator.usb.getDevices()
    device = devices[0] || null
  }
  if (!device) {
    throw new Error('Chưa kết nối máy in qua WebUSB!')
  }
  if (!device.opened) await device.open()
  if (device.configuration === null) await device.selectConfiguration(1)
  const iface = device.configuration.interfaces[0]
  await device.claimInterface(iface.interfaceNumber)
  const outEndpoint = iface.alternate.endpoints.find((e) => e.direction === 'out')
  if (!outEndpoint) {
    throw new Error('Không tìm thấy Bulk OUT Endpoint trên máy in USB!')
  }
  await device.transferOut(outEndpoint.endpointNumber, uint8Bytes)
  activeUsbDevice = device
  return { ok: true, mode: 'WEB_USB', job: { transport: 'WEB_USB', bytes: uint8Bytes.byteLength } }
}

function uint8ToBase64(uint8) {
  let binary = ''
  for (let i = 0; i < uint8.byteLength; i++) {
    binary += String.fromCharCode(uint8[i])
  }
  return btoa(binary)
}

export function sendViaAndroidRawBt(uint8Bytes) {
  if (typeof window === 'undefined') {
    throw new Error('Môi trường không hỗ trợ Android RawBT Intent')
  }
  const b64 = uint8ToBase64(uint8Bytes)
  const isAndroid = /Android/i.test(navigator.userAgent || '')
  const url = isAndroid
    ? `intent:base64,${b64}#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;`
    : `rawbt:base64,${b64}`
  window.location.href = url
  return { ok: true, mode: 'ANDROID_RAWBT', job: { transport: 'ANDROID_RAWBT', bytes: uint8Bytes.byteLength } }
}

// ============================================================================
// CLOUD-TO-LOCAL PRINT RELAY (iPad / Android Tablet trên HTTPS -> Backend -> LAN Bridge)
// ============================================================================
export async function dispatchCloudPrintRelay(kind, payload) {
  const res = await axiosClient.post('/print-relay/dispatch', { kind, payload }, { silent: true })
  return {
    ok: Boolean(res?.ok),
    mode: 'CLOUD_RELAY',
    job: res?.job || { transport: 'CLOUD_RELAY' },
  }
}

export async function getCloudPrintRelayStatus() {
  try {
    return await axiosClient.get('/print-relay/status', { silent: true })
  } catch {
    return { ok: false, bridgeActive: false, pendingCount: 0, jobs: [] }
  }
}

// ============================================================================
// LOCAL PRINT BRIDGE HTTP CLIENT & MULTI-TIER ROUTER
// ============================================================================
async function bridgeFetch(path, { method = 'GET', body = null, timeoutMs = 2500 } = {}) {
  const { url, token } = getBridgeClientSettings()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = {}
    if (body) headers['Content-Type'] = 'application/json'
    if (token) headers['X-Print-Bridge-Token'] = token
    const res = await fetch(`${url}${path}`, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data.error || `Print Bridge lỗi HTTP ${res.status}`)
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

export async function checkBridgeHealth() {
  const cfg = getBridgeClientSettings()
  try {
    const data = await bridgeFetch('/health', { timeoutMs: 1200 })
    return { online: Boolean(data?.ok), transportMode: cfg.transportMode, ...data }
  } catch {
    if (cfg.transportMode === 'CLOUD_RELAY' || cfg.cloudRelayFallback) {
      const relay = await getCloudPrintRelayStatus()
      if (relay?.bridgeActive) {
        return {
          online: true,
          viaCloudRelay: true,
          transportMode: 'CLOUD_RELAY',
          relayStatus: relay,
        }
      }
    }
    return { online: false, transportMode: cfg.transportMode }
  }
}

export async function saveBridgePrinterConfig(config) {
  return bridgeFetch('/config', { method: 'PUT', body: config, timeoutMs: 4000 })
}

export async function getBridgeJobs() {
  const data = await bridgeFetch('/jobs', { timeoutMs: 2500 })
  return data.jobs || []
}

export async function retryBridgeJob(jobId) {
  return bridgeFetch(`/jobs/${jobId}/retry`, { method: 'POST', timeoutMs: 6000 })
}

export async function bridgePrintReceipt(payload) {
  const cfg = getBridgeClientSettings()
  if (cfg.transportMode === 'CLOUD_RELAY') {
    return dispatchCloudPrintRelay('RECEIPT', payload)
  }
  if (cfg.transportMode === 'WEB_SERIAL') {
    return sendViaWebSerial(buildBrowserEscPosReceiptBytes(payload))
  }
  if (cfg.transportMode === 'WEB_USB') {
    return sendViaWebUsb(buildBrowserEscPosReceiptBytes(payload))
  }
  if (cfg.transportMode === 'WEB_BLUETOOTH') {
    return sendViaWebBluetooth(buildBrowserEscPosReceiptBytes(payload))
  }
  if (cfg.transportMode === 'ANDROID_RAWBT') {
    return sendViaAndroidRawBt(buildBrowserEscPosReceiptBytes(payload))
  }

  try {
    return await bridgeFetch('/print/receipt', { method: 'POST', body: payload, timeoutMs: 4500 })
  } catch (err) {
    if (cfg.cloudRelayFallback) {
      return dispatchCloudPrintRelay('RECEIPT', payload)
    }
    throw err
  }
}

export async function bridgePrintLabels(payload) {
  const cfg = getBridgeClientSettings()
  if (cfg.transportMode === 'CLOUD_RELAY') {
    return dispatchCloudPrintRelay('LABEL', payload)
  }
  try {
    return await bridgeFetch('/print/labels', { method: 'POST', body: payload, timeoutMs: 4500 })
  } catch (err) {
    if (cfg.cloudRelayFallback) {
      return dispatchCloudPrintRelay('LABEL', payload)
    }
    throw err
  }
}

export async function bridgePrintZReport(payload) {
  const cfg = getBridgeClientSettings()
  if (cfg.transportMode === 'CLOUD_RELAY') {
    return dispatchCloudPrintRelay('Z_REPORT', payload)
  }
  try {
    return await bridgeFetch('/print/z-report', { method: 'POST', body: payload, timeoutMs: 4500 })
  } catch (err) {
    if (cfg.cloudRelayFallback) {
      return dispatchCloudPrintRelay('Z_REPORT', payload)
    }
    throw err
  }
}

export async function bridgeKickDrawer({ reason = 'NO_SALE', actor = '' } = {}) {
  const cfg = getBridgeClientSettings()
  if (cfg.transportMode === 'CLOUD_RELAY') {
    return dispatchCloudPrintRelay('DRAWER_KICK', { reason, actor })
  }
  if (cfg.transportMode === 'WEB_SERIAL') {
    return sendViaWebSerial(buildBrowserCashDrawerKickBytes())
  }
  if (cfg.transportMode === 'WEB_USB') {
    return sendViaWebUsb(buildBrowserCashDrawerKickBytes())
  }
  if (cfg.transportMode === 'WEB_BLUETOOTH') {
    return sendViaWebBluetooth(buildBrowserCashDrawerKickBytes())
  }
  if (cfg.transportMode === 'ANDROID_RAWBT') {
    return sendViaAndroidRawBt(buildBrowserCashDrawerKickBytes())
  }
  try {
    return await bridgeFetch('/drawer/kick', { method: 'POST', body: { reason, actor }, timeoutMs: 3500 })
  } catch (err) {
    if (cfg.cloudRelayFallback) {
      return dispatchCloudPrintRelay('DRAWER_KICK', { reason, actor })
    }
    throw err
  }
}
