/**
 * 分类路由模块
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { validateCategoryData } = require('../utils/validator');

const MAX_REORDER_ITEMS = 200;

function parsePositiveId(value) {
    const id = parseInt(value, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function parseSortOrder(value) {
    const sortOrder = parseInt(value, 10);
    return Number.isInteger(sortOrder) && sortOrder >= 0 ? sortOrder : 0;
}

// 获取分类列表
router.get('/', (req, res) => {
    const results = db.prepare(`
        SELECT c.*, (SELECT COUNT(*) FROM sites WHERE category_id = c.id) as sites_count
        FROM categories c ORDER BY c.sort_order ASC, c.created_at ASC
    `).all();
    res.json({ success: true, data: results });
});

// 创建分类（需要认证）
router.post('/', requireAuth, (req, res) => {
    const validation = validateCategoryData(req.body);
    if (!validation.valid) {
        return res.status(400).json({ success: false, message: validation.error });
    }

    const { name, icon, color } = validation.sanitized;
    const stmt = db.prepare(`INSERT INTO categories (name, icon, color, sort_order) VALUES (?, ?, ?, ?)`);
    const result = stmt.run(name, icon, color, parseSortOrder(req.body.sort_order));
    res.json({ success: true, message: '分类创建成功', data: { id: result.lastInsertRowid } });
});

// 更新分类（需要认证）
router.put('/:id', requireAuth, (req, res) => {
    const categoryId = parsePositiveId(req.params.id);
    if (!categoryId) {
        return res.status(400).json({ success: false, message: '无效的分类ID' });
    }

    const validation = validateCategoryData(req.body);
    if (!validation.valid) {
        return res.status(400).json({ success: false, message: validation.error });
    }

    const { name, icon, color } = validation.sanitized;
    const stmt = db.prepare(`UPDATE categories SET name=?, icon=?, color=?, sort_order=? WHERE id=?`);
    const result = stmt.run(name, icon, color, parseSortOrder(req.body.sort_order), categoryId);
    if (result.changes === 0) {
        return res.status(404).json({ success: false, message: '分类不存在' });
    }
    res.json({ success: true, message: '分类更新成功' });
});

// 删除分类（需要认证）
router.delete('/:id', requireAuth, (req, res) => {
    const categoryId = parsePositiveId(req.params.id);
    if (!categoryId) {
        return res.status(400).json({ success: false, message: '无效的分类ID' });
    }

    const count = db.prepare('SELECT COUNT(*) as count FROM sites WHERE category_id = ?').get(categoryId);
    if (count.count > 0) {
        return res.status(400).json({ success: false, message: `此分类下还有 ${count.count} 个站点，无法删除` });
    }
    const result = db.prepare('DELETE FROM categories WHERE id = ?').run(categoryId);
    if (result.changes === 0) {
        return res.status(404).json({ success: false, message: '分类不存在' });
    }
    res.json({ success: true, message: '分类删除成功' });
});

// 分类排序（需要认证）
router.post('/reorder', requireAuth, (req, res) => {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length > MAX_REORDER_ITEMS) {
        return res.status(400).json({ success: false, message: '无效的排序数据' });
    }

    const normalizedOrder = [];
    for (const item of order) {
        const id = parsePositiveId(item?.id);
        if (!id) {
            return res.status(400).json({ success: false, message: '排序数据包含无效分类ID' });
        }
        normalizedOrder.push({ id, sort_order: parseSortOrder(item.sort_order) });
    }

    const stmt = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?');
    const updateMany = db.transaction((items) => {
        for (const item of items) {
            stmt.run(item.sort_order, item.id);
        }
    });
    updateMany(normalizedOrder);
    res.json({ success: true, message: '分类排序更新成功' });
});

module.exports = router;
