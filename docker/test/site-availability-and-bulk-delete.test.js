const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');

function clearServerRequireCache() {
    const serverDir = `${path.sep}docker${path.sep}server${path.sep}`;
    for (const modulePath of Object.keys(require.cache)) {
        if (modulePath.includes(serverDir)) {
            delete require.cache[modulePath];
        }
    }
}

function requestJson(port, { method, routePath, body, headers = {} }) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);

        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path: routePath,
                method,
                headers: {
                    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                    ...headers
                }
            },
            (res) => {
                let raw = '';
                res.on('data', (chunk) => {
                    raw += chunk;
                });
                res.on('end', () => {
                    let parsed = null;
                    try {
                        parsed = raw ? JSON.parse(raw) : null;
                    } catch (e) {}

                    resolve({
                        statusCode: res.statusCode,
                        body: parsed,
                        headers: res.headers
                    });
                });
            }
        );

        req.on('error', reject);
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

test('db init migrates legacy sites table with availability columns', { concurrency: false }, (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-dashboard-health-migrate-'));
    const isolatedDbPath = path.join(tempDir, 'nav.db');

    const legacyDb = new Database(isolatedDbPath);
    legacyDb.exec(`
        CREATE TABLE categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            icon TEXT,
            color TEXT DEFAULT '#ff9a56',
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE sites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            description TEXT,
            logo TEXT,
            category_id INTEGER,
            sort_order INTEGER DEFAULT 0,
            click_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
        );
        CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            color TEXT DEFAULT '#6366f1',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE site_tags (
            site_id INTEGER NOT NULL,
            tag_id INTEGER NOT NULL,
            PRIMARY KEY (site_id, tag_id)
        );
    `);
    legacyDb.close();

    const originalDbPath = process.env.NAV_DB_PATH;
    process.env.NAV_DB_PATH = isolatedDbPath;

    clearServerRequireCache();
    const db = require('../server/db');

    t.after(() => {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
        if (originalDbPath === undefined) {
            delete process.env.NAV_DB_PATH;
        } else {
            process.env.NAV_DB_PATH = originalDbPath;
        }
    });

    const columns = db.prepare('PRAGMA table_info(sites)').all();
    const columnNames = new Set(columns.map((item) => item.name));
    assert.equal(columnNames.has('last_check_status'), true);
    assert.equal(columnNames.has('last_check_http_status'), true);
    assert.equal(columnNames.has('last_check_error'), true);
    assert.equal(columnNames.has('last_check_at'), true);
});

test('manual site checks and failed-site bulk delete persist and protect data', { concurrency: false }, async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-dashboard-health-'));
    const isolatedDbPath = path.join(tempDir, 'nav.db');

    const originalDbPath = process.env.NAV_DB_PATH;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAdminPassword = process.env.ADMIN_PASSWORD;

    process.env.NAV_DB_PATH = isolatedDbPath;
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_PASSWORD = 'health-admin-pass';

    clearServerRequireCache();

    const db = require('../server/db');
    const { createApp } = require('../server/index');

    const availabilityServer = await new Promise((resolve) => {
        const instance = http.createServer((req, res) => {
            if (req.url === '/redirect') {
                res.statusCode = 302;
                res.setHeader('Location', '/ok');
                res.end();
                return;
            }
            if (req.url === '/ok') {
                res.statusCode = 200;
                res.end('ok');
                return;
            }
            res.statusCode = 404;
            res.end('missing');
        });
        instance.listen(0, '127.0.0.1', () => resolve(instance));
    });

    const app = createApp();
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    t.after(() => {
        server.close(() => {});
        availabilityServer.close(() => {});
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });

        if (originalDbPath === undefined) {
            delete process.env.NAV_DB_PATH;
        } else {
            process.env.NAV_DB_PATH = originalDbPath;
        }

        if (originalNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = originalNodeEnv;
        }

        if (originalAdminPassword === undefined) {
            delete process.env.ADMIN_PASSWORD;
        } else {
            process.env.ADMIN_PASSWORD = originalAdminPassword;
        }
    });

    const columns = db.prepare('PRAGMA table_info(sites)').all();
    const columnNames = new Set(columns.map((item) => item.name));
    assert.equal(columnNames.has('last_check_status'), true);
    assert.equal(columnNames.has('last_check_http_status'), true);
    assert.equal(columnNames.has('last_check_error'), true);
    assert.equal(columnNames.has('last_check_at'), true);

    const port = server.address().port;

    const noAuthCheck = await requestJson(port, {
        method: 'POST',
        routePath: '/api/sites/check-availability',
        body: { siteIds: [1] }
    });
    assert.equal(noAuthCheck.statusCode, 401);

    const noAuthBulkDelete = await requestJson(port, {
        method: 'POST',
        routePath: '/api/sites/bulk-delete',
        body: { siteIds: [1] }
    });
    assert.equal(noAuthBulkDelete.statusCode, 401);

    const login = await requestJson(port, {
        method: 'POST',
        routePath: '/api/auth/verify',
        body: { password: 'health-admin-pass' }
    });
    assert.equal(login.statusCode, 200);
    assert.equal(login.body?.success, true);
    const authHeaders = { Authorization: `Bearer ${login.body.token}` };

    db.prepare('DELETE FROM site_tags').run();
    db.prepare('DELETE FROM tags').run();
    db.prepare('DELETE FROM sites').run();
    db.prepare('DELETE FROM categories').run();

    const categoryId = db.prepare('INSERT INTO categories (name, icon, color, sort_order) VALUES (?, ?, ?, ?)')
        .run('健康检查', 'H', '#123456', 1)
        .lastInsertRowid;

    const availabilityPort = availabilityServer.address().port;
    const okSiteId = db.prepare('INSERT INTO sites (name, url, category_id, sort_order) VALUES (?, ?, ?, ?)')
        .run('ok-site', `http://127.0.0.1:${availabilityPort}/ok`, categoryId, 1)
        .lastInsertRowid;
    const redirectSiteId = db.prepare('INSERT INTO sites (name, url, category_id, sort_order) VALUES (?, ?, ?, ?)')
        .run('redirect-site', `http://127.0.0.1:${availabilityPort}/redirect`, categoryId, 2)
        .lastInsertRowid;
    const failedSiteId = db.prepare('INSERT INTO sites (name, url, category_id, sort_order) VALUES (?, ?, ?, ?)')
        .run('failed-site', 'http://127.0.0.1:1/not-running', categoryId, 3)
        .lastInsertRowid;

    const tagId = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run('health-tag', '#000000').lastInsertRowid;
    db.prepare('INSERT INTO site_tags (site_id, tag_id) VALUES (?, ?)').run(okSiteId, tagId);
    db.prepare('INSERT INTO site_tags (site_id, tag_id) VALUES (?, ?)').run(failedSiteId, tagId);

    const checkAvailability = await requestJson(port, {
        method: 'POST',
        routePath: '/api/sites/check-availability',
        body: { siteIds: [okSiteId, redirectSiteId, failedSiteId] },
        headers: authHeaders
    });
    assert.equal(checkAvailability.statusCode, 200);
    assert.equal(checkAvailability.body?.success, true);
    assert.equal(checkAvailability.body?.data?.requestedCount, 3);
    assert.equal(checkAvailability.body?.data?.checkedCount, 3);
    assert.equal(checkAvailability.body?.data?.failedCount, 1);
    assert.equal(checkAvailability.body?.data?.skippedCount, 0);

    const okSite = db.prepare('SELECT last_check_status, last_check_http_status, last_check_error, last_check_at FROM sites WHERE id = ?').get(okSiteId);
    assert.equal(okSite.last_check_status, 'success');
    assert.equal(okSite.last_check_http_status, 200);
    assert.equal(okSite.last_check_error, null);
    assert.equal(Boolean(okSite.last_check_at), true);

    const redirectSite = db.prepare('SELECT last_check_status, last_check_http_status FROM sites WHERE id = ?').get(redirectSiteId);
    assert.equal(redirectSite.last_check_status, 'success');
    assert.equal(redirectSite.last_check_http_status, 200);

    const failedSite = db.prepare('SELECT last_check_status, last_check_http_status, last_check_error, last_check_at FROM sites WHERE id = ?').get(failedSiteId);
    assert.equal(failedSite.last_check_status, 'failed');
    assert.equal(failedSite.last_check_http_status, null);
    assert.equal(typeof failedSite.last_check_error, 'string');
    assert.equal(Boolean(failedSite.last_check_at), true);

    const failedFilter = await requestJson(port, {
        method: 'GET',
        routePath: '/api/sites?lastCheckStatus=failed'
    });
    assert.equal(failedFilter.statusCode, 200);
    assert.equal(failedFilter.body?.success, true);
    assert.equal(failedFilter.body?.data.length, 1);
    assert.equal(failedFilter.body?.data[0]?.id, failedSiteId);

    const invalidFilter = await requestJson(port, {
        method: 'GET',
        routePath: '/api/sites?lastCheckStatus=unknown-status'
    });
    assert.equal(invalidFilter.statusCode, 400);

    const skippedCheck = await requestJson(port, {
        method: 'POST',
        routePath: '/api/sites/check-availability',
        body: { siteIds: [okSiteId, 999999] },
        headers: authHeaders
    });
    assert.equal(skippedCheck.statusCode, 200);
    assert.equal(skippedCheck.body?.data?.requestedCount, 2);
    assert.equal(skippedCheck.body?.data?.checkedCount, 1);
    assert.equal(skippedCheck.body?.data?.skippedCount, 1);
    assert.equal(skippedCheck.body?.data?.skippedSiteIds.includes(999999), true);

    const bulkDelete = await requestJson(port, {
        method: 'POST',
        routePath: '/api/sites/bulk-delete',
        body: { siteIds: [okSiteId, failedSiteId, 999999] },
        headers: authHeaders
    });
    assert.equal(bulkDelete.statusCode, 200);
    assert.equal(bulkDelete.body?.success, true);
    assert.equal(bulkDelete.body?.data?.deletedCount, 1);
    assert.equal(bulkDelete.body?.data?.deletedSiteIds.includes(failedSiteId), true);
    assert.equal(bulkDelete.body?.data?.skippedSiteIds.includes(okSiteId), true);

    const deletedFailedSite = db.prepare('SELECT id FROM sites WHERE id = ?').get(failedSiteId);
    assert.equal(deletedFailedSite, undefined);

    const keptOkSite = db.prepare('SELECT id FROM sites WHERE id = ?').get(okSiteId);
    assert.equal(Boolean(keptOkSite), true);

    const deletedSiteTag = db.prepare('SELECT site_id FROM site_tags WHERE site_id = ?').get(failedSiteId);
    assert.equal(deletedSiteTag, undefined);

    const keptSiteTag = db.prepare('SELECT site_id FROM site_tags WHERE site_id = ?').get(okSiteId);
    assert.equal(Boolean(keptSiteTag), true);

    const singleDeleteSiteId = db.prepare('INSERT INTO sites (name, url, category_id, sort_order, last_check_status) VALUES (?, ?, ?, ?, ?)')
        .run('single-delete-site', 'https://single-delete.example', categoryId, 99, 'failed')
        .lastInsertRowid;
    db.prepare('INSERT INTO site_tags (site_id, tag_id) VALUES (?, ?)').run(singleDeleteSiteId, tagId);

    const singleDeleteRes = await requestJson(port, {
        method: 'DELETE',
        routePath: `/api/sites/${singleDeleteSiteId}`,
        headers: authHeaders
    });
    assert.equal(singleDeleteRes.statusCode, 200);

    const singleDeletedSite = db.prepare('SELECT id FROM sites WHERE id = ?').get(singleDeleteSiteId);
    assert.equal(singleDeletedSite, undefined);

    const singleDeletedSiteTag = db.prepare('SELECT site_id FROM site_tags WHERE site_id = ?').get(singleDeleteSiteId);
    assert.equal(singleDeletedSiteTag, undefined);

    const exportRes = await requestJson(port, {
        method: 'GET',
        routePath: '/api/export',
        headers: authHeaders
    });
    assert.equal(exportRes.statusCode, 200);
    const exportedSite = exportRes.body?.sites?.find((site) => site.id === okSiteId);
    assert.equal(Boolean(exportedSite), true);
    assert.equal(Object.prototype.hasOwnProperty.call(exportedSite, 'last_check_status'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(exportedSite, 'last_check_http_status'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(exportedSite, 'last_check_error'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(exportedSite, 'last_check_at'), true);

    const importPayload = {
        categories: [
            { id: 10, name: '导入分类', icon: 'I', color: '#0f0f0f', sort_order: 1 }
        ],
        sites: [
            {
                id: 20,
                name: '导入失败站点',
                url: 'https://import.example',
                description: 'imported',
                logo: '',
                category_id: 10,
                sort_order: 1,
                click_count: 12,
                last_check_status: 'failed',
                last_check_http_status: 503,
                last_check_error: 'HTTP 503',
                last_check_at: '2025-01-01T00:00:00.000Z'
            }
        ],
        tags: [
            { id: 30, name: '导入标签', color: '#333333' }
        ],
        site_tags: [
            { site_id: 20, tag_id: 30 }
        ],
        settings: [
            { key: 'background_image', value: 'https://example.com/bg.jpg' }
        ]
    };

    const importRes = await requestJson(port, {
        method: 'POST',
        routePath: '/api/import',
        body: importPayload,
        headers: authHeaders
    });
    assert.equal(importRes.statusCode, 200);
    assert.equal(importRes.body?.success, true);

    const importedSite = db.prepare(`
        SELECT click_count, last_check_status, last_check_http_status, last_check_error, last_check_at
        FROM sites
        WHERE name = ?
    `).get('导入失败站点');

    assert.equal(importedSite.click_count, 12);
    assert.equal(importedSite.last_check_status, 'failed');
    assert.equal(importedSite.last_check_http_status, 503);
    assert.equal(importedSite.last_check_error, 'HTTP 503');
    assert.equal(importedSite.last_check_at, '2025-01-01T00:00:00.000Z');
});
