import { useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { formatVND } from '../utils/format'
import { playNewOrderSound, playCashSuccessSound } from '../utils/sound'

const SAMPLE_MENU = [
  { id: 'CF1', name: 'Cà phê Sữa đá', price: 29000, size: 'M', group: 'Cà phê' },
  { id: 'CF2', name: 'Bạc xỉu đá', price: 35000, size: 'M', group: 'Cà phê' },
  { id: 'CF3', name: 'Cà phê Muối', price: 38000, size: 'M', group: 'Cà phê' },
  { id: 'TR1', name: 'Trà Đào Cam Sả', price: 42000, size: 'L', group: 'Trà trái cây' },
  { id: 'TR2', name: 'Matcha Latte', price: 45000, size: 'M', group: 'Matcha' },
  { id: 'TS1', name: 'Trà sữa Trân châu ĐĐ', price: 45000, size: 'L', group: 'Trà sữa' },
]

// [PLG] Interactive Split-Screen Live Sandbox (Không cần đăng ký tài khoản!)
export default function LiveSandboxPage() {
  const [cart, setCart] = useState([])
  const [ice, setIce] = useState('100% Đá')
  const [sugar, setSugar] = useState('70% Đường')
  const [tableName, setTableName] = useState('Mang đi')
  const [kdsOrders, setKdsOrders] = useState([])
  const [completedCount, setCompletedCount] = useState(0)
  const seqRef = useRef(100)

  const addItem = (item) => {
    setCart((prev) => {
      const note = `${ice} • ${sugar}`
      const idx = prev.findIndex((i) => i.id === item.id && i.note === note)
      if (idx > -1) {
        return prev.map((x, k) => (k === idx ? { ...x, qty: x.qty + 1 } : x))
      }
      return [...prev, { ...item, qty: 1, note }]
    })
  }

  const cartTotal = cart.reduce((s, i) => s + i.price * i.qty, 0)

  const sendToBar = () => {
    if (cart.length === 0) return
    seqRef.current += 1
    const orderNo = String(seqRef.current)
    const newTicket = {
      id: `SB-${orderNo}`,
      orderNo,
      tableName,
      items: cart,
      total: cartTotal,
      status: 'ChoPhaChe',
      time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    }
    setKdsOrders((prev) => [newTicket, ...prev])
    setCart([])
    playNewOrderSound()
  }

  const startTicket = (id) => {
    setKdsOrders((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'DangLam' } : t)))
  }

  const finishTicket = (id) => {
    setKdsOrders((prev) => prev.filter((t) => t.id !== id))
    setCompletedCount((c) => c + 1)
    playCashSuccessSound()
  }

  return (
    <div className="min-h-screen bg-stone-950 text-white flex flex-col">
      <header className="bg-stone-900 border-b border-stone-800 px-5 py-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-xs font-extrabold uppercase text-amber-400">
            🎮 Interactive Live Sandbox — Dùng thử ngay không cần tạo tài khoản
          </span>
          <h1 className="text-lg font-black text-white">
            Bấm đơn ở Thu ngân (Trái) → Xem đơn nhảy tức thì sang Quầy Bar KDS (Phải)
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/onboarding"
            className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold rounded-xl text-xs shadow-lg"
          >
            🚀 Tạo quán thật của bạn trong 30s (Miễn phí)
          </Link>
          <Link
            to="/login"
            className="px-3.5 py-2.5 bg-stone-800 hover:bg-stone-700 text-stone-200 font-bold rounded-xl text-xs"
          >
            Đăng nhập
          </Link>
        </div>
      </header>

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-stone-800">
        {/* NỬA TRÁI: MÀN HÌNH POS THU NGÂN */}
        <section className="p-5 bg-stone-100 text-stone-900 flex flex-col justify-between space-y-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-black text-amber-800">🖥️ 1. Màn hình Thu ngân (POS)</h2>
              <div className="flex gap-1.5 text-xs font-bold">
                {['Mang đi', 'Bàn 01', 'Bàn 02'].map((t) => (
                  <button
                    key={t}
                    onClick={() => setTableName(t)}
                    className={`px-3 py-1.5 rounded-xl cursor-pointer ${
                      tableName === t ? 'bg-stone-900 text-white' : 'bg-white border text-stone-700'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-2 text-xs">
              {['100% Đá', '50% Đá', 'Không đá'].map((opt) => (
                <button
                  key={opt}
                  onClick={() => setIce(opt)}
                  className={`px-3 py-1.5 rounded-lg font-bold cursor-pointer ${
                    ice === opt ? 'bg-sky-700 text-white' : 'bg-white border'
                  }`}
                >
                  🧊 {opt}
                </button>
              ))}
              {['100% Đường', '70% Đường', '30% Đường'].map((opt) => (
                <button
                  key={opt}
                  onClick={() => setSugar(opt)}
                  className={`px-3 py-1.5 rounded-lg font-bold cursor-pointer ${
                    sugar === opt ? 'bg-amber-700 text-white' : 'bg-white border'
                  }`}
                >
                  🍯 {opt}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {SAMPLE_MENU.map((item) => (
                <button
                  key={item.id}
                  onClick={() => addItem(item)}
                  className="p-3.5 rounded-2xl bg-white border border-stone-200 hover:border-amber-600 hover:shadow text-left transition cursor-pointer active:scale-95"
                >
                  <span className="text-[10px] font-bold uppercase text-amber-700">{item.group}</span>
                  <p className="font-extrabold text-sm text-stone-900 mt-0.5">{item.name}</p>
                  <p className="text-sm font-black text-amber-700 mt-2">{formatVND(item.price)}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-2xl p-4 border border-stone-200 space-y-3 shadow-sm">
            <div className="flex justify-between items-center text-xs font-bold">
              <span>Giỏ hàng ({tableName})</span>
              {cart.length > 0 && (
                <button onClick={() => setCart([])} className="text-red-600 cursor-pointer">
                  Xóa giỏ
                </button>
              )}
            </div>
            {cart.length === 0 ? (
              <p className="text-xs text-stone-400 text-center py-3">
                👆 Chạm vào bất kỳ món nào phía trên để thêm vào giỏ
              </p>
            ) : (
              <div className="space-y-1.5 max-h-36 overflow-y-auto text-xs">
                {cart.map((c, idx) => (
                  <div key={idx} className="flex justify-between items-center py-1 border-b border-stone-100">
                    <div>
                      <b>{c.name}</b> ×{c.qty} <span className="text-stone-400">({c.note})</span>
                    </div>
                    <span className="font-bold">{formatVND(c.price * c.qty)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between pt-2 border-t">
              <span className="text-lg font-black text-amber-700">{formatVND(cartTotal)}</span>
              <button
                onClick={sendToBar}
                disabled={cart.length === 0}
                className="min-h-12 px-5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-stone-300 text-white font-extrabold rounded-xl text-sm shadow cursor-pointer"
              >
                ⚡ Thu tiền & Gửi Quầy Bar →
              </button>
            </div>
          </div>
        </section>

        {/* NỬA PHẢI: MÀN HÌNH KDS QUẦY PHA CHẾ */}
        <section className="p-5 bg-stone-900 flex flex-col space-y-4">
          <div className="flex items-center justify-between border-b border-stone-800 pb-3">
            <div>
              <h2 className="text-base font-black text-amber-400">🍹 2. Màn hình Quầy Pha Chế (KDS Barista)</h2>
              <p className="text-xs text-stone-400">
                Đang chờ: <b className="text-amber-300">{kdsOrders.length} đơn</b> • Đã hoàn tất:{' '}
                <b className="text-emerald-400">{completedCount} đơn</b>
              </p>
            </div>
            <span className="px-3 py-1 rounded-full bg-emerald-900/60 border border-emerald-600 text-emerald-300 text-xs font-bold">
              ● Real-time WebSocket Ready
            </span>
          </div>

          {kdsOrders.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-stone-500 text-center space-y-2 py-16">
              <span className="text-5xl">🔔</span>
              <p className="text-base font-bold text-stone-300">Đang chờ đơn từ Thu ngân bên trái...</p>
              <p className="text-xs max-w-sm">
                Thử chọn 1 ly Cà phê Sữa đá rồi bấm &ldquo;Thu tiền & Gửi Quầy Bar&rdquo; để nghe âm báo Ting-Ting!
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 overflow-y-auto">
              {kdsOrders.map((tk) => (
                <div
                  key={tk.id}
                  className={`p-4 rounded-2xl bg-stone-800 border-2 space-y-3 shadow-lg ${
                    tk.status === 'DangLam' ? 'border-sky-400' : 'border-amber-400'
                  }`}
                >
                  <div className="flex justify-between items-center text-xs border-b border-stone-700 pb-2">
                    <span className="font-extrabold text-amber-400 text-sm">
                      #{tk.orderNo} • {tk.tableName}
                    </span>
                    <span className="text-stone-400">{tk.time}</span>
                  </div>
                  <div className="space-y-1.5 text-sm">
                    {tk.items.map((it, idx) => (
                      <div key={idx} className="bg-stone-900 p-2 rounded-xl">
                        <p className="font-bold text-white">
                          {it.name} ({it.size}) <span className="text-emerald-400 font-black">×{it.qty}</span>
                        </p>
                        <p className="text-[11px] text-amber-200 italic">{it.note}</p>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    {tk.status !== 'DangLam' && (
                      <button
                        onClick={() => startTicket(tk.id)}
                        className="px-3 py-2.5 bg-sky-600 hover:bg-sky-500 rounded-xl text-xs font-bold cursor-pointer"
                      >
                        🔥 Nhận làm
                      </button>
                    )}
                    <button
                      onClick={() => finishTicket(tk.id)}
                      className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-xs font-extrabold cursor-pointer"
                    >
                      ✓ Trả món xong
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
