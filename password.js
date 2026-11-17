// Băm & kiểm tra mật khẩu bằng scrypt (có sẵn trong Node, không cần cài thêm thư viện).
// Định dạng lưu trong NhanVien.MatKhauHash:  scrypt$<N>$<salt base64url>$<key base64url>
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const PREFIX = 'scrypt';
const N = 16384; // chi phí CPU/RAM (16 MB mỗi lần băm) - tăng dần theo thời gian
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const N_TOI_DA = 131072; // chặn giá trị N bất thường đọc từ DB gây tràn RAM

const DUMMY_SALT = crypto.randomBytes(SALT_LEN);

async function hashPassword(plain) {
    const salt = crypto.randomBytes(SALT_LEN);
    const key = await scrypt(plain, salt, KEY_LEN, { N, r: R, p: P });
    return [PREFIX, N, salt.toString('base64url'), key.toString('base64url')].join('$');
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

/**
 * @returns {{ ok: boolean, canBamLai: boolean }}
 *  - canBamLai = true khi mật khẩu đúng nhưng đang lưu dạng cũ (plaintext) hoặc chi phí N cũ
 *    => nơi gọi nên băm lại và lưu đè.
 *  - stored = null/undefined (không có tài khoản) vẫn tốn thời gian tương đương
 *    để không lộ "tài khoản có tồn tại hay không" qua thời gian phản hồi.
 */
async function verifyPassword(plain, stored) {
    try {
        if (typeof stored === 'string' && stored.startsWith(`${PREFIX}$`)) {
            const [, nStr, saltB64, keyB64] = stored.split('$');
            const n = Number(nStr);
            const salt = Buffer.from(saltB64 || '', 'base64url');
            const expected = Buffer.from(keyB64 || '', 'base64url');
            if (!Number.isInteger(n) || n < 1024 || n > N_TOI_DA || (n & (n - 1)) !== 0 || expected.length === 0) {
                return { ok: false, canBamLai: false };
            }
            const key = await scrypt(plain, salt, expected.length, { N: n, r: R, p: P });
            const ok = crypto.timingSafeEqual(key, expected);
            return { ok, canBamLai: ok && n !== N };
        }

        if (typeof stored === 'string' && stored.length > 0) {
            // Dữ liệu cũ: mật khẩu đang lưu thô. So khớp hằng-thời-gian rồi yêu cầu băm lại.
            const ok = crypto.timingSafeEqual(sha256(plain), sha256(stored));
            return { ok, canBamLai: ok };
        }

        await scrypt(plain, DUMMY_SALT, KEY_LEN, { N, r: R, p: P });
        return { ok: false, canBamLai: false };
    } catch {
        return { ok: false, canBamLai: false };
    }
}

module.exports = { hashPassword, verifyPassword };
