import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { sanPhamService } from '../../services/sanPhamService'
import { formatVND } from '../../utils/format'

export default function ThucDon() {
  const [menu, setMenu] = useState([])
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({
    maMon: '',
    tenMon: '',
    nhomMon: 'Cà phê',
    giaGoc: 25000,
    giaS: 25000,
    giaM: 30000,
    giaL: 35000,
  })

  const loadMenu = async () => {
    try {
      setMenu(await sanPhamService.getMenu())
    } catch {
      // Interceptor xử lý
    }
  }

  useEffect(() => {
    loadMenu()
  }, [])

  const handleSave = async (e) => {
    e.preventDefault()
    const payload = {
      maMon: form.maMon.trim(),
      tenMon: form.tenMon.trim(),
      nhomMon: form.nhomMon.trim(),
      giaGoc: Number(form.giaGoc),
      sizes: [
        { kichThuoc: 'S', giaBan: Number(form.giaS) },
        { kichThuoc: 'M', giaBan: Number(form.giaM) },
        { kichThuoc: 'L', giaBan: Number(form.giaL) },
      ],
    }

    try {
      if (editing) {
        await sanPhamService.update(editing, payload)
        toast.success('Đã cập nhật món thành công')
      } else {
        await sanPhamService.create(payload)
        toast.success('Đã thêm món mới thành công')
      }
      setEditing(null)
      setForm({ maMon: '', tenMon: '', nhomMon: 'Cà phê', giaGoc: 25000, giaS: 25000, giaM: 30000, giaL: 35000 })
      loadMenu()
    } catch {
      // Interceptor xử lý
    }
  }

  const handleEditClick = (item) => {
    setEditing(item.maMon)
    const findPrice = (sz) => item.sizes?.find((s) => s.kichThuoc === sz)?.giaBan || 0
    setForm({
      maMon: item.maMon,
      tenMon: item.tenMon,
      nhomMon: item.nhomMon || 'Cà phê',
      giaGoc: findPrice('S') || 25000,
      giaS: findPrice('S'),
      giaM: findPrice('M'),
      giaL: findPrice('L'),
    })
  }

  const handleDelete = async (maMon) => {
    if (!window.confirm(`Ngừng kinh doanh món ${maMon}?`)) return
    try {
      await sanPhamService.remove(maMon)
      toast.success('Đã chuyển trạng thái ngừng kinh doanh')
      loadMenu()
    } catch {
      // Interceptor xử lý
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">☕ Quản lý Thực đơn & Bảng giá Size</h1>

      <form onSubmit={handleSave} className="bg-white p-5 rounded-2xl shadow-sm space-y-4">
        <h3 className="font-bold text-gray-700">
          {editing ? `Đang sửa món: ${editing}` : 'Thêm món mới vào thực đơn'}
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <input
            type="text"
            required
            disabled={Boolean(editing)}
            placeholder="Mã món (VD: CF01)"
            value={form.maMon}
            onChange={(e) => setForm({ ...form, maMon: e.target.value })}
            className="px-3 py-2 border rounded-xl text-sm disabled:bg-gray-100"
          />
          <input
            type="text"
            required
            placeholder="Tên món..."
            value={form.tenMon}
            onChange={(e) => setForm({ ...form, tenMon: e.target.value })}
            className="px-3 py-2 border rounded-xl text-sm md:col-span-2"
          />
          <input
            type="text"
            placeholder="Nhóm món (Cà phê, Trà...)"
            value={form.nhomMon}
            onChange={(e) => setForm({ ...form, nhomMon: e.target.value })}
            className="px-3 py-2 border rounded-xl text-sm"
          />
          <input
            type="number"
            placeholder="Giá Size S"
            value={form.giaS}
            onChange={(e) => setForm({ ...form, giaS: e.target.value, giaGoc: e.target.value })}
            className="px-3 py-2 border rounded-xl text-sm"
          />
          <input
            type="number"
            placeholder="Giá Size M"
            value={form.giaM}
            onChange={(e) => setForm({ ...form, giaM: e.target.value })}
            className="px-3 py-2 border rounded-xl text-sm"
          />
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-gray-600">Giá Size L:</label>
            <input
              type="number"
              value={form.giaL}
              onChange={(e) => setForm({ ...form, giaL: e.target.value })}
              className="px-3 py-1.5 border rounded-xl text-sm w-36"
            />
          </div>
          <div className="flex gap-2">
            {editing && (
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="px-4 py-2 border rounded-xl text-sm cursor-pointer"
              >
                Hủy sửa
              </button>
            )}
            <button
              type="submit"
              className="px-5 py-2 bg-amber-700 hover:bg-amber-800 text-white font-semibold rounded-xl text-sm cursor-pointer"
            >
              {editing ? 'Cập nhật món' : '+ Thêm món'}
            </button>
          </div>
        </div>
      </form>

      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        <table className="w-full text-sm text-left">
          <thead className="bg-gray-50 text-xs uppercase text-gray-600">
            <tr>
              <th className="p-3">Mã</th>
              <th className="p-3">Tên món</th>
              <th className="p-3">Nhóm</th>
              <th className="p-3">Bảng giá theo Size</th>
              <th className="p-3 text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {menu.map((item) => (
              <tr key={item.maMon} className="hover:bg-gray-50">
                <td className="p-3 font-mono text-xs">{item.maMon}</td>
                <td className="p-3 font-bold text-gray-800">{item.tenMon}</td>
                <td className="p-3">{item.nhomMon}</td>
                <td className="p-3 space-x-2">
                  {item.sizes?.map((s) => (
                    <span
                      key={s.kichThuoc}
                      className="inline-block px-2.5 py-1 bg-amber-50 text-amber-900 rounded-lg text-xs font-semibold"
                    >
                      {s.kichThuoc}: {formatVND(s.giaBan)}
                    </span>
                  ))}
                </td>
                <td className="p-3 text-right space-x-2">
                  <button
                    onClick={() => handleEditClick(item)}
                    className="px-3 py-1 bg-blue-50 text-blue-700 rounded-lg text-xs font-semibold cursor-pointer"
                  >
                    Sửa
                  </button>
                  <button
                    onClick={() => handleDelete(item.maMon)}
                    className="px-3 py-1 bg-red-50 text-red-700 rounded-lg text-xs font-semibold cursor-pointer"
                  >
                    Ngừng bán
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}