const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('frontend rendering escapes user-controlled admin table data', () => {
    const adminJs = read('public/js/admin.js');

    assert.match(adminJs, /function safeImageSrc/);
    assert.match(adminJs, /function safeHttpUrl/);
    assert.match(adminJs, /function safeCssColor/);
    assert.doesNotMatch(adminJs, /alt="\$\{site\.name\}"/);
    assert.doesNotMatch(adminJs, /<td>\$\{site\.category_name \|\| '-'}<\/td>/);
    assert.doesNotMatch(adminJs, /preview\.innerHTML = `<img src="\$\{url\}"/);
    assert.doesNotMatch(adminJs, /toast\.innerHTML = `\$\{icon\} \$\{message\}`/);
});

test('homepage rendering escapes site, tag and search suggestion data', () => {
    const uiJs = read('public/js/modules/ui.js');
    const searchJs = read('public/js/modules/search.js');
    const quickAddJs = read('public/js/modules/quickAdd.js');

    assert.match(uiJs, /function safeImageSrc/);
    assert.match(uiJs, /\$\{escapeHtml\(site\.name\)\}/);
    assert.match(uiJs, /\$\{escapeHtml\(tag\.name\)\}/);
    assert.match(searchJs, /\$\{escapeHtml\(site\.name\)\}/);
    assert.match(searchJs, /\$\{escapeAttr\(safeHttpUrl\(site\.url\)\)\}/);
    assert.doesNotMatch(searchJs, /href="\$\{site\.url\}"/);
    assert.doesNotMatch(quickAddJs, /quickAddLogoPreview\.innerHTML = `<img src="\$\{url\}"/);
});

test('backup list rendering validates filenames and avoids inline restore handlers', () => {
    const backupJs = read('public/js/backup.js');

    assert.match(backupJs, /function safeBackupFilename/);
    assert.match(backupJs, /data-backup-filename="\$\{escapeAttr\(filename\)\}"/);
    assert.doesNotMatch(backupJs, /onclick="restoreBackup\('\$\{backup\.filename\}'\)"/);
    assert.doesNotMatch(backupJs, /<strong>\$\{backup\.filename\}<\/strong>/);
});
