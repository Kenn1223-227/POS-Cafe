import axiosClient from '../api/axiosClient'

export const saasService = {
  getTemplates: () => axiosClient.get('/saas/templates'),

  registerTenant: (body) => axiosClient.post('/saas/register', body),

  getMyTenant: () => axiosClient.get('/saas/tenant'),

  createBillingOrder: ({ goiCuoc, soThang, extraBranches = 0 }) =>
    axiosClient.post('/saas/billing/create-order', { goiCuoc, soThang, extraBranches }),

  downgradeToFree: () => axiosClient.post('/saas/downgrade-free'),

  submitExpansionInquiry: (body) => axiosClient.post('/saas/expansion/inquiry', body),

  confirmBillingOrder: ({ maDonThanhToan, maGiaoDichNgoai }) =>
    axiosClient.post('/saas/billing/confirm', { maDonThanhToan, maGiaoDichNgoai }),

  getPendingBillingOrders: () => axiosClient.get('/saas/billing/pending'),

  getBankSettings: () => axiosClient.get('/settings/bank', { silent: true }),

  saveBankSettings: (bank) => axiosClient.put('/settings/bank', bank),

  updatePlan: (goiCuoc) => axiosClient.put('/saas/plan', { goiCuoc }),

  getAllTenants: () => axiosClient.get('/saas/tenants'),

  aiParseMenu: (body) => axiosClient.post('/ai/parse-menu', body),

  aiImportMenu: (items) => axiosClient.post('/ai/import-menu', { items }),
}
