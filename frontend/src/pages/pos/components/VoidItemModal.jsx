import { memo } from 'react'

const VoidItemModal = memo(function VoidItemModal({
  voidTarget,
  activeInvoice,
  canApproveVoidOrRefund,
  voidReason,
  onChangeVoidReason,
  voidPin,
  onChangeVoidPin,
  pinApprovers,
  voidApproverId,
  onChangeVoidApproverId,
  voidSubmitting,
  onClose,
  onConfirm,
}) {
  if (!voidTarget) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-extrabold text-base text-red-700">
              🚫 Hủy món: {voidTarget.tenMon} ({voidTarget.kichThuoc})
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {voidTarget.trangThaiPhaChe !== 'ChoPhaChe'
                ? '⚠️ Món ĐÃ pha chế — hệ thống sẽ ghi nhận HAO HỤT (không hoàn kho).'
                : '↩️ Món CHƯA pha chế — hệ thống sẽ tự động hoàn nguyên liệu về kho.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-w-[44px] min-h-[44px] rounded-full bg-gray-100 font-bold cursor-pointer"
          >
            ✕ [ESC]
          </button>
        </div>

        <form onSubmit={onConfirm} className="space-y-3 text-xs">
          <div>
            <label className="block font-bold text-gray-700 mb-1.5">Chọn nhanh lý do hủy:</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {['Khách đổi ý', 'Thu ngân bấm nhầm', 'Khách đợi lâu', 'Pha nhầm món'].map((r) => (
                <button
                  type="button"
                  key={r}
                  onClick={() => onChangeVoidReason(r)}
                  className={`min-h-[44px] px-3 py-1.5 rounded-xl border font-semibold cursor-pointer ${
                    voidReason === r
                      ? 'bg-red-600 text-white border-red-600'
                      : 'bg-gray-50 hover:bg-gray-100 text-gray-700 border-gray-200'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <input
              type="text"
              required
              value={voidReason}
              onChange={(e) => onChangeVoidReason(e.target.value)}
              placeholder="Hoặc nhập lý do cụ thể (tối thiểu 3 ký tự)..."
              className="w-full min-h-[52px] px-3 border rounded-xl text-xs"
            />
          </div>

          {(voidTarget.trangThaiPhaChe !== 'ChoPhaChe' || activeInvoice?.daInTamTinh) &&
            !canApproveVoidOrRefund && (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-300 space-y-2">
                <label className="block font-extrabold text-amber-900">
                  🔒 Phê duyệt Quản lý / Ca trưởng (xác thực PIN O(1)):
                </label>
                <p className="text-[11px] text-amber-800">
                  {activeInvoice?.daInTamTinh
                    ? 'Hóa đơn đã in tạm tính — chọn Quản lý hoặc Ca trưởng để xác thực PIN O(1) chống gian lận.'
                    : 'Món đã nhận pha chế — chọn Quản lý hoặc Ca trưởng để xác nhận hao hụt.'}
                </p>
                {pinApprovers.length > 0 && (
                  <select
                    value={voidApproverId}
                    onChange={(e) => onChangeVoidApproverId(e.target.value)}
                    className="w-full min-h-[48px] px-3 border border-amber-400 bg-white rounded-xl text-xs font-bold text-stone-800"
                  >
                    {pinApprovers.map((ap) => (
                      <option key={ap.maNV} value={ap.maNV}>
                        {ap.laCaTruong && Number(ap.vaiTro) !== 1 ? '🎖️ Ca trưởng: ' : '👔 Quản lý: '}
                        {ap.tenNV} ({ap.maNV})
                      </option>
                    ))}
                  </select>
                )}
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  value={voidPin}
                  onChange={(e) => onChangeVoidPin(e.target.value.replace(/\D/g, ''))}
                  placeholder="Nhập mã PIN 4–6 chữ số..."
                  className="w-full min-h-[52px] px-3 border border-amber-400 bg-white rounded-xl text-sm font-mono tracking-widest font-bold"
                />
              </div>
            )}

          <div className="flex gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 min-h-[52px] border rounded-xl font-bold cursor-pointer"
            >
              Đóng [ESC]
            </button>
            <button
              type="submit"
              disabled={voidSubmitting}
              className="flex-1 min-h-[52px] bg-red-600 hover:bg-red-700 text-white rounded-xl font-extrabold cursor-pointer disabled:bg-gray-300"
            >
              {voidSubmitting ? 'Đang xử lý...' : 'Xác nhận hủy món'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
})

export default VoidItemModal
