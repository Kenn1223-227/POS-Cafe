# Hướng dẫn Triển khai Print Hub cho Quán dùng iPad / Android Tablet

Hệ thống Cafe POS hỗ trợ **5 tầng kết nối máy in không hộp thoại (Silent Print)** để tương thích mọi cấu hình quán cafe tại Việt Nam:

## 1. Quán dùng iPad / Android Tablet (Đề xuất: Cloud Print Relay + Raspberry Pi / Mini PC Hub)
Khi POS chạy trên `https://...`, trình duyệt trên iPad/Android sẽ chặn gọi trực tiếp `http://192.168.x.x:9100` (Mixed Content / Private Network Access). Giải pháp ổn định nhất là đặt **1 máy PC quầy hoặc Raspberry Pi Zero 2W / Pi 4** cắm chung mạng LAN với máy in nhiệt (`192.168.1.200:9100`):

1. Trên Raspberry Pi / macOS / Linux, chạy:
   ```bash
   CLOUD_RELAY_URL="https://api.your-domain.com" \
   CLOUD_RELAY_TOKEN="<JWT_TOKEN_QUAN_CUA_BAN>" \
   bash local-print-bridge/start-bridge.sh
   ```
   *(Hoặc trên Windows PC, chạy `local-print-bridge/install-windows-autorun.bat` để tự khởi động ngầm cùng Windows).*
2. Trên mọi iPad / Android Tablet của thu ngân và phục vụ:
   - Mở POS → bấm **🖨️ Máy in** → chọn chế độ **☁️ Cloud Print Relay (iPad / Android Tablet chạy HTTPS)**.
   - Mọi lệnh in Bill K80, Tem 50×30mm và xung mở két RJ11 sẽ đi qua HTTPS về Backend rồi được Print Hub kéo về in ngay trong ~1 giây!

## 2. Quán dùng Android Tablet / Máy POS Cầm Tay (Sunmi V2/T2) không cần PC Hub
- **Cách A — Android RawBT**: Cài app miễn phí `RawBT` trên Android, ghép nối máy in Bluetooth/USB một lần → trong POS chọn chế độ **📱 Android RawBT / Sunmi POS Intent**.
- **Cách B — WebBluetooth / WebUSB trực tiếp trên Chrome Android**: Trong POS bấm **🖨️ Máy in** → bấm **📶 Ghép máy in Bluetooth (BLE)** hoặc **🔌 Ghép máy in WebUSB** (0 app cài thêm!).

## 3. Quán dùng PC Windows / macOS
- Chạy `local-print-bridge/start-bridge.bat` (Windows) hoặc `local-print-bridge/start-bridge.sh` (macOS/Linux), hoặc chọn **🔌 WebSerial / WebUSB** ngay trên Chrome/Edge.
