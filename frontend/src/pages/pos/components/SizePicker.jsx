import { formatVND } from '../../../utils/format'

export default function SizePicker({ sizes = [], selectedSize, onSelectSize }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-bold uppercase text-gray-600">
        Chọn kích cỡ (Size S / M / L)
      </label>
      <div className="grid grid-cols-3 gap-2.5">
        {sizes.map((s) => {
          const active = selectedSize?.kichThuoc === s.kichThuoc
          return (
            <button
              type="button"
              key={s.kichThuoc}
              onClick={() => onSelectSize(s)}
              className={`p-3 rounded-xl border-2 text-center transition cursor-pointer ${
                active
                  ? 'border-amber-700 bg-amber-50 text-amber-900 shadow-sm'
                  : 'border-gray-200 hover:border-gray-300 text-gray-700'
              }`}
            >
              <div className="text-sm font-extrabold">Size {s.kichThuoc}</div>
              <div className="text-xs font-bold text-amber-700 mt-0.5">
                {formatVND(s.giaBan)}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}