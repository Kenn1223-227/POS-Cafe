import { Routes, Route, Navigate } from 'react-router-dom'
import { ROUTE_ROLES, ROLE_HOME } from '../constants/roles'
import { useAuthStore } from '../store/authStore'
import ProtectedRoute from './ProtectedRoute'
import Login from '../pages/Login'
import OnboardingPage from '../pages/OnboardingPage'
import LiveSandboxPage from '../pages/LiveSandboxPage'
import SuperAdminPage from '../pages/SuperAdminPage'
import PosPage from '../pages/pos/PosPage'
import CfdPage from '../pages/pos/CfdPage'
import BaristaPage from '../pages/barista/BaristaPage'
import WaiterPage from '../pages/waiter/WaiterPage'
import AdminLayout from '../layouts/AdminLayout'
import QrOrderPage from '../pages/public/QrOrderPage'

export default function AppRouter() {
  const { token, user } = useAuthStore()

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route path="/sandbox" element={<LiveSandboxPage />} />
      <Route path="/super-admin" element={<SuperAdminPage />} />
      <Route path="/cfd" element={<CfdPage />} />
      <Route path="/m/:tenantSlug/:tableToken" element={<QrOrderPage />} />

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
            <WaiterPage />
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