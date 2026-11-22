import { useState, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'
import { ecosystemService } from '../../../services/ecosystemService'
import { formatVND, formatDateTime } from '../../../utils/format'

const PLATFORM_BADGE = {
  GRABFOOD: 'bg-emerald-600 text-white',
  SHOPEEFOOD: 'bg-orange-600 text-white',
  BEFOOD: 'bg-yellow-500 text-stone-950',
}

const SERVICE_TYPES = [
  { id: 'BIDA', label: '🎱 Bàn Bida', defaultRate: 65000 },
  { id: 'BOARDGAME', label: '🎲 Boardgame Cafe', defaultRate: 45000 },
  { id: 'COWORKING', label: '💻 Co-working Space', defaultRate: 50000 },
  { id: 'PHONG_VIP', label: '🏢 Phòng họp / VIP', defaultRate: 120000 },
]

export default function EcosystemPosDrawer({
  isOpen,
  initialTab = 'qr',
  onClose,
  tables = [],
  onRefreshPos,
  onCountsChange,
}) {
  const [tab, setTab] = useState(initialTab)
  const [loading, setLoading] = useState(false)
  const [qrOrders, setQrOrders] = useState([])
  const [aggData, setAggData] = useState({ summary: [], orders: [] })
  const [timeSessions, setTimeSessions] = useState([])
  const [tableQrLink, setTableQrLink] = useState(null)

  const [timerBan, setTimerBan] = useState('')
  const [timerService, setTimerService] = useState('BIDA')
  const [timerRate, setTimerRate] = useState('65000')

  useEffect(() => {
    if (!isOpen) return undefined
    const t = setTimeout(() => {
      setTab(initialTab)
    }, 0)
    return () => clearTimeout(t)
  }, [isOpen, initialTab])

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [qrRes, aggRes, tbRes] = await Promise.all([
        ecosystemService.getQrOrders().catch(() => []),
        ecosystemService.getAggregatorOrders().catch(() => ({ summary: [], orders: [] })),
        ecosystemService.getActiveTimeBilling().catch(() => []),
      ])
      const qrList = Array.isArray(qrRes) ? qrRes : []
      const aggOrders = Array.isArray(aggRes?.orders) ? aggRes.orders : []
      const tbList = Array.isArray(tbRes) ? tbRes : []
      setQrOrders(qrList)
      setAggData({ summary: aggRes?.summary || [], orders: aggOrders })
      setTimeSessions(tbList)
      onCountsChange?.({
        qrPending: qrList.filter((q) => ['PENDING_APPROVAL', 'AWAITING_PAYMENT'].includes(q.trangThai)).length,
        aggNew: aggOrders.filter((a) => a.trangThai === 'NEW').length,
        timersRunning: tbList.filter((t) => t.trangThai === 'RUNNING').length,
      })
    } finally {
      setLoading(false)
    }
  }, [onCountsChange])

  useEffect(() => {
    if (!isOpen) return undefined
    const t = setTimeout(() => {
      void loadAll()
    }, 0)
    return () => clearTimeout(t)
  }, [isOpen, loadAll])

  if (!isOpen) return null

  const pendingQr = qrOrders.filter((q) => ['PENDING_APPROVAL', 'AWAITING_PAYMENT'].includes(q.trangThai))
  const newAgg = aggData.orders.filter((a) => a.trangThai === 'NEW')
  const runningTimers = timeSessions.filter((t) => t.trangThai === 'RUNNING')

  const handleApproveQr = async (maDonQr) => {
    try {
      const res = await ecosystemService.approveQrOrder(maDonQr, { daXacNhanVietQr: true })
      toast.success(res.message || 'Đã duyệt đơn QR!')
      await loadAll()
      await onRefreshPos?.()
    } catch {
      // Interceptor báo lỗi
    }
  }

  const handleRejectQr = async (maDonQr) => {
    try {
      const res = await ecosystemService.rejectQrOrder(maDonQr, 'Thu ngân từ chối đơn nghi spam')
      toast.success(res.message || 'Đã từ chối đơn QR!')
      await loadAll()
    } catch {
      // Interceptor báo lỗi
    }
  }

  const handleRotateTableQr = async (maBan) => {
    try {
      const res = await ecosystemService.rotateTableQr(maBan, { rotateToken: true })
      setTableQrLink(res.tableQr)
      toast.success(res.message)
      await onRefreshPos?.()
    } catch {
      // Interceptor báo lỗi
    }
  }

  const handleSimulateAgg = async (pf) => {
    try {
      const res = await ecosystemService.simulateAggregatorOrder(pf)
      toast.success(res.message)
      await loadAll()
    } catch {
      // Interceptor báo lỗi
    }
  }

  const handleAcceptAgg = async (maDonSan) => {
    try {
      const res = await ecosystemService.acceptAggregatorOrder(maDonSan)
      toast.success(res.message)
      await loadAll()
      await onRefreshPos?.()
    } catch {
      // Interceptor báo lỗi
    }
  }

  const handleStartTimer = async (e) => {
    e.preventDefault()
    if (!timerBan) {
      toast.error('Vui lòng chọn bàn để bấm giờ!')
      return
    }
    try {
      const res = await ecosystemService.startTimeBilling({
        maBan: timerBan,
        loaiDichVu: timerService,
        donGiaTheoGio: Number(timerRate || 60000),
      })
      toast.success(res.message)
      await loadAll()
      await onRefreshPos?.()
    } catch {
      // Interceptor báo lỗi
    }
  }

  const handleStopTimer = async (maPhien) => {
    try {
      const res = await ecosystemService.stopTimeBilling(maPhien)
      toast.success(res.message)
      await loadAll()
      await onRefreshPos?.()
    } catch {
      // Interceptor báo lỗi
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex justify-end">
      <div className="bg-white w-full max-w-2xl h-full flex flex-col shadow-2xl">
        <div className="p-4 bg-stone-900 text-white flex items-center justify-between">
          <div>
            <h3 className="font-black text-base text-amber-400">
              🌐 Trung tâm Omnichannel POS (QR • Sàn Giao Hàng • Tính giờ)
            </h3>
            <p className="text-[11px] text-stone-300">
              Duyệt đơn QR 1 chạm • Nhận đơn Grab/Shopee/Be không gõ tay • Bấm giờ Bida/Boardgame
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 rounded-xl bg-stone-800 hover:bg-stone-700 text-white font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>

        {/* Tab switcher */}
        <div className="p-3 bg-stone-100 border-b flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setTab('qr')}
            className={`px-3.5 py-2 rounded-xl text-xs font-extrabold cursor-pointer ${
              tab === 'qr' ? 'bg-amber-700 text-white' : 'bg-white text-stone-700 border'
            }`}
          >
            📱 Đơn QR Tại Bàn ({pendingQr.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('agg')}
            className={`px-3.5 py-2 rounded-xl text-xs font-extrabold cursor-pointer ${
              tab === 'agg' ? 'bg-emerald-700 text-white' : 'bg-white text-stone-700 border'
            }`}
          >
            🛵 Sàn Giao Hàng ({newAgg.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('timer')}
            className={`px-3.5 py-2 rounded-xl text-xs font-extrabold cursor-pointer ${
              tab === 'timer' ? 'bg-indigo-700 text-white' : 'bg-white text-stone-700 border'
            }`}
          >
            🎱 Bấm Giờ Bida/Boardgame ({runningTimers.length})
          </button>
          <button
            type="button"
            onClick={() => void loadAll()}
            disabled={loading}
            className="ml-auto px-3 py-2 rounded-xl bg-white border text-xs font-bold text-stone-700 cursor-pointer"
          >
            {loading ? '...' : '↻ Tải lại'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* TAB 1: QR ORDER */}
          {tab === 'qr' && (
            <>
              {tableQrLink && (
                <div className="p-3.5 rounded-2xl bg-amber-50 border-2 border-amber-400 text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-black text-amber-950">
                      🔗 Link QR mới của {tableQrLink.tenBan} (Token: {tableQrLink.qrToken})
                    </span>
                    <button
                      type="button"
                      onClick={() => setTableQrLink(null)}
                      className="text-stone-500 font-bold cursor-pointer"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={`${window.location.origin}${tableQrLink.qrPath}`}
                      className="flex-1 px-2.5 py-1.5 rounded-lg bg-white border font-mono text-[11px]"
                    />
                    <a
                      href={tableQrLink.qrPath}
                      target="_blank"
                      rel="noreferrer"
                      className="px-3 py-1.5 rounded-lg bg-amber-700 text-white font-bold shrink-0"
                    >
                      Mở thử QR ↗
                    </a>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-xs font-extrabold text-stone-700 uppercase">
                  📥 Hàng đợi duyệt đơn QR (Chống phá hoại Lớp 1)
                </p>
                {qrOrders.length === 0 ? (
                  <p className="text-xs text-stone-400 bg-stone-50 p-4 rounded-xl text-center">
                    Chưa có đơn QR nào. Bạn có thể tạo link QR bàn bên dưới để khách quét đặt thử!
                  </p>
                ) : (
                  qrOrders.map((q) => {
                    const isPending = ['PENDING_APPROVAL', 'AWAITING_PAYMENT'].includes(q.trangThai)
                    return (
                      <div
                        key={q.maDonQr}
                        className={`p-3.5 rounded-2xl border space-y-2 text-xs ${
                          isPending ? 'bg-amber-50/70 border-amber-300' : 'bg-stone-50 border-stone-200 opacity-75'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-black text-stone-900">
                            🪑 {q.tenBan || q.maBan} • #{q.maDonQr}
                          </span>
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-white border">
                            {q.trangThai === 'PENDING_APPROVAL'
                              ? '⏳ CHỜ DUYỆT 1 CHẠM'
                              : q.trangThai === 'AWAITING_PAYMENT'
                              ? '💳 CHỜ VIETQR TRƯỚC'
                              : q.trangThai === 'APPROVED'
                              ? `✅ ĐÃ DUYỆT (HĐ #${q.maHoaDonDaTao})`
                              : '🚫 ĐÃ TỪ CHỐI'}
                          </span>
                        </div>
                        <ul className="space-y-0.5 text-stone-700">
                          {q.danhSachMon.map((m, idx) => (
                            <li key={idx}>
                              • <b>{m.tenMon}</b> ({m.kichThuoc}) x{m.soLuong} — {formatVND(m.thanhTien)}
                              {m.ghiChu ? <i className="text-stone-500"> ({m.ghiChu})</i> : ''}
                            </li>
                          ))}
                        </ul>
                        <div className="flex items-center justify-between pt-1 border-t border-amber-200/70">
                          <span className="font-extrabold text-amber-900">
                            Tổng: {formatVND(q.tongTienTamTinh)}
                            {q.tenKhach ? ` • ${q.tenKhach}` : ''}
                          </span>
                          {isPending && (
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => handleRejectQr(q.maDonQr)}
                                className="px-3 py-1.5 rounded-xl bg-red-100 hover:bg-red-200 text-red-700 font-bold cursor-pointer"
                              >
                                🚫 Từ chối
                              </button>
                              <button
                                type="button"
                                onClick={() => handleApproveQr(q.maDonQr)}
                                className="px-4 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold cursor-pointer shadow"
                              >
                                ✅ Duyệt đơn QR → Bar
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              <div className="space-y-2 pt-2 border-t">
                <p className="text-xs font-extrabold text-stone-700 uppercase">
                  🔄 Lấy link / Xoay mã QR động theo bàn (Chống phá hoại Lớp 2)
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {tables.slice(0, 12).map((b) => (
                    <button
                      key={b.maBan}
                      type="button"
                      onClick={() => handleRotateTableQr(b.maBan)}
                      className="p-2.5 rounded-xl border bg-white hover:border-amber-500 text-left text-xs cursor-pointer"
                    >
                      <p className="font-extrabold text-stone-800">{b.tenBan}</p>
                      <p className="text-[10px] text-amber-700 font-semibold">🔄 Tạo/Xoay link QR</p>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* TAB 2: AGGREGATOR HUB */}
          {tab === 'agg' && (
            <>
              <div className="flex flex-wrap gap-2">
                {['GRABFOOD', 'SHOPEEFOOD', 'BEFOOD'].map((pf) => (
                  <button
                    key={pf}
                    type="button"
                    onClick={() => handleSimulateAgg(pf)}
                    className={`px-3.5 py-2 rounded-xl text-xs font-extrabold cursor-pointer shadow ${PLATFORM_BADGE[pf]}`}
                  >
                    + Giả lập đơn {pf}
                  </button>
                ))}
              </div>

              <div className="space-y-2.5">
                {aggData.orders.length === 0 ? (
                  <p className="text-xs text-stone-400 bg-stone-50 p-4 rounded-xl text-center">
                    Chưa có đơn từ GrabFood / ShopeeFood / BeFood. Bấm nút phía trên để thử luồng nhận đơn 1 chạm!
                  </p>
                ) : (
                  aggData.orders.map((o) => (
                    <div key={o.maDonSan} className="p-3.5 rounded-2xl border bg-white space-y-2 text-xs shadow-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded-md text-[10px] font-black ${PLATFORM_BADGE[o.nenTang] || 'bg-stone-700 text-white'}`}>
                            {o.nenTang}
                          </span>
                          <span className="font-mono font-black text-stone-900">{o.maDonNgoai}</span>
                        </div>
                        <span className="text-[11px] font-bold text-stone-500">{formatDateTime(o.thoiGianTao)}</span>
                      </div>
                      <p className="text-[11px] text-stone-600">
                        👤 {o.tenKhach} • 🛵 {o.tenTaiXe} ({o.bienSoXe})
                      </p>
                      <ul className="text-stone-800 space-y-0.5">
                        {o.danhSachMon.map((m, idx) => (
                          <li key={idx}>
                            • <b>{m.tenMon}</b> ({m.kichThuoc}) x{m.soLuong}
                          </li>
                        ))}
                      </ul>
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t">
                        <div className="space-x-2">
                          <span>Hàng: <b>{formatVND(o.tongTienHang)}</b></span>
                          <span className="text-red-600">Phí sàn: -{formatVND(o.phiChietKhauSan)}</span>
                          <span className="text-emerald-700 font-black">Thực nhận: {formatVND(o.doanhThuThucNhan)}</span>
                        </div>
                        {o.trangThai === 'NEW' ? (
                          <button
                            type="button"
                            onClick={() => handleAcceptAgg(o.maDonSan)}
                            className="px-4 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold cursor-pointer"
                          >
                            ✅ Nhận đơn vào POS → Bar
                          </button>
                        ) : (
                          <span className="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-800 font-bold">
                            {o.trangThai} {o.maHoaDonPos ? `• HĐ #${o.maHoaDonPos}` : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {/* TAB 3: TIME-BASED BILLING */}
          {tab === 'timer' && (
            <>
              <form onSubmit={handleStartTimer} className="p-4 rounded-2xl bg-indigo-50 border border-indigo-200 space-y-3 text-xs">
                <p className="font-black text-indigo-950">⏱️ Bắt đầu tính giờ theo bàn (Bida / Boardgame / Co-working)</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <select
                    value={timerBan}
                    onChange={(e) => setTimerBan(e.target.value)}
                    className="px-3 py-2 rounded-xl bg-white border font-semibold"
                    required
                  >
                    <option value="">-- Chọn bàn/phòng --</option>
                    {tables.map((b) => (
                      <option key={b.maBan} value={b.maBan}>
                        {b.tenBan} ({b.khuVuc})
                      </option>
                    ))}
                  </select>
                  <select
                    value={timerService}
                    onChange={(e) => {
                      const val = e.target.value
                      setTimerService(val)
                      const def = SERVICE_TYPES.find((s) => s.id === val)
                      if (def) setTimerRate(String(def.defaultRate))
                    }}
                    className="px-3 py-2 rounded-xl bg-white border font-semibold"
                  >
                    {SERVICE_TYPES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={0}
                    step={5000}
                    value={timerRate}
                    onChange={(e) => setTimerRate(e.target.value)}
                    placeholder="VNĐ / giờ"
                    className="px-3 py-2 rounded-xl bg-white border font-bold"
                  />
                </div>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-indigo-700 hover:bg-indigo-800 text-white font-extrabold cursor-pointer"
                >
                  ▶ Bấm giờ ngay (Tự cộng phụ thu giờ cao điểm 18h–23h x1.25)
                </button>
              </form>

              <div className="space-y-2">
                {timeSessions.map((s) => (
                  <div
                    key={s.maPhien}
                    className={`p-3.5 rounded-2xl border flex flex-wrap items-center justify-between gap-2 text-xs ${
                      s.trangThai === 'RUNNING' ? 'bg-emerald-50 border-emerald-300' : 'bg-stone-50 border-stone-200'
                    }`}
                  >
                    <div>
                      <p className="font-black text-stone-900">
                        {s.tenBan} • {s.tenDichVu} ({formatVND(s.donGiaTheoGio)}/h)
                      </p>
                      <p className="text-[11px] text-stone-600">
                        ⏱️ {s.soPhutSuDung} phút • Tạm tính: <b className="text-indigo-800">{formatVND(s.tongTienGio)}</b>
                        {s.maHoaDon ? ` • HĐ #${s.maHoaDon}` : ''}
                      </p>
                    </div>
                    {s.trangThai === 'RUNNING' ? (
                      <button
                        type="button"
                        onClick={() => handleStopTimer(s.maPhien)}
                        className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white font-extrabold cursor-pointer"
                      >
                        ⏹️ Dừng & Cộng vào Bill
                      </button>
                    ) : (
                      <span className="px-2.5 py-1 rounded-lg bg-stone-200 text-stone-700 font-bold">
                        Đã chốt ({formatVND(s.tongTienGio)})
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
