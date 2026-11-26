import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { platformAuth, platformService } from '../services/platformService'
import { useAuthStore } from '../store/authStore'
import { formatVND, formatDateTime, formatNumber } from '../utils/format'

const FLAG_LIST = [
  { key: 'inventory_bom', label: 'Kho BOM, Sub-Recipes & Ma trận BCG', defaultPlan: 'PRO' },
  { key: 'vietqr_webhook', label: 'VietQR Auto Webhook (SePay / PayOS)', defaultPlan: 'PRO' },
  { key: 'audit_logs', label: 'Nhật ký Kiểm toán Anti-Fraud & Telegram', defaultPlan: 'PRO' },
  { key: 'ai_menu_importer', label: 'AI Menu Importer (Ảnh / Zalo / CSV)', defaultPlan: 'STARTER' },
  { key: 'offline_pwa', label: 'Bán hàng ngoại tuyến (Offline-First PWA)', defaultPlan: 'STARTER' },
  { key: 'qr_order', label: 'QR Order tại bàn cho khách', defaultPlan: 'PRO' },
  { key: 'crm_tiers', label: 'CRM Loyalty & Hạng thành viên', defaultPlan: 'PRO' },
  { key: 'multi_branch', label: 'Quản trị Chuỗi đa chi nhánh', defaultPlan: 'ENTERPRISE' },
  { key: 'receipt_watermark', label: 'Watermark + QR dùng thử chân bill K80 (PLG)', defaultPlan: 'FREE' },
]

const HEALTH_BADGE = {
  GREEN: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  YELLOW: 'bg-amber-100 text-amber-900 border-amber-300',
  RED: 'bg-red-100 text-red-800 border-red-300',
}

const HEALTH_DOT = {
  GREEN: '🟢',
  YELLOW: '🟡',
  RED: '🔴',
}

const STATUS_BADGE = {
  ACTIVE: 'bg-emerald-100 text-emerald-800',
  TRIAL: 'bg-amber-100 text-amber-900',
  GRACE_PERIOD: 'bg-orange-100 text-orange-800',
  EXPIRED: 'bg-red-100 text-red-800',
  SUSPENDED: 'bg-slate-200 text-slate-800',
}

const STATUS_LABEL = {
  ACTIVE: 'Chính thức',
  TRIAL: 'Dùng thử',
  GRACE_PERIOD: 'Ân hạn 5 ngày',
  EXPIRED: 'Hết hạn',
  SUSPENDED: 'Tạm khóa',
}

export default function SuperAdminPage() {
  const navigate = useNavigate()
  const { setAuth } = useAuthStore()

  const [admin, setAdmin] = useState(() => platformAuth.getAdmin())
  const [loginForm, setLoginForm] = useState({ username: 'superadmin', password: '' })
  const [loggingIn, setLoggingIn] = useState(false)

  const [tab, setTab] = useState('tenants')
  const [overview, setOverview] = useState(null)
  const [tenants, setTenants] = useState([])
  const [billingOrders, setBillingOrders] = useState([])
  const [expansionRequests, setExpansionRequests] = useState([])
  const [loading, setLoading] = useState(false)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [healthFilter, setHealthFilter] = useState('ALL')

  // Modal Link VietQR gia hạn ưu đãi 12 tháng (-20%) từ Churn Radar
  const [renewalOffer, setRenewalOffer] = useState(null)
  const [creatingRenewalId, setCreatingRenewalId] = useState('')

  // Modal chỉnh sửa Quyền & Feature Flags cho Tenant
  const [editingTenant, setEditingTenant] = useState(null)
  const [editForm, setEditForm] = useState({
    goiCuoc: 'PRO',
    trangThai: 'ACTIVE',
    extendDays: 0,
    lyDo: '',
    featureFlags: {},
  })
  const [savingEdit, setSavingEdit] = useState(false)

  // Modal đối soát & duyệt đơn nâng cấp thủ công
  const [approvingOrder, setApprovingOrder] = useState(null)
  const [bankTxRef, setBankTxRef] = useState('')
  const [approveNote, setApproveNote] = useState('')
  const [approving, setApproving] = useState(false)

  // Modal đổi mật khẩu Super Admin
  const [showPwdModal, setShowPwdModal] = useState(false)
  const [pwdForm, setPwdForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [savingPwd, setSavingPwd] = useState(false)

  const loadConsoleData = useCallback(async () => {
    if (!platformAuth.getToken()) return
    setLoading(true)
    try {
      const [meRes, ovRes, tnRes, billRes, expRes] = await Promise.all([
        platformService.me(),
        platformService.getOverview(),
        platformService.getTenants(),
        platformService.getBillingOrders(),
        platformService.getExpansionRequests().catch(() => []),
      ])
      if (meRes?.admin) {
        setAdmin(meRes.admin)
      }
      setOverview(ovRes)
      setTenants(Array.isArray(tnRes) ? tnRes : [])
      setBillingOrders(Array.isArray(billRes) ? billRes : [])
      setExpansionRequests(Array.isArray(expRes) ? expRes : [])
    } catch {
      if (!platformAuth.getToken()) {
        setAdmin(null)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!admin) return undefined
    const t = setTimeout(() => {
      void loadConsoleData()
    }, 0)
    return () => clearTimeout(t)
  }, [admin?.username, loadConsoleData]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoggingIn(true)
    try {
      const res = await platformService.login(loginForm.username.trim(), loginForm.password)
      platformAuth.setSession(res.token, res.admin)
      setAdmin(res.admin)
      setLoginForm((prev) => ({ ...prev, password: '' }))
      toast.success(res.message)
    } catch {
      // Interceptor đã báo lỗi
    } finally {
      setLoggingIn(false)
    }
  }

  const handleLogout = () => {
    platformAuth.clearSession()
    setAdmin(null)
    setOverview(null)
    setTenants([])
    setBillingOrders([])
    toast.success('Đã đăng xuất khỏi Platform Super Admin!')
  }

  const openEditTenant = (t) => {
    setEditingTenant(t)
    setEditForm({
      goiCuoc: t.goiCuoc || 'PRO',
      trangThai: t.trangThaiGoc || t.trangThai || 'TRIAL',
      extendDays: 0,
      lyDo: '',
      featureFlags: { ...(t.featureFlags || {}) },
    })
  }

  const handlePlanChangeInModal = (nextPlan) => {
    const planDefaults = overview?.plans?.[nextPlan]
    setEditForm((prev) => ({
      ...prev,
      goiCuoc: nextPlan,
      featureFlags: planDefaults
        ? {
            maxOrdersPerMonth: planDefaults.maxOrdersPerMonth,
            maxBranches: planDefaults.maxBranches,
            reportHistoryDays: planDefaults.reportHistoryDays ?? -1,
            inventory_bom: planDefaults.inventory_bom,
            vietqr_webhook: planDefaults.vietqr_webhook,
            offline_pwa: planDefaults.offline_pwa,
            ai_menu_importer: planDefaults.ai_menu_importer,
            audit_logs: planDefaults.audit_logs,
            multi_branch: planDefaults.multi_branch,
            qr_order: planDefaults.qr_order,
            crm_tiers: planDefaults.crm_tiers,
            receipt_watermark: planDefaults.receipt_watermark,
          }
        : prev.featureFlags,
    }))
  }

  const handleSaveEntitlements = async (e) => {
    e.preventDefault()
    if (!editingTenant) return
    setSavingEdit(true)
    try {
      const res = await platformService.updateTenantEntitlements(editingTenant.tenantId, {
        goiCuoc: editForm.goiCuoc,
        trangThai: editForm.trangThai,
        extendDays: Number(editForm.extendDays) || 0,
        lyDo: editForm.lyDo,
        featureFlags: editForm.featureFlags,
      })
      toast.success(res.message)
      setEditingTenant(null)
      await loadConsoleData()
    } catch {
      // Interceptor đã báo lỗi
    } finally {
      setSavingEdit(false)
    }
  }

  const handleApproveBilling = async (e) => {
    e.preventDefault()
    if (!approvingOrder) return
    setApproving(true)
    try {
      const res = await platformService.manualApproveBilling({
        maDonThanhToan: approvingOrder.maDonThanhToan,
        bankTxRef: bankTxRef.trim(),
        ghiChu: approveNote.trim(),
      })
      toast.success(res.message)
      setApprovingOrder(null)
      setBankTxRef('')
      setApproveNote('')
      await loadConsoleData()
    } catch {
      // Interceptor đã báo lỗi
    } finally {
      setApproving(false)
    }
  }

  const handleImpersonate = async (t) => {
    try {
      const res = await platformService.impersonateTenant(
        t.tenantId,
        `Hỗ trợ kỹ thuật trực tiếp cho ${t.tenQuan}`
      )
      setAuth(res.token, res.user)
      toast.success(res.message, { duration: 5000 })
      navigate('/admin/dashboard')
    } catch {
      // Interceptor đã báo lỗi
    }
  }

  const handleCreateRenewalLink = async (t, targetPlan = null) => {
    setCreatingRenewalId(t.tenantId)
    try {
      const res = await platformService.createRenewalLink(t.tenantId, {
        ...(targetPlan ? { goiCuoc: targetPlan } : {}),
        soThang: 12,
      })
      setRenewalOffer(res.offer)
      toast.success(res.message)
      await loadConsoleData()
    } catch {
      // Interceptor đã báo lỗi
    } finally {
      setCreatingRenewalId('')
    }
  }

  const handleChangePassword = async (e) => {
    e.preventDefault()
    if (pwdForm.newPassword !== pwdForm.confirmPassword) {
      return toast.error('Xác nhận mật khẩu mới chưa khớp!')
    }
    setSavingPwd(true)
    try {
      const res = await platformService.changePassword({
        currentPassword: pwdForm.currentPassword,
        newPassword: pwdForm.newPassword,
      })
      toast.success(res.message)
      setShowPwdModal(false)
      setPwdForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
    } catch {
      // Interceptor đã báo lỗi
    } finally {
      setSavingPwd(false)
    }
  }

  // ==================== MÀN HÌNH ĐĂNG NHẬP PLATFORM ADMIN ====================
  if (!admin) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-5">
          <div className="space-y-1.5 text-center">
            <span className="inline-block px-3 py-1 rounded-full bg-indigo-500/20 text-indigo-300 text-[11px] font-extrabold tracking-wide uppercase">
              Platform Operations Console
            </span>
            <h1 className="text-2xl font-black text-white">🛡️ Platform Super Admin</h1>
            <p className="text-xs text-slate-400">
              Cổng quản trị nền tảng SaaS độc lập — tách biệt hoàn toàn khỏi tài khoản bán hàng của mọi quán (kể cả Tenant <code className="text-amber-400">DEFAULT</code>).
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">Tên đăng nhập Platform</label>
              <input
                type="text"
                required
                value={loginForm.username}
                onChange={(e) => setLoginForm({ ...loginForm, username: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-indigo-400"
                placeholder="superadmin"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">Mật khẩu</label>
              <input
                type="password"
                required
                value={loginForm.password}
                onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-indigo-400"
                placeholder="••••••••"
              />
            </div>
            <button
              type="submit"
              disabled={loggingIn}
              className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold text-sm shadow-lg cursor-pointer disabled:opacity-50"
            >
              {loggingIn ? 'Đang xác thực...' : '🔐 Đăng nhập Cổng Quản Trị Nền Tảng'}
            </button>
          </form>

          <div className="pt-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
            <Link to="/login" className="hover:text-white">
              ← Đăng nhập quán POS
            </Link>
            <span>Bảng riêng: Platform_Admins</span>
          </div>
        </div>
      </div>
    )
  }

  // ==================== BẢNG ĐIỀU KHIỂN PLATFORM SUPER ADMIN ====================
  const kpi = overview?.kpi || {}
  const healthSummary = overview?.healthSummary || { GREEN: 0, YELLOW: 0, RED: 0, UPSELL: 0 }
  const pendingCount = billingOrders.filter((o) => o.trangThai === 'PENDING').length
  const filteredTenants = tenants.filter((t) => {
    const q = search.trim().toLowerCase()
    const matchText =
      !q ||
      t.tenQuan.toLowerCase().includes(q) ||
      t.tenantId.toLowerCase().includes(q) ||
      (t.slug || '').toLowerCase().includes(q) ||
      (t.health?.ownerContact || '').toLowerCase().includes(q)
    const matchStatus = statusFilter === 'ALL' || t.trangThai === statusFilter
    const matchHealth =
      healthFilter === 'ALL'
        ? true
        : healthFilter === 'UPSELL'
        ? Boolean(t.health?.upsellOpportunity)
        : t.health?.healthColor === healthFilter
    return matchText && matchStatus && matchHealth
  })

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      {/* Topbar tách biệt hoàn toàn với POS */}
      <header className="bg-slate-950 text-white px-5 py-3.5 shadow-md sticky top-0 z-20">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center font-black text-lg">
              🛡️
            </span>
            <div>
              <h1 className="text-base font-black tracking-tight">
                Platform Super Admin Console
              </h1>
              <p className="text-[11px] text-slate-400">
                Operator: <b className="text-indigo-300">{admin.fullName || admin.username}</b> (@{admin.username}) • Độc lập hoàn toàn với Tenant POS
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => void loadConsoleData()}
              disabled={loading}
              className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 font-bold cursor-pointer"
            >
              {loading ? '⏳ Đang tải...' : '🔄 Làm mới'}
            </button>
            <button
              type="button"
              onClick={() => setShowPwdModal(true)}
              className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 font-bold cursor-pointer"
            >
              🔑 Đổi mật khẩu
            </button>
            <Link
              to="/login"
              className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 font-bold"
            >
              ☕ Về trang đăng nhập POS
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              className="px-3 py-2 rounded-lg bg-red-600 hover:bg-red-700 font-bold cursor-pointer"
            >
              Đăng xuất
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-5 space-y-5">
        {/* KPI Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
            <p className="text-[11px] font-bold text-slate-500 uppercase">Tổng số quán</p>
            <p className="text-2xl font-black text-slate-900 mt-1">{formatNumber(kpi.totalTenants || 0)}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Trả phí: <b className="text-emerald-700">{kpi.activePaid || 0}</b> • FREE:{' '}
              <b className="text-sky-700">{kpi.activeFree || 0}</b> • Thử: <b className="text-amber-700">{kpi.activeTrial || 0}</b>
            </p>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
            <p className="text-[11px] font-bold text-slate-500 uppercase">MRR Ước tính</p>
            <p className="text-2xl font-black text-emerald-700 mt-1">{formatVND(kpi.mrrEstimate || 0)}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Tổng thu gói: <b>{formatVND(kpi.totalBillingRevenue || 0)}</b>
            </p>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
            <p className="text-[11px] font-bold text-slate-500 uppercase">Đơn nâng cấp chờ duyệt</p>
            <p className="text-2xl font-black text-amber-700 mt-1">{formatNumber(kpi.pendingBillingCount || 0)}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Giá trị: <b>{formatVND(kpi.pendingBillingAmount || 0)}</b>
            </p>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
            <p className="text-[11px] font-bold text-slate-500 uppercase">Đơn POS 7 ngày qua</p>
            <p className="text-2xl font-black text-indigo-700 mt-1">{formatNumber(kpi.totalOrders7d || 0)}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">Trên toàn bộ hệ thống</p>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
            <p className="text-[11px] font-bold text-slate-500 uppercase">Ân hạn / Hết hạn</p>
            <p className="text-2xl font-black text-red-600 mt-1">
              {(kpi.gracePeriod || 0) + (kpi.expiredOrSuspended || 0)}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Ân hạn: <b>{kpi.gracePeriod || 0}</b> • Khóa/Hết: <b>{kpi.expiredOrSuspended || 0}</b>
            </p>
          </div>
        </div>

        {/* ==================== HEALTH METRICS & CHURN RADAR 3 MÀU (PHÂN HỆ 9) ==================== */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-extrabold text-slate-900">
                📡 Health Metrics &amp; Churn Radar 3 Màu (Đơn 3N vs TB 14N • Offline FAILED • Last Login • Hạn gói)
              </h2>
              <p className="text-[11px] text-slate-500">
                Viral PLG Referrals từ QR hóa đơn: <b className="text-indigo-700">{kpi.viralReferralCount || 0} quán</b> • Bấm vào từng thẻ để lọc nhanh danh sách quán bên dưới
              </p>
            </div>
            {healthFilter !== 'ALL' && (
              <button
                type="button"
                onClick={() => setHealthFilter('ALL')}
                className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-bold cursor-pointer"
              >
                ✕ Bỏ lọc Radar
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <button
              type="button"
              onClick={() => {
                setTab('tenants')
                setHealthFilter((cur) => (cur === 'GREEN' ? 'ALL' : 'GREEN'))
              }}
              className={`p-3.5 rounded-xl border-2 text-left transition cursor-pointer ${
                healthFilter === 'GREEN'
                  ? 'border-emerald-600 bg-emerald-50 shadow-sm'
                  : 'border-emerald-200 bg-emerald-50/50 hover:border-emerald-400'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-extrabold text-emerald-900">🟢 Khỏe mạnh</span>
                <span className="text-xl font-black text-emerald-700">{healthSummary.GREEN || 0}</span>
              </div>
              <p className="text-[11px] text-emerald-800/80 mt-1">
                Có đơn đều, không kẹt Offline Queue.
              </p>
            </button>

            <button
              type="button"
              onClick={() => {
                setTab('tenants')
                setHealthFilter((cur) => (cur === 'UPSELL' ? 'ALL' : 'UPSELL'))
              }}
              className={`p-3.5 rounded-xl border-2 text-left transition cursor-pointer ${
                healthFilter === 'UPSELL'
                  ? 'border-indigo-600 bg-indigo-50 shadow-sm'
                  : 'border-indigo-200 bg-indigo-50/50 hover:border-indigo-400'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-extrabold text-indigo-900">🔥 Cơ hội Upsell</span>
                <span className="text-xl font-black text-indigo-700">{healthSummary.UPSELL || 0}</span>
              </div>
              <p className="text-[11px] text-indigo-800/80 mt-1">
                Quán FREE/STARTER chạm ≥80% quota hoặc bán khỏe → Gọi nâng PRO!
              </p>
            </button>

            <button
              type="button"
              onClick={() => {
                setTab('tenants')
                setHealthFilter((cur) => (cur === 'YELLOW' ? 'ALL' : 'YELLOW'))
              }}
              className={`p-3.5 rounded-xl border-2 text-left transition cursor-pointer ${
                healthFilter === 'YELLOW'
                  ? 'border-amber-600 bg-amber-50 shadow-sm'
                  : 'border-amber-200 bg-amber-50/50 hover:border-amber-400'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-extrabold text-amber-900">🟡 Cảnh báo sớm</span>
                <span className="text-xl font-black text-amber-700">{healthSummary.YELLOW || 0}</span>
              </div>
              <p className="text-[11px] text-amber-800/80 mt-1">
                3 ngày chưa có đơn, giảm &gt;50% đơn tuần hoặc kẹt Offline FAILED → Gọi CS!
              </p>
            </button>

            <button
              type="button"
              onClick={() => {
                setTab('tenants')
                setHealthFilter((cur) => (cur === 'RED' ? 'ALL' : 'RED'))
              }}
              className={`p-3.5 rounded-xl border-2 text-left transition cursor-pointer ${
                healthFilter === 'RED'
                  ? 'border-red-600 bg-red-50 shadow-sm'
                  : 'border-red-200 bg-red-50/50 hover:border-red-400'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-extrabold text-red-900">🔴 Sắp hết hạn / Ân hạn</span>
                <span className="text-xl font-black text-red-700">{healthSummary.RED || 0}</span>
              </div>
              <p className="text-[11px] text-red-800/80 mt-1">
                Còn ≤5 ngày hoặc đang ân hạn → Gửi link VietQR ưu đãi 12T (-20%)!
              </p>
            </button>
          </div>

          {/* Hành động nhanh cho danh sách Churn Risk (Đỏ & Vàng) */}
          {overview?.churnRiskTenants?.length > 0 && (
            <div className="pt-2 border-t border-slate-100 space-y-2">
              <p className="text-xs font-extrabold text-slate-800">
                🚨 Danh sách ưu tiên xử lý ngay ({overview.churnRiskTenants.length} quán Đỏ / Vàng):
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                {overview.churnRiskTenants.slice(0, 9).map((c) => (
                  <div
                    key={c.tenantId}
                    className={`rounded-xl p-3 text-xs border flex flex-col justify-between gap-2 ${
                      c.healthColor === 'RED'
                        ? 'bg-red-50/60 border-red-200'
                        : 'bg-amber-50/60 border-amber-200'
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-extrabold text-slate-900 truncate">
                          {HEALTH_DOT[c.healthColor] || '🟡'} {c.tenQuan}
                        </p>
                        <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-white border">
                          {c.healthScore}/100
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-600">
                        <b>{c.goiCuoc}</b> • {STATUS_LABEL[c.trangThai] || c.trangThai}
                        {c.soNgayConLai !== null ? ` (còn ${c.soNgayConLai}n)` : ''}
                        {c.ownerContact ? ` • 📞 ${c.ownerContact}` : ''}
                      </p>
                      <p className="text-[11px] text-slate-700">
                        {(c.healthReasons || []).slice(0, 2).join(' • ')}
                      </p>
                      <p className="text-[10px] font-bold text-indigo-800">→ {c.recommendedAction}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        disabled={creatingRenewalId === c.tenantId}
                        onClick={() => void handleCreateRenewalLink(c)}
                        className="flex-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[11px] cursor-pointer"
                      >
                        {creatingRenewalId === c.tenantId ? 'Đang tạo...' : '🎁 VietQR 12T (-20%)'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleImpersonate(c)}
                        className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold text-[11px] cursor-pointer"
                      >
                        🕵️ Hỗ trợ
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex bg-white border border-slate-200 rounded-xl p-1 gap-1 text-xs">
            <button
              type="button"
              onClick={() => setTab('tenants')}
              className={`px-4 py-2 rounded-lg font-extrabold cursor-pointer ${
                tab === 'tenants' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              🏪 Danh Sách Quán & Feature Flags ({tenants.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('billing')}
              className={`px-4 py-2 rounded-lg font-extrabold cursor-pointer flex items-center gap-1.5 ${
                tab === 'billing' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              💳 Duyệt Đơn Thanh Toán Gói
              {pendingCount > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-amber-500 text-white text-[10px]">
                  {pendingCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setTab('expansion')}
              className={`px-4 py-2 rounded-lg font-extrabold cursor-pointer flex items-center gap-1.5 ${
                tab === 'expansion' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              🧩 Phần Cứng / Zalo ZNS / Fintech
              {expansionRequests.length > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-indigo-500 text-white text-[10px]">
                  {expansionRequests.length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* TAB 1: TENANTS & FEATURE FLAGS */}
        {tab === 'tenants' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="🔍 Tìm theo tên quán, TenantId, slug..."
                className="w-full sm:w-80 px-3.5 py-2 rounded-xl border border-slate-300 text-xs focus:outline-none focus:border-indigo-500"
              />
              <div className="flex flex-wrap gap-1.5 text-xs">
                {['ALL', 'ACTIVE', 'TRIAL', 'GRACE_PERIOD', 'EXPIRED', 'SUSPENDED'].map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setStatusFilter(st)}
                    className={`px-3 py-1.5 rounded-lg font-bold cursor-pointer ${
                      statusFilter === st
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    {st === 'ALL' ? 'Tất cả' : STATUS_LABEL[st]}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-600 uppercase">
                  <tr>
                    <th className="p-2.5">Quán / TenantId</th>
                    <th className="p-2.5">Health Radar</th>
                    <th className="p-2.5">Trạng thái</th>
                    <th className="p-2.5">Gói &amp; Quota tháng</th>
                    <th className="p-2.5">Feature Flags đang bật</th>
                    <th className="p-2.5 text-right">Đơn 3N / 7N / Tổng</th>
                    <th className="p-2.5 text-right">Doanh thu</th>
                    <th className="p-2.5">Đăng nhập / Bán cuối</th>
                    <th className="p-2.5 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredTenants.map((t) => {
                    const flags = t.featureFlags || {}
                    const h = t.health || {}
                    const enabledCount = FLAG_LIST.filter((f) => flags[f.key]).length
                    const limit = Number(flags.maxOrdersPerMonth || -1)
                    return (
                      <tr key={t.tenantId} className="hover:bg-slate-50">
                        <td className="p-2.5">
                          <p className="font-extrabold text-slate-900">{t.tenQuan}</p>
                          <p className="font-mono text-[10px] text-slate-500">
                            {t.tenantId} • {t.soMon} món • {t.soNV} NV
                          </p>
                          {h.ownerContact && (
                            <p className="text-[10px] text-indigo-700 font-semibold">📞 {h.ownerContact}</p>
                          )}
                          {h.referredBy && (
                            <p className="text-[10px] text-emerald-700 font-semibold">🤝 Ref: {h.referredBy}</p>
                          )}
                        </td>
                        <td className="p-2.5">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border font-extrabold text-[10px] ${
                              HEALTH_BADGE[h.healthColor] || 'bg-slate-100 text-slate-700'
                            }`}
                            title={(h.healthReasons || []).join(' | ')}
                          >
                            {HEALTH_DOT[h.healthColor] || '🟢'} {h.healthScore ?? 90}/100
                          </span>
                          <p className="text-[10px] text-slate-600 mt-0.5 max-w-[170px] truncate" title={h.recommendedAction}>
                            {h.healthLabel || 'Khỏe mạnh'}
                          </p>
                          {h.upsellOpportunity && (
                            <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800 text-[9px] font-extrabold">
                              🔥 UPSELL → {h.upsellTargetPlan}
                            </span>
                          )}
                          {Number(h.offlineFailedCount || 0) > 0 && (
                            <p className="text-[10px] text-red-600 font-bold mt-0.5">
                              ⚠️ Offline FAILED: {h.offlineFailedCount}
                            </p>
                          )}
                        </td>
                        <td className="p-2.5">
                          <span
                            className={`px-2 py-0.5 rounded-full font-extrabold text-[10px] ${
                              STATUS_BADGE[t.trangThai] || 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {t.isFreeForever ? 'FREE Vĩnh viễn' : STATUS_LABEL[t.trangThai] || t.trangThai}
                          </span>
                          {t.soNgayConLai !== null && t.tenantId !== 'DEFAULT' && (
                            <p className="text-[10px] text-slate-500 mt-0.5">
                              Còn {t.soNgayConLai} ngày
                            </p>
                          )}
                        </td>
                        <td className="p-2.5">
                          <span className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-800 font-extrabold">
                            {t.goiCuoc}
                          </span>
                          <p className="text-[10px] text-slate-500 mt-0.5">
                            {limit > 0
                              ? `Tháng này: ${t.soDonThangNay}/${limit} (${h.quotaUsagePct || 0}%)`
                              : `Tháng này: ${t.soDonThangNay} đơn (∞)`}
                          </p>
                        </td>
                        <td className="p-2.5">
                          <div className="flex flex-wrap gap-1 max-w-xs">
                            {FLAG_LIST.slice(0, 6).map((f) => (
                              <span
                                key={f.key}
                                title={f.label}
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                  flags[f.key]
                                    ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                                    : 'bg-slate-100 text-slate-400 line-through'
                                }`}
                              >
                                {f.key.replace('_importer', '').replace('_webhook', '')}
                              </span>
                            ))}
                          </div>
                          <p className="text-[10px] text-slate-400 mt-0.5">
                            {enabledCount}/{FLAG_LIST.length} cờ bật{flags.receipt_watermark ? ' • Bill QR' : ''}
                          </p>
                        </td>
                        <td className="p-2.5 text-right">
                          <span className="font-extrabold text-emerald-700">{t.soDon3Ngay ?? 0}</span>
                          <span className="text-slate-400"> / </span>
                          <span className="font-extrabold text-indigo-700">{t.soDon7Ngay}</span>
                          <span className="text-slate-400"> / {t.soDon}</span>
                          {h.dailyAvg14d > 0 && (
                            <p className="text-[10px] text-slate-400">
                              TB 3N: {h.dailyAvg3d} vs 14N: {h.dailyAvg14d}
                            </p>
                          )}
                        </td>
                        <td className="p-2.5 text-right font-extrabold text-emerald-700">
                          {formatVND(t.tongDoanhThu)}
                        </td>
                        <td className="p-2.5 text-slate-500 text-[10px]">
                          <p>ĐN: {h.lastLoginAt ? formatDateTime(h.lastLoginAt) : 'Chưa rõ'}</p>
                          <p>Bán: {t.lanBanCuoi ? formatDateTime(t.lanBanCuoi) : 'Chưa có đơn'}</p>
                        </td>
                        <td className="p-2.5 text-right">
                          <div className="flex justify-end flex-wrap gap-1">
                            {t.tenantId !== 'DEFAULT' && (
                              <button
                                type="button"
                                disabled={creatingRenewalId === t.tenantId}
                                onClick={() => void handleCreateRenewalLink(t, h.upsellTargetPlan || null)}
                                className="px-2 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold cursor-pointer"
                                title="Tạo mã VietQR gia hạn / nâng cấp 12 tháng (-20%)"
                              >
                                🎁 QR -20%
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => openEditTenant(t)}
                              className="px-2 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold cursor-pointer"
                            >
                              ⚙️ Gói
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleImpersonate(t)}
                              className="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-900 text-white font-bold cursor-pointer"
                              title="Mở phiên hỗ trợ kỹ thuật 15 phút (ghi Audit Log)"
                            >
                              🕵️ 15p
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  {filteredTenants.length === 0 && (
                    <tr>
                      <td colSpan={9} className="p-6 text-center text-slate-400">
                        Không có quán nào khớp bộ lọc
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 2: BILLING APPROVAL QUEUE */}
        {tab === 'billing' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4">
            <div>
              <h2 className="text-base font-extrabold text-slate-900">
                💳 Hàng Đợi Đối Soát & Duyệt Đơn Thanh Toán Gói Cước
              </h2>
              <p className="text-xs text-slate-500">
                Webhook VietQR (SePay/PayOS) sẽ tự kích hoạt nếu khách chuyển đúng cú pháp. Khi cần duyệt thủ công, Operator bắt buộc nhập Mã giao dịch sao kê ngân hàng (bankTxRef) để ghi vào Audit Log bất biến.
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-600 uppercase">
                  <tr>
                    <th className="p-2.5">Mã đơn</th>
                    <th className="p-2.5">Quán</th>
                    <th className="p-2.5">Gói / Chu kỳ</th>
                    <th className="p-2.5 text-right">Số tiền</th>
                    <th className="p-2.5">Trạng thái</th>
                    <th className="p-2.5">Mã sao kê / Thời gian</th>
                    <th className="p-2.5 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {billingOrders.map((o) => (
                    <tr key={o.maDonThanhToan} className="hover:bg-slate-50">
                      <td className="p-2.5 font-mono font-bold text-slate-900">{o.maDonThanhToan}</td>
                      <td className="p-2.5">
                        <p className="font-bold text-slate-900">{o.tenQuan}</p>
                        <p className="font-mono text-[10px] text-slate-400">{o.tenantId}</p>
                      </td>
                      <td className="p-2.5 font-bold">
                        {o.goiCuoc} • {o.soThang} tháng
                      </td>
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
                          {o.trangThai === 'PAID' ? 'ĐÃ KÍCH HOẠT' : 'CHỜ ĐỐI SOÁT'}
                        </span>
                      </td>
                      <td className="p-2.5 text-[11px] text-slate-500">
                        {o.maGiaoDichNgoai && (
                          <p className="font-mono font-bold text-slate-700">{o.maGiaoDichNgoai}</p>
                        )}
                        <p>{formatDateTime(o.thoiGianThanhToan || o.thoiGianTao)}</p>
                      </td>
                      <td className="p-2.5 text-right">
                        {o.trangThai === 'PENDING' && (
                          <button
                            type="button"
                            onClick={() => {
                              setApprovingOrder(o)
                              setBankTxRef('')
                              setApproveNote('')
                            }}
                            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold cursor-pointer"
                          >
                            ✅ Đối soát & Duyệt
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {billingOrders.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-6 text-center text-slate-400">
                        Chưa có đơn nâng cấp gói cước nào
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 3: YÊU CẦU MỞ RỘNG (HARDWARE BUNDLING / ZALO ZNS / FINTECH SOUNDBOX) */}
        {tab === 'expansion' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4">
            <div>
              <h2 className="text-base font-extrabold text-slate-900">
                🧩 Yêu Cầu Combo Phần Cứng Cắm-Là-Chạy, Zalo ZNS Credits &amp; Soundbox SePay/PayOS
              </h2>
              <p className="text-xs text-slate-500">
                Danh sách chủ quán đăng ký doanh thu cộng thêm (Expansion Revenue) từ cổng Bản quyền &amp; Gói cước.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-600 uppercase">
                  <tr>
                    <th className="p-2.5">Quán</th>
                    <th className="p-2.5">Nhóm dịch vụ</th>
                    <th className="p-2.5">Gói quan tâm</th>
                    <th className="p-2.5">Liên hệ</th>
                    <th className="p-2.5">Thời gian</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {expansionRequests.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="p-2.5">
                        <p className="font-bold text-slate-900">{r.tenQuan}</p>
                        <p className="font-mono text-[10px] text-slate-400">{r.tenantId}</p>
                      </td>
                      <td className="p-2.5">
                        <span className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-800 font-extrabold text-[10px]">
                          {r.loaiDichVu}
                        </span>
                      </td>
                      <td className="p-2.5 font-semibold text-slate-800">{r.goiQuanTam}</td>
                      <td className="p-2.5 font-mono text-emerald-700 font-bold">{r.lienHe || '-'}</td>
                      <td className="p-2.5 text-slate-500">{formatDateTime(r.thoiGianTao)}</td>
                    </tr>
                  ))}
                  {expansionRequests.length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-slate-400">
                        Chưa có yêu cầu Combo Phần cứng / Zalo ZNS nào
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>

      {/* ==================== MODAL CHỈNH QUYỀN & FEATURE FLAGS ==================== */}
      {editingTenant && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveEntitlements}
            className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-6 space-y-4"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-lg font-black text-slate-900">
                  ⚙️ Gói Cước & Feature Flags — {editingTenant.tenQuan}
                </h3>
                <p className="text-xs text-slate-500 font-mono">{editingTenant.tenantId}</p>
              </div>
              <button
                type="button"
                onClick={() => setEditingTenant(null)}
                className="text-slate-400 hover:text-slate-700 font-bold text-lg cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1">Gói cước</label>
                <select
                  value={editForm.goiCuoc}
                  onChange={(e) => handlePlanChangeInModal(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 font-bold"
                >
                  <option value="FREE">FREE (0đ • 350 đơn/T)</option>
                  <option value="STARTER">STARTER (169k • Không giới hạn)</option>
                  <option value="PRO">PRO / GROWTH (349k)</option>
                  <option value="CHAIN">CHAIN (499k/CN • từ 3 CN)</option>
                  <option value="ENTERPRISE">ENTERPRISE (499k/CN • từ 3 CN)</option>
                </select>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Trạng thái quán</label>
                <select
                  value={editForm.trangThai}
                  disabled={editingTenant.tenantId === 'DEFAULT'}
                  onChange={(e) => setEditForm({ ...editForm, trangThai: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 font-bold disabled:bg-slate-100"
                >
                  <option value="TRIAL">TRIAL (Dùng thử)</option>
                  <option value="ACTIVE">ACTIVE (Chính thức)</option>
                  <option value="EXPIRED">EXPIRED (Hết hạn)</option>
                  <option value="SUSPENDED">SUSPENDED (Tạm khóa)</option>
                </select>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Cộng thêm ngày</label>
                <input
                  type="number"
                  min={0}
                  max={3650}
                  value={editForm.extendDays}
                  onChange={(e) => setEditForm({ ...editForm, extendDays: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 font-bold"
                  placeholder="0"
                />
                <div className="flex gap-1 mt-1">
                  {[7, 14, 30, 90].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setEditForm((prev) => ({ ...prev, extendDays: d }))}
                      className="px-1.5 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-[10px] font-bold cursor-pointer"
                    >
                      +{d}n
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-extrabold text-slate-800 uppercase">
                  Bật / Tắt Feature Flags độc lập (Override theo quán)
                </p>
                <span className="text-[11px] text-slate-500">
                  Hạn mức đơn/tháng:{' '}
                  <b>
                    {Number(editForm.featureFlags?.maxOrdersPerMonth || -1) > 0
                      ? editForm.featureFlags.maxOrdersPerMonth
                      : 'Không giới hạn'}
                  </b>
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {FLAG_LIST.map((f) => {
                  const checked = Boolean(editForm.featureFlags?.[f.key])
                  return (
                    <label
                      key={f.key}
                      className={`p-3 rounded-xl border cursor-pointer flex items-start gap-2.5 text-xs ${
                        checked
                          ? 'bg-emerald-50 border-emerald-300 text-emerald-950'
                          : 'bg-slate-50 border-slate-200 text-slate-600'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setEditForm((prev) => ({
                            ...prev,
                            featureFlags: {
                              ...prev.featureFlags,
                              [f.key]: e.target.checked,
                            },
                          }))
                        }
                        className="mt-0.5 accent-emerald-600"
                      />
                      <div>
                        <p className="font-bold">{f.label}</p>
                        <p className="text-[10px] opacity-75">
                          Mã cờ: <code>{f.key}</code> • Mặc định gói {f.defaultPlan}
                        </p>
                      </div>
                    </label>
                  )
                })}
              </div>
            </div>

            <div className="text-xs">
              <label className="block font-bold text-slate-700 mb-1">Lý do thay đổi (ghi Audit Log)</label>
              <input
                type="text"
                value={editForm.lyDo}
                onChange={(e) => setEditForm({ ...editForm, lyDo: e.target.value })}
                placeholder="VD: Mở trải nghiệm BOM 14 ngày cho quán thử nghiệm..."
                className="w-full px-3 py-2 rounded-xl border border-slate-300"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <button
                type="button"
                onClick={() => setEditingTenant(null)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-bold cursor-pointer"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={savingEdit}
                className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-extrabold cursor-pointer disabled:opacity-50"
              >
                {savingEdit ? 'Đang lưu...' : '💾 Lưu & Áp dụng tức thì'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ==================== MODAL DUYỆT ĐƠN THANH TOÁN GÓI ==================== */}
      {approvingOrder && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleApproveBilling}
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4 text-xs"
          >
            <h3 className="text-base font-black text-emerald-800">
              ✅ Đối Soát Sao Kê & Kích Hoạt #{approvingOrder.maDonThanhToan}
            </h3>
            <div className="bg-slate-50 border rounded-xl p-3 space-y-1">
              <p>
                Quán: <b>{approvingOrder.tenQuan}</b> ({approvingOrder.tenantId})
              </p>
              <p>
                Gói & Chu kỳ: <b>{approvingOrder.goiCuoc}</b> • <b>{approvingOrder.soThang} tháng</b>
              </p>
              <p>
                Số tiền cần khớp: <b className="text-emerald-700 text-sm">{formatVND(approvingOrder.soTien)}</b>
              </p>
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">
                Mã giao dịch sao kê ngân hàng (bankTxRef) *
              </label>
              <input
                type="text"
                required
                minLength={3}
                value={bankTxRef}
                onChange={(e) => setBankTxRef(e.target.value)}
                placeholder="VD: FT26112188991234"
                className="w-full px-3 py-2 rounded-xl border border-slate-300 font-mono"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Ghi chú đối soát</label>
              <input
                type="text"
                value={approveNote}
                onChange={(e) => setApproveNote(e.target.value)}
                placeholder="VD: Đã nhận đủ qua MB Bank lúc 14:30"
                className="w-full px-3 py-2 rounded-xl border border-slate-300"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <button
                type="button"
                onClick={() => setApprovingOrder(null)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 font-bold cursor-pointer"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={approving}
                className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold cursor-pointer disabled:opacity-50"
              >
                {approving ? 'Đang kích hoạt...' : '✅ Xác nhận & Kích hoạt'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ==================== MODAL LINK VIETQR ƯU ĐÃI 12 THÁNG (-20%) TỪ CHURN RADAR ==================== */}
      {renewalOffer && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-4 text-xs">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-base font-black text-emerald-800">
                  🎁 Link VietQR Ưu Đãi {renewalOffer.soThang} Tháng (-{renewalOffer.giamGiaPhanTram}%)
                </h3>
                <p className="text-slate-500">
                  Quán: <b>{renewalOffer.tenQuan}</b> • Gói <b>{renewalOffer.goiCuoc}</b> • Mã đơn{' '}
                  <code className="font-mono font-bold">{renewalOffer.maDonThanhToan}</code>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRenewalOffer(null)}
                className="text-slate-400 hover:text-slate-700 font-bold text-lg cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-4 bg-slate-50 p-3.5 rounded-xl border">
              <img
                src={renewalOffer.vietQrUrl}
                alt="VietQR ưu đãi gia hạn"
                className="w-40 h-40 rounded-xl border bg-white p-1 object-contain shrink-0"
              />
              <div className="space-y-1.5 flex-1">
                <p>
                  Giá gốc: <span className="line-through text-slate-400">{formatVND(renewalOffer.soTienGoc)}</span>
                </p>
                <p className="text-base font-black text-emerald-700">
                  Ưu đãi (-{renewalOffer.giamGiaPhanTram}%): {formatVND(renewalOffer.soTien)}
                </p>
                <p>
                  Nội dung CK: <code className="font-mono font-extrabold text-amber-800">{renewalOffer.noiDungCK}</code>
                </p>
                {renewalOffer.ownerContact && (
                  <p className="text-indigo-700 font-bold">📞 Liên hệ chủ quán: {renewalOffer.ownerContact}</p>
                )}
              </div>
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">
                Mẫu tin nhắn gửi Zalo / SMS cho chủ quán:
              </label>
              <textarea
                readOnly
                rows={4}
                value={renewalOffer.zaloMessage}
                className="w-full p-2.5 rounded-xl border border-slate-300 bg-slate-50 font-sans text-xs"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(renewalOffer.zaloMessage)
                  toast.success('Đã sao chép tin nhắn ưu đãi VietQR gửi Zalo!')
                }}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold cursor-pointer"
              >
                📋 Sao chép tin nhắn Zalo
              </button>
              <button
                type="button"
                onClick={() => setRenewalOffer(null)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 font-bold cursor-pointer"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== MODAL ĐỔI MẬT KHẨU SUPER ADMIN ==================== */}
      {showPwdModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleChangePassword}
            className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-black text-slate-900">🔑 Đổi Mật Khẩu Platform Super Admin</h3>
            <div>
              <label className="block font-bold text-slate-700 mb-1">Mật khẩu hiện tại</label>
              <input
                type="password"
                required
                value={pwdForm.currentPassword}
                onChange={(e) => setPwdForm({ ...pwdForm, currentPassword: e.target.value })}
                className="w-full px-3 py-2 rounded-xl border border-slate-300"
              />
            </div>
            <div>
              <label className="block font-bold text-slate-700 mb-1">Mật khẩu mới (tối thiểu 8 ký tự)</label>
              <input
                type="password"
                required
                minLength={8}
                value={pwdForm.newPassword}
                onChange={(e) => setPwdForm({ ...pwdForm, newPassword: e.target.value })}
                className="w-full px-3 py-2 rounded-xl border border-slate-300"
              />
            </div>
            <div>
              <label className="block font-bold text-slate-700 mb-1">Nhập lại mật khẩu mới</label>
              <input
                type="password"
                required
                minLength={8}
                value={pwdForm.confirmPassword}
                onChange={(e) => setPwdForm({ ...pwdForm, confirmPassword: e.target.value })}
                className="w-full px-3 py-2 rounded-xl border border-slate-300"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <button
                type="button"
                onClick={() => setShowPwdModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 font-bold cursor-pointer"
              >
                Đóng
              </button>
              <button
                type="submit"
                disabled={savingPwd}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold cursor-pointer"
              >
                {savingPwd ? 'Đang lưu...' : 'Cập nhật mật khẩu'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
