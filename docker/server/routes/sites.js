/**
 * 站点路由模块
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { cacheRemoteImage, tryDownloadImage, uploadsDir } = require('../utils/imageCache');
const { checkSiteAvailability } = require('../utils/siteAvailability');
const { validateSiteData } = require('../utils/validator');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');
const path = require('path');
const fs = require('fs');

const ALLOWED_LAST_CHECK_STATUS = new Set(['unchecked', 'success', 'failed']);
const MAX_SITE_CHECK_BATCH = 100;
const SITE_CHECK_CONCURRENCY = 5;

function parseSiteIds(input) {
    if (!Array.isArray(input)) {
        return null;
    }

    const ids = input
        .map((id) => parseInt(id, 10))
        .filter((id) => Number.isInteger(id) && id > 0);

    return Array.from(new Set(ids));
}

const deleteSitesWithTags = db.transaction((siteIds) => {
    const deleteSiteTagsStmt = db.prepare('DELETE FROM site_tags WHERE site_id = ?');
    const deleteSiteStmt = db.prepare('DELETE FROM sites WHERE id = ?');

    let deletedSites = 0;
    for (const siteId of siteIds) {
        deleteSiteTagsStmt.run(siteId);
        const result = deleteSiteStmt.run(siteId);
        deletedSites += result.changes;
    }

    return deletedSites;
});

async function runWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let currentIndex = 0;

    async function next() {
        while (currentIndex < items.length) {
            const index = currentIndex++;
            results[index] = await worker(items[index], index);
        }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => next());
    await Promise.all(workers);
    return results;
}

// 获取站点列表
router.get('/', (req, res) => {
    const { category, search, lastCheckStatus, page = 1, pageSize = 24 } = req.query;

    // 参数验证
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSizeNum = Math.min(100, Math.max(1, parseInt(pageSize) || 24));
    const offset = (pageNum - 1) * pageSizeNum;

    const whereParts = [];
    const params = [];

    if (search) {
        // 限制搜索词长度
        const searchTerm = String(search).slice(0, 100);
        whereParts.push(`(s.name LIKE ? OR s.description LIKE ? OR s.url LIKE ?)`);
        const term = `%${searchTerm}%`;
        params.push(term, term, term);
    }

    if (category && category !== 'all') {
        whereParts.push('s.category_id = ?');
        params.push(category);
    }

    if (lastCheckStatus && lastCheckStatus !== 'all') {
        const normalizedStatus = String(lastCheckStatus).toLowerCase();
        if (!ALLOWED_LAST_CHECK_STATUS.has(normalizedStatus)) {
            return res.status(400).json({ success: false, message: '无效的状态筛选值' });
        }
        whereParts.push('s.last_check_status = ?');
        params.push(normalizedStatus);
    }

    const whereClause = whereParts.length > 0
        ? `WHERE ${whereParts.join(' AND ')}`
        : '';

    const countStmt = db.prepare(`SELECT COUNT(*) as total FROM sites s ${whereClause}`);
    const total = countStmt.get(...params)?.total || 0;

    const dataStmt = db.prepare(`
        SELECT s.*, c.name as category_name, c.color as category_color
        FROM sites s
        LEFT JOIN categories c ON s.category_id = c.id
        ${whereClause}
        ORDER BY s.click_count DESC, s.sort_order ASC, s.created_at DESC
        LIMIT ? OFFSET ?
    `);
    const results = dataStmt.all(...params, pageSizeNum, offset);

    // 获取所有站点的标签（批量查询优化）
    if (results.length > 0) {
        try {
            const siteIds = results.map(s => s.id);
            const placeholders = siteIds.map(() => '?').join(',');
            const tagsStmt = db.prepare(`
                SELECT st.site_id, t.id, t.name, t.color
                FROM site_tags st
                INNER JOIN tags t ON st.tag_id = t.id
                WHERE st.site_id IN (${placeholders})
            `);
            const tagResults = tagsStmt.all(...siteIds);

            // 将标签按站点分组
            const tagsBySite = {};
            for (const tag of tagResults) {
                if (!tagsBySite[tag.site_id]) {
                    tagsBySite[tag.site_id] = [];
                }
                tagsBySite[tag.site_id].push({
                    id: tag.id,
                    name: tag.name,
                    color: tag.color
                });
            }

            // 将标签添加到站点数据中
            for (const site of results) {
                site.tags = tagsBySite[site.id] || [];
            }
        } catch (e) {
            // 标签表可能不存在，忽略错误
            for (const site of results) {
                site.tags = [];
            }
        }
    }

    res.json({
        success: true,
        data: results,
        pagination: { page: pageNum, pageSize: pageSizeNum, total, hasMore: offset + results.length < total }
    });
});

// 创建站点（需要认证）
router.post('/', requireAuth, asyncHandler(async (req, res) => {
    const { category_id, sort_order } = req.body;

    // 输入验证
    const validation = validateSiteData(req.body);
    if (!validation.valid) {
        return res.status(400).json({ success: false, message: validation.error });
    }

    const { name, url, description } = validation.sanitized;
    let siteLogo = validation.sanitized.logo;

    // 自动获取 favicon
    if (!siteLogo) {
        try {
            const domain = new URL(url).hostname;
            siteLogo = `https://www.google.com/s2/favicons?sz=128&domain=${domain}`;
        } catch (e) {
            siteLogo = '';
        }
    }

    const stmt = db.prepare(`INSERT INTO sites (name, url, description, logo, category_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)`);
    const result = stmt.run(name, url, description, siteLogo, category_id || null, sort_order || 0);
    res.json({ success: true, message: '站点创建成功', data: { id: result.lastInsertRowid } });
}));

// 更新站点（需要认证）
router.put('/:id', requireAuth, asyncHandler(async (req, res) => {
    const { category_id, sort_order } = req.body;
    const siteId = parseInt(req.params.id);

    if (isNaN(siteId)) {
        return res.status(400).json({ success: false, message: '无效的站点ID' });
    }

    // 输入验证
    const validation = validateSiteData(req.body);
    if (!validation.valid) {
        return res.status(400).json({ success: false, message: validation.error });
    }

    const { name, url, description } = validation.sanitized;
    let siteLogo = validation.sanitized.logo;

    if (!siteLogo) {
        try {
            const domain = new URL(url).hostname;
            siteLogo = `https://www.google.com/s2/favicons?sz=128&domain=${domain}`;
        } catch (e) {
            siteLogo = '';
        }
    }

    const stmt = db.prepare(`UPDATE sites SET name=?, url=?, description=?, logo=?, category_id=?, sort_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`);
    const result = stmt.run(name, url, description, siteLogo, category_id || null, sort_order || 0, siteId);

    if (result.changes === 0) {
        return res.status(404).json({ success: false, message: '站点不存在' });
    }
    res.json({ success: true, message: '站点更新成功' });
}));

// 删除站点（需要认证）
router.delete('/:id', requireAuth, (req, res) => {
    const siteId = parseInt(req.params.id);
    if (isNaN(siteId)) {
        return res.status(400).json({ success: false, message: '无效的站点ID' });
    }

    const existing = db.prepare('SELECT id FROM sites WHERE id = ?').get(siteId);
    if (!existing) {
        return res.status(404).json({ success: false, message: '站点不存在' });
    }

    deleteSitesWithTags([siteId]);
    res.json({ success: true, message: '站点删除成功' });
});

// 手动检查站点可用性（需要认证）
router.post('/check-availability', requireAuth, asyncHandler(async (req, res) => {
    const siteIds = parseSiteIds(req.body?.siteIds);
    if (!siteIds || siteIds.length === 0) {
        return res.status(400).json({ success: false, message: 'siteIds 必须是非空数组' });
    }

    if (siteIds.length > MAX_SITE_CHECK_BATCH) {
        return res.status(400).json({ success: false, message: `单次最多检查 ${MAX_SITE_CHECK_BATCH} 个站点` });
    }

    const placeholders = siteIds.map(() => '?').join(',');
    const sites = db.prepare(`SELECT id, name, url FROM sites WHERE id IN (${placeholders})`).all(...siteIds);
    if (sites.length === 0) {
        return res.status(404).json({ success: false, message: '未找到可检查的站点' });
    }

    const foundSiteIds = new Set(sites.map((site) => site.id));
    const skippedSiteIds = siteIds.filter((siteId) => !foundSiteIds.has(siteId));

    const updateStmt = db.prepare(`
        UPDATE sites
        SET last_check_status = ?,
            last_check_http_status = ?,
            last_check_error = ?,
            last_check_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `);

    const checkResults = await runWithConcurrency(sites, SITE_CHECK_CONCURRENCY, async (site) => {
        const checkResult = await checkSiteAvailability(site.url, { timeoutMs: 8000 });
        updateStmt.run(
            checkResult.status,
            checkResult.httpStatus,
            checkResult.error,
            site.id
        );

        return {
            siteId: site.id,
            name: site.name,
            status: checkResult.status,
            httpStatus: checkResult.httpStatus,
            error: checkResult.error,
            responseTimeMs: checkResult.responseTimeMs,
            finalUrl: checkResult.finalUrl
        };
    });

    const successCount = checkResults.filter((item) => item.status === 'success').length;
    const failedCount = checkResults.length - successCount;

    res.json({
        success: true,
        message: `检查完成: 成功 ${successCount} 个, 失败 ${failedCount} 个`,
        data: {
            requestedCount: siteIds.length,
            checkedCount: checkResults.length,
            successCount,
            failedCount,
            skippedCount: skippedSiteIds.length,
            skippedSiteIds,
            results: checkResults
        }
    });
}));

// 批量删除失败站点（需要认证）
router.post('/bulk-delete', requireAuth, (req, res) => {
    const siteIds = parseSiteIds(req.body?.siteIds);
    if (!siteIds || siteIds.length === 0) {
        return res.status(400).json({ success: false, message: 'siteIds 必须是非空数组' });
    }

    const placeholders = siteIds.map(() => '?').join(',');
    const failedSites = db.prepare(`
        SELECT id
        FROM sites
        WHERE id IN (${placeholders}) AND last_check_status = 'failed'
    `).all(...siteIds);

    const failedSiteIds = failedSites.map((item) => item.id);
    const deletedCount = failedSiteIds.length > 0 ? deleteSitesWithTags(failedSiteIds) : 0;

    const failedIdSet = new Set(failedSiteIds);
    const skippedSiteIds = siteIds.filter((id) => !failedIdSet.has(id));

    res.json({
        success: true,
        message: `批量删除完成: 删除 ${deletedCount} 个失败站点`,
        data: {
            requestedCount: siteIds.length,
            deletedCount,
            deletedSiteIds: failedSiteIds,
            skippedCount: skippedSiteIds.length,
            skippedSiteIds
        }
    });
});

// 记录站点点击（无需认证）
router.post('/:id/click', (req, res) => {
    const siteId = parseInt(req.params.id);
    if (isNaN(siteId)) {
        return res.status(400).json({ success: false, message: '无效的站点ID' });
    }

    const result = db.prepare('UPDATE sites SET click_count = click_count + 1 WHERE id = ?').run(siteId);
    if (result.changes === 0) {
        return res.status(404).json({ success: false, message: '站点不存在' });
    }
    res.json({ success: true });
});

// 站点排序（需要认证）
router.post('/reorder', requireAuth, (req, res) => {
    const { order } = req.body;

    if (!order || !Array.isArray(order)) {
        return res.status(400).json({ success: false, message: '无效的排序数据' });
    }

    // 验证排序数据
    if (order.length > 1000) {
        return res.status(400).json({ success: false, message: '排序数据过多' });
    }

    for (const item of order) {
        if (typeof item.id !== 'number' || typeof item.sort_order !== 'number') {
            return res.status(400).json({ success: false, message: '排序数据格式错误' });
        }
    }

    const stmt = db.prepare('UPDATE sites SET sort_order = ? WHERE id = ?');
    const updateMany = db.transaction((items) => {
        for (const item of items) {
            stmt.run(item.sort_order, item.id);
        }
    });
    updateMany(order);
    res.json({ success: true, message: '排序更新成功' });
});

// 恢复为网络图标（需要认证）
router.post('/restore-remote-logos', requireAuth, asyncHandler(async (req, res) => {
    const sites = db.prepare(`SELECT id, name, url FROM sites`).all();
    let updated = 0;
    let failed = 0;
    const updateStmt = db.prepare('UPDATE sites SET logo = ? WHERE id = ?');

    for (const site of sites) {
        try {
            const domain = new URL(site.url).hostname;
            const newLogo = `https://www.google.com/s2/favicons?sz=128&domain=${domain}`;
            updateStmt.run(newLogo, site.id);
            updated++;
        } catch (e) {
            console.error(`重置图标失败 [${site.name}]:`, e.message);
            failed++;
        }
    }

    res.json({
        success: true,
        message: `图标重置完成: ${updated} 个已恢复为网络图标`,
        updated,
        failed,
        total: sites.length
    });
}));

// 批量缓存站点图标（需要认证）
router.post('/cache-logos', requireAuth, asyncHandler(async (req, res) => {
    const sites = db.prepare(`SELECT id, name, url, logo FROM sites WHERE logo IS NOT NULL AND logo != ''`).all();

    let cached = 0;
    let failed = 0;
    let fixed = 0;
    const updateStmt = db.prepare('UPDATE sites SET logo = ? WHERE id = ?');

    for (const site of sites) {
        let newLogo = site.logo;
        let needsUpdate = false;

        // 情况1: 已经是本地路径，检查文件是否存在
        if (site.logo && site.logo.startsWith('/api/images/')) {
            const filename = site.logo.replace('/api/images/', '');
            const filePath = path.join(uploadsDir, filename);

            if (!fs.existsSync(filePath)) {
                console.log(`发现丢失的图标: ${site.name} (${site.logo})，尝试重新获取...`);
                try {
                    const domain = new URL(site.url).hostname;
                    const fallbackUrl = `https://www.google.com/s2/favicons?sz=128&domain=${domain}`;
                    const result = await tryDownloadImage(fallbackUrl);
                    if (result) {
                        newLogo = result;
                        needsUpdate = true;
                        fixed++;
                    } else {
                        failed++;
                    }
                } catch (e) {
                    console.error(`修复图标失败 [${site.name}]:`, e.message);
                    failed++;
                }
            }
        }
        // 情况2: 远程 URL，尝试缓存
        else if (site.logo && !site.logo.startsWith('/api/images/')) {
            const result = await cacheRemoteImage(site.logo);
            if (result && result !== site.logo) {
                newLogo = result;
                needsUpdate = true;
                cached++;
            } else if (!result) {
                failed++;
            }
        }

        if (needsUpdate) {
            updateStmt.run(newLogo, site.id);
        }
    }

    res.json({
        success: true,
        message: `图标处理完成: 缓存 ${cached} 个, 修复 ${fixed} 个, 失败 ${failed} 个`,
        cached,
        fixed,
        failed,
        total: sites.length
    });
}));

module.exports = router;
