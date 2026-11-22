import { create } from 'zustand'
import { disconnectSocket } from '../socket/socketClient'

const LEGACY_TOKEN_KEY = 'pos_token'
const SESSION_TOKEN_KEY = 'pos_access_token'
const USER_KEY = 'pos_user'

// [Phân hệ 7] Di chuyển Access Token ngắn hạn ra khỏi localStorage (dùng RAM + sessionStorage; Refresh Token nằm trong HttpOnly Cookie)
const docTokenBanDau = () => {
  try {
    const sess = sessionStorage.getItem(SESSION_TOKEN_KEY)
    if (sess) return sess
    // Di cư 1 lần từ localStorage cũ sang sessionStorage rồi xóa sạch localStorage
    const legacy = localStorage.getItem(LEGACY_TOKEN_KEY)
    if (legacy) {
      sessionStorage.setItem(SESSION_TOKEN_KEY, legacy)
      localStorage.removeItem(LEGACY_TOKEN_KEY)
      return legacy
    }
  } catch {
    // ignore private mode
  }
  return null
}

const docUserTuStorage = () => {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export const useAuthStore = create((set) => ({
  token: docTokenBanDau(),
  user: docUserTuStorage(), // { maNV, tenNV, vaiTro, tenantId, ... }
  authBootstrapped: false,

  setAuthBootstrapped: (val) => set({ authBootstrapped: Boolean(val) }),

  setAuth: (token, user) => {
    try {
      sessionStorage.setItem(SESSION_TOKEN_KEY, token)
      localStorage.removeItem(LEGACY_TOKEN_KEY)
      localStorage.setItem(USER_KEY, JSON.stringify(user))
    } catch {
      // ignore
    }
    set({ token, user, authBootstrapped: true })
  },

  clearLocalAuth: () => {
    disconnectSocket()
    try {
      sessionStorage.removeItem(SESSION_TOKEN_KEY)
      localStorage.removeItem(LEGACY_TOKEN_KEY)
      localStorage.removeItem(USER_KEY)
    } catch {
      // ignore
    }
    set({ token: null, user: null, authBootstrapped: true })
  },

  logout: () => {
    disconnectSocket()
    const apiBase = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api').replace(/\/+$/, '')
    // Thu hồi HttpOnly Refresh Token Cookie trên Backend (fire-and-forget, không chặn UI khi offline)
    if (typeof fetch === 'function') {
      fetch(`${apiBase}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => {})
    }
    try {
      sessionStorage.removeItem(SESSION_TOKEN_KEY)
      localStorage.removeItem(LEGACY_TOKEN_KEY)
      localStorage.removeItem(USER_KEY)
    } catch {
      // ignore
    }
    set({ token: null, user: null, authBootstrapped: true })
  },
}))

export default useAuthStore
