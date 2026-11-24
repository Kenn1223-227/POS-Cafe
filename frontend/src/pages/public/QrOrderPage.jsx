import { useState, useEffect, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { ecosystemService } from '../../services/ecosystemService'
import { formatVND } from '../../utils/format'

export default function QrOrderPage() {
  const { tenantSlug, tableToken } = useParams()
  const [loading, setLoading] = useState(true)
  const [errorState, setErrorState] = useState(null)
  const [data, setData] = useState(null)
  const [activeCat, setActiveCat] = useState('Tất cả')
  const [search, setSearch] = useState('')
  const [picking, setPicking] = useState(null)
  const [pickSize, setPickSize] = useState('M')
  const [pickToppings, setPickToppings] = useState([])
  const [pickModifiers, setPickModifiers] = useState({})
  const [pickNote, setPickNote] = useState('')
  const [cart, setCart] = useState([])
  const [showCheckout, setShowCheckout] = useState(false)
  const [tenKhach, setTenKhach] = useState('')
  const [soDienThoai, setSoDienThoai] = useState('')
  const [ghiChuChung, setGhiChuChung] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submittedOrder, setSubmittedOrder] = useState(null)

  useEffect(() => {
    let mounted = true
    const fetchMenu = async () => {
      setLoading(true)
      setErrorState(null)
      try {
        const res = await ecosystemService.getPublicQrMenu(tenantSlug, tableToken)
        if (mounted) setData(res)
      } catch (err) {
        if (mounted) {
          setErrorState({
            code: err?.response?.data?.code || 'ERROR',
            message:
              err?.response?.data?.message ||
              'Không tải được thực đơn QR. Vui lòng kiểm tra kết nối hoặc liên hệ thu ngân!',
          })
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    void fetchMenu()
    return () => {
      mounted = false
    }
  }, [tenantSlug, tableToken])

  const categories = useMemo(() => {
    const items = data?.menu || []
    return ['Tất cả', ...new Set(items.map((m) => m.nhomMon || 'Khác'))]
  }, [data])

  const filteredMenu = useMemo(() => {
    const items = data?.menu || []
    return items.filter((m) => {
      const okCat = activeCat === 'Tất cả' || (m.nhomMon || 'Khác') === activeCat
      const okSearch = !search.trim() || m.tenMon.toLowerCase().includes(search.trim().toLowerCase())
      return okCat && okSearch
    })
  }, [data, activeCat, search])

  const cartTotal = useMemo(
    () =>
      cart.reduce((sum, item) => {
        const tpSum = (item.toppings || []).reduce((t, x) => t + x.giaTopping * x.soLuong, 0)
        const modSum = Number(item.giaModifiers || 0)
        return sum + (item.donGia + tpSum + modSum) * item.soLuong
      }, 0),
    [cart]
  )
  const cartCount = useMemo(() => cart.reduce((s, i) => s + i.soLuong, 0), [cart])

  const openPicker = (product) => {
    if (product.tamHet) return
    setPicking(product)
    setPickSize(product.sizes.find((s) => s.kichThuoc === 'M')?.kichThuoc || product.sizes[0]?.kichThuoc || 'M')
    setPickToppings([])
    const defaultMods = {}
    for (const grp of product.modifierGroups || []) {
      for (const opt of grp.options || []) {
        if (opt.laMacDinh && !opt.tamHet) {
          defaultMods[opt.id] = { ...opt, groupId: grp.id, tenGroup: grp.tenGroup, qty: 1 }
        }
      }
    }
    setPickModifiers(defaultMods)
    setPickNote('')
  }

  const toggleModifierOption = (grp, opt) => {
    if (opt.tamHet) return
    setPickModifiers((prev) => {
      const next = { ...prev }
      const isSingle = grp.loai === 'SINGLE' || grp.chonToiDa === 1
      if (isSingle) {
        for (const o of grp.options || []) {
          delete next[o.id]
        }
        next[opt.id] = { ...opt, groupId: grp.id, tenGroup: grp.tenGroup, qty: 1 }
        return next
      }
      if (next[opt.id]) {
        delete next[opt.id]
        return next
      }
      const selectedInGroup = Object.values(next).filter((x) => x.groupId === grp.id).length
      if (selectedInGroup >= (grp.chonToiDa || 1)) {
        toast.error(`Nhóm "${grp.tenGroup}" chỉ được chọn tối đa ${grp.chonToiDa} tùy chọn!`)
        return prev
      }
      next[opt.id] = { ...opt, groupId: grp.id, tenGroup: grp.tenGroup, qty: 1 }
      return next
    })
  }

  const adjustModifierQty = (opt, delta) => {
    setPickModifiers((prev) => {
      const cur = prev[opt.id]
      if (!cur) return prev
      const nextQty = (cur.qty || 1) + delta
      const maxQty = Math.max(1, Number(opt.toiDaSoLuong || 1))
      const next = { ...prev }
      if (nextQty <= 0) {
        delete next[opt.id]
      } else {
        next[opt.id] = { ...cur, qty: Math.min(maxQty, nextQty) }
      }
      return next
    })
  }

  const quickAddUpsell = (u) => {
    const prod = (data?.menu || []).find((m) => m.maMon === u.maMon)
    if (!prod || prod.tamHet) return
    const sz = prod.sizes.find((s) => s.kichThuoc === u.kichThuoc) || prod.sizes[0]
    setCart((prev) => [
      ...prev,
      {
        uid: `${prod.maMon}_${sz.kichThuoc}_${Date.now()}`,
        maMon: prod.maMon,
        tenMon: prod.tenMon,
        kichThuoc: sz.kichThuoc,
        donGia: sz.giaBan,
        soLuong: 1,
        toppings: [],
        ghiChu: '',
      },
    ])
    toast.success(`Đã thêm ${prod.tenMon}!`)
  }

  const confirmAddPick = () => {
    if (!picking) return
    const selectedMods = Object.values(pickModifiers)
    for (const grp of picking.modifierGroups || []) {
      const minRequired = grp.batBuoc ? Math.max(1, Number(grp.chonToiThieu || 1)) : Number(grp.chonToiThieu || 0)
      if (minRequired > 0) {
        const count = selectedMods.filter((m) => m.groupId === grp.id).length
        if (count < minRequired) {
          toast.error(`Vui lòng chọn ít nhất ${minRequired} tùy chọn cho "${grp.tenGroup}"!`)
          return
        }
      }
    }
    const giaModifiers = selectedMods.reduce((s, m) => s + Number(m.giaThem || 0) * Number(m.qty || 1), 0)
    const sz = picking.sizes.find((s) => s.kichThuoc === pickSize) || picking.sizes[0]
    setCart((prev) => [
      ...prev,
      {
        uid: `${picking.maMon}_${sz.kichThuoc}_${Date.now()}`,
        maMon: picking.maMon,
        tenMon: picking.tenMon,
        kichThuoc: sz.kichThuoc,
        donGia: sz.giaBan,
        giaModifiers,
        soLuong: 1,
        toppings: pickToppings.map((t) => ({ ...t, soLuong: 1 })),
        modifiers: selectedMods.map((m) => ({
          optionId: m.id,
          tenOption: m.tenOption,
          giaThem: Number(m.giaThem || 0),
          qty: Number(m.qty || 1),
        })),
        ghiChu: pickNote.trim(),
      },
    ])
    toast.success(`Đã thêm ${picking.tenMon} (${sz.kichThuoc})`)
    setPicking(null)
  }

  const updateCartQty = (uid, delta) => {
    setCart((prev) =>
      prev
        .map((it) => (it.uid === uid ? { ...it, soLuong: it.soLuong + delta } : it))
        .filter((it) => it.soLuong > 0)
    )
  }

  const handleSubmitQrOrder = async (e) => {
    e.preventDefault()
    if (cart.length === 0) return
    setSubmitting(true)
    try {
      const res = await ecosystemService.submitPublicQrOrder(tenantSlug, tableToken, {
        tenKhach: tenKhach.trim(),
        soDienThoai: soDienThoai.trim(),
        ghiChu: ghiChuChung.trim(),
        danhSachMon: cart.map((c) => ({
          maMon: c.maMon,
          kichThuoc: c.kichThuoc,
          soLuong: c.soLuong,
          ghiChu: c.ghiChu,
          toppings: c.toppings.map((t) => ({ maTopping: t.maTopping, soLuong: t.soLuong })),
          modifiers: (c.modifiers || []).map((m) => ({ optionId: m.optionId, qty: m.qty })),
        })),
      })
      setSubmittedOrder(res.order)
      setCart([])
      setShowCheckout(false)
      toast.success(res.message || 'Đã gửi đơn thành công!')
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Gửi đơn thất bại, vui lòng thử lại!')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-50 flex flex-col items-center justify-center p-6 text-center">
        <div className="w-12 h-12 rounded-full border-4 border-amber-600 border-t-transparent animate-spin mb-4" />
        <p className="text-sm font-bold text-stone-700">Đang tải thực đơn QR tại bàn...</p>
      </div>
    )
  }

  if (errorState) {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center p-5">
        <div className="bg-white max-w-md w-full rounded-3xl p-6 shadow-xl border border-amber-200 text-center space-y-3">
          <div className="text-5xl">{errorState.code === 'QR_TOKEN_ROTATED' ? '🛡️' : '☕'}</div>
          <h1 className="text-lg font-black text-stone-900">
            {errorState.code === 'QR_TOKEN_ROTATED'
              ? 'Mã QR bàn đã tự động đổi mới'
              : 'Không thể mở thực đơn QR'}
          </h1>
          <p className="text-xs text-stone-600 leading-relaxed">{errorState.message}</p>
          <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-2.5 font-semibold">
            Cơ chế chống phá hoại 3 lớp: Mã QR bàn tự động xoay sau mỗi lượt thanh toán để bảo vệ quán.
          </p>
        </div>
      </div>
    )
  }

  const { tenant, table, antiSpamPolicy, upsells = [], toppings = [] } = data

  return (
    <div className="min-h-screen bg-stone-50 pb-28 max-w-lg mx-auto shadow-xl border-x border-stone-200">
      {/* Header Quán & Số bàn */}
      <header className="sticky top-0 z-30 bg-stone-900 text-white px-4 py-3.5 shadow-md">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="font-black text-base text-amber-400 truncate">☕ {tenant.tenQuan}</h1>
            <p className="text-xs text-stone-300">
              QR Order Tại Bàn • <b className="text-white">{table.tenBan}</b> ({table.khuVuc})
            </p>
          </div>
          <span
            className={`px-2.5 py-1 rounded-full text-[10px] font-extrabold shrink-0 ${
              table.daMoBan ? 'bg-emerald-600 text-white' : 'bg-amber-600 text-white'
            }`}
          >
            {table.daMoBan ? '🟢 Bàn đã mở' : '🛡️ Chờ duyệt POS'}
          </span>
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm trà sữa, cà phê, bánh ngọt..."
            className="w-full px-3.5 py-2 rounded-xl bg-stone-800 text-white placeholder-stone-400 text-xs outline-none focus:ring-2 focus:ring-amber-500"
          />
        </div>
      </header>

      {/* Banner Anti-Spam 3 lớp */}
      <div className="mx-3 mt-3 p-3 rounded-2xl bg-amber-50 border border-amber-200 text-[11px] text-amber-950 font-medium">
        🛡️ {antiSpamPolicy?.notice}
      </div>

      {/* Trạng thái đơn vừa gửi thành công */}
      {submittedOrder && (
        <div className="mx-3 mt-3 p-4 rounded-2xl bg-emerald-50 border-2 border-emerald-400 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="font-black text-sm text-emerald-900">
              ✅ Đã gửi đơn #{submittedOrder.maDonQr}
            </span>
            <button
              type="button"
              onClick={() => setSubmittedOrder(null)}
              className="text-xs text-stone-500 font-bold"
            >
              Đóng
            </button>
          </div>
          <p className="text-xs text-emerald-800">
            Tổng tạm tính: <b>{formatVND(submittedOrder.tongTienTamTinh)}</b> • Trạng thái:{' '}
            <b>
              {submittedOrder.batBuocThanhToanTruoc
                ? 'Chờ quét VietQR xác thực'
                : 'Đang chờ thu ngân duyệt 1 chạm'}
            </b>
          </p>
          {submittedOrder.batBuocThanhToanTruoc && submittedOrder.vietQrUrl && (
            <div className="bg-white p-3 rounded-xl border border-emerald-200 flex flex-col items-center gap-1.5">
              <img
                src={submittedOrder.vietQrUrl}
                alt="VietQR thanh toán trước"
                className="w-48 h-48 object-contain"
              />
              <p className="text-[11px] font-mono font-bold text-amber-800">
                Nội dung CK: {submittedOrder.noiDungCK}
              </p>
            </div>
          )}
        </div>
      )}

      {/* AI Smart Upsell Strip */}
      {upsells.length > 0 && (
        <section className="px-3 mt-3 space-y-1.5">
          <p className="text-[11px] font-extrabold uppercase text-amber-900">
            ✨ Gợi ý gọi kèm siêu hời
          </p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {upsells.map((u) => (
              <button
                key={u.maMon}
                type="button"
                onClick={() => quickAddUpsell(u)}
                className="shrink-0 px-3 py-2 rounded-xl bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-300 text-left shadow-xs active:scale-95 transition cursor-pointer"
              >
                <p className="text-xs font-extrabold text-amber-950">{u.badgeText}</p>
                <p className="text-[10px] text-amber-800">{u.lyDo}</p>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Danh mục */}
      <div className="px-3 mt-3 flex gap-2 overflow-x-auto pb-1">
        {categories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setActiveCat(cat)}
            className={`shrink-0 px-3.5 py-2 rounded-full text-xs font-bold transition cursor-pointer ${
              activeCat === cat
                ? 'bg-amber-700 text-white shadow'
                : 'bg-white border border-stone-200 text-stone-700'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Danh sách món */}
      <main className="px-3 mt-3 grid grid-cols-1 gap-2.5">
        {filteredMenu.map((item) => {
          const minPrice = Math.min(...item.sizes.map((s) => s.giaBan))
          const origPrice = Math.min(...item.sizes.map((s) => s.giaGoc || s.giaBan))
          return (
            <button
              key={item.maMon}
              type="button"
              disabled={item.tamHet}
              onClick={() => openPicker(item)}
              className={`w-full p-3.5 rounded-2xl bg-white border text-left flex items-center justify-between gap-3 transition ${
                item.tamHet
                  ? 'opacity-50 border-stone-200'
                  : 'border-stone-200 hover:border-amber-500 active:scale-[0.99] cursor-pointer shadow-xs'
              }`}
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-extrabold text-sm text-stone-900">{item.tenMon}</span>
                  {item.bakeryMarkdown && (
                    <span className="px-1.5 py-0.5 rounded-md bg-red-600 text-white text-[10px] font-black">
                      🔥 -{item.bakeryMarkdown.phanTramGiam}% sau {item.bakeryMarkdown.gioGiamGia}h
                    </span>
                  )}
                  {item.tamHet && (
                    <span className="px-1.5 py-0.5 rounded bg-stone-200 text-stone-600 text-[10px] font-bold">
                      Tạm hết
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-stone-500">{item.nhomMon}</p>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-black text-amber-800">{formatVND(minPrice)}</span>
                  {origPrice > minPrice && (
                    <span className="text-xs text-stone-400 line-through">{formatVND(origPrice)}</span>
                  )}
                </div>
              </div>
              <span className="w-9 h-9 rounded-xl bg-amber-700 text-white font-black text-lg flex items-center justify-center shrink-0">
                +
              </span>
            </button>
          )
        })}
      </main>

      {/* Thanh Giỏ hàng dính đáy */}
      {cartCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 max-w-lg mx-auto p-3 bg-white/95 backdrop-blur border-t border-stone-200 shadow-2xl">
          <button
            type="button"
            onClick={() => setShowCheckout(true)}
            className="w-full py-3.5 px-4 rounded-2xl bg-amber-700 hover:bg-amber-800 text-white font-extrabold text-sm flex items-center justify-between shadow-lg cursor-pointer"
          >
            <span>🛒 Xem giỏ ({cartCount} món)</span>
            <span>{formatVND(cartTotal)} →</span>
          </button>
        </div>
      )}

      {/* Modal chọn Size / Topping */}
      {picking && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center">
          <div className="bg-white w-full max-w-lg rounded-t-3xl sm:rounded-3xl p-5 space-y-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="font-black text-base text-stone-900">{picking.tenMon}</h3>
              <button type="button" onClick={() => setPicking(null)} className="text-stone-400 font-bold text-lg">
                ✕
              </button>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-bold text-stone-600">Chọn Size</p>
              <div className="grid grid-cols-3 gap-2">
                {picking.sizes.map((s) => (
                  <button
                    key={s.kichThuoc}
                    type="button"
                    onClick={() => setPickSize(s.kichThuoc)}
                    className={`p-2.5 rounded-xl border-2 text-xs font-bold cursor-pointer ${
                      pickSize === s.kichThuoc
                        ? 'border-amber-700 bg-amber-50 text-amber-900'
                        : 'border-stone-200 text-stone-700'
                    }`}
                  >
                    <div>Size {s.kichThuoc}</div>
                    <div className="font-black mt-0.5">{formatVND(s.giaBan)}</div>
                  </button>
                ))}
              </div>
            </div>

            {(picking.modifierGroups || []).length > 0 && (
              <div className="space-y-3">
                {picking.modifierGroups.map((grp) => (
                  <div key={grp.id} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-stone-700">
                        {grp.tenGroup}{' '}
                        {grp.batBuoc && (
                          <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-extrabold">
                            Bắt buộc
                          </span>
                        )}
                      </span>
                      <span className="text-[10px] text-stone-400">
                        Tối đa {grp.chonToiDa || 1}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(grp.options || []).map((opt) => {
                        const sel = pickModifiers[opt.id]
                        return (
                          <div key={opt.id} className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              disabled={opt.tamHet}
                              onClick={() => toggleModifierOption(grp, opt)}
                              className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition ${
                                opt.tamHet
                                  ? 'opacity-40 bg-stone-100 border-stone-200 text-stone-400 line-through'
                                  : sel
                                  ? 'bg-amber-700 text-white border-amber-700 cursor-pointer'
                                  : 'bg-stone-50 text-stone-700 border-stone-200 cursor-pointer'
                              }`}
                            >
                              {opt.tenOption}
                              {Number(opt.giaThem || 0) > 0 ? ` (+${Math.round(opt.giaThem / 1000)}k)` : ''}
                            </button>
                            {sel && Number(opt.toiDaSoLuong || 1) > 1 && (
                              <div className="inline-flex items-center border border-amber-300 rounded-lg bg-amber-50 text-xs font-extrabold">
                                <button
                                  type="button"
                                  onClick={() => adjustModifierQty(opt, -1)}
                                  className="px-2 py-1 text-amber-900 cursor-pointer"
                                >
                                  -
                                </button>
                                <span className="px-1.5 text-amber-950">{sel.qty}</span>
                                <button
                                  type="button"
                                  onClick={() => adjustModifierQty(opt, 1)}
                                  className="px-2 py-1 text-amber-900 cursor-pointer"
                                >
                                  +
                                </button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {toppings.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-bold text-stone-600">Thêm Topping</p>
                <div className="flex flex-wrap gap-2">
                  {toppings.filter((t) => !t.tamHet).map((tp) => {
                    const selected = pickToppings.some((x) => x.maTopping === tp.maTopping)
                    return (
                      <button
                        key={tp.maTopping}
                        type="button"
                        onClick={() =>
                          setPickToppings((prev) =>
                            selected ? prev.filter((x) => x.maTopping !== tp.maTopping) : [...prev, tp]
                          )
                        }
                        className={`px-3 py-1.5 rounded-xl border text-xs font-bold cursor-pointer ${
                          selected
                            ? 'bg-amber-700 text-white border-amber-700'
                            : 'bg-stone-50 text-stone-700 border-stone-200'
                        }`}
                      >
                        {tp.tenTopping} (+{Math.round(tp.giaTopping / 1000)}k)
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <input
              type="text"
              value={pickNote}
              onChange={(e) => setPickNote(e.target.value)}
              placeholder="Ghi chú (VD: 50% đường, ít đá)..."
              className="w-full px-3 py-2.5 rounded-xl border border-stone-300 text-xs outline-none"
            />

            <button
              type="button"
              onClick={confirmAddPick}
              className="w-full py-3.5 rounded-2xl bg-amber-700 hover:bg-amber-800 text-white font-extrabold text-sm cursor-pointer"
            >
              Thêm vào giỏ
            </button>
          </div>
        </div>
      )}

      {/* Modal Xác nhận Gửi đơn QR */}
      {showCheckout && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center">
          <form
            onSubmit={handleSubmitQrOrder}
            className="bg-white w-full max-w-lg rounded-t-3xl sm:rounded-3xl p-5 space-y-3.5 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-black text-base text-stone-900">
                🧾 Xác nhận đơn — {table.tenBan}
              </h3>
              <button type="button" onClick={() => setShowCheckout(false)} className="text-stone-400 font-bold text-lg">
                ✕
              </button>
            </div>

            <div className="divide-y max-h-52 overflow-y-auto">
              {cart.map((c) => (
                <div key={c.uid} className="py-2 flex items-center justify-between gap-2 text-xs">
                  <div className="min-w-0">
                    <p className="font-bold text-stone-900">
                      {c.tenMon} ({c.kichThuoc})
                    </p>
                    {c.toppings.length > 0 && (
                      <p className="text-[11px] text-amber-800">
                        + {c.toppings.map((t) => t.tenTopping).join(', ')}
                      </p>
                    )}
                    {c.ghiChu && <p className="text-[11px] text-stone-500 italic">{c.ghiChu}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => updateCartQty(c.uid, -1)}
                      className="w-7 h-7 rounded-lg bg-stone-100 font-bold"
                    >
                      -
                    </button>
                    <span className="font-black w-5 text-center">{c.soLuong}</span>
                    <button
                      type="button"
                      onClick={() => updateCartQty(c.uid, 1)}
                      className="w-7 h-7 rounded-lg bg-stone-100 font-bold"
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={tenKhach}
                onChange={(e) => setTenKhach(e.target.value)}
                placeholder="Tên của bạn (tùy chọn)"
                className="px-3 py-2.5 rounded-xl border text-xs outline-none"
              />
              <input
                type="tel"
                value={soDienThoai}
                onChange={(e) => setSoDienThoai(e.target.value)}
                placeholder="SĐT tích điểm (tùy chọn)"
                className="px-3 py-2.5 rounded-xl border text-xs outline-none"
              />
            </div>

            <input
              type="text"
              value={ghiChuChung}
              onChange={(e) => setGhiChuChung(e.target.value)}
              placeholder="Ghi chú chung cho quán..."
              className="w-full px-3 py-2.5 rounded-xl border text-xs outline-none"
            />

            <div className="flex items-center justify-between pt-1 text-sm font-black text-stone-900">
              <span>Tổng tạm tính:</span>
              <span className="text-amber-800">{formatVND(cartTotal)}</span>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3.5 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-sm shadow-lg cursor-pointer disabled:opacity-60"
            >
              {submitting ? 'Đang gửi đơn...' : '🚀 Gửi đơn tới Quầy Thu ngân'}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
