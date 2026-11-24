import { useState, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'
import axiosClient from '../../api/axiosClient'
import { ecosystemService } from '../../services/ecosystemService'
import { banService } from '../../services/banService'
import { sanPhamService } from '../../services/sanPhamService'
import { khoService } from '../../services/khoService'
import { formatVND, formatDateTime, getTodayISO } from '../../utils/format'

const TABS = [
  { id: 'branches', label: '🏢 Đa chi nhánh & Nhượng quyền' },
  { id: 'omnichannel', label: '📱 QR Order & Sàn Giao Hàng' },
  { id: 'crm', label: '👑 CRM Phân hạng, Ví & Zalo ZNS' },
  { id: 'horizontal', label: '🎱 Tính giờ & Lô bánh Bakery 19h' },
  { id: 'chain_ops', label: '💼 Bảng giá đa kênh, Đối soát & B2B' },
  { id: 'ai', label: '🤖 AI Dự báo Kho (60 ngày) & Upsell' },
]

export default function HeSinhThai() {
  const [activeTab, setActiveTab] = useState('branches')
  const [loading, setLoading] = useState(false)

  // Shared master data
  const [tables, setTables] = useState([])
  const [menu, setMenu] = useState([])
  const [ingredients, setIngredients] = useState([])

  // Tab 1: Multi-Branch HQ
  const [branches, setBranches] = useState([])
  const [consolidated, setConsolidated] = useState(null)
  const [regionalPrices, setRegionalPrices] = useState([])
  const [transfers, setTransfers] = useState([])
  const [newBranch, setNewBranch] = useState({
    maChiNhanh: '',
    tenChiNhanh: '',
    khuVucGia: 'HCM',
    diaChi: '',
    laKhoTong: false,
    tyLePhiNhuongQuyen: '5',
  })
  const [zonePush, setZonePush] = useState({
    khuVucGia: 'DA_NANG',
    maMon: '',
    kichThuoc: 'M',
    giaBan: '39000',
  })
  const [transferForm, setTransferForm] = useState({
    tuBranchId: '',
    denBranchId: '',
    maNL: '',
    soLuong: '5000',
    ghiChu: 'Điều chuyển nguyên liệu từ Kho tổng',
  })

  // Tab 2: QR & Aggregators
  const [qrLinksMap, setQrLinksMap] = useState({})
  const [aggData, setAggData] = useState({ summary: [], orders: [] })

  // Tab 3: CRM & ZNS
  const [crmData, setCrmData] = useState({ tierSummary: [], tongSoDuVi: 0, customers: [] })
  const [znsOutbox, setZnsOutbox] = useState([])
  const [znsProviderMode, setZnsProviderMode] = useState('mock')
  const [topupTarget, setTopupTarget] = useState(null)
  const [topupAmount, setTopupAmount] = useState('100000')

  // Tab Wave 4A: Price Books, Aggregator Settlements & House Accounts B2B
  const [priceBooks, setPriceBooks] = useState([])
  const [settlements, setSettlements] = useState([])
  const [houseAccounts, setHouseAccounts] = useState([])
  const [pbForm, setPbForm] = useState({ code: '', name: '', channel: 'GRABFOOD', priority: '20' })
  const [acctForm, setAcctForm] = useState({ accountCode: '', companyName: '', creditLimit: '5000000' })
  const [settleForm, setSettleForm] = useState({
    platform: 'GRABFOOD',
    periodFrom: getTodayISO(),
    periodTo: getTodayISO(),
    grossSales: '1000000',
    commissionRatePct: '25',
    netReceived: '750000',
  })

  // Tab 4: Horizontal F&B
  const [bakeryBatches, setBakeryBatches] = useState([])
  const [timeSessions, setTimeSessions] = useState([])
  const [newBatch, setNewBatch] = useState({
    maMon: '',
    soLuongSanXuat: '20',
    gioGiamGia: '19',
    phanTramGiam: '50',
  })

  // Tab 5: AI Demand Forecast & Upsell
  const [forecast, setForecast] = useState(null)
  const [upsells, setUpsells] = useState([])

  const loadMasterData = useCallback(async () => {
    const [bList, mList, nlList] = await Promise.all([
      banService.getAll().catch(() => []),
      sanPhamService.getMenu().catch(() => []),
      khoService.getNguyenLieu().catch(() => []),
    ])
    setTables(Array.isArray(bList) ? bList : [])
    setMenu(Array.isArray(mList) ? mList : [])
    setIngredients(Array.isArray(nlList) ? nlList : [])
  }, [])

  const loadTabData = useCallback(async (tabId) => {
    setLoading(true)
    try {
      if (tabId === 'branches') {
        const [brs, rep, prices, trs] = await Promise.all([
          ecosystemService.getBranches().catch(() => []),
          ecosystemService
            .getConsolidatedReport({ tuNgay: `${getTodayISO().slice(0, 8)}01`, denNgay: getTodayISO() })
            .catch(() => null),
          ecosystemService.getRegionalPrices().catch(() => []),
          ecosystemService.getTransfers().catch(() => []),
        ])
        setBranches(Array.isArray(brs) ? brs : [])
        setConsolidated(rep)
        setRegionalPrices(Array.isArray(prices) ? prices : [])
        setTransfers(Array.isArray(trs) ? trs : [])
      } else if (tabId === 'omnichannel') {
        const agg = await ecosystemService.getAggregatorOrders().catch(() => ({ summary: [], orders: [] }))
        setAggData({ summary: agg?.summary || [], orders: agg?.orders || [] })
      } else if (tabId === 'crm') {
        const [crm, znsRes] = await Promise.all([
          ecosystemService.getCrmCustomers().catch(() => ({ tierSummary: [], tongSoDuVi: 0, customers: [] })),
          axiosClient.get('/zns/outbox', { silent: true }).catch(() => ({ providerMode: 'mock', items: [] })),
        ])
        setCrmData(crm || { tierSummary: [], tongSoDuVi: 0, customers: [] })
        setZnsProviderMode(znsRes?.providerMode || 'mock')
        setZnsOutbox(Array.isArray(znsRes?.items) ? znsRes.items : [])
      } else if (tabId === 'chain_ops') {
        const [pbRes, stRes, haRes] = await Promise.all([
          axiosClient.get('/price-books', { silent: true }).then((r) => r?.priceBooks || []).catch(() => []),
          axiosClient.get('/finance/aggregator-settlements', { silent: true }).then((r) => r?.settlements || []).catch(() => []),
          axiosClient.get('/finance/house-accounts', { silent: true }).then((r) => r?.accounts || []).catch(() => []),
        ])
        setPriceBooks(pbRes)
        setSettlements(stRes)
        setHouseAccounts(haRes)
      } else if (tabId === 'horizontal') {
        const [batches, timers] = await Promise.all([
          ecosystemService.getBakeryBatches().catch(() => []),
          ecosystemService.getActiveTimeBilling().catch(() => []),
        ])
        setBakeryBatches(Array.isArray(batches) ? batches : [])
        setTimeSessions(Array.isArray(timers) ? timers : [])
      } else if (tabId === 'ai') {
        const [fc, up] = await Promise.all([
          ecosystemService.getAiDemandForecast().catch(() => null),
          ecosystemService.getSmartUpsell([]).catch(() => ({ suggestions: [] })),
        ])
        setForecast(fc)
        setUpsells(Array.isArray(up?.suggestions) ? up.suggestions : [])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      void loadMasterData()
    }, 0)
    return () => clearTimeout(t)
  }, [loadMasterData])

  useEffect(() => {
    const t = setTimeout(() => {
      void loadTabData(activeTab)
    }, 0)
    return () => clearTimeout(t)
  }, [activeTab, loadTabData])

  // Handlers Tab 1
  const handleCreateBranch = async (e) => {
    e.preventDefault()
    try {
      const res = await ecosystemService.createBranch({
        ...newBranch,
        tyLePhiNhuongQuyen: Number(newBranch.tyLePhiNhuongQuyen || 0),
      })
      toast.success(res.message)
      setNewBranch({ maChiNhanh: '', tenChiNhanh: '', khuVucGia: 'HCM', diaChi: '', laKhoTong: false, tyLePhiNhuongQuyen: '5' })
      await loadTabData('branches')
    } catch {
      // Interceptor
    }
  }

  const handlePushZonePrice = async (e) => {
    e.preventDefault()
    if (!zonePush.maMon) return toast.error('Hãy chọn món cần đẩy giá vùng!')
    try {
      const res = await ecosystemService.pushRegionalPrices({
        khuVucGia: zonePush.khuVucGia,
        items: [{ maMon: zonePush.maMon, kichThuoc: zonePush.kichThuoc, giaBan: Number(zonePush.giaBan) }],
      })
      toast.success(res.message)
      await loadTabData('branches')
    } catch {
      // Interceptor
    }
  }

  const handleCreateTransfer = async (e) => {
    e.preventDefault()
    if (!transferForm.tuBranchId || !transferForm.denBranchId || !transferForm.maNL) {
      return toast.error('Vui lòng chọn Chi nhánh xuất, Chi nhánh nhận và Nguyên liệu!')
    }
    try {
      const res = await ecosystemService.createTransfer({
        tuBranchId: transferForm.tuBranchId,
        denBranchId: transferForm.denBranchId,
        ghiChu: transferForm.ghiChu,
        items: [{ maNL: transferForm.maNL, soLuong: Number(transferForm.soLuong) }],
      })
      toast.success(res.message)
      await loadTabData('branches')
    } catch {
      // Interceptor
    }
  }

  // Handlers Tab 2
  const handleUpdateTableQr = async (maBan, opts) => {
    try {
      const res = await ecosystemService.rotateTableQr(maBan, opts)
      setQrLinksMap((prev) => ({ ...prev, [maBan]: res.tableQr }))
      toast.success(res.message)
      await loadMasterData()
    } catch {
      // Interceptor
    }
  }

  // Handlers Tab 3
  const handleWalletTopup = async (e) => {
    e.preventDefault()
    if (!topupTarget) return
    try {
      const res = await ecosystemService.walletTopup(topupTarget.maKH, {
        soTien: Number(topupAmount),
        loaiGD: 'TOPUP',
      })
      toast.success(res.message)
      setTopupTarget(null)
      await loadTabData('crm')
    } catch {
      // Interceptor
    }
  }

  const handleTriggerBirthday = async () => {
    try {
      const res = await ecosystemService.triggerBirthdayZns(30000)
      toast.success(res.message)
      await loadTabData('crm')
    } catch {
      // Interceptor
    }
  }

  const handleRunZnsWorker = async () => {
    try {
      const d = (await axiosClient.post('/zns/outbox/process', { limit: 30 })) || {}
      toast.success(`ZNS Worker (${d.mode || znsProviderMode}): gửi ${d.sent || 0}, bỏ qua chưa opt-in ${d.skippedNoConsent || 0}`)
      await loadTabData('crm')
    } catch {
      // Interceptor
    }
  }

  const handleCreatePriceBook = async (e) => {
    e.preventDefault()
    try {
      await axiosClient.post('/price-books', {
        code: pbForm.code,
        name: pbForm.name,
        channel: pbForm.channel,
        priority: Number(pbForm.priority || 10),
      })
      toast.success('Đã tạo bảng giá đa kênh!')
      setPbForm({ code: '', name: '', channel: 'GRABFOOD', priority: '20' })
      await loadTabData('chain_ops')
    } catch {
      // Interceptor
    }
  }

  const handleCreateHouseAccount = async (e) => {
    e.preventDefault()
    try {
      await axiosClient.post('/finance/house-accounts', {
        accountCode: acctForm.accountCode,
        companyName: acctForm.companyName,
        creditLimit: Number(acctForm.creditLimit || 0),
      })
      toast.success('Đã tạo tài khoản công nợ B2B!')
      setAcctForm({ accountCode: '', companyName: '', creditLimit: '5000000' })
      await loadTabData('chain_ops')
    } catch {
      // Interceptor
    }
  }

  const handleCreateSettlement = async (e) => {
    e.preventDefault()
    try {
      await axiosClient.post('/finance/aggregator-settlements', {
        platform: settleForm.platform,
        periodFrom: settleForm.periodFrom,
        periodTo: settleForm.periodTo,
        grossSales: Number(settleForm.grossSales || 0),
        commissionRatePct: Number(settleForm.commissionRatePct || 0),
        netReceived: Number(settleForm.netReceived || 0),
      })
      toast.success('Đã lưu kỳ đối soát sàn!')
      await loadTabData('chain_ops')
    } catch {
      // Interceptor
    }
  }

  // Handlers Tab 4
  const handleCreateBakeryBatch = async (e) => {
    e.preventDefault()
    if (!newBatch.maMon) return toast.error('Vui lòng chọn món bánh!')
    try {
      const res = await ecosystemService.createBakeryBatch({
        maMon: newBatch.maMon,
        soLuongSanXuat: Number(newBatch.soLuongSanXuat),
        gioGiamGia: Number(newBatch.gioGiamGia),
        phanTramGiam: Number(newBatch.phanTramGiam),
      })
      toast.success(res.message)
      await loadTabData('horizontal')
    } catch {
      // Interceptor
    }
  }

  return (
    <div className="space-y-5">
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-800">
            🚀 Hệ Sinh Thái Mở Rộng & Tăng Trưởng (Phân hệ 8)
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Đa chi nhánh & Nhượng quyền • QR Order Anti-Spam 3 lớp • CRM Phân hạng/Zalo ZNS • Grab/Shopee/Be • Bida/Bakery • AI Dự báo 60 ngày
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadTabData(activeTab)}
          disabled={loading}
          className="px-4 py-2 rounded-xl bg-stone-800 hover:bg-stone-900 text-white text-xs font-bold cursor-pointer"
        >
          {loading ? 'Đang tải...' : '↻ Làm mới'}
        </button>
      </div>

      {/* Navigation Tabs */}
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2.5 rounded-xl text-xs font-extrabold transition cursor-pointer ${
              activeTab === t.id
                ? 'bg-amber-700 text-white shadow'
                : 'bg-white border border-gray-200 text-gray-700 hover:bg-stone-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ================= TAB 1: MULTI-BRANCH & FRANCHISE HQ ================= */}
      {activeTab === 'branches' && (
        <div className="space-y-5">
          {consolidated && (
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div className="bg-white p-4 rounded-2xl border-l-4 border-amber-600 shadow-xs">
                <p className="text-[11px] font-bold text-gray-400 uppercase">Tổng Chi Nhánh</p>
                <p className="text-xl font-black text-gray-900 mt-1">{consolidated.tongSoChiNhanh} cơ sở</p>
              </div>
              <div className="bg-white p-4 rounded-2xl border-l-4 border-emerald-600 shadow-xs">
                <p className="text-[11px] font-bold text-gray-400 uppercase">Doanh Thu Gộp Chuỗi</p>
                <p className="text-xl font-black text-emerald-700 mt-1">{formatVND(consolidated.tongDoanhThuChuoi)}</p>
              </div>
              <div className="bg-white p-4 rounded-2xl border-l-4 border-blue-600 shadow-xs">
                <p className="text-[11px] font-bold text-gray-400 uppercase">Tổng Số Đơn</p>
                <p className="text-xl font-black text-blue-700 mt-1">{consolidated.tongSoDon} đơn</p>
              </div>
              <div className="bg-white p-4 rounded-2xl border-l-4 border-purple-600 shadow-xs">
                <p className="text-[11px] font-bold text-gray-400 uppercase">Phí Nhượng Quyền Tự Động</p>
                <p className="text-xl font-black text-purple-700 mt-1">{formatVND(consolidated.tongPhiNhuongQuyen)}</p>
              </div>
            </div>
          )}

          {/* Báo cáo hợp nhất + Tạo chi nhánh */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-7 bg-white p-5 rounded-2xl border border-gray-200 space-y-3">
              <h3 className="font-extrabold text-sm text-gray-800">
                🏢 Phân cấp Brand/HQ → Chi nhánh → Quầy Terminal & Phí Nhượng quyền
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-gray-50 text-gray-600 uppercase text-[10px]">
                    <tr>
                      <th className="p-2">Chi nhánh</th>
                      <th className="p-2">Vùng giá</th>
                      <th className="p-2 text-right">Doanh thu thuần</th>
                      <th className="p-2 text-right">Royalty %</th>
                      <th className="p-2 text-right">Phí bản quyền</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(consolidated?.branches || branches).map((b) => (
                      <tr key={b.branchId} className="hover:bg-gray-50">
                        <td className="p-2 font-bold text-gray-800">
                          {b.tenChiNhanh}
                          {b.laKhoTong && (
                            <span className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 text-[9px] font-extrabold">
                              KHO TỔNG
                            </span>
                          )}
                        </td>
                        <td className="p-2">
                          <span className="px-2 py-0.5 rounded-full bg-stone-100 font-bold text-[10px]">
                            {b.khuVucGia}
                          </span>
                        </td>
                        <td className="p-2 text-right font-bold text-emerald-700">
                          {formatVND(b.doanhThuThuan || 0)}
                        </td>
                        <td className="p-2 text-right">{b.tyLePhiNhuongQuyen || 0}%</td>
                        <td className="p-2 text-right font-black text-purple-700">
                          {formatVND(b.phiNhuongQuyen || 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <form onSubmit={handleCreateBranch} className="lg:col-span-5 bg-white p-5 rounded-2xl border border-gray-200 space-y-3 text-xs">
              <h3 className="font-extrabold text-sm text-gray-800">➕ Mở Chi nhánh Mới trong Chuỗi</h3>
              <div className="grid grid-cols-2 gap-2">
                <input
                  required
                  value={newBranch.maChiNhanh}
                  onChange={(e) => setNewBranch({ ...newBranch, maChiNhanh: e.target.value })}
                  placeholder="Mã CN (VD: CN02)"
                  className="px-3 py-2 border rounded-xl"
                />
                <input
                  required
                  value={newBranch.khuVucGia}
                  onChange={(e) => setNewBranch({ ...newBranch, khuVucGia: e.target.value })}
                  placeholder="Vùng giá (HCM / DA_NANG)"
                  className="px-3 py-2 border rounded-xl"
                />
              </div>
              <input
                required
                value={newBranch.tenChiNhanh}
                onChange={(e) => setNewBranch({ ...newBranch, tenChiNhanh: e.target.value })}
                placeholder="Tên chi nhánh (VD: Cơ sở 2 - Quận 1)"
                className="w-full px-3 py-2 border rounded-xl"
              />
              <div className="grid grid-cols-2 gap-2 items-center">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={newBranch.tyLePhiNhuongQuyen}
                  onChange={(e) => setNewBranch({ ...newBranch, tyLePhiNhuongQuyen: e.target.value })}
                  placeholder="% Phí nhượng quyền"
                  className="px-3 py-2 border rounded-xl"
                />
                <label className="flex items-center gap-2 font-semibold text-gray-700">
                  <input
                    type="checkbox"
                    checked={newBranch.laKhoTong}
                    onChange={(e) => setNewBranch({ ...newBranch, laKhoTong: e.target.checked })}
                  />
                  Đặt làm Kho Tổng
                </label>
              </div>
              <button
                type="submit"
                className="w-full py-2.5 rounded-xl bg-amber-700 hover:bg-amber-800 text-white font-extrabold cursor-pointer"
              >
                🏢 Khởi tạo Chi nhánh & Quầy POS
              </button>
            </form>
          </div>

          {/* Đẩy Menu theo Vùng giá & Điều chuyển Kho nội bộ */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="bg-white p-5 rounded-2xl border border-gray-200 space-y-3 text-xs">
              <h3 className="font-extrabold text-sm text-gray-800">
                🎯 Menu Tập Trung — Đẩy Giá Theo Vùng (VD: Đà Nẵng 39k / TP.HCM 45k)
              </h3>
              <form onSubmit={handlePushZonePrice} className="grid grid-cols-2 gap-2">
                <input
                  value={zonePush.khuVucGia}
                  onChange={(e) => setZonePush({ ...zonePush, khuVucGia: e.target.value })}
                  placeholder="Vùng giá (DA_NANG / HCM)"
                  className="px-3 py-2 border rounded-xl font-bold"
                />
                <select
                  value={zonePush.maMon}
                  onChange={(e) => setZonePush({ ...zonePush, maMon: e.target.value })}
                  className="px-3 py-2 border rounded-xl"
                >
                  <option value="">-- Chọn món --</option>
                  {menu.map((m) => (
                    <option key={m.maMon} value={m.maMon}>{m.tenMon}</option>
                  ))}
                </select>
                <select
                  value={zonePush.kichThuoc}
                  onChange={(e) => setZonePush({ ...zonePush, kichThuoc: e.target.value })}
                  className="px-3 py-2 border rounded-xl"
                >
                  <option value="S">Size S</option>
                  <option value="M">Size M</option>
                  <option value="L">Size L</option>
                </select>
                <input
                  type="number"
                  value={zonePush.giaBan}
                  onChange={(e) => setZonePush({ ...zonePush, giaBan: e.target.value })}
                  placeholder="Giá vùng (VNĐ)"
                  className="px-3 py-2 border rounded-xl font-bold"
                />
                <button
                  type="submit"
                  className="col-span-2 py-2.5 rounded-xl bg-sky-700 hover:bg-sky-800 text-white font-extrabold cursor-pointer"
                >
                  🚀 Đẩy giá đồng loạt xuống toàn bộ chi nhánh vùng {zonePush.khuVucGia}
                </button>
              </form>
              {regionalPrices.length > 0 && (
                <div className="max-h-40 overflow-y-auto divide-y border-t pt-2">
                  {regionalPrices.map((p) => (
                    <div key={p.id} className="py-1.5 flex justify-between">
                      <span>
                        <b className="text-sky-800">[{p.khuVucGia}]</b> {p.tenMon} ({p.kichThuoc})
                      </span>
                      <b className="text-amber-800">{formatVND(p.giaBan)}</b>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white p-5 rounded-2xl border border-gray-200 space-y-3 text-xs">
              <h3 className="font-extrabold text-sm text-gray-800">
                🚚 Kho Tổng & Điều Chuyển Nội Bộ Giữa Các Chi Nhánh
              </h3>
              <form onSubmit={handleCreateTransfer} className="grid grid-cols-2 gap-2">
                <select
                  value={transferForm.tuBranchId}
                  onChange={(e) => setTransferForm({ ...transferForm, tuBranchId: e.target.value })}
                  className="px-3 py-2 border rounded-xl"
                >
                  <option value="">-- Từ Kho / Chi nhánh --</option>
                  {branches.map((b) => (
                    <option key={b.branchId} value={b.branchId}>{b.tenChiNhanh}</option>
                  ))}
                </select>
                <select
                  value={transferForm.denBranchId}
                  onChange={(e) => setTransferForm({ ...transferForm, denBranchId: e.target.value })}
                  className="px-3 py-2 border rounded-xl"
                >
                  <option value="">-- Đến Chi nhánh --</option>
                  {branches.map((b) => (
                    <option key={b.branchId} value={b.branchId}>{b.tenChiNhanh}</option>
                  ))}
                </select>
                <select
                  value={transferForm.maNL}
                  onChange={(e) => setTransferForm({ ...transferForm, maNL: e.target.value })}
                  className="px-3 py-2 border rounded-xl"
                >
                  <option value="">-- Nguyên liệu (VD: Hạt Cà phê) --</option>
                  {ingredients.map((nl) => (
                    <option key={nl.maNL || nl.manl} value={nl.maNL || nl.manl}>
                      {nl.tenNL || nl.tennl} ({nl.donViTinh || nl.donvitinh})
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  value={transferForm.soLuong}
                  onChange={(e) => setTransferForm({ ...transferForm, soLuong: e.target.value })}
                  placeholder="Số lượng điều chuyển"
                  className="px-3 py-2 border rounded-xl font-bold"
                />
                <button
                  type="submit"
                  className="col-span-2 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-extrabold cursor-pointer"
                >
                  📦 Tạo Phiếu Điều Chuyển Kho
                </button>
              </form>
              <div className="max-h-44 overflow-y-auto divide-y border-t pt-2 space-y-1.5">
                {transfers.map((tr) => (
                  <div key={tr.maPhieu} className="pt-1.5 flex items-center justify-between gap-2">
                    <div>
                      <p className="font-bold">
                        #{tr.maPhieu}: {tr.tenTuChiNhanh} → {tr.tenDenChiNhanh}
                      </p>
                      <p className="text-[11px] text-gray-500">
                        {tr.chiTiet.map((c) => `${c.tenNL} (${c.soLuong} ${c.donViTinh})`).join(', ')}
                      </p>
                    </div>
                    {tr.trangThai === 'PENDING' ? (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const res = await ecosystemService.completeTransfer(tr.maPhieu)
                            toast.success(res.message)
                            await loadTabData('branches')
                          } catch {
                            // Interceptor
                          }
                        }}
                        className="px-3 py-1 rounded-lg bg-emerald-600 text-white font-bold cursor-pointer shrink-0"
                      >
                        ✓ Xác nhận nhận kho
                      </button>
                    ) : (
                      <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px]">
                        HOÀN TẤT
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================= TAB 2: QR ORDER & AGGREGATOR HUB ================= */}
      {activeTab === 'omnichannel' && (
        <div className="space-y-5">
          <div className="bg-white p-5 rounded-2xl border border-gray-200 space-y-3">
            <h3 className="font-extrabold text-sm text-gray-800">
              🛡️ Quản trị QR Order Tại Bàn — Chống Phá Hoại 3 Lớp (/m/:tenantSlug/:tableToken)
            </h3>
            <p className="text-xs text-gray-500">
              Lớp 1: Bàn phải mở hoặc duyệt 1 chạm trên POS • Lớp 2: Mã QR tự xoay sau mỗi lượt thanh toán • Lớp 3: Tùy chọn bắt buộc thanh toán VietQR trước.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {tables.map((b) => {
                const linkInfo = qrLinksMap[b.maBan]
                return (
                  <div key={b.maBan} className="p-3.5 rounded-2xl border bg-stone-50 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-black text-gray-900">🪑 {b.tenBan} ({b.khuVuc})</span>
                      <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-white border">
                        {linkInfo?.qrToken || b.qrToken || 'Chưa tạo'}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2 text-[11px]">
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(b.qrYeuCauMoBan)}
                          onChange={(e) =>
                            handleUpdateTableQr(b.maBan, {
                              rotateToken: false,
                              qrYeuCauMoBan: e.target.checked,
                            })
                          }
                        />
                        Yêu cầu mở bàn/duyệt POS
                      </label>
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(b.qrBatBuocVietQR)}
                          onChange={(e) =>
                            handleUpdateTableQr(b.maBan, {
                              rotateToken: false,
                              qrBatBuocVietQR: e.target.checked,
                            })
                          }
                        />
                        Bắt buộc VietQR trước
                      </label>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleUpdateTableQr(b.maBan, { rotateToken: true })}
                        className="flex-1 py-1.5 rounded-xl bg-amber-700 hover:bg-amber-800 text-white font-bold cursor-pointer"
                      >
                        🔄 Xoay & Lấy link QR
                      </button>
                      {linkInfo?.qrPath && (
                        <a
                          href={linkInfo.qrPath}
                          target="_blank"
                          rel="noreferrer"
                          className="px-3 py-1.5 rounded-xl bg-stone-800 text-white font-bold"
                        >
                          Mở ↗
                        </a>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-gray-200 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-extrabold text-sm text-gray-800">
                🛵 Aggregator Hub — Doanh thu &amp; Chiết khấu Sàn Giao Đồ Ăn{' '}
                <span className="ml-1.5 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-extrabold uppercase">
                  Beta / Demo Simulator
                </span>
              </h3>
              <div className="flex gap-2">
                {['GRABFOOD', 'SHOPEEFOOD', 'BEFOOD'].map((pf) => (
                  <button
                    key={pf}
                    type="button"
                    onClick={async () => {
                      const res = await ecosystemService.simulateAggregatorOrder(pf)
                      toast.success(res.message)
                      await loadTabData('omnichannel')
                    }}
                    className="px-3 py-1.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold cursor-pointer"
                  >
                    + Test đơn {pf}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {aggData.summary.map((s) => (
                <div key={s.nenTang} className="p-4 rounded-2xl bg-stone-50 border text-xs space-y-1">
                  <p className="font-black text-sm text-gray-900">{s.nenTang}</p>
                  <p>Số đơn: <b>{s.soDon}</b> • Tổng tiền hàng: <b>{formatVND(s.tongTienHang)}</b></p>
                  <p className="text-red-600">Chiết khấu sàn: -{formatVND(s.tongPhiSan)}</p>
                  <p className="text-emerald-700 font-black text-sm">Thực nhận: {formatVND(s.doanhThuThucNhan)}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ================= TAB 3: CRM TIERS, WALLET & ZALO ZNS ================= */}
      {activeTab === 'crm' && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {crmData.tierSummary.map((t) => (
              <div key={t.code} className="bg-white p-4 rounded-2xl border shadow-xs text-xs">
                <p className="font-black text-gray-800">{t.label} (Cashback {t.cashbackPct}%)</p>
                <p className="text-xl font-black text-amber-700 mt-1">{t.count} khách</p>
                <p className="text-[10px] text-gray-500">Mốc chi tiêu: {formatVND(t.minSpend)}</p>
              </div>
            ))}
            <div className="bg-emerald-50 p-4 rounded-2xl border border-emerald-200 text-xs">
              <p className="font-black text-emerald-900">Tổng Số Dư Ví Khách</p>
              <p className="text-xl font-black text-emerald-700 mt-1">{formatVND(crmData.tongSoDuVi || 0)}</p>
              <button
                type="button"
                onClick={handleTriggerBirthday}
                className="mt-2 px-3 py-1 rounded-lg bg-emerald-700 text-white font-bold cursor-pointer"
              >
                🎂 Gửi ZNS Sinh nhật
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-7 bg-white p-5 rounded-2xl border space-y-3">
              <h3 className="font-extrabold text-sm text-gray-800">👑 Danh sách Thành viên & Ví Trả Trước</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-gray-50 text-[10px] uppercase text-gray-600">
                    <tr>
                      <th className="p-2">Khách hàng</th>
                      <th className="p-2">Hạng</th>
                      <th className="p-2 text-right">Tổng chi tiêu</th>
                      <th className="p-2 text-right">Điểm</th>
                      <th className="p-2 text-right">Số dư Ví</th>
                      <th className="p-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {crmData.customers.map((c) => (
                      <tr key={c.maKH} className="hover:bg-gray-50">
                        <td className="p-2">
                          <p className="font-bold text-gray-900">{c.tenKH}</p>
                          <p className="text-[11px] text-gray-500">{c.soDienThoai}</p>
                        </td>
                        <td className="p-2 font-extrabold text-amber-800">{c.tenHang}</td>
                        <td className="p-2 text-right">{formatVND(c.tongChiTieu)}</td>
                        <td className="p-2 text-right font-bold">⭐ {c.diemTichLuy}</td>
                        <td className="p-2 text-right font-black text-emerald-700">{formatVND(c.soDuVi)}</td>
                        <td className="p-2 text-right">
                          <button
                            type="button"
                            onClick={() => setTopupTarget(c)}
                            className="px-2.5 py-1 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-900 font-bold cursor-pointer"
                          >
                            + Nạp ví
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="lg:col-span-5 bg-white p-5 rounded-2xl border space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <h3 className="font-extrabold text-sm text-gray-800">
                  💬 Hàng đợi Zalo ZNS Worker{' '}
                  <span className="ml-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-extrabold uppercase">
                    Outbox Worker ({znsProviderMode}) • NĐ 13/2023
                  </span>
                </h3>
                <button
                  type="button"
                  onClick={handleRunZnsWorker}
                  className="px-2.5 py-1 rounded-lg bg-sky-700 hover:bg-sky-800 text-white text-[11px] font-bold cursor-pointer"
                >
                  ▶ Chạy Worker
                </button>
              </div>
              <div className="space-y-2 max-h-80 overflow-y-auto text-xs">
                {znsOutbox.length === 0 ? (
                  <p className="text-gray-400 text-center py-6">
                    Tin nhắn cảm ơn sau mua hàng, thăng hạng &amp; sinh nhật (tuân thủ đồng thuận NĐ 13/2023) sẽ xuất hiện tại đây!
                  </p>
                ) : (
                  znsOutbox.map((z) => (
                    <div key={z.id} className="p-3 rounded-xl bg-sky-50 border border-sky-200 space-y-1">
                      <div className="flex justify-between font-bold text-sky-950">
                        <span>[{z.purpose || z.loaiTin}] {z.phone || z.soDienThoai}</span>
                        <span className="text-[10px] text-sky-700">{z.status || z.trangThai}</span>
                      </div>
                      <p className="text-[11px] text-gray-700">{z.noiDung?.tinNhan}</p>
                      <p className="text-[10px] text-gray-400">{formatDateTime(z.thoiGianTao)}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {topupTarget && (
            <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
              <form onSubmit={handleWalletTopup} className="bg-white rounded-2xl max-w-sm w-full p-5 space-y-3 text-xs shadow-2xl">
                <h3 className="font-black text-base text-gray-900">💰 Nạp Ví Trả Trước — {topupTarget.tenKH}</h3>
                <input
                  type="number"
                  min={10000}
                  step={10000}
                  value={topupAmount}
                  onChange={(e) => setTopupAmount(e.target.value)}
                  className="w-full px-3 py-2.5 border rounded-xl font-black text-sm"
                />
                <div className="flex gap-2">
                  <button type="button" onClick={() => setTopupTarget(null)} className="flex-1 py-2 border rounded-xl font-bold">
                    Hủy
                  </button>
                  <button type="submit" className="flex-1 py-2 bg-emerald-600 text-white rounded-xl font-extrabold cursor-pointer">
                    Xác nhận nạp
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}

      {/* ================= TAB 4: HORIZONTAL F&B (BAKERY 19H & TIME BILLING) ================= */}
      {activeTab === 'horizontal' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="bg-white p-5 rounded-2xl border space-y-3 text-xs">
            <h3 className="font-extrabold text-sm text-gray-800">
              🥐 Quản lý Lô Bánh Trong Ngày — Tự động Giảm 50% sau 19h
            </h3>
            <form onSubmit={handleCreateBakeryBatch} className="grid grid-cols-2 gap-2">
              <select
                value={newBatch.maMon}
                onChange={(e) => setNewBatch({ ...newBatch, maMon: e.target.value })}
                className="col-span-2 px-3 py-2 border rounded-xl"
              >
                <option value="">-- Chọn món bánh --</option>
                {menu.map((m) => (
                  <option key={m.maMon} value={m.maMon}>{m.tenMon}</option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                value={newBatch.soLuongSanXuat}
                onChange={(e) => setNewBatch({ ...newBatch, soLuongSanXuat: e.target.value })}
                placeholder="SL nướng hôm nay"
                className="px-3 py-2 border rounded-xl"
              />
              <div className="flex gap-1.5">
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={newBatch.gioGiamGia}
                  onChange={(e) => setNewBatch({ ...newBatch, gioGiamGia: e.target.value })}
                  placeholder="Giờ giảm (19)"
                  className="w-1/2 px-2 py-2 border rounded-xl"
                />
                <input
                  type="number"
                  min={5}
                  max={90}
                  value={newBatch.phanTramGiam}
                  onChange={(e) => setNewBatch({ ...newBatch, phanTramGiam: e.target.value })}
                  placeholder="% giảm (50)"
                  className="w-1/2 px-2 py-2 border rounded-xl"
                />
              </div>
              <button
                type="submit"
                className="col-span-2 py-2.5 rounded-xl bg-amber-700 hover:bg-amber-800 text-white font-extrabold cursor-pointer"
              >
                ➕ Nhập Lô Bánh Hôm Nay
              </button>
            </form>

            <div className="space-y-2 pt-2 border-t">
              {bakeryBatches.map((b) => (
                <div key={b.maLo} className="p-3 rounded-xl bg-amber-50/70 border border-amber-200 flex justify-between items-center">
                  <div>
                    <p className="font-black text-gray-900">{b.tenMon}</p>
                    <p className="text-[11px] text-gray-600">
                      Còn <b>{b.soLuongConLai}/{b.soLuongSanXuat}</b> • Tự giảm <b>{b.phanTramGiam || 50}%</b> sau <b>{b.gioGiamGia}h</b>
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`font-black ${b.dangGiamGia ? 'text-red-600' : 'text-gray-800'}`}>
                      {formatVND(b.giaHienTai)}
                    </p>
                    {b.dangGiamGia && (
                      <span className="px-1.5 py-0.5 rounded bg-red-600 text-white text-[9px] font-black">
                        ĐANG FLASH SALE
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white p-5 rounded-2xl border space-y-3 text-xs">
            <h3 className="font-extrabold text-sm text-gray-800">
              🎱 Phiên Tính Giờ Theo Khung Giờ (Bida / Boardgame / Co-working)
            </h3>
            <p className="text-gray-500">
              Thu ngân có thể bấm giờ trực tiếp từ nút <b>🌐 QR/Sàn/Giờ</b> trên màn hình POS. Hệ thống tự cộng phụ thu khung giờ cao điểm (18h–23h) vào hóa đơn bàn!
            </p>
            <div className="space-y-2">
              {timeSessions.length === 0 ? (
                <p className="text-gray-400 text-center py-8">Chưa có phiên tính giờ nào.</p>
              ) : (
                timeSessions.map((s) => (
                  <div key={s.maPhien} className="p-3 rounded-xl border bg-indigo-50/50 flex justify-between items-center">
                    <div>
                      <p className="font-black text-indigo-950">{s.tenBan} • {s.tenDichVu}</p>
                      <p className="text-[11px] text-gray-600">
                        {s.soPhutSuDung} phút • {formatVND(s.donGiaTheoGio)}/h • Trạng thái: <b>{s.trangThai}</b>
                      </p>
                    </div>
                    <span className="text-sm font-black text-indigo-700">{formatVND(s.tongTienGio)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================= TAB WAVE 4A: PRICE BOOKS, ĐỐI SOÁT SÀN & CÔNG NỢ B2B ================= */}
      {activeTab === 'chain_ops' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Price Books */}
          <div className="bg-white p-5 rounded-2xl border space-y-3">
            <h3 className="font-extrabold text-sm text-gray-800">🏷️ Bảng Giá Đa Kênh (Price Books)</h3>
            <form onSubmit={handleCreatePriceBook} className="space-y-2 text-xs">
              <input
                required
                value={pbForm.code}
                onChange={(e) => setPbForm({ ...pbForm, code: e.target.value })}
                placeholder="Mã bảng giá (VD: GRAB_Q1)"
                className="w-full px-3 py-2 rounded-xl border border-gray-300"
              />
              <input
                required
                value={pbForm.name}
                onChange={(e) => setPbForm({ ...pbForm, name: e.target.value })}
                placeholder="Tên bảng giá"
                className="w-full px-3 py-2 rounded-xl border border-gray-300"
              />
              <div className="flex gap-2">
                <select
                  value={pbForm.channel}
                  onChange={(e) => setPbForm({ ...pbForm, channel: e.target.value })}
                  className="flex-1 px-3 py-2 rounded-xl border border-gray-300"
                >
                  <option value="GRABFOOD">GRABFOOD</option>
                  <option value="SHOPEEFOOD">SHOPEEFOOD</option>
                  <option value="BEFOOD">BEFOOD</option>
                  <option value="DINE_IN">DINE_IN</option>
                  <option value="TAKEAWAY">TAKEAWAY</option>
                  <option value="VIP">VIP</option>
                </select>
                <input
                  type="number"
                  value={pbForm.priority}
                  onChange={(e) => setPbForm({ ...pbForm, priority: e.target.value })}
                  placeholder="Ưu tiên"
                  className="w-24 px-3 py-2 rounded-xl border border-gray-300"
                />
              </div>
              <button
                type="submit"
                className="w-full py-2 rounded-xl bg-amber-700 hover:bg-amber-800 text-white font-bold cursor-pointer"
              >
                + Tạo Price Book
              </button>
            </form>
            <div className="space-y-1.5 max-h-60 overflow-y-auto text-xs">
              {priceBooks.map((pb) => (
                <div key={pb.id} className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 flex justify-between">
                  <div>
                    <p className="font-bold text-amber-950">{pb.code} • {pb.name}</p>
                    <p className="text-[10px] text-amber-700">{pb.channel} • Ưu tiên {pb.priority}</p>
                  </div>
                  <span className="text-[10px] font-bold text-amber-900">{(pb.items || []).length} món</span>
                </div>
              ))}
            </div>
          </div>

          {/* Aggregator Settlements */}
          <div className="bg-white p-5 rounded-2xl border space-y-3">
            <h3 className="font-extrabold text-sm text-gray-800">🛵 Đối Soát Sàn Giao Đồ Ăn</h3>
            <form onSubmit={handleCreateSettlement} className="space-y-2 text-xs">
              <select
                value={settleForm.platform}
                onChange={(e) => setSettleForm({ ...settleForm, platform: e.target.value })}
                className="w-full px-3 py-2 rounded-xl border border-gray-300"
              >
                <option value="GRABFOOD">GRABFOOD</option>
                <option value="SHOPEEFOOD">SHOPEEFOOD</option>
                <option value="BEFOOD">BEFOOD</option>
                <option value="XANHSM">XANHSM</option>
              </select>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  value={settleForm.grossSales}
                  onChange={(e) => setSettleForm({ ...settleForm, grossSales: e.target.value })}
                  placeholder="Doanh thu gộp"
                  className="px-3 py-2 rounded-xl border border-gray-300"
                />
                <input
                  type="number"
                  value={settleForm.commissionRatePct}
                  onChange={(e) => setSettleForm({ ...settleForm, commissionRatePct: e.target.value })}
                  placeholder="% Chiết khấu"
                  className="px-3 py-2 rounded-xl border border-gray-300"
                />
              </div>
              <input
                type="number"
                value={settleForm.netReceived}
                onChange={(e) => setSettleForm({ ...settleForm, netReceived: e.target.value })}
                placeholder="Thực nhận từ sàn (VNĐ)"
                className="w-full px-3 py-2 rounded-xl border border-gray-300"
              />
              <button
                type="submit"
                className="w-full py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold cursor-pointer"
              >
                + Lưu kỳ đối soát
              </button>
            </form>
            <div className="space-y-1.5 max-h-60 overflow-y-auto text-xs">
              {settlements.map((s) => (
                <div key={s.id} className="p-2.5 rounded-xl bg-stone-50 border flex justify-between">
                  <div>
                    <p className="font-bold text-gray-900">{s.platform} ({s.status})</p>
                    <p className="text-[10px] text-gray-500">
                      Kỳ vọng: {formatVND(s.net_expected)} • Thực nhận: {formatVND(s.net_received)}
                    </p>
                  </div>
                  <span className={`font-bold ${Number(s.variance_amount) === 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                    {formatVND(s.variance_amount)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* House Accounts B2B */}
          <div className="bg-white p-5 rounded-2xl border space-y-3">
            <h3 className="font-extrabold text-sm text-gray-800">🏢 Công Nợ Doanh Nghiệp (B2B)</h3>
            <form onSubmit={handleCreateHouseAccount} className="space-y-2 text-xs">
              <input
                required
                value={acctForm.accountCode}
                onChange={(e) => setAcctForm({ ...acctForm, accountCode: e.target.value })}
                placeholder="Mã KH B2B (VD: CORP01)"
                className="w-full px-3 py-2 rounded-xl border border-gray-300"
              />
              <input
                required
                value={acctForm.companyName}
                onChange={(e) => setAcctForm({ ...acctForm, companyName: e.target.value })}
                placeholder="Tên công ty / đối tác"
                className="w-full px-3 py-2 rounded-xl border border-gray-300"
              />
              <input
                type="number"
                value={acctForm.creditLimit}
                onChange={(e) => setAcctForm({ ...acctForm, creditLimit: e.target.value })}
                placeholder="Hạn mức công nợ (VNĐ)"
                className="w-full px-3 py-2 rounded-xl border border-gray-300"
              />
              <button
                type="submit"
                className="w-full py-2 rounded-xl bg-sky-700 hover:bg-sky-800 text-white font-bold cursor-pointer"
              >
                + Tạo tài khoản B2B
              </button>
            </form>
            <div className="space-y-1.5 max-h-60 overflow-y-auto text-xs">
              {houseAccounts.map((a) => (
                <div key={a.id} className="p-2.5 rounded-xl bg-sky-50 border border-sky-200 flex justify-between">
                  <div>
                    <p className="font-bold text-sky-950">{a.account_code} • {a.company_name}</p>
                    <p className="text-[10px] text-sky-700">Hạn mức: {formatVND(a.credit_limit)}</p>
                  </div>
                  <span className="font-black text-sky-900">Nợ: {formatVND(a.current_balance)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ================= TAB 5: AI DEMAND FORECAST & SMART UPSELL ================= */}
      {activeTab === 'ai' && (
        <div className="space-y-5">
          {forecast && (
            <div className="bg-white p-5 rounded-2xl border space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-extrabold text-base text-gray-800">
                    🤖 AI Demand Forecasting — Đề Xuất Nhập Kho Sáng Mai ({forecast.thuNgayMai}, {forecast.ngayDuBao})
                  </h3>
                  <p className="text-xs text-gray-500">
                    Mô hình kết hợp lịch sử tiêu hao 60 ngày + hệ số Thứ trong tuần + xu hướng 14 ngày gần nhất + tồn kho thực tế.
                  </p>
                </div>
                <div className="text-right text-xs bg-amber-50 border border-amber-200 px-4 py-2 rounded-xl">
                  <p className="text-gray-500">Ngân sách nhập sáng mai ({forecast.soNguyenLieuCanNhap} mã cần nhập)</p>
                  <p className="text-lg font-black text-amber-800">{formatVND(forecast.tongChiPhiNhapDuKien)}</p>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-gray-50 text-[10px] uppercase text-gray-600">
                    <tr>
                      <th className="p-2.5">Nguyên liệu</th>
                      <th className="p-2.5 text-right">Tồn hiện tại</th>
                      <th className="p-2.5 text-right">TB 60 ngày</th>
                      <th className="p-2.5 text-right">Hệ số {forecast.thuNgayMai}</th>
                      <th className="p-2.5 text-right">Dự báo mai</th>
                      <th className="p-2.5 text-right">Đề xuất nhập</th>
                      <th className="p-2.5 text-right">Chi phí dự kiến</th>
                      <th className="p-2.5 text-center">Mức độ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {forecast.danhSach.map((r) => (
                      <tr key={r.maNL} className="hover:bg-gray-50">
                        <td className="p-2.5 font-bold text-gray-900">
                          {r.tenNL} <span className="text-gray-400">({r.donViTinh})</span>
                        </td>
                        <td className="p-2.5 text-right">{r.tonHienTai}</td>
                        <td className="p-2.5 text-right text-gray-500">{r.trungBinh60Ngay}</td>
                        <td className="p-2.5 text-right font-bold text-sky-700">x{r.heSoThu}</td>
                        <td className="p-2.5 text-right font-bold">{r.duBaoNgayMai}</td>
                        <td className="p-2.5 text-right font-black text-amber-800">
                          {r.goiYNhapSangMai > 0 ? `+${r.goiYNhapSangMai} ${r.donViTinh}` : 'Đủ dùng'}
                        </td>
                        <td className="p-2.5 text-right font-bold text-emerald-700">
                          {r.chiPhiDuKien > 0 ? formatVND(r.chiPhiDuKien) : '—'}
                        </td>
                        <td className="p-2.5 text-center">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${
                              r.mucDoKhanCap === 'HIGH'
                                ? 'bg-red-100 text-red-700'
                                : r.mucDoKhanCap === 'MEDIUM'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-emerald-100 text-emerald-700'
                            }`}
                          >
                            {r.mucDoKhanCap === 'HIGH' ? 'NHẬP GẤP' : r.mucDoKhanCap === 'MEDIUM' ? 'NÊN NHẬP' : 'AN TOÀN'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="bg-white p-5 rounded-2xl border space-y-3">
            <h3 className="font-extrabold text-sm text-gray-800">
              ✨ Thẻ Gợi Ý Bán Kèm (Smart Upsell) Đang Hiển Thị Trên POS & QR Menu
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {upsells.map((u) => (
                <div key={u.maMon} className="p-3.5 rounded-2xl bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-300 text-xs space-y-1">
                  <p className="font-black text-amber-950">{u.badgeText}</p>
                  <p className="text-[11px] text-amber-800">{u.lyDo}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
