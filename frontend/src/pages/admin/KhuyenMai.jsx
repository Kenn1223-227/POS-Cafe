import { useState, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'
import { khuyenMaiService } from '../../services/khuyenMaiService'
import { formatVND } from '../../utils/format'

const WEEKDAYS = [
  { id: '1', label: 'T2' },
  { id: '2', label: 'T3' },
  { id: '3', label: 'T4' },
  { id: '4', label: 'T5' },
  { id: '5', label: 'T6' },
  { id: '6', label: 'T7' },
  { id: '0', label: 'CN' },
]

const EMPTY_FORM = {
  loaiKM: 'CODE',
  maCode: '',
  tenChuongTrinh: '',
  kieuGiam: 'PERCENT',
  giaTriGiam: '10',
  giamToiDa: '',
  donToiThieu: '0',
  khungGioTu: '14:00',
  khungGioDen: '17:00',
  ngayTrongTuan: ['1', '2', '3', '4', '5'],
  tuNgay: '',
  denNgay: '',
  gioiHanLuotDung: '',
}

export default function KhuyenMai() {
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)

  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const data = await khuyenMaiService.getAll()
      setList(Array.isArray(data) ? data : [])
    } catch {
      // Interceptor xử lý
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      void loadList()
    }, 0)
    return () => clearTimeout(t)
  }, [loadList])

  const toggleWeekday = (id) => {
    setForm((prev) => {
      const has = prev.ngayTrongTuan.includes(id)
      const next = has ? prev.ngayTrongTuan.filter((d) => d !== id) : [...prev.ngayTrongTuan, id]
      return { ...prev, ngayTrongTuan: next }
    })
  }

  const handleCreate = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      const payload = {
        loaiKM: form.loaiKM,
        maCode: form.loaiKM === 'CODE' ? form.maCode.trim().toUpperCase() : null,
        tenChuongTrinh: form.tenChuongTrinh.trim(),
        kieuGiam: form.kieuGiam,
        giaTriGiam: Number(form.giaTriGiam),
        giamToiDa: form.kieuGiam === 'PERCENT' && form.giamToiDa !== '' ? Number(form.giamToiDa) : null,
        donToiThieu: Number(form.donToiThieu || 0),
        khungGioTu: form.loaiKM === 'HAPPY_HOUR' ? form.khungGioTu : null,
        khungGioDen: form.loaiKM === 'HAPPY_HOUR' ? form.khungGioDen : null,
        ngayTrongTuan:
          form.loaiKM === 'HAPPY_HOUR' && form.ngayTrongTuan.length > 0
            ? form.ngayTrongTuan.join(',')
            : null,
        tuNgay: form.tuNgay || null,
        denNgay: form.denNgay || null,
        gioiHanLuotDung: form.gioiHanLuotDung !== '' ? Number(form.gioiHanLuotDung) : null,
      }
      const res = await khuyenMaiService.create(payload)
      toast.success(res.message || 'Đã tạo khuyến mãi thành công!')
      setForm(EMPTY_FORM)
      await loadList()
    } catch {
      // Interceptor xử lý
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (km) => {
    try {
      const res = await khuyenMaiService.toggleTrangThai(km.id, !km.dangHoatDong)
      toast.success(res.message)
      await loadList()
    } catch {
      // Interceptor xử lý
    }
  }

  const handleDelete = async (km) => {
    if (!window.confirm(`Xóa chương trình "${km.tenChuongTrinh}"?`)) return
    try {
      const res = await khuyenMaiService.remove(km.id)
      toast.success(res.message)
      await loadList()
    } catch {
      // Interceptor xử lý
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-gray-800">
          🎁 Khuyến Mãi (Happy Hour / Mã Giảm Giá) &amp; Quy Tắc Điểm Loyalty
        </h1>
        <p className="text-xs text-gray-500 mt-1">
          Quy đổi Loyalty mặc định: <b>Tích 1 điểm / 10.000đ</b> thực thanh toán • <b>Đổi 1 điểm = 1.000đ</b> trừ thẳng vào hóa đơn tại quầy POS.
        </p>
      </div>

      {/* Form tạo chương trình khuyến mãi */}
      <form onSubmit={handleCreate} className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-4 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
          <h3 className="font-extrabold text-sm text-gray-800">➕ Tạo Chương Trình Khuyến Mãi Mới</h3>
          <div className="flex gap-2">
            {[
              { id: 'CODE', label: '🎟️ Mã giảm giá (Voucher Code)' },
              { id: 'HAPPY_HOUR', label: '⏰ Happy Hour (Tự động theo giờ)' },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setForm((prev) => ({ ...prev, loaiKM: t.id }))}
                className={`px-3.5 py-2 rounded-xl font-bold border cursor-pointer transition ${
                  form.loaiKM === t.id
                    ? 'bg-amber-700 text-white border-amber-700'
                    : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="md:col-span-2">
            <label className="block font-bold text-gray-600 mb-1">Tên chương trình *</label>
            <input
              type="text"
              required
              value={form.tenChuongTrinh}
              onChange={(e) => setForm({ ...form, tenChuongTrinh: e.target.value })}
              placeholder={
                form.loaiKM === 'HAPPY_HOUR'
                  ? 'VD: Happy Hour Khung giờ vàng 14h–17h giảm 20%'
                  : 'VD: Khai trương giảm 15% cho khách mới'
              }
              className="w-full px-3 py-2 border rounded-xl outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>

          {form.loaiKM === 'CODE' && (
            <div>
              <label className="block font-bold text-gray-600 mb-1">Mã giảm giá (Code) *</label>
              <input
                type="text"
                required
                value={form.maCode}
                onChange={(e) =>
                  setForm({ ...form, maCode: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') })
                }
                placeholder="VD: CAFE15"
                className="w-full px-3 py-2 border rounded-xl font-mono font-extrabold uppercase outline-none focus:ring-2 focus:ring-amber-600"
              />
            </div>
          )}

          <div>
            <label className="block font-bold text-gray-600 mb-1">Kiểu giảm</label>
            <select
              value={form.kieuGiam}
              onChange={(e) => setForm({ ...form, kieuGiam: e.target.value })}
              className="w-full px-3 py-2 border rounded-xl bg-white font-bold"
            >
              <option value="PERCENT">Giảm theo Phần trăm (%)</option>
              <option value="FIXED">Giảm số tiền cố định (VND)</option>
            </select>
          </div>

          <div>
            <label className="block font-bold text-gray-600 mb-1">
              {form.kieuGiam === 'PERCENT' ? 'Phần trăm giảm (%) *' : 'Số tiền giảm (VND) *'}
            </label>
            <input
              type="number"
              required
              min="1"
              max={form.kieuGiam === 'PERCENT' ? 100 : undefined}
              value={form.giaTriGiam}
              onChange={(e) => setForm({ ...form, giaTriGiam: e.target.value })}
              className="w-full px-3 py-2 border rounded-xl font-bold outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>

          {form.kieuGiam === 'PERCENT' && (
            <div>
              <label className="block font-bold text-gray-600 mb-1">Giảm tối đa (VND, tùy chọn)</label>
              <input
                type="number"
                min="0"
                step="1000"
                value={form.giamToiDa}
                onChange={(e) => setForm({ ...form, giamToiDa: e.target.value })}
                placeholder="VD: 30000"
                className="w-full px-3 py-2 border rounded-xl"
              />
            </div>
          )}

          <div>
            <label className="block font-bold text-gray-600 mb-1">Đơn tối thiểu (VND)</label>
            <input
              type="number"
              min="0"
              step="1000"
              value={form.donToiThieu}
              onChange={(e) => setForm({ ...form, donToiThieu: e.target.value })}
              className="w-full px-3 py-2 border rounded-xl"
            />
          </div>

          <div>
            <label className="block font-bold text-gray-600 mb-1">Giới hạn lượt dùng (trống = ∞)</label>
            <input
              type="number"
              min="1"
              value={form.gioiHanLuotDung}
              onChange={(e) => setForm({ ...form, gioiHanLuotDung: e.target.value })}
              placeholder="VD: 100"
              className="w-full px-3 py-2 border rounded-xl"
            />
          </div>

          <div>
            <label className="block font-bold text-gray-600 mb-1">Từ ngày (tùy chọn)</label>
            <input
              type="date"
              value={form.tuNgay}
              onChange={(e) => setForm({ ...form, tuNgay: e.target.value })}
              className="w-full px-3 py-2 border rounded-xl"
            />
          </div>

          <div>
            <label className="block font-bold text-gray-600 mb-1">Đến ngày (tùy chọn)</label>
            <input
              type="date"
              value={form.denNgay}
              onChange={(e) => setForm({ ...form, denNgay: e.target.value })}
              className="w-full px-3 py-2 border rounded-xl"
            />
          </div>
        </div>

        {form.loaiKM === 'HAPPY_HOUR' && (
          <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="font-bold text-amber-950">⏰ Khung giờ (VN):</span>
              <input
                type="time"
                required
                value={form.khungGioTu}
                onChange={(e) => setForm({ ...form, khungGioTu: e.target.value })}
                className="px-2.5 py-1.5 bg-white border rounded-lg font-bold"
              />
              <span>→</span>
              <input
                type="time"
                required
                value={form.khungGioDen}
                onChange={(e) => setForm({ ...form, khungGioDen: e.target.value })}
                className="px-2.5 py-1.5 bg-white border rounded-lg font-bold"
              />
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-bold text-amber-950 mr-1">📅 Ngày áp dụng:</span>
              {WEEKDAYS.map((d) => {
                const active = form.ngayTrongTuan.includes(d.id)
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => toggleWeekday(d.id)}
                    className={`w-9 h-8 rounded-lg font-bold border cursor-pointer ${
                      active
                        ? 'bg-amber-700 text-white border-amber-700'
                        : 'bg-white text-gray-600 border-gray-300'
                    }`}
                  >
                    {d.label}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div>
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2.5 bg-amber-700 hover:bg-amber-800 text-white font-extrabold rounded-xl shadow cursor-pointer disabled:opacity-50"
          >
            {saving ? 'Đang tạo...' : '💾 Tạo chương trình khuyến mãi'}
          </button>
        </div>
      </form>

      {/* Danh sách chương trình khuyến mãi */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-extrabold text-sm text-gray-800">
            📋 Danh sách Khuyến mãi của quán ({list.length})
          </h3>
          <button
            type="button"
            onClick={loadList}
            className="px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-xs font-bold cursor-pointer"
          >
            ↻ Tải lại
          </button>
        </div>

        {loading ? (
          <p className="text-xs text-gray-400 py-6 text-center">Đang tải danh sách khuyến mãi...</p>
        ) : list.length === 0 ? (
          <p className="text-xs text-gray-400 py-8 text-center italic">
            Chưa có chương trình khuyến mãi nào. Hãy tạo Mã giảm giá hoặc Happy Hour ở trên!
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-gray-50 text-gray-600 uppercase">
                <tr>
                  <th className="p-2.5">Loại / Mã</th>
                  <th className="p-2.5">Chương trình</th>
                  <th className="p-2.5">Mức giảm</th>
                  <th className="p-2.5">Điều kiện &amp; Thời gian</th>
                  <th className="p-2.5 text-center">Lượt dùng</th>
                  <th className="p-2.5">Trạng thái</th>
                  <th className="p-2.5 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {list.map((km) => (
                  <tr key={km.id} className="hover:bg-gray-50">
                    <td className="p-2.5">
                      {km.loaiKM === 'HAPPY_HOUR' ? (
                        <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 font-extrabold text-[10px]">
                          ⏰ HAPPY HOUR
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded bg-indigo-100 text-indigo-900 font-mono font-extrabold text-[11px]">
                          {km.maCode}
                        </span>
                      )}
                    </td>
                    <td className="p-2.5 font-bold text-gray-800">{km.tenChuongTrinh}</td>
                    <td className="p-2.5 font-extrabold text-emerald-700">
                      {km.kieuGiam === 'PERCENT'
                        ? `-${km.giaTriGiam}%${km.giamToiDa ? ` (tối đa ${formatVND(km.giamToiDa)})` : ''}`
                        : `-${formatVND(km.giaTriGiam)}`}
                    </td>
                    <td className="p-2.5 text-gray-600 space-y-0.5">
                      {km.donToiThieu > 0 && <p>Đơn tối thiểu: <b>{formatVND(km.donToiThieu)}</b></p>}
                      {km.khungGioTu && km.khungGioDen && (
                        <p>Khung giờ: <b>{km.khungGioTu}–{km.khungGioDen}</b></p>
                      )}
                      {(km.tuNgay || km.denNgay) && (
                        <p>{km.tuNgay || '...'} → {km.denNgay || '...'}</p>
                      )}
                    </td>
                    <td className="p-2.5 text-center font-mono font-bold">
                      {km.soLuotDaDung} / {km.gioiHanLuotDung ?? '∞'}
                    </td>
                    <td className="p-2.5">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${
                          km.dangHoatDong ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-600'
                        }`}
                      >
                        {km.dangHoatDong ? 'ĐANG CHẠY' : 'TẠM NGƯNG'}
                      </span>
                    </td>
                    <td className="p-2.5 text-right space-x-1.5 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => handleToggle(km)}
                        className={`px-2.5 py-1 rounded-lg font-bold cursor-pointer ${
                          km.dangHoatDong
                            ? 'bg-amber-100 hover:bg-amber-200 text-amber-900'
                            : 'bg-emerald-100 hover:bg-emerald-200 text-emerald-800'
                        }`}
                      >
                        {km.dangHoatDong ? 'Tạm ngưng' : 'Bật lại'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(km)}
                        className="px-2.5 py-1 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 font-bold cursor-pointer"
                      >
                        Xóa
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
