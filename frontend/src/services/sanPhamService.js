import axiosClient from '../api/axiosClient'

export const sanPhamService = {
  // POS: Lấy thực đơn đang kinh doanh (kèm cờ tamHet 86'ing)
  getMenu: () => axiosClient.get('/sanpham'),

  // Quản lý: Lấy toàn bộ thực đơn (gồm cả món ngừng bán & tạm hết)
  getQuanLy: () => axiosClient.get('/sanpham/quanly'),

  create: (body) => axiosClient.post('/sanpham', body),

  update: (maMon, body) => axiosClient.put(`/sanpham/${maMon}`, body),

  remove: (maMon) => axiosClient.delete(`/sanpham/${maMon}`),

  // [P1] Barista / Quản lý bật-tắt nhanh trạng thái Tạm hết (86'ing)
  setTamHet: (maMon, tamHet) => axiosClient.put(`/sanpham/${maMon}/tamhet`, { tamHet }),

  // Quản lý: Tra cứu công thức định lượng của 1 món
  getCongThuc: (maMon) => axiosClient.get(`/congthuc/${maMon}`),

  // Quản lý: Lưu công thức định lượng nguyên liệu cho món (size S, M, L)
  saveCongThuc: (body) => axiosClient.post('/congthuc', body),

  // [P1] Quản lý Topping & Định lượng Công thức đa nguyên liệu (Topping_CongThuc)
  getToppingQuanLy: () => axiosClient.get('/topping/quanly'),

  createTopping: (body) => axiosClient.post('/topping', body),

  saveToppingCongThuc: (maTopping, dinhMuc) =>
    axiosClient.post(`/topping/${encodeURIComponent(maTopping)}/congthuc`, { dinhMuc }),

  setToppingTamHet: (maTopping, tamHet) =>
    axiosClient.put(`/topping/${encodeURIComponent(maTopping)}/tamhet`, { tamHet }),
}
