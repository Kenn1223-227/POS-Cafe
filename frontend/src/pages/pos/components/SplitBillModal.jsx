import { useState, memo } from 'react'
import { formatVND } from '../../../utils/format'

function previewEqualSplit(conLai, soNguoi) {
  const n = Math.floor(Number(soNguoi || 0))
  const total = Math.round(Number(conLai || 0))
  if (n < 2 || total <= 0) return []
  if (total >= n * 1000) {
    const base = Math.floor(total / n / 1000) * 1000
    let rem = total - base * n
    const shares = new Array(n).fill(base)
    let idx = 0
    while (rem >= 1000) {
      shares[idx % n] += 1000
      rem -= 1000
      idx += 1
    }
    if (rem > 0) shares[0] += rem
    return shares
  }
  const base = Math.floor(total / n)
  const rem = total - base * n
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0))
}

const SplitBillModal = memo(function SplitBillModal({
  isOpen,
  activeInvoice,
  tables,
  splitQtyMap,
  onChangeSplitQtyMap,
  splitDestTable,
  onChangeSplitDestTable,
  splitSubmitting,
  onClose,
  onConfirm,
  onConfirmSplitEqual,
  onConfirmSplitAmount,
}) {
  const [tab, setTab] = useState('BY_ITEM') // 'BY_ITEM' | 'SPLIT_EQUAL' | 'SPLIT_AMOUNT'
  const [soNguoi, setSoNguoi] = useState(2)
  const [customShares, setCustomShares] = useState([
    { nhan: 'Khách 1', soTien: '' },
    { nhan: 'Khách 2', soTien: '' },
  ])

  if (!isOpen || !activeInvoice) return null

  const totalSelectedCups = Object.values(splitQtyMap).reduce((s, q) => s + Number(q || 0), 0)
  const conLai = Math.round(Number(activeInvoice.conLaiCanThu ?? activeInvoice.tongPhaiTra ?? activeInvoice.tongTamTinh ?? 0))
  const equalPreview = previewEqualSplit(conLai, soNguoi)
  const customSum = customShares.reduce((s, x) => s + Math.round(Number(x.soTien || 0)), 0)
  const customDiff = conLai - customSum

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="font-extrabold text-base text-purple-900">
            ✂️ Tách / Chia Hóa Đơn #{activeInvoice.maHoaDon}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="min-w-[44px] min-h-[44px] rounded-full bg-gray-100 font-bold cursor-pointer"
          >
            ✕ [ESC]
          </button>
        </div>

        {/* 3 kiểu tách bill chuẩn F&B */}
        <div className="grid grid-cols-3 gap-1.5 bg-gray-100 p-1 rounded-xl text-xs font-bold">
          <button
            type="button"
            onClick={() => setTab('BY_ITEM')}
            className={`py-2 px-2 rounded-lg cursor-pointer transition ${
              tab === 'BY_ITEM' ? 'bg-purple-600 text-white shadow-xs' : 'text-gray-700 hover:bg-white'
            }`}
          >
            ✂️ Theo món
          </button>
          <button
            type="button"
            onClick={() => setTab('SPLIT_EQUAL')}
            className={`py-2 px-2 rounded-lg cursor-pointer transition ${
              tab === 'SPLIT_EQUAL' ? 'bg-purple-600 text-white shadow-xs' : 'text-gray-700 hover:bg-white'
            }`}
          >
            ➗ Chia đều N
          </button>
          <button
            type="button"
            onClick={() => setTab('SPLIT_AMOUNT')}
            className={`py-2 px-2 rounded-lg cursor-pointer transition ${
              tab === 'SPLIT_AMOUNT' ? 'bg-purple-600 text-white shadow-xs' : 'text-gray-700 hover:bg-white'
            }`}
          >
            💵 Số tiền tùy ý
          </button>
        </div>

        {tab === 'BY_ITEM' && (
          <form onSubmit={onConfirm} className="space-y-3 text-xs">
            <p className="text-gray-500">
              Chọn món và số lượng ly muốn tách (giữ nguyên định lượng topping/ly, không làm hỏng báo cáo kho):
            </p>
            <div className="max-h-56 overflow-y-auto divide-y border rounded-xl p-2">
              {(activeInvoice.danhSachMon || [])
                .filter((m) => !m.daHuy && m.trangThaiPhaChe !== 'DaHuy')
                .map((m) => {
                  const maxQty = Number(m.soLuong || 1)
                  const selectedQty = Number(splitQtyMap[m.maCTHD] || 0)
                  const checked = selectedQty > 0
                  const unitAmount = maxQty > 0 ? Math.round(Number(m.thanhTien || 0) / maxQty) : 0
                  return (
                    <div
                      key={m.maCTHD}
                      className={`flex items-center justify-between gap-2 py-2 px-1.5 rounded-lg ${
                        checked ? 'bg-purple-50/80' : 'hover:bg-gray-50'
                      }`}
                    >
                      <label className="flex items-center gap-2 font-semibold text-gray-800 cursor-pointer flex-1 min-w-0">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            onChangeSplitQtyMap((prev) => {
                              const next = { ...prev }
                              if (checked) delete next[m.maCTHD]
                              else next[m.maCTHD] = maxQty > 1 ? 1 : maxQty
                              return next
                            })
                          }
                          className="w-5 h-5 accent-purple-600 shrink-0"
                        />
                        <span className="truncate">
                          {m.tenMon} ({m.kichThuoc}) <b className="text-purple-800">x{maxQty}</b>
                        </span>
                      </label>

                      <div className="flex items-center gap-2 shrink-0">
                        {checked && maxQty > 1 && (
                          <div className="inline-flex items-center border border-purple-300 bg-white rounded-lg overflow-hidden">
                            <button
                              type="button"
                              onClick={() =>
                                onChangeSplitQtyMap((prev) => ({
                                  ...prev,
                                  [m.maCTHD]: Math.max(1, selectedQty - 1),
                                }))
                              }
                              className="px-2.5 py-1 font-extrabold text-purple-800 hover:bg-purple-100 cursor-pointer"
                            >
                              −
                            </button>
                            <span className="px-2 py-1 font-extrabold text-purple-950">
                              {selectedQty}/{maxQty} ly
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                onChangeSplitQtyMap((prev) => ({
                                  ...prev,
                                  [m.maCTHD]: Math.min(maxQty, selectedQty + 1),
                                }))
                              }
                              className="px-2.5 py-1 font-extrabold text-purple-800 hover:bg-purple-100 cursor-pointer"
                            >
                              +
                            </button>
                          </div>
                        )}
                        <span className="font-bold text-gray-700">
                          {checked && selectedQty < maxQty
                            ? formatVND(unitAmount * selectedQty)
                            : formatVND(m.thanhTien)}
                        </span>
                      </div>
                    </div>
                  )
                })}
            </div>

            <div>
              <label className="block font-bold text-gray-600 mb-1">Chuyển các món đã chọn sang:</label>
              <select
                value={splitDestTable}
                onChange={(e) => onChangeSplitDestTable(e.target.value)}
                className="w-full min-h-[48px] px-3 border rounded-xl bg-white font-semibold"
              >
                <option value="">🛍️ Đơn tách thanh toán ngay (Mang đi / Quầy)</option>
                <optgroup label="🪑 Bàn trống — Mở hóa đơn mới">
                  {tables
                    .filter((b) => Number(b.trangThai) !== 2)
                    .map((b) => (
                      <option key={b.maBan} value={b.maBan}>
                        🪑 {b.tenBan} ({b.khuVuc})
                      </option>
                    ))}
                </optgroup>
                {tables.some((b) => Number(b.trangThai) === 2 && b.maBan !== activeInvoice.maBan) && (
                  <optgroup label="🍻 Bàn đang có khách — Chuyển ghép món sang bàn này">
                    {tables
                      .filter((b) => Number(b.trangThai) === 2 && b.maBan !== activeInvoice.maBan)
                      .map((b) => (
                        <option key={b.maBan} value={b.maBan}>
                          🍻 {b.tenBan} ({b.khuVuc}) — Đang có khách ({formatVND(b.tongTamTinh || 0)})
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
            </div>

            <div className="flex gap-2.5 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 min-h-[48px] border rounded-xl font-bold cursor-pointer"
              >
                Hủy [ESC]
              </button>
              <button
                type="submit"
                disabled={splitSubmitting || totalSelectedCups === 0}
                className="flex-1 min-h-[48px] bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-extrabold cursor-pointer disabled:bg-gray-300"
              >
                {splitSubmitting ? 'Đang xử lý...' : `✂️ Xác nhận tách (${totalSelectedCups} ly)`}
              </button>
            </div>
          </form>
        )}

        {tab === 'SPLIT_EQUAL' && (
          <div className="space-y-3 text-xs">
            <p className="text-gray-600">
              Còn phải thu: <b className="text-purple-900 text-sm">{formatVND(conLai)}</b> • Chia tròn bội số 1.000đ,
              không tách/vỡ dòng món (bảo toàn 100% kho & báo cáo).
            </p>
            <div className="flex items-center justify-between bg-purple-50 p-3 rounded-xl border border-purple-200">
              <span className="font-bold text-purple-900">Số người chia:</span>
              <div className="flex items-center gap-2">
                {[2, 3, 4, 5, 6].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setSoNguoi(n)}
                    className={`w-10 h-10 rounded-xl font-extrabold cursor-pointer ${
                      soNguoi === n ? 'bg-purple-600 text-white' : 'bg-white border border-purple-300 text-purple-900'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-stone-50 border space-y-1.5">
              <p className="font-bold text-gray-700">Dự kiến chia ({soNguoi} phần):</p>
              {equalPreview.map((amt, i) => (
                <div key={i} className="flex justify-between font-semibold">
                  <span>Phần {i + 1}/{soNguoi}</span>
                  <span className="text-purple-800 font-extrabold">{formatVND(amt)}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-2.5 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 min-h-[48px] border rounded-xl font-bold cursor-pointer"
              >
                Hủy
              </button>
              <button
                type="button"
                disabled={splitSubmitting || conLai <= 0 || !onConfirmSplitEqual}
                onClick={() => onConfirmSplitEqual?.(soNguoi)}
                className="flex-1 min-h-[48px] bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-extrabold cursor-pointer disabled:bg-gray-300"
              >
                {splitSubmitting ? 'Đang chia...' : `➗ Xác nhận chia ${soNguoi} phần`}
              </button>
            </div>
          </div>
        )}

        {tab === 'SPLIT_AMOUNT' && (
          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-gray-600">
                Tổng cần chia: <b className="text-purple-900">{formatVND(conLai)}</b>
              </span>
              <span className={`font-extrabold ${customDiff === 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                {customDiff === 0 ? '✅ Khớp tuyệt đối' : `Chênh: ${formatVND(customDiff)}`}
              </span>
            </div>
            <div className="space-y-2 max-h-52 overflow-y-auto">
              {customShares.map((sh, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={sh.nhan}
                    onChange={(e) =>
                      setCustomShares((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, nhan: e.target.value } : x))
                      )
                    }
                    className="w-28 px-2.5 py-2 border rounded-xl font-semibold"
                    placeholder={`Phần ${idx + 1}`}
                  />
                  <input
                    type="number"
                    min="0"
                    step="1000"
                    value={sh.soTien}
                    onChange={(e) =>
                      setCustomShares((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, soTien: e.target.value } : x))
                      )
                    }
                    className="flex-1 px-3 py-2 border rounded-xl font-extrabold"
                    placeholder="Nhập số tiền..."
                  />
                  {customShares.length > 2 && (
                    <button
                      type="button"
                      onClick={() => setCustomShares((prev) => prev.filter((_, i) => i !== idx))}
                      className="px-2.5 py-2 rounded-xl bg-red-50 text-red-600 font-bold cursor-pointer"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                setCustomShares((prev) => [
                  ...prev,
                  { nhan: `Khách ${prev.length + 1}`, soTien: customDiff > 0 ? String(customDiff) : '' },
                ])
              }
              className="w-full py-2 rounded-xl bg-stone-100 hover:bg-stone-200 font-bold text-stone-700 cursor-pointer"
            >
              + Thêm phần chia
            </button>
            <div className="flex gap-2.5 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 min-h-[48px] border rounded-xl font-bold cursor-pointer"
              >
                Hủy
              </button>
              <button
                type="button"
                disabled={splitSubmitting || customDiff !== 0 || !onConfirmSplitAmount}
                onClick={() =>
                  onConfirmSplitAmount?.(
                    customShares.map((s) => ({ nhan: s.nhan, soTien: Math.round(Number(s.soTien || 0)) }))
                  )
                }
                className="flex-1 min-h-[48px] bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-extrabold cursor-pointer disabled:bg-gray-300"
              >
                {splitSubmitting ? 'Đang tạo...' : '💵 Lưu bảng chia tiền'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
})

export default SplitBillModal
