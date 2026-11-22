export const formatVND = (amount) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(Number(amount || 0))

export const formatNumber = (num) =>
  new Intl.NumberFormat('vi-VN').format(Number(num || 0))

export const formatDate = (dateStr) => {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return Number.isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('vi-VN')
}

export const formatDateTime = (dateStr) => {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return Number.isNaN(d.getTime()) ? dateStr : d.toLocaleString('vi-VN')
}

// Chuẩn múi giờ Việt Nam (UTC+7) — sửa lỗi lệch 1 ngày vào khung 00:00–06:59 sáng
export const getTodayISO = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())

// Chống XSS khi dựng HTML in hóa đơn / tem nhãn
export const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

// Gợi ý mệnh giá tiền mặt thông minh cho thu ngân bấm 1 chạm
export const suggestCashDenominations = (total) => {
  const amt = Math.ceil(Number(total || 0))
  if (amt <= 0) return []
  const set = new Set([amt])
  const roundUp = (step) => Math.ceil(amt / step) * step
  ;[5000, 10000, 20000, 50000, 100000, 200000, 500000].forEach((step) => {
    const val = roundUp(step)
    if (val >= amt) set.add(val)
  })
  ;[50000, 100000, 200000, 500000].forEach((bill) => {
    if (bill > amt) set.add(bill)
  })
  return [...set].sort((a, b) => a - b).slice(0, 6)
}
