// Sinh khóa chống gửi trùng (UUID v4).
// crypto.randomUUID() chỉ có trên HTTPS/localhost; POS chạy qua http://192.168.x.x (mạng LAN) sẽ không có,
// nên fallback sang getRandomValues (dùng được ở mọi ngữ cảnh).
export function newIdempotencyKey() {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()

  const b = new Uint8Array(16)
  if (c?.getRandomValues) c.getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)

  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
