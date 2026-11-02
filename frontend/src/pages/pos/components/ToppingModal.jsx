import { useState, useEffect } from 'react'
import SizePicker from './SizePicker'
import { formatVND } from '../../../utils/format'

const QUICK_NOTES = ['Ít đá', 'Không đá', 'Ít ngọt', 'Nhiều sữa', 'Đá riêng']

export default function ToppingModal({
  product,
  availableToppings = [],
  isOpen,
  onClose,
  onConfirm,
}) {
  const [selectedSize, setSelectedSize] = useState(null)
  const [soLuong, setSoLuong] = useState(1)
  const [ghiChu, setGhiChu] = useState('')
  const [selectedToppings, setSelectedToppings] = useState({}) // { maTopping: soLuongPerCup }

  useEffect(() => {
    if (product) {
      setSelectedSize(product.sizes?.[0] || { kichThuoc: 'S', giaBan: 0 })
      setSoLuong(1)
      setGhiChu('')
      setSelectedToppings({})
    }
  }, [product])

  if (!isOpen || !product) return null

  const toggleTopping = (tp) => {
    setSelectedToppings((prev) => {
      const next = { ...prev }
      if (next[tp.maTopping]) {
        delete next[tp.maTopping]
      } else {
        next[tp.maTopping] = 1
      }
      return next
    })
  }

  const changeToppingQty = (maTopping, delta) => {
    setSelectedToppings((prev) => {
      const nextQty = (prev[maTopping] || 1) + delta
      if (nextQty <= 0) {
        const copy = { ...prev }
        delete copy[maTopping]
        return copy
      }
      return { ...prev, [maTopping]: nextQty }
    })
  }

  const toppingsArray = Object.entries(selectedToppings).map(([maTopping, sl]) => {
    const info = availableToppings.find((t) => t.maTopping === maTopping)
    return {
      maTopping,
      tenTopping: info?.tenTopping || maTopping,
      donGia: Number(info?.giaTopping || 0),
      soLuong: sl,
    }
  })

  const toppingCostPerCup = toppingsArray.reduce(
    (sum, t) => sum + t.donGia * t.soLuong,
    0
  )
  const unitPrice = Number(selectedSize?.giaBan || 0) + toppingCostPerCup
  const lineTotal = unitPrice * soLuong

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!selectedSize) return
    onConfirm({
      maMon: product.maMon,
      tenMon: product.tenMon,
      kichThuoc: selectedSize.kichThuoc,
      donGia: Number(selectedSize.giaBan),
      soLuong: Number(soLuong),
      ghiChu: ghiChu.trim(),
      toppings: toppingsArray,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b pb-3">
          <div>
            <h3 className="text-lg font-extrabold text-gray-800">
              {product.tenMon}
            </h3>
            <p className="text-xs text-gray-500">
              Mã món: {product.maMon} • Nhóm: {product.nhomMon}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 font-bold text-gray-600 cursor-pointer"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <SizePicker
            sizes={product.sizes || []}
            selectedSize={selectedSize}
            onSelectSize={setSelectedSize}
          />

          {/* Danh sách Topping từ /api/topping */}
          <div className="space-y-2">
            <label className="block text-xs font-bold uppercase text-gray-600">
              Chọn Topping kèm theo (trên mỗi ly)
            </label>
            {availableToppings.length === 0 ? (
              <p className="text-xs text-gray-400 italic">
                Không có topping đang kinh doanh
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-40 overflow-y-auto pr-1">
                {availableToppings.map((tp) => {
                  const qty = selectedToppings[tp.maTopping] || 0
                  return (
                    <div
                      key={tp.maTopping}
                      onClick={() => toggleTopping(tp)}
                      className={`p-2.5 rounded-xl border flex items-center justify-between cursor-pointer transition ${
                        qty > 0
                          ? 'border-amber-600 bg-amber-50/70'
                          : 'border-gray-200 hover: bg-gray-50'
                      }`}
                    >
                      <div className="text-xs">
                        <p className="font-bold text-gray-800">{tp.tenTopping}</p>
                        <p className="text-amber-700 font-semibold">
                          +{formatVND(tp.giaTopping)}
                        </p>
                      </div>
                      {qty > 0 && (
                        <div
                          className="flex items-center gap-1.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() => changeToppingQty(tp.maTopping, -1)}
                            className="w-6 h-6 rounded bg-white border font-bold text-xs"
                          >
                            -
                          </button>
                          <span className="text-xs font-bold w-4 text-center">
                            {qty}
                          </span>
                          <button
                            type="button"
                            onClick={() => changeToppingQty(tp.maTopping, 1)}
                            className="w-6 h-6 rounded bg-amber-700 text-white font-bold text-xs"
                          >
                            +
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Số lượng ly */}
          <div className="flex items-center justify-between bg-stone-100 p-3 rounded-xl">
            <span className="text-xs font-bold uppercase text-gray-700">
              Số lượng ly:
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setSoLuong((q) => Math.max(1, q - 1))}
                className="w-9 h-9 rounded-xl bg-white border border-gray-300 font-bold text-base cursor-pointer"
              >
                -
              </button>
              <span className="w-8 text-center font-extrabold text-base">
                {soLuong}
              </span>
              <button
                type="button"
                onClick={() => setSoLuong((q) => q + 1)}
                className="w-9 h-9 rounded-xl bg-amber-700 text-white font-bold text-base cursor-pointer"
              >
                +
              </button>
            </div>
          </div>

          {/* Ghi chú từng món */}
          <div>
            <label className="block text-xs font-bold uppercase text-gray-600 mb-1.5">
              Ghi chú pha chế
            </label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {QUICK_NOTES.map((note) => (
                <button
                  type="button"
                  key={note}
                  onClick={() =>
                    setGhiChu((prev) => (prev ? `${prev}, ${note}` : note))
                  }
                  className="px-2.5 py-1 text-xs bg-amber-50 hover:bg-amber-100 text-amber-900 rounded-lg border border-amber-200 cursor-pointer"
                >
                  + {note}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={ghiChu}
              onChange={(e) => setGhiChu(e.target.value)}
              placeholder="Nhập ghi chú riêng cho món này..."
              className="w-full px-3.5 py-2 rounded-xl border border-gray-300 text-xs outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 rounded-xl border border-gray-300 font-bold text-xs text-gray-700 cursor-pointer"
            >
              Đóng
            </button>
            <button
              type="submit"
              className="flex-2 py-3 px-4 rounded-xl bg-amber-700 hover:bg-amber-800 text-white font-bold text-xs shadow-md cursor-pointer"
            >
              Thêm vào giỏ • {formatVND(lineTotal)}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}