import { memo } from 'react'

const VietQrBankModal = memo(function VietQrBankModal({
  isOpen,
  bankForm,
  onChangeBankForm,
  onClose,
  onSubmit,
}) {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="font-extrabold text-base text-gray-800">
            🏦 Cấu hình VietQR Động &amp; Webhook Riêng Của Quán
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="min-w-[44px] min-h-[44px] rounded-full bg-gray-100 font-bold cursor-pointer text-xs"
          >
            ✕ [ESC]
          </button>
        </div>
        <form onSubmit={onSubmit} className="space-y-3 text-xs">
          <div>
            <label className="block font-bold text-gray-600 mb-1">
              Mã ngân hàng (VD: MB, VCB, TCB, ACB, BIDV)
            </label>
            <input
              type="text"
              required
              value={bankForm.bankId || ''}
              onChange={(e) =>
                onChangeBankForm({ ...bankForm, bankId: e.target.value.toUpperCase() })
              }
              className="w-full min-h-[48px] px-3 border rounded-xl font-bold"
            />
          </div>
          <div>
            <label className="block font-bold text-gray-600 mb-1">Số tài khoản</label>
            <input
              type="text"
              required
              value={bankForm.accountNo || ''}
              onChange={(e) =>
                onChangeBankForm({ ...bankForm, accountNo: e.target.value.trim() })
              }
              placeholder="Nhập STK nhận tiền của quán..."
              className="w-full min-h-[48px] px-3 border rounded-xl font-bold"
            />
          </div>
          <div>
            <label className="block font-bold text-gray-600 mb-1">Tên chủ tài khoản</label>
            <input
              type="text"
              value={bankForm.accountName || ''}
              onChange={(e) =>
                onChangeBankForm({ ...bankForm, accountName: e.target.value })
              }
              className="w-full min-h-[48px] px-3 border rounded-xl font-bold"
            />
          </div>

          <div className="pt-2 border-t space-y-2.5">
            <p className="font-extrabold text-amber-900">
              🔐 Khóa xác thực Webhook riêng của quán (Mã hóa AES-256-GCM):
            </p>
            <div>
              <label className="block font-bold text-gray-600 mb-1">
                SePay API Key{' '}
                {bankForm.hasSepayKey && (
                  <span className="text-emerald-700">(Đã cấu hình)</span>
                )}
              </label>
              <input
                type="password"
                value={bankForm.sepayApiKey ?? ''}
                onChange={(e) =>
                  onChangeBankForm({ ...bankForm, sepayApiKey: e.target.value })
                }
                placeholder="Nhập SePay API Key của quán..."
                className="w-full min-h-[48px] px-3 border rounded-xl font-mono"
              />
            </div>
            <div>
              <label className="block font-bold text-gray-600 mb-1">
                PayOS Checksum Key{' '}
                {bankForm.hasPayosKey && (
                  <span className="text-emerald-700">(Đã cấu hình)</span>
                )}
              </label>
              <input
                type="password"
                value={bankForm.payosChecksumKey ?? ''}
                onChange={(e) =>
                  onChangeBankForm({ ...bankForm, payosChecksumKey: e.target.value })
                }
                placeholder="Nhập PayOS Checksum Key của quán..."
                className="w-full min-h-[48px] px-3 border rounded-xl font-mono"
              />
            </div>
            {bankForm.sepayWebhookPath && (
              <div className="p-2.5 rounded-xl bg-stone-50 border border-stone-200 space-y-1 text-[11px]">
                <p className="font-bold text-stone-700">
                  🔗 Endpoint Webhook định danh riêng cho quán:
                </p>
                <p className="font-mono text-stone-800 break-all">
                  SePay: <b>{bankForm.sepayWebhookPath}</b>
                </p>
                <p className="font-mono text-stone-800 break-all">
                  PayOS: <b>{bankForm.payosWebhookPath}</b>
                </p>
              </div>
            )}
          </div>

          <div className="flex gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 min-h-[52px] border rounded-xl font-bold cursor-pointer"
            >
              Đóng [ESC]
            </button>
            <button
              type="submit"
              className="flex-1 min-h-[52px] bg-amber-700 text-white rounded-xl font-bold cursor-pointer"
            >
              Lưu VietQR &amp; Webhook
            </button>
          </div>
        </form>
      </div>
    </div>
  )
})

export default VietQrBankModal
