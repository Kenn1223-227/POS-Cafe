import { useState } from 'react'
import { formatVND } from '../../../utils/format'

export default function MenuGrid({ menu, onPickProduct }) {
  const groups = ['Tất cả', ...new Set(menu.map((m) => m.nhomMon || 'Khác'))]
  const [activeGroup, setActiveGroup] = useState('Tất cả')
  const [search, setSearch] = useState('')

  const filtered = menu.filter((item) => {
    const matchGroup =
      activeGroup === 'Tất cả' || (item.nhomMon || 'Khác') === activeGroup
    const matchSearch = item.tenMon
      ?.toLowerCase()
      .includes(search.trim().toLowerCase())
    return matchGroup && matchSearch
  })

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 border border-gray-200 flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex flex-wrap gap-1.5">
          {groups.map((g) => (
            <button
              key={g}
              onClick={() => setActiveGroup(g)}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                activeGroup === g
                  ? 'bg-amber-700 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {g}
            </button>
          ))}
        </div>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 Tìm tên món..."
          className="px-3.5 py-2 rounded-xl border border-gray-300 text-xs focus:ring-2 focus:ring-amber-600 outline-none w-48"
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3 overflow-y-auto max-h-[460px] pr-1">
        {filtered.map((item) => {
          const minPrice = item.sizes?.length
            ? Math.min(...item.sizes.map((s) => Number(s.giaBan)))
            : 0
          return (
            <button
              key={item.maMon}
              onClick={() => onPickProduct(item)}
              className="p-3.5 rounded-2xl border border-gray-200 hover:border-amber-600 hover:shadow-md bg-stone-50/70 text-left flex flex-col justify-between transition min-h-[116px] cursor-pointer group"
            >
              <div>
                <div className="flex items-center justify-between gap-1 mb-1">
                  <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                    {item.nhomMon || 'Đồ uống'}
                  </span>
                  <span className="text-[10px] font-mono text-gray-400">
                    {item.maMon}
                  </span>
                </div>
                <h4 className="font-bold text-gray-800 text-sm group-hover:text-amber-800 leading-snug">
                  {item.tenMon}
                </h4>
              </div>

              <div className="mt-3 pt-2 border-t border-gray-200/80 flex items-center justify-between">
                <span className="text-sm font-extrabold text-amber-700">
                  {formatVND(minPrice)}
                </span>
                <div className="flex gap-1">
                  {item.sizes?.map((s) => (
                    <span
                      key={s.kichThuoc}
                      className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-white border border-gray-200 text-gray-600"
                    >
                      {s.kichThuoc}
                    </span>
                  ))}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}