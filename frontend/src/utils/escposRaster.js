// [Wave 2 — P0-08] Bộ chuyển đổi Canvas/RGBA sang ESC/POS 1-bit Monochrome Raster GS v 0
// Hỗ trợ in bill K80 tiếng Việt có dấu sắc nét 100%, kèm Logo quán & mã VietQR
// Tự động cắt băng dọc BAND_HEIGHT = 256px chống tràn buffer máy in Xprinter / Zywell

export const RASTER_BAND_HEIGHT = 256

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
  const width = Math.max(1, Number(canvas.width || 576))
  const height = Math.max(1, Number(canvas.height || 1))
  const imgData = ctx.getImageData(0, 0, width, height)
  return rgbaToEscPosRasterGsV0(imgData.data, width, height, { bandHeight, threshold })
}

/**
 * Render hóa đơn K80 tiếng Việt có dấu (576px) lên Canvas kèm Logo/VietQR (nếu có)
 * và trả về cả canvas lẫn buffer GS v 0 dạng Base64 để gửi tới Local Print Bridge.
 */
export function renderVietnameseReceiptToCanvas(
  hoaDon,
  {
    tenQuan = 'QUÁN CÀ PHÊ POS',
    diaChi = '',
    thuNgan = '',
    logoImage = null,
    qrImage = null,
    width = 576,
  } = {}
) {
  if (typeof document === 'undefined') {
    throw new Error('renderVietnameseReceiptToCanvas chỉ chạy trên môi trường trình duyệt')
  }
  const items = (hoaDon?.danhSachMon || []).filter((m) => !m.daHuy && m.trangThaiPhaChe !== 'DaHuy')
  const lineH = 30
  const estHeight = Math.max(
    420,
    260 + items.length * 56 + (logoImage ? 100 : 0) + (qrImage ? 220 : 0)
  )
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = estHeight
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, width, estHeight)
  ctx.fillStyle = '#000000'

  let y = 28
  if (logoImage) {
    const logoW = 140
    const logoH = 80
    ctx.drawImage(logoImage, (width - logoW) / 2, y, logoW, logoH)
    y += logoH + 16
  }

  ctx.textAlign = 'center'
  ctx.font = 'bold 28px sans-serif'
  ctx.fillText(String(tenQuan || 'QUÁN CÀ PHÊ POS').toUpperCase(), width / 2, y)
  y += 32

  if (diaChi) {
    ctx.font = '18px sans-serif'
    ctx.fillText(String(diaChi), width / 2, y)
    y += 24
  }

  ctx.font = 'bold 20px sans-serif'
  ctx.fillText(`HĐ #${hoaDon?.maHoaDon || ''}`, width / 2, y)
  y += 28

  ctx.textAlign = 'left'
  ctx.font = '18px sans-serif'
  if (thuNgan) {
    ctx.fillText(`Thu ngân: ${thuNgan}`, 12, y)
    y += 24
  }
  ctx.fillRect(12, y, width - 24, 2)
  y += 24

  for (const m of items) {
    ctx.font = 'bold 20px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(`${m.tenMon} (${m.kichThuoc || 'M'}) x${m.soLuong}`, 12, y)
    ctx.textAlign = 'right'
    ctx.fillText(`${Math.round(Number(m.thanhTien || 0)).toLocaleString('vi-VN')}đ`, width - 12, y)
    y += lineH
  }

  ctx.fillRect(12, y - 10, width - 24, 2)
  y += 20

  const drawRow = (label, value, bold = false) => {
    ctx.font = bold ? 'bold 24px sans-serif' : '20px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(label, 12, y)
    ctx.textAlign = 'right'
    ctx.fillText(value, width - 12, y)
    y += bold ? 34 : 28
  }

  const phiPhucVu = Number(hoaDon?.phiPhucVu ?? hoaDon?.tienPhiPhucVu ?? 0)
  const thueVAT = Number(hoaDon?.thueVAT ?? hoaDon?.tienThueVAT ?? hoaDon?.tienVat ?? 0)
  if (phiPhucVu > 0) drawRow('Phí phục vụ:', `+${Math.round(phiPhucVu).toLocaleString('vi-VN')}đ`)
  if (thueVAT > 0) drawRow('Thuế VAT:', `+${Math.round(thueVAT).toLocaleString('vi-VN')}đ`)

  const tongCong = Number(hoaDon?.tongTienThanhToan ?? hoaDon?.tongSauGiam ?? hoaDon?.tongTamTinh ?? 0)
  drawRow('TỔNG CỘNG:', `${Math.round(tongCong).toLocaleString('vi-VN')}đ`, true)

  if (qrImage) {
    const qrSize = 190
    ctx.drawImage(qrImage, (width - qrSize) / 2, y + 6, qrSize, qrSize)
    y += qrSize + 24
  }

  const rasterBytes = canvasToEscPosRasterGsV0(canvas)
  return { canvas, rasterBytes }
}
