import { Routes, Route, Navigate } from 'react-router-dom'
import { ROUTE_ROLES, ROLE_HOME } from '../constants/roles'
import { useAuthStore } from '../store/authStore'
import ProtectedRoute from './ProtectedRoute'
import Login from '../pages/Login'
import PosPage from '../pages/pos/PosPage'
import BaristaPage from '../pages/barista/BaristaPage'
import AdminLayout from '../layouts/AdminLayout'
import Placeholder from '../pages/Placeholder'

export default function AppRouter() {
  const { token, user } = useAuthStore()

  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        path="/pos"
        element={
          <ProtectedRoute allowedRoles={ROUTE_ROLES['/pos']}>
            <PosPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/barista"
        element={
          <ProtectedRoute allowedRoles={ROUTE_ROLES['/barista']}>
            <BaristaPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin/*"
        element={
          <ProtectedRoute allowedRoles={ROUTE_ROLES['/admin']}>
            <AdminLayout />
          </ProtectedRoute>
        }
      />

      <Route
        path="/waiter"
        element={
          <ProtectedRoute allowedRoles={ROUTE_ROLES['/waiter']}>
            <Placeholder title="Màn hình Phục vụ (/waiter)" />
          </ProtectedRoute>
        }
      />

      <Route
        path="*"
        element={
          <Navigate to={token && user ? ROLE_HOME[user.vaiTro] || '/login' : '/login'} replace />
        }
      />
    </Routes>
  )
}