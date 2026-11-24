# Kế Hoạch Triển Khai Vá Lỗi Theo 4 Đợt & Kiến Trúc Bộ Kiểm Thử Tự Động 5 Tầng

> **Phiên bản:** v1.1 (Immutable Sequential Migrations `027` -> `038`, đã duyệt triển khai Wave 1)  
> **Phạm vi:** `cafe-pos-backend` (Express 5 / PostgreSQL / Socket.IO), `frontend` (React 19 / Vite 8 / Zustand 5 / PWA), `local-print-bridge`.  
> **Nguyên tắc bất di bất dịch:**
> 1. Không cấp `BYPASSRLS` cho `app_runtime`; mọi truy vấn cross-tenant dùng `SECURITY DEFINER` + `SET search_path = public` + `GRANT EXECUTE ... TO app_runtime`.
> 2. **Immutable Sequential Migrations:** Mỗi migration chỉ viết 1 lần, không bao giờ sửa nối lại file migration giữa các đợt.
> 3. **Expand-and-Contract:** Không `DROP COLUMN` phá dữ liệu hoặc gây lỗi rolling deploy.
> 4. **Zero Split-Brain & No Fake Production:** Mọi thay đổi API đều nối thẳng UI + test xác nhận; không giữ mock/stub trong đường dẫn thu phí production.

---

## 1. Kiểm Chứng Thực Tế Mã Nguồn (Codebase Verification Checklist)

| Hạng mục | Vị trí thực tế | Ghi nhận |
| :--- | :--- | :--- |
| Backend Monolith | `server.js` (`11,977` dòng) | Chưa có `SIGTERM`/`SIGINT`; `/api/ready` ở L11924; `cors(` L176; `express.json` L183; `SKIP_AUTO_DDL` L302/314/345. |
| Migrations | `db/migrations/` (`001`–`026`) + `scripts/run-migration.js` | Chưa có bảng `schema_migrations`, mặc định chỉ chạy `'026'`. Cần nâng cấp tracker `public.schema_migrations`. |
| PK `combo` & FK con | `db/migrations/023_foh_phase1_100_percent_upgrade.sql` | `combo` PK đơn `macombo`, `combo_slots.macombo` có FK trỏ vào. Đổi PK sang `(tenantid, macombo)` phải recreate FK `combo_slots (tenantid, macombo)`. |
| VietQR Webhook | `server.js` (`xuLyBienDongSoDuVietQR`, L7150) | Chưa bọc `SAVEPOINT sp_vietqr_settle`, lỗi khớp đơn làm rollback mất luôn log `vietqr_webhook_events`. |
| `staffStatusCache` | `middleware.js` (L15–20) | Key `maNV` thuần thiếu `tenantId`. |
| VietQR Frontend | `frontend/src/utils/vietqrEmvco.js` (L65) | Fallback im lặng về MB Bank `'970422'`; ảnh QR phụ thuộc `img.vietqr.io`. Đổi sang dùng gói `qrcode` vẽ SVG/Canvas nội bộ. |
| Redis & Container | `package.json`, `modules/redisCluster.js`, `docker-compose.yml`, `Dockerfile` | Thiếu `ioredis` & `@socket.io/redis-adapter`; `incr`+`pexpire` chưa nguyên tử; Redis dùng `allkeys-lru`; `Dockerfile` copy `scripts`. |
| PWA & Offline | `frontend/public/sw.js`, `frontend/vite.config.js` | `sw.js` viết tay không precache `/assets/*.js,*.css`. |
| UI Split-Brain | `orderService.js`, `caService.js` vs `PosPage.jsx`, `Cart.jsx`, `ThuChiModal.jsx`, `DongCaModal.jsx` | Service wrappers đã có (`luu-tam`, `receipt-photo`, `resolve-overpayment`, `tienGiuLaiKet`), nhưng React UI chưa nối. |
| Socket Rooms & 86 | `BaristaPage.jsx` vs `PosPage.jsx`, `WaiterPage.jsx` | Chỉ `BaristaPage` gửi `room:subscribe`; 0 listener `menu:86_updated`. |
| Browser Dialogs & Barcode | 7 `window.prompt` + 8 `window.confirm` + `useBarcodeScanner.js` | Đúng 15 dialog cần thay; `useBarcodeScanner` dùng `HTMLInputElement.prototype` setter trên `TEXTAREA`. |
| Print Bridge | `local-print-bridge/bridge-config.json`, `tsplBuilder.js` | `apiToken` hardcode; `escapeTspl` chưa lọc `[\r\n\t]+`. |

---

## 2. Ma Trận Migrations Bất Biến & Liên Tục (`027` -> `038`)

| Đợt | Số | Tên file trong `db/migrations/` | Nội dung cốt lõi |
| :---: | :---: | :--- | :--- |
| **Wave 1** | **027** | `027_dual_fsm_version_combo_pk_branch_counter.sql` | `HoaDon.lifecycle_status`, `buoc_lam_tron`, trigger `trg_guard_hoadon_fsm`, `ChiTietHoaDon.trang_thai_huy`, đổi PK `combo` sang `(tenantid, macombo)` + FK `combo_slots`, bảng `branch_daily_counter`, `fn_resolve_invoice_for_webhook` (`SECURITY DEFINER`). |
| **Wave 1** | **028** | `028_hr_attendance_unique_and_missed_clockout.sql` | `UNIQUE INDEX uq_chamcong_single_per_phanca ON chamcong(maphanca)`, cột `trangthai_chamcong`, `auto_flagged_at`. |
| **Wave 1** | **029** | `029_platform_admin_security_definer_rpcs.sql` | Bộ RPC `SECURITY DEFINER SET search_path = public` (`GRANT EXECUTE TO app_runtime`) cho Super Admin: `fn_platform_kpi_overview`, `fn_platform_list_tenants`, `fn_platform_manual_approve_billing`, `fn_platform_impersonate_tenant` có ghi `Audit_Logs`. |
| **Wave 2** | **030** | `030_idempotency_composite_pk_and_lease.sql` | Đổi PK `donhang_idempotency` sang `(tenantid, khoaidem)`, thêm `lease_expires_at`, `request_fingerprint`. |
| **Wave 2** | **031** | `031_cogs_adjustment_journal.sql` | Tạo `public.cogs_adjustment_journal` (`FORCE RLS`) cho Safe WAC & replay hồi tố. |
| **Wave 3** | **032** | `032_branch_availability_86.sql` | Tạo `public.branch_availability_86 (tenant_id, branch_id, entity_type, entity_id)` với `FORCE RLS`. |
| **Wave 3** | **033** | `033_vn_tax_einvoice_and_nd13_privacy.sql` | `tax_categories` (`VAT_8_FB`, `VAT_10_STD`, `VAT_0`, `KCT`), tax snapshot trên `chitiethoadon`, `einvoices`, `customer_consent_logs`, `ZaloOptIn DEFAULT FALSE`, `anonymized_at`. |
| **Wave 3** | **034** | `034_hr_3layer_kiosk_gps_and_shift_overlap.sql` | `kiosk_hmac_secret`, GPS/IP chi nhánh trên `ChiNhanh`, ràng buộc chống trùng khung giờ ca `PhanCa`. |
| **Wave 4** | **035** | `035_business_day_cutoff_and_reporting_summary.sql` | `business_day_cutoff_hour` (04:00), `hoadon.business_date`, composite indexes, `daily_branch_financial_summary`. |
| **Wave 4** | **036** | `036_house_account_vietqr_attempts_dual_pin.sql` | `house_accounts`, `house_account_ledger`, `vietqr_payment_attempts` (TTL 5p), `shift_handovers` (Dual-PIN). |
| **Wave 4** | **037** | `037_aggregator_settlement_and_supplier_ap.sql` | `aggregator_settlement_batches`, `supplier_ap_ledger`. |
| **Wave 4** | **038** | `038_price_books_zns_tip_pool_and_ot_rules.sql` | `price_books`, `price_book_items`, `zns_credit_balance`, `zns_delivery_logs`, `tip_pool_entries`, `hr_ot_policies`. |

---

## 3. Chi Tiết 4 Đợt Triển Khai

### ĐỢT 1 — P0 LAUNCH BLOCKERS (`P0-01`, `P0-03`, `P0-04`, `P0-07`)
- **Migrations:** `027`, `028`, `029`.
- **Hạ tầng Test & Migration:** `docker-compose.test.yml`, `db/init-test-db.sql`, `db/schema_base.sql`, `.env.test.example`, nâng cấp `scripts/run-migration.js` có `public.schema_migrations`.
- **P0-01 (Dual FSM & Concurrency):**
  - `POST /api/order/huy-mon`: Bắt buộc `expectedVersion` (`428` nếu thiếu, `409 ORDER_CONCURRENT_MODIFIED` nếu lệch); tách `CANCELLED_BEFORE_PREP` vs `WASTED_AFTER_PREP`; cấm hoàn kho món đã `DaPhucVu` kể cả `laHangDongGoi = true`; chặn `tongMoi < daThanhToan` (`409 VOID_EXCEEDS_UNPAID_BALANCE`); tự chuyển `VOIDED`, xóa `HoaDon_Ban`, trả `Ban.TrangThai = 1`, xoay `QrToken` và phát `BAN_THAY_DOI` khi món hiệu lực = 0 và `daThanhToan = 0`.
  - `doiTrangThaiMon`: kiểm tra `FireStatus = 'FIRED'` và `TrangThaiTT IN (0, 1)`.
  - Mandatory `expectedVersion` trên toàn bộ API sửa/tách/gộp/hủy/thanh toán + UI `PosPage.jsx` & `TableMap.jsx` + Soft-Lock bàn `table:checkout_lock` (TTL 45s).
  - Bảo toàn `DaInTamTinh = TRUE` khi gộp bàn (`POST /api/ban/gop`); giữ đúng `buoc_lam_tron` trong `recalculateInvoiceTotals`; đổi PK `combo` sang `(tenantid, macombo)`; dùng `branch_daily_counter`; chặn tách lẻ món trong Combo ở `handleSplitOrder`.
- **P0-03 (VietQR & Ví):**
  - `xuLyBienDongSoDuVietQR`: dùng `fn_resolve_invoice_for_webhook`, bọc settle trong `SAVEPOINT sp_vietqr_settle`, lỗi `400/404/409` thì `ROLLBACK TO SAVEPOINT` nhưng bắt buộc `COMMIT` `vietqr_webhook_events` = `'PENDING_ACTION'` + phát cảnh báo đỏ lên POS; tự nâng cấp `POS_MANUAL_PROVISIONAL` -> `WEBHOOK_VERIFIED`.
  - `POST /api/order/quick-checkout`: dùng chung `ghiNhanThanhToanTrongGiaoDich` khóa `FOR UPDATE` và kiểm tra/trừ `KhachHang.SoDuVi`.
  - `vietqrEmvco.js` + `VietQrBankModal.jsx` + `printHelper.js`: bỏ fallback MB Bank (`970422`), báo lỗi tường minh khi thiếu BIN; cài gói `qrcode` vẽ SVG/Canvas nội bộ từ `emvcoPayload`.
- **P0-04 (Super Admin RLS & AppSec):**
  - `platformAdminRoutes.js`: chuyển `overview`, `tenants`, `manual-approve`, `impersonate` sang RPC `SECURITY DEFINER` (`029`).
  - `saasRoutes.js`: sinh `MaTienTo` 4 bytes random kèm retry `UNIQUE`.
  - `server.js`: siết CORS production (bắt buộc `FRONTEND_URL`, tắt `isLocalDevOrigin`, thêm `'PATCH'`), Security Headers (`HSTS`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`), `express.json({ limit: '512kb' })` toàn cục (chỉ mở `8mb` cho `/api/ai/parse-menu`), rate-limit chống brute-force/DoS `scrypt` ở `xacThucPinQuanLy`.
  - `middleware.js`: key `staffStatusCache` = `${tenantId}:${maNV}`.
  - `local-print-bridge`: xóa `apiToken` hardcode khỏi `bridge-config.json`, tự sinh 32-byte random token lần đầu, mặc định bind `127.0.0.1`.
- **P0-07 (HR & Blind Drop):**
  - `POST /api/nhansu/chamcong`: `uq_chamcong_single_per_phanca` (`409`), kiểm tra `pc.NgayLam = todayDateVN()`, job đánh dấu `MISSED_CLOCK_OUT` quá 2h.
  - `GET /api/nhansu/tinhluong`: giữ NV `TrangThaiLamViec = FALSE` nếu có phân ca/chấm công trong kỳ.
  - Bịt rò rỉ `expected_cash`: xóa `tienMatLyThuyet` khỏi Socket `shift:drawer_limit_warning`, ẩn tổng tiền mặt theo ca trên `/api/hoadon/lichsu` đối với Thu ngân khi ca mở.
  - `computeEndOfDayReconciliation`: lọc `vietqr_webhook_events` theo khung `[ThoiGianMoCa, COALESCE(ThoiGianDongCa, now())]`.
- **Exit Criteria Wave 1:** `npm run test:wave1` pass 100% + `cd frontend && npm run build` xanh.

### ĐỢT 2 — P0 VẬN HÀNH QUẦY (`P0-02`, `P0-05`, `P0-06`, `P0-08`)
- **Migrations:** `030`, `031`.
- Xóa Split-Brain UI (`ThuChiModal.jsx`, `PosPage.jsx`, `Cart.jsx`, `DongCaModal.jsx`); khớp P&L Dashboard + AvT + `cogs_adjustment_journal`; cài `ioredis` + `@socket.io/redis-adapter`, Lua rate-limit, `volatile-lru`, Graceful Shutdown `SIGTERM`, Idempotency Lease 60s, `vite-plugin-pwa`, Error Boundaries; nâng cấp `escposBuilder.js` (`GS v 0` 1-bit raster) & `tsplBuilder.js` (`escapeTsplSafe`, `REVERSE`, wrap dòng 2).
- **Exit Criteria Wave 2:** `npm run test:wave2` pass 100%.

### ĐỢT 3 — P1 THƯƠNG MẠI HÓA VIỆT NAM (`P1-01` -> `P1-05`)
- **Migrations:** `032`, `033`, `034`.
- Thuế VAT đa mức 8%/10% + HĐĐT Adapter + NĐ 13/2023; cô lập Socket 3 tầng + `branch_availability_86` + `item-swap` + `rush`; hoàn thiện UI FOH (Combo, Modifier `+/-`, Cân ký, Bao bì, `[F1]` không dấu, thay 15 `prompt/confirm`, CFD, `useBarcodeScanner`, Thumb Zone, Clock Drift); Chấm công 3 lớp QR HMAC 30s + GPS 50m/IP; Storage Adapter S3/R2; SaaS Portal trung thực + Excel Import + Dunning Cron.
- **Exit Criteria Wave 3:** `npm run test:wave3` pass 100%.

### ĐỢT 4 — P2/P3 MỞ RỘNG QUY MÔ CHUỖI (`P2-01` -> `P2-03`, `P3-01`)
- **Migrations:** `035`, `036`, `037`, `038`.
- Tách `server.js` theo Strangler Pattern (`src/domains/*`), `SKIP_AUTO_DDL=true` production, `business_day_cutoff_hour` + Read-Replica `REPORT_DATABASE_URL`, House Account, Dual-PIN Handover, Price Books, Zalo ZNS thật, Bida Time-Billing, Tip Pool & OT, `.github/workflows/ci.yml` + `k6` stress test (`p95 < 350ms`, error `< 0.5%`).
- **Exit Criteria Wave 4:** `npm run test:all` + `npm run test:load` + CI xanh.

---

## 4. Bộ Kiểm Thử Tự Động 5 Tầng
- **Tầng 1 (`tests/unit/`):** Pure logic (< 5s, 0 DB) với `node:test`.
- **Tầng 2 (`tests/integration/`):** DB RLS & API Integration bắt buộc qua `tests/integration/00-rls-guard.test.js` kiểm tra `rolbypassrls === false` trên `app_runtime`, phủ 100% `QA-02` -> `QA-14`.
- **Tầng 3 (`tests/realtime/`):** 2 Express+Socket.IO instances chung Redis, cô lập 3 tầng, Delta Sync, Graceful Shutdown `SIGTERM`.
- **Tầng 4 (`tests/e2e/`):** Playwright Chromium (`QA-01` PWA offline F5, modals, công thái học, Local Print Bridge).
- **Tầng 5 (`scripts/loadtest-rush-hour.k6.js` + `.github/workflows/ci.yml`):** Stress test 25 TPS + 200 VU & CI Quality Gate.
