import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { authService } from '../../../services/authService'
import { useAuthStore } from '../../../store/authStore'
import { disconnectSocket } from '../../../socket/socketClient'
import { ROLE_LABEL, ROLE_HOME } from '../../../constants/roles'

const KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫']

export default function PinSwitchModal({ isOpen, onClose, onSwitched }) {
  const { user, setAuth } = useAuthStore()
  const navigate = useNavigate()
  const [staffList, setStaffList] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedMaNV, setSelectedMaNV] = useState('')
  const [pin, setPin] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const loadStaff = useCallback(async () => {
    setLoading(true)
    try {
      const data = await authService.getStaffQuickList()
      const list = Array.isArray(data) ? data : []
      setStaffList(list)
      const firstOther = list.find((s) => s.daDatPin && s.maNV !== user?.maNV) || list.find((s) => s.daDatPin) || list[0]
      setSelectedMaNV(firstOther?.maNV || '')
    } catch {
      // Interceptor đã xử lý
    } finally {
      setLoading(false)
    }
  }, [user?.maNV])

  useEffect(() => {
    if (!isOpen) return undefined
    const t = setTimeout(() => {
      setPin('')
      void loadStaff()
    }, 0)
    return () => clearTimeout(t)
  }, [isOpen, loadStaff])

  if (!isOpen) return null

  const selectedStaff = staffList.find((s) => s.maNV === selectedMaNV) || null

  const handleKeyPress = (k) => {
    if (k === 'C') return setPin('')
    if (k === '⌫') return setPin((p) => p.slice(0, -1))
    setPin((p) => (p.length < 6 ? p + k : p))
  }

  const handleSubmit = async (e) => {
    e?.preventDefault()
    if (!selectedMaNV) {
      toast.error('Vui lòng chọn nhân viên cần chuyển sang!')
      return
    }
    if (!/^\d{4,6}$/.test(pin)) {
      toast.error('Vui lòng nhập mã PIN gồm 4–6 chữ số!')
      return
    }
    setSubmitting(true)
    try {
      const res = await authService.pinSwitch(selectedMaNV, pin)
      // Ngắt socket cũ để mở lại kết nối bằng JWT nhân viên mới
      disconnectSocket()
      setAuth(res.token, res.user)
      toast.success(res.message || `Đã chuyển sang ${res.user.tenNV}!`)
      setPin('')
      onClose()
      if (typeof onSwitched === 'function') onSwitched(res.user)
      // Nếu chuyển sang Barista -> đưa thẳng về KDS; ngược lại giữ POS hoặc về trang mặc định vai trò
      if (Number(res.user.vaiTro) === 2) {
        navigate('/barista', { replace: true })
      } else if (![1, 3, 4].includes(Number(res.user.vaiTro))) {
        navigate(ROLE_HOME[res.user.vaiTro] || '/pos', { replace: true })
      }
    } catch {
      setPin('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-5 shadow-2xl space-y-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b pb-3">
          <div>
            <h3 className="font-extrabold text-base text-stone-900">
              🔄 Chuyển Nhân Viên Nhanh (Mã PIN)
            </h3>
            <p className="text-xs text-stone-500">
              Đang đăng nhập: <b>{user?.tenNV}</b> ({ROLE_LABEL[user?.vaiTro]})
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-stone-100 hover:bg-stone-200 font-bold text-stone-600 cursor-pointer"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <p className="text-center text-xs text-stone-400 py-8">Đang tải danh sách nhân viên...</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <p className="text-xs font-bold text-stone-600">1. Chọn nhân viên nhận máy:</p>
              <div className="grid grid-cols-2 gap-2 max-h-36 overflow-y-auto pr-1">
                {staffList.map((nv) => {
                  const isSel = nv.maNV === selectedMaNV
                  const isCurrent = nv.maNV === user?.maNV
                  return (
                    <button
                      key={nv.maNV}
                      type="button"
                      onClick={() => {
                        setSelectedMaNV(nv.maNV)
                        setPin('')
                      }}
                      className={`p-2.5 rounded-xl border text-left transition cursor-pointer ${
                        isSel
                          ? 'bg-amber-700 text-white border-amber-700 shadow'
                          : 'bg-stone-50 hover:bg-amber-50 border-stone-200 text-stone-800'
                      }`}
                    >
                      <p className="font-extrabold text-xs truncate">
                        {nv.tenNV} {isCurrent ? '(Hiện tại)' : ''}
                      </p>
                      <p className={`text-[10px] mt-0.5 ${isSel ? 'text-amber-100' : 'text-stone-500'}`}>
                        {ROLE_LABEL[nv.vaiTro]} • {nv.daDatPin ? '🔢 Đã có PIN' : '⚠️ Chưa có PIN'}
                      </p>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-bold text-stone-600">
                2. Nhập mã PIN 4–6 số {selectedStaff ? `của ${selectedStaff.tenNV}` : ''}:
              </p>
              <input
                type="password"
                inputMode="numeric"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="• • • •"
                className="w-full py-2.5 text-center text-2xl font-black tracking-[0.6em] bg-stone-50 border-2 border-stone-300 rounded-xl outline-none focus:border-amber-600"
              />
              <div className="grid grid-cols-3 gap-2">
                {KEYPAD.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => handleKeyPress(k)}
                    className={`min-h-12 rounded-xl font-black text-lg border cursor-pointer transition ${
                      k === 'C' || k === '⌫'
                        ? 'bg-stone-100 hover:bg-stone-200 text-stone-700 border-stone-200'
                        : 'bg-white hover:bg-amber-50 text-stone-900 border-stone-300 shadow-2xs'
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>

            {selectedStaff && !selectedStaff.daDatPin && (
              <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-2.5">
                ⚠️ Nhân viên này chưa có mã PIN. Quản lý hãy vào <b>Admin → Nhân sự → 🔢 Đặt PIN</b> để cấp PIN 4–6 số.
              </p>
            )}

            <button
              type="submit"
              disabled={submitting || pin.length < 4 || !selectedStaff?.daDatPin}
              className="w-full min-h-12 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white font-extrabold rounded-xl text-sm shadow cursor-pointer"
            >
              {submitting ? 'Đang xác thực PIN...' : '🔓 Xác nhận đổi nhân viên'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
