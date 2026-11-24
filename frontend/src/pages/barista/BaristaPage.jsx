import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useSocketEvents } from '../../socket/useSocketEvents'
import { getSocket } from '../../socket/socketClient'
import { orderService } from '../../services/orderService'
import { khoService } from '../../services/khoService'
import { sanPhamService } from '../../services/sanPhamService'
import { useAuthStore } from '../../store/authStore'
import { ROLES } from '../../constants/roles'
import {
  playNewOrderSound,
  playRushOrRemakeSound,
  playCancelSound,
  playTableMovedSound,
  playAllReadySound,
  unlockAudioAndWakeLock,
} from '../../utils/sound'
import { printKdsItemLabels50x30 } from '../../utils/printHelper'
import { subscribeLanEvents, updateLanItemStatus } from '../../utils/lanHub'

const KHOA_QUEUE_CU = 'barista_kds_queue'
const KHOA_TRAM_KDS = 'barista_kds_station'
const CHU_KY_DONG_BO_MS = 25000

const TRAM_KDS_LIST = [
  { id: 'ALL', label: '🍹 Tất cả trạm', badge: 'Tất cả' },
  { id: 'BAR_CHINH', label: '☕ Bar Chính (Espresso)', badge: '☕ Bar Chính' },
  { id: 'BAR_LANH', label: '🧋 Bar Lạnh (Trà/Đá xay)', badge: '🧋 Bar Lạnh' },
  { id: 'BEP_BANH', label: '🥐 Bếp & Bánh', badge: '🥐 Bếp Bánh' },
]

const NHAN_TRANG_THAI = {
  ChoPhaChe: { text: '⏳ Chờ pha', cls: 'bg-amber-500/20 text-amber-300' },
  DangLam: { text: '🔥 Đang pha', cls: 'bg-sky-500/25 text-sky-300' },
}

const gioHienThi = (v) => {
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
}

const formatStt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? `#${String(n).padStart(2, '0')}` : null
}

const getElapsedMinutes = (thoiGianGoi, nowMs) => {
  const t = new Date(thoiGianGoi).getTime()
  if (Number.isNaN(t)) return 0
  return Math.max(0, Math.floor((nowMs - t) / 60000))
}

const getSlaStyle = (mins, dangHoan) => {
  if (dangHoan) return { border: 'border-stone-600 opacity-60', badge: 'bg-stone-700 text-stone-300' }
  if (mins >= 10) return { border: 'border-red-500 ring-2 ring-red-500/50 animate-pulse', badge: 'bg-red-600 text-white' }
  if (mins >= 5) return { border: 'border-amber-400', badge: 'bg-amber-500 text-stone-950' }
  return { border: 'border-emerald-500/70', badge: 'bg-emerald-600/30 text-emerald-300' }
}

export default function BaristaPage() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()

  const [queue, setQueue] = useState([])
  const [lanItems, setLanItems] = useState([])
  const [lanHubOnline, setLanHubOnline] = useState(false)
  const [recallList, setRecallList] = useState([])
  const [daTai, setDaTai] = useState(false)
  const [loiDongBo, setLoiDongBo] = useState(false)
  const [lanDongBoCuoi, setLanDongBoCuoi] = useState(null)
  const [hoan, setHoan] = useState(() => new Set())
  const [dangXuLy, setDangXuLy] = useState(() => new Set())
  const [lowStock, setLowStock] = useState([])
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [viewMode, setViewMode] = useState('ITEM') // 'ITEM' | 'TICKET' | 'BATCH' | 'EXPO' | 'RECALL'
  const [stationFilter, setStationFilter] = useState(
    () => localStorage.getItem(KHOA_TRAM_KDS) || 'ALL'
  )
  const [expoTickets, setExpoTickets] = useState([])
  const [clockOffsetMs, setClockOffsetMs] = useState(0)
  const [disconnectedOver5s, setDisconnectedOver5s] = useState(false)
  const [voidAlerts, setVoidAlerts] = useState([]) // [{ id, maCTHD, maHoaDon, tenMon, lyDo, at }]
  const [recentTableMoves, setRecentTableMoves] = useState({})
  const [resumePrintItem, setResumePrintItem] = useState(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  // Drawer báo hết món / topping / nguyên liệu (86'ing)
  const [show86Modal, setShow86Modal] = useState(false)
  const [tab86, setTab86] = useState('MENU') // 'MENU' | 'TOPPING' | 'INGREDIENT'
  const [menuList, setMenuList] = useState([])
  const [toppingList, setToppingList] = useState([])
  const [ingredientList, setIngredientList] = useState([])
  const [toggling86, setToggling86] = useState(null)

  const yeuCauRef = useRef(0)
  const daApDungRef = useRef(0)
  const daThayRef = useRef(null)
  const lastSeqRef = useRef(0)
  const soundRef = useRef(soundEnabled)
  const clockOffsetRef = useRef(0)

  useEffect(() => {
    soundRef.current = soundEnabled
  }, [soundEnabled])

  useEffect(() => {
    clockOffsetRef.current = clockOffsetMs
  }, [clockOffsetMs])

  // Ticker cập nhật SLA timer mỗi 10 giây (tự động bù lệch đồng hồ iPad bằng clockOffsetMs của Server!)
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now() + clockOffsetRef.current), 10000)
    return () => clearInterval(id)
  }, [])

  // Tự động dọn cảnh báo hủy món sau 60 giây nếu Barista chưa bấm xác nhận
  useEffect(() => {
    if (voidAlerts.length === 0) return
    const timer = setInterval(() => {
      const cutoff = Date.now() - 60000
      setVoidAlerts((prev) => prev.filter((a) => a.at > cutoff))
    }, 5000)
    return () => clearInterval(timer)
  }, [voidAlerts.length])

  const dongBo = useCallback(async () => {
    const stt = ++yeuCauRef.current
    try {
      const branchId = user?.branchId || 'DEFAULT'
      const [syncData, cb, vuaTra] = await Promise.all([
        orderService.syncKds(
          { branchId, station: stationFilter, lastSeq: lastSeqRef.current },
          { silent: true }
        ),
        khoService.canhBao().catch(() => null),
        orderService.getVuaTra({ silent: true }).catch(() => null),
      ])
      if (stt < daApDungRef.current) return
      daApDungRef.current = stt

      // Bù lệch đồng hồ thiết bị iPad (Clock-Skew Compensation) chuẩn theo giờ Server
      if (syncData?.serverNowMs) {
        const offset = Number(syncData.serverNowMs) - Date.now()
        setClockOffsetMs(offset)
        setNowMs(Date.now() + offset)
      }
      if (syncData?.latestSeq) {
        lastSeqRef.current = Math.max(lastSeqRef.current, Number(syncData.latestSeq))
      }

      // Replay các sự kiện bị lỡ trong lúc rớt Wi-Fi (hủy món, đổi bàn, remake)
      if (Array.isArray(syncData?.missedEvents) && syncData.missedEvents.length > 0) {
        for (const ev of syncData.missedEvents) {
          if (ev.eventType === 'ITEM_VOID' || ev.eventType === 'ITEM_SWAP') {
            setVoidAlerts((prev) => [
              {
                id: `${ev.seq}-${ev.payload?.maCTHD || ev.payload?.oldMaCTHD || Date.now()}`,
                maCTHD: ev.payload?.maCTHD || ev.payload?.oldMaCTHD,
                maHoaDon: ev.maHoaDon,
                tenMon: ev.payload?.tenMon || ev.payload?.oldTenMon || 'Món vừa hủy/đổi',
                lyDo: ev.payload?.lyDo || 'Đã hủy trong lúc mất Wi-Fi',
                at: Date.now(),
              },
              ...prev.slice(0, 9),
            ])
          }
        }
      }

      const ds = Array.isArray(syncData?.tickets) ? syncData.tickets : []
      const ids = new Set(ds.map((m) => m.maCTHD))
      if (daThayRef.current) {
        const moi = ds.filter((m) => !daThayRef.current.has(m.maCTHD))
        if (moi.length > 0) {
          const hasRemake = moi.some((m) => m.remakeOfCTHD || Number(m.mucDoUuTien) >= 2)
          if (soundRef.current) {
            if (hasRemake) playRushOrRemakeSound()
            else playNewOrderSound()
          }
          const nhanBan = [...new Set(moi.map((m) => m.tenBan || 'Mang đi'))].join(', ')
          toast.success(
            hasRemake ? `⚡ VÉ LÀM LẠI ƯU TIÊN (${nhanBan})` : `🔔 ${moi.length} món mới (${nhanBan})`
          )
        }
      }
      daThayRef.current = ids

      setQueue(ds)
      if (Array.isArray(syncData?.expoTickets)) setExpoTickets(syncData.expoTickets)
      if (Array.isArray(cb)) setLowStock(cb)
      if (Array.isArray(vuaTra)) setRecallList(vuaTra)
      setHoan((prev) => new Set([...prev].filter((id) => ids.has(id))))
      setDaTai(true)
      setLoiDongBo(false)
      setLanDongBoCuoi(new Date())
    } catch (err) {
      const status = err.response?.status
      if (status === 401 || (status === 403 && /^Token/i.test(err.response?.data?.message || ''))) {
        toast.error('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại')
        logout()
        navigate('/login', { replace: true })
        return
      }
      setLoiDongBo(true)
    }
  }, [logout, navigate, stationFilter, user])

  useEffect(() => {
    localStorage.removeItem(KHOA_QUEUE_CU)
    const lanDau = setTimeout(dongBo, 0)
    const timer = setInterval(dongBo, CHU_KY_DONG_BO_MS)
    const khiHienLai = () => {
      if (document.visibilityState === 'visible') dongBo()
    }
    document.addEventListener('visibilitychange', khiHienLai)
    return () => {
      clearTimeout(lanDau)
      clearInterval(timer)
      document.removeEventListener('visibilitychange', khiHienLai)
    }
  }, [dongBo])

  // [Phân hệ 7] Local-LAN KDS Sync Fallback: lắng nghe đơn Offline từ máy Thu ngân qua Wi-Fi LAN khi đứt Internet
  useEffect(() => {
    const tenantId = String(user?.tenantId || 'DEFAULT')
    const flattenOrders = (orders) =>
      (Array.isArray(orders) ? orders : [])
        .filter((o) => !o.syncedToCloud)
        .flatMap((o) => (o.items || []).filter((i) => i.trangThaiPhaChe !== 'DaXong'))

    const unsub = subscribeLanEvents(tenantId, {
      onConnected: () => setLanHubOnline(true),
      onError: () => setLanHubOnline(false),
      onSnapshot: (snap) => {
        setLanHubOnline(true)
        setLanItems(flattenOrders(snap?.orders))
      },
      onOrderCreated: (order) => {
        setLanHubOnline(true)
        const activeItems = (order?.items || []).filter((i) => i.trangThaiPhaChe !== 'DaXong')
        if (activeItems.length > 0) {
          if (soundRef.current) playNewOrderSound()
          toast.success(`📡 [LAN Offline] ${activeItems.length} món mới (${order.tableName || 'Mang đi'})`)
          setLanItems((prev) => [
            ...activeItems,
            ...prev.filter((p) => String(p.maHoaDon) !== String(order.offlineClientId || order.id)),
          ])
        }
      },
      onItemUpdated: ({ orderId, itemId, trangThaiPhaChe }) => {
        setLanItems((prev) =>
          trangThaiPhaChe === 'DaXong'
            ? prev.filter((i) => !(String(i.maHoaDon) === String(orderId) && String(i.maCTHD) === String(itemId)))
            : prev.map((i) =>
                String(i.maHoaDon) === String(orderId) && String(i.maCTHD) === String(itemId)
                  ? { ...i, trangThaiPhaChe }
                  : i
              )
        )
      },
      onOrderSynced: ({ orderId }) => {
        setLanItems((prev) => prev.filter((i) => String(i.maHoaDon) !== String(orderId)))
        void dongBo()
      },
    })
    return unsub
  }, [user?.tenantId, dongBo])

  useEffect(() => {
    localStorage.setItem(KHOA_TRAM_KDS, stationFilter)
    try {
      const sock = getSocket()
      if (sock?.connected) {
        sock.emit('room:subscribe', {
          tenantId: user?.tenantId || 'DEFAULT',
          branchId: user?.branchId || 'DEFAULT',
          station: stationFilter,
          role: viewMode === 'EXPO' ? 'EXPO' : 'KDS',
        })
      }
    } catch {
      // ignore
    }
  }, [stationFilter, viewMode, user?.tenantId, user?.branchId])

  useSocketEvents({
    CONNECTION_STATE: ({ disconnectedOver5s: isAlert }) => {
      setDisconnectedOver5s(Boolean(isAlert))
    },
    connect: () => {
      setDisconnectedOver5s(false)
      try {
        getSocket()?.emit('room:subscribe', {
          tenantId: user?.tenantId || 'DEFAULT',
          branchId: user?.branchId || 'DEFAULT',
          station: stationFilter,
          role: viewMode === 'EXPO' ? 'EXPO' : 'KDS',
        })
      } catch {
        // ignore
      }
      void dongBo()
    },
    RECONNECTED: () => {
      setDisconnectedOver5s(false)
      void dongBo()
    },
    'order:new': (info) => {
      if (info?.seq) lastSeqRef.current = Math.max(lastSeqRef.current, Number(info.seq))
      void dongBo()
    },
    CO_DON_MOI: dongBo,
    MON_DANG_LAM: dongBo,
    MON_DA_XONG: dongBo,
    MON_HOAN_TAC: dongBo,
    'kds:item_recalled': dongBo,
    'kds:remake': (info) => {
      if (info?.seq) lastSeqRef.current = Math.max(lastSeqRef.current, Number(info.seq))
      if (soundRef.current) playRushOrRemakeSound()
      toast.error(`⚡ VÉ LÀM LẠI (0đ • Ưu tiên cao nhất): ${info?.mon?.tenMon || ''}`, { duration: 7000 })
      void dongBo()
    },
    ORDER_RUSH_UPDATED: (info) => {
      if (info?.seq) lastSeqRef.current = Math.max(lastSeqRef.current, Number(info.seq))
      if (info?.rush && soundRef.current) playRushOrRemakeSound()
      toast(
        info?.rush
          ? `🔥 ĐƠN GẤP: #${info.maHoaDon} vừa được đặt ưu tiên cao nhất!`
          : `Đã gỡ cờ GẤP cho đơn #${info?.maHoaDon}`,
        { duration: 5000 }
      )
      void dongBo()
    },
    ORDER_ALL_READY: (info) => {
      if (soundRef.current) playAllReadySound()
      toast.success(
        `✅ ĐỦ 100% MÓN ĐA QUẦY — ${info?.tenBan || `Đơn #${info?.soThuTuHienThi || info?.maHoaDon}`} sẵn sàng bưng!`,
        { duration: 7000 }
      )
      void dongBo()
    },
    'kds:item_voided': (info) => {
      if (info?.seq) lastSeqRef.current = Math.max(lastSeqRef.current, Number(info.seq))
      if (soundRef.current) playCancelSound()
      setVoidAlerts((prev) => [
        {
          id: `${Date.now()}-${info?.maCTHD || ''}`,
          maCTHD: info?.maCTHD,
          maHoaDon: info?.maHoaDon,
          tenMon: info?.tenMon || 'Món vừa bị hủy',
          lyDo: info?.lyDo || 'Quầy thu ngân hủy món',
          at: Date.now(),
        },
        ...prev.slice(0, 9),
      ])
      toast.error(`🚫 DỪNG PHA! Món "${info?.tenMon || ''}" vừa bị HỦY!`, { duration: 7000 })
      void dongBo()
    },
    'kds:item_swapped': (info) => {
      if (info?.seq) lastSeqRef.current = Math.max(lastSeqRef.current, Number(info.seq))
      if (soundRef.current) playCancelSound()
      setVoidAlerts((prev) => [
        {
          id: `swap-${Date.now()}-${info?.oldMaCTHD || ''}`,
          maCTHD: info?.oldMaCTHD,
          maHoaDon: info?.maHoaDon,
          tenMon: `${info?.oldTenMon || 'Món cũ'} ➔ ${info?.monMoi?.tenMon || 'Món mới'}`,
          lyDo: info?.lyDo || 'Đổi món tại quầy',
          at: Date.now(),
        },
        ...prev.slice(0, 9),
      ])
      toast(`🔄 ĐỔI MÓN HĐ #${info?.maHoaDon}: ${info?.oldTenMon || ''} ➔ ${info?.monMoi?.tenMon || ''}`, { duration: 7000 })
      void dongBo()
    },
    MON_DA_DOI: (info) => {
      if (soundRef.current) playNewOrderSound()
      toast.success(
        `🔄 Đổi món HĐ #${info?.maHoaDon}: ${info?.monCu?.tenMon || ''} → ${info?.monMoi?.tenMon || ''}`,
        { duration: 5000 }
      )
      void dongBo()
    },
    BAN_CHUYEN: (info) => {
      if (soundRef.current) playTableMovedSound()
      const tenCu = info?.tenBanCu || info?.fromMaBan || 'Bàn cũ'
      const tenMoi = info?.tenBanMoi || info?.toMaBan || 'Bàn mới'
      toast(`🔄 Đổi bàn: ${tenCu} → ${tenMoi}`, { icon: '⚠️', duration: 6000 })
      if (info?.maHoaDon) {
        setRecentTableMoves((prev) => ({
          ...prev,
          [info.maHoaDon]: { tenBanCu: tenCu, tenBanMoi: tenMoi, at: Date.now() },
          ...(info.maHoaDonGoc
            ? { [info.maHoaDonGoc]: { tenBanCu: tenCu, tenBanMoi: tenMoi, at: Date.now() } }
            : {}),
        }))
      }
      void dongBo()
    },
    'kds:table_moved': (info) => {
      if (info?.seq) lastSeqRef.current = Math.max(lastSeqRef.current, Number(info.seq))
      if (soundRef.current) playTableMovedSound()
      const tenCu = info?.fromTenBan || info?.fromMaBan || 'Bàn cũ'
      const tenMoi = info?.toTenBan || info?.toMaBan || 'Bàn mới'
      toast(`🔄 CHUYỂN BÀN: ${tenCu} ➔ ${tenMoi}`, { icon: '🔔', duration: 7000 })
      if (info?.maHoaDon) {
        setRecentTableMoves((prev) => ({
          ...prev,
          [info.maHoaDon]: { tenBanCu: tenCu, tenBanMoi: tenMoi, at: Date.now() },
        }))
      }
      void dongBo()
    },
    'kds:orders_merged': (info) => {
      if (soundRef.current) playNewOrderSound()
      toast(`🔗 Gộp bàn: ${info?.fromTenBan || ''} ➔ ${info?.toTenBan || ''}`, { duration: 6000 })
      void dongBo()
    },
    'kds:item_transferred': (info) => {
      if (soundRef.current) playNewOrderSound()
      toast(`🔄 Chuyển món: ${info?.fromTenBan || ''} ➔ ${info?.toTenBan || ''}`, { duration: 6000 })
      void dongBo()
    },
    'kds:course_fired': (info) => {
      if (soundRef.current) playNewOrderSound()
      toast.success(`🔥 BÁO BẾP RA MÓN (Course ${info?.courseNo || 2}) — HĐ #${info?.maHoaDon}!`, { duration: 6000 })
      void dongBo()
    },
    MON_BI_HUY: () => {
      if (soundRef.current) playCancelSound()
      toast.error('🚫 Có món vừa bị HỦY từ quầy thu ngân!')
      dongBo()
    },
  })

  const handleStartDish = async (item) => {
    if (dangXuLy.has(item.maCTHD)) return
    setDangXuLy((prev) => new Set(prev).add(item.maCTHD))
    try {
      if (item.laDonLanOffline) {
        await updateLanItemStatus(item.maHoaDon, item.maCTHD, 'DangLam')
        setLanItems((prev) =>
          prev.map((q) => (q.maCTHD === item.maCTHD ? { ...q, trangThaiPhaChe: 'DangLam' } : q))
        )
        return
      }
      await orderService.nhanLam(item.maCTHD)
      setQueue((prev) =>
        prev.map((q) => (q.maCTHD === item.maCTHD ? { ...q, trangThaiPhaChe: 'DangLam' } : q))
      )
    } catch {
      // Interceptor xử lý
    } finally {
      setDangXuLy((prev) => {
        const n = new Set(prev)
        n.delete(item.maCTHD)
        return n
      })
      if (!item.laDonLanOffline) dongBo()
    }
  }

  const handleFinishDish = async (item) => {
    if (dangXuLy.has(item.maCTHD)) return
    setDangXuLy((prev) => new Set(prev).add(item.maCTHD))
    try {
      if (item.laDonLanOffline) {
        await updateLanItemStatus(item.maHoaDon, item.maCTHD, 'DaXong')
        toast.success(`📡 Đã trả món (LAN Offline): ${item.tenMon}`)
        setLanItems((prev) => prev.filter((q) => q.maCTHD !== item.maCTHD))
        return
      }
      await orderService.traMon(item.maCTHD)
      toast.success(`Đã trả món: ${item.tenMon}`)
      setQueue((prev) => prev.filter((q) => q.maCTHD !== item.maCTHD))
    } catch {
      // Interceptor xử lý
    } finally {
      setDangXuLy((prev) => {
        const n = new Set(prev)
        n.delete(item.maCTHD)
        return n
      })
      if (!item.laDonLanOffline) dongBo()
    }
  }

  const handleRecallDish = async (item) => {
    if (dangXuLy.has(item.maCTHD)) return
    setDangXuLy((prev) => new Set(prev).add(item.maCTHD))
    try {
      const res = await orderService.recallKdsItem(item.maCTHD)
      toast.success(res.message || `↩️ Đã hoàn tác món "${item.tenMon}" về hàng đợi`)
      setRecallList((prev) => prev.filter((q) => q.maCTHD !== item.maCTHD))
    } catch {
      // Interceptor xử lý
    } finally {
      setDangXuLy((prev) => {
        const n = new Set(prev)
        n.delete(item.maCTHD)
        return n
      })
      dongBo()
    }
  }

  const open86Drawer = async () => {
    setShow86Modal(true)
    try {
      const [menus, tps, nls] = await Promise.all([
        sanPhamService.getMenu(),
        orderService.getToppings().catch(() => []),
        khoService.getAllNguyenLieu().catch(() => []),
      ])
      setMenuList(Array.isArray(menus) ? menus : [])
      setToppingList(Array.isArray(tps) ? tps : [])
      setIngredientList(Array.isArray(nls) ? nls : [])
    } catch {
      // ignore
    }
  }

  const handleToggle86Ingredient = async (nl, tamHet) => {
    setToggling86(`NL_${nl.maNL}`)
    try {
      const res = await khoService.setNguyenLieuTamHet(nl.maNL, tamHet)
      toast.success(res.message, { duration: 4500 })
      const [menus, tps] = await Promise.all([
        sanPhamService.getMenu().catch(() => null),
        orderService.getToppings().catch(() => null),
      ])
      if (Array.isArray(menus)) setMenuList(menus)
      if (Array.isArray(tps)) setToppingList(tps)
    } catch {
      // Interceptor xử lý
    } finally {
      setToggling86(null)
    }
  }

  const handleToggle86Topping = async (tp) => {
    setToggling86(tp.maTopping)
    try {
      const nextState = !tp.tamHet
      const res = await orderService.setToppingTamHet(tp.maTopping, nextState)
      toast.success(res.message)
      setToppingList((prev) =>
        prev.map((t) => (t.maTopping === tp.maTopping ? { ...t, tamHet: nextState } : t))
      )
    } catch {
      // Interceptor xử lý
    } finally {
      setToggling86(null)
    }
  }

  const handleToggle86 = async (mon) => {
    setToggling86(mon.maMon)
    try {
      const nextState = !mon.tamHet
      const res = await sanPhamService.setTamHet(mon.maMon, nextState)
      toast.success(res.message)
      setMenuList((prev) =>
        prev.map((m) => (m.maMon === mon.maMon ? { ...m, tamHet: nextState } : m))
      )
    } catch {
      // Interceptor xử lý
    } finally {
      setToggling86(null)
    }
  }

  const toggleHoan = (maCTHD) =>
    setHoan((prev) => {
      const n = new Set(prev)
      if (n.has(maCTHD)) n.delete(maCTHD)
      else n.add(maCTHD)
      return n
    })

  // [Phân hệ 2 - Trụ cột 1] Dedup Cloud Socket vs Local LAN Hub bằng clientOrderUid (Cloud luôn thay thế vé LAN trùng mã!)
  const cloudClientUids = new Set(queue.map((q) => q.clientOrderUid).filter(Boolean))
  const dedupedLanItems = lanItems.filter((li) => !li.clientOrderUid || !cloudClientUids.has(li.clientOrderUid))
  const combinedQueue = [...dedupedLanItems, ...queue].sort((a, b) => {
    const pa = Number(a.mucDoUuTien || 0)
    const pb = Number(b.mucDoUuTien || 0)
    if (pb !== pa) return pb - pa
    return new Date(a.firedAt || a.thoiGianGoi || 0).getTime() - new Date(b.firedAt || b.thoiGianGoi || 0).getTime()
  })

  const stationCounts = {
    ALL: combinedQueue.reduce((s, q) => s + Number(q.soLuong || 1), 0),
    BAR_CHINH: combinedQueue
      .filter((q) => (q.tramCheBien || 'BAR_CHINH') === 'BAR_CHINH')
      .reduce((s, q) => s + Number(q.soLuong || 1), 0),
    BAR_LANH: combinedQueue
      .filter((q) => q.tramCheBien === 'BAR_LANH')
      .reduce((s, q) => s + Number(q.soLuong || 1), 0),
    BEP_BANH: combinedQueue
      .filter((q) => q.tramCheBien === 'BEP_BANH')
      .reduce((s, q) => s + Number(q.soLuong || 1), 0),
  }

  const filteredQueue =
    stationFilter === 'ALL'
      ? combinedQueue
      : combinedQueue.filter((q) => (q.tramCheBien || 'BAR_CHINH') === stationFilter)

  const hienThi = [
    ...filteredQueue.filter((q) => !hoan.has(q.maCTHD)),
    ...filteredQueue.filter((q) => hoan.has(q.maCTHD)),
  ]

  // Dữ liệu cho Chế độ Gom món (Batch Summary / All-Day View — nhóm theo MaMon, KichThuoc + gom phụ theo Mức đường đá / Ghi chú)
  const batchSummary = Object.values(
    filteredQueue.reduce((acc, item) => {
      const key = `${item.maMon}|${item.kichThuoc}`
      if (!acc[key]) {
        acc[key] = {
          key,
          tenMon: item.tenMon,
          kichThuoc: item.kichThuoc,
          tramCheBien: item.tramCheBien || 'BAR_CHINH',
          tongLy: 0,
          nhomGhiChuMap: {},
          chiTiet: [],
        }
      }
      const sl = Number(item.soLuong || 1)
      acc[key].tongLy += sl
      const modLabel =
        Array.isArray(item.modifiersSnapshot) && item.modifiersSnapshot.length > 0
          ? item.modifiersSnapshot
              .map((m) => {
                const mQty = Number(m.qty ?? m.soLuong ?? 1)
                const lbl = m.tenInNgan || m.tenOption || ''
                return mQty > 1 ? `${lbl} x${mQty}` : lbl
              })
              .filter(Boolean)
              .join(', ')
          : ''
      const tpLabel = item.toppings?.length
        ? ` (+${item.toppings.map((t) => t.tenTopping).join(', ')})`
        : ''
      const baseNote = [modLabel, (item.ghiChu || '').trim()].filter(Boolean).join(' • ') || 'Bình thường'
      const noteKey = `${baseNote}${tpLabel}`
      acc[key].nhomGhiChuMap[noteKey] = (acc[key].nhomGhiChuMap[noteKey] || 0) + sl
      acc[key].chiTiet.push(item)
      return acc
    }, {})
  ).sort((a, b) => b.tongLy - a.tongLy)

  // Dữ liệu cho Chế độ Theo Đơn (Ticket View)
  const tickets = Object.values(
    filteredQueue.reduce((acc, item) => {
      if (!acc[item.maHoaDon]) {
        acc[item.maHoaDon] = {
          maHoaDon: item.maHoaDon,
          soThuTuNgay: item.soThuTuNgay,
          tenBan: item.tenBan || '🛍️ Mang đi',
          thoiGianGoi: item.thoiGianGoi,
          items: [],
        }
      }
      acc[item.maHoaDon].items.push(item)
      return acc
    }, {})
  )

  const handleFinishWholeBatch = async (batch) => {
    for (const item of batch.chiTiet) {
      await handleFinishDish(item)
    }
  }

  // [Phân hệ 2 - Trụ cột 2] Hỗ trợ Bàn phím Bump Bar USB quầy Bar (1-9: Xử lý thẻ #N, 0: Recall món mới nhất, Space/.: Trả FIFO)
  useEffect(() => {
    const onKeyDown = (e) => {
      if (show86Modal) return
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1
        const item = hienThi[idx]
        if (!item) return
        e.preventDefault()
        if (item.trangThaiPhaChe === 'ChoPhaChe') void handleStartDish(item)
        else void handleFinishDish(item)
      } else if (e.key === '0') {
        if (recallList[0]) {
          e.preventDefault()
          void handleRecallDish(recallList[0])
        }
      } else if (e.key === '.' || e.key === ' ') {
        const oldest = hienThi[0]
        if (oldest) {
          e.preventDefault()
          void handleFinishDish(oldest)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <div className="min-h-screen bg-stone-900 text-stone-100 flex flex-col">
      <header className="bg-stone-950 px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 border-b border-stone-800">
        <div>
          <h1 className="text-xl font-extrabold text-amber-400">
            🍹 KDS Quầy Pha Chế (Barista)
          </h1>
          <p className="text-xs text-stone-400">
            {user?.tenNV} • <b>{queue.length} dòng</b> ({queue.reduce((s, q) => s + Number(q.soLuong), 0)} ly chờ) •{' '}
            {loiDongBo ? (
              <span className="text-red-400 font-semibold">⚠️ Mất đồng bộ, đang thử lại...</span>
            ) : (
              <span className="text-emerald-400">
                ● Đồng bộ {lanDongBoCuoi ? lanDongBoCuoi.toLocaleTimeString('vi-VN') : '...'}
              </span>
            )}
            {lanHubOnline && (
              <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-bold text-[10px]">
                📡 LAN Hub ON{lanItems.length > 0 ? ` (${lanItems.length} món Offline)` : ''}
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Chuyển đổi 5 chế độ xem (bao gồm Expo Gom món đa quầy & KDS Recall 15p) */}
          <div className="bg-stone-800 p-1 rounded-xl flex flex-wrap gap-1 text-xs font-bold">
            {[
              { id: 'ITEM', label: '🥤 Theo ly' },
              { id: 'TICKET', label: '🧾 Theo đơn' },
              { id: 'BATCH', label: '📦 Gom mẻ' },
              { id: 'EXPO', label: `🎯 Expo (${expoTickets.length})` },
              { id: 'RECALL', label: `↩️ Vừa trả (${recallList.length})` },
            ].map((m) => (
              <button
                key={m.id}
                onClick={() => setViewMode(m.id)}
                className={`px-3 py-1.5 rounded-lg cursor-pointer transition ${
                  viewMode === m.id
                    ? m.id === 'RECALL'
                      ? 'bg-sky-600 text-white'
                      : m.id === 'EXPO'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-amber-600 text-white'
                    : 'text-stone-300 hover:bg-stone-700'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <button
            onClick={async () => {
              const res = await unlockAudioAndWakeLock()
              setSoundEnabled(true)
              setWakeLockActive(res.wakeLockActive)
              toast.success(
                res.wakeLockActive
                  ? '🔊 Đã kích hoạt âm báo & Giữ sáng màn hình (Wake Lock ON)!'
                  : '🔊 Đã kích hoạt âm báo quầy Bar!'
              )
            }}
            className={`px-3 py-2 rounded-xl text-xs font-bold cursor-pointer ${
              wakeLockActive ? 'bg-emerald-600 text-white' : 'bg-amber-600/90 hover:bg-amber-500 text-white'
            }`}
          >
            {wakeLockActive ? '🔆 Giữ sáng: ON' : '🔊 Kích hoạt âm thanh & Giữ sáng'}
          </button>

          <button
            onClick={open86Drawer}
            className="px-3.5 py-2 bg-orange-600 hover:bg-orange-500 rounded-xl text-xs font-bold cursor-pointer"
          >
            🚫 Báo hết món (86)
          </button>

          <button
            onClick={dongBo}
            className="px-3.5 py-2 bg-stone-800 hover:bg-stone-700 rounded-xl text-xs font-semibold cursor-pointer"
          >
            ↻ Tải lại
          </button>

          {Number(user?.vaiTro) === ROLES.QUAN_LY && (
            <button
              onClick={() => navigate('/pos')}
              className="px-3.5 py-2 bg-amber-700 hover:bg-amber-600 rounded-xl text-xs font-bold cursor-pointer"
            >
              🖥️ POS
            </button>
          )}

          <button
            onClick={() => {
              logout()
              navigate('/login', { replace: true })
            }}
            className="px-3.5 py-2 bg-red-600 hover:bg-red-700 rounded-xl text-xs font-semibold cursor-pointer"
          >
            Đăng xuất
          </button>
        </div>
      </header>

      {/* Thanh phân tuyến Trạm pha chế / Bếp (Multi-Station KDS Routing) */}
      <div className="bg-stone-900 border-b border-stone-800 px-5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-stone-400 font-bold mr-1">📍 Trạm KDS:</span>
          {TRAM_KDS_LIST.map((tr) => (
            <button
              key={tr.id}
              type="button"
              onClick={() => setStationFilter(tr.id)}
              className={`px-3 py-1.5 rounded-xl font-bold cursor-pointer transition ${
                stationFilter === tr.id
                  ? 'bg-amber-500 text-stone-950 shadow'
                  : 'bg-stone-800 text-stone-300 hover:bg-stone-700'
              }`}
            >
              {tr.label} ({stationCounts[tr.id] || 0} ly)
            </button>
          ))}
        </div>
        {Object.keys(recentTableMoves).length > 0 && (
          <button
            type="button"
            onClick={() => setRecentTableMoves({})}
            className="px-2.5 py-1 rounded-lg bg-red-900/70 hover:bg-red-800 text-red-200 font-bold cursor-pointer"
          >
            ✕ Đã xem thông báo đổi bàn ({Object.keys(recentTableMoves).length})
          </button>
        )}
      </div>

      {/* Cảnh báo đỏ nhấp nháy khi rớt Wi-Fi / Socket quá 5 giây */}
      {disconnectedOver5s && (
        <div className="bg-red-600 text-white px-6 py-2.5 text-sm font-black flex items-center justify-between animate-pulse">
          <span>🚨 MẤT KẾT NỐI QUẦY BAR QUÁ 5 GIÂY — Kiểm tra Wi-Fi! Hệ thống sẽ tự kéo bù các đơn bị lỡ ngay khi có mạng.</span>
          <button
            type="button"
            onClick={dongBo}
            className="px-3 py-1 rounded-lg bg-white text-red-700 font-extrabold text-xs cursor-pointer"
          >
            ↻ Thử kéo bù ngay
          </button>
        </div>
      )}

      {/* Banner găm đỏ cảnh báo Hủy món / Đổi món yêu cầu Barista xác nhận "✓ Đã thấy hủy" */}
      {voidAlerts.length > 0 && (
        <div className="bg-red-950 border-b-2 border-red-500 px-5 py-2.5 space-y-1.5">
          {voidAlerts.map((al) => (
            <div
              key={al.id}
              className="flex flex-wrap items-center justify-between gap-2 bg-red-900/90 border border-red-400 rounded-xl px-4 py-2 text-xs text-red-100"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-2 py-0.5 rounded bg-red-500 text-white font-black animate-pulse">
                  🚫 DỪNG PHA / HỦY MÓN
                </span>
                <span className="line-through font-extrabold text-white text-sm">{al.tenMon}</span>
                <span className="text-red-200">(HĐ #{al.maHoaDon} • {al.lyDo})</span>
              </div>
              <button
                type="button"
                onClick={() => setVoidAlerts((prev) => prev.filter((x) => x.id !== al.id))}
                className="px-3 py-1.5 rounded-lg bg-white hover:bg-red-100 text-red-900 font-black cursor-pointer"
              >
                ✓ Đã thấy hủy
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Thanh cảnh báo tồn kho thấp */}
      {lowStock.length > 0 && (
        <div className="bg-red-950/80 border-b border-red-800 px-6 py-2 text-xs text-red-200 flex items-center gap-2 overflow-x-auto">
          <span className="font-bold shrink-0">⚠️ Tồn kho thấp:</span>
          {lowStock.map((nl) => (
            <span
              key={nl.maNL}
              className="px-2.5 py-0.5 rounded-full bg-red-900/90 border border-red-700 shrink-0"
            >
              {nl.tenNL}: còn {nl.tonKho} {nl.donViTinh}
            </span>
          ))}
        </div>
      )}

      <main className="flex-1 p-5">
        {!daTai ? (
          <div className="h-96 flex flex-col items-center justify-center text-stone-500">
            <p className="text-4xl mb-3">⏳</p>
            <p className="text-lg font-medium">Đang tải hàng đợi pha chế...</p>
          </div>
        ) : viewMode === 'EXPO' ? (
          /* Chế độ Trạm Gom Món Đa Quầy (Expo / Pass Screen) */
          expoTickets.length === 0 ? (
            <div className="h-96 flex flex-col items-center justify-center text-stone-500">
              <p className="text-4xl mb-3">🎯</p>
              <p className="text-lg font-medium">Chưa có đơn nào đang gom tại Trạm Expo</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {expoTickets.map((tk) => {
                const mins = getElapsedMinutes(tk.oldestTime, nowMs)
                return (
                  <div
                    key={tk.ticketKey}
                    className={`bg-stone-800 border-2 rounded-2xl p-5 flex flex-col justify-between shadow-lg space-y-3 ${
                      tk.allStationsReady
                        ? 'border-emerald-400 ring-2 ring-emerald-400/60 bg-emerald-950/30'
                        : 'border-stone-700'
                    }`}
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between border-b border-stone-700 pb-2 gap-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {tk.soThuTuHienThi && (
                            <span className="px-2 py-0.5 rounded-md bg-amber-500 text-stone-950 font-black text-xs">
                              #{tk.soThuTuHienThi}
                            </span>
                          )}
                          <span className="font-extrabold text-amber-300 text-base">
                            {tk.tenBan || '🛍️ Mang đi'}
                          </span>
                          <span className="text-xs text-stone-400">Đợt {tk.dotGoi}</span>
                        </div>
                        <span className="px-2 py-0.5 rounded-lg bg-stone-700 text-stone-200 text-xs font-bold">
                          ⏱ {mins}p ({tk.doneItems}/{tk.totalItems})
                        </span>
                      </div>

                      {tk.allStationsReady && (
                        <div className="px-3 py-2 rounded-xl bg-emerald-600 text-white text-xs font-black text-center">
                          ✅ ĐỦ 100% MÓN ĐA QUẦY — SẴN SÀNG BƯNG / GỌI KHÁCH!
                        </div>
                      )}

                      <div className="flex flex-wrap gap-1.5 text-[11px]">
                        {(tk.stations || []).map((st) => (
                          <span
                            key={st.station}
                            className={`px-2.5 py-1 rounded-lg font-extrabold ${
                              st.ready
                                ? 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/50'
                                : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                            }`}
                          >
                            {st.ready ? '✓' : '⏳'} {st.station}: {st.done}/{st.total}
                          </span>
                        ))}
                      </div>

                      <div className="space-y-1.5 text-xs">
                        {(tk.items || []).map((it) => (
                          <div key={it.maCTHD} className="flex items-center justify-between bg-stone-900/80 px-3 py-2 rounded-lg">
                            <span className={it.trangThaiPhaChe === 'DaXong' || it.trangThaiPhaChe === 'DaPhucVu' ? 'text-emerald-300 font-bold' : 'text-stone-200'}>
                              {it.trangThaiPhaChe === 'DaXong' || it.trangThaiPhaChe === 'DaPhucVu' ? '✓ ' : '• '}
                              {it.tenMon} ({it.kichThuoc}) ×{it.soLuong}
                            </span>
                            <span className="text-[10px] text-stone-400">{it.tramCheBien}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        ) : viewMode === 'RECALL' ? (
          /* Chế độ KDS Recall — Hoàn tác trả món trong 15 phút gần nhất */
          recallList.length === 0 ? (
            <div className="h-96 flex flex-col items-center justify-center text-stone-500">
              <p className="text-4xl mb-3">↩️</p>
              <p className="text-lg font-medium">Chưa có món nào vừa trả trong 15 phút gần đây</p>
              <p className="text-xs text-stone-500 mt-1">
                Khi lỡ bấm nhầm &quot;Trả món&quot;, mở mục này để kéo món quay lại hàng đợi Đang pha.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {recallList.map((item) => {
                const stt = formatStt(item.soThuTuNgay)
                const doneMins = getElapsedMinutes(item.thoiGianXong || item.thoiGianGoi, nowMs)
                return (
                  <div
                    key={item.maCTHD}
                    className="bg-stone-800 border-2 border-sky-500/70 rounded-2xl p-5 flex flex-col justify-between shadow-lg space-y-3"
                  >
                    <div>
                      <div className="flex items-center justify-between text-xs text-stone-400 pb-2 border-b border-stone-700 gap-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {stt && (
                            <span className="px-2 py-0.5 rounded-md bg-amber-500 text-stone-950 font-black text-xs">
                              {stt}
                            </span>
                          )}
                          <span className="font-extrabold text-sky-300 text-sm">
                            {item.tenBan || '🛍️ Mang đi'}
                          </span>
                        </div>
                        <span className="px-2 py-0.5 rounded-lg bg-sky-900/80 text-sky-200 font-bold shrink-0">
                          ✓ {doneMins}p trước
                        </span>
                      </div>

                      <div className="my-3">
                        <div className="flex items-baseline justify-between gap-2">
                          <h3 className="text-lg font-extrabold text-white">{item.tenMon}</h3>
                          <span className="px-2 py-0.5 rounded-lg bg-amber-500/20 text-amber-300 font-bold text-xs shrink-0">
                            Size {item.kichThuoc}
                          </span>
                        </div>
                        <p className="text-xl font-black text-emerald-400 mt-1">×{item.soLuong}</p>
                        {item.toppings?.length > 0 && (
                          <p className="mt-1.5 text-xs text-amber-200">
                            + {item.toppings.map((t) => `${t.tenTopping} ×${t.soLuong}`).join(', ')}
                          </p>
                        )}
                        {item.ghiChu && (
                          <p className="mt-1 text-xs text-stone-400 italic">📝 {item.ghiChu}</p>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleRecallDish(item)}
                      disabled={dangXuLy.has(item.maCTHD)}
                      className="w-full min-h-12 bg-sky-600 hover:bg-sky-500 disabled:bg-stone-600 text-white font-extrabold rounded-xl text-sm transition cursor-pointer"
                    >
                      ↩️ Hoàn tác về Đang pha
                    </button>
                  </div>
                )
              })}
            </div>
          )
        ) : filteredQueue.length === 0 ? (
          <div className="h-96 flex flex-col items-center justify-center text-stone-500">
            <p className="text-4xl mb-3">☕</p>
            <p className="text-lg font-medium">Hiện không có món nào đang chờ ở trạm này</p>
          </div>
        ) : viewMode === 'BATCH' ? (
          /* Chế độ Gom món pha theo mẻ (All-Day Batch View nhóm theo MaMon, KichThuoc, MucDuongDa) */
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {batchSummary.map((b) => (
              <div
                key={b.key}
                className="bg-stone-800 border-2 border-amber-500/70 rounded-2xl p-5 space-y-3 shadow-lg flex flex-col justify-between"
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between border-b border-stone-700 pb-3">
                    <div>
                      <h3 className="text-xl font-extrabold text-white">{b.tenMon}</h3>
                      <span className="text-xs font-bold text-amber-300">Size {b.kichThuoc}</span>
                    </div>
                    <span className="px-4 py-2 rounded-2xl bg-emerald-600 text-white text-2xl font-black">
                      ×{b.tongLy}
                    </span>
                  </div>

                  {/* Bảng tóm tắt gom mẻ theo Mức đường/đá & Topping để Barista đong 1 lần */}
                  <div className="p-2.5 rounded-xl bg-amber-950/50 border border-amber-700/50 space-y-1 text-xs">
                    <p className="font-extrabold text-amber-300">🧪 Tóm tắt công thức mẻ ({b.tongLy} ly):</p>
                    {Object.entries(b.nhomGhiChuMap).map(([noteLabel, qty]) => (
                      <div key={noteLabel} className="flex items-center justify-between text-amber-100">
                        <span className="truncate pr-2">• {noteLabel}</span>
                        <b className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 shrink-0">
                          {qty} ly
                        </b>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                    {b.chiTiet.map((item) => {
                      const stt = formatStt(item.soThuTuNgay)
                      return (
                        <div
                          key={item.maCTHD}
                          className="p-2.5 rounded-xl bg-stone-900 flex items-center justify-between gap-2 text-xs"
                        >
                          <div>
                            <p className="font-bold text-amber-300 flex items-center gap-1.5 flex-wrap">
                              {stt && (
                                <span className="px-1.5 py-0.5 rounded bg-amber-500 text-stone-950 font-black text-[11px]">
                                  {stt}
                                </span>
                              )}
                              <span>
                                {item.tenBan || 'Mang đi'} (#{item.maHoaDon}) • x{item.soLuong}
                              </span>
                            </p>
                            {Array.isArray(item.modifiersSnapshot) && item.modifiersSnapshot.length > 0 && (
                              <p className="text-sky-300 font-semibold">
                                ⚙️{' '}
                                {item.modifiersSnapshot
                                  .map((m) => {
                                    const mQty = Number(m.qty ?? m.soLuong ?? 1)
                                    const lbl = m.tenInNgan || m.tenOption || ''
                                    return mQty > 1 ? `${lbl} x${mQty}` : lbl
                                  })
                                  .join(', ')}
                              </p>
                            )}
                            {item.toppings?.length > 0 && (
                              <p className="text-amber-100">
                                + {item.toppings.map((t) => `${t.tenTopping} x${t.soLuong}`).join(', ')}
                              </p>
                            )}
                            {item.ghiChu && <p className="text-stone-400 italic">📝 {item.ghiChu}</p>}
                          </div>
                          <button
                            onClick={() => handleFinishDish(item)}
                            disabled={dangXuLy.has(item.maCTHD)}
                            className="min-h-12 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold shrink-0 cursor-pointer"
                          >
                            ✓ Xong
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {b.chiTiet.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleFinishWholeBatch(b)}
                    className="w-full min-h-12 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-extrabold text-sm cursor-pointer"
                  >
                    ✓ Trả xong toàn bộ mẻ ({b.tongLy} ly)
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : viewMode === 'TICKET' ? (
          /* Chế độ Theo Đơn hàng (Ticket View) */
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {tickets.map((tk) => {
              const mins = getElapsedMinutes(tk.thoiGianGoi, nowMs)
              const sla = getSlaStyle(mins, false)
              const stt = formatStt(tk.soThuTuNgay)
              return (
                <div
                  key={tk.maHoaDon}
                  className={`bg-stone-800 border-2 rounded-2xl p-5 flex flex-col justify-between shadow-lg space-y-3 ${sla.border}`}
                >
                  <div className="flex items-center justify-between border-b border-stone-700 pb-2 gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {stt && (
                        <span className="px-2 py-0.5 rounded-md bg-amber-500 text-stone-950 font-black text-xs">
                          {stt}
                        </span>
                      )}
                      <span className="font-extrabold text-amber-400 text-base">{tk.tenBan}</span>
                      <span className="text-xs text-stone-400">#{tk.maHoaDon}</span>
                    </div>
                    <span className={`px-2.5 py-1 rounded-lg text-xs font-extrabold shrink-0 ${sla.badge}`}>
                      ⏱ {mins} phút
                    </span>
                  </div>
                  <div className="space-y-2.5 flex-1">
                    {tk.items.map((item) => (
                      <div key={item.maCTHD} className="p-3 rounded-xl bg-stone-900 space-y-2">
                        <div className="flex justify-between items-start gap-2">
                          <div>
                            <p className="font-bold text-white text-sm">
                              {item.tenMon} ({item.kichThuoc}) × {item.soLuong}
                            </p>
                            {item.toppings?.length > 0 && (
                              <p className="text-xs text-amber-200">
                                + {item.toppings.map((t) => `${t.tenTopping} x${t.soLuong}`).join(', ')}
                              </p>
                            )}
                            {item.ghiChu && <p className="text-xs text-stone-400 italic">📝 {item.ghiChu}</p>}
                          </div>
                          <button
                            onClick={() => handleFinishDish(item)}
                            disabled={dangXuLy.has(item.maCTHD)}
                            className="min-h-12 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold shrink-0 cursor-pointer"
                          >
                            ✓ Trả
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          /* Chế độ Theo từng dòng món (Item View + SLA Timer + Nhận làm) */
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {hienThi.map((item, cardIdx) => {
              const dangHoan = hoan.has(item.maCTHD)
              const nhan = NHAN_TRANG_THAI[item.trangThaiPhaChe]
              const mins = getElapsedMinutes(item.firedAt || item.thoiGianGoi, nowMs)
              const sla = getSlaStyle(mins, dangHoan)
              const isMaking = item.trangThaiPhaChe === 'DangLam'
              const isRemake = Boolean(item.remakeOfCTHD) || Number(item.mucDoUuTien) >= 2
              const isOpenItem = Boolean(item.laMonThoiGia || item.tenMonTuyChinh || item.trongLuongGram)
              const stt = formatStt(item.soThuTuNgay)

              return (
                <div
                  key={item.maCTHD}
                  className={`bg-stone-800 border-2 rounded-2xl p-5 flex flex-col justify-between shadow-lg ${
                    isRemake ? 'border-fuchsia-400 ring-2 ring-fuchsia-500/70' : sla.border
                  }`}
                >
                  <div>
                    {isRemake && (
                      <div className="mb-2 px-3 py-1.5 rounded-xl bg-fuchsia-600 text-white text-xs font-black flex items-center justify-between">
                        <span>⚡ LÀM LẠI (0đ • ƯU TIÊN CAO NHẤT)</span>
                        {cardIdx < 9 && <span className="px-1.5 py-0.5 rounded bg-black/30">Phím {cardIdx + 1}</span>}
                      </div>
                    )}
                    {isOpenItem && (
                      <div className="mb-2 px-2.5 py-1 rounded-lg bg-indigo-900/80 border border-indigo-400 text-indigo-200 text-[11px] font-bold">
                        ⚖️ OPEN ITEM{item.trongLuongGram ? ` • ${item.trongLuongGram}g` : ''}
                      </div>
                    )}
                    {recentTableMoves[item.maHoaDon] && (
                      <div className="mb-2.5 p-2 rounded-xl bg-red-900/90 border border-red-400 text-red-100 text-xs flex items-center justify-between gap-2 animate-pulse">
                        <span className="font-extrabold">
                          ⚠️ ĐỔI BÀN: {recentTableMoves[item.maHoaDon].tenBanCu} →{' '}
                          {recentTableMoves[item.maHoaDon].tenBanMoi}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            printKdsItemLabels50x30(item, {
                              tableMoveNotice: `${recentTableMoves[item.maHoaDon].tenBanCu} -> ${recentTableMoves[item.maHoaDon].tenBanMoi}`,
                            })
                          }
                          className="px-2 py-1 rounded-lg bg-white text-red-900 font-black text-[11px] shrink-0 cursor-pointer"
                        >
                          🏷️ In tem đính chính
                        </button>
                      </div>
                    )}
                    <div className="flex items-center justify-between text-xs text-stone-400 pb-2 border-b border-stone-700 gap-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {stt && (
                          <span className="px-2 py-0.5 rounded-md bg-amber-500 text-stone-950 font-black text-xs">
                            {stt}
                          </span>
                        )}
                        <span className="font-extrabold text-amber-400 text-sm">
                          {item.tenBan || '🛍️ Mang đi'}
                        </span>
                      </div>
                      <span className={`px-2 py-0.5 rounded-lg font-extrabold shrink-0 ${sla.badge}`}>
                        ⏱ {mins}p • {gioHienThi(item.thoiGianGoi)}
                      </span>
                    </div>

                    <div className="my-3.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <h3 className="text-xl font-extrabold text-white">{item.tenMon}</h3>
                        <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 font-bold text-sm shrink-0">
                          Size {item.kichThuoc}
                        </span>
                      </div>
                      <div className="flex items-center justify-between mt-2 gap-2">
                        <p className="text-2xl font-black text-emerald-400">×{item.soLuong}</p>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const nextRush = !(Number(item.mucDoUuTien || 0) >= 2)
                                await orderService.setOrderRush(item.maHoaDon, { rush: nextRush })
                                toast.success(
                                  nextRush
                                    ? `🔥 Đã đặt ưu tiên GẤP đơn #${item.maHoaDon}`
                                    : `Đã gỡ cờ GẤP đơn #${item.maHoaDon}`
                                )
                                void dongBo()
                              } catch {
                                // interceptor handles error
                              }
                            }}
                            className={`px-2 py-1 rounded-lg text-xs font-extrabold cursor-pointer ${
                              Number(item.mucDoUuTien || 0) >= 2
                                ? 'bg-red-600 text-white'
                                : 'bg-stone-700 hover:bg-red-700 text-amber-200'
                            }`}
                          >
                            🔥 {Number(item.mucDoUuTien || 0) >= 2 ? 'GẤP' : 'Đặt gấp'}
                          </button>
                          {nhan && (
                            <span className={`px-2.5 py-1 rounded-lg text-xs font-bold ${nhan.cls}`}>
                              {nhan.text}
                            </span>
                          )}
                        </div>
                      </div>

                      {Array.isArray(item.modifiersSnapshot) && item.modifiersSnapshot.length > 0 && (
                        <div className="mt-2 p-2 rounded-xl bg-sky-950/60 border border-sky-600/50 text-xs text-sky-200 flex flex-wrap gap-1">
                          {item.modifiersSnapshot.map((m, idx) => {
                            const mQty = Number(m.qty ?? m.soLuong ?? 1)
                            return (
                              <span
                                key={`${m.optionId || idx}`}
                                className="px-2 py-0.5 rounded bg-sky-800/80 font-bold"
                              >
                                {m.tenInNgan || m.tenOption}
                                {mQty > 1 ? ` x${mQty}` : ''}
                              </span>
                            )
                          })}
                        </div>
                      )}

                      {item.toppings?.length > 0 && (
                        <div className="mt-2.5 p-2.5 rounded-xl bg-stone-900 border border-amber-700/50 text-sm text-amber-100 space-y-0.5">
                          {item.toppings.map((t) => (
                            <p key={t.maTopping} className="font-semibold">
                              + {t.tenTopping} ×{t.soLuong}
                            </p>
                          ))}
                        </div>
                      )}

                      {item.ghiChu && (
                        <p className="mt-2 p-2.5 rounded-xl bg-stone-900 text-amber-200 text-xs italic">
                          📝 {item.ghiChu}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex gap-2 pt-3 border-t border-stone-700">
                    {!isMaking && (
                      <button
                        onClick={() => handleStartDish(item)}
                        disabled={dangXuLy.has(item.maCTHD)}
                        className="min-h-12 px-3 bg-sky-600 hover:bg-sky-500 disabled:bg-stone-600 text-white font-bold rounded-xl text-xs transition cursor-pointer"
                      >
                        🔥 Nhận làm
                      </button>
                    )}
                    <button
                      onClick={() => handleFinishDish(item)}
                      disabled={dangXuLy.has(item.maCTHD)}
                      className="flex-1 min-h-12 bg-emerald-600 hover:bg-emerald-500 disabled:bg-stone-600 text-white font-extrabold rounded-xl text-sm transition cursor-pointer"
                    >
                      ✓ Trả món
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (Number(item.soLuong) > 1) {
                          setResumePrintItem(item)
                        } else {
                          void printKdsItemLabels50x30(item)
                        }
                      }}
                      title="In lại tem dán cốc (hoặc chọn in tiếp từ ly k/N khi kẹt giấy)"
                      className="min-h-12 px-2.5 bg-stone-700 hover:bg-stone-600 text-amber-300 rounded-xl text-xs font-bold cursor-pointer"
                    >
                      🏷️
                    </button>
                    <button
                      onClick={() => toggleHoan(item.maCTHD)}
                      className="min-h-12 px-3 bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-xl text-xs cursor-pointer"
                    >
                      {dangHoan ? 'Bỏ hoãn' : 'Hoãn'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </main>

      {/* Modal Báo Hết Món (86'ing) */}
      {show86Modal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-stone-900 border border-stone-700 rounded-2xl max-w-lg w-full p-5 shadow-2xl space-y-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-stone-800 pb-3">
              <div>
                <h3 className="font-extrabold text-base text-amber-400">
                  🚫 Khóa nhanh Món &amp; Topping Tạm Hết (86&apos;ing)
                </h3>
                <p className="text-xs text-stone-400">
                  Đồng bộ tức thì lên mọi màn hình Thu ngân &amp; Phục vụ
                </p>
              </div>
              <button
                onClick={() => setShow86Modal(false)}
                className="w-10 h-10 rounded-full bg-stone-800 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>
            <div className="flex gap-2 text-xs font-bold">
              <button
                type="button"
                onClick={() => setTab86('MENU')}
                className={`flex-1 py-2 rounded-xl cursor-pointer ${
                  tab86 === 'MENU' ? 'bg-amber-600 text-white' : 'bg-stone-800 text-stone-300'
                }`}
              >
                ☕ Món ({menuList.length})
              </button>
              <button
                type="button"
                onClick={() => setTab86('TOPPING')}
                className={`flex-1 py-2 rounded-xl cursor-pointer ${
                  tab86 === 'TOPPING' ? 'bg-amber-600 text-white' : 'bg-stone-800 text-stone-300'
                }`}
              >
                🧋 Topping ({toppingList.length})
              </button>
              <button
                type="button"
                onClick={() => setTab86('INGREDIENT')}
                className={`flex-1 py-2 rounded-xl cursor-pointer ${
                  tab86 === 'INGREDIENT' ? 'bg-amber-600 text-white' : 'bg-stone-800 text-stone-300'
                }`}
              >
                📦 Nguyên liệu ({ingredientList.length})
              </button>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {tab86 === 'MENU'
                ? menuList.map((m) => (
                    <div
                      key={m.maMon}
                      className="p-3 rounded-xl bg-stone-800 flex items-center justify-between gap-2"
                    >
                      <div>
                        <p className="font-bold text-sm text-white">{m.tenMon}</p>
                        <p className="text-xs text-stone-400">{m.nhomMon} • {m.maMon}</p>
                      </div>
                      <button
                        type="button"
                        disabled={toggling86 === m.maMon}
                        onClick={() => handleToggle86(m)}
                        className={`min-h-10 px-4 rounded-xl text-xs font-extrabold cursor-pointer ${
                          m.tamHet
                            ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                            : 'bg-red-600 hover:bg-red-500 text-white'
                        }`}
                      >
                        {m.tamHet ? '✓ Mở bán lại' : '🚫 Báo tạm hết'}
                      </button>
                    </div>
                  ))
                : tab86 === 'TOPPING'
                ? toppingList.map((tp) => (
                    <div
                      key={tp.maTopping}
                      className="p-3 rounded-xl bg-stone-800 flex items-center justify-between gap-2"
                    >
                      <div>
                        <p className="font-bold text-sm text-white">{tp.tenTopping}</p>
                        <p className="text-xs text-stone-400">{tp.maTopping}</p>
                      </div>
                      <button
                        type="button"
                        disabled={toggling86 === tp.maTopping}
                        onClick={() => handleToggle86Topping(tp)}
                        className={`min-h-10 px-4 rounded-xl text-xs font-extrabold cursor-pointer ${
                          tp.tamHet
                            ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                            : 'bg-red-600 hover:bg-red-500 text-white'
                        }`}
                      >
                        {tp.tamHet ? '✓ Mở topping' : '🚫 Hết topping'}
                      </button>
                    </div>
                  ))
                : (
                  <>
                    <div className="p-2.5 rounded-xl bg-amber-950/60 border border-amber-700/50 text-[11px] text-amber-200">
                      💡 Chọn <b>Hết NL</b> để khóa tự động mọi Món &amp; Topping có dùng nguyên liệu đó theo công thức BOM.
                    </div>
                    {ingredientList.map((nl) => {
                      const busy = toggling86 === `NL_${nl.maNL}`
                      const isLow = nl.hanMuc > 0 && nl.tonKho <= nl.hanMuc
                      return (
                        <div
                          key={nl.maNL}
                          className="p-3 rounded-xl bg-stone-800 flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <p className="font-bold text-sm text-white truncate">{nl.tenNL}</p>
                            <p className={`text-xs ${isLow ? 'text-red-300 font-bold' : 'text-stone-400'}`}>
                              {nl.maNL} • Tồn: {nl.tonKho} {nl.donViTinh}
                              {isLow ? ' ⚠️' : ''}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleToggle86Ingredient(nl, true)}
                              className="min-h-10 px-3 rounded-xl text-xs font-extrabold bg-red-600 hover:bg-red-500 disabled:bg-stone-600 text-white cursor-pointer"
                            >
                              🚫 Hết NL
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleToggle86Ingredient(nl, false)}
                              className="min-h-10 px-3 rounded-xl text-xs font-extrabold bg-emerald-600 hover:bg-emerald-500 disabled:bg-stone-600 text-white cursor-pointer"
                            >
                              ✓ Mở lại
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </>
                )}
            </div>
          </div>
        </div>
      )}

      {/* Modal In lại / In tiếp tem dán cốc từ ly k/N khi máy in kẹt giấy */}
      {resumePrintItem && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-stone-900 border border-stone-700 rounded-2xl max-w-sm w-full p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-stone-800 pb-2.5">
              <h3 className="font-extrabold text-sm text-amber-400">
                🏷️ In tiếp tem cốc ({resumePrintItem.tenMon} ×{resumePrintItem.soLuong})
              </h3>
              <button
                type="button"
                onClick={() => setResumePrintItem(null)}
                className="w-8 h-8 rounded-full bg-stone-800 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-stone-400">
              Khi máy in hết giấy/kẹt giấy giữa chừng, chọn ly bắt đầu in tiếp để không phải in lại từ ly 1:
            </p>
            <div className="grid grid-cols-2 gap-2">
              {Array.from({ length: Number(resumePrintItem.soLuong || 1) }, (_, idx) => idx + 1).map(
                (cupNum) => (
                  <button
                    key={cupNum}
                    type="button"
                    onClick={() => {
                      void printKdsItemLabels50x30(resumePrintItem, { startFromCup: cupNum })
                      setResumePrintItem(null)
                    }}
                    className="py-2.5 px-3 rounded-xl bg-stone-800 hover:bg-amber-600 hover:text-stone-950 font-extrabold text-xs cursor-pointer transition"
                  >
                    {cupNum === 1
                      ? `In đủ cả ${resumePrintItem.soLuong} tem`
                      : `In tiếp từ ly ${cupNum}/${resumePrintItem.soLuong}`}
                  </button>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
