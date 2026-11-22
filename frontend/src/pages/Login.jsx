import { useState, useEffect } from 'react'
import { Navigate, useNavigate, Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { authService } from '../services/authService'
import { useAuthStore } from '../store/authStore'
import { ROLE_HOME, ROLE_LABEL } from '../constants/roles'

const PIN_KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫']

export default function Login() {
  const [form, setForm] = useState({ tenDangNhap: '', matKhau: '', maQuan: '' })
  const [hienMatKhau, setHienMatKhau] = useState(false)
  const [showStoreCode, setShowStoreCode] = useState(false)
  const [rememberDevice, setRememberDevice] = useState(true)
  const [loading, setLoading] = useState(false)

  // [Phân hệ 7] Fast Store Device Session: Mở khóa ca nhanh bằng mã PIN 4–6 số khi máy quầy đã có HttpOnly Cookie
  const [deviceSession, setDeviceSession] = useState(null)
  const [usePinMode, setUsePinMode] = useState(false)
  const [selectedPinStaff, setSelectedPinStaff] = useState('')
  const [pinCode, setPinCode] = useState('')
  const [pinSubmitting, setPinSubmitting] = useState(false)

  const { token, user, setAuth } = useAuthStore()
  const navigate = useNavigate()

  useEffect(() => {
    let mounted = true
    authService
      .getDeviceSession()
      .then((res) => {
        if (!mounted || !res?.active) return
        const pinStaff = (res.staff || []).filter((s) => s.daDatPin)
        setDeviceSession(res)
        if (pinStaff.length > 0) {
          setSelectedPinStaff(res.lastStaff?.maNV || pinStaff[0].maNV)
          setUsePinMode(true)
        }
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [])

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
      const { token: jwt, user: nguoiDung } = await authService.login(tenDangNhap, form.matKhau, {
        maQuan: form.maQuan.trim(),
        rememberDevice,
      })
      const vaiTro = Number(nguoiDung?.vaiTro)
      const trangChu = ROLE_HOME[vaiTro]

      if (!jwt || !trangChu) {
        toast.error('Tài khoản chưa được phân quyền hợp lệ')
        return
      }

      setAuth(jwt, { ...nguoiDung, vaiTro })
      toast.success(`Xin chào, ${nguoiDung.tenNV}!`)
      navigate(trangChu, { replace: true })
    } catch (err) {
      if (err?.response?.data?.code === 'AMBIGUOUS_TENANT_LOGIN') {
        setShowStoreCode(true)
      }
    } finally {
      setLoading(false)
    }
  }

  const handlePinKey = (k) => {
    if (k === 'C') return setPinCode('')
    if (k === '⌫') return setPinCode((p) => p.slice(0, -1))
    setPinCode((p) => (p.length < 6 ? p + k : p))
  }

  const handlePinUnlock = async (e) => {
    e?.preventDefault()
    if (!selectedPinStaff || !/^\d{4,6}$/.test(pinCode)) {
      toast.error('Vui lòng chọn nhân viên và nhập đủ mã PIN (4–6 số)!')
      return
    }
    setPinSubmitting(true)
    try {
      const res = await authService.pinSwitch(selectedPinStaff, pinCode)
      const vaiTro = Number(res?.user?.vaiTro)
      const trangChu = ROLE_HOME[vaiTro] || '/pos'
      setAuth(res.token, { ...res.user, vaiTro })
      toast.success(res.message || `Chào mừng trở lại, ${res.user.tenNV}!`)
      navigate(trangChu, { replace: true })
    } catch {
      setPinCode('')
    } finally {
      setPinSubmitting(false)
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center bg-amber-50 p-4">
      <div className="card w-full max-w-md p-8 space-y-5">
        <div className="text-center">
          <div className="text-6xl">☕</div>
          <h1 className="mt-2 text-3xl font-bold text-amber-800">
            {deviceSession?.active && usePinMode ? deviceSession.tenQuan : 'POS Quán Cà Phê'}
          </h1>
          <p className="mt-1 text-stone-500 text-sm">
            {deviceSession?.active && usePinMode
              ? '🔓 Máy quầy đã gắn phiên — chọn tên & nhập PIN để vào ca ngay'
              : 'Đăng nhập để bắt đầu ca làm việc'}
          </p>
        </div>

        {deviceSession?.active && usePinMode ? (
          <form onSubmit={handlePinUnlock} className="space-y-4">
            <div className="grid grid-cols-2 gap-2 max-h-36 overflow-y-auto pr-1">
              {(deviceSession.staff || []).map((nv) => {
                const isSel = nv.maNV === selectedPinStaff
                return (
                  <button
                    key={nv.maNV}
                    type="button"
                    disabled={!nv.daDatPin}
                    onClick={() => {
                      setSelectedPinStaff(nv.maNV)
                      setPinCode('')
                    }}
                    className={`p-2.5 rounded-xl border text-left transition cursor-pointer disabled:opacity-45 ${
                      isSel
                        ? 'bg-amber-700 text-white border-amber-700 shadow'
                        : 'bg-stone-50 hover:bg-amber-50 border-stone-200 text-stone-800'
                    }`}
                  >
                    <p className="font-extrabold text-xs truncate">{nv.tenNV}</p>
                    <p className={`text-[10px] mt-0.5 ${isSel ? 'text-amber-100' : 'text-stone-500'}`}>
                      {ROLE_LABEL[nv.vaiTro]} • {nv.daDatPin ? '🔢 PIN' : 'Chưa có PIN'}
                    </p>
                  </button>
                )
              })}
            </div>

            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={pinCode}
              onChange={(e) => setPinCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="• • • •"
              className="w-full py-2.5 text-center text-2xl font-black tracking-[0.6em] bg-stone-50 border-2 border-stone-300 rounded-xl outline-none focus:border-amber-600"
            />

            <div className="grid grid-cols-3 gap-2">
              {PIN_KEYPAD.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => handlePinKey(k)}
                  className={`min-h-11 rounded-xl font-black text-lg border cursor-pointer transition ${
                    k === 'C' || k === '⌫'
                      ? 'bg-stone-100 hover:bg-stone-200 text-stone-700 border-stone-200'
                      : 'bg-white hover:bg-amber-50 text-stone-900 border-stone-300'
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>

            <button
              type="submit"
              disabled={pinSubmitting || pinCode.length < 4}
              className="btn btn-primary w-full min-h-12 text-base"
            >
              {pinSubmitting ? 'Đang mở khóa...' : '🔓 Mở khóa vào ca bằng PIN'}
            </button>

            <button
              type="button"
              onClick={() => setUsePinMode(false)}
              className="w-full text-xs font-semibold text-amber-800 hover:underline cursor-pointer"
            >
              Đăng nhập bằng Tên đăng nhập & Mật khẩu (Quản lý / Đổi quán) →
            </button>
          </form>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            {deviceSession?.active && (
              <button
                type="button"
                onClick={() => setUsePinMode(true)}
                className="w-full py-2.5 px-3 rounded-xl bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-800 font-bold text-xs cursor-pointer transition"
              >
                🔢 Mở khóa nhanh bằng PIN tại {deviceSession.tenQuan}
              </button>
            )}

            <label className="block">
              <span className="block mb-1.5 font-medium">Tên đăng nhập</span>
              <input
                name="tenDangNhap"
                value={form.tenDangNhap}
                onChange={onChange}
                className="input"
                placeholder="vd: admin hoặc thungan1@ma-quan"
                autoComplete="username"
                autoCapitalize="none"
                autoFocus
                disabled={loading}
              />
            </label>

            {showStoreCode ? (
              <label className="block">
                <span className="block mb-1.5 font-medium text-amber-900">
                  Mã quán / Slug <span className="text-xs text-stone-400">(phân biệt khi nhiều quán dùng chung tên NV)</span>
                </span>
                <input
                  name="maQuan"
                  value={form.maQuan}
                  onChange={onChange}
                  className="input border-amber-400"
                  placeholder="vd: Q4A1F hoặc cafe-sai-gon"
                  autoCapitalize="none"
                  disabled={loading}
                />
              </label>
            ) : (
              <button
                type="button"
                onClick={() => setShowStoreCode(true)}
                className="text-xs font-semibold text-stone-500 hover:text-amber-800 cursor-pointer"
              >
                + Nhập Mã quán (nếu dùng tên đăng nhập chung như thungan1)
              </button>
            )}

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

            <label className="flex items-center gap-2 text-xs text-stone-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rememberDevice}
                onChange={(e) => setRememberDevice(e.target.checked)}
                className="w-4 h-4 accent-amber-700 rounded"
              />
              <span>Ghi nhớ máy quầy POS (tự gia hạn ngầm & đổi ca nhanh bằng PIN)</span>
            </label>

            <button type="submit" disabled={loading} className="btn btn-primary w-full min-h-14 text-lg">
              {loading ? 'Đang đăng nhập...' : 'Đăng nhập'}
            </button>
          </form>
        )}

        <div className="pt-3 border-t border-stone-200 space-y-2 text-center">
          <Link
            to="/onboarding"
            className="block w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm transition shadow-sm"
          >
            🎁 Dùng thử miễn phí 30 ngày (Khởi tạo quán mẫu trong 30 giây)
          </Link>
          <p className="text-[11px] text-stone-500">
            Trải nghiệm đầy đủ tính năng 30 ngày không cần thẻ — nâng cấp bản chính thức chỉ từ 199.000đ/tháng
          </p>
          <Link
            to="/sandbox"
            className="block w-full py-2.5 rounded-xl bg-amber-100 hover:bg-amber-200 text-amber-900 font-bold text-xs transition"
          >
            🎮 Dùng thử nhanh Live Sandbox (Không cần đăng ký tài khoản)
          </Link>
          <div className="pt-1">
            <Link
              to="/super-admin"
              className="text-[11px] font-semibold text-stone-400 hover:text-indigo-700 transition"
            >
              🛡️ Quản trị nền tảng SaaS (Platform Super Admin) →
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
