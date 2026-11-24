import { useState, memo } from 'react'
import toast from 'react-hot-toast'
import { formatVND } from '../../../utils/format'
import { getSmartCashSuggestions, buildVietQrEmvcoPayload } from '../../../utils/vietqrEmvco'
import { buildVietQrUrl, getVietQrConfig } from '../../../utils/printHelper'
import { caService } from '../../../services/caService'
import CartItemList from './CartItemList'

const TRANG_THAI_PHA_CHE_LABEL = {
  ChoPhaChe: '⏳ Chờ pha',
  DangLam: '🔥 Đang pha',
  DaXong: '✅ Đã xong',
  DaPhucVu: '🍽️ Đã phục vụ',
  DaHuy: '🚫 Đã hủy',
}

const PTTT_BADGE = {
  TIEN_MAT: '💵 Tiền mặt',
  CHUYEN_KHOAN: '📱 VietQR',
  THE: '💳 Thẻ',
  VOUCHER: '🎟️ Voucher',
  VI_KHACH: '👛 Ví thành viên',
  VI_DIEN_TU: '📲 Ví điện tử',
  SAN_GIAO_HANG: '🛵 App Sàn',
}

const Cart = memo(function Cart({
  selectedTable,
  orderType = 'MANG_DI',
  onChangeOrderType,
  tenKhachVangLai = '',
  onChangeTenKhachVangLai,
  cart,
  activeInvoice,
  canPay = true,
  isManager = false,
  onUpdateQty,
  onUpdateNote,
  onSplitItem,
  onCloneItem,
  onEditItem,
  onToggleTakeaway,
  onToggleHoldCourse,
  onRemoveItem,
  onClearCart,
  onHoldOrder,
  onSubmitOrder,
  onQuickCheckout,
  onStartVietQrOrder,
  onOpenSplitBill,
  onPayInvoice,
  onFireCourse,
  onSimulateVietQr,
  onVoidInvoiceItem,
  onPrintInvoice,
  onPrintLabels,
  onOpenBankConfig,
  customer = null,
  activeHappyHours = [],
  promoCodeInput = '',
  onChangePromoCode,
  diemSuDungInput = '',
  onChangeDiemSuDung,
  promoPreview = null,
  onApplyPromo,
  onClearPromo,
  soTheRung = '',
  onChangeSoTheRung,
  preferVietQrKey = 0,
  upsellSuggestions = [],
  onQuickAddUpsell,
  concurrencyBanner = null,
  onDismissConcurrencyBanner,
  submitting,
  paying,
}) {
  const [payModeState, setPayModeState] = useState({ qrKey: 0, mode: 'TIEN_MAT' })
  const phuongThucTT =
    preferVietQrKey > 0 && payModeState.qrKey !== preferVietQrKey
      ? 'CHUYEN_KHOAN'
      : payModeState.mode
  const setPhuongThucTT = (mode) => setPayModeState({ qrKey: preferVietQrKey, mode })
  const [cashEntry, setCashEntry] = useState({ key: '', value: '' })
  const [splitState, setSplitState] = useState({
    key: '',
    rows: [
      { phuongThucTT: 'TIEN_MAT', soTien: '' },
      { phuongThucTT: 'CHUYEN_KHOAN', soTien: '' },
    ],
  })

  const invoiceId = activeInvoice?.maHoaDon || ''
  const cashKey = `${invoiceId}|${selectedTable?.maBan || ''}`
  const tienKhachDua = cashEntry.key === cashKey ? cashEntry.value : ''
  const setTienKhachDua = (value) => setCashEntry({ key: cashKey, value })

  const splitRows =
    splitState.key === cashKey
      ? splitState.rows
      : [
          { phuongThucTT: 'TIEN_MAT', soTien: '' },
          { phuongThucTT: 'CHUYEN_KHOAN', soTien: '' },
        ]
  const setSplitRows = (updater) => {
    setSplitState((prev) => {
      const base =
        prev.key === cashKey
          ? prev.rows
          : [
              { phuongThucTT: 'TIEN_MAT', soTien: '' },
              { phuongThucTT: 'CHUYEN_KHOAN', soTien: '' },
            ]
      const next = typeof updater === 'function' ? updater(base) : updater
      return { key: cashKey, rows: next }
    })
  }

  const calcCartItemTotal = (item) => {
    const tpPerCup = (item.toppings || []).reduce(
      (s, t) => s + Number(t.donGia) * Number(t.soLuongMoiLy ?? t.soLuong ?? 1),
      0
    )
    const modPerCup = Number(item.giaModifiers || 0)
    return (Number(item.donGia) + modPerCup + tpPerCup) * Number(item.soLuong)
  }

  const cartTotal = cart.reduce((s, i) => s + calcCartItemTotal(i), 0)
  const invoiceTotal = Number(activeInvoice?.tongTamTinh || 0)
  const daThanhToan = Number(activeInvoice?.daThanhToan || 0)
  const rawConLai =
    activeInvoice?.conLaiCanThu !== undefined
      ? Number(activeInvoice.conLaiCanThu)
      : Math.max(0, invoiceTotal - daThanhToan)

  const previewAppliesToInvoice =
    Boolean(activeInvoice) &&
    Number(activeInvoice?.tongGiamGia || 0) === 0 &&
    promoPreview &&
    Number(promoPreview.tongGiamGia || 0) > 0
  const conLaiCanThu = previewAppliesToInvoice
    ? Math.max(0, Math.round((rawConLai - Number(promoPreview.tongGiamGia || 0)) * 100) / 100)
    : rawConLai

  const khachHangHienTai = activeInvoice?.khachHang || customer || null
  const diemKhachCo = Math.max(0, Math.floor(Number(khachHangHienTai?.diemTichLuy || 0)))
  const baseForPromo = activeInvoice ? invoiceTotal : cartTotal
  const maxDiemCoTheDoi = Math.min(diemKhachCo, Math.floor(baseForPromo / 1000))
  const diemMuonDoiNum = Math.max(0, Math.floor(Number(diemSuDungInput || 0)))
  const promoCodeSach = promoCodeInput.trim().toUpperCase()

  const cashSuggestions = getSmartCashSuggestions(conLaiCanThu)
  const [unmatchedQrList, setUnmatchedQrList] = useState([])
  const [loadingUnmatched, setLoadingUnmatched] = useState(false)
  const [showUnmatchedQueue, setShowUnmatchedQueue] = useState(false)
  const [resolvingOverpayId, setResolvingOverpayId] = useState(null)
  const [voucherManagerPin, setVoucherManagerPin] = useState('')
  const [manualQrProof, setManualQrProof] = useState({ key: '', idChungTu: '', preview: '' })
  const [uploadingManualQr, setUploadingManualQr] = useState(false)

  const manualQrIdChungTu = manualQrProof.key === cashKey ? manualQrProof.idChungTu : ''
  const manualQrPreview = manualQrProof.key === cashKey ? manualQrProof.preview : ''

  const handleUploadManualQrProof = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingManualQr(true)
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error('Không đọc được ảnh'))
        reader.onload = () => resolve(String(reader.result || ''))
        reader.readAsDataURL(file)
      })
      const uploaded = await caService.uploadReceiptPhoto({
        dataUrl,
        mimeType: file.type || 'image/jpeg',
      })
      const idChungTu = uploaded?.idChungTu || uploaded?.id || ''
      setManualQrProof({ key: cashKey, idChungTu, preview: dataUrl })
      toast.success('📷 Đã đính kèm ảnh chụp chuyển khoản!')
    } catch {
      toast.error('Không thể tải ảnh chụp chuyển khoản!')
    } finally {
      setUploadingManualQr(false)
    }
  }

  const handleResolveOverpayment = async (ev, action) => {
    if (!ev?.id) return
    if (action === 'WALLET_CREDITED' && !khachHangHienTai?.maKH) {
      toast.error('Vui lòng chọn Khách hàng thành viên trước khi bảo lưu tiền dư vào ví!')
      return
    }
    setResolvingOverpayId(ev.id)
    try {
      const res = await caService.resolveVietQrOverpayment({
        webhookEventId: ev.id,
        action,
        maKH: action === 'WALLET_CREDITED' ? khachHangHienTai?.maKH : null,
      })
      toast.success(res?.message || 'Đã xử lý khoản chuyển khoản dư thành công!')
      setUnmatchedQrList((prev) => prev.filter((item) => item.id !== ev.id))
    } catch {
      // Interceptor xử lý lỗi
    } finally {
      setResolvingOverpayId(null)
    }
  }

  const bankConfig = getVietQrConfig()
  const transferMemo = activeInvoice ? `POSHD${activeInvoice.maHoaDon}` : ''
  let emvcoPayload = ''
  let vietQrBankError = ''
  if (bankConfig?.accountNo) {
    try {
      emvcoPayload = buildVietQrEmvcoPayload({
        bankId: bankConfig.bankId,
        accountNo: bankConfig.accountNo,
        amount: conLaiCanThu,
        memo: transferMemo,
      })
    } catch (err) {
      vietQrBankError = err?.message || 'Mã ngân hàng VietQR chưa hợp lệ!'
    }
  }

  const handleLoadUnmatchedQr = async () => {
    setLoadingUnmatched(true)
    setShowUnmatchedQueue(true)
    try {
      const list = await caService.getUnmatchedVietQr(30)
      setUnmatchedQrList(Array.isArray(list) ? list : [])
    } catch {
      setUnmatchedQrList([])
    } finally {
      setLoadingUnmatched(false)
    }
  }

  const handleMatchUnmatchedToCurrent = async (ev) => {
    if (!activeInvoice?.maHoaDon) return
    try {
      const res = await caService.matchUnmatchedVietQr({
        webhookEventId: ev.id,
        maHoaDon: activeInvoice.maHoaDon,
      })
      toast.success(res.message || 'Đã khớp giao dịch ngân hàng thành công!')
      setUnmatchedQrList((prev) => prev.filter((x) => x.id !== ev.id))
    } catch {
      // Interceptor xử lý
    }
  }
  const tienThuaDuKien =
    phuongThucTT === 'TIEN_MAT' && tienKhachDua !== ''
      ? Number(tienKhachDua) - conLaiCanThu
      : null
  const cashInsufficient =
    phuongThucTT === 'TIEN_MAT' && tienKhachDua !== '' && Number(tienKhachDua) < conLaiCanThu

  // Tính toán cho chế độ Thanh toán hỗn hợp (Split Tender)
  const validSplitRows = splitRows
    .map((r) => ({ ...r, soTienNum: Number(r.soTien || 0) }))
    .filter((r) => r.soTienNum > 0)
  const splitEnteredTotal = validSplitRows.reduce((s, r) => s + r.soTienNum, 0)
  const splitRemaining = Math.max(0, Math.round((conLaiCanThu - splitEnteredTotal) * 100) / 100)
  const splitEnough = splitEnteredTotal + 0.01 >= conLaiCanThu && conLaiCanThu > 0

  const vietQrUrl =
    phuongThucTT === 'CHUYEN_KHOAN' && activeInvoice && conLaiCanThu > 0
      ? buildVietQrUrl({ amount: conLaiCanThu, addInfo: transferMemo })
      : null

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 border border-gray-200 flex flex-col h-full space-y-3">
      {/* Banner cảnh báo ghi đè đồng thời (Optimistic Locking 409 ORDER_CONCURRENT_MODIFIED) */}
      {concurrencyBanner && (
        <div className="p-2.5 rounded-xl bg-red-600 text-white text-xs font-bold flex items-center justify-between gap-2 shadow">
          <span>⚠️ {concurrencyBanner}</span>
          {onDismissConcurrencyBanner && (
            <button
              type="button"
              onClick={onDismissConcurrencyBanner}
              className="px-2 py-0.5 rounded bg-red-800 hover:bg-red-900 cursor-pointer shrink-0"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Nút chuyển nhanh 1 chạm Order Type: Tại bàn / Mang đi / Giao hàng */}
      {onChangeOrderType && (
        <div className="grid grid-cols-3 gap-1 bg-stone-100 p-1 rounded-xl text-[11px] font-extrabold">
          {[
            { id: 'TAI_QUAN', label: '🪑 Tại bàn' },
            { id: 'MANG_DI', label: '🛍️ Mang đi' },
            { id: 'GIAO_HANG', label: '🛵 Giao hàng' },
          ].map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => onChangeOrderType(opt.id)}
              className={`py-2 px-1.5 rounded-lg cursor-pointer transition ${
                (selectedTable ? 'TAI_QUAN' : orderType) === opt.id
                  ? 'bg-amber-700 text-white shadow-xs'
                  : 'text-stone-700 hover:bg-white'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* Ô nhập nhanh Tên khách vãng lai in lên tem cốc Takeaway */}
      {!selectedTable && onChangeTenKhachVangLai && (
        <input
          type="text"
          value={tenKhachVangLai}
          onChange={(e) => onChangeTenKhachVangLai(e.target.value)}
          placeholder="🏷️ Tên khách in tem cốc (VD: Anh Huy)..."
          className="w-full px-3 py-2 rounded-xl border border-gray-200 bg-stone-50 text-xs font-semibold outline-none focus:ring-2 focus:ring-amber-600"
        />
      )}

      {/* Header Bàn */}
      <div className="flex items-center justify-between border-b pb-2.5">
        <div>
          <h3 className="font-extrabold text-base text-gray-800">
            {selectedTable ? `🪑 ${selectedTable.tenBan}` : '🛍️ Đơn Mang Đi (Counter)'}
          </h3>
          <p className="text-xs text-gray-500">
            {selectedTable
              ? `Mã: ${selectedTable.maBan} • ${
                  Number(selectedTable.trangThai) === 2 ? 'Đang có khách' : 'Bàn trống'
                }`
              : 'Thanh toán nhanh 1 chạm (F9 / F10) hoặc tạo đơn chờ VietQR'}
          </p>
        </div>
        {cart.length > 0 && (
          <div className="flex items-center gap-2">
            {onHoldOrder && (
              <button
                type="button"
                onClick={onHoldOrder}
                className="min-h-12 px-3.5 py-2 rounded-xl bg-amber-100 hover:bg-amber-200 text-amber-900 text-xs font-extrabold cursor-pointer"
                title="Lưu tạm giỏ hàng để phục vụ khách sau (F4)"
              >
                ⏸️ Lưu tạm [F4]
              </button>
            )}
            <button
              type="button"
              onClick={onClearCart}
              className="min-h-12 px-3 py-2 rounded-xl bg-red-50 hover:bg-red-100 text-xs text-red-700 font-bold cursor-pointer"
            >
              Xóa giỏ
            </button>
          </div>
        )}
      </div>

      {/* Hóa đơn đang mở */}
      {activeInvoice && (
        <div className="p-3 rounded-xl bg-orange-50 border border-orange-200 space-y-2.5 text-xs">
          <div className="flex items-center justify-between font-bold text-orange-950 gap-2">
            <span className="flex items-center gap-1.5 flex-wrap">
              {Number(activeInvoice.soThuTuNgay) > 0 && (
                <span className="px-2 py-0.5 rounded-md bg-stone-900 text-amber-300 font-black text-xs">
                  SỐ #{String(activeInvoice.soThuTuNgay).padStart(2, '0')}
                </span>
              )}
              <span>🧾 HĐ #{activeInvoice.maHoaDon}</span>
              {activeInvoice.daInTamTinh && (
                <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px]">
                  Đã in tạm tính
                </span>
              )}
            </span>
            <div className="flex items-center gap-2">
              {canPay &&
                onOpenSplitBill &&
                (activeInvoice.danhSachMon || [])
                  .filter((m) => !m.daHuy && m.trangThaiPhaChe !== 'DaHuy')
                  .reduce((s, m) => s + Number(m.soLuong || 1), 0) > 1 && (
                  <button
                    type="button"
                    onClick={onOpenSplitBill}
                    className="min-h-12 px-3.5 py-2 rounded-xl bg-purple-100 hover:bg-purple-200 text-purple-900 text-xs font-extrabold cursor-pointer"
                    title="Tách lẻ theo số lượng ly hoặc chuyển ghép món sang bàn khác"
                  >
                    ✂️ Tách đơn
                  </button>
                )}
              <span className="text-sm font-black text-orange-800">{formatVND(invoiceTotal)}</span>
            </div>
          </div>

          <div className="max-h-36 overflow-y-auto divide-y divide-orange-200/60 pr-1">
            {activeInvoice.danhSachMon?.map((m) => {
              const isVoided = m.daHuy || m.trangThaiPhaChe === 'DaHuy'
              return (
                <div
                  key={m.maCTHD}
                  className={`py-1.5 flex justify-between items-start gap-2 ${
                    isVoided ? 'opacity-50 line-through' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <span className="font-semibold text-gray-800">
                      {m.tenMon} ({m.kichThuoc}) x{m.soLuong}
                    </span>
                    <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-white border text-gray-600">
                      {TRANG_THAI_PHA_CHE_LABEL[m.trangThaiPhaChe] || m.trangThaiPhaChe}
                    </span>
                    {m.toppings?.length > 0 && (
                      <p className="text-[11px] text-amber-800">
                        + {m.toppings.map((t) => `${t.tenTopping} (x${t.soLuong})`).join(', ')}
                      </p>
                    )}
                    {m.ghiChu && (
                      <p className="text-[11px] text-gray-500 italic">Ghi chú: {m.ghiChu}</p>
                    )}
                    {isVoided && m.lyDoHuy && (
                      <p className="text-[10px] text-red-600 no-underline">Lý do: {m.lyDoHuy}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-bold text-gray-800">{formatVND(m.thanhTien)}</span>
                    {!isVoided && canPay && onVoidInvoiceItem && (
                      <button
                        type="button"
                        onClick={() => onVoidInvoiceItem(m)}
                        className={`min-h-12 px-3 py-1.5 rounded-xl font-bold text-xs cursor-pointer ${
                          (activeInvoice.daInTamTinh || m.trangThaiPhaChe !== 'ChoPhaChe') && !isManager
                            ? 'bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300'
                            : 'bg-red-100 hover:bg-red-200 text-red-700'
                        }`}
                        title={
                          (activeInvoice.daInTamTinh || m.trangThaiPhaChe !== 'ChoPhaChe') && !isManager
                            ? 'Yêu cầu mã PIN Quản lý / Ca trưởng để phê duyệt hủy món'
                            : 'Hủy món này'
                        }
                      >
                        {(activeInvoice.daInTamTinh || m.trangThaiPhaChe !== 'ChoPhaChe') && !isManager
                          ? '🔒 Hủy (PIN)'
                          : 'Hủy'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Nút 🔥 Báo bếp ra Đợt 2 (Course Firing) nếu hóa đơn có món đang HELD */}
          {onFireCourse &&
            (activeInvoice.danhSachMon || []).some(
              (m) => !m.daHuy && m.trangThaiPhaChe !== 'DaHuy' && m.fireStatus === 'HELD'
            ) && (
              <button
                type="button"
                onClick={() => onFireCourse(activeInvoice.maHoaDon)}
                className="w-full min-h-11 px-3 py-2 rounded-xl bg-orange-600 hover:bg-orange-700 text-white font-extrabold text-xs shadow cursor-pointer"
              >
                🔥 Báo bếp ra Đợt 2 (
                {
                  (activeInvoice.danhSachMon || []).filter(
                    (m) => !m.daHuy && m.trangThaiPhaChe !== 'DaHuy' && m.fireStatus === 'HELD'
                  ).length
                }{' '}
                món đang chờ)
              </button>
            )}

          {/* Bảng Chia tiền Hóa đơn (Kiểu 2 Chia đều / Kiểu 3 Số tiền tùy ý — Thanh toán từng phần riêng biệt) */}
          {activeInvoice.danhSachChiaTien?.length > 0 && (
            <div className="p-2.5 rounded-xl bg-purple-50 border border-purple-200 space-y-1.5 text-[11px]">
              <p className="font-extrabold text-purple-900">➗ Bảng chia tiền ({activeInvoice.danhSachChiaTien.length} phần):</p>
              {activeInvoice.danhSachChiaTien.map((sh) => (
                <div key={sh.id} className="flex items-center justify-between gap-2 bg-white px-2 py-1.5 rounded-lg border border-purple-100">
                  <div>
                    <span className="font-bold text-gray-800">{sh.nhanChia}</span>
                    <span className="ml-2 font-black text-purple-800">{formatVND(sh.soTienPhaiTra)}</span>
                  </div>
                  {sh.trangThai === 'PAID' ? (
                    <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-extrabold text-[10px]">
                      ✅ ĐÃ THU
                    </span>
                  ) : (
                    canPay && (
                      <div className="flex gap-1">
                        <button
                          type="button"
                          disabled={paying}
                          onClick={() =>
                            onPayInvoice({
                              maHoaDon: activeInvoice.maHoaDon,
                              phuongThucTT: 'TIEN_MAT',
                              chiaTienId: sh.id,
                              choPhepThuMotPhan: true,
                            })
                          }
                          className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] cursor-pointer"
                        >
                          💵 TM
                        </button>
                        <button
                          type="button"
                          disabled={paying}
                          onClick={() =>
                            onPayInvoice({
                              maHoaDon: activeInvoice.maHoaDon,
                              phuongThucTT: 'CHUYEN_KHOAN',
                              chiaTienId: sh.id,
                              choPhepThuMotPhan: true,
                            })
                          }
                          className="px-2 py-1 rounded bg-sky-600 hover:bg-sky-700 text-white font-bold text-[10px] cursor-pointer"
                        >
                          📱 QR
                        </button>
                      </div>
                    )
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Hiển thị lịch sử các khoản đã thu trước (Split / Partial Payment) */}
          {activeInvoice.danhSachThanhToan?.length > 0 && (
            <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 space-y-1 text-[11px]">
              <p className="font-extrabold text-emerald-900">✅ Đã ghi nhận thanh toán 1 phần:</p>
              {activeInvoice.danhSachThanhToan.map((p) => (
                <div key={p.id} className="flex justify-between text-emerald-800">
                  <span>
                    {PTTT_BADGE[p.phuongThucTT] || p.phuongThucTT}{' '}
                    {p.nguonXacNhan?.includes('WEBHOOK') && (
                      <span className="px-1 py-0.5 rounded bg-emerald-200 text-[9px] font-bold">AUTO</span>
                    )}
                  </span>
                  <b>{formatVND(p.soTien)}</b>
                </div>
              ))}
              <div className="pt-1 border-t border-emerald-200 flex justify-between font-extrabold text-xs text-red-700">
                <span>Còn lại cần thu:</span>
                <span>{formatVND(conLaiCanThu)}</span>
              </div>
            </div>
          )}

          {/* Khu vực Thanh toán (4 chế độ: Tiền mặt / VietQR Auto / Thẻ / Hỗn hợp Split Tender) */}
          {canPay ? (
            <div className="pt-2 border-t border-orange-200 space-y-2.5">
              {/* Khuyến mãi (Happy Hour / Mã giảm giá) & Đổi điểm Loyalty cho Hóa đơn đang mở */}
              {Number(activeInvoice.tongGiamGia || 0) > 0 ? (
                <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-[11px] text-emerald-900 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-extrabold text-emerald-950">✅ Đã khóa ưu đãi lên hóa đơn (khớp VietQR):</span>
                    {daThanhToan === 0 && onClearPromo && (
                      <button
                        type="button"
                        onClick={onClearPromo}
                        className="px-2 py-0.5 rounded bg-white hover:bg-red-50 text-red-600 border border-red-200 font-bold text-[10px] cursor-pointer"
                        title="Gỡ khuyến mãi & hoàn lại điểm tạm giữ trên hóa đơn"
                      >
                        ✕ Gỡ ưu đãi
                      </button>
                    )}
                  </div>
                  {Number(activeInvoice.tienGiamKM || 0) > 0 && (
                    <div className="flex justify-between">
                      <span>🎁 {activeInvoice.tenKhuyenMai || (activeInvoice.maKhuyenMai ? `KM (${activeInvoice.maKhuyenMai})` : 'Khuyến mãi')}:</span>
                      <b>-{formatVND(activeInvoice.tienGiamKM)}</b>
                    </div>
                  )}
                  {Number(activeInvoice.tienGiamDiem || 0) > 0 && (
                    <div className="flex justify-between">
                      <span>⭐ Đổi {activeInvoice.diemSuDung} điểm Loyalty:</span>
                      <b>-{formatVND(activeInvoice.tienGiamDiem)}</b>
                    </div>
                  )}
                  <div className="flex justify-between border-t border-emerald-200 pt-1 font-extrabold text-xs">
                    <span>Còn phải thu:</span>
                    <span className="text-emerald-800">{formatVND(conLaiCanThu)}</span>
                  </div>
                </div>
              ) : (
                onApplyPromo && (
                  <div className="p-2.5 rounded-xl bg-white border border-amber-200 space-y-2 text-[11px]">
                    {activeHappyHours.length > 0 && !promoCodeSach && (
                      <div className="px-2 py-1 rounded-lg bg-amber-100 text-amber-950 font-bold">
                        ⏰ Happy Hour đang tự động áp dụng: {activeHappyHours[0].tenChuongTrinh}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={promoCodeInput}
                        onChange={(e) => onChangePromoCode?.(e.target.value.toUpperCase())}
                        placeholder="Mã giảm giá (VD: CAFE15)..."
                        className="flex-1 min-h-8 px-2 py-1 border border-gray-200 rounded-lg font-mono font-bold uppercase text-xs"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          onApplyPromo({
                            tongTamTinh: invoiceTotal,
                            maKhuyenMai: promoCodeSach || null,
                            maKH: khachHangHienTai?.maKH || null,
                            diemSuDung: diemMuonDoiNum,
                          })
                        }
                        className="px-2.5 min-h-8 rounded-lg bg-amber-700 hover:bg-amber-800 text-white font-bold cursor-pointer"
                      >
                        Áp dụng
                      </button>
                      {(promoCodeSach || diemMuonDoiNum > 0 || promoPreview) && onClearPromo && (
                        <button
                          type="button"
                          onClick={onClearPromo}
                          className="px-2 min-h-8 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold cursor-pointer"
                          title="Xóa mã / điểm đang chọn"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    {diemKhachCo > 0 && (
                      <div className="flex items-center justify-between gap-1.5 bg-indigo-50/70 border border-indigo-200 rounded-lg px-2 py-1">
                        <span className="font-bold text-indigo-950">
                          ⭐ Có {diemKhachCo} điểm ({formatVND(diemKhachCo * 1000)})
                        </span>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={0}
                            max={maxDiemCoTheDoi}
                            value={diemSuDungInput}
                            onChange={(e) => onChangeDiemSuDung?.(e.target.value.replace(/\D/g, ''))}
                            placeholder="Điểm đổi"
                            className="w-16 px-1.5 py-0.5 bg-white border border-indigo-300 rounded text-center font-extrabold text-xs"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              onChangeDiemSuDung?.(String(maxDiemCoTheDoi))
                              onApplyPromo({
                                tongTamTinh: invoiceTotal,
                                maKhuyenMai: promoCodeSach || null,
                                maKH: khachHangHienTai?.maKH || null,
                                diemSuDung: maxDiemCoTheDoi,
                              })
                            }}
                            className="px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-[10px] cursor-pointer"
                          >
                            Dùng tối đa
                          </button>
                        </div>
                      </div>
                    )}
                    {previewAppliesToInvoice && (
                      <div className="p-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 space-y-0.5">
                        {promoPreview.tienGiamKM > 0 && (
                          <div className="flex justify-between">
                            <span>🎁 {promoPreview.tenKhuyenMai || promoPreview.maKhuyenMai}:</span>
                            <b>-{formatVND(promoPreview.tienGiamKM)}</b>
                          </div>
                        )}
                        {promoPreview.tienGiamDiem > 0 && (
                          <div className="flex justify-between">
                            <span>⭐ Đổi {promoPreview.diemSuDung} điểm:</span>
                            <b>-{formatVND(promoPreview.tienGiamDiem)}</b>
                          </div>
                        )}
                        <div className="flex justify-between border-t border-emerald-200 pt-1 font-extrabold text-xs">
                          <span>Còn phải thu sau ưu đãi:</span>
                          <span className="text-emerald-800">{formatVND(conLaiCanThu)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )
              )}

              <div className="grid grid-cols-4 gap-2">
                {[
                  { id: 'TIEN_MAT', label: '💵 Mặt' },
                  { id: 'CHUYEN_KHOAN', label: '📱 VietQR' },
                  { id: 'THE', label: '💳 Thẻ' },
                  { id: 'HON_HOP', label: '🔀 Hỗn hợp' },
                ].map((pt) => (
                  <button
                    type="button"
                    key={pt.id}
                    onClick={() => setPhuongThucTT(pt.id)}
                    className={`min-h-12 py-2 rounded-xl font-bold text-xs border cursor-pointer ${
                      phuongThucTT === pt.id
                        ? 'bg-orange-700 text-white border-orange-700 shadow-sm'
                        : 'bg-white text-gray-700 border-gray-300'
                    }`}
                  >
                    {pt.label}
                  </button>
                ))}
              </div>

              {/* 1. Tiền mặt */}
              {phuongThucTT === 'TIEN_MAT' && (
                <div className="space-y-2">
                  {cashSuggestions.length > 0 && (
                    <div className="flex flex-wrap gap-2.5">
                      {cashSuggestions.map((val, idx) => (
                        <button
                          type="button"
                          key={val}
                          onClick={() => setTienKhachDua(String(val))}
                          className={`min-h-[52px] px-3.5 py-2 rounded-xl text-xs font-extrabold border cursor-pointer active:scale-95 ${
                            Number(tienKhachDua) === val
                              ? 'bg-emerald-700 text-white border-emerald-700'
                              : 'bg-white hover:bg-emerald-50 text-emerald-900 border-emerald-200'
                          }`}
                        >
                          {idx === 0 ? `Vừa đủ (${val / 1000}k)` : `${val / 1000}k`}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="space-y-2">
                    <input
                      type="number"
                      min="0"
                      value={tienKhachDua}
                      onChange={(e) => setTienKhachDua(e.target.value)}
                      placeholder="Tiền khách đưa (VND)..."
                      className="w-full min-h-[52px] px-3 py-2 bg-white border rounded-xl text-sm font-bold"
                    />
                    {tienThuaDuKien !== null && (
                      <div
                        data-testid="cash-change-due"
                        className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl border-2 ${
                          tienThuaDuKien >= 0
                            ? 'bg-emerald-50 border-emerald-400 text-emerald-900'
                            : 'bg-rose-50 border-rose-400 text-rose-800'
                        }`}
                      >
                        <span className="text-xs font-extrabold uppercase tracking-wide">
                          {tienThuaDuKien >= 0 ? '💵 Tiền thối lại khách' : '⚠️ Tiền khách đưa còn thiếu'}
                        </span>
                        <span className="text-xl font-black">
                          {formatVND(Math.abs(tienThuaDuKien))}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 2. VietQR Động + Auto Webhook */}
              {phuongThucTT === 'CHUYEN_KHOAN' && (
                <div className="bg-white rounded-xl border border-emerald-300 p-3 text-center space-y-2">
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-[10px] font-extrabold">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                    Tự động chốt đơn khi nhận tiền (SePay / PayOS)
                  </div>
                  {vietQrUrl ? (
                    <>
                      <img
                        src={vietQrUrl}
                        alt="Mã thanh toán VietQR"
                        className="w-40 h-40 mx-auto object-contain rounded-lg"
                      />
                      <p className="text-[11px] text-gray-700">
                        Số tiền: <b className="text-amber-800">{formatVND(conLaiCanThu)}</b> • ND CK:{' '}
                        <b className="font-mono bg-amber-50 px-1.5 py-0.5 rounded">{transferMemo}</b>
                      </p>
                      {emvcoPayload && (
                        <p className="text-[9px] text-emerald-700 font-mono truncate" title={emvcoPayload}>
                          ✓ EMVCo Napas247 cục bộ sẵn sàng (CRC16: {emvcoPayload.slice(-4)})
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="py-2 space-y-1.5">
                      <p className="text-[11px] text-gray-500">
                        Chưa cấu hình STK hiển thị QR (Nội dung CK tự khớp: <b>{transferMemo}</b>)
                      </p>
                      {onOpenBankConfig && (
                        <button
                          type="button"
                          onClick={onOpenBankConfig}
                          className="px-3 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-900 rounded-lg font-bold text-xs cursor-pointer"
                        >
                          ⚙️ Cấu hình STK VietQR
                        </button>
                      )}
                    </div>
                  )}

                  {/* [Phân hệ 3 - Trụ cột 2] Hộp thư Khớp tay 1 chạm (Manual Bank Match Queue) cho khách xóa nhầm nội dung CK */}
                  <div className="pt-1 border-t border-emerald-100 space-y-1.5 text-left">
                    <button
                      type="button"
                      onClick={handleLoadUnmatchedQr}
                      disabled={loadingUnmatched}
                      className="w-full py-1.5 px-2.5 rounded-lg bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-900 font-bold text-[11px] cursor-pointer"
                    >
                      {loadingUnmatched ? '⏳ Đang kiểm tra biến động ngân hàng...' : '📥 Tiền vừa về chưa khớp (30 phút)'}
                    </button>
                    {showUnmatchedQueue && (
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {unmatchedQrList.length === 0 ? (
                          <p className="text-[10px] text-gray-500 italic text-center py-1">
                            Chưa có giao dịch chuyển khoản chưa khớp nào trong 30 phút qua.
                          </p>
                        ) : (
                          unmatchedQrList.map((ev) => (
                            <div
                              key={ev.id}
                              className="p-2 rounded-lg bg-stone-50 border border-stone-200 space-y-1.5 text-[10px]"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="font-extrabold text-emerald-700">
                                    +{formatVND(ev.soTien)}
                                    {Number(ev.soTienConLai || 0) > 0 && (
                                      <span className="ml-1 text-amber-700">
                                        (Dư: {formatVND(ev.soTienConLai)})
                                      </span>
                                    )}
                                  </p>
                                  <p className="text-gray-600 truncate">{ev.noiDungCK || ev.maGiaoDichNgoai}</p>
                                </div>
                                {ev.trangThaiXuLy === 'UNMATCHED' && (
                                  <button
                                    type="button"
                                    onClick={() => handleMatchUnmatchedToCurrent(ev)}
                                    className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold shrink-0 cursor-pointer"
                                  >
                                    ✓ Khớp HĐ
                                  </button>
                                )}
                              </div>
                              {(ev.trangThaiXuLyDu === 'PENDING_ACTION' || Number(ev.soTienConLai || 0) > 0) && (
                                <div className="flex flex-wrap gap-1 pt-1 border-t border-stone-200">
                                  <button
                                    type="button"
                                    disabled={resolvingOverpayId === ev.id}
                                    onClick={() => handleResolveOverpayment(ev, 'CASH_RETURNED')}
                                    className="px-2 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white font-bold cursor-pointer disabled:opacity-50"
                                  >
                                    💵 Thối tiền mặt (THOI_CK_DU)
                                  </button>
                                  <button
                                    type="button"
                                    disabled={resolvingOverpayId === ev.id}
                                    onClick={() => handleResolveOverpayment(ev, 'TIP')}
                                    className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold cursor-pointer disabled:opacity-50"
                                  >
                                    🎉 Ghi nhận Tip
                                  </button>
                                  <button
                                    type="button"
                                    disabled={resolvingOverpayId === ev.id}
                                    onClick={() => handleResolveOverpayment(ev, 'WALLET_CREDITED')}
                                    className="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-700 text-white font-bold cursor-pointer disabled:opacity-50"
                                  >
                                    👛 Bảo lưu ví khách
                                  </button>
                                </div>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>

                  {/* [Wave 2 — P0-02] Bắt buộc đính kèm ảnh chụp chứng từ khi xác nhận chuyển khoản thủ công (POS_MANUAL_PROVISIONAL) */}
                  <div className="pt-1.5 border-t border-emerald-100 text-left space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-900 font-bold text-[11px] cursor-pointer">
                        <span>
                          {uploadingManualQr
                            ? '⏳ Đang tải ảnh CK...'
                            : manualQrIdChungTu
                            ? '📷 Đổi ảnh chứng từ CK'
                            : '📷 Ảnh chụp CK từ khách (Bắt buộc xác nhận tay)'}
                        </span>
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          data-testid="manual-qr-proof-file"
                          onChange={handleUploadManualQrProof}
                          className="hidden"
                        />
                      </label>
                      {manualQrPreview && (
                        <img
                          src={manualQrPreview}
                          alt="Chứng từ CK"
                          className="w-9 h-9 rounded-lg object-cover border border-emerald-300"
                        />
                      )}
                    </div>
                    {manualQrIdChungTu && (
                      <p className="text-[10px] text-emerald-700 font-semibold">
                        ✅ Đã lưu chứng từ xác nhận tạm: {manualQrIdChungTu}
                      </p>
                    )}
                  </div>

                  {isManager && onSimulateVietQr && conLaiCanThu > 0 && (
                    <button
                      type="button"
                      disabled={paying}
                      onClick={() => onSimulateVietQr(activeInvoice.maHoaDon, conLaiCanThu)}
                      className="w-full py-2 rounded-xl bg-sky-50 hover:bg-sky-100 border border-sky-300 text-sky-800 font-bold text-[11px] cursor-pointer"
                    >
                      🧪 Giả lập Webhook đã nhận CK ({formatVND(conLaiCanThu)})
                    </button>
                  )}
                </div>
              )}

              {/* 3. Thanh toán Hỗn hợp (Split Tender & Chia đều hóa đơn N người) */}
              {phuongThucTT === 'HON_HOP' && (
                <div className="bg-white rounded-xl border border-orange-200 p-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-gray-700 text-[11px]">
                      Chia nhiều phương thức (Cần thu: {formatVND(conLaiCanThu)})
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setSplitRows((prev) => [...prev, { phuongThucTT: 'VOUCHER', soTien: '' }])
                      }
                      className="text-[11px] font-bold text-amber-700 hover:underline cursor-pointer"
                    >
                      + Thêm dòng
                    </button>
                  </div>

                  {/* Chia đều hóa đơn cho N người (Equal Bill Split) */}
                  {conLaiCanThu > 0 && (
                    <div className="flex flex-wrap items-center gap-1 bg-orange-50/70 border border-orange-200/80 rounded-lg px-2 py-1.5">
                      <span className="text-[10px] font-extrabold text-orange-900 mr-0.5">
                        👥 Chia đều:
                      </span>
                      {[2, 3, 4, 5, 6].map((n) => {
                        const per = Math.floor(conLaiCanThu / n)
                        return (
                          <button
                            type="button"
                            key={n}
                            onClick={() => {
                              const rows = Array.from({ length: n }, (_, idx) => ({
                                phuongThucTT: idx === 0 ? 'TIEN_MAT' : 'CHUYEN_KHOAN',
                                soTien: String(
                                  idx === n - 1 ? conLaiCanThu - per * (n - 1) : per
                                ),
                              }))
                              setSplitRows(rows)
                            }}
                            className="px-2 py-0.5 rounded bg-white hover:bg-orange-100 border border-orange-300 text-orange-950 font-bold text-[10px] cursor-pointer"
                            title={`Chia đều ${formatVND(conLaiCanThu)} cho ${n} người (~${formatVND(per)}/người)`}
                          >
                            {n} người
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {splitRows.map((row, idx) => (
                    <div key={idx} className="flex items-center gap-1.5">
                      <select
                        value={row.phuongThucTT}
                        onChange={(e) =>
                          setSplitRows((prev) =>
                            prev.map((r, i) => (i === idx ? { ...r, phuongThucTT: e.target.value } : r))
                          )
                        }
                        className="px-2 py-2 bg-stone-50 border rounded-lg text-[11px] font-bold"
                      >
                        <option value="TIEN_MAT">💵 Tiền mặt</option>
                        <option value="CHUYEN_KHOAN">📱 VietQR</option>
                        <option value="THE">💳 Thẻ EDC</option>
                        <option value="VI_KHACH">👛 Ví thành viên</option>
                        <option value="VI_DIEN_TU">📲 Ví điện tử (MoMo/ZaloPay)</option>
                        <option value="SAN_GIAO_HANG">🛵 App Giao hàng</option>
                        <option value="VOUCHER">🎟️ Voucher</option>
                      </select>
                      <input
                        type="number"
                        min="0"
                        placeholder="Số tiền..."
                        value={row.soTien}
                        onChange={(e) =>
                          setSplitRows((prev) =>
                            prev.map((r, i) => (i === idx ? { ...r, soTien: e.target.value } : r))
                          )
                        }
                        className="flex-1 min-h-9 px-2.5 py-1.5 border rounded-lg text-xs font-bold"
                      />
                      {splitRemaining > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setSplitRows((prev) =>
                              prev.map((r, i) =>
                                i === idx
                                  ? { ...r, soTien: String((Number(r.soTien) || 0) + splitRemaining) }
                                  : r
                              )
                            )
                          }
                          className="px-2 py-1.5 rounded-lg bg-amber-100 text-amber-900 font-bold text-[10px] cursor-pointer shrink-0"
                          title="Điền nhanh phần tiền còn thiếu"
                        >
                          +Đủ
                        </button>
                      )}
                      {splitRows.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setSplitRows((prev) => prev.filter((_, i) => i !== idx))}
                          className="px-1.5 text-red-500 font-bold cursor-pointer"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}

                  {!isManager && splitRows.some((r) => r.phuongThucTT === 'VOUCHER') && (
                    <div className="p-2 rounded-lg bg-rose-50 border border-rose-200 space-y-1">
                      <label className="block text-[11px] font-bold text-rose-800">
                        🔐 Mã PIN Quản lý duyệt Voucher (bắt buộc cho Thu ngân) *
                      </label>
                      <input
                        type="password"
                        inputMode="numeric"
                        autoComplete="off"
                        value={voucherManagerPin}
                        onChange={(e) => setVoucherManagerPin(e.target.value)}
                        data-testid="split-voucher-manager-pin"
                        placeholder="Nhập PIN Quản lý..."
                        className="w-full px-2.5 py-1.5 bg-white border border-rose-300 rounded-lg text-xs font-bold"
                      />
                    </div>
                  )}

                  {splitEnteredTotal > conLaiCanThu && splitRows.some((r) => r.phuongThucTT === 'TIEN_MAT') && (
                    <div
                      data-testid="split-cash-change-due"
                      className="flex items-center justify-between px-3 py-2 rounded-xl bg-emerald-50 border-2 border-emerald-400 text-emerald-900"
                    >
                      <span className="text-xs font-extrabold uppercase tracking-wide">
                        💵 Tiền thối lại khách (Hỗn hợp)
                      </span>
                      <span className="text-xl font-black">
                        {formatVND(splitEnteredTotal - conLaiCanThu)}
                      </span>
                    </div>
                  )}

                  <div className="flex justify-between text-[11px] pt-1 border-t">
                    <span>Đã nhập: <b>{formatVND(splitEnteredTotal)}</b></span>
                    <span className={splitRemaining <= 0 ? 'text-emerald-700 font-bold' : 'text-red-600 font-bold'}>
                      {splitRemaining <= 0 ? '✓ Đủ chốt đơn' : `Còn thiếu: ${formatVND(splitRemaining)}`}
                    </span>
                  </div>
                </div>
              )}

              {/* Thanh nút hành động: In Bill / In Tem / Thanh toán (Touch Target 48px–56px) */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onPrintInvoice(activeInvoice)}
                  className="min-h-14 px-3.5 bg-white hover:bg-gray-100 text-gray-800 border border-gray-300 rounded-xl font-bold text-xs cursor-pointer"
                >
                  🖨️ Bill
                </button>
                {onPrintLabels && (
                  <button
                    type="button"
                    onClick={() => onPrintLabels(activeInvoice)}
                    className="min-h-14 px-3.5 bg-white hover:bg-gray-100 text-gray-800 border border-gray-300 rounded-xl font-bold text-xs cursor-pointer"
                  >
                    🏷️ Tem
                  </button>
                )}

                {phuongThucTT === 'HON_HOP' ? (
                  <button
                    type="button"
                    disabled={paying || (conLaiCanThu > 0 && validSplitRows.length === 0)}
                    onClick={() => {
                      const hasVoucher = validSplitRows.some((r) => r.phuongThucTT === 'VOUCHER')
                      if (hasVoucher && !isManager && !voucherManagerPin.trim()) {
                        toast.error('Vui lòng nhập mã PIN Quản lý để duyệt thanh toán bằng VOUCHER!')
                        return
                      }
                      const overCash = Math.max(0, splitEnteredTotal - conLaiCanThu)
                      let cashOverApplied = false
                      const payloadRows = validSplitRows.map((r) => {
                        if (r.phuongThucTT === 'TIEN_MAT' && overCash > 0 && !cashOverApplied) {
                          cashOverApplied = true
                          const netCash = Math.max(0, r.soTienNum - overCash)
                          return {
                            phuongThucTT: r.phuongThucTT,
                            soTien: netCash > 0 ? netCash : r.soTienNum,
                            tienKhachDua: r.soTienNum,
                          }
                        }
                        return {
                          phuongThucTT: r.phuongThucTT,
                          soTien: r.soTienNum,
                        }
                      })
                      onPayInvoice({
                        maHoaDon: activeInvoice.maHoaDon,
                        maKhuyenMai: promoCodeSach || null,
                        diemSuDung: diemMuonDoiNum,
                        thanhToan: payloadRows,
                        choPhepThuMotPhan: !splitEnough && conLaiCanThu > 0,
                        ...(voucherManagerPin.trim() ? { managerPin: voucherManagerPin.trim() } : {}),
                      })
                    }}
                    className={`flex-1 min-h-14 rounded-xl font-extrabold text-sm text-white shadow cursor-pointer disabled:bg-gray-300 ${
                      splitEnough || conLaiCanThu === 0
                        ? 'bg-emerald-600 hover:bg-emerald-700'
                        : 'bg-sky-600 hover:bg-sky-700'
                    }`}
                  >
                    {paying
                      ? 'Đang xử lý...'
                      : conLaiCanThu === 0
                      ? '✅ Chốt đơn 0đ (Ưu đãi/Điểm)'
                      : splitEnough
                      ? `✅ Thu hỗn hợp & Chốt (${formatVND(splitEnteredTotal)})`
                      : `⏳ Thu trước ${formatVND(splitEnteredTotal)} (Chờ QR phần còn lại)`}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={paying || cashInsufficient}
                    onClick={() => {
                      if (phuongThucTT === 'CHUYEN_KHOAN' && conLaiCanThu > 0 && !manualQrIdChungTu) {
                        toast.error('Xác nhận chuyển khoản thủ công bắt buộc đính kèm ảnh chụp chứng từ từ khách!')
                        return
                      }
                      onPayInvoice({
                        maHoaDon: activeInvoice.maHoaDon,
                        phuongThucTT,
                        maKhuyenMai: promoCodeSach || null,
                        diemSuDung: diemMuonDoiNum,
                        tienKhachDua:
                          phuongThucTT === 'TIEN_MAT' && tienKhachDua !== ''
                            ? Number(tienKhachDua)
                            : undefined,
                        ...(phuongThucTT === 'CHUYEN_KHOAN' && manualQrIdChungTu
                          ? { nguonXacNhan: 'POS_MANUAL_PROVISIONAL', idChungTu: manualQrIdChungTu }
                          : {}),
                      })
                    }}
                    className="flex-1 min-h-14 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-xl font-extrabold text-sm shadow cursor-pointer"
                  >
                    {paying
                      ? 'Đang thu tiền...'
                      : conLaiCanThu === 0
                      ? '✅ Chốt đơn 0đ (Ưu đãi/Điểm)'
                      : phuongThucTT === 'CHUYEN_KHOAN'
                      ? `Xác nhận tay (${formatVND(conLaiCanThu)})`
                      : `Thanh toán (${formatVND(conLaiCanThu)})`}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-amber-800 italic border-t border-orange-200 pt-2">
              🔒 Chỉ Thu ngân / Quản lý mới có quyền thanh toán hóa đơn.
            </p>
          )}
        </div>
      )}

      {/* Danh sách món mới trong giỏ (Tách sub-component bọc React.memo chống re-render khi gõ tiền/khuyến mãi) */}
      <CartItemList
        cart={cart}
        onUpdateQty={onUpdateQty}
        onUpdateNote={onUpdateNote}
        onSplitItem={onSplitItem}
        onCloneItem={onCloneItem}
        onEditItem={onEditItem}
        onToggleTakeaway={onToggleTakeaway}
        onToggleHoldCourse={onToggleHoldCourse}
        onRemoveItem={onRemoveItem}
      />

      {/* Footer gửi Order & Counter 1-Tap Quick Checkout */}
      <div className="border-t pt-3 space-y-2">
        <div className="flex justify-between items-center">
          <span className="text-xs font-bold text-gray-600">
            Tạm tính giỏ ({cart.reduce((s, i) => s + i.soLuong, 0)} ly):
          </span>
          <span className="text-xl font-black text-amber-700">{formatVND(cartTotal)}</span>
        </div>

        {!activeInvoice && cart.length > 0 && onApplyPromo && canPay && (
          <div className="p-2 rounded-xl bg-stone-50 border border-stone-200 space-y-1.5 text-[11px]">
            {activeHappyHours.length > 0 && !promoCodeSach && (
              <div className="px-2 py-1 rounded-lg bg-amber-100 text-amber-950 font-bold">
                ⏰ Happy Hour tự động: {activeHappyHours[0].tenChuongTrinh}
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={promoCodeInput}
                onChange={(e) => onChangePromoCode?.(e.target.value.toUpperCase())}
                placeholder="Mã giảm giá (nếu có)..."
                className="flex-1 px-2 py-1 bg-white border border-gray-200 rounded-lg font-mono font-bold uppercase text-xs"
              />
              <button
                type="button"
                onClick={() =>
                  onApplyPromo({
                    tongTamTinh: cartTotal,
                    maKhuyenMai: promoCodeSach || null,
                    maKH: customer?.maKH || null,
                    diemSuDung: diemMuonDoiNum,
                  })
                }
                className="px-2.5 py-1 rounded-lg bg-amber-700 hover:bg-amber-800 text-white font-bold cursor-pointer"
              >
                Kiểm tra
              </button>
            </div>
            {diemKhachCo > 0 && (
              <div className="flex items-center justify-between gap-1.5 bg-indigo-50 border border-indigo-200 rounded-lg px-2 py-1">
                <span className="font-bold text-indigo-950">
                  ⭐ Đổi điểm ({diemKhachCo}đ = {formatVND(diemKhachCo * 1000)})
                </span>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    max={maxDiemCoTheDoi}
                    value={diemSuDungInput}
                    onChange={(e) => onChangeDiemSuDung?.(e.target.value.replace(/\D/g, ''))}
                    placeholder="0"
                    className="w-14 px-1 py-0.5 bg-white border border-indigo-300 rounded text-center font-extrabold text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      onChangeDiemSuDung?.(String(maxDiemCoTheDoi))
                      onApplyPromo({
                        tongTamTinh: cartTotal,
                        maKhuyenMai: promoCodeSach || null,
                        maKH: customer?.maKH || null,
                        diemSuDung: maxDiemCoTheDoi,
                      })
                    }}
                    className="px-1.5 py-0.5 rounded bg-indigo-600 text-white font-bold text-[10px] cursor-pointer"
                  >
                    Max
                  </button>
                </div>
              </div>
            )}
            {promoPreview && promoPreview.tongGiamGia > 0 && (
              <div className="flex justify-between font-extrabold text-emerald-800 bg-emerald-50 px-2 py-1 rounded-lg border border-emerald-200">
                <span>Giảm ưu đãi/điểm: -{formatVND(promoPreview.tongGiamGia)}</span>
                <span>Thu: {formatVND(promoPreview.tongSauGiam)}</span>
              </div>
            )}
          </div>
        )}

        {upsellSuggestions.length > 0 && onQuickAddUpsell && (
          <div className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-xl p-2 space-y-1.5">
            <p className="text-[10px] font-extrabold uppercase text-amber-900">
              ✨ AI Smart Upsell — Gợi ý bán kèm 1 chạm
            </p>
            <div className="flex flex-wrap gap-1.5">
              {upsellSuggestions.slice(0, 3).map((u) => (
                <button
                  key={u.maMon}
                  type="button"
                  onClick={() => onQuickAddUpsell(u)}
                  className="px-2.5 py-1.5 rounded-lg bg-white hover:bg-amber-100 border border-amber-300 text-left text-[11px] font-extrabold text-amber-950 shadow-xs cursor-pointer transition"
                  title={u.lyDo}
                >
                  {u.badgeText}
                  {u.dangGiamGiaBanh && (
                    <span className="ml-1 px-1 py-0.5 rounded bg-red-600 text-white text-[9px]">
                      -{u.phanTramGiam}%
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {!activeInvoice && cart.length > 0 && onChangeSoTheRung && (
          <div className="flex items-center justify-between gap-2 bg-amber-50/70 border border-amber-200 rounded-xl px-2.5 py-1.5 text-xs">
            <span className="font-bold text-amber-950 shrink-0">🔔 Thẻ rung / STT:</span>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                max={999}
                value={soTheRung}
                onChange={(e) => onChangeSoTheRung(e.target.value.replace(/\D/g, '').slice(0, 3))}
                placeholder="Tự động 01→99"
                className="w-28 px-2 py-1 bg-white border border-amber-300 rounded-lg text-xs font-extrabold text-center text-stone-900"
              />
              {soTheRung && (
                <button
                  type="button"
                  onClick={() => onChangeSoTheRung('')}
                  className="text-stone-400 hover:text-red-600 font-bold px-1 cursor-pointer"
                  title="Xóa để tự động đánh số 01→99"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        )}

        {!selectedTable && !activeInvoice && canPay && onQuickCheckout && (
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => onQuickCheckout('TIEN_MAT')}
              disabled={submitting || paying || cart.length === 0}
              className="min-h-14 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-98 disabled:bg-gray-300 text-white font-extrabold text-sm shadow cursor-pointer"
              title="Bán nhanh 2 chạm: Thu tiền mặt vừa đủ, tự in bill + tem + đá két RJ11 (Phím tắt F9)"
            >
              💵 Tiền mặt nhanh [F9]
            </button>
            <button
              type="button"
              onClick={() => (onStartVietQrOrder ? onStartVietQrOrder() : onSubmitOrder())}
              disabled={submitting || paying || cart.length === 0}
              className="min-h-14 px-3 rounded-xl bg-sky-600 hover:bg-sky-700 active:scale-98 disabled:bg-gray-300 text-white font-extrabold text-sm shadow cursor-pointer"
              title="Tạo đơn và hiện mã VietQR chờ Webhook ngân hàng tự động xác nhận (Phím tắt F10)"
            >
              📱 Tạo QR chờ tiền [F10]
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={onSubmitOrder}
          disabled={submitting || cart.length === 0}
          className="w-full min-h-14 rounded-xl bg-amber-700 hover:bg-amber-800 active:scale-98 disabled:bg-gray-300 text-white font-extrabold text-sm shadow-md transition cursor-pointer"
        >
          {submitting
            ? 'Đang xử lý & trừ kho...'
            : activeInvoice
            ? '➕ Gọi thêm món vào Hóa đơn này'
            : selectedTable
            ? '🚀 Gửi Pha chế (Trả tiền sau tại bàn)'
            : '🚀 Tạo đơn chờ thanh toán / Quét VietQR Auto'}
        </button>
      </div>
    </div>
  )
})

export default Cart
