// [Phân hệ 7] Local-LAN POS Hub Client (Wi-Fi nội bộ quán khi đứt cáp quang Internet)
// Kết nối trực tiếp tới Local Print Bridge & POS LAN Hub (mặc định http://127.0.0.1:9100 hoặc IP LAN máy Thu ngân)
import { getBridgeClientSettings } from './printBridge'

const LAN_HUB_SETTINGS_KEY = 'pos_lan_hub_settings'

export function getLanHubSettings() {
  try {
    const raw = localStorage.getItem(LAN_HUB_SETTINGS_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    const bridgeCfg = getBridgeClientSettings()
    return {
      enabled: parsed.enabled !== false,
      url: String(parsed.url || bridgeCfg.url || 'http://127.0.0.1:9100').replace(/\/+$/, ''),
      token: String(parsed.token || bridgeCfg.token || '').trim(),
    }
  } catch {
    return { enabled: true, url: 'http://127.0.0.1:9100', token: '' }
  }
}

export function saveLanHubSettings(patch = {}) {
  const prev = getLanHubSettings()
  const next = {
    ...prev,
    ...patch,
    url: String(patch.url || prev.url || 'http://127.0.0.1:9100').replace(/\/+$/, ''),
    token: String(patch.token !== undefined ? patch.token : prev.token || '').trim(),
  }
  try {
    localStorage.setItem(LAN_HUB_SETTINGS_KEY, JSON.stringify(next))
  } catch {
    // ignore
  }
  return next
}

async function lanFetch(path, { method = 'GET', body = null, timeoutMs = 1800 } = {}) {
  const cfg = getLanHubSettings()
  if (!cfg.enabled || !cfg.url) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = {}
    if (body) headers['Content-Type'] = 'application/json'
    if (cfg.token) {
      headers['X-Lan-Hub-Token'] = cfg.token
      headers['X-Print-Bridge-Token'] = cfg.token
    }
    const res = await fetch(`${cfg.url}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function pushOrderToLanHub(job) {
  if (!job || job.type === 'INVOICE_PAY') return null
  return lanFetch('/lan/orders', {
    method: 'POST',
    body: {
      tenantId: job.tenantId || 'DEFAULT',
      offlineClientId: job.payload?.offlineClientId || job.localInvoice?.maHoaDon,
      clientOrderUid: job.clientOrderUid || job.idempotencyKey || job.payload?.clientOrderUid || null,
      idempotencyKey: job.idempotencyKey || null,
      tableName: job.tableName,
      type: job.type,
      totalAmount: job.totalAmount,
      localInvoice: job.localInvoice,
      createdAt: job.createdAt,
    },
  })
}

export async function markLanOrderSynced(offlineClientId) {
  if (!offlineClientId) return null
  return lanFetch(`/lan/orders/${encodeURIComponent(offlineClientId)}/synced`, {
    method: 'POST',
    body: {},
  })
}

export async function fetchLanOrders(tenantId = 'DEFAULT') {
  const data = await lanFetch(`/lan/orders?tenantId=${encodeURIComponent(tenantId)}`)
  return Array.isArray(data?.orders) ? data.orders : []
}

export async function updateLanItemStatus(orderId, itemId, trangThaiPhaChe) {
  return lanFetch(
    `/lan/orders/${encodeURIComponent(orderId)}/items/${encodeURIComponent(itemId)}/status`,
    {
      method: 'PUT',
      body: { trangThaiPhaChe },
    }
  )
}

export function subscribeLanEvents(tenantId = 'DEFAULT', handlers = {}) {
  if (typeof EventSource === 'undefined') return () => {}
  const cfg = getLanHubSettings()
  if (!cfg.enabled || !cfg.url) return () => {}

  const params = new URLSearchParams({ tenantId: String(tenantId || 'DEFAULT') })
  if (cfg.token) params.set('token', cfg.token)
  const es = new EventSource(`${cfg.url}/lan/events?${params.toString()}`)

  const parseAndCall = (fn) => (ev) => {
    if (typeof fn !== 'function') return
    try {
      fn(JSON.parse(ev.data))
    } catch {
      // ignore malformed event
    }
  }

  es.addEventListener('LAN_SNAPSHOT', parseAndCall(handlers.onSnapshot))
  es.addEventListener('LAN_ORDER_CREATED', parseAndCall(handlers.onOrderCreated))
  es.addEventListener('LAN_ITEM_UPDATED', parseAndCall(handlers.onItemUpdated))
  es.addEventListener('LAN_ORDER_SYNCED', parseAndCall(handlers.onOrderSynced))
  es.onopen = () => handlers.onConnected?.()
  es.onerror = () => handlers.onError?.()

  return () => {
    try {
      es.close()
    } catch {
      // ignore
    }
  }
}
