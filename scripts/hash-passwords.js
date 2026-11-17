const path = require('path');
// Ép đọc đúng file .env ở thư mục gốc (backend) một cách tuyệt đối
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { Pool } = require('pg');
const { hashPassword } = require('../password');

// 1. Lấy và kiểm tra biến môi trường
const connectionString = process.env.DATABASE_URL;

if (!connectionString || !connectionString.startsWith('postgres')) {
    console.error('❌ Lỗi: DATABASE_URL không tồn tại hoặc sai định dạng.');
    console.error('Giá trị hiện tại đang nhận được là:', connectionString);
    process.exit(1);
}

// 2. Khởi tạo Pool với SSL tắt xác thực để triệt tiêu cảnh báo
const pool = new Pool({
    connectionString: connectionString.trim(),
    ssl: {
        rejectUnauthorized: false 
    }
});

(async () => {
    try {
        try {
            await pool.query('ALTER TABLE NhanVien ALTER COLUMN MatKhauHash TYPE TEXT');
        } catch (e) {
            console.warn('Không đổi được kiểu cột MatKhauHash (bỏ qua nếu đã là TEXT):', e.message);
        }

        const { rows } = await pool.query(
            `SELECT MaNV, MatKhauHash FROM NhanVien
              WHERE MatKhauHash IS NOT NULL AND MatKhauHash NOT LIKE 'scrypt$%'`
        );
        console.log(`Tìm thấy ${rows.length} tài khoản còn mật khẩu dạng thô.`);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const r of rows) {
                const hash = await hashPassword(r.matkhauhash);
                await client.query('UPDATE NhanVien SET MatKhauHash = $1 WHERE MaNV = $2', [hash, r.manv]);
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
        console.log(`✅ Đã băm ${rows.length} mật khẩu.`);
    } catch (e) {
        console.error('❌ Thất bại:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();