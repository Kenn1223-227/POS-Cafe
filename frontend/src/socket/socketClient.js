import { io } from 'socket.io-client'
import { useAuthStore } from '../store/authStore'

let socket = null

export const getSocket = () => {
  if (!socket) {
    socket = io(import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000', {
      autoConnect: false,
      transports: ['websocket', 'polling'], // Fallback polling nếu mạng quán chặn WebSocket upgrade
      auth: (cb) => cb({ token: useAuthStore.getState().token }),
      reconnectionDelay: 1000,
    })
  }
  return socket
}

export const disconnectSocket = () => {
  if (socket && socket.connected) {
    socket.disconnect()
  }
}
