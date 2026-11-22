import { useState, useMemo, useRef, memo } from 'react'
import { formatVND } from '../../../utils/format'

const MenuGrid = memo(function MenuGrid({ menu, onPickProduct, onQuickAdd, searchInputRef }) {
  const groups = useMemo(
    () => ['Tất cả', ...new Set(menu.map((m) => m.nhomMon || 'Khác'))],
    [menu]
  )
  const [activeGroup, setActiveGroup] = useState('Tất cả')
  const [search, setSearch] = useState('')
  const longPressTimerRef = useRef(null)
  const longPressedRef = useRef(false)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return menu.filter((item) => {
      const matchGroup = activeGroup === 'Tất cả' || (item.nhomMon || 'Khác') === activeGroup
      const matchSearch =
        !q ||
        item.tenMon?.toLowerCase().includes(q) ||
        item.maMon?.toLowerCase().includes(q)
      return matchGroup && matchSearch
    })
  }, [menu, activeGroup, search])

  const triggerSmartDefaultAdd = (item) => {
    const defaultSize =
      item.sizes?.find((s) => s.kichThuoc === 'M') ||
      item.sizes?.[0] || { kichThuoc: 'M', giaBan: 0 }

    // Smart Defaults: tự động điền sẵn tất cả Forced Modifiers (laMacDinh = true) để bấm 1 chạm vào giỏ không bị pop-up chặn đường!
    const defaultMods = []
    let giaModifiers = 0
    for (const grp of item.modifierGroups || []) {
      const defaults = (grp.options || []).filter((o) => o.laMacDinh && !o.tamHet)
      if (defaults.length > 0) {
        const take = grp.loai === 'SINGLE' ? defaults.slice(0, 1) : defaults.slice(0, grp.chonToiDa || 1)
        const freeK = Number(grp.soLuongMienPhi || 0)
        take.forEach((opt, idx) => {
          const gia = idx < freeK ? 0 : Number(opt.giaCongThem || 0)
          giaModifiers += gia
          defaultMods.push({
            groupId: grp.id,
            tenGroup: grp.tenGroup,
            optionId: opt.id,
            tenOption: opt.tenOption,
            tenInNgan: opt.tenInNgan || opt.tenOption,
            qty: 1,
            giaCongThem: Number(opt.giaCongThem || 0),
          })
        })
      }
    }

    if (onQuickAdd) {
      onQuickAdd({
        maMon: item.maMon,
        tenMon: item.tenMon,
        kichThuoc: defaultSize.kichThuoc,
        donGia: Number(defaultSize.giaBan),
        giaModifiers,
        modifiers: defaultMods,
        soLuong: 1,
        ghiChu: '',
        isTakeaway: false,
        courseNo: 1,
        fireStatus: 'FIRED',
        toppings: [],
      })
    } else if (onPickProduct) {
      onPickProduct(item)
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 border border-gray-200 flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2.5 mb-3">
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => (
            <button
              type="button"
              key={g}
              onClick={() => setActiveGroup(g)}
              className={`min-h-12 px-4 py-2 rounded-xl text-xs font-extrabold transition cursor-pointer ${
                activeGroup === g
                  ? 'bg-amber-700 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {g}
            </button>
          ))}
        </div>

        <div className="relative flex items-center">
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Tìm món / Quét mã..."
            className="min-h-12 pl-3.5 pr-12 py-2 rounded-xl border border-gray-300 text-xs focus:ring-2 focus:ring-amber-600 outline-none w-56 font-semibold"
          />
          <kbd className="absolute right-2.5 px-1.5 py-0.5 rounded bg-stone-100 border border-stone-300 text-[10px] font-mono font-extrabold text-stone-600 pointer-events-none">
            [F1]
          </kbd>
        </div>
      </div>

      <p className="text-[11px] text-stone-500 mb-2.5">
        ⚡ <b>Chạm thẳng thẻ món</b> để cộng nhanh +1 (Smart Default Size M • 100% Đá/Đường — chốt đơn trong 2 chạm) • Nhấn giữ hoặc bấm <b>⚙️ Size/Topping</b> để tùy chỉnh
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2.5 overflow-y-auto max-h-[480px] pr-1">
        {filtered.map((item) => {
          const defaultSize =
            item.sizes?.find((s) => s.kichThuoc === 'M') ||
            item.sizes?.[0] || { kichThuoc: 'M', giaBan: 0 }
          const minPrice = item.sizes?.length
            ? Math.min(...item.sizes.map((s) => Number(s.giaBan)))
            : 0
          const isSoldOut = Boolean(item.tamHet)

          return (
            <div
              key={item.maMon}
              onPointerDown={() => {
                if (isSoldOut) return
                longPressedRef.current = false
                clearTimeout(longPressTimerRef.current)
                longPressTimerRef.current = setTimeout(() => {
                  longPressedRef.current = true
                  onPickProduct?.(item)
                }, 420)
              }}
              onPointerUp={() => clearTimeout(longPressTimerRef.current)}
              onPointerLeave={() => clearTimeout(longPressTimerRef.current)}
              onClick={() => {
                if (isSoldOut) return
                if (longPressedRef.current) {
                  longPressedRef.current = false
                  return
                }
                triggerSmartDefaultAdd(item)
              }}
              className={`p-3.5 rounded-2xl border text-left flex flex-col justify-between transition min-h-[132px] relative select-none ${
                isSoldOut
                  ? 'bg-gray-100 border-gray-200 opacity-60 cursor-not-allowed'
                  : 'border-gray-200 hover:border-amber-600 hover:shadow-md active:scale-[0.98] bg-stone-50/70 cursor-pointer group'
              }`}
              title={
                isSoldOut
                  ? 'Món đang tạm hết (86)'
                  : `Chạm để +1 nhanh Size ${defaultSize.kichThuoc} (${formatVND(defaultSize.giaBan)}) • Nhấn giữ để đổi Size/Topping`
              }
            >
              <div>
                <div className="flex items-center justify-between gap-1 mb-1">
                  <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                    {item.nhomMon || 'Đồ uống'}
                  </span>
                  {isSoldOut ? (
                    <span className="text-[10px] font-extrabold px-2 py-0.5 rounded bg-red-600 text-white">
                      TẠM HẾT (86)
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono text-gray-400">{item.maMon}</span>
                  )}
                </div>
                <h4 className="font-bold text-gray-800 text-sm group-hover:text-amber-800 leading-snug">
                  {item.tenMon}
                </h4>
              </div>

              <div className="mt-3 pt-2 border-t border-gray-200/80 flex items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-extrabold text-amber-700 block">
                    {formatVND(minPrice)}
                  </span>
                  <div className="flex gap-1 mt-0.5">
                    {item.sizes?.map((s) => (
                      <span
                        key={s.kichThuoc}
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                          s.kichThuoc === defaultSize.kichThuoc
                            ? 'bg-amber-100 border-amber-400 text-amber-900'
                            : 'bg-white border-gray-200 text-gray-600'
                        }`}
                      >
                        {s.kichThuoc}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Nút Tùy chọn Size / Đá / Đường / Topping chuẩn cảm ứng 48x48px+ */}
                {!isSoldOut && (
                  <button
                    type="button"
                    title="Đổi Size / Đường / Đá / Topping"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      onPickProduct?.(item)
                    }}
                    className="min-w-12 min-h-12 px-2.5 rounded-xl bg-white hover:bg-amber-50 border-2 border-amber-600 text-amber-800 font-extrabold text-xs shadow-xs flex items-center justify-center shrink-0 cursor-pointer active:scale-95"
                  >
                    ⚙️ Tùy
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
})

export default MenuGrid
