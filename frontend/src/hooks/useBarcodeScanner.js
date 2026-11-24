import { useEffect, useRef } from 'react'

/**
 * Global HID Barcode Scanner Listener (<50ms/ký tự kết thúc bằng Enter)
 * Cho phép thu ngân cầm súng quét mã vạch (USB/Bluetooth HID Wedge) quét trực tiếp:
 * - Thẻ thành viên / SĐT khách hàng (10 số 09.../03.../08... hoặc KH...)
 * - Mã món / Nước đóng chai (SKU / MaMon) -> Tự động +1 vào giỏ hàng
 * - Mã Voucher / Khuyến mãi -> Tự động áp mã giảm giá
 * mà KHÔNG cần chạm chuột focus vào bất kỳ ô input nào!
 */
export function useBarcodeScanner({ onScan, enabled = true, maxInterKeyMs = 50, minLength = 4 }) {
  const onScanRef = useRef(onScan)
  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined

    let buffer = ''
    let lastKeyTime = 0
    let fastIntervals = 0

    const onKeyDown = (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return

      const now = performance.now()
      const delta = now - lastKeyTime

      if (e.key === 'Enter') {
        if (buffer.length >= minLength && fastIntervals >= minLength - 1 && delta <= maxInterKeyMs * 2) {
          const code = buffer.trim()
          buffer = ''
          fastIntervals = 0
          lastKeyTime = 0

          e.preventDefault()
          e.stopPropagation()

          // Nếu con trỏ chuột vô tình đang đặt trong một ô input khi súng quét bắn ký tự vào,
          // tự động cắt phần chuỗi mã vạch vừa bị đổ nhầm vào ô input đó!
          const activeEl = document.activeElement
          if (
            activeEl &&
            (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') &&
            typeof activeEl.value === 'string' &&
            activeEl.value.endsWith(code)
          ) {
            const cleanVal = activeEl.value.slice(0, activeEl.value.length - code.length)
            const targetProto =
              activeEl.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype
            const nativeValueSetter = Object.getOwnPropertyDescriptor(targetProto, 'value')?.set
            if (nativeValueSetter) {
              nativeValueSetter.call(activeEl, cleanVal)
              activeEl.dispatchEvent(new Event('input', { bubbles: true }))
            }
          }

          if (typeof onScanRef.current === 'function') {
            onScanRef.current(code)
          }
        } else {
          buffer = ''
          fastIntervals = 0
        }
        return
      }

      if (e.key.length === 1) {
        if (delta <= maxInterKeyMs) {
          buffer += e.key
          fastIntervals += 1
        } else {
          buffer = e.key
          fastIntervals = 0
        }
        lastKeyTime = now
      } else if (e.key !== 'Shift') {
        buffer = ''
        fastIntervals = 0
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [enabled, maxInterKeyMs, minLength])
}
