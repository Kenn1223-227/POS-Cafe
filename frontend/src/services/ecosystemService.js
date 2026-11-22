import axios from 'axios'
import axiosClient from '../api/axiosClient'

const publicHttp = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
})

export const ecosystemService = {
  // === Public QR Order (không cần JWT) ===
  getPublicQrMenu: async (tenantSlug, tableToken) => {
    const res = await publicHttp.get(
      `/public/qr-menu/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(tableToken)}`
    )
    return res.data
  },
  submitPublicQrOrder: async (tenantSlug, tableToken, body) => {
    const res = await publicHttp.post(
      `/public/qr-order/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(tableToken)}`,
      body
    )
    return res.data
  },

  // === POS / Admin QR Order Management ===
  getQrOrders: (trangThai) =>
    axiosClient.get('/qr-orders', { params: trangThai ? { trangThai } : {} }),
  approveQrOrder: (maDonQr, body = {}) =>
    axiosClient.post(`/qr-orders/${encodeURIComponent(maDonQr)}/approve`, body),
  rejectQrOrder: (maDonQr, lyDo) =>
    axiosClient.post(`/qr-orders/${encodeURIComponent(maDonQr)}/reject`, { lyDo }),
  rotateTableQr: (maBan, body = {}) =>
    axiosClient.post(`/ban/${encodeURIComponent(maBan)}/qr-rotate`, body),

  // === CRM Tiers, Wallet & Zalo ZNS ===
  getCrmCustomers: (q = '') =>
    axiosClient.get('/crm/customers', { params: q ? { q } : {} }),
  walletTopup: (maKH, body) =>
    axiosClient.post(`/crm/customers/${encodeURIComponent(maKH)}/wallet-topup`, body),
  getZnsOutbox: () => axiosClient.get('/crm/zns/outbox'),
  triggerBirthdayZns: (tangCashback = 30000) =>
    axiosClient.post('/crm/zns/trigger-birthday', { tangCashback }),

  // === Multi-Branch & Franchise HQ ===
  getBranches: () => axiosClient.get('/branches'),
  createBranch: (body) => axiosClient.post('/branches', body),
  createTerminal: (branchId, body) =>
    axiosClient.post(`/branches/${encodeURIComponent(branchId)}/terminals`, body),
  getConsolidatedReport: ({ tuNgay, denNgay } = {}) =>
    axiosClient.get('/branches/consolidated-report', { params: { tuNgay, denNgay } }),
  getRegionalPrices: () => axiosClient.get('/branches/regional-prices'),
  pushRegionalPrices: (body) => axiosClient.post('/branches/regional-prices/push', body),
  getTransfers: () => axiosClient.get('/branches/transfers'),
  createTransfer: (body) => axiosClient.post('/branches/transfers', body),
  completeTransfer: (maPhieu) =>
    axiosClient.post(`/branches/transfers/${encodeURIComponent(maPhieu)}/complete`),

  // === Aggregator Hub (GrabFood / ShopeeFood / BeFood) ===
  getAggregatorOrders: () => axiosClient.get('/aggregators/orders'),
  simulateAggregatorOrder: (nenTang) =>
    axiosClient.post('/aggregators/simulate', { nenTang }),
  acceptAggregatorOrder: (maDonSan) =>
    axiosClient.post(`/aggregators/orders/${encodeURIComponent(maDonSan)}/accept`),
  updateAggregatorStatus: (maDonSan, trangThai) =>
    axiosClient.put(`/aggregators/orders/${encodeURIComponent(maDonSan)}/status`, { trangThai }),

  // === Horizontal F&B: Time-based Billing & Bakery Auto-Markdown ===
  getActiveTimeBilling: () => axiosClient.get('/time-billing/active'),
  startTimeBilling: (body) => axiosClient.post('/time-billing/start', body),
  stopTimeBilling: (maPhien) =>
    axiosClient.post(`/time-billing/${encodeURIComponent(maPhien)}/stop`),
  getBakeryBatches: (ngay) =>
    axiosClient.get('/bakery/batches', { params: ngay ? { ngay } : {} }),
  createBakeryBatch: (body) => axiosClient.post('/bakery/batches', body),
  updateBakeryBatch: (maLo, body) =>
    axiosClient.put(`/bakery/batches/${encodeURIComponent(maLo)}`, body),

  // === AI Demand Forecasting & Smart Upsell ===
  getAiDemandForecast: () => axiosClient.get('/ai/demand-forecast'),
  getSmartUpsell: (cartMaMonList = []) =>
    axiosClient.get('/ai/smart-upsell', {
      params: cartMaMonList.length > 0 ? { cartMaMon: cartMaMonList.join(',') } : {},
      silent: true,
    }),
}
