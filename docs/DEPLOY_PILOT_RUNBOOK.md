# Runbook Triển Khai Thương Mại Pilot — Cafe POS (`v1.0.0-pilot-rc2`)

Tài liệu triển khai từng bước cho cụm Pilot (5–15 quán), đã qua đầy đủ cổng kiểm thử tự động CI (Migrations `001 -> 043`, V3 P0 Gate + POS Bootstrap) và Smoke Test thực chiến qua trình duyệt.

> **Ràng buộc vận hành Pilot (BẮT BUỘC):**
> - Backend **PHẢI chạy đúng `Scale = 1 instance`** (`min_machines_running = 1`, không autoscale nhiều instance) vì `pinFailMap` và `printRelayTenants` đang lưu trên RAM tiến trình Node.js.
> - RAM khuyến nghị cho Backend: **`memory_mb = 1024`** (1 GB).
> - Khóa Auto-DDL tuyệt đối: `NODE_ENV=production` và `SKIP_AUTO_DDL=true`.

---

## 1. Thứ Tự Triển Khai Chuẩn (6 Bước)

### Bước 1: Backup Cơ Sở Dữ Liệu Production (BẮT BUỘC)
Chạy backup trước khi áp dụng bất kỳ migration nào bằng chuỗi kết nối Direct cổng `5432`:

```bash
export MIGRATION_DATABASE_URL="postgresql://postgres:<PASSWORD>@<DB_HOST>:5432/postgres"
pg_dump "$MIGRATION_DATABASE_URL" -Fc -f "backup_before_pilot_rc2_$(date +%Y%m%d_%H%M%S).dump"
```

Kiểm tra file dump có dung lượng > 0 và lưu về máy chủ an toàn / cloud storage.

---

### Bước 2: Kiểm Tra Biến Môi Trường Pre-Flight (Không sửa DB)
Chạy script kiểm tra trên bộ biến môi trường Production trước khi migrate/deploy:

```bash
# Kiểm tra từ biến môi trường hiện tại hoặc file env riêng (không commit file env)
npm run verify:pilot-env -- --env .env.production

# Kiểm tra đồng thời file cầu in máy quầy (nếu có)
npm run verify:pilot-env -- --env .env.production --bridge /path/to/bridge-config.json
```

Chỉ tiếp tục sang Bước 3 khi kết quả in ra `✅ PRE-FLIGHT PASSED (0 lỗi)`.

---

### Bước 3: Áp Dụng Migrations `039 -> 043` Qua `MIGRATION_DATABASE_URL`
Migration được chạy qua cổng Direct `5432` (role owner — **không dùng PgBouncer `6543`** và **không dùng `app_runtime`**):

```bash
MIGRATION_DATABASE_URL="postgresql://postgres:<PASSWORD>@<DB_HOST>:5432/postgres" npm run db:migrate
```

Xác nhận các bản ghi mới đã áp dụng trong `public.schema_migrations`:
- `039_revoke_platform_rpcs_from_app_runtime.sql` (thu hồi `EXECUTE` 6 hàm `fn_platform_*` khỏi `app_runtime`)
- `040_ensure_topping_and_item_discount_cols.sql`
- `041_cauhinh_vattu_mangdi_channel_pk.sql`
- `042_fix_public_einvoice_rpc.sql`
- `043_pos_bootstrap_columns.sql` (bổ sung `Ban.ToaDoX`, `Ban.ToaDoY`)

---

### Bước 4: Deploy Backend (Render hoặc Fly.io — `memory_mb=1024`, `Scale = 1`)

#### Phương án A — Fly.io (Khuyến nghị, Singapore `sin`)
Cấu hình sẵn trong `fly.toml` (`memory_mb = 1024`, `min_machines_running = 1`, `auto_stop_machines = "off"`):

```bash
# 1. Nạp secrets 1 lần (hoặc khi xoay khóa)
flyctl secrets set \
  DATABASE_URL="postgresql://app_runtime:<PASS>@<POOLER_HOST>:6543/postgres?pgbouncer=true" \
  PLATFORM_DATABASE_URL="postgresql://<PLATFORM_ROLE>:<PASS>@<DB_HOST>:5432/postgres" \
  MIGRATION_DATABASE_URL="postgresql://postgres:<PASS>@<DB_HOST>:5432/postgres" \
  JWT_SECRET="<96_HEX_CHARS>" \
  FRONTEND_URL="https://pos.tenmienquan.vn" \
  SKIP_AUTO_DDL="true" \
  COOKIE_SAMESITE="None" \
  COOKIE_SECURE="true" \
  TRUST_PROXY="1" \
  PLATFORM_ADMIN_USERNAME="<ADMIN_USER>" \
  PLATFORM_ADMIN_PASSWORD="<STRONG_16_CHAR_PASS>"

# 2. Deploy từ tag đã chốt và khóa cứng đúng 1 máy chạy
git checkout v1.0.0-pilot-rc2
flyctl deploy --ha=false
flyctl scale count 1
flyctl scale memory 1024
```

#### Phương án B — Render Web Service (Docker)
- Source: GitHub repo nhánh `main` (hoặc tag `v1.0.0-pilot-rc2`), Runtime: **Docker** (`Dockerfile` ở root).
- Instance Type: gói có **>= 1 GB RAM** (Starter/Standard), **Auto-Scaling: OFF**, **Instance Count: `1`**.
- Health Check Path: `/api/health`.
- Nhập toàn bộ biến môi trường ở Bảng 2.1 bên dưới, sau đó bấm **Manual Deploy -> Deploy latest commit**.

Kiểm tra sau deploy Backend:
```bash
curl -fsS https://<BACKEND_DOMAIN>/api/health
curl -fsS https://<BACKEND_DOMAIN>/api/ready
```

---

### Bước 5: Deploy Frontend Lên Vercel
- Root Directory: `frontend`
- Build Command: `npm run build`
- Output Directory: `dist`
- Nhập biến môi trường Vercel (Bảng 2.2), đặc biệt `VITE_API_URL=https://<BACKEND_DOMAIN>/api` và `VITE_SOCKET_URL=https://<BACKEND_DOMAIN>`.
- Redeploy production và kiểm tra mở `/login`, đăng nhập thử, F5 tải lại trang và mở `/super-admin`.

---

### Bước 6: Cấu Hình Khóa VietQR (SePay / PayOS) Riêng Cho Từng Quán Pilot
> **LƯU Ý BẢO MẬT QUAN TRỌNG:** Route webhook `POST /api/webhooks/sepay/:tenantSlug` và `POST /api/webhooks/payos/:tenantSlug` **ĐÃ CẤM FALLBACK** sang biến toàn cục `SEPAY_API_KEY` / `PAYOS_CHECKSUM_KEY`.

Với từng quán Pilot:
1. Đăng nhập tài khoản **Quản lý** của quán tại `/pos` -> bấm nút **🏦 VietQR** (hoặc vào mục Cài đặt Ngân hàng).
2. Nhập đúng Ngân hàng, Số tài khoản, Tên chủ tài khoản và **API Key SePay / Checksum Key PayOS riêng của quán**.
3. Khai báo Webhook URL trên cổng SePay / PayOS trỏ về:
   - SePay: `https://<BACKEND_DOMAIN>/api/webhooks/sepay/<tenantSlug>`
   - PayOS: `https://<BACKEND_DOMAIN>/api/webhooks/payos/<tenantSlug>`
4. Chuyển thử `2.000đ` để xác nhận hóa đơn tự động đóng & phát loa/toast thành công.

---

## 2. Bảng Biến Môi Trường Đầy Đủ

### 2.1 Backend (Render / Fly.io)

| Biến môi trường | Bắt buộc | Giá trị chuẩn Pilot | Ghi chú |
| :--- | :---: | :--- | :--- |
| `NODE_ENV` | Có | `production` | Khóa CORS chặt & Auto-DDL |
| `PORT` | Có | `3000` | Khớp `EXPOSE 3000` trong `Dockerfile` |
| `SKIP_AUTO_DDL` | Có | `true` | Không bao giờ chạy DDL khi khởi động app |
| `TRUST_PROXY` | Có | `1` | Nhận đúng `X-Forwarded-Proto` & IP khách sau proxy |
| `DATABASE_URL` | Có | `postgresql://app_runtime:...@...:6543/postgres?pgbouncer=true` | Role `app_runtime` (`NOBYPASSRLS` + `FORCE RLS`) |
| `PLATFORM_DATABASE_URL` | Có | `postgresql://<platform_role>:...@...:5432/postgres` | Tách biệt hoàn toàn `DATABASE_URL`; gọi 6 RPC `fn_platform_*` |
| `MIGRATION_DATABASE_URL` | Có | `postgresql://postgres:...@...:5432/postgres` | Kết nối Direct cổng `5432` cho `npm run db:migrate` |
| `JWT_SECRET` | Có | Chuỗi hex >= 32 ký tự (`randomBytes(48).toString('hex')`) | Tạo mới riêng cho Production |
| `FRONTEND_URL` | Có | `https://pos.tenmienquan.vn` | HTTPS chính xác, ngăn cách dấu phẩy, **cấm `*`** |
| `COOKIE_SAMESITE` | Có | `None` *(cross-domain)* hoặc `Lax` *(cùng root domain)* | Bắt buộc `None` nếu Vercel và Render/Fly khác domain |
| `COOKIE_SECURE` | Có | `true` | Bắt buộc trên HTTPS Production |
| `PLATFORM_ADMIN_USERNAME` | Có | Tên quản trị riêng (khác mặc định) | Đăng nhập `/super-admin` |
| `PLATFORM_ADMIN_PASSWORD` | Có | >= 12 ký tự mạnh (hoa, thường, số, ký tự đặc biệt) | **Cấm** dùng `SuperAdmin@2026` |
| `LOG_FORMAT` | Khuyến nghị | `json` | Structured JSON logs |
| `LOG_LEVEL` | Khuyến nghị | `info` | Mức log chuẩn vận hành |
| `SLOW_QUERY_MS` | Tùy chọn | `500` | Cảnh báo truy vấn chậm > 500ms |
| `STORAGE_PROVIDER` | Khuyến nghị | `supabase` / `r2` / `s3` | Lưu ảnh chứng từ phiếu chi bền vững (tránh mất khi restart container) |
| `ALLOW_NEGATIVE_STOCK` | Tùy chọn | `true` | Không chặn bán giờ cao điểm khi kho âm |

### 2.2 Frontend (Vercel)

| Biến môi trường | Bắt buộc | Ví dụ giá trị |
| :--- | :---: | :--- |
| `VITE_API_URL` | Có | `https://api.tenmienquan.vn/api` |
| `VITE_SOCKET_URL` | Có | `https://api.tenmienquan.vn` |

### 2.3 Máy Quầy — `local-print-bridge/bridge-config.json`

| Trường cấu hình | Giá trị khuyến nghị Pilot | Lưu ý an toàn |
| :--- | :--- | :--- |
| `receiptPrinter.mode` | `LAN_TCP` hoặc `WINDOWS_SHARE` | Test trước bằng `SIMULATOR` |
| `receiptPrinter.sensorProbeEnabled` | `false` | **Đặt `false`** cho máy in nhiệt LAN phổ thông (Xprinter/Zywell) tránh treo timeout |
| `labelPrinter.sensorProbeEnabled` | `false` | Đặt `false` nếu máy in tem không hỗ trợ phản hồi `<ESC>!?` qua TCP |
| `*.shareName` | `XP-80C` / `XP-350B` | **Cấm** nhập đường dẫn UNC bắt đầu bằng `\\` |
| `security.apiToken` | Chuỗi 64 hex ngẫu nhiên | Dán khớp vào modal **🖨️ Máy in** trên POS |
| `security.allowedOrigins` | `["https://pos.tenmienquan.vn"]` | **Cấm** để rỗng, cấm `*` và cấm `https://*.vercel.app` |

---

## 3. Quy Trình Rollback Nhanh Khi Có Sự Cố

1. **Rollback Backend (30–60 giây):**
   - **Fly.io:** `flyctl releases` -> chọn bản ổn định trước đó -> `flyctl deploy --image <PREVIOUS_IMAGE>` (giữ `scale count 1`).
   - **Render:** Vào tab **Events** -> chọn deploy ổn định trước đó -> bấm **Rollback to this deploy**.
   - **Git tag dự phòng:** `git checkout v1.0.0-pilot-rc1` (nếu cần dựng lại ảnh cũ).
2. **Rollback Frontend (Vercel — 15 giây):**
   - Vào **Deployments** -> chọn bản Production trước đó -> **Instant Rollback**.
3. **Rollback Cơ Sở Dữ Liệu (chỉ thực hiện nếu phát sinh lỗi schema nghiêm trọng):**
   - Tạm dừng traffic ghi vào Backend (scale 0 hoặc bật maintenance).
   - Khôi phục từ file backup Bước 1:
     ```bash
     pg_restore --clean --if-exists --no-owner -d "$MIGRATION_DATABASE_URL" backup_before_pilot_rc2_YYYYMMDD_HHMMSS.dump
     ```
   - Lưu ý: Migrations `039 -> 043` đều mang tính bổ sung/thu hồi quyền an toàn, **không xóa dữ liệu**, nên đa số trường hợp chỉ cần rollback ứng dụng (Bước 1–2) mà không cần restore DB.
