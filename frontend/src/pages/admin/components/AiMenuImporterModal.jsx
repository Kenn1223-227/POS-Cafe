import { useState } from 'react'
import toast from 'react-hot-toast'
import { saasService } from '../../../services/saasService'

const SAMPLE_TEXT_MENU = `=== CÀ PHÊ ===
Cà phê đen đá - 25k / 29k / 35k
Cà phê sữa Sài Gòn - 29k / 35k / 39k
Bạc xỉu kem muối - 35k / 42k / 48k

=== TRÀ TRÁI CÂY ===
Trà đào cam sả - 39k / 45k / 52k
Trà mãng cầu tươi - 42k / 49k / 55k
Trà vải hoa hồng - 39k / 45k / 49k

=== BÁNH NGỌT ===
Croissant bơ Pháp, Bánh ngọt, 35000, 35000, 35000
Tiramisu cà phê, Bánh ngọt, 49000, 49000, 49000`

export default function AiMenuImporterModal({ isOpen, onClose, onImported }) {
  const [tab, setTab] = useState('TEXT') // 'TEXT' | 'IMAGE'
  const [rawText, setRawText] = useState('')
  const [imagePreview, setImagePreview] = useState(null)
  const [imageMime, setImageMime] = useState('image/jpeg')
  const [parsing, setParsing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [parsedItems, setParsedItems] = useState([])
  const [engineUsed, setEngineUsed] = useState(null)

  if (!isOpen) return null

  const handleFileChange = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 6 * 1024 * 1024) {
      toast.error('Ảnh menu tối đa 6MB!')
      return
    }
    setImageMime(file.type || 'image/jpeg')
    const reader = new FileReader()
    reader.onload = () => setImagePreview(reader.result)
    reader.readAsDataURL(file)
  }

  const handleParse = async () => {
    if (tab === 'TEXT' && !rawText.trim()) {
      toast.error('Hãy dán danh sách thực đơn hoặc bấm "Điền mẫu thử"!')
      return
    }
    if (tab === 'IMAGE' && !imagePreview) {
      toast.error('Hãy chọn ảnh chụp tờ menu giấy trước!')
      return
    }

    setParsing(true)
    try {
      const res = await saasService.aiParseMenu(
        tab === 'IMAGE'
          ? { imageBase64: imagePreview, mimeType: imageMime }
          : { rawText }
      )
      setEngineUsed(res.engine)
      if (res.hint && (!res.items || res.items.length === 0)) {
        toast(res.hint, { duration: 6000 })
      }
      setParsedItems(res.items || [])
      if (res.items?.length > 0) {
        toast.success(`✨ Đã bóc tách thành công ${res.items.length} món!`)
      }
    } catch {
      // Interceptor xử lý
    } finally {
      setParsing(false)
    }
  }

  const handleImportAll = async () => {
    if (parsedItems.length === 0) return
    setImporting(true)
    try {
      const res = await saasService.aiImportMenu(parsedItems)
      toast.success(res.message)
      setParsedItems([])
      setRawText('')
      setImagePreview(null)
      if (onImported) onImported()
      onClose()
    } catch {
      // Interceptor xử lý
    } finally {
      setImporting(false)
    }
  }

  const updateRow = (idx, field, val) => {
    setParsedItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [field]: val } : it)))
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-3xl w-full p-6 shadow-2xl space-y-4 max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between border-b pb-3">
          <div>
            <h3 className="font-extrabold text-base text-gray-800">
              ✨ AI Menu Importer — Tạo toàn bộ thực đơn trong 15 giây
            </h3>
            <p className="text-xs text-gray-500">
              Chụp ảnh tờ menu giấy (Gemini Vision) hoặc dán danh sách món từ Zalo / Excel / GrabFood
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

        <div className="flex gap-2 text-xs font-bold">
          <button
            type="button"
            onClick={() => setTab('TEXT')}
            className={`px-4 py-2 rounded-xl cursor-pointer ${
              tab === 'TEXT' ? 'bg-amber-700 text-white' : 'bg-stone-100 text-stone-700'
            }`}
          >
            📋 Dán văn bản / CSV / Zalo (Chạy ngay)
          </button>
          <button
            type="button"
            onClick={() => setTab('IMAGE')}
            className={`px-4 py-2 rounded-xl cursor-pointer ${
              tab === 'IMAGE' ? 'bg-amber-700 text-white' : 'bg-stone-100 text-stone-700'
            }`}
          >
            📸 Tải ảnh tờ Menu giấy (AI Vision)
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          {tab === 'TEXT' ? (
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-bold text-gray-600">Nội dung thực đơn thô:</span>
                <button
                  type="button"
                  onClick={() => setRawText(SAMPLE_TEXT_MENU)}
                  className="text-amber-700 font-bold hover:underline cursor-pointer"
                >
                  ⚡ Điền mẫu menu thử nghiệm
                </button>
              </div>
              <textarea
                rows={6}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder="Dán danh sách món (VD: Cà phê sữa đá - 29k / 35k / 39k)..."
                className="w-full p-3 border rounded-xl text-xs font-mono outline-none focus:ring-2 focus:ring-amber-600"
              />
            </div>
          ) : (
            <div className="border-2 border-dashed border-amber-300 rounded-2xl p-6 text-center space-y-3 bg-amber-50/40">
              <input
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="text-xs"
              />
              {imagePreview ? (
                <img
                  src={imagePreview}
                  alt="Ảnh menu tải lên"
                  className="max-h-48 mx-auto rounded-xl shadow border"
                />
              ) : (
                <p className="text-xs text-gray-500">
                  Chọn ảnh chụp thực đơn (JPEG/PNG). Cần cấu hình <code>GEMINI_API_KEY</code> trên backend để AI Vision đọc trực tiếp từ ảnh.
                </p>
              )}
            </div>
          )}

          <button
            type="button"
            disabled={parsing}
            onClick={handleParse}
            className="w-full min-h-11 bg-stone-900 hover:bg-stone-800 text-white font-bold rounded-xl text-xs cursor-pointer disabled:opacity-50"
          >
            {parsing ? '🤖 AI đang phân tích thực đơn...' : '🤖 Bóc tách tự động Tên món, Nhóm & Bảng giá Size'}
          </button>

          {/* Bảng xem trước & chỉnh sửa */}
          {parsedItems.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-extrabold text-emerald-800">
                  ✅ Xem trước {parsedItems.length} món ({engineUsed})
                </span>
                <span className="text-gray-400">Bạn có thể sửa nhanh giá trước khi lưu</span>
              </div>
              <div className="overflow-x-auto border rounded-xl">
                <table className="w-full text-xs text-left">
                  <thead className="bg-stone-50 text-stone-600 uppercase">
                    <tr>
                      <th className="p-2">Mã</th>
                      <th className="p-2">Tên món</th>
                      <th className="p-2">Nhóm</th>
                      <th className="p-2">Size S</th>
                      <th className="p-2">Size M</th>
                      <th className="p-2">Size L</th>
                      <th className="p-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {parsedItems.map((it, idx) => (
                      <tr key={idx}>
                        <td className="p-1.5">
                          <input
                            value={it.maMon}
                            onChange={(e) => updateRow(idx, 'maMon', e.target.value)}
                            className="w-16 px-2 py-1 border rounded font-mono"
                          />
                        </td>
                        <td className="p-1.5">
                          <input
                            value={it.tenMon}
                            onChange={(e) => updateRow(idx, 'tenMon', e.target.value)}
                            className="w-full min-w-[140px] px-2 py-1 border rounded font-bold"
                          />
                        </td>
                        <td className="p-1.5">
                          <input
                            value={it.nhomMon}
                            onChange={(e) => updateRow(idx, 'nhomMon', e.target.value)}
                            className="w-28 px-2 py-1 border rounded"
                          />
                        </td>
                        <td className="p-1.5">
                          <input
                            type="number"
                            value={it.giaS}
                            onChange={(e) => updateRow(idx, 'giaS', Number(e.target.value))}
                            className="w-20 px-2 py-1 border rounded text-right"
                          />
                        </td>
                        <td className="p-1.5">
                          <input
                            type="number"
                            value={it.giaM}
                            onChange={(e) => updateRow(idx, 'giaM', Number(e.target.value))}
                            className="w-20 px-2 py-1 border rounded text-right"
                          />
                        </td>
                        <td className="p-1.5">
                          <input
                            type="number"
                            value={it.giaL}
                            onChange={(e) => updateRow(idx, 'giaL', Number(e.target.value))}
                            className="w-20 px-2 py-1 border rounded text-right"
                          />
                        </td>
                        <td className="p-1.5">
                          <button
                            type="button"
                            onClick={() => setParsedItems((prev) => prev.filter((_, i) => i !== idx))}
                            className="text-red-500 font-bold cursor-pointer px-1"
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t pt-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 border rounded-xl text-xs font-bold cursor-pointer"
          >
            Đóng
          </button>
          <button
            type="button"
            disabled={importing || parsedItems.length === 0}
            onClick={handleImportAll}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-xl text-xs font-extrabold shadow cursor-pointer"
          >
            {importing ? 'Đang lưu vào POS...' : `✨ Nhập toàn bộ ${parsedItems.length} món vào POS`}
          </button>
        </div>
      </div>
    </div>
  )
}
