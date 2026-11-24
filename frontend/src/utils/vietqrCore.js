import QRCode from 'qrcode'

// Bảng mã BIN Ngân hàng Việt Nam phổ biến (Napas247)
export const VIETQR_BANK_BINS = {
  MB: '970422',
  MBBANK: '970422',
  VCB: '970436',
  VIETCOMBANK: '970436',
  TCB: '970407',
  TECHCOMBANK: '970407',
  ACB: '970416',
  BIDV: '970418',
  ICB: '970415',
  VIETINBANK: '970415',
  VPB: '970432',
  VPBANK: '970432',
  TPB: '970423',
  TPBANK: '970423',
  STB: '970403',
  SACOMBANK: '970403',
  AGRIBANK: '970405',
  VBA: '970405',
  OCB: '970448',
  VIB: '970441',
  HDB: '970437',
  SHB: '970443',
  MSB: '970426',
  LPB: '970449',
}

function tlv(tag, value) {
  const str = String(value ?? '')
  return `${tag}${String(str.length).padStart(2, '0')}${str}`
}

// CRC16-CCITT (polynomial 0x1021, initial value 0xFFFF) chuẩn EMVCo Tag 63
export function crc16Ccitt(input) {
  let crc = 0xffff
  for (let i = 0; i < input.length; i += 1) {
    crc ^= input.charCodeAt(i) << 8
    for (let j = 0; j < 8; j += 1) {
      if ((crc & 0x8000) !== 0) crc = ((crc << 1) ^ 0x1021) & 0xffff
      else crc = (crc << 1) & 0xffff
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

export function resolveVietQrBankBin(bankId) {
  const rawBank = String(bankId || '').trim().toUpperCase()
  if (!rawBank) {
    throw new Error('UNSUPPORTED_BANK_BIN: Thiếu mã ngân hàng (bankId/BIN) để tạo VietQR!')
  }
  if (/^\d{6}$/.test(rawBank)) return rawBank
  const mapped = VIETQR_BANK_BINS[rawBank]
  if (!mapped) {
    throw new Error(
      `UNSUPPORTED_BANK_BIN: Mã ngân hàng "${rawBank}" chưa có trong danh sách BIN Napas247! Vui lòng nhập mã BIN 6 chữ số hợp lệ.`
    )
  }
  return mapped
}

export function buildVietQrEmvcoPayload({ bankId, accountNo, amount = 0, memo = '' }) {
  const cleanAcc = String(accountNo || '').replace(/[^0-9A-Za-z]/g, '').trim()
  if (!cleanAcc) return ''
  // [Wave 1 — P0-03] Xóa fallback im lặng về MB Bank ('970422') — báo lỗi tường minh nếu thiếu/sai BIN!
  const bin = resolveVietQrBankBin(bankId)
  const cleanAmount = Math.max(0, Math.round(Number(amount) || 0))
  const cleanMemo = String(memo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9\s\-_]/g, '')
    .trim()
    .slice(0, 50)

  const bankOrg = tlv('00', bin) + tlv('01', cleanAcc)
  const merchantAccInfo = tlv('00', 'A000000727') + tlv('01', bankOrg) + tlv('02', 'QRIBFTTA')

  let payload = ''
  payload += tlv('00', '01')
  payload += tlv('01', cleanAmount > 0 ? '12' : '11')
  payload += tlv('38', merchantAccInfo)
  payload += tlv('53', '704')
  if (cleanAmount > 0) payload += tlv('54', String(cleanAmount))
  payload += tlv('58', 'VN')
  if (cleanMemo) {
    payload += tlv('62', tlv('08', cleanMemo))
  }
  payload += '6304'
  return payload + crc16Ccitt(payload)
}

/**
 * [Wave 1 — P0-03] Vẽ QR SVG cục bộ đồng bộ (0 phụ thuộc img.vietqr.io, hoạt động cả offline 100%)
 */
export function renderVietQrSvg(
  emvcoPayload,
  { margin = 2, darkColor = '#000000', lightColor = '#ffffff' } = {}
) {
  const text = String(emvcoPayload || '').trim()
  if (!text) return ''
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const size = qr.modules.size
  const total = size + margin * 2
  const parts = []
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (qr.modules.get(x, y)) {
        parts.push(`M${x + margin},${y + margin}h1v1h-1z`)
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${lightColor}"/><path d="${parts.join('')}" fill="${darkColor}"/></svg>`
}

export function buildVietQrSvgDataUrl({ bankId, accountNo, amount = 0, memo = '' }) {
  const payload = buildVietQrEmvcoPayload({ bankId, accountNo, amount, memo })
  if (!payload) return null
  const svg = renderVietQrSvg(payload)
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export function getSmartCashSuggestions(amountDue) {
  const due = Math.max(0, Math.round(Number(amountDue) || 0))
  if (due === 0) return []
  const denoms = [5000, 10000, 20000, 50000, 100000, 200000, 500000]
  const set = new Set([due])
  for (const d of denoms) {
    const nextMultiple = Math.ceil(due / d) * d
    if (nextMultiple > due) set.add(nextMultiple)
    if (d > due) set.add(d)
  }
  return Array.from(set)
    .sort((a, b) => a - b)
    .slice(0, 5)
}
