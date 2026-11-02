const jwt = require('jsonwebtoken');
require('dotenv').config();

const kiemTraToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Lấy token sau chữ "Bearer "

    if (!token) return res.status(401).json({ message: 'Vui lòng cung cấp Token!' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Token không hợp lệ hoặc đã hết hạn!' });
        req.user = user; 
        next();
    });
};

module.exports = { kiemTraToken };