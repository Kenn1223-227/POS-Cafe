import axiosClient from '../api/axiosClient'
import {
  getAllOutboxJobs,
  updateOutboxJob,
  deleteOutboxJob,
  enqueueOutboxJob,
  generateOfflineClientId,
  getOrCreatePosDeviceId,
} from './offlineDb'
import { newIdempotencyKey } from '../utils/idempotency'
import { pushOrderToLanHub, markLanOrderSynced } from '../utils/lanHub'

// Nhận diện lỗi rớt mạng / mất kết nối / timeout (không có phản hồi HTTP từ server)
export function isNetworkError(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  if (!err) return false
  if (!err.response) return true
  return err.code === 'ECONNABORTED' || err.code === 'ERR_NETWORK'
}

// Dựng hóa đơn tạm cục bộ để in Bill K80 & Tem Cốc 50x30 ngay lập tức khi mất mạng (cô lập TenantId + DeviceId + ULID + Ca gốc)
export function buildOfflineOrderJob({
  type, // 'ORDER_CREATE' | 'QUICK_CHECKOUT' | 'INVOICE_PAY'
  payload,
  cart = [],
  existingInvoice = null,
  selectedTable = null,
  customer = null,
  promoPreview = null,
  idempotencyKey,
  tenantId = 'DEFAULT',
  maCaThuNganGoc = null,
}) {
  const now = new Date()
  const nowIso = now.toISOString()
  // [P0 FIX Phân hệ 7] OFF-${deviceId}-${YYYYMMDD}-${ULID_SHORT} chống trùng tuyệt đối giữa nhiều máy POS & nhiều ngày
  const shortId = generateOfflineClientId(now)
  const deviceId = getOrCreatePosDeviceId()
  const key = idempotencyKey || newIdempotencyKey()
  const cleanTenant = String(tenantId || 'DEFAULT')

  if (type === 'INVOICE_PAY' && existingInvoice) {
    const rawTotal = Number(existingInvoice.tongTamTinh || 0)
    const netTotal = Number(
      promoPreview?.tongSauGiam ??
        existingInvoice.conLaiCanThu ??
        existingInvoice.tongSauGiam ??
        rawTotal
    )
    const localInvoice = {
      ...existingInvoice,
      offline: true,
      offlineClientId: shortId,
      trangThaiTT: 1,
      phuongThucTT: payload.phuongThucTT || 'TIEN_MAT',
      khachHang: customer || existingInvoice.khachHang || null,
      tienGiamKM: promoPreview?.tienGiamKM ?? existingInvoice.tienGiamKM ?? 0,
      tienGiamDiem: promoPreview?.tienGiamDiem ?? existingInvoice.tienGiamDiem ?? 0,
      tongGiamGia: promoPreview?.tongGiamGia ?? existingInvoice.tongGiamGia ?? 0,
      tongTienThanhToan: netTotal,
    }
    const tableName =
      existingInvoice.ban?.map((b) => b.tenBan).join(', ') ||
      selectedTable?.tenBan ||
      `HĐ #${existingInvoice.maHoaDon}`

    return {
      id: `${shortId}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      deviceId,
      tenantId: cleanTenant,
      idempotencyKey: key,
      type: 'INVOICE_PAY',
      endpoint: '/order/thanhtoan',
      payload: {
        ...payload,
        maHoaDon: existingInvoice.maHoaDon,
        offlineCreatedAt: nowIso,
        offlineClientId: shortId,
        ...(maCaThuNganGoc ? { maCaThuNganGoc } : {}),
      },
      localInvoice,
      tableName,
      totalAmount: netTotal,
      status: 'PENDING',
      retryCount: 0,
      lastError: null,
      createdAt: nowIso,
    }
  }

  const danhSachMon = (cart || []).map((item, idx) => {
    const tpPerCup = (item.toppings || []).reduce(
      (s, t) => s + Number(t.donGia) * Number(t.soLuongMoiLy ?? t.soLuong ?? 1),
      0
    )
    const modPerCup = Number(item.giaModifiers || 0)
    const thanhTien = (Number(item.donGia) + modPerCup + tpPerCup) * Number(item.soLuong)
    return {
      maCTHD: `${shortId}-${idx + 1}`,
      maMon: item.maMon,
      tenMon: item.tenMon,
      kichThuoc: item.kichThuoc,
      tramCheBien: item.tramCheBien || 'BAR_CHINH',
      soLuong: Number(item.soLuong),
      donGia: Number(item.donGia),
      giaModifiers: modPerCup,
      modifiersSnapshot: Array.isArray(item.modifiers) ? item.modifiers : [],
      isTakeaway: Boolean(item.isTakeaway),
      courseNo: Number(item.courseNo || 1),
      fireStatus: item.fireStatus || 'FIRED',
      ghiChu: item.ghiChu || null,
      trangThaiPhaChe: 'ChoPhaChe',
      // [Trụ cột 2 FIX] Truyền soLuongMoiLy tách biệt với soLuongTong, KHÔNG nhân mất định lượng trên mỗi ly!
      toppings: (item.toppings || []).map((t) => {
        const soLuongMoiLy = Math.max(1, Number(t.soLuongMoiLy ?? t.soLuong ?? 1))
        const soLuongTong = soLuongMoiLy * Number(item.soLuong)
        return {
          maTopping: t.maTopping,
          tenTopping: t.tenTopping,
          soLuongMoiLy,
          soLuongTong,
          soLuong: soLuongTong,
          donGia: Number(t.donGia),
        }
      }),
      thanhTien,
    }
  })

  const rawTotal = danhSachMon.reduce((s, m) => s + m.thanhTien, 0)
  const netTotal = Number(promoPreview?.tongSauGiam ?? rawTotal)
  const localInvoice = {
    maHoaDon: shortId,
    offline: true,
    offlineClientId: shortId,
    trangThaiTT: type === 'QUICK_CHECKOUT' ? 1 : 0,
    phuongThucTT: payload.phuongThucTT || null,
    thoiGianTao: nowIso,
    ban: selectedTable ? [{ maBan: selectedTable.maBan, tenBan: selectedTable.tenBan }] : [],
    khachHang: customer || null,
    danhSachMon,
    tongTamTinh: rawTotal,
    tienGiamKM: promoPreview?.tienGiamKM || 0,
    tienGiamDiem: promoPreview?.tienGiamDiem || 0,
    tongGiamGia: promoPreview?.tongGiamGia || 0,
    tongTienThanhToan: type === 'QUICK_CHECKOUT' ? netTotal : null,
  }

  return {
    id: `${shortId}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    deviceId,
    tenantId: cleanTenant,
    idempotencyKey: key,
    type,
    endpoint: type === 'QUICK_CHECKOUT' ? '/order/quick-checkout' : '/order',
    payload: {
      ...payload,
      offlineCreatedAt: nowIso,
      offlineClientId: shortId,
      ...(maCaThuNganGoc ? { maCaThuNganGoc } : {}),
    },
    localInvoice,
    tableName: selectedTable?.tenBan || 'Mang đi',
    totalAmount: netTotal,
    status: 'PENDING', // 'PENDING' | 'SYNCING' | 'FAILED'
    retryCount: 0,
    lastError: null,
    createdAt: nowIso,
  }
}

export function isTimeoutError(err) {
  return Boolean(err && !err.response && (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '')))
}

// [Phân hệ 2 - Trụ cột 1] Trước khi đẩy sang LAN Hub sau lỗi timeout ECONNABORTED,
// kiểm tra nhanh xem Cloud Server đã thực sự commit đơn với clientOrderUid này chưa (timeout 2s)!
export async function probeOrderOnCloudByClientUid(clientOrderUid) {
  if (!clientOrderUid) return { exists: false }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { exists: false }
  try {
    const res = await axiosClient.get(`/order/by-client-uid/${encodeURIComponent(clientOrderUid)}`, {
      timeout: 2000,
      silent: true,
    })
    return res && res.exists ? res : { exists: false }
  } catch {
    return { exists: false }
  }
}

export async function saveOfflineOrder(params) {
  const key = params.idempotencyKey || newIdempotencyKey()
  // Nếu nguyên nhân là timeout ECONNABORTED -> thăm dò Cloud 2s để triệt tiêu đúp vé Cloud vs LAN Hub!
  if (params.triggerError && isTimeoutError(params.triggerError)) {
    const probe = await probeOrderOnCloudByClientUid(key)
    if (probe?.exists && probe.hoaDon) {
      return {
        alreadyCommittedOnCloud: true,
        maHoaDon: probe.maHoaDon,
        hoaDon: probe.hoaDon,
        clientOrderUid: key,
      }
    }
  }
  const job = buildOfflineOrderJob({ ...params, idempotencyKey: key })
  job.clientOrderUid = key
  if (job.payload) job.payload.clientOrderUid = key
  if (job.localInvoice) job.localInvoice.clientOrderUid = key
  await enqueueOutboxJob(job)
  // [Phân hệ 7 + 2] Đẩy song song sang Local-LAN POS Hub kèm clientOrderUid để Barista dedup tuyệt đối!
  void pushOrderToLanHub(job)
  return job
}

let isFlushing = false
const CLOCK_DRIFT_WARN_MS = 10 * 60 * 1000

function resolveBackendReadyUrl() {
  const base = String(axiosClient?.defaults?.baseURL || import.meta?.env?.VITE_API_URL || '').trim()
  if (base) {
    try {
      const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
      const parsed = new URL(base, origin)
      return `${parsed.origin}/api/ready`
    } catch {
      // Fallback sang relative URL nếu cấu hình không hợp lệ
    }
  }
  return '/api/ready'
}

/**
 * [Wave 3B — P1-02] So sánh đồng hồ thiết bị với header Date của Server trước khi sync Offline.
 * Nếu lệch > 10 phút -> trả cảnh báo rõ để thu ngân kiểm tra lại giờ thiết bị (tránh bị từ chối Happy Hour).
 */
export async function checkServerClockDrift() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { drifted: false, driftMs: 0, warning: null }
  }
  try {
    const res = await fetch(resolveBackendReadyUrl(), { method: 'GET', cache: 'no-store' })
    const serverDateHeader = res?.headers?.get('date')
    if (!serverDateHeader) return { drifted: false, driftMs: 0, warning: null }
    const serverMs = Date.parse(serverDateHeader)
    if (!Number.isFinite(serverMs)) return { drifted: false, driftMs: 0, warning: null }
    const driftMs = Math.abs(Date.now() - serverMs)
    const driftMinutes = Math.round((driftMs / 60000) * 10) / 10
    if (driftMs > CLOCK_DRIFT_WARN_MS) {
      return {
        drifted: true,
        driftMs,
        driftMinutes,
        warning: `⏰ Cảnh báo lệch đồng hồ thiết bị ${driftMinutes} phút (> 10 phút) so với máy chủ! Khuyến mãi theo khung giờ (Happy Hour) sẽ không tự động áp dụng khi đồng bộ.`,
      }
    }
    return { drifted: false, driftMs, driftMinutes, warning: null }
  } catch {
    return { drifted: false, driftMs: 0, warning: null }
  }
}

// Đồng bộ tuần tự FIFO toàn bộ hàng đợi Outbox của đúng Tenant hiện tại lên Server (an toàn Idempotency-Key + Silent Refresh Token)
export async function flushOutboxQueue({ tenantId = null, includeFailed = false, onUpdate } = {}) {
  if (isFlushing) return { synced: 0, failed: 0, skipped: true }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { synced: 0, failed: 0, offline: true }
  }

  isFlushing = true
  let synced = 0
  let failed = 0
  let authExpired = false
  let shiftNotOpen = false
  const shiftWarnings = []
  let clockDriftWarning = null

  try {
    const clockStatus = await checkServerClockDrift()
    if (clockStatus.drifted && clockStatus.warning) {
      clockDriftWarning = clockStatus.warning
      shiftWarnings.push(clockStatus.warning)
    }
    const jobs = await getAllOutboxJobs(tenantId)
    const targets = jobs.filter((j) => j.status === 'PENDING' || (includeFailed && j.status === 'FAILED'))

    for (const job of targets) {
      if (typeof navigator !== 'undefined' && !navigator.onLine) break

      await updateOutboxJob(job.id, { status: 'SYNCING', lastError: null })
      if (onUpdate) onUpdate(await getAllOutboxJobs(tenantId))

      try {
        const res = await axiosClient.post(job.endpoint, job.payload, {
          silent: true,
          headers: {
            'Idempotency-Key': job.idempotencyKey,
            'X-Offline-Sync': '1',
          },
        })
        if (res?.canhBaoLechCa) {
          shiftWarnings.push(`${job.payload?.offlineClientId || job.id}: ${res.canhBaoLechCa}`)
        }
        // Thông báo LAN Hub đã đồng bộ lên Cloud để dọn vé trùng trên màn hình Barista LAN
        if (job.payload?.offlineClientId) {
          void markLanOrderSynced(job.payload.offlineClientId)
        }
        // 201 mới tạo hoặc 200 trùng Idempotency-Key => đều đã có trên Server an toàn
        await deleteOutboxJob(job.id)
        synced += 1
      } catch (err) {
        if (isNetworkError(err)) {
          // Mạng lại rớt giữa chừng => trả về PENDING để tự đẩy lại sau
          await updateOutboxJob(job.id, {
            status: 'PENDING',
            retryCount: (job.retryCount || 0) + 1,
            lastError: 'Mạng chập chờn, sẽ tự thử lại khi ổn định',
          })
          break
        }

        const status = err.response?.status
        const maLoi = err.response?.data?.maLoi || err.response?.data?.code
        const msg = err.response?.data?.message || 'Lỗi nghiệp vụ khi đồng bộ đơn'

        // Chưa mở ca thu ngân mới sau khi ca cũ đã đóng -> giữ PENDING (KHÔNG đánh FAILED!) để tự xả ngay khi thu ngân mở ca!
        if (status === 409 && (maLoi === 'SHIFT_NOT_OPEN_FOR_SYNC' || maLoi === 'CHUA_MO_CA')) {
          await updateOutboxJob(job.id, {
            status: 'PENDING',
            lastError: 'Chưa mở ca thu ngân hiện tại — hãy mở ca mới, đơn sẽ tự động đồng bộ!',
          })
          shiftNotOpen = true
          break
        }

        // [P0 FIX] Nếu Refresh Token cũng đã hết hạn/bị thu hồi (sau khi axiosClient đã thử silent refresh) -> giữ PENDING chờ đăng nhập/PIN lại
        if (status === 401 || (status === 403 && /^Token/i.test(msg))) {
          await updateOutboxJob(job.id, {
            status: 'PENDING',
            lastError: 'Phiên đăng nhập đã hết hạn — mở khóa bằng PIN hoặc đăng nhập lại để đồng bộ đơn Offline',
          })
          authExpired = true
          break
        }

        // Lỗi nghiệp vụ 4xx thực sự (vd món bị xóa, không đủ quyền) => đánh dấu FAILED để nhân viên kiểm tra
        await updateOutboxJob(job.id, {
          status: 'FAILED',
          retryCount: (job.retryCount || 0) + 1,
          lastError: msg,
        })
        failed += 1
      }

      if (onUpdate) onUpdate(await getAllOutboxJobs(tenantId))
    }
  } finally {
    isFlushing = false
    if (onUpdate) onUpdate(await getAllOutboxJobs(tenantId))
  }

  return { synced, failed, authExpired, shiftNotOpen, shiftWarnings, clockDriftWarning }
}
