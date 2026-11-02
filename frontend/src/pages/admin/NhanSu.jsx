import { useState } from 'react'
import toast from 'react-hot-toast'
import { nhanSuService } from '../../services/nhanSuService'
import { formatVND, getTodayISO } from '../../utils/format'

export default function NhanSu() {
  const [phanCaForm, setPhanCaForm] = useState({
    maNV: '',
    maCa: 'CA01',
    ngayLam: getTodayISO(),
  })

  const now = new Date()
  const [luongParams, setLuongParams] = useState({
    thang: now.getMonth() + 1,
    nam: now.getFullYear(),
    donGiaGio: 25000,
  })
  const [bangLuong, setBangLuong] = useState([])

  const handlePhanCa = async (e) => {
    e.preventDefault()
    try {
      await nhanSuService.phanCa(phanCaForm)
      toast.success(`Đã xếp ca ${phanCaForm.maCa} cho NV ${phanCaForm.maNV}`)
      setPhanCaForm({ ...phanCaForm, maNV: '' })
    } catch {
      // Interceptor xử lý
    }
  }

  const handleTinhLuong = async (e) => {
    e.preventDefault()
    try {
      const res = await nhanSuService.tinhLuong(luongParams)
      setBangLuong(res.bangLuong || [])
      toast.success('Đã tổng hợp bảng lương theo giờ chấm công')
    } catch {
      // Interceptor xử lý
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">👥 Quản lý Nhân sự, Phân ca & Tính lương</h1>

      {/* Form Xếp lịch phân ca */}
      <form onSubmit={handlePhanCa} className="bg-white p-5 rounded-2xl shadow-sm space-y-4">
        <h3 className="font-bold text-gray-700">📅 Xếp lịch Phân ca Nhân viên</h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input
            type="text"
            required
            placeholder="Mã Nhân viên (VD: NV02)..."
            value={phanCaForm.maNV}
            onChange={(e) => setPhanCaForm({ ...phanCaForm, maNV: e.target.value })}
            className="px-3 py-2.5 border rounded-xl text-sm"
          />
          <select
            value={phanCaForm.maCa}
            onChange={(e) => setPhanCaForm({ ...phanCaForm, maCa: e.target.value })}
            className="px-3 py-2.5 border rounded-xl text-sm"
          >
            <option value="CA01">CA01 - Ca Sáng</option>
            <option value="CA02">CA02 - Ca Chiều</option>
            <option value="CA03">CA03 - Ca Tối</option>
          </select>
          <input
            type="date"
            required
            value={phanCaForm.ngayLam}
            onChange={(e) => setPhanCaForm({ ...phanCaForm, ngayLam: e.target.value })}
            className="px-3 py-2.5 border rounded-xl text-sm"
          />
          <button
            type="submit"
            className="bg-amber-700 hover:bg-amber-800 text-white font-semibold rounded-xl text-sm py-2.5 cursor-pointer"
          >
            + Xếp ca làm việc
          </button>
        </div>
      </form>

      {/* Bảng tính lương tự động */}
      <div className="bg-white p-5 rounded-2xl shadow-sm space-y-4">
        <form onSubmit={handleTinhLuong} className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Tháng</label>
            <input
              type="number"
              min="1"
              max="12"
              value={luongParams.thang}
              onChange={(e) => setLuongParams({ ...luongParams, thang: e.target.value })}
              className="px-3 py-2 border rounded-xl text-sm w-24"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Năm</label>
            <input
              type="number"
              value={luongParams.nam}
              onChange={(e) => setLuongParams({ ...luongParams, nam: e.target.value })}
              className="px-3 py-2 border rounded-xl text-sm w-28"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Đơn giá / giờ (VND)</label>
            <input
              type="number"
              value={luongParams.donGiaGio}
              onChange={(e) => setLuongParams({ ...luongParams, donGiaGio: e.target.value })}
              className="px-3 py-2 border rounded-xl text-sm w-40"
            />
          </div>
          <button
            type="submit"
            className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl text-sm cursor-pointer"
          >
            Tính lương tự động
          </button>
        </form>

        <table className="w-full text-sm text-left">
          <thead className="bg-gray-50 text-xs uppercase text-gray-600">
            <tr>
              <th className="p-3">Mã NV</th>
              <th className="p-3">Họ tên nhân viên</th>
              <th className="p-3 text-right">Tổng giờ làm thực tế</th>
              <th className="p-3 text-right">Tổng lương nhận</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {bangLuong.map((nv) => (
              <tr key={nv.maNV}>
                <td className="p-3 font-mono text-xs">{nv.maNV}</td>
                <td className="p-3 font-bold">{nv.tenNV}</td>
                <td className="p-3 text-right">{nv.tongSoGio.toFixed(2)} giờ</td>
                <td className="p-3 text-right font-bold text-emerald-700">
                  {formatVND(nv.tongLuong)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}