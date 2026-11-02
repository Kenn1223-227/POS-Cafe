import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useSocketEvents } from '../../socket/useSocketEvents'
import { useAuthStore } from '../../store/authStore'

const STORAGE_WAITER_QUEUE = 'waiter_ready_queue'

export default function WaiterPage() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()

  const [readyList, setReadyList] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_WAITER_QUEUE)) || []
    } catch {
      return []
    }
  })

  useEffect(() => {
    localStorage.setItem(STORAGE_WAITER_QUEUE, JSON.stringify(readyList))
  }, [readyList])

  const onDishReady = (payload) => {
    toast.success(`🔔 Món ${payload.maCTHD} đã pha chế xong!`)
    setReadyList((prev) => [
      {
        id: `${payload.maCTHD}_${Date.now()}`,
        maCTHD: payload.maCTHD,
        tenMon: payload.tenMon || 'Đồ uống đã hoàn tất',
        maBan: payload.maBan || 'Quầy Bar',
        message: payload.message || 'Món đã pha chế xong, mời phục vụ nhận món!',
        time: new Date().toLocaleTimeString('vi-VN'),
      },
      ...prev,
    ])
  }

  useSocketEvents({ MON_DA_XONG: onDishReady })

  const handleDelivered = (id) => {
    setReadyList((prev) => prev.filter((item) => item.id !== id))
    toast.success('Đã xác nhận mang lên cho khách')
  }

  return (
    <div className="min-h-screen bg-amber-50 flex flex-col">
      <header className="bg-amber-800 text-white px-6 py-4 flex items-center justify-between shadow">
        <div>
          <h1 className="text-xl font-bold">🏃 Màn hình Phục Vụ (Waiter)</h1>
          <p className="text-xs text-amber-200">
            Nhân viên: {user?.tenNV} • Kênh real-time: <code>room_phucvu</code>
          </p>
        </div>
        <button
          onClick={() => {
            logout()
            navigate('/login', { replace: true })
          }}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-xl text-xs font-semibold cursor-pointer"
        >
          Đăng xuất
        </button>
      </header>

      <main className="flex-1 p-6 max-w-5xl w-full mx-auto">
        {readyList.length === 0 ? (
          <div className="bg-white rounded-2xl p-12 text-center shadow-sm border border-amber-100">
            <p className="text-4xl mb-2">🛎️</p>
            <p className="text-gray-600 font-medium">
              Chưa có món mới cần bưng. Thông báo sẽ hiển thị tức thời khi Barista hoàn tất!
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {readyList.map((item) => (
              <div
                key={item.id}
                className="bg-white rounded-2xl p-5 shadow-md border-l-8 border-emerald-500 flex items-center justify-between gap-4"
              >
                <div>
                  <span className="inline-block text-xs font-bold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 mb-2">
                    Món sẵn sàng • {item.time}
                  </span>
                  <h3 className="text-lg font-bold text-gray-800">
                    Mã CTHD: {item.maCTHD}
                  </h3>
                  <p className="text-sm text-gray-600 mt-0.5">{item.message}</p>
                  <p className="text-xs font-semibold text-amber-800 mt-1">
                    Vị trí: {item.maBan}
                  </p>
                </div>

                <button
                  onClick={() => handleDelivered(item.id)}
                  className="px-5 py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-sm shrink-0 shadow cursor-pointer"
                >
                  Đã bưng cho khách
                </button>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}