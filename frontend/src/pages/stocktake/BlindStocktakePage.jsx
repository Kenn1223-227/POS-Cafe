import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { khoService } from '../../services/khoService'
import { useAuthStore } from '../../store/authStore'
import { ROLES, ROLE_LABEL, ROLE_HOME } from '../../constants/roles'
import { useBarcodeScanner } from '../../hooks/useBarcodeScanner'

export default function BlindStocktakePage() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()
  const userRole = Number(user?.vaiTro)

  const [keyOnly, setKeyOnly] = useState(true)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [session, setSession] = useState(null) // { sessionId, thoiDiemBatDau, branchId, recountItems }
  const [rows, setRows] = useState([])
  const [ghiChu, setGhiChu] = useState('Kiểm kho mù 60s cuối ca')
  const [lastResult, setLastResult] = useState(null)

  const startSession = useCallback(
    async (useKeyOnly = keyOnly) => {
      setLoading(true)
      setLastResult(null)
      try {
        const res = await khoService.startBlindStocktake({
          keyOnly: useKeyOnly,
          forceBlind: true,
        })
        const items = Array.isArray(res?.items) ? res.items : []
        setSession({
          sessionId: res.sessionId,
          branchId: res.branchId,
          thoiDiemBatDau: res.thoiDiemBatDau,
          recountItems: null,
        })
        setRows(
          items.map((it) => ({
            maNL: it.maNL,
            tenNL: it.tenNL,
            donViTinh: it.donViTinh,
            isKeyItem: Boolean(it.isKeyItem),
            donViQuyDoi: Array.isArray(it.donViQuyDoi) ? it.donViQuyDoi : [],
            compoundQtys: {},
            soLuong: '',
          }))
        )
        toast.success(`🕵️ Đã mở phiên kiểm kê mù #${res.sessionId} (${items.length} nguyên liệu)!`)
      } catch {
        // axiosClient interceptor thông báo lỗi
      } finally {
        setLoading(false)
      }
    },
    [keyOnly]
  )

  useEffect(() => {
    void startSession(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useBarcodeScanner({
    enabled: Boolean(session?.sessionId) && !submitting,
    onScan: async (code) => {
      try {
        const hit = await khoService.lookupBarcode(code)
        if (!hit?.maNL) return
        setRows((prev) =>
          prev.map((r) => {
            if (r.maNL !== hit.maNL) return r
            const matchedUom = (r.donViQuyDoi || []).find(
              (u) => Number(u.heSoQuyDoi) === Number(hit.heSoQuyDoi)
            )
            const unitKey = matchedUom ? String(matchedUom.id) : '__BASE__'
            const nextMap = {
              ...(r.compoundQtys || {}),
              [unitKey]: String(Number(r.compoundQtys?.[unitKey] || 0) + 1),
            }
            let totalBase = Number(nextMap.__BASE__ || 0)
            for (const u of r.donViQuyDoi || []) {
              totalBase += Number(nextMap[String(u.id)] || 0) * Number(u.heSoQuyDoi || 1)
            }
            return {
              ...r,
              compoundQtys: nextMap,
              soLuong: String(Math.round(totalBase * 1000) / 1000),
            }
          })
        )
        toast.success(`📷 Đã cộng +1 ${hit.tenDonVi || ''} (${hit.tenNL || hit.maNL})`)
      } catch {
        // ignore unknown barcode
      }
    },
  })

  const updateCompoundUnit = (idx, unitKey, val) => {
    setRows((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r
        const nextMap = { ...(r.compoundQtys || {}), [unitKey]: val }
        let totalBase = Number(nextMap.__BASE__ || 0)
        for (const u of r.donViQuyDoi || []) {
          totalBase += Number(nextMap[String(u.id)] || 0) * Number(u.heSoQuyDoi || 1)
        }
        const hasAny = Object.values(nextMap).some((v) => v !== '' && v !== undefined && v !== null)
        return {
          ...r,
          compoundQtys: nextMap,
          soLuong: hasAny ? String(Math.round(totalBase * 1000) / 1000) : '',
        }
      })
    )
  }

  const updateDirectBaseQty = (idx, val) => {
    setRows((prev) =>
      prev.map((r, i) =>
        i === idx
          ? {
              ...r,
              compoundQtys: { ...(r.compoundQtys || {}), __BASE__: val },
              soLuong: val,
            }
          : r
      )
    )
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!session?.sessionId) {
      toast.error('Chưa mở phiên kiểm kê mù!')
      return
    }
    const validRows = rows.filter((r) => r.soLuong !== '' && !Number.isNaN(Number(r.soLuong)) && Number(r.soLuong) >= 0)
    if (validRows.length === 0) {
      toast.error('Vui lòng nhập số lượng đếm thực tế cho ít nhất 1 nguyên liệu!')
      return
    }
    setSubmitting(true)
    try {
      const res = await khoService.submitBlindStocktake({
        sessionId: session.sessionId,
        ghiChu: ghiChu.trim() || 'Kiểm kho mù 60s cuối ca',
        recountConfirmed: Boolean(session.recountItems),
        danhSachNguyenLieu: validRows.map((r) => {
          const uoms = r.donViQuyDoi || []
          const chiTietDonVi = []
          for (const u of uoms) {
            const q = Number(r.compoundQtys?.[String(u.id)] || 0)
            if (q > 0) {
              chiTietDonVi.push({
                tenDonVi: u.tenDonVi,
                soLuong: q,
                heSoQuyDoi: Number(u.heSoQuyDoi || 1),
              })
            }
          }
          const baseVal = Number(r.compoundQtys?.__BASE__ || 0)
          if (chiTietDonVi.length > 0 && baseVal > 0) {
            chiTietDonVi.push({ tenDonVi: r.donViTinh, soLuong: baseVal, heSoQuyDoi: 1 })
          }
          return chiTietDonVi.length > 0
            ? { maNL: r.maNL, chiTietDonVi }
            : { maNL: r.maNL, soLuong: Number(r.soLuong), heSoQuyDoi: 1 }
        }),
      })
      toast.success(res.message || 'Đã nộp phiếu kiểm kê mù!')
      setLastResult(res)
      setSession(null)
    } catch (err) {
      const data = err?.response?.data
      if (err?.response?.status === 422 && data?.code === 'BLIND_STOCK_RECOUNT') {
        setSession((prev) => ({ ...prev, recountItems: data.recountItems || [] }))
        toast.error('⚠️ Một số nguyên liệu có sai lệch lớn — vui lòng cân/đếm lại lần 2 rồi bấm Xác nhận lần 2!', {
          duration: 6000,
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const recountSet = new Set((session?.recountItems || []).map((x) => x.maNL))

  return (
    <div className="min-h-screen bg-stone-100 flex flex-col">
      <header className="sticky top-0 z-30 bg-stone-900 text-white px-4 py-3 flex flex-wrap items-center justify-between gap-2 shadow-md">
        <div className="min-w-0">
          <h1 className="text-base sm:text-lg font-extrabold text-amber-400 truncate">
            🕵️ Kiểm Kê Kho Mù 60s (Cuối Ca)
          </h1>
          <p className="text-xs text-stone-300 truncate">
            {user?.tenNV} • {ROLE_LABEL[userRole] || 'Nhân viên ca'} • Đã ẩn tồn hệ thống &amp; giá vốn
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {[ROLES.QUAN_LY, ROLES.THU_NGAN].includes(userRole) && (
            <button
              type="button"
              onClick={() => navigate('/pos')}
              className="px-3 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-xs font-bold cursor-pointer"
            >
              🖥️ POS
            </button>
          )}
          {[ROLES.QUAN_LY, ROLES.BARISTA].includes(userRole) && (
            <button
              type="button"
              onClick={() => navigate('/barista')}
              className="px-3 py-2 rounded-xl bg-sky-700 hover:bg-sky-600 text-xs font-bold cursor-pointer"
            >
              🍹 KDS Bar
            </button>
          )}
          {userRole === ROLES.QUAN_LY && (
            <button
              type="button"
              onClick={() => navigate('/admin/kho')}
              className="px-3 py-2 rounded-xl bg-stone-700 hover:bg-stone-600 text-xs font-bold cursor-pointer"
            >
              📦 Quản trị Kho
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              logout()
              navigate('/login', { replace: true })
            }}
            className="px-3 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-xs font-bold cursor-pointer"
          >
            Đăng xuất
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto p-3 sm:p-5 space-y-4">
        <div className="bg-white rounded-2xl border border-stone-200 p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-xs font-bold text-stone-700">
              {session?.sessionId
                ? `Phiên đang mở: #${session.sessionId} • Chi nhánh: ${session.branchId}`
                : 'Chưa có phiên kiểm kê đang mở'}
            </p>
            <p className="text-[11px] text-stone-500">
              Hệ thống tự động bù trừ tiêu hao bán hàng phát sinh trong lúc bạn đang cân đếm.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                setKeyOnly(true)
                void startSession(true)
              }}
              className={`px-3 py-2 rounded-xl text-xs font-bold cursor-pointer ${
                keyOnly ? 'bg-amber-600 text-white' : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
              }`}
            >
              ⚡ Key Items (60s)
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                setKeyOnly(false)
                void startSession(false)
              }}
              className={`px-3 py-2 rounded-xl text-xs font-bold cursor-pointer ${
                !keyOnly ? 'bg-amber-600 text-white' : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
              }`}
            >
              📋 Tất cả nguyên liệu
            </button>
          </div>
        </div>

        {session?.recountItems && session.recountItems.length > 0 && (
          <div className="bg-amber-50 border-2 border-amber-400 rounded-2xl p-4 text-amber-900 space-y-1">
            <p className="text-sm font-extrabold">
              ⚠️ Yêu cầu cân/đếm lại lần 2 (Không hiển thị tồn lý thuyết)
            </p>
            <p className="text-xs">
              Vui lòng kiểm tra lại chính xác số lượng thực tế các mã sau:{' '}
              <strong>{session.recountItems.map((x) => x.tenNL).join(', ')}</strong>, sau đó bấm{' '}
              <strong>Xác nhận kiểm đếm lần 2</strong>.
            </p>
          </div>
        )}

        {lastResult && (
          <div className="bg-emerald-50 border border-emerald-300 rounded-2xl p-4 space-y-2">
            <p className="text-sm font-extrabold text-emerald-900">
              {lastResult.message || `✅ Đã ghi nhận phiếu kiểm kê #${lastResult.maGiaoDich}`}
            </p>
            <p className="text-xs text-emerald-800">
              Trạng thái: <strong>{lastResult.trangThaiDuyet}</strong> • Mã phiếu:{' '}
              <strong>#{lastResult.maGiaoDich}</strong>
            </p>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => void startSession(keyOnly)}
                className="px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold cursor-pointer"
              >
                🔄 Mở phiên kiểm mới
              </button>
              <button
                type="button"
                onClick={() => navigate(ROLE_HOME[userRole] || '/pos')}
                className="px-4 py-2 rounded-xl bg-stone-200 hover:bg-stone-300 text-stone-800 text-xs font-bold cursor-pointer"
              >
                Quay lại màn hình làm việc
              </button>
            </div>
          </div>
        )}

        {session && (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-2.5">
              {rows.map((r, idx) => {
                const needRecount = recountSet.has(r.maNL)
                return (
                  <div
                    key={r.maNL}
                    className={`bg-white rounded-2xl border p-4 shadow-sm space-y-3 ${
                      needRecount ? 'border-amber-500 ring-2 ring-amber-200' : 'border-stone-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-extrabold text-stone-900">
                          {r.tenNL}{' '}
                          {r.isKeyItem && (
                            <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold">
                              KEY
                            </span>
                          )}
                          {needRecount && (
                            <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-bold">
                              ĐẾM LẠI LẦN 2
                            </span>
                          )}
                        </p>
                        <p className="text-[11px] text-stone-500">
                          Mã: {r.maNL} • Đơn vị gốc: <strong>{r.donViTinh}</strong>
                        </p>
                      </div>
                      <div className="text-right">
                        <span className="text-[11px] text-stone-500 block">Tổng quy đổi</span>
                        <span className="text-sm font-black text-emerald-700">
                          {r.soLuong !== '' ? `${r.soLuong} ${r.donViTinh}` : '—'}
                        </span>
                      </div>
                    </div>

                    {r.donViQuyDoi.length > 0 ? (
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {r.donViQuyDoi.map((u) => (
                          <label key={u.id} className="block text-xs">
                            <span className="text-[11px] font-semibold text-stone-600 block mb-1">
                              {u.tenDonVi} (×{u.heSoQuyDoi} {r.donViTinh})
                            </span>
                            <input
                              type="number"
                              min="0"
                              step="any"
                              inputMode="decimal"
                              value={r.compoundQtys?.[String(u.id)] ?? ''}
                              onChange={(e) => updateCompoundUnit(idx, String(u.id), e.target.value)}
                              placeholder="0"
                              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm font-bold focus:outline-none focus:border-amber-500"
                            />
                          </label>
                        ))}
                        <label className="block text-xs">
                          <span className="text-[11px] font-semibold text-stone-600 block mb-1">
                            Lẻ ({r.donViTinh})
                          </span>
                          <input
                            type="number"
                            min="0"
                            step="any"
                            inputMode="decimal"
                            value={r.compoundQtys?.__BASE__ ?? ''}
                            onChange={(e) => updateCompoundUnit(idx, '__BASE__', e.target.value)}
                            placeholder="0"
                            className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm font-bold focus:outline-none focus:border-amber-500"
                          />
                        </label>
                      </div>
                    ) : (
                      <label className="block text-xs">
                        <span className="text-[11px] font-semibold text-stone-600 block mb-1">
                          Số lượng thực tế ({r.donViTinh})
                        </span>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          inputMode="decimal"
                          value={r.soLuong}
                          onChange={(e) => updateDirectBaseQty(idx, e.target.value)}
                          placeholder={`Nhập số ${r.donViTinh} thực tế đếm được...`}
                          className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 text-sm font-bold focus:outline-none focus:border-amber-500"
                        />
                      </label>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="bg-white rounded-2xl border border-stone-200 p-4 shadow-sm flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
              <input
                type="text"
                value={ghiChu}
                onChange={(e) => setGhiChu(e.target.value)}
                placeholder="Ghi chú kiểm kê cuối ca..."
                className="flex-1 px-3.5 py-2.5 rounded-xl border border-stone-300 text-xs font-medium"
              />
              <button
                type="submit"
                disabled={submitting || loading}
                className="px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-extrabold shadow cursor-pointer"
              >
                {submitting
                  ? 'Đang nộp phiếu...'
                  : session?.recountItems
                  ? '✅ Xác nhận Kiểm đếm Lần 2'
                  : '📤 Nộp Phiếu Kiểm Kê Mù'}
              </button>
            </div>
          </form>
        )}
      </main>
    </div>
  )
}
