const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') 
    ? false 
    : { rejectUnauthorized: false } // Bắt buộc cho các dịch vụ Cloud như Supabase/Neon
});

pool.on('connect', () => {
  console.log('🔗 Đã kết nối thành công với cơ sở dữ liệu PostgreSQL qua Connection String!');
});

module.exports = pool;