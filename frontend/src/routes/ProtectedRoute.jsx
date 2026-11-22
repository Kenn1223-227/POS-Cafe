import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { ROLE_HOME } from '../constants/roles'

export default function ProtectedRoute({ allowedRoles = [], children }) {
  const token = useAuthStore((s) => s.token)
  const user = useAuthStore((s) => s.user)
  const authBootstrapped = useAuthStore((s) => s.authBootstrapped)

  // Chờ silent refresh từ HttpOnly Cookie hoàn tất nếu trình duyệt vừa mở lại tab với user cũ
  if (!token && user && !authBootstrapped && typeof navigator !== 'undefined' && navigator.onLine) {
    return (
      <div className="min-h-full flex items-center justify-center bg-amber-50 text-amber-900 font-bold text-sm">
        🔄 Đang khôi phục phiên thiết bị POS...
      </div>
    )
  }

  // Cho phép giữ màn hình POS khi thiết bị reload hoàn toàn Offline nhưng đã có phiên user cache
  const allowOfflineCachedUser = !token && user && typeof navigator !== 'undefined' && !navigator.onLine

  if ((!token && !allowOfflineCachedUser) || !user) {
    return <Navigate to="/login" replace />
  }

  const userRole = Number(user.vaiTro)

  if (allowedRoles.length > 0 && !allowedRoles.includes(userRole)) {
    return <Navigate to={ROLE_HOME[userRole] || '/login'} replace />
  }

  return children
}
