/**
 * 数据导入导出路由模块
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const {
    validateSiteData,
    validateCategoryData,
    validateTagData,
    parseNonNegativeInteger,
    parsePositiveInteger
} = require('../utils/validator');

const SENSITIVE_SETTING_KEYS = new Set(['admin_password', 'webdav_password']);
const MAX_IMPORT_CATEGORIES = 500;
const MAX_IMPORT_SITES = 5000;
const MAX_IMPORT_TAGS = 1000;
const MAX_IMPORT_SITE_TAGS = 10000;
const MAX_IMPORT_SETTINGS = 200;

function normalizeSettingsEntries(settings) {
    if (!settings) {
        return [];
    }
    if (Array.isArray(settings)) {
        return settings.filter(item => item && typeof item.key === 'string');
    }
    if (typeof settings === 'object') {
        return Object.entries(settings).map(([key, value]) => ({ key, value }));
    }
    return [];
}

function validateImportCollection(name, value, maxItems) {
    if (!Array.isArray(value)) {
        return { valid: false, error: `${name} 必须是数组` };
    }
    if (value.length > maxItems) {
        return { valid: false, error: `${name} 数量不能超过 ${maxItems}` };
    }
    return { valid: true };
}

function validateImportData(data) {
    if (!data || typeof data !== 'object') {
        return { valid: false, error: '无效的导入数据格式' };
    }

    const requiredCategories = validateImportCollection('categories', data.categories, MAX_IMPORT_CATEGORIES);
    if (!requiredCategories.valid) return requiredCategories;

    const requiredSites = validateImportCollection('sites', data.sites, MAX_IMPORT_SITES);
    if (!requiredSites.valid) return requiredSites;

    if (data.tags !== undefined) {
        const tags = validateImportCollection('tags', data.tags, MAX_IMPORT_TAGS);
        if (!tags.valid) return tags;
    }

    if (data.site_tags !== undefined) {
        const siteTags = validateImportCollection('site_tags', data.site_tags, MAX_IMPORT_SITE_TAGS);
        if (!siteTags.valid) return siteTags;
    }

    const settings = normalizeSettingsEntries(data.settings);
    if (settings.length > MAX_IMPORT_SETTINGS) {
        return { valid: false, error: `settings 数量不能超过 ${MAX_IMPORT_SETTINGS}` };
    }

    return { valid: true, settings };
}

function validateCheckStatus(status) {
    return ['unchecked', 'success', 'failed'].includes(status) ? status : 'unchecked';
}

// 数据导出（需要认证）
router.get('/export', requireAuth, (req, res) => {
    try {
        const categories = db.prepare(`
            SELECT id, name, icon, color, sort_order FROM categories ORDER BY sort_order ASC
        `).all();

        const sites = db.prepare(`
            SELECT
                id,
                name,
                url,
                description,
                logo,
                category_id,
                sort_order,
                click_count,
                last_check_status,
                last_check_http_status,
                last_check_error,
                last_check_at
            FROM sites
            ORDER BY sort_order ASC
        `).all();

        const tags = db.prepare(`
            SELECT id, name, color FROM tags ORDER BY name ASC
        `).all();

        const site_tags = db.prepare(`
            SELECT site_id, tag_id FROM site_tags ORDER BY site_id ASC, tag_id ASC
        `).all();

        const settings = db.prepare(`
            SELECT key, value FROM settings WHERE key NOT IN ('admin_password', 'webdav_password')
        `).all();

        const exportData = {
            version: '1.0',
            exportTime: new Date().toISOString(),
            categories,
            sites,
            tags,
            site_tags,
            settings
        };

        res.set('Content-Type', 'application/json');
        res.set('Content-Disposition', 'attachment; filename="nav-dashboard-backup.json"');
        res.send(JSON.stringify(exportData, null, 2));
    } catch (error) {
        res.status(500).json({ success: false, message: '导出失败: ' + error.message });
    }
});

// 数据导入（需要认证）
router.post('/import', requireAuth, (req, res) => {
    try {
        const data = req.body;

        const importValidation = validateImportData(data);
        if (!importValidation.valid) {
            return res.status(400).json({ success: false, message: importValidation.error });
        }

        const categoryValidationCache = [];
        const siteValidationCache = [];
        const tagValidationCache = [];
        const categoryIds = new Set();
        const siteIds = new Set();
        const tagIds = new Set();

        for (const cat of data.categories) {
            const id = parsePositiveInteger(cat?.id);
            const validation = validateCategoryData(cat);
            const sortOrder = parseNonNegativeInteger(cat?.sort_order, 0);
            if (!id || categoryIds.has(id) || !validation.valid || sortOrder === null) {
                return res.status(400).json({ success: false, message: validation.error || '分类数据无效' });
            }
            categoryIds.add(id);
            categoryValidationCache.push({ id, data: validation.sanitized, sortOrder });
        }

        for (const site of data.sites) {
            const id = parsePositiveInteger(site?.id);
            const validation = validateSiteData(site);
            const sortOrder = parseNonNegativeInteger(site?.sort_order, 0);
            const clickCount = parseNonNegativeInteger(site?.click_count, 0);
            const categoryId = site?.category_id === null || site?.category_id === undefined || site?.category_id === '' ? null : parsePositiveInteger(site.category_id);
            if (!id || siteIds.has(id) || !validation.valid || sortOrder === null || clickCount === null || (site?.category_id && !categoryId) || (categoryId && !categoryIds.has(categoryId))) {
                return res.status(400).json({ success: false, message: validation.error || '站点数据无效' });
            }
            siteIds.add(id);
            siteValidationCache.push({ id, data: validation.sanitized, categoryId, sortOrder, clickCount, status: validateCheckStatus(site.last_check_status), httpStatus: parseNonNegativeInteger(site.last_check_http_status, null), lastCheckError: site.last_check_error ? String(site.last_check_error).slice(0, 500) : null, lastCheckAt: site.last_check_at ? String(site.last_check_at).slice(0, 100) : null });
        }

        for (const tag of data.tags || []) {
            const id = parsePositiveInteger(tag?.id);
            const validation = validateTagData(tag);
            if (!id || tagIds.has(id) || !validation.valid) {
                return res.status(400).json({ success: false, message: validation.error || '标签数据无效' });
            }
            tagIds.add(id);
            tagValidationCache.push({ id, data: validation.sanitized });
        }

        for (const row of data.site_tags || []) {
            const siteId = parsePositiveInteger(row?.site_id);
            const tagId = parsePositiveInteger(row?.tag_id);
            if (!siteId || !tagId || !siteIds.has(siteId) || !tagIds.has(tagId)) {
                return res.status(400).json({ success: false, message: '站点标签关联数据无效' });
            }
        }

        for (const setting of importValidation.settings) {
            if (!setting.key || typeof setting.key !== 'string' || setting.key.length > 100) {
                return res.status(400).json({ success: false, message: '设置数据无效' });
            }
        }

        const importTransaction = db.transaction(() => {
            // 清空现有数据
            db.prepare('DELETE FROM site_tags').run();
            db.prepare('DELETE FROM sites').run();
            db.prepare('DELETE FROM tags').run();
            db.prepare('DELETE FROM categories').run();
            db.prepare("DELETE FROM settings WHERE key NOT IN ('admin_password', 'webdav_password')").run();

            // 导入分类
            const categoryIdMap = {};
            const insertCategory = db.prepare(`INSERT INTO categories (name, icon, color, sort_order) VALUES (?, ?, ?, ?)`);
            for (const cat of categoryValidationCache) {
                const result = insertCategory.run(cat.data.name, cat.data.icon, cat.data.color, cat.sortOrder);
                categoryIdMap[cat.id] = result.lastInsertRowid;
            }

            // 导入站点
            const siteIdMap = {};
            const insertSite = db.prepare(`
                INSERT INTO sites (
                    name,
                    url,
                    description,
                    logo,
                    category_id,
                    sort_order,
                    click_count,
                    last_check_status,
                    last_check_http_status,
                    last_check_error,
                    last_check_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const site of siteValidationCache) {
                const newCategoryId = site.categoryId ? categoryIdMap[site.categoryId] : null;
                const result = insertSite.run(
                    site.data.name,
                    site.data.url,
                    site.data.description,
                    site.data.logo || '',
                    newCategoryId,
                    site.sortOrder,
                    site.clickCount,
                    site.status,
                    site.httpStatus,
                    site.lastCheckError,
                    site.lastCheckAt
                );
                siteIdMap[site.id] = result.lastInsertRowid;
            }

            // 导入标签
            const tagIdMap = {};
            const insertTag = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)');
            for (const tag of tagValidationCache) {
                const result = insertTag.run(tag.data.name, tag.data.color);
                tagIdMap[tag.id] = result.lastInsertRowid;
            }

            // 导入站点-标签关联
            const insertSiteTag = db.prepare('INSERT OR IGNORE INTO site_tags (site_id, tag_id) VALUES (?, ?)');
            for (const row of data.site_tags || []) {
                const newSiteId = siteIdMap[parsePositiveInteger(row.site_id)];
                const newTagId = tagIdMap[parsePositiveInteger(row.tag_id)];
                if (newSiteId && newTagId) {
                    insertSiteTag.run(newSiteId, newTagId);
                }
            }

            // 导入设置
            if (importValidation.settings.length > 0) {
                const insertSetting = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
                for (const setting of importValidation.settings) {
                    if (!setting || !setting.key || SENSITIVE_SETTING_KEYS.has(setting.key)) {
                        continue;
                    }
                    insertSetting.run(setting.key, setting.value ?? '');
                }
            }
        });

        importTransaction();

        res.json({
            success: true,
            message: `导入成功: ${data.categories.length} 个分类, ${data.sites.length} 个站点, ${(data.tags || []).length} 个标签`
        });
    } catch (error) {
        res.status(500).json({ success: false, message: '导入失败: ' + error.message });
    }
});

// 书签导入（需要认证）
router.post('/import/bookmarks', requireAuth, express.text({ type: 'text/html', limit: '5mb' }), (req, res) => {
    try {
        const html = req.body;

        if (!html || typeof html !== 'string') {
            return res.status(400).json({ success: false, message: '无效的书签文件' });
        }

        // 简单的 HTML 书签解析
        const bookmarks = [];
        const categories = new Map();

        // 逐行解析
        const lines = html.split('\n');
        const folderStack = ['未分类'];

        for (const line of lines) {
            // 检查文件夹开始
            const folderMatch = /<DT><H3[^>]*>([^<]+)<\/H3>/i.exec(line);
            if (folderMatch) {
                const folderName = folderMatch[1].trim().slice(0, 50);
                const validation = validateCategoryData({ name: folderName, icon: '📁', color: '#a78bfa' });
                if (!validation.valid) {
                    return res.status(400).json({ success: false, message: validation.error });
                }
                folderStack.push(folderName);
                if (!categories.has(folderName)) {
                    categories.set(folderName, validation.sanitized);
                }
                continue;
            }

            // 检查书签
            const bookmarkMatch = /<DT><A[^>]*HREF="([^"]+)"[^>]*>([^<]+)<\/A>/i.exec(line);
            if (bookmarkMatch) {
                const url = bookmarkMatch[1].trim();
                const name = bookmarkMatch[2].trim().slice(0, 100);

                // 跳过 javascript: 和空链接
                if (!url || url.toLowerCase().startsWith('javascript:')) continue;

                let hostname;
                try {
                    hostname = new URL(url).hostname;
                } catch {
                    continue;
                }

                const siteValidation = validateSiteData({
                    name,
                    url,
                    description: '',
                    logo: `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(hostname)}`
                });
                if (!siteValidation.valid) {
                    return res.status(400).json({ success: false, message: siteValidation.error });
                }

                bookmarks.push({
                    data: siteValidation.sanitized,
                    category: folderStack[folderStack.length - 1]
                });
                continue;
            }

            // 检查文件夹结束
            if (/<\/DL>/i.test(line) && folderStack.length > 1) {
                folderStack.pop();
            }
        }

        if (bookmarks.length === 0) {
            return res.status(400).json({ success: false, message: '未找到有效书签' });
        }
        if (categories.size > MAX_IMPORT_CATEGORIES || bookmarks.length > MAX_IMPORT_SITES) {
            return res.status(400).json({ success: false, message: '书签数量超过限制' });
        }

        // 导入到数据库
        const importBookmarksTransaction = db.transaction(() => {
            const categoryIdMap = {};
            const insertCategory = db.prepare('INSERT INTO categories (name, icon, color, sort_order) VALUES (?, ?, ?, ?)');
            const insertSite = db.prepare('INSERT INTO sites (name, url, description, logo, category_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)');

            let sortOrder = 0;
            for (const [name, cat] of categories) {
                const result = insertCategory.run(cat.name, cat.icon, cat.color, sortOrder++);
                categoryIdMap[name] = result.lastInsertRowid;
            }

            let siteOrder = 0;
            for (const bm of bookmarks) {
                const categoryId = categoryIdMap[bm.category] || null;
                insertSite.run(bm.data.name, bm.data.url, bm.data.description, bm.data.logo || '', categoryId, siteOrder++);
            }
        });

        importBookmarksTransaction();

        res.json({
            success: true,
            message: `导入成功: ${categories.size} 个分类, ${bookmarks.length} 个书签`,
            imported: { categories: categories.size, bookmarks: bookmarks.length }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: '导入失败: ' + error.message });
    }
});

module.exports = router;
