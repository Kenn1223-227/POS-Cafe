/**
 * =============================================================================
 * PHÂN HỆ 2 - TRỤ CỘT 2: HỆ THỐNG ÂM THANH WEB AUDIO ĐA KỊCH BẢN & SCREEN WAKE LOCK
 * - 6 âm sắc riêng biệt (tổng hợp trực tiếp bằng OscillatorNode, 0 file MP3 ngoài)
 * - Mở khóa autoplay Safari/iPadOS + giữ sáng màn hình Wake Lock tự động khôi phục
 * =============================================================================
 */

let audioCtx = null
let wakeLockSentinel = null
let wakeLockListenerBound = false

function getAudioContext() {
  if (typeof window === 'undefined') return null
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return null
  if (!audioCtx) audioCtx = new Ctx()
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {})
  }
  return audioCtx
}

function playToneSequence(notes = [], { type = 'sine', volume = 0.22 } = {}) {
  try {
    const ctx = getAudioContext()
    if (!ctx) return
    const base = ctx.currentTime
    for (const { freq, offset = 0, duration = 0.2, gain = volume, wave = type } of notes) {
      const osc = ctx.createOscillator()
      const gainNode = ctx.createGain()
      osc.type = wave
      osc.frequency.setValueAtTime(freq, base + offset)
      gainNode.gain.setValueAtTime(0.001, base + offset)
      gainNode.gain.exponentialRampToValueAtTime(Math.max(0.002, gain), base + offset + 0.015)
      gainNode.gain.exponentialRampToValueAtTime(0.001, base + offset + duration)
      osc.connect(gainNode)
      gainNode.connect(ctx.destination)
      osc.start(base + offset)
      osc.stop(base + offset + duration + 0.02)
    }
  } catch {
    // Bỏ qua nếu trình duyệt chưa được người dùng tương tác mở khóa AudioContext
  }
}

// 1. Đơn mới (Ting-tong thanh thoát 2 nốt cao)
export function playNewOrderSound() {
  playToneSequence(
    [
      { freq: 880, offset: 0, duration: 0.26 },
      { freq: 1174.66, offset: 0.14, duration: 0.34 },
    ],
    { type: 'sine', volume: 0.24 }
  )
}

// 2. Đơn Gấp / Vé Làm Lại (⚡ RUSH / REMAKE: Bíp-bíp-bíp dồn dập)
export function playRushOrRemakeSound() {
  playToneSequence(
    [
      { freq: 1320, offset: 0, duration: 0.14, wave: 'triangle' },
      { freq: 1320, offset: 0.16, duration: 0.14, wave: 'triangle' },
      { freq: 1568, offset: 0.32, duration: 0.24, wave: 'triangle' },
    ],
    { volume: 0.28 }
  )
}

// 3. Hủy món / Đổi món (Âm trầm cảnh báo Barista dừng tay ngay lập tức!)
export function playCancelSound() {
  playToneSequence(
    [
      { freq: 440, offset: 0, duration: 0.22, wave: 'sawtooth', gain: 0.2 },
      { freq: 311, offset: 0.18, duration: 0.32, wave: 'sawtooth', gain: 0.22 },
      { freq: 261.63, offset: 0.42, duration: 0.35, wave: 'sawtooth', gain: 0.2 },
    ]
  )
}

// 4. Chuyển bàn / Gộp bàn (Chime đổi trạng thái 2 nốt trung)
export function playTableMovedSound() {
  playToneSequence(
    [
      { freq: 659.25, offset: 0, duration: 0.18, wave: 'triangle' },
      { freq: 987.77, offset: 0.16, duration: 0.26, wave: 'triangle' },
    ],
    { volume: 0.22 }
  )
}

// 5. Cảnh báo Quá hạn SLA Đỏ (Bíp cảnh báo kép)
export function playSlaRedAlertSound() {
  playToneSequence(
    [
      { freq: 980, offset: 0, duration: 0.18, wave: 'square', gain: 0.15 },
      { freq: 740, offset: 0.22, duration: 0.24, wave: 'square', gain: 0.15 },
    ]
  )
}

// 6. Đơn hoàn tất 100% đa quầy tại Expo (ORDER_ALL_READY — 3 nốt hợp âm trưởng vui tai)
export function playAllReadySound() {
  playToneSequence(
    [
      { freq: 523.25, offset: 0, duration: 0.16 },
      { freq: 659.25, offset: 0.12, duration: 0.16 },
      { freq: 783.99, offset: 0.24, duration: 0.3 },
    ],
    { type: 'sine', volume: 0.24 }
  )
}

// 7. Thu tiền mặt thành công (POS)
export function playCashSuccessSound() {
  playToneSequence(
    [
      { freq: 1046.5, offset: 0, duration: 0.14 },
      { freq: 1318.5, offset: 0.11, duration: 0.24 },
    ],
    { type: 'sine', volume: 0.22 }
  )
}

// 8. Nhận tiền VietQR thành công (POS)
export function playVietQrReceivedSound() {
  playToneSequence(
    [
      { freq: 783.99, offset: 0, duration: 0.14 },
      { freq: 1046.5, offset: 0.12, duration: 0.16 },
      { freq: 1567.98, offset: 0.24, duration: 0.3 },
    ],
    { type: 'sine', volume: 0.25 }
  )
}

// 9. Đọc giọng nói tiếng Việt (Web Speech API) cho thông báo nhận tiền chuyển khoản
export function speakVietnamese(text) {
  try {
    if (typeof window === 'undefined' || !window.speechSynthesis || !text) return
    const utter = new SpeechSynthesisUtterance(String(text))
    utter.lang = 'vi-VN'
    utter.rate = 1.05
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utter)
  } catch {
    // ignore
  }
}

async function requestWakeLockInternal() {
  if (typeof navigator === 'undefined' || !navigator.wakeLock?.request) return false
  try {
    if (wakeLockSentinel && !wakeLockSentinel.released) return true
    wakeLockSentinel = await navigator.wakeLock.request('screen')
    return true
  } catch {
    return false
  }
}

/**
 * Gọi trong 1 cú chạm nút "🔊 Kích hoạt âm thanh & Giữ sáng màn hình":
 * - Mở khóa Web AudioContext (vượt autoplay policy Safari/iPadOS)
 * - Kích hoạt Screen Wake Lock để iPad quầy Bar không tự khóa màn hình giữa ca
 * - Tự động xin lại Wake Lock khi tab quay lại visible
 */
export async function unlockAudioAndWakeLock() {
  const ctx = getAudioContext()
  let audioUnlocked = false
  if (ctx) {
    try {
      await ctx.resume()
      audioUnlocked = ctx.state === 'running'
      playToneSequence([{ freq: 880, offset: 0, duration: 0.12 }], { volume: 0.14 })
    } catch {
      audioUnlocked = false
    }
  }
  const wakeLockActive = await requestWakeLockInternal()
  if (!wakeLockListenerBound && typeof document !== 'undefined') {
    wakeLockListenerBound = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void requestWakeLockInternal()
      }
    })
  }
  return { audioUnlocked, wakeLockActive }
}
