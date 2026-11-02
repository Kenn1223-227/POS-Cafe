import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { ROLE_HOME } from '../constants/roles'

export default function ProtectedRoute({ allowedRoles = [], children }) {
  const { token, user } = useAuthStore()

  if (!token || !user) {
    return <Navigate to="/login" replace />
  }

  const userRole = Number(user.vaiTro)

  if (allowedRoles.length > 0 && !allowedRoles.includes(userRole)) {
    return <Navigate to={ROLE_HOME[userRole] || '/login'} replace />
  }

  return children
}