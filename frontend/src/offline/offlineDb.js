// Lớp lưu trữ IndexedDB cục bộ cho Cafe POS Offline-First & Persistent Print Queue (0 thư viện ngoài)
const DB_NAME = 'CafePosOfflineDB'
const DB_VERSION = 2
const STORE_CATALOG = 'catalog_cache'
const STORE_OUTBOX = 'outbox_queue'
const STORE_PRINT_JOBS = 'print_jobs'
const POS_DEVICE_ID_KEY = 'pos_device_id'

const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford Base32 (không nhầm I/L/O/U)

// [P0 FIX Phân hệ 7] Sinh mã định danh trình duyệt/máy POS 4 ký tự cố định lưu localStorage
export function getOrCreatePosDeviceId() {
  try {
    if (typeof localStorage !== 'undefined') {
      const existing = localStorage.getItem(POS_DEVICE_ID_KEY)
      if (existing && /^[A-Z0-9]{4}$/.test(existing)) return existing
    }
  } catch {
    // ignore private mode
  }

  let out = ''
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(4)
    crypto.getRandomValues(bytes)
    for (let i = 0; i < 4; i++) out += BASE32_ALPHABET[bytes[i] % BASE32_ALPHABET.length]
  } else {
    for (let i = 0; i < 4; i++) out += BASE32_ALPHABET[Math.floor(Math.random() * BASE32_ALPHABET.length)]
  }

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(POS_DEVICE_ID_KEY, out)
    }
  } catch {
    // ignore
  }
  return out
}

// [P0 FIX Phân hệ 7] Sinh mã hóa đơn Offline chống trùng 100%: OFF-${deviceId}-${YYYYMMDD}-${ULID_SHORT}
export function generateOfflineClientId(now = new Date()) {
  const deviceId = getOrCreatePosDeviceId()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const yyyymmdd = `${y}${m}${d}`

  // 8 ký tự ULID ngắn (3 ký tự thời gian trong ngày Base32 + 5 ký tự ngẫu nhiên từ Web Crypto / UUID)
  let ulidShort
  const secOfDay = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
  const msPart = Math.floor(now.getMilliseconds() / 4) // 0..249
  const timeVal = (secOfDay * 250 + msPart) % (32 * 32 * 32 * 32)
  let t = timeVal
  let timeChars = ''
  for (let i = 0; i < 3; i++) {
    timeChars = BASE32_ALPHABET[t % 32] + timeChars
    t = Math.floor(t / 32)
  }

  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    const randHex = crypto.randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()
    ulidShort = `${timeChars}${randHex}`
  } else if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(5)
    crypto.getRandomValues(bytes)
    let randChars = ''
    for (let i = 0; i < 5; i++) randChars += BASE32_ALPHABET[bytes[i] % 32]
    ulidShort = `${timeChars}${randChars}`
  } else {
    ulidShort = `${timeChars}${Math.random().toString(36).slice(2, 7).toUpperCase().padEnd(5, 'X')}`
  }

  return `OFF-${deviceId}-${yyyymmdd}-${ulidShort}`
}

function notifyPrintQueueChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pos:print-queue-changed'))
  }
}

let dbPromise = null

function openDb() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB không khả dụng trên trình duyệt này'))
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (e) => {
        const db = e.target.result
        if (!db.objectStoreNames.contains(STORE_CATALOG)) {
          db.createObjectStore(STORE_CATALOG, { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
          const store = db.createObjectStore(STORE_OUTBOX, { keyPath: 'id' })
          store.createIndex('createdAt', 'createdAt', { unique: false })
        }
        if (!db.objectStoreNames.contains(STORE_PRINT_JOBS)) {
          const pStore = db.createObjectStore(STORE_PRINT_JOBS, { keyPath: 'id' })
          pStore.createIndex('createdAt', 'createdAt', { unique: false })
          pStore.createIndex('status', 'status', { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => {
        dbPromise = null
        reject(req.error)
      }
    })
  }
  return dbPromise
}

async function runTx(storeName, mode, fn) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const store = tx.objectStore(storeName)
    let result
    try {
      result = fn(store)
    } catch (err) {
      reject(err)
      return
    }
    tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'))
  })
}

const scopeKey = (tenantId, key) => `${String(tenantId || 'DEFAULT')}:${key}`

// ---- 1. Catalog Cache (Menu, Sizes, Toppings, Tables, Shift, Promotions, Customers — cô lập theo TenantId) ----
export async function saveCatalogSnapshot(entries, tenantId = 'DEFAULT') {
  try {
    const now = new Date().toISOString()
    await runTx(STORE_CATALOG, 'readwrite', (store) => {
      Object.entries(entries).forEach(([key, data]) => {
        store.put({ key: scopeKey(tenantId, key), tenantId: String(tenantId || 'DEFAULT'), data, updatedAt: now })
      })
    })
  } catch {
    // Không làm gián đoạn luồng chính nếu private mode chặn IndexedDB
  }
}

export async function loadCatalogSnapshot(keys, tenantId = 'DEFAULT') {
  try {
    const db = await openDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_CATALOG, 'readonly')
      const store = tx.objectStore(STORE_CATALOG)
      const out = {}
      let latestUpdatedAt = null
      keys.forEach((k) => {
        const req = store.get(scopeKey(tenantId, k))
        req.onsuccess = () => {
          if (req.result) {
            out[k] = req.result.data
            if (!latestUpdatedAt || req.result.updatedAt > latestUpdatedAt) {
              latestUpdatedAt = req.result.updatedAt
            }
          }
        }
      })
      tx.oncomplete = () => resolve({ data: out, updatedAt: latestUpdatedAt })
      tx.onerror = () => resolve({ data: {}, updatedAt: null })
    })
  } catch {
    return { data: {}, updatedAt: null }
  }
}

// [Phân hệ 7] Tra cứu Khách hàng thân thiết trực tiếp từ IndexedDB khi mất mạng
export async function searchCachedCustomers(tenantId = 'DEFAULT', query = '') {
  const q = String(query || '').trim()
  if (!q) return []
  const { data } = await loadCatalogSnapshot(['customers'], tenantId)
  const list = Array.isArray(data.customers) ? data.customers : []
  const cleanDigits = q.replace(/\D/g, '')
  const lower = q.toLowerCase()

  // Khớp chính xác SĐT trước
  const exact = list.filter((c) => String(c.soDienThoai || '').trim() === q)
  if (exact.length > 0) return exact

  // Khớp 4 số cuối SĐT
  if (cleanDigits.length === 4) {
    const byLast4 = list.filter((c) => String(c.soDienThoai || '').replace(/\D/g, '').endsWith(cleanDigits))
    if (byLast4.length > 0) return byLast4.slice(0, 5)
  }

  // Khớp theo chuỗi con SĐT hoặc tên khách
  return list
    .filter(
      (c) =>
        String(c.soDienThoai || '').includes(q) ||
        String(c.tenKH || '').toLowerCase().includes(lower)
    )
    .slice(0, 5)
}

// [Phân hệ 7] Tính ưu đãi Khuyến mãi & Điểm Loyalty cục bộ từ cache IndexedDB khi mất mạng
export function evaluateOfflinePromo({
  promotions = { happyHours: [], codes: [], vndMoiDiemDoi: 1000 },
  tongTamTinh = 0,
  maKhuyenMai = null,
  customer = null,
  diemSuDung = 0,
  tuDongHappyHour = true,
} = {}) {
  const subtotal = Math.max(0, Math.round(Number(tongTamTinh) || 0))
  const vndPerPoint = Number(promotions?.vndMoiDiemDoi || 1000)
  const codeInput = String(maKhuyenMai || '').trim().toUpperCase()
  const codes = Array.isArray(promotions?.codes) ? promotions.codes : []
  const happyHours = Array.isArray(promotions?.happyHours) ? promotions.happyHours : []

  const calcDiscount = (km) => {
    if (!km) return 0
    if (subtotal < Number(km.donToiThieu || 0)) return 0
    if (km.gioiHanLuotDung && Number(km.soLuotDaDung || 0) >= Number(km.gioiHanLuotDung)) return 0
    let giam =
      String(km.kieuGiam || '').toUpperCase() === 'PERCENT'
        ? Math.round((subtotal * Number(km.giaTriGiam || 0)) / 100)
        : Math.round(Number(km.giaTriGiam || 0))
    if (km.giamToiDa && giam > Number(km.giamToiDa)) giam = Number(km.giamToiDa)
    return Math.min(subtotal, Math.max(0, giam))
  }

  let appliedPromo = null
  let tienGiamKM = 0

  if (codeInput) {
    const matched = codes.find((c) => String(c.maCode || '').toUpperCase() === codeInput)
    if (!matched) {
      throw new Error(`Không tìm thấy mã "${codeInput}" trong dữ liệu khuyến mãi Offline!`)
    }
    if (subtotal < Number(matched.donToiThieu || 0)) {
      throw new Error(`Mã "${codeInput}" yêu cầu đơn tối thiểu ${Number(matched.donToiThieu).toLocaleString('vi-VN')}đ!`)
    }
    appliedPromo = matched
    tienGiamKM = calcDiscount(matched)
  } else if (tuDongHappyHour && happyHours.length > 0) {
    let best = null
    let bestVal = 0
    for (const hh of happyHours) {
      const val = calcDiscount(hh)
      if (val > bestVal) {
        bestVal = val
        best = hh
      }
    }
    appliedPromo = best
    tienGiamKM = bestVal
  }

  const conSauKM = Math.max(0, subtotal - tienGiamKM)
  const diemHienCo = Math.max(0, Math.floor(Number(customer?.diemTichLuy || 0)))
  const diemYeuCau = Math.max(0, Math.floor(Number(diemSuDung || 0)))
  const diemToiDaTheoTien = Math.floor(conSauKM / vndPerPoint)
  const diemThucTru = customer ? Math.min(diemYeuCau, diemHienCo, diemToiDaTheoTien) : 0
  const tienGiamDiem = diemThucTru * vndPerPoint
  const tongGiamGia = Math.min(subtotal, tienGiamKM + tienGiamDiem)
  const tongSauGiam = Math.max(0, subtotal - tongGiamGia)

  return {
    offlineEstimated: true,
    maKhuyenMai: appliedPromo?.maCode || (appliedPromo ? `HH#${appliedPromo.id}` : null),
    tenKhuyenMai: appliedPromo?.tenChuongTrinh || null,
    tienGiamKM,
    diemSuDung: diemThucTru,
    tienGiamDiem,
    diemHienCo,
    tongGiamGia,
    tongSauGiam,
    vndMoiDiemDoi: vndPerPoint,
  }
}

// ---- 2. Outbox Queue (Đơn hàng & Thanh toán tạo lúc rớt mạng chờ đồng bộ lên Server — cô lập theo TenantId) ----
export async function enqueueOutboxJob(job) {
  const scopedJob = { ...job, tenantId: String(job.tenantId || 'DEFAULT') }
  await runTx(STORE_OUTBOX, 'readwrite', (store) => store.put(scopedJob))
  // Đăng ký Background Sync nếu trình duyệt hỗ trợ
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.ready
      .then((reg) => {
        if ('sync' in reg) return reg.sync.register('pos-outbox-sync')
      })
      .catch(() => {})
  }
  return scopedJob
}

export async function getAllOutboxJobs(tenantId = null) {
  try {
    const list = await runTx(STORE_OUTBOX, 'readonly', (store) => store.getAll())
    const arr = Array.isArray(list) ? list : []
    const filtered = tenantId
      ? arr.filter((j) => String(j.tenantId || 'DEFAULT') === String(tenantId))
      : arr
    return filtered.sort((a, b) =>
      String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    )
  } catch {
    return []
  }
}

export async function updateOutboxJob(id, patch) {
  const existing = await runTx(STORE_OUTBOX, 'readonly', (store) => store.get(id))
  if (!existing) return null
  const updated = { ...existing, ...patch }
  await runTx(STORE_OUTBOX, 'readwrite', (store) => store.put(updated))
  return updated
}

export async function deleteOutboxJob(id) {
  await runTx(STORE_OUTBOX, 'readwrite', (store) => store.delete(id))
}

// ---- 3. Persistent Print Queue (Hàng đợi lệnh in bền vững lưu IndexedDB chống mất bill khi lỏng dây LAN / hết giấy) ----
export async function enqueueFailedPrintJob({
  tenantId = 'DEFAULT',
  kind = 'RECEIPT',
  maHoaDon = null,
  label = '',
  payload = {},
  error = 'Máy in không phản hồi',
}) {
  try {
    const now = new Date().toISOString()
    const job = {
      id: `PJ_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      tenantId: String(tenantId || 'DEFAULT'),
      kind: String(kind).toUpperCase(),
      maHoaDon: maHoaDon ? String(maHoaDon) : null,
      label: label || `${kind} #${maHoaDon || 'TEST'}`,
      payload,
      status: 'FAILED',
      error: String(error || 'Lỗi kết nối máy in'),
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    }
    await runTx(STORE_PRINT_JOBS, 'readwrite', (store) => store.put(job))
    notifyPrintQueueChanged()
    return job
  } catch {
    return null
  }
}

export async function getAllPersistentPrintJobs(tenantId = null) {
  try {
    const list = await runTx(STORE_PRINT_JOBS, 'readonly', (store) => store.getAll())
    const arr = Array.isArray(list) ? list : []
    const filtered = tenantId
      ? arr.filter((j) => String(j.tenantId || 'DEFAULT') === String(tenantId))
      : arr
    return filtered.sort((a, b) =>
      String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    )
  } catch {
    return []
  }
}

export async function updatePersistentPrintJob(id, patch) {
  try {
    const existing = await runTx(STORE_PRINT_JOBS, 'readonly', (store) => store.get(id))
    if (!existing) return null
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() }
    await runTx(STORE_PRINT_JOBS, 'readwrite', (store) => store.put(updated))
    notifyPrintQueueChanged()
    return updated
  } catch {
    return null
  }
}

export async function deletePersistentPrintJob(id) {
  try {
    await runTx(STORE_PRINT_JOBS, 'readwrite', (store) => store.delete(id))
    notifyPrintQueueChanged()
  } catch {
    // ignore
  }
}

export async function clearDonePersistentPrintJobs(tenantId = null) {
  try {
    const list = await getAllPersistentPrintJobs(tenantId)
    for (const j of list) {
      if (j.status === 'DONE') {
        await runTx(STORE_PRINT_JOBS, 'readwrite', (store) => store.delete(j.id))
      }
    }
    notifyPrintQueueChanged()
  } catch {
    // ignore
  }
}
