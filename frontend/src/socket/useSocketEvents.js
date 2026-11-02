import { useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import { getSocket } from './socketClient'
import { useAuthStore } from '../store/authStore'

/** handlers: { CO_DON_MOI: fn } hoặc { MON_DA_XONG: fn } */
export function useSocketEvents(handlers) {
  const ref = useRef(handlers)
  ref.current = handlers

  useEffect(() => {
    const socket = getSocket()
    let wasDown = false

    const bound = Object.keys(ref.current).map((evt) => {
      const fn = (...args) => ref.current[evt]?.(...args)
      socket.on(evt, fn)
      return [evt, fn]
    })

    const onConnect = () => {
      if (wasDown) toast.success('Đã kết nối lại real-time')
      wasDown = false
    }
    const onDisconnect = (reason) => {
      if (reason === 'io client disconnect') return
      wasDown = true
      toast.error('Mất kết nối real-time, đang thử lại...')
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
    socket.connect()

    return () => {
      bound.forEach(([e, f]) => socket.off(e, f))
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onError)
      socket.disconnect()
    }
  }, [])
}