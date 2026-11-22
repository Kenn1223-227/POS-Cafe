import { useState, useMemo } from 'react'
import SizePicker from './SizePicker'
import { formatVND } from '../../../utils/format'

const ICE_OPTIONS = ['100% Đá', '70% Đá', '50% Đá', '30% Đá', 'Không đá', 'Đá riêng']
const SUGAR_OPTIONS = ['100% Đường', '70% Đường', '50% Đường', '30% Đường', 'Không đường']
const EXTRA_NOTES = ['Nhiều sữa', 'Ít sữa', 'Nóng', 'Ít trà', 'Đậm trà']

function calcTieredToppingPrice(tp, soLuongMoiLy) {
  const qty = Math.max(1, Number(soLuongMoiLy || 1))
  const base = Number(tp?.giaTopping || 0)
  const tiers = Array.isArray(tp?.giaBacThang)
    ? [...tp.giaBacThang].sort((a, b) => Number(a.tu || 1) - Number(b.tu || 1))
    : []
  if (tiers.length === 0) return base * qty
  let sum = 0
  for (let u = 1; u <= qty; u += 1) {
    let p = base
    for (const t of tiers) {
      if (u >= Number(t.tu || 1)) p = Number(t.gia ?? base)
      else break
    }
    sum += p
  }
  return sum
}

export default function ToppingModal({
  product,
  initialCartItem = null,
  availableToppings = [],
  isOpen,
  onClose,
  onConfirm,
}) {
  const [selectedSize, setSelectedSize] = useState(() => {
    if (initialCartItem) {
      return (
        product?.sizes?.find((s) => s.kichThuoc === initialCartItem.kichThuoc) ||
        product?.sizes?.[0] || { kichThuoc: initialCartItem.kichThuoc || 'M', giaBan: initialCartItem.donGia || 0 }
      )
    }
    return product?.sizes?.find((s) => s.kichThuoc === 'M') || product?.sizes?.[0] || { kichThuoc: 'M', giaBan: 0 }
  })
  const [soLuong, setSoLuong] = useState(() => Number(initialCartItem?.soLuong || 1))
  const [iceLevel, setIceLevel] = useState('100% Đá')
  const [sugarLevel, setSugarLevel] = useState('100% Đường')
  const [ghiChuThem, setGhiChuThem] = useState(() => initialCartItem?.ghiChu || '')
  const [isTakeaway, setIsTakeaway] = useState(() => Boolean(initialCartItem?.isTakeaway))
  const [holdCourse2, setHoldCourse2] = useState(() => initialCartItem?.fireStatus === 'HELD')
  const [selectedToppings, setSelectedToppings] = useState(() => {
    const map = {}
    for (const t of initialCartItem?.toppings || []) {
      map[t.maTopping] = Number(t.soLuongMoiLy ?? t.soLuong ?? 1)
    }
    return map
  })

  // Structured Modifiers state: { [groupId]: { [optionId]: qty } }
  const modifierGroups = useMemo(() => product?.modifierGroups || [], [product?.modifierGroups])
  const [selectedMods, setSelectedMods] = useState(() => {
    const init = {}
    if (initialCartItem?.modifiers?.length) {
      for (const m of initialCartItem.modifiers) {
        if (!init[m.groupId]) init[m.groupId] = {}
        init[m.groupId][m.optionId] = Number(m.qty || 1)
      }
      return init
    }
    // Smart Defaults: tự điền sẵn các tùy chọn mặc định
    for (const grp of product?.modifierGroups || []) {
      const defaults = (grp.options || []).filter((o) => o.laMacDinh && !o.tamHet)
      if (defaults.length > 0) {
        init[grp.id] = {}
        const take = grp.loai === 'SINGLE' ? defaults.slice(0, 1) : defaults.slice(0, grp.chonToiDa || 1)
        for (const opt of take) init[grp.id][opt.id] = 1
      }
    }
    return init
  })

  if (!isOpen || !product) return null

  const toggleModifierOption = (grp, opt) => {
    if (opt.tamHet) return
    setSelectedMods((prev) => {
      const grpSel = { ...(prev[grp.id] || {}) }
      if (grp.loai === 'SINGLE') {
        if (grpSel[opt.id] && !grp.batBuoc) {
          delete grpSel[opt.id]
        } else {
          return { ...prev, [grp.id]: { [opt.id]: 1 } }
        }
      } else {
        const curQty = grpSel[opt.id] || 0
        const totalInGrp = Object.values(grpSel).reduce((s, q) => s + q, 0)
        if (curQty > 0) {
          delete grpSel[opt.id]
        } else if (totalInGrp < Number(grp.chonToiDa || 99)) {
          grpSel[opt.id] = 1
        }
      }
      return { ...prev, [grp.id]: grpSel }
    })
  }

  const toggleTopping = (tp) => {
    if (tp.tamHet) return
    setSelectedToppings((prev) => {
      const next = { ...prev }
      if (next[tp.maTopping]) delete next[tp.maTopping]
      else next[tp.maTopping] = 1
      return next
    })
  }

  const changeToppingQty = (tp, delta) => {
    const maxPerCup = Math.max(1, Number(tp.toiDaMoiLy || 3))
    setSelectedToppings((prev) => {
      const nextQty = (prev[tp.maTopping] || 1) + delta
      if (nextQty <= 0) {
        const copy = { ...prev }
        delete copy[tp.maTopping]
        return copy
      }
      return { ...prev, [tp.maTopping]: Math.min(maxPerCup, nextQty) }
    })
  }

  // Tính giá Modifiers (có hỗ trợ soluongmienphi — miễn phí K lựa chọn đầu theo giá ASC)
  const { modifiersArray, modifiersCostPerCup, missingRequiredGroup } = (() => {
    const list = []
    let totalCost = 0
    let missingGroup = null

    for (const grp of modifierGroups) {
      const grpSel = selectedMods[grp.id] || {}
      const entries = Object.entries(grpSel)
        .map(([oid, qty]) => {
          const opt = (grp.options || []).find((o) => Number(o.id) === Number(oid))
          return opt ? { opt, qty: Number(qty || 1) } : null
        })
        .filter(Boolean)

      const count = entries.reduce((s, e) => s + e.qty, 0)
      const minReq = grp.batBuoc ? Math.max(1, Number(grp.chonToiThieu || 1)) : Number(grp.chonToiThieu || 0)
      if (count < minReq && !missingGroup) {
        missingGroup = grp.tenGroup
      }

      const units = []
      for (const e of entries) {
        for (let i = 0; i < e.qty; i += 1) {
          units.push({ id: e.opt.id, gia: Number(e.opt.giaCongThem || 0) })
        }
      }
      units.sort((a, b) => a.gia - b.gia)
      let freeLeft = Math.max(0, Number(grp.soLuongMienPhi || 0))
      const freeById = {}
      for (const u of units) {
        if (freeLeft > 0 && u.gia > 0) {
          freeById[u.id] = (freeById[u.id] || 0) + 1
          freeLeft -= 1
        }
      }

      for (const { opt, qty } of entries) {
        const freeQty = freeById[opt.id] || 0
        const billedQty = Math.max(0, qty - freeQty)
        totalCost += Number(opt.giaCongThem || 0) * billedQty
        list.push({
          groupId: grp.id,
          tenGroup: grp.tenGroup,
          optionId: opt.id,
          tenOption: opt.tenOption,
          tenInNgan: opt.tenInNgan || opt.tenOption,
          qty,
          freeQty,
          giaCongThem: Number(opt.giaCongThem || 0),
        })
      }
    }
    return { modifiersArray: list, modifiersCostPerCup: totalCost, missingRequiredGroup: missingGroup }
  })()

  const toppingsArray = Object.entries(selectedToppings).map(([maTopping, sl]) => {
    const info = availableToppings.find((t) => t.maTopping === maTopping)
    const tieredTotal = calcTieredToppingPrice(info, sl)
    return {
      maTopping,
      tenTopping: info?.tenTopping || maTopping,
      donGia: Math.round((tieredTotal / sl) * 100) / 100,
      soLuongMoiLy: sl,
      soLuong: sl,
    }
  })

  const toppingCostPerCup = toppingsArray.reduce((sum, t) => sum + t.donGia * t.soLuongMoiLy, 0)
  const unitPrice = Number(selectedSize?.giaBan || 0) + modifiersCostPerCup + toppingCostPerCup
  const lineTotal = unitPrice * soLuong

  const buildStructuredNote = () => {
    if (modifierGroups.length > 0) return ghiChuThem.trim()
    const parts = []
    if (iceLevel !== '100% Đá') parts.push(iceLevel)
    if (sugarLevel !== '100% Đường') parts.push(sugarLevel)
    if (ghiChuThem.trim()) parts.push(ghiChuThem.trim())
    return parts.join(' • ')
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!selectedSize || missingRequiredGroup) return
    onConfirm({
      maMon: product.maMon,
      tenMon: product.tenMon,
      kichThuoc: selectedSize.kichThuoc,
      donGia: Number(selectedSize.giaBan),
      giaModifiers: modifiersCostPerCup,
      modifiers: modifiersArray,
      soLuong: Number(soLuong),
      ghiChu: buildStructuredNote(),
      isTakeaway,
      courseNo: holdCourse2 ? 2 : 1,
      fireStatus: holdCourse2 ? 'HELD' : 'FIRED',
      toppings: toppingsArray,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full p-5 shadow-2xl space-y-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b pb-3">
          <div>
            <h3 className="text-lg font-extrabold text-gray-800">
              {initialCartItem ? `⚙️ Tùy chỉnh: ${product.tenMon}` : product.tenMon}
            </h3>
            <p className="text-xs text-gray-500">
              Mã: {product.maMon} • Nhóm: {product.nhomMon}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-11 h-11 rounded-full bg-gray-100 hover:bg-gray-200 font-bold text-gray-700 cursor-pointer"
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

          {/* Structured Modifiers từ DB (Forced Modifiers + Smart Defaults + Free K + 86'ing) */}
          {modifierGroups.length > 0 ? (
            <div className="space-y-3">
              {modifierGroups.map((grp) => {
                const grpSel = selectedMods[grp.id] || {}
                return (
                  <div key={grp.id} className="space-y-1.5">
                    <label className="flex items-center justify-between text-xs font-bold uppercase text-gray-700">
                      <span>
                        🎛️ {grp.tenGroup}{' '}
                        {grp.batBuoc && (
                          <span className="ml-1 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px]">
                            BẮT BUỘC
                          </span>
                        )}
                      </span>
                      <span className="text-[11px] font-normal text-gray-500 normal-case">
                        {grp.loai === 'SINGLE' ? 'Chọn 1' : `Tối đa ${grp.chonToiDa}`}
                        {grp.soLuongMienPhi > 0 ? ` • Miễn phí ${grp.soLuongMienPhi} đầu` : ''}
                      </span>
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {(grp.options || []).map((opt) => {
                        const active = Boolean(grpSel[opt.id])
                        const isOut = Boolean(opt.tamHet)
                        return (
                          <button
                            type="button"
                            key={opt.id}
                            disabled={isOut}
                            onClick={() => toggleModifierOption(grp, opt)}
                            className={`min-h-11 px-2.5 py-2 rounded-xl text-xs font-bold border text-left transition ${
                              isOut
                                ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed line-through'
                                : active
                                ? 'bg-amber-700 text-white border-amber-700 shadow-sm cursor-pointer'
                                : 'bg-stone-50 text-gray-700 border-gray-200 hover:bg-amber-50 cursor-pointer'
                            }`}
                          >
                            <div className="truncate">{opt.tenOption}</div>
                            {Number(opt.giaCongThem) > 0 && (
                              <div className={`text-[10px] ${active ? 'text-amber-200' : 'text-amber-700'}`}>
                                +{formatVND(opt.giaCongThem)}
                              </div>
                            )}
                            {isOut && <div className="text-[9px] text-red-600 font-extrabold no-underline">HẾT (86)</div>}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <>
              {/* Fallback Mức Đá */}
              <div className="space-y-1.5">
                <label className="block text-xs font-bold uppercase text-gray-600">
                  🧊 Mức đá <span className="text-gray-400 font-normal">(Mặc định 100%)</span>
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {ICE_OPTIONS.map((opt) => (
                    <button
                      type="button"
                      key={opt}
                      onClick={() => setIceLevel(opt)}
                      className={`min-h-11 px-2 py-2 rounded-xl text-xs font-bold border transition cursor-pointer ${
                        iceLevel === opt
                          ? 'bg-sky-700 text-white border-sky-700 shadow-sm'
                          : 'bg-sky-50/50 text-gray-700 border-gray-200 hover:bg-sky-50'
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              {/* Fallback Mức Đường */}
              <div className="space-y-1.5">
                <label className="block text-xs font-bold uppercase text-gray-600">
                  🍯 Mức đường <span className="text-gray-400 font-normal">(Mặc định 100%)</span>
                </label>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                  {SUGAR_OPTIONS.map((opt) => (
                    <button
                      type="button"
                      key={opt}
                      onClick={() => setSugarLevel(opt)}
                      className={`min-h-11 px-2 py-2 rounded-xl text-xs font-bold border transition cursor-pointer ${
                        sugarLevel === opt
                          ? 'bg-amber-700 text-white border-amber-700 shadow-sm'
                          : 'bg-amber-50/40 text-gray-700 border-gray-200 hover:bg-amber-50'
                      }`}
                    >
                      {opt.replace(' Đường', '')}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Danh sách Topping (Topping-per-Cup + Giá bậc thang + Giới hạn tối đa/ly) */}
          <div className="space-y-2">
            <label className="block text-xs font-bold uppercase text-gray-600">
              🧋 Topping kèm theo (định lượng trên mỗi ly)
            </label>
            {availableToppings.length === 0 ? (
              <p className="text-xs text-gray-400 italic">Không có topping đang kinh doanh</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-40 overflow-y-auto pr-1">
                {availableToppings.map((tp) => {
                  const qty = selectedToppings[tp.maTopping] || 0
                  const isOut = Boolean(tp.tamHet)
                  const maxPerCup = Number(tp.toiDaMoiLy || 3)
                  return (
                    <div
                      key={tp.maTopping}
                      onClick={() => toggleTopping(tp)}
                      className={`p-2.5 min-h-12 rounded-xl border flex items-center justify-between transition ${
                        isOut
                          ? 'border-gray-200 bg-gray-100 opacity-55 cursor-not-allowed'
                          : qty > 0
                          ? 'border-amber-600 bg-amber-50/80 cursor-pointer'
                          : 'border-gray-200 hover:bg-gray-50 cursor-pointer'
                      }`}
                    >
                      <div className="text-xs">
                        <p className="font-bold text-gray-800">
                          {tp.tenTopping}{' '}
                          {isOut && (
                            <span className="ml-1 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-extrabold">
                              TẠM HẾT
                            </span>
                          )}
                        </p>
                        <p className="text-amber-700 font-semibold">
                          +{formatVND(tp.giaTopping)}{' '}
                          <span className="text-[10px] text-gray-400 font-normal">(tối đa {maxPerCup}/ly)</span>
                        </p>
                      </div>
                      {qty > 0 && (
                        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => changeToppingQty(tp, -1)}
                            className="w-9 h-9 rounded-lg bg-white border font-bold text-sm cursor-pointer"
                          >
                            -
                          </button>
                          <span className="text-xs font-bold w-5 text-center">{qty}</span>
                          <button
                            type="button"
                            disabled={qty >= maxPerCup}
                            onClick={() => changeToppingQty(tp, 1)}
                            className="w-9 h-9 rounded-lg bg-amber-700 disabled:bg-gray-300 text-white font-bold text-sm cursor-pointer"
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

          {/* Tùy chọn Ly Mang Về & Hẹn giờ ra món (Course Firing) */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setIsTakeaway((v) => !v)}
              className={`min-h-11 px-3 py-2 rounded-xl border text-xs font-extrabold cursor-pointer transition ${
                isTakeaway
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-indigo-50 text-indigo-900 border-indigo-200'
              }`}
            >
              {isTakeaway ? '🛍️ ĐÓNG GÓI MANG VỀ' : '🪑 Uống tại quán'}
            </button>
            <button
              type="button"
              onClick={() => setHoldCourse2((v) => !v)}
              className={`min-h-11 px-3 py-2 rounded-xl border text-xs font-extrabold cursor-pointer transition ${
                holdCourse2
                  ? 'bg-orange-600 text-white border-orange-600'
                  : 'bg-orange-50 text-orange-900 border-orange-200'
              }`}
            >
              {holdCourse2 ? '⏸️ Course 2 (Chờ báo bếp)' : '🔥 Ra ngay (Course 1)'}
            </button>
          </div>

          {/* Số lượng ly */}
          <div className="flex items-center justify-between bg-stone-100 p-3 rounded-xl">
            <span className="text-xs font-bold uppercase text-gray-700">Số lượng ly:</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setSoLuong((q) => Math.max(1, q - 1))}
                className="w-12 h-12 rounded-xl bg-white border border-gray-300 font-extrabold text-lg cursor-pointer"
              >
                -
              </button>
              <span className="w-8 text-center font-extrabold text-lg">{soLuong}</span>
              <button
                type="button"
                onClick={() => setSoLuong((q) => q + 1)}
                className="w-12 h-12 rounded-xl bg-amber-700 text-white font-extrabold text-lg cursor-pointer"
              >
                +
              </button>
            </div>
          </div>

          {/* Ghi chú thêm */}
          <div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {EXTRA_NOTES.map((note) => (
                <button
                  type="button"
                  key={note}
                  onClick={() =>
                    setGhiChuThem((prev) =>
                      prev.includes(note) ? prev : prev ? `${prev}, ${note}` : note
                    )
                  }
                  className="px-3 py-1.5 text-xs bg-stone-100 hover:bg-stone-200 text-stone-800 rounded-lg font-medium cursor-pointer"
                >
                  + {note}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={ghiChuThem}
              onChange={(e) => setGhiChuThem(e.target.value)}
              placeholder="Ghi chú riêng thêm (VD: ít bọt, ly giấy...)"
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-300 text-xs outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>

          {missingRequiredGroup && (
            <p className="text-xs font-bold text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
              ⚠️ Vui lòng chọn đầy đủ tùy chọn bắt buộc cho nhóm "{missingRequiredGroup}"!
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 min-h-12 rounded-xl border border-gray-300 font-bold text-xs text-gray-700 cursor-pointer"
            >
              Đóng (ESC)
            </button>
            <button
              type="submit"
              disabled={Boolean(missingRequiredGroup)}
              className="flex-2 min-h-12 px-4 rounded-xl bg-amber-700 hover:bg-amber-800 disabled:bg-gray-300 text-white font-extrabold text-sm shadow-md cursor-pointer"
            >
              {initialCartItem ? 'Lưu tùy chỉnh' : 'Thêm vào giỏ'} • {formatVND(lineTotal)}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
