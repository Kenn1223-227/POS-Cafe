import { useState, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'
import { caService } from '../../services/caService'
import { useAuthStore } from '../../store/authStore'
import FeatureLockedCard from '../../components/FeatureLockedCard'
import FraudAlertConfigPanel from './components/FraudAlertConfigPanel'
import { hasFeatureFlag } from '../../utils/featureFlags'
import { formatVND, formatDateTime, getTodayISO } from '../../utils/format'
import { printZReportK80 } from '../../utils/printHelper'
import DenominationCounterGrid from '../../components/DenominationCounterGrid'

const AUDIT_LABELS = {
  SHIFT_OPEN: '🟢 Mở ca',
  SHIFT_CLOSE: '🔒 Chốt ca',
  CASH_PAYIN: '📥 Thu lặt vặt',
  CASH_PAYOUT: '📤 Chi lặt vặt',
  CASH_SAFE_DROP: '🏦 Rút két an toàn (Safe Drop)',
  ITEM_VOID_RETURN_STOCK: '↩️ Hủy món (Hoàn kho)',
  ITEM_VOID_WASTE: '🗑️ Hủy món (Hao hụt)',
  PREBILL_PRINT: '🧾 In tạm tính',
  RECEIPT_PRINT: '🖨️ In hóa đơn',
  RECEIPT_REPRINT: '⚠️ In lại hóa đơn',
  TABLE_MOVE: '🔄 Chuyển bàn',
  TABLE_MERGE: '🔗 Gộp bàn',
  ORDER_SPLIT: '✂️ Tách hóa đơn',
  MANAGER_PIN_UPDATED: '🔢 Cập nhật PIN Quản lý',
  DRAWER_NO_SALE_KICK: '💰 Mở két tiền không bán (No-Sale)',
  MENU_86_TOGGLE: '🚫 Báo hết/Mở món',
  INVENTORY_STOCK_IN: '📦 Nhập kho',
  INVENTORY_WASTAGE: '🗑️ Xuất hủy kho',
  INVENTORY_STOCKTAKE: '📋 Kiểm kê kho',
  SPLIT_PAYMENT_SETTLED: '🔀 Chốt thanh toán hỗn hợp',
  PARTIAL_PAYMENT_RECORDED: '⏳ Thu trước 1 phần',
  VIETQR_AUTO_SETTLED: '📱 VietQR tự động chốt đơn',
  VIETQR_PARTIAL_RECEIVED: '📱 VietQR nhận CK 1 phần',
  MANUAL_TRANSFER_CONFIRMED: '⚠️ Xác nhận CK thủ công tại quầy',
  OFFLINE_ORDER_SYNCED: '📡 Đồng bộ đơn Offline',
  TENANT_REGISTERED: '🎁 Khởi tạo bản dùng thử 30 ngày',
  SUBSCRIPTION_ACTIVATED: '💳 Kích hoạt bản chính thức',
  SAAS_PLAN_CHANGED: '💎 Đổi gói cước SaaS',
  AI_MENU_IMPORTED: '✨ AI Import thực đơn',
  BANK_SETTINGS_UPDATED: '🏦 Đổi STK VietQR nhận tiền',
  RECIPE_UPDATED: '🧪 Sửa công thức BOM',
  TOPPING_BOM_UPDATED: '🧋 Sửa công thức BOM Topping',
  UOM_UPDATED: '📐 Cập nhật quy đổi đơn vị kho',
  PRICE_UPDATED: '🏷️ Đổi giá / Sửa món',
  PRODUCT_DELETED: '❌ Ngừng bán món',
  TOPPING_86_TOGGLE: '🚫 Báo hết/Mở topping',
  STAFF_CREATED: '👤 Tạo tài khoản nhân viên',
  STAFF_STATUS_CHANGED: '🔐 Khóa/Mở tài khoản nhân viên',
  STAFF_PASSWORD_RESET: '🔑 Đặt lại mật khẩu nhân viên',
  PLATFORM_BILLING_APPROVED: '🛡️ Super Admin duyệt gói bản quyền',
  PLATFORM_TENANT_UPDATED: '⚙️ Super Admin cập nhật gói/Feature Flags',
  PLATFORM_IMPERSONATION_STARTED: '🕵️ Super Admin mở phiên hỗ trợ 15p',
  ORDER_POST_PAYMENT_REFUND: '↩️ Hoàn tiền / Hủy đơn sau thanh toán',
  ORPHAN_PAYMENTS_ATTACHED: '🔗 Gắn giao dịch VietQR ngoài giờ vào ca mới',
  INGREDIENT_86_CASCADE: '📦 Khóa/Mở 86 hàng loạt theo nguyên liệu',
  FRAUD_ALERT_CONFIG_UPDATED: '🔔 Cập nhật cảnh báo gian lận Telegram/Webhook',
  PROMOTION_CREATED: '🎁 Tạo chương trình khuyến mãi / Happy Hour',
  STAFF_PIN_SWITCH: '🔄 Đổi nhân viên nhanh bằng mã PIN',
}

export default function CaLamViec() {
  const { user } = useAuthStore()
  const allowAuditLogs = hasFeatureFlag(user, 'audit_logs')
  const allowVietQrWebhook = hasFeatureFlag(user, 'vietqr_webhook')
  const [tuNgay, setTuNgay] = useState(() => getTodayISO())
  const [denNgay, setDenNgay] = useState(() => getTodayISO())
  const [danhSachCa, setDanhSachCa] = useState([])
  const [selectedCa, setSelectedCa] = useState(null)
  const [thuChiList, setThuChiList] = useState([])
  const [auditLogs, setAuditLogs] = useState([])
  const [vietQrLogs, setVietQrLogs] = useState([])

  const [tienThucTeInput, setTienThucTeInput] = useState('')
  const [chiTietMenhGia, setChiTietMenhGia] = useState({})
  const [tienGiuLaiKet, setTienGiuLaiKet] = useState('0')
  const [recountNeeded, setRecountNeeded] = useState(false)
  const [ghiChuChenhLech, setGhiChuChenhLech] = useState('')
  const [doiSoatResult, setDoiSoatResult] = useState(null)
  const [eodRecon, setEodRecon] = useState(null)
  const [edcInput, setEdcInput] = useState('')
  const [loadingAction, setLoadingAction] = useState(false)

  // [Phân hệ 3 - Blind Drop Tuyệt đối] Chỉ Quản lý / tài khoản có quyền shift.view_x_report mới thấy nút Kiểm tra quỹ (X-Report)
  const canViewXReport =
    Number(user?.vaiTro) === 1 || Boolean(user?.permissionsOverride?.['shift.view_x_report'])

  const handleSelectCa = useCallback(async (ca) => {
    setSelectedCa(ca)
    setDoiSoatResult(null)
    setTienThucTeInput(ca?.tienMatThucTe !== null && ca?.tienMatThucTe !== undefined ? String(ca.tienMatThucTe) : '')
    if (!ca) {
      setThuChiList([])
      return
    }
    try {
      const tc = await caService.getDanhSachThuChi(ca.maCaThuNgan)
      setThuChiList(tc)
    } catch {
      setThuChiList([])
    }
  }, [])

  const loadCaData = useCallback(async () => {
    try {
      const [list, logs, vqrLogs] = await Promise.all([
        caService.getDanhSachCa(tuNgay, denNgay),
        allowAuditLogs ? caService.getAuditLogs(60).catch(() => []) : Promise.resolve([]),
        allowVietQrWebhook ? caService.getVietQrLogs(50).catch(() => []) : Promise.resolve([]),
      ])
      setDanhSachCa(list)
      setAuditLogs(Array.isArray(logs) ? logs : [])
      setVietQrLogs(Array.isArray(vqrLogs) ? vqrLogs : [])
      if (list.length > 0) {
        setSelectedCa((prev) => {
          const target = prev ? list.find((c) => c.maCaThuNgan === prev.maCaThuNgan) || list[0] : list[0]
          // Gọi tải thu/chi cho ca được chọn mặc định (sửa bug trống bảng thu/chi ban đầu)
          handleSelectCa(target)
          return target
        })
      } else {
        setSelectedCa(null)
        setThuChiList([])
      }
    } catch {
      // Interceptor xử lý
    }
  }, [tuNgay, denNgay, handleSelectCa, allowAuditLogs, allowVietQrWebhook])

  useEffect(() => {
    const t = setTimeout(() => {
      void loadCaData()
    }, 0)
    return () => clearTimeout(t)
  }, [loadCaData])

  const handleCheckDoiSoat = async (e) => {
    e?.preventDefault()
    if (!selectedCa || tienThucTeInput === '') {
      toast.error('Vui lòng nhập tiền mặt kiểm đếm thực tế!')
      return
    }
    setLoadingAction(true)
    try {
      const res = await caService.doiSoat({
        maCaThuNgan: selectedCa.maCaThuNgan,
        tienMatThucTe: Number(tienThucTeInput),
      })
      setDoiSoatResult(res.doiSoat)
      toast.success('Đã tính toán đối soát ca')
    } catch {
      // Interceptor xử lý
    } finally {
      setLoadingAction(false)
    }
  }

  const handleDongCa = async () => {
    if (!selectedCa || tienThucTeInput === '') {
      toast.error('Vui lòng nhập kiểm đếm mệnh giá / số tiền thực tế trước khi chốt ca!')
      return
    }
    if (recountNeeded && ghiChuChenhLech.trim().length < 10) {
      toast.error('Vui lòng nhập lý do giải trình chênh lệch tối thiểu 10 ký tự để xác nhận lần 2!')
      return
    }
    if (!window.confirm(`Xác nhận chốt ca #${selectedCa.maCaThuNgan}? Sau khi chốt sẽ đóng băng Z-Report bất biến.`)) return

    setLoadingAction(true)
    try {
      const res = await caService.dongCa(Number(tienThucTeInput), {
        maCaThuNgan: selectedCa.maCaThuNgan,
        chiTietMenhGia: Object.keys(chiTietMenhGia).length > 0 ? chiTietMenhGia : undefined,
        tienGiuLaiKet: Number(tienGiuLaiKet || 0),
        confirmRecount: recountNeeded,
        ghiChuChenhLech: ghiChuChenhLech.trim() || undefined,
      })
      toast.success(res.message || 'Đã chốt ca thành công!')
      setRecountNeeded(false)
      setGhiChuChenhLech('')
      setDoiSoatResult(res.doiSoat)
      await loadCaData()
    } catch (err) {
      if (err?.response?.status === 422 && err?.response?.data?.code === 'BLIND_RECOUNT_REQUIRED') {
        setRecountNeeded(true)
        toast.error(err.response.data.message || 'Số tiền đang chênh lệch! Vui lòng kiểm đếm lại 1 lần nữa.')
      }
    } finally {
      setLoadingAction(false)
    }
  }

  const handleConfirmSafeDrop = async (maPhieuTC, status) => {
    setLoadingAction(true)
    try {
      const res = await caService.confirmSafeDrop(maPhieuTC, { status })
      toast.success(res.message)
      if (selectedCa) await handleSelectCa(selectedCa)
    } catch {
      // Interceptor xử lý
    } finally {
      setLoadingAction(false)
    }
  }

  const handleCheckEodReconciliation = async () => {
    setLoadingAction(true)
    try {
      const res = await caService.getEodReconciliation({
        tuNgay,
        denNgay,
        ...(selectedCa ? { maCaThuNgan: selectedCa.maCaThuNgan } : {}),
        ...(edcInput !== '' ? { tongChotLoEDC: Number(edcInput) } : {}),
      })
      setEodRecon(res)
      if (selectedCa && edcInput !== '') {
        await caService.settleEdcBatch({
          maCaThuNgan: selectedCa.maCaThuNgan,
          tongChotLoEDC: Number(edcInput),
        })
      }
      toast.success('Đã hoàn tất đối soát 3 chiều Ngân hàng & Chốt lô EDC!')
    } catch {
      // Interceptor xử lý
    } finally {
      setLoadingAction(false)
    }
  }

  const handlePrintShiftZReport = async (ca = selectedCa) => {
    if (!ca) return
    setLoadingAction(true)
    try {
      let ds = doiSoatResult && doiSoatResult.maCaThuNgan === ca.maCaThuNgan ? doiSoatResult : null
      if (!ds) {
        const params = { maCaThuNgan: ca.maCaThuNgan }
        if (ca.trangThaiCa !== 2 && tienThucTeInput !== '') {
          params.tienMatThucTe = Number(tienThucTeInput)
        }
        const res = await caService.doiSoat(params)
        ds = res.doiSoat
        setDoiSoatResult(ds)
      }
      const printRes = await printZReportK80(ds, {
        tenQuan: user?.tenQuan || '',
        nguoiIn: user?.tenNV || '',
        laBanSao: ca.trangThaiCa === 2,
      })
      if (printRes?.mode === 'BRIDGE') {
        toast.success(`🖨️ Đã in Z-Report Ca #${ca.maCaThuNgan} (Silent Print)`)
      }
    } catch {
      // Interceptor xử lý
    } finally {
      setLoadingAction(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-extrabold text-gray-800">
        🕒 Ca Thu Ngân, Đối Soát Quỹ & Nhật Ký Kiểm Toán (Anti-Fraud)
      </h1>

      <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-200 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-bold text-gray-800 text-sm">Lịch sử Ca Thu Ngân</h3>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={tuNgay}
            onChange={(e) => setTuNgay(e.target.value)}
            className="px-2.5 py-1.5 border rounded-xl text-xs outline-none"
          />
          <span className="text-gray-400">→</span>
          <input
            type="date"
            value={denNgay}
            onChange={(e) => setDenNgay(e.target.value)}
            className="px-2.5 py-1.5 border rounded-xl text-xs outline-none"
          />
          <button
            onClick={loadCaData}
            className="px-3.5 py-1.5 bg-amber-700 hover:bg-amber-800 text-white rounded-xl text-xs font-bold cursor-pointer"
          >
            Lọc ca
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 bg-white p-4 rounded-2xl shadow-sm border border-gray-200 space-y-3 max-h-[620px] overflow-y-auto">
          <h4 className="font-bold text-xs uppercase text-gray-500">Danh sách ca ({danhSachCa.length})</h4>
          {danhSachCa.length === 0 ? (
            <p className="text-xs text-gray-400 py-8 text-center">Không có ca thu ngân nào trong khoảng thời gian này</p>
          ) : (
            <div className="space-y-2">
              {danhSachCa.map((ca) => {
                const isSelected = selectedCa?.maCaThuNgan === ca.maCaThuNgan
                return (
                  <div
                    key={ca.maCaThuNgan}
                    onClick={() => handleSelectCa(ca)}
                    className={`p-3.5 rounded-xl border transition cursor-pointer flex justify-between items-center ${
                      isSelected ? 'border-amber-700 bg-amber-50/70 shadow-sm' : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <div>
                      <p className="font-bold text-gray-800 text-xs">
                        Ca #{String(ca.maCaThuNgan).slice(0, 8)} • {ca.tenNV}
                      </p>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        Mở: {formatDateTime(ca.thoiGianMoCa)}
                      </p>
                      {ca.chenhLech !== null && ca.chenhLech !== 0 && (
                        <p className="text-[11px] font-bold text-red-600 mt-0.5">
                          ⚠️ Lệch quỹ: {formatVND(ca.chenhLech)}
                        </p>
                      )}
                    </div>
                    <span
                      className={`px-2.5 py-1 rounded-full text-[10px] font-extrabold ${
                        ca.trangThaiCa === 2 ? 'bg-emerald-100 text-emerald-800' : 'bg-orange-100 text-orange-800'
                      }`}
                    >
                      {ca.trangThaiCa === 2 ? 'Đã chốt ca' : 'Đang mở'}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="lg:col-span-7 space-y-4">
          {selectedCa ? (
            <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-4">
              <div className="flex justify-between items-start border-b pb-3">
                <div>
                  <h3 className="font-extrabold text-base text-gray-800">
                    Chi tiết Ca #{selectedCa.maCaThuNgan}
                  </h3>
                  <p className="text-xs text-gray-500">Người mở ca: <b>{selectedCa.tenNV}</b></p>
                  {selectedCa.ghiChuChenhLech && (
                    <p className="text-xs text-amber-800 mt-1">
                      📝 Giải trình bàn giao: <i>{selectedCa.ghiChuChenhLech}</i>
                    </p>
                  )}
                </div>
                <div className="text-right text-xs space-y-1">
                  <p className="text-gray-500">Tiền đầu ca: <b>{formatVND(selectedCa.tienMatDauCa)}</b></p>
                  <p className="text-emerald-700 font-bold">
                    Tổng thu HĐ: {formatVND(selectedCa.tongThuHoaDon || 0)}
                  </p>
                  {Number(selectedCa.tongRutKet || 0) > 0 && (
                    <p className="text-indigo-700 font-bold">
                      🏦 Rút két: -{formatVND(selectedCa.tongRutKet)}
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={loadingAction}
                    onClick={() => handlePrintShiftZReport(selectedCa)}
                    className="mt-1 px-3 py-1.5 bg-amber-700 hover:bg-amber-800 text-white font-bold rounded-lg text-[11px] cursor-pointer disabled:opacity-50"
                  >
                    🖨️ In Z-Report (K80)
                  </button>
                </div>
              </div>

              <div className="bg-stone-50 p-4 rounded-xl border border-stone-200 space-y-3">
                <h4 className="font-bold text-xs uppercase text-stone-700">🧮 Đối soát Mù (Blind Drop) &amp; Chốt quỹ ca</h4>
                {selectedCa.trangThaiCa === 1 && (
                  <DenominationCounterGrid
                    value={chiTietMenhGia}
                    onChange={(map, total) => {
                      setChiTietMenhGia(map)
                      setTienThucTeInput(String(total))
                    }}
                  />
                )}
                {recountNeeded && (
                  <div className="p-3 rounded-xl bg-amber-50 border-2 border-amber-400 text-xs text-amber-900 space-y-2">
                    <p className="font-extrabold">
                      ⚠️ YÊU CẦU KIỂM ĐẾM LẠI (LẦN 2): Số tiền kiểm đếm đang chênh lệch so với sổ quỹ. Vui lòng kiểm tra ngăn kéo và nhập lý do giải trình!
                    </p>
                    <input
                      type="text"
                      value={ghiChuChenhLech}
                      onChange={(e) => setGhiChuChenhLech(e.target.value)}
                      placeholder="Nhập lý do giải trình chênh lệch (tối thiểu 10 ký tự)..."
                      className="w-full px-3 py-2 bg-white border border-amber-300 rounded-lg text-xs"
                    />
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <input
                    type="number"
                    min="0"
                    disabled={selectedCa.trangThaiCa === 2}
                    value={tienThucTeInput}
                    onChange={(e) => setTienThucTeInput(e.target.value)}
                    placeholder="Tổng tiền mặt kiểm đếm thực tế..."
                    className="flex-1 min-w-[160px] px-3 py-2 bg-white border rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-600 disabled:bg-gray-100"
                  />
                  {selectedCa.trangThaiCa === 1 && (
                    <input
                      type="number"
                      min="0"
                      value={tienGiuLaiKet}
                      onChange={(e) => setTienGiuLaiKet(e.target.value)}
                      placeholder="Quỹ tiền lẻ giữ lại cho ca sau..."
                      className="w-44 px-3 py-2 bg-white border rounded-xl text-xs outline-none"
                    />
                  )}
                  {canViewXReport && (
                    <button
                      type="button"
                      disabled={loadingAction}
                      onClick={handleCheckDoiSoat}
                      className="px-3.5 py-2 bg-stone-700 hover:bg-stone-800 text-white font-bold rounded-xl text-xs cursor-pointer disabled:opacity-50"
                    >
                      Kiểm tra quỹ (X-Report)
                    </button>
                  )}
                  {selectedCa.trangThaiCa === 1 && (
                    <button
                      type="button"
                      disabled={loadingAction}
                      onClick={handleDongCa}
                      className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl text-xs cursor-pointer shadow disabled:opacity-50"
                    >
                      {recountNeeded ? 'Xác nhận chốt ca (Lần 2)' : 'Chốt ca ngay'}
                    </button>
                  )}
                </div>

                {doiSoatResult && (
                  <div className="p-4 bg-white rounded-xl border border-amber-300 text-xs space-y-2 mt-3 shadow-sm">
                    <h5 className="font-extrabold text-amber-900 border-b pb-1 text-sm">📊 Bảng Tổng Hợp Đối Soát</h5>
                    <div className="grid grid-cols-2 gap-2 text-gray-700">
                      <p>Tiền mặt đầu ca: <b>{formatVND(doiSoatResult.tienMatDauCa)}</b></p>
                      <p>Thu Tiền mặt: <b className="text-emerald-700">+{formatVND(doiSoatResult.doanhThu?.tienMat || 0)}</b></p>
                      <p>Thu Chuyển khoản (VietQR): <b className="text-sky-700">{formatVND(doiSoatResult.doanhThu?.chuyenKhoan || 0)}</b></p>
                      <p>Thu Thẻ / Voucher: <b>{formatVND((doiSoatResult.doanhThu?.the || 0) + (doiSoatResult.doanhThu?.voucher || 0))}</b></p>
                      <p>Thu lặt vặt: <b className="text-emerald-700">+{formatVND(doiSoatResult.thuLatVat || 0)}</b></p>
                      <p>Chi lặt vặt: <b className="text-red-600">-{formatVND(doiSoatResult.chiLatVat || 0)}</b></p>
                      <p>🏦 Rút két (Safe Drop): <b className="text-indigo-700">-{formatVND(doiSoatResult.rutKet || 0)}</b></p>
                      <p>Số hóa đơn trong ca: <b>{Number(doiSoatResult.doanhThu?.soHoaDon || 0)} đơn</b></p>
                      {doiSoatResult.hoanTien?.tong > 0 && (
                        <>
                          <p>Hoàn tiền mặt sau TT: <b className="text-rose-700">-{formatVND(doiSoatResult.hoanTien.tienMat || 0)}</b></p>
                          <p>Hoàn CK / Thẻ sau TT: <b className="text-rose-700">{formatVND((doiSoatResult.hoanTien.chuyenKhoan || 0) + (doiSoatResult.hoanTien.the || 0))}</b></p>
                        </>
                      )}
                    </div>
                    <div className="pt-2 border-t flex justify-between items-center text-xs">
                      <span>Quỹ tiền mặt lý thuyết:</span>
                      <span className="font-extrabold text-base text-gray-900">{formatVND(doiSoatResult.tienMatLyThuyet)}</span>
                    </div>
                    <div className="flex justify-between items-center text-xs">
                      <span>Thực tế kiểm đếm:</span>
                      <span className="font-extrabold text-base text-blue-700">{formatVND(doiSoatResult.tienMatThucTe)}</span>
                    </div>
                    <div
                      className={`p-2 rounded-lg font-extrabold flex justify-between items-center ${
                        doiSoatResult.chenhLech === 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                      }`}
                    >
                      <span>Chênh lệch: {doiSoatResult.trangThai}</span>
                      <span>{formatVND(doiSoatResult.chenhLech)}</span>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <h4 className="font-bold text-xs uppercase text-gray-600 mb-2">
                  Khoản Thu / Chi lặt vặt &amp; Rút két ({thuChiList.length})
                </h4>
                {thuChiList.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">Không có khoản thu chi / rút két phát sinh trong ca này</p>
                ) : (
                  <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                    {thuChiList.map((tc) => (
                      <div key={tc.maPhieuTC} className="p-2.5 rounded-xl bg-gray-50 border flex flex-wrap justify-between items-center gap-2 text-xs">
                        <div>
                          <span
                            className={`px-2 py-0.5 rounded font-bold text-[10px] mr-2 ${
                              tc.loaiThuChi === 'THU'
                                ? 'bg-emerald-100 text-emerald-800'
                                : tc.loaiThuChi === 'RUT_KET'
                                ? 'bg-indigo-100 text-indigo-800'
                                : tc.loaiThuChi === 'THOI_CK_DU'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {tc.loaiThuChi === 'RUT_KET'
                              ? '🏦 RÚT KÉT'
                              : tc.loaiThuChi === 'THOI_CK_DU'
                              ? '💵 THỐI CK DƯ'
                              : tc.loaiThuChi}
                          </span>
                          <span className="font-semibold text-gray-800">{tc.lyDo}</span>
                          {tc.loaiThuChi === 'RUT_KET' && (
                            <span
                              className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                tc.trangThaiXacNhan === 'CONFIRMED'
                                  ? 'bg-emerald-100 text-emerald-700'
                                  : tc.trangThaiXacNhan === 'DISPUTED'
                                  ? 'bg-red-100 text-red-700'
                                  : 'bg-amber-100 text-amber-800'
                              }`}
                            >
                              {tc.trangThaiXacNhan === 'CONFIRMED'
                                ? '✓ Chủ quán đã nhận'
                                : tc.trangThaiXacNhan === 'DISPUTED'
                                ? '🚨 Đang báo sai lệch'
                                : '⏳ Chờ chủ quán xác nhận'}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold">{formatVND(tc.soTien)}</span>
                          {tc.loaiThuChi === 'RUT_KET' && tc.trangThaiXacNhan === 'PENDING_RECEIPT' && canViewXReport && (
                            <>
                              <button
                                type="button"
                                disabled={loadingAction}
                                onClick={() => handleConfirmSafeDrop(tc.maPhieuTC, 'CONFIRMED')}
                                className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] cursor-pointer"
                              >
                                ✓ Đã nhận
                              </button>
                              <button
                                type="button"
                                disabled={loadingAction}
                                onClick={() => handleConfirmSafeDrop(tc.maPhieuTC, 'DISPUTED')}
                                className="px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-bold text-[10px] cursor-pointer"
                              >
                                🚨 Lệch
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* [Phân hệ 3 - Trụ cột 6] Đối soát 3 Chiều Cuối Ngày (POS <-> Webhook Ngân hàng <-> Chốt lô EDC) */}
              {canViewXReport && (
                <div className="bg-sky-50/70 p-4 rounded-xl border border-sky-200 space-y-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="font-extrabold text-sky-900">
                      ⚖️ Đối soát 3 Chiều (POS ↔ Webhook Ngân hàng ↔ Chốt lô Thẻ EDC)
                    </h4>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        value={edcInput}
                        onChange={(e) => setEdcInput(e.target.value)}
                        placeholder="Tổng chốt lô máy EDC (VND)..."
                        className="w-48 px-2.5 py-1.5 bg-white border border-sky-300 rounded-lg text-xs"
                      />
                      <button
                        type="button"
                        disabled={loadingAction}
                        onClick={handleCheckEodReconciliation}
                        className="px-3 py-1.5 bg-sky-700 hover:bg-sky-800 text-white font-bold rounded-lg cursor-pointer"
                      >
                        Đối soát ngay
                      </button>
                    </div>
                  </div>
                  {eodRecon && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                      <div className="p-3 rounded-lg bg-white border border-sky-200 space-y-1">
                        <p className="font-extrabold text-sky-900">🏦 Đối soát Chuyển khoản</p>
                        <p>POS Auto Webhook: <b>{formatVND(eodRecon.bankReconciliation?.posBankAutoWebhook || 0)}</b></p>
                        <p className={eodRecon.bankReconciliation?.hasManualRisk ? 'text-red-700 font-bold' : ''}>
                          POS Xác nhận thủ công: <b>{formatVND(eodRecon.bankReconciliation?.posBankManual || 0)}</b>
                        </p>
                        <p>Webhook Sao kê khớp: <b className="text-emerald-700">{formatVND(eodRecon.bankReconciliation?.webhookMatchedTotal || 0)}</b></p>
                        <p>Chênh lệch: <b className={eodRecon.bankReconciliation?.variance === 0 ? 'text-emerald-700' : 'text-red-700'}>{formatVND(eodRecon.bankReconciliation?.variance || 0)}</b></p>
                      </div>
                      <div className="p-3 rounded-lg bg-white border border-sky-200 space-y-1">
                        <p className="font-extrabold text-sky-900">💳 Đối soát Chốt lô EDC</p>
                        <p>Sổ Thẻ POS ({eodRecon.edcReconciliation?.posCardCount || 0} GD): <b>{formatVND(eodRecon.edcReconciliation?.posCardTotal || 0)}</b></p>
                        <p>Tổng chốt lô máy EDC: <b>{eodRecon.edcReconciliation?.tongChotLoEDC !== null ? formatVND(eodRecon.edcReconciliation.tongChotLoEDC) : 'Chưa nhập'}</b></p>
                        {eodRecon.edcReconciliation?.variance !== null && (
                          <p>
                            Chênh lệch EDC:{' '}
                            <b className={eodRecon.edcReconciliation.matched ? 'text-emerald-700' : 'text-red-700'}>
                              {formatVND(eodRecon.edcReconciliation.variance)}
                            </b>
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="bg-white p-12 rounded-2xl shadow-sm border border-gray-200 text-center text-gray-400 text-xs">
              Chọn một ca bên trái để xem chi tiết đối soát và chốt quỹ
            </div>
          )}
        </div>
      </div>

      {/* Nhật ký Webhook VietQR tự động (SePay / PayOS) */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-extrabold text-base text-gray-800">
              🏦 Biến Động Số Dư VietQR Tự Động (SePay / PayOS Webhook)
            </h3>
            <p className="text-xs text-gray-500">
              Endpoint nhận webhook: <code className="bg-stone-100 px-1.5 py-0.5 rounded">POST /api/webhooks/sepay</code> •{' '}
              <code className="bg-stone-100 px-1.5 py-0.5 rounded">POST /api/webhooks/payos</code>
            </p>
          </div>
          <span className="text-xs font-bold text-gray-500">{vietQrLogs.length} giao dịch gần nhất</span>
        </div>

        {!allowVietQrWebhook ? (
          <FeatureLockedCard
            title="VietQR Auto Webhook (SePay / PayOS)"
            description="Tự động đối soát biến động số dư ngân hàng và chốt đơn real-time khi khách chuyển khoản VietQR."
            requiredPlan="PRO"
            currentPlan={user?.goiCuoc || 'STARTER'}
          />
        ) : (
        <div className="overflow-x-auto max-h-64 overflow-y-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-gray-50 text-gray-600 uppercase sticky top-0">
              <tr>
                <th className="p-2.5">Thời gian</th>
                <th className="p-2.5">Cổng</th>
                <th className="p-2.5 text-right">Số tiền</th>
                <th className="p-2.5">Nội dung CK</th>
                <th className="p-2.5">HĐ khớp</th>
                <th className="p-2.5">Trạng thái</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {vietQrLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-gray-400">
                    Chưa có biến động chuyển khoản VietQR nào được ghi nhận
                  </td>
                </tr>
              ) : (
                vietQrLogs.map((v) => (
                  <tr key={v.id} className="hover:bg-gray-50">
                    <td className="p-2.5 whitespace-nowrap text-gray-500">{formatDateTime(v.thoiGianNhan)}</td>
                    <td className="p-2.5 font-mono text-[11px]">{v.nhaCungCap}</td>
                    <td className="p-2.5 text-right font-extrabold text-emerald-700">{formatVND(v.soTien)}</td>
                    <td className="p-2.5 text-gray-700">{v.noiDungCK || '—'}</td>
                    <td className="p-2.5 font-mono font-bold">{v.maHoaDonKhop ? `#${v.maHoaDonKhop}` : '—'}</td>
                    <td className="p-2.5">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${
                          v.trangThaiXuLy === 'MATCHED_PAID'
                            ? 'bg-emerald-100 text-emerald-800'
                            : v.trangThaiXuLy === 'PARTIAL_PAID'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {v.trangThaiXuLy}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        )}
      </div>

      {/* Cấu hình Cảnh báo Gian lận Tức thời về Telegram / Webhook Chủ quán */}
      <FraudAlertConfigPanel allowAuditLogs={allowAuditLogs} user={user} />

      {/* Nhật ký Kiểm toán Bất biến (Anti-Fraud Audit Trail) */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-extrabold text-base text-gray-800">
              🛡️ Nhật Ký Kiểm Toán Hệ Thống (Anti-Fraud Audit Trail)
            </h3>
            <p className="text-xs text-gray-500">
              Ghi vết bất biến mọi thao tác nhạy cảm: Hủy món, In tạm tính/In lại bill, Thu/Chi két tiền, Chốt ca, Chuyển bàn
            </p>
          </div>
          <span className="text-xs font-bold text-gray-500">{auditLogs.length} sự kiện gần nhất</span>
        </div>

        {!allowAuditLogs ? (
          <FeatureLockedCard
            title="Nhật ký Kiểm toán Anti-Fraud bất biến"
            description="Theo dõi chi tiết từng lần hủy món, in lại tạm tính, mở két tiền không bán (No-Sale) và duyệt PIN Quản lý."
            requiredPlan="PRO"
            currentPlan={user?.goiCuoc || 'STARTER'}
          />
        ) : (
        <div className="overflow-x-auto max-h-80 overflow-y-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-gray-50 text-gray-600 uppercase sticky top-0">
              <tr>
                <th className="p-2.5">Thời gian</th>
                <th className="p-2.5">Nhân viên</th>
                <th className="p-2.5">Hành động</th>
                <th className="p-2.5">Đối tượng</th>
                <th className="p-2.5">Lý do / Chi tiết</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-gray-400">
                    Chưa có bản ghi kiểm toán nào
                  </td>
                </tr>
              ) : (
                auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-gray-50">
                    <td className="p-2.5 whitespace-nowrap text-gray-500">{formatDateTime(log.thoiGianTao)}</td>
                    <td className="p-2.5 font-bold text-gray-800">{log.tenNV}</td>
                    <td className="p-2.5 font-semibold">
                      {AUDIT_LABELS[log.hanhDong] || log.hanhDong}
                    </td>
                    <td className="p-2.5 font-mono text-[11px]">
                      {log.doiTuong} #{log.maDoiTuong}
                    </td>
                    <td className="p-2.5 text-gray-600">
                      {log.lyDo || (log.giaTriMoi ? JSON.stringify(log.giaTriMoi) : '—')}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        )}
      </div>
    </div>
  )
}
