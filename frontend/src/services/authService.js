import axiosClient from '../api/axiosClient'

export const authService = {
  // Trả về { message, token, user: { maNV, tenNV, vaiTro } }
  login: (tenDangNhap, matKhau) => axiosClient.post('/auth/login', { tenDangNhap, matKhau }),
}
