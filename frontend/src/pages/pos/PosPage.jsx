import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { banService } from '../../services/banService'
import { sanPhamService } from '../../services/sanPhamService'
import { orderService } from '../../services/orderService'
import { caService } from '../../services/caService'
import { saasService } from '../../services/saasService'
import { khuyenMaiService } from '../../services/khuyenMaiService'
import { khachHangService } from '../../services/khachHangService'
import { authService } from '../../services/authService'
import { ecosystemService } from '../../services/ecosystemService'
import { useAuthStore } from '../../store/authStore'
import { usePosStore } from '../../store/posStore'
import { useSocketEvents } from '../../socket/useSocketEvents'
import { useBarcodeScanner } from '../../hooks/useBarcodeScanner'
import { ROLES } from '../../constants/roles'
import TableMap from './components/TableMap'
import MenuGrid from './components/MenuGrid'
import ToppingModal from './components/ToppingModal'
import CustomerBox from './components/CustomerBox'
import Cart from './components/Cart'
import ThuChiModal from './components/ThuChiModal'
import DongCaModal from './components/DongCaModal'
import OfflineQueueModal from './components/OfflineQueueModal'
import PrintBridgeModal from './components/PrintBridgeModal'
import PaidOrdersRefundModal from './components/PaidOrdersRefundModal'
import PinSwitchModal from './components/PinSwitchModal'
import VoidItemModal from './components/VoidItemModal'
import SplitBillModal from './components/SplitBillModal'
import VietQrBankModal from './components/VietQrBankModal'
import EcosystemPosDrawer from './components/EcosystemPosDrawer'
import TrialBanner from '../../components/TrialBanner'
import { checkBridgeHealth } from '../../utils/printBridge'
import { formatVND } from '../../utils/format'
import { newIdempotencyKey } from '../../utils/idempotency'
import {
  saveCatalogSnapshot,
  loadCatalogSnapshot,
  getAllOutboxJobs,
  deleteOutboxJob,
  getAllPersistentPrintJobs,
  evaluateOfflinePromo,
} from '../../offline/offlineDb'
import {
  isNetworkError,
  saveOfflineOrder,
  flushOutboxQueue,
} from '../../offline/syncEngine'
import {
  printReceiptK80,
  printCupLabels50x30,
  getVietQrConfig,
  saveVietQrConfig,
  buildVietQrUrl,
} from '../../utils/printHelper'
import { playCashSuccessSound, playVietQrReceivedSound, speakVietnamese } from '../../utils/sound'

export default function PosPage() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()
  const userRole = Number(user?.vaiTro)
  const canManageCash = [ROLES.QUAN_LY, ROLES.THU_NGAN].includes(userRole)
  const canApproveVoidOrRefund =
    userRole === ROLES.QUAN_LY ||
    Boolean(user?.permissionsOverride?.isShiftSupervisor) ||
    Boolean(user?.permissionsOverride?.['order.item.void_approve'])

  // [PHÂN HỆ 6] Zustand Atomic Selectors — chống re-render chéo trên máy POS cảm ứng cấu hình thấp (Celeron/J4125)
  const selectedTable = usePosStore((s) => s.selectedTable)
  const orderType = usePosStore((s) => s.orderType)
  const tenKhachVangLai = usePosStore((s) => s.tenKhachVangLai)
  const setOrderType = usePosStore((s) => s.setOrderType)
  const setTenKhachVangLai = usePosStore((s) => s.setTenKhachVangLai)
  const activeInvoice = usePosStore((s) => s.activeInvoice)
  const customer = usePosStore((s) => s.customer)
  const cart = usePosStore((s) => s.cart)
  const heldOrders = usePosStore((s) => s.heldOrders)
  const currentShift = usePosStore((s) => s.currentShift)
  const setCurrentShift = usePosStore((s) => s.setCurrentShift)
  const setSelectedTable = usePosStore((s) => s.setSelectedTable)
  const setActiveInvoice = usePosStore((s) => s.setActiveInvoice)
  const setCustomer = usePosStore((s) => s.setCustomer)
  const addToCart = usePosStore((s) => s.addToCart)
  const updateCartQty = usePosStore((s) => s.updateCartQty)
  const updateCartItem = usePosStore((s) => s.updateCartItem)
  const updateCartNote = usePosStore((s) => s.updateCartNote)
  const splitCartItem = usePosStore((s) => s.splitCartItem)
  const cloneCartItem = usePosStore((s) => s.cloneCartItem)
  const toggleCartItemTakeaway = usePosStore((s) => s.toggleCartItemTakeaway)
  const toggleCartItemHoldCourse = usePosStore((s) => s.toggleCartItemHoldCourse)
  const removeFromCart = usePosStore((s) => s.removeFromCart)
  const clearCart = usePosStore((s) => s.clearCart)
  const holdCurrentOrder = usePosStore((s) => s.holdCurrentOrder)
  const restoreHeldOrder = usePosStore((s) => s.restoreHeldOrder)
  const deleteHeldOrder = usePosStore((s) => s.deleteHeldOrder)

  const [tables, setTables] = useState([])
  const [menu, setMenu] = useState([])
  const [toppings, setToppings] = useState([])
  const [openInvoices, setOpenInvoices] = useState([])
  const [pickingProduct, setPickingProduct] = useState(null)
  const [editingCartTarget, setEditingCartTarget] = useState(null) // { idx, item, product }
  const [concurrencyBanner, setConcurrencyBanner] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [paying, setPaying] = useState(false)
  const [tienDauCaInput, setTienDauCaInput] = useState('500000')
  const [openingShift, setOpeningShift] = useState(false)

  const [showThuChiModal, setShowThuChiModal] = useState(false)
  const [showDongCaModal, setShowDongCaModal] = useState(false)
  const [showOpenOrdersModal, setShowOpenOrdersModal] = useState(false)
  const [showBankModal, setShowBankModal] = useState(false)
  const [bankForm, setBankForm] = useState(() => getVietQrConfig())
  const [preferVietQrKey, setPreferVietQrKey] = useState(0)
  const [soTheRung, setSoTheRung] = useState('')
  const [showPinSwitchModal, setShowPinSwitchModal] = useState(false)
  const [activeHappyHours, setActiveHappyHours] = useState([])
  const [cachedPromotions, setCachedPromotions] = useState({ happyHours: [], codes: [], vndMoiDiemDoi: 1000 })
  const [promoCodeInput, setPromoCodeInput] = useState('')
  const [diemSuDungInput, setDiemSuDungInput] = useState('')
  const [promoPreview, setPromoPreview] = useState(null)

  // Modal Hủy món chuẩn hóa kèm Manager/Ca trưởng Override PIN O(1) (thay cho window.prompt)
  const [voidTarget, setVoidTarget] = useState(null)
  const [voidReason, setVoidReason] = useState('')
  const [voidPin, setVoidPin] = useState('')
  const [pinApprovers, setPinApprovers] = useState([])
  const [voidApproverId, setVoidApproverId] = useState('')
  const [voidSubmitting, setVoidSubmitting] = useState(false)

  // Modal Tách hóa đơn theo món & số lượng lẻ / Chuyển ghép món sang bàn khác (Split Bill)
  const [showSplitModal, setShowSplitModal] = useState(false)
  const [splitQtyMap, setSplitQtyMap] = useState({})
  const [splitDestTable, setSplitDestTable] = useState('')
  const [splitSubmitting, setSplitSubmitting] = useState(false)

  // [Offline-First PWA] Trạng thái mạng + Hàng đợi IndexedDB Outbox
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )
  const [outboxJobs, setOutboxJobs] = useState([])
  const [syncingOutbox, setSyncingOutbox] = useState(false)
  const [cacheUpdatedAt, setCacheUpdatedAt] = useState(null)
  const [showOfflineModal, setShowOfflineModal] = useState(false)
  const [showPrintModal, setShowPrintModal] = useState(false)
  const [showPaidHistoryModal, setShowPaidHistoryModal] = useState(false)
  const [bridgeOnline, setBridgeOnline] = useState(false)
  const [showEcosystemDrawer, setShowEcosystemDrawer] = useState(false)
  const [ecosystemDrawerTab, setEcosystemDrawerTab] = useState('qr')
  const [ecoCounts, setEcoCounts] = useState({ qrPending: 0, aggNew: 0, timersRunning: 0 })
  const [upsellSuggestions, setUpsellSuggestions] = useState([])
  const [failedPrintCount, setFailedPrintCount] = useState(0)
  const [posTheme, setPosTheme] = useState(() => {
    try {
      return localStorage.getItem('pos_visual_theme') || 'light'
    } catch {
      return 'light'
    }
  })

  const cyclePosTheme = () => {
    const order = ['light', 'dark', 'high-contrast']
    const next = order[(order.indexOf(posTheme) + 1) % order.length]
    setPosTheme(next)
    try {
      localStorage.setItem('pos_visual_theme', next)
    } catch {
      // ignore
    }
    const label =
      next === 'dark'
        ? '🌙 Chế độ Tối (Lounge / Pub)'
        : next === 'high-contrast'
        ? '🔆 Chế độ Tương phản cao (Ngoài trời nắng gắt)'
        : '☀️ Chế độ Sáng tiêu chuẩn'
    toast.success(label, { duration: 1800 })
  }

  const submitLockRef = useRef(false)
  const payLockRef = useRef(false)
  const orderKeyRef = useRef(null)
  const searchInputRef = useRef(null)
  const customerInputRef = useRef(null)

  const currentTenantId = String(user?.tenantId || 'DEFAULT')

  const refreshOutboxList = useCallback(async () => {
    const jobs = await getAllOutboxJobs(currentTenantId)
    setOutboxJobs(jobs)
    return jobs
  }, [currentTenantId])

  const refreshFailedPrintCount = useCallback(async () => {
    const jobs = await getAllPersistentPrintJobs(currentTenantId)
    const failed = jobs.filter((j) => j.status === 'FAILED').length
    setFailedPrintCount(failed)
    return failed
  }, [currentTenantId])

  const loadPosData = useCallback(async () => {
    const hydrateFromCache = async () => {
      const { data, updatedAt } = await loadCatalogSnapshot(
        ['tables', 'menu', 'toppings', 'shift', 'openInvoices', 'promotions'],
        currentTenantId
      )
      if (Array.isArray(data.tables)) setTables(data.tables)
      if (Array.isArray(data.menu)) setMenu(data.menu)
      if (Array.isArray(data.toppings)) setToppings(data.toppings)
      if (data.shift !== undefined) setCurrentShift(data.shift)
      if (Array.isArray(data.openInvoices)) setOpenInvoices(data.openInvoices)
      if (data.promotions && typeof data.promotions === 'object') {
        setCachedPromotions(data.promotions)
        if (Array.isArray(data.promotions.happyHours)) {
          setActiveHappyHours(data.promotions.happyHours)
        }
      }
      if (updatedAt) setCacheUpdatedAt(updatedAt)
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await hydrateFromCache()
      return
    }

    try {
      const [banList, menuList, toppingList, shift, openList, bankCfg, kmDangChay, cachedCustomers] = await Promise.all([
        banService.getAll(),
        sanPhamService.getMenu(),
        orderService.getToppings(),
        caService.getCaHienTai(),
        orderService.getDangMo().catch(() => []),
        saasService.getBankSettings().catch(() => null),
        khuyenMaiService.getDangChay({ silent: true }).catch(() => null),
        khachHangService.getCache({ silent: true }).catch(() => null),
      ])
      const promoSnap = kmDangChay
        ? {
            happyHours: Array.isArray(kmDangChay.happyHours) ? kmDangChay.happyHours : [],
            codes: Array.isArray(kmDangChay.codes) ? kmDangChay.codes : [],
            vndMoiDiemDoi: Number(kmDangChay.vndMoiDiemDoi || 1000),
          }
        : null
      if (promoSnap) {
        setCachedPromotions(promoSnap)
        setActiveHappyHours(promoSnap.happyHours)
      }
      if (bankCfg) {
        if (bankCfg.accountNo) saveVietQrConfig(bankCfg)
        setBankForm((prev) => ({
          ...prev,
          ...bankCfg,
          sepayApiKey: bankCfg.hasSepayKey ? '********' : '',
          payosChecksumKey: bankCfg.hasPayosKey ? '********' : '',
        }))
      }
      const openArr = Array.isArray(openList) ? openList : []
      setTables(banList)
      setMenu(menuList)
      setToppings(toppingList)
      setCurrentShift(shift)
      setOpenInvoices(openArr)
      setCacheUpdatedAt(new Date().toISOString())
      // Lưu bản sao mới nhất xuống IndexedDB (Menu, Bàn, Ca, Khuyến mãi & Khách hàng — cô lập theo TenantId) để bán xuyên suốt khi đứt mạng
      void saveCatalogSnapshot(
        {
          tables: banList,
          menu: menuList,
          toppings: toppingList,
          shift,
          openInvoices: openArr,
          ...(promoSnap ? { promotions: promoSnap } : {}),
          ...(Array.isArray(cachedCustomers) ? { customers: cachedCustomers } : {}),
        },
        currentTenantId
      )
    } catch (err) {
      if (isNetworkError(err)) {
        setIsOnline(false)
        await hydrateFromCache()
      }
    }
  }, [setCurrentShift, currentTenantId])

  // [P1 PERF FIX] Tách tải dữ liệu vận hành tức thời (bàn + đơn mở + ca) khỏi tải danh mục tĩnh (menu + topping + bank)
  // Giảm 50-65% lượng API thừa mỗi khi có đơn thanh toán trong giờ cao điểm!
  const loadLiveOperations = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return
    try {
      const [banList, shift, openList] = await Promise.all([
        banService.getAll(),
        caService.getCaHienTai(),
        orderService.getDangMo().catch(() => []),
      ])
      const openArr = Array.isArray(openList) ? openList : []
      setTables(banList)
      setCurrentShift(shift)
      setOpenInvoices(openArr)
      void saveCatalogSnapshot({ tables: banList, shift, openInvoices: openArr }, currentTenantId)
    } catch (err) {
      if (isNetworkError(err)) setIsOnline(false)
    }
  }, [setCurrentShift, currentTenantId])

  const triggerOutboxSync = useCallback(
    async (includeFailed = false) => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return
      setSyncingOutbox(true)
      try {
        const res = await flushOutboxQueue({
          tenantId: currentTenantId,
          includeFailed,
          onUpdate: (jobs) => setOutboxJobs(jobs),
        })
        if (res.synced > 0) {
          toast.success(`✅ Đã tự động đồng bộ ${res.synced} đơn Offline lên máy chủ!`)
          if (res.shiftWarnings?.length > 0) {
            toast(`ℹ️ ${res.shiftWarnings[0]}`, { duration: 6000 })
          }
          await loadLiveOperations()
        }
        if (res.shiftNotOpen) {
          toast('⏳ Có đơn Offline đang chờ: hãy mở ca thu ngân mới, hệ thống sẽ tự động đẩy lên ngay!', {
            icon: '🕒',
            duration: 6000,
          })
        } else if (res.authExpired) {
          toast.error('🔐 Phiên đăng nhập hết hạn khi đồng bộ Offline — các đơn vẫn được giữ an toàn, hãy mở khóa PIN hoặc đăng nhập lại để đồng bộ tiếp!', {
            duration: 7000,
          })
        } else if (res.failed > 0) {
          toast.error(`⚠️ Có ${res.failed} đơn Offline cần kiểm tra trong hàng đợi!`)
        }
      } finally {
        setSyncingOutbox(false)
      }
    },
    [loadLiveOperations, currentTenantId]
  )

  useEffect(() => {
    const t = setTimeout(() => {
      void loadPosData()
      void refreshOutboxList()
      void refreshFailedPrintCount()
      void checkBridgeHealth().then((h) => setBridgeOnline(h.online))
    }, 0)

    const onPrintQueueChanged = () => {
      void refreshFailedPrintCount()
    }
    window.addEventListener('pos:print-queue-changed', onPrintQueueChanged)

    const onOnline = () => {
      setIsOnline(true)
      toast.success('🟢 Đã có kết nối Internet — Đang đồng bộ hàng đợi Offline...')
      void triggerOutboxSync(false)
      void loadPosData()
    }
    const onOffline = () => {
      setIsOnline(false)
      toast('📡 Đã chuyển sang chế độ OFFLINE — Bạn vẫn bán hàng & in bill bình thường!', {
        duration: 5000,
      })
    }
    const onSwMessage = (event) => {
      if (event.data?.type === 'TRIGGER_OUTBOX_SYNC') {
        void triggerOutboxSync(false)
      }
    }

    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    navigator.serviceWorker?.addEventListener('message', onSwMessage)

    // Quét định kỳ 30s nếu còn đơn Pending khi có mạng
    const syncTimer = setInterval(() => {
      if (navigator.onLine) {
        void getAllOutboxJobs().then((jobs) => {
          setOutboxJobs(jobs)
          if (jobs.some((j) => j.status === 'PENDING')) {
            void triggerOutboxSync(false)
          }
        })
      }
    }, 30000)

    return () => {
      clearTimeout(t)
      clearInterval(syncTimer)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('pos:print-queue-changed', onPrintQueueChanged)
      navigator.serviceWorker?.removeEventListener('message', onSwMessage)
    }
  }, [loadPosData, refreshOutboxList, refreshFailedPrintCount, triggerOutboxSync])

  // Đồng bộ Màn hình phụ Khách hàng (Customer Facing Display - /cfd) qua BroadcastChannel
  const postCfdMessage = useCallback((payload) => {
    if (typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel('pos_cfd_channel')
    channel.postMessage(payload)
    channel.close()
  }, [])

  useEffect(() => {
    const total = activeInvoice
      ? Number(activeInvoice.tongTamTinh || 0)
      : cart.reduce((s, item) => {
          const tp = (item.toppings || []).reduce((ts, t) => ts + Number(t.donGia) * Number(t.soLuong || 1), 0)
          return s + (Number(item.donGia) + tp) * Number(item.soLuong)
        }, 0)
    const paidAmount = activeInvoice ? Number(activeInvoice.daThanhToan || 0) : 0
    const remainingAmount = activeInvoice
      ? Number(activeInvoice.conLaiCanThu ?? Math.max(0, total - paidAmount))
      : total
    const transferMemo = activeInvoice ? `POSHD${activeInvoice.maHoaDon}` : 'POSCAFE'

    postCfdMessage({
      type: 'CFD_UPDATE',
      tableName: selectedTable?.tenBan || 'Đơn Mang Đi',
      customer,
      cart,
      activeInvoice,
      total,
      paidAmount,
      remainingAmount,
      transferMemo,
      vietQrUrl: remainingAmount > 0 ? buildVietQrUrl({ amount: remainingAmount, addInfo: transferMemo }) : null,
    })
  }, [cart, activeInvoice, selectedTable, customer, postCfdMessage])

  const activeInvoiceId = activeInvoice?.maHoaDon || null

  // Đồng bộ đầy đủ sự kiện real-time (kể cả khi mất mạng kết nối lại)
  const refreshActiveInvoice = useCallback(async () => {
    if (!activeInvoiceId) return
    try {
      const updated = await orderService.getById(activeInvoiceId)
      if (updated && updated.trangThaiTT === 0) setActiveInvoice(updated)
      else setActiveInvoice(null)
    } catch {
      // ignore
    }
  }, [activeInvoiceId, setActiveInvoice])

  useSocketEvents({
    connect: () => {
      setIsOnline(true)
      void triggerOutboxSync(false)
      void loadPosData()
    },
    BAN_THAY_DOI: ({ maBan, trangThai }) => {
      setTables((prev) => prev.map((b) => (b.maBan === maBan ? { ...b, trangThai } : b)))
    },
    BAN_CHUYEN: () => loadLiveOperations(),
    THUC_DON_THAY_DOI: ({ maMon, tamHet, tenMon }) => {
      setMenu((prev) => prev.map((m) => (m.maMon === maMon ? { ...m, tamHet } : m)))
      toast(tamHet ? `🚫 Quầy Bar báo TẠM HẾT: ${tenMon}` : `✅ Đã mở bán lại: ${tenMon}`)
    },
    TOPPING_THAY_DOI: ({ maTopping, tamHet, tenTopping }) => {
      setToppings((prev) => prev.map((t) => (t.maTopping === maTopping ? { ...t, tamHet } : t)))
      toast(tamHet ? `🚫 Quầy Bar báo HẾT TOPPING: ${tenTopping}` : `✅ Đã mở lại topping: ${tenTopping}`)
    },
    CA_THAY_DOI: () => loadLiveOperations(),
    HOADON_DA_TT: () => loadLiveOperations(),
    HOADON_DA_HOAN: (ev) => {
      toast(`↩️ Hóa đơn #${ev?.maHoaDon} vừa được hoàn ${formatVND(ev?.tongHoan || 0)}`, { duration: 5000 })
      loadLiveOperations()
    },
    VIETQR_DA_NHAN: (ev) => {
      playVietQrReceivedSound()
      const soTienText = formatVND(ev.soTienNhan)
      const tienThuaCk = Number(ev.tienChuyenThua || 0)
      if (ev.daHoanTat) {
        toast.success(`📱 VietQR TỰ ĐỘNG chốt HĐ #${ev.maHoaDon} (${ev.tenBan}): +${soTienText}`, {
          duration: 6000,
        })
        if (tienThuaCk > 0) {
          toast.error(
            `⚠️ Khách chuyển DƯ ${formatVND(tienThuaCk)} qua VietQR (HĐ #${ev.maHoaDon}) — nhớ trả lại tiền thừa cho khách!`,
            { duration: 10000 }
          )
          speakVietnamese(`Đã nhận chuyển khoản ${Math.round(ev.soTienNhan)} đồng. Chú ý khách chuyển thừa ${Math.round(tienThuaCk)} đồng.`)
        } else {
          speakVietnamese(`Đã nhận chuyển khoản ${Math.round(ev.soTienNhan)} đồng. Hóa đơn đã thanh toán hoàn tất.`)
        }
        postCfdMessage({
          type: 'CFD_PAID_SUCCESS',
          amount: ev.soTienNhan,
          message: `Hóa đơn #${ev.maHoaDon} (${ev.tenBan}) đã xác nhận tự động qua VietQR`,
        })
        if (String(activeInvoiceId) === String(ev.maHoaDon)) {
          if (ev.hoaDon) handlePrintInvoice(ev.hoaDon)
          setActiveInvoice(null)
          setCustomer(null)
        }
      } else {
        toast(`📱 VietQR nhận 1 phần HĐ #${ev.maHoaDon}: +${soTienText} (còn thiếu ${formatVND(ev.conLai)})`, {
          duration: 6000,
        })
        speakVietnamese(`Đã nhận chuyển khoản ${Math.round(ev.soTienNhan)} đồng, còn thiếu ${Math.round(ev.conLai)} đồng.`)
        if (String(activeInvoiceId) === String(ev.maHoaDon) && ev.hoaDon) {
          setActiveInvoice(ev.hoaDon)
        }
      }
      loadLiveOperations()
    },
    MON_DANG_LAM: () => refreshActiveInvoice(),
    MON_DA_XONG: () => refreshActiveInvoice(),
    MON_DA_PHUC_VU: () => refreshActiveInvoice(),
    QR_ORDER_MOI: (ev) => {
      playCashSuccessSound()
      setEcoCounts((prev) => ({ ...prev, qrPending: prev.qrPending + 1 }))
      toast(`📱 Đơn QR mới từ ${ev?.tenBan || 'Bàn'} (${ev?.soMon || 1} món) — Bấm duyệt 1 chạm!`, {
        duration: 7000,
      })
    },
    QR_ORDER_CAP_NHAT: () => {
      setEcoCounts((prev) => ({ ...prev, qrPending: Math.max(0, prev.qrPending - 1) }))
      loadLiveOperations()
    },
    AGGREGATOR_ORDER_MOI: (ev) => {
      playCashSuccessSound()
      setEcoCounts((prev) => ({ ...prev, aggNew: prev.aggNew + 1 }))
      toast(`🛵 Đơn mới từ ${ev?.nenTang || 'Sàn'} #${ev?.maDonNgoai || ''} — Nhận ngay vào Bar!`, {
        duration: 7000,
      })
    },
    AGGREGATOR_ORDER_CAP_NHAT: () => {
      setEcoCounts((prev) => ({ ...prev, aggNew: Math.max(0, prev.aggNew - 1) }))
    },
    MON_BI_HUY: () => {
      refreshActiveInvoice()
      loadLiveOperations()
    },
  })

  const handleSelectTable = async (ban) => {
    setSelectedTable(ban)
    if (!ban) return
    try {
      const hd = await orderService.getByTable(ban.maBan)
      setActiveInvoice(hd)
    } catch {
      setActiveInvoice(null)
    }
  }

  const handleOpenExistingInvoice = async (maHoaDon) => {
    try {
      const hd = await orderService.getById(maHoaDon)
      if (!hd) return
      if (hd.ban?.length) {
        const match = tables.find((t) => t.maBan === hd.ban[0].maBan)
        setSelectedTable(match || null)
      } else {
        setSelectedTable(null)
      }
      setActiveInvoice(hd)
      setShowOpenOrdersModal(false)
    } catch {
      // Interceptor xử lý
    }
  }

  const handleOpenShift = async (e) => {
    e.preventDefault()
    setOpeningShift(true)
    try {
      const res = await caService.moCa(Number(tienDauCaInput || 0))
      toast.success(res?.message || 'Đã mở ca thu ngân thành công!', {
        duration: res?.soGiaoDichTuDongGanCa > 0 ? 7000 : 3000,
      })
      await loadPosData()
    } catch {
      // Interceptor xử lý
    } finally {
      setOpeningShift(false)
    }
  }

  const buildOrderPayload = useCallback(
    () => {
      const cleanBuzzer = String(soTheRung || '').trim()
      return {
        maBan: selectedTable?.maBan || null,
        maHoaDon: !selectedTable && activeInvoice ? activeInvoice.maHoaDon : null,
        maKH: customer?.maKH || null,
        loaiDonHang: selectedTable ? 'TAI_QUAN' : orderType || 'MANG_DI',
        ...(tenKhachVangLai?.trim() ? { tenKhachVangLai: tenKhachVangLai.trim() } : {}),
        ...(cleanBuzzer ? { soTheRung: cleanBuzzer } : {}),
        ...(activeInvoice?.version ? { expectedVersion: activeInvoice.version } : {}),
        danhSachMon: cart.map((item) => ({
          maMon: item.maMon,
          kichThuoc: item.kichThuoc,
          soLuong: Number(item.soLuong),
          ghiChu: item.ghiChu || null,
          isTakeaway: Boolean(item.isTakeaway),
          courseNo: Number(item.courseNo || 1),
          fireStatus: item.fireStatus === 'HELD' ? 'HELD' : 'FIRED',
          modifiers: (item.modifiers || []).map((m) => ({
            groupId: m.groupId,
            optionId: m.optionId,
            qty: Number(m.qty || 1),
          })),
          toppings: (item.toppings || []).map((t) => ({
            maTopping: t.maTopping,
            soLuongMoiLy: Number(t.soLuongMoiLy ?? t.soLuong ?? 1),
            soLuong: Number(t.soLuongMoiLy ?? t.soLuong ?? 1),
          })),
        })),
      }
    },
    [selectedTable, activeInvoice, customer, cart, soTheRung, orderType, tenKhachVangLai]
  )

  const handlePrintInvoice = useCallback(
    async (hoaDon, extraOpts = {}) => {
      if (!hoaDon) return
      let printMeta = {
        soLanIn: 1,
        laBanSao: false,
        laTamTinh: hoaDon.trangThaiTT === 0,
        reprintBanner: null,
        printToken: null,
      }
      try {
        printMeta = await orderService.issuePrintToken(hoaDon.maHoaDon, {
          managerPin: extraOpts.managerPin || null,
          maNVDuyet: extraOpts.maNVDuyet || null,
          lyDo: extraOpts.lyDo || null,
        })
      } catch (err) {
        const status = err?.response?.status
        const code = err?.response?.data?.code || err?.response?.data?.maLoi
        if (status === 403 && (code === 'REPRINT_FORBIDDEN' || code === 'CAN_QUYEN_IN_LAI')) {
          const pin = window.prompt(
            'In lại hóa đơn (lần 2+) yêu cầu mã PIN Quản lý / Ca trưởng (4–6 số):'
          )
          if (!pin || !pin.trim()) {
            toast.error('Đã hủy in lại hóa đơn (cần PIN Quản lý)!')
            return
          }
          const lyDo = window.prompt('Lý do in lại hóa đơn:', 'Khách yêu cầu in lại bill') || 'In lại bill theo yêu cầu'
          try {
            printMeta = await orderService.issuePrintToken(hoaDon.maHoaDon, {
              managerPin: pin.trim(),
              lyDo: lyDo.trim(),
            })
          } catch (retryErr) {
            toast.error(retryErr?.response?.data?.message || 'PIN Quản lý không hợp lệ — từ chối in lại!')
            return
          }
        } else if (err?.response) {
          // Lỗi từ máy chủ (400/401/403/404) -> không bỏ qua kiểm soát in!
          return
        }
        // Chỉ fallback in cục bộ khi mất kết nối mạng hoàn toàn (!err.response)
      }
      const res = await printReceiptK80(hoaDon, {
        ...printMeta,
        ...extraOpts,
        thuNgan: user?.tenNV || '',
        tenQuan: user?.tenQuan || '',
      })
      if (res?.mode === 'BRIDGE') {
        toast.success(`🖨️ Đã in Bill #${hoaDon.maHoaDon} (Silent Print)${extraOpts.isCashPayment ? ' + Mở két RJ11' : ''}`, {
          duration: 2500,
        })
      }
    },
    [user?.tenNV, user?.tenQuan]
  )

  const handleSubmitOrder = useCallback(async () => {
    if (cart.length === 0) return
    if (!currentShift) {
      toast.error('Bạn cần mở ca thu ngân trước khi tạo đơn!')
      return
    }
    if (submitLockRef.current) return
    submitLockRef.current = true
    setSubmitting(true)
    const payload = buildOrderPayload()
    const dauVanTay = JSON.stringify(payload)
    if (!orderKeyRef.current || orderKeyRef.current.dauVanTay !== dauVanTay) {
      orderKeyRef.current = { key: newIdempotencyKey(), dauVanTay }
    }
    const idemKey = orderKeyRef.current.key

    const enqueueLocally = async () => {
      const job = await saveOfflineOrder({
        type: 'ORDER_CREATE',
        payload,
        cart,
        selectedTable,
        customer,
        idempotencyKey: idemKey,
        tenantId: currentTenantId,
        maCaThuNganGoc: currentShift?.maCaThuNgan || null,
      })
      orderKeyRef.current = null
      await refreshOutboxList()
      clearCart()
      setSoTheRung('')
      if (selectedTable?.maBan) {
        setTables((prev) =>
          prev.map((b) => (b.maBan === selectedTable.maBan ? { ...b, trangThai: 2 } : b))
        )
        setSelectedTable({ ...selectedTable, trangThai: 2 })
      }
      toast.success(`📡 Đã lưu Offline (${job.localInvoice.maHoaDon})! Sẽ tự đồng bộ khi có mạng.`, {
        duration: 5000,
      })
      printReceiptK80(job.localInvoice, { laDonOffline: true, thuNgan: user?.tenNV || '', tenQuan: user?.tenQuan || '' })
    }

    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await enqueueLocally()
        return
      }
      const res = await orderService.create(payload, idemKey, { silent: true })
      orderKeyRef.current = null
      const sttStr = Number(res.hoaDon?.soThuTuNgay) > 0 ? ` • Số #${String(res.hoaDon.soThuTuNgay).padStart(2, '0')}` : ''
      toast.success(`${res.message || `Đã tạo order #${res.maHoaDon}`}${sttStr}`)
      if (res.canhBaoTonThap?.length) {
        toast(
          `⚠️ Tồn kho thấp: ${res.canhBaoTonThap.map((n) => `${n.tenNL} (còn ${n.conLai} ${n.donViTinh})`).join(', ')}`,
          { duration: 5000 }
        )
      }
      clearCart()
      setSoTheRung('')
      setActiveInvoice(res.hoaDon)
      await loadPosData()
    } catch (err) {
      if (isNetworkError(err)) {
        setIsOnline(false)
        await enqueueLocally()
      } else {
        toast.error(err.response?.data?.message || 'Không thể tạo order!')
      }
    } finally {
      submitLockRef.current = false
      setSubmitting(false)
    }
  }, [
    cart,
    currentShift,
    buildOrderPayload,
    selectedTable,
    customer,
    currentTenantId,
    refreshOutboxList,
    clearCart,
    setSelectedTable,
    user?.tenNV,
    user?.tenQuan,
    setActiveInvoice,
    loadPosData,
  ])

  // [P0] Thanh toán nhanh 1 chạm cho Counter / Mang đi (hỗ trợ Offline Outbox Queue!)
  const handleQuickCheckout = useCallback(
    async (phuongThucTT = 'TIEN_MAT') => {
      if (cart.length === 0) return
      if (!currentShift) {
        toast.error('Bạn cần mở ca thu ngân trước khi bán hàng!')
        return
      }
      if (!canManageCash) {
        toast.error('Chỉ Thu ngân / Quản lý mới có quyền thanh toán!')
        return
      }
      if (submitLockRef.current) return
      submitLockRef.current = true
      setSubmitting(true)
      const payload = {
        ...buildOrderPayload(),
        phuongThucTT,
        maKhuyenMai: promoCodeInput.trim().toUpperCase() || null,
        diemSuDung: Math.max(0, Math.floor(Number(diemSuDungInput || 0))),
      }
      const dauVanTay = JSON.stringify(payload)
      if (!orderKeyRef.current || orderKeyRef.current.dauVanTay !== dauVanTay) {
        orderKeyRef.current = { key: newIdempotencyKey(), dauVanTay }
      }
      const idemKey = orderKeyRef.current.key

      const enqueueQuickLocally = async () => {
        const job = await saveOfflineOrder({
          type: 'QUICK_CHECKOUT',
          payload,
          cart,
          selectedTable,
          customer,
          promoPreview,
          idempotencyKey: idemKey,
          tenantId: currentTenantId,
          maCaThuNganGoc: currentShift?.maCaThuNgan || null,
        })
        orderKeyRef.current = null
        await refreshOutboxList()
        playCashSuccessSound()
        toast.success(`📡 Đã thu Offline (${job.localInvoice.maHoaDon}) & in bill! Tự đồng bộ khi có mạng.`, {
          duration: 5000,
        })
        clearCart()
        setSoTheRung('')
        setPromoCodeInput('')
        setDiemSuDungInput('')
        setPromoPreview(null)
        setCustomer(null)
        setActiveInvoice(null)
        printReceiptK80(job.localInvoice, { laDonOffline: true, thuNgan: user?.tenNV || '', tenQuan: user?.tenQuan || '' })
      }

      try {
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          await enqueueQuickLocally()
          return
        }
        const res = await orderService.quickCheckout(payload, idemKey, { silent: true })
        orderKeyRef.current = null
        playCashSuccessSound()
        const sttStr = Number(res.hoaDon?.soThuTuNgay) > 0 ? ` (Số #${String(res.hoaDon.soThuTuNgay).padStart(2, '0')})` : ''
        toast.success(
          `⚡ Thu nhanh ${phuongThucTT === 'CHUYEN_KHOAN' ? 'VietQR' : 'Tiền mặt'} thành công${sttStr}!${
            res.diemCong ? ` (+${res.diemCong} điểm KH)` : ''
          }`
        )
        clearCart()
        setSoTheRung('')
        setPromoCodeInput('')
        setDiemSuDungInput('')
        setPromoPreview(null)
        setCustomer(null)
        setActiveInvoice(null)
        if (res.hoaDon) {
          void handlePrintInvoice(res.hoaDon, { isCashPayment: phuongThucTT === 'TIEN_MAT' })
        }
        await loadPosData()
      } catch (err) {
        if (isNetworkError(err)) {
          setIsOnline(false)
          await enqueueQuickLocally()
        } else {
          toast.error(err.response?.data?.message || 'Không thể thanh toán nhanh!')
        }
      } finally {
        submitLockRef.current = false
        setSubmitting(false)
      }
    },
    [
      cart,
      currentShift,
      canManageCash,
      buildOrderPayload,
      promoCodeInput,
      diemSuDungInput,
      promoPreview,
      selectedTable,
      customer,
      currentTenantId,
      refreshOutboxList,
      clearCart,
      setCustomer,
      setActiveInvoice,
      user?.tenNV,
      user?.tenQuan,
      handlePrintInvoice,
      loadPosData,
    ]
  )

  const handleApplyPromo = useCallback(
    async ({ tongTamTinh, maKhuyenMai, maKH, diemSuDung }) => {
      const applyOfflinePreview = () => {
        try {
          const baseTotal = activeInvoice?.tongTamTinh ?? tongTamTinh
          const preview = evaluateOfflinePromo({
            promotions: cachedPromotions,
            tongTamTinh: baseTotal,
            maKhuyenMai,
            customer,
            diemSuDung,
            tuDongHappyHour: true,
          })
          setPromoPreview(preview)
          if (preview.tongGiamGia > 0) {
            toast.success(`📡 Đã áp ưu đãi Offline (giảm ${formatVND(preview.tongGiamGia)}) — sẽ đối soát khi có mạng!`)
          } else {
            toast('Không có ưu đãi giảm giá phù hợp trong bộ nhớ Offline.', { icon: 'ℹ️' })
          }
        } catch (offErr) {
          setPromoPreview(null)
          toast.error(offErr.message || 'Mã khuyến mãi không hợp lệ!')
        }
      }

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        applyOfflinePreview()
        return
      }

      try {
        // [P0 FIX] Nếu đang có hóa đơn mở -> khóa/lưu trực tiếp xuống HoaDon trên DB để VietQR Webhook khớp 100%!
        if (activeInvoice?.maHoaDon) {
          const res = await orderService.apUuDai(activeInvoice.maHoaDon, {
            maKhuyenMai,
            diemSuDung,
            maKH: maKH || customer?.maKH || null,
            tuDongHappyHour: true,
            goBo: false,
          })
          if (res.hoaDon) setActiveInvoice(res.hoaDon)
          setPromoPreview(null)
          toast.success(res.message || 'Đã áp ưu đãi lên hóa đơn!')
          return
        }
        const preview = await khuyenMaiService.kiemTra({
          tongTamTinh,
          maKhuyenMai,
          maKH,
          diemSuDung,
        })
        setPromoPreview(preview)
        if (preview.tongGiamGia > 0) {
          toast.success(`🎁 Đã áp ưu đãi giảm ${formatVND(preview.tongGiamGia)}!`)
        } else {
          toast('Không có ưu đãi giảm giá nào được áp dụng cho đơn này.', { icon: 'ℹ️' })
        }
      } catch (err) {
        if (isNetworkError(err)) {
          setIsOnline(false)
          applyOfflinePreview()
        } else {
          setPromoPreview(null)
        }
      }
    },
    [activeInvoice, customer, setActiveInvoice, cachedPromotions]
  )

  const handleClearPromo = useCallback(async () => {
    if (
      activeInvoice?.maHoaDon &&
      Number(activeInvoice.tongGiamGia || 0) > 0 &&
      Number(activeInvoice.daThanhToan || 0) === 0
    ) {
      try {
        const res = await orderService.apUuDai(activeInvoice.maHoaDon, { goBo: true })
        if (res.hoaDon) setActiveInvoice(res.hoaDon)
        toast.success(res.message || 'Đã gỡ ưu đãi khỏi hóa đơn!')
      } catch {
        // Interceptor xử lý
      }
    }
    setPromoCodeInput('')
    setDiemSuDungInput('')
    setPromoPreview(null)
  }, [activeInvoice, setActiveInvoice])

  const handlePayInvoice = async ({
    maHoaDon,
    phuongThucTT,
    maKhuyenMai,
    diemSuDung,
    tienKhachDua,
    thanhToan,
    choPhepThuMotPhan,
    chiaTienId = null,
  }) => {
    if (payLockRef.current) return
    payLockRef.current = true
    setPaying(true)
    const payPayload = {
      maHoaDon,
      phuongThucTT,
      maKH: customer?.maKH || null,
      maKhuyenMai: maKhuyenMai || null,
      diemSuDung: Number(diemSuDung || 0),
      tienKhachDua,
      thanhToan,
      choPhepThuMotPhan,
      ...(chiaTienId ? { chiaTienId } : {}),
      ...(activeInvoice?.version ? { expectedVersion: activeInvoice.version } : {}),
    }
    const payIdemKey = newIdempotencyKey()

    const enqueuePayLocally = async () => {
      const job = await saveOfflineOrder({
        type: 'INVOICE_PAY',
        payload: payPayload,
        existingInvoice: activeInvoice || { maHoaDon, ban: selectedTable ? [selectedTable] : [], danhSachMon: [] },
        selectedTable,
        customer,
        promoPreview,
        idempotencyKey: payIdemKey,
        tenantId: currentTenantId,
        maCaThuNganGoc: currentShift?.maCaThuNgan || null,
      })
      await refreshOutboxList()
      playCashSuccessSound()
      toast.success(`📡 Đã chốt thanh toán bàn Offline (${job.payload.offlineClientId}) & in bill! Tự đồng bộ khi có mạng.`, {
        duration: 5000,
      })
      printReceiptK80(job.localInvoice, { laDonOffline: true, thuNgan: user?.tenNV || '', tenQuan: user?.tenQuan || '' })
      setOpenInvoices((prev) => prev.filter((inv) => String(inv.maHoaDon) !== String(maHoaDon)))
      if (selectedTable?.maBan) {
        setTables((prev) =>
          prev.map((b) => (b.maBan === selectedTable.maBan ? { ...b, trangThai: 1 } : b))
        )
        setSelectedTable({ ...selectedTable, trangThai: 1 })
      }
      setActiveInvoice(null)
      setCustomer(null)
      setPromoCodeInput('')
      setDiemSuDungInput('')
      setPromoPreview(null)
    }

    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await enqueuePayLocally()
        return
      }
      const res = await orderService.thanhToan(payPayload, payIdemKey, { silent: true })
      playCashSuccessSound()
      if (res.daHoanTat) {
        toast.success(
          `Thanh toán hoàn tất!${res.tienThua ? ` Tiền thối: ${formatVND(res.tienThua)}` : ''}${
            res.diemCong ? ` (+${res.diemCong} điểm)` : ''
          }`
        )
        postCfdMessage({
          type: 'CFD_PAID_SUCCESS',
          amount: res.hoaDon?.tongTienThanhToan || res.hoaDon?.tongTamTinh || 0,
          message: `Hóa đơn #${maHoaDon} đã thanh toán thành công`,
        })
        const hasCashPayment =
          phuongThucTT === 'TIEN_MAT' ||
          (Array.isArray(thanhToan) && thanhToan.some((t) => t.phuongThucTT === 'TIEN_MAT' && Number(t.soTien) > 0))
        await handlePrintInvoice(res.hoaDon, { isCashPayment: hasCashPayment })
        setActiveInvoice(null)
        setCustomer(null)
        handleClearPromo()
        await loadPosData()
        if (selectedTable) setSelectedTable({ ...selectedTable, trangThai: 3 })
      } else {
        toast.success(res.message)
        setActiveInvoice(res.hoaDon)
        await loadPosData()
      }
    } catch (err) {
      if (isNetworkError(err)) {
        setIsOnline(false)
        await enqueuePayLocally()
      } else if (err?.response?.status === 409 && err?.response?.data?.maLoi === 'ORDER_CONCURRENT_MODIFIED') {
        const latest = err.response.data?.hoaDonMoiNhat
        if (latest) setActiveInvoice(latest)
        const bannerMsg =
          err.response.data?.message ||
          `${selectedTable?.tenBan || `HĐ #${maHoaDon}`} vừa được thiết bị khác cập nhật thêm món — vui lòng kiểm tra lại tổng tiền mới trước khi thu!`
        setConcurrencyBanner(bannerMsg)
        toast.error(bannerMsg, { duration: 6000 })
        await loadLiveOperations()
      } else {
        toast.error(err?.response?.data?.message || 'Không thể thanh toán hóa đơn!')
      }
    } finally {
      payLockRef.current = false
      setPaying(false)
    }
  }

  const handleSimulateVietQr = async (maHoaDon, soTien) => {
    setPaying(true)
    try {
      await orderService.simulateVietQrWebhook({ maHoaDon, soTien })
      // Socket VIETQR_DA_NHAN sẽ tự động thông báo, đọc giọng nói & chốt màn hình!
    } catch {
      // Interceptor xử lý
    } finally {
      setPaying(false)
    }
  }

  const handleStartVietQrOrder = useCallback(async () => {
    await handleSubmitOrder()
    setPreferVietQrKey((k) => k + 1)
    toast('📱 Đã mở đơn & bật mã VietQR chờ Webhook ngân hàng tự động xác nhận!', { icon: '🏦' })
  }, [handleSubmitOrder])

  const handleVoidInvoiceItem = (item) => {
    setVoidTarget(item)
    setVoidReason('')
    setVoidPin('')
    if (
      (item?.trangThaiPhaChe !== 'ChoPhaChe' || activeInvoice?.daInTamTinh) &&
      !canApproveVoidOrRefund
    ) {
      authService
        .getStaffQuickList()
        .then((res) => {
          const list = (res?.danhSachNV || []).filter((s) => s.coQuyenDuyetPin && s.daDatPin)
          setPinApprovers(list)
          if (list.length > 0) setVoidApproverId((prev) => prev || list[0].maNV)
        })
        .catch(() => {})
    }
  }

  const handleConfirmVoidItem = async (e) => {
    e.preventDefault()
    if (!voidTarget) return
    const daPha = voidTarget.trangThaiPhaChe !== 'ChoPhaChe'
    const canPin = (daPha || activeInvoice?.daInTamTinh) && !canApproveVoidOrRefund
    if (voidReason.trim().length < 3) {
      toast.error('Vui lòng chọn hoặc nhập lý do hủy món (tối thiểu 3 ký tự)!')
      return
    }
    if (canPin && !/^\d{4,6}$/.test(voidPin.trim())) {
      toast.error('Hóa đơn đã in tạm tính hoặc món đã pha — cần nhập mã PIN Quản lý / Ca trưởng (4–6 số)!')
      return
    }
    setVoidSubmitting(true)
    try {
      const res = await orderService.huyMon({
        maCTHD: voidTarget.maCTHD,
        lyDo: voidReason.trim(),
        hoanKho: !daPha,
        managerPin: canPin ? voidPin.trim() : null,
        maNVDuyet: canPin && voidApproverId ? voidApproverId : null,
        expectedVersion: activeInvoice?.version || 1,
      })
      toast.success(res.message)
      setActiveInvoice(res.hoaDon)
      setVoidTarget(null)
      await loadLiveOperations()
    } catch {
      // Interceptor xử lý
    } finally {
      setVoidSubmitting(false)
    }
  }

  const handleOpenSplitBill = () => {
    if (!activeInvoice) return
    setSplitQtyMap({})
    setSplitDestTable('')
    setShowSplitModal(true)
  }

  const handleConfirmSplitBill = async (e) => {
    e.preventDefault()
    const splitItems = Object.entries(splitQtyMap)
      .map(([maCTHD, soLuong]) => ({ maCTHD: Number(maCTHD), soLuong: Number(soLuong) }))
      .filter((it) => it.maCTHD > 0 && it.soLuong > 0)
    if (!activeInvoice || splitItems.length === 0) {
      toast.error('Vui lòng chọn ít nhất 1 món / 1 ly để tách!')
      return
    }
    const destObj = splitDestTable ? tables.find((t) => t.maBan === splitDestTable) : null
    const mode = destObj && Number(destObj.trangThai) === 2 ? 'TRANSFER_TO_TABLE' : 'NEW_INVOICE'

    setSplitSubmitting(true)
    try {
      const res = await orderService.tachDon({
        maHoaDon: activeInvoice.maHoaDon,
        splitItems,
        toMaBan: splitDestTable || null,
        mode,
        expectedVersion: activeInvoice?.version || 1,
      })
      toast.success(res.message)
      setShowSplitModal(false)
      if (res.hoaDonMoi) {
        if (splitDestTable) {
          setSelectedTable(destObj ? { ...destObj, trangThai: 2 } : null)
        } else {
          setSelectedTable(null)
        }
        setActiveInvoice(res.hoaDonMoi)
      }
      await loadLiveOperations()
    } catch {
      // Interceptor xử lý
    } finally {
      setSplitSubmitting(false)
    }
  }

  const handleConfirmSplitEqual = async (soNguoi) => {
    if (!activeInvoice) return
    setSplitSubmitting(true)
    try {
      const res = await orderService.tachDon({
        maHoaDon: activeInvoice.maHoaDon,
        mode: 'SPLIT_EQUAL',
        soNguoi,
        expectedVersion: activeInvoice.version,
      })
      toast.success(res.message)
      if (res.hoaDon) setActiveInvoice(res.hoaDon)
      setShowSplitModal(false)
      await loadLiveOperations()
    } catch {
      // Interceptor xử lý
    } finally {
      setSplitSubmitting(false)
    }
  }

  const handleConfirmSplitAmount = async (shares) => {
    if (!activeInvoice) return
    setSplitSubmitting(true)
    try {
      const res = await orderService.tachDon({
        maHoaDon: activeInvoice.maHoaDon,
        mode: 'SPLIT_AMOUNT',
        shares,
        expectedVersion: activeInvoice.version,
      })
      toast.success(res.message)
      if (res.hoaDon) setActiveInvoice(res.hoaDon)
      setShowSplitModal(false)
      await loadLiveOperations()
    } catch {
      // Interceptor xử lý
    } finally {
      setSplitSubmitting(false)
    }
  }

  const handleFireCourse = async (maHoaDon) => {
    try {
      const res = await orderService.fireCourse(maHoaDon, { courseNo: 2 })
      toast.success(res.message || '🔥 Đã báo bếp ra món!')
      if (res.hoaDon) setActiveInvoice(res.hoaDon)
      await loadLiveOperations()
    } catch {
      // Interceptor xử lý
    }
  }

  const handleOpenEditCartItem = (idx, item) => {
    const product = menu.find((m) => m.maMon === item.maMon) || {
      maMon: item.maMon,
      tenMon: item.tenMon,
      nhomMon: '',
      sizes: [{ kichThuoc: item.kichThuoc, giaBan: item.donGia }],
      modifierGroups: [],
    }
    setEditingCartTarget({ idx, item, product })
  }

  const handleSplitCartItemAndEdit = (idx) => {
    const newIdx = splitCartItem(idx)
    if (newIdx >= 0) {
      const freshCart = usePosStore.getState().cart
      const newItem = freshCart[newIdx]
      if (newItem) handleOpenEditCartItem(newIdx, newItem)
    }
  }

  const handleCloneCartItemAndEdit = (idx) => {
    const newIdx = cloneCartItem(idx)
    if (newIdx >= 0) {
      const freshCart = usePosStore.getState().cart
      const newItem = freshCart[newIdx]
      if (newItem) handleOpenEditCartItem(newIdx, newItem)
    }
  }

  // [P1] Bộ phím tắt tốc độ cao chuẩn POS (F1, F2, F4, F8, F9, F10, ESC)
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        setPickingProduct(null)
        setShowThuChiModal(false)
        setShowDongCaModal(false)
        setShowOpenOrdersModal(false)
        setShowBankModal(false)
        setShowOfflineModal(false)
        setShowPrintModal(false)
        setShowPaidHistoryModal(false)
        setVoidTarget(null)
        setShowSplitModal(false)
        return
      }
      if (e.key === 'F1') {
        e.preventDefault()
        searchInputRef.current?.focus()
      } else if (e.key === 'F2') {
        e.preventDefault()
        setSelectedTable(null)
      } else if (e.key === 'F4') {
        e.preventDefault()
        if (holdCurrentOrder()) toast.success('⏸️ Đã lưu tạm đơn hàng (F4)!')
      } else if (e.key === 'F8') {
        e.preventDefault()
        customerInputRef.current?.focus()
      } else if (e.key === 'F9') {
        e.preventDefault()
        if (!selectedTable && !activeInvoice && cart.length > 0 && canManageCash) {
          handleQuickCheckout('TIEN_MAT')
        }
      } else if (e.key === 'F10') {
        e.preventDefault()
        // Chống gian lận F10 chốt chuyển khoản không kiểm tiền: tạo hóa đơn mở & bật VietQR chờ Webhook xác nhận thật!
        if (!selectedTable && !activeInvoice && cart.length > 0 && canManageCash) {
          void handleStartVietQrOrder()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setSelectedTable, holdCurrentOrder, selectedTable, activeInvoice, cart.length, canManageCash, handleQuickCheckout, handleStartVietQrOrder])

  // [PHÂN HỆ 6] Trình nghe Súng Quét Mã Vạch Toàn Cục (Global HID Barcode Listener <50ms/ký tự)
  const handleBarcodeScanned = useCallback(
    async (rawCode) => {
      const code = String(rawCode || '').trim()
      if (!code) return
      const upper = code.toUpperCase()

      // 1. Khớp mã món / SKU nước đóng chai trong Menu -> Tự động +1 vào giỏ hàng
      const matchedProduct = menu.find((m) => String(m.maMon || '').toUpperCase() === upper)
      if (matchedProduct) {
        if (matchedProduct.tamHet) {
          toast.error(`🚫 Món "${matchedProduct.tenMon}" đang TẠM HẾT (86)!`)
          return
        }
        const defSize =
          matchedProduct.sizes?.find((s) => s.kichThuoc === 'M') ||
          matchedProduct.sizes?.[0] || { kichThuoc: 'M', giaBan: 0 }
        addToCart({
          maMon: matchedProduct.maMon,
          tenMon: matchedProduct.tenMon,
          kichThuoc: defSize.kichThuoc,
          donGia: Number(defSize.giaBan),
          soLuong: 1,
          ghiChu: '',
          toppings: [],
        })
        toast.success(`🔫 [Barcode] +1 ${matchedProduct.tenMon} (${defSize.kichThuoc})`, {
          duration: 1800,
        })
        return
      }

      // 2. Khớp SĐT khách hàng (10 chữ số bắt đầu bằng 0) hoặc thẻ thành viên KH... -> Tự động tra cứu & gắn Loyalty
      if (/^0\d{9}$/.test(code) || /^KH[_-]?\w+/i.test(code)) {
        try {
          const kh = await khachHangService.traCuu(code)
          if (kh) {
            setCustomer(kh)
            toast.success(`🔫 [Thẻ KH] Đã gắn khách hàng: ${kh.tenKH} (⭐ ${kh.diemTichLuy} điểm)`)
          } else {
            toast.error(`🔫 Chưa tìm thấy khách hàng có mã/SĐT "${code}"!`)
          }
        } catch {
          toast.error(`🔫 Không tra cứu được mã khách hàng "${code}"!`)
        }
        return
      }

      // 3. Mặc định: coi là mã Voucher / Khuyến mãi -> Tự động điền và áp ưu đãi
      setPromoCodeInput(upper)
      const currentTotal = activeInvoice
        ? Number(activeInvoice.tongTamTinh || 0)
        : cart.reduce((s, item) => {
            const tp = (item.toppings || []).reduce(
              (ts, t) => ts + Number(t.donGia) * Number(t.soLuong || 1),
              0
            )
            return s + (Number(item.donGia) + tp) * Number(item.soLuong)
          }, 0)
      if (currentTotal > 0) {
        toast(`🔫 Đang kiểm tra mã Voucher "${upper}"...`, { icon: '🎟️' })
        await handleApplyPromo({
          tongTamTinh: currentTotal,
          maKhuyenMai: upper,
          maKH: customer?.maKH || null,
          diemSuDung: Number(diemSuDungInput || 0),
        })
      } else {
        toast.success(`🔫 Đã nhận mã ưu đãi "${upper}" — hãy chọn món để áp dụng!`)
      }
    },
    [menu, addToCart, setCustomer, activeInvoice, cart, handleApplyPromo, customer, diemSuDungInput]
  )

  useBarcodeScanner({ onScan: handleBarcodeScanned, enabled: true })

  // [PHÂN HỆ 8] Tải gợi ý AI Smart Upsell theo giỏ hàng hiện tại (debounced)
  const cartMaMonKey = cart.map((c) => c.maMon).join(',')
  useEffect(() => {
    if (!isOnline || menu.length === 0) return undefined
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const ids = cartMaMonKey ? cartMaMonKey.split(',') : []
        const res = await ecosystemService.getSmartUpsell(ids)
        if (!cancelled && Array.isArray(res?.suggestions)) {
          setUpsellSuggestions(res.suggestions)
        }
      } catch {
        // ignore
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [cartMaMonKey, isOnline, menu.length])

  const handleQuickAddUpsell = useCallback(
    (u) => {
      const prod = menu.find((m) => m.maMon === u.maMon)
      const sz = prod?.sizes?.find((s) => s.kichThuoc === u.kichThuoc) || prod?.sizes?.[0]
      addToCart({
        maMon: u.maMon,
        tenMon: u.tenMon,
        kichThuoc: sz?.kichThuoc || u.kichThuoc || 'M',
        donGia: Number(u.giaGoiY ?? sz?.giaBan ?? 0),
        soLuong: 1,
        toppings: [],
        ghiChu: u.dangGiamGiaBanh ? `[Bakery -${u.phanTramGiam}%]` : '',
      })
      toast.success(`✨ Đã thêm gợi ý: ${u.tenMon}`, { duration: 1400 })
    },
    [menu, addToCart]
  )

  const ecoAlertTotal = ecoCounts.qrPending + ecoCounts.aggNew
  const takeawayOpenCount = openInvoices.filter((o) => o.mangDi).length

  const themeClass =
    posTheme === 'dark'
      ? 'pos-theme-dark'
      : posTheme === 'high-contrast'
      ? 'pos-theme-high-contrast'
      : 'bg-stone-100'

  return (
    <div className={`min-h-screen flex flex-col ${themeClass}`}>
      <header className="bg-stone-900 text-white px-4 py-3 flex flex-wrap items-center justify-between gap-2 shadow">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-extrabold text-amber-400">
            ☕ {user?.tenQuan || 'POS Bán Hàng'}
          </span>
          <span className="text-xs bg-stone-800 px-3 py-1.5 rounded-full text-stone-300 font-semibold">
            {user?.tenNV}
          </span>

          {currentShift ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs bg-emerald-900/80 border border-emerald-600 text-emerald-200 px-3 py-1.5 rounded-full font-semibold">
                🟢 Ca #{currentShift.maCaThuNgan}
                {/* Blind Drop: Chỉ Quản lý mới thấy quỹ lý thuyết; Thu ngân hoàn toàn không thấy */}
                {!currentShift.blindMode && currentShift.tienMatLyThuyet !== undefined && (
                  <> • Quỹ LT: <b>{formatVND(currentShift.tienMatLyThuyet)}</b></>
                )}
              </span>

              {canManageCash && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowThuChiModal(true)}
                    className="min-h-10 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold cursor-pointer transition shadow"
                  >
                    💵 Thu/Chi/Rút két
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDongCaModal(true)}
                    className="min-h-10 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-bold cursor-pointer transition shadow"
                  >
                    🔒 Đóng ca
                  </button>
                </>
              )}
            </div>
          ) : canManageCash ? (
            <form onSubmit={handleOpenShift} className="flex items-center gap-1.5">
              <span className="text-xs text-amber-300 font-semibold">⚠️ Chưa mở ca:</span>
              <input
                type="number"
                value={tienDauCaInput}
                onChange={(e) => setTienDauCaInput(e.target.value)}
                placeholder="Tiền đầu ca..."
                className="w-28 min-h-9 px-2 py-1 rounded-lg bg-stone-800 border border-stone-600 text-xs text-white"
              />
              <button
                type="submit"
                disabled={openingShift}
                className="min-h-9 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-bold cursor-pointer"
              >
                Mở ca ngay
              </button>
            </form>
          ) : (
            <span className="text-xs text-amber-300 font-semibold">
              ⚠️ Chờ Thu ngân / Quản lý mở ca
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Nút Trạng thái Mạng & Hàng đợi Offline Outbox */}
          <button
            type="button"
            onClick={() => setShowOfflineModal(true)}
            className={`min-h-10 px-3 py-1.5 rounded-xl text-xs font-extrabold cursor-pointer border transition ${
              !isOnline
                ? 'bg-red-600 border-red-400 text-white animate-pulse'
                : outboxJobs.length > 0
                ? 'bg-amber-500 border-amber-300 text-stone-950'
                : 'bg-emerald-950/70 border-emerald-700 text-emerald-300 hover:bg-emerald-900/70'
            }`}
            title="Xem & đồng bộ hàng đợi đơn hàng Offline (IndexedDB)"
          >
            {!isOnline
              ? `📡 OFFLINE (${outboxJobs.length} chờ)`
              : syncingOutbox
              ? `🔄 Đang đồng bộ (${outboxJobs.length})...`
              : outboxJobs.length > 0
              ? `📤 Chờ đồng bộ (${outboxJobs.length})`
              : '🟢 Online • PWA'}
          </button>

          <button
            type="button"
            onClick={() => setShowOpenOrdersModal(true)}
            className="min-h-10 px-3 py-1.5 bg-stone-800 hover:bg-stone-700 border border-stone-600 rounded-xl text-xs font-bold cursor-pointer"
            title="Xem mọi đơn đang chờ thanh toán (kể cả đơn Mang đi)"
          >
            📋 Đơn chưa thu ({openInvoices.length}
            {takeawayOpenCount > 0 ? ` • ${takeawayOpenCount} Mang đi` : ''})
          </button>

          {canManageCash && (
            <button
              type="button"
              onClick={() => setShowPaidHistoryModal(true)}
              className="min-h-10 px-3 py-1.5 bg-stone-800 hover:bg-stone-700 border border-stone-600 rounded-xl text-xs font-bold cursor-pointer"
              title="Xem hóa đơn đã thanh toán trong ngày & Hoàn tiền sau thu"
            >
              🧾 Đã thu / Hoàn
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowPrintModal(true)}
            className={`min-h-12 px-3.5 py-2 rounded-xl text-xs font-extrabold cursor-pointer border transition ${
              failedPrintCount > 0
                ? 'bg-rose-600 border-rose-300 text-white animate-pulse shadow-md'
                : bridgeOnline
                ? 'bg-emerald-950/70 border-emerald-600 text-emerald-300 hover:bg-emerald-900/70'
                : 'bg-stone-800 hover:bg-stone-700 border-stone-600 text-stone-200'
            }`}
            title={
              failedPrintCount > 0
                ? `Có ${failedPrintCount} lệnh in bị lỗi — Bấm để in lại ngay!`
                : 'Cấu hình Print Bridge / Cloud Relay / WebBluetooth / WebUSB / Két tiền RJ11'
            }
          >
            {failedPrintCount > 0
              ? `🚨 In lỗi (${failedPrintCount}) — In lại`
              : bridgeOnline
              ? '🖨️ Silent Print'
              : '🖨️ Máy in'}
          </button>

          <button
            type="button"
            onClick={cyclePosTheme}
            className="min-h-12 px-3 py-2 bg-stone-800 hover:bg-stone-700 border border-stone-600 rounded-xl text-xs font-bold cursor-pointer"
            title="Chuyển đổi giao diện Sáng / Tối (Lounge) / Tương phản cao (Quầy ngoài trời nắng gắt)"
          >
            {posTheme === 'dark'
              ? '🌙 Tối'
              : posTheme === 'high-contrast'
              ? '🔆 Nắng gắt'
              : '☀️ Sáng'}
          </button>

          <button
            type="button"
            onClick={() => window.open('/cfd', 'pos_cfd', 'width=900,height=650')}
            className="min-h-10 px-3 py-1.5 bg-stone-800 hover:bg-stone-700 border border-stone-600 rounded-xl text-xs font-bold cursor-pointer"
            title="Mở Màn hình phụ hiển thị cho khách hàng (CFD)"
          >
            🖥️ Màn hình khách
          </button>

          {userRole === ROLES.QUAN_LY && (
            <button
              type="button"
              onClick={() => setShowBankModal(true)}
              className="min-h-10 px-3 py-1.5 bg-stone-800 hover:bg-stone-700 border border-stone-600 rounded-xl text-xs font-bold cursor-pointer"
              title="Chỉ Quản lý mới có quyền cấu hình STK VietQR của quán (lưu trên máy chủ & ghi Audit Log)"
            >
              🏦 VietQR
            </button>
          )}

          {userRole === ROLES.QUAN_LY && (
            <>
              <button
                type="button"
                onClick={() => navigate('/barista')}
                className="min-h-10 px-3 py-1.5 bg-sky-700 hover:bg-sky-600 rounded-xl text-xs font-bold cursor-pointer"
              >
                🍹 KDS Bar
              </button>
              <button
                type="button"
                onClick={() => navigate('/admin/dashboard')}
                className="min-h-10 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 rounded-xl text-xs font-bold cursor-pointer"
              >
                📊 Quản trị
              </button>
            </>
          )}

          {[ROLES.PHUC_VU, ROLES.QUAN_LY].includes(userRole) && (
            <button
              type="button"
              onClick={() => navigate('/waiter')}
              className="min-h-10 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 rounded-xl text-xs font-bold cursor-pointer"
            >
              🛎️ Bưng món
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setEcosystemDrawerTab(ecoCounts.aggNew > 0 && ecoCounts.qrPending === 0 ? 'agg' : 'qr')
              setShowEcosystemDrawer(true)
            }}
            className={`min-h-10 px-3 py-1.5 rounded-xl text-xs font-extrabold cursor-pointer transition shadow ${
              ecoAlertTotal > 0
                ? 'bg-amber-500 hover:bg-amber-400 text-stone-950 animate-pulse'
                : 'bg-teal-700 hover:bg-teal-600 text-white'
            }`}
            title="Duyệt đơn QR tại bàn 1 chạm, nhận đơn GrabFood/ShopeeFood/BeFood & bấm giờ Bida/Boardgame"
          >
            🌐 QR/Sàn/Giờ{ecoAlertTotal > 0 ? ` (${ecoAlertTotal})` : ''}
          </button>

          <button
            type="button"
            onClick={() => setShowPinSwitchModal(true)}
            className="min-h-10 px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 rounded-xl text-xs font-bold cursor-pointer"
            title="Chuyển nhanh sang nhân viên khác trên máy POS bằng mã PIN 4–6 số"
          >
            🔄 Đổi NV (PIN)
          </button>

          <button
            type="button"
            onClick={() => {
              logout()
              navigate('/login', { replace: true })
            }}
            className="min-h-10 px-3 py-1.5 bg-red-600 hover:bg-red-700 rounded-xl text-xs font-bold cursor-pointer"
          >
            Đăng xuất
          </button>
        </div>
      </header>

      <TrialBanner />

      {/* Banner thông báo rõ khi quán đang bán ở chế độ Offline */}
      {!isOnline && (
        <div className="bg-red-600 text-white px-4 py-2 text-xs font-bold flex flex-wrap items-center justify-between gap-2">
          <span>
            📡 MẤT KẾT NỐI INTERNET — POS đang chạy từ bộ nhớ cục bộ (IndexedDB). Bạn vẫn tạo đơn, thu tiền mặt & in hóa đơn/tem bình thường!
          </span>
          <button
            type="button"
            onClick={() => setShowOfflineModal(true)}
            className="px-3 py-1 bg-white text-red-700 rounded-lg font-extrabold cursor-pointer"
          >
            Xem {outboxJobs.length} đơn chờ đồng bộ
          </button>
        </div>
      )}

      {/* Thanh đơn Lưu Tạm (Hold / Park Orders) */}
      {heldOrders.length > 0 && (
        <div className="bg-amber-100 border-b border-amber-300 px-4 py-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-extrabold text-amber-900">⏸️ Đơn đang giữ tạm ({heldOrders.length}):</span>
          {heldOrders.map((h) => (
            <div
              key={h.id}
              className="inline-flex items-center gap-1 bg-white border border-amber-400 rounded-xl px-2.5 py-1 shadow-xs"
            >
              <button
                type="button"
                onClick={() => {
                  restoreHeldOrder(h.id)
                  toast.success(`Đã mở lại đơn tạm "${h.label}"`)
                }}
                className="font-bold text-amber-900 hover:underline cursor-pointer"
              >
                {h.label} ({h.cart.reduce((s, i) => s + i.soLuong, 0)} ly)
              </button>
              <button
                type="button"
                onClick={() => deleteHeldOrder(h.id)}
                className="text-red-500 font-bold ml-1 cursor-pointer"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 p-4 grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-8 space-y-4">
          <TableMap
            tables={tables}
            selectedTable={selectedTable}
            onSelectTable={handleSelectTable}
            onRefresh={loadPosData}
            userRole={user?.vaiTro}
          />
          <MenuGrid
            menu={menu}
            onPickProduct={setPickingProduct}
            onQuickAdd={(item) => {
              addToCart(item)
              toast.success(`+1 ${item.tenMon} (${item.kichThuoc})`, { duration: 1200 })
            }}
            searchInputRef={searchInputRef}
          />
        </div>

        <div className="lg:col-span-4 flex flex-col gap-3">
          <CustomerBox
            customer={customer}
            onSelectCustomer={setCustomer}
            inputRef={customerInputRef}
          />
          <div className="flex-1">
            <Cart
              selectedTable={selectedTable}
              orderType={orderType}
              onChangeOrderType={setOrderType}
              tenKhachVangLai={tenKhachVangLai}
              onChangeTenKhachVangLai={setTenKhachVangLai}
              cart={cart}
              activeInvoice={activeInvoice}
              canPay={canManageCash}
              isManager={userRole === ROLES.QUAN_LY}
              onUpdateQty={updateCartQty}
              onUpdateNote={updateCartNote}
              onSplitItem={handleSplitCartItemAndEdit}
              onCloneItem={handleCloneCartItemAndEdit}
              onEditItem={handleOpenEditCartItem}
              onToggleTakeaway={toggleCartItemTakeaway}
              onToggleHoldCourse={toggleCartItemHoldCourse}
              onRemoveItem={removeFromCart}
              onClearCart={() => {
                clearCart()
                setSoTheRung('')
              }}
              onHoldOrder={async () => {
                if (typeof navigator !== 'undefined' && navigator.onLine && cart.length > 0) {
                  try {
                    const res = await orderService.luuTam({
                      label: tenKhachVangLai || customer?.tenKH || selectedTable?.tenBan || null,
                      maKH: customer?.maKH || null,
                      loaiDonHang: selectedTable ? 'TAI_QUAN' : orderType,
                      danhSachMon: buildOrderPayload().danhSachMon,
                    })
                    clearCart()
                    toast.success(res.message || '⏸️ Đã lưu tạm đơn lên máy chủ!')
                    return
                  } catch {
                    // fallback local
                  }
                }
                if (holdCurrentOrder()) toast.success('⏸️ Đã lưu tạm đơn! Bạn có thể phục vụ khách tiếp theo.')
              }}
              onSubmitOrder={handleSubmitOrder}
              onQuickCheckout={handleQuickCheckout}
              onStartVietQrOrder={handleStartVietQrOrder}
              onOpenSplitBill={handleOpenSplitBill}
              onPayInvoice={handlePayInvoice}
              onFireCourse={handleFireCourse}
              onSimulateVietQr={handleSimulateVietQr}
              onVoidInvoiceItem={handleVoidInvoiceItem}
              onPrintInvoice={handlePrintInvoice}
              onPrintLabels={printCupLabels50x30}
              onOpenBankConfig={userRole === ROLES.QUAN_LY ? () => setShowBankModal(true) : undefined}
              customer={customer}
              activeHappyHours={activeHappyHours}
              promoCodeInput={promoCodeInput}
              onChangePromoCode={(val) => {
                setPromoCodeInput(val)
                setPromoPreview(null)
              }}
              diemSuDungInput={diemSuDungInput}
              onChangeDiemSuDung={(val) => {
                setDiemSuDungInput(val)
                setPromoPreview(null)
              }}
              promoPreview={promoPreview}
              onApplyPromo={handleApplyPromo}
              onClearPromo={handleClearPromo}
              soTheRung={soTheRung}
              onChangeSoTheRung={setSoTheRung}
              preferVietQrKey={preferVietQrKey}
              upsellSuggestions={upsellSuggestions}
              onQuickAddUpsell={handleQuickAddUpsell}
              concurrencyBanner={concurrencyBanner}
              onDismissConcurrencyBanner={() => setConcurrencyBanner(null)}
              submitting={submitting}
              paying={paying}
            />
          </div>
        </div>
      </div>

      <ToppingModal
        key={editingCartTarget ? `edit-${editingCartTarget.idx}-${editingCartTarget.item.cartKey}` : pickingProduct?.maMon || 'none'}
        product={editingCartTarget?.product || pickingProduct}
        initialCartItem={editingCartTarget?.item || null}
        availableToppings={toppings}
        isOpen={Boolean(editingCartTarget || pickingProduct)}
        onClose={() => {
          setPickingProduct(null)
          setEditingCartTarget(null)
        }}
        onConfirm={(configuredItem) => {
          if (editingCartTarget) {
            updateCartItem(editingCartTarget.idx, configuredItem)
            setEditingCartTarget(null)
          } else {
            addToCart(configuredItem)
          }
        }}
      />

      <ThuChiModal
        isOpen={showThuChiModal}
        onClose={() => setShowThuChiModal(false)}
        onSuccess={loadPosData}
      />

      <DongCaModal
        isOpen={showDongCaModal}
        onClose={() => setShowDongCaModal(false)}
        currentShift={currentShift}
        onShiftClosed={() => {
          setCurrentShift(null)
          loadPosData()
        }}
      />

      <PaidOrdersRefundModal
        isOpen={showPaidHistoryModal}
        onClose={() => setShowPaidHistoryModal(false)}
        isManager={canApproveVoidOrRefund}
        onRefundSuccess={() => void loadLiveOperations()}
      />

      <PinSwitchModal
        isOpen={showPinSwitchModal}
        onClose={() => setShowPinSwitchModal(false)}
        onSwitched={() => void loadPosData()}
      />

      <OfflineQueueModal
        isOpen={showOfflineModal}
        onClose={() => setShowOfflineModal(false)}
        isOnline={isOnline}
        jobs={outboxJobs}
        syncing={syncingOutbox}
        cacheUpdatedAt={cacheUpdatedAt}
        onSyncNow={triggerOutboxSync}
        onDeleteJob={async (id) => {
          await deleteOutboxJob(id)
          await refreshOutboxList()
          toast.success('Đã xóa đơn khỏi hàng đợi Offline')
        }}
        thuNgan={user?.tenNV || ''}
      />

      {/* Modal Danh sách Hóa đơn chưa thanh toán (chống Đơn Mang đi mồ côi) */}
      {showOpenOrdersModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-5 shadow-2xl space-y-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="font-extrabold text-base text-gray-800">
                📋 Hóa đơn đang mở / Chưa thanh toán ({openInvoices.length})
              </h3>
              <button
                type="button"
                onClick={() => setShowOpenOrdersModal(false)}
                className="w-10 h-10 rounded-full bg-gray-100 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2">
              {openInvoices.length === 0 ? (
                <p className="text-center text-gray-400 text-xs py-10">
                  Không có hóa đơn nào đang chờ thanh toán!
                </p>
              ) : (
                openInvoices.map((hd) => (
                  <button
                    type="button"
                    key={hd.maHoaDon}
                    onClick={() => handleOpenExistingInvoice(hd.maHoaDon)}
                    className="w-full p-3.5 rounded-xl border border-gray-200 hover:border-amber-600 hover:bg-amber-50/60 flex items-center justify-between text-left cursor-pointer"
                  >
                    <div>
                      <p className="font-extrabold text-sm text-gray-800 flex items-center gap-1.5 flex-wrap">
                        {Number(hd.soThuTuNgay) > 0 && (
                          <span className="px-2 py-0.5 rounded bg-stone-900 text-amber-300 font-black text-xs">
                            SỐ #{String(hd.soThuTuNgay).padStart(2, '0')}
                          </span>
                        )}
                        <span>
                          #{hd.maHoaDon} • {hd.tenBan || '🛍️ Mang đi (Chưa thu tiền)'}
                        </span>
                      </p>
                      <p className="text-xs text-gray-500">
                        {hd.tongLy} ly {hd.tenKH ? `• KH: ${hd.tenKH}` : ''}
                      </p>
                    </div>
                    <span className="font-black text-amber-800 text-sm">
                      {formatVND(hd.tongTamTinh)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal Hủy món chuẩn hóa + Manager/Ca trưởng Override PIN O(1) (Bọc React.memo) */}
      <VoidItemModal
        voidTarget={voidTarget}
        activeInvoice={activeInvoice}
        canApproveVoidOrRefund={canApproveVoidOrRefund}
        voidReason={voidReason}
        onChangeVoidReason={setVoidReason}
        voidPin={voidPin}
        onChangeVoidPin={setVoidPin}
        pinApprovers={pinApprovers}
        voidApproverId={voidApproverId}
        onChangeVoidApproverId={setVoidApproverId}
        voidSubmitting={voidSubmitting}
        onClose={() => setVoidTarget(null)}
        onConfirm={handleConfirmVoidItem}
      />

      {/* Modal Tách Hóa Đơn theo món & số lượng lẻ (Bọc React.memo) */}
      <SplitBillModal
        isOpen={showSplitModal}
        activeInvoice={activeInvoice}
        tables={tables}
        splitQtyMap={splitQtyMap}
        onChangeSplitQtyMap={setSplitQtyMap}
        splitDestTable={splitDestTable}
        onChangeSplitDestTable={setSplitDestTable}
        splitSubmitting={splitSubmitting}
        onClose={() => setShowSplitModal(false)}
        onConfirm={handleConfirmSplitBill}
        onConfirmSplitEqual={handleConfirmSplitEqual}
        onConfirmSplitAmount={handleConfirmSplitAmount}
      />

      {/* Modal Cấu hình tài khoản nhận VietQR & Khóa Webhook riêng của quán (Bọc React.memo) */}
      <VietQrBankModal
        isOpen={showBankModal}
        bankForm={bankForm}
        onChangeBankForm={setBankForm}
        onClose={() => setShowBankModal(false)}
        onSubmit={async (e) => {
          e.preventDefault()
          try {
            const res = await saasService.saveBankSettings(bankForm)
            const savedBank = res.bank || bankForm
            saveVietQrConfig(savedBank)
            setBankForm((prev) => ({
              ...prev,
              ...savedBank,
              sepayApiKey: savedBank.hasSepayKey ? '********' : '',
              payosChecksumKey: savedBank.hasPayosKey ? '********' : '',
            }))
            toast.success(res.message || 'Đã lưu cấu hình VietQR trên máy chủ!')
            setShowBankModal(false)
          } catch {
            // Interceptor xử lý
          }
        }}
      />

      <PrintBridgeModal
        isOpen={showPrintModal}
        onClose={() => setShowPrintModal(false)}
        user={user}
        onStatusChange={setBridgeOnline}
      />

      <EcosystemPosDrawer
        isOpen={showEcosystemDrawer}
        initialTab={ecosystemDrawerTab}
        onClose={() => setShowEcosystemDrawer(false)}
        tables={tables}
        onRefreshPos={loadLiveOperations}
        onCountsChange={setEcoCounts}
      />
    </div>
  )
}
