import axiosClient from '../api/axiosClient'

export const orderService = {
  // Tạo order mới hoặc gọi thêm món vào bàn đang mở
  create: ({ maBan, maKH, danhSachMon }) =>
    axiosClient.post('/order', { maBan, maKH, danhSachMon }),

  // Lấy hóa đơn đang mở (TrangThaiTT = 0) của 1 bàn
  getByTable: async (maBan) => {
    const res = await axiosClient.get(`/ban/${maBan}/hoadon`)
    return res.hoaDon // null nếu bàn trống
  },

  // Chi tiết 1 hóa đơn theo mã
  getById: async (maHoaDon) => {
    const res = await axiosClient.get(`/hoadon/${maHoaDon}`)
    return res.hoaDon
  },

  // Thanh toán hóa đơn: phuongThucTT = 'TIEN_MAT' | 'CHUYEN_KHOAN' | 'THE'
  thanhToan: ({ maHoaDon, phuongThucTT, maKH, tienKhachDua }) =>
    axiosClient.post('/order/thanhtoan', {
      maHoaDon,
      phuongThucTT,
      maKH,
      tienKhachDua,
    }),

  // Danh sách topping đang kinh doanh
  getToppings: () => axiosClient.get('/topping'),

  // Barista & Waiter APIs
  getDangCho: () => axiosClient.get('/order/dangcho'),
  nhanLam: (maCTHD) => axiosClient.put('/order/danglam', { maCTHD }),
  traMon: (maCTHD) => axiosClient.put('/order/tramon', { maCTHD }),
  getChoPhucVu: () => axiosClient.get('/order/chophucvu'),
  xacNhanPhucVu: (maCTHD) => axiosClient.put('/order/phucvu', { maCTHD }),
}