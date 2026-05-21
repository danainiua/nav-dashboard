/**
 * WebDAV 备份管理模块
 * 与 admin.js 配合使用
 */

const API_BASE_BACKUP = '';

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
}

function escapeAttr(value) {
    return escapeHtml(value);
}

function safeBackupFilename(filename) {
    const value = String(filename || '');
    return /^nav-dashboard-backup-\d{8}\.json$/.test(value) ? value : '';
}

// 初始化备份面板
function initBackupPanel() {
    loadBackupConfig();

    // 绑定事件
    document.getElementById('testConnectionBtn')?.addEventListener('click', testConnection);
    document.getElementById('saveBackupConfigBtn')?.addEventListener('click', saveBackupConfig);
    document.getElementById('backupNowBtn')?.addEventListener('click', backupNow);
    document.getElementById('refreshBackupsBtn')?.addEventListener('click', loadBackupList);
}

// 加载备份配置
async function loadBackupConfig() {
    try {
        const response = await fetch(`${API_BASE_BACKUP}/api/backup/config`);
        const data = await response.json();

        if (data.success) {
            const config = data.data;
            document.getElementById('webdavUrl').value = config.webdav_url || '';
            document.getElementById('webdavUsername').value = config.webdav_username || '';
            document.getElementById('webdavPassword').value = '';  // 不显示密码
            document.getElementById('backupFrequency').value = config.backup_frequency || 'off';

            // 显示上次备份状态
            const statusEl = document.getElementById('lastBackupStatus');
            if (statusEl && config.last_backup_time) {
                statusEl.innerHTML = `
                    <strong>上次备份:</strong> ${escapeHtml(new Date(config.last_backup_time).toLocaleString())}<br>
                    <strong>状态:</strong> ${escapeHtml(config.last_backup_status || '未知')}
                `;
            }
        }
    } catch (error) {
        console.error('加载备份配置失败:', error);
    }
}

// 测试连接
async function testConnection() {
    const btn = document.getElementById('testConnectionBtn');
    const url = document.getElementById('webdavUrl').value;
    const username = document.getElementById('webdavUsername').value;
    const password = document.getElementById('webdavPassword').value;

    if (!url || !username || !password) {
        showBackupMsg('请填写完整的 WebDAV 配置', 'error');
        return;
    }

    btn.disabled = true;
    btn.textContent = '测试中...';

    try {
        const response = await fetch(`${API_BASE_BACKUP}/api/backup/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ webdav_url: url, webdav_username: username, webdav_password: password })
        });
        const data = await response.json();

        if (data.success) {
            showBackupMsg('✓ 连接成功！', 'success');
        } else {
            showBackupMsg('✗ 连接失败: ' + (data.error || '未知错误'), 'error');
        }
    } catch (error) {
        showBackupMsg('✗ 请求失败: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '🔗 测试连接';
    }
}

// 保存配置
async function saveBackupConfig() {
    const btn = document.getElementById('saveBackupConfigBtn');
    const url = document.getElementById('webdavUrl').value;
    const username = document.getElementById('webdavUsername').value;
    const password = document.getElementById('webdavPassword').value;
    const frequency = document.getElementById('backupFrequency').value;

    if (!url || !username) {
        showBackupMsg('请填写 WebDAV 地址和用户名', 'error');
        return;
    }

    btn.disabled = true;

    try {
        const response = await fetch(`${API_BASE_BACKUP}/api/backup/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                webdav_url: url,
                webdav_username: username,
                webdav_password: password || undefined,  // 不发送空密码
                backup_frequency: frequency
            })
        });
        const data = await response.json();

        if (data.success) {
            showBackupMsg('✓ 配置已保存', 'success');
        } else {
            showBackupMsg('✗ 保存失败: ' + data.message, 'error');
        }
    } catch (error) {
        showBackupMsg('✗ 请求失败: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

// 立即备份
async function backupNow() {
    const btn = document.getElementById('backupNowBtn');
    btn.disabled = true;
    btn.textContent = '备份中...';

    try {
        const response = await fetch(`${API_BASE_BACKUP}/api/backup/now`, {
            method: 'POST'
        });
        const data = await response.json();

        if (data.success) {
            showBackupMsg(`✓ 备份成功: ${data.filename}`, 'success');
            loadBackupList();  // 刷新列表
            loadBackupConfig();  // 刷新状态
        } else {
            showBackupMsg('✗ 备份失败: ' + data.message, 'error');
        }
    } catch (error) {
        showBackupMsg('✗ 请求失败: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '📤 立即备份';
    }
}

// 加载备份列表
async function loadBackupList() {
    const listEl = document.getElementById('backupList');
    if (!listEl) return;

    listEl.innerHTML = '<div style="text-align:center; padding:1rem;">加载中...</div>';

    try {
        const response = await fetch(`${API_BASE_BACKUP}/api/backup/list`);
        const data = await response.json();

        if (data.success && data.data.length > 0) {
            listEl.innerHTML = data.data.map((backup) => {
                const filename = safeBackupFilename(backup.filename);
                if (!filename) return '';
                return `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:0.75rem; background:rgba(255,255,255,0.1); border-radius:8px; margin-bottom:0.5rem;">
                    <div>
                        <strong>${escapeHtml(filename)}</strong><br>
                        <small style="opacity:0.7;">${escapeHtml(new Date(backup.lastModified).toLocaleString())}</small>
                    </div>
                    <button class="btn-secondary" data-backup-filename="${escapeAttr(filename)}" style="padding:0.4rem 0.8rem;">📥 恢复</button>
                </div>
            `;
            }).join('');
            listEl.querySelectorAll('[data-backup-filename]').forEach((button) => {
                button.addEventListener('click', () => restoreBackup(button.dataset.backupFilename));
            });
        } else if (data.success) {
            listEl.innerHTML = '<div style="text-align:center; padding:1rem; opacity:0.7;">暂无备份文件</div>';
        } else {
            listEl.innerHTML = `<div style="text-align:center; padding:1rem; color:#ff6b6b;">加载失败: ${escapeHtml(data.message)}</div>`;
        }
    } catch (error) {
        listEl.innerHTML = `<div style="text-align:center; padding:1rem; color:#ff6b6b;">请求失败: ${escapeHtml(error.message)}</div>`;
    }
}

// 恢复备份
async function restoreBackup(filename) {
    const safeFilename = safeBackupFilename(filename);
    if (!safeFilename) {
        showBackupMsg('✗ 备份文件名无效', 'error');
        return;
    }
    if (!confirm(`确定要从 "${safeFilename}" 恢复数据吗？\n\n警告：这将覆盖当前的分类和站点数据！`)) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE_BACKUP}/api/backup/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: safeFilename })
        });
        const data = await response.json();

        if (data.success) {
            showBackupMsg(`✓ 恢复成功！分类: ${data.categories} 个，站点: ${data.sites} 个`, 'success');
            // 刷新页面数据
            if (typeof loadCategories === 'function') loadCategories();
            if (typeof loadSites === 'function') loadSites();
        } else {
            showBackupMsg('✗ 恢复失败: ' + data.message, 'error');
        }
    } catch (error) {
        showBackupMsg('✗ 请求失败: ' + error.message, 'error');
    }
}

// 显示消息
function showBackupMsg(msg, type) {
    const msgEl = document.getElementById('backupMsg');
    if (msgEl) {
        msgEl.textContent = msg;
        msgEl.className = 'backup-msg ' + type;
        msgEl.style.display = 'block';

        setTimeout(() => {
            msgEl.style.display = 'none';
        }, 5000);
    }
}

// 页面加载时检查是否在备份标签页
document.addEventListener('DOMContentLoaded', () => {
    // 如果备份面板存在，初始化
    if (document.getElementById('backupPanel')) {
        // 监听标签切换
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.target.classList.contains('active')) {
                    initBackupPanel();
                    loadBackupList();
                }
            });
        });

        const backupPanel = document.getElementById('backupPanel');
        if (backupPanel) {
            observer.observe(backupPanel, { attributes: true, attributeFilter: ['class'] });
        }
    }
});
