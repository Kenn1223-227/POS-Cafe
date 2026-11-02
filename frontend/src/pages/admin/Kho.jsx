import { useState, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'
import { khoService } from '../../services/khoService'
import { formatVND, formatNumber, getTodayISO } from '../../utils/format'

export default function Kho() {
  const [nguyenLieuList, setNguyenLieuList] = useState([])
  const [canhBaoList, setCanhBaoList] = useState([])
  const [canDoiList, setCanDoiList] = useState([])

  const [tuNgay, setTuNgay] = useState(() => getTodayISO().slice(0, 8) + '01')
  const [denNgay, setDenNgay] = useState(() => getTodayISO())

  // Tab lập phiếu: 'NHAP' (LoaiGD=1) | 'HUY' (LoaiGD=2) | 'KIEMKE' (LoaiGD=3)
  const [mode, setMode] = useState('NHAP')
  const [ghiChu, setGhiChu] = useState('')
  const [items, setItems] = useState([
    { maNL: '', soLuong: '', donGiaNhap: '', tinhTrang: 'Tốt' },
  ])
  const [submitting, setSubmitting] = useState(false)

  const loadKhoData = useCallback(async () => {
    try {
      const [nlAll, cb, cd] = await Promise.all([
        khoService.getAllNguyenLieu(),
        khoService.canhBao(),
        khoService.canDoi(tuNgay, denNgay),
      ])
      setNguyenLieuList(nlAll)
      setCanhBaoList(cb)
      setCanDoiList(cd)

      if (nlAll.length > 0) {
        setItems((prev) =>
          prev.map((row, idx) =>
            idx === 0 && !row.maNL ? { ...row, maNL: nlAll[0].maNL } : row
          )
        )
      }
    } catch {
      // Interceptor xử lý
    }
  }, [tuNgay, denNgay])

  useEffect(() => {
    loadKhoData()
  }, [loadKhoData])

  const handleAddRow = () => {
    setItems((prev) => [
      ...prev,
      {
        maNL: nguyenLieuList[0]?.maNL || '',
        soLuong: '',
        donGiaNhap: '',
        tinhTrang: mode === 'HUY' ? 'Hủy do hư hỏng' : 'Tốt',
      },
    ])
  }

  const handleChangeRow = (idx, field, value) => {
    setItems((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r))
    )
  }

  const handleRemoveRow = (idx) => {
    if (items.length <= 1) return
    setItems((prev) => prev.filter((_, i) => i !== idx))
  }

  const handleSubmitPhieu = async (e) => {
    e.preventDefault()
    const validRows = items.filter((r) => r.maNL && Number(r.soLuong) >= 0)
    if (validRows.length === 0) {
      toast.error('Vui lòng nhập ít nhất 1 dòng nguyên liệu hợp lệ')
      return
    }

    setSubmitting(true)
    try {
      if (mode === 'NHAP') {
        await khoService.nhap({
          ghiChu: ghiChu.trim() || 'Nhập kho nguyên liệu',
          danhSachNguyenLieu: validRows.map((r) => ({
            maNL: r.maNL,
            soLuong: Number(r.soLuong),
            donGiaNhap: Number(r.donGiaNhap || 0),
            tinhTrang: r.tinhTrang || 'Tốt',
          })),
        })
        toast.success('Đã lập phiếu nhập kho thành công!')
      } else {
        await khoService.kiemKe({
          loaiGD: mode === 'HUY' ? 2 : 3,
          ghiChu:
            ghiChu.trim() ||
            (mode === 'HUY' ? 'Xuất hủy nguyên liệu' : 'Kiểm kê kho định kỳ'),
          danhSachNguyenLieu: validRows.map((r) => ({
            maNL: r.maNL,
            soLuong: Number(r.soLuong),
            tinhTrang: r.tinhTrang,
          })),
        })
        toast.success(
          mode === 'HUY'
            ? 'Đã lập phiếu xuất hủy nguyên liệu!'
            : 'Đã cập nhật kiểm kê tồn kho thực tế!'
        )
      }

      setGhiChu('')
      setItems([
        {
          maNL: nguyenLieuList[0]?.maNL || '',
          soLuong: '',
          donGiaNhap: '',
          tinhTrang: 'Tốt',
        },
      ])
      await loadKhoData()
    } catch {
      // Interceptor đã xử lý
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-extrabold text-gray-800">
        📦 Quản Lý Kho Bãi, Cảnh Báo & Báo Cáo Cân Đối
      </h1>

      {/* 1. Bảng cảnh báo tồn kho thấp */}
      <div
        className={`p-4 rounded-2xl border ${
          canhBaoList.length > 0
            ? 'bg-red-50 border-red-200'
            : 'bg-emerald-50 border-emerald-200'
        }`}
      >
        <h3
          className={`text-sm font-extrabold mb-2 ${
            canhBaoList.length > 0 ? 'text-red-900' : 'text-emerald-900'
          }`}
        >
          {canhBaoList.length > 0
            ? `⚠️ Cảnh báo: Có ${canhBaoList.length} nguyên liệu chạm/dưới định mức tối thiểu!`
            : '✅ Tất cả nguyên liệu đều trên mức cảnh báo tồn kho'}
        </h3>

        {canhBaoList.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {canhBaoList.map((nl) => (
              <div
                key={nl.maNL}
                className="bg-white p-3 rounded-xl border border-red-200 flex items-center justify-between text-xs"
              >
                <div>
                  <p className="font-bold text-gray-800">
                    {nl.tenNL} ({nl.maNL})
                  </p>
                  <p className="text-gray-500">
                    Định mức tối thiểu: {formatNumber(nl.hanMuc)} {nl.donViTinh}
                  </p>
                </div>
                <span className="px-2.5 py-1 rounded-lg bg-red-100 text-red-800 font-extrabold">
                  Còn {formatNumber(nl.tonKho)} {nl.donViTinh}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 2. Form lập phiếu Nhập kho / Xuất hủy / Kiểm kê */}
      <form
        onSubmit={handleSubmitPhieu}
        className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
          <div className="flex flex-wrap gap-2">
            {[
              { id: 'NHAP', label: '➕ Nhập kho (LoaiGD = 1)' },
              { id: 'HUY', label: '🗑️ Xuất hủy (LoaiGD = 2)' },
              { id: 'KIEMKE', label: '📋 Kiểm kê thực tế (LoaiGD = 3)' },
            ].map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => setMode(t.id)}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                  mode === t.id
                    ? 'bg-amber-700 text-white shadow-sm'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleAddRow}
            className="px-3 py-1.5 bg-stone-100 hover:bg-stone-200 text-stone-800 rounded-xl text-xs font-bold cursor-pointer"
          >
            + Thêm dòng nguyên liệu
          </button>
        </div>

        <div className="space-y-2.5">
          {items.map((row, idx) => (
            <div
              key={idx}
              className="grid grid-cols-1 md:grid-cols-12 gap-2.5 items-center bg-gray-50 p-2.5 rounded-xl"
            >
              <select
                value={row.maNL}
                onChange={(e) => handleChangeRow(idx, 'maNL', e.target.value)}
                className="md:col-span-4 px-3 py-2 bg-white border rounded-xl text-xs font-medium"
              >
                {nguyenLieuList.map((nl) => (
                  <option key={nl.maNL} value={nl.maNL}>
                    {nl.maNL} - {nl.tenNL} (Tồn: {formatNumber(nl.tonKho)}{' '}
                    {nl.donViTinh})
                  </option>
                ))}
              </select>

              <input
                type="number"
                step="any"
                required
                placeholder={
                  mode === 'KIEMKE'
                    ? 'Tồn thực tế kiểm đếm...'
                    : 'Số lượng...'
                }
                value={row.soLuong}
                onChange={(e) =>
                  handleChangeRow(idx, 'soLuong', e.target.value)
                }
                className="md:col-span-3 px-3 py-2 bg-white border rounded-xl text-xs"
              />

              {mode === 'NHAP' ? (
                <input
                  type="number"
                  required
                  placeholder="Đơn giá nhập (VND / ĐVT)..."
                  value={row.donGiaNhap}
                  onChange={(e) =>
                    handleChangeRow(idx, 'donGiaNhap', e.target.value)
                  }
                  className="md:col-span-3 px-3 py-2 bg-white border rounded-xl text-xs"
                />
              ) : (
                <input
                  type="text"
                  placeholder="Tình trạng / Lý do..."
                  value={row.tinhTrang}
                  onChange={(e) =>
                    handleChangeRow(idx, 'tinhTrang', e.target.value)
                  }
                  className="md:col-span-3 px-3 py-2 bg-white border rounded-xl text-xs"
                />
              )}

              <div className="md:col-span-2 flex justify-end">
                <button
                  type="button"
                  disabled={items.length <= 1}
                  onClick={() => handleRemoveRow(idx)}
                  className="px-3 py-2 text-xs font-bold text-red-600 disabled:text-gray-300 cursor-pointer"
                >
                  Xóa dòng
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <input
            type="text"
            value={ghiChu}
            onChange={(e) => setGhiChu(e.target.value)}
            placeholder="Ghi chú chung cho phiếu kho này..."
            className="flex-1 min-w-[240px] px-3.5 py-2.5 border rounded-xl text-xs"
          />
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs shadow cursor-pointer"
          >
            {submitting ? 'Đang lưu phiếu...' : '💾 Xác nhận Lưu Phiếu Kho'}
          </button>
        </div>
      </form>

      {/* 3. Bảng Báo cáo Cân đối kho định kỳ */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-bold text-gray-800 text-base">
              📊 Báo Cáo Cân Đối Xuất - Nhập - Tồn Kho
            </h3>
            <p className="text-xs text-gray-500">
              Đối chiếu lượng nhập, tiêu hao bán hàng tự động, xuất hủy và chênh lệch kiểm kê
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="date"
              value={tuNgay}
              onChange={(e) => setTuNgay(e.target.value)}
              className="px-2.5 py-1.5 border rounded-xl text-xs"
            />
            <span className="text-gray-400">→</span>
            <input
              type="date"
              value={denNgay}
              onChange={(e) => setDenNgay(e.target.value)}
              className="px-2.5 py-1.5 border rounded-xl text-xs"
            />
            <button
              onClick={loadKhoData}
              className="px-3.5 py-1.5 bg-stone-800 hover:bg-stone-900 text-white rounded-xl text-xs font-bold cursor-pointer"
            >
              Xem cân đối
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-gray-50 text-gray-600 uppercase">
              <tr>
                <th className="p-3">Mã NL</th>
                <th className="p-3">Tên nguyên liệu</th>
                <th className="p-3">ĐVT</th>
                <th className="p-3 text-right">Tồn hiện tại</th>
                <th className="p-3 text-right">Tổng nhập (+1)</th>
                <th className="p-3 text-right">Tiêu hao bán (-6)</th>
                <th className="p-3 text-right">Xuất hủy (-2)</th>
                <th className="p-3 text-right">Lệch kiểm kê (±3)</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {canDoiList.map((r) => (
                <tr key={r.maNL} className="hover:bg-gray-50">
                  <td className="p-3 font-mono">{r.maNL}</td>
                  <td className="p-3 font-bold text-gray-800">{r.tenNL}</td>
                  <td className="p-3">{r.donViTinh}</td>
                  <td className="p-3 text-right font-extrabold text-amber-800">
                    {formatNumber(r.tonKho)}
                  </td>
                  <td className="p-3 text-right font-semibold text-emerald-600">
                    +{formatNumber(r.tongNhap)}
                  </td>
                  <td className="p-3 text-right font-semibold text-blue-600">
                    -{formatNumber(r.tongTieuHaoBanHang)}
                  </td>
                  <td className="p-3 text-right font-semibold text-red-600">
                    -{formatNumber(r.tongXuatHuy)}
                  </td>
                  <td className="p-3 text-right font-semibold">
                    {r.chenhLechKiemKe > 0
                      ? `+${formatNumber(r.chenhLechKiemKe)}`
                      : formatNumber(r.chenhLechKiemKe)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}