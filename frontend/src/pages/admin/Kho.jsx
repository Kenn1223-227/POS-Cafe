import { useState, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'
import { khoService } from '../../services/khoService'
import { useAuthStore } from '../../store/authStore'
import { useBarcodeScanner } from '../../hooks/useBarcodeScanner'
import FeatureLockedCard from '../../components/FeatureLockedCard'
import { hasFeatureFlag } from '../../utils/featureFlags'
import { formatVND, formatNumber, getTodayISO } from '../../utils/format'
import axiosClient from '../../api/axiosClient'

const WASTAGE_OPTIONS = [
  { code: 'BARISTA_SPILL', label: 'Đổ vỡ / đánh sữa hỏng trong quầy' },
  { code: 'MACHINE_CALIBRATION', label: 'Hiệu chỉnh cối xay / test shot đầu ca' },
  { code: 'EXPIRED_BATCH', label: 'Hủy bán thành phẩm / nguyên liệu quá HSD' },
  { code: 'CUSTOMER_REMAKE', label: 'Pha lại do khách phàn nàn / đổi món' },
  { code: 'DAMAGED_DELIVERY', label: 'Hỏng vận chuyển / lỗi nhà cung cấp' },
  { code: 'STAFF_DRINK', label: 'Đồ uống nội bộ nhân viên trong ca' },
]

export default function Kho() {
  const { user } = useAuthStore()
  const allowInventoryBom = hasFeatureFlag(user, 'inventory_bom')
  const isManager = Number(user?.vaiTro) === 1
  const [nguyenLieuList, setNguyenLieuList] = useState([])
  const [canhBaoList, setCanhBaoList] = useState([])
  const [canDoiList, setCanDoiList] = useState([])
  const [quyDoiList, setQuyDoiList] = useState([])
  const [loTonKho, setLoTonKho] = useState([])
  const [expiringLots, setExpiringLots] = useState([])
  const [periodLocks, setPeriodLocks] = useState([])
  const [shiftAvt, setShiftAvt] = useState(null)

  const [tuNgay, setTuNgay] = useState(() => getTodayISO().slice(0, 8) + '01')
  const [denNgay, setDenNgay] = useState(() => getTodayISO())

  const [mode, setMode] = useState('NHAP') // 'NHAP' | 'HUY' | 'KIEMKE'
  const [ghiChu, setGhiChu] = useState('')
  const [chiPhiVanChuyen, setChiPhiVanChuyen] = useState('')
  const [giamGiaNCC, setGiamGiaNCC] = useState('')
  const [ngayChungTu, setNgayChungTu] = useState(() => getTodayISO())
  const [maLyDoHuy, setMaLyDoHuy] = useState('BARISTA_SPILL')
  const [priceSpikeAlerts, setPriceSpikeAlerts] = useState([])
  const [blindSession, setBlindSession] = useState(null) // { sessionId, thoiDiemBatDau, recountItems }
  const [items, setItems] = useState([
    { maNL: '', soLuong: '', donGiaNhap: '', donViNhap: '', heSoQuyDoi: 1, hanSuDung: '', compoundQtys: {}, tinhTrang: 'Tốt' },
  ])
  const [submitting, setSubmitting] = useState(false)

  // Modal tạo nguyên liệu mới & Modal Quy đổi Đơn vị tính (Thùng -> Hộp -> ml/g + Mã vạch)
  const [showAddNL, setShowAddNL] = useState(false)
  const [newNL, setNewNL] = useState({ maNL: '', tenNL: '', donViTinh: 'ml', hanMucCanhBao: 500, giaVonDonVi: 0 })
  const [showUomModal, setShowUomModal] = useState(false)
  const [uomForm, setUomForm] = useState({ maNL: '', tenDonVi: 'Thùng', heSoQuyDoi: 12000, maVachDonVi: '' })

  // Bán thành phẩm / Sơ chế mẻ linh hoạt (Flexible soMe + Yield % thực thu)
  const [banThanhPhamList, setBanThanhPhamList] = useState([])
  const [showSubRecipeModal, setShowSubRecipeModal] = useState(false)
  const [subRecipeForm, setSubRecipeForm] = useState({
    maNLThanhPham: '',
    sanLuongMeMacDinh: 2000,
    hanSuDungGio: 4,
    dinhMuc: [{ maNLThanhPhan: '', khoiLuongTieuHao: 500 }],
  })
  const [producingNL, setProducingNL] = useState(null)
  const [batchDraftByNL, setBatchDraftByNL] = useState({})
  const [lockDateInput, setLockDateInput] = useState(() => getTodayISO())

  // [Wave 3B — P1-02] Vật tư Đóng gói theo Kênh (cauhinh_vattu_mangdi: /api/kho/vattu-mangdi)
  const [packagingRules, setPackagingRules] = useState([])
  const [packagingForm, setPackagingForm] = useState({
    loaiDonHang: 'MANG_DI',
    kichThuoc: 'ALL',
    maNL: '',
    soLuongMoiLy: 1,
  })
  const [savingPackaging, setSavingPackaging] = useState(false)

  const loadPackagingRules = useCallback(async () => {
    try {
      const res = await axiosClient.get('/kho/vattu-mangdi', { silent: true })
      setPackagingRules(Array.isArray(res?.danhSach) ? res.danhSach : Array.isArray(res) ? res : [])
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    void loadPackagingRules()
  }, [loadPackagingRules])

  const handleSavePackagingRule = async (e) => {
    e.preventDefault()
    if (!packagingForm.maNL) {
      toast.error('Vui lòng chọn vật tư/bao bì (ly nhựa, nắp, ống hút, túi...)!')
      return
    }
    setSavingPackaging(true)
    try {
      await axiosClient.post('/kho/vattu-mangdi', {
        loaiDonHang: packagingForm.loaiDonHang,
        kichThuoc: packagingForm.kichThuoc,
        maNL: packagingForm.maNL,
        soLuongMoiLy: Number(packagingForm.soLuongMoiLy || 1),
      })
      toast.success('📦 Đã lưu định mức vật tư đóng gói theo kênh!')
      await loadPackagingRules()
    } catch {
      // Interceptor xử lý
    } finally {
      setSavingPackaging(false)
    }
  }
  const [autoPoOrders, setAutoPoOrders] = useState([])

  const loadKhoData = useCallback(async () => {
    try {
      const [nlAll, cb, cd, qd, btp, lotsRes, locksRes, avtRes] = await Promise.all([
        khoService.getAllNguyenLieu(),
        khoService.canhBao(),
        khoService.canDoi(tuNgay, denNgay),
        khoService.getQuyDoi().catch(() => []),
        khoService.getBanThanhPham().catch(() => []),
        khoService.getLoTonKho({ onlyActive: true }).catch(() => ({ lots: [], expiringAlerts: [] })),
        isManager ? khoService.getPeriodLocks().catch(() => []) : Promise.resolve([]),
        isManager ? khoService.getShiftAvt({ dispatchAlerts: false }).catch(() => null) : Promise.resolve(null),
      ])
      setNguyenLieuList(nlAll)
      setCanhBaoList(cb)
      setCanDoiList(cd)
      setQuyDoiList(Array.isArray(qd) ? qd : [])
      setBanThanhPhamList(Array.isArray(btp) ? btp : [])
      setLoTonKho(Array.isArray(lotsRes?.lots) ? lotsRes.lots : [])
      setExpiringLots(Array.isArray(lotsRes?.expiringAlerts) ? lotsRes.expiringAlerts : [])
      setPeriodLocks(Array.isArray(locksRes) ? locksRes : [])
      setShiftAvt(avtRes)

      if (nlAll.length > 0) {
        setItems((prev) =>
          prev.map((row, idx) => (idx === 0 && !row.maNL ? { ...row, maNL: nlAll[0].maNL } : row))
        )
        setUomForm((prev) => (prev.maNL ? prev : { ...prev, maNL: nlAll[0].maNL }))
        setSubRecipeForm((prev) =>
          prev.maNLThanhPham
            ? prev
            : {
                ...prev,
                maNLThanhPham: nlAll[0].maNL,
                dinhMuc: [{ maNLThanhPhan: nlAll[1]?.maNL || nlAll[0].maNL, khoiLuongTieuHao: 500 }],
              }
        )
      }
    } catch {
      // Interceptor xử lý
    }
  }, [tuNgay, denNgay, isManager])

  // Tích hợp súng quét mã vạch (Barcode Scanner) tự động nhận MaNL + đơn vị Thùng/Hộp và cộng +1!
  useBarcodeScanner({
    enabled: !showAddNL && !showUomModal && !showSubRecipeModal,
    onScan: async (code) => {
      try {
        const hit = await khoService.lookupBarcode(code)
        if (!hit?.maNL) return
        setItems((prev) => {
          const idx = prev.findIndex(
            (r) => r.maNL === hit.maNL && Number(r.heSoQuyDoi || 1) === Number(hit.heSoQuyDoi)
          )
          if (idx >= 0) {
            return prev.map((r, i) =>
              i === idx ? { ...r, soLuong: String(Number(r.soLuong || 0) + 1) } : r
            )
          }
          return [
            ...prev.filter((r) => r.maNL && r.soLuong !== ''),
            {
              maNL: hit.maNL,
              soLuong: '1',
              donGiaNhap: '',
              donViNhap: hit.tenDonVi,
              heSoQuyDoi: Number(hit.heSoQuyDoi),
              hanSuDung: '',
              compoundQtys: {},
              tinhTrang: mode === 'HUY' ? 'Hủy do hư hỏng' : 'Tốt',
            },
          ]
        })
        toast.success(`🔫 Quét thành công: +1 ${hit.tenDonVi} ${hit.tenNL} (×${formatNumber(hit.heSoQuyDoi)} ${hit.donViGoc})`)
      } catch {
        toast.error(`Không nhận diện được mã vạch kho: ${code}`)
      }
    },
  })

  useEffect(() => {
    const t = setTimeout(() => {
      void loadKhoData()
    }, 0)
    return () => clearTimeout(t)
  }, [loadKhoData])

  const handleChangeMode = (nextMode) => {
    setMode(nextMode)
    setItems((prev) =>
      prev.map((r) => ({
        ...r,
        tinhTrang: nextMode === 'HUY' ? 'Hủy do hư hỏng' : 'Tốt',
      }))
    )
  }

  const handleAddRow = () => {
    setItems((prev) => [
      ...prev,
      {
        maNL: nguyenLieuList[0]?.maNL || '',
        soLuong: '',
        donGiaNhap: '',
        donViNhap: '',
        heSoQuyDoi: 1,
        tinhTrang: mode === 'HUY' ? 'Hủy do hư hỏng' : 'Tốt',
      },
    ])
  }

  const handleChangeRow = (idx, field, value) => {
    setItems((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r
        if (field === 'maNL') {
          return { ...r, maNL: value, donViNhap: '', heSoQuyDoi: 1 }
        }
        return { ...r, [field]: value }
      })
    )
  }

  const handleChangeRowUnit = (idx, unitKey, nl) => {
    if (!unitKey || unitKey === '__BASE__') {
      setItems((prev) =>
        prev.map((r, i) => (i === idx ? { ...r, donViNhap: nl?.donViTinh || '', heSoQuyDoi: 1 } : r))
      )
      return
    }
    const found = quyDoiList.find((q) => String(q.id) === String(unitKey))
    if (!found) return
    setItems((prev) =>
      prev.map((r, i) =>
        i === idx ? { ...r, donViNhap: found.tenDonVi, heSoQuyDoi: Number(found.heSoQuyDoi) } : r
      )
    )
  }

  const handleSaveUom = async (e) => {
    e.preventDefault()
    try {
      const res = await khoService.saveQuyDoi({
        maNL: uomForm.maNL,
        tenDonVi: uomForm.tenDonVi,
        heSoQuyDoi: Number(uomForm.heSoQuyDoi),
        maVachDonVi: uomForm.maVachDonVi?.trim() || null,
      })
      toast.success(res.message)
      setUomForm((prev) => ({ ...prev, maVachDonVi: '' }))
      await loadKhoData()
    } catch {
      // Interceptor xử lý
    }
  }

  const handleDeleteUom = async (id) => {
    try {
      await khoService.deleteQuyDoi(id)
      toast.success('Đã xóa đơn vị quy đổi')
      await loadKhoData()
    } catch {
      // Interceptor xử lý
    }
  }

  const handleRemoveRow = (idx) => {
    if (items.length <= 1) return
    setItems((prev) => prev.filter((_, i) => i !== idx))
  }

  // [Phân hệ 4] Kiểm kho mù 60 giây cuối ca (Start phiên -> ghi mốc thời gian bù trừ bán hàng giữa chừng!)
  const handleLoadQuick60sStocktake = async () => {
    setMode('KIEMKE')
    try {
      const session = await khoService.startBlindStocktake({ keyOnly: true, forceBlind: true })
      const targetList = session.items || []
      if (targetList.length === 0) {
        toast.error('Chưa có nguyên liệu nào trong kho!')
        return
      }
      setBlindSession({
        sessionId: session.sessionId,
        thoiDiemBatDau: session.thoiDiemBatDau,
        recountItems: null,
      })
      setGhiChu('Kiểm kho mù 60s cuối ca (Tự động bù trừ bán hàng giữa chừng)')
      setItems(
        targetList.map((n) => ({
          maNL: n.maNL,
          soLuong: '',
          donGiaNhap: '',
          donViNhap: '',
          heSoQuyDoi: 1,
          hanSuDung: '',
          compoundQtys: {},
          tinhTrang: 'Kiểm kho mù 60s',
        }))
      )
      toast.success(`🕵️ Đã mở phiên kiểm kho mù #${session.sessionId} (${targetList.length} Key Items)!`)
    } catch {
      const keyItems = nguyenLieuList.filter((n) => n.isKeyItem)
      const targetList = keyItems.length > 0 ? keyItems : nguyenLieuList.slice(0, 6)
      setItems(
        targetList.map((n) => ({
          maNL: n.maNL,
          soLuong: '',
          donGiaNhap: '',
          donViNhap: '',
          heSoQuyDoi: 1,
          hanSuDung: '',
          compoundQtys: {},
          tinhTrang: 'Kiểm kho mù 60s',
        }))
      )
    }
  }

  const handleChangeCompoundUnit = (idx, unitKey, qtyVal, uomsForRow) => {
    setItems((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r
        const nextMap = { ...(r.compoundQtys || {}), [unitKey]: qtyVal }
        let totalBase = Number(nextMap.__BASE__ || 0)
        for (const u of uomsForRow) {
          totalBase += Number(nextMap[String(u.id)] || 0) * Number(u.heSoQuyDoi || 1)
        }
        return {
          ...r,
          compoundQtys: nextMap,
          soLuong: totalBase > 0 || Object.values(nextMap).some((v) => v !== '') ? String(Math.round(totalBase * 1000) / 1000) : '',
          heSoQuyDoi: 1,
          donViNhap: '',
        }
      })
    )
  }

  const handleDisposeLot = async (lot) => {
    try {
      const res = await khoService.disposeLoTonKho(lot.id, { ghiChu: `Hủy mẻ hết HSD ${lot.maLo}` })
      toast.success(res.message)
      await loadKhoData()
    } catch {
      // Interceptor xử lý
    }
  }

  const handleAutoGeneratePO = async () => {
    try {
      const res = await khoService.autoGeneratePO({ daysCover: 5 })
      setAutoPoOrders(res.orders || [])
      toast.success(res.message)
    } catch {
      // Interceptor xử lý
    }
  }

  const handleLockPeriod = async () => {
    if (!lockDateInput) return
    try {
      const res = await khoService.lockPeriod({ ngayKhoaSoDen: lockDateInput })
      toast.success(res.message)
      await loadKhoData()
    } catch {
      // Interceptor xử lý
    }
  }

  const handleToggleKeyItem = async (nl) => {
    try {
      const next = !nl.isKeyItem
      const res = await khoService.capNhatThuocTinh(nl.maNL, { isKeyItem: next })
      toast.success(res.message)
      await loadKhoData()
    } catch {
      // Interceptor xử lý
    }
  }

  const handleSaveSubRecipeBom = async (e) => {
    e.preventDefault()
    if (!subRecipeForm.maNLThanhPham) return
    try {
      const res = await khoService.luuCongThucBanThanhPham(subRecipeForm.maNLThanhPham, {
        sanLuongMeMacDinh: Number(subRecipeForm.sanLuongMeMacDinh || 1000),
        hanSuDungGio: subRecipeForm.hanSuDungGio ? Number(subRecipeForm.hanSuDungGio) : null,
        dinhMuc: subRecipeForm.dinhMuc
          .filter((d) => d.maNLThanhPhan && Number(d.khoiLuongTieuHao) > 0)
          .map((d) => ({
            maNLThanhPhan: d.maNLThanhPhan,
            khoiLuongTieuHao: Number(d.khoiLuongTieuHao),
          })),
      })
      toast.success(res.message)
      await loadKhoData()
    } catch {
      // Interceptor xử lý
    }
  }

  const handleProduceBatch = async (btp) => {
    setProducingNL(btp.maNL)
    const draft = batchDraftByNL[btp.maNL] || {}
    const soMe = Number(draft.soMe || 1)
    const sanLuongThucTe = draft.sanLuongThucTe ? Number(draft.sanLuongThucTe) : null
    try {
      const res = await khoService.sanXuatMe({
        maNLThanhPham: btp.maNL,
        soMe,
        ...(sanLuongThucTe > 0 ? { sanLuongThucTe } : {}),
      })
      toast.success(
        `${res.message}${res.highPrepLoss ? ` • ⚠️ Hao hụt sơ chế ${res.prepLossPct}%!` : ''}`,
        { duration: 6000 }
      )
      await loadKhoData()
    } catch {
      // Interceptor xử lý
    } finally {
      setProducingNL(null)
    }
  }

  const handleCreateNL = async (e) => {
    e.preventDefault()
    try {
      const res = await khoService.taoNguyenLieu(newNL)
      toast.success(res.message)
      setShowAddNL(false)
      setNewNL({ maNL: '', tenNL: '', donViTinh: 'ml', hanMucCanhBao: 500, giaVonDonVi: 0 })
      await loadKhoData()
    } catch {
      // Interceptor xử lý
    }
  }

  const handleSubmitPhieu = async (e) => {
    e.preventDefault()
    const validRows = items.filter((r) => {
      if (!r.maNL || r.soLuong === '') return false
      const sl = Number(r.soLuong)
      if (Number.isNaN(sl)) return false
      return mode === 'KIEMKE' ? sl >= 0 : sl > 0
    })

    if (validRows.length === 0) {
      toast.error(
        mode === 'KIEMKE'
          ? 'Vui lòng nhập ít nhất 1 dòng nguyên liệu với tồn thực tế >= 0'
          : 'Vui lòng nhập ít nhất 1 dòng nguyên liệu với số lượng > 0'
      )
      return
    }

    setSubmitting(true)
    try {
      if (mode === 'NHAP') {
        const res = await khoService.nhap({
          ghiChu: ghiChu.trim() || 'Nhập kho nguyên liệu',
          ngayChungTu: ngayChungTu || undefined,
          chiPhiVanChuyen: Number(chiPhiVanChuyen || 0),
          giamGiaNCC: Number(giamGiaNCC || 0),
          danhSachNguyenLieu: validRows.map((r) => ({
            maNL: r.maNL,
            soLuong: Number(r.soLuong),
            donGiaNhap: Number(r.donGiaNhap || 0),
            donViNhap: r.donViNhap || null,
            heSoQuyDoi: Number(r.heSoQuyDoi) > 0 ? Number(r.heSoQuyDoi) : 1,
            hanSuDung: r.hanSuDung || null,
            tinhTrang: r.tinhTrang || 'Tốt',
          })),
        })
        setPriceSpikeAlerts(res.priceSpikeAlerts || [])
        toast.success(
          `Đã nhập kho & cập nhật Safe WAC${
            res.cogsAdjustment ? ` (Bù COGS âm kho: ${formatVND(res.cogsAdjustment)})` : ''
          }!`
        )
      } else if (mode === 'KIEMKE' && blindSession?.sessionId) {
        try {
          const res = await khoService.submitBlindStocktake({
            sessionId: blindSession.sessionId,
            ngayChungTu: ngayChungTu || undefined,
            ghiChu: ghiChu.trim() || 'Kiểm kho mù 60s cuối ca',
            recountConfirmed: Boolean(blindSession.recountItems),
            danhSachNguyenLieu: validRows.map((r) => ({
              maNL: r.maNL,
              soLuong: Number(r.soLuong),
              donViNhap: r.donViNhap || null,
              heSoQuyDoi: Number(r.heSoQuyDoi) > 0 ? Number(r.heSoQuyDoi) : 1,
            })),
          })
          toast.success(res.message)
          setBlindSession(null)
        } catch (err) {
          const data = err?.response?.data
          if (err?.response?.status === 422 && data?.code === 'BLIND_STOCK_RECOUNT') {
            setBlindSession((prev) => ({ ...prev, recountItems: data.recountItems || [] }))
            toast.error('⚠️ Một số mã lệch lớn — vui lòng cân/đếm lại lần 2 rồi bấm Xác nhận lần 2!', {
              duration: 6000,
            })
            return
          }
          throw err
        }
      } else {
        await khoService.kiemKe({
          loaiGD: mode === 'HUY' ? 2 : 3,
          ngayChungTu: ngayChungTu || undefined,
          maLyDoHuy: mode === 'HUY' ? maLyDoHuy : null,
          ghiChu:
            ghiChu.trim() || (mode === 'HUY' ? 'Xuất hủy nguyên liệu' : 'Kiểm kê kho định kỳ'),
          danhSachNguyenLieu: validRows.map((r) => ({
            maNL: r.maNL,
            soLuong: Number(r.soLuong),
            donViNhap: r.donViNhap || null,
            heSoQuyDoi: Number(r.heSoQuyDoi) > 0 ? Number(r.heSoQuyDoi) : 1,
            tinhTrang: r.tinhTrang,
          })),
        })
        toast.success(
          mode === 'HUY'
            ? 'Đã lập phiếu xuất hủy theo mã nguyên nhân!'
            : 'Đã cập nhật kiểm kê tồn kho thực tế!'
        )
      }

      setGhiChu('')
      setChiPhiVanChuyen('')
      setGiamGiaNCC('')
      setItems([
        {
          maNL: nguyenLieuList[0]?.maNL || '',
          soLuong: '',
          donGiaNhap: '',
          donViNhap: '',
          heSoQuyDoi: 1,
          hanSuDung: '',
          compoundQtys: {},
          tinhTrang: mode === 'HUY' ? 'Hủy do hư hỏng' : 'Tốt',
        },
      ])
      await loadKhoData()
    } catch {
      // Interceptor đã xử lý
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-extrabold text-gray-800">
          📦 Quản Lý Kho Bãi, Giá Vốn (WAC) & Cân Đối Tồn
        </h1>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleLoadQuick60sStocktake}
            className="px-4 py-2.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl text-xs font-bold shadow cursor-pointer"
          >
            ⚡ Kiểm kê nhanh 60s ({nguyenLieuList.filter((n) => n.isKeyItem).length} Key Items)
          </button>
          <button
            type="button"
            onClick={() => setShowSubRecipeModal(true)}
            className="px-4 py-2.5 bg-purple-700 hover:bg-purple-800 text-white rounded-xl text-xs font-bold shadow cursor-pointer"
          >
            🧪 Sơ chế Bán thành phẩm ({banThanhPhamList.length})
          </button>
          <button
            type="button"
            onClick={() => setShowUomModal(true)}
            className="px-4 py-2.5 bg-sky-700 hover:bg-sky-800 text-white rounded-xl text-xs font-bold shadow cursor-pointer"
          >
            📐 Quy đổi Đơn vị ({quyDoiList.length})
          </button>
          <button
            type="button"
            onClick={() => setShowAddNL(true)}
            className="px-4 py-2.5 bg-amber-700 hover:bg-amber-800 text-white rounded-xl text-xs font-bold shadow cursor-pointer"
          >
            + Thêm nguyên liệu mới
          </button>
        </div>
      </div>

      {/* 1. Bảng cảnh báo tồn kho thấp */}
      <div
        className={`p-4 rounded-2xl border ${
          canhBaoList.length > 0 ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'
        }`}
      >
        <h3
          className={`text-sm font-extrabold mb-2 ${
            canhBaoList.length > 0 ? 'text-red-900' : 'text-emerald-900'
          }`}
        >
          {canhBaoList.length > 0
            ? `⚠️ Cảnh báo: Có ${canhBaoList.length} nguyên liệu chạm/dưới định mức tối thiểu!`
            : '✅ Tất cả nguyên liệu đều trên mức cảnh báo tồn kho'}
        </h3>

        {canhBaoList.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {canhBaoList.map((nl) => (
              <div
                key={nl.maNL}
                className="bg-white p-3 rounded-xl border border-red-200 flex items-center justify-between text-xs"
              >
                <div>
                  <p className="font-bold text-gray-800">
                    {nl.tenNL} ({nl.maNL})
                  </p>
                  <p className="text-gray-500">
                    Định mức tối thiểu: {formatNumber(nl.hanMuc)} {nl.donViTinh}
                  </p>
                </div>
                <span className="px-2.5 py-1 rounded-lg bg-red-100 text-red-800 font-extrabold">
                  Còn {formatNumber(nl.tonKho)} {nl.donViTinh}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 2. Form lập phiếu Nhập kho / Xuất hủy / Kiểm kê */}
      <form
        onSubmit={handleSubmitPhieu}
        className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
          <div className="flex flex-wrap gap-2">
            {[
              { id: 'NHAP', label: '➕ Nhập kho (Tự tính WAC)' },
              { id: 'HUY', label: '🗑️ Xuất hủy (Hao hụt)' },
              { id: 'KIEMKE', label: '📋 Kiểm kê thực tế' },
            ].map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => handleChangeMode(t.id)}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                  mode === t.id
                    ? 'bg-amber-700 text-white shadow-sm'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleAddRow}
            className="px-3 py-1.5 bg-stone-100 hover:bg-stone-200 text-stone-800 rounded-xl text-xs font-bold cursor-pointer"
          >
            + Thêm dòng nguyên liệu
          </button>
        </div>

        {priceSpikeAlerts.length > 0 && (
          <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-300 text-xs space-y-1.5">
            <p className="font-extrabold text-amber-900">
              📈 Cảnh báo Tăng giá nhập (&ge; +5%) &amp; Xói mòn Biên lợi nhuận:
            </p>
            {priceSpikeAlerts.map((al, i) => (
              <div key={i} className="text-amber-950">
                <span className="font-bold">• {al.message}</span>
                {al.affectedItems?.length > 0 && (
                  <span className="ml-1 text-red-700 font-semibold">
                    → Ảnh hưởng:{' '}
                    {al.affectedItems
                      .slice(0, 3)
                      .map((m) => `${m.tenMon} (${m.kichThuoc}: ${m.oldMarginPct}% → ${m.newMarginPct}%)`)
                      .join(', ')}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {mode === 'KIEMKE' && blindSession && (
          <div className="p-3 rounded-xl bg-indigo-50 border border-indigo-200 text-xs flex flex-wrap items-center justify-between gap-2">
            <span className="font-bold text-indigo-900">
              🕵️ Chế độ Kiểm Kho Mù 60s (#{blindSession.sessionId}) — Đã ẩn tồn hệ thống &amp; tự bù trừ tiêu hao bán hàng phát sinh trong lúc đếm!
            </span>
            {blindSession.recountItems && (
              <span className="px-2.5 py-1 rounded-lg bg-red-600 text-white font-extrabold">
                ⚠️ Cần đếm lại lần 2 ({blindSession.recountItems.map((x) => x.tenNL).join(', ')})
              </span>
            )}
          </div>
        )}

        {mode === 'HUY' && (
          <div className="flex flex-wrap items-center gap-2 bg-rose-50/70 p-2.5 rounded-xl border border-rose-200 text-xs">
            <span className="font-bold text-rose-900">🏷️ Phân loại nguyên nhân hao hụt (Wastage Taxonomy):</span>
            <select
              value={maLyDoHuy}
              onChange={(e) => setMaLyDoHuy(e.target.value)}
              className="px-3 py-1.5 bg-white border rounded-xl font-bold text-rose-900"
            >
              {WASTAGE_OPTIONS.map((opt) => (
                <option key={opt.code} value={opt.code}>
                  {opt.code} — {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="space-y-2.5">
          {items.map((row, idx) => {
            const nl = nguyenLieuList.find((x) => x.maNL === row.maNL)
            const uomsForRow = quyDoiList.filter((q) => q.maNL === row.maNL)
            const heSo = Number(row.heSoQuyDoi || 1)
            const slNum = Number(row.soLuong || 0)
            const giaNum = Number(row.donGiaNhap || 0)
            const baseQtyPreview = heSo !== 1 && slNum > 0 ? Math.round(slNum * heSo * 1000) / 1000 : null
            const baseCostPreview = heSo !== 1 && giaNum > 0 ? Math.round((giaNum / heSo) * 100) / 100 : null

            return (
              <div key={idx} className="bg-gray-50 p-2.5 rounded-xl space-y-2">
                <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5 items-center">
                  <select
                    value={row.maNL}
                    onChange={(e) => handleChangeRow(idx, 'maNL', e.target.value)}
                    className="md:col-span-4 px-3 py-2 bg-white border rounded-xl text-xs font-medium"
                  >
                    {nguyenLieuList.map((n) => (
                      <option key={n.maNL} value={n.maNL}>
                        {mode === 'KIEMKE'
                          ? `${n.maNL} - ${n.tenNL} (${n.donViTinh})`
                          : `${n.maNL} - ${n.tenNL} (Tồn: ${formatNumber(n.tonKho)} ${n.donViTinh} • Vốn: ${formatVND(n.giaVonDonVi)})`}
                      </option>
                    ))}
                  </select>

                  <input
                    type="number"
                    step="any"
                    min={mode === 'KIEMKE' ? '0' : '0.001'}
                    required
                    placeholder={mode === 'KIEMKE' ? 'Tồn thực tế...' : 'Số lượng...'}
                    value={row.soLuong}
                    onChange={(e) => handleChangeRow(idx, 'soLuong', e.target.value)}
                    className="md:col-span-2 px-3 py-2 bg-white border rounded-xl text-xs"
                  />

                  <select
                    value={
                      heSo === 1
                        ? '__BASE__'
                        : String(
                            uomsForRow.find(
                              (q) => q.tenDonVi === row.donViNhap && Number(q.heSoQuyDoi) === heSo
                            )?.id || '__BASE__'
                          )
                    }
                    onChange={(e) => handleChangeRowUnit(idx, e.target.value, nl)}
                    className="md:col-span-2 px-2.5 py-2 bg-white border rounded-xl text-xs font-bold text-sky-900"
                    title="Chọn đơn vị (Thùng / Hộp / Kg) áp dụng cho cả Nhập, Hủy & Kiểm kê"
                  >
                    <option value="__BASE__">{nl?.donViTinh || 'ĐVT gốc'} (×1)</option>
                    {uomsForRow.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.tenDonVi} (×{formatNumber(u.heSoQuyDoi)} {nl?.donViTinh})
                      </option>
                    ))}
                  </select>

                  {mode === 'NHAP' ? (
                    <div className="md:col-span-3 grid grid-cols-2 gap-1.5">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        required
                        placeholder={`Giá / ${heSo === 1 ? nl?.donViTinh || 'ĐVT' : row.donViNhap}`}
                        value={row.donGiaNhap}
                        onChange={(e) => handleChangeRow(idx, 'donGiaNhap', e.target.value)}
                        className="px-2.5 py-2 bg-white border rounded-xl text-xs"
                      />
                      <input
                        type="date"
                        title="Hạn sử dụng lô FEFO (tùy chọn)"
                        value={row.hanSuDung || ''}
                        onChange={(e) => handleChangeRow(idx, 'hanSuDung', e.target.value)}
                        className="px-2 py-2 bg-white border rounded-xl text-[11px]"
                      />
                    </div>
                  ) : (
                    <input
                      type="text"
                      placeholder="Tình trạng / Lý do..."
                      value={row.tinhTrang}
                      onChange={(e) => handleChangeRow(idx, 'tinhTrang', e.target.value)}
                      className="md:col-span-3 px-3 py-2 bg-white border rounded-xl text-xs"
                    />
                  )}

                  <div className="md:col-span-1 flex justify-end">
                    <button
                      type="button"
                      disabled={items.length <= 1}
                      onClick={() => handleRemoveRow(idx)}
                      className="px-2 py-2 text-xs font-bold text-red-600 disabled:text-gray-300 cursor-pointer"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* Nhập Tổ hợp Đa đơn vị (Compound UoM: Thùng + Hộp + ml lẻ) cho cả Kiểm kê & Xuất hủy */}
                {uomsForRow.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pl-1 text-[11px]">
                    <span className="font-bold text-sky-900">🧮 Đếm tổ hợp:</span>
                    {uomsForRow.slice(0, 2).map((u) => (
                      <label key={u.id} className="inline-flex items-center gap-1 bg-white px-2 py-1 rounded-lg border">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          placeholder="0"
                          value={row.compoundQtys?.[String(u.id)] ?? ''}
                          onChange={(e) => handleChangeCompoundUnit(idx, String(u.id), e.target.value, uomsForRow)}
                          className="w-12 text-center font-bold outline-none"
                        />
                        <span className="text-gray-600 font-semibold">{u.tenDonVi}</span>
                      </label>
                    ))}
                    <label className="inline-flex items-center gap-1 bg-white px-2 py-1 rounded-lg border">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        placeholder="0"
                        value={row.compoundQtys?.__BASE__ ?? ''}
                        onChange={(e) => handleChangeCompoundUnit(idx, '__BASE__', e.target.value, uomsForRow)}
                        className="w-14 text-center font-bold outline-none"
                      />
                      <span className="text-gray-600 font-semibold">{nl?.donViTinh} lẻ</span>
                    </label>
                    {slNum > 0 && (
                      <span className="font-extrabold text-emerald-700">
                        = {formatNumber(heSo !== 1 ? baseQtyPreview : slNum)} {nl?.donViTinh}
                      </span>
                    )}
                  </div>
                )}

                {mode === 'NHAP' && baseQtyPreview !== null && (
                  <p className="text-[11px] font-bold text-sky-800 pl-1">
                    📐 Quy đổi tự động: {slNum} {row.donViNhap} ={' '}
                    <span className="text-emerald-700">
                      {formatNumber(baseQtyPreview)} {nl?.donViTinh}
                    </span>
                    {baseCostPreview !== null && (
                      <>
                        {' '}
                        • Đơn giá gốc:{' '}
                        <span className="text-amber-800">
                          {formatNumber(baseCostPreview)}đ/{nl?.donViTinh}
                        </span>
                      </>
                    )}
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2.5 pt-2">
          <input
            type="date"
            value={ngayChungTu}
            onChange={(e) => setNgayChungTu(e.target.value)}
            title="Ngày chứng từ (Kiểm tra khóa sổ kỳ kế toán)"
            className="px-3 py-2.5 border rounded-xl text-xs font-semibold"
          />
          {mode === 'NHAP' && (
            <>
              <input
                type="number"
                min="0"
                step="1000"
                value={chiPhiVanChuyen}
                onChange={(e) => setChiPhiVanChuyen(e.target.value)}
                placeholder="Phí ship / xe lạnh (Landed Cost)..."
                className="w-48 px-3 py-2.5 border rounded-xl text-xs"
              />
              <input
                type="number"
                min="0"
                step="1000"
                value={giamGiaNCC}
                onChange={(e) => setGiamGiaNCC(e.target.value)}
                placeholder="Giảm giá NCC..."
                className="w-36 px-3 py-2.5 border rounded-xl text-xs"
              />
            </>
          )}
          <input
            type="text"
            value={ghiChu}
            onChange={(e) => setGhiChu(e.target.value)}
            placeholder="Ghi chú chung cho phiếu kho này..."
            className="flex-1 min-w-[200px] px-3.5 py-2.5 border rounded-xl text-xs"
          />
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs shadow cursor-pointer"
          >
            {submitting
              ? 'Đang lưu phiếu...'
              : blindSession?.recountItems
              ? '✅ Xác nhận Kiểm đếm Lần 2'
              : '💾 Xác nhận Lưu Phiếu Kho'}
          </button>
        </div>
      </form>

      {/* 3. Bảng Báo cáo Cân đối kho định kỳ */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-bold text-gray-800 text-base">
              📊 Báo Cáo Cân Đối Xuất - Nhập - Tồn & Giá Vốn (WAC)
            </h3>
            <p className="text-xs text-gray-500">
              Chuẩn múi giờ VN • Gồm nhập kho, tiêu hao bán hàng, hoàn kho hủy món, xuất hủy & kiểm kê
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="date"
              value={tuNgay}
              onChange={(e) => setTuNgay(e.target.value)}
              className="px-2.5 py-1.5 border rounded-xl text-xs"
            />
            <span className="text-gray-400">→</span>
            <input
              type="date"
              value={denNgay}
              onChange={(e) => setDenNgay(e.target.value)}
              className="px-2.5 py-1.5 border rounded-xl text-xs"
            />
            <button
              onClick={loadKhoData}
              className="px-3.5 py-1.5 bg-stone-800 hover:bg-stone-900 text-white rounded-xl text-xs font-bold cursor-pointer"
            >
              Xem cân đối
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-gray-50 text-gray-600 uppercase">
              <tr>
                <th className="p-3">Nguyên liệu</th>
                <th className="p-3 text-right">Giá vốn (WAC)</th>
                <th className="p-3 text-right">Tồn hiện tại</th>
                <th className="p-3 text-right">Nhập (+1)</th>
                <th className="p-3 text-right">Tiêu hao (-6)</th>
                <th className="p-3 text-right">Hoàn hủy (+7)</th>
                <th className="p-3 text-right">Xuất hủy (-2)</th>
                <th className="p-3 text-right">Lệch kiểm kê (±3)</th>
                <th className="p-3 text-right">Thất thoát (VNĐ / %)</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {canDoiList.map((r) => (
                <tr key={r.maNL} className="hover:bg-gray-50">
                  <td className="p-3">
                    <button
                      type="button"
                      onClick={() => {
                        const found = nguyenLieuList.find((x) => x.maNL === r.maNL) || r
                        void handleToggleKeyItem(found)
                      }}
                      title="Đánh dấu mặt hàng nhạy cảm thất thoát cao để Kiểm kê nhanh 60s cuối ca"
                      className="mr-1.5 cursor-pointer"
                    >
                      {nguyenLieuList.find((x) => x.maNL === r.maNL)?.isKeyItem ? '⭐' : '☆'}
                    </button>
                    <span className="font-bold text-gray-800">{r.tenNL}</span>
                    <span className="ml-1.5 font-mono text-[10px] text-gray-400">
                      ({r.maNL} • {r.donViTinh})
                    </span>
                  </td>
                  <td className="p-3 text-right font-semibold text-stone-700">
                    {formatVND(r.giaVonDonVi)}
                  </td>
                  <td
                    className={`p-3 text-right font-extrabold ${
                      r.tonKho < 0 ? 'text-red-600' : 'text-amber-800'
                    }`}
                  >
                    {formatNumber(r.tonKho)}
                  </td>
                  <td className="p-3 text-right font-semibold text-emerald-600">
                    +{formatNumber(r.tongNhap)}
                  </td>
                  <td className="p-3 text-right font-semibold text-blue-600">
                    -{formatNumber(r.tongTieuHaoBanHang)}
                  </td>
                  <td className="p-3 text-right font-semibold text-teal-600">
                    +{formatNumber(r.tongHoanKhoHuyMon)}
                  </td>
                  <td className="p-3 text-right font-semibold text-red-600">
                    -{formatNumber(r.tongXuatHuy)}
                  </td>
                  <td className="p-3 text-right font-semibold">
                    {r.chenhLechKiemKe > 0
                      ? `+${formatNumber(r.chenhLechKiemKe)}`
                      : formatNumber(r.chenhLechKiemKe)}
                  </td>
                  <td className="p-3 text-right">
                    {r.giaTriThatThoat > 0 ? (
                      <span className="font-extrabold text-red-700">
                        {formatVND(r.giaTriThatThoat)}{' '}
                        <span className="text-[10px] font-bold">({r.tyLeThatThoatPct}%)</span>
                      </span>
                    ) : (
                      <span className="text-emerald-700 font-semibold">0đ</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal Sơ chế Bán thành phẩm theo mẻ (Sub-Recipe / Batch Production) */}
      {showSubRecipeModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto text-xs">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <h3 className="font-extrabold text-base text-purple-900">
                  🧪 Sơ Chế Bán Thành Phẩm Theo Mẻ (Sub-Recipes / Batch Prep)
                </h3>
                <p className="text-gray-500">
                  VD: Ủ 1 mẻ 10.000ml Cốt trà Ô Long hoặc nấu 2.000g Trân châu đường đen (HSD 4 giờ) → tự trừ nguyên liệu thô &amp; tính lại Giá vốn WAC
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowSubRecipeModal(false)}
                className="w-9 h-9 rounded-full bg-gray-100 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form
              onSubmit={handleSaveSubRecipeBom}
              className="space-y-3 bg-purple-50/70 p-4 rounded-xl border border-purple-200"
            >
              <p className="font-extrabold text-purple-950">
                1. Thiết lập công thức sơ chế cho 1 mẻ Bán thành phẩm:
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                  <label className="block font-bold text-gray-600 mb-1">Bán thành phẩm đích:</label>
                  <select
                    value={subRecipeForm.maNLThanhPham}
                    onChange={(e) =>
                      setSubRecipeForm({ ...subRecipeForm, maNLThanhPham: e.target.value })
                    }
                    className="w-full px-3 py-2 border rounded-xl bg-white font-bold"
                  >
                    {nguyenLieuList.map((n) => (
                      <option key={n.maNL} value={n.maNL}>
                        {n.tenNL} ({n.donViTinh})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-gray-600 mb-1">Sản lượng thu được / 1 mẻ:</label>
                  <input
                    type="number"
                    min="1"
                    step="any"
                    required
                    value={subRecipeForm.sanLuongMeMacDinh}
                    onChange={(e) =>
                      setSubRecipeForm({ ...subRecipeForm, sanLuongMeMacDinh: e.target.value })
                    }
                    className="w-full px-3 py-2 border rounded-xl bg-white font-bold"
                  />
                </div>
                <div>
                  <label className="block font-bold text-gray-600 mb-1">Hạn sử dụng sau nấu (Giờ):</label>
                  <input
                    type="number"
                    min="1"
                    placeholder="VD: 4 giờ"
                    value={subRecipeForm.hanSuDungGio}
                    onChange={(e) =>
                      setSubRecipeForm({ ...subRecipeForm, hanSuDungGio: e.target.value })
                    }
                    className="w-full px-3 py-2 border rounded-xl bg-white font-bold"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-gray-700">Nguyên liệu thô tiêu hao cho 1 mẻ:</span>
                  <button
                    type="button"
                    onClick={() =>
                      setSubRecipeForm((prev) => ({
                        ...prev,
                        dinhMuc: [
                          ...prev.dinhMuc,
                          { maNLThanhPhan: nguyenLieuList[0]?.maNL || '', khoiLuongTieuHao: 100 },
                        ],
                      }))
                    }
                    className="text-purple-700 font-bold hover:underline cursor-pointer"
                  >
                    + Thêm thành phần thô
                  </button>
                </div>
                {subRecipeForm.dinhMuc.map((row, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <select
                      value={row.maNLThanhPhan}
                      onChange={(e) =>
                        setSubRecipeForm((prev) => ({
                          ...prev,
                          dinhMuc: prev.dinhMuc.map((r, i) =>
                            i === idx ? { ...r, maNLThanhPhan: e.target.value } : r
                          ),
                        }))
                      }
                      className="flex-1 px-3 py-1.5 border rounded-xl bg-white font-semibold"
                    >
                      {nguyenLieuList
                        .filter((n) => n.maNL !== subRecipeForm.maNLThanhPham)
                        .map((n) => (
                          <option key={n.maNL} value={n.maNL}>
                            {n.tenNL} ({n.donViTinh} • Vốn: {formatVND(n.giaVonDonVi)})
                          </option>
                        ))}
                    </select>
                    <input
                      type="number"
                      min="0.001"
                      step="any"
                      value={row.khoiLuongTieuHao}
                      onChange={(e) =>
                        setSubRecipeForm((prev) => ({
                          ...prev,
                          dinhMuc: prev.dinhMuc.map((r, i) =>
                            i === idx ? { ...r, khoiLuongTieuHao: e.target.value } : r
                          ),
                        }))
                      }
                      className="w-28 px-3 py-1.5 border rounded-xl bg-white font-bold"
                    />
                    {subRecipeForm.dinhMuc.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setSubRecipeForm((prev) => ({
                            ...prev,
                            dinhMuc: prev.dinhMuc.filter((_, i) => i !== idx),
                          }))
                        }
                        className="text-red-600 font-bold px-2 cursor-pointer"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-purple-700 hover:bg-purple-800 text-white font-bold cursor-pointer"
                >
                  💾 Lưu công thức Bán thành phẩm
                </button>
              </div>
            </form>

            <div className="space-y-2">
              <p className="font-extrabold text-gray-800">
                2. Danh sách Bán thành phẩm sẵn sàng nấu / ủ theo mẻ ({banThanhPhamList.length}):
              </p>
              {banThanhPhamList.length === 0 ? (
                <p className="p-4 text-center text-gray-400 italic border rounded-xl">
                  Chưa có Bán thành phẩm nào được thiết lập công thức ở trên.
                </p>
              ) : (
                <div className="divide-y border rounded-xl">
                  {banThanhPhamList.map((btp) => (
                    <div
                      key={btp.maNL}
                      className="p-3 flex flex-wrap items-center justify-between gap-2"
                    >
                      <div>
                        <p className="font-extrabold text-gray-900">
                          {btp.tenNL}{' '}
                          <span className="text-purple-800">
                            (1 mẻ = {formatNumber(btp.sanLuongMeMacDinh)} {btp.donViTinh}
                            {btp.hanSuDungGio ? ` • HSD ${btp.hanSuDungGio}h` : ''})
                          </span>
                        </p>
                        <p className="text-[11px] text-gray-500">
                          Thành phần:{' '}
                          {btp.dinhMuc
                            .map(
                              (c) =>
                                `${c.tenNLThanhPhan} (${formatNumber(c.khoiLuongTieuHao)}${c.donViTinh})`
                            )
                            .join(' + ')}
                        </p>
                        <p className="text-[11px] text-emerald-800 font-bold mt-0.5">
                          Tồn hiện tại: {formatNumber(btp.soLuongTon)} {btp.donViTinh} • Giá vốn mẻ dự kiến:{' '}
                          {formatVND(btp.giaVonMeDuKien)} ({btp.giaVonDonViDuKien}đ/{btp.donViTinh})
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <input
                          type="number"
                          step="0.5"
                          min="0.1"
                          value={batchDraftByNL[btp.maNL]?.soMe ?? '1'}
                          onChange={(e) =>
                            setBatchDraftByNL((prev) => ({
                              ...prev,
                              [btp.maNL]: { ...(prev[btp.maNL] || {}), soMe: e.target.value },
                            }))
                          }
                          title="Số mẻ linh hoạt (VD: 0.5, 1.5, 2)"
                          className="w-16 px-2 py-1.5 border rounded-lg text-center font-bold"
                        />
                        <span className="text-gray-500">mẻ</span>
                        <input
                          type="number"
                          step="any"
                          min="1"
                          placeholder={`Thực thu (${btp.donViTinh})`}
                          value={batchDraftByNL[btp.maNL]?.sanLuongThucTe ?? ''}
                          onChange={(e) =>
                            setBatchDraftByNL((prev) => ({
                              ...prev,
                              [btp.maNL]: { ...(prev[btp.maNL] || {}), sanLuongThucTe: e.target.value },
                            }))
                          }
                          title="Sản lượng thực thu sau lọc bã (để tính đúng Yield % & Giá vốn)"
                          className="w-28 px-2 py-1.5 border rounded-lg font-semibold"
                        />
                        <button
                          type="button"
                          disabled={producingNL === btp.maNL}
                          onClick={() => handleProduceBatch(btp)}
                          className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold cursor-pointer disabled:opacity-50"
                        >
                          {producingNL === btp.maNL
                            ? 'Đang nấu...'
                            : `🔥 Nấu ${batchDraftByNL[btp.maNL]?.soMe || 1} mẻ`}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 4. [Phân hệ 4] Lô FEFO Sắp Hết Hạn, AvT Theo Ca, Auto-PO & Khóa Sổ Kho */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white p-4 rounded-2xl border border-gray-200 space-y-2.5 text-xs">
          <div className="flex items-center justify-between">
            <h3 className="font-extrabold text-gray-800">
              ⏱️ Lô Tồn Kho FEFO &amp; Cảnh Báo Hết Hạn ({loTonKho.length} lô đang mở)
            </h3>
            {expiringLots.length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-extrabold">
                {expiringLots.length} lô sắp/đã hết HSD
              </span>
            )}
          </div>
          {loTonKho.length === 0 ? (
            <p className="text-gray-400 italic">Chưa có lô FEFO / Bán thành phẩm nào đang theo dõi hạn dùng.</p>
          ) : (
            <div className="divide-y max-h-52 overflow-y-auto">
              {loTonKho.slice(0, 8).map((lot) => (
                <div key={lot.id} className="py-2 flex items-center justify-between gap-2">
                  <div>
                    <p className="font-bold text-gray-800">
                      {lot.tenNL} <span className="text-indigo-700">({lot.maLo})</span>
                    </p>
                    <p className="text-[11px] text-gray-500">
                      Còn: {formatNumber(lot.soLuongConLai)} {lot.donViTinh} • Vốn lô: {formatNumber(lot.giaVonLo)}đ
                      {lot.thoiGianHetHan ? ` • HSD: ${new Date(lot.thoiGianHetHan).toLocaleString('vi-VN')}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDisposeLot(lot)}
                    className="px-2.5 py-1.5 rounded-lg bg-rose-100 hover:bg-rose-200 text-rose-800 font-bold cursor-pointer"
                  >
                    🗑️ Hủy lô
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {isManager && (
          <div className="bg-white p-4 rounded-2xl border border-gray-200 space-y-3 text-xs">
            <h3 className="font-extrabold text-gray-800">
              🛡️ Kiểm Soát Chuỗi Cung Ứng (AvT Theo Ca • Auto-PO • Khóa Sổ Kho)
            </h3>
            {shiftAvt && (
              <div className="p-2.5 rounded-xl bg-slate-50 border flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-bold text-slate-800">
                    📊 AvT Ca hiện tại ({shiftAvt.tenNV}): {shiftAvt.items?.length || 0} Key Items đã chốt
                  </p>
                  <p className="text-[11px] text-slate-600">
                    Thất thoát vô danh:{' '}
                    <span className={shiftAvt.flaggedItems?.length ? 'text-red-700 font-extrabold' : 'text-emerald-700 font-bold'}>
                      {formatVND(shiftAvt.totalUnexplainedValue || 0)} ({shiftAvt.flaggedItems?.length || 0} cảnh báo)
                    </span>
                  </p>
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleAutoGeneratePO}
                className="px-3.5 py-2 rounded-xl bg-sky-700 hover:bg-sky-800 text-white font-bold cursor-pointer"
              >
                🤖 Tạo Auto-PO từ AI 60 ngày
              </button>
              <input
                type="date"
                value={lockDateInput}
                onChange={(e) => setLockDateInput(e.target.value)}
                className="px-2.5 py-1.5 border rounded-xl"
              />
              <button
                type="button"
                onClick={handleLockPeriod}
                className="px-3.5 py-2 rounded-xl bg-stone-800 hover:bg-stone-900 text-white font-bold cursor-pointer"
              >
                🔒 Khóa sổ kho
              </button>
            </div>
            {periodLocks.length > 0 && (
              <p className="text-[11px] text-amber-800 font-semibold">
                🔒 Đã khóa sổ đến hết ngày: <strong>{periodLocks[0].ngayKhoaSoDen}</strong> (bởi {periodLocks[0].nguoiDongSo})
              </p>
            )}
            {autoPoOrders.length > 0 && (
              <div className="p-2.5 rounded-xl bg-sky-50 border border-sky-200 space-y-1">
                {autoPoOrders.map((po) => (
                  <p key={po.maPO} className="text-[11px] text-sky-950 font-semibold">
                    📦 {po.maPO} ({po.items.length} dòng • Dự kiến {formatVND(po.tongDuKien)} • Giao {po.etaDate})
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modal Quản lý Quy đổi Đơn vị tính Kho (Thùng -> Lon -> ml/g) */}
      {showUomModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-xl w-full p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto text-xs">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <h3 className="font-extrabold text-base text-sky-900">
                  📐 Quy Đổi Đơn Vị Tính Nhập Kho (UoM Conversion)
                </h3>
                <p className="text-gray-500">
                  VD: Mua theo Thùng / Hộp / Kg → hệ thống tự nhân hệ số quy đổi về ml/g &amp; tính đúng giá vốn WAC
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowUomModal(false)}
                className="w-9 h-9 rounded-full bg-gray-100 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            {!allowInventoryBom ? (
              <FeatureLockedCard
                title="Quy đổi Đơn vị tính Kho (Thùng → Lon → ml/g)"
                description="Tự động quy đổi đơn vị nhập mua (Thùng, Hộp, Kg) sang đơn vị xuất kho (ml, g) và tính giá vốn WAC thuộc gói PRO."
                requiredPlan="PRO"
                currentPlan={user?.goiCuoc || 'STARTER'}
              />
            ) : (
            <form onSubmit={handleSaveUom} className="space-y-3 bg-sky-50/70 p-3.5 rounded-xl border border-sky-200">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <select
                  required
                  value={uomForm.maNL}
                  onChange={(e) => setUomForm({ ...uomForm, maNL: e.target.value })}
                  className="px-3 py-2 border rounded-xl bg-white font-semibold"
                >
                  {nguyenLieuList.map((n) => (
                    <option key={n.maNL} value={n.maNL}>
                      {n.tenNL} ({n.donViTinh})
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  required
                  placeholder="Tên đơn vị (Thùng, Hộp, Kg...)"
                  value={uomForm.tenDonVi}
                  onChange={(e) => setUomForm({ ...uomForm, tenDonVi: e.target.value })}
                  className="px-3 py-2 border rounded-xl bg-white"
                />
                <input
                  type="number"
                  step="any"
                  min="0.001"
                  required
                  placeholder="Hệ số ra ĐVT gốc"
                  value={uomForm.heSoQuyDoi}
                  onChange={(e) => setUomForm({ ...uomForm, heSoQuyDoi: e.target.value })}
                  className="px-3 py-2 border rounded-xl bg-white font-bold"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {[
                    { label: '1 Kg = 1000g', tenDonVi: 'Kg', heSoQuyDoi: 1000 },
                    { label: '1 Hộp = 1000ml', tenDonVi: 'Hộp', heSoQuyDoi: 1000 },
                    { label: '1 Thùng 12H = 12000ml', tenDonVi: 'Thùng', heSoQuyDoi: 12000 },
                    { label: '1 Thùng 48 Lon = 18240ml', tenDonVi: 'Thùng 48 lon', heSoQuyDoi: 18240 },
                  ].map((p) => (
                    <button
                      type="button"
                      key={p.label}
                      onClick={() => setUomForm((prev) => ({ ...prev, tenDonVi: p.tenDonVi, heSoQuyDoi: p.heSoQuyDoi }))}
                      className="px-2 py-1 rounded-lg bg-white hover:bg-sky-100 border border-sky-200 text-sky-900 font-semibold cursor-pointer"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-sky-700 hover:bg-sky-800 text-white font-bold cursor-pointer"
                >
                  + Lưu quy đổi
                </button>
              </div>
            </form>
            )}

            <div className="divide-y border rounded-xl">
              {quyDoiList.length === 0 ? (
                <p className="p-4 text-center text-gray-400 italic">
                  Chưa có quy đổi đơn vị nào — chọn nguyên liệu và bấm gợi ý nhanh ở trên!
                </p>
              ) : (
                quyDoiList.map((q) => (
                  <div key={q.id} className="p-3 flex items-center justify-between gap-2">
                    <div>
                      <span className="font-bold text-gray-800">{q.tenNL}</span>
                      <span className="ml-2 px-2 py-0.5 rounded bg-sky-100 text-sky-900 font-extrabold">
                        1 {q.tenDonVi} = {formatNumber(q.heSoQuyDoi)} {q.donViGoc}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteUom(q.id)}
                      className="text-red-600 font-bold hover:underline cursor-pointer"
                    >
                      Xóa
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal Thêm nguyên liệu mới */}
      {showAddNL && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl space-y-4">
            <h3 className="font-extrabold text-base text-gray-800">➕ Thêm Nguyên Liệu Mới</h3>
            <form onSubmit={handleCreateNL} className="space-y-3 text-xs">
              <div>
                <label className="block font-bold text-gray-600 mb-1">Mã NL (VD: NL_SUA)</label>
                <input
                  type="text"
                  required
                  value={newNL.maNL}
                  onChange={(e) => setNewNL({ ...newNL, maNL: e.target.value })}
                  className="w-full px-3 py-2 border rounded-xl"
                />
              </div>
              <div>
                <label className="block font-bold text-gray-600 mb-1">Tên nguyên liệu</label>
                <input
                  type="text"
                  required
                  value={newNL.tenNL}
                  onChange={(e) => setNewNL({ ...newNL, tenNL: e.target.value })}
                  className="w-full px-3 py-2 border rounded-xl"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-bold text-gray-600 mb-1">Đơn vị tính (ml, g, cái)</label>
                  <input
                    type="text"
                    required
                    value={newNL.donViTinh}
                    onChange={(e) => setNewNL({ ...newNL, donViTinh: e.target.value })}
                    className="w-full px-3 py-2 border rounded-xl"
                  />
                </div>
                <div>
                  <label className="block font-bold text-gray-600 mb-1">Hạn mức cảnh báo</label>
                  <input
                    type="number"
                    min="0"
                    value={newNL.hanMucCanhBao}
                    onChange={(e) => setNewNL({ ...newNL, hanMucCanhBao: e.target.value })}
                    className="w-full px-3 py-2 border rounded-xl"
                  />
                </div>
              </div>
              <div>
                <label className="block font-bold text-gray-600 mb-1">Giá vốn ban đầu / 1 ĐVT (VND)</label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={newNL.giaVonDonVi}
                  onChange={(e) => setNewNL({ ...newNL, giaVonDonVi: e.target.value })}
                  className="w-full px-3 py-2 border rounded-xl"
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddNL(false)}
                  className="flex-1 py-2.5 border rounded-xl font-bold cursor-pointer"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 bg-amber-700 text-white rounded-xl font-bold cursor-pointer"
                >
                  Tạo nguyên liệu
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* [Wave 3B — P1-02] Tab / Panel Vật tư Đóng gói theo Kênh (cauhinh_vattu_mangdi) */}
      <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-extrabold text-stone-900">
              📦 Vật tư Đóng gói theo Kênh (Bao bì động Mang đi / Giao hàng)
            </h2>
            <p className="text-xs text-stone-500">
              Tự động trừ ly nhựa, nắp cầu, ống hút, túi chữ T theo kênh bán (MANG_DI / GIAO_HANG / APP) vào COGS
            </p>
          </div>
          <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800">
            {packagingRules.length} cấu hình
          </span>
        </div>
        <form onSubmit={handleSavePackagingRule} className="grid grid-cols-1 sm:grid-cols-5 gap-2.5">
          <select
            value={packagingForm.loaiDonHang}
            onChange={(e) => setPackagingForm((p) => ({ ...p, loaiDonHang: e.target.value }))}
            className="rounded-xl border border-stone-300 px-3 py-2 text-xs font-semibold"
          >
            <option value="MANG_DI">🛍️ Mang đi (MANG_DI)</option>
            <option value="GIAO_HANG">🛵 Giao hàng (GIAO_HANG)</option>
            <option value="APP">📱 App Delivery (APP)</option>
          </select>
          <select
            value={packagingForm.kichThuoc}
            onChange={(e) => setPackagingForm((p) => ({ ...p, kichThuoc: e.target.value }))}
            className="rounded-xl border border-stone-300 px-3 py-2 text-xs font-semibold"
          >
            <option value="ALL">Mọi Size (ALL)</option>
            <option value="S">Size S</option>
            <option value="M">Size M</option>
            <option value="L">Size L</option>
          </select>
          <select
            value={packagingForm.maNL}
            onChange={(e) => setPackagingForm((p) => ({ ...p, maNL: e.target.value }))}
            className="rounded-xl border border-stone-300 px-3 py-2 text-xs font-semibold"
          >
            <option value="">-- Chọn vật tư bao bì --</option>
            {nguyenLieuList.map((nl) => (
              <option key={nl.maNL} value={nl.maNL}>
                {nl.tenNL} ({nl.donViTinh})
              </option>
            ))}
          </select>
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={packagingForm.soLuongMoiLy}
            onChange={(e) => setPackagingForm((p) => ({ ...p, soLuongMoiLy: e.target.value }))}
            placeholder="SL mỗi ly"
            className="rounded-xl border border-stone-300 px-3 py-2 text-xs font-semibold"
          />
          <button
            type="submit"
            disabled={savingPackaging}
            className="rounded-xl bg-amber-700 hover:bg-amber-800 text-white text-xs font-extrabold px-4 py-2 cursor-pointer disabled:opacity-50"
          >
            {savingPackaging ? 'Đang lưu...' : '💾 Lưu bao bì'}
          </button>
        </form>
        {packagingRules.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {packagingRules.map((r, idx) => (
              <div key={r.id || idx} className="p-2.5 rounded-xl bg-stone-50 border border-stone-200 text-xs flex justify-between">
                <span className="font-bold text-stone-800">
                  {r.loaiDonHang || r.loaidonhang} • Size {r.kichThuoc || r.kichthuoc}
                </span>
                <span className="text-amber-800 font-extrabold">
                  {r.tenNL || r.manl} × {r.soLuongMoiLy || r.soluongmoily}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
