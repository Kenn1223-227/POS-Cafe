import { create } from 'zustand'

const CART_STORAGE_PREFIX = 'pos_active_cart_v3'
const HELD_STORAGE_PREFIX = 'pos_held_orders_v1'

export function resolveActiveTenantId(overrideTenantId) {
  if (overrideTenantId && String(overrideTenantId).trim()) {
    return String(overrideTenantId).trim()
  }
  try {
    const raw = localStorage.getItem('pos_user')
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed?.tenantId) return String(parsed.tenantId).trim()
    }
  } catch {
    // ignore
  }
  return 'DEFAULT'
}

export function getCartStorageKey(tenantId) {
  return `${CART_STORAGE_PREFIX}:${resolveActiveTenantId(tenantId)}`
}

export function getHeldStorageKey(tenantId) {
  return `${HELD_STORAGE_PREFIX}:${resolveActiveTenantId(tenantId)}`
}

const loadJson = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

const saveJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Bỏ qua nếu đầy storage
  }
}

// [Trụ cột 2 - 100/100] Khóa gộp dòng định danh chuẩn (lineSignature) theo Topping-per-Cup, Modifiers, Takeaway & Combo
export function buildCartLineSignature(item) {
  const modsKey = (item.modifiers || [])
    .map((m) => `${m.groupId}:${m.optionId}:${m.qty || 1}`)
    .sort()
    .join('|')
  const tpKey = (item.toppings || [])
    .map((t) => `${t.maTopping}:${t.soLuongMoiLy ?? t.soLuong ?? 1}`)
    .sort()
    .join('|')
  const noteKey = String(item.ghiChu || '').trim().toLowerCase()
  const takeKey = item.isTakeaway ? 'TA' : 'DI'
  const courseKey = `C${item.courseNo || 1}_${item.fireStatus || 'FIRED'}`
  const comboKey = item.comboInstanceId || 'SINGLE'
  return `${comboKey}__${item.maMon}__${item.kichThuoc}__${takeKey}__${courseKey}__${modsKey}__${tpKey}__${noteKey}`
}

export const buildCartKey = buildCartLineSignature

function normalizeCartItem(item) {
  const toppings = (item.toppings || []).map((t) => {
    const perCup = Math.max(1, Number(t.soLuongMoiLy ?? t.soLuong ?? 1))
    return {
      ...t,
      soLuongMoiLy: perCup,
      soLuong: perCup,
    }
  })
  const normalized = {
    ...item,
    soLuong: Math.max(1, Number(item.soLuong || 1)),
    donGia: Number(item.donGia || 0),
    giaModifiers: Number(item.giaModifiers || 0),
    modifiers: Array.isArray(item.modifiers) ? item.modifiers : [],
    isTakeaway: Boolean(item.isTakeaway),
    courseNo: Math.max(1, Number(item.courseNo || 1)),
    fireStatus: item.fireStatus === 'HELD' ? 'HELD' : 'FIRED',
    toppings,
  }
  return {
    ...normalized,
    cartKey: buildCartLineSignature(normalized),
  }
}

export const usePosStore = create((set, get) => ({
  selectedTable: null,
  orderType: 'MANG_DI', // 'TAI_QUAN' | 'MANG_DI' | 'GIAO_HANG'
  tenKhachVangLai: '',
  diaChiGiao: '',
  soKhach: 1,
  tenantScope: resolveActiveTenantId(),
  activeInvoice: null,
  customer: null,
  cart: loadJson(getCartStorageKey(), []),
  heldOrders: loadJson(getHeldStorageKey(), []),
  currentShift: null,

  syncTenantStorage: (tenantId) => {
    const nextTenant = resolveActiveTenantId(tenantId)
    if (get().tenantScope === nextTenant) return
    set({
      tenantScope: nextTenant,
      selectedTable: null,
      activeInvoice: null,
      customer: null,
      cart: loadJson(getCartStorageKey(nextTenant), []),
      heldOrders: loadJson(getHeldStorageKey(nextTenant), []),
    })
  },

  setCurrentShift: (shift) => set({ currentShift: shift }),

  setOrderType: (orderType) =>
    set((state) => ({
      orderType,
      selectedTable: orderType === 'TAI_QUAN' ? state.selectedTable : null,
      activeInvoice: orderType === 'TAI_QUAN' ? state.activeInvoice : null,
    })),

  setTenKhachVangLai: (tenKhachVangLai) => set({ tenKhachVangLai }),
  setDiaChiGiao: (diaChiGiao) => set({ diaChiGiao }),
  setSoKhach: (soKhach) => set({ soKhach: Math.max(1, Number(soKhach || 1)) }),

  // Sửa lỗi rò rỉ ngữ cảnh khách hàng khi chuyển giữa các bàn
  setSelectedTable: (table) =>
    set({
      selectedTable: table,
      orderType: table ? 'TAI_QUAN' : 'MANG_DI',
      activeInvoice: null,
      customer: null,
    }),

  setActiveInvoice: (hoaDon) =>
    set({
      activeInvoice: hoaDon,
      customer: hoaDon?.khachHang || null,
    }),

  setCustomer: (customer) => set({ customer }),

  // 1. Tự động gộp (Auto-Group): chỉ cộng soLuong += 1 khi lineSignature trùng khớp 100%
  addToCart: (rawItem) => {
    const item = normalizeCartItem(rawItem)
    const current = get().cart
    const existingIdx = current.findIndex((i) => (i.cartKey || buildCartLineSignature(i)) === item.cartKey)

    let nextCart
    if (existingIdx > -1) {
      nextCart = [...current]
      nextCart[existingIdx] = {
        ...nextCart[existingIdx],
        soLuong: nextCart[existingIdx].soLuong + item.soLuong,
      }
    } else {
      nextCart = [...current, item]
    }
    saveJson(getCartStorageKey(get().tenantScope), nextCart)
    set({ cart: nextCart })
  },

  replaceCart: (items = []) => {
    const nextCart = (items || []).map(normalizeCartItem)
    saveJson(getCartStorageKey(get().tenantScope), nextCart)
    set({ cart: nextCart })
  },

  updateCartQty: (idx, newQty) => {
    if (newQty <= 0) {
      get().removeFromCart(idx)
      return
    }
    const nextCart = get().cart.map((item, i) => (i === idx ? { ...item, soLuong: newQty } : item))
    saveJson(getCartStorageKey(get().tenantScope), nextCart)
    set({ cart: nextCart })
  },

  updateCartItem: (idx, patch) => {
    const current = get().cart
    if (!current[idx]) return
    const updated = normalizeCartItem({ ...current[idx], ...patch })
    const nextCart = [...current]
    nextCart[idx] = updated
    saveJson(getCartStorageKey(get().tenantScope), nextCart)
    set({ cart: nextCart })
  },

  // Tính lại lineSignature khi sửa ghi chú inline
  updateCartNote: (idx, ghiChu) => {
    const nextCart = get().cart.map((item, i) => {
      if (i !== idx) return item
      const updated = { ...item, ghiChu }
      return { ...updated, cartKey: buildCartLineSignature(updated) }
    })
    saveJson(getCartStorageKey(get().tenantScope), nextCart)
    set({ cart: nextCart })
  },

  // Toggle mang về cho từng ly lẻ trong đơn ngồi bàn
  toggleCartItemTakeaway: (idx) => {
    const current = get().cart
    const target = current[idx]
    if (!target) return
    const updated = normalizeCartItem({ ...target, isTakeaway: !target.isTakeaway })
    const nextCart = [...current]
    nextCart[idx] = updated
    saveJson(getCartStorageKey(get().tenantScope), nextCart)
    set({ cart: nextCart })
  },

  // Toggle Course 2 (Chờ gọi ra sau)
  toggleCartItemHoldCourse: (idx) => {
    const current = get().cart
    const target = current[idx]
    if (!target) return
    const nextHeld = target.fireStatus !== 'HELD'
    const updated = normalizeCartItem({
      ...target,
      courseNo: nextHeld ? 2 : 1,
      fireStatus: nextHeld ? 'HELD' : 'FIRED',
    })
    const nextCart = [...current]
    nextCart[idx] = updated
    saveJson(getCartStorageKey(get().tenantScope), nextCart)
    set({ cart: nextCart })
  },

  // 2. Tách nhanh 1 ly (✂️ Tách 1): giảm dòng cũ -1, sinh ngay dòng mới soLuong = 1 ở bên dưới
  splitCartItem: (idx) => {
    const current = get().cart
    const target = current[idx]
    if (!target || target.soLuong <= 1) return -1
    const nextCart = [...current]
    nextCart[idx] = { ...target, soLuong: target.soLuong - 1 }
    const splitCopy = {
      ...target,
      soLuong: 1,
      modifiers: (target.modifiers || []).map((m) => ({ ...m })),
      toppings: (target.toppings || []).map((t) => ({ ...t })),
    }
    splitCopy.cartKey = `${buildCartLineSignature(splitCopy)}#S${Date.now()}`
    nextCart.splice(idx + 1, 0, splitCopy)
    saveJson(getCartStorageKey(get().tenantScope), nextCart)
    set({ cart: nextCart })
    return idx + 1
  },

  // 3. Nhân bản dòng (📋 +1 giống): copy nguyên bản toàn bộ Size + Modifiers + Toppings sang dòng mới để sửa nhanh 1 thuộc tính
  cloneCartItem: (idx) => {
    const current = get().cart
    const target = current[idx]
    if (!target) return -1
    const nextCart = [...current]
    const cloned = {
      ...target,
      soLuong: 1,
      modifiers: (target.modifiers || []).map((m) => ({ ...m })),
      toppings: (target.toppings || []).map((t) => ({ ...t })),
    }
    cloned.cartKey = `${buildCartLineSignature(cloned)}#C${Date.now()}`
    nextCart.splice(idx + 1, 0, cloned)
    saveJson(getCartStorageKey(get().tenantScope), nextCart)
    set({ cart: nextCart })
    return idx + 1
  },

  removeFromCart: (idx) => {
    const nextCart = get().cart.filter((_, i) => i !== idx)
    saveJson(getCartStorageKey(get().tenantScope), nextCart)
    set({ cart: nextCart })
  },

  clearCart: () => {
    saveJson(getCartStorageKey(get().tenantScope), [])
    set({ cart: [] })
  },

  // Lưu tạm cục bộ (fallback khi offline; online ưu tiên DB /api/order/luu-tam đa thiết bị)
  holdCurrentOrder: (label) => {
    const { cart, customer, selectedTable, heldOrders } = get()
    if (cart.length === 0) return false
    const entry = {
      id: `HOLD-${Date.now()}`,
      label: label || customer?.tenKH || selectedTable?.tenBan || `Khách tạm #${heldOrders.length + 1}`,
      createdAt: new Date().toISOString(),
      cart,
      customer,
      selectedTable,
    }
    const nextHeld = [entry, ...heldOrders].slice(0, 15)
    saveJson(getHeldStorageKey(get().tenantScope), nextHeld)
    saveJson(getCartStorageKey(get().tenantScope), [])
    set({ heldOrders: nextHeld, cart: [], customer: null })
    return true
  },

  restoreHeldOrder: (holdId) => {
    const { heldOrders } = get()
    const target = heldOrders.find((h) => h.id === holdId)
    if (!target) return
    const nextHeld = heldOrders.filter((h) => h.id !== holdId)
    saveJson(getHeldStorageKey(get().tenantScope), nextHeld)
    saveJson(getCartStorageKey(get().tenantScope), target.cart)
    set({
      heldOrders: nextHeld,
      cart: target.cart,
      customer: target.customer || null,
      selectedTable: target.selectedTable || null,
    })
  },

  deleteHeldOrder: (holdId) => {
    const nextHeld = get().heldOrders.filter((h) => h.id !== holdId)
    saveJson(getHeldStorageKey(get().tenantScope), nextHeld)
    set({ heldOrders: nextHeld })
  },
}))
