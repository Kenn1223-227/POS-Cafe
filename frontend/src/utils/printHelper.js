import { escapeHtml, formatDateTime, formatVND } from './format'
import {
  getBridgeClientSettings,
  bridgePrintReceipt,
  bridgePrintLabels,
  bridgePrintZReport,
} from './printBridge'
import {
  enqueueFailedPrintJob,
  updatePersistentPrintJob,
} from '../offline/offlineDb'
import { buildVietQrSvgDataUrl } from './vietqrEmvco'
import {
  renderVietnameseReceiptToCanvas,
  uint8ToBase64,
  resolvePaperWidthPx,
} from './escposRaster'

/**
 * [Batch 5 — Vietnamese ESC/POS Raster GS v 0]
 * Dựng ảnh raster 1-bit tiếng Việt có dấu từ Canvas theo khổ giấy K80 (576px) / K58 (384px)
 * và đính kèm `rasterBase64` vào payload gửi Local Print Bridge / WebSerial / WebUSB / RawBT.
 * Khi cờ `vietnameseRaster` tắt hoặc môi trường không hỗ trợ Canvas 2D -> giữ nguyên payload ESC/POS ASCII.
 */
export function buildReceiptRasterPayload(
  receiptPayload,
  { vietnameseRaster = true, paperWidth = 'K80', renderFn = renderVietnameseReceiptToCanvas } = {}
) {
  if (!vietnameseRaster || !receiptPayload?.hoaDon) return receiptPayload
  if (receiptPayload.rasterBase64) return receiptPayload
  const normalizedPaper = String(paperWidth || 'K80').toUpperCase() === 'K58' ? 'K58' : 'K80'
  const width = resolvePaperWidthPx(normalizedPaper)
  try {
    const rendered = renderFn(receiptPayload.hoaDon, {
      tenQuan: receiptPayload.tenQuan,
      diaChi: receiptPayload.diaChi || '',
      thuNgan: receiptPayload.thuNgan || '',
      soLanIn: receiptPayload.soLanIn,
      laBanSao: receiptPayload.laBanSao,
      reprintBanner: receiptPayload.reprintBanner,
      laTamTinh: receiptPayload.laTamTinh,
      laDonOffline: receiptPayload.laDonOffline,
      showPlgWatermark: receiptPayload.showPlgWatermark,
      plgReferralUrl: receiptPayload.plgReferralUrl,
      paperWidth: normalizedPaper,
      width,
    })
    const rasterBase64 =
      rendered?.rasterBase64 ||
      (rendered?.rasterBytes?.length ? uint8ToBase64(rendered.rasterBytes) : '')
    if (rasterBase64) {
      return {
        ...receiptPayload,
        paperWidth: normalizedPaper,
        rasterWidth: width,
        rasterBase64,
      }
    }
  } catch {
    // Môi trường không có Canvas 2D -> tự động fallback ESC/POS ASCII an toàn
  }
  return receiptPayload
}

function readCurrentUserMeta() {
  try {
    const raw = localStorage.getItem('pos_user')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function readCurrentTenantId() {
  return String(readCurrentUserMeta()?.tenantId || 'DEFAULT')
}

// [PHÂN HỆ 9 - VIRAL PLG LOOP] Chỉ hiển thị Watermark + QR đăng ký dùng thử cho gói FREE (hoặc khi bật cờ receipt_watermark)
function resolvePlgReceiptWatermark(explicitFlag) {
  const user = readCurrentUserMeta()
  const show =
    typeof explicitFlag === 'boolean'
      ? explicitFlag
      : typeof user?.featureFlags?.receipt_watermark === 'boolean'
      ? user.featureFlags.receipt_watermark
      : String(user?.goiCuoc || '').toUpperCase() === 'FREE'
  const refCode = user?.slug || user?.tenantSlug || user?.tenantId || 'pos'
  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'https://cafepos.vn'
  const url = `${origin}/onboarding?ref=${encodeURIComponent(refCode)}`
  return { showPlgWatermark: show, plgReferralUrl: url }
}

const BANK_STORAGE_KEY = 'pos_vietqr_config'
const OFFLINE_QR_CACHE_KEY = 'pos_vietqr_offline_dataurl'

export function getVietQrConfig() {
  try {
    const raw = localStorage.getItem(BANK_STORAGE_KEY)
    return raw ? JSON.parse(raw) : { bankId: '', accountNo: '', accountName: 'QUAN CAFE POS' }
  } catch {
    return { bankId: '', accountNo: '', accountName: 'QUAN CAFE POS' }
  }
}

export function saveVietQrConfig(cfg) {
  localStorage.setItem(BANK_STORAGE_KEY, JSON.stringify(cfg))
  try {
    const dataUrl = buildVietQrSvgDataUrl({
      bankId: cfg?.bankId,
      accountNo: cfg?.accountNo,
      amount: 0,
      memo: '',
    })
    if (dataUrl) {
      localStorage.setItem(
        OFFLINE_QR_CACHE_KEY,
        JSON.stringify({ key: `${cfg.bankId}|${cfg.accountNo}`, dataUrl })
      )
    }
  } catch {
    // Bank BIN chưa hợp lệ — không cache QR lỗi
  }
}

export function buildVietQrUrl({ amount, addInfo }) {
  const cfg = getVietQrConfig()
  if (!cfg.bankId || !cfg.accountNo) return null
  // [Wave 1 — P0-03] Vẽ QR SVG 100% cục bộ từ EMVCo payload (không phụ thuộc img.vietqr.io)
  try {
    return buildVietQrSvgDataUrl({
      bankId: cfg.bankId,
      accountNo: cfg.accountNo,
      amount: Math.max(0, Math.round(Number(amount) || 0)),
      memo: addInfo || '',
    })
  } catch {
    return null
  }
}

// In bằng hidden iframe (tránh bị trình duyệt chặn popup sau async await)
function printHtmlInHiddenIframe(html) {
  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  document.body.appendChild(iframe)

  const doc = iframe.contentWindow?.document
  if (!doc) {
    document.body.removeChild(iframe)
    return
  }
  doc.open()
  doc.write(html)
  doc.close()

  setTimeout(() => {
    try {
      iframe.contentWindow.focus()
      iframe.contentWindow.print()
    } finally {
      setTimeout(() => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
      }, 1500)
    }
  }, 150)
}

export async function printReceiptK80(
  hoaDon,
  {
    soLanIn = 1,
    laBanSao = false,
    reprintBanner = null,
    printToken = null,
    laTamTinh = false,
    laDonOffline = false,
    thuNgan = '',
    tenQuan = '',
    isCashPayment = false,
    kickDrawer = undefined,
    showPlgWatermark = undefined,
    vietnameseRaster = undefined,
    paperWidth = undefined,
    skipQueueOnFail = false,
    browserFallbackOnFail = true,
  } = {}
) {
  if (!hoaDon) return { mode: 'NONE' }

  const plgMeta = resolvePlgReceiptWatermark(showPlgWatermark)

  // Tầng 1: Silent Print qua Local Print Bridge / Cloud Relay / WebSerial / WebUSB / WebBluetooth / RawBT
  const bridgeSettings = getBridgeClientSettings()
  const useVietnameseRaster =
    typeof vietnameseRaster === 'boolean'
      ? vietnameseRaster
      : bridgeSettings.vietnameseRaster !== false
  const effectivePaperWidth = paperWidth || bridgeSettings.paperWidth || 'K80'

  const maskPhoneReceipt = (sdt) => {
    const raw = String(sdt || '').trim()
    if (!raw) return ''
    if (raw.length <= 3) return '***'
    return `${'*'.repeat(raw.length - 3)}${raw.slice(-3)}`
  }

  // [Batch 6 — NĐ 13/2023] Che SĐT khách hàng trước khi đóng gói payload gửi sang Print Bridge / Cloud Relay / Raster
  const sanitizedHoaDon =
    hoaDon?.khachHang && hoaDon.khachHang.soDienThoai
      ? {
          ...hoaDon,
          khachHang: {
            ...hoaDon.khachHang,
            soDienThoai: maskPhoneReceipt(hoaDon.khachHang.soDienThoai),
          },
        }
      : hoaDon

  const baseReceiptPayload = {
    hoaDon: sanitizedHoaDon,
    tenQuan: tenQuan || 'QUAN CA PHE POS',
    soLanIn,
    laBanSao,
    reprintBanner,
    printToken,
    laTamTinh,
    laDonOffline,
    thuNgan,
    isCashPayment,
    kickDrawer,
    showPlgWatermark: plgMeta.showPlgWatermark,
    plgReferralUrl: plgMeta.plgReferralUrl,
  }
  const receiptPayload = bridgeSettings.enabled
    ? buildReceiptRasterPayload(baseReceiptPayload, {
        vietnameseRaster: useVietnameseRaster,
        paperWidth: effectivePaperWidth,
      })
    : baseReceiptPayload
  if (bridgeSettings.enabled) {
    try {
      const res = await bridgePrintReceipt(receiptPayload)
      if (res?.ok) return { mode: res.mode || 'BRIDGE', job: res.job }
    } catch (err) {
      // [PHÂN HỆ 6] Lưu vào Hàng đợi In Bền vững (IndexedDB print_jobs) chống mất bill khi lỏng dây LAN / hết giấy!
      if (!skipQueueOnFail) {
        await enqueueFailedPrintJob({
          tenantId: readCurrentTenantId(),
          kind: 'RECEIPT',
          maHoaDon: hoaDon.maHoaDon,
          label: `Bill K80 #${hoaDon.maHoaDon}${laTamTinh ? ' (Tạm tính)' : ''}`,
          payload: receiptPayload,
          error: err?.message || 'Không kết nối được máy in Bill K80',
        })
      }
      if (!browserFallbackOnFail) {
        return { mode: 'FAILED_QUEUED', error: err?.message }
      }
    }
  }

  // Tầng 2 (Fallback): Hidden iframe window.print()
  const gioTao = escapeHtml(formatDateTime(hoaDon.thoigiantao || hoaDon.thoiGianTao))
  const tenBan = escapeHtml(hoaDon.ban?.map((b) => b.tenBan).join(', ') || 'Mang đi')
  const tienGiamKM = Number(hoaDon.tienGiamKM || 0)
  const tienGiamDiem = Number(hoaDon.tienGiamDiem || 0)
  const diemSuDung = Number(hoaDon.diemSuDung || 0)
  const phiPhucVu = Number(hoaDon.phiPhucVu ?? hoaDon.tienPhiPhucVu ?? 0)
  const thueVAT = Number(hoaDon.thueVAT ?? hoaDon.tienThueVAT ?? hoaDon.tienVat ?? 0)

  const taxBreakdown = Array.isArray(hoaDon.taxBreakdown || hoaDon.tax_breakdown_json)
    ? hoaDon.taxBreakdown || hoaDon.tax_breakdown_json
    : []
  const taxBreakdownHtml = taxBreakdown.length > 0
    ? taxBreakdown
        .map((b) => {
          const rateLbl = b.isKct ? 'KCT (0%)' : `VAT ${Number(b.vatRate || 0)}%`
          return `<div style="display:flex;justify-content:space-between;font-size:10.5px"><span>${escapeHtml(rateLbl)} (DT ${escapeHtml(formatVND(b.taxableBase || 0))}):</span><span>${escapeHtml(formatVND(b.vatAmount || 0))}</span></div>`
        })
        .join('')
    : thueVAT > 0
      ? `<div style="display:flex;justify-content:space-between"><span>Thuế VAT${Number(hoaDon.tyLeThueVAT || 0) > 0 ? ` (${Number(hoaDon.tyLeThueVAT)}%)` : ''}:</span><span>+${escapeHtml(formatVND(thueVAT))}</span></div>`
      : ''

  const discountRowsHtml = tienGiamKM > 0 || tienGiamDiem > 0 || phiPhucVu > 0 || thueVAT > 0 || taxBreakdown.length > 0
    ? `<div style="font-size:11px;margin-bottom:4px">
        <div style="display:flex;justify-content:space-between"><span>Tạm tính:</span><span>${escapeHtml(formatVND(hoaDon.tongTamTinh || 0))}</span></div>
        ${tienGiamKM > 0 ? `<div style="display:flex;justify-content:space-between"><span>Giảm KM${hoaDon.maKhuyenMai ? ` (${escapeHtml(hoaDon.maKhuyenMai)})` : ''}:</span><span>-${escapeHtml(formatVND(tienGiamKM))}</span></div>` : ''}
        ${tienGiamDiem > 0 ? `<div style="display:flex;justify-content:space-between"><span>Đổi điểm (${diemSuDung} điểm):</span><span>-${escapeHtml(formatVND(tienGiamDiem))}</span></div>` : ''}
        ${phiPhucVu > 0 ? `<div style="display:flex;justify-content:space-between"><span>Phí phục vụ${Number(hoaDon.tyLePhiPhucVu || 0) > 0 ? ` (${Number(hoaDon.tyLePhiPhucVu)}%)` : ''}:</span><span>+${escapeHtml(formatVND(phiPhucVu))}</span></div>` : ''}
        ${taxBreakdownHtml}
       </div>`
    : ''
  const tongCong = escapeHtml(formatVND(hoaDon.tongTienThanhToan ?? hoaDon.tongSauGiam ?? hoaDon.tongTamTinh))
  const maHD = escapeHtml(hoaDon.maHoaDon)
  const tenQuanHienThi = escapeHtml((tenQuan || 'QUÁN CÀ PHÊ POS').toUpperCase())
  const sttNum = Number(hoaDon.soThuTuNgay)
  const sttBlock = Number.isInteger(sttNum) && sttNum > 0
    ? `<div style="text-align:center;margin:6px 0 4px;padding:4px 6px;border:2px solid #000;font-size:22px;font-weight:900;letter-spacing:1px">SỐ #${String(sttNum).padStart(2, '0')}</div>`
    : ''

  const watermark = laDonOffline || hoaDon.offline
    ? `<div style="text-align:center;border:1px dashed #000;padding:4px;margin:6px 0;font-weight:bold;font-size:12px">*** ĐƠN OFFLINE — ĐANG CHỜ ĐỒNG BỘ ***</div>`
    : laTamTinh
    ? `<div style="text-align:center;border:1px dashed #000;padding:4px;margin:6px 0;font-weight:bold;font-size:12px">*** PHIẾU TẠM TÍNH (CHƯA THANH TOÁN) ***</div>`
    : laBanSao
    ? `<div style="text-align:center;border:1px dashed #000;padding:4px;margin:6px 0;font-weight:bold;font-size:12px">${escapeHtml(reprintBanner || `*** BẢN SAO - REPRINT (LẦN ${Number(soLanIn)}) ***`)}</div>`
    : ''

  const rows = (hoaDon.danhSachMon || [])
    .filter((m) => !m.daHuy && m.trangThaiPhaChe !== 'DaHuy')
    .map((m) => {
      const mods = Array.isArray(m.modifiersSnapshot) ? m.modifiersSnapshot : Array.isArray(m.modifiers) ? m.modifiers : []
      const modStr = mods
        .map((mod) => {
          const lbl = mod.tenInNgan || mod.tenOption || ''
          const mQty = Number(mod.qty ?? mod.soLuong ?? 1)
          return lbl ? (mQty > 1 ? `${escapeHtml(lbl)} x${mQty}` : escapeHtml(lbl)) : ''
        })
        .filter(Boolean)
        .join(', ')
      const modText = modStr ? `<br/><small>• ${modStr}</small>` : ''
      const tpText = m.toppings?.length
        ? `<br/><small>+ ${m.toppings.map((t) => `${escapeHtml(t.tenTopping)} x${Number(t.soLuong)}`).join(', ')}</small>`
        : ''
      const noteText = m.ghiChu ? `<br/><small><i>(${escapeHtml(m.ghiChu)})</i></small>` : ''
      return `<tr>
        <td style="padding:4px 0"><b>${escapeHtml(m.tenMon)} (${escapeHtml(m.kichThuoc)})</b>${modText}${tpText}${noteText}</td>
        <td align="center" style="vertical-align:top;padding:4px 2px">${Number(m.soLuong)}</td>
        <td align="right" style="vertical-align:top;padding:4px 0">${escapeHtml(formatVND(m.thanhTien))}</td>
      </tr>`
    })
    .join('')

  const khLine = hoaDon.khachHang
    ? `<p style="font-size:11px;margin:2px 0">KH: ${escapeHtml(hoaDon.khachHang.tenKH)} (${escapeHtml(maskPhoneReceipt(hoaDon.khachHang.soDienThoai))}) • ⭐ ${Number(hoaDon.khachHang.diemTichLuy || 0)} điểm</p>`
    : ''

  const einvoiceCode = String(hoaDon.einvoiceLookupCode || hoaDon.einvoice_lookup_code || '').trim()
  const einvoiceFooterHtml = einvoiceCode && !laTamTinh
    ? `<div style="margin-top:6px;padding:4px 6px;border:1px dashed #000;text-align:center;font-size:10px">
         <div><b>XUẤT HÓA ĐƠN ĐIỆN TỬ (MTT)</b></div>
         <div>Mã tra cứu: <b>${escapeHtml(einvoiceCode)}</b></div>
       </div>`
    : ''

  // [Chống Gian lận Bill Recycling] Mã đối chiếu 4 ký tự cuối + giờ in đậm + thông điệp nhắc khách kiểm tra
  const rawIdStr = String(hoaDon.maHoaDon || '')
  const maDoiChieu = escapeHtml(rawIdStr.slice(-4).toUpperCase())
  const gioInHienTai = escapeHtml(
    new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  )

  const plgFooterHtml = plgMeta.showPlgWatermark
    ? `<hr/>
       <div style="text-align:center;font-size:9.5px;margin-top:4px;padding:4px;border:1px dashed #000">
         <div style="font-weight:bold">🚀 Dùng CafePOS MIỄN PHÍ 350 đơn/tháng</div>
         <div>Chủ quán? Quét QR mở quán trong 30 giây!</div>
         <img
           src="https://api.qrserver.com/v1/create-qr-code/?size=110x110&margin=2&data=${encodeURIComponent(plgMeta.plgReferralUrl)}"
           alt="QR đăng ký CafePOS"
           style="width:92px;height:92px;margin:4px auto;display:block"
           onerror="this.style.display='none'"
         />
         <div style="font-size:8.5px;word-break:break-all">${escapeHtml(plgMeta.plgReferralUrl.replace(/^https?:\/\//i, ''))}</div>
       </div>`
    : ''

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Bill #${maHD}</title>
    <style>
      @page { size: 80mm auto; margin: 2mm; }
      body { font-family: monospace; width: 72mm; margin: 0 auto; padding: 6px; color: #000; }
      hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
    </style></head>
    <body>
      <h3 style="text-align:center;margin:0;font-size:15px">☕ ${tenQuanHienThi}</h3>
      ${sttBlock}
      <p style="text-align:center;font-size:11px;margin:2px 0">HĐ: #${maHD} | ${tenBan}</p>
      ${watermark}
      <p style="font-size:11px;margin:2px 0"><b>Giờ tạo: ${gioTao}</b> (In: ${gioInHienTai})</p>
      ${thuNgan ? `<p style="font-size:11px;margin:2px 0">Thu ngân: ${escapeHtml(thuNgan)}</p>` : ''}
      ${khLine}
      <hr/>
      <table>
        <thead><tr><th align="left">Món</th><th>SL</th><th align="right">T.Tiền</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <hr/>
      ${discountRowsHtml}
      <div style="display:flex;justify-content:space-between;font-size:14px;font-weight:bold">
        <span>TỔNG CỘNG:</span><span>${tongCong}</span>
      </div>
      <div style="margin-top:8px;padding:4px 6px;border:1px solid #000;text-align:center;font-size:10px">
        <div><b>MÃ ĐỐI CHIẾU: #${maDoiChieu} • GIỜ IN: ${gioInHienTai}</b></div>
        <div style="margin-top:2px">Quý khách vui lòng kiểm tra ĐÚNG GIỜ IN &amp; SỐ THỨ TỰ trên hóa đơn.</div>
      </div>
      <p style="text-align:center;font-size:10px;margin-top:6px">Cảm ơn Quý khách &amp; Hẹn gặp lại!</p>
      ${einvoiceFooterHtml}
      ${plgFooterHtml}
    </body></html>`

  printHtmlInHiddenIframe(html)
  return { mode: 'BROWSER_FALLBACK' }
}

// [P0] In Tem Nhãn Dán Cốc (50x30mm) — ưu tiên TSPL2 Silent Print qua Local Print Bridge, fallback hidden iframe
// Hỗ trợ startFromCup (In tiếp từ ly k/N khi máy in tem kẹt giấy/hết giấy giữa chừng)
export async function printCupLabels50x30(
  hoaDon,
  { onlyCupIndex = null, startFromCup = 1, skipQueueOnFail = false, browserFallbackOnFail = true } = {}
) {
  if (!hoaDon) return { mode: 'NONE' }

  const bridgeSettings = getBridgeClientSettings()
  const labelPayload = { hoaDon, onlyCupIndex, startFromCup }
  if (bridgeSettings.enabled) {
    try {
      const res = await bridgePrintLabels(labelPayload)
      if (res?.ok) return { mode: res.mode || 'BRIDGE', job: res.job }
    } catch (err) {
      if (!skipQueueOnFail) {
        await enqueueFailedPrintJob({
          tenantId: readCurrentTenantId(),
          kind: 'LABEL',
          maHoaDon: hoaDon.maHoaDon,
          label: `Tem dán cốc 50×30 #${hoaDon.maHoaDon}`,
          payload: labelPayload,
          error: err?.message || 'Không kết nối được máy in Tem',
        })
      }
      if (!browserFallbackOnFail) {
        return { mode: 'FAILED_QUEUED', error: err?.message }
      }
    }
  }

  const monHopLe = (hoaDon.danhSachMon || []).filter((m) => !m.daHuy && m.trangThaiPhaChe !== 'DaHuy')
  const cups = []
  for (const m of monHopLe) {
    const qty = Math.max(1, Number(m.soLuong || 1))
    for (let i = 0; i < qty; i++) {
      cups.push(m)
    }
  }
  if (cups.length === 0) return

  const startIdx = Math.max(0, Math.min(cups.length - 1, (Number(startFromCup) || 1) - 1))
  const tenBan = escapeHtml(hoaDon.ban?.map((b) => b.tenBan).join(', ') || hoaDon.tenBan || 'Mang đi')
  const maHD = escapeHtml(hoaDon.maHoaDon)
  const sttNum = Number(hoaDon.soThuTuNgay)
  const sttTag = Number.isInteger(sttNum) && sttNum > 0
    ? `<b>#${String(sttNum).padStart(2, '0')}</b> • ${tenBan}`
    : `<b>${tenBan}</b> #${maHD}`
  const gio = escapeHtml(new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }))

  const pages = cups
    .map((cup, idx) => ({ cup, idx }))
    .filter(({ idx }) =>
      onlyCupIndex !== null && onlyCupIndex !== undefined
        ? idx === Number(onlyCupIndex) - 1
        : idx >= startIdx
    )
    .map(({ cup, idx }) => {
      const tp = cup.toppings?.length
        ? `<div class="tp">+ ${cup.toppings.map((t) => escapeHtml(t.tenTopping)).join(', ')}</div>`
        : ''
      const note = cup.ghiChu ? `<div class="note">${escapeHtml(cup.ghiChu)}</div>` : ''
      return `<div class="label">
        <div class="head"><span>${sttTag}</span><span>Ly ${idx + 1}/${cups.length} • ${gio}</span></div>
        <div class="name">${escapeHtml(cup.tenMon)} (${escapeHtml(cup.kichThuoc)})</div>
        ${tp}
        ${note}
      </div>`
    })
    .join('')

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Tem #${maHD}</title>
    <style>
      @page { size: 50mm 30mm; margin: 1mm; }
      body { margin: 0; font-family: sans-serif; color: #000; }
      .label { width: 48mm; height: 28mm; box-sizing: border-box; padding: 1.5mm; page-break-after: always; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; border: 0.5px dotted #ccc; }
      .head { display: flex; justify-content: space-between; font-size: 8px; border-bottom: 1px solid #000; padding-bottom: 1px; }
      .name { font-size: 11px; font-weight: 800; line-height: 1.15; margin-top: 2px; }
      .tp { font-size: 8.5px; font-weight: 600; }
      .note { font-size: 8.5px; font-style: italic; }
    </style></head>
    <body>${pages}</body></html>`

  printHtmlInHiddenIframe(html)
}

// [P1 - KDS Barista Label Print & Table Move Correction Label]
export async function printKdsItemLabels50x30(item, { startFromCup = 1, tableMoveNotice = null } = {}) {
  if (!item) return
  const noteWithMove = tableMoveNotice
    ? `[ĐỔI BÀN: ${tableMoveNotice}] ${item.ghiChu || ''}`.trim()
    : item.ghiChu || ''
  return printCupLabels50x30(
    {
      maHoaDon: item.maHoaDon,
      soThuTuNgay: item.soThuTuNgay,
      tenBan: item.tenBan || 'Mang đi',
      ban: item.tenBan ? [{ tenBan: item.tenBan }] : [],
      danhSachMon: [{ ...item, ghiChu: noteWithMove }],
    },
    { startFromCup }
  )
}

// [P1] In Phiếu Chốt Ca Nhiệt (Z-Report K80) — ưu tiên Silent Print ESC/POS qua Print Bridge, fallback hidden iframe
export async function printZReportK80(
  doiSoat,
  {
    tenQuan = '',
    diaChi = '',
    nguoiIn = '',
    laBanSao = false,
    kickDrawer = false,
    skipQueueOnFail = false,
    browserFallbackOnFail = true,
  } = {}
) {
  if (!doiSoat) return { mode: 'NONE' }

  const bridgeSettings = getBridgeClientSettings()
  const zPayload = {
    doiSoat,
    tenQuan: tenQuan || 'QUAN CA PHE POS',
    diaChi,
    nguoiIn,
    laBanSao,
    kickDrawer,
  }
  if (bridgeSettings.enabled) {
    try {
      const res = await bridgePrintZReport(zPayload)
      if (res?.ok) return { mode: res.mode || 'BRIDGE', job: res.job }
    } catch (err) {
      if (!skipQueueOnFail) {
        await enqueueFailedPrintJob({
          tenantId: readCurrentTenantId(),
          kind: 'Z_REPORT',
          maHoaDon: `CA_${doiSoat.maCaThuNgan || ''}`,
          label: `Phiếu chốt ca Z-Report #${doiSoat.maCaThuNgan || ''}`,
          payload: zPayload,
          error: err?.message || 'Không kết nối được máy in Z-Report',
        })
      }
      if (!browserFallbackOnFail) {
        return { mode: 'FAILED_QUEUED', error: err?.message }
      }
    }
  }

  const dt = doiSoat.doanhThu || {}
  const ht = doiSoat.hoanTien || {}
  const tenQuanHienThi = escapeHtml((tenQuan || 'QUÁN CÀ PHÊ POS').toUpperCase())
  const moLuc = escapeHtml(doiSoat.thoiGianMoCa ? formatDateTime(doiSoat.thoiGianMoCa) : '-')
  const dongLuc = escapeHtml(
    doiSoat.thoiGianDongCa ? formatDateTime(doiSoat.thoiGianDongCa) : formatDateTime(new Date().toISOString())
  )
  const gioIn = escapeHtml(formatDateTime(new Date().toISOString()))
  const chenhLechNum = Number(doiSoat.chenhLech || 0)
  const chenhLechText = `${chenhLechNum > 0 ? '+' : ''}${formatVND(chenhLechNum)}`

  const menhGiaEntries =
    doiSoat.chiTietMenhGia && typeof doiSoat.chiTietMenhGia === 'object'
      ? Object.entries(doiSoat.chiTietMenhGia)
          .map(([k, v]) => [Number(k), Number(v)])
          .filter(([mg, sl]) => mg > 0 && sl > 0)
          .sort((a, b) => b[0] - a[0])
      : []

  const menhGiaHtml = menhGiaEntries.length
    ? `<hr/>
       <div class="sec">3. BẢNG ĐẾM MỆNH GIÁ (BLIND DROP)</div>
       <table>
         ${menhGiaEntries
           .map(
             ([mg, sl]) =>
               `<tr><td>${escapeHtml(formatVND(mg))} × ${sl} tờ</td><td align="right">${escapeHtml(formatVND(mg * sl))}</td></tr>`
           )
           .join('')}
       </table>`
    : ''

  const hoanHtml = Number(ht.tong || 0) > 0
    ? `<tr><td>Hoàn tiền sau TT (tổng)</td><td align="right">-${escapeHtml(formatVND(ht.tong))}</td></tr>
       ${Number(ht.tienMat || 0) > 0 ? `<tr><td>&nbsp;&nbsp;- Hoàn tiền mặt</td><td align="right">-${escapeHtml(formatVND(ht.tienMat))}</td></tr>` : ''}
       ${Number(ht.chuyenKhoan || 0) + Number(ht.the || 0) + Number(ht.voucher || 0) > 0 ? `<tr><td>&nbsp;&nbsp;- Hoàn CK / Thẻ</td><td align="right">-${escapeHtml(formatVND((ht.chuyenKhoan || 0) + (ht.the || 0) + (ht.voucher || 0)))}</td></tr>` : ''}`
    : ''

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Z-Report Ca #${escapeHtml(doiSoat.maCaThuNgan)}</title>
    <style>
      @page { size: 80mm auto; margin: 2mm; }
      body { font-family: monospace; width: 72mm; margin: 0 auto; padding: 6px; color: #000; font-size: 11px; }
      hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
      .sec { font-weight: bold; margin: 4px 0 2px; font-size: 11.5px; }
      table { width: 100%; border-collapse: collapse; }
      td { padding: 2px 0; }
      .big { font-size: 14px; font-weight: 900; }
      .box { border: 1.5px solid #000; padding: 4px 6px; margin: 6px 0; }
      .sign { display: flex; justify-content: space-between; margin-top: 14px; text-align: center; font-size: 10px; }
    </style></head>
    <body>
      <h3 style="text-align:center;margin:0;font-size:15px">☕ ${tenQuanHienThi}</h3>
      <div style="text-align:center;font-weight:900;font-size:13px;margin:2px 0">PHIẾU CHỐT CA (Z-REPORT)</div>
      ${laBanSao ? `<div style="text-align:center;border:1px dashed #000;padding:2px;margin:4px 0;font-weight:bold">*** BẢN SAO - REPRINT ***</div>` : ''}
      <hr/>
      <table>
        <tr><td>Mã ca:</td><td align="right"><b>#${escapeHtml(doiSoat.maCaThuNgan)}</b></td></tr>
        <tr><td>Thu ngân:</td><td align="right"><b>${escapeHtml(doiSoat.tenNV || '-')}</b></td></tr>
        <tr><td>Mở ca:</td><td align="right">${moLuc}</td></tr>
        <tr><td>Đóng ca:</td><td align="right">${dongLuc}</td></tr>
        <tr><td>Số hóa đơn đã thu:</td><td align="right"><b>${Number(dt.soHoaDon || 0)} đơn</b></td></tr>
      </table>
      <hr/>
      <div class="sec">1. DOANH THU TRONG CA</div>
      <table>
        <tr><td>Tiền mặt</td><td align="right">${escapeHtml(formatVND(dt.tienMat || 0))}</td></tr>
        <tr><td>Chuyển khoản / VietQR</td><td align="right">${escapeHtml(formatVND(dt.chuyenKhoan || 0))}</td></tr>
        ${Number(dt.the || 0) > 0 ? `<tr><td>Thẻ ngân hàng</td><td align="right">${escapeHtml(formatVND(dt.the))}</td></tr>` : ''}
        ${Number(dt.voucher || 0) > 0 ? `<tr><td>Voucher / Khác</td><td align="right">${escapeHtml(formatVND(dt.voucher))}</td></tr>` : ''}
        <tr><td><b>TỔNG DOANH THU</b></td><td align="right"><b>${escapeHtml(formatVND(dt.tong || 0))}</b></td></tr>
        ${hoanHtml}
      </table>
      <hr/>
      <div class="sec">2. ĐỐI SOÁT KÉT TIỀN MẶT</div>
      <table>
        <tr><td>(+) Tiền mặt đầu ca</td><td align="right">${escapeHtml(formatVND(doiSoat.tienMatDauCa || 0))}</td></tr>
        <tr><td>(+) Doanh thu tiền mặt</td><td align="right">${escapeHtml(formatVND(dt.tienMat || 0))}</td></tr>
        ${Number(ht.tienMat || 0) > 0 ? `<tr><td>(-) Hoàn tiền mặt sau TT</td><td align="right">-${escapeHtml(formatVND(ht.tienMat))}</td></tr>` : ''}
        <tr><td>(+) Thu lặt vặt (Pay-In)</td><td align="right">${escapeHtml(formatVND(doiSoat.thuLatVat || 0))}</td></tr>
        <tr><td>(-) Chi lặt vặt (Pay-Out)</td><td align="right">-${escapeHtml(formatVND(doiSoat.chiLatVat || 0))}</td></tr>
        <tr><td><b>(-) Rút két an toàn (Safe Drop)</b></td><td align="right"><b>-${escapeHtml(formatVND(doiSoat.rutKet || 0))}</b></td></tr>
      </table>
      <div class="box">
        <table>
          <tr><td><b>QUỸ LÝ THUYẾT TẠI KÉT:</b></td><td align="right"><b>${escapeHtml(formatVND(doiSoat.tienMatLyThuyet || 0))}</b></td></tr>
          <tr><td><b>THỰC ĐẾM TẠI KÉT:</b></td><td align="right"><b>${escapeHtml(formatVND(doiSoat.tienMatThucTe ?? 0))}</b></td></tr>
          <tr class="big"><td>CHÊNH LỆCH:</td><td align="right">${escapeHtml(chenhLechText)}</td></tr>
        </table>
        ${doiSoat.trangThai ? `<div style="text-align:center;font-weight:bold;margin-top:3px">${escapeHtml(doiSoat.trangThai)}</div>` : ''}
      </div>
      ${menhGiaHtml}
      ${doiSoat.ghiChuChenhLech ? `<hr/><div><b>Ghi chú:</b> ${escapeHtml(doiSoat.ghiChuChenhLech)}</div>` : ''}
      <div class="sign">
        <div><b>Thu ngân ký</b><br/><br/><br/>(Ký, ghi rõ họ tên)</div>
        <div><b>Quản lý / Chủ quán</b><br/><br/><br/>(Ký xác nhận)</div>
      </div>
      <p style="text-align:center;font-size:9.5px;margin-top:10px">In lúc: ${gioIn}${nguoiIn ? ` • ${escapeHtml(nguoiIn)}` : ''}</p>
    </body></html>`

  printHtmlInHiddenIframe(html)
  return { mode: 'BROWSER_FALLBACK' }
}

// [PHÂN HỆ 6] In lại lệnh từ Hàng đợi In Bền vững (Persistent Print Queue - IndexedDB)
export async function retryPersistentPrintJob(job, { useBrowserFallback = false } = {}) {
  if (!job) return { ok: false, error: 'Lệnh in không hợp lệ' }
  const payload = job.payload || {}
  const attempts = Number(job.attempts || 1) + 1
  try {
    if (useBrowserFallback) {
      if (job.kind === 'LABEL') {
        await printCupLabels50x30(payload.hoaDon, {
          onlyCupIndex: payload.onlyCupIndex || null,
          skipQueueOnFail: true,
          browserFallbackOnFail: true,
        })
      } else if (job.kind === 'Z_REPORT') {
        await printZReportK80(payload.doiSoat, {
          ...payload,
          skipQueueOnFail: true,
          browserFallbackOnFail: true,
        })
      } else {
        await printReceiptK80(payload.hoaDon, {
          ...payload,
          skipQueueOnFail: true,
          browserFallbackOnFail: true,
        })
      }
      await updatePersistentPrintJob(job.id, { status: 'DONE', error: null, attempts })
      return { ok: true, mode: 'BROWSER_FALLBACK' }
    }

    let res = null
    if (job.kind === 'LABEL') {
      res = await bridgePrintLabels(payload)
    } else if (job.kind === 'Z_REPORT') {
      res = await bridgePrintZReport(payload)
    } else {
      res = await bridgePrintReceipt(payload)
    }
    if (res?.ok) {
      await updatePersistentPrintJob(job.id, { status: 'DONE', error: null, attempts })
      return { ok: true, mode: res.mode || 'BRIDGE' }
    }
    throw new Error('Máy in từ chối lệnh in')
  } catch (err) {
    await updatePersistentPrintJob(job.id, {
      status: 'FAILED',
      error: err?.message || 'Vẫn chưa kết nối được máy in',
      attempts,
    })
    return { ok: false, error: err?.message || 'In lại thất bại' }
  }
}
