import axiosClient from '../api/axiosClient'

export const baoCaoService = {
  dashboard: async ({ tuNgay, denNgay }) => {
    const d = await axiosClient.get('/baocao/dashboard', {
      params: { tuNgay, denNgay },
    })
    const tq = d.tongQuan || {}
    return {
      kyBaoCao: d.kyBaoCao || { tuNgay, denNgay },
      reportLimitDays: Number(d.reportLimitDays ?? -1),
      wasClamped: Boolean(d.wasClamped),
      currentPlan: d.currentPlan || null,
      tongSoDon: Number(tq.tongSoDon ?? d.tongSoDon ?? 0),
      tongDoanhThu: Number(tq.tongDoanhThu ?? d.tongDoanhThu ?? 0),
      tongGiaVon: Number(tq.tongGiaVon ?? 0),
      loiNhuanGop: Number(tq.loiNhuanGop ?? 0),
      tySuatLoiNhuan: Number(tq.tySuatLoiNhuan ?? 0),
      tongChiPhiNhapKho: Number(tq.tongChiPhiNhapKho ?? d.chiPhiNhapKho ?? 0),
      loiNhuanTamTinh: Number(tq.loiNhuanTamTinh ?? d.loiNhuanTamTinh ?? 0),
      bieuDoDoanhThu: (d.bieuDoDoanhThu || d.doanhThuTheoNgay || []).map((r) => ({
        ngay: r.ngay,
        soDon: Number(r.soDon ?? r.sodon ?? 0),
        doanhThu: Number(r.doanhThu ?? r.doanhthu ?? 0),
        giaVon: Number(r.giaVon ?? r.giavon ?? 0),
        loiNhuanGop: Number(r.loiNhuanGop ?? 0),
      })),
      doanhThuTheoPhuongThuc: d.doanhThuTheoPhuongThuc || [],
      topMonBanChay: d.topMonBanChay || [],
    }
  },

  menuEngineering: ({ tuNgay, denNgay }) =>
    axiosClient.get('/baocao/menu-engineering', {
      params: { tuNgay, denNgay },
      silent: true,
    }),
}
