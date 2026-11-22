import { useState, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'
import { caService } from '../../../services/caService'
import FeatureLockedCard from '../../../components/FeatureLockedCard'
import { formatDateTime } from '../../../utils/format'

const DEFAULT_EVENTS_META = [
  { key: 'DRAWER_NO_SALE_KICK', label: '💰 Mở két tiền không bán hàng (No-Sale RJ11)', severity: 'HIGH' },
  { key: 'RECEIPT_REPRINT', label: '⚠️ In lại hóa đơn (Reprint lần 2+)', severity: 'MEDIUM' },
  { key: 'ITEM_VOID_WASTE', label: '🗑️ Hủy món đã pha chế (Hao hụt kho)', severity: 'HIGH' },
  { key: 'MANUAL_TRANSFER_CONFIRMED', label: '⚠️ Xác nhận chuyển khoản thủ công tại quầy', severity: 'HIGH' },
  { key: 'SHIFT_CLOSE_DIFF', label: '🚨 Chốt ca lệch quỹ tiền mặt', severity: 'CRITICAL' },
  { key: 'ORDER_POST_PAYMENT_REFUND', label: '↩️ Hoàn tiền / Hủy đơn sau thanh toán', severity: 'CRITICAL' },
  { key: 'CASH_SAFE_DROP', label: '🏦 Rút két an toàn (Safe Drop)', severity: 'INFO' },
  { key: 'LOYALTY_HARVESTING_SUSPECTED', label: '🎯 Nghi vấn tích điểm khống (1 SĐT >= 4 đơn tiền mặt/ca)', severity: 'HIGH' },
  { key: 'DISCOUNT_VELOCITY_ABUSE', label: '📉 Bất thường tỷ lệ đơn giảm giá (>2x trung bình quán)', severity: 'HIGH' },
]

export default function FraudAlertConfigPanel({ allowAuditLogs, user }) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [eventMeta, setEventMeta] = useState(DEFAULT_EVENTS_META)
  const [recentDeliveries, setRecentDeliveries] = useState([])
  const [testResult, setTestResult] = useState(null)

  const [form, setForm] = useState({
    enabled: false,
    telegramBotToken: '',
    hasTelegramBotToken: false,
    telegramBotTokenMasked: '',
    clearTelegramToken: false,
    telegramChatId: '',
    webhookUrl: '',
    webhookSecret: '',
    hasWebhookSecret: false,
    webhookSecretMasked: '',
    clearWebhookSecret: false,
    shiftDiffThresholdVnd: 1000,
    events: Object.fromEntries(DEFAULT_EVENTS_META.map((e) => [e.key, true])),
  })

  const loadConfig = useCallback(async () => {
    if (!allowAuditLogs) return
    setLoading(true)
    try {
      const data = await caService.getAlertConfig()
      if (Array.isArray(data.eventMeta) && data.eventMeta.length > 0) {
        setEventMeta(data.eventMeta)
      }
      if (data.config) {
        setForm({
          enabled: Boolean(data.config.enabled),
          telegramBotToken: '',
          hasTelegramBotToken: Boolean(data.config.hasTelegramBotToken),
          telegramBotTokenMasked: data.config.telegramBotTokenMasked || '',
          clearTelegramToken: false,
          telegramChatId: data.config.telegramChatId || '',
          webhookUrl: data.config.webhookUrl || '',
          webhookSecret: '',
          hasWebhookSecret: Boolean(data.config.hasWebhookSecret),
          webhookSecretMasked: data.config.webhookSecretMasked || '',
          clearWebhookSecret: false,
          shiftDiffThresholdVnd: Number(data.config.shiftDiffThresholdVnd ?? 1000),
          events: data.config.events || Object.fromEntries(DEFAULT_EVENTS_META.map((e) => [e.key, true])),
        })
      }
      setRecentDeliveries(Array.isArray(data.recentDeliveries) ? data.recentDeliveries : [])
    } catch {
      // Interceptor đã xử lý
    } finally {
      setLoading(false)
    }
  }, [allowAuditLogs])

  useEffect(() => {
    if (!allowAuditLogs) return undefined
    const t = setTimeout(() => {
      void loadConfig()
    }, 0)
    return () => clearTimeout(t)
  }, [allowAuditLogs, loadConfig])

  const handleToggleEvent = (key) => {
    setForm((prev) => ({
      ...prev,
      events: { ...prev.events, [key]: !prev.events[key] },
    }))
  }

  const handleSave = async (e) => {
    e.preventDefault()
    setSaving(true)
    setTestResult(null)
    try {
      const res = await caService.saveAlertConfig({
        enabled: form.enabled,
        telegramBotToken: form.telegramBotToken || undefined,
        clearTelegramToken: form.clearTelegramToken,
        telegramChatId: form.telegramChatId,
        webhookUrl: form.webhookUrl,
        webhookSecret: form.webhookSecret || undefined,
        clearWebhookSecret: form.clearWebhookSecret,
        shiftDiffThresholdVnd: Number(form.shiftDiffThresholdVnd || 0),
        events: form.events,
      })
      toast.success(res.message || 'Đã lưu cấu hình cảnh báo gian lận!')
      if (res.config) {
        setForm((prev) => ({
          ...prev,
          enabled: Boolean(res.config.enabled),
          telegramBotToken: '',
          hasTelegramBotToken: Boolean(res.config.hasTelegramBotToken),
          telegramBotTokenMasked: res.config.telegramBotTokenMasked || '',
          clearTelegramToken: false,
          telegramChatId: res.config.telegramChatId || '',
          webhookUrl: res.config.webhookUrl || '',
          webhookSecret: '',
          hasWebhookSecret: Boolean(res.config.hasWebhookSecret),
          webhookSecretMasked: res.config.webhookSecretMasked || '',
          clearWebhookSecret: false,
          shiftDiffThresholdVnd: Number(res.config.shiftDiffThresholdVnd ?? 1000),
          events: res.config.events || prev.events,
        }))
      }
    } catch {
      // Interceptor đã xử lý
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await caService.testAlertConfig({
        telegramBotToken: form.telegramBotToken || undefined,
        telegramChatId: form.telegramChatId || undefined,
        webhookUrl: form.webhookUrl || undefined,
        webhookSecret: form.webhookSecret || undefined,
      })
      setTestResult(res)
      if (Array.isArray(res.recentDeliveries)) {
        setRecentDeliveries(res.recentDeliveries)
      }
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
    } catch {
      // Interceptor đã xử lý
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-extrabold text-base text-gray-800">
            🔔 Cảnh Báo Gian Lận Tức Thời về Telegram / Webhook Chủ Quán
          </h3>
          <p className="text-xs text-gray-500">
            Tự động đẩy tin nhắn ngay lập tức về điện thoại chủ quán khi có thao tác rủi ro (No-Sale, Reprint, Hủy hao hụt, CK tay, Lệch ca)
          </p>
        </div>
        {allowAuditLogs && (
          <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border bg-stone-50 cursor-pointer text-xs font-extrabold">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))}
              className="w-4 h-4 accent-amber-700"
            />
            <span className={form.enabled ? 'text-emerald-700' : 'text-stone-500'}>
              {form.enabled ? '🟢 Đang BẬT cảnh báo' : '⚪ Đang TẮT'}
            </span>
          </label>
        )}
      </div>

      {!allowAuditLogs ? (
        <FeatureLockedCard
          title="Cảnh báo Gian lận Tức thời (Telegram / Webhook)"
          description="Đẩy thông báo tức thì về Telegram, Slack, Discord hoặc n8n/Zalo Bridge khi có No-Sale mở két, in lại bill, hủy hao hụt, xác nhận CK tay hoặc lệch quỹ chốt ca."
          requiredPlan="PRO"
          currentPlan={user?.goiCuoc || 'STARTER'}
        />
      ) : loading ? (
        <p className="text-xs text-gray-400 py-4">Đang tải cấu hình cảnh báo...</p>
      ) : (
        <form onSubmit={handleSave} className="space-y-4 text-xs">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Kênh 1: Telegram Bot */}
            <div className="p-4 rounded-xl bg-sky-50/70 border border-sky-200 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-extrabold text-sky-950 text-sm">✈️ Kênh Telegram Bot</h4>
                {form.hasTelegramBotToken && !form.clearTelegramToken && (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[10px]">
                    ✓ Đã lưu Token ({form.telegramBotTokenMasked})
                  </span>
                )}
              </div>

              <div>
                <label className="block font-bold text-stone-700 mb-1">
                  Telegram Bot Token {form.hasTelegramBotToken ? '(để trống nếu giữ nguyên token cũ)' : ''}
                </label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={form.telegramBotToken}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, telegramBotToken: e.target.value, clearTelegramToken: false }))
                    }
                    placeholder="VD: 7123456789:AAH..."
                    className="flex-1 px-3 py-2 bg-white border border-sky-200 rounded-xl outline-none focus:ring-2 focus:ring-sky-500"
                  />
                  {form.hasTelegramBotToken && (
                    <button
                      type="button"
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          telegramBotToken: '',
                          clearTelegramToken: !prev.clearTelegramToken,
                        }))
                      }
                      className={`px-2.5 py-1.5 rounded-xl font-bold border cursor-pointer ${
                        form.clearTelegramToken
                          ? 'bg-red-600 text-white border-red-600'
                          : 'bg-white text-red-600 border-red-200'
                      }`}
                    >
                      {form.clearTelegramToken ? 'Sẽ xóa' : 'Xóa token'}
                    </button>
                  )}
                </div>
              </div>

              <div>
                <label className="block font-bold text-stone-700 mb-1">Telegram Chat ID / Group ID</label>
                <input
                  type="text"
                  value={form.telegramChatId}
                  onChange={(e) => setForm((prev) => ({ ...prev, telegramChatId: e.target.value }))}
                  placeholder="VD: 512345678 hoặc -1001987654321"
                  className="w-full px-3 py-2 bg-white border border-sky-200 rounded-xl outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>

              <p className="text-[11px] text-sky-900/80">
                💡 Tạo bot miễn phí qua <b>@BotFather</b> → lấy Token; nhắn <b>@userinfobot</b> (hoặc thêm bot vào nhóm quản lý) để lấy Chat ID.
              </p>
            </div>

            {/* Kênh 2: Custom Webhook */}
            <div className="p-4 rounded-xl bg-amber-50/70 border border-amber-200 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-extrabold text-amber-950 text-sm">🔗 Kênh Webhook (Slack / Discord / Zalo / n8n)</h4>
                {form.hasWebhookSecret && !form.clearWebhookSecret && (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[10px]">
                    ✓ Có chữ ký HMAC
                  </span>
                )}
              </div>

              <div>
                <label className="block font-bold text-stone-700 mb-1">Webhook Endpoint URL (HTTPS)</label>
                <input
                  type="url"
                  value={form.webhookUrl}
                  onChange={(e) => setForm((prev) => ({ ...prev, webhookUrl: e.target.value }))}
                  placeholder="https://hooks.slack.com/services/... hoặc URL n8n / Zalo Bridge"
                  className="w-full px-3 py-2 bg-white border border-amber-200 rounded-xl outline-none focus:ring-2 focus:ring-amber-600"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block font-bold text-stone-700 mb-1">Webhook Secret HMAC (tùy chọn)</label>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={form.webhookSecret}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, webhookSecret: e.target.value, clearWebhookSecret: false }))
                    }
                    placeholder={form.hasWebhookSecret ? 'Để trống để giữ secret cũ' : 'Khóa ký X-POS-Alert-Signature'}
                    className="w-full px-3 py-2 bg-white border border-amber-200 rounded-xl outline-none focus:ring-2 focus:ring-amber-600"
                  />
                </div>
                <div>
                  <label className="block font-bold text-stone-700 mb-1">Ngưỡng báo lệch ca (VND)</label>
                  <input
                    type="number"
                    min="0"
                    step="1000"
                    value={form.shiftDiffThresholdVnd}
                    onChange={(e) => setForm((prev) => ({ ...prev, shiftDiffThresholdVnd: e.target.value }))}
                    className="w-full px-3 py-2 bg-white border border-amber-200 rounded-xl font-bold outline-none focus:ring-2 focus:ring-amber-600"
                  />
                </div>
              </div>

              <p className="text-[11px] text-amber-900/80">
                🛡️ Payload JSON tự tương thích <b>Slack</b> (<code className="bg-white px-1 rounded">text</code>), <b>Discord</b> (<code className="bg-white px-1 rounded">content</code>) &amp; <b>n8n/Zalo OA</b>; có chặn SSRF bảo mật.
              </p>
            </div>
          </div>

          {/* Danh sách sự kiện kích hoạt cảnh báo */}
          <div className="p-4 rounded-xl bg-stone-50 border border-stone-200 space-y-2.5">
            <h4 className="font-bold text-stone-700 uppercase text-[11px]">
              Chọn các sự kiện rủi ro cần đẩy cảnh báo tức thời
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {eventMeta.map((ev) => (
                <label
                  key={ev.key}
                  className={`flex items-center gap-2 p-2.5 rounded-xl border cursor-pointer transition ${
                    form.events[ev.key]
                      ? 'bg-white border-amber-400 shadow-2xs'
                      : 'bg-stone-100/70 border-stone-200 text-stone-400'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={Boolean(form.events[ev.key])}
                    onChange={() => handleToggleEvent(ev.key)}
                    className="w-4 h-4 accent-amber-700 shrink-0"
                  />
                  <span className="font-semibold leading-tight">{ev.label}</span>
                </label>
              ))}
            </div>
          </div>

          {testResult && (
            <div
              className={`p-3 rounded-xl border text-xs space-y-1 ${
                testResult.ok ? 'bg-emerald-50 border-emerald-300 text-emerald-900' : 'bg-red-50 border-red-300 text-red-900'
              }`}
            >
              <p className="font-extrabold">{testResult.message}</p>
              <div className="flex flex-wrap gap-3">
                {testResult.channels?.telegram && (
                  <span>
                    Telegram:{' '}
                    <b>
                      {testResult.channels.telegram.ok
                        ? '✅ Gửi thành công'
                        : `❌ ${testResult.channels.telegram.error}`}
                    </b>
                  </span>
                )}
                {testResult.channels?.webhook && (
                  <span>
                    Webhook:{' '}
                    <b>
                      {testResult.channels.webhook.ok
                        ? `✅ HTTP ${testResult.channels.webhook.status}`
                        : `❌ ${testResult.channels.webhook.error}`}
                    </b>
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2.5 bg-amber-700 hover:bg-amber-800 text-white font-extrabold rounded-xl shadow cursor-pointer disabled:opacity-50"
            >
              {saving ? 'Đang lưu...' : '💾 Lưu cấu hình cảnh báo'}
            </button>
            <button
              type="button"
              disabled={testing}
              onClick={handleTest}
              className="px-4 py-2.5 bg-sky-600 hover:bg-sky-700 text-white font-extrabold rounded-xl shadow cursor-pointer disabled:opacity-50"
            >
              {testing ? 'Đang gửi thử...' : '🚀 Gửi thử cảnh báo ngay'}
            </button>
          </div>

          {recentDeliveries.length > 0 && (
            <div className="border-t pt-3 space-y-1.5">
              <p className="font-bold text-[11px] uppercase text-stone-500">
                Lịch sử đẩy cảnh báo gần nhất ({recentDeliveries.length})
              </p>
              <div className="space-y-1 max-h-32 overflow-y-auto pr-1">
                {recentDeliveries.slice(0, 5).map((d, idx) => (
                  <div
                    key={`${d.at}-${idx}`}
                    className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-stone-50 border text-[11px]"
                  >
                    <span className="text-stone-500">{formatDateTime(d.at)}</span>
                    <span className="font-bold text-stone-800">{d.eventKey}</span>
                    <div className="flex items-center gap-1.5">
                      {d.channels?.telegram && (
                        <span
                          className={`px-2 py-0.5 rounded-full font-bold text-[10px] ${
                            d.channels.telegram.ok ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'
                          }`}
                        >
                          TG: {d.channels.telegram.ok ? 'OK' : d.channels.telegram.error}
                        </span>
                      )}
                      {d.channels?.webhook && (
                        <span
                          className={`px-2 py-0.5 rounded-full font-bold text-[10px] ${
                            d.channels.webhook.ok ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'
                          }`}
                        >
                          WH: {d.channels.webhook.ok ? 'OK' : d.channels.webhook.error}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </form>
      )}
    </div>
  )
}
