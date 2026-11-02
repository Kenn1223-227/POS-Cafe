import { useState } from 'react'
import toast from 'react-hot-toast'
import { banService } from '../../../services/banService'

export default function TableMap({
  tables,
  selectedTable,
  onSelectTable,
  onRefresh,
  userRole,
}) {
  const areas = ['Tất cả', ...new Set(tables.map((t) => t.khuVuc || 'Khu chính'))]
  const [activeArea, setActiveArea] = useState('Tất cả')
  const [showAddModal, setShowAddModal] = useState(false)
  const [newBan, setNewBan] = useState({ maBan: '', tenBan: '', khuVuc: 'Khu chính' })
  const [loading, setLoading] = useState(false)

  const filtered =
    activeArea === 'Tất cả'
      ? tables
      : tables.filter((t) => (t.khuVuc || 'Khu chính') === activeArea)

  const servingCount = tables.filter((t) => Number(t.trangThai) === 2).length
  const emptyCount = tables.length - servingCount

  const handleCreateBan = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      await banService.create(newBan)
      toast.success('Thêm bàn mới thành công!')
      setShowAddModal(false)
      setNewBan({ maBan: '', tenBan: '', khuVuc: 'Khu chính' })
      if (onRefresh) onRefresh()
    } catch {
      // Interceptor xử lý lỗi
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 border border-gray-200 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {areas.map((area) => (
            <button
              key={area}
              onClick={() => setActiveArea(area)}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                activeArea === area
                  ? 'bg-amber-700 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {area}
            </button>
          ))}
          <button
            onClick={() => onSelectTable(null)}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold border transition cursor-pointer ${
              selectedTable === null
                ? 'bg-stone-800 text-white border-stone-800'
                : 'bg-stone-50 text-stone-700 border-stone-300 hover:bg-stone-100'
            }`}
          >
            🛍️ Mang đi (Takeaway)
          </button>
        </div>

        <div className="flex items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
            Trống ({emptyCount})
          </span>
          <span className="inline-flex items-center gap-1.5 font-semibold text-orange-700">
            <span className="w-2.5 h-2.5 rounded-full bg-orange-500" />
            Đang phục vụ ({servingCount})
          </span>
          {Number(userRole) === 1 && (
            <button
              onClick={() => setShowAddModal(true)}
              className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl font-bold cursor-pointer transition shadow-sm"
            >
              + Thêm bàn
            </button>
          )}
          <button
            onClick={onRefresh}
            className="px-2.5 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium text-gray-700 cursor-pointer"
          >
            ↻
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2.5">
        {filtered.map((ban) => {
          const isServing = Number(ban.trangThai) === 2
          const isSelected = selectedTable?.maBan === ban.maBan

          return (
            <button
              key={ban.maBan}
              onClick={() => onSelectTable(ban)}
              className={`p-3.5 rounded-2xl border-2 text-left transition flex flex-col justify-between min-h-[88px] cursor-pointer ${
                isSelected
                  ? 'ring-4 ring-amber-400 border-amber-800'
                  : ''
              } ${
                isServing
                  ? 'bg-orange-50 border-orange-400 text-orange-950 hover:bg-orange-100/70'
                  : 'bg-emerald-50 border-emerald-400 text-emerald-950 hover:bg-emerald-100/70'
              }`}
            >
              <div className="flex items-center justify-between w-full">
                <span className="font-extrabold text-sm">{ban.tenBan}</span>
                <span
                  className={`w-2.5 h-2.5 rounded-full ${
                    isServing ? 'bg-orange-500 animate-pulse' : 'bg-emerald-500'
                  }`}
                />
              </div>
              <div className="mt-2">
                <p className="text-[11px] opacity-75">{ban.khuVuc || 'Khu chính'}</p>
                <p
                  className={`text-xs font-bold mt-0.5 ${
                    isServing ? 'text-orange-700' : 'text-emerald-700'
                  }`}
                >
                  {isServing ? 'Đang phục vụ' : 'Bàn trống'}
                </p>
              </div>
            </button>
          )
        })}
      </div>

      {/* Modal Thêm Bàn mới dành cho Quản lý */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl space-y-4">
            <h3 className="font-extrabold text-base text-gray-800">➕ Thêm Bàn Mới</h3>
            <form onSubmit={handleCreateBan} className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-gray-600 mb-1">Mã bàn (VD: B09)</label>
                <input
                  type="text"
                  required
                  value={newBan.maBan}
                  onChange={(e) => setNewBan({ ...newBan, maBan: e.target.value })}
                  className="w-full px-3 py-2 border rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-600"
                  placeholder="Nhập mã bàn..."
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-600 mb-1">Tên bàn (VD: Bàn 09)</label>
                <input
                  type="text"
                  required
                  value={newBan.tenBan}
                  onChange={(e) => setNewBan({ ...newBan, tenBan: e.target.value })}
                  className="w-full px-3 py-2 border rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-600"
                  placeholder="Nhập tên bàn..."
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-600 mb-1">Khu vực</label>
                <input
                  type="text"
                  required
                  value={newBan.khuVuc}
                  onChange={(e) => setNewBan({ ...newBan, khuVuc: e.target.value })}
                  className="w-full px-3 py-2 border rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-600"
                  placeholder="Nhập khu vực..."
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 py-2 border rounded-xl text-xs font-bold cursor-pointer text-gray-700 hover:bg-gray-50"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 py-2 bg-amber-700 hover:bg-amber-800 text-white rounded-xl text-xs font-bold shadow cursor-pointer disabled:opacity-50"
                >
                  {loading ? 'Đang thêm...' : 'Xác nhận thêm'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}