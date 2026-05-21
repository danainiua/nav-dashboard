/**
 * 上传路由模块
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { fetchRemoteImage, getImageExtension } = require('../utils/remoteImage');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');

// 上传目录
const uploadsDir = path.join(__dirname, '..', '..', 'uploads');

// 确保上传目录存在
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer 配置
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const ext = getImageExtension(file.mimetype);
        const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}${ext}`;
        cb(null, filename);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
    fileFilter: (req, file, cb) => {
        cb(null, Boolean(getImageExtension(file.mimetype)));
    }
});

// 上传图片（需要认证）
router.post('/', requireAuth, upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: '没有上传文件或文件类型不支持' });
    }
    res.json({ success: true, message: '上传成功', data: { url: `/api/images/${req.file.filename}` } });
});

// 获取图片
router.get('/images/:filename', (req, res) => {
    // 安全检查：防止路径遍历
    const filename = path.basename(req.params.filename);
    if (filename !== req.params.filename || filename.includes('..')) {
        return res.status(400).send('Invalid filename');
    }

    const filePath = path.join(uploadsDir, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('Image not found');
    }
    res.sendFile(filePath);
});

// 图片代理（带域名白名单）
router.get('/proxy/image', asyncHandler(async (req, res) => {
    const imageUrl = req.query.url;

    if (!imageUrl) {
        return res.status(400).json({
            success: false,
            error: 'Missing url parameter'
        });
    }

    const result = await fetchRemoteImage(imageUrl);
    if (!result.success) {
        return res.status(result.status || 502).json({
            success: false,
            error: result.error,
            status: result.upstreamStatus
        });
    }

    res.set('Content-Type', result.contentType);
    res.set('Cache-Control', 'public, max-age=604800');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(result.buffer);
}));

module.exports = router;
