import axiosClient from '../api/axiosClient'
import { buildCreateOrderBody } from '../utils/orderPayload'

export { buildCreateOrderBody }

export const orderService = {
  create: (params, idempotencyKey, extraConfig = {}) =>
    axiosClient.post(
      '/order',
      buildCreateOrderBody(params),
      {
        ...extraConfig,
        headers: {
          ...(extraConfig.headers || {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
      }
    ),

  quickCheckout: (
    {
      maBan,
      maKH,
      danhSachMon,
      combos = [],
      phuongThucTT,
      tienKhachDua,
      soTheRung = null,
      loaiDonHang = null,
      tenKhachVangLai = null,
      diaChiGiao = null,
      maKhuyenMai = null,
      diemSuDung = 0,
      tuDongHappyHour = true,
    },
    idempotencyKey,
    extraConfig = {}
  ) =>
    axiosClient.post(
      '/order/quick-checkout',
      {
        maBan,
        maKH,
        danhSachMon,
        ...(Array.isArray(combos) && combos.length > 0 ? { combos } : {}),
        phuongThucTT,
        tienKhachDua,
        ...(soTheRung ? { soTheRung } : {}),
        ...(loaiDonHang ? { loaiDonHang } : {}),
        ...(tenKhachVangLai ? { tenKhachVangLai } : {}),
        ...(diaChiGiao ? { diaChiGiao } : {}),
        ...(maKhuyenMai ? { maKhuyenMai } : {}),
        ...(Number(diemSuDung) > 0 ? { diemSuDung: Number(diemSuDung) } : {}),
        tuDongHappyHour,
      },
      {
        ...extraConfig,
        headers: {
          ...(extraConfig.headers || {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
      }
    ),

  getDangMo: () => axiosClient.get('/hoadon/dangmo'),

  getLichSuHomNay: (ngay) =>
    axiosClient.get('/hoadon/lichsu', { params: ngay ? { ngay } : undefined }),

  hoanTienSauTT: ({
    maHoaDon,
    lyDo,
    phuongThucHoan = 'TIEN_MAT',
    hoanKho = false,
    managerPin = null,
    maNVDuyet = null,
    dsMaCTHDHoan = null,
  }) =>
    axiosClient.post(`/order/${encodeURIComponent(maHoaDon)}/hoan-tien`, {
      lyDo,
      phuongThucHoan,
      hoanKho,
      managerPin,
      ...(maNVDuyet ? { maNVDuyet } : {}),
      ...(Array.isArray(dsMaCTHDHoan) && dsMaCTHDHoan.length > 0 ? { dsMaCTHDHoan } : {}),
    }),

  // [P0 FIX] Khóa / Gỡ trực tiếp Khuyến mãi & Đổi điểm Loyalty xuống HoaDon trên DB trước khi sinh VietQR
  apUuDai: (maHoaDon, { maKhuyenMai = null, diemSuDung = 0, maKH = null, tuDongHappyHour = true, goBo = false } = {}) =>
    axiosClient.post(`/order/${encodeURIComponent(maHoaDon)}/ap-uu-dai`, {
      maKhuyenMai,
      diemSuDung: Number(diemSuDung || 0),
      maKH,
      tuDongHappyHour,
      goBo,
    }),

  getByTable: async (maBan) => {
    const res = await axiosClient.get(`/ban/${maBan}/hoadon`)
    return res.hoaDon
  },

  getById: async (maHoaDon) => {
    const res = await axiosClient.get(`/hoadon/${maHoaDon}`)
    return res.hoaDon
  },

  // Hỗ trợ 1 phương thức + Thanh toán hỗn hợp + Thu 1 phần + Chia tiền (chiaTienId) + Optimistic Locking (expectedVersion)
  thanhToan: (
    {
      maHoaDon,
      phuongThucTT,
      maKH,
      maKhuyenMai = null,
      diemSuDung = 0,
      tuDongHappyHour = true,
      tienKhachDua,
      thanhToan,
      choPhepThuMotPhan,
      chiaTienId = null,
      expectedVersion = null,
      managerPin = null,
      idChungTu = null,
      nguonXacNhan = null,
    },
    idempotencyKey,
    extraConfig = {}
  ) =>
    axiosClient.post(
      '/order/thanhtoan',
      {
        maHoaDon,
        phuongThucTT,
        maKH,
        ...(maKhuyenMai ? { maKhuyenMai } : {}),
        ...(Number(diemSuDung) > 0 ? { diemSuDung: Number(diemSuDung) } : {}),
        tuDongHappyHour,
        tienKhachDua,
        ...(managerPin ? { managerPin } : {}),
        ...(idChungTu ? { idChungTu } : {}),
        ...(nguonXacNhan ? { nguonXacNhan } : {}),
        thanhToan,
        choPhepThuMotPhan,
        ...(chiaTienId ? { chiaTienId } : {}),
        ...(expectedVersion !== null && expectedVersion !== undefined ? { expectedVersion } : {}),
      },
      {
        ...extraConfig,
        headers: {
          ...(extraConfig.headers || {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
      }
    ),

  // [QA/Demo] Giả lập nhận biến động số dư VietQR từ SePay/PayOS (chỉ Quản lý)
  simulateVietQrWebhook: ({ maHoaDon, soTien, nhaCungCap = 'SEPAY_WEBHOOK' }) =>
    axiosClient.post('/webhooks/vietqr/test-simulate', { maHoaDon, soTien, nhaCungCap }),

  huyMon: ({ maCTHD, lyDo, hoanKho = true, managerPin = null, maNVDuyet = null, expectedVersion = null }) =>
    axiosClient.post('/order/huy-mon', {
      maCTHD,
      lyDo,
      hoanKho,
      managerPin,
      ...(maNVDuyet ? { maNVDuyet } : {}),
      ...(expectedVersion !== null && expectedVersion !== undefined ? { expectedVersion } : {}),
    }),

  // [P1 - Modify / Swap Item] Đổi món đang chờ pha chế (ChoPhaChe) tự tính bù/hoàn chênh lệch
  doiMon: (
    maHoaDon,
    {
      maCTHD,
      maMonMoi,
      kichThuocMoi,
      soLuongMoi,
      ghiChuMoi,
      toppingsMoi = [],
      phuongThucTTChenhLech = 'TIEN_MAT',
      lyDo = 'Khách yêu cầu đổi món tại quầy',
    }
  ) =>
    axiosClient.post(`/order/${encodeURIComponent(maHoaDon)}/doi-mon`, {
      maCTHD,
      maMonMoi,
      kichThuocMoi,
      soLuongMoi,
      ghiChuMoi,
      toppingsMoi,
      phuongThucTTChenhLech,
      lyDo,
    }),

  // [Phân hệ 1 - 100/100] Tách hóa đơn đủ 3 kiểu: BY_ITEM | SPLIT_EQUAL | SPLIT_AMOUNT
  tachDon: ({
    maHoaDon,
    dsMaCTHD,
    splitItems,
    toMaBan = null,
    mode = 'NEW_INVOICE',
    soNguoi = null,
    shares = [],
    expectedVersion = null,
  }) =>
    axiosClient.post(`/order/${encodeURIComponent(maHoaDon)}/tach`, {
      dsMaCTHD,
      splitItems,
      toMaBan,
      mode,
      ...(soNguoi ? { soNguoi } : {}),
      ...(Array.isArray(shares) && shares.length > 0 ? { shares } : {}),
      ...(expectedVersion !== null && expectedVersion !== undefined ? { expectedVersion } : {}),
    }),

  chuyenMon: ({
    fromMaHoaDon,
    toMaBan = null,
    toMaHoaDon = null,
    items = [],
    expectedVersion = null,
    destExpectedVersion = null,
    toExpectedVersion = null,
  }) => {
    const finalDestVer = destExpectedVersion ?? toExpectedVersion ?? null
    return axiosClient.post('/order/chuyen-mon', {
      fromMaHoaDon,
      toMaBan,
      toMaHoaDon,
      items,
      ...(expectedVersion !== null && expectedVersion !== undefined ? { expectedVersion } : {}),
      ...(finalDestVer !== null && finalDestVer !== undefined ? { destExpectedVersion: finalDestVer } : {}),
    })
  },

  // Course Firing (Hẹn giờ ra món)
  getChoBaoBep: () => axiosClient.get('/order/cho-bao-bep'),
  fireCourse: (maHoaDon, { courseNo = null, dsMaCTHD = null } = {}) =>
    axiosClient.post(`/order/${encodeURIComponent(maHoaDon)}/fire-course`, {
      ...(courseNo !== null ? { courseNo } : {}),
      ...(Array.isArray(dsMaCTHD) ? { dsMaCTHD } : {}),
    }),

  // Multi-device Park Order (Lưu tạm trên DB)
  getLuuTam: () => axiosClient.get('/order/luu-tam'),
  luuTam: (body) => axiosClient.post('/order/luu-tam', body),
  khoiPhucTam: (maHoaDon) => axiosClient.post(`/order/${encodeURIComponent(maHoaDon)}/khoi-phuc-tam`),
  xoaLuuTam: (maHoaDon) => axiosClient.delete(`/order/${encodeURIComponent(maHoaDon)}/luu-tam`),

  // Modifiers, Combos & Physical Buzzers
  getModifierGroups: () => axiosClient.get('/modifiers/groups'),
  getCombosActive: () => axiosClient.get('/combos/active'),
  getTheRung: () => axiosClient.get('/pos/the-rung'),

  ghiNhanIn: (maHoaDon, { managerPin = null, maNVDuyet = null, lyDo = null } = {}) =>
    axiosClient.post(`/order/${encodeURIComponent(maHoaDon)}/print-token`, {
      ...(managerPin ? { managerPin } : {}),
      ...(maNVDuyet ? { maNVDuyet } : {}),
      ...(lyDo ? { lyDo } : {}),
    }),

  ghiNhanMoKetKhongBan: (lyDo) => axiosClient.post('/pos/drawer-kick', { lyDo }),

  verifyManagerPin: ({ managerPin, maNVDuyet = null, action = 'OFFLINE_QUEUE_ITEM_DELETED', lyDo = '', details = {} }) =>
    axiosClient.post('/pos/verify-manager-pin', {
      managerPin,
      ...(maNVDuyet ? { maNVDuyet } : {}),
      action,
      lyDo,
      details,
    }),

  getToppings: () => axiosClient.get('/topping'),

  setToppingTamHet: (maTopping, tamHet) =>
    axiosClient.put(`/topping/${encodeURIComponent(maTopping)}/tamhet`, { tamHet }),

  getDangCho: (config) => axiosClient.get('/order/dangcho', config),
  getVuaTra: (config) => axiosClient.get('/order/vua-tra', config),
  nhanLam: (maCTHD) => axiosClient.put('/order/danglam', { maCTHD }),
  traMon: (maCTHD) => axiosClient.put('/order/tramon', { maCTHD }),
  hoanTacTraMon: (maCTHD) => axiosClient.put('/order/hoantac-tramon', { maCTHD }),
  getChoPhucVu: (config) => axiosClient.get('/order/chophucvu', config),
  xacNhanPhucVu: (maCTHD) => axiosClient.put('/order/phucvu', { maCTHD }),

  // [Phân hệ 2 - 100/100] KDS Sync Replay, Batch, Expo, Recall, Remake, Telemetry, Print Token, Item Swap, 86'ing 5 lớp
  syncKds: ({ branchId = 'DEFAULT', station = 'ALL', lastSeq = 0 } = {}, config = {}) =>
    axiosClient.get('/kds/sync', { params: { branchId, station, lastSeq }, ...config }),
  getKdsBatchSummary: ({ branchId = null, station = 'ALL' } = {}, config = {}) =>
    axiosClient.get('/kds/batch-summary', { params: { ...(branchId ? { branchId } : {}), station }, ...config }),
  runKdsBatchAction: ({ action = 'START_ALL', maMon, kichThuoc = 'M', branchId = null, station = 'ALL' }) =>
    axiosClient.post('/kds/batch-action', { action, maMon, kichThuoc, branchId, station }),
  getKdsExpo: ({ branchId = null } = {}, config = {}) =>
    axiosClient.get('/kds/expo', { params: branchId ? { branchId } : undefined, ...config }),
  recallKdsItem: (maCTHD) => axiosClient.post(`/kds/recall/${encodeURIComponent(maCTHD)}`),
  remakeKdsItem: ({ maCTHD, lyDo, soLuong = null }) =>
    axiosClient.post('/kds/remake', { maCTHD, lyDo, ...(soLuong ? { soLuong } : {}) }),
  getKdsTelemetry: ({ branchId = null, station = 'ALL', hours = 24 } = {}) =>
    axiosClient.get('/kds/telemetry', { params: { ...(branchId ? { branchId } : {}), station, hours } }),
  issuePrintToken: (maHoaDon, { managerPin = null, maNVDuyet = null, lyDo = null } = {}) =>
    axiosClient.post(`/order/${encodeURIComponent(maHoaDon)}/print-token`, {
      ...(managerPin ? { managerPin } : {}),
      ...(maNVDuyet ? { maNVDuyet } : {}),
      ...(lyDo ? { lyDo } : {}),
    }),
  swapOrderItem: ({
    maCTHD,
    newItem,
    lyDo,
    phuongThucBuHoan = 'TIEN_MAT',
    forceWasteIfInProgress = false,
    managerPin = null,
    maNVDuyet = null,
  }) =>
    axiosClient.post('/order/item-swap', {
      maCTHD,
      newItem,
      lyDo,
      phuongThucBuHoan,
      forceWasteIfInProgress,
      ...(managerPin ? { managerPin } : {}),
      ...(maNVDuyet ? { maNVDuyet } : {}),
    }),
  lookupOrderByClientUid: (uid, config = {}) =>
    axiosClient.get(`/order/by-client-uid/${encodeURIComponent(uid)}`, config),
  cascadeIngredient86: ({ maNL, action = 'LOCK', branchId = 'DEFAULT' }) =>
    axiosClient.post('/kho/ingredient-86', { maNL, action, branchId }),
  setProductCountdown: (maMon, soLuongGioiHan86) =>
    axiosClient.put(`/sanpham/${encodeURIComponent(maMon)}/countdown`, { soLuongGioiHan86 }),
  parkOrderV2: (body) => axiosClient.post('/order/park', body),
  resumeParkOrderV2: (maHoaDon) => axiosClient.post(`/order/${encodeURIComponent(maHoaDon)}/resume`),
  setOrderRush: (maHoaDon, { rush = true, priority = 2, lyDo = '' } = {}) =>
    axiosClient.patch(`/order/${encodeURIComponent(maHoaDon)}/rush`, { rush, priority, lyDo }),
}
