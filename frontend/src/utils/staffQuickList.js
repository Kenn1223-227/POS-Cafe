/**
 * Chuẩn hóa phản hồi từ GET /api/auth/staff-quick-list.
 * Hỗ trợ cả mảng JSON thô `[...]` lẫn object `{ danhSachNV: [...] }`.
 */
export function parseStaffQuickList(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.danhSachNV)) return payload.danhSachNV
  return []
}
