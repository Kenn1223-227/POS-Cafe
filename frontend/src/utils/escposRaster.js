// [Wave 2 — P0-08 / Batch 5] Bộ chuyển đổi Canvas/RGBA sang ESC/POS 1-bit Monochrome Raster GS v 0
// Hỗ trợ in bill K80 (576px) & K58 (384px) tiếng Việt có dấu sắc nét 100%, kèm Logo quán & mã VietQR
// Tự động cắt băng dọc BAND_HEIGHT = 256px chống tràn buffer máy in Xprinter / Zywell

export const RASTER_BAND_HEIGHT = 256

export const PAPER_WIDTH_PX = {
  K80: 576,
  K58: 384,
}

export function resolvePaperWidthPx(paperWidth = 'K80') {
  return String(paperWidth || 'K80').toUpperCase() === 'K58'
    ? PAPER_WIDTH_PX.K58
    : PAPER_WIDTH_PX.K80
}

export function uint8ToBase64(uint8) {
  if (!uint8 || uint8.length === 0) return ''
  if (typeof globalThis.Buffer !== 'undefined') {
    return globalThis.Buffer.from(uint8).toString('base64')
  }
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < uint8.length; i += chunkSize) {
    const slice = uint8.subarray(i, Math.min(i + chunkSize, uint8.length))
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

export function base64ToUint8(base64) {
  const clean = String(base64 || '').trim()
  if (!clean) return new Uint8Array(0)
  if (typeof globalThis.Buffer !== 'undefined') {
    return new Uint8Array(globalThis.Buffer.from(clean, 'base64'))
  }
  const binary = atob(clean)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

/**
 * Đóng gói mảng byte GS v 0 thành gói ESC/POS hoàn chỉnh cho WebSerial / WebUSB / WebBluetooth / RawBT
 * (ESC @ Init + [tùy chọn RJ11 Kick] + ESC a 1 Center + GS v 0 Raster + Feed + [tùy chọn GS V 66 Auto-Cut])
 */
export function wrapEscPosRasterReceiptBytes(
  rasterBytes,
  { kickDrawer = false, autoCut = true } = {}
) {
  const payload = rasterBytes instanceof Uint8Array ? rasterBytes : new Uint8Array(rasterBytes || [])
  const prefix = kickDrawer
    ? [0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa, 0x1b, 0x61, 0x01]
    : [0x1b, 0x40, 0x1b, 0x61, 0x01]
  const suffix = autoCut
    ? [0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x42, 0x00]
    : [0x0a, 0x0a, 0x0a]

  const out = new Uint8Array(prefix.length + payload.length + suffix.length)
  out.set(prefix, 0)
  out.set(payload, prefix.length)
  out.set(suffix, prefix.length + payload.length)
  return out
}

/**
 * Chuyển mảng pixel RGBA (Uint8ClampedArray / Uint8Array) thành lệnh nhị phân ESC/POS GS v 0
 * Header mỗi băng: 0x1D 0x76 0x30 0x00 xL xH yL yH + (widthBytes * bandH) bytes
 */
export function rgbaToEscPosRasterGsV0(
  rgbaData,
  width,
  height,
  { bandHeight = RASTER_BAND_HEIGHT, threshold = 160 } = {}
) {
  const w = Math.max(1, Math.floor(Number(width) || 0))
  const h = Math.max(1, Math.floor(Number(height) || 0))
  const maxBand = Math.max(1, Math.min(256, Math.floor(Number(bandHeight) || RASTER_BAND_HEIGHT)))
  const widthBytes = Math.ceil(w / 8)

  const mono = new Uint8Array(widthBytes * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4
      const r = rgbaData[idx] ?? 255
      const g = rgbaData[idx + 1] ?? 255
      const b = rgbaData[idx + 2] ?? 255
      const a = rgbaData[idx + 3] ?? 255
      const lum = a < 128 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b
      if (lum < threshold) {
        mono[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
  }

  const bandCount = Math.ceil(h / maxBand)
  const totalBytes = bandCount * 8 + widthBytes * h
  const out = new Uint8Array(totalBytes)
  const xL = widthBytes & 0xff
  const xH = (widthBytes >> 8) & 0xff

  let offset = 0
  for (let yStart = 0; yStart < h; yStart += maxBand) {
    const bandH = Math.min(maxBand, h - yStart)
    const yL = bandH & 0xff
    const yH = (bandH >> 8) & 0xff

    out[offset++] = 0x1d // GS
    out[offset++] = 0x76 // 'v'
    out[offset++] = 0x30 // '0'
    out[offset++] = 0x00 // normal mode (m = 0)
    out[offset++] = xL
    out[offset++] = xH
    out[offset++] = yL
    out[offset++] = yH

    const sliceStart = yStart * widthBytes
    const sliceEnd = sliceStart + bandH * widthBytes
    out.set(mono.subarray(sliceStart, sliceEnd), offset)
    offset += bandH * widthBytes
  }

  return out
}

/**
 * Chuyển trực tiếp HTMLCanvasElement (hoặc mock canvas có getContext('2d').getImageData)
 * thành mảng byte ESC/POS GS v 0
 */
export function canvasToEscPosRasterGsV0(
  canvas,
  { bandHeight = RASTER_BAND_HEIGHT, threshold = 160 } = {}
) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error('Canvas không hợp lệ để chuyển đổi raster ESC/POS GS v 0')
  }
  const ctx = canvas.getContext('2d')
  const width = Math.max(1, Number(canvas.width || PAPER_WIDTH_PX.K80))
  const height = Math.max(1, Number(canvas.height || 1))
  const imgData = ctx.getImageData(0, 0, width, height)
  return rgbaToEscPosRasterGsV0(imgData.data, width, height, { bandHeight, threshold })
}

function formatVndVi(n) {
  return `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`
}

function maskPhoneVi(sdt) {
  const raw = String(sdt || '').trim()
  if (!raw) return ''
  if (raw.length < 7) {
    if (raw.length <= 2) return '***'
    return `${raw.slice(0, 1)}***${raw.slice(-1)}`
  }
  return `${raw.slice(0, 4)}***${raw.slice(-3)}`
}

function wrapCanvasText(ctx, text, maxWidth) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const lines = []
  let current = words[0]
  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate
    } else {
      lines.push(current)
      current = words[i]
    }
  }
  lines.push(current)
  return lines
}

/**
 * Render hóa đơn K80 (576px) hoặc K58 (384px) tiếng Việt có dấu lên Canvas
 * kèm Logo/VietQR (nếu có) và trả về canvas + rasterBytes + rasterBase64 (GS v 0).
 */
export function renderVietnameseReceiptToCanvas(
  hoaDon,
  {
    tenQuan = 'QUÁN CÀ PHÊ POS',
    diaChi = '',
    thuNgan = '',
    soLanIn = 1,
    laBanSao = false,
    reprintBanner = null,
    laTamTinh = false,
    laDonOffline = false,
    showPlgWatermark = false,
    plgReferralUrl = '',
    logoImage = null,
    qrImage = null,
    paperWidth = 'K80',
    width = undefined,
  } = {}
) {
  if (typeof document === 'undefined') {
    throw new Error('renderVietnameseReceiptToCanvas chỉ chạy trên môi trường trình duyệt')
  }

  const targetWidth = Math.max(256, Math.floor(Number(width) || resolvePaperWidthPx(paperWidth)))
  const isCompact = targetWidth <= 400
  const pad = isCompact ? 8 : 14
  const fontScale = isCompact ? 0.76 : 1
  const px = (n) => Math.max(12, Math.round(n * fontScale))
  const fontFamily = '"Segoe UI", "Roboto", "Arial", sans-serif'

  const items = (hoaDon?.danhSachMon || []).filter((m) => !m.daHuy && m.trangThaiPhaChe !== 'DaHuy')
  const taxBreakdown = Array.isArray(hoaDon?.taxBreakdown || hoaDon?.tax_breakdown_json)
    ? hoaDon.taxBreakdown || hoaDon.tax_breakdown_json
    : []
  const payments = Array.isArray(hoaDon?.danhSachThanhToan) ? hoaDon.danhSachThanhToan : []

  // Dự trù chiều cao đủ rộng rồi cắt gọn đúng theo nội dung thực tế sau khi vẽ
  const estHeight = Math.max(
    640,
    520 +
      items.length * 110 +
      taxBreakdown.length * 36 +
      payments.length * 32 +
      (logoImage ? 120 : 0) +
      (qrImage ? 240 : 0) +
      (showPlgWatermark ? 120 : 0)
  )

  const workCanvas = document.createElement('canvas')
  workCanvas.width = targetWidth
  workCanvas.height = estHeight
  const ctx = workCanvas.getContext('2d')
  if (!ctx) {
    throw new Error('Trình duyệt không hỗ trợ Canvas 2D để dựng ảnh hóa đơn tiếng Việt')
  }

  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, targetWidth, estHeight)
  ctx.fillStyle = '#000000'
  ctx.textBaseline = 'top'

  let y = 16
  const drawDivider = (thick = 2) => {
    ctx.fillRect(pad, y, targetWidth - pad * 2, thick)
    y += thick + 10
  }

  const drawCentered = (text, size, bold = false) => {
    ctx.font = `${bold ? 'bold ' : ''}${px(size)}px ${fontFamily}`
    ctx.textAlign = 'center'
    for (const line of wrapCanvasText(ctx, text, targetWidth - pad * 2)) {
      ctx.fillText(line, targetWidth / 2, y)
      y += Math.round(px(size) * 1.35)
    }
  }

  const drawRow = (left, right, size = 20, bold = false) => {
    ctx.font = `${bold ? 'bold ' : ''}${px(size)}px ${fontFamily}`
    const rightStr = String(right || '')
    const rightW = ctx.measureText(rightStr).width
    const maxLeftW = Math.max(80, targetWidth - pad * 2 - rightW - 10)
    const leftLines = wrapCanvasText(ctx, left, maxLeftW)
    const lineStep = Math.round(px(size) * 1.35)
    leftLines.forEach((line, idx) => {
      ctx.textAlign = 'left'
      ctx.fillText(line, pad, y)
      if (idx === 0) {
        ctx.textAlign = 'right'
        ctx.fillText(rightStr, targetWidth - pad, y)
      }
      y += lineStep
    })
  }

  // Watermark / Reprint / Tạm tính / Offline
  const effectiveReprintBanner =
    reprintBanner ||
    (laBanSao || Number(soLanIn) >= 2
      ? `*** BẢN SAO - IN LẠI LẦN ${Math.max(2, Number(soLanIn || 2))} ***`
      : null)
  if (effectiveReprintBanner) {
    drawCentered(effectiveReprintBanner, 20, true)
    y += 4
  }
  if (laDonOffline || hoaDon?.offline) {
    drawCentered('*** ĐƠN OFFLINE — ĐANG CHỜ ĐỒNG BỘ ***', 19, true)
    y += 4
  } else if (laTamTinh) {
    drawCentered('*** PHIẾU TẠM TÍNH (CHƯA THANH TOÁN) ***', 19, true)
    y += 4
  }

  if (logoImage) {
    const logoW = Math.round(140 * fontScale)
    const logoH = Math.round(80 * fontScale)
    ctx.drawImage(logoImage, (targetWidth - logoW) / 2, y, logoW, logoH)
    y += logoH + 12
  }

  drawCentered(String(tenQuan || 'QUÁN CÀ PHÊ POS').toUpperCase(), 28, true)
  if (diaChi) drawCentered(diaChi, 18, false)

  const sttNum = Number(hoaDon?.soThuTuNgay)
  if (Number.isInteger(sttNum) && sttNum > 0) {
    y += 4
    drawCentered(`SỐ #${String(sttNum).padStart(2, '0')}`, 30, true)
  }

  const maHD = hoaDon?.maHoaDon || 'TEST'
  const tenBan = hoaDon?.ban?.map((b) => b.tenBan).join(', ') || 'Mang đi'
  drawCentered(`HĐ #${maHD} | ${tenBan}`, 20, true)
  y += 6

  // Meta
  ctx.textAlign = 'left'
  ctx.font = `${px(18)}px ${fontFamily}`
  const gio = new Date(hoaDon?.thoiGianTao || hoaDon?.thoigiantao || Date.now()).toLocaleString('vi-VN')
  ctx.fillText(`Giờ: ${gio}`, pad, y)
  y += Math.round(px(18) * 1.35)
  if (thuNgan) {
    ctx.fillText(`Thu ngân: ${thuNgan}`, pad, y)
    y += Math.round(px(18) * 1.35)
  }
  if (hoaDon?.khachHang) {
    const maskedPhone = maskPhoneVi(hoaDon.khachHang.soDienThoai)
    ctx.fillText(
      `KH: ${hoaDon.khachHang.tenKH}${maskedPhone ? ` (${maskedPhone})` : ''}`,
      pad,
      y
    )
    y += Math.round(px(18) * 1.35)
  }

  y += 4
  drawDivider(2)
  drawRow('MÓN / SL', 'THÀNH TIỀN', 19, true)
  drawDivider(1)

  for (const m of items) {
    const title = `${m.tenMon}${m.kichThuoc ? ` (${m.kichThuoc})` : ''} x${m.soLuong}`
    drawRow(title, formatVndVi(m.thanhTien), 20, true)
    if (m.toppings?.length) {
      const tpStr = `+ ${m.toppings.map((t) => `${t.tenTopping} x${t.soLuong}`).join(', ')}`
      ctx.font = `${px(17)}px ${fontFamily}`
      ctx.textAlign = 'left'
      for (const line of wrapCanvasText(ctx, tpStr, targetWidth - pad * 2 - 14)) {
        ctx.fillText(line, pad + 14, y)
        y += Math.round(px(17) * 1.32)
      }
    }
    if (m.ghiChu) {
      ctx.font = `italic ${px(17)}px ${fontFamily}`
      ctx.textAlign = 'left'
      for (const line of wrapCanvasText(ctx, `(${m.ghiChu})`, targetWidth - pad * 2 - 14)) {
        ctx.fillText(line, pad + 14, y)
        y += Math.round(px(17) * 1.32)
      }
    }
    y += 4
  }

  drawDivider(2)

  const tienGiamKM = Number(hoaDon?.tienGiamKM || 0)
  const tienGiamDiem = Number(hoaDon?.tienGiamDiem || 0)
  const diemSuDung = Number(hoaDon?.diemSuDung || 0)
  const phiPhucVu = Number(hoaDon?.phiPhucVu ?? hoaDon?.tienPhiPhucVu ?? 0)
  const thueVAT = Number(hoaDon?.thueVAT ?? hoaDon?.tienThueVAT ?? hoaDon?.tienVat ?? 0)

  if (tienGiamKM > 0 || tienGiamDiem > 0 || phiPhucVu > 0 || thueVAT > 0 || taxBreakdown.length > 0) {
    drawRow('Tạm tính:', formatVndVi(hoaDon?.tongTamTinh ?? 0), 19, false)
    if (tienGiamKM > 0) {
      const labelKm = hoaDon?.maKhuyenMai ? `Giảm KM (${hoaDon.maKhuyenMai}):` : 'Giảm khuyến mãi:'
      drawRow(labelKm, `-${formatVndVi(tienGiamKM)}`, 19, false)
    }
    if (tienGiamDiem > 0) {
      drawRow(`Đổi điểm (${diemSuDung} điểm):`, `-${formatVndVi(tienGiamDiem)}`, 19, false)
    }
    if (phiPhucVu > 0) {
      const pctSrv = Number(hoaDon?.tyLePhiPhucVu || 0)
      const srvLabel = pctSrv > 0 ? `Phí phục vụ (${pctSrv}%):` : 'Phí phục vụ:'
      drawRow(srvLabel, `+${formatVndVi(phiPhucVu)}`, 19, false)
    }
    if (taxBreakdown.length > 0) {
      for (const b of taxBreakdown) {
        const rateLbl = b.isKct ? 'KCT (0%)' : `VAT ${Number(b.vatRate || 0)}%`
        drawRow(
          `  ${rateLbl} (DT ${formatVndVi(b.taxableBase || 0)}):`,
          formatVndVi(b.vatAmount || 0),
          17,
          false
        )
      }
    } else if (thueVAT > 0) {
      const pctVat = Number(hoaDon?.tyLeThueVAT || 0)
      const vatLabel = pctVat > 0 ? `Thuế VAT (${pctVat}%):` : 'Thuế VAT:'
      drawRow(vatLabel, `+${formatVndVi(thueVAT)}`, 19, false)
    }
  }

  const tongCong = Number(hoaDon?.tongTienThanhToan ?? hoaDon?.tongSauGiam ?? hoaDon?.tongTamTinh ?? 0)
  drawRow('TỔNG CỘNG:', formatVndVi(tongCong), 25, true)

  if (payments.length > 0) {
    for (const p of payments) {
      drawRow(`  TT (${p.phuongThucTT}):`, formatVndVi(p.soTien), 18, false)
    }
  }

  y += 4
  drawDivider(1)

  const maDoiChieu = String(maHD).slice(-4).toUpperCase()
  const gioIn = new Date().toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  drawCentered(`MÃ ĐỐI CHIẾU: #${maDoiChieu} | GIỜ IN: ${gioIn}`, 17, true)
  drawCentered('Quý khách vui lòng kiểm tra ĐÚNG GIỜ IN & STT', 16, false)

  const einvoiceCode = String(hoaDon?.einvoiceLookupCode || hoaDon?.einvoice_lookup_code || '').trim()
  if (einvoiceCode && !laTamTinh) {
    y += 4
    drawCentered(`HÓA ĐƠN ĐIỆN TỬ (MTT) - MÃ: ${einvoiceCode}`, 17, true)
  }

  if (qrImage) {
    const qrSize = Math.round(180 * fontScale)
    ctx.drawImage(qrImage, (targetWidth - qrSize) / 2, y + 6, qrSize, qrSize)
    y += qrSize + 18
  }

  drawCentered('Cảm ơn Quý khách & Hẹn gặp lại!', 19, true)

  if (showPlgWatermark) {
    y += 4
    drawDivider(1)
    drawCentered('Phần mềm CafePOS — Mở quán trong 30s', 16, true)
    if (plgReferralUrl) {
      drawCentered(String(plgReferralUrl).replace(/^https?:\/\//i, ''), 15, false)
    }
  }

  const finalHeight = Math.min(estHeight, Math.max(120, Math.ceil(y + 16)))
  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = finalHeight
  const finalCtx = canvas.getContext('2d')
  if (finalCtx) {
    finalCtx.fillStyle = '#FFFFFF'
    finalCtx.fillRect(0, 0, targetWidth, finalHeight)
    finalCtx.drawImage(workCanvas, 0, 0, targetWidth, finalHeight, 0, 0, targetWidth, finalHeight)
  }

  const targetCanvas = finalCtx ? canvas : workCanvas
  const rasterBytes = canvasToEscPosRasterGsV0(targetCanvas)
  return {
    canvas: targetCanvas,
    rasterBytes,
    rasterBase64: uint8ToBase64(rasterBytes),
    width: targetCanvas.width,
    height: targetCanvas.height,
  }
}
