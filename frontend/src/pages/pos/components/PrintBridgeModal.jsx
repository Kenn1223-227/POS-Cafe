import { useState, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'
import ConfirmPinModal from '../../../components/ConfirmPinModal'
import {
  getBridgeClientSettings,
  saveBridgeClientSettings,
  checkBridgeHealth,
  saveBridgePrinterConfig,
  getBridgeJobs,
  retryBridgeJob,
  bridgePrintReceipt,
  bridgePrintLabels,
  bridgeKickDrawer,
  isWebSerialSupported,
  isWebUsbSupported,
  isWebBluetoothSupported,
  connectWebSerialPrinter,
  connectWebUsbPrinter,
  connectWebBluetoothPrinter,
} from '../../../utils/printBridge'
import { buildReceiptRasterPayload, retryPersistentPrintJob } from '../../../utils/printHelper'
import {
  getAllPersistentPrintJobs,
  deletePersistentPrintJob,
  clearDonePersistentPrintJobs,
} from '../../../offline/offlineDb'
import { orderService } from '../../../services/orderService'
import { formatDateTime } from '../../../utils/format'

const SAMPLE_TEST_INVOICE = {
  maHoaDon: 'TEST-K80',
  thoiGianTao: new Date().toISOString(),
  ban: [{ tenBan: 'Quầy Test' }],
  tongTamTinh: 64000,
  tongTienThanhToan: 64000,
  danhSachMon: [
    {
      tenMon: 'Cà phê Sữa đá',
      kichThuoc: 'M',
      soLuong: 1,
      thanhTien: 29000,
      ghiChu: '50% Đá • 70% Đường',
      toppings: [],
    },
    {
      tenMon: 'Trà Đào Cam Sả',
      kichThuoc: 'L',
      soLuong: 1,
      thanhTien: 35000,
      ghiChu: 'Ít đá',
      toppings: [{ tenTopping: 'Kem Cheese', soLuong: 1 }],
    },
  ],
}

export default function PrintBridgeModal({ isOpen, onClose, user, onStatusChange }) {
  const [clientCfg, setClientCfg] = useState(() => getBridgeClientSettings())
  const [online, setOnline] = useState(false)
  const [printerCfg, setPrinterCfg] = useState(null)
  const [jobs, setJobs] = useState([])
  const [persistentJobs, setPersistentJobs] = useState([])
  const [expandedJobId, setExpandedJobId] = useState(null)
  const [loading, setLoading] = useState(false)

  const currentTenantId = String(user?.tenantId || 'DEFAULT')

  const refreshPersistentQueue = useCallback(async () => {
    const list = await getAllPersistentPrintJobs(currentTenantId)
    setPersistentJobs(list)
  }, [currentTenantId])

  const refreshBridge = useCallback(async () => {
    await refreshPersistentQueue()
    const h = await checkBridgeHealth()
    setOnline(h.online)
    if (onStatusChange) onStatusChange(h.online)
    if (h.online) {
      if (h.config) setPrinterCfg(h.config)
      const list = await getBridgeJobs().catch(() => [])
      setJobs(list)
    } else {
      setJobs([])
    }
  }, [onStatusChange, refreshPersistentQueue])

  useEffect(() => {
    if (!isOpen) return undefined
    const t = setTimeout(() => {
      void refreshBridge()
    }, 0)
    const onQueueChanged = () => void refreshPersistentQueue()
    window.addEventListener('pos:print-queue-changed', onQueueChanged)
    return () => {
      clearTimeout(t)
      window.removeEventListener('pos:print-queue-changed', onQueueChanged)
    }
  }, [isOpen, refreshBridge, refreshPersistentQueue])

  if (!isOpen) return null

  const handleSaveClient = async () => {
    saveBridgeClientSettings(clientCfg)
    toast.success('Đã lưu chế độ kết nối phần cứng máy in!')
    await refreshBridge()
  }

  const handleConnectWebSerial = async () => {
    try {
      await connectWebSerialPrinter()
      const next = saveBridgeClientSettings({ ...clientCfg, enabled: true, transportMode: 'WEB_SERIAL' })
      setClientCfg(next)
      toast.success('🔌 Đã kết nối trực tiếp máy in nhiệt qua cổng WebSerial (USB/COM)!')
    } catch (err) {
      toast.error(err.message || 'Không thể kết nối máy in WebSerial')
    }
  }

  const handleConnectWebUsb = async () => {
    try {
      const res = await connectWebUsbPrinter()
      const next = saveBridgeClientSettings({ ...clientCfg, enabled: true, transportMode: 'WEB_USB' })
      setClientCfg(next)
      toast.success(`🔌 Đã kết nối trực tiếp máy in WebUSB (${res.productName})!`)
    } catch (err) {
      toast.error(err.message || 'Không thể kết nối máy in WebUSB')
    }
  }

  const handleConnectWebBluetooth = async () => {
    try {
      const res = await connectWebBluetoothPrinter()
      const next = saveBridgeClientSettings({
        ...clientCfg,
        enabled: true,
        transportMode: 'WEB_BLUETOOTH',
      })
      setClientCfg(next)
      toast.success(`📶 Đã ghép nối máy in Bluetooth (${res.deviceName})!`)
    } catch (err) {
      toast.error(err.message || 'Không thể ghép nối máy in WebBluetooth')
    }
  }

  const handleRetryPersistent = async (job, useBrowserFallback = false) => {
    setLoading(true)
    try {
      const res = await retryPersistentPrintJob(job, { useBrowserFallback })
      if (res.ok) {
        toast.success(`✅ Đã in lại thành công: ${job.label}`)
      } else {
        toast.error(`❌ In lại thất bại: ${res.error}`)
      }
      await refreshPersistentQueue()
    } finally {
      setLoading(false)
    }
  }

  const handleRetryAllFailed = async () => {
    const failed = persistentJobs.filter((j) => j.status === 'FAILED')
    if (failed.length === 0) return
    setLoading(true)
    let okCount = 0
    try {
      for (const j of failed) {
        const res = await retryPersistentPrintJob(j, { useBrowserFallback: false })
        if (res.ok) okCount += 1
      }
      if (okCount === failed.length) {
        toast.success(`✅ Đã in lại thành công toàn bộ ${okCount} lệnh lỗi!`)
      } else if (okCount > 0) {
        toast.success(`Đã in lại ${okCount}/${failed.length} lệnh — còn ${failed.length - okCount} lệnh cần kiểm tra dây/giấy!`)
      } else {
        toast.error('Máy in vẫn chưa phản hồi! Hãy kiểm tra dây LAN/USB hoặc bấm "In trình duyệt".')
      }
      await refreshPersistentQueue()
    } finally {
      setLoading(false)
    }
  }

  const handleSavePrinters = async (e) => {
    e.preventDefault()
    if (!printerCfg) return
    setLoading(true)
    try {
      const res = await saveBridgePrinterConfig(printerCfg)
      toast.success(res.message || 'Đã lưu cấu hình máy in!')
      await refreshBridge()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleTestReceipt = async () => {
    setLoading(true)
    try {
      const testPayload = buildReceiptRasterPayload(
        {
          hoaDon: SAMPLE_TEST_INVOICE,
          tenQuan: user?.tenQuan || 'QUÁN CÀ PHÊ POS',
          thuNgan: user?.tenNV || 'Thu ngân',
          isCashPayment: true,
        },
        {
          vietnameseRaster: clientCfg.vietnameseRaster !== false,
          paperWidth: clientCfg.paperWidth || 'K80',
        }
      )
      await bridgePrintReceipt(testPayload)
      toast.success(
        `🖨️ Đã gửi lệnh in thử Bill ${clientCfg.paperWidth || 'K80'}${
          testPayload.rasterBase64 ? ' (Tiếng Việt Raster GS v 0)' : ' (ESC/POS ASCII)'
        }!`
      )
      await refreshBridge()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleTestLabels = async () => {
    setLoading(true)
    try {
      await bridgePrintLabels({ hoaDon: SAMPLE_TEST_INVOICE })
      toast.success('🏷️ Đã gửi lệnh in thử 2 Tem 50×30mm (TSPL2)!')
      await refreshBridge()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  const [noSaleModalOpen, setNoSaleModalOpen] = useState(false)

  const handleNoSaleKick = () => {
    setNoSaleModalOpen(true)
  }

  const executeNoSaleKick = async (lyDo) => {
    setNoSaleModalOpen(false)
    if (!lyDo || lyDo.trim().length < 3) {
      toast.error('Lý do mở két phải từ 3 ký tự trở lên!')
      return
    }
    setLoading(true)
    try {
      // Ghi Audit Log bất biến lên server TRƯỚC rồi mới bắn xung RJ11 mở két!
      await orderService.ghiNhanMoKetKhongBan(lyDo.trim())
      await bridgeKickDrawer({ reason: lyDo.trim(), actor: user?.tenNV || user?.maNV })
      toast.success('💰 Đã kích mở két tiền RJ11 & ghi Audit Log!')
      await refreshBridge()
    } catch (err) {
      if (err?.message) toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleRetryJob = async (jobId) => {
    setLoading(true)
    try {
      await retryBridgeJob(jobId)
      toast.success(`↻ Đã in lại lệnh #${jobId}!`)
      await refreshBridge()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="p-4 border-b flex items-center justify-between bg-stone-900 text-white">
          <div>
            <h3 className="font-extrabold text-base text-amber-400">
              🖨️ Local Print Bridge — In Không Hộp Thoại &amp; Két Tiền RJ11
            </h3>
            <p className="text-xs text-stone-300">
              Trạng thái:{' '}
              {online ? (
                <span className="text-emerald-400 font-bold">🟢 Bridge Online ({clientCfg.url})</span>
              ) : (
                <span className="text-amber-300 font-bold">
                  ⚪ Chưa kết nối Bridge — đang tự fallback sang in trình duyệt
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-stone-800 hover:bg-stone-700 font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
          {/* [PHÂN HỆ 6] Hàng đợi Lệnh In Bền Vững (Persistent Print Queue - IndexedDB) khi lỏng dây LAN / hết giấy */}
          {persistentJobs.length > 0 && (
            <div className="p-4 rounded-xl bg-rose-50 border-2 border-rose-300 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="font-extrabold text-sm text-rose-900">
                    🚨 Hàng đợi Lệnh In Lỗi Bền Vững ({persistentJobs.filter((j) => j.status === 'FAILED').length} lỗi / {persistentJobs.length} lưu)
                  </h4>
                  <p className="text-[11px] text-rose-800">
                    Lưu tự động trong IndexedDB khi lỏng dây LAN hoặc hết giấy — không bao giờ mất bill!
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {persistentJobs.some((j) => j.status === 'FAILED') && (
                    <button
                      type="button"
                      disabled={loading}
                      onClick={handleRetryAllFailed}
                      className="min-h-11 px-3.5 rounded-xl bg-rose-700 hover:bg-rose-800 text-white font-extrabold cursor-pointer"
                    >
                      ↻ In lại tất cả ({persistentJobs.filter((j) => j.status === 'FAILED').length})
                    </button>
                  )}
                  {persistentJobs.some((j) => j.status === 'DONE') && (
                    <button
                      type="button"
                      onClick={() => void clearDonePersistentPrintJobs(currentTenantId).then(refreshPersistentQueue)}
                      className="min-h-11 px-3 rounded-xl bg-white border border-rose-200 text-stone-700 font-bold cursor-pointer"
                    >
                      Dọn lệnh đã xong
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {persistentJobs.map((pj) => (
                  <div
                    key={pj.id}
                    className={`p-3 rounded-xl border flex flex-wrap items-center justify-between gap-2 ${
                      pj.status === 'DONE' ? 'bg-emerald-50/70 border-emerald-200' : 'bg-white border-rose-200'
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="font-bold text-stone-900 flex items-center gap-1.5 flex-wrap">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${
                            pj.status === 'DONE' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                          }`}
                        >
                          {pj.status === 'DONE' ? 'ĐÃ IN LẠI' : `LỖI (${pj.attempts} lần)`}
                        </span>
                        <span>{pj.label}</span>
                      </p>
                      <p className="text-[11px] text-stone-500 mt-0.5">
                        {formatDateTime(pj.createdAt)}
                        {pj.error ? ` • ${pj.error}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {pj.status !== 'DONE' && (
                        <>
                          <button
                            type="button"
                            disabled={loading}
                            onClick={() => handleRetryPersistent(pj, false)}
                            className="min-h-10 px-3 rounded-xl bg-amber-700 hover:bg-amber-800 text-white font-bold cursor-pointer"
                          >
                            ↻ In lại
                          </button>
                          <button
                            type="button"
                            disabled={loading}
                            onClick={() => handleRetryPersistent(pj, true)}
                            className="min-h-10 px-3 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-800 font-bold cursor-pointer"
                          >
                            🖨️ In trình duyệt
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => void deletePersistentPrintJob(pj.id).then(refreshPersistentQueue)}
                        className="min-h-10 min-w-10 rounded-xl bg-red-50 hover:bg-red-100 text-red-600 font-bold cursor-pointer"
                        title="Xóa khỏi hàng đợi"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Kết nối Đa tầng: Local Print Bridge / Cloud Relay (iPad & Android HTTPS) / WebSerial / WebUSB / WebBluetooth / RawBT */}
          <div className="p-3.5 rounded-xl bg-stone-50 border space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 font-bold text-gray-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={clientCfg.enabled}
                    onChange={(e) => setClientCfg({ ...clientCfg, enabled: e.target.checked })}
                    className="w-4 h-4 accent-amber-700"
                  />
                  Bật In Không Hộp Thoại (Silent Print)
                </label>
                <select
                  value={clientCfg.transportMode || 'AUTO'}
                  onChange={(e) => setClientCfg({ ...clientCfg, transportMode: e.target.value })}
                  className="min-h-11 px-3 py-1.5 border rounded-xl font-bold bg-white text-stone-800"
                >
                  <option value="AUTO">⚡ Tự động (Local Bridge → Cloud Relay)</option>
                  <option value="LOCAL_BRIDGE">🖥️ Local Print Bridge (PC Windows / macOS / Raspberry Pi LAN)</option>
                  <option value="CLOUD_RELAY">☁️ Cloud Print Relay (iPad / Android Tablet chạy HTTPS)</option>
                  <option value="WEB_BLUETOOTH">📶 WebBluetooth Trực tiếp (Máy in nhiệt Bluetooth trên Chrome Android/PC)</option>
                  <option value="WEB_SERIAL">🔌 WebSerial Trực tiếp (Cáp USB/COM trên Chrome — 0 cài đặt)</option>
                  <option value="WEB_USB">🔌 WebUSB Trực tiếp (Cáp USB trên Chrome — 0 cài đặt)</option>
                  <option value="ANDROID_RAWBT">📱 Android RawBT / Sunmi POS Intent (Bluetooth/USB)</option>
                </select>
                {(clientCfg.transportMode === 'AUTO' || clientCfg.transportMode === 'LOCAL_BRIDGE') && (
                  <>
                    <input
                      type="text"
                      value={clientCfg.url}
                      onChange={(e) => setClientCfg({ ...clientCfg, url: e.target.value })}
                      className="min-h-11 px-3 py-1.5 border rounded-xl font-mono w-48 bg-white"
                      placeholder="http://127.0.0.1:9100"
                    />
                    <input
                      type="password"
                      value={clientCfg.token || ''}
                      onChange={(e) => setClientCfg({ ...clientCfg, token: e.target.value })}
                      className="min-h-11 px-3 py-1.5 border rounded-xl font-mono w-44 bg-white"
                      placeholder="Bridge Auth Token"
                      title="Token xác thực hiển thị khi khởi chạy Local Print Bridge (X-Print-Bridge-Token)"
                    />
                  </>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSaveClient}
                  className="min-h-11 px-4 py-1.5 rounded-xl bg-amber-700 hover:bg-amber-800 text-white font-bold cursor-pointer"
                >
                  Lưu &amp; Kiểm tra
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-stone-200">
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 font-semibold text-stone-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={clientCfg.vietnameseRaster !== false}
                    onChange={(e) =>
                      setClientCfg({ ...clientCfg, vietnameseRaster: e.target.checked })
                    }
                    className="w-4 h-4 accent-emerald-600"
                  />
                  <span>
                    🇻🇳 In tiếng Việt có dấu (<b>Raster ESC/POS GS v 0</b>)
                  </span>
                </label>
                <select
                  value={clientCfg.paperWidth || 'K80'}
                  onChange={(e) => setClientCfg({ ...clientCfg, paperWidth: e.target.value })}
                  className="min-h-10 px-2.5 py-1 border rounded-xl font-bold bg-white text-stone-800"
                  title="Chọn khổ giấy máy in hóa đơn (K80: 576px / K58: 384px)"
                >
                  <option value="K80">🧾 Khổ giấy K80 (80mm • 576px)</option>
                  <option value="K58">🧾 Khổ giấy K58 (58mm • 384px)</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-stone-200">
              <label className="inline-flex items-center gap-2 font-semibold text-stone-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(clientCfg.cloudRelayFallback)}
                  onChange={(e) =>
                    setClientCfg({ ...clientCfg, cloudRelayFallback: e.target.checked })
                  }
                  className="w-4 h-4 accent-sky-600"
                />
                <span>
                  ☁️ Tự động chuyển tiếp qua <b>Cloud Print Relay (HTTPS)</b> khi dùng iPad / Android Tablet (không lo chặn Mixed Content!)
                </span>
              </label>

              <div className="flex flex-wrap gap-2">
                {isWebBluetoothSupported() && (
                  <button
                    type="button"
                    onClick={handleConnectWebBluetooth}
                    className="min-h-10 px-3 py-1 rounded-xl bg-violet-100 hover:bg-violet-200 text-violet-900 font-bold cursor-pointer"
                  >
                    📶 Ghép máy in Bluetooth (BLE)
                  </button>
                )}
                {isWebSerialSupported() && (
                  <button
                    type="button"
                    onClick={handleConnectWebSerial}
                    className="min-h-10 px-3 py-1 rounded-xl bg-sky-100 hover:bg-sky-200 text-sky-900 font-bold cursor-pointer"
                  >
                    🔌 Ghép máy in WebSerial (COM/USB)
                  </button>
                )}
                {isWebUsbSupported() && (
                  <button
                    type="button"
                    onClick={handleConnectWebUsb}
                    className="min-h-10 px-3 py-1 rounded-xl bg-indigo-100 hover:bg-indigo-200 text-indigo-900 font-bold cursor-pointer"
                  >
                    🔌 Ghép máy in WebUSB
                  </button>
                )}
              </div>
            </div>
          </div>

          {!online && (
            <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-950 space-y-2">
              <p className="font-extrabold">💡 Giải pháp Print Hub đa nền tảng (Windows / macOS / Raspberry Pi / iPad / Android):</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  <b>PC Windows:</b> Nhấp đúp <code className="bg-white px-1.5 py-0.5 rounded border font-mono">local-print-bridge/start-bridge.bat</code> (hoặc <code className="font-mono">install-windows-autorun.bat</code> để tự chạy ngầm khi mở máy).
                </li>
                <li>
                  <b>iPad / Android Tablet (LAN Print Hub):</b> Đặt 1 máy tính quầy hoặc <b>Raspberry Pi</b> chạy <code className="bg-white px-1.5 py-0.5 rounded border font-mono">bash local-print-bridge/start-bridge.sh</code> (kèm <code className="font-mono">CLOUD_RELAY_URL</code>) rồi chọn chế độ <b>☁️ Cloud Print Relay</b> trên mọi iPad/điện thoại phục vụ.
                </li>
                <li>
                  <b>Android / Chrome không cần PC Hub:</b> Chọn <b>📶 WebBluetooth</b>, <b>🔌 WebUSB</b> hoặc <b>📱 Android RawBT</b> ngay phía trên!
                </li>
              </ul>
            </div>
          )}

          {/* Cấu hình 2 máy in độc lập khi Bridge Online */}
          {online && printerCfg && (
            <form onSubmit={handleSavePrinters} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Máy in Bill K80 */}
                <div className="p-4 rounded-xl border border-gray-200 space-y-2.5 bg-white">
                  <h4 className="font-extrabold text-sm text-gray-800">🧾 Máy in Bill K80 (ESC/POS + RJ11)</h4>
                  <div>
                    <label className="block font-bold text-gray-600 mb-1">Chế độ kết nối</label>
                    <select
                      value={printerCfg.receiptPrinter.mode}
                      onChange={(e) =>
                        setPrinterCfg({
                          ...printerCfg,
                          receiptPrinter: { ...printerCfg.receiptPrinter, mode: e.target.value },
                        })
                      }
                      className="w-full px-3 py-2 border rounded-lg bg-white font-semibold"
                    >
                      <option value="SIMULATOR">🧪 Simulator (Test không cần máy in thật)</option>
                      <option value="LAN_TCP">🌐 Máy in mạng LAN (TCP Raw Port 9100)</option>
                      <option value="WINDOWS_SHARE">🔌 Máy in USB chia sẻ Windows (\\localhost\Share)</option>
                    </select>
                  </div>
                  {printerCfg.receiptPrinter.mode === 'LAN_TCP' && (
                    <div className="grid grid-cols-3 gap-2">
                      <input
                        type="text"
                        placeholder="IP máy in (VD 192.168.1.200)"
                        value={printerCfg.receiptPrinter.host || ''}
                        onChange={(e) =>
                          setPrinterCfg({
                            ...printerCfg,
                            receiptPrinter: { ...printerCfg.receiptPrinter, host: e.target.value },
                          })
                        }
                        className="col-span-2 px-2.5 py-2 border rounded-lg font-mono"
                      />
                      <input
                        type="number"
                        value={printerCfg.receiptPrinter.port || 9100}
                        onChange={(e) =>
                          setPrinterCfg({
                            ...printerCfg,
                            receiptPrinter: { ...printerCfg.receiptPrinter, port: Number(e.target.value) },
                          })
                        }
                        className="px-2.5 py-2 border rounded-lg font-mono"
                      />
                    </div>
                  )}
                  {printerCfg.receiptPrinter.mode === 'WINDOWS_SHARE' && (
                    <input
                      type="text"
                      placeholder="Tên Share Windows (VD: XP-80C)"
                      value={printerCfg.receiptPrinter.shareName || ''}
                      onChange={(e) =>
                        setPrinterCfg({
                          ...printerCfg,
                          receiptPrinter: { ...printerCfg.receiptPrinter, shareName: e.target.value },
                        })
                      }
                      className="w-full px-2.5 py-2 border rounded-lg font-mono"
                    />
                  )}
                  <div className="flex flex-col gap-1.5 pt-1">
                    <label className="inline-flex items-center gap-2 font-semibold text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={printerCfg.receiptPrinter.autoCut !== false}
                        onChange={(e) =>
                          setPrinterCfg({
                            ...printerCfg,
                            receiptPrinter: { ...printerCfg.receiptPrinter, autoCut: e.target.checked },
                          })
                        }
                      />
                      Tự động cắt giấy sau khi in (GS V 66)
                    </label>
                    <label className="inline-flex items-center gap-2 font-semibold text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={printerCfg.receiptPrinter.kickDrawerOnCash !== false}
                        onChange={(e) =>
                          setPrinterCfg({
                            ...printerCfg,
                            receiptPrinter: { ...printerCfg.receiptPrinter, kickDrawerOnCash: e.target.checked },
                          })
                        }
                      />
                      Tự động mở két tiền RJ11 khi thu Tiền mặt
                    </label>
                  </div>
                </div>

                {/* Máy in Tem 50x30mm */}
                <div className="p-4 rounded-xl border border-gray-200 space-y-2.5 bg-white">
                  <h4 className="font-extrabold text-sm text-gray-800">🏷️ Máy in Tem Cốc 50×30mm (TSPL2)</h4>
                  <div>
                    <label className="block font-bold text-gray-600 mb-1">Chế độ kết nối</label>
                    <select
                      value={printerCfg.labelPrinter.mode}
                      onChange={(e) =>
                        setPrinterCfg({
                          ...printerCfg,
                          labelPrinter: { ...printerCfg.labelPrinter, mode: e.target.value },
                        })
                      }
                      className="w-full px-3 py-2 border rounded-lg bg-white font-semibold"
                    >
                      <option value="SIMULATOR">🧪 Simulator (Test không cần máy in thật)</option>
                      <option value="LAN_TCP">🌐 Máy in tem mạng LAN (TCP Port 9100)</option>
                      <option value="WINDOWS_SHARE">🔌 Máy in tem USB chia sẻ Windows (\\localhost\Share)</option>
                    </select>
                  </div>
                  {printerCfg.labelPrinter.mode === 'LAN_TCP' && (
                    <div className="grid grid-cols-3 gap-2">
                      <input
                        type="text"
                        placeholder="IP máy in tem"
                        value={printerCfg.labelPrinter.host || ''}
                        onChange={(e) =>
                          setPrinterCfg({
                            ...printerCfg,
                            labelPrinter: { ...printerCfg.labelPrinter, host: e.target.value },
                          })
                        }
                        className="col-span-2 px-2.5 py-2 border rounded-lg font-mono"
                      />
                      <input
                        type="number"
                        value={printerCfg.labelPrinter.port || 9100}
                        onChange={(e) =>
                          setPrinterCfg({
                            ...printerCfg,
                            labelPrinter: { ...printerCfg.labelPrinter, port: Number(e.target.value) },
                          })
                        }
                        className="px-2.5 py-2 border rounded-lg font-mono"
                      />
                    </div>
                  )}
                  {printerCfg.labelPrinter.mode === 'WINDOWS_SHARE' && (
                    <input
                      type="text"
                      placeholder="Tên Share Windows (VD: XP-350B)"
                      value={printerCfg.labelPrinter.shareName || ''}
                      onChange={(e) =>
                        setPrinterCfg({
                          ...printerCfg,
                          labelPrinter: { ...printerCfg.labelPrinter, shareName: e.target.value },
                        })
                      }
                      className="w-full px-2.5 py-2 border rounded-lg font-mono"
                    />
                  )}
                  <p className="text-[11px] text-gray-500">
                    Hỗ trợ tách 1 đơn N ly thành N tem độc lập (Xprinter XP-350B / XP-365B / Gprinter / HPRT).
                  </p>
                </div>
              </div>

              <div className="p-3.5 rounded-xl border border-gray-200 bg-white space-y-1.5">
                <label className="block font-extrabold text-xs text-gray-800">
                  🌐 Danh sách Origin HTTPS được phép kết nối CORS (phân tách bằng dấu phẩy)
                </label>
                <input
                  type="text"
                  value={(printerCfg.security?.allowedOrigins || []).join(', ')}
                  onChange={(e) =>
                    setPrinterCfg({
                      ...printerCfg,
                      security: {
                        ...(printerCfg.security || {}),
                        allowedOrigins: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      },
                    })
                  }
                  placeholder="https://*.vercel.app, https://pos.tenquancuaban.vn"
                  className="w-full px-3 py-2 border rounded-lg font-mono text-xs bg-stone-50"
                />
                <p className="text-[11px] text-gray-500">
                  Localhost / 127.0.0.1 luôn tự động được phép. Mọi domain lạ ngoài danh sách sẽ bị chặn 403.
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={handleTestReceipt}
                    className="px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white font-bold cursor-pointer"
                  >
                    🖨️ In thử Bill K80
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={handleTestLabels}
                    className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold cursor-pointer"
                  >
                    🏷️ In thử Tem 50×30
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={handleNoSaleKick}
                    className="px-3.5 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold cursor-pointer"
                  >
                    💰 Mở két (No-Sale • Có Log)
                  </button>
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold cursor-pointer shadow"
                >
                  💾 Lưu cấu hình máy in
                </button>
              </div>
            </form>
          )}

          {/* Hàng đợi lệnh in gần đây & In lại khi kẹt giấy */}
          {online && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="font-extrabold text-sm text-gray-800">
                  📋 Hàng đợi lệnh in gần đây ({jobs.length})
                </h4>
                <button
                  type="button"
                  onClick={() => void refreshBridge()}
                  className="text-amber-700 font-bold hover:underline cursor-pointer"
                >
                  ↻ Làm mới
                </button>
              </div>
              {jobs.length === 0 ? (
                <p className="text-gray-400 italic py-4 text-center border rounded-xl">
                  Chưa có lệnh in nào trong phiên này — bấm &ldquo;In thử Bill K80&rdquo; để kiểm tra!
                </p>
              ) : (
                <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                  {jobs.map((j) => (
                    <div key={j.id} className="p-3 rounded-xl border bg-stone-50 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${
                              j.status === 'DONE'
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-red-100 text-red-700'
                            }`}
                          >
                            {j.status}
                          </span>
                          <span className="font-bold text-gray-800">
                            #{j.id} • {j.label}
                          </span>
                          <span className="text-[10px] text-gray-400">
                            {j.transport} ({j.bytes || 0}B)
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setExpandedJobId(expandedJobId === j.id ? null : j.id)}
                            className="px-2 py-1 rounded bg-white border text-gray-700 font-bold cursor-pointer"
                          >
                            {expandedJobId === j.id ? 'Ẩn' : 'Xem lệnh'}
                          </button>
                          <button
                            type="button"
                            disabled={loading}
                            onClick={() => handleRetryJob(j.id)}
                            className="px-2.5 py-1 rounded bg-amber-700 hover:bg-amber-800 text-white font-bold cursor-pointer"
                          >
                            ↻ In lại
                          </button>
                        </div>
                      </div>
                      {j.error && <p className="text-red-600 font-semibold">Lỗi: {j.error}</p>}
                      {expandedJobId === j.id && j.previewText && (
                        <pre className="p-2.5 rounded-lg bg-stone-900 text-emerald-300 font-mono text-[11px] overflow-x-auto whitespace-pre-wrap">
                          {j.previewText}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <ConfirmPinModal
        open={noSaleModalOpen}
        mode="input"
        title="💰 Mở két tiền không bán hàng (No-Sale RJ11)"
        message="Nhập lý do mở két tiền không bán hàng (bắt buộc ghi Audit Log):"
        placeholder="VD: Đổi tiền lẻ đầu ca..."
        minLength={3}
        confirmText="Mở két & Ghi Log"
        onConfirm={executeNoSaleKick}
        onCancel={() => setNoSaleModalOpen(false)}
      />
    </div>
  )
}
