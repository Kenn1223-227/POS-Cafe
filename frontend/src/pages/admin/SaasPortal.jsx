import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { saasService } from '../../services/saasService'
import { useAuthStore } from '../../store/authStore'
import { formatVND, formatDateTime, formatNumber } from '../../utils/format'
import ConfirmPinModal from '../../components/ConfirmPinModal'
import axiosClient from '../../api/axiosClient'

const PLAN_CARDS = [
  {
    id: 'FREE',
    name: 'FREE (Vĩnh viễn)',
    priceVnd: 0,
    priceLabel: '0đ / điểm bán',
    badge: 'MIỄN PHÍ 0Đ',
    desc: 'Xe cafe mang đi & quán mới mở • 1 điểm bán, tối đa 350 đơn/tháng',
    perks: [
      'Miễn phí 0đ mãi mãi (tối đa 350 đơn/tháng)',
      'Bán hàng POS cơ bản & KDS 1 quầy',
      'Báo cáo kinh doanh 7 ngày gần nhất',
      'Hóa đơn K80 kèm dòng chân trang QR CafePOS',
    ],
  },
  {
    id: 'STARTER',
    name: 'STARTER',
    priceVnd: 169000,
    priceLabel: '169.000đ / điểm bán / tháng',
    badge: '',
    desc: '169.000đ/điểm bán/tháng • Không giới hạn đơn POS cơ bản',
    perks: [
      'Không giới hạn đơn hàng & lịch sử báo cáo',
      'Offline-First PWA (bán liên tục khi rớt mạng)',
      'Nhập thực đơn từ KiotViet / Sapo (CSV/Excel)',
      'Hóa đơn sạch hoàn toàn (không watermark)',
    ],
  },
  {
    id: 'PRO',
    name: 'PRO',
    priceVnd: 349000,
    priceLabel: '349.000đ / điểm bán / tháng',
    badge: 'CHỦ LỰC • PHỔ BIẾN NHẤT',
    highlight: true,
    desc: '349.000đ/điểm bán/tháng • Quán cafe/trà sữa chuyên nghiệp',
    perks: [
      'Kho BOM + Sub-Recipes + Kiểm kho 60s + Ma trận BCG',
      'KDS đa trạm + In tem cốc 50×30 + QR Order tại bàn',
      'VietQR Auto Webhook (SePay/PayOS) chốt đơn 3 giây',
      'Đối soát mù + Chấm công 3 lớp QR/GPS + CRM Loyalty',
    ],
  },
  {
    id: 'CHAIN',
    name: 'CHAIN (Từ 3 điểm bán)',
    priceVnd: 499000,
    priceLabel: '499.000đ / điểm bán / tháng',
    badge: 'CHUỖI TỪ 3 ĐIỂM BÁN',
    desc: '499.000đ/điểm bán/tháng (từ 3 điểm bán) • Quản trị chuỗi tập trung',
    perks: [
      'Đa chi nhánh, Menu tập trung, Kho tổng & Điều chuyển',
      'Quản trị Nhượng quyền & PostgreSQL RLS cô lập tuyệt đối',
      'Hóa đơn điện tử MTT • Aggregator & Zalo ZNS Outbox (Beta / Demo)',
      'Hỗ trợ SLA 24/7 & Triển khai phần cứng tận nơi',
    ],
  },
]

const FEATURE_ITEMS = [
  { key: 'offline_pwa', label: 'Offline-First PWA', desc: 'Bán hàng liên tục khi mất mạng & tự đồng bộ', minPlan: 'STARTER' },
  { key: 'ai_menu_importer', label: 'AI Menu Importer', desc: 'Nhập thực đơn tự động từ ảnh chụp / Zalo / CSV', minPlan: 'STARTER' },
  { key: 'inventory_bom', label: 'Kho BOM, Sub-Recipes & BCG', desc: 'Trừ kho theo Size/Topping, kiểm kho 60s & Ma trận BCG', minPlan: 'PRO' },
  { key: 'vietqr_webhook', label: 'VietQR Auto Webhook', desc: 'Tự động chốt đơn & đọc tiền khi SePay/PayOS báo có', minPlan: 'PRO' },
  { key: 'audit_logs', label: 'Audit Logs & Telegram Anti-Fraud', desc: 'Nhật ký kiểm toán bất biến & cảnh báo gian lận tức thì', minPlan: 'PRO' },
  { key: 'qr_order', label: 'QR Order tại bàn & CRM Loyalty', desc: 'Khách tự quét mã gọi món & tích điểm thành viên', minPlan: 'PRO' },
  { key: 'multi_branch', label: 'Chuỗi đa chi nhánh', desc: 'Menu tập trung, kho tổng & điều chuyển nhiều cơ sở', minPlan: 'CHAIN' },
]

const EXPANSION_OFFERS = [
  {
    loaiDichVu: 'HARDWARE_BUNDLE',
    icon: '🖨️',
    title: 'Combo Phần Cứng Cắm-Là-Chạy (Upfront Bundle)',
    priceLabel: 'Chỉ 7.990.000đ trọn gói (Tiết kiệm 1.800.000đ)',
    goiQuanTam: 'Combo 1 năm PRO + Máy in Bill K80 LAN + Máy in Tem 50x30 + Két tiền RJ11 + Print Bridge',
    bullets: [
      'Tặng sẵn 12 tháng gói PRO / GROWTH',
      'Máy in bill nhiệt K80 LAN + Máy in tem cốc 50×30mm + Két tiền tự bật RJ11',
      'Cài đặt sẵn Local Print Bridge — cắm điện & dây mạng là in ngầm tức thì',
    ],
    cta: '📦 Đặt mua / Nhận báo giá Combo',
  },
  {
    loaiDichVu: 'ZALO_ZNS_CREDITS',
    icon: '💬',
    title: 'Gói Tin Nhắn Zalo ZNS Credits (Chăm Sóc & Tích Điểm)',
    priceLabel: 'Từ 350đ / tin ZNS — Nạp theo gói 1.000 / 5.000 / 20.000 tin',
    goiQuanTam: 'Gói 5.000 tin Zalo ZNS Tích điểm & Gửi hóa đơn điện tử',
    bullets: [
      'Gửi tự động tin nhắn xác nhận tích điểm, thăng hạng VIP & mã voucher sinh nhật',
      'Hiển thị tên thương hiệu quán (Zalo OA) giúp tăng tỷ lệ quay lại 25–40%',
      'Thanh toán linh hoạt theo mức tiêu thụ (Pay-as-you-go Credits)',
    ],
    cta: '💬 Đăng ký nạp Zalo ZNS Credits',
  },
  {
    loaiDichVu: 'FINTECH_SOUNDBOX',
    icon: '🔊',
    title: 'Embedded Fintech & Loa Thông Báo Tiền Về (Soundbox)',
    priceLabel: 'Miễn phí mở TK doanh nghiệp + Ưu đãi Soundbox SePay / PayOS',
    goiQuanTam: 'Mở tài khoản doanh nghiệp + Tích hợp Soundbox SePay / PayOS tự động',
    bullets: [
      'Kết nối SePay / PayOS nhận tiền tức thì 0đ phí chuyển khoản',
      'Loa Soundbox đọc to số tiền khách chuyển chống chụp ảnh bill giả giờ cao điểm',
      'Tự động đóng bàn & in bill ngay khi tiền về tài khoản',
    ],
    cta: '🔊 Đăng ký Soundbox & Tài khoản Ngân hàng',
  },
]

const CYCLE_OPTIONS = [
  { months: 1, label: '1 tháng', badge: '' },
  { months: 6, label: '6 tháng', badge: '-10%' },
  { months: 12, label: '12 tháng', badge: '-20%' },
]

export default function SaasPortal() {
  const { token, user, setAuth } = useAuthStore()
  const [info, setInfo] = useState(null)
  const [billingMonths, setBillingMonths] = useState(12)
  const [chainBranches, setChainBranches] = useState(3)
  const [activeOrder, setActiveOrder] = useState(null)
  const [processing, setProcessing] = useState(false)
  const [submittingOffer, setSubmittingOffer] = useState('')

  const loadData = useCallback(async () => {
    try {
      const my = await saasService.getMyTenant()
      setInfo(my)
      // Đồng bộ lại gói cước, featureFlags & subscription vào authStore để toàn bộ UI cập nhật ngay
      if (my?.tenant && user) {
        setAuth(token, {
          ...user,
          slug: my.tenant.slug || user.slug,
          goiCuoc: my.tenant.goiCuoc,
          featureFlags: my.tenant.featureFlags || user.featureFlags,
          subscription: my.tenant.subscription || user.subscription,
        })
      }
    } catch {
      // Interceptor xử lý
    }
  }, [token, user?.maNV]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setTimeout(() => {
      void loadData()
    }, 0)
    return () => clearTimeout(t)
  }, [loadData])

  const handleStartCheckout = async (planId) => {
    setProcessing(true)
    try {
      const isChainPlan = planId === 'CHAIN' || planId === 'ENTERPRISE'
      const safeBranches = isChainPlan ? Math.max(3, Number(chainBranches) || 3) : 1
      const res = await saasService.createBillingOrder({
        goiCuoc: planId,
        soThang: billingMonths,
        ...(isChainPlan ? { soChiNhanh: safeBranches, extraBranches: Math.max(0, safeBranches - 3) } : { extraBranches: 0 }),
      })
      setActiveOrder(res.order)
      toast.success(res.message)
      await loadData()
    } catch {
      // Interceptor xử lý
    } finally {
      setProcessing(false)
    }
  }

  const [saasDialog, setSaasDialog] = useState(null) // { kind: 'switchFree'|'expansion', offer }
  const [showImportModal, setShowImportModal] = useState(false)
  const [importCsvText, setImportCsvText] = useState('')
  const [importingSheet, setImportingSheet] = useState(false)
  const [importResult, setImportResult] = useState(null)

  const handleImportMenuSheet = async (e) => {
    e.preventDefault()
    if (!importCsvText.trim()) {
      toast.error('Vui lòng dán dữ liệu CSV hoặc chọn tệp xuất từ KiotViet / Sapo!')
      return
    }
    setImportingSheet(true)
    try {
      const res = await axiosClient.post('/saas/import-menu-sheet', { csvText: importCsvText })
      setImportResult(res)
      toast.success(res.message || `Đã nhập ${res.imported} món!`)
    } catch {
      // Interceptor xử lý
    } finally {
      setImportingSheet(false)
    }
  }

  const handleSwitchFree = () => {
    setSaasDialog({ kind: 'switchFree' })
  }

  const handleRequestExpansion = (offer) => {
    setSaasDialog({ kind: 'expansion', offer })
  }

  const handleConfirmSaasDialog = async (val) => {
    if (!saasDialog) return
    const current = saasDialog
    setSaasDialog(null)
    if (current.kind === 'switchFree') {
      setProcessing(true)
      try {
        const res = await saasService.downgradeToFree()
        toast.success(res.message)
        await loadData()
      } catch {
        // Interceptor xử lý
      } finally {
        setProcessing(false)
      }
      return
    }
    if (current.kind === 'expansion' && current.offer) {
      setSubmittingOffer(current.offer.loaiDichVu)
      try {
        const res = await saasService.submitExpansionInquiry({
          loaiDichVu: current.offer.loaiDichVu,
          goiQuanTam: current.offer.goiQuanTam,
          soLuong: 1,
          lienHe: String(val || '').trim(),
        })
        toast.success(res.message, { duration: 5000 })
      } catch {
        // Interceptor xử lý
      } finally {
        setSubmittingOffer('')
      }
    }
  }

  const tenant = info?.tenant
  const sub = tenant?.subscription
  const flags = tenant?.featureFlags || user?.featureFlags || {}
  const usage = info?.usage || {}
  const maxOrders = Number(flags.maxOrdersPerMonth || -1)
  const reportHistoryDays = Number(flags.reportHistoryDays || -1)
  const hasWatermark = Boolean(flags.receipt_watermark)
  const usedOrdersMonth = Number(usage.soDonThangNay || 0)
  const quotaPct = maxOrders > 0 ? Math.min(100, Math.round((usedOrdersMonth / maxOrders) * 100)) : 0
  const isDefaultTenant = (tenant?.tenantId || user?.tenantId || 'DEFAULT') === 'DEFAULT'
  const checklist = info?.checklist || []
  const doneCount = checklist.filter((c) => c.done).length
  const progressPct = checklist.length ? Math.round((doneCount / checklist.length) * 100) : 0
  const discountRate = billingMonths === 12 ? 0.2 : billingMonths === 6 ? 0.1 : 0
  const shopLoginUrl = info?.shopLoginUrl
    ? `${window.location.origin}${info.shopLoginUrl}`
    : tenant?.slug
    ? `${window.location.origin}/login?shop=${tenant.slug}`
    : ''

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-800">
            🏢 Bản Quyền, Gói Cước &amp; Hệ Sinh Thái Mở Rộng
          </h1>
          <p className="text-xs text-gray-500">
            Kiến trúc Multi-Tenant (TenantId + PostgreSQL RLS) • Mã quán: <b>{tenant?.tenantId || '...'}</b> • Tiền tố: <b>{tenant?.maTienTo || '...'}</b>
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {shopLoginUrl && (
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(shopLoginUrl)
                toast.success('Đã sao chép đường dẫn đăng nhập riêng của quán!')
              }}
              className="px-3.5 py-2.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border border-indigo-200 font-bold rounded-xl cursor-pointer"
            >
              🔗 Link NV: /login?shop={tenant?.slug}
            </button>
          )}
          <Link
            to="/onboarding"
            className="px-4 py-2.5 bg-amber-700 hover:bg-amber-800 text-white font-bold rounded-xl shadow"
          >
            + Tạo quán mới (FREE / Thử 30N)
          </Link>
          <Link
            to="/sandbox"
            className="px-4 py-2.5 bg-stone-800 hover:bg-stone-900 text-white font-bold rounded-xl"
          >
            🎮 Mở Live Sandbox
          </Link>
        </div>
      </div>

      {/* Thẻ trạng thái Bản quyền / Gói FREE / Đếm ngược 30 ngày dùng thử */}
      {tenant && (
        <div
          className={`p-5 rounded-2xl border-2 flex flex-wrap items-center justify-between gap-4 ${
            sub?.hetHan
              ? 'bg-red-50 border-red-300'
              : sub?.trongAnHan
              ? 'bg-orange-50 border-orange-300'
              : sub?.laDungThu
              ? 'bg-amber-50 border-amber-300'
              : 'bg-emerald-50 border-emerald-300'
          }`}
        >
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`px-2.5 py-0.5 rounded-full text-[11px] font-extrabold ${
                  sub?.hetHan
                    ? 'bg-red-600 text-white'
                    : sub?.trongAnHan
                    ? 'bg-orange-600 text-white'
                    : sub?.laDungThu
                    ? 'bg-amber-600 text-white'
                    : 'bg-emerald-600 text-white'
                }`}
              >
                {isDefaultTenant
                  ? 'BẢN CHÍNH THỨC (QUÁN GỐC)'
                  : sub?.isFreeForever
                  ? 'GÓI FREE VĨNH VIỄN (0Đ/THÁNG)'
                  : sub?.hetHan
                  ? 'ĐÃ HẾT HẠN'
                  : sub?.trongAnHan
                  ? `ÂN HẠN — CÒN ${sub.soNgayAnHanConLai || 5} NGÀY`
                  : sub?.laDungThu
                  ? `DÙNG THỬ MIỄN PHÍ — CÒN ${sub.soNgayConLai} NGÀY`
                  : 'BẢN CHÍNH THỨC ĐÃ KÍCH HOẠT'}
              </span>
              <span className="text-xs font-bold text-gray-600">
                Gói hiện tại: <b className="text-gray-900">{tenant.goiCuoc}</b>
              </span>
            </div>
            <p className="text-sm font-bold text-gray-900">{tenant.tenQuan}</p>
            <p className="text-xs text-gray-600">
              {isDefaultTenant
                ? 'Quán vận hành mặc định với đầy đủ tính năng gói PRO. (Quản trị toàn nền tảng nằm tại cổng /super-admin độc lập.)'
                : sub?.isFreeForever
                ? 'Đang dùng miễn phí vĩnh viễn (tối đa 350 đơn/tháng, báo cáo 7 ngày). Nâng cấp STARTER (169k/tháng) để bán không giới hạn đơn & xóa watermark bill.'
                : sub?.laDungThu && !sub?.hetHan
                ? `Hạn dùng thử đến ${sub.trialEndsAt ? new Date(sub.trialEndsAt).toLocaleDateString('vi-VN') : ''}. Sau 30 ngày bạn có thể nâng cấp gói trả phí hoặc chuyển về gói FREE vĩnh viễn mà không mất dữ liệu.`
                : sub?.hetHan
                ? 'Thời gian bản quyền đã kết thúc. Chọn gói trả phí bên dưới hoặc chuyển sang gói FREE (350 đơn/tháng) để mở khóa bán hàng tức thì.'
                : `Bản quyền chính thức có hiệu lực đến ${sub?.subscriptionEndsAt ? new Date(sub.subscriptionEndsAt).toLocaleDateString('vi-VN') : 'không giới hạn'}.`}
            </p>
          </div>
          {!isDefaultTenant && (sub?.laDungThu || sub?.hetHan || sub?.trongAnHan || sub?.isFreeForever) && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={processing}
                onClick={() => handleStartCheckout(tenant.goiCuoc === 'FREE' ? 'STARTER' : tenant.goiCuoc || 'PRO')}
                className="px-5 py-3 rounded-xl bg-amber-700 hover:bg-amber-800 text-white font-extrabold text-xs shadow cursor-pointer"
              >
                💳 {sub?.isFreeForever ? 'Nâng cấp STARTER (169k/tháng)' : 'Thanh toán kích hoạt ngay'}
              </button>
              {!sub?.isFreeForever && (
                <button
                  type="button"
                  disabled={processing}
                  onClick={handleSwitchFree}
                  className="px-4 py-3 rounded-xl bg-white border border-stone-300 hover:bg-stone-100 text-stone-700 font-bold text-xs cursor-pointer"
                >
                  🆓 Về gói FREE (0đ)
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Ma trận Quyền Tính Năng & Hạn Mức Gói Cước */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-extrabold text-base text-gray-800">
              🎛️ Quyền Tính Năng &amp; Hạn Mức Của Quán (Gói {tenant?.goiCuoc || user?.goiCuoc || 'PRO'})
            </h3>
            <p className="text-xs text-gray-500">
              Đồng bộ 100% giữa Backend Entitlement API, Máy in Bill K80 và Giao diện Quản trị
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            <div className="text-gray-700 bg-stone-50 border rounded-xl px-3 py-2">
              Đơn tháng này:{' '}
              <b className={maxOrders > 0 && quotaPct >= 80 ? 'text-red-600' : 'text-emerald-700'}>
                {formatNumber(usedOrdersMonth)}
              </b>
              {maxOrders > 0 ? ` / ${formatNumber(maxOrders)}` : ' / ∞'}
            </div>
            <div className="text-gray-700 bg-stone-50 border rounded-xl px-3 py-2">
              Lịch sử báo cáo:{' '}
              <b className={reportHistoryDays > 0 ? 'text-amber-700' : 'text-emerald-700'}>
                {reportHistoryDays > 0 ? `${reportHistoryDays} ngày` : 'Toàn bộ'}
              </b>
            </div>
            <div className="text-gray-700 bg-stone-50 border rounded-xl px-3 py-2">
              Hóa đơn K80:{' '}
              <b className={hasWatermark ? 'text-amber-700' : 'text-emerald-700'}>
                {hasWatermark ? 'Có Watermark QR' : 'Sạch (Không Watermark)'}
              </b>
            </div>
          </div>
        </div>

        {maxOrders > 0 && (
          <div className="space-y-1">
            <div className="h-2.5 bg-stone-100 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all ${
                  quotaPct >= 90 ? 'bg-red-600' : quotaPct >= 80 ? 'bg-amber-500' : 'bg-emerald-600'
                }`}
                style={{ width: `${quotaPct}%` }}
              />
            </div>
            <p className="text-[11px] text-gray-500">
              Đã dùng <b>{quotaPct}%</b> hạn mức {formatNumber(maxOrders)} đơn/tháng của gói {tenant?.goiCuoc}. Nâng cấp <b>STARTER (169k/tháng)</b> để bán không giới hạn đơn!
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {FEATURE_ITEMS.map((item) => {
            const enabled = flags[item.key] !== false
            return (
              <div
                key={item.key}
                className={`p-3.5 rounded-xl border text-xs flex items-start justify-between gap-2 ${
                  enabled
                    ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
                    : 'bg-stone-50 border-stone-200 text-stone-500'
                }`}
              >
                <div className="space-y-0.5">
                  <p className="font-extrabold">
                    {enabled ? '✅' : '🔒'} {item.label}
                  </p>
                  <p className="text-[11px] opacity-80">{item.desc}</p>
                </div>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold shrink-0 ${
                    enabled ? 'bg-emerald-200/80 text-emerald-900' : 'bg-amber-100 text-amber-900'
                  }`}
                >
                  {enabled ? 'MỞ' : item.minPlan}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Khung thanh toán VietQR khi vừa tạo đơn nâng cấp */}
      {activeOrder && (
        <div className="bg-white p-5 rounded-2xl border-2 border-emerald-500 shadow-lg grid grid-cols-1 md:grid-cols-3 gap-5 items-center">
          <div className="flex flex-col items-center">
            <img
              src={activeOrder.vietQrUrl}
              alt="VietQR nâng cấp bản chính thức"
              className="w-52 h-52 rounded-xl border p-1 bg-white object-contain"
            />
            <span className="text-[11px] text-gray-500 mt-1.5">Quét bằng ứng dụng ngân hàng bất kỳ</span>
          </div>
          <div className="md:col-span-2 space-y-2.5 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-black text-emerald-800">
                💳 Đơn nâng cấp Bản chính thức #{activeOrder.maDonThanhToan}
              </h3>
              <button
                type="button"
                onClick={() => setActiveOrder(null)}
                className="text-gray-400 hover:text-gray-700 font-bold cursor-pointer"
              >
                ✕ Đóng
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 bg-stone-50 p-3 rounded-xl border">
              <div>
                <p className="text-gray-500">Gói &amp; Chu kỳ</p>
                <p className="font-extrabold text-gray-900">
                  {activeOrder.tenGoi} • {activeOrder.soThang} tháng
                  {activeOrder.extraBranches > 0 ? ` (+${activeOrder.extraBranches} CN)` : ''}
                  {activeOrder.giamGiaPhanTram > 0 ? ` (Giảm ${activeOrder.giamGiaPhanTram}%)` : ''}
                </p>
              </div>
              <div>
                <p className="text-gray-500">Số tiền cần thanh toán</p>
                <p className="text-base font-black text-emerald-700">{formatVND(activeOrder.soTien)}</p>
              </div>
              <div>
                <p className="text-gray-500">Ngân hàng / STK</p>
                <p className="font-bold text-gray-900">
                  {activeOrder.bank?.bankId} • {activeOrder.bank?.accountNo} ({activeOrder.bank?.accountName})
                </p>
              </div>
              <div>
                <p className="text-gray-500">Nội dung chuyển khoản</p>
                <p className="font-mono font-extrabold text-amber-800">{activeOrder.noiDungCK}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 font-semibold">
                ⏳ Hệ thống tự động kích hoạt ngay khi Webhook VietQR nhận đúng số tiền &amp; nội dung{' '}
                <b>{activeOrder.noiDungCK}</b> (hoặc sau khi Platform Super Admin đối soát sao kê).
              </span>
              <button
                type="button"
                onClick={() => void loadData()}
                className="px-4 py-2 rounded-xl bg-stone-800 hover:bg-stone-900 text-white font-bold cursor-pointer"
              >
                🔄 Kiểm tra trạng thái thanh toán
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bảng 4 gói giá tối ưu cho thị trường Việt Nam */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-extrabold text-base text-gray-800">
            💎 Bảng Giá 4 Gói Cước Tối Ưu Cho Thị Trường F&amp;B Việt Nam
          </h3>
          <div className="inline-flex bg-white border rounded-xl p-1 gap-1 text-xs">
            {CYCLE_OPTIONS.map((opt) => (
              <button
                key={opt.months}
                type="button"
                onClick={() => setBillingMonths(opt.months)}
                className={`px-3 py-1.5 rounded-lg font-bold cursor-pointer transition ${
                  billingMonths === opt.months
                    ? 'bg-amber-700 text-white'
                    : 'text-gray-600 hover:bg-stone-100'
                }`}
              >
                {opt.label}
                {opt.badge && <span className="ml-1 text-[10px] opacity-90">({opt.badge})</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {PLAN_CARDS.map((p) => {
            const isCurrent = tenant?.goiCuoc === p.id
            const isFree = p.id === 'FREE'
            const isChain = p.id === 'CHAIN' || p.id === 'ENTERPRISE'
            const effectiveBranches = isChain ? Math.max(3, Number(chainBranches) || 3) : 1
            const monthlyBase = isChain ? p.priceVnd * effectiveBranches : p.priceVnd
            const monthlyAfterDiscount = Math.round(monthlyBase * (1 - discountRate))
            const totalCycle = monthlyAfterDiscount * billingMonths
            return (
              <div
                key={p.id}
                className={`p-5 rounded-2xl border-2 flex flex-col justify-between space-y-4 bg-white relative ${
                  isCurrent
                    ? 'border-amber-700 shadow-md ring-2 ring-amber-200'
                    : p.highlight
                    ? 'border-emerald-500 shadow-md'
                    : 'border-gray-200'
                }`}
              >
                {p.badge && (
                  <span
                    className={`absolute -top-2.5 right-4 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold ${
                      p.highlight
                        ? 'bg-emerald-600 text-white'
                        : isFree
                        ? 'bg-stone-800 text-white'
                        : 'bg-indigo-600 text-white'
                    }`}
                  >
                    {p.badge}
                  </span>
                )}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-black text-base text-gray-900">{p.name}</span>
                    {isCurrent && (
                      <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 text-[10px] font-extrabold shrink-0">
                        {sub?.laDungThu ? 'DÙNG THỬ' : 'HIỆN TẠI'}
                      </span>
                    )}
                  </div>
                  <div>
                    <p className="text-xl font-black text-amber-700">
                      {isFree ? '0đ / tháng' : `${formatVND(monthlyAfterDiscount)} / tháng`}
                    </p>
                    {!isFree && billingMonths > 1 && (
                      <p className="text-[11px] text-emerald-700 font-bold">
                        Thanh toán {billingMonths} tháng: {formatVND(totalCycle)}
                      </p>
                    )}
                    {isFree && (
                      <p className="text-[11px] text-emerald-700 font-bold">Miễn phí trọn đời • 350 đơn/tháng</p>
                    )}
                  </div>
                  <p className="text-xs text-gray-500">{p.desc}</p>
                  {isChain && (
                    <div className="pt-1 flex items-center justify-between gap-2 text-[11px] bg-indigo-50 px-2.5 py-1.5 rounded-lg border border-indigo-100">
                      <span className="font-bold text-indigo-900">Số điểm bán (tối thiểu 3 • 499k/CN):</span>
                      <input
                        type="number"
                        min={3}
                        max={200}
                        value={chainBranches}
                        onChange={(e) => setChainBranches(Math.max(3, Number(e.target.value) || 3))}
                        className="w-16 px-2 py-0.5 rounded border border-indigo-300 bg-white text-center font-bold"
                      />
                    </div>
                  )}
                  <ul className="space-y-1.5 pt-2 text-xs text-gray-700">
                    {p.perks.map((perk) => (
                      <li key={perk}>✓ {perk}</li>
                    ))}
                  </ul>
                </div>

                {isFree ? (
                  <button
                    type="button"
                    disabled={processing || isDefaultTenant || (isCurrent && !sub?.laDungThu)}
                    onClick={handleSwitchFree}
                    className="w-full py-2.5 rounded-xl text-xs font-extrabold cursor-pointer bg-stone-100 hover:bg-stone-200 disabled:opacity-50 text-stone-800 border border-stone-300"
                  >
                    {isCurrent && !sub?.laDungThu ? 'Đang dùng gói FREE' : 'Chuyển sang FREE (0đ)'}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={processing}
                    onClick={() => handleStartCheckout(p.id)}
                    className={`w-full py-2.5 rounded-xl text-xs font-extrabold cursor-pointer text-white ${
                      p.highlight
                        ? 'bg-emerald-600 hover:bg-emerald-700 shadow'
                        : 'bg-amber-700 hover:bg-amber-800'
                    }`}
                  >
                    {sub?.laDungThu || sub?.hetHan || sub?.isFreeForever
                      ? `Nâng cấp ${p.id} (${formatVND(totalCycle)})`
                      : `Gia hạn ${p.id} (${formatVND(totalCycle)})`}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Doanh thu cộng thêm (Expansion Revenue): Combo Phần cứng + Zalo ZNS Credits + Fintech Soundbox */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-4">
        <div>
          <span className="text-[11px] font-extrabold uppercase tracking-wider text-indigo-700">
            🧩 Hệ Sinh Thái Phần Cứng &amp; Dịch Vụ Mở Rộng (Expansion Add-ons)
          </span>
          <h3 className="font-extrabold text-base text-gray-900 mt-0.5">
            Combo Phần Cứng Cắm-Là-Chạy, Zalo ZNS Credits &amp; Soundbox SePay/PayOS
          </h3>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {EXPANSION_OFFERS.map((offer) => (
            <div
              key={offer.loaiDichVu}
              className="p-4 rounded-2xl border border-slate-200 bg-slate-50/70 flex flex-col justify-between space-y-3"
            >
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{offer.icon}</span>
                  <h4 className="font-extrabold text-sm text-slate-900 leading-snug">{offer.title}</h4>
                </div>
                <p className="text-xs font-black text-emerald-700">{offer.priceLabel}</p>
                <ul className="space-y-1 text-xs text-slate-600">
                  {offer.bullets.map((b) => (
                    <li key={b}>• {b}</li>
                  ))}
                </ul>
              </div>
              <button
                type="button"
                disabled={submittingOffer === offer.loaiDichVu}
                onClick={() => void handleRequestExpansion(offer)}
                className="w-full py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-extrabold text-xs cursor-pointer"
              >
                {submittingOffer === offer.loaiDichVu ? 'Đang gửi yêu cầu...' : offer.cta}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Interactive Onboarding Checklist 5 bước */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-extrabold text-base text-gray-800">
            🧭 Tiến Trình Thiết Lập Quán ({doneCount}/{checklist.length} bước)
          </h3>
          <span className="text-sm font-black text-emerald-700">{progressPct}%</span>
        </div>
        <div className="h-2.5 bg-stone-100 rounded-full overflow-hidden">
          <div className="h-full bg-emerald-600 transition-all" style={{ width: `${progressPct}%` }} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 pt-1">
          {checklist.map((item) => (
            <Link
              key={item.id}
              to={item.link}
              className={`p-3 rounded-xl border text-xs flex flex-col justify-between gap-2 transition ${
                item.done
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-stone-50 border-stone-200 hover:border-amber-500 text-stone-700'
              }`}
            >
              <span className="font-bold">
                {item.done ? '✅' : '⬜'} {item.label}
              </span>
              <span className="text-[11px] font-semibold opacity-75">
                {item.done ? 'Đã hoàn thành' : 'Thực hiện ngay →'}
              </span>
            </Link>
          ))}
        </div>
      </div>

      {/* Lịch sử thanh toán gói bản quyền của quán */}
      {info?.billingHistory?.length > 0 && (
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-3">
          <h3 className="font-extrabold text-base text-gray-800">🧾 Lịch Sử Thanh Toán Bản Quyền</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-gray-50 text-gray-600 uppercase">
                <tr>
                  <th className="p-2.5">Mã đơn</th>
                  <th className="p-2.5">Gói</th>
                  <th className="p-2.5">Chu kỳ</th>
                  <th className="p-2.5 text-right">Số tiền</th>
                  <th className="p-2.5">Trạng thái</th>
                  <th className="p-2.5">Thời gian</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {info.billingHistory.map((o) => (
                  <tr key={o.maDonThanhToan} className="hover:bg-gray-50">
                    <td className="p-2.5 font-mono font-bold">{o.maDonThanhToan}</td>
                    <td className="p-2.5 font-bold">{o.goiCuoc}</td>
                    <td className="p-2.5">{o.soThang} tháng</td>
                    <td className="p-2.5 text-right font-extrabold text-emerald-700">
                      {formatVND(o.soTien)}
                    </td>
                    <td className="p-2.5">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${
                          o.trangThai === 'PAID'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {o.trangThai === 'PAID' ? 'ĐÃ THANH TOÁN' : 'CHỜ ĐỐI SOÁT'}
                      </span>
                    </td>
                    <td className="p-2.5 text-gray-500">
                      {formatDateTime(o.thoiGianThanhToan || o.thoiGianTao)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* [Wave 3B — P1-05] Migration Toolkit 1 phút: Nhập thực đơn từ KiotViet / Sapo */}
      <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-extrabold text-emerald-950">
            📥 Chuyển đổi dữ liệu 1 phút từ KiotViet / Sapo (Migration Toolkit)
          </h3>
          <p className="text-xs text-emerald-800">
            Tự động nhận diện cột Tên hàng, Nhóm hàng, Giá bán, ĐVT/Size, Mã hàng từ file CSV/Excel xuất từ KiotViet &amp; Sapo.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setImportResult(null)
            setShowImportModal(true)
          }}
          className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer"
        >
          📥 Nhập Thực Đơn Từ KiotViet / Sapo (CSV/Excel)
        </button>
      </div>

      {/* Liên kết riêng cho đội vận hành nền tảng */}
      <div className="flex items-center justify-between px-4 py-3 rounded-xl bg-slate-900 text-slate-300 text-xs">
        <span>🛡️ Bạn là Quản trị viên vận hành toàn nền tảng SaaS (Churn Radar, duyệt gói, bật/tắt Feature Flags)?</span>
        <Link
          to="/super-admin"
          className="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold shrink-0"
        >
          Mở Platform Super Admin →
        </Link>
      </div>

      {showImportModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleImportMenuSheet}
            className="bg-white rounded-2xl max-w-xl w-full p-5 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="text-base font-extrabold text-stone-900">
                📥 Nhập Thực Đơn Từ KiotViet / Sapo (CSV / Excel)
              </h3>
              <button
                type="button"
                onClick={() => setShowImportModal(false)}
                className="w-9 h-9 rounded-full bg-stone-100 hover:bg-stone-200 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>
            <div className="space-y-2">
              <input
                type="file"
                accept=".csv,.txt"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  const reader = new FileReader()
                  reader.onload = () => setImportCsvText(String(reader.result || ''))
                  reader.readAsText(f, 'utf-8')
                }}
                className="block w-full text-xs text-stone-600"
              />
              <textarea
                rows={7}
                value={importCsvText}
                onChange={(e) => setImportCsvText(e.target.value)}
                placeholder={'Mã hàng,Tên hàng,Nhóm hàng,Giá bán,ĐVT\nCF01,Cà Phê Sữa Đá,Cà phê,29000,M\nBX01,Bạc Xỉu Đá,Cà phê,35000,L'}
                className="w-full rounded-xl border border-stone-300 p-3 text-xs font-mono"
              />
            </div>
            {importResult && (
              <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
                Nguồn nhận diện: <b>{importResult.detectedSource}</b> • Đã nhập: <b>{importResult.imported}</b> • Bỏ qua:{' '}
                <b>{importResult.skipped}</b>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowImportModal(false)}
                className="px-4 py-2 rounded-xl border border-stone-300 text-xs font-bold cursor-pointer"
              >
                Đóng
              </button>
              <button
                type="submit"
                disabled={importingSheet}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer disabled:opacity-50"
              >
                {importingSheet ? 'Đang nhập...' : '🚀 Nhập thực đơn ngay'}
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmPinModal
        open={Boolean(saasDialog)}
        mode={saasDialog?.kind === 'switchFree' ? 'confirm' : 'input'}
        title={
          saasDialog?.kind === 'switchFree'
            ? 'Chuyển sang gói FREE Vĩnh viễn (0đ/tháng)'
            : `Đăng ký tư vấn: ${saasDialog?.offer?.title || ''}`
        }
        message={
          saasDialog?.kind === 'switchFree'
            ? 'Giới hạn: 350 đơn/tháng, báo cáo 7 ngày gần nhất, bill K80 có dòng chân trang QR CafePOS. Toàn bộ dữ liệu của bạn vẫn được giữ nguyên.'
            : `Nhập SĐT / Zalo nhận tư vấn cho "${saasDialog?.offer?.title || ''}":`
        }
        defaultValue={saasDialog?.kind === 'expansion' ? user?.soDienThoai || user?.email || '' : ''}
        confirmText={saasDialog?.kind === 'switchFree' ? 'Chuyển sang FREE' : 'Gửi yêu cầu'}
        onConfirm={handleConfirmSaasDialog}
        onCancel={() => setSaasDialog(null)}
      />
    </div>
  )
}
