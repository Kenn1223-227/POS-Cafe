import { create } from 'zustand'

const buildCartKey = (item) => {
  const tpKey = (item.toppings || [])
    .map((t) => `${t.maTopping}:${t.soLuong || 1}`)
    .sort()
    .join(',')
  return `${item.maMon}|${item.kichThuoc}|${item.ghiChu || ''}|${tpKey}`
}

export const usePosStore = create((set, get) => ({
  selectedTable: null, // { maBan, tenBan, trangThai, khuVuc } hoặc null (Mang đi)
  activeInvoice: null, // Hóa đơn chưa thanh toán của bàn đang chọn
  customer: null,      // { maKH, tenKH, soDienThoai, diemTichLuy }
  cart: [],            // Danh sách món chuẩn bị gửi lên /api/order
  currentShift: null,  // Thông tin ca thu ngân đang mở

  setCurrentShift: (shift) => set({ currentShift: shift }),

  setSelectedTable: (table) =>
    set({
      selectedTable: table,
      activeInvoice: null,
    }),

  setActiveInvoice: (hoaDon) =>
    set((state) => ({
      activeInvoice: hoaDon,
      customer: hoaDon?.khachHang || state.customer,
    })),

  setCustomer: (customer) => set({ customer }),

  addToCart: (newItem) => {
    const key = buildCartKey(newItem)
    const current = get().cart
    const existingIdx = current.findIndex((i) => i.cartKey === key)

    if (existingIdx > -1) {
      const updated = [...current]
      updated[existingIdx] = {
        ...updated[existingIdx],
        soLuong: updated[existingIdx].soLuong + Number(newItem.soLuong || 1),
      }
      set({ cart: updated })
    } else {
      set({ cart: [...current, { ...newItem, cartKey: key }] })
    }
  },

  updateCartQty: (idx, newQty) => {
    if (newQty <= 0) {
      get().removeFromCart(idx)
      return
    }
    set((state) => ({
      cart: state.cart.map((item, i) =>
        i === idx ? { ...item, soLuong: newQty } : item
      ),
    }))
  },

  updateCartNote: (idx, ghiChu) =>
    set((state) => ({
      cart: state.cart.map((item, i) =>
        i === idx ? { ...item, ghiChu } : item
      ),
    })),

  removeFromCart: (idx) =>
    set((state) => ({
      cart: state.cart.filter((_, i) => i !== idx),
    })),

  clearCart: () => set({ cart: [] }),
}))