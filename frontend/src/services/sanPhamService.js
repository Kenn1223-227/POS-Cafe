import axiosClient from '../api/axiosClient'

export const sanPhamService = {
  // POS: Lấy thực đơn đang kinh doanh
  getMenu: () => axiosClient.get('/sanpham'),

  // Quản lý: Lấy toàn bộ thực đơn (gồm cả món ngừng bán)
  getQuanLy: () => axiosClient.get('/sanpham/quanly'),

  create: (body) => axiosClient.post('/sanpham', body),

  update: (maMon, body) => axiosClient.put(`/sanpham/${maMon}`, body),

  remove: (maMon) => axiosClient.delete(`/sanpham/${maMon}`),

  // Quản lý: Tra cứu công thức định lượng của 1 món
  getCongThuc: (maMon) => axiosClient.get(`/congthuc/${maMon}`),

  // Quản lý: Lưu công thức định lượng nguyên liệu cho món (size S, M, L)
  saveCongThuc: (body) => axiosClient.post('/congthuc', body),
}