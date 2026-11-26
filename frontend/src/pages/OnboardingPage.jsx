import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { saasService } from '../services/saasService'
import { useAuthStore } from '../store/authStore'

const TEMPLATE_ICONS = {
  CAFE_TAKEAWAY: '🥤',
  CAFE_SAN_VUON: '🌿',
  TRA_SUA: '🧋',
  TIEM_BANH: '🥐',
}

export default function OnboardingPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const refFromQr = (searchParams.get('ref') || '').trim()
  const { setAuth } = useAuthStore()

  const [templates, setTemplates] = useState([])
  const [step, setStep] = useState(1) // 1: Mô hình quán | 2: Tài khoản & Gói | 3: Hoàn tất
  const [submitting, setSubmitting] = useState(false)
  const [createdInfo, setCreatedInfo] = useState(null)

  const [form, setForm] = useState({
    tenQuan: '',
    moHinh: 'CAFE_TAKEAWAY',
    soBan: 8,
    tenChuQuan: '',
    tenDangNhap: '',
    email: '',
    soDienThoai: '',
    matKhau: '',
    goiCuoc: 'PRO',
  })

  useEffect(() => {
    saasService
      .getTemplates()
      .then((res) => setTemplates(res.templates || []))
      .catch(() => {})
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await saasService.registerTenant({
        ...form,
        ...(refFromQr ? { referredBy: refFromQr } : {}),
      })
      setAuth(res.token, res.user)
      setCreatedInfo(res)
      setStep(3)
      toast.success(res.message || 'Khởi tạo quán thành công!')
    } catch {
      // Interceptor đã báo lỗi
    } finally {
      setSubmitting(false)
    }
  }

  const copyText = (text, label) => {
    if (!navigator.clipboard) return
    navigator.clipboard.writeText(text).then(
      () => toast.success(`Đã sao chép ${label}!`),
      () => {}
    )
  }

  const fullShopLoginUrl = createdInfo?.shopLoginUrl
    ? `${window.location.origin}${createdInfo.shopLoginUrl}`
    : ''

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-stone-100 to-orange-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl border border-amber-100 max-w-2xl w-full p-6 sm:p-8 space-y-6">
        <div className="flex items-center justify-between border-b pb-4 gap-3">
          <div>
            <span className="text-xs font-extrabold uppercase tracking-wider text-emerald-700">
              🎁 Gói FREE Vĩnh Viễn (350 đơn/tháng) • Hoặc Dùng Thử 30 Ngày PRO
            </span>
            <h1 className="text-2xl font-black text-stone-900 mt-0.5">
              Khởi tạo quán POS trong 30 giây
            </h1>
            <p className="text-xs text-stone-500 mt-0.5">
              Không cần thẻ thanh toán. Tự động nạp sẵn Thực đơn, Size S/M/L, Topping &amp; Công thức Kho BOM chuẩn F&amp;B.
            </p>
            {refFromQr && (
              <span className="inline-block mt-1.5 px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-900 text-[11px] font-bold">
                🤝 Giới thiệu qua QR hóa đơn: {refFromQr}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs shrink-0">
            <Link
              to="/sandbox"
              className="px-3 py-2 rounded-xl bg-amber-100 hover:bg-amber-200 text-amber-900 font-bold"
            >
              🎮 Live Sandbox
            </Link>
            <Link to="/login" className="px-3 py-2 rounded-xl border text-stone-600 font-bold">
              Đăng nhập
            </Link>
          </div>
        </div>

        {/* Thanh tiến trình 3 bước */}
        <div className="grid grid-cols-3 gap-2 text-xs font-bold">
          {[
            { n: 1, label: '1. Mô hình quán' },
            { n: 2, label: '2. Tài khoản & Gói' },
            { n: 3, label: '3. Sẵn sàng bán hàng' },
          ].map((s) => (
            <div
              key={s.n}
              className={`py-2 px-3 rounded-xl text-center ${
                step >= s.n ? 'bg-amber-700 text-white' : 'bg-stone-100 text-stone-400'
              }`}
            >
              {s.label}
            </div>
          ))}
        </div>

        {/* BƯỚC 1: Tên quán + Chọn mô hình mẫu + Số bàn */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  Tên quán của bạn <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={form.tenQuan}
                  onChange={(e) => setForm({ ...form, tenQuan: e.target.value })}
                  placeholder="VD: Mộc Coffee & Tea, Tiệm Trà Sữa Mây..."
                  className="w-full min-h-12 px-3.5 rounded-xl border border-stone-300 text-sm font-semibold outline-none focus:ring-2 focus:ring-amber-600"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  Số lượng bàn (0 = Takeaway)
                </label>
                <input
                  type="number"
                  min="0"
                  max="30"
                  value={form.soBan}
                  onChange={(e) => setForm({ ...form, soBan: e.target.value })}
                  className="w-full min-h-12 px-3.5 rounded-xl border border-stone-300 text-sm font-bold outline-none focus:ring-2 focus:ring-amber-600"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-700 mb-2">
                Chọn mô hình quán (Hệ thống tự nạp sẵn Thực đơn, Giá Size, Topping &amp; Định lượng BOM):
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {templates.map((t) => {
                  const active = form.moHinh === t.id
                  return (
                    <button
                      type="button"
                      key={t.id}
                      onClick={() => setForm({ ...form, moHinh: t.id })}
                      className={`p-4 rounded-2xl border-2 text-left transition cursor-pointer space-y-1.5 ${
                        active
                          ? 'border-amber-700 bg-amber-50 shadow-sm'
                          : 'border-stone-200 hover:border-amber-300 bg-white'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-extrabold text-sm text-stone-900">
                          {TEMPLATE_ICONS[t.id] || '☕'} {t.name}
                        </span>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900">
                          {t.productCount} món
                        </span>
                      </div>
                      <p className="text-xs text-stone-500 leading-relaxed">{t.description}</p>
                      <p className="text-[11px] text-amber-800 font-medium">
                        Mẫu: {t.sampleProducts?.join(', ')}...
                      </p>
                    </button>
                  )
                })}
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                if (form.tenQuan.trim().length < 2) {
                  toast.error('Vui lòng nhập Tên quán trước khi tiếp tục!')
                  return
                }
                setStep(2)
              }}
              className="w-full min-h-12 bg-amber-700 hover:bg-amber-800 text-white font-extrabold rounded-xl text-sm shadow cursor-pointer"
            >
              Tiếp tục → Tạo tài khoản chủ quán
            </button>
          </div>
        )}

        {/* BƯỚC 2: Tài khoản Chủ quán (Email/SĐT + Username nội bộ quán) & Chọn gói */}
        {step === 2 && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  Họ tên Chủ quán <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={form.tenChuQuan}
                  onChange={(e) => setForm({ ...form, tenChuQuan: e.target.value })}
                  placeholder="VD: Nguyễn Minh Anh"
                  className="w-full min-h-11 px-3.5 rounded-xl border border-stone-300 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  Tên đăng nhập trong quán <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={form.tenDangNhap}
                  onChange={(e) => setForm({ ...form, tenDangNhap: e.target.value.toLowerCase() })}
                  placeholder="VD: chuquan hoặc admin"
                  className="w-full min-h-11 px-3.5 rounded-xl border border-stone-300 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  Email Chủ quán (Đăng nhập không cần mã quán)
                </label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="VD: minhanh@moccoffee.vn"
                  className="w-full min-h-11 px-3.5 rounded-xl border border-stone-300 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  Số điện thoại Chủ quán (Zalo hỗ trợ &amp; Đăng nhập)
                </label>
                <input
                  type="tel"
                  value={form.soDienThoai}
                  onChange={(e) => setForm({ ...form, soDienThoai: e.target.value })}
                  placeholder="VD: 0909123456"
                  className="w-full min-h-11 px-3.5 rounded-xl border border-stone-300 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">
                Mật khẩu (tối thiểu 6 ký tự) <span className="text-red-500">*</span>
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={form.matKhau}
                onChange={(e) => setForm({ ...form, matKhau: e.target.value })}
                placeholder="Nhập mật khẩu bảo mật..."
                className="w-full min-h-11 px-3.5 rounded-xl border border-stone-300 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-700 mb-2">
                Chọn gói khởi đầu phù hợp (có thể nâng cấp hoặc về gói FREE bất cứ lúc nào):
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, goiCuoc: 'FREE' })}
                  className={`p-3.5 rounded-2xl border-2 text-left cursor-pointer space-y-1 ${
                    form.goiCuoc === 'FREE'
                      ? 'border-emerald-600 bg-emerald-50'
                      : 'border-stone-200 bg-white'
                  }`}
                >
                  <p className="font-extrabold text-sm text-emerald-900">🆓 FREE Vĩnh viễn</p>
                  <p className="text-[11px] font-black text-emerald-700">0đ / tháng mãi mãi</p>
                  <p className="text-[11px] text-stone-600">
                    1 POS • Tối đa 350 đơn/tháng • Báo cáo 7 ngày • Phù hợp xe cafe &amp; quán mới mở.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setForm({ ...form, goiCuoc: 'STARTER' })}
                  className={`p-3.5 rounded-2xl border-2 text-left cursor-pointer space-y-1 ${
                    form.goiCuoc === 'STARTER'
                      ? 'border-amber-700 bg-amber-50'
                      : 'border-stone-200 bg-white'
                  }`}
                >
                  <p className="font-extrabold text-sm text-stone-800">🌱 STARTER</p>
                  <p className="text-[11px] font-black text-amber-700">Thử 30N • Sau 169k/tháng</p>
                  <p className="text-[11px] text-stone-600">
                    Không giới hạn đơn POS • Offline PWA • AI Menu • Bill sạch không watermark.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setForm({ ...form, goiCuoc: 'PRO' })}
                  className={`p-3.5 rounded-2xl border-2 text-left cursor-pointer space-y-1 relative ${
                    form.goiCuoc === 'PRO'
                      ? 'border-amber-700 bg-amber-50 shadow-sm'
                      : 'border-stone-200 bg-white'
                  }`}
                >
                  <span className="absolute -top-2 right-2 px-2 py-0.5 rounded-full bg-amber-700 text-white text-[9px] font-extrabold">
                    PHỔ BIẾN NHẤT
                  </span>
                  <p className="font-extrabold text-sm text-amber-900">🚀 PRO / GROWTH</p>
                  <p className="text-[11px] font-black text-emerald-700">Thử 30N • Sau 349k/tháng</p>
                  <p className="text-[11px] text-stone-600">
                    Full Kho BOM + BCG, KDS đa trạm, VietQR Auto, QR Order, Anti-Fraud, Loyalty.
                  </p>
                </button>
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="px-5 min-h-12 border rounded-xl text-sm font-bold text-stone-600 cursor-pointer"
              >
                ← Quay lại
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="flex-1 min-h-12 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white font-extrabold rounded-xl text-sm shadow-md cursor-pointer"
              >
                {submitting
                  ? '⚙️ Đang khởi tạo quán...'
                  : form.goiCuoc === 'FREE'
                  ? '🆓 Mở quán FREE vĩnh viễn ngay (0đ)'
                  : '🎁 Bắt đầu dùng thử miễn phí 30 ngày'}
              </button>
            </div>
          </form>
        )}

        {/* BƯỚC 3: Hoàn tất & Đường dẫn đăng nhập riêng cho nhân viên */}
        {step === 3 && createdInfo && (
          <div className="space-y-4">
            <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 space-y-2 text-xs">
              <h3 className="text-base font-black text-emerald-900">
                🎉 Quán &ldquo;{createdInfo.user?.tenQuan}&rdquo; đã sẵn sàng bán hàng!
              </h3>
              <p className="text-emerald-800">
                {createdInfo.seededSummary?.isFreePlan ? (
                  <>
                    Gói <b>FREE Vĩnh viễn (0đ/tháng — 350 đơn/tháng)</b> đã kích hoạt. Hệ thống đã nạp sẵn mô hình{' '}
                    <b>{createdInfo.seededSummary?.moHinh}</b> và mở sẵn Ca thu ngân đầu tiên:
                  </>
                ) : (
                  <>
                    Thời hạn dùng thử miễn phí đến{' '}
                    <b>
                      {createdInfo.seededSummary?.trialEndsAt
                        ? new Date(createdInfo.seededSummary.trialEndsAt).toLocaleDateString('vi-VN')
                        : '30 ngày tới'}
                    </b>
                    . Hệ thống đã nạp sẵn mô hình <b>{createdInfo.seededSummary?.moHinh}</b> và mở sẵn Ca thu ngân đầu tiên:
                  </>
                )}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                <div className="bg-white p-2.5 rounded-xl text-center border border-emerald-200">
                  <p className="text-lg font-black text-amber-700">{createdInfo.seededSummary?.soMon}</p>
                  <p className="text-[11px] text-gray-500">Món + BOM</p>
                </div>
                <div className="bg-white p-2.5 rounded-xl text-center border border-emerald-200">
                  <p className="text-lg font-black text-amber-700">{createdInfo.seededSummary?.soNguyenLieu}</p>
                  <p className="text-[11px] text-gray-500">Nguyên liệu</p>
                </div>
                <div className="bg-white p-2.5 rounded-xl text-center border border-emerald-200">
                  <p className="text-lg font-black text-amber-700">{createdInfo.seededSummary?.soTopping}</p>
                  <p className="text-[11px] text-gray-500">Topping</p>
                </div>
                <div className="bg-white p-2.5 rounded-xl text-center border border-emerald-200">
                  <p className="text-lg font-black text-amber-700">{createdInfo.seededSummary?.soBan}</p>
                  <p className="text-[11px] text-gray-500">Bàn phục vụ</p>
                </div>
              </div>
            </div>

            {/* Đường dẫn đăng nhập riêng cho nhân viên quán */}
            {fullShopLoginUrl && (
              <div className="p-4 rounded-2xl bg-indigo-50 border border-indigo-200 text-xs space-y-1.5">
                <p className="font-extrabold text-indigo-950">
                  🔗 Đường dẫn đăng nhập riêng của quán (Lưu trên máy POS &amp; gửi nhân viên):
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-white border border-indigo-200 px-3 py-2 rounded-xl font-mono text-indigo-900 break-all">
                    {fullShopLoginUrl}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyText(fullShopLoginUrl, 'link đăng nhập quán')}
                    className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold cursor-pointer shrink-0"
                  >
                    📋 Sao chép
                  </button>
                </div>
                <p className="text-[11px] text-indigo-700">
                  Mã quán rút gọn: <b>{createdInfo.seededSummary?.maTienTo}</b> • Chủ quán có thể đăng nhập trực tiếp bằng Email/SĐT ở bất kỳ đâu.
                </p>
              </div>
            )}

            <div className="p-4 rounded-2xl bg-stone-50 border border-stone-200 text-xs space-y-1.5">
              <p className="font-bold text-stone-800">
                👥 3 tài khoản nhân sự tạo sẵn (dùng chung mật khẩu bạn vừa đặt — tên đăng nhập riêng biệt theo quán):
              </p>
              {createdInfo.demoAccounts?.map((acc) => (
                <div key={acc.username} className="flex justify-between py-1 border-b border-stone-200 last:border-0">
                  <span className="font-semibold text-stone-700">{acc.role}</span>
                  <code className="font-mono font-bold text-amber-800">{acc.username}</code>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => navigate('/pos', { replace: true })}
                className="min-h-12 bg-amber-700 hover:bg-amber-800 text-white font-extrabold rounded-xl text-sm shadow cursor-pointer"
              >
                🚀 Bán đơn đầu tiên ngay (/pos)
              </button>
              <button
                type="button"
                onClick={() => navigate('/admin/thucdon', { replace: true })}
                className="min-h-12 bg-stone-900 hover:bg-stone-800 text-white font-extrabold rounded-xl text-sm shadow cursor-pointer"
              >
                ✨ Thiết lập Thực đơn quán
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
