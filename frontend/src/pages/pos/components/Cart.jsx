import { useState } from 'react'
import { formatVND } from '../../../utils/format'

const TRANG_THAI_PHA_CHE_LABEL = {
  ChoPhaChe: '⏳ Chờ pha',
  DangLam: '🔥 Đang pha',
  DaXong: '✅ Đã xong',
  DaPhucVu: '🍽️ Đã phục vụ',
}

export default function Cart({
  selectedTable,
  cart,
  activeInvoice,
  onUpdateQty,
  onUpdateNote,
  onRemoveItem,
  onClearCart,
  onSubmitOrder,
  onPayInvoice,
  onPrintInvoice,
  submitting,
  paying,
}) {
  const [phuongThucTT, setPhuongThucTT] = useState('TIEN_MAT')
  const [tienKhachDua, setTienKhachDua] = useState('')

  const calcCartItemTotal = (item) => {
    const tpPerCup = (item.toppings || []).reduce(
      (s, t) => s + Number(t.donGia) * Number(t.soLuong || 1),
      0
    )
    return (Number(item.donGia) + tpPerCup) * Number(item.soLuong)
  }

  const cartTotal = cart.reduce((s, i) => s + calcCartItemTotal(i), 0)
  const invoiceTotal = Number(activeInvoice?.tongTamTinh || 0)
  const tienThuaDuKien =
    phuongThucTT === 'TIEN_MAT' && tienKhachDua !== ''
      ? Number(tienKhachDua) - invoiceTotal
      : null

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 border border-gray-200 flex flex-col h-full space-y-3">
      {/* Header Bàn */}
      <div className="flex items-center justify-between border-b pb-2.5">
        <div>
          <h3 className="font-extrabold text-base text-gray-800">
            {selectedTable ? `🪑 ${selectedTable.tenBan}` : '🛍️ Đơn Mang Đi'}
          </h3>
          <p className="text-xs text-gray-500">
            {selectedTable
              ? `Mã: ${selectedTable.maBan} • ${
                  Number(selectedTable.trangThai) === 2
                    ? 'Đang có khách'
                    : 'Bàn trống'
                }`
              : 'Khách mua mang về'}
          </p>
        </div>
        {cart.length > 0 && (
          <button
            onClick={onClearCart}
            className="text-xs text-red-600 font-bold hover:underline cursor-pointer"
          >
            Xóa giỏ chọn
          </button>
        )}
      </div>

      {/* Hóa đơn đang mở trên bàn (từ GET /api/ban/:maBan/hoadon) */}
      {activeInvoice && (
        <div className="p-3 rounded-xl bg-orange-50 border border-orange-200 space-y-2 text-xs">
          <div className="flex items-center justify-between font-bold text-orange-950">
            <span>🧾 Hóa đơn đang mở: #{activeInvoice.maHoaDon}</span>
            <span className="text-sm text-orange-700">
              {formatVND(invoiceTotal)}
            </span>
          </div>

          <div className="max-h-36 overflow-y-auto divide-y divide-orange-200/60 pr-1">
            {activeInvoice.danhSachMon?.map((m) => (
              <div key={m.maCTHD} className="py-1.5 flex justify-between gap-2">
                <div>
                  <span className="font-semibold text-gray-800">
                    {m.tenMon} ({m.kichThuoc}) x{m.soLuong}
                  </span>
                  <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-white border text-gray-600">
                    {TRANG_THAI_PHA_CHE_LABEL[m.trangThaiPhaChe] ||
                      m.trangThaiPhaChe}
                  </span>
                  {m.toppings?.length > 0 && (
                    <p className="text-[11px] text-amber-800">
                      + Topping:{' '}
                      {m.toppings
                        .map((t) => `${t.tenTopping} (x${t.soLuong})`)
                        .join(', ')}
                    </p>
                  )}
                  {m.ghiChu && (
                    <p className="text-[11px] text-gray-500 italic">
                      Ghi chú: {m.ghiChu}
                    </p>
                  )}
                </div>
                <span className="font-bold text-gray-800 shrink-0">
                  {formatVND(m.thanhTien)}
                </span>
              </div>
            ))}
          </div>

          {/* Khu vực Thanh toán hóa đơn đang mở */}
          <div className="pt-2 border-t border-orange-200 space-y-2">
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { id: 'TIEN_MAT', label: '💵 Tiền mặt' },
                { id: 'CHUYEN_KHOAN', label: '🏦 Chuyển khoản' },
                { id: 'THE', label: '💳 Thẻ' },
              ].map((pt) => (
                <button
                  type="button"
                  key={pt.id}
                  onClick={() => setPhuongThucTT(pt.id)}
                  className={`py-1.5 rounded-lg font-bold text-[11px] border cursor-pointer ${
                    phuongThucTT === pt.id
                      ? 'bg-orange-700 text-white border-orange-700'
                      : 'bg-white text-gray-700 border-gray-300'
                  }`}
                >
                  {pt.label}
                </button>
              ))}
            </div>

            {phuongThucTT === 'TIEN_MAT' && (
              <div className="flex items-center justify-between gap-2">
                <input
                  type="number"
                  value={tienKhachDua}
                  onChange={(e) => setTienKhachDua(e.target.value)}
                  placeholder="Tiền khách đưa (VND)..."
                  className="flex-1 px-2.5 py-1.5 bg-white border rounded-lg text-xs"
                />
                {tienThuaDuKien !== null && (
                  <span
                    className={`font-bold text-xs ${
                      tienThuaDuKien >= 0 ? 'text-emerald-700' : 'text-red-600'
                    }`}
                  >
                    Thừa: {formatVND(Math.max(0, tienThuaDuKien))}
                  </span>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onPrintInvoice(activeInvoice)}
                className="px-3 py-2 bg-white hover:bg-gray-100 text-gray-800 border border-gray-300 rounded-xl font-bold text-xs cursor-pointer"
              >
                🖨️ In Bill
              </button>
              <button
                type="button"
                disabled={paying}
                onClick={() =>
                  onPayInvoice({
                    maHoaDon: activeInvoice.maHoaDon,
                    phuongThucTT,
                    tienKhachDua:
                      phuongThucTT === 'TIEN_MAT' && tienKhachDua !== ''
                        ? Number(tienKhachDua)
                        : undefined,
                  })
                }
                className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-xl font-bold text-xs shadow cursor-pointer"
              >
                {paying
                  ? 'Đang thanh toán...'
                  : `Thanh toán & Trả bàn (${formatVND(invoiceTotal)})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Danh sách món mới trong giỏ */}
      <div className="flex-1 overflow-y-auto space-y-2 pr-1 max-h-[280px]">
        {cart.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-xs">
            Chọn món bên trái để thêm vào order mới
          </div>
        ) : (
          cart.map((item, idx) => (
            <div
              key={item.cartKey || idx}
              className="p-2.5 rounded-xl bg-stone-50 border border-gray-200 space-y-1.5 text-xs"
            >
              <div className="flex justify-between items-start">
                <div>
                  <span className="font-bold text-gray-800">
                    {item.tenMon}{' '}
                    <span className="text-amber-700 font-extrabold">
                      (Size {item.kichThuoc})
                    </span>
                  </span>
                  {item.toppings?.length > 0 && (
                    <p className="text-[11px] text-amber-800">
                      +{' '}
                      {item.toppings
                        .map((t) => `${t.tenTopping} x${t.soLuong}`)
                        .join(', ')}
                    </p>
                  )}
                </div>
                <span className="font-extrabold text-gray-800">
                  {formatVND(calcCartItemTotal(item))}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <input
                  type="text"
                  value={item.ghiChu || ''}
                  onChange={(e) => onUpdateNote(idx, e.target.value)}
                  placeholder="Ghi chú món..."
                  className="flex-1 px-2 py-1 bg-white border border-gray-200 rounded-lg text-[11px]"
                />
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => onUpdateQty(idx, item.soLuong - 1)}
                    className="w-6 h-6 rounded bg-white border font-bold"
                  >
                    -
                  </button>
                  <span className="w-5 text-center font-bold">
                    {item.soLuong}
                  </span>
                  <button
                    onClick={() => onUpdateQty(idx, item.soLuong + 1)}
                    className="w-6 h-6 rounded bg-amber-700 text-white font-bold"
                  >
                    +
                  </button>
                  <button
                    onClick={() => onRemoveItem(idx)}
                    className="text-red-500 font-bold ml-1"
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer gửi Order */}
      <div className="border-t pt-3 space-y-2">
        <div className="flex justify-between items-center">
          <span className="text-xs font-bold text-gray-600">
            Tạm tính món mới ({cart.reduce((s, i) => s + i.soLuong, 0)} ly):
          </span>
          <span className="text-lg font-extrabold text-amber-700">
            {formatVND(cartTotal)}
          </span>
        </div>

        <button
          onClick={onSubmitOrder}
          disabled={submitting || cart.length === 0}
          className="w-full py-3 rounded-xl bg-amber-700 hover:bg-amber-800 disabled:bg-gray-300 text-white font-bold text-sm shadow-md transition cursor-pointer"
        >
          {submitting
            ? 'Đang xử lý & trừ kho...'
            : activeInvoice
            ? '➕ Gọi thêm món vào Bàn này'
            : '🚀 Xác nhận Order & Chuyển Pha chế'}
        </button>
      </div>
    </div>
  )
}