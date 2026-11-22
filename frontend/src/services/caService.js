import axiosClient from '../api/axiosClient'

export const caService = {
  getCaHienTai: async (params = {}) => {
    const res = await axiosClient.get('/ca/hientai', { params })
    return res.caHienTai
  },

  moCa: (tienMatDauCa, opts = {}) =>
    axiosClient.post('/ca/mo', {
      tienMatDauCa: Number(tienMatDauCa || 0),
      ...(opts.chiTietMenhGiaDauCa ? { chiTietMenhGiaDauCa: opts.chiTietMenhGiaDauCa } : {}),
      ...(opts.branchId ? { branchId: opts.branchId } : {}),
      ...(opts.terminalId ? { terminalId: opts.terminalId } : {}),
    }),

  thuChi: (body) => axiosClient.post('/ca/thuchi', body),

  getDanhSachThuChi: (maCaThuNgan) =>
    axiosClient.get('/ca/thuchi', { params: maCaThuNgan ? { maCaThuNgan } : {} }),

  doiSoat: (params) => axiosClient.get('/ca/doisoat', { params }),

  dongCa: (
    tienMatThucTe,
    {
      maCaThuNgan,
      ghiChuChenhLech,
      chiTietMenhGia,
      tienGiuLaiKet = 0,
      confirmRecount = false,
      outboxPendingCount = 0,
      branchId,
      terminalId,
    } = {}
  ) =>
    axiosClient.post('/ca/dong', {
      tienMatThucTe: Number(tienMatThucTe),
      maCaThuNgan: maCaThuNgan || undefined,
      ghiChuChenhLech: ghiChuChenhLech || undefined,
      chiTietMenhGia: chiTietMenhGia || undefined,
      tienGiuLaiKet: Number(tienGiuLaiKet || 0),
      confirmRecount: Boolean(confirmRecount),
      outboxPendingCount: Number(outboxPendingCount || 0),
      branchId: branchId || undefined,
      terminalId: terminalId || undefined,
    }),

  getDanhSachCa: (tuNgay, denNgay) =>
    axiosClient.get('/ca/danhsach', { params: { tuNgay, denNgay } }),

  // [Phân hệ 3 - 100/100] Policy, Pre-close Gate, Receipt Photo, Safe Drop 2 lớp, VietQR Match/Overpay & Đối soát 3 chiều
  getPolicy: () => axiosClient.get('/ca/policy'),
  savePolicy: (body) => axiosClient.put('/ca/policy', body),
  preCloseCheck: (params = {}) => axiosClient.get('/ca/pre-close-check', { params }),
  uploadReceiptPhoto: ({ dataUrl, mimeType = 'image/webp' }) =>
    axiosClient.post('/uploads/receipt-photo', { dataUrl, mimeType }),
  confirmSafeDrop: (maPhieuTC, { status = 'CONFIRMED', ghiChu = null } = {}) =>
    axiosClient.post(`/ca/safe-drop/${encodeURIComponent(maPhieuTC)}/confirm`, { status, ghiChu }),
  getUnmatchedVietQr: (minutes = 30) =>
    axiosClient.get('/vietqr/unmatched', { params: { minutes } }),
  matchUnmatchedVietQr: ({ webhookEventId, maHoaDon }) =>
    axiosClient.post('/vietqr/match-unmatched', { webhookEventId, maHoaDon }),
  resolveVietQrOverpayment: ({ webhookEventId, action, maKH = null, lyDo = null }) =>
    axiosClient.post('/vietqr/resolve-overpayment', { webhookEventId, action, maKH, lyDo }),
  getEodReconciliation: (params = {}) =>
    axiosClient.get('/ca/reconciliation-eod', { params }),
  settleEdcBatch: ({ maCaThuNgan, tongChotLoEDC }) =>
    axiosClient.post('/ca/edc-settlement', { maCaThuNgan, tongChotLoEDC: Number(tongChotLoEDC) }),

  getAuditLogs: (limit = 80) =>
    axiosClient.get('/audit-logs', { params: { limit } }),

  getVietQrLogs: (limit = 60) =>
    axiosClient.get('/webhooks/vietqr/logs', { params: { limit } }),

  getAlertConfig: () => axiosClient.get('/alerts/config'),

  saveAlertConfig: (body) => axiosClient.put('/alerts/config', body),

  testAlertConfig: (body) => axiosClient.post('/alerts/test', body),
}
