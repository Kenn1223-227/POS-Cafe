import { useState, useEffect } from 'react'
import { NavLink, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { ROLE_LABEL } from '../constants/roles'
import Dashboard from '../pages/admin/Dashboard'
import Kho from '../pages/admin/Kho'
import ThucDon from '../pages/admin/ThucDon'
import NhanSu from '../pages/admin/NhanSu'
import CaLamViec from '../pages/admin/CaLamViec'
import KhuyenMai from '../pages/admin/KhuyenMai'
import SaasPortal from '../pages/admin/SaasPortal'
import HeSinhThai from '../pages/admin/HeSinhThai'
import TrialBanner from '../components/TrialBanner'

const NAV_ITEMS = [
  { to: '/admin/dashboard', label: '📊 Dashboard Tổng quan' },
  { to: '/admin/hesinhthai', label: '🚀 Hệ sinh thái & Chuỗi' },
  { to: '/admin/kho', label: '📦 Quản lý Kho & Cân đối' },
  { to: '/admin/thucdon', label: '☕ Thực đơn & Định lượng' },
  { to: '/admin/khuyenmai', label: '🎁 Khuyến mãi & Happy Hour' },
  { to: '/admin/nhansu', label: '👥 Nhân sự & Chấm công' },
  { to: '/admin/ca', label: '🕒 Ca Thu ngân & Đối soát' },
  { to: '/admin/saas', label: '💎 Bản quyền & Gói cước' },
]

export default function AdminLayout() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [drawerOpen, setDrawerOpen] = useState(false)

  const currentNav = NAV_ITEMS.find((item) => location.pathname.startsWith(item.to))

  // Đóng Drawer bằng phím ESC
  useEffect(() => {
    if (!drawerOpen) return undefined
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [drawerOpen])

  const renderSidebarContent = (isMobile = false) => (
    <div className="flex flex-col h-full bg-stone-900 text-stone-100">
      <div className="p-5 border-b border-stone-800 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-extrabold text-amber-400 truncate">
            ☕ {user?.tenQuan || 'Cafe POS Admin'}
          </h2>
          <p className="text-xs text-stone-400 mt-1">
            {user?.tenNV} • {ROLE_LABEL[user?.vaiTro]}
            {user?.goiCuoc && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-600/30 text-amber-300 font-bold text-[10px]">
                {user.goiCuoc}
              </span>
            )}
          </p>
        </div>
        {isMobile && (
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Đóng menu"
            className="min-w-12 min-h-12 rounded-xl bg-stone-800 hover:bg-stone-700 text-white font-bold flex items-center justify-center shrink-0 cursor-pointer"
          >
            ✕
          </button>
        )}
      </div>

      <nav className="flex-1 p-3 space-y-2 overflow-y-auto">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={() => setDrawerOpen(false)}
            className={({ isActive }) =>
              `flex items-center min-h-12 px-4 py-2.5 rounded-xl text-sm font-semibold transition ${
                isActive
                  ? 'bg-amber-600 text-white shadow'
                  : 'text-stone-300 hover:bg-stone-800'
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}

        <div className="pt-4 mt-4 border-t border-stone-800 space-y-2">
          <NavLink
            to="/pos"
            onClick={() => setDrawerOpen(false)}
            className="flex items-center min-h-12 px-4 py-2.5 rounded-xl text-sm font-bold bg-stone-800 text-amber-300 hover:bg-stone-700 transition"
          >
            🖥️ Màn hình POS Thu ngân
          </NavLink>
          <NavLink
            to="/barista"
            onClick={() => setDrawerOpen(false)}
            className="flex items-center min-h-12 px-4 py-2.5 rounded-xl text-xs font-bold bg-stone-800/80 text-sky-300 hover:bg-stone-700 transition"
          >
            🍹 Màn hình KDS Pha chế
          </NavLink>
          <NavLink
            to="/waiter"
            onClick={() => setDrawerOpen(false)}
            className="flex items-center min-h-12 px-4 py-2.5 rounded-xl text-xs font-bold bg-stone-800/80 text-emerald-300 hover:bg-stone-700 transition"
          >
            🛎️ Màn hình Phục vụ
          </NavLink>
        </div>
      </nav>

      <div className="p-4 border-t border-stone-800">
        <button
          type="button"
          onClick={() => {
            setDrawerOpen(false)
            logout()
            navigate('/login', { replace: true })
          }}
          className="w-full min-h-12 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-bold transition cursor-pointer"
        >
          Đăng xuất
        </button>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-stone-100">
      {/* Desktop Sidebar (>= lg) */}
      <aside className="hidden lg:flex w-64 shrink-0 flex-col">
        {renderSidebarContent(false)}
      </aside>

      {/* Mobile / Tablet Top Bar (< lg) */}
      <header className="lg:hidden sticky top-0 z-30 bg-stone-900 text-white px-3 py-2 flex items-center justify-between gap-2 shadow-md">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Mở menu quản trị"
            className="min-w-12 min-h-12 rounded-xl bg-stone-800 hover:bg-stone-700 text-amber-400 font-black text-xl flex items-center justify-center shrink-0 cursor-pointer"
          >
            ☰
          </button>
          <div className="min-w-0">
            <p className="text-sm font-extrabold text-amber-400 truncate">
              ☕ {user?.tenQuan || 'Cafe POS Admin'}
            </p>
            <p className="text-[11px] text-stone-300 truncate">
              {currentNav?.label || 'Quản trị hệ thống'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => navigate('/pos')}
          className="min-h-12 px-3.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-extrabold shrink-0 cursor-pointer"
        >
          🖥️ POS
        </button>
      </header>

      {/* Mobile Slide-Over Drawer (< lg) */}
      {drawerOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-[1px]"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="relative z-10 w-72 max-w-[85vw] h-full shadow-2xl">
            {renderSidebarContent(true)}
          </aside>
        </div>
      )}

      {/* Main View */}
      <div className="flex-1 flex flex-col min-w-0">
        <TrialBanner />
        <main className="flex-1 p-3 sm:p-5 lg:p-6 overflow-y-auto">
          <Routes>
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="hesinhthai" element={<HeSinhThai />} />
            <Route path="kho" element={<Kho />} />
            <Route path="thucdon" element={<ThucDon />} />
            <Route path="khuyenmai" element={<KhuyenMai />} />
            <Route path="nhansu" element={<NhanSu />} />
            <Route path="ca" element={<CaLamViec />} />
            <Route path="saas" element={<SaasPortal />} />
            <Route path="*" element={<Navigate to="dashboard" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
