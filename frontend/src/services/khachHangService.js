import axiosClient from '../api/axiosClient'

export const khachHangService = {
  // Chỉ tra cứu theo SĐT (không tự tạo mới)
  traCuu: async (soDienThoai) => {
    const res = await axiosClient.get('/khachhang', { params: { soDienThoai } })
    return res.khachHang // null nếu chưa có
  },

  // Tìm hoặc đăng ký nhanh khách hàng mới
  timHoacTao: async (soDienThoai, tenKH) => {
    const res = await axiosClient.post('/khachhang', { soDienThoai, tenKH })
    const k = res.khachHang
    return {
      message: res.message,
      khachHang: k
        ? {
            maKH: k.maKH ?? k.makh,
            tenKH: k.tenKH ?? k.tenkh,
            soDienThoai: k.soDienThoai ?? k.sodienthoai,
            diemTichLuy: Number(k.diemTichLuy ?? k.diemtichluy ?? 0),
          }
        : null,
    }
  },
}