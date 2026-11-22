import axios from 'axios'
import toast from 'react-hot-toast'
import { useAuthStore } from '../store/authStore'
import { getOrCreatePosDeviceId } from '../offline/offlineDb'

const API_BASE_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api').replace(/\/+$/, '')
const API_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS || 15000)

const axiosClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT_MS,
  withCredentials: true, // Gửi kèm HttpOnly Refresh Token Cookie cho Silent Refresh & Store Device Session
})

// Client riêng (không gắn interceptor lặp) chỉ dùng để gọi /auth/refresh
const refreshClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT_MS,
  withCredentials: true,
})

// Tự gắn JWT ngắn hạn + mã định danh máy POS (X-Device-Id) vào mọi request
axiosClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token
  if (token) config.headers.Authorization = `Bearer ${token}`
  config.headers['X-Device-Id'] = getOrCreatePosDeviceId()
  return config
})

let dangChuyenTrang = false
const hetPhienDangNhap = () => {
  if (dangChuyenTrang) return
  dangChuyenTrang = true
  toast.error('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập hoặc mở khóa bằng PIN')
  useAuthStore.getState().clearLocalAuth()
  setTimeout(() => {
    dangChuyenTrang = false
    window.location.href = '/login'
  }, 800)
}

// Deduplicate các request 401/403 đồng thời: chỉ gọi /auth/refresh đúng 1 lần rồi phát lại toàn bộ hàng đợi!
let pendingRefreshPromise = null

export async function silentRefreshAccessToken() {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null
  if (!pendingRefreshPromise) {
    pendingRefreshPromise = refreshClient
      .post('/auth/refresh', {})
      .then((res) => {
        const body = res.data
        if (body?.token && body?.user) {
          useAuthStore.getState().setAuth(body.token, {
            ...body.user,
            vaiTro: Number(body.user.vaiTro),
          })
          return body.token
        }
        return null
      })
      .catch(() => null)
      .finally(() => {
        pendingRefreshPromise = null
      })
  }
  return pendingRefreshPromise
}

function isTokenExpiredResponse(err) {
  const status = err.response?.status
  const msg = String(err.response?.data?.message || '')
  return status === 401 || (status === 403 && /^Token/i.test(msg))
}

function isAuthBypassUrl(url = '') {
  return (
    url.includes('/auth/login') ||
    url.includes('/auth/refresh') ||
    url.includes('/auth/logout') ||
    url.includes('/auth/pin-switch') ||
    url.includes('/platform/auth/')
  )
}

axiosClient.interceptors.response.use(
  (res) => res.data, // service nhận thẳng phần body
  async (err) => {
    const originalConfig = err.config || {}
    const reqUrl = String(originalConfig.url || '')

    // [Phân hệ 7] Silent Refresh Token Rotation: tự gia hạn Access Token ngầm (áp dụng cho cả Outbox Sync `silent: true`!)
    if (
      err.response &&
      !originalConfig._retryRefresh &&
      !isAuthBypassUrl(reqUrl) &&
      isTokenExpiredResponse(err)
    ) {
      originalConfig._retryRefresh = true
      const newToken = await silentRefreshAccessToken()
      if (newToken) {
        originalConfig.headers = originalConfig.headers || {}
        originalConfig.headers.Authorization = `Bearer ${newToken}`
        return axiosClient(originalConfig)
      }
    }

    // Service có thể tắt toast: axiosClient.get(url, { silent: true })
    if (originalConfig.silent) return Promise.reject(err)

    const status = err.response?.status
    const code = err.response?.data?.code
    const message = err.response?.data?.message
    const laDangNhap = isAuthBypassUrl(reqUrl)

    if (!err.response) {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        toast.error('Thiết bị đang ngoại tuyến (Offline)')
      } else if (err.code === 'ECONNABORTED') {
        toast.error('Máy chủ phản hồi chậm, vui lòng thử lại sau giây lát!')
      } else {
        toast.error(`Không kết nối được máy chủ (${API_BASE_URL}). Hãy đảm bảo Backend đang chạy!`)
      }
    } else if (status === 402) {
      toast.error(
        message ||
          (code === 'ORDER_QUOTA_EXCEEDED'
            ? 'Quán đã đạt hạn mức đơn hàng/tháng của gói hiện tại. Vui lòng nâng cấp lên gói PRO!'
            : 'Bản dùng thử 30 ngày đã hết hạn! Vui lòng thanh toán để nâng cấp bản chính thức.'),
        { duration: 6000 }
      )
    } else if (status === 403 && code === 'FEATURE_NOT_IN_PLAN') {
      toast.error(message || 'Tính năng này không nằm trong gói cước hiện tại — vui lòng nâng cấp gói!', {
        duration: 5000,
      })
    } else if (!laDangNhap && isTokenExpiredResponse(err)) {
      hetPhienDangNhap()
    } else {
      toast.error(message || 'Có lỗi xảy ra, vui lòng thử lại')
    }
    return Promise.reject(err)
  }
)

export default axiosClient
