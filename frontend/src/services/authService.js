import axiosClient from '../api/axiosClient'
import { getOrCreatePosDeviceId } from '../offline/offlineDb'

export const authService = {
  // Trả về { message, token, accessTokenExpiresIn, deviceSession, user }
  login: (tenDangNhap, matKhau, { maQuan = '', rememberDevice = true } = {}) =>
    axiosClient.post('/auth/login', {
      tenDangNhap,
      matKhau,
      ...(maQuan ? { maQuan } : {}),
      rememberDevice: Boolean(rememberDevice),
      deviceId: getOrCreatePosDeviceId(),
    }),

  // Gia hạn Access Token ngầm từ HttpOnly Refresh Token Cookie (Refresh Token Rotation)
  refresh: () => axiosClient.post('/auth/refresh', {}, { silent: true }),

  // Đăng xuất chuẩn: thu hồi Refresh Token trên DB & xóa HttpOnly Cookie
  logout: () => axiosClient.post('/auth/logout', {}, { silent: true }),

  // Fast Store Device Session: kiểm tra máy quầy có sẵn phiên HttpOnly để nhân viên mở khóa bằng mã PIN 4–6 số
  getDeviceSession: () => axiosClient.get('/auth/device-session', { silent: true }),

  // Danh sách nhân viên đang hoạt động trong cùng quán để đổi ca nhanh bằng PIN
  getStaffQuickList: () => axiosClient.get('/auth/staff-quick-list'),

  // Chuyển đổi nhân viên nhanh bằng mã PIN 4–6 số (hoạt động với cả Bearer Token lẫn HttpOnly Device Session Cookie)
  pinSwitch: (maNV, pin) => axiosClient.post('/auth/pin-switch', { maNV, pin }),
}
