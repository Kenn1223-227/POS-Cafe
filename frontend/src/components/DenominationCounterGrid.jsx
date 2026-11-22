import { formatVND } from '../utils/format'

const DENOMS = [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000]

export default function DenominationCounterGrid({
  value = {},
  onChange,
  disabled = false,
  title = '💵 Kiểm đếm theo mệnh giá (Blind Drop)',
}) {
  const safeMap = value && typeof value === 'object' ? value : {}
  const total = DENOMS.reduce((sum, d) => sum + d * Math.max(0, Math.floor(Number(safeMap[d] || 0))), 0)

  const handleQtyChange = (denom, raw) => {
    const qty = Math.max(0, Math.floor(Number(raw || 0)))
    const next = { ...safeMap }
    if (qty > 0) next[denom] = qty
    else delete next[denom]
    const nextTotal = DENOMS.reduce((sum, d) => sum + d * Math.max(0, Math.floor(Number(next[d] || 0))), 0)
    onChange?.(next, nextTotal)
  }

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-extrabold text-stone-700">{title}</p>
        <span className="text-xs font-black text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200">
          Tổng đếm: {formatVND(total)}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {DENOMS.map((d) => {
          const qty = safeMap[d] ?? ''
          return (
            <label
              key={d}
              className="flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-lg bg-stone-50 border border-stone-200 text-[11px]"
            >
              <span className="font-bold text-stone-700 shrink-0">{(d / 1000).toLocaleString('vi-VN')}k</span>
              <input
                type="number"
                min="0"
                disabled={disabled}
                value={qty}
                onChange={(e) => handleQtyChange(d, e.target.value)}
                placeholder="0"
                className="w-14 px-1.5 py-1 bg-white border rounded text-right font-extrabold text-stone-900 outline-none focus:ring-1 focus:ring-amber-600 disabled:bg-gray-100"
              />
            </label>
          )
        })}
      </div>
    </div>
  )
}
