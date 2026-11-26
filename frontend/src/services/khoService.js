import axiosClient from '../api/axiosClient'

const mapNL = (r) => ({
  maNL: r.maNL ?? r.manl,
  tenNL: r.tenNL ?? r.tennl,
  donViTinh: r.donViTinh ?? r.donvitinh,
  tonKho: r.soLuongTon !== undefined ? Number(r.soLuongTon) : r.soluongton !== undefined ? Number(r.soluongton) : r.tonkhohientai !== undefined ? Number(r.tonkhohientai) : null,
  tonDangChuyen: Number(r.tonDangChuyen ?? r.tondangchuyen ?? 0),
  hanMuc: Number(r.hanMucCanhBao ?? r.hanmuccanhbao ?? 0),
  giaVonDonVi: Number(r.giaVonDonVi ?? r.giavondonvi ?? 0),
  isKeyItem: Boolean(r.isKeyItem ?? r.iskeyitem),
  laBanThanhPham: Boolean(r.laBanThanhPham ?? r.labanthanhpham),
  sanLuongMeMacDinh: Number(r.sanLuongMeMacDinh ?? r.sanluongmemacdinh ?? 1000),
  hanSuDungGio: r.hanSuDungGio ?? r.hansudunggio ?? null,
  theoDoiHanDung: Boolean(r.theoDoiHanDung ?? r.theodoihandung),
  maNCCMacDinh: r.maNCCMacDinh ?? r.manccmacdinh ?? null,
})

export const khoService = {
  getAllNguyenLieu: async (params = {}) => {
    const rows = await axiosClient.get('/kho/nguyenlieu', { params })
    return rows.map(mapNL)
  },

  setNguyenLieuTamHet: (maNL, tamHet) =>
    axiosClient.put(`/kho/nguyenlieu/${encodeURIComponent(maNL)}/tamhet`, { tamHet }),

  capNhatThuocTinh: (maNL, body) =>
    axiosClient.put(`/kho/nguyenlieu/${encodeURIComponent(maNL)}/thuoctinh`, body),

  getBanThanhPham: () => axiosClient.get('/kho/ban-thanh-pham'),

  luuCongThucBanThanhPham: (maNLThanhPham, body) =>
    axiosClient.post(`/kho/ban-thanh-pham/${encodeURIComponent(maNLThanhPham)}/congthuc`, body),

  sanXuatMe: (body) => axiosClient.post('/kho/san-xuat-me', body),

  taoNguyenLieu: (body) => axiosClient.post('/kho/nguyenlieu', body),

  getQuyDoi: () => axiosClient.get('/kho/quydoi'),

  saveQuyDoi: (body) => axiosClient.post('/kho/quydoi', body),

  deleteQuyDoi: (id) => axiosClient.delete(`/kho/quydoi/${id}`),

  lookupBarcode: (code) => axiosClient.get(`/kho/barcode/${encodeURIComponent(code)}`),

  canhBao: async (params = {}) => {
    const rows = await axiosClient.get('/kho/canhbao', { params })
    return rows.map(mapNL)
  },

  nhap: (body) => axiosClient.post('/kho/nhap', body),

  kiemKe: (body) => axiosClient.post('/kho/kiemke', body),

  // [Phân hệ 4] Blind Stocktake 60s (Items -> Start -> Submit w/ In-Flight Sales Delta -> Pending -> Approve)
  getBlindStocktakeItems: (params = {}) => axiosClient.get('/kho/kiem-ke/items', { params }),
  getPendingBlindStocktakes: (params = {}) => axiosClient.get('/kho/kiem-ke/pending', { params }),
  startBlindStocktake: (body = {}) => axiosClient.post('/kho/kiem-ke/start', body),
  submitBlindStocktake: (body) => axiosClient.post('/kho/kiem-ke/submit', body),
  approveBlindStocktake: (maGD, approve = true) =>
    axiosClient.post(`/kho/kiem-ke/${encodeURIComponent(maGD)}/approve`, { approve }),

  // [Phân hệ 4] Reversal Phiếu Nhập Sai + WAC Replay & Định giá Điểm Thời Gian
  reversePhieu: (maGD, lyDo) =>
    axiosClient.post(`/kho/phieu/${encodeURIComponent(maGD)}/reverse`, { lyDo }),
  getDinhGia: (asOfDate, branchId = null) =>
    axiosClient.get('/kho/dinh-gia', { params: { asOfDate, ...(branchId ? { branchId } : {}) } }),

  // [Phân hệ 4] Lô FEFO & Hủy mẻ hết hạn 1 chạm
  getLoTonKho: (params = {}) => axiosClient.get('/kho/lo-tonkho', { params }),
  disposeLoTonKho: (id, body = {}) => axiosClient.post(`/kho/lo-tonkho/${id}/dispose`, body),

  // [Phân hệ 4] AvT Theo Ca & 6 mã lý do Hao hụt
  getWastageTaxonomy: () => axiosClient.get('/kho/wastage-taxonomy'),
  getShiftAvt: (params = {}) => axiosClient.get('/kho/avt-by-shift', { params }),
  snapshotShiftStock: (body) => axiosClient.post('/kho/avt-by-shift/snapshot', body),

  // [Phân hệ 4] Nhà cung cấp, Auto-PO & GRN + Khóa sổ kho
  getNhaCungCap: () => axiosClient.get('/kho/nhacungcap'),
  createNhaCungCap: (body) => axiosClient.post('/kho/nhacungcap', body),
  getPurchaseOrders: () => axiosClient.get('/kho/po'),
  autoGeneratePO: (body = {}) => axiosClient.post('/kho/po/auto-generate', body),
  receivePO: (maPO, body = {}) => axiosClient.post(`/kho/po/${encodeURIComponent(maPO)}/receive`, body),
  getPeriodLocks: (branchId = null) =>
    axiosClient.get('/kho/khoa-so', { params: branchId ? { branchId } : {} }),
  lockPeriod: (body) => axiosClient.post('/kho/khoa-so', body),

  canDoi: async (tuNgay, denNgay, branchId = null) => {
    const d = await axiosClient.get('/kho/candoi', {
      params: { tuNgay, denNgay, ...(branchId ? { branchId } : {}) },
    })
    return (d.canDoiKho || []).map((r) => ({
      ...mapNL(r),
      tongNhap: Number(r.tongnhap ?? r.tongNhap ?? 0),
      tongXuatHuy: Number(r.tongxuathuy ?? r.tongXuatHuy ?? 0),
      chenhLechKiemKe: Number(r.tongchenhlechkiemke ?? r.chenhLechKiemKe ?? 0),
      tongTieuHaoBanHang: Number(r.tongtieuhaobanhang ?? r.tongTieuHaoBanHang ?? 0),
      tongHoanKhoHuyMon: Number(r.tonghoankhohuymon ?? r.tongHoanKhoHuyMon ?? 0),
      giaTriThatThoat: Number(r.giaTriThatThoat ?? 0),
      tyLeThatThoatPct: Number(r.tyLeThatThoatPct ?? 0),
    }))
  },
}
