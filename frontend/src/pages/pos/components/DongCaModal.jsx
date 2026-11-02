import { useState } from 'react'
import toast from 'react-hot-toast'
import { caService } from '../../../services/caService'
import { formatVND } from '../../../utils/format'

export default function DongCaModal({ isOpen, onClose, currentShift, onShiftClosed }) {
  const [tienThucTe, setTienThucTe] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (!isOpen || !currentShift) return null

  const lyThuyet = Number(currentShift.tienMatLyThuyet || 0)
  const thucTeNum = tienThucTe === '' ? null : Number(tienThucTe)
  const chenhLech = thucTeNum !== null ? thucTeNum - lyThuyet : null

  const handleDongCa = async (e) => {
    e.preventDefault()
    if (tienThucTe === '' || thucTeNum < 0) {
      toast.error('Vui lòng nhập tiền mặt thực tế kiểm đếm (>= 0)!')
      return
    }

    if (!window.confirm('Bạn có chắc chắn muốn chốt và đóng ca làm việc này?')) return

    setSubmitting(true)
    try {
      const res = await caService.dongCa(thucTeNum)
      toast.success(res.message || 'Chốt ca thành công!')
      onShiftClosed()
      onClose()
    } catch {
      // Interceptor đã xử lý toast lỗi
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b pb-3">
          <div>
            <h3 className="font-extrabold text-base text-gray-800">🔒 Chốt & Đóng Ca Làm Việc</h3>
            <p className="text-xs text-gray-500">Ca #{currentShift.maCaThuNgan?.slice(0, 8)}...</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 font-bold text-gray-600 cursor-pointer">
            ✕
          </button>
        </div>

        <form onSubmit={handleDongCa} className="space-y-4">
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
              value={tienThucTe}
              onChange={(e) => setTienThucTe(e.target.value)}
              placeholder="Nhập số tiền kiểm đếm trong két..."
              className="w-full px-3.5 py-2.5 border rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>

          {chenhLech !== null && (
            <div className={`p-3 rounded-xl border text-xs flex justify-between items-center font-bold ${
              chenhLech === 0 ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'bg-red-50 border-red-300 text-red-800'
            }`}>
              <span>Chênh lệch quỹ:</span>
              <span className="text-sm">
                {formatVND(chenhLech)} {chenhLech === 0 ? '(Khớp quỹ)' : chenhLech > 0 ? '(Thừa tiền)' : '(Hụt tiền)'}
              </span>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 border rounded-xl text-xs font-bold text-gray-700 cursor-pointer hover:bg-gray-50"
            >
              Hủy bỏ
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-bold shadow cursor-pointer disabled:opacity-50"
            >
              {submitting ? 'Đang chốt ca...' : 'Xác nhận Đóng Ca'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}