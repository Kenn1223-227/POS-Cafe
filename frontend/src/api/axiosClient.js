import axios from 'axios'
import toast from 'react-hot-toast'
import { useAuthStore } from '../store/authStore'

const axiosClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL, // http://localhost:3000/api
  timeout: 15000,
})

// Tự gắn JWT vào mọi request
axiosClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

let dangChuyenTrang = false
const hetPhienDangNhap = () => {
  if (dangChuyenTrang) return
  dangChuyenTrang = true
  toast.error('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại')
  useAuthStore.getState().logout()
  setTimeout(() => { window.location.href = '/login' }, 800)
}

axiosClient.interceptors.response.use(
  (res) => res.data, // service nhận thẳng phần body
  (err) => {
    // Service có thể tắt toast: axiosClient.get(url, { silent: true })
    if (err.config?.silent) return Promise.reject(err)

    const status = err.response?.status
    const message = err.response?.data?.message
    const laDangNhap = err.config?.url?.includes('/auth/login')

    if (!err.response) {
      toast.error('Mất kết nối tới máy chủ')
    } else if (!laDangNhap && (status === 401 || (status === 403 && /^Token/i.test(message || '')))) {
      hetPhienDangNhap() // backend trả 403 cho token sai/hết hạn, 401 khi thiếu token
    } else {
      toast.error(message || 'Có lỗi xảy ra, vui lòng thử lại')
    }
    return Promise.reject(err)
  }
)

export default axiosClient
