import { io } from 'socket.io-client'
import { useAuthStore } from '../store/authStore'

let socket = null

export const getSocket = () => {
  if (!socket) {
    socket = io(import.meta.env.VITE_SOCKET_URL, {
      autoConnect: false,
      transports: ['websocket'],
      // hàm => luôn lấy token mới nhất mỗi lần (re)connect
      auth: (cb) => cb({ token: useAuthStore.getState().token }),
      reconnectionDelay: 1000,
    })
  }
  return socket
}