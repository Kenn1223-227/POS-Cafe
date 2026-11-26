// [Batch 5 — POS Hotkey Guard] Chặn phím tắt thanh toán / thao tác nhanh ([F9], [F10], [F4], [F2], [F1], [F8])
// khi đang có bất kỳ Modal / Dialog / Drawer mở phía trên hoặc con trỏ đang focus trong ô nhập liệu.

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export function isEditableElement(el) {
  if (!el || typeof el !== 'object') return false
  const tag = String(el.tagName || '').toUpperCase()
  if (EDITABLE_TAGS.has(tag)) return true
  if (el.isContentEditable === true) return true
  if (typeof el.getAttribute === 'function') {
    const ce = String(el.getAttribute('contenteditable') || '').toLowerCase()
    if (ce === '' || ce === 'true' || ce === 'plaintext-only') {
      if (el.hasAttribute?.('contenteditable')) return true
    }
  }
  if (typeof el.closest === 'function' && el.closest('[contenteditable="true"]')) {
    return true
  }
  return false
}

export function hasDomOpenModal(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || typeof doc.querySelector !== 'function') return false
  return Boolean(
    doc.querySelector('[role="dialog"], [aria-modal="true"], [data-pos-modal="true"], dialog[open]')
  )
}

/**
 * Trả về `true` nếu phím tắt POS phải bị chặn để tránh nổ xuyên qua Modal / Dialog / Input Focus.
 * Riêng phím `Escape` luôn trả về `false` để người dùng có thể đóng modal hoặc thoát focus input.
 */
export function shouldBlockPosHotkey({
  key = '',
  hasOpenModal = false,
  hasDomModal = false,
  target = null,
  activeElement = null,
} = {}) {
  if (key === 'Escape') return false
  if (hasOpenModal || hasDomModal) return true
  if (isEditableElement(target) || isEditableElement(activeElement)) return true
  return false
}
