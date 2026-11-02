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

export const getTodayISO = () => new Date().toISOString().slice(0, 10)