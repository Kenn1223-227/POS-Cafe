# 🖨️ Cafe POS — Local Print Bridge Agent (Silent Print)

Dịch vụ chạy nền siêu nhẹ tại máy quầy thu ngân (`http://127.0.0.1:9100`), **không cần cài thêm bất kỳ thư viện npm nào**, giúp Web POS:
- **In im lặng (Silent Print)** không bật hộp thoại `window.print()` của trình duyệt.
- **Định tuyến độc lập 2 máy in**: Bill **K80 (ESC/POS + Auto-cut)** và Tem cốc **50×30mm (TSPL2)**.
- **Kích mở ngăn kéo tiền RJ11** (`ESC p 0 25 250`) tự động khi thanh toán tiền mặt hoặc mở thủ công có ghi Audit Log.
- **Hàng đợi lệnh in cục bộ** hỗ trợ in lại 1 chạm khi kẹt giấy (kể cả in lại đúng 1 tem ly cụ thể).

## Cách khởi chạy
1. **Windows**: Nhấn đúp chuột vào file `start-bridge.bat` (hoặc chạy `npm run print-bridge` trong thư mục `cafe-pos-backend`).
2. **macOS / Linux**: Chạy `node bridge-server.js`.
3. Mở màn hình POS trên trình duyệt → bấm nút **🖨️ Máy in** trên thanh tiêu đề để:
   - Kiểm tra trạng thái `🟢 Silent Print Online`.
   - Chọn chế độ máy in:
     - `SIMULATOR`: Test không cần máy in thật (xem trước trực tiếp nội dung ESC/POS & TSPL).
     - `LAN_TCP`: Nhập IP máy in mạng nội bộ (cổng mặc định `9100`, VD: `192.168.1.200` cho Bill K80, `192.168.1.201` cho Tem XP-350B).
     - `WINDOWS_SHARE`: Chia sẻ máy in USB trong *Windows Printers & Scanners* (VD đặt Share Name là `XP-80C`, `XP-350B`) rồi nhập đúng tên vào ô cấu hình.

## Đóng gói file `.exe` chạy 1-click trên Windows (không cần cài Node.js ở máy quầy)
1. Dùng `@yao-pkg/pkg` (khuyến nghị nhanh gọn):
   ```bash
   npx @yao-pkg/pkg bridge-server.js --targets node20-win-x64 --output CafePOS-PrintBridge.exe
   ```
2. Gửi file `CafePOS-PrintBridge.exe` cho chủ quán nhấn đúp chạy nền (hoặc bỏ shortcut vào `shell:startup` để tự bật cùng Windows).
3. **Cấu hình CORS cho Frontend HTTPS Production (Vercel / Custom Domain -> Localhost)**:
   - Bridge tự động cho phép mọi origin loopback (`http(s)://localhost:*`, `http(s)://127.0.0.1:*`) và trả `Access-Control-Allow-Private-Network: true` để vượt kiểm tra **Chrome Private Network Access (PNA)**.
   - Mọi origin bên ngoài phải nằm trong danh sách cho phép (allowlist); origin lạ sẽ bị từ chối với HTTP `403`.
   - Cấu hình bằng 1 trong 2 cách (hoặc kết hợp cả hai — xem mẫu trong `bridge-config.example.json`):
     - Trong `bridge-config.json` → `security.allowedOrigins` (mặc định hỗ trợ `https://*.vercel.app`, `https://cafepos.vn`, `https://*.cafepos.vn` — khuyến nghị khóa chặt về đúng domain quán của bạn khi triển khai thực tế).
     - Hoặc biến môi trường `PRINT_BRIDGE_ALLOWED_ORIGINS` (phân tách bằng dấu phẩy), ví dụ:
       ```bash
       PRINT_BRIDGE_ALLOWED_ORIGINS="https://pos.quancuaban.vn,https://my-cafe-pos.vercel.app" node bridge-server.js
       ```
   - Không chấp nhận wildcard mở toang (`*`) để tránh website độc hại gửi lệnh in / mở két tiền trái phép vào `127.0.0.1:9100`.
