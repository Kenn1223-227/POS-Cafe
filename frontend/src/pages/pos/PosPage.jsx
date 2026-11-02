import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { banService } from '../../services/banService'
import { sanPhamService } from '../../services/sanPhamService'
import { orderService } from '../../services/orderService'
import { caService } from '../../services/caService'
import { useAuthStore } from '../../store/authStore'
import { usePosStore } from '../../store/posStore'
import { useSocketEvents } from '../../socket/useSocketEvents'
import { ROLES } from '../../constants/roles'
import TableMap from './components/TableMap'
import MenuGrid from './components/MenuGrid'
import ToppingModal from './components/ToppingModal'
import CustomerBox from './components/CustomerBox'
import Cart from './components/Cart'
import ThuChiModal from './components/ThuChiModal'
import { formatVND, formatDateTime } from '../../utils/format'

export default function PosPage() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()

  const {
    selectedTable,
    activeInvoice,
    customer,
    cart,
    currentShift,
    setCurrentShift,
    setSelectedTable,
    setActiveInvoice,
    setCustomer,
    addToCart,
    updateCartQty,
    updateCartNote,
    removeFromCart,
    clearCart,
  } = usePosStore()

  const [tables, setTables] = useState([])
  const [menu, setMenu] = useState([])
  const [toppings, setToppings] = useState([])
  const [pickingProduct, setPickingProduct] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [paying, setPaying] = useState(false)
  const [tienDauCaInput, setTienDauCaInput] = useState('500000')
  const [openingShift, setOpeningShift] = useState(false)

  const [showThuChiModal, setShowThuChiModal] = useState(false)
  const [showDongCaModal, setShowDongCaModal] = useState(false)
  const [tienThucTeInput, setTienThucTeInput] = useState('')
  const [closingShift, setClosingShift] = useState(false)

  const loadPosData = useCallback(async () => {
    try {
      const [banList, menuList, toppingList, shift] = await Promise.all([
        banService.getAll(),
        sanPhamService.getMenu(),
        orderService.getToppings(),
        caService.getCaHienTai(),
      ])
      setTables(banList)
      setMenu(menuList)
      setToppings(toppingList)
      setCurrentShift(shift)
    } catch {
      // Interceptor xử lý
    }
  }, [setCurrentShift])

  useEffect(() => {
    loadPosData()
  }, [loadPosData])

  useSocketEvents({
    BAN_THAY_DOI: ({ maBan, trangThai }) => {
      setTables((prev) => prev.map((b) => (b.maBan === maBan ? { ...b, trangThai } : b)))
    },
  })

  const handleSelectTable = async (ban) => {
    setSelectedTable(ban)
    if (!ban) return
    try {
      const hd = await orderService.getByTable(ban.maBan)
      setActiveInvoice(hd)
    } catch {
      setActiveInvoice(null)
    }
  }

  const handleOpenShift = async (e) => {
    e.preventDefault()
    setOpeningShift(true)
    try {
      await caService.moCa(Number(tienDauCaInput || 0))
      toast.success('Đã mở ca thu ngân thành công!')
      const shift = await caService.getCaHienTai()
      setCurrentShift(shift)
    } catch {
      // Interceptor xử lý
    } finally {
      setOpeningShift(false)
    }
  }

  const handleCloseShift = async (e) => {
    e.preventDefault()
    if (tienThucTeInput === '' || Number(tienThucTeInput) < 0) {
      toast.error('Vui lòng nhập số tiền mặt kiểm đếm thực tế hợp lệ (>= 0)!')
      return
    }
    if (!window.confirm('Bạn có chắc chắn muốn chốt và đóng ca làm việc này?')) return

    setClosingShift(true)
    try {
      const res = await caService.dongCa(Number(tienThucTeInput))
      toast.success(res.message || 'Đã chốt và đóng ca thành công!')
      setShowDongCaModal(false)
      setTienThucTeInput('')
      setCurrentShift(null)
      await loadPosData()
    } catch {
      // Interceptor xử lý
    } finally {
      setClosingShift(false)
    }
  }

  const handleSubmitOrder = async () => {
    if (cart.length === 0) return
    if (!currentShift) {
      toast.error('Bạn cần mở ca thu ngân trên thanh công cụ trước khi tạo đơn!')
      return
    }

    setSubmitting(true)
    try {
      const payload = {
        maBan: selectedTable?.maBan || null,
        maKH: customer?.maKH || null,
        danhSachMon: cart.map((item) => ({
          maMon: item.maMon,
          kichThuoc: item.kichThuoc,
          soLuong: Number(item.soLuong),
          ghiChu: item.ghiChu || null,
          toppings: (item.toppings || []).map((t) => ({
            maTopping: t.maTopping,
            soLuong: Number(t.soLuong || 1),
          })),
        })),
      }

      const res = await orderService.create(payload)
      toast.success(res.message || `Đã tạo order #${res.maHoaDon}`)
      clearCart()
      setActiveInvoice(res.hoaDon)

      if (selectedTable?.maBan) {
        setTables((prev) => prev.map((b) => (b.maBan === selectedTable.maBan ? { ...b, trangThai: 2 } : b)))
        setSelectedTable({ ...selectedTable, trangThai: 2 })
      }
    } catch (err) {
      const data = err.response?.data
      if (data?.maLoi === 'HET_NGUYEN_LIEU' && Array.isArray(data.nguyenLieuThieu)) {
        const detail = data.nguyenLieuThieu
          .map((nl) => `${nl.tenNL}: cần ${nl.canDung}, còn ${nl.conLai} ${nl.donViTinh}`)
          .join('\n')
        toast.error(`Hết nguyên liệu:\n${detail}`, { duration: 5000 })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handlePayInvoice = async ({ maHoaDon, phuongThucTT, tienKhachDua }) => {
    setPaying(true)
    try {
      const res = await orderService.thanhToan({
        maHoaDon,
        phuongThucTT,
        maKH: customer?.maKH || null,
        tienKhachDua,
      })
      toast.success(`Thanh toán thành công!${res.tienThua ? ` Tiền thừa: ${formatVND(res.tienThua)}` : ''}`)
      handlePrintInvoice(res.hoaDon)
      setActiveInvoice(null)
      setCustomer(null)
      await loadPosData()
      if (selectedTable) setSelectedTable({ ...selectedTable, trangThai: 1 })
    } catch {
      // Interceptor xử lý
    } finally {
      setPaying(false)
    }
  }

  const handlePrintInvoice = (hoaDon) => {
    if (!hoaDon) return
    const win = window.open('', '_blank', 'width=420,height=640')
    if (!win) return
    const gioTao = formatDateTime(hoaDon.thoigiantao || hoaDon.thoiGianTao)
    const tenBan = hoaDon.ban?.map((b) => b.tenBan).join(', ') || 'Mang đi'
    const tongCong = formatVND(hoaDon.tongTienThanhToan ?? hoaDon.tongTamTinh)
    const rows = (hoaDon.danhSachMon || [])
      .map((m) => {
        const tpText = m.toppings?.length
          ? `<br/><small>+ ${m.toppings.map((t) => `${t.tenTopping} x${t.soLuong}`).join(', ')}</small>`
          : ''
        return `<tr><td style="padding:4px 0"><b>${m.tenMon} (${m.kichThuoc})</b>${tpText}</td><td align="center">${m.soLuong}</td><td align="right">${formatVND(m.thanhTien)}</td></tr>`
      })
      .join('')

    win.document.write(
      `<html><head><title>Bill ${hoaDon.maHoaDon}</title></head><body style="font-family:monospace;padding:16px"><h3 style="text-align:center;margin:0">☕ QUÁN CÀ PHÊ POS</h3><p style="text-align:center;font-size:12px">HĐ: #${hoaDon.maHoaDon} | ${tenBan}</p><p style="font-size:11px">Giờ tạo: ${gioTao}</p><hr/><table style="width:100%;font-size:12px"><thead><tr><th align="left">Món</th><th>SL</th><th align="right">T.Tiền</th></tr></thead><tbody>${rows}</tbody></table><hr/><h3 style="text-align:right">TỔNG CỘNG: ${tongCong}</h3></body></html>`
    )
    win.document.close()
    win.print()
  }

  const lyThuyet = Number(currentShift?.tienMatLyThuyet || 0)
  const thucTeNum = tienThucTeInput === '' ? null : Number(tienThucTeInput)
  const chenhLech = thucTeNum !== null ? thucTeNum - lyThuyet : null

  return (
    <div className="min-h-screen bg-stone-100 flex flex-col">
      <header className="bg-stone-900 text-white px-5 py-3 flex flex-wrap items-center justify-between gap-3 shadow">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-lg font-extrabold text-amber-400">☕ POS Bán Hàng & Thu Ngân</span>
          <span className="text-xs bg-stone-800 px-3 py-1 rounded-full text-stone-300">{user?.tenNV}</span>
          {currentShift ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs bg-emerald-900/80 border border-emerald-600 text-emerald-200 px-3 py-1 rounded-full">
                🟢 Ca #{currentShift.maCaThuNgan} • Quỹ lý thuyết: <b>{formatVND(currentShift.tienMatLyThuyet)}</b>
              </span>
              <button
                type="button"
                onClick={() => setShowThuChiModal(true)}
                className="px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold cursor-pointer transition shadow"
              >
                💵 Thu/Chi lặt vặt
              </button>
              <button
                type="button"
                onClick={() => {
                  setTienThucTeInput(String(currentShift.tienMatLyThuyet || 0))
                  setShowDongCaModal(true)
                }}
                className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-bold cursor-pointer transition shadow"
              >
                🔒 Đóng ca
              </button>
            </div>
          ) : (
            <form onSubmit={handleOpenShift} className="flex items-center gap-1.5">
              <span className="text-xs text-amber-300 font-semibold">⚠️ Chưa mở ca:</span>
              <input
                type="number"
                value={tienDauCaInput}
                onChange={(e) => setTienDauCaInput(e.target.value)}
                placeholder="Tiền đầu ca..."
                className="w-28 px-2 py-1 rounded bg-stone-800 border border-stone-600 text-xs text-white"
              />
              <button
                type="submit"
                disabled={openingShift}
                className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 rounded text-xs font-bold cursor-pointer"
              >
                Mở ca ngay
              </button>
            </form>
          )}
        </div>

        <div className="flex items-center gap-2">
          {Number(user?.vaiTro) === ROLES.QUAN_LY && (
            <button
              onClick={() => navigate('/admin/dashboard')}
              className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 rounded-xl text-xs font-bold cursor-pointer"
            >
              📊 Quản trị (/admin)
            </button>
          )}
          <button
            onClick={() => {
              logout()
              navigate('/login', { replace: true })
            }}
            className="px-3.5 py-1.5 bg-red-600 hover:bg-red-700 rounded-xl text-xs font-bold cursor-pointer"
          >
            Đăng xuất
          </button>
        </div>
      </header>

      <div className="flex-1 p-4 grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-8 space-y-4">
          <TableMap
            tables={tables}
            selectedTable={selectedTable}
            onSelectTable={handleSelectTable}
            onRefresh={loadPosData}
            userRole={user?.vaiTro}
          />
          <MenuGrid menu={menu} onPickProduct={setPickingProduct} />
        </div>

        <div className="lg:col-span-4 flex flex-col gap-3">
          <CustomerBox customer={customer} onSelectCustomer={setCustomer} />
          <div className="flex-1">
            <Cart
              selectedTable={selectedTable}
              cart={cart}
              activeInvoice={activeInvoice}
              onUpdateQty={updateCartQty}
              onUpdateNote={updateCartNote}
              onRemoveItem={removeFromCart}
              onClearCart={clearCart}
              onSubmitOrder={handleSubmitOrder}
              onPayInvoice={handlePayInvoice}
              onPrintInvoice={handlePrintInvoice}
              submitting={submitting}
              paying={paying}
            />
          </div>
        </div>
      </div>

      <ToppingModal
        product={pickingProduct}
        availableToppings={toppings}
        isOpen={Boolean(pickingProduct)}
        onClose={() => setPickingProduct(null)}
        onConfirm={addToCart}
      />

      <ThuChiModal
        isOpen={showThuChiModal}
        onClose={() => setShowThuChiModal(false)}
        onSuccess={loadPosData}
      />

      {showDongCaModal && currentShift && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <h3 className="font-extrabold text-base text-gray-800">🔒 Đối Soát & Đóng Ca Thu Ngân</h3>
                <p className="text-xs text-gray-500">Mã ca: #{currentShift.maCaThuNgan}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowDongCaModal(false)}
                className="w-8 h-8 rounded-full bg-gray-100 font-bold text-gray-600 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCloseShift} className="space-y-4">
              <div className="bg-amber-50 p-3.5 rounded-xl border border-amber-200 text-xs space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-gray-600">Tiền mặt đầu ca:</span>
                  <span className="font-bold">{formatVND(currentShift.tienMatDauCa)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Doanh thu tiền mặt:</span>
                  <span className="font-bold text-emerald-700">+{formatVND(currentShift.doanhThu?.tienMat || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Thu lặt vặt:</span>
                  <span className="font-bold text-emerald-700">+{formatVND(currentShift.thuLatVat || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Chi lặt vặt:</span>
                  <span className="font-bold text-red-600">-{formatVND(currentShift.chiLatVat || 0)}</span>
                </div>
                <div className="pt-2 border-t border-amber-200 flex justify-between text-sm">
                  <span className="font-bold text-gray-800">Quỹ tiền mặt lý thuyết:</span>
                  <span className="font-black text-amber-900">{formatVND(lyThuyet)}</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  Tiền mặt kiểm đếm thực tế (VND) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  required
                  min="0"
                  value={tienThucTeInput}
                  onChange={(e) => setTienThucTeInput(e.target.value)}
                  placeholder="Nhập số tiền thực tế trong két..."
                  className="w-full px-3.5 py-2.5 border rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:ring-amber-600"
                />
              </div>

              {chenhLech !== null && (
                <div
                  className={`p-3 rounded-xl border text-xs flex justify-between items-center font-bold ${
                    chenhLech === 0
                      ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                      : 'bg-red-50 border-red-300 text-red-800'
                  }`}
                >
                  <span>Chênh lệch quỹ:</span>
                  <span className="text-sm">
                    {formatVND(chenhLech)} {chenhLech === 0 ? '(Khớp quỹ)' : chenhLech > 0 ? '(Thừa tiền)' : '(Hụt tiền)'}
                  </span>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowDongCaModal(false)}
                  className="flex-1 py-2.5 border rounded-xl text-xs font-bold text-gray-700 cursor-pointer hover:bg-gray-50"
                >
                  Hủy bỏ
                </button>
                <button
                  type="submit"
                  disabled={closingShift}
                  className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-bold shadow cursor-pointer disabled:opacity-50"
                >
                  {closingShift ? 'Đang chốt ca...' : 'Xác nhận Đóng Ca'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}