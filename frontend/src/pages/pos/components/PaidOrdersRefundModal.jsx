import { useState, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'
import { orderService } from '../../../services/orderService'
import { sanPhamService } from '../../../services/sanPhamService'
import { authService } from '../../../services/authService'
import { formatVND, formatDateTime, getTodayISO } from '../../../utils/format'

const REFUND_METHODS = [
  { value: 'TIEN_MAT', label: '💵 Tiền mặt (cộng/trừ quỹ két)' },
  { value: 'CHUYEN_KHOAN', label: '📱 Chuyển khoản' },
  { value: 'THE', label: '💳 Quẹt Thẻ' },
]

export default function PaidOrdersRefundModal({ isOpen, onClose, isManager, onRefundSuccess }) {
  const [ngay, setNgay] = useState(() => getTodayISO())
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(false)

  const [selectedOrder, setSelectedOrder] = useState(null)
  const [refundOrderDetail, setRefundOrderDetail] = useState(null)
  const [refundSelectedIds, setRefundSelectedIds] = useState([])
  const [lyDo, setLyDo] = useState('')
  const [phuongThucHoan, setPhuongThucHoan] = useState('TIEN_MAT')
  const [hoanKho, setHoanKho] = useState(false)
  const [managerPin, setManagerPin] = useState('')
  const [approvers, setApprovers] = useState([])
  const [maNVDuyet, setMaNVDuyet] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Chế độ Đổi món sau thanh toán (Swap Item — không cần hủy cả hóa đơn nếu món chưa pha!)
  const [swapOrderDetail, setSwapOrderDetail] = useState(null)
  const [menuList, setMenuList] = useState([])
  const [selectedSwapCTHD, setSelectedSwapCTHD] = useState('')
  const [maMonMoi, setMaMonMoi] = useState('')
  const [kichThuocMoi, setKichThuocMoi] = useState('M')
  const [soLuongMoi, setSoLuongMoi] = useState(1)
  const [ghiChuMoi, setGhiChuMoi] = useState('')
  const [ptttChenhLech, setPtttChenhLech] = useState('TIEN_MAT')
  const [lyDoDoi, setLyDoDoi] = useState('Khách xin đổi món ngay tại quầy')
  const [loadingSwapDetail, setLoadingSwapDetail] = useState(false)

  const loadHistory = useCallback(async () => {
    setLoading(true)
    try {
      const list = await orderService.getLichSuHomNay(ngay)
      setOrders(Array.isArray(list) ? list : [])
    } catch {
      setOrders([])
    } finally {
      setLoading(false)
    }
  }, [ngay])

  useEffect(() => {
    if (!isOpen) return undefined
    const t = setTimeout(() => {
      void loadHistory()
      authService
        .getStaffQuickList()
        .then((res) => {
          const list = (res?.danhSachNV || []).filter((s) => s.coQuyenDuyetPin && s.daDatPin)
          setApprovers(list)
          if (list.length > 0) setMaNVDuyet((prev) => prev || list[0].maNV)
        })
        .catch(() => {})
    }, 0)
    return () => clearTimeout(t)
  }, [isOpen, loadHistory])

  if (!isOpen) return null

  const openRefundForm = async (order) => {
    setSwapOrderDetail(null)
    setSelectedOrder(order)
    setRefundOrderDetail(null)
    setRefundSelectedIds([])
    setLyDo('')
    setPhuongThucHoan(
      ['TIEN_MAT', 'CHUYEN_KHOAN', 'THE'].includes(order.phuongThucTT)
        ? order.phuongThucTT
        : 'TIEN_MAT'
    )
    setHoanKho(false)
    setManagerPin('')
    try {
      const detail = await orderService.getById(order.maHoaDon)
      setRefundOrderDetail(detail)
      const activeIds = (detail?.danhSachMon || [])
        .filter((m) => !m.daHuy && m.trangThaiPhaChe !== 'DaHuy')
        .map((m) => m.maCTHD)
      setRefundSelectedIds(activeIds)
    } catch {
      // fallback full refund if detail fails
    }
  }

  const openSwapForm = async (order) => {
    setSelectedOrder(null)
    setLoadingSwapDetail(true)
    try {
      const [detail, menus] = await Promise.all([
        orderService.getById(order.maHoaDon),
        menuList.length > 0 ? Promise.resolve(menuList) : sanPhamService.getMenu(),
      ])
      const validMenus = Array.isArray(menus) ? menus.filter((m) => !m.tamHet) : []
      setMenuList(validMenus)
      const swappable = (detail?.danhSachMon || []).filter(
        (m) => !m.daHuy && m.trangThaiPhaChe === 'ChoPhaChe'
      )
      if (swappable.length === 0) {
        toast.error(
          'Tất cả các món trong đơn này đã được Barista nhận làm hoặc hoàn thành, không thể đổi ngang!'
        )
        return
      }
      const firstItem = swappable[0]
      const defaultNewMon = validMenus.find((m) => m.maMon !== firstItem.maMon) || validMenus[0]
      setSwapOrderDetail(detail)
      setSelectedSwapCTHD(String(firstItem.maCTHD))
      setMaMonMoi(defaultNewMon?.maMon || '')
      setKichThuocMoi(defaultNewMon?.sizes?.[0]?.kichThuoc || 'M')
      setSoLuongMoi(Number(firstItem.soLuong || 1))
      setGhiChuMoi(firstItem.ghiChu || '')
      setPtttChenhLech(
        ['TIEN_MAT', 'CHUYEN_KHOAN', 'THE'].includes(order.phuongThucTT)
          ? order.phuongThucTT
          : 'TIEN_MAT'
      )
      setLyDoDoi('Khách xin đổi món ngay tại quầy')
    } catch {
      toast.error('Không tải được chi tiết hóa đơn để đổi món!')
    } finally {
      setLoadingSwapDetail(false)
    }
  }

  const handleSubmitSwap = async (e) => {
    e.preventDefault()
    if (!swapOrderDetail || !selectedSwapCTHD || !maMonMoi) return
    setSubmitting(true)
    try {
      const res = await orderService.swapOrderItem({
        maCTHD: Number(selectedSwapCTHD),
        newItem: {
          maMon: maMonMoi,
          kichThuoc: kichThuocMoi,
          soLuong: Number(soLuongMoi || 1),
          ghiChu: ghiChuMoi.trim() || null,
        },
        phuongThucBuHoan: ptttChenhLech,
        lyDo: lyDoDoi.trim() || 'Khách xin đổi món tại quầy',
      })
      toast.success(res.message, { duration: 5000 })
      setSwapOrderDetail(null)
      await loadHistory()
      if (typeof onRefundSuccess === 'function') {
        onRefundSuccess(res)
      }
    } catch {
      // Interceptor xử lý
    } finally {
      setSubmitting(false)
    }
  }

  const handleSubmitRefund = async (e) => {
    e.preventDefault()
    if (!selectedOrder) return
    if (lyDo.trim().length < 3) {
      return toast.error('Vui lòng nhập lý do hoàn tiền tối thiểu 3 ký tự!')
    }
    if (!isManager && !/^\d{4,6}$/.test(managerPin.trim())) {
      return toast.error('Hoàn tiền sau thanh toán yêu cầu mã PIN Quản lý (4–6 số)!')
    }
    const activeItems = (refundOrderDetail?.danhSachMon || []).filter(
      (m) => !m.daHuy && m.trangThaiPhaChe !== 'DaHuy'
    )
    if (activeItems.length > 0 && refundSelectedIds.length === 0) {
      return toast.error('Vui lòng chọn ít nhất 1 món cần hoàn tiền!')
    }
    const isPartial =
      activeItems.length > 1 &&
      refundSelectedIds.length > 0 &&
      refundSelectedIds.length < activeItems.length

    setSubmitting(true)
    try {
      const res = await orderService.hoanTienSauTT({
        maHoaDon: selectedOrder.maHoaDon,
        lyDo: lyDo.trim(),
        phuongThucHoan,
        hoanKho,
        managerPin: managerPin.trim() || null,
        maNVDuyet: !isManager && maNVDuyet ? maNVDuyet : null,
        dsMaCTHDHoan: isPartial ? refundSelectedIds : null,
      })
      toast.success(res.message)
      setSelectedOrder(null)
      setRefundOrderDetail(null)
      await loadHistory()
      if (typeof onRefundSuccess === 'function') {
        onRefundSuccess(res)
      }
    } catch {
      // Interceptor đã báo lỗi
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full p-5 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
          <div>
            <h3 className="font-extrabold text-base text-stone-900">
              🧾 Đơn Đã Thanh Toán &amp; Hoàn Tiền Sau Thu (Post-Payment Refund)
            </h3>
            <p className="text-[11px] text-stone-500">
              Phục vụ đổi món / hoàn tiền đơn đã thu tiền • Bắt buộc có Quản lý hoặc PIN Quản lý &amp; ghi Audit Log bất biến
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={ngay}
              onChange={(e) => setNgay(e.target.value)}
              className="px-2.5 py-1.5 border rounded-lg text-xs font-bold"
            />
            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-stone-100 hover:bg-stone-200 font-bold cursor-pointer"
            >
              ✕
            </button>
          </div>
        </div>

        {swapOrderDetail ? (
          (() => {
            const swappableItems = (swapOrderDetail.danhSachMon || []).filter(
              (m) => !m.daHuy && m.trangThaiPhaChe === 'ChoPhaChe'
            )
            const currentOldItem = swappableItems.find(
              (m) => String(m.maCTHD) === String(selectedSwapCTHD)
            )
            const newProduct = menuList.find((m) => m.maMon === maMonMoi)
            const newSizeObj =
              newProduct?.sizes?.find((s) => s.kichThuoc === kichThuocMoi) ||
              newProduct?.sizes?.[0]
            const donGiaMoi = Number(newSizeObj?.giaBan || 0)
            const thanhTienCu = Number(currentOldItem?.thanhTien || 0)
            const thanhTienMoi = donGiaMoi * Number(soLuongMoi || 1)
            const chenhLech = thanhTienMoi - thanhTienCu

            return (
              <form
                onSubmit={handleSubmitSwap}
                className="space-y-3 bg-sky-50/80 p-4 rounded-xl border border-sky-200"
              >
                <div className="flex items-center justify-between">
                  <h4 className="font-extrabold text-sm text-sky-950">
                    🔄 Đổi món nhanh trên Hóa đơn #{swapOrderDetail.maHoaDon} (chưa pha chế)
                  </h4>
                  <button
                    type="button"
                    onClick={() => setSwapOrderDetail(null)}
                    className="text-xs font-bold text-stone-500 hover:text-stone-800 cursor-pointer"
                  >
                    ← Quay lại danh sách
                  </button>
                </div>

                <div>
                  <label className="block font-bold text-stone-700 mb-1">
                    1. Chọn món đang chờ pha (`ChoPhaChe`) cần đổi:
                  </label>
                  <select
                    value={selectedSwapCTHD}
                    onChange={(e) => {
                      const val = e.target.value
                      setSelectedSwapCTHD(val)
                      const found = swappableItems.find((m) => String(m.maCTHD) === String(val))
                      if (found) {
                        setSoLuongMoi(Number(found.soLuong || 1))
                        setGhiChuMoi(found.ghiChu || '')
                      }
                    }}
                    className="w-full px-3 py-2 border rounded-xl bg-white font-bold"
                  >
                    {swappableItems.map((m) => (
                      <option key={m.maCTHD} value={m.maCTHD}>
                        {m.tenMon} (Size {m.kichThuoc}) ×{m.soLuong} — {formatVND(m.thanhTien)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="sm:col-span-2">
                    <label className="block font-bold text-stone-700 mb-1">2. Đổi sang món mới:</label>
                    <select
                      value={maMonMoi}
                      onChange={(e) => {
                        const nextMa = e.target.value
                        setMaMonMoi(nextMa)
                        const sp = menuList.find((m) => m.maMon === nextMa)
                        if (sp?.sizes?.length && !sp.sizes.some((s) => s.kichThuoc === kichThuocMoi)) {
                          setKichThuocMoi(sp.sizes[0].kichThuoc)
                        }
                      }}
                      className="w-full px-3 py-2 border rounded-xl bg-white font-bold"
                    >
                      {menuList.map((m) => (
                        <option key={m.maMon} value={m.maMon}>
                          {m.tenMon} ({m.nhomMon})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block font-bold text-stone-700 mb-1">Size &amp; Số lượng:</label>
                    <div className="flex gap-1.5">
                      <select
                        value={kichThuocMoi}
                        onChange={(e) => setKichThuocMoi(e.target.value)}
                        className="flex-1 px-2 py-2 border rounded-xl bg-white font-bold"
                      >
                        {(newProduct?.sizes || []).map((s) => (
                          <option key={s.kichThuoc} value={s.kichThuoc}>
                            {s.kichThuoc} ({formatVND(s.giaBan)})
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={soLuongMoi}
                        onChange={(e) => setSoLuongMoi(Math.max(1, Number(e.target.value || 1)))}
                        className="w-14 px-2 py-2 border rounded-xl bg-white text-center font-bold"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="block font-bold text-stone-700 mb-1">Ghi chú pha chế mới:</label>
                    <input
                      type="text"
                      value={ghiChuMoi}
                      onChange={(e) => setGhiChuMoi(e.target.value)}
                      placeholder="VD: Ít ngọt, 50% đá..."
                      className="w-full px-3 py-2 border rounded-xl bg-white"
                    />
                  </div>
                  <div>
                    <label className="block font-bold text-stone-700 mb-1">
                      Phương thức thu bù / hoàn chênh lệch:
                    </label>
                    <select
                      value={ptttChenhLech}
                      onChange={(e) => setPtttChenhLech(e.target.value)}
                      className="w-full px-3 py-2 border rounded-xl bg-white font-bold"
                    >
                      {REFUND_METHODS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-white border flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-stone-500">
                      Món cũ: <b>{formatVND(thanhTienCu)}</b> → Món mới: <b>{formatVND(thanhTienMoi)}</b>
                    </p>
                  </div>
                  <div
                    className={`px-3 py-1 rounded-lg font-extrabold text-xs ${
                      chenhLech > 0
                        ? 'bg-amber-100 text-amber-900'
                        : chenhLech < 0
                        ? 'bg-emerald-100 text-emerald-900'
                        : 'bg-stone-100 text-stone-700'
                    }`}
                  >
                    {chenhLech > 0
                      ? `Thu thêm khách: +${formatVND(chenhLech)}`
                      : chenhLech < 0
                      ? `Hoàn lại khách: -${formatVND(Math.abs(chenhLech))}`
                      : 'Ngang giá (0đ)'}
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t border-sky-200">
                  <button
                    type="button"
                    onClick={() => setSwapOrderDetail(null)}
                    className="px-4 py-2 rounded-xl bg-white border font-bold cursor-pointer"
                  >
                    Hủy
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="px-5 py-2 rounded-xl bg-sky-700 hover:bg-sky-800 text-white font-extrabold cursor-pointer disabled:opacity-50"
                  >
                    {submitting ? 'Đang đổi món...' : '🔄 Xác nhận đổi món & cập nhật KDS'}
                  </button>
                </div>
              </form>
            )
          })()
        ) : selectedOrder ? (
          <form onSubmit={handleSubmitRefund} className="space-y-3 bg-rose-50/70 p-4 rounded-xl border border-rose-200">
            <div className="flex items-center justify-between">
              <h4 className="font-extrabold text-sm text-rose-900">
                ↩️ Xác nhận Hoàn tiền Hóa đơn #{selectedOrder.maHoaDon}
              </h4>
              <button
                type="button"
                onClick={() => setSelectedOrder(null)}
                className="text-xs font-bold text-stone-500 hover:text-stone-800 cursor-pointer"
              >
                ← Chọn hóa đơn khác
              </button>
            </div>

            <div className="bg-white rounded-xl p-3 border grid grid-cols-2 gap-2">
              <p>Bàn / Loại: <b>{selectedOrder.tenBan || 'Mang đi'}</b></p>
              <p>Tổng đã thu: <b className="text-rose-700 text-sm">{formatVND(selectedOrder.tongTienThanhToan)}</b></p>
              <p>PTTT gốc: <b>{selectedOrder.phuongThucTT || 'TIEN_MAT'}</b></p>
              <p>Thu lúc: <b>{formatDateTime(selectedOrder.thoiGianThanhToan)}</b></p>
            </div>

            {/* Chọn món cần hoàn (hỗ trợ Hoàn tiền 1 phần từng món hoặc Hoàn toàn bộ hóa đơn) */}
            {refundOrderDetail?.danhSachMon?.length > 0 && (
              <div className="bg-white rounded-xl p-3 border space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-stone-800">
                    Chọn món hoàn tiền (bỏ tích các món khách vẫn giữ để Hoàn tiền 1 phần):
                  </span>
                </div>
                <div className="divide-y max-h-40 overflow-y-auto">
                  {refundOrderDetail.danhSachMon
                    .filter((m) => !m.daHuy && m.trangThaiPhaChe !== 'DaHuy')
                    .map((m) => {
                      const checked = refundSelectedIds.includes(m.maCTHD)
                      return (
                        <label
                          key={m.maCTHD}
                          className="py-1.5 px-1 flex items-center justify-between gap-2 cursor-pointer hover:bg-rose-50/60 rounded"
                        >
                          <span className="flex items-center gap-2 font-semibold text-stone-800">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setRefundSelectedIds((prev) =>
                                  checked
                                    ? prev.filter((id) => id !== m.maCTHD)
                                    : [...prev, m.maCTHD]
                                )
                              }
                              className="w-4 h-4 accent-rose-600"
                            />
                            {m.tenMon} (Size {m.kichThuoc}) ×{m.soLuong}
                          </span>
                          <b className="text-stone-700">{formatVND(m.thanhTien)}</b>
                        </label>
                      )
                    })}
                </div>
              </div>
            )}

            <div>
              <label className="block font-bold text-stone-700 mb-1">Phương thức hoàn tiền cho khách</label>
              <select
                value={phuongThucHoan}
                onChange={(e) => setPhuongThucHoan(e.target.value)}
                className="w-full px-3 py-2 border rounded-xl bg-white font-bold"
              >
                {REFUND_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-bold text-stone-700 mb-1">Lý do hoàn tiền / đổi món *</label>
              <input
                type="text"
                required
                minLength={3}
                value={lyDo}
                onChange={(e) => setLyDo(e.target.value)}
                placeholder="VD: Khách đổi sang Trà Vải size L / Lỡ nhập sai món..."
                className="w-full px-3 py-2 border rounded-xl bg-white"
              />
            </div>

            <label className="flex items-start gap-2 p-2.5 rounded-xl bg-white border cursor-pointer">
              <input
                type="checkbox"
                checked={hoanKho}
                onChange={(e) => setHoanKho(e.target.checked)}
                className="mt-0.5 accent-amber-700"
              />
              <span>
                <b>Hoàn trả nguyên liệu về kho</b> (chỉ tích nếu Barista <b>CHƯA</b> pha chế; nếu đã pha xong sẽ mặc định ghi nhận Hao hụt).
              </span>
            </label>

            {!isManager && (
              <div className="p-3 rounded-xl bg-white border border-rose-200 space-y-2">
                <label className="block font-bold text-rose-900">
                  🔒 Phê duyệt Quản lý / Ca trưởng (xác thực PIN O(1)) *
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {approvers.length > 0 && (
                    <select
                      value={maNVDuyet}
                      onChange={(e) => setMaNVDuyet(e.target.value)}
                      className="px-3 py-2 border border-rose-300 rounded-xl bg-white font-bold"
                    >
                      {approvers.map((ap) => (
                        <option key={ap.maNV} value={ap.maNV}>
                          {ap.laCaTruong && Number(ap.vaiTro) !== 1 ? '🎖️ Ca trưởng: ' : '👔 Quản lý: '}
                          {ap.tenNV} ({ap.maNV})
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    type="password"
                    required
                    value={managerPin}
                    onChange={(e) => setManagerPin(e.target.value)}
                    placeholder="Nhập PIN 4–6 số..."
                    className="px-3 py-2 border border-rose-300 rounded-xl bg-white font-mono text-sm tracking-widest"
                  />
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-rose-200">
              <button
                type="button"
                onClick={() => setSelectedOrder(null)}
                className="px-4 py-2 rounded-xl bg-white border font-bold cursor-pointer"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2 rounded-xl bg-rose-700 hover:bg-rose-800 text-white font-extrabold cursor-pointer disabled:opacity-50"
              >
                {submitting ? 'Đang xử lý...' : `✅ Xác nhận hoàn ${formatVND(selectedOrder.tongTienThanhToan)}`}
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {loading ? (
              <p className="text-center py-8 text-stone-400">Đang tải danh sách hóa đơn...</p>
            ) : orders.length === 0 ? (
              <p className="text-center py-8 text-stone-400 italic">
                Chưa có hóa đơn đã thanh toán nào trong ngày {ngay}
              </p>
            ) : (
              orders.map((o) => (
                <div
                  key={o.maHoaDon}
                  className={`p-3 rounded-xl border flex flex-wrap items-center justify-between gap-2 ${
                    o.daHoanTien ? 'bg-stone-100 border-stone-200 opacity-75' : 'bg-stone-50 border-stone-200'
                  }`}
                >
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {Number(o.soThuTuNgay) > 0 && (
                        <span className="px-2 py-0.5 rounded bg-stone-900 text-amber-300 font-black text-[11px]">
                          SỐ #{String(o.soThuTuNgay).padStart(2, '0')}
                        </span>
                      )}
                      <span className="font-mono font-extrabold text-stone-900">#{o.maHoaDon}</span>
                      <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 font-bold text-[10px]">
                        {o.tenBan || 'Mang đi'}
                      </span>
                      {o.daHoanTien ? (
                        <span className="px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 font-extrabold text-[10px]">
                          ĐÃ HOÀN TIỀN
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-extrabold text-[10px]">
                          {o.phuongThucTT || 'TIEN_MAT'}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-stone-500 mt-0.5">
                      {o.tongLy} ly • Thu lúc {formatDateTime(o.thoiGianThanhToan)}
                      {o.tenKH ? ` • KH: ${o.tenKH}` : ''}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="font-black text-sm text-emerald-700">
                      {formatVND(o.tongTienThanhToan)}
                    </span>
                    {!o.daHoanTien && (
                      <>
                        <button
                          type="button"
                          disabled={loadingSwapDetail}
                          onClick={() => openSwapForm(o)}
                          className="px-2.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white font-bold cursor-pointer"
                          title="Đổi sang món khác (nếu Barista chưa pha) và chỉ thu/hoàn phần tiền chênh lệch"
                        >
                          🔄 Đổi món
                        </button>
                        <button
                          type="button"
                          onClick={() => openRefundForm(o)}
                          className="px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold cursor-pointer"
                        >
                          ↩️ Hoàn tiền
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
