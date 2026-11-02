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
    }))
  },

  create: (body) => axiosClient.post('/ban', body),
}