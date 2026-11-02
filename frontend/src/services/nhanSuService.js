import axiosClient from '../api/axiosClient'

export const nhanSuService = {
  // --- Dành cho Nhân viên / Thu ngân ---
  phanCaCuaToi: async (ngayLam) => {
    try {
      const d = await axiosClient.get('/nhansu/phancacuatoi', { params: { ngayLam }, silent: true })
      return d.danhSachPhanCa.map((r) => ({
        maPhanCa: r.maphanca, maCa: r.maca, tenCa: r.tenca,
        gioBatDau: r.giobatdau, gioKetThuc: r.gioketthuc, ngayLam: r.ngaylam, trangThai: r.trangthai,
      }))
    } catch (e) { if (e.response?.status === 404) return []; throw e }
  },

  checkIn: (maPhanCa) => axiosClient.post('/nhansu/chamcong', { maPhanCa }),
  
  checkOut: (maPhanCa) => axiosClient.put('/nhansu/chamcong', { maPhanCa }),

  // --- Dành cho Quản lý (Admin) ---
  getNhanVien: () => axiosClient.get('/nhansu/nhanvien'),

  getCaLamViec: () => axiosClient.get('/nhansu/ca'),

  getPhanCa: (tuNgay, denNgay) =>
    axiosClient.get('/nhansu/phanca', { params: { tuNgay, denNgay } }),

  phanCa: (body) => axiosClient.post('/nhansu/phanca', body),

  tinhLuong: async (params) => {
    const res = await axiosClient.get('/nhansu/tinhluong', { params })
    const list = res.bangLuong || res.danhSachLuong || (Array.isArray(res) ? res : [])
    return {
      ...res,
      bangLuong: list.map((r) => ({
        maNV: r.manv ?? r.maNV,
        tenNV: r.tennv ?? r.tenNV,
        soCaHoanThanh: Number(r.socahoanthanh ?? r.soCaHoanThanh ?? 0),
        tongSoGio: Number(r.tongsogio ?? r.tongSoGio ?? 0),
        tongLuong: Number(r.tongluong ?? r.tongLuong ?? 0),
      })),
    }
  },
}