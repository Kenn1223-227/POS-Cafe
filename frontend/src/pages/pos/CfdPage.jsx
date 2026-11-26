import { useState, useEffect, useRef } from 'react'
import { formatVND } from '../../utils/format'

// [P1] Customer Facing Display (Màn hình phụ khách hàng — tự hiển thị số tiền còn lại & xác nhận VietQR tự động)
export default function CfdPage() {
  const [state, setState] = useState({
    tableName: 'Xin chào Quý khách!',
    customer: null,
    cart: [],
    activeInvoice: null,
    total: 0,
    paidAmount: 0,
    remainingAmount: 0,
    vietQrUrl: null,
    transferMemo: '',
  })
  const [celebration, setCelebration] = useState(null) // { amount, message }
  const timerRef = useRef(null)

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel('pos_cfd_channel')
    channel.onmessage = (event) => {
      if (event.data?.type === 'CFD_UPDATE') {
        setState(event.data)
      } else if (event.data?.type === 'CFD_PAID_SUCCESS') {
        setCelebration({
          amount: event.data.amount,
          message: event.data.message || 'Thanh toán thành công!',
        })
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCelebration(null), 6000)
      }
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      channel.close()
    }
  }, [])

  const items = state.activeInvoice
    ? (state.activeInvoice.danhSachMon || []).filter((m) => !m.daHuy && m.trangThaiPhaChe !== 'DaHuy')
    : state.cart || []

  const amountDue = state.remainingAmount ?? state.total

  return (
    <div className="min-h-screen bg-stone-950 text-white flex flex-col relative">
      {/* Banner chúc mừng khi VietQR / Thu ngân thanh toán hoàn tất */}
      {celebration && (
        <div className="fixed inset-0 z-50 bg-emerald-950/95 flex flex-col items-center justify-center text-center p-8 space-y-4">
          <div className="w-24 h-24 rounded-full bg-emerald-500 flex items-center justify-center text-5xl shadow-2xl">
            ✓
          </div>
          <h2 className="text-4xl font-black text-emerald-300">ĐÃ NHẬN THANH TOÁN!</h2>
          <p className="text-3xl font-extrabold text-white">{formatVND(celebration.amount)}</p>
          <p className="text-lg text-emerald-200">{celebration.message}</p>
          <p className="text-sm text-stone-300 pt-4">☕ Cảm ơn Quý khách! Đồ uống đang được pha chế...</p>
        </div>
      )}

      <header className="px-8 py-5 bg-stone-900 border-b border-stone-800 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-amber-400">☕ QUÁN CÀ PHÊ POS</h1>
          <p className="text-sm text-stone-400">{state.tableName}</p>
        </div>
        {state.customer && (
          <div className="bg-amber-500/20 border border-amber-500/40 px-4 py-2 rounded-2xl text-right">
            <p className="text-sm font-bold text-amber-300">Xin chào, {state.customer.tenKH}</p>
            <p className="text-xs text-amber-200">⭐ {state.customer.diemTichLuy || 0} điểm tích lũy</p>
          </div>
        )}
      </header>

      <main className="flex-1 grid grid-cols-1 md:grid-cols-12 gap-6 p-8">
        <div className="md:col-span-7 bg-stone-900 rounded-3xl p-6 border border-stone-800 flex flex-col">
          <h2 className="text-lg font-extrabold text-amber-300 border-b border-stone-800 pb-3 mb-4">
            🧾 Chi tiết đơn hàng của bạn
          </h2>
          {items.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-stone-500 space-y-3">
              <span className="text-6xl">☕</span>
              <p className="text-xl font-bold text-stone-300">Chúc Quý khách một ngày tuyệt vời!</p>
              <p className="text-sm">Mời Quý khách chọn đồ uống tại quầy</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto divide-y divide-stone-800">
              {items.map((m, idx) => (
                <div key={m.maCTHD || m.cartKey || idx} className="py-3 flex justify-between items-center">
                  <div>
                    <p className="text-base font-bold text-white">
                      {m.tenMon} ({m.kichThuoc}) × {m.soLuong}
                    </p>
                    {(m.modifiersSnapshot?.length > 0 || m.modifiers?.length > 0) && (
                      <p className="text-xs text-sky-300">
                        •{' '}
                        {(m.modifiersSnapshot || m.modifiers)
                          .map((mod) => {
                            const lbl = mod.tenInNgan || mod.tenOption || ''
                            const mQty = Number(mod.qty ?? mod.soLuong ?? 1)
                            return lbl ? (mQty > 1 ? `${lbl} x${mQty}` : lbl) : ''
                          })
                          .filter(Boolean)
                          .join(', ')}
                      </p>
                    )}
                    {m.toppings?.length > 0 && (
                      <p className="text-xs text-amber-300">
                        + {m.toppings.map((t) => t.tenTopping).join(', ')}
                      </p>
                    )}
                    {m.ghiChu && <p className="text-xs text-stone-400 italic">{m.ghiChu}</p>}
                  </div>
                  <span className="text-base font-extrabold text-emerald-400">
                    {formatVND(
                      m.thanhTien ??
                        (Number(m.donGia) +
                          Number(m.giaModifiers || 0) +
                          (m.toppings || []).reduce(
                            (s, t) => s + Number(t.donGia) * Number(t.soLuongMoiLy ?? t.soLuong ?? 1),
                            0
                          )) *
                          Number(m.soLuong)
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="border-t border-stone-800 pt-4 mt-4 space-y-1.5">
            {Number(state.discountAmount || state.promoPreview?.tongGiamGia || 0) > 0 && (
              <div className="flex justify-between text-sm text-amber-300 font-bold">
                <span>🎁 Giảm giá khuyến mãi / điểm:</span>
                <span>-{formatVND(Number(state.discountAmount || state.promoPreview?.tongGiamGia || 0))}</span>
              </div>
            )}
            {state.paidAmount > 0 && (
              <>
                <div className="flex justify-between text-sm text-stone-400">
                  <span>Tổng hóa đơn:</span>
                  <span>{formatVND(state.total)}</span>
                </div>
                <div className="flex justify-between text-sm text-emerald-400 font-bold">
                  <span>Đã thanh toán trước:</span>
                  <span>-{formatVND(state.paidAmount)}</span>
                </div>
              </>
            )}
            <div className="flex items-center justify-between">
              <span className="text-lg font-bold text-stone-300">
                {state.paidAmount > 0 ? 'CÒN LẠI CẦN THANH TOÁN' : 'TỔNG THANH TOÁN'}
              </span>
              <span className="text-3xl font-black text-amber-400">{formatVND(amountDue)}</span>
            </div>
          </div>
        </div>

        <div className="md:col-span-5 bg-stone-900 rounded-3xl p-6 border border-stone-800 flex flex-col items-center justify-center text-center space-y-4">
          {state.vietQrUrl && state.activeInvoice?.maHoaDon && amountDue > 0 ? (
            <>
              <span className="px-4 py-1.5 rounded-full bg-emerald-500/20 text-emerald-300 font-bold text-xs">
                📱 QUÉT MÃ VIETQR — TỰ ĐỘNG XÁC NHẬN
              </span>
              <div className="bg-white p-4 rounded-3xl shadow-2xl">
                <img src={state.vietQrUrl} alt="VietQR" className="w-64 h-64 object-contain" />
              </div>
              <p className="text-2xl font-black text-white">{formatVND(amountDue)}</p>
              {state.transferMemo && (
                <p className="text-xs text-stone-400">
                  Nội dung CK: <b className="text-amber-300 font-mono">{state.transferMemo}</b>
                </p>
              )}
            </>
          ) : (
            <div className="space-y-3 text-stone-400">
              <p className="text-5xl">✨</p>
              <h3 className="text-xl font-extrabold text-amber-300">Tích điểm thành viên</h3>
              <p className="text-sm max-w-xs">
                Đọc 4 số cuối số điện thoại cho thu ngân để tích ngay 1 điểm cho mỗi 10.000đ chi tiêu!
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
