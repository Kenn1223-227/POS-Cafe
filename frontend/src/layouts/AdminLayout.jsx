import { NavLink, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { ROLE_LABEL } from '../constants/roles'
import Dashboard from '../pages/admin/Dashboard'
import Kho from '../pages/admin/Kho'
import ThucDon from '../pages/admin/ThucDon'
import NhanSu from '../pages/admin/NhanSu'
import CaLamViec from '../pages/admin/CaLamViec'

const NAV_ITEMS = [
  { to: '/admin/dashboard', label: '📊 Dashboard Tổng quan' },
  { to: '/admin/kho', label: '📦 Quản lý Kho & Cân đối' },
  { to: '/admin/thucdon', label: '☕ Thực đơn & Định lượng' },
  { to: '/admin/nhansu', label: '👥 Nhân sự & Chấm công' },
  { to: '/admin/ca', label: '🕒 Ca Thu ngân & Đối soát' },
]

export default function AdminLayout() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()

  return (
    <div className="min-h-screen flex bg-stone-100">
      {/* Sidebar */}
      <aside className="w-64 bg-stone-900 text-stone-100 flex flex-col shrink-0">
        <div className="p-5 border-b border-stone-800">
          <h2 className="text-xl font-extrabold text-amber-400">
            ☕ Cafe POS Admin
          </h2>
          <p className="text-xs text-stone-400 mt-1">
            {user?.tenNV} • {ROLE_LABEL[user?.vaiTro]}
          </p>
        </div>

        <nav className="flex-1 p-3 space-y-1.5">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `block px-4 py-3 rounded-xl text-sm font-semibold transition ${
                  isActive
                    ? 'bg-amber-600 text-white shadow'
                    : 'text-stone-300 hover:bg-stone-800'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}

          <div className="pt-4 mt-4 border-t border-stone-800">
            <NavLink
              to="/pos"
              className="block px-4 py-3 rounded-xl text-sm font-bold bg-stone-800 text-amber-300 hover:bg-stone-700 transition"
            >
              🖥️ Chuyển sang Màn hình POS
            </NavLink>
          </div>
        </nav>

        <div className="p-4 border-t border-stone-800">
          <button
            onClick={() => {
              logout()
              navigate('/login', { replace: true })
            }}
            className="w-full py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-bold transition cursor-pointer"
          >
            Đăng xuất
          </button>
        </div>
      </aside>

      {/* Main View */}
      <main className="flex-1 p-6 overflow-y-auto">
        <Routes>
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="kho" element={<Kho />} />
          <Route path="thucdon" element={<ThucDon />} />
          <Route path="nhansu" element={<NhanSu />} />
          <Route path="ca" element={<CaLamViec />} />
          <Route path="*" element={<Navigate to="dashboard" replace />} />
        </Routes>
      </main>
    </div>
  )
}