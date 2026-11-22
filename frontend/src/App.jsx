import { useEffect } from 'react'
import { Toaster } from 'react-hot-toast'
import AppRouter from './routes/AppRouter'
import { useAuthStore } from './store/authStore'
import { silentRefreshAccessToken } from './api/axiosClient'

export default function App() {
  const token = useAuthStore((s) => s.token)
  const user = useAuthStore((s) => s.user)
  const setAuthBootstrapped = useAuthStore((s) => s.setAuthBootstrapped)

  // [Phân hệ 7] Tự động khôi phục Access Token ngắn hạn từ HttpOnly Refresh Cookie khi mở lại tab trình duyệt
  useEffect(() => {
    let active = true
    const bootstrap = async () => {
      if (!token && user && typeof navigator !== 'undefined' && navigator.onLine) {
        await silentRefreshAccessToken()
      }
      if (active) setAuthBootstrapped(true)
    }
    void bootstrap()
    return () => {
      active = false
    }
  }, [token, user, setAuthBootstrapped])

  return (
    <>
      <Toaster position="top-right" toastOptions={{ duration: 3000 }} />
      <AppRouter />
    </>
  )
}
