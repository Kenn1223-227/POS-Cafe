import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { caService } from '../../../services/caService'
import { formatVND } from '../../../utils/format'

// Nén ảnh chụp chứng từ phía trình duyệt về JPEG gọn nhẹ (<= 120KB) để lưu nhanh & đối soát cuối ngày
function compressReceiptImage(file, maxWidth = 720, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Không đọc được file ảnh'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('Định dạng ảnh không hợp lệ'))
      img.onload = () => {
        const scale = img.width > maxWidth ? maxWidth / img.width : 1
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.src = String(reader.result || '')
    }
    reader.readAsDataURL(file)
  })
}

const LOAI_OPTIONS = [
  {
    id: 'THU',
    label: '📥 Thu lặt vặt',
    activeCls: 'bg-emerald-600 text-white border-emerald-600',
    desc: 'Tiền bổ sung thêm vào ngăn kéo (VD: Đổi thêm tiền lẻ đầu ca, thu hộ...).',
    placeholder: 'VD: Bổ sung thêm tiền lẻ từ chủ quán...',
  },
  {
    id: 'CHI',
    label: '📤 Chi lặt vặt',
    activeCls: 'bg-red-600 text-white border-red-600',
    desc: 'Chi phí vận hành phát sinh trong ca (VD: Mua thêm đá viên, sữa, túi rác...).',
    placeholder: 'VD: Mua 2 bao đá viên, tiền đổ rác...',
  },
  {
    id: 'RUT_KET',
    label: '🏦 Rút két (Safe Drop)',
    activeCls: 'bg-indigo-600 text-white border-indigo-600',
    desc: 'Rút tiền mặt từ ngăn kéo cất két sắt / nộp chủ quán giữa ca. Trừ vào quỹ két nhưng KHÔNG tính là chi phí quán.',
    placeholder: 'VD: Chủ quán (Anh Nam) rút két an toàn 2 triệu giữa ca trưa...',
  },
]

export default function ThuChiModal({ isOpen, onClose, onSuccess }) {
  const [loaiThuChi, setLoaiThuChi] = useState('CHI')
  const [soTien, setSoTien] = useState('')
  const [lyDo, setLyDo] = useState('')
  const [anhChungTuUrl, setAnhChungTuUrl] = useState('')
  const [recentList, setRecentList] = useState([])
  const [previewImg, setPreviewImg] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!isOpen) return undefined
    const t = setTimeout(() => {
      caService
        .getDanhSachThuChi()
        .then((res) => setRecentList(Array.isArray(res) ? res : []))
        .catch(() => setRecentList([]))
    }, 0)
    return () => clearTimeout(t)
  }, [isOpen])

  if (!isOpen) return null

  const currentOpt = LOAI_OPTIONS.find((o) => o.id === loaiThuChi) || LOAI_OPTIONS[1]

  const handlePickPhoto = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const compressed = await compressReceiptImage(file)
      setAnhChungTuUrl(compressed)
      toast.success('📷 Đã đính kèm ảnh chứng từ!')
    } catch {
      toast.error('Không thể xử lý ảnh chứng từ!')
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!soTien || Number(soTien) <= 0) {
      toast.error('Vui lòng nhập số tiền hợp lệ (> 0)')
      return
    }
    if (lyDo.trim().length < 3) {
      toast.error(
        loaiThuChi === 'RUT_KET'
          ? 'Vui lòng ghi rõ tên người nhận rút két / ghi chú bàn giao (tối thiểu 3 ký tự)'
          : 'Vui lòng nhập lý do thu/chi (tối thiểu 3 ký tự)'
      )
      return
    }

    setLoading(true)
    try {
      const res = await caService.thuChi({
        loaiThuChi,
        soTien: Number(soTien),
        lyDo: lyDo.trim(),
        anhChungTuUrl: anhChungTuUrl || null,
      })
      toast.success(res?.message || `Đã ghi nhận khoản ${loaiThuChi} thành công!`)
      setSoTien('')
      setLyDo('')
      setAnhChungTuUrl('')
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
          <h3 className="font-extrabold text-base text-gray-800">
            💵 Thu / Chi Lặt Vặt &amp; Rút Két (Safe Drop)
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-gray-100 font-bold text-gray-600 cursor-pointer"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {LOAI_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setLoaiThuChi(opt.id)}
                className={`py-2.5 px-1.5 rounded-xl font-bold text-[11px] border cursor-pointer transition ${
                  loaiThuChi === opt.id
                    ? opt.activeCls
                    : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div
            className={`p-2.5 rounded-xl text-[11px] border ${
              loaiThuChi === 'RUT_KET'
                ? 'bg-indigo-50 border-indigo-200 text-indigo-900'
                : loaiThuChi === 'THU'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-amber-50 border-amber-200 text-amber-900'
            }`}
          >
            💡 {currentOpt.desc}
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-600 mb-1">Số tiền (VND)</label>
            <input
              type="number"
              required
              min="1000"
              step="1000"
              value={soTien}
              onChange={(e) => setSoTien(e.target.value)}
              placeholder="Nhập số tiền..."
              className="w-full px-3 py-2 border rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-600 mb-1">
              {loaiThuChi === 'RUT_KET' ? 'Người nhận tiền & Ghi chú bàn giao *' : 'Lý do phát sinh *'}
            </label>
            <textarea
              required
              rows="2"
              value={lyDo}
              onChange={(e) => setLyDo(e.target.value)}
              placeholder={currentOpt.placeholder}
              className="w-full px-3 py-2 border rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>

          {/* Chụp / Đính kèm ảnh biên nhận hoặc chứng từ chi tại quầy (AnhChungTuUrl) */}
          <div className="p-2.5 rounded-xl bg-gray-50 border border-gray-200 flex items-center justify-between gap-2 text-xs">
            <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-gray-300 hover:bg-gray-100 font-bold text-gray-700 cursor-pointer">
              <span>📷 {anhChungTuUrl ? 'Đổi ảnh chứng từ' : 'Chụp / Đính kèm ảnh biên nhận'}</span>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handlePickPhoto}
                className="hidden"
              />
            </label>
            {anhChungTuUrl && (
              <div className="flex items-center gap-2">
                <img
                  src={anhChungTuUrl}
                  alt="Chứng từ"
                  onClick={() => setPreviewImg(anhChungTuUrl)}
                  className="w-10 h-10 object-cover rounded-lg border cursor-pointer"
                />
                <button
                  type="button"
                  onClick={() => setAnhChungTuUrl('')}
                  className="text-red-600 font-bold cursor-pointer"
                >
                  ✕
                </button>
              </div>
            )}
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 border rounded-xl text-xs font-bold cursor-pointer text-gray-700"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={loading}
              className={`flex-1 py-2.5 text-white rounded-xl text-xs font-bold shadow cursor-pointer disabled:opacity-50 ${
                loaiThuChi === 'RUT_KET'
                  ? 'bg-indigo-600 hover:bg-indigo-700'
                  : 'bg-amber-700 hover:bg-amber-800'
              }`}
            >
              {loading
                ? 'Đang lưu...'
                : loaiThuChi === 'RUT_KET'
                ? '🏦 Xác nhận Rút két'
                : 'Xác nhận ghi nhận'}
            </button>
          </div>
        </form>

        {/* Danh sách các phiếu thu/chi/rút két trong ca hiện tại (kèm xem ảnh chứng từ) */}
        {recentList.length > 0 && (
          <div className="pt-2 border-t space-y-1.5 text-xs">
            <p className="font-extrabold text-gray-700">📋 Phiếu đã lập trong ca ({recentList.length}):</p>
            <div className="max-h-32 overflow-y-auto divide-y pr-1">
              {recentList.slice(0, 6).map((p) => (
                <div key={p.maPhieuTC} className="py-1.5 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-bold text-gray-800">
                      [{p.loaiThuChi}] {formatVND(p.soTien)}
                    </span>
                    <p className="text-[11px] text-gray-500 truncate">{p.lyDo}</p>
                  </div>
                  {p.anhChungTuUrl && (
                    <button
                      type="button"
                      onClick={() => setPreviewImg(p.anhChungTuUrl)}
                      className="px-2 py-1 rounded bg-amber-100 text-amber-900 font-bold text-[10px] shrink-0 cursor-pointer"
                    >
                      🖼️ Xem ảnh
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {previewImg && (
          <div
            onClick={() => setPreviewImg(null)}
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          >
            <img
              src={previewImg}
              alt="Ảnh chứng từ phóng to"
              className="max-h-[85vh] max-w-full rounded-xl shadow-2xl"
            />
          </div>
        )}
      </div>
    </div>
  )
}