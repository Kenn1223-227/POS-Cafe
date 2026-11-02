import { useState } from 'react'
import toast from 'react-hot-toast'
import { khachHangService } from '../../../services/khachHangService'

export default function CustomerBox({ customer, onSelectCustomer }) {
  const [soDienThoai, setSoDienThoai] = useState('')
  const [tenKH, setTenKH] = useState('')
  const [needRegister, setNeedRegister] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSearch = async (e) => {
    e.preventDefault()
    const sdt = soDienThoai.trim()
    if (!sdt) {
      toast.error('Vui lòng nhập số điện thoại khách hàng')
      return
    }
    setLoading(true)
    try {
      if (!needRegister) {
        const kh = await khachHangService.traCuu(sdt)
        if (kh) {
          onSelectCustomer(kh)
          toast.success(`Đã chọn KH: ${kh.tenKH}`)
          setNeedRegister(false)
        } else {
          setNeedRegister(true)
          toast('Chưa có SĐT này, hãy nhập tên để đăng ký nhanh!', { icon: '📝' })
        }
      } else {
        if (!tenKH.trim()) {
          toast.error('Vui lòng nhập tên khách hàng mới')
          return
        }
        const res = await khachHangService.timHoacTao(sdt, tenKH.trim())
        onSelectCustomer(res.khachHang)
        toast.success(res.message || 'Đăng ký khách hàng thành công')
        setNeedRegister(false)
        setTenKH('')
      }
    } catch {
      // Interceptor đã báo lỗi
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-amber-50/90 border border-amber-200 rounded-2xl p-3.5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-extrabold uppercase text-amber-900">
          👤 Khách hàng thân thiết (Tích điểm)
        </span>
        {customer && (
          <button
            type="button"
            onClick={() => {
              onSelectCustomer(null)
              setSoDienThoai('')
              setNeedRegister(false)
            }}
            className="text-xs text-red-600 font-semibold hover:underline cursor-pointer"
          >
            Bỏ gắn KH
          </button>
        )}
      </div>

      {customer ? (
        <div className="bg-white p-2.5 rounded-xl border border-amber-200 flex items-center justify-between text-xs">
          <div>
            <p className="font-bold text-gray-800 text-sm">{customer.tenKH}</p>
            <p className="text-gray-500">
              SĐT: {customer.soDienThoai} • Mã: {customer.maKH}
            </p>
          </div>
          <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-900 font-extrabold">
            ⭐ {customer.diemTichLuy} điểm
          </span>
        </div>
      ) : (
        <form onSubmit={handleSearch} className="space-y-2">
          <div className="flex gap-2">
            <input
              type="tel"
              value={soDienThoai}
              onChange={(e) => {
                setSoDienThoai(e.target.value)
                setNeedRegister(false)
              }}
              placeholder="Nhập SĐT khách hàng..."
              className="flex-1 px-3 py-2 bg-white rounded-xl border border-gray-300 text-xs outline-none focus:ring-2 focus:ring-amber-600"
            />
            <button
              type="submit"
              disabled={loading}
              className="px-3.5 py-2 bg-amber-700 hover:bg-amber-800 text-white text-xs font-bold rounded-xl cursor-pointer shrink-0"
            >
              {loading ? '...' : needRegister ? 'Đăng ký' : 'Tra cứu'}
            </button>
          </div>

          {needRegister && (
            <input
              type="text"
              value={tenKH}
              onChange={(e) => setTenKH(e.target.value)}
              placeholder="Nhập họ tên khách hàng mới..."
              className="w-full px-3 py-2 bg-white rounded-xl border border-amber-400 text-xs outline-none"
              autoFocus
            />
          )}
        </form>
      )}
    </div>
  )
}