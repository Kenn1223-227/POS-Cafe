import { formatDateTime, formatVND } from '../../../utils/format'
import { printCupLabels50x30, printReceiptK80 } from '../../../utils/printHelper'
import { getOrCreatePosDeviceId } from '../../../offline/offlineDb'

const STATUS_BADGE = {
  PENDING: { text: '⏳ Chờ mạng', cls: 'bg-amber-100 text-amber-900' },
  SYNCING: { text: '🔄 Đang đẩy...', cls: 'bg-sky-100 text-sky-900' },
  FAILED: { text: '⚠️ Lỗi xung đột', cls: 'bg-red-100 text-red-800' },
}

const JOB_TYPE_LABEL = {
  QUICK_CHECKOUT: '⚡ Thu nhanh',
  ORDER_CREATE: '📝 Order bàn',
  INVOICE_PAY: '💵 Thanh toán bàn',
}

export default function OfflineQueueModal({
  isOpen,
  onClose,
  isOnline,
  jobs = [],
  syncing = false,
  cacheUpdatedAt,
  onSyncNow,
  onDeleteJob,
  thuNgan = '',
}) {
  if (!isOpen) return null

  const totalQueuedAmount = jobs.reduce((s, j) => s + Number(j.totalAmount || 0), 0)
  const deviceId = getOrCreatePosDeviceId()

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full p-5 shadow-2xl space-y-4 max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between border-b pb-3">
          <div>
            <h3 className="font-extrabold text-base text-gray-800">
              📡 Hàng Đợi Offline Outbox (IndexedDB)
            </h3>
            <p className="text-xs text-gray-500">
              Trạng thái: {isOnline ? <b className="text-emerald-700">🟢 Đã có mạng</b> : <b className="text-red-600">🔴 Đang mất mạng</b>}
              {' • '}Mã máy POS: <code className="font-bold text-stone-700">{deviceId}</code>
              {cacheUpdatedAt && <> • Cache Menu/KM/KH lúc: {formatDateTime(cacheUpdatedAt)}</>}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 rounded-full bg-gray-100 hover:bg-gray-200 font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="bg-stone-50 border border-stone-200 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div>
            <p className="font-bold text-gray-800">
              Đang chờ đồng bộ: <b>{jobs.length} đơn</b> • Tổng giá trị: <b className="text-amber-800">{formatVND(totalQueuedAmount)}</b>
            </p>
            <p className="text-[11px] text-gray-500">
              Mọi đơn đều gắn <code>Idempotency-Key</code> & mã <code>OFF-{deviceId}-YYYYMMDD-ULID</code> duy nhất — chống trùng 100% giữa nhiều máy POS.
            </p>
          </div>
          <button
            type="button"
            disabled={!isOnline || syncing || jobs.length === 0}
            onClick={() => onSyncNow(true)}
            className="min-h-10 px-4 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white font-extrabold rounded-xl cursor-pointer shadow-sm"
          >
            {syncing ? '🔄 Đang đồng bộ...' : '🔄 Đồng bộ tất cả ngay'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
          {jobs.length === 0 ? (
            <div className="py-12 text-center text-gray-400 text-xs space-y-2">
              <p className="text-3xl">✅</p>
              <p className="font-semibold text-gray-600">Toàn bộ đơn hàng đã được đồng bộ lên máy chủ!</p>
            </div>
          ) : (
            jobs.map((job) => {
              const badge = STATUS_BADGE[job.status] || STATUS_BADGE.PENDING
              return (
                <div
                  key={job.id}
                  className="p-3.5 rounded-xl border border-gray-200 bg-white space-y-2 text-xs shadow-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-extrabold text-sm text-gray-800">
                        {job.payload?.offlineClientId || job.localInvoice?.maHoaDon} • {job.tableName}{' '}
                        <span className="text-xs font-semibold text-gray-500">
                          ({JOB_TYPE_LABEL[job.type] || '📝 Đơn Offline'})
                        </span>
                      </p>
                      <p className="text-[11px] text-gray-500">
                        Tạo lúc: {formatDateTime(job.createdAt)} •{' '}
                        {job.localInvoice?.danhSachMon?.reduce((s, m) => s + Number(m.soLuong), 0) || 0} ly
                        {job.payload?.maCaThuNganGoc && <> • Ca gốc #{job.payload.maCaThuNganGoc}</>}
                      </p>
                    </div>
                    <div className="text-right space-y-1">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-extrabold ${badge.cls}`}>
                        {badge.text}
                      </span>
                      <p className="font-black text-amber-800 text-sm">{formatVND(job.totalAmount)}</p>
                    </div>
                  </div>

                  {job.lastError && (
                    <div className="p-2 rounded-lg bg-red-50 border border-red-200 text-red-700 font-semibold text-[11px]">
                      ⚠️ {job.lastError}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1 border-t">
                    <button
                      type="button"
                      onClick={() =>
                        printReceiptK80(job.localInvoice, { laDonOffline: true, thuNgan })
                      }
                      className="px-3 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 font-bold text-stone-800 cursor-pointer"
                    >
                      🖨️ In Bill
                    </button>
                    {job.type !== 'INVOICE_PAY' && (
                      <button
                        type="button"
                        onClick={() => printCupLabels50x30(job.localInvoice)}
                        className="px-3 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 font-bold text-stone-800 cursor-pointer"
                      >
                        🏷️ In Tem
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Xóa đơn offline ${job.payload?.offlineClientId || job.localInvoice?.maHoaDon} khỏi hàng đợi?`)) {
                          onDeleteJob(job.id)
                        }
                      }}
                      className="px-3 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 font-bold text-red-600 cursor-pointer"
                    >
                      🗑️ Xóa
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
