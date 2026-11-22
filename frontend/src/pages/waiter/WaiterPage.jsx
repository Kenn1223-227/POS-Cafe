import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useSocketEvents } from '../../socket/useSocketEvents'
import { orderService } from '../../services/orderService'
import { useAuthStore } from '../../store/authStore'
import { playNewOrderSound } from '../../utils/sound'

// Dọn khóa hàng đợi cũ từng lưu sai nguồn sự thật ở localStorage
const KHOA_QUEUE_CU = 'waiter_ready_queue'
// Lưới an toàn: đồng bộ nền mỗi 20 giây phòng trường hợp socket rớt ngầm
const CHU_KY_DONG_BO_MS = 20000

const gioHienThi = (v) => {
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('vi-VN')
}

export default function WaiterPage() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()

  const [readyList, setReadyList] = useState([])
  const [daTai, setDaTai] = useState(false)
  const [loiDongBo, setLoiDongBo] = useState(false)
  const [lanDongBoCuoi, setLanDongBoCuoi] = useState(null)
  const [dangXuLy, setDangXuLy] = useState(() => new Set())

  const yeuCauRef = useRef(0)    // số thứ tự request gần nhất đã gửi
  const daApDungRef = useRef(0)  // bỏ qua phản hồi cũ đến muộn
  const daThayRef = useRef(null) // null = lần tải đầu tiên (chưa bật toast món mới)

  const dongBo = useCallback(async () => {
    const stt = ++yeuCauRef.current
    try {
      const ds = await orderService.getChoPhucVu({ silent: true })
      if (stt < daApDungRef.current) return
      daApDungRef.current = stt

      const ids = new Set(ds.map((m) => m.maCTHD))
      if (daThayRef.current) {
        const moi = ds.filter((m) => !daThayRef.current.has(m.maCTHD))
        if (moi.length > 0) {
          playNewOrderSound()
          const nhanBan = [...new Set(moi.map((m) => m.tenBan || 'Mang đi'))].join(', ')
          toast.success(`🛎️ ${moi.length} món đã pha xong (${nhanBan})`)
        }
      }
      daThayRef.current = ids

      setReadyList(ds)
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
  }, [logout, navigate])

  // Mở trang + polling 20s + đồng bộ ngay khi màn hình tablet/điện thoại sáng lại
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

  // Socket làm tín hiệu kéo lại dữ liệu mới nhất từ server (không cộng tay payload)
  useSocketEvents({
    connect: dongBo,
    MON_DA_XONG: dongBo,
    MON_DA_PHUC_VU: dongBo,
    MON_BI_HUY: dongBo,
    BAN_CHUYEN: dongBo,
  })

  const handleDelivered = async (item) => {
    if (dangXuLy.has(item.maCTHD)) return
    setDangXuLy((prev) => new Set(prev).add(item.maCTHD))
    try {
      await orderService.xacNhanPhucVu(item.maCTHD)
      toast.success(`Đã bưng: ${item.tenMon} → ${item.tenBan || 'Mang đi'}`)
      setReadyList((prev) => prev.filter((q) => q.maCTHD !== item.maCTHD))
    } catch {
      // Interceptor đã báo lỗi (vd. phục vụ khác vừa xác nhận xong); dongBo() bên dưới sẽ cập nhật lại
    } finally {
      setDangXuLy((prev) => {
        const n = new Set(prev)
        n.delete(item.maCTHD)
        return n
      })
      dongBo()
    }
  }

  return (
    <div className="min-h-screen bg-amber-50 flex flex-col">
      <header className="bg-amber-800 text-white px-6 py-4 flex flex-wrap items-center justify-between gap-3 shadow">
        <div>
          <h1 className="text-xl font-bold">🏃 Màn hình Phục Vụ (Waiter)</h1>
          <p className="text-xs text-amber-200">
            Nhân viên: {user?.tenNV} • {readyList.length} món chờ bưng •{' '}
            {loiDongBo ? (
              <span className="text-red-200 font-semibold">
                ⚠️ Mất đồng bộ với máy chủ, đang thử lại...
              </span>
            ) : (
              <span className="text-emerald-200">
                ● Đồng bộ {lanDongBoCuoi ? lanDongBoCuoi.toLocaleTimeString('vi-VN') : '...'}
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/pos')}
            className="px-4 py-2 bg-amber-950/60 hover:bg-amber-950 rounded-xl text-xs font-semibold cursor-pointer"
          >
            🖥️ Về màn hình Order (/pos)
          </button>
          <button
            onClick={dongBo}
            className="px-4 py-2 bg-amber-700 hover:bg-amber-600 rounded-xl text-xs font-semibold cursor-pointer"
          >
            ↻ Tải lại
          </button>
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

      <main className="flex-1 p-6 max-w-6xl w-full mx-auto">
        {!daTai ? (
          <div className="bg-white rounded-2xl p-12 text-center shadow-sm border border-amber-100">
            <p className="text-4xl mb-2">⏳</p>
            <p className="text-gray-600 font-medium">
              {loiDongBo ? 'Chưa tải được danh sách món, đang thử lại...' : 'Đang tải danh sách món chờ bưng...'}
            </p>
          </div>
        ) : readyList.length === 0 ? (
          <div className="bg-white rounded-2xl p-12 text-center shadow-sm border border-amber-100">
            <p className="text-4xl mb-2">🛎️</p>
            <p className="text-gray-600 font-medium">
              Hiện chưa có món nào chờ bưng. Thông báo sẽ hiện tức thời khi Barista hoàn tất!
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {readyList.map((item) => (
              <div
                key={item.maCTHD}
                className="bg-white rounded-2xl p-5 shadow-md border-l-8 border-emerald-500 flex flex-col justify-between gap-4"
              >
                <div>
                  <div className="flex items-center justify-between text-xs text-gray-500 pb-2 border-b">
                    <span className="font-extrabold text-amber-800 text-sm">
                      {item.tenBan || '🛍️ Mang đi'}
                    </span>
                    <span>
                      {gioHienThi(item.thoiGianGoi)} • #{item.maHoaDon}
                    </span>
                  </div>

                  <div className="mt-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="text-lg font-extrabold text-gray-800">{item.tenMon}</h3>
                      <span className="px-2 py-0.5 rounded-lg bg-amber-100 text-amber-900 font-bold text-xs shrink-0">
                        Size {item.kichThuoc}
                      </span>
                    </div>

                    <p className="text-xl font-extrabold text-emerald-700 mt-1">
                      Số lượng: ×{item.soLuong}
                    </p>

                    {item.toppings?.length > 0 && (
                      <div className="mt-2 p-2 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-0.5">
                        {item.toppings.map((t) => (
                          <p key={t.maTopping} className="font-semibold">
                            + {t.tenTopping} ×{t.soLuong}
                          </p>
                        ))}
                      </div>
                    )}

                    {item.ghiChu && (
                      <p className="mt-2 p-2 rounded-xl bg-stone-100 text-stone-700 text-xs italic">
                        📝 {item.ghiChu}
                      </p>
                    )}
                  </div>
                </div>

                <button
                  onClick={() => handleDelivered(item)}
                  disabled={dangXuLy.has(item.maCTHD)}
                  className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white font-bold rounded-xl text-sm shadow cursor-pointer transition"
                >
                  {dangXuLy.has(item.maCTHD) ? 'Đang cập nhật...' : '✓ Đã bưng cho khách'}
                </button>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}