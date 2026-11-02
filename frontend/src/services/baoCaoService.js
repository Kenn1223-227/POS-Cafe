import axiosClient from '../api/axiosClient'

export const baoCaoService = {
  dashboard: async ({ tuNgay, denNgay }) => {
    const d = await axiosClient.get('/baocao/dashboard', {
      params: { tuNgay, denNgay },
    })
    const tq = d.tongQuan || {}
    return {
      kyBaoCao: d.kyBaoCao || { tuNgay, denNgay },
      tongSoDon: Number(tq.tongSoDon ?? d.tongSoDon ?? 0),
      tongDoanhThu: Number(tq.tongDoanhThu ?? d.tongDoanhThu ?? 0),
      tongChiPhiNhapKho: Number(tq.tongChiPhiNhapKho ?? d.chiPhiNhapKho ?? 0),
      loiNhuanTamTinh: Number(tq.loiNhuanTamTinh ?? d.loiNhuanTamTinh ?? 0),
      bieuDoDoanhThu: (d.bieuDoDoanhThu || d.doanhThuTheoNgay || []).map((r) => ({
        ngay: r.ngay,
        soDon: Number(r.soDon ?? r.sodon ?? 0),
        doanhThu: Number(r.doanhThu ?? r.doanhthu ?? 0),
      })),
    }
  },
}