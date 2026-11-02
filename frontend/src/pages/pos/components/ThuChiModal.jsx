import { useState } from 'react'
import toast from 'react-hot-toast'
import { caService } from '../../../services/caService'

export default function ThuChiModal({ isOpen, onClose, onSuccess }) {
  const [loaiThuChi, setLoaiThuChi] = useState('CHI')
  const [soTien, setSoTien] = useState('')
  const [lyDo, setLyDo] = useState('')
  const [loading, setLoading] = useState(false)

  if (!isOpen) return null

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!soTien || Number(soTien) <= 0) {
      toast.error('Vui lòng nhập số tiền hợp lệ (> 0)')
      return
    }
    if (!lyDo.trim()) {
      toast.error('Vui lòng nhập lý do thu/chi')
      return
    }

    setLoading(true)
    try {
      await caService.thuChi({
        loaiThuChi,
        soTien: Number(soTien),
        lyDo: lyDo.trim(),
      })
      toast.success(`Đã ghi nhận khoản ${loaiThuChi} thành công!`)
      setSoTien('')
      setLyDo('')
      onSuccess()
      onClose()
    } catch {
      // Interceptor xử lý lỗi
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b pb-3">
          <h3 className="font-extrabold text-base text-gray-800">💵 Ghi Nhận Thu / Chi Lặt Vặt</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 font-bold text-gray-600 cursor-pointer">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setLoaiThuChi('THU')}
              className={`py-2.5 rounded-xl font-bold text-xs border cursor-pointer ${
                loaiThuChi === 'THU' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-gray-50 text-gray-700 border-gray-200'
              }`}
            >
              📥 Khoản Thu
            </button>
            <button
              type="button"
              onClick={() => setLoaiThuChi('CHI')}
              className={`py-2.5 rounded-xl font-bold text-xs border cursor-pointer ${
                loaiThuChi === 'CHI' ? 'bg-red-600 text-white border-red-600' : 'bg-gray-50 text-gray-700 border-gray-200'
              }`}
            >
              📤 Khoản Chi
            </button>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-600 mb-1">Số tiền (VND)</label>
            <input
              type="number"
              required
              value={soTien}
              onChange={(e) => setSoTien(e.target.value)}
              placeholder="Nhập số tiền..."
              className="w-full px-3 py-2 border rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-600 mb-1">Lý do phát sinh</label>
            <textarea
              required
              rows="3"
              value={lyDo}
              onChange={(e) => setLyDo(e.target.value)}
              placeholder="Nhập lý do thu/chi (VD: Mua thêm đá viên, tiền nước dọn dẹp...)"
              className="w-full px-3 py-2 border rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 border rounded-xl text-xs font-bold cursor-pointer text-gray-700">Hủy</button>
            <button type="submit" disabled={loading} className="flex-1 py-2.5 bg-amber-700 hover:bg-amber-800 text-white rounded-xl text-xs font-bold shadow cursor-pointer disabled:opacity-50">
              {loading ? 'Đang lưu...' : 'Xác nhận ghi nhận'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}