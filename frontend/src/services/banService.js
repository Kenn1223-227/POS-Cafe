import axiosClient from '../api/axiosClient'

export const banService = {
  getAll: async () => {
    const res = await axiosClient.get('/ban')
    const list = Array.isArray(res) ? res : res.data || []
    return list.map((r) => ({
      maBan: r.maBan || r.maban,
      tenBan: r.tenBan || r.tenban,
      trangThai: Number(r.trangThai ?? r.trangthai ?? 1), // 1: Trống, 2: Đang phục vụ
      khuVuc: r.khuVuc || r.khuvuc || 'Khu chính',
      x: r.toadox ?? r.x ?? 0,
      y: r.toadoy ?? r.y ?? 0,
      maHoaDonMo: r.mahoadonmo || r.maHoaDonMo || null,
      thoiGianMoBan: r.thoigianmoban || r.thoiGianMoBan || null,
      lastOrderAt: r.lastorderat || r.lastOrderAt || null,
      soKhach: Number(r.sokhach ?? r.soKhach ?? 1),
      version: Number(r.version ?? 1),
      kdsProgress: r.kdsProgress || {
        tongMon: Number(r.tongmonkds || 0),
        daXong: Number(r.mondaxongkds || 0),
        daPhucVu: Number(r.mondaphucvukds || 0),
      },
      upcomingReservation: r.upcomingReservation || null,
      tongTamTinh: Number(r.tongtamtinh ?? r.tongTamTinh ?? 0),
      branchId: r.branchid || r.branchId || null,
      qrToken: r.qrtoken || r.qrToken || null,
      qrYeuCauMoBan: r.qryeucaumoban ?? r.qrYeuCauMoBan ?? true,
      qrBatBuocVietQR: r.qrbatbuocvietqr ?? r.qrBatBuocVietQR ?? false,
    }))
  },

  create: (body) => axiosClient.post('/ban', body),

  // [P1] Chuyển bàn (đồng bộ sang cả màn hình Barista)
  chuyenBan: ({ fromMaBan, toMaBan, forceClean = false }) =>
    axiosClient.post('/ban/chuyen', { fromMaBan, toMaBan, forceClean }),

  // [P1] Gộp bàn (Merge Table)
  gopBan: ({ fromMaBan, toMaBan, expectedVersion = null, keepTable = false }) =>
    axiosClient.post('/ban/gop', { fromMaBan, toMaBan, ...(expectedVersion ? { expectedVersion } : {}), keepTable }),

  // [P1] Đổi trạng thái bàn (1: Trống, 3: Chờ dọn bàn, 4: Đã đặt trước)
  doiTrangThai: (maBan, trangThai) =>
    axiosClient.put(`/ban/${encodeURIComponent(maBan)}/trangthai`, { trangThai }),

  // [Phân hệ 1 - 100/100] Đặt bàn trước (Reservations)
  getDatBan: (trangThai) =>
    axiosClient.get('/datban', { params: trangThai ? { trangThai } : undefined }),
  taoDatBan: (body) => axiosClient.post('/datban', body),
  capNhatDatBan: (maDatBan, body) =>
    axiosClient.put(`/datban/${encodeURIComponent(maDatBan)}/trangthai`, body),
}
