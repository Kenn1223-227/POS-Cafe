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
3. **Hỗ trợ HTTPS Production (Vercel -> Localhost)**: Bridge mặc định trả header `Access-Control-Allow-Private-Network: true` cùng `Access-Control-Allow-Origin` theo Origin gọi vào để vượt kiểm tra **Chrome Private Network Access (PNA)** mà không bị chặn.
