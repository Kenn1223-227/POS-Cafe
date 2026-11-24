import { useState, useEffect, useCallback } from 'react'
import axiosClient from '../api/axiosClient'
import { formatVND } from '../utils/format'

export default function HourlySalesLaborChart({ tuNgay, denNgay, branchId = '' }) {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const params = {}
      if (tuNgay) params.fromDate = tuNgay
      if (denNgay) params.toDate = denNgay
      if (branchId) params.branchId = branchId
      const res = await axiosClient.get('/analytics/hourly-sales-vs-labor', { params, silent: true })
      setData(res || null)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [tuNgay, denNgay, branchId])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  const hours = data?.hours || []
  const maxSales = Math.max(...hours.map((h) => Number(h.netSales || 0)), 1)
  const summary = data?.summary || {
    totalNetSales: 0,
    totalLaborCost: 0,
    overallLaborCostPct: 0,
    highLaborHoursCount: 0,
  }

  return (
    <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-extrabold text-sm text-gray-800">
            ⏱️ Biểu Đồ Doanh Thu Theo Giờ vs. Tỷ Lệ Nhân Công (Hourly Sales vs. Labor Cost %)
          </h3>
          <p className="text-xs text-gray-500">
            24 khung giờ (00:00 → 23:00, UTC+7) • Cảnh báo đỏ khi Labor Cost % &gt; 30%
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
          <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-900">
            Doanh thu: {formatVND(summary.totalNetSales)}
          </span>
          <span className="px-2.5 py-1 rounded-full bg-sky-100 text-sky-900">
            Nhân công: {formatVND(summary.totalLaborCost)}
          </span>
          <span
            className={`px-2.5 py-1 rounded-full ${
              Number(summary.overallLaborCostPct) > 30
                ? 'bg-red-100 text-red-700'
                : 'bg-emerald-100 text-emerald-800'
            }`}
          >
            Labor Cost: {summary.overallLaborCostPct}%
          </span>
          {summary.highLaborHoursCount > 0 && (
            <span className="px-2.5 py-1 rounded-full bg-red-600 text-white">
              ⚠️ {summary.highLaborHoursCount} giờ &gt; 30%
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="py-10 text-center text-xs text-gray-400">
          Đang tổng hợp dữ liệu doanh thu &amp; chi phí nhân công 24 giờ...
        </div>
      ) : hours.length === 0 ? (
        <div className="py-8 text-center text-xs text-gray-400">
          Chưa có dữ liệu doanh thu / chấm công trong khoảng thời gian đã chọn.
        </div>
      ) : (
        <div className="overflow-x-auto pb-2">
          <div className="min-w-[760px] grid grid-cols-24 gap-1 items-end h-52 pt-6 border-b border-gray-200">
            {hours.map((h) => {
              const barPct = Math.max(h.netSales > 0 ? 6 : 2, Math.round((h.netSales / maxSales) * 100))
              const isHigh = Number(h.laborCostPct) > 30
              return (
                <div
                  key={h.hour}
                  className="flex flex-col items-center justify-end h-full group relative"
                  title={`${h.label} | Doanh thu: ${formatVND(h.netSales)} (${h.orderCount} đơn) | Nhân công: ${formatVND(h.laborCost)} (${h.activeStaffCount} NV) | Labor %: ${h.laborCostPct}%`}
                >
                  <span
                    className={`text-[9px] font-extrabold mb-1 px-1 rounded ${
                      isHigh
                        ? 'bg-red-600 text-white'
                        : h.laborCostPct > 0
                        ? 'text-emerald-700'
                        : 'text-gray-300'
                    }`}
                  >
                    {h.laborCostPct > 0 ? `${Math.round(h.laborCostPct)}%` : ''}
                  </span>
                  <div className="w-full flex items-end justify-center h-36">
                    <div
                      style={{ height: `${barPct}%` }}
                      className={`w-full max-w-[22px] rounded-t-md transition-all ${
                        isHigh
                          ? 'bg-red-500 hover:bg-red-600'
                          : h.netSales > 0
                          ? 'bg-amber-600 hover:bg-amber-700'
                          : 'bg-gray-200'
                      }`}
                    />
                  </div>
                  <span className="text-[9px] font-bold text-gray-500 mt-1">
                    {String(h.hour).padStart(2, '0')}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="flex items-center justify-between text-[11px] text-gray-500 mt-2">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-amber-600 inline-block" /> Doanh thu bình thường (≤ 30% Labor)
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-red-500 inline-block" /> Cảnh báo Labor Cost % &gt; 30%
              </span>
            </div>
            <button
              type="button"
              onClick={fetchData}
              className="px-2.5 py-1 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold cursor-pointer"
            >
              🔄 Làm mới
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
