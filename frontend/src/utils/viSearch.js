/**
 * Wave 3B (P1-02): Chuẩn hóa tìm kiếm tiếng Việt không dấu cho POS [F1]
 * Chuyển đ/Đ -> d, bỏ dấu tổ hợp Unicode (NFD), chuyển chữ thường và chuẩn hóa khoảng trắng.
 * Ví dụ: normalizeViSearch("Bạc Xỉu Đá") === "bac xiu da"
 */
export function normalizeViSearch(str) {
  return String(str || '')
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function matchesViSearch(haystack, query) {
  const q = normalizeViSearch(query)
  if (!q) return true
  const target = normalizeViSearch(haystack)
  return target.includes(q)
}
