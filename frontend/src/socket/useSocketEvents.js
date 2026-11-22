import { useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import { getSocket } from './socketClient'
import { useAuthStore } from '../store/authStore'

// Đếm số lượng subscriber đang mount để tránh 1 component unmount làm ngắt socket của component khác
let activeSubscribers = 0

export function useSocketEvents(handlers) {
  const ref = useRef(handlers)

  useEffect(() => {
    ref.current = handlers
  })

  useEffect(() => {
    const socket = getSocket()
    let wasDown = false
    activeSubscribers += 1

    const bound = Object.keys(ref.current).map((evt) => {
      const fn = (...args) => ref.current[evt]?.(...args)
      socket.on(evt, fn)
      return [evt, fn]
    })

    let disconnectAlertTimer = null

    const onConnect = () => {
      if (disconnectAlertTimer) {
        clearTimeout(disconnectAlertTimer)
        disconnectAlertTimer = null
      }
      ref.current.CONNECTION_STATE?.({ connected: true, disconnectedOver5s: false })
      if (wasDown) {
        toast.success(
          socket.recovered
            ? 'Đã kết nối lại real-time (đã khôi phục gói tin)'
            : 'Đã kết nối lại real-time — đang đồng bộ lại dữ liệu'
        )
        ref.current.RECONNECTED?.({ recovered: Boolean(socket.recovered) })
      }
      wasDown = false
    }
    const onDisconnect = (reason) => {
      if (reason === 'io client disconnect') return
      wasDown = true
      ref.current.CONNECTION_STATE?.({ connected: false, disconnectedOver5s: false })
      toast.error('Mất kết nối real-time, đang thử lại...')
      if (!disconnectAlertTimer) {
        disconnectAlertTimer = setTimeout(() => {
          ref.current.CONNECTION_STATE?.({ connected: false, disconnectedOver5s: true })
        }, 5000)
      }
    }
    const onError = (err) => {
      if (/Token/i.test(err.message)) {
        toast.error('Phiên đăng nhập đã hết hạn')
        useAuthStore.getState().logout()
        window.location.href = '/login'
      }
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onError)
    if (!socket.connected) socket.connect()

    return () => {
      if (disconnectAlertTimer) clearTimeout(disconnectAlertTimer)
      bound.forEach(([e, f]) => socket.off(e, f))
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onError)
      activeSubscribers = Math.max(0, activeSubscribers - 1)
      if (activeSubscribers === 0) socket.disconnect()
    }
  }, [])
}
