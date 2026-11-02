import axiosClient from '../api/axiosClient'

const mapNL = (r) => ({
  maNL: r.maNL ?? r.manl,
  tenNL: r.tenNL ?? r.tennl,
  donViTinh: r.donViTinh ?? r.donvitinh,
  tonKho: Number(r.soLuongTon ?? r.soluongton ?? r.tonkhohientai ?? 0),
  hanMuc: Number(r.hanMucCanhBao ?? r.hanmuccanhbao ?? 0),
  giaVonDonVi: Number(r.giaVonDonVi ?? r.giavondonvi ?? 0),
})

export const khoService = {
  // Danh mục toàn bộ nguyên liệu (Quản lý)
  getAllNguyenLieu: async () => {
    const rows = await axiosClient.get('/kho/nguyenlieu')
    return rows.map(mapNL)
  },

  // Cảnh báo nguyên liệu tồn thấp
  canhBao: async () => {
    const rows = await axiosClient.get('/kho/canhbao')
    return rows.map(mapNL)
  },

  // Lập phiếu nhập kho (LoaiGD = 1)
  nhap: (body) => axiosClient.post('/kho/nhap', body),

  // Lập phiếu xuất hủy (loaiGD = 2) hoặc kiểm kê (loaiGD = 3)
  kiemKe: (body) => axiosClient.post('/kho/kiemke', body),

  // Báo cáo cân đối kho định kỳ
  canDoi: async (tuNgay, denNgay) => {
    const d = await axiosClient.get('/kho/candoi', { params: { tuNgay, denNgay } })
    return (d.canDoiKho || []).map((r) => ({
      ...mapNL(r),
      tongNhap: Number(r.tongnhap ?? r.tongNhap ?? 0),
      tongXuatHuy: Number(r.tongxuathuy ?? r.tongXuatHuy ?? 0),
      chenhLechKiemKe: Number(r.tongchenhlechkiemke ?? r.chenhLechKiemKe ?? 0),
      tongTieuHaoBanHang: Number(r.tongtieuhaobanhang ?? r.tongTieuHaoBanHang ?? 0),
    }))
  },
}