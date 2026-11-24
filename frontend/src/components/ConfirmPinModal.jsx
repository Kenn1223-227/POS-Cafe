import { useEffect, useState } from 'react'

/**
 * Wave 3B (P1-02): Modal xác nhận / nhập văn bản / nhập mã PIN bảo mật (che ••••)
 * Thay thế hoàn toàn window.confirm và window.prompt trên toàn bộ ứng dụng POS.
 * Hỗ trợ:
 *  - mode="confirm": Xác nhận 2 nút chạm lớn (touch-friendly)
 *  - mode="input": Nhập lý do / văn bản (có giá trị mặc định)
 *  - mode="pin": Nhập mã PIN / mật khẩu (type="password", che ••••, bàn phím số cảm ứng)
 */
export default function ConfirmPinModal({
  open,
  mode = 'confirm', // 'confirm' | 'input' | 'pin'
  title = 'Xác nhận thao tác',
  message = '',
  placeholder = '',
  defaultValue = '',
  confirmText = 'Xác nhận',
  cancelText = 'Hủy',
  danger = false,
  minLength = 0,
  showKeypad = false,
  onConfirm,
  onCancel,
}) {
  const [value, setValue] = useState(defaultValue || '')
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setValue(defaultValue || '')
      setError('')
    }
  }, [open, defaultValue])

  if (!open) return null

  const isPin = mode === 'pin'
  const isInput = mode === 'input' || isPin

  const handleSubmit = (e) => {
    if (e) e.preventDefault()
    if (isInput) {
      const trimmed = String(value || '').trim()
      if (minLength > 0 && trimmed.length < minLength) {
        setError(`Vui lòng nhập tối thiểu ${minLength} ký tự!`)
        return
      }
      onConfirm?.(trimmed)
    } else {
      onConfirm?.(true)
    }
  }

  const appendDigit = (d) => {
    setError('')
    setValue((prev) => `${prev}${d}`.slice(0, 12))
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel?.()
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-stone-200 overflow-hidden"
      >
        <div className={`px-5 py-4 border-b ${danger ? 'bg-red-50 border-red-100' : 'bg-amber-50/70 border-stone-100'}`}>
          <h3 className={`text-base font-bold ${danger ? 'text-red-800' : 'text-stone-900'}`}>
            {title}
          </h3>
          {message && <p className="mt-1 text-sm text-stone-600 whitespace-pre-line">{message}</p>}
        </div>

        {isInput && (
          <div className="p-5 space-y-3">
            <input
              type={isPin ? 'password' : 'text'}
              inputMode={isPin && showKeypad ? 'numeric' : 'text'}
              autoComplete="new-password"
              autoFocus
              value={value}
              onChange={(e) => {
                setError('')
                setValue(e.target.value)
              }}
              placeholder={placeholder || (isPin ? '••••' : 'Nhập nội dung...')}
              className={`w-full rounded-xl border border-stone-300 px-4 py-3 text-base outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200 ${
                isPin ? 'tracking-[0.4em] text-center font-bold text-lg' : ''
              }`}
            />

            {isPin && showKeypad && (
              <div className="grid grid-cols-3 gap-2 pt-1">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      if (k === 'C') setValue('')
                      else if (k === '⌫') setValue((p) => p.slice(0, -1))
                      else appendDigit(k)
                    }}
                    className="h-12 rounded-xl bg-stone-100 hover:bg-stone-200 active:scale-95 font-bold text-stone-800 text-lg transition"
                  >
                    {k}
                  </button>
                ))}
              </div>
            )}

            {error && <p className="text-xs font-medium text-red-600">{error}</p>}
          </div>
        )}

        <div className="px-5 py-4 bg-stone-50 border-t border-stone-100 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => onCancel?.()}
            className="min-h-[44px] px-4 py-2 rounded-xl border border-stone-300 bg-white text-stone-700 font-semibold text-sm hover:bg-stone-100 active:scale-95 transition"
          >
            {cancelText}
          </button>
          <button
            type="submit"
            className={`min-h-[44px] px-5 py-2 rounded-xl font-semibold text-sm text-white active:scale-95 transition ${
              danger
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-amber-600 hover:bg-amber-700'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </form>
    </div>
  )
}
