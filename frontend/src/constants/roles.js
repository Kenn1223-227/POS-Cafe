export const ROLES = {
  QUAN_LY: 1,
  BARISTA: 2,
  PHUC_VU: 3,
  THU_NGAN: 4,
}

export const ROLE_LABEL = {
  1: 'Quản lý',
  2: 'Pha chế',
  3: 'Phục vụ',
  4: 'Thu ngân',
}

export const ROLE_HOME = {
  1: '/pos',
  2: '/barista',
  3: '/pos', // Phục vụ trỏ về màn hình pos tương tự thu ngân
  4: '/pos',
}

export const ROUTE_ROLES = {
  '/admin': [1],
  '/pos': [4, 1, 3], // Cho phép cả Thu ngân, Quản lý và Phục vụ truy cập POS
  '/barista': [2],
  '/waiter': [3, 1],
}