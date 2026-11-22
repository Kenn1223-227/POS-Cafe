import { memo } from 'react'
import { formatVND } from '../../../utils/format'

function calcCartItemTotal(item) {
  const tpPerCup = (item.toppings || []).reduce(
    (s, t) => s + Number(t.donGia) * Number(t.soLuongMoiLy ?? t.soLuong ?? 1),
    0
  )
  const modPerCup = Number(item.giaModifiers || 0)
  return (Number(item.donGia) + modPerCup + tpPerCup) * Number(item.soLuong)
}

const CartItemList = memo(function CartItemList({
  cart,
  onUpdateQty,
  onUpdateNote,
  onSplitItem,
  onCloneItem,
  onEditItem,
  onToggleTakeaway,
  onToggleHoldCourse,
  onRemoveItem,
}) {
  return (
    <div className="flex-1 overflow-y-auto space-y-2.5 pr-1 max-h-[290px]">
      {cart.length === 0 ? (
        <div className="text-center py-7 text-gray-400 text-xs">
          Chạm thẳng thẻ món để thêm nhanh 1 chạm (Smart Default), hoặc bấm <b>⚙️ Tùy</b> để chọn Đường/Đá/Sữa/Topping
        </div>
      ) : (
        cart.map((item, idx) => (
          <div
            key={item.cartKey || idx}
            className="p-3 rounded-xl bg-stone-50 border border-gray-200 space-y-2 text-xs"
          >
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="font-bold text-gray-800 text-sm">
                    {item.tenMon}{' '}
                    <span className="text-amber-700 font-extrabold">({item.kichThuoc})</span>
                  </span>
                  {item.isTakeaway && (
                    <span className="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800 text-[10px] font-extrabold">
                      🛍️ MANG VỀ
                    </span>
                  )}
                  {item.fireStatus === 'HELD' && (
                    <span className="px-1.5 py-0.5 rounded bg-orange-100 text-orange-800 text-[10px] font-extrabold">
                      ⏸️ COURSE {item.courseNo || 2}
                    </span>
                  )}
                </div>
                {item.modifiers?.length > 0 && (
                  <p className="text-[11px] text-sky-800 font-semibold">
                    🎛️ {item.modifiers.map((m) => `${m.tenInNgan || m.tenOption}${m.qty > 1 ? ` x${m.qty}` : ''}`).join(' • ')}
                  </p>
                )}
                {item.toppings?.length > 0 && (
                  <p className="text-[11px] text-amber-800 font-medium">
                    + {item.toppings.map((t) => `${t.tenTopping} x${t.soLuongMoiLy ?? t.soLuong ?? 1}/ly`).join(', ')}
                  </p>
                )}
              </div>
              <span className="font-extrabold text-gray-900 shrink-0 text-sm">
                {formatVND(calcCartItemTotal(item))}
              </span>
            </div>

            {/* Thanh thao tác nhanh 1 chạm: Tùy chỉnh / Tách 1 / +1 giống / Mang về / Chờ ra sau */}
            <div className="flex flex-wrap items-center gap-1.5">
              {onEditItem && (
                <button
                  type="button"
                  onClick={() => onEditItem(idx, item)}
                  className="px-2.5 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-900 font-bold text-[11px] cursor-pointer"
                >
                  ⚙️ Tùy chỉnh
                </button>
              )}
              {item.soLuong >= 2 && onSplitItem && (
                <button
                  type="button"
                  onClick={() => onSplitItem(idx)}
                  className="px-2.5 py-1.5 rounded-lg bg-sky-100 hover:bg-sky-200 text-sky-900 font-bold text-[11px] cursor-pointer"
                  title="Tách 1 ly ra thành dòng riêng và mở bảng tùy chỉnh Đường/Đá/Topping"
                >
                  ✂️ Tách 1
                </button>
              )}
              {onCloneItem && (
                <button
                  type="button"
                  onClick={() => onCloneItem(idx)}
                  className="px-2.5 py-1.5 rounded-lg bg-violet-100 hover:bg-violet-200 text-violet-900 font-bold text-[11px] cursor-pointer"
                  title="Nhân bản nguyên Size + Modifiers + Toppings sang dòng mới để đổi nhanh 1 thuộc tính"
                >
                  📋 +1 giống
                </button>
              )}
              {onToggleTakeaway && (
                <button
                  type="button"
                  onClick={() => onToggleTakeaway(idx)}
                  className={`px-2 py-1.5 rounded-lg font-bold text-[11px] cursor-pointer ${
                    item.isTakeaway
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                  }`}
                  title="Đánh dấu ly mang về (tự cộng phí đóng gói & trừ vật tư ly/nắp/ống hút)"
                >
                  🛍️
                </button>
              )}
              {onToggleHoldCourse && (
                <button
                  type="button"
                  onClick={() => onToggleHoldCourse(idx)}
                  className={`px-2 py-1.5 rounded-lg font-bold text-[11px] cursor-pointer ${
                    item.fireStatus === 'HELD'
                      ? 'bg-orange-600 text-white'
                      : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                  }`}
                  title="Hẹn giờ ra món (Course 2 — chờ báo bếp)"
                >
                  ⏸️ C2
                </button>
              )}
            </div>

            <div className="flex items-center justify-between gap-2">
              <input
                type="text"
                value={item.ghiChu || ''}
                onChange={(e) => onUpdateNote(idx, e.target.value)}
                placeholder="Ghi chú (Đá / Đường...)"
                className="flex-1 min-h-[44px] px-3 py-1.5 bg-white border border-gray-200 rounded-xl text-xs"
              />
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => onUpdateQty(idx, item.soLuong - 1)}
                  className="min-w-[44px] min-h-[44px] rounded-xl bg-white border border-gray-300 font-extrabold text-base cursor-pointer active:scale-95"
                >
                  −
                </button>
                <span className="w-6 text-center font-extrabold text-sm">{item.soLuong}</span>
                <button
                  type="button"
                  onClick={() => onUpdateQty(idx, item.soLuong + 1)}
                  className="min-w-[44px] min-h-[44px] rounded-xl bg-amber-700 hover:bg-amber-800 text-white font-extrabold text-base cursor-pointer active:scale-95"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveItem(idx)}
                  className="min-w-[44px] min-h-[44px] rounded-xl bg-red-50 hover:bg-red-100 text-red-600 font-extrabold cursor-pointer active:scale-95"
                >
                  ✕
                </button>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  )
})

export default CartItemList
