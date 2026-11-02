import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { authService } from '../services/authService'
import { useAuthStore } from '../store/authStore'
import { ROLE_HOME } from '../constants/roles'

export default function Login() {
  const [form, setForm] = useState({ tenDangNhap: '', matKhau: '' })
  const [hienMatKhau, setHienMatKhau] = useState(false)
  const [loading, setLoading] = useState(false)
  const { token, user, setAuth } = useAuthStore()
  const navigate = useNavigate()

  // Đã đăng nhập sẵn thì vào thẳng màn hình của vai trò
  if (token && user && ROLE_HOME[user.vaiTro]) {
    return <Navigate to={ROLE_HOME[user.vaiTro]} replace />
  }

  const onChange = (e) => setForm({ ...form, [e.target.name]: e.target.value })

  const onSubmit = async (e) => {
    e.preventDefault()
    const tenDangNhap = form.tenDangNhap.trim()
    if (!tenDangNhap || !form.matKhau) {
      toast.error('Vui lòng nhập tên đăng nhập và mật khẩu')
      return
    }

    setLoading(true)
    try {
      const { token: jwt, user: nguoiDung } = await authService.login(tenDangNhap, form.matKhau)
      const vaiTro = Number(nguoiDung?.vaiTro)
      const trangChu = ROLE_HOME[vaiTro]

      if (!jwt || !trangChu) {
        toast.error('Tài khoản chưa được phân quyền hợp lệ')
        return
      }

      setAuth(jwt, { ...nguoiDung, vaiTro }) // lưu token + user vào localStorage
      toast.success(`Xin chào, ${nguoiDung.tenNV}!`)
      navigate(trangChu, { replace: true }) // 1 admin, 2 barista, 3 waiter, 4 pos
    } catch {
      // Lỗi (sai mật khẩu, mất kết nối...) đã được interceptor hiển thị bằng toast
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center bg-amber-50 p-4">
      <form onSubmit={onSubmit} className="card w-full max-w-md p-8 space-y-5">
        <div className="text-center">
          <div className="text-6xl">☕</div>
          <h1 className="mt-2 text-3xl font-bold text-amber-800">POS Quán Cà Phê</h1>
          <p className="mt-1 text-stone-500">Đăng nhập để bắt đầu ca làm việc</p>
        </div>

        <label className="block">
          <span className="block mb-1.5 font-medium">Tên đăng nhập</span>
          <input
            name="tenDangNhap"
            value={form.tenDangNhap}
            onChange={onChange}
            className="input"
            autoComplete="username"
            autoCapitalize="none"
            autoFocus
            disabled={loading}
          />
        </label>

        <label className="block">
          <span className="block mb-1.5 font-medium">Mật khẩu</span>
          <div className="relative">
            <input
              name="matKhau"
              type={hienMatKhau ? 'text' : 'password'}
              value={form.matKhau}
              onChange={onChange}
              className="input pr-24"
              autoComplete="current-password"
              disabled={loading}
            />
            <button
              type="button"
              onClick={() => setHienMatKhau((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 h-10 px-3 rounded-lg text-sm font-semibold text-amber-800 hover:bg-amber-50"
            >
              {hienMatKhau ? 'Ẩn' : 'Hiện'}
            </button>
          </div>
        </label>

        <button type="submit" disabled={loading} className="btn btn-primary w-full min-h-14 text-lg">
          {loading ? 'Đang đăng nhập...' : 'Đăng nhập'}
        </button>
      </form>
    </div>
  )
}
