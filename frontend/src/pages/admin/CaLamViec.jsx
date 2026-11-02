import { useState, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'
import { caService } from '../../services/caService'
import { formatVND, formatDateTime, getTodayISO } from '../../utils/format'

export default function CaLamViec() {
  const [tuNgay, setTuNgay] = useState(() => getTodayISO())
  const [denNgay, setDenNgay] = useState(() => getTodayISO())
  const [danhSachCa, setDanhSachCa] = useState([])
  const [selectedCa, setSelectedCa] = useState(null)
  const [thuChiList, setThuChiList] = useState([])
  
  // Dữ liệu đối soát & đóng ca
  const [tienThucTeInput, setTienThucTeInput] = useState('')
  const [doiSoatResult, setDoiSoatResult] = useState(null)
  const [loadingAction, setLoadingAction] = useState(false)

  const loadCaData = useCallback(async () => {
    try {
      const list = await caService.getDanhSachCa(tuNgay, denNgay)
      setDanhSachCa(list)
      if (list.length > 0) {
        // Tự động chọn ca đầu tiên hoặc giữ nguyên ca đang chọn
        setSelectedCa((prev) => (prev ? list.find((c) => c.maCaThuNgan === prev.maCaThuNgan) || list[0] : list[0]))
      } else {
        setSelectedCa(null)
      }
    } catch {
      // Interceptor xử lý
    }
  }, [tuNgay, denNgay])

  useEffect(() => {
    loadCaData()
  }, [loadCaData])

  const handleSelectCa = async (ca) => {
    setSelectedCa(ca)
    setDoiSoatResult(null)
    setTienThucTeInput(ca.tienMatThucTe !== null ? String(ca.tienMatThucTe) : '')
    try {
      const tc = await caService.getDanhSachThuChi(ca.maCaThuNgan)
      setThuChiList(tc)
    } catch {
      setThuChiList([])
    }
  }

  // 1. Chỉ kiểm tra xem trước đối soát (GET /api/ca/doisoat)
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

  // 2. Chốt ca chính thức vào CSDL (POST /api/ca/dong)
  const handleDongCa = async () => {
    if (!selectedCa || tienThucTeInput === '') {
      toast.error('Vui lòng nhập số tiền thực tế trước khi chốt ca!')
      return
    }
    if (!window.confirm(`Xác nhận chốt ca #${selectedCa.maCaThuNgan}? Sau khi chốt sẽ không thể chỉnh sửa.`)) return

    setLoadingAction(true)
    try {
      const res = await caService.dongCa(Number(tienThucTeInput))
      toast.success(res.message || 'Đã chốt ca thành công!')
      setDoiSoatResult(res.doiSoat)
      await loadCaData()
    } catch {
      // Interceptor xử lý
    } finally {
      setLoadingAction(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-extrabold text-gray-800">
        🕒 Quản Lý Ca Thu Ngân, Thu Chi & Chốt Quỹ
      </h1>

      {/* Thanh bộ lọc ngày */}
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
        {/* Cột trái: Danh sách ca */}
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
                        Ca #{ca.maCaThuNgan?.slice(0, 8)}... • {ca.tenNV}
                      </p>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        Mở: {formatDateTime(ca.thoiGianMoCa)}
                      </p>
                    </div>
                    <span className={`px-2.5 py-1 rounded-full text-[10px] font-extrabold ${
                      ca.trangThaiCa === 2 ? 'bg-emerald-100 text-emerald-800' : 'bg-orange-100 text-orange-800'
                    }`}>
                      {ca.trangThaiCa === 2 ? 'Đã chốt ca' : 'Đang mở'}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Cột phải: Đối soát & Chốt ca */}
        <div className="lg:col-span-7 space-y-4">
          {selectedCa ? (
            <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-4">
              <div className="flex justify-between items-start border-b pb-3">
                <div>
                  <h3 className="font-extrabold text-base text-gray-800">
                    Chi tiết Ca #{selectedCa.maCaThuNgan}
                  </h3>
                  <p className="text-xs text-gray-500">Người mở ca: <b>{selectedCa.tenNV}</b></p>
                  <p className="text-[11px] text-gray-400">
                    Trạng thái: <b>{selectedCa.trangThaiCa === 2 ? 'Đã chốt ca' : 'Đang hoạt động'}</b>
                  </p>
                </div>
                <div className="text-right text-xs">
                  <p className="text-gray-500">Tiền đầu ca: <b>{formatVND(selectedCa.tienMatDauCa)}</b></p>
                  <p className="text-emerald-700 font-bold mt-0.5">
                    Tổng thu HĐ: {formatVND(selectedCa.tongThuHoaDon || 0)}
                  </p>
                </div>
              </div>

              {/* Form Đối soát & Chốt ca */}
              <div className="bg-stone-50 p-4 rounded-xl border border-stone-200 space-y-3">
                <h4 className="font-bold text-xs uppercase text-stone-700">🧮 Đối soát & Chốt quỹ ca</h4>
                
                <div className="flex gap-2">
                  <input
                    type="number"
                    min="0"
                    disabled={selectedCa.trangThaiCa === 2}
                    value={tienThucTeInput}
                    onChange={(e) => setTienThucTeInput(e.target.value)}
                    placeholder="Nhập tiền mặt kiểm đếm thực tế..."
                    className="flex-1 px-3 py-2 bg-white border rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-600 disabled:bg-gray-100"
                  />
                  <button
                    type="button"
                    disabled={loadingAction}
                    onClick={handleCheckDoiSoat}
                    className="px-3.5 py-2 bg-stone-700 hover:bg-stone-800 text-white font-bold rounded-xl text-xs cursor-pointer disabled:opacity-50"
                  >
                    Kiểm tra quỹ
                  </button>
                  {selectedCa.trangThaiCa === 1 && (
                    <button
                      type="button"
                      disabled={loadingAction}
                      onClick={handleDongCa}
                      className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl text-xs cursor-pointer shadow disabled:opacity-50"
                    >
                      Chốt ca ngay
                    </button>
                  )}
                </div>

                {/* Kết quả đối soát hiển thị dạng thẻ thay cho chuỗi JSON thô */}
                {doiSoatResult && (
                  <div className="p-4 bg-white rounded-xl border border-amber-300 text-xs space-y-2 mt-3 shadow-sm">
                    <h5 className="font-extrabold text-amber-900 border-b pb-1 text-sm">📊 Bảng Tổng Hợp Đối Soát</h5>
                    <div className="grid grid-cols-2 gap-2 text-gray-700">
                      <p>Tiền mặt đầu ca: <b>{formatVND(doiSoatResult.tienMatDauCa)}</b></p>
                      <p>Doanh thu tiền mặt: <b className="text-emerald-700">+{formatVND(doiSoatResult.doanhThu?.tienMat || 0)}</b></p>
                      <p>Thu lặt vặt: <b className="text-emerald-700">+{formatVND(doiSoatResult.thuLatVat || 0)}</b></p>
                      <p>Chi lặt vặt: <b className="text-red-600">-{formatVND(doiSoatResult.chiLatVat || 0)}</b></p>
                    </div>

                    <div className="pt-2 border-t flex justify-between items-center text-xs">
                      <span>Quỹ tiền mặt lý thuyết:</span>
                      <span className="font-extrabold text-base text-gray-900">{formatVND(doiSoatResult.tienMatLyThuyet)}</span>
                    </div>

                    <div className="flex justify-between items-center text-xs">
                      <span>Thực tế kiểm đếm:</span>
                      <span className="font-extrabold text-base text-blue-700">{formatVND(doiSoatResult.tienMatThucTe)}</span>
                    </div>

                    <div className={`p-2 rounded-lg font-extrabold flex justify-between items-center ${
                      doiSoatResult.chenhLech === 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                    }`}>
                      <span>Chênh lệch: {doiSoatResult.trangThai}</span>
                      <span>{formatVND(doiSoatResult.chenhLech)}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Danh sách khoản thu chi */}
              <div>
                <h4 className="font-bold text-xs uppercase text-gray-600 mb-2">Khoản Thu / Chi lặt vặt ({thuChiList.length})</h4>
                {thuChiList.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">Không có khoản thu chi phát sinh trong ca này</p>
                ) : (
                  <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                    {thuChiList.map((tc) => (
                      <div key={tc.maPhieuTC} className="p-2.5 rounded-xl bg-gray-50 border flex justify-between items-center text-xs">
                        <div>
                          <span className={`px-2 py-0.5 rounded font-bold text-[10px] mr-2 ${
                            tc.loaiThuChi === 'THU' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                          }`}>
                            {tc.loaiThuChi}
                          </span>
                          <span className="font-semibold text-gray-800">{tc.lyDo}</span>
                        </div>
                        <span className="font-bold">{formatVND(tc.soTien)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-white p-12 rounded-2xl shadow-sm border border-gray-200 text-center text-gray-400 text-xs">
              Chọn một ca bên trái để xem chi tiết đối soát và chốt quỹ
            </div>
          )}
        </div>
      </div>
    </div>
  )
}