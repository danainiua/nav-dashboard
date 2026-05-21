document.addEventListener('DOMContentLoaded', async () => {
    const nameInput = document.getElementById('name');
    const urlInput = document.getElementById('url');
    const descriptionInput = document.getElementById('description');
    const categorySelect = document.getElementById('category');
    const logoInput = document.getElementById('logo');
    const logoImg = document.getElementById('logo-img');
    const logoModeSelect = document.getElementById('logo-mode');
    const submitBtn = document.getElementById('submit-btn');
    const optionsBtn = document.getElementById('options-btn');
    const messageDiv = document.getElementById('message');
    const notConfigured = document.getElementById('not-configured');
    const goOptionsBtn = document.getElementById('go-options');

    let apiUrl = '';
    let password = '';
    let currentFavIconUrl = '';
    let currentPageUrl = '';

    const DEFAULT_ICON = '/default-icon.png';

    // 加载配置
    const config = await chrome.storage.sync.get(['apiUrl', 'password']);
    apiUrl = config.apiUrl || '';
    password = config.password || '';

    if (!apiUrl) {
        notConfigured.style.display = 'block';
        submitBtn.disabled = true;
    }

    // 判断是从右键菜单打开还是直接点击图标
    const urlParams = new URLSearchParams(window.location.search);
    const isContextMenu = urlParams.get('mode') === 'contextMenu';

    if (isContextMenu) {
        // 从右键菜单打开，读取存储的数据
        const data = await chrome.storage.local.get('pendingSite');
        if (data.pendingSite) {
            nameInput.value = data.pendingSite.title || '';
            urlInput.value = data.pendingSite.url || '';
            setLogo(data.pendingSite.favIconUrl, data.pendingSite.url);
            // 清除临时数据
            chrome.storage.local.remove('pendingSite');
        }
    } else {
        // 直接点击图标，获取当前标签页
        chrome.runtime.sendMessage({ action: 'getCurrentTab' }, (response) => {
            if (response) {
                nameInput.value = response.title || '';
                urlInput.value = response.url || '';
                setLogo(response.favIconUrl, response.url);
            }
        });
    }

    function getDomain(pageUrl) {
        try {
            return new URL(pageUrl).hostname;
        } catch (e) {
            return '';
        }
    }

    function getAutoFaviconUrl(pageUrl) {
        const domain = getDomain(pageUrl);
        return domain ? `https://www.google.com/s2/favicons?sz=128&domain=${domain}` : '';
    }

    function setPreviewLogo(logoUrl, fallbackUrls = [], previewUrl = logoUrl) {
        logoInput.value = logoUrl;
        logoImg.src = previewUrl || getPlaceholderIcon();

        let fallbackIndex = 0;
        logoImg.onerror = () => {
            if (fallbackIndex < fallbackUrls.length) {
                const nextUrl = fallbackUrls[fallbackIndex++];
                logoImg.src = nextUrl;
                logoInput.value = nextUrl;
            } else {
                logoImg.src = getPlaceholderIcon();
            }
        };
    }

    function updateLogoByMode() {
        const mode = logoModeSelect.value;
        const domain = getDomain(currentPageUrl);

        if (mode === 'default') {
            setPreviewLogo(DEFAULT_ICON, [], apiUrl ? `${apiUrl}${DEFAULT_ICON}` : DEFAULT_ICON);
            return;
        }

        if (mode === 'browser') {
            const fallbackUrls = domain ? [
                getAutoFaviconUrl(currentPageUrl),
                `https://icons.duckduckgo.com/ip3/${domain}.ico`,
                `https://favicon.im/${domain}`
            ].filter(Boolean) : [];
            setPreviewLogo(currentFavIconUrl || getAutoFaviconUrl(currentPageUrl), fallbackUrls);
            return;
        }

        const fallbackUrls = domain ? [
            `https://icons.duckduckgo.com/ip3/${domain}.ico`,
            `https://favicon.im/${domain}`
        ] : [];
        setPreviewLogo(getAutoFaviconUrl(currentPageUrl), fallbackUrls);
    }

    // 设置Logo
    function setLogo(favIconUrl, pageUrl) {
        currentFavIconUrl = favIconUrl || '';
        currentPageUrl = pageUrl || '';
        updateLogoByMode();
    }

    // 获取占位图标
    function getPlaceholderIcon() {
        return 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23999"><rect width="24" height="24" rx="4"/></svg>';
    }

    // 加载分类列表
    async function loadCategories() {
        if (!apiUrl) return;

        try {
            const response = await fetch(`${apiUrl}/api/categories`);
            const data = await response.json();

            if (data.success && data.data) {
                categorySelect.innerHTML = '<option value="">不选择分类</option>';
                data.data.forEach(cat => {
                    const option = document.createElement('option');
                    option.value = cat.id;
                    option.textContent = `${cat.icon || '📁'} ${cat.name}`;
                    categorySelect.appendChild(option);
                });
            }
        } catch (error) {
            console.error('加载分类失败:', error);
            categorySelect.innerHTML = '<option value="">加载失败</option>';
        }
    }

    // 显示消息
    function showMessage(text, type) {
        messageDiv.textContent = text;
        messageDiv.className = `message ${type}`;
        setTimeout(() => {
            messageDiv.className = 'message';
        }, 3000);
    }

    // 验证密码（如果设置了密码）
    async function verifyPassword() {
        if (!password) return true;

        try {
            const response = await fetch(`${apiUrl}/api/auth/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const data = await response.json();
            return data.success;
        } catch (error) {
            return false;
        }
    }

    // 提交站点
    async function submitSite() {
        const name = nameInput.value.trim();
        const url = urlInput.value.trim();
        const description = descriptionInput.value.trim();
        const category_id = categorySelect.value || null;
        const logo = logoInput.value;

        if (!name || !url) {
            showMessage('请填写站点名称和地址', 'error');
            return;
        }

        // 验证URL格式
        try {
            new URL(url);
        } catch (e) {
            showMessage('请输入有效的网址', 'error');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.classList.add('loading');
        submitBtn.textContent = '';

        try {
            // 先验证密码
            const isValid = await verifyPassword();
            if (!isValid) {
                showMessage('密码验证失败，请检查设置', 'error');
                return;
            }

            // 添加站点
            const response = await fetch(`${apiUrl}/api/sites`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, url, description, logo, category_id })
            });

            const data = await response.json();

            if (data.success) {
                showMessage('✅ 添加成功！', 'success');
                // 1.5秒后关闭窗口
                setTimeout(() => {
                    window.close();
                }, 1500);
            } else {
                showMessage(data.message || '添加失败', 'error');
            }
        } catch (error) {
            showMessage('网络错误: ' + error.message, 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.classList.remove('loading');
            submitBtn.textContent = '添加';
        }
    }

    // 事件绑定
    submitBtn.addEventListener('click', submitSite);

    optionsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    goOptionsBtn?.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    logoModeSelect.addEventListener('change', updateLogoByMode);

    // URL变化时更新Logo
    urlInput.addEventListener('blur', () => {
        if (urlInput.value) {
            setLogo('', urlInput.value);
        }
    });

    // 回车提交
    [nameInput, urlInput, descriptionInput].forEach(input => {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                submitSite();
            }
        });
    });

    // 初始化加载分类
    await loadCategories();
});
