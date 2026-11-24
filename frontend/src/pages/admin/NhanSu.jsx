import { useState, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'
import QRCode from 'qrcode'
import { nhanSuService } from '../../services/nhanSuService'
import { useAuthStore } from '../../store/authStore'
import { ROLE_LABEL } from '../../constants/roles'
import { formatVND, getTodayISO } from '../../utils/format'
import ConfirmPinModal from '../../components/ConfirmPinModal'
import axiosClient from '../../api/axiosClient'

// Cắt "07:00:00" thành "07:00" cho gọn
const formatGio = (gio) => (gio ? String(gio).slice(0, 5) : '')

export default function NhanSu() {
  const { user } = useAuthStore()
  const shopCode = user?.slug || user?.tenantSlug || user?.maTienTo || 'default-cafe'
  const shopLoginUrl = `${window.location.origin}/login?shop=${encodeURIComponent(shopCode)}`

  // BƯỚC 1: State chứa danh sách thật tải từ Backend
  const [tatCaNV, setTatCaNV] = useState([])
  const [danhSachNV, setDanhSachNV] = useState([])
  const [danhSachCa, setDanhSachCa] = useState([])
  const [loadingInit, setLoadingInit] = useState(true)
  const [creatingNV, setCreatingNV] = useState(false)
  const [newStaff, setNewStaff] = useState({
    tenNV: '',
    tenDangNhap: '',
    matKhau: '',
    vaiTro: 4,
    mucLuongTheoGio: 28000,
  })

  const [phanCaForm, setPhanCaForm] = useState({
    maNV: '',
    maCa: '',
    ngayLam: getTodayISO(),
  })

  const now = new Date()
  const [luongParams, setLuongParams] = useState({
    thang: now.getMonth() + 1,
    nam: now.getFullYear(),
    donGiaGio: 25000,
  })
  const [bangLuong, setBangLuong] = useState([])

  // BƯỚC 2: Vừa mở trang thì gọi API lấy danh sách Nhân viên và Ca làm việc
  useEffect(() => {
    let active = true

    const loadDanhMuc = async () => {
      try {
        const [nvRes, caRes] = await Promise.all([
          nhanSuService.getNhanVien(),
          nhanSuService.getCaLamViec(),
        ])
        if (!active) return

        const allNv = Array.isArray(nvRes) ? nvRes : []
        // Chỉ giữ nhân viên đang còn làm việc cho form phân ca
        const nvDangLam = allNv.filter((nv) => nv.trangThaiLamViec !== false)
        const caList = Array.isArray(caRes) ? caRes : []

        setTatCaNV(allNv)
        setDanhSachNV(nvDangLam)
        setDanhSachCa(caList)

        // Chọn sẵn dòng đầu tiên cho form phân ca khỏi bị rỗng
        setPhanCaForm((prev) => ({
          ...prev,
          maNV: prev.maNV || nvDangLam[0]?.maNV || '',
          maCa: prev.maCa || caList[0]?.maCa || '',
        }))
      } catch {
        // axiosClient interceptor đã tự hiện toast lỗi
      } finally {
        if (active) setLoadingInit(false)
      }
    }

    loadDanhMuc()
    return () => {
      active = false
    }
  }, [])

  const reloadNhanVien = async () => {
    try {
      const nvRes = await nhanSuService.getNhanVien()
      const allNv = Array.isArray(nvRes) ? nvRes : []
      setTatCaNV(allNv)
      setDanhSachNV(allNv.filter((nv) => nv.trangThaiLamViec !== false))
    } catch {
      // Interceptor xử lý
    }
  }

  const handleTaoNV = async (e) => {
    e.preventDefault()
    setCreatingNV(true)
    try {
      const res = await nhanSuService.taoNhanVien({
        ...newStaff,
        vaiTro: Number(newStaff.vaiTro),
        mucLuongTheoGio: Number(newStaff.mucLuongTheoGio),
      })
      toast.success(res.message || 'Tạo nhân viên thành công!')
      setNewStaff({ tenNV: '', tenDangNhap: '', matKhau: '', vaiTro: 4, mucLuongTheoGio: 28000 })
      await reloadNhanVien()
    } catch {
      // Interceptor xử lý
    } finally {
      setCreatingNV(false)
    }
  }

  const [staffDialog, setStaffDialog] = useState(null) // { kind: 'lock'|'resetPassword'|'setPin', nv }
  const [weeklyShifts, setWeeklyShifts] = useState([])
  const [kioskQr, setKioskQr] = useState({ token: '', qrDataUrl: '', expiresInSec: 30, branchId: 'DEFAULT' })

  const weekDates = (() => {
    const today = new Date()
    const day = today.getDay()
    const diffToMon = day === 0 ? -6 : 1 - day
    const mon = new Date(today)
    mon.setDate(today.getDate() + diffToMon)
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(mon)
      d.setDate(mon.getDate() + i)
      const iso = d.toISOString().slice(0, 10)
      const labels = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']
      return { iso, label: `${labels[i]} (${iso.slice(8, 10)}/${iso.slice(5, 7)})` }
    })
  })()

  const loadWeeklyShifts = useCallback(async () => {
    try {
      const res = await axiosClient.get('/nhansu/phanca', { silent: true })
      const list = Array.isArray(res?.danhSachPhanCa)
        ? res.danhSachPhanCa
        : Array.isArray(res)
        ? res
        : []
      setWeeklyShifts(list)
    } catch {
      // ignore
    }
  }, [])

  const refreshKioskQr = useCallback(async () => {
    try {
      const res = await axiosClient.get('/hr/kiosk-qr-token', { silent: true })
      if (res?.token) {
        const qrDataUrl = await QRCode.toDataURL(res.token, { width: 180, margin: 1 })
        setKioskQr({
          token: res.token,
          qrDataUrl,
          expiresInSec: Number(res.expiresInSec || 30),
          branchId: res.branchId || 'DEFAULT',
        })
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    void loadWeeklyShifts()
    void refreshKioskQr()
    const qrTimer = setInterval(() => void refreshKioskQr(), 30000)
    const tickTimer = setInterval(() => {
      setKioskQr((prev) => ({ ...prev, expiresInSec: Math.max(0, Number(prev.expiresInSec || 0) - 1) }))
    }, 1000)
    return () => {
      clearInterval(qrTimer)
      clearInterval(tickTimer)
    }
  }, [loadWeeklyShifts, refreshKioskQr])

  const handleToggleStaff = async (nv) => {
    const next = nv.trangThaiLamViec === false
    if (!next) {
      setStaffDialog({ kind: 'lock', nv })
      return
    }
    try {
      const res = await nhanSuService.doiTrangThaiNV(nv.maNV, next)
      toast.success(res.message)
      await reloadNhanVien()
    } catch {
      // Interceptor xử lý
    }
  }

  const handleResetPassword = (nv) => {
    setStaffDialog({ kind: 'resetPassword', nv })
  }

  const handleSetManagerPin = (nv) => {
    setStaffDialog({ kind: 'setPin', nv })
  }

  const handleConfirmStaffDialog = async (val) => {
    if (!staffDialog) return
    const { kind, nv } = staffDialog
    setStaffDialog(null)
    try {
      if (kind === 'lock') {
        const res = await nhanSuService.doiTrangThaiNV(nv.maNV, false)
        toast.success(res.message)
        await reloadNhanVien()
      } else if (kind === 'resetPassword') {
        if (!val || val.length < 6) {
          toast.error('Mật khẩu mới phải từ 6 ký tự trở lên!')
          return
        }
        const res = await nhanSuService.datLaiMatKhauNV(nv.maNV, val)
        toast.success(res.message)
      } else if (kind === 'setPin') {
        if (!/^\d{4,6}$/.test(String(val || '').trim())) {
          toast.error('Mã PIN phải gồm 4 đến 6 chữ số!')
          return
        }
        const res = await nhanSuService.datPinNV(nv.maNV, String(val).trim())
        toast.success(res.message)
        await reloadNhanVien()
      }
    } catch {
      // Interceptor xử lý
    }
  }

  const handleToggleShiftSupervisor = async (nv) => {
    const next = !nv.laCaTruong
    try {
      const res = await nhanSuService.capNhatQuyenNV(nv.maNV, { isShiftSupervisor: next })
      toast.success(res.message)
      await reloadNhanVien()
    } catch {
      // Interceptor xử lý
    }
  }

  const handlePhanCa = async (e) => {
    e.preventDefault()
    if (!phanCaForm.maNV || !phanCaForm.maCa) {
      toast.error('Vui lòng chọn nhân viên và ca làm việc!')
      return
    }
    try {
      await nhanSuService.phanCa(phanCaForm)
      const nv = danhSachNV.find((n) => n.maNV === phanCaForm.maNV)
      const ca = danhSachCa.find((c) => c.maCa === phanCaForm.maCa)
      toast.success(
        `Đã xếp ${ca?.tenCa || phanCaForm.maCa} cho ${nv?.tenNV || phanCaForm.maNV}`
      )
    } catch {
      // Interceptor xử lý
    }
  }

  const handleTinhLuong = async (e) => {
    e.preventDefault()
    const thang = Number(luongParams.thang)
    const nam = Number(luongParams.nam)
    const donGia = Number(luongParams.donGiaGio)

    // Tính ngày đầu tháng và cuối tháng để gửi kèm tuNgay/denNgay cho khớp server.js
    const ngayCuoiThang = new Date(nam, thang, 0).getDate()
    const tuNgay = `${nam}-${String(thang).padStart(2, '0')}-01`
    const denNgay = `${nam}-${String(thang).padStart(2, '0')}-${String(ngayCuoiThang).padStart(2, '0')}`

    try {
      const res = await nhanSuService.tinhLuong({
        thang,
        nam,
        tuNgay,
        denNgay,
        luongTheoGio: donGia,
        donGiaGio: donGia,
      })
      setBangLuong(res.bangLuong || [])
      toast.success('Đã tổng hợp bảng lương theo giờ chấm công')
    } catch {
      // Interceptor xử lý
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">
        👥 Quản lý Nhân sự, Tài khoản, Phân ca & Tính lương
      </h1>

      {/* Đường dẫn đăng nhập riêng cho nhân viên quán (Phân hệ 9: tách định danh theo Tenant) */}
      <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="space-y-0.5">
          <p className="font-extrabold text-indigo-950">
            🔗 Đường dẫn đăng nhập riêng của quán (dành cho Thu ngân / Barista / Phục vụ)
          </p>
          <p className="text-indigo-800">
            Mã quán: <code className="font-mono font-bold bg-white px-1.5 py-0.5 rounded border border-indigo-200">{user?.maTienTo || 'DEF'}</code> •{' '}
            Link: <code className="font-mono font-bold text-indigo-900">{shopLoginUrl}</code>
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(shopLoginUrl)
            toast.success('Đã sao chép đường dẫn đăng nhập cho nhân viên!')
          }}
          className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold cursor-pointer shrink-0"
        >
          📋 Sao chép link đăng nhập quán
        </button>
      </div>

      {/* Quản lý tài khoản nhân sự + Khóa tức thì thu hồi JWT/Socket */}
      <div className="bg-white p-5 rounded-2xl shadow-sm space-y-4">
        <h3 className="font-bold text-gray-700">🔐 Danh sách & Tạo Tài khoản Nhân viên</h3>
        <form onSubmit={handleTaoNV} className="grid grid-cols-1 md:grid-cols-6 gap-2.5 text-xs">
          <input
            type="text"
            required
            placeholder="Họ tên nhân viên"
            value={newStaff.tenNV}
            onChange={(e) => setNewStaff({ ...newStaff, tenNV: e.target.value })}
            className="px-3 py-2.5 border rounded-xl"
          />
          <input
            type="text"
            required
            placeholder="Tên đăng nhập"
            value={newStaff.tenDangNhap}
            onChange={(e) => setNewStaff({ ...newStaff, tenDangNhap: e.target.value.toLowerCase() })}
            className="px-3 py-2.5 border rounded-xl font-mono"
          />
          <input
            type="password"
            required
            minLength={6}
            placeholder="Mật khẩu (>=6 ký tự)"
            value={newStaff.matKhau}
            onChange={(e) => setNewStaff({ ...newStaff, matKhau: e.target.value })}
            className="px-3 py-2.5 border rounded-xl"
          />
          <select
            value={newStaff.vaiTro}
            onChange={(e) => setNewStaff({ ...newStaff, vaiTro: Number(e.target.value) })}
            className="px-3 py-2.5 border rounded-xl bg-white"
          >
            <option value={4}>Thu ngân</option>
            <option value={2}>Pha chế (Barista)</option>
            <option value={3}>Phục vụ</option>
            <option value={1}>Quản lý</option>
          </select>
          <input
            type="number"
            min="0"
            step="1000"
            placeholder="Lương/giờ (VNĐ)"
            value={newStaff.mucLuongTheoGio}
            onChange={(e) => setNewStaff({ ...newStaff, mucLuongTheoGio: e.target.value })}
            className="px-3 py-2.5 border rounded-xl"
          />
          <button
            type="submit"
            disabled={creatingNV}
            className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl py-2.5 cursor-pointer"
          >
            {creatingNV ? 'Đang tạo...' : '+ Thêm nhân viên'}
          </button>
        </form>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-gray-50 text-gray-600 uppercase">
              <tr>
                <th className="p-2.5">Mã NV</th>
                <th className="p-2.5">Họ tên</th>
                <th className="p-2.5">Tài khoản</th>
                <th className="p-2.5">Vai trò</th>
                <th className="p-2.5 text-right">Lương/giờ</th>
                <th className="p-2.5">Trạng thái</th>
                <th className="p-2.5 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {tatCaNV.map((nv) => (
                <tr key={nv.maNV} className="hover:bg-gray-50">
                  <td className="p-2.5 font-mono text-[11px]">{nv.maNV}</td>
                  <td className="p-2.5 font-bold text-gray-800">{nv.tenNV}</td>
                  <td className="p-2.5 font-mono text-gray-600">{nv.tenDangNhap || '—'}</td>
                  <td className="p-2.5">
                    <span className="font-semibold">{ROLE_LABEL[nv.vaiTro] || nv.vaiTro}</span>
                    {nv.laCaTruong && Number(nv.vaiTro) !== 1 && (
                      <span
                        className="ml-1.5 px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-indigo-100 text-indigo-800 border border-indigo-300"
                        title="Ca trưởng: Được duyệt PIN hủy món, hoàn tiền, chi lặt vặt & kiểm kê kho nhưng KHÔNG xem được lãi gộp / bảng lương"
                      >
                        🎖️ Ca trưởng
                      </span>
                    )}
                  </td>
                  <td className="p-2.5 text-right">{formatVND(nv.mucLuongTheoGio)}</td>
                  <td className="p-2.5">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${
                        nv.trangThaiLamViec === false
                          ? 'bg-red-100 text-red-700'
                          : 'bg-emerald-100 text-emerald-700'
                      }`}
                    >
                      {nv.trangThaiLamViec === false ? 'ĐÃ KHÓA' : 'ĐANG LÀM'}
                    </span>
                  </td>
                  <td className="p-2.5 text-right">
                    <div className="inline-flex flex-wrap justify-end gap-2">
                    {Number(nv.vaiTro) !== 1 && (
                      <button
                        type="button"
                        onClick={() => handleToggleShiftSupervisor(nv)}
                        className={`min-h-11 px-3 py-2 rounded-xl font-bold cursor-pointer ${
                          nv.laCaTruong
                            ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                            : 'bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border border-indigo-200'
                        }`}
                        title="Cấp/Gỡ quyền Ca trưởng (Duyệt PIN hủy món, hoàn tiền, chi quỹ >50k & kiểm kê mà không lộ báo cáo tài chính/lương)"
                      >
                        {nv.laCaTruong ? '🎖️ Gỡ Ca trưởng' : '🎖️ Phong Ca trưởng'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleSetManagerPin(nv)}
                      className="min-h-11 px-3 py-2 rounded-xl bg-amber-100 hover:bg-amber-200 text-amber-900 font-bold cursor-pointer"
                      title="Đặt mã PIN 4–6 số để đổi nhân viên nhanh trên POS (Quản lý / Ca trưởng kiêm duyệt hủy món O(1))"
                    >
                      🔢 {nv.daDatPin ? 'Đổi PIN' : 'Đặt PIN'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleResetPassword(nv)}
                      className="min-h-11 px-3 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold cursor-pointer"
                    >
                      🔑 Đổi MK
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleStaff(nv)}
                      className={`min-h-11 px-3 py-2 rounded-xl font-bold cursor-pointer ${
                        nv.trangThaiLamViec === false
                          ? 'bg-emerald-100 hover:bg-emerald-200 text-emerald-800'
                          : 'bg-red-100 hover:bg-red-200 text-red-700'
                      }`}
                    >
                      {nv.trangThaiLamViec === false ? '🔓 Mở khóa' : '🔒 Khóa ngay'}
                    </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Form Xếp lịch phân ca */}
      <form onSubmit={handlePhanCa} className="bg-white p-5 rounded-2xl shadow-sm space-y-4">
        <h3 className="font-bold text-gray-700">📅 Xếp lịch Phân ca Nhân viên</h3>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {/* BƯỚC 3A: Select động cho Nhân viên thay vì <input> gõ tay */}
          <select
            required
            disabled={loadingInit || danhSachNV.length === 0}
            value={phanCaForm.maNV}
            onChange={(e) => setPhanCaForm({ ...phanCaForm, maNV: e.target.value })}
            className="px-3 py-2.5 border rounded-xl text-sm bg-white disabled:bg-gray-100"
          >
            {danhSachNV.length === 0 ? (
              <option value="">
                {loadingInit ? 'Đang tải nhân viên...' : 'Chưa có nhân viên'}
              </option>
            ) : (
              danhSachNV.map((nv) => (
                <option key={nv.maNV} value={nv.maNV}>
                  {nv.maNV} - {nv.tenNV} ({ROLE_LABEL[nv.vaiTro] || `Vai trò ${nv.vaiTro}`})
                </option>
              ))
            )}
          </select>

          {/* BƯỚC 3B: Select động cho Ca làm việc thay vì 3 option hardcode */}
          <select
            required
            disabled={loadingInit || danhSachCa.length === 0}
            value={phanCaForm.maCa}
            onChange={(e) => setPhanCaForm({ ...phanCaForm, maCa: e.target.value })}
            className="px-3 py-2.5 border rounded-xl text-sm bg-white disabled:bg-gray-100"
          >
            {danhSachCa.length === 0 ? (
              <option value="">
                {loadingInit ? 'Đang tải ca làm...' : 'Chưa có ca làm việc'}
              </option>
            ) : (
              danhSachCa.map((ca) => (
                <option key={ca.maCa} value={ca.maCa}>
                  {ca.maCa} - {ca.tenCa} ({formatGio(ca.gioBatDau)}–{formatGio(ca.gioKetThuc)})
                </option>
              ))
            )}
          </select>

          <input
            type="date"
            required
            value={phanCaForm.ngayLam}
            onChange={(e) => setPhanCaForm({ ...phanCaForm, ngayLam: e.target.value })}
            className="px-3 py-2.5 border rounded-xl text-sm"
          />

          <button
            type="submit"
            disabled={loadingInit || danhSachNV.length === 0 || danhSachCa.length === 0}
            className="bg-amber-700 hover:bg-amber-800 disabled:bg-gray-300 text-white font-semibold rounded-xl text-sm py-2.5 cursor-pointer"
          >
            + Xếp ca làm việc
          </button>
        </div>
      </form>

      {/* Bảng tính lương tự động */}
      <div className="bg-white p-5 rounded-2xl shadow-sm space-y-4">
        <form onSubmit={handleTinhLuong} className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Tháng</label>
            <input
              type="number"
              min="1"
              max="12"
              value={luongParams.thang}
              onChange={(e) => setLuongParams({ ...luongParams, thang: e.target.value })}
              className="px-3 py-2 border rounded-xl text-sm w-24"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Năm</label>
            <input
              type="number"
              value={luongParams.nam}
              onChange={(e) => setLuongParams({ ...luongParams, nam: e.target.value })}
              className="px-3 py-2 border rounded-xl text-sm w-28"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Đơn giá mặc định / giờ (VND)</label>
            <input
              type="number"
              value={luongParams.donGiaGio}
              onChange={(e) => setLuongParams({ ...luongParams, donGiaGio: e.target.value })}
              className="px-3 py-2 border rounded-xl text-sm w-44"
            />
          </div>
          <button
            type="submit"
            className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl text-sm cursor-pointer"
          >
            Tính lương tự động
          </button>
        </form>

        <table className="w-full text-sm text-left">
          <thead className="bg-gray-50 text-xs uppercase text-gray-600">
            <tr>
              <th className="p-3">Mã NV</th>
              <th className="p-3">Họ tên nhân viên</th>
              <th className="p-3 text-right">Số ca</th>
              <th className="p-3 text-right">Tổng giờ làm thực tế</th>
              <th className="p-3 text-right">Tổng lương nhận</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {bangLuong.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-6 text-center text-gray-400 text-xs">
                  Chọn tháng/năm rồi bấm &ldquo;Tính lương tự động&rdquo; để xem bảng lương
                </td>
              </tr>
            ) : (
              bangLuong.map((nv) => (
                <tr key={nv.maNV}>
                  <td className="p-3 font-mono text-xs">{nv.maNV}</td>
                  <td className="p-3 font-bold">{nv.tenNV}</td>
                  <td className="p-3 text-right">{nv.soCaHoanThanh} ca</td>
                  <td className="p-3 text-right">{nv.tongSoGio.toFixed(2)} giờ</td>
                  <td className="p-3 text-right font-bold text-emerald-700">
                    {formatVND(nv.tongLuong)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* [Wave 3B — P1-04] Mã QR Chấm Công Động (tự đổi mỗi 30 giây) + Bảng Lịch Phân Ca Tuần (NV × 7 ngày) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-4 bg-white rounded-2xl border border-amber-200 p-5 shadow-sm flex flex-col items-center text-center space-y-3">
          <div className="w-full flex items-center justify-between">
            <h2 className="text-sm font-extrabold text-amber-900">🔐 Mã QR Chấm Công Động (30s)</h2>
            <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[11px] font-bold">
              Đổi sau {kioskQr.expiresInSec}s
            </span>
          </div>
          {kioskQr.qrDataUrl ? (
            <img
              src={kioskQr.qrDataUrl}
              alt="Kiosk QR Chấm công động 30 giây"
              className="w-44 h-44 rounded-xl border border-stone-200 p-1 bg-white"
            />
          ) : (
            <div className="w-44 h-44 rounded-xl bg-stone-100 flex items-center justify-center text-xs text-stone-400">
              Đang tạo mã QR...
            </div>
          )}
          <p className="text-[11px] text-stone-500">
            Chống chụp ảnh gửi nhóm chấm công hộ — tự xoay chữ ký HMAC-SHA256 mỗi 30 giây • Chi nhánh: <b>{kioskQr.branchId}</b>
          </p>
          <button
            type="button"
            onClick={() => void refreshKioskQr()}
            className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold cursor-pointer"
          >
            🔄 Làm mới QR ngay
          </button>
        </div>

        <div className="lg:col-span-8 bg-white rounded-2xl border border-stone-200 p-5 shadow-sm space-y-3 overflow-x-auto">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-extrabold text-stone-900">📅 Bảng Lịch Phân Ca Tuần (Nhân viên × 7 ngày)</h2>
            <button
              type="button"
              onClick={() => void loadWeeklyShifts()}
              className="text-xs font-bold text-amber-700 hover:underline cursor-pointer"
            >
              ↻ Tải lại lịch
            </button>
          </div>
          <table className="w-full text-xs border-collapse min-w-[640px]">
            <thead>
              <tr className="bg-stone-100 text-stone-700">
                <th className="p-2 text-left border border-stone-200">Nhân viên</th>
                {weekDates.map((d) => (
                  <th key={d.iso} className="p-2 text-center border border-stone-200">
                    {d.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {nhanVienList.map((nv) => (
                <tr key={nv.maNV} className="hover:bg-stone-50">
                  <td className="p-2 font-bold text-stone-800 border border-stone-200">{nv.tenNV}</td>
                  {weekDates.map((d) => {
                    const matched = weeklyShifts.filter(
                      (s) =>
                        String(s.maNV || s.manv) === String(nv.maNV) &&
                        String(s.ngayLam || s.ngaylam || '').slice(0, 10) === d.iso
                    )
                    return (
                      <td key={d.iso} className="p-1.5 text-center border border-stone-200 align-top">
                        {matched.length === 0 ? (
                          <span className="text-stone-300">—</span>
                        ) : (
                          <div className="space-y-1">
                            {matched.map((m, idx) => (
                              <span
                                key={m.maPhanCa || m.maphanca || idx}
                                className="block px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 font-bold text-[10px]"
                              >
                                {m.tenCa || m.tenca || `Ca #${m.maCa || m.maca}`}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmPinModal
        open={Boolean(staffDialog)}
        mode={staffDialog?.kind === 'lock' ? 'confirm' : 'pin'}
        showKeypad={staffDialog?.kind === 'setPin'}
        danger={staffDialog?.kind === 'lock'}
        title={
          staffDialog?.kind === 'lock'
            ? `Khóa tài khoản "${staffDialog.nv.tenNV}"`
            : staffDialog?.kind === 'resetPassword'
            ? `Đặt lại mật khẩu cho ${staffDialog.nv.tenNV}`
            : staffDialog
            ? `Đặt mã PIN (4–6 số) cho ${staffDialog.nv.tenNV}`
            : ''
        }
        message={
          staffDialog?.kind === 'lock'
            ? `Khóa ngay tài khoản "${staffDialog.nv.tenNV}"? Nhân viên này sẽ bị đăng xuất & ngắt Socket.IO lập tức.`
            : staffDialog?.kind === 'resetPassword'
            ? 'Nhập mật khẩu mới (tối thiểu 6 ký tự):'
            : 'Nhập mã PIN gồm 4–6 chữ số (được che ••••):'
        }
        minLength={staffDialog?.kind === 'resetPassword' ? 6 : staffDialog?.kind === 'setPin' ? 4 : 0}
        confirmText={staffDialog?.kind === 'lock' ? 'Khóa ngay' : 'Lưu thay đổi'}
        onConfirm={handleConfirmStaffDialog}
        onCancel={() => setStaffDialog(null)}
      />
    </div>
  )
}