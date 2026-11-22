import { useState, useEffect, memo } from 'react'
import toast from 'react-hot-toast'
import { banService } from '../../../services/banService'
import { formatVND } from '../../../utils/format'

const TableMap = memo(function TableMap({
  tables,
  selectedTable,
  onSelectTable,
  onRefresh,
  userRole,
}) {
  const areas = ['Tất cả', ...new Set(tables.map((t) => t.khuVuc || 'Khu chính'))]
  const [activeArea, setActiveArea] = useState('Tất cả')
  const [showAddModal, setShowAddModal] = useState(false)
  const [showMoveModal, setShowMoveModal] = useState(false)
  const [showMergeModal, setShowMergeModal] = useState(false)
  const [targetMaBan, setTargetMaBan] = useState('')
  const [mergeTargetMaBan, setMergeTargetMaBan] = useState('')
  const [newBan, setNewBan] = useState({ maBan: '', tenBan: '', khuVuc: 'Khu chính' })
  const [loading, setLoading] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])

  const filtered =
    activeArea === 'Tất cả'
      ? tables
      : tables.filter((t) => (t.khuVuc || 'Khu chính') === activeArea)

  const servingTables = tables.filter((t) => Number(t.trangThai) === 2)
  const servingCount = servingTables.length
  const otherServingTables = servingTables.filter((t) => t.maBan !== selectedTable?.maBan)
  const cleaningTables = tables.filter((t) => Number(t.trangThai) === 3)
  const cleaningCount = cleaningTables.length
  const emptyTables = tables.filter((t) => Number(t.trangThai) !== 2)
  const trulyEmptyCount = tables.filter((t) => Number(t.trangThai) === 1).length

  const handleToggleTableStatus = async (maBan, trangThaiMoi) => {
    setLoading(true)
    try {
      const res = await banService.doiTrangThai(maBan, trangThaiMoi)
      toast.success(res.message || 'Đã cập nhật trạng thái bàn!')
      if (onRefresh) await onRefresh()
      if (selectedTable?.maBan === maBan) {
        onSelectTable({ ...selectedTable, trangThai: trangThaiMoi })
      }
    } catch {
      // Interceptor xử lý
    } finally {
      setLoading(false)
    }
  }

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

  const handleMoveTable = async (e) => {
    e.preventDefault()
    if (!selectedTable || !targetMaBan) return
    setLoading(true)
    try {
      const res = await banService.chuyenBan({
        fromMaBan: selectedTable.maBan,
        toMaBan: targetMaBan,
      })
      toast.success(res.message || 'Chuyển bàn thành công!')
      setShowMoveModal(false)
      const destTable = tables.find((t) => t.maBan === targetMaBan)
      if (onRefresh) await onRefresh()
      if (destTable) onSelectTable({ ...destTable, trangThai: 2 })
    } catch {
      // Interceptor xử lý
    } finally {
      setLoading(false)
    }
  }

  const handleMergeTable = async (e) => {
    e.preventDefault()
    if (!selectedTable || !mergeTargetMaBan) return
    setLoading(true)
    try {
      const res = await banService.gopBan({
        fromMaBan: selectedTable.maBan,
        toMaBan: mergeTargetMaBan,
      })
      toast.success(res.message || 'Gộp bàn thành công!')
      setShowMergeModal(false)
      const destTable = tables.find((t) => t.maBan === mergeTargetMaBan)
      if (onRefresh) await onRefresh()
      if (destTable) onSelectTable({ ...destTable, trangThai: 2 })
    } catch {
      // Interceptor xử lý
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 border border-gray-200 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          {areas.map((area) => (
            <button
              type="button"
              key={area}
              onClick={() => setActiveArea(area)}
              className={`min-h-[52px] px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                activeArea === area
                  ? 'bg-amber-700 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {area}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onSelectTable(null)}
            className={`min-h-[52px] px-3.5 py-2 rounded-xl text-xs font-extrabold border transition cursor-pointer ${
              selectedTable === null
                ? 'bg-stone-800 text-white border-stone-800'
                : 'bg-stone-50 text-stone-700 border-stone-300 hover:bg-stone-100'
            }`}
          >
            🛍️ Mang đi [F2]
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
            Trống ({trulyEmptyCount})
          </span>
          <span className="inline-flex items-center gap-1.5 font-semibold text-orange-700">
            <span className="w-2.5 h-2.5 rounded-full bg-orange-500" />
            Có khách ({servingCount})
          </span>
          {cleaningCount > 0 && (
            <span className="inline-flex items-center gap-1.5 font-semibold text-amber-700">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
              Chờ dọn ({cleaningCount})
            </span>
          )}

          {selectedTable && Number(selectedTable.trangThai) === 3 && (
            <button
              type="button"
              disabled={loading}
              onClick={() => handleToggleTableStatus(selectedTable.maBan, 1)}
              className="min-h-12 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold cursor-pointer transition shadow-sm"
            >
              ✨ Đã dọn xong ({selectedTable.tenBan})
            </button>
          )}

          {selectedTable && Number(selectedTable.trangThai) === 1 && (
            <button
              type="button"
              disabled={loading}
              onClick={() => handleToggleTableStatus(selectedTable.maBan, 3)}
              className="min-h-12 px-3.5 py-2 bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300 rounded-xl font-bold cursor-pointer transition"
              title="Đánh dấu bàn đang chờ nhân viên dọn dẹp trước khi đón khách mới"
            >
              🧹 Báo chờ dọn
            </button>
          )}

          {selectedTable && Number(selectedTable.trangThai) === 2 && emptyTables.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setTargetMaBan(emptyTables[0]?.maBan || '')
                setShowMoveModal(true)
              }}
              className="min-h-12 px-3.5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-xl font-bold cursor-pointer transition shadow-sm"
            >
              🔄 Chuyển bàn
            </button>
          )}

          {selectedTable && Number(selectedTable.trangThai) === 2 && otherServingTables.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setMergeTargetMaBan(otherServingTables[0]?.maBan || '')
                setShowMergeModal(true)
              }}
              className="min-h-12 px-3.5 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-bold cursor-pointer transition shadow-sm"
            >
              🔗 Gộp bàn
            </button>
          )}

          {Number(userRole) === 1 && (
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="min-h-12 px-3.5 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-xl font-bold cursor-pointer transition shadow-sm"
            >
              + Thêm bàn
            </button>
          )}
          <button
            type="button"
            onClick={onRefresh}
            className="min-h-12 min-w-12 px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-xl font-bold text-gray-700 cursor-pointer"
          >
            ↻
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2.5">
        {filtered.map((ban) => {
          const st = Number(ban.trangThai)
          const isServing = st === 2
          const isCleaning = st === 3
          const isReserved = st === 4
          const isSelected = selectedTable?.maBan === ban.maBan

          const dwellMins =
            isServing && ban.thoiGianMoBan
              ? Math.max(1, Math.floor((nowMs - new Date(ban.thoiGianMoBan).getTime()) / 60000))
              : 0
          const idleSinceLastOrderMins =
            isServing && ban.lastOrderAt
              ? Math.max(0, Math.floor((nowMs - new Date(ban.lastOrderAt).getTime()) / 60000))
              : 0
          const dwellBadgeCls =
            dwellMins > 90 || idleSinceLastOrderMins > 30
              ? 'bg-red-600 text-white'
              : dwellMins >= 45
              ? 'bg-amber-500 text-stone-950'
              : 'bg-emerald-600 text-white'

          const kdsTotal = Number(ban.kdsProgress?.tongMon || 0)
          const kdsDone = Number(ban.kdsProgress?.daXong || 0)
          const resv = ban.upcomingReservation || null
          const resvTime = resv?.thoiGianDen
            ? new Date(resv.thoiGianDen).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
            : ''

          const handleClickTable = () => {
            if (!isServing && resv) {
              const ok = window.confirm(
                `⚠️ ${ban.tenBan} có lịch ĐẶT TRƯỚC lúc ${resvTime} - ${resv.tenKhach} (${resv.soKhach} khách). Bạn vẫn muốn xếp khách vãng lai ngồi bàn này?`
              )
              if (!ok) return
            }
            onSelectTable(ban)
          }

          return (
            <div
              key={ban.maBan}
              onClick={handleClickTable}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && handleClickTable()}
              className={`p-3 rounded-2xl border-2 text-left transition flex flex-col justify-between min-h-[104px] cursor-pointer ${
                isSelected ? 'ring-4 ring-amber-400 border-amber-800' : ''
              } ${
                isServing
                  ? 'bg-orange-50 border-orange-400 text-orange-950 hover:bg-orange-100/70'
                  : isCleaning
                  ? 'bg-purple-50 border-purple-400 border-dashed text-purple-950 hover:bg-purple-100/70'
                  : isReserved
                  ? 'bg-sky-50 border-sky-400 text-sky-950 hover:bg-sky-100/70'
                  : 'bg-emerald-50 border-emerald-400 text-emerald-950 hover:bg-emerald-100/70'
              }`}
            >
              <div className="flex items-center justify-between w-full gap-1">
                <span className="font-extrabold text-sm truncate">
                  {ban.tenBan}
                  {isServing && Number(ban.soKhach) > 0 && (
                    <span className="ml-1 text-[11px] font-bold text-orange-800">({ban.soKhach}👤)</span>
                  )}
                </span>
                {isServing && dwellMins > 0 ? (
                  <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-extrabold shrink-0 ${dwellBadgeCls}`}>
                    ⏱ {dwellMins}p
                  </span>
                ) : (
                  <span
                    className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                      isServing
                        ? 'bg-orange-500 animate-pulse'
                        : isCleaning
                        ? 'bg-purple-500'
                        : isReserved
                        ? 'bg-sky-500'
                        : 'bg-emerald-500'
                    }`}
                  />
                )}
              </div>

              <div className="mt-1.5 space-y-1">
                {resv && (
                  <p className="text-[10px] font-extrabold px-1.5 py-0.5 rounded bg-sky-600 text-white truncate">
                    📅 {resvTime} - {resv.tenKhach} ({resv.soKhach}👤)
                  </p>
                )}

                {isServing ? (
                  <div className="space-y-0.5">
                    {ban.tongTamTinh > 0 && (
                      <p className="text-xs font-black text-orange-900">{formatVND(ban.tongTamTinh)}</p>
                    )}
                    {kdsTotal > 0 && (
                      <p className="text-[10px] font-bold text-orange-700">
                        🍹 {kdsDone}/{kdsTotal} món đã ra
                      </p>
                    )}
                  </div>
                ) : isCleaning ? (
                  <div className="flex items-center justify-between gap-1 pt-0.5">
                    <span className="text-[11px] font-extrabold text-purple-800">🧹 Chờ dọn</span>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleToggleTableStatus(ban.maBan, 1)
                      }}
                      className="px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-extrabold cursor-pointer"
                    >
                      ✓ Đã dọn
                    </button>
                  </div>
                ) : isReserved ? (
                  <p className="text-xs font-extrabold text-sky-800">📅 Đã đặt trước</p>
                ) : (
                  <p className="text-xs font-bold text-emerald-700">Bàn trống</p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Modal Chuyển bàn */}
      {showMoveModal && selectedTable && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl space-y-4">
            <h3 className="font-extrabold text-base text-gray-800">
              🔄 Chuyển từ {selectedTable.tenBan} sang bàn trống
            </h3>
            <p className="text-xs text-gray-500">
              Màn hình Quầy Pha Chế (Barista) và Phục vụ sẽ tự động cập nhật số bàn mới.
            </p>
            <form onSubmit={handleMoveTable} className="space-y-3">
              <select
                value={targetMaBan}
                onChange={(e) => setTargetMaBan(e.target.value)}
                className="w-full min-h-11 px-3 py-2 border rounded-xl text-sm font-semibold"
              >
                {emptyTables.map((b) => (
                  <option key={b.maBan} value={b.maBan}>
                    {b.tenBan} ({b.khuVuc})
                  </option>
                ))}
              </select>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowMoveModal(false)}
                  className="flex-1 min-h-11 border rounded-xl text-xs font-bold cursor-pointer text-gray-700"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 min-h-11 bg-sky-600 hover:bg-sky-700 text-white rounded-xl text-xs font-bold shadow cursor-pointer disabled:opacity-50"
                >
                  {loading ? 'Đang chuyển...' : 'Xác nhận chuyển'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Gộp bàn (Merge Table) */}
      {showMergeModal && selectedTable && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl space-y-4">
            <h3 className="font-extrabold text-base text-gray-800">
              🔗 Gộp {selectedTable.tenBan} vào bàn khác
            </h3>
            <p className="text-xs text-gray-500">
              Toàn bộ món & khoản thanh toán của <b>{selectedTable.tenBan}</b> sẽ được gộp vào hóa đơn của bàn đích và trả trống {selectedTable.tenBan}.
            </p>
            <form onSubmit={handleMergeTable} className="space-y-3">
              <select
                value={mergeTargetMaBan}
                onChange={(e) => setMergeTargetMaBan(e.target.value)}
                className="w-full min-h-11 px-3 py-2 border rounded-xl text-sm font-semibold"
              >
                {otherServingTables.map((b) => (
                  <option key={b.maBan} value={b.maBan}>
                    {b.tenBan} ({b.khuVuc}) — {formatVND(b.tongTamTinh || 0)}
                  </option>
                ))}
              </select>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowMergeModal(false)}
                  className="flex-1 min-h-11 border rounded-xl text-xs font-bold cursor-pointer text-gray-700"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 min-h-11 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-bold shadow cursor-pointer disabled:opacity-50"
                >
                  {loading ? 'Đang gộp...' : 'Xác nhận gộp bàn'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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
                  className="w-full min-h-11 px-3 py-2 border rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-600"
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
                  className="w-full min-h-11 px-3 py-2 border rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-600"
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
                  className="w-full min-h-11 px-3 py-2 border rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-600"
                  placeholder="Nhập khu vực..."
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 min-h-11 border rounded-xl text-xs font-bold cursor-pointer text-gray-700 hover:bg-gray-50"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 min-h-11 bg-amber-700 hover:bg-amber-800 text-white rounded-xl text-xs font-bold shadow cursor-pointer disabled:opacity-50"
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
})

export default TableMap
