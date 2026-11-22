// Chẩn đoán DATABASE_URL và JWT_SECRET trong .env mà KHÔNG in giá trị bí mật.
// Chạy trong thư mục cafe-pos-backend:   node check-db-url.js
const fs = require('fs');
require('dotenv').config({ quiet: true });
const { loiJwtSecret } = require('./config');

const u = process.env.DATABASE_URL;
if (!u) { console.log('❌ Không đọc được DATABASE_URL (file .env phải nằm trong thư mục bạn đang chạy lệnh).'); process.exit(1); }

const van = [];

// 1) Đọc dòng thô trong .env: dotenv coi '#' (ngoài dấu nháy) là bắt đầu chú thích => mật khẩu bị CẮT CỤT âm thầm
try {
  const dong = fs.readFileSync('.env', 'utf8').split(/\r?\n/).find((l) => /^\s*DATABASE_URL\s*=/.test(l));
  if (dong) {
    const giaTri = dong.slice(dong.indexOf('=') + 1).trim();
    if (!/^["'`]/.test(giaTri) && giaTri.includes('#')) van.push('Giá trị có ký tự # mà KHÔNG nằm trong dấu nháy: dotenv hiểu # là chú thích và cắt mất phần sau => mật khẩu/host sai');
  }
} catch { /* không có .env: biến đến từ môi trường hệ thống */ }

// 2) Soi từng phần của chuỗi
if (!/^postgres(ql)?:\/\//.test(u)) van.push('Không bắt đầu bằng postgresql:// hoặc postgres://');
if (/\[|\]/.test(u)) van.push('Còn dấu ngoặc vuông [ ] (vd. còn nguyên mẫu [YOUR-PASSWORD] của Supabase: phải bỏ cả ngoặc, thay bằng mật khẩu thật)');
const sau = u.replace(/^postgres(ql)?:\/\//, '');
const iAt = sau.lastIndexOf('@');
if (iAt < 0) van.push('Thiếu dấu @ ngăn giữa "user:mật_khẩu" và tên máy chủ');
const userPass = iAt >= 0 ? sau.slice(0, iAt) : '';
const pass = userPass.includes(':') ? userPass.slice(userPass.indexOf(':') + 1) : '';
if ((sau.match(/@/g) || []).length > 1) van.push('Có hơn 1 dấu @: mật khẩu chứa @ chưa mã hóa (phải viết %40)');
const dacBiet = pass.match(/[\/?#:]/g);
if (dacBiet) van.push(`Mật khẩu chứa ký tự đặc biệt chưa mã hóa: ${[...new Set(dacBiet)].join(' ')}  (/ → %2F, ? → %3F, # → %23, : → %3A, @ → %40, % → %25)`);
if (/%(?![0-9A-Fa-f]{2})/.test(pass)) van.push('Mật khẩu có dấu % không theo sau bởi 2 ký tự hex (phải viết %25)');
if (u !== u.trim()) van.push('Có khoảng trắng ở đầu/cuối giá trị');

// 3) Chạy ĐÚNG bộ phân tích mà thư viện pg dùng khi kết nối
let ketQua = null, loiPg = null;
try {
  const { parse } = require('pg-connection-string');
  const c = parse(u);
  ketQua = `host=${c.host}  port=${c.port || '(mặc định)'}  database=${c.database || '(trống)'}  user=${c.user}  độ dài mật khẩu=${(c.password || '').length}`;
  if (/^db\.[a-z0-9]+\.supabase\.co$/.test(c.host || '')) van.push('Đây là kết nối TRỰC TIẾP của Supabase (db.<mã>.supabase.co): gói miễn phí chỉ có địa chỉ IPv6, máy/mạng không có IPv6 sẽ báo getaddrinfo ENOENT. Hãy dùng chuỗi POOLER (host dạng aws-0-<vùng>.pooler.supabase.com, cổng 6543)');
  if ((c.host || '').includes('pooler.supabase.com') && !/^postgres\.[a-z0-9]+$/.test(c.user || '')) van.push('Dùng pooler thì tên người dùng phải là postgres.<mã dự án>, không phải chỉ "postgres"');
  if (c.host && !c.host.includes('.')) van.push(`Tên máy chủ "${c.host}" không giống một tên miền: nhiều khả năng chuỗi đã bị cắt/hiểu sai (xem các nghi vấn khác)`);
} catch (e) { loiPg = e.message; }

console.log(ketQua ? `✅ pg đọc được: ${ketQua}` : `❌ pg không đọc được chuỗi này (${loiPg}) — đây chính là lỗi bạn gặp.`);
if (van.length) { console.log('\nNghi vấn:'); van.forEach((v) => console.log('  - ' + v)); }
if (!ketQua && !van.length) console.log('Chưa nhận ra nguyên nhân: hãy dán chuỗi kết nối đã che mật khẩu bằng ****** để mình soi tiếp.');
// 4) JWT_SECRET (chỉ in kết luận, không in giá trị)
const loiJwt = loiJwtSecret(process.env.JWT_SECRET);
console.log(loiJwt.length ? '\n❌ JWT_SECRET chưa đạt:' : `\n✅ JWT_SECRET đạt (độ dài ${(process.env.JWT_SECRET || '').length})`);
loiJwt.forEach((l) => console.log('  - ' + l));

console.log('\nCách chắc nhất: Supabase → Database → Reset password → đặt mật khẩu CHỈ gồm chữ và số (không cần mã hóa), rồi dán lại chuỗi kết nối.');
