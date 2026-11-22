// Thử kết nối thật tới database và nói rõ lỗi thuộc loại nào. KHÔNG in mật khẩu.
// Chạy trong thư mục cafe-pos-backend:   node ping-db.js
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

function phanLoaiLoi(msg = '') {
  if (/tenant\/user .* not found/i.test(msg)) return [
    'Pooler của Supabase không nhận ra tổ hợp "host + tên người dùng" này. Thường do một trong 3 nguyên nhân:',
    '  1) Dự án đang bị TẠM DỪNG (gói miễn phí tự dừng khi lâu không dùng): vào dashboard Supabase, nếu thấy nút "Restore project" thì bấm và đợi vài phút.',
    '  2) Host pooler sai VÙNG hoặc sai TIỀN TỐ (có dự án dùng aws-0-..., dự án mới dùng aws-1-...). ĐỪNG tự gõ: bấm nút "Connect" ở đầu trang dashboard,',
    '     chọn "Transaction pooler" (hoặc "Session pooler"), copy NGUYÊN chuỗi, chỉ thay [YOUR-PASSWORD] bằng mật khẩu thật (bỏ cả ngoặc).',
    '  3) Sai mã dự án trong tên người dùng (phải đúng dạng postgres.<mã dự án>).',
  ];
  if (/password authentication failed|SASL|authentication failed/i.test(msg)) return [
    'Đã tới được database nhưng MẬT KHẨU SAI. Reset mật khẩu trên Supabase (chỉ chữ và số), dán lại vào .env rồi chạy lại.',
  ];
  if (/ENOTFOUND|ENOENT|EAI_AGAIN/i.test(msg)) return [
    'Không phân giải được tên máy chủ: sai host, hoặc đang dùng kết nối trực tiếp db.<mã>.supabase.co (chỉ có IPv6). Hãy dùng chuỗi pooler.',
  ];
  if (/ETIMEDOUT|ECONNREFUSED|timeout/i.test(msg)) return [
    'Không kết nối được (hết thời gian/bị từ chối): kiểm tra mạng, VPN, tường lửa có chặn cổng 6543/5432 không, hoặc thử mạng khác (điện thoại phát wifi).',
  ];
  if (/self.signed|certificate|SSL/i.test(msg)) return [
    'Lỗi chứng chỉ SSL khi kết nối.',
  ];
  return ['Lỗi chưa phân loại, hãy gửi nguyên dòng "Chi tiết" ở trên (không chứa mật khẩu).'];
}

async function main() {
  if (!process.env.DATABASE_URL) { console.log('❌ Không đọc được DATABASE_URL trong .env'); process.exit(1); }
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  try {
    await client.connect();
    const r = await client.query('SELECT current_user AS nguoi_dung, current_database() AS csdl');
    console.log(`✅ Kết nối thành công: user=${r.rows[0].nguoi_dung}  database=${r.rows[0].csdl}`);
    try {
      const nv = await client.query(
        `SELECT COUNT(*)::int AS tong,
                COUNT(*) FILTER (WHERE MatKhauHash NOT LIKE 'scrypt$%')::int AS chua_bam
           FROM NhanVien`
      );
      console.log(`   Bảng NhanVien: ${nv.rows[0].tong} tài khoản, ${nv.rows[0].chua_bam} tài khoản còn mật khẩu dạng thô.`);
      console.log('   → Giờ có thể chạy:  npm run hash-passwords');
    } catch (e) {
      console.log(`⚠️ Kết nối được nhưng không đọc được bảng NhanVien: ${e.message}`);
    }
  } catch (e) {
    console.log(`❌ Không kết nối được.\n   Chi tiết: ${e.message}\n`);
    phanLoaiLoi(e.message).forEach((l) => console.log(l));
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = { phanLoaiLoi };
if (require.main === module) main();
