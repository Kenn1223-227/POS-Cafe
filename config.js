// Kiểm tra cấu hình bắt buộc ngay khi khởi động: thiếu/yếu thì dừng, không chạy ở trạng thái không an toàn.
require('dotenv').config({ quiet: true });

const JWT_SECRET_TOI_THIEU = 32;
const LENH_TAO_KHOA = `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`;

// Trả về danh sách vấn đề của JWT_SECRET (rỗng = đạt)
function loiJwtSecret(secret) {
    const loi = [];
    const s = secret || '';

    if (/\s/.test(s) || /node\s+-e|randomBytes|console\.log|require\(/i.test(s)) {
        loi.push(
            'JWT_SECRET đang chứa khoảng trắng hoặc nội dung giống CÂU LỆNH: có vẻ bạn đã dán câu lệnh tạo khóa thay vì KẾT QUẢ của lệnh.\n' +
            `    Hãy chạy lệnh:  ${LENH_TAO_KHOA}\n` +
            '    rồi dán chuỗi in ra (96 ký tự chữ-số) vào .env:  JWT_SECRET=<chuỗi đó>'
        );
    } else if (s.length < JWT_SECRET_TOI_THIEU) {
        loi.push(
            `JWT_SECRET phải dài tối thiểu ${JWT_SECRET_TOI_THIEU} ký tự ngẫu nhiên (hiện ${s.length}).\n` +
            `    Tạo bằng: ${LENH_TAO_KHOA}`
        );
    } else if (new Set(s).size < 12) {
        loi.push('JWT_SECRET quá đơn điệu (ít loại ký tự), hãy dùng chuỗi ngẫu nhiên sinh bằng lệnh ở trên.');
    }
    return loi;
}

function kiemTraCauHinh() {
    const loi = [];

    if (!process.env.DATABASE_URL) {
        loi.push('Thiếu DATABASE_URL.');
    }
    loi.push(...loiJwtSecret(process.env.JWT_SECRET));

    if (loi.length > 0) {
        console.error('\n❌ Cấu hình không hợp lệ, server không khởi động:');
        loi.forEach((l) => console.error('  - ' + l));
        console.error('');
        process.exit(1);
    }
}

module.exports = { kiemTraCauHinh, loiJwtSecret };
