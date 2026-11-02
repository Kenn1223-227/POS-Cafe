import { useState, useEffect, useCallback } from 'react'
import { baoCaoService } from '../../services/baoCaoService'
import { formatVND, formatDate, getTodayISO } from '../../utils/format'

export default function Dashboard() {
  const [tuNgay, setTuNgay] = useState(() => getTodayISO().slice(0, 8) + '01')
  const [denNgay, setDenNgay] = useState(() => getTodayISO())
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState({
    tongSoDon: 0,
    tongDoanhThu: 0,
    tongChiPhiNhapKho: 0,
    loiNhuanTamTinh: 0,
    bieuDoDoanhThu: [],
  })

  const fetchReport = useCallback(async () => {
    setLoading(true)
    try {
      const res = await baoCaoService.dashboard({ tuNgay, denNgay })
      setReport(res)
    } catch {
      // Interceptor đã báo lỗi
    } finally {
      setLoading(false)
    }
  }, [tuNgay, denNgay])

  useEffect(() => {
    fetchReport()
  }, [fetchReport])

  const maxRevenue = Math.max(
    ...report.bieuDoDoanhThu.map((d) => d.doanhThu),
    1
  )

  return (
    <div className="space-y-6">
      {/* Bộ lọc ngày */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-800">
            📊 Báo Cáo Hoạt Động Kinh Doanh
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Tổng hợp doanh thu hóa đơn đã thanh toán, chi phí nhập nguyên liệu và lợi nhuận
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="date"
            value={tuNgay}
            onChange={(e) => setTuNgay(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-xl text-xs font-medium"
          />
          <span className="text-gray-400 font-bold">→</span>
          <input
            type="date"
            value={denNgay}
            onChange={(e) => setDenNgay(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-xl text-xs font-medium"
          />
          <button
            onClick={fetchReport}
            disabled={loading}
            className="px-4 py-2 bg-amber-700 hover:bg-amber-800 text-white font-bold rounded-xl text-xs cursor-pointer"
          >
            {loading ? 'Đang tải...' : 'Lọc dữ liệu'}
          </button>
        </div>
      </div>

      {/* 4 Thẻ chỉ số KPI */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-2xl shadow-sm border-l-4 border-emerald-500">
          <span className="text-xs font-bold uppercase text-gray-400">
            Tổng Doanh Thu
          </span>
          <p className="text-2xl font-extrabold text-emerald-700 mt-2">
            {formatVND(report.tongDoanhThu)}
          </p>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-sm border-l-4 border-blue-500">
          <span className="text-xs font-bold uppercase text-gray-400">
            Tổng Số Đơn Đã Thu
          </span>
          <p className="text-2xl font-extrabold text-gray-800 mt-2">
            {report.tongSoDon} đơn
          </p>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-sm border-l-4 border-orange-500">
          <span className="text-xs font-bold uppercase text-gray-400">
            Chi Phí Nhập Kho
          </span>
          <p className="text-2xl font-extrabold text-orange-700 mt-2">
            {formatVND(report.tongChiPhiNhapKho)}
          </p>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-sm border-l-4 border-amber-600">
          <span className="text-xs font-bold uppercase text-gray-400">
            Lợi Nhuận Tạm Tính
          </span>
          <p
            className={`text-2xl font-extrabold mt-2 ${
              report.loiNhuanTamTinh >= 0 ? 'text-amber-700' : 'text-red-600'
            }`}
          >
            {formatVND(report.loiNhuanTamTinh)}
          </p>
        </div>
      </div>

      {/* Biểu đồ cột Doanh thu theo ngày */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 space-y-4">
        <h3 className="font-bold text-gray-800 text-base">
          📈 Biểu đồ Doanh thu & Số đơn theo ngày
        </h3>

        {report.bieuDoDoanhThu.length === 0 ? (
          <div className="py-12 text-center text-gray-400 text-sm">
            Chưa có dữ liệu hóa đơn thanh toán trong khoảng thời gian này
          </div>
        ) : (
          <>
            <div className="h-64 flex items-end gap-3 pt-8 pb-2 px-2 overflow-x-auto border-b border-gray-200">
              {report.bieuDoDoanhThu.map((item) => {
                const heightPct = Math.max(
                  8,
                  Math.round((item.doanhThu / maxRevenue) * 100)
                )
                return (
                  <div
                    key={item.ngay}
                    className="flex flex-col items-center flex-1 min-w-[68px] h-full justify-end group"
                  >
                    <span className="text-[10px] font-bold text-amber-800 mb-1 opacity-90">
                      {formatVND(item.doanhThu)}
                    </span>
                    <div
                      style={{ height: `${heightPct}%` }}
                      className="w-10 bg-amber-600 group-hover:bg-amber-700 rounded-t-xl transition-all shadow-sm"
                      title={`${item.ngay}: ${formatVND(item.doanhThu)} (${item.soDon} đơn)`}
                    />
                    <span className="text-[11px] font-semibold text-gray-600 mt-2">
                      {item.ngay.slice(5)}
                    </span>
                    <span className="text-[10px] text-gray-400">
                      {item.soDon} đơn
                    </span>
                  </div>
                )
              })}
            </div>

            {/* Bảng chi tiết theo ngày */}
            <div className="overflow-x-auto pt-2">
              <table className="w-full text-xs text-left">
                <thead className="bg-gray-50 text-gray-600 uppercase">
                  <tr>
                    <th className="p-3">Ngày</th>
                    <th className="p-3 text-right">Số hóa đơn</th>
                    <th className="p-3 text-right">Doanh thu</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.bieuDoDoanhThu.map((r) => (
                    <tr key={r.ngay} className="hover:bg-gray-50">
                      <td className="p-3 font-semibold">{formatDate(r.ngay)}</td>
                      <td className="p-3 text-right">{r.soDon} đơn</td>
                      <td className="p-3 text-right font-bold text-emerald-700">
                        {formatVND(r.doanhThu)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}