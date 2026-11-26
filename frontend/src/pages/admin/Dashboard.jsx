import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { baoCaoService } from '../../services/baoCaoService'
import { useAuthStore } from '../../store/authStore'
import FeatureLockedCard from '../../components/FeatureLockedCard'
import HourlySalesLaborChart from '../../components/HourlySalesLaborChart'
import { hasFeatureFlag } from '../../utils/featureFlags'
import { formatVND, formatDate, getTodayISO } from '../../utils/format'

const PTTT_LABEL = {
  TIEN_MAT: '💵 Tiền mặt',
  CHUYEN_KHOAN: '📱 Chuyển khoản / VietQR',
  THE: '💳 Quẹt thẻ',
  VOUCHER: '🎟️ Voucher / Điểm',
}

export default function Dashboard() {
  const { user } = useAuthStore()
  const allowBomBcg = hasFeatureFlag(user, 'inventory_bom')
  const [tuNgay, setTuNgay] = useState(() => getTodayISO().slice(0, 8) + '01')
  const [denNgay, setDenNgay] = useState(() => getTodayISO())
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState({
    tongSoDon: 0,
    tongDoanhThu: 0,
    tongGiaVon: 0,
    loiNhuanGop: 0,
    tySuatLoiNhuan: 0,
    tongChiPhiNhapKho: 0,
    loiNhuanTamTinh: 0,
    bieuDoDoanhThu: [],
    doanhThuTheoPhuongThuc: [],
    topMonBanChay: [],
  })
  const [bcg, setBcg] = useState({ summary: null, items: [] })

  const fetchReport = useCallback(async () => {
    setLoading(true)
    try {
      const [res, bcgRes] = await Promise.all([
        baoCaoService.dashboard({ tuNgay, denNgay }),
        allowBomBcg
          ? baoCaoService.menuEngineering({ tuNgay, denNgay }).catch(() => ({ summary: null, items: [] }))
          : Promise.resolve({ summary: null, items: [] }),
      ])
      setReport(res)
      setBcg(bcgRes || { summary: null, items: [] })
    } catch {
      // Interceptor đã báo lỗi
    } finally {
      setLoading(false)
    }
  }, [tuNgay, denNgay, allowBomBcg])

  useEffect(() => {
    const t = setTimeout(() => {
      void fetchReport()
    }, 0)
    return () => clearTimeout(t)
  }, [fetchReport])

  const maxRevenue = Math.max(...report.bieuDoDoanhThu.map((d) => d.doanhThu), 1)

  return (
    <div className="space-y-6">
      {/* Bộ lọc ngày */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-800">
            📊 Báo Cáo Kinh Doanh & Giá Vốn (COGS)
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Chuẩn múi giờ Việt Nam (UTC+7) • Tính Lợi nhuận gộp theo giá vốn định lượng thực tế (WAC)
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

      {/* Cảnh báo giới hạn lịch sử báo cáo 7 ngày trên gói FREE */}
      {Number(report.reportLimitDays) > 0 && (
        <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-300 flex flex-wrap items-center justify-between gap-3 text-xs">
          <span className="text-amber-950 font-semibold">
            📅 Gói <b>{report.currentPlan || 'FREE'}</b> chỉ xem được lịch sử báo cáo{' '}
            <b>{report.reportLimitDays} ngày gần nhất</b>
            {report.wasClamped && report.kyBaoCao?.tuNgay
              ? ` (đã tự động giới hạn từ ngày ${formatDate(report.kyBaoCao.tuNgay)}).`
              : '.'}{' '}
            Nâng cấp gói STARTER (chỉ 169.000đ/tháng) để xem toàn bộ lịch sử &amp; không giới hạn đơn!
          </span>
          <Link
            to="/admin/saas"
            className="px-3.5 py-1.5 rounded-xl bg-amber-700 hover:bg-amber-800 text-white font-extrabold shrink-0"
          >
            💎 Nâng cấp STARTER / PRO
          </Link>
        </div>
      )}

      {/* 5 Thẻ KPI chuẩn kế toán F&B */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white p-5 rounded-2xl shadow-sm border-l-4 border-emerald-500">
          <span className="text-xs font-bold uppercase text-gray-400">Tổng Doanh Thu</span>
          <p className="text-xl font-extrabold text-emerald-700 mt-2">
            {formatVND(report.tongDoanhThu)}
          </p>
          <p className="text-[11px] text-gray-500 mt-1">{report.tongSoDon} hóa đơn đã thu</p>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-sm border-l-4 border-amber-600">
          <span className="text-xs font-bold uppercase text-gray-400">Giá Vốn (COGS)</span>
          <p className="text-xl font-extrabold text-amber-800 mt-2">
            {formatVND(report.tongGiaVon)}
          </p>
          <p className="text-[11px] text-gray-500 mt-1">Theo định lượng BOM lúc bán</p>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-sm border-l-4 border-blue-600">
          <span className="text-xs font-bold uppercase text-gray-400">Lợi Nhuận Gộp</span>
          <p className="text-xl font-extrabold text-blue-700 mt-2">
            {formatVND(report.loiNhuanGop)}
          </p>
          <p className="text-[11px] font-bold text-emerald-700 mt-1">
            Biên lãi gộp: {report.tySuatLoiNhuan}%
          </p>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-sm border-l-4 border-orange-500">
          <span className="text-xs font-bold uppercase text-gray-400">Chi Nhập Kho Kỳ Này</span>
          <p className="text-xl font-extrabold text-orange-700 mt-2">
            {formatVND(report.tongChiPhiNhapKho)}
          </p>
          <p className="text-[11px] text-gray-500 mt-1">Dòng tiền chi mua NVL</p>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-sm border-l-4 border-stone-600">
          <span className="text-xs font-bold uppercase text-gray-400">Dòng Tiền Ròng</span>
          <p
            className={`text-xl font-extrabold mt-2 ${
              report.loiNhuanTamTinh >= 0 ? 'text-stone-800' : 'text-red-600'
            }`}
          >
            {formatVND(report.loiNhuanTamTinh)}
          </p>
          <p className="text-[11px] text-gray-500 mt-1">Doanh thu - Chi nhập kho</p>
        </div>
      </div>

      {/* Doanh thu theo PTTT & Top món bán chạy */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-5 bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-3">
          <h3 className="font-bold text-gray-800 text-base">💳 Cơ cấu Phương thức Thanh toán</h3>
          {report.doanhThuTheoPhuongThuc.length === 0 ? (
            <p className="text-xs text-gray-400 py-6 text-center">Chưa có giao dịch trong kỳ</p>
          ) : (
            <div className="space-y-2.5">
              {report.doanhThuTheoPhuongThuc.map((p) => {
                const pct =
                  report.tongDoanhThu > 0 ? Math.round((p.tongTien / report.tongDoanhThu) * 100) : 0
                return (
                  <div key={p.phuongThucTT} className="space-y-1 text-xs">
                    <div className="flex justify-between font-semibold">
                      <span>{PTTT_LABEL[p.phuongThucTT] || p.phuongThucTT}</span>
                      <span>
                        <b>{formatVND(p.tongTien)}</b> ({p.soDon} đơn • {pct}%)
                      </span>
                    </div>
                    <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full bg-amber-600 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="lg:col-span-7 bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-3">
          <h3 className="font-bold text-gray-800 text-base">🏆 Top Món Bán Chạy & Biên Lãi</h3>
          {report.topMonBanChay.length === 0 ? (
            <p className="text-xs text-gray-400 py-6 text-center">Chưa có dữ liệu món bán</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-gray-50 text-gray-600 uppercase">
                  <tr>
                    <th className="p-2.5">Món</th>
                    <th className="p-2.5 text-right">SL bán</th>
                    <th className="p-2.5 text-right">Doanh thu</th>
                    <th className="p-2.5 text-right">Lãi gộp</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.topMonBanChay.map((m) => (
                    <tr key={m.maMon} className="hover:bg-gray-50">
                      <td className="p-2.5 font-bold text-gray-800">{m.tenMon}</td>
                      <td className="p-2.5 text-right font-bold">{m.tongLy} ly</td>
                      <td className="p-2.5 text-right text-emerald-700 font-semibold">
                        {formatVND(m.doanhThu)}
                      </td>
                      <td className="p-2.5 text-right text-blue-700 font-bold">
                        {formatVND(m.loiNhuanGop)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Biểu đồ cột Doanh thu theo ngày */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 space-y-4">
        <h3 className="font-bold text-gray-800 text-base">
          📈 Biểu đồ Doanh thu & Lãi gộp theo ngày
        </h3>

        {report.bieuDoDoanhThu.length === 0 ? (
          <div className="py-12 text-center text-gray-400 text-sm">
            Chưa có dữ liệu hóa đơn thanh toán trong khoảng thời gian này
          </div>
        ) : (
          <>
            <div className="h-64 flex items-end gap-3 pt-8 pb-2 px-2 overflow-x-auto border-b border-gray-200">
              {report.bieuDoDoanhThu.map((item) => {
                const heightPct = Math.max(8, Math.round((item.doanhThu / maxRevenue) * 100))
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
                      title={`${item.ngay}: DT ${formatVND(item.doanhThu)} | Lãi gộp ${formatVND(item.loiNhuanGop)}`}
                    />
                    <span className="text-[11px] font-semibold text-gray-600 mt-2">
                      {item.ngay.slice(5)}
                    </span>
                    <span className="text-[10px] text-gray-400">{item.soDon} đơn</span>
                  </div>
                )
              })}
            </div>

            <div className="overflow-x-auto pt-2">
              <table className="w-full text-xs text-left">
                <thead className="bg-gray-50 text-gray-600 uppercase">
                  <tr>
                    <th className="p-3">Ngày</th>
                    <th className="p-3 text-right">Số hóa đơn</th>
                    <th className="p-3 text-right">Doanh thu</th>
                    <th className="p-3 text-right">Giá vốn (COGS)</th>
                    <th className="p-3 text-right">Lợi nhuận gộp</th>
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
                      <td className="p-3 text-right font-semibold text-amber-800">
                        {formatVND(r.giaVon)}
                      </td>
                      <td className="p-3 text-right font-bold text-blue-700">
                        {formatVND(r.loiNhuanGop)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* [P1 - BCG Matrix] Ma trận Kỹ thuật Thực đơn (Menu Engineering) */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-bold text-gray-800 text-base">
              🧠 Ma Trận Kỹ Thuật Thực Đơn (Menu Engineering — BCG)
            </h3>
            <p className="text-xs text-gray-500">
              Phân loại món theo Độ phổ biến (số ly bán) × Biên lợi nhuận gộp từ giá vốn định lượng (WAC)
            </p>
          </div>
          {bcg.summary && (
            <div className="flex flex-wrap gap-2 text-xs font-bold">
              <span className="px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800">⭐ Ngôi sao: {bcg.summary.STAR}</span>
              <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-900">🐄 Bò sữa: {bcg.summary.PLOWHORSE}</span>
              <span className="px-2.5 py-1 rounded-full bg-sky-100 text-sky-800">❓ Câu đố: {bcg.summary.PUZZLE}</span>
              <span className="px-2.5 py-1 rounded-full bg-red-100 text-red-800">🐕 Chó mực: {bcg.summary.DOG}</span>
            </div>
          )}
        </div>

        {!allowBomBcg ? (
          <FeatureLockedCard
            title="Ma trận Kỹ thuật Thực đơn (BCG Matrix & Giá vốn BOM)"
            description="Phân tích tự động món Ngôi sao / Bò sữa / Câu đố / Chó mực theo giá vốn định lượng WAC chỉ có từ gói PRO trở lên."
            requiredPlan="PRO"
            currentPlan={user?.goiCuoc || 'STARTER'}
          />
        ) : !bcg.items || bcg.items.length === 0 ? (
          <div className="py-8 text-center text-gray-400 text-sm">
            Chưa đủ dữ liệu bán hàng trong kỳ để phân tích ma trận BCG
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-gray-50 text-gray-600 uppercase">
                <tr>
                  <th className="p-2.5">Món</th>
                  <th className="p-2.5">Phân nhóm BCG</th>
                  <th className="p-2.5 text-right">Đã bán</th>
                  <th className="p-2.5 text-right">Lãi gộp / ly</th>
                  <th className="p-2.5 text-right">Biên LN</th>
                  <th className="p-2.5">Gợi ý tối ưu</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {bcg.items.map((it) => (
                  <tr key={it.maMon} className="hover:bg-gray-50">
                    <td className="p-2.5 font-bold text-gray-800">
                      {it.tenMon}
                      <span className="block text-[10px] font-normal text-gray-400">{it.nhomMon}</span>
                    </td>
                    <td className="p-2.5">
                      <span
                        className={`px-2 py-0.5 rounded-full font-extrabold text-[10px] ${
                          it.category === 'STAR'
                            ? 'bg-emerald-100 text-emerald-800'
                            : it.category === 'PLOWHORSE'
                            ? 'bg-amber-100 text-amber-900'
                            : it.category === 'PUZZLE'
                            ? 'bg-sky-100 text-sky-800'
                            : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {it.categoryLabel}
                      </span>
                    </td>
                    <td className="p-2.5 text-right font-bold">{it.soLyBan} ly</td>
                    <td className="p-2.5 text-right font-bold text-emerald-700">{formatVND(it.laiGopMoiLy)}</td>
                    <td className="p-2.5 text-right font-semibold">{it.bienLoiNhuanPct}%</td>
                    <td className="p-2.5 text-gray-600">{it.advice}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {/* Biểu đồ Doanh thu theo giờ vs. Labor Cost % (Wave 4A — P3-01) */}
      <HourlySalesLaborChart tuNgay={tuNgay} denNgay={denNgay} />
    </div>
  )
}
