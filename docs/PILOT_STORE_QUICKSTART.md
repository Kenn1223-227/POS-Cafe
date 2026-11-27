# Hướng Dẫn Vận Hành Nhanh Cho Quán Pilot (1 Trang)

Tài liệu cầm tay dành cho **Chủ quán** & **Thu ngân** sử dụng hệ thống Cafe POS hằng ngày.

---

## 1. Thiết Lập Ban Đầu Tại Quầy (Làm 1 Lần)

### A. Cài & cấu hình cầu in nhiệt (`local-print-bridge`)
1. Sao chép `local-print-bridge/bridge-config.example.json` thành `local-print-bridge/bridge-config.json`.
2. Mở file `bridge-config.json` và điền đúng 3 mục:
   - `security.apiToken`: đặt chuỗi bí mật ngẫu nhiên (hoặc chạy `start-bridge.bat` lần đầu để hệ thống tự sinh 64 ký tự).
   - `security.allowedOrigins`: chỉ ghi **đúng địa chỉ web POS của quán** (ví dụ `["https://pos.tenquan.vn"]` — **không** ghi `*` hay `*.vercel.app`).
   - Máy in bill K80 & máy in tem TSPL: chọn `LAN_TCP` (nhập đúng IP máy in, cổng `9100`, đặt **`sensorProbeEnabled: false`** để máy in Xprinter/Zywell không bị kẹt chờ cảm biến) hoặc `WINDOWS_SHARE` (nhập tên chia sẻ ngắn như `XP-80C`, **không** gõ `\\` ở đầu).
3. Chạy `start-bridge.bat` (Windows) hoặc `start-bridge.sh` (macOS/Linux); có thể chạy `install-windows-autorun.bat` để tự khởi động cùng máy tính.
4. Trên màn hình POS, bấm **🖨️ Máy in** -> dán `apiToken` -> bấm **Lưu** -> bấm **In thử Bill K80 (Tiếng Việt Raster)** và **In thử Tem cốc TSPL** để kiểm tra chữ có dấu sắc nét và cắt giấy bình thường.

### B. Nhập khóa VietQR riêng của quán (SePay / PayOS)
1. Đăng nhập tài khoản **Quản lý** -> tại màn hình POS bấm nút **🏦 VietQR**.
2. Chọn Ngân hàng, nhập Số tài khoản, Tên chủ tài khoản và dán **SePay API Key** hoặc **PayOS Checksum Key** riêng của quán -> bấm **Lưu**.
3. Test chuyển khoản `2.000đ` vào đơn thử để xác nhận màn hình tự nhảy trạng thái **Đã thanh toán**.

---

## 2. Quy Trình 4 Bước Trong 1 Ngày Bán Hàng

1. **Mở ca đầu ngày:**
   - Thu ngân đăng nhập -> nhập số tiền mặt thực đếm trong két (hoặc bấm **🧮 Đếm mệnh giá** theo từng loại tờ tiền) -> bấm **Mở ca ngay**.
2. **Lên đơn & thanh toán:**
   - Chọn bàn hoặc **Mang đi** (nhập **Số thẻ rung** nếu quán dùng thẻ rung).
   - Chọn món -> chọn tùy chọn **Đá / Đường / Extra Shot (x1, x2...)** & Topping -> bấm **Gửi bếp** hoặc **Thanh toán nhanh** (Tiền mặt / VietQR / Hỗn hợp).
   - **Lưu ý phân quyền:** Khi Thu ngân cần **tặng món (0đ)**, **chiết khấu dòng món**, **hủy món đã nhận pha/đã in tạm tính** hoặc **hoàn tiền**, hệ thống sẽ khóa và yêu cầu chọn tên **Quản lý / Ca trưởng** trong danh sách rồi nhập **mã PIN 4–6 số**.
3. **Thu / Chi lặt vặt trong ca:**
   - Mở mục **Thu / Chi** -> chọn **CHI** (mua đá, mua sữa...) hoặc **RÚT KÉT** -> chọn danh mục & nhập số tiền.
   - Khoản chi từ ngưỡng quy định trở lên (mặc định `>= 50.000đ`) **bắt buộc chụp/đính kèm ảnh hóa đơn chứng từ**; khoản lớn (`>= 200.000đ`) cần thêm PIN Quản lý.
4. **Đóng ca mù (Blind Drop) & In Z-Report:**
   - Cuối ca, kiểm tra không còn bàn mở/đơn lưu tạm -> bấm **🔒 Đóng ca**.
   - Đếm thực tế tiền mặt trong két theo bảng mệnh giá (hệ thống ẩn số lý thuyết để chống đối phó), nhập **Tiền giữ lại két cho ca sau** -> bấm **Xác nhận Đóng ca**.
   - Hệ thống tự hiện kết quả đối soát (Khớp / Thừa / Thiếu) -> bấm **🖨️ In phiếu Z-Report** để hai bên ký bàn giao.

---

## 3. Xử Lý Nhanh 3 Tình Huống Hay Gặp Tại Quầy

| Tình huống | Dấu hiệu nhận biết | Cách xử lý nhanh trong 30 giây |
| :--- | :--- | :--- |
| **1. Mất mạng Internet** | Nút góc trên chuyển đỏ **📡 OFFLINE** | **Cứ tiếp tục lên đơn & thu tiền mặt bình thường.** Đơn tự lưu an toàn vào hàng đợi **Offline Queue** trên trình duyệt (và truyền nội bộ qua Wi-Fi LAN sang Barista nếu bật LAN Hub). Khi có mạng lại, hệ thống tự đồng bộ lên máy chủ; có thể bấm nút **📤 Chờ đồng bộ** để kiểm tra/đồng bộ ngay. |
| **2. Kẹt giấy / Hết giấy khi đang in tem nhiều ly** | Đèn máy in báo đỏ hoặc POS hiện cảnh báo **🚨 In lỗi** | Mở nắp thay cuộn giấy/gỡ giấy kẹt rồi đóng nắp. Bấm **🖨️ Máy in** -> bấm **In lại / Tiếp tục** trên lệnh bị tạm dừng. Bridge tự nhớ các ly đã in và **chỉ in tiếp từ ly `k/N` trở đi**, không in trùng tem cũ. |
| **3. Hết món / Hết nguyên liệu giờ cao điểm (Báo 86)** | Quầy Bar báo hết nguyên liệu hoặc hết món | Trên màn hình Barista (hoặc Quản trị Thực đơn), bấm **Báo hết món (86)** -> gạt tắt món / topping / nguyên liệu bị hết. Toàn bộ máy POS & menu QR khách sẽ **tự động khóa mờ món đó tức thì** để thu ngân không nhận nhầm đơn. Khi nhập hàng lại chỉ cần gạt bật lại. |
