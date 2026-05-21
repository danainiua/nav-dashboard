const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function clearServerRequireCache() {
    const serverDir = `${path.sep}docker${path.sep}server${path.sep}`;
    for (const modulePath of Object.keys(require.cache)) {
        if (modulePath.includes(serverDir)) {
            delete require.cache[modulePath];
        }
    }
}

function parseResponse(res, resolve) {
    let raw = '';
    res.on('data', (chunk) => {
        raw += chunk;
    });
    res.on('end', () => {
        let parsed = null;
        try {
            parsed = raw ? JSON.parse(raw) : null;
        } catch (e) {}
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed, text: raw });
    });
}

function request(port, { method = 'GET', routePath, body, headers = {} }) {
    return new Promise((resolve, reject) => {
        const contentType = headers['Content-Type'] || headers['content-type'];
        const payload = body === undefined ? null : (typeof body === 'string' && contentType && !contentType.includes('application/json') ? body : JSON.stringify(body));
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
            (res) => parseResponse(res, resolve)
        );

        req.on('error', reject);
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

function uploadImage(port, { token, filename, contentType, content }) {
    return new Promise((resolve, reject) => {
        const boundary = `----nav-dashboard-${Date.now()}`;
        const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
            Buffer.isBuffer(content) ? content : Buffer.from(content),
            Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);

        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path: '/api/upload',
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': body.length
                }
            },
            (res) => parseResponse(res, resolve)
        );

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function withIsolatedServer(t, env, run) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-dashboard-security-'));
    const isolatedDbPath = path.join(tempDir, 'nav.db');
    const originalEnv = {};

    for (const key of ['NAV_DB_PATH', 'NODE_ENV', 'ADMIN_PASSWORD', 'CORS_ORIGINS', 'COOKIE_SECURE', 'TRUST_PROXY', 'ALLOWED_IMAGE_DOMAINS']) {
        originalEnv[key] = process.env[key];
    }

    process.env.NAV_DB_PATH = isolatedDbPath;
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_PASSWORD = 'security-admin-pass';
    for (const [key, value] of Object.entries(env || {})) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    clearServerRequireCache();
    const db = require('../server/db');
    const { createApp } = require('../server/index');
    const app = createApp();
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    t.after(() => {
        require('../server/backup').stopScheduledBackup();
        server.close(() => {});
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });

        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        clearServerRequireCache();
    });

    await run({ port: server.address().port, db });
}

test('CORS only allows configured origins', async (t) => {
    await withIsolatedServer(t, { CORS_ORIGINS: 'https://trusted.example' }, async ({ port }) => {
        const trusted = await request(port, {
            routePath: '/api/sites',
            headers: { Origin: 'https://trusted.example' }
        });
        assert.equal(trusted.statusCode, 200);
        assert.equal(trusted.headers['access-control-allow-origin'], 'https://trusted.example');
        assert.equal(trusted.headers['access-control-allow-credentials'], 'true');

        const blocked = await request(port, {
            routePath: '/api/sites',
            headers: { Origin: 'https://evil.example' }
        });
        assert.equal(blocked.statusCode, 200);
        assert.equal(blocked.headers['access-control-allow-origin'], undefined);
    });
});

test('auth cookie attributes and password changes invalidate old tokens', async (t) => {
    await withIsolatedServer(t, { COOKIE_SECURE: 'true' }, async ({ port }) => {
        const login = await request(port, {
            method: 'POST',
            routePath: '/api/auth/verify',
            body: { password: 'security-admin-pass' }
        });
        assert.equal(login.statusCode, 200);
        assert.equal(login.body?.success, true);
        assert.ok(login.body?.token);
        assert.match(login.headers['set-cookie']?.[0] || '', /HttpOnly/);
        assert.match(login.headers['set-cookie']?.[0] || '', /SameSite=Strict/);
        assert.match(login.headers['set-cookie']?.[0] || '', /Secure/);

        const authHeaders = { Authorization: `Bearer ${login.body.token}` };
        const updatePassword = await request(port, {
            method: 'PUT',
            routePath: '/api/settings/password',
            body: { old_password: 'security-admin-pass', new_password: 'new-security-pass' },
            headers: authHeaders
        });
        assert.equal(updatePassword.statusCode, 200);

        const oldTokenStatus = await request(port, {
            routePath: '/api/auth/status',
            headers: authHeaders
        });
        assert.equal(oldTokenStatus.statusCode, 200);
        assert.equal(oldTokenStatus.body?.authenticated, false);

        const newLogin = await request(port, {
            method: 'POST',
            routePath: '/api/auth/verify',
            body: { password: 'new-security-pass' }
        });
        assert.equal(newLogin.statusCode, 200);
        assert.equal(newLogin.body?.success, true);
    });
});

test('site updates preserve existing logo when logo input is empty', async (t) => {
    await withIsolatedServer(t, {}, async ({ port, db }) => {
        const login = await request(port, {
            method: 'POST',
            routePath: '/api/auth/verify',
            body: { password: 'security-admin-pass' }
        });
        const authHeaders = { Authorization: `Bearer ${login.body.token}` };

        const create = await request(port, {
            method: 'POST',
            routePath: '/api/sites',
            body: {
                name: 'Original title',
                url: 'https://example.com',
                description: '',
                logo: '/default-icon.png',
                category_id: null,
                sort_order: 0
            },
            headers: authHeaders
        });
        assert.equal(create.statusCode, 200);
        const siteId = create.body?.data?.id;
        assert.ok(siteId);

        const update = await request(port, {
            method: 'PUT',
            routePath: `/api/sites/${siteId}`,
            body: {
                name: 'Updated title',
                url: 'https://example.com',
                description: '',
                logo: '',
                category_id: null,
                sort_order: 0
            },
            headers: authHeaders
        });
        assert.equal(update.statusCode, 200);

        const saved = db.prepare('SELECT name, logo FROM sites WHERE id = ?').get(siteId);
        assert.equal(saved.name, 'Updated title');
        assert.equal(saved.logo, '/default-icon.png');
    });
});

function withImageServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

test('category and tag inputs are validated and sanitized', async (t) => {
    await withIsolatedServer(t, {}, async ({ port, db }) => {
        const login = await request(port, {
            method: 'POST',
            routePath: '/api/auth/verify',
            body: { password: 'security-admin-pass' }
        });
        const authHeaders = { Authorization: `Bearer ${login.body.token}` };

        const invalidCategoryColor = await request(port, {
            method: 'POST',
            routePath: '/api/categories',
            body: { name: 'bad-color', color: 'red' },
            headers: authHeaders
        });
        assert.equal(invalidCategoryColor.statusCode, 400);

        const xssCategory = await request(port, {
            method: 'POST',
            routePath: '/api/categories',
            body: { name: '<img src=x onerror=alert(1)>', icon: '<b>', color: '#123456' },
            headers: authHeaders
        });
        assert.equal(xssCategory.statusCode, 200);
        const storedCategory = db.prepare('SELECT name, icon, color FROM categories WHERE id = ?').get(xssCategory.body.data.id);
        assert.equal(storedCategory.name, '&lt;img src=x onerror=alert(1)&gt;');
        assert.equal(storedCategory.icon, '&lt;b&gt;');
        assert.equal(storedCategory.color, '#123456');

        const invalidTagColor = await request(port, {
            method: 'POST',
            routePath: '/api/tags',
            body: { name: 'bad-tag', color: 'blue' },
            headers: authHeaders
        });
        assert.equal(invalidTagColor.statusCode, 400);

        const xssTag = await request(port, {
            method: 'POST',
            routePath: '/api/tags',
            body: { name: '<script>alert(1)</script>', color: '#654321' },
            headers: authHeaders
        });
        assert.equal(xssTag.statusCode, 200);
        const storedTag = db.prepare('SELECT name, color FROM tags WHERE id = ?').get(xssTag.body.data.id);
        assert.equal(storedTag.name, '&lt;script&gt;alert(1)&lt;/script&gt;');
        assert.equal(storedTag.color, '#654321');

        const firstSite = db.prepare('SELECT id FROM sites ORDER BY id ASC LIMIT 1').get();
        const invalidTagIds = await request(port, {
            method: 'PUT',
            routePath: `/api/tags/site/${firstSite.id}`,
            body: { tag_ids: [xssTag.body.data.id, 'not-a-number'] },
            headers: authHeaders
        });
        assert.equal(invalidTagIds.statusCode, 400);

        const validTagIds = await request(port, {
            method: 'PUT',
            routePath: `/api/tags/site/${firstSite.id}`,
            body: { tag_ids: [xssTag.body.data.id, String(xssTag.body.data.id)] },
            headers: authHeaders
        });
        assert.equal(validTagIds.statusCode, 200);
        const relationCount = db.prepare('SELECT COUNT(*) as count FROM site_tags WHERE site_id = ? AND tag_id = ?').get(firstSite.id, xssTag.body.data.id).count;
        assert.equal(relationCount, 1);

        const invalidFilter = await request(port, {
            routePath: '/api/tags/filter?tag_ids=1,abc'
        });
        assert.equal(invalidFilter.statusCode, 400);
    });
});

test('data import validates payloads and preserves sensitive settings on failure', async (t) => {
    await withIsolatedServer(t, {}, async ({ port, db }) => {
        const login = await request(port, {
            method: 'POST',
            routePath: '/api/auth/verify',
            body: { password: 'security-admin-pass' }
        });
        const authHeaders = { Authorization: `Bearer ${login.body.token}` };
        const initialCategoryCount = db.prepare('SELECT COUNT(*) as count FROM categories').get().count;
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('webdav_password', 'keep-secret');

        const invalidImport = await request(port, {
            method: 'POST',
            routePath: '/api/import',
            body: {
                categories: [{ id: 1, name: '<img src=x onerror=alert(1)>', icon: 'x', color: '#123456', sort_order: 0 }],
                sites: [{ id: 1, name: 'bad-site', url: 'javascript:alert(1)', category_id: 1 }],
                settings: [{ key: 'webdav_password', value: 'overwrite' }]
            },
            headers: authHeaders
        });
        assert.equal(invalidImport.statusCode, 400);
        assert.equal(db.prepare('SELECT COUNT(*) as count FROM categories').get().count, initialCategoryCount);
        assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('webdav_password')?.value, 'keep-secret');

        const validImport = await request(port, {
            method: 'POST',
            routePath: '/api/import',
            body: {
                categories: [{ id: 1, name: '<b>导入分类</b>', icon: 'x', color: '#123456', sort_order: 0 }],
                sites: [{ id: 1, name: '<script>导入站点</script>', url: 'https://example.com', description: '<img src=x>', logo: '/default-icon.png', category_id: 1, sort_order: 0 }],
                tags: [{ id: 1, name: '<i>导入标签</i>', color: '#654321' }],
                site_tags: [{ site_id: 1, tag_id: 1 }],
                settings: [{ key: 'webdav_password', value: 'overwrite' }, { key: 'background_image', value: 'https://example.com/bg.jpg' }]
            },
            headers: authHeaders
        });
        assert.equal(validImport.statusCode, 200);
        assert.equal(db.prepare('SELECT name FROM categories LIMIT 1').get().name, '&lt;b&gt;导入分类&lt;/b&gt;');
        assert.equal(db.prepare('SELECT name, description FROM sites LIMIT 1').get().name, '&lt;script&gt;导入站点&lt;/script&gt;');
        assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('webdav_password')?.value, 'keep-secret');
        assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('background_image')?.value, 'https://example.com/bg.jpg');
    });
});

test('bookmark import validates folder names and bookmark urls', async (t) => {
    await withIsolatedServer(t, {}, async ({ port, db }) => {
        const login = await request(port, {
            method: 'POST',
            routePath: '/api/auth/verify',
            body: { password: 'security-admin-pass' }
        });
        const authHeaders = { Authorization: `Bearer ${login.body.token}` };
        const initialSiteCount = db.prepare('SELECT COUNT(*) as count FROM sites').get().count;

        const invalidBookmarks = await request(port, {
            method: 'POST',
            routePath: '/api/import/bookmarks',
            body: '<DL><DT><A HREF="javascript:alert(1)">bad</A></DL>',
            headers: { ...authHeaders, 'Content-Type': 'text/html' }
        });
        assert.equal(invalidBookmarks.statusCode, 400);
        assert.equal(db.prepare('SELECT COUNT(*) as count FROM sites').get().count, initialSiteCount);

        const validBookmarks = await request(port, {
            method: 'POST',
            routePath: '/api/import/bookmarks',
            body: '<DL>\n<DT><H3>Dev Tools</H3>\n<DT><A HREF="https://example.com">Example Site</A>\n</DL>',
            headers: { ...authHeaders, 'Content-Type': 'text/html' }
        });
        assert.equal(validBookmarks.statusCode, 200);
        assert.equal(db.prepare('SELECT name FROM sites WHERE url = ?').get('https://example.com').name, 'Example Site');
        assert.equal(db.prepare('SELECT name FROM categories WHERE name = ?').get('Dev Tools').name, 'Dev Tools');
    });
});

test('backup restore rejects unsafe filenames before WebDAV access', async (t) => {
    await withIsolatedServer(t, {}, async ({ port }) => {
        const login = await request(port, {
            method: 'POST',
            routePath: '/api/auth/verify',
            body: { password: 'security-admin-pass' }
        });
        const unsafeRestore = await request(port, {
            method: 'POST',
            routePath: '/api/backup/restore',
            body: { filename: '../nav-dashboard-backup-20260101.json' },
            headers: { Authorization: `Bearer ${login.body.token}` }
        });
        assert.equal(unsafeRestore.statusCode, 400);
        assert.equal(unsafeRestore.body?.success, false);
    });
});

test('backup restore validates content and rolls back invalid backups', async (t) => {
    await withIsolatedServer(t, {}, async ({ db }) => {
        const backup = require('../server/backup');
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('webdav_url', 'https://dav.example.com');
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('webdav_username', 'dav-user');
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('webdav_password', 'dav-pass');
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('admin_password', 'keep-admin');
        const initialCategoryCount = db.prepare('SELECT COUNT(*) as count FROM categories').get().count;

        const restoreFactory = backup.setWebDAVClientFactoryForTest(() => ({
            getFileContents: async () => JSON.stringify({
                categories: [{ id: 1, name: '恢复分类', color: '#123456' }],
                sites: [{ id: 1, name: 'bad-restore', url: 'javascript:alert(1)', category_id: 1 }]
            })
        }));
        t.after(() => restoreFactory());

        await assert.rejects(
            () => backup.restoreBackup(db, 'nav-dashboard-backup-20260101.json'),
            /URL格式无效/
        );
        assert.equal(db.prepare('SELECT COUNT(*) as count FROM categories').get().count, initialCategoryCount);
        assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password')?.value, 'keep-admin');

        restoreFactory();
        const restoreValidFactory = backup.setWebDAVClientFactoryForTest(() => ({
            getFileContents: async () => JSON.stringify({
                categories: [{ id: 10, name: '<b>恢复分类</b>', color: '#123456', sort_order: 0 }],
                sites: [{ id: 20, name: '<script>恢复站点</script>', url: 'https://example.com', description: '<img src=x>', logo: '/default-icon.png', category_id: 10, sort_order: 0 }],
                tags: [{ id: 30, name: '<i>恢复标签</i>', color: '#654321' }],
                site_tags: [{ site_id: 20, tag_id: 30 }],
                settings: [{ key: 'admin_password', value: 'overwrite' }, { key: 'background_image', value: 'https://example.com/bg.jpg' }]
            })
        }));
        t.after(() => restoreValidFactory());

        const restored = await backup.restoreBackup(db, 'nav-dashboard-backup-20260101.json');
        assert.equal(restored.success, true);
        assert.equal(db.prepare('SELECT name FROM categories WHERE id = 10').get().name, '&lt;b&gt;恢复分类&lt;/b&gt;');
        assert.equal(db.prepare('SELECT name FROM sites WHERE id = 20').get().name, '&lt;script&gt;恢复站点&lt;/script&gt;');
        assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password')?.value, 'keep-admin');
        assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('background_image')?.value, 'https://example.com/bg.jpg');
    });
});

test('image upload rejects SVG and derives extension from MIME type', async (t) => {
    await withIsolatedServer(t, {}, async ({ port }) => {
        const login = await request(port, {
            method: 'POST',
            routePath: '/api/auth/verify',
            body: { password: 'security-admin-pass' }
        });

        const svgUpload = await uploadImage(port, {
            token: login.body.token,
            filename: 'logo.png',
            contentType: 'image/svg+xml',
            content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
        });
        assert.equal(svgUpload.statusCode, 400);
        assert.equal(svgUpload.body?.success, false);

        const pngUpload = await uploadImage(port, {
            token: login.body.token,
            filename: 'logo.svg',
            contentType: 'image/png',
            content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        });
        assert.equal(pngUpload.statusCode, 200);
        assert.equal(pngUpload.body?.success, true);
        assert.match(pngUpload.body?.data?.url || '', /\.png$/);
    });
});

test('image proxy blocks internal addresses', async (t) => {
    await withIsolatedServer(t, { ALLOWED_IMAGE_DOMAINS: '127.0.0.1,localhost' }, async ({ port }) => {
        const invalidProtocol = await request(port, {
            routePath: '/api/proxy/image?url=file%3A%2F%2F%2Fetc%2Fpasswd'
        });
        assert.equal(invalidProtocol.statusCode, 400);

        const localhost = await request(port, {
            routePath: '/api/proxy/image?url=http%3A%2F%2Flocalhost%2Ffavicon.ico'
        });
        assert.equal(localhost.statusCode, 403);
        assert.equal(localhost.body?.error, 'Internal addresses are not allowed');

        const metadata = await request(port, {
            routePath: '/api/proxy/image?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F'
        });
        assert.equal(metadata.statusCode, 403);
    });
});

test('remote image helper enforces redirects, MIME type and response size', async (t) => {
    const dns = require('dns').promises;
    const originalAllowedDomains = process.env.ALLOWED_IMAGE_DOMAINS;
    const originalLookup = dns.lookup;
    const originalFetch = global.fetch;

    process.env.ALLOWED_IMAGE_DOMAINS = 'example.test,localhost,127.0.0.1';
    dns.lookup = async (hostname) => {
        if (hostname === 'example.test') {
            return [{ address: '93.184.216.34', family: 4 }];
        }
        if (hostname === 'localhost') {
            return [{ address: '127.0.0.1', family: 4 }];
        }
        return originalLookup(hostname, { all: true, verbatim: false });
    };

    clearServerRequireCache();
    const { fetchRemoteImage } = require('../server/utils/remoteImage');
    const { validateRemoteImageUrl } = require('../server/utils/validator');

    t.after(() => {
        if (originalAllowedDomains === undefined) {
            delete process.env.ALLOWED_IMAGE_DOMAINS;
        } else {
            process.env.ALLOWED_IMAGE_DOMAINS = originalAllowedDomains;
        }
        dns.lookup = originalLookup;
        global.fetch = originalFetch;
        clearServerRequireCache();
    });

    const blockedPrivate = await validateRemoteImageUrl('http://127.0.0.1/image.png');
    assert.equal(blockedPrivate.valid, false);
    assert.equal(blockedPrivate.status, 403);

    global.fetch = async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
        status: 200,
        headers: { 'Content-Type': 'image/svg+xml' }
    });
    const svg = await fetchRemoteImage('https://example.test/logo.svg');
    assert.equal(svg.success, false);
    assert.equal(svg.status, 400);

    global.fetch = async () => new Response(Buffer.alloc(6), {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Content-Length': '6' }
    });
    const contentLengthTooLarge = await fetchRemoteImage('https://example.test/logo.png', { maxBytes: 5 });
    assert.equal(contentLengthTooLarge.success, false);
    assert.equal(contentLengthTooLarge.status, 413);

    global.fetch = async () => new Response(Buffer.alloc(6), {
        status: 200,
        headers: { 'Content-Type': 'image/png' }
    });
    const streamedTooLarge = await fetchRemoteImage('https://example.test/logo.png', { maxBytes: 5 });
    assert.equal(streamedTooLarge.success, false);
    assert.equal(streamedTooLarge.status, 413);

    global.fetch = async () => new Response(null, {
        status: 302,
        headers: { Location: 'http://localhost/private.png' }
    });
    const unsafeRedirect = await fetchRemoteImage('https://example.test/logo.png');
    assert.equal(unsafeRedirect.success, false);
    assert.equal(unsafeRedirect.status, 403);
});
