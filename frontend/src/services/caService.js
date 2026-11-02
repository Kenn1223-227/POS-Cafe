import axiosClient from '../api/axiosClient'

export const caService = {
  // --- Thao tác Ca của Thu ngân (POS) ---
  getCaHienTai: async () => {
    const res = await axiosClient.get('/ca/hientai')
    return res.caHienTai
  },

  moCa: (tienMatDauCa) =>
    axiosClient.post('/ca/mo', { tienMatDauCa: Number(tienMatDauCa || 0) }),

  thuChi: (body) => axiosClient.post('/ca/thuchi', body),

  getDanhSachThuChi: (maCaThuNgan) =>
    axiosClient.get('/ca/thuchi', { params: maCaThuNgan ? { maCaThuNgan } : {} }),

  doiSoat: (params) => axiosClient.get('/ca/doisoat', { params }),

  dongCa: (tienMatThucTe) =>
    axiosClient.post('/ca/dong', { tienMatThucTe: Number(tienMatThucTe) }),

  // --- Thao tác Lịch sử Ca của Quản lý (Admin) ---
  getDanhSachCa: (tuNgay, denNgay) =>
    axiosClient.get('/ca/danhsach', { params: { tuNgay, denNgay } }),
}