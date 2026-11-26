import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { ROLES } from '../constants/roles'

// Banner Chế độ Hỗ trợ Kỹ thuật Giả lập (Impersonation) + Banner đếm ngược Bản dùng thử 30 ngày / Ân hạn / Hết hạn
export default function TrialBanner() {
  const navigate = useNavigate()
  const { user, logout } = useAuthStore()
  if (!user) return null

  const sub = user.subscription
  const isAdmin = Number(user.vaiTro) === ROLES.QUAN_LY

  const handleExitImpersonation = () => {
    logout()
    navigate('/super-admin')
  }

  const impersonationBanner = user.impersonatedBy ? (
    <div className="bg-rose-700 text-white px-4 py-2 text-xs font-bold flex flex-wrap items-center justify-between gap-2 shadow-md">
      <span>
        🕵️ <b>CHẾ ĐỘ HỖ TRỢ KỸ THUẬT (IMPERSONATION)</b> — Platform Admin{' '}
        <code className="bg-rose-900/70 px-1.5 py-0.5 rounded">@{user.impersonatedBy}</code> đang xem quán{' '}
        <b>{user.tenQuan}</b> ({user.tenantId}) • Phiên có hạn 15 phút & mọi thao tác đều ghi Audit Log!
      </span>
      <button
        type="button"
        onClick={handleExitImpersonation}
        className="px-3.5 py-1 rounded-lg bg-white text-rose-800 hover:bg-rose-50 font-extrabold shrink-0 cursor-pointer"
      >
        ↩️ Thoát hỗ trợ → /super-admin
      </button>
    </div>
  ) : null

  let subscriptionBanner = null
  if (sub && user.tenantId !== 'DEFAULT') {
    if (sub.isFreeForever) {
      if (isAdmin) {
        subscriptionBanner = (
          <div className="bg-emerald-50 text-emerald-950 border-b border-emerald-200 px-4 py-1.5 text-xs font-semibold flex flex-wrap items-center justify-between gap-2">
            <span>
              🆓 <b>Gói FREE Vĩnh viễn</b> (350 đơn/tháng • Báo cáo 7 ngày • Hóa đơn có chân trang QR). Nâng cấp <b>STARTER (169k/tháng)</b> để không giới hạn đơn &amp; tắt watermark!
            </span>
            <Link
              to="/admin/saas"
              className="px-3 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-extrabold shrink-0"
            >
              🚀 Nâng cấp gói
            </Link>
          </div>
        )
      }
    } else if (sub.trongAnHan) {
      subscriptionBanner = (
        <div className="bg-orange-600 text-white px-4 py-2.5 text-xs font-bold flex flex-wrap items-center justify-between gap-2 shadow">
          <span>
            ⚠️ Thời gian dùng thử 30 ngày đã hết — quán đang trong{' '}
            <b>{sub.soNgayAnHanConLai || 5} ngày ân hạn</b> (vẫn bán hàng bình thường). Hãy thanh toán sớm để tránh bị tạm khóa sau thời gian ân hạn!
          </span>
          {isAdmin && (
            <Link
              to="/admin/saas"
              className="px-3.5 py-1.5 rounded-lg bg-white text-orange-700 hover:bg-orange-50 font-extrabold shrink-0"
            >
              💳 Thanh toán gia hạn ngay
            </Link>
          )}
        </div>
      )
    } else if (sub.hetHan) {
      subscriptionBanner = (
        <div className="bg-red-700 text-white px-4 py-2.5 text-xs font-bold flex flex-wrap items-center justify-between gap-2 shadow">
          <span>
            🔒{' '}
            {sub.laDungThu
              ? 'Bản dùng thử miễn phí 30 ngày đã kết thúc — chức năng bán hàng/mở ca tạm khóa cho đến khi nâng cấp lên bản chính thức.'
              : 'Gói bản quyền của quán đã hết hạn — vui lòng gia hạn để tiếp tục bán hàng.'}
          </span>
          {isAdmin && (
            <Link
              to="/admin/saas"
              className="px-3.5 py-1.5 rounded-lg bg-white text-red-700 hover:bg-red-50 font-extrabold shrink-0"
            >
              💳 Thanh toán nâng cấp ngay
            </Link>
          )}
        </div>
      )
    } else if (sub.laDungThu) {
      const days = sub.soNgayConLai ?? 30
      const urgent = days <= 5
      subscriptionBanner = (
        <div
          className={`${
            urgent ? 'bg-amber-600 text-white' : 'bg-amber-100 text-amber-950 border-b border-amber-300'
          } px-4 py-2 text-xs font-semibold flex flex-wrap items-center justify-between gap-2`}
        >
          <span>
            ⏳ <b>Bản dùng thử miễn phí 30 ngày</b> — còn <b>{days} ngày</b>
            {sub.trialEndsAt ? ` (đến ${new Date(sub.trialEndsAt).toLocaleDateString('vi-VN')})` : ''}. Sau 30 ngày cần thanh toán để tiếp tục sử dụng bản chính thức.
          </span>
          {isAdmin && (
            <Link
              to="/admin/saas"
              className={`px-3 py-1 rounded-lg font-extrabold shrink-0 ${
                urgent
                  ? 'bg-white text-amber-800 hover:bg-amber-50'
                  : 'bg-amber-700 text-white hover:bg-amber-800'
              }`}
            >
              💎 Nâng cấp bản chính thức
            </Link>
          )}
        </div>
      )
    }
  }

  if (!impersonationBanner && !subscriptionBanner) return null

  return (
    <div>
      {impersonationBanner}
      {subscriptionBanner}
    </div>
  )
}
