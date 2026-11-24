/**
 * =============================================================================
 * PHÂN HỆ 3: ĐỘNG CƠ DYNAMIC VIETQR EMVCO CỤC BỘ (NAPAS 247),
 * SMART CASH DENOMINATIONS & SOUNDBOX AUDIO PROOF-OF-PAYMENT
 * =============================================================================
 */
import { speakVietnamese } from './sound.js'
import { getBridgeClientSettings } from './printBridge.js'

export {
  VIETQR_BANK_BINS,
  crc16Ccitt,
  resolveVietQrBankBin,
  buildVietQrEmvcoPayload,
  renderVietQrSvg,
  buildVietQrSvgDataUrl,
  getSmartCashSuggestions,
} from './vietqrCore.js'

/**
 * Phát loa xác nhận nhận tiền 2 lớp (Chống bill giả 100%):
 *  - Lớp 1: Web Speech API trên trình duyệt POS
 *  - Lớp 2: POST /speak qua Local Print Bridge (loa ngoài / Soundbox đọc ngay cả khi tab bị thu nhỏ)
 */
export async function speakPaymentProofDualLayer({ amount, maHoaDon = null, customText = null }) {
  const vnd = Math.round(Number(amount) || 0)
  const text =
    customText ||
    `Đã nhận chuyển khoản ${vnd.toLocaleString('vi-VN')} đồng${maHoaDon ? `, đơn số ${maHoaDon}` : ''}`
  speakVietnamese(text)
  try {
    const bridge = getBridgeClientSettings()
    const baseUrl = String(bridge?.url || 'http://127.0.0.1:9100').replace(/\/+$/, '')
    const headers = { 'Content-Type': 'application/json' }
    if (bridge?.token) headers['X-Print-Bridge-Token'] = bridge.token
    await fetch(`${baseUrl}/speak`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, amount: vnd, maHoaDon }),
    }).catch(() => {})
  } catch {
    // ignore if bridge offline
  }
}
