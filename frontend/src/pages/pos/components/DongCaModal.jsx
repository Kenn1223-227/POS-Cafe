import { useState } from 'react'
import toast from 'react-hot-toast'
import { caService } from '../../../services/caService'
import { useAuthStore } from '../../../store/authStore'
import { formatVND } from '../../../utils/format'
import { printZReportK80 } from '../../../utils/printHelper'
import ConfirmPinModal from '../../../components/ConfirmPinModal'

const MENH_GIA = [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000]

export function calcDenominationTotal(counts = {}) {
  return MENH_GIA.reduce((s, mg) => s + mg * (Number(counts[mg]) || 0), 0)
}

export function buildDenominationMap(counts = {}) {
  return Object.fromEntries(
    MENH_GIA.map((mg) => [String(mg), Math.floor(Number(counts[mg]) || 0)]).filter(([, sl]) => sl > 0)
  )
}

export function DenominationCounterGrid({ counts = {}, onChange, totalLabel = 'Tổng tiền mặt đã đếm:' }) {
  const total = calcDenominationTotal(counts)
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        {MENH_GIA.map((mg) => (
          <div
            key={mg}
            className="flex items-center justify-between gap-1.5 bg-stone-50 border border-stone-200 rounded-xl px-2.5 py-2"
          >
            <span className="text-xs font-bold text-stone-700">
              {mg >= 1000 ? `${mg / 1000}k` : mg}
            </span>
            <input
              type="number"
              min="0"
              placeholder="0"
              value={counts[mg] ?? ''}
              onChange={(e) => onChange({ ...counts, [mg]: e.target.value })}
              className="w-16 px-2 py-1.5 bg-white border rounded-lg text-xs font-bold text-right"
            />
          </div>
        ))}
      </div>
      <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 flex justify-between items-center">
        <span className="text-xs font-bold text-blue-900">{totalLabel}</span>
        <span className="text-lg font-black text-blue-800">{formatVND(total)}</span>
      </div>
    </div>
  )
}

// [P0/P1] Đối soát MÙ thực sự (Blind Cash Reconciliation) + Bảng đếm mệnh giá + Tiền giữ lại két + In Z-Report K80
export default function DongCaModal({
  isOpen,
  onClose,
  currentShift,
  preCloseWarning = null,
  preCloseCheck = null,
  outboxPendingCount = 0,
  onShiftClosed,
}) {
  const { user } = useAuthStore()
  const [useCounter, setUseCounter] = useState(true)
  const [counts, setCounts] = useState({})
  const [manualCash, setManualCash] = useState('')
  const [tienGiuLaiKet, setTienGiuLaiKet] = useState('')
  const [ghiChuChenhLech, setGhiChuChenhLech] = useState('')
  const [recountNeeded, setRecountNeeded] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [ketQuaChot, setKetQuaChot] = useState(null)
  const [confirmDongCaOpen, setConfirmDongCaOpen] = useState(false)

  if (!isOpen || (!currentShift && !ketQuaChot)) return null

  const preCheck = preCloseWarning || preCloseCheck || null
  const openOrdersCount = Number(
    preCheck?.soHoaDonDangMo ??
      (Array.isArray(preCheck?.openOrders) ? preCheck.openOrders.length : preCheck?.openOrders) ??
      0
  )
  const parkedCount = Number(preCheck?.soDonLuuTam ?? preCheck?.parkedOrdersCount ?? 0)
  const effectiveOutboxPending = Number(outboxPendingCount || preCheck?.outboxPendingCount || 0)
  const preCheckWarnings = [
    ...(Array.isArray(preCheck?.warnings) ? preCheck.warnings : []),
    ...(Array.isArray(preCheck?.blockingReasons) ? preCheck.blockingReasons : []),
  ]
  const hasPreCloseAlert =
    openOrdersCount > 0 ||
    parkedCount > 0 ||
    Number(preCheck?.soBanChuaDong || 0) > 0 ||
    effectiveOutboxPending > 0 ||
    preCheckWarnings.length > 0

  const maCaHienThi = currentShift?.maCaThuNgan || ketQuaChot?.doiSoat?.maCaThuNgan
  const tongTuMenhGia = calcDenominationTotal(counts)
  const tienThucTeNum = useCounter ? tongTuMenhGia : manualCash === '' ? null : Number(manualCash)

  const handleCloseAndReset = () => {
    setCounts({})
    setManualCash('')
    setTienGiuLaiKet('')
    setGhiChuChenhLech('')
    setRecountNeeded(false)
    setKetQuaChot(null)
    onClose()
  }

  const handlePrintZReport = async (doiSoat) => {
    if (!doiSoat) return
    setPrinting(true)
    try {
      const res = await printZReportK80(doiSoat, {
        tenQuan: user?.tenQuan || '',
        nguoiIn: user?.tenNV || '',
        laBanSao: false,
      })
      if (res?.mode === 'BRIDGE') {
        toast.success(`🖨️ Đã in phiếu chốt ca Z-Report Ca #${doiSoat.maCaThuNgan} (Silent Print)`)
      }
    } finally {
      setPrinting(false)
    }
  }

  const handleDongCa = (e) => {
    e.preventDefault()
    if (outboxPendingCount > 0) {
      toast.error(`Còn ${outboxPendingCount} đơn Offline chưa đồng bộ lên server! Vui lòng đồng bộ trước khi đóng ca.`)
      return
    }
    if (tienThucTeNum === null || Number.isNaN(tienThucTeNum) || tienThucTeNum < 0) {
      toast.error('Vui lòng kiểm đếm và nhập số tiền mặt thực tế (>= 0)!')
      return
    }
    if (recountNeeded && ghiChuChenhLech.trim().length < 10) {
      toast.error('Vui lòng nhập lý do giải trình chênh lệch tối thiểu 10 ký tự để xác nhận lần 2!')
      return
    }
    setConfirmDongCaOpen(true)
  }

  const executeDongCa = async () => {
    setConfirmDongCaOpen(false)
    const chiTietMenhGia = useCounter ? buildDenominationMap(counts) : undefined

    setSubmitting(true)
    try {
      const res = await caService.dongCa(tienThucTeNum, {
        ghiChuChenhLech: ghiChuChenhLech.trim() || undefined,
        chiTietMenhGia: chiTietMenhGia && Object.keys(chiTietMenhGia).length > 0 ? chiTietMenhGia : undefined,
        tienGiuLaiKet: Math.max(0, Number(tienGiuLaiKet || 0)),
        confirmRecount: recountNeeded,
        outboxPendingCount,
      })
      toast.success(res.message || 'Đã chốt ca thành công!')
      setRecountNeeded(false)
      setKetQuaChot(res)
      onShiftClosed()
    } catch (err) {
      if (err?.response?.status === 422 && err?.response?.data?.code === 'BLIND_RECOUNT_REQUIRED') {
        setRecountNeeded(true)
        toast.error(err.response.data.message || 'Số tiền đang chênh lệch! Vui lòng kiểm đếm lại lần 2 và nhập lý do giải trình.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b pb-3">
          <div>
            <h3 className="font-extrabold text-base text-gray-800">
              🔒 Đóng Ca &amp; Kiểm Đếm Tiền Mặt (Blind Drop)
            </h3>
            <p className="text-xs text-gray-500">
              Ca #{maCaHienThi} • Hệ thống chỉ đối chiếu sau khi bạn xác nhận đếm xong
            </p>
          </div>
          <button
            type="button"
            onClick={handleCloseAndReset}
            className="w-10 h-10 rounded-full bg-gray-100 hover:bg-gray-200 font-bold text-gray-600 cursor-pointer"
          >
            ✕
          </button>
        </div>

        {/* Sau khi chốt thành công: hiển thị biên bản Z-Report đối chiếu & nút in nhiệt K80 */}
        {ketQuaChot ? (
          <div className="space-y-4">
            <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 space-y-2 text-xs">
              <h4 className="font-extrabold text-sm text-emerald-900">
                ✅ Biên Bản Chốt Ca (Z-Report) • {Number(ketQuaChot.doiSoat?.doanhThu?.soHoaDon || 0)} đơn
              </h4>
              <div className="flex justify-between">
                <span>Tiền đầu ca:</span>
                <b>{formatVND(ketQuaChot.doiSoat?.tienMatDauCa)}</b>
              </div>
              <div className="flex justify-between">
                <span>Doanh thu tiền mặt:</span>
                <b className="text-emerald-700">+{formatVND(ketQuaChot.doiSoat?.doanhThu?.tienMat)}</b>
              </div>
              <div className="flex justify-between">
                <span>Chuyển khoản / Thẻ:</span>
                <b>
                  {formatVND(
                    (ketQuaChot.doiSoat?.doanhThu?.chuyenKhoan || 0) +
                      (ketQuaChot.doiSoat?.doanhThu?.the || 0)
                  )}
                </b>
              </div>
              {Number(ketQuaChot.doiSoat?.hoanTien?.tienMat || 0) > 0 && (
                <div className="flex justify-between">
                  <span>Hoàn tiền mặt sau TT:</span>
                  <b className="text-rose-700">-{formatVND(ketQuaChot.doiSoat.hoanTien.tienMat)}</b>
                </div>
              )}
              <div className="flex justify-between">
                <span>Thu / Chi lặt vặt:</span>
                <b>
                  +{formatVND(ketQuaChot.doiSoat?.thuLatVat)} / -
                  {formatVND(ketQuaChot.doiSoat?.chiLatVat)}
                </b>
              </div>
              <div className="flex justify-between">
                <span>🏦 Rút két an toàn (Safe Drop):</span>
                <b className="text-indigo-700">-{formatVND(ketQuaChot.doiSoat?.rutKet || 0)}</b>
              </div>
              <hr className="border-emerald-200" />
              <div className="flex justify-between text-sm">
                <span>Quỹ lý thuyết tại két:</span>
                <b>{formatVND(ketQuaChot.doiSoat?.tienMatLyThuyet)}</b>
              </div>
              <div className="flex justify-between text-sm">
                <span>Tiền mặt thực tế kiểm đếm:</span>
                <b className="text-blue-700">{formatVND(ketQuaChot.doiSoat?.tienMatThucTe)}</b>
              </div>
              <div
                className={`p-2.5 rounded-xl font-extrabold flex justify-between text-sm ${
                  ketQuaChot.doiSoat?.chenhLech === 0
                    ? 'bg-emerald-200/70 text-emerald-900'
                    : 'bg-red-100 text-red-800'
                }`}
              >
                <span>Chênh lệch ({ketQuaChot.doiSoat?.trangThai}):</span>
                <span>{formatVND(ketQuaChot.doiSoat?.chenhLech)}</span>
              </div>
              {ketQuaChot.soHoaDonDangMo > 0 && (
                <p className="text-amber-800 font-semibold pt-1">
                  ⚠️ Lưu ý: Hiện còn {ketQuaChot.soHoaDonDangMo} hóa đơn chưa thanh toán chuyển sang ca sau.
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                disabled={printing}
                onClick={() => handlePrintZReport(ketQuaChot.doiSoat)}
                className="flex-1 min-h-12 bg-amber-700 hover:bg-amber-800 text-white font-extrabold rounded-xl text-sm shadow cursor-pointer disabled:opacity-50"
              >
                {printing ? 'Đang gửi máy in...' : '🖨️ In phiếu Z-Report (K80)'}
              </button>
              <button
                type="button"
                onClick={handleCloseAndReset}
                className="px-5 min-h-12 bg-stone-900 hover:bg-stone-800 text-white font-bold rounded-xl text-sm cursor-pointer"
              >
                Đóng
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleDongCa} className="space-y-4">
            {hasPreCloseAlert && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-300 text-xs text-rose-900 space-y-1">
                <p className="font-extrabold">⚠️ Cảnh báo trước khi đóng ca (Pre-Close Check):</p>
                {openOrdersCount > 0 && (
                  <p>• Còn {openOrdersCount} hóa đơn/bàn đang mở chưa thanh toán.</p>
                )}
                {parkedCount > 0 && (
                  <p>• Còn {parkedCount} đơn lưu tạm chưa xử lý.</p>
                )}
                {effectiveOutboxPending > 0 && (
                  <p>• Còn {effectiveOutboxPending} đơn offline (Outbox) chưa đồng bộ lên máy chủ.</p>
                )}
                {preCheckWarnings.map((w, idx) => (
                  <p key={idx}>• {typeof w === 'string' ? w : w.message || JSON.stringify(w)}</p>
                ))}
              </div>
            )}

            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900">
              🛡️ <b>Chế độ Kiểm tiền mù (Chống gian lận):</b> Hãy đếm chính xác toàn bộ tiền mặt
              trong két theo từng tờ tiền rồi xác nhận. Số chênh lệch sẽ được ghi nhận vào nhật ký kiểm toán.
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setUseCounter(true)}
                className={`flex-1 min-h-10 rounded-xl text-xs font-bold border cursor-pointer ${
                  useCounter ? 'bg-amber-700 text-white border-amber-700' : 'bg-gray-50 text-gray-700'
                }`}
              >
                🧮 Đếm theo mệnh giá tờ
              </button>
              <button
                type="button"
                onClick={() => setUseCounter(false)}
                className={`flex-1 min-h-10 rounded-xl text-xs font-bold border cursor-pointer ${
                  !useCounter ? 'bg-amber-700 text-white border-amber-700' : 'bg-gray-50 text-gray-700'
                }`}
              >
                ⌨️ Nhập tổng trực tiếp
              </button>
            </div>

            {useCounter ? (
              <DenominationCounterGrid
                counts={counts}
                onChange={setCounts}
                totalLabel="Tổng tiền mặt đã đếm:"
              />
            ) : (
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  Tổng tiền mặt kiểm đếm thực tế (VND) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  required
                  min="0"
                  value={manualCash}
                  onChange={(e) => setManualCash(e.target.value)}
                  placeholder="Nhập chính xác số tiền trong két..."
                  className="w-full min-h-12 px-3.5 py-2.5 border rounded-xl text-base font-bold outline-none focus:ring-2 focus:ring-amber-600"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">
                💰 Tiền lẻ giữ lại két cho ca sau (VND)
              </label>
              <input
                type="number"
                min="0"
                step="1000"
                value={tienGiuLaiKet}
                onChange={(e) => setTienGiuLaiKet(e.target.value)}
                data-testid="dongca-tien-giu-lai-ket"
                placeholder="VD: 500000 (để khớp quỹ bàn giao đầu ca sau)"
                className="w-full min-h-11 px-3 py-2 border rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-amber-600"
              />
            </div>

            {recountNeeded && (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-300 text-xs text-amber-900 font-semibold">
                ⚠️ Số tiền kiểm đếm đang chênh lệch so với sổ quỹ. Vui lòng kiểm tra lại ngăn kéo / tờ tiền kẹt và nhập giải trình (tối thiểu 10 ký tự) để xác nhận lần 2.
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">
                {recountNeeded ? 'Lý do giải trình chênh lệch (bắt buộc ≥ 10 ký tự) *' : 'Ghi chú bàn giao / Giải trình (nếu có)'}
              </label>
              <input
                type="text"
                required={recountNeeded}
                value={ghiChuChenhLech}
                onChange={(e) => setGhiChuChenhLech(e.target.value)}
                placeholder={recountNeeded ? 'VD: Đã đếm lại lần 2, hụt do thối nhầm tiền lẻ...' : 'VD: Bàn giao đầy đủ tiền lẻ, không phát sinh bất thường...'}
                className="w-full min-h-11 px-3 py-2 border rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-600"
              />
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={handleCloseAndReset}
                className="flex-1 min-h-12 border rounded-xl text-xs font-bold text-gray-700 cursor-pointer hover:bg-gray-50"
              >
                Hủy bỏ
              </button>
              <button
                type="submit"
                disabled={submitting || outboxPendingCount > 0}
                className="flex-1 min-h-12 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-extrabold shadow cursor-pointer disabled:opacity-50"
              >
                {submitting ? 'Đang chốt & đối chiếu...' : 'Xác nhận Chốt Ca'}
              </button>
            </div>
          </form>
        )}
      </div>
      <ConfirmPinModal
        open={confirmDongCaOpen}
        mode="confirm"
        danger
        title="Xác nhận Chốt Ca"
        message={`Xác nhận chốt ca với tiền mặt thực tế ${formatVND(tienThucTeNum)}?`}
        confirmText="Chốt ca ngay"
        onConfirm={executeDongCa}
        onCancel={() => setConfirmDongCaOpen(false)}
      />
    </div>
  )
}
