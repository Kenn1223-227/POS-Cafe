import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useSocketEvents } from '../../socket/useSocketEvents'
import { orderService } from '../../services/orderService'
import { sanPhamService } from '../../services/sanPhamService'
import { khoService } from '../../services/khoService'
import { useAuthStore } from '../../store/authStore'

const STORAGE_BARISTA_QUEUE = 'barista_kds_queue'

export default function BaristaPage() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()

  const [queue, setQueue] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_BARISTA_QUEUE)) || []
    } catch {
      return []
    }
  })
  const [menuMap, setMenuMap] = useState({})
  const [lowStock, setLowStock] = useState([])
  const [manualMaCTHD, setManualMaCTHD] = useState('')

  useEffect(() => {
    localStorage.setItem(STORAGE_BARISTA_QUEUE, JSON.stringify(queue))
  }, [queue])

  useEffect(() => {
    // Tải danh mục món để ánh xạ maMon -> tenMon và cảnh báo nguyên liệu
    sanPhamService.getMenu().then((list) => {
      const map = {}
      list.forEach((m) => {
        map[m.maMon] = m.tenMon
      })
      setMenuMap(map)
    }).catch(() => {})

    khoService.canhBao().then(setLowStock).catch(() => {})
  }, [])

  const onNewOrder = (payload) => {
    toast.success(`🔔 Có đơn mới: ${payload.maHoaDon} (Bàn ${payload.maBan || 'Mang đi'})`)
    const now = new Date().toLocaleTimeString('vi-VN')
    const newItems = (payload.danhSachMon || []).map((item, idx) => ({
      uid: `${payload.maHoaDon}_${idx}_${Date.now()}`,
      maHoaDon: payload.maHoaDon,
      maBan: payload.maBan,
      tenBan: item.tenBan || (payload.maBan ? `Bàn ${payload.maBan}` : 'Mang đi'),
      maCTHD: item.maCTHD || '', // Sẵn sàng nếu backend trả maCTHD
      maMon: item.maMon,
      tenMon: item.tenMon || menuMap[item.maMon] || item.maMon,
      kichThuoc: item.kichThuoc,
      soLuong: item.soLuong,
      ghiChu: item.ghiChu,
      time: now,
    }))
    setQueue((prev) => [...prev, ...newItems])
  }

  useSocketEvents({ CO_DON_MOI: onNewOrder })

  const handleFinishDish = async (item) => {
    const cthdToCall = item.maCTHD || manualMaCTHD.trim()
    if (!cthdToCall) {
      toast.error('Vui lòng nhập Mã CTHD (do payload CO_DON_MOI chưa đính kèm maCTHD)')
      return
    }
    try {
      await orderService.traMon(cthdToCall)
      toast.success(`Đã trả món: ${item.tenMon}`)
      setQueue((prev) => prev.filter((q) => q.uid !== item.uid))
      setManualMaCTHD('')
    } catch {
      // Interceptor xử lý
    }
  }

  return (
    <div className="min-h-screen bg-stone-900 text-stone-100 flex flex-col">
      <header className="bg-stone-950 px-6 py-4 flex items-center justify-between border-b border-stone-800">
        <div>
          <h1 className="text-xl font-bold text-amber-400">
            🍹 Màn hình KDS Pha Chế (Barista)
          </h1>
          <p className="text-xs text-stone-400">
            Nhân viên: {user?.tenNV} • Đang lắng nghe kênh <code className="text-emerald-400">room_barista</code>
          </p>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="text"
            value={manualMaCTHD}
            onChange={(e) => setManualMaCTHD(e.target.value)}
            placeholder="Nhập nhanh Mã CTHD (nếu cần)..."
            className="px-3 py-2 rounded-lg bg-stone-800 border border-stone-700 text-xs text-white outline-none"
          />
          <button
            onClick={() => {
              logout()
              navigate('/login', { replace: true })
            }}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-xl text-xs font-semibold cursor-pointer"
          >
            Đăng xuất
          </button>
        </div>
      </header>

      {/* Thanh cảnh báo nguyên liệu sắp hết */}
      {lowStock.length > 0 && (
        <div className="bg-red-950/80 border-b border-red-800 px-6 py-2.5 text-xs text-red-200 flex items-center gap-2 overflow-x-auto">
          <span className="font-bold shrink-0">⚠️ Cảnh báo tồn kho thấp:</span>
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

      <main className="flex-1 p-6">
        {queue.length === 0 ? (
          <div className="h-96 flex flex-col items-center justify-center text-stone-500">
            <p className="text-4xl mb-3">☕</p>
            <p className="text-lg font-medium">Hiện không có món nào đang chờ pha chế</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {queue.map((item) => (
              <div
                key={item.uid}
                className="bg-stone-800 border-2 border-amber-500/80 rounded-2xl p-5 flex flex-col justify-between shadow-lg"
              >
                <div>
                  <div className="flex items-center justify-between text-xs text-stone-400 pb-2 border-b border-stone-700">
                    <span className="font-bold text-amber-400 text-sm">
                      {item.tenBan}
                    </span>
                    <span>{item.time} • {item.maHoaDon}</span>
                  </div>

                  <div className="my-4">
                    <div className="flex items-baseline justify-between">
                      <h3 className="text-xl font-bold text-white">
                        {item.tenMon || menuMap[item.maMon] || item.maMon}
                      </h3>
                      <span className="ml-2 px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 font-bold text-sm">
                        Size {item.kichThuoc}
                      </span>
                    </div>
                    <p className="text-2xl font-extrabold text-emerald-400 mt-2">
                      Số lượng: x{item.soLuong}
                    </p>
                    {item.ghiChu && (
                      <p className="mt-2 p-2.5 rounded-xl bg-stone-900 text-amber-200 text-xs italic">
                        📝 Ghi chú: {item.ghiChu}
                      </p>
                    )}
                    {item.maCTHD && (
                      <p className="text-[11px] text-stone-400 mt-1">
                        Mã CTHD: {item.maCTHD}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex gap-2 pt-3 border-t border-stone-700">
                  <button
                    onClick={() => handleFinishDish(item)}
                    className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-sm transition cursor-pointer"
                  >
                    ✓ Hoàn thành / Trả món
                  </button>
                  <button
                    onClick={() =>
                      setQueue((prev) => prev.filter((q) => q.uid !== item.uid))
                    }
                    className="px-3 py-3 bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-xl text-xs cursor-pointer"
                    title="Ẩn khỏi màn hình"
                  >
                    Ẩn
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}