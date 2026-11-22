import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { sanPhamService } from '../../services/sanPhamService'
import { khoService } from '../../services/khoService'
import { useAuthStore } from '../../store/authStore'
import FeatureLockedCard from '../../components/FeatureLockedCard'
import { hasFeatureFlag } from '../../utils/featureFlags'
import { formatVND } from '../../utils/format'
import AiMenuImporterModal from './components/AiMenuImporterModal'

const TRAM_KDS_OPTIONS = [
  { value: 'BAR_CHINH', label: '☕ Bar Chính (Espresso / Cà phê)' },
  { value: 'BAR_LANH', label: '🧋 Bar Lạnh (Trà / Đá xay)' },
  { value: 'BEP_BANH', label: '🥐 Bếp & Bánh ngọt' },
]

const TRAM_KDS_BADGE = {
  BAR_CHINH: { text: '☕ Bar Chính', cls: 'bg-amber-100 text-amber-900' },
  BAR_LANH: { text: '🧋 Bar Lạnh', cls: 'bg-sky-100 text-sky-900' },
  BEP_BANH: { text: '🥐 Bếp Bánh', cls: 'bg-orange-100 text-orange-900' },
}

const DEFAULT_FORM = {
  maMon: '',
  tenMon: '',
  nhomMon: 'Cà phê',
  tramCheBien: 'BAR_CHINH',
  giaGoc: 25000,
  giaS: 25000,
  giaM: 30000,
  giaL: 35000,
}

export default function ThucDon() {
  const { user } = useAuthStore()
  const allowInventoryBom = hasFeatureFlag(user, 'inventory_bom')
  const allowAiMenu = hasFeatureFlag(user, 'ai_menu_importer')
  const [menu, setMenu] = useState([])
  const [nguyenLieuList, setNguyenLieuList] = useState([])
  const [toppingList, setToppingList] = useState([])
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(DEFAULT_FORM)

  // Modal Định lượng Công thức (BOM) theo Size S/M/L
  const [bomProduct, setBomProduct] = useState(null)
  const [bomSize, setBomSize] = useState('M')
  const [bomBySize, setBomBySize] = useState({ S: [], M: [], L: [] })
  const [savingBom, setSavingBom] = useState(false)
  const [showAiImporter, setShowAiImporter] = useState(false)

  // Quản lý Topping & Định lượng BOM Topping đa nguyên liệu
  const [newTpForm, setNewTpForm] = useState({ maTopping: '', tenTopping: '', giaTopping: 10000 })
  const [bomTopping, setBomTopping] = useState(null)
  const [tpBomRows, setTpBomRows] = useState([])
  const [savingTpBom, setSavingTpBom] = useState(false)

  const loadMenu = async () => {
    try {
      const [ds, nl, tps] = await Promise.all([
        sanPhamService.getQuanLy(),
        khoService.getAllNguyenLieu().catch(() => []),
        sanPhamService.getToppingQuanLy().catch(() => []),
      ])
      setMenu(ds)
      setNguyenLieuList(nl)
      setToppingList(Array.isArray(tps) ? tps : [])
    } catch {
      // Interceptor xử lý
    }
  }

  useEffect(() => {
    const t = setTimeout(() => {
      void loadMenu()
    }, 0)
    return () => clearTimeout(t)
  }, [])

  const handleSave = async (e) => {
    e.preventDefault()
    const payload = {
      maMon: form.maMon.trim(),
      tenMon: form.tenMon.trim(),
      nhomMon: form.nhomMon.trim(),
      tramCheBien: form.tramCheBien || 'BAR_CHINH',
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
        toast.success('Đã cập nhật món (và mở kinh doanh) thành công')
      } else {
        await sanPhamService.create(payload)
        toast.success('Đã thêm món mới thành công')
      }
      setEditing(null)
      setForm(DEFAULT_FORM)
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
      tramCheBien: item.tramCheBien || 'BAR_CHINH',
      giaGoc: item.giaGoc ?? findPrice('S') ?? 25000,
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

  const handleToggle86 = async (item) => {
    try {
      const res = await sanPhamService.setTamHet(item.maMon, !item.tamHet)
      toast.success(res.message)
      loadMenu()
    } catch {
      // Interceptor xử lý
    }
  }

  const handleCreateTopping = async (e) => {
    e.preventDefault()
    try {
      const res = await sanPhamService.createTopping({
        maTopping: newTpForm.maTopping.trim(),
        tenTopping: newTpForm.tenTopping.trim(),
        giaTopping: Number(newTpForm.giaTopping || 0),
      })
      toast.success(res.message)
      setNewTpForm({ maTopping: '', tenTopping: '', giaTopping: 10000 })
      loadMenu()
    } catch {
      // Interceptor xử lý
    }
  }

  const handleToggleTopping86 = async (tp) => {
    try {
      const res = await sanPhamService.setToppingTamHet(tp.maTopping, !tp.tamHet)
      toast.success(res.message)
      loadMenu()
    } catch {
      // Interceptor xử lý
    }
  }

  const openToppingBomModal = (tp) => {
    setBomTopping(tp)
    setTpBomRows(tp.congThuc?.length ? tp.congThuc.map((c) => ({ ...c })) : [])
  }

  const addTpBomRow = () => {
    const firstNL = nguyenLieuList[0]
    if (!firstNL) {
      toast.error('Kho chưa có nguyên liệu nào! Hãy tạo nguyên liệu trong trang Kho trước.')
      return
    }
    setTpBomRows((prev) => [
      ...prev,
      {
        maNL: firstNL.maNL,
        tenNL: firstNL.tenNL,
        donViTinh: firstNL.donViTinh,
        khoiLuongTieuHao: 20,
        giaVonDonVi: firstNL.giaVonDonVi || 0,
      },
    ])
  }

  const handleSaveToppingBom = async () => {
    if (!bomTopping) return
    setSavingTpBom(true)
    try {
      const res = await sanPhamService.saveToppingCongThuc(
        bomTopping.maTopping,
        tpBomRows
          .filter((r) => r.maNL && Number(r.khoiLuongTieuHao) > 0)
          .map((r) => ({ maNL: r.maNL, khoiLuongTieuHao: Number(r.khoiLuongTieuHao) }))
      )
      toast.success(res.message)
      setBomTopping(null)
      loadMenu()
    } catch {
      // Interceptor xử lý
    } finally {
      setSavingTpBom(false)
    }
  }

  // Mở Modal Định lượng Công thức (BOM)
  const openBomModal = async (item) => {
    setBomProduct(item)
    setBomSize('M')
    try {
      const res = await sanPhamService.getCongThuc(item.maMon)
      setBomBySize(res.congThuc || { S: [], M: [], L: [] })
    } catch {
      setBomBySize({ S: [], M: [], L: [] })
    }
  }

  const currentBomRows = bomBySize[bomSize] || []

  const addBomRow = () => {
    const firstNL = nguyenLieuList[0]
    if (!firstNL) {
      toast.error('Kho chưa có nguyên liệu nào! Hãy tạo nguyên liệu trong trang Kho trước.')
      return
    }
    setBomBySize((prev) => ({
      ...prev,
      [bomSize]: [
        ...(prev[bomSize] || []),
        {
          maNL: firstNL.maNL,
          tenNL: firstNL.tenNL,
          donViTinh: firstNL.donViTinh,
          khoiLuongTieuHao: 10,
          giaVonDonVi: firstNL.giaVonDonVi || 0,
        },
      ],
    }))
  }

  const updateBomRow = (idx, field, val) => {
    setBomBySize((prev) => ({
      ...prev,
      [bomSize]: (prev[bomSize] || []).map((r, i) => {
        if (i !== idx) return r
        if (field === 'maNL') {
          const nl = nguyenLieuList.find((x) => x.maNL === val)
          return {
            ...r,
            maNL: val,
            tenNL: nl?.tenNL || val,
            donViTinh: nl?.donViTinh || '',
            giaVonDonVi: nl?.giaVonDonVi || 0,
          }
        }
        return { ...r, [field]: val }
      }),
    }))
  }

  const removeBomRow = (idx) => {
    setBomBySize((prev) => ({
      ...prev,
      [bomSize]: (prev[bomSize] || []).filter((_, i) => i !== idx),
    }))
  }

  const saveBomForCurrentSize = async () => {
    if (!bomProduct) return
    const valid = currentBomRows.filter((r) => r.maNL && Number(r.khoiLuongTieuHao) > 0)
    if (valid.length === 0) {
      toast.error('Cần ít nhất 1 nguyên liệu có định lượng > 0!')
      return
    }
    setSavingBom(true)
    try {
      await sanPhamService.saveCongThuc({
        maMon: bomProduct.maMon,
        kichThuoc: bomSize,
        dinhMuc: valid.map((r) => ({
          maNL: r.maNL,
          khoiLuongTieuHao: Number(r.khoiLuongTieuHao),
        })),
      })
      toast.success(`Đã lưu định lượng ${bomProduct.tenMon} (Size ${bomSize})!`)
    } catch {
      // Interceptor xử lý
    } finally {
      setSavingBom(false)
    }
  }

  const giaBanSizeDangChon =
    bomProduct?.sizes?.find((s) => s.kichThuoc === bomSize)?.giaBan || 0
  const giaVonDuKien = currentBomRows.reduce(
    (s, r) => s + Number(r.khoiLuongTieuHao || 0) * Number(r.giaVonDonVi || 0),
    0
  )
  const bienLaiGop =
    giaBanSizeDangChon > 0
      ? Math.round(((giaBanSizeDangChon - giaVonDuKien) / giaBanSizeDangChon) * 1000) / 10
      : 0

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-800">
          ☕ Quản lý Thực đơn, Bảng giá Size & Định lượng BOM
        </h1>
        <button
          type="button"
          onClick={() => {
            if (!allowAiMenu) {
              toast.error('Tính năng AI Menu Importer đang bị tắt ở gói hiện tại!')
              return
            }
            setShowAiImporter(true)
          }}
          className={`px-4 py-2.5 rounded-xl text-xs font-extrabold shadow-md cursor-pointer ${
            allowAiMenu
              ? 'bg-gradient-to-r from-amber-700 to-orange-600 hover:from-amber-800 hover:to-orange-700 text-white'
              : 'bg-gray-200 text-gray-500'
          }`}
        >
          {allowAiMenu ? '✨ AI Menu Importer (Ảnh / Zalo / CSV)' : '🔒 AI Menu Importer (Đang khóa)'}
        </button>
      </div>

      {!allowInventoryBom && (
        <FeatureLockedCard
          compact
          title="Chỉnh sửa Định lượng BOM Món & BOM Topping"
          description="Gói hiện tại đang khóa cấu hình công thức trừ kho định lượng (BOM). Nâng cấp lên gói PRO để thiết lập định lượng & giá vốn WAC."
          requiredPlan="PRO"
          currentPlan={user?.goiCuoc || 'STARTER'}
        />
      )}

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
            onChange={(e) => setForm({ ...form, giaS: e.target.value })}
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-gray-600">Giá Size L:</label>
              <input
                type="number"
                value={form.giaL}
                onChange={(e) => setForm({ ...form, giaL: e.target.value })}
                className="px-3 py-1.5 border rounded-xl text-sm w-28"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-gray-600">Giá gốc:</label>
              <input
                type="number"
                value={form.giaGoc}
                onChange={(e) => setForm({ ...form, giaGoc: e.target.value })}
                className="px-3 py-1.5 border rounded-xl text-sm w-28"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-gray-600">📍 Trạm KDS:</label>
              <select
                value={form.tramCheBien || 'BAR_CHINH'}
                onChange={(e) => setForm({ ...form, tramCheBien: e.target.value })}
                className="px-3 py-1.5 border rounded-xl text-xs font-bold bg-white"
              >
                {TRAM_KDS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            {editing && (
              <button
                type="button"
                onClick={() => {
                  setEditing(null)
                  setForm(DEFAULT_FORM)
                }}
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

      <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="bg-gray-50 text-xs uppercase text-gray-600">
            <tr>
              <th className="p-3">Mã</th>
              <th className="p-3">Tên món</th>
              <th className="p-3">Trạng thái</th>
              <th className="p-3">Bảng giá theo Size</th>
              <th className="p-3 text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {menu.map((item) => (
              <tr key={item.maMon} className={`hover:bg-gray-50 ${!item.dangKinhDoanh ? 'opacity-60' : ''}`}>
                <td className="p-3 font-mono text-xs">{item.maMon}</td>
                <td className="p-3">
                  <p className="font-bold text-gray-800">{item.tenMon}</p>
                  <p className="text-xs text-gray-400 flex items-center gap-1.5 mt-0.5">
                    <span>{item.nhomMon}</span>
                    {TRAM_KDS_BADGE[item.tramCheBien] && (
                      <span
                        className={`px-1.5 py-0.5 rounded font-bold text-[10px] ${
                          TRAM_KDS_BADGE[item.tramCheBien].cls
                        }`}
                      >
                        {TRAM_KDS_BADGE[item.tramCheBien].text}
                      </span>
                    )}
                  </p>
                </td>
                <td className="p-3 text-xs space-x-1">
                  {!item.dangKinhDoanh ? (
                    <span className="px-2 py-0.5 rounded-full bg-gray-200 text-gray-700 font-bold">
                      Ngừng bán
                    </span>
                  ) : item.tamHet ? (
                    <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-bold">
                      Tạm hết (86)
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-bold">
                      Đang bán
                    </span>
                  )}
                </td>
                <td className="p-3 space-x-1.5">
                  {item.sizes?.map((s) => (
                    <span
                      key={s.kichThuoc}
                      className="inline-block px-2 py-1 bg-amber-50 text-amber-900 rounded-lg text-xs font-semibold"
                    >
                      {s.kichThuoc}: {formatVND(s.giaBan)}
                    </span>
                  ))}
                </td>
                <td className="p-3 text-right space-x-1.5 whitespace-nowrap">
                  <button
                    onClick={() => openBomModal(item)}
                    className="px-3 py-1.5 bg-amber-100 text-amber-900 rounded-lg text-xs font-bold cursor-pointer"
                  >
                    🧪 Định lượng
                  </button>
                  {item.dangKinhDoanh && (
                    <button
                      onClick={() => handleToggle86(item)}
                      className="min-h-11 px-3.5 py-2 bg-orange-50 hover:bg-orange-100 text-orange-700 rounded-xl text-xs font-bold cursor-pointer"
                    >
                      {item.tamHet ? 'Mở lại' : 'Báo hết'}
                    </button>
                  )}
                  <button
                    onClick={() => handleEditClick(item)}
                    className="min-h-11 px-3.5 py-2 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-xl text-xs font-bold cursor-pointer"
                  >
                    {item.dangKinhDoanh ? 'Sửa' : 'Mở bán lại'}
                  </button>
                  {item.dangKinhDoanh && (
                    <button
                      onClick={() => handleDelete(item.maMon)}
                      className="min-h-11 px-3.5 py-2 bg-red-50 hover:bg-red-100 text-red-700 rounded-xl text-xs font-bold cursor-pointer"
                    >
                      Ngừng bán
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Khu vực Quản lý Topping & Định lượng Công thức đa nguyên liệu (Topping_CongThuc) */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-4">
        <div>
          <h3 className="font-extrabold text-base text-gray-800">
            🧋 Quản Lý Topping &amp; Định Lượng BOM Topping (Trà Sữa / Cafe)
          </h3>
          <p className="text-xs text-gray-500">
            Khai báo nhiều nguyên liệu cho mỗi phần Topping (VD: Kem Cheese = Kem béo + Sữa tươi + Muối) để tự trừ kho &amp; tính đúng giá vốn COGS
          </p>
        </div>

        <form onSubmit={handleCreateTopping} className="grid grid-cols-1 md:grid-cols-4 gap-2.5 text-xs">
          <input
            type="text"
            required
            placeholder="Mã Topping (VD: TP_KEMCHEESE)"
            value={newTpForm.maTopping}
            onChange={(e) => setNewTpForm({ ...newTpForm, maTopping: e.target.value.toUpperCase() })}
            className="px-3 py-2 border rounded-xl font-mono"
          />
          <input
            type="text"
            required
            placeholder="Tên Topping (VD: Kem Cheese Muối Biển)"
            value={newTpForm.tenTopping}
            onChange={(e) => setNewTpForm({ ...newTpForm, tenTopping: e.target.value })}
            className="px-3 py-2 border rounded-xl"
          />
          <input
            type="number"
            min="0"
            step="1000"
            required
            placeholder="Giá bán (VNĐ)"
            value={newTpForm.giaTopping}
            onChange={(e) => setNewTpForm({ ...newTpForm, giaTopping: e.target.value })}
            className="px-3 py-2 border rounded-xl font-bold"
          />
          <button
            type="submit"
            className="bg-amber-700 hover:bg-amber-800 text-white font-bold rounded-xl py-2 cursor-pointer"
          >
            + Thêm Topping mới
          </button>
        </form>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-gray-50 text-gray-600 uppercase">
              <tr>
                <th className="p-2.5">Topping</th>
                <th className="p-2.5">Trạng thái</th>
                <th className="p-2.5 text-right">Giá bán</th>
                <th className="p-2.5 text-right">Giá vốn BOM</th>
                <th className="p-2.5 text-right">Lãi gộp</th>
                <th className="p-2.5">Công thức trừ kho</th>
                <th className="p-2.5 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {toppingList.map((tp) => (
                <tr key={tp.maTopping} className="hover:bg-gray-50">
                  <td className="p-2.5">
                    <p className="font-bold text-gray-800">{tp.tenTopping}</p>
                    <p className="font-mono text-[10px] text-gray-400">{tp.maTopping}</p>
                  </td>
                  <td className="p-2.5">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        tp.tamHet ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
                      }`}
                    >
                      {tp.tamHet ? 'Tạm hết (86)' : 'Đang bán'}
                    </span>
                  </td>
                  <td className="p-2.5 text-right font-bold text-amber-800">{formatVND(tp.giaTopping)}</td>
                  <td className="p-2.5 text-right font-semibold text-stone-700">{formatVND(tp.giaVon)}</td>
                  <td className="p-2.5 text-right font-bold text-emerald-700">{tp.tySuatLoiNhuan}%</td>
                  <td className="p-2.5 text-gray-600">
                    {tp.congThuc?.length ? (
                      tp.congThuc.map((c) => `${c.tenNL}: ${c.khoiLuongTieuHao}${c.donViTinh}`).join(', ')
                    ) : (
                      <span className="text-amber-700 italic">Chưa khai báo BOM</span>
                    )}
                  </td>
                  <td className="p-2.5 text-right space-x-1.5 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => openToppingBomModal(tp)}
                      className="px-2.5 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-900 rounded-lg font-bold cursor-pointer"
                    >
                      🧪 BOM Topping
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleTopping86(tp)}
                      className="px-2.5 py-1.5 bg-orange-50 hover:bg-orange-100 text-orange-700 rounded-lg font-semibold cursor-pointer"
                    >
                      {tp.tamHet ? 'Mở lại' : 'Báo hết'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal Định lượng Công thức BOM cho Topping */}
      {bomTopping && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-xl w-full p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto text-xs">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <h3 className="font-extrabold text-base text-gray-800">
                  🧪 Định lượng BOM Topping: {bomTopping.tenTopping}
                </h3>
                <p className="text-gray-500">
                  Giá bán: <b>{formatVND(bomTopping.giaTopping)}</b> • Giá vốn dự kiến:{' '}
                  <b className="text-amber-800">
                    {formatVND(
                      Math.round(
                        tpBomRows.reduce(
                          (s, r) => s + Number(r.khoiLuongTieuHao || 0) * Number(r.giaVonDonVi || 0),
                          0
                        )
                      )
                    )}
                  </b>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setBomTopping(null)}
                className="w-9 h-9 rounded-full bg-gray-100 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={addTpBomRow}
                className="px-3 py-1.5 rounded-xl bg-stone-100 hover:bg-stone-200 font-bold text-stone-800 cursor-pointer"
              >
                + Thêm nguyên liệu
              </button>
            </div>

            <div className="space-y-2">
              {tpBomRows.length === 0 ? (
                <p className="py-6 text-center text-gray-400 italic border rounded-xl">
                  Chưa có nguyên liệu nào cho topping này — bấm &ldquo;+ Thêm nguyên liệu&rdquo; ở trên.
                </p>
              ) : (
                tpBomRows.map((row, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-center bg-gray-50 p-2 rounded-xl">
                    <select
                      value={row.maNL}
                      onChange={(e) => {
                        const nl = nguyenLieuList.find((x) => x.maNL === e.target.value)
                        setTpBomRows((prev) =>
                          prev.map((r, i) =>
                            i === idx
                              ? {
                                  ...r,
                                  maNL: e.target.value,
                                  tenNL: nl?.tenNL || e.target.value,
                                  donViTinh: nl?.donViTinh || '',
                                  giaVonDonVi: nl?.giaVonDonVi || 0,
                                }
                              : r
                          )
                        )
                      }}
                      className="col-span-6 px-2.5 py-2 bg-white border rounded-xl font-semibold"
                    >
                      {nguyenLieuList.map((nl) => (
                        <option key={nl.maNL} value={nl.maNL}>
                          {nl.tenNL} ({nl.donViTinh})
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      step="any"
                      min="0.01"
                      value={row.khoiLuongTieuHao}
                      onChange={(e) =>
                        setTpBomRows((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, khoiLuongTieuHao: e.target.value } : r))
                        )
                      }
                      className="col-span-3 px-2.5 py-2 bg-white border rounded-xl font-bold"
                    />
                    <span className="col-span-2 text-gray-500 font-semibold">{row.donViTinh}</span>
                    <button
                      type="button"
                      onClick={() => setTpBomRows((prev) => prev.filter((_, i) => i !== idx))}
                      className="col-span-1 text-red-600 font-bold cursor-pointer"
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="flex gap-2 pt-2 border-t">
              <button
                type="button"
                onClick={() => setBomTopping(null)}
                className="flex-1 py-2.5 border rounded-xl font-bold cursor-pointer"
              >
                Đóng
              </button>
              <button
                type="button"
                disabled={savingTpBom}
                onClick={handleSaveToppingBom}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-extrabold cursor-pointer"
              >
                {savingTpBom ? 'Đang lưu...' : '💾 Lưu BOM Topping'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Thiết lập Công thức Định lượng (BOM) theo Size */}
      {bomProduct && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <h3 className="font-extrabold text-base text-gray-800">
                  🧪 Định lượng Công thức (BOM): {bomProduct.tenMon}
                </h3>
                <p className="text-xs text-gray-500">
                  Tự động trừ kho & tính Giá vốn (COGS) chính xác cho từng ly bán ra
                </p>
              </div>
              <button
                onClick={() => setBomProduct(null)}
                className="w-9 h-9 rounded-full bg-gray-100 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="flex items-center justify-between gap-2">
              <div className="flex gap-2">
                {['S', 'M', 'L'].map((sz) => (
                  <button
                    key={sz}
                    type="button"
                    onClick={() => setBomSize(sz)}
                    className={`px-4 py-2 rounded-xl text-xs font-bold cursor-pointer ${
                      bomSize === sz
                        ? 'bg-amber-700 text-white shadow-sm'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    Size {sz} ({bomBySize[sz]?.length || 0} NL)
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={addBomRow}
                className="px-3.5 py-2 bg-stone-800 text-white rounded-xl text-xs font-bold cursor-pointer"
              >
                + Thêm nguyên liệu
              </button>
            </div>

            <div className="space-y-2">
              {currentBomRows.length === 0 ? (
                <p className="text-center text-xs text-gray-400 py-6 border border-dashed rounded-xl">
                  Chưa có công thức cho Size {bomSize}. Bấm &ldquo;+ Thêm nguyên liệu&rdquo; để thiết lập.
                </p>
              ) : (
                currentBomRows.map((row, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-12 gap-2 items-center bg-stone-50 p-2.5 rounded-xl text-xs"
                  >
                    <select
                      value={row.maNL}
                      onChange={(e) => updateBomRow(idx, 'maNL', e.target.value)}
                      className="col-span-5 px-2.5 py-2 bg-white border rounded-lg font-medium"
                    >
                      {nguyenLieuList.map((nl) => (
                        <option key={nl.maNL} value={nl.maNL}>
                          {nl.tenNL} ({nl.donViTinh}) — {formatVND(nl.giaVonDonVi)}/{nl.donViTinh}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={row.khoiLuongTieuHao}
                      onChange={(e) => updateBomRow(idx, 'khoiLuongTieuHao', e.target.value)}
                      className="col-span-3 px-2.5 py-2 bg-white border rounded-lg font-bold"
                      placeholder="Định lượng..."
                    />
                    <span className="col-span-3 text-right font-bold text-amber-800">
                      {formatVND(Number(row.khoiLuongTieuHao || 0) * Number(row.giaVonDonVi || 0))}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeBomRow(idx)}
                      className="col-span-1 text-red-600 font-bold cursor-pointer"
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Bảng phân tích Giá vốn & Lãi gộp ngay lập tức */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 grid grid-cols-3 gap-3 text-xs">
              <div>
                <p className="text-gray-500">Giá bán Size {bomSize}</p>
                <p className="font-extrabold text-sm text-gray-900">{formatVND(giaBanSizeDangChon)}</p>
              </div>
              <div>
                <p className="text-gray-500">Giá vốn ước tính (WAC)</p>
                <p className="font-extrabold text-sm text-amber-900">{formatVND(giaVonDuKien)}</p>
              </div>
              <div>
                <p className="text-gray-500">Tỷ suất lãi gộp</p>
                <p
                  className={`font-extrabold text-sm ${
                    bienLaiGop >= 60 ? 'text-emerald-700' : 'text-red-600'
                  }`}
                >
                  {bienLaiGop}%
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setBomProduct(null)}
                className="px-4 py-2 border rounded-xl text-xs font-bold cursor-pointer"
              >
                Đóng
              </button>
              <button
                type="button"
                disabled={savingBom}
                onClick={saveBomForCurrentSize}
                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold shadow cursor-pointer disabled:opacity-50"
              >
                {savingBom ? 'Đang lưu...' : `💾 Lưu Công thức Size ${bomSize}`}
              </button>
            </div>
          </div>
        </div>
      )}

      <AiMenuImporterModal
        isOpen={showAiImporter}
        onClose={() => setShowAiImporter(false)}
        onImported={loadMenu}
      />
    </div>
  )
}
