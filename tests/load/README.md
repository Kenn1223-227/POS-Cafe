# Bộ Stress Test `k6` — Scale 500 Quán (Wave 4B — `P2-01`)

Tài liệu hướng dẫn chạy kịch bản kiểm thử chịu tải giờ cao điểm cho POS Cafe Multi-Tenant SaaS.

## Kịch bản trong `k6-pos-25tps.js`

1. **`order_checkout_25tps` (`constant-arrival-rate`)**
   - Tốc độ cố định: **25 TPS** (`rate: 25`, `timeUnit: '1s'`) liên tục trong **2 phút**.
   - `preAllocatedVUs: 50`, `maxVUs: 150`.
   - Mô phỏng luồng tạo đơn `POST /api/order` kèm `Idempotency-Key` duy nhất + kiểm tra trạng thái đơn (`GET /api/hoadon/:maHoaDon` / `GET /api/hoadon/dangmo`).
2. **`kds_pos_200vu` (`ramping-vus`)**
   - Tăng tải lên **200 VU đồng thời** (30s -> 100 VU, 1m -> 200 VU, 30s -> 0 VU).
   - Mô phỏng 200 thiết bị POS / KDS / Quản lý đọc đồng thời:
     - `GET /api/sanpham`
     - `GET /api/ban`
     - `GET /api/order/dangcho`
     - `GET /api/reports/daily-summary` (định tuyến qua Read-Replica `READ ONLY` pool).

## Ngưỡng SLO cứng (`thresholds`)

- `http_req_failed`: `< 1%` (`rate<0.01`)
- `http_req_duration`: `p(95) < 500ms`, `p(99) < 1200ms`

## Cách chạy cục bộ / Staging

```bash
BASE_URL=http://127.0.0.1:3000 \
AUTH_TOKEN="<JWT_ACCESS_TOKEN_QUAN_LY>" \
BRANCH_ID="CN01" \
TENANT_ID="DEFAULT" \
npm run test:load:k6
```
