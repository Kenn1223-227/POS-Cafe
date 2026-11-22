import axios from 'axios'
import toast from 'react-hot-toast'

const API_BASE_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api').replace(/\/+$/, '')
const PLATFORM_TOKEN_KEY = 'platform_admin_token'
const PLATFORM_ADMIN_KEY = 'platform_admin_profile'

const platformClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 45000,
})

platformClient.interceptors.request.use((config) => {
  const token = localStorage.getItem(PLATFORM_TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

platformClient.interceptors.response.use(
  (res) => res.data,
  (err) => {
    if (err.config?.silent) return Promise.reject(err)
    const status = err.response?.status
    const message = err.response?.data?.message
    if (!err.response) {
      toast.error(`Không kết nối được máy chủ (${API_BASE_URL})!`)
    } else if (status === 401 && !err.config?.url?.includes('/platform/auth/login')) {
      localStorage.removeItem(PLATFORM_TOKEN_KEY)
      localStorage.removeItem(PLATFORM_ADMIN_KEY)
      toast.error(message || 'Phiên Platform Admin đã hết hạn!')
    } else {
      toast.error(message || 'Có lỗi xảy ra trên Platform Console!')
    }
    return Promise.reject(err)
  }
)

export const platformAuth = {
  getToken: () => localStorage.getItem(PLATFORM_TOKEN_KEY),
  getAdmin: () => {
    try {
      const raw = localStorage.getItem(PLATFORM_ADMIN_KEY)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  },
  setSession: (token, admin) => {
    localStorage.setItem(PLATFORM_TOKEN_KEY, token)
    localStorage.setItem(PLATFORM_ADMIN_KEY, JSON.stringify(admin))
  },
  clearSession: () => {
    localStorage.removeItem(PLATFORM_TOKEN_KEY)
    localStorage.removeItem(PLATFORM_ADMIN_KEY)
  },
}

export const platformService = {
  login: (username, password) =>
    platformClient.post('/platform/auth/login', { username, password }),

  me: () => platformClient.get('/platform/me', { silent: true }),

  changePassword: ({ currentPassword, newPassword }) =>
    platformClient.put('/platform/auth/password', { currentPassword, newPassword }),

  getOverview: () => platformClient.get('/platform/overview'),

  getTenants: () => platformClient.get('/platform/tenants'),

  updateTenantEntitlements: (tenantId, payload) =>
    platformClient.put(`/platform/tenants/${encodeURIComponent(tenantId)}/entitlements`, payload),

  getBillingOrders: () => platformClient.get('/platform/billing/orders'),

  manualApproveBilling: ({ maDonThanhToan, bankTxRef, ghiChu }) =>
    platformClient.post('/platform/billing/manual-approve', {
      maDonThanhToan,
      bankTxRef,
      ghiChu,
    }),

  impersonateTenant: (tenantId, lyDo) =>
    platformClient.post(`/platform/tenants/${encodeURIComponent(tenantId)}/impersonate`, { lyDo }),

  createRenewalLink: (tenantId, { goiCuoc, soThang = 12 } = {}) =>
    platformClient.post(`/platform/tenants/${encodeURIComponent(tenantId)}/create-renewal-link`, {
      ...(goiCuoc ? { goiCuoc } : {}),
      soThang,
    }),

  getExpansionRequests: () => platformClient.get('/platform/expansion/requests'),
}
