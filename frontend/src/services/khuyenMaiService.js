import axiosClient from '../api/axiosClient'

export const khuyenMaiService = {
  getAll: () => axiosClient.get('/khuyenmai'),

  getDangChay: (config) => axiosClient.get('/khuyenmai/dangchay', config),

  create: (body) => axiosClient.post('/khuyenmai', body),

  toggleTrangThai: (id, dangHoatDong) =>
    axiosClient.put(`/khuyenmai/${id}/trangthai`, { dangHoatDong }),

  remove: (id) => axiosClient.delete(`/khuyenmai/${id}`),

  kiemTra: ({ tongTamTinh, maKhuyenMai = null, maKH = null, diemSuDung = 0, tuDongHappyHour = true }) =>
    axiosClient.post('/khuyenmai/kiemtra', {
      tongTamTinh,
      maKhuyenMai: maKhuyenMai || null,
      maKH: maKH || null,
      diemSuDung: Number(diemSuDung || 0),
      tuDongHappyHour,
    }),
}
