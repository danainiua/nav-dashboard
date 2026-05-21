// 创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: 'add-to-nav',
            title: '添加到导航仪表盘',
            contexts: ['page', 'link']
        });
        chrome.contextMenus.create({
            id: 'add-to-nav-default-icon',
            title: '添加到导航仪表盘（默认图标）',
            contexts: ['page', 'link']
        });
    });
});

function siteFromContext(info, tab) {
    if (info.linkUrl) {
        return {
            url: info.linkUrl,
            title: info.linkText || new URL(info.linkUrl).hostname,
            favIconUrl: tab.favIconUrl || ''
        };
    }

    return {
        url: tab.url,
        title: tab.title,
        favIconUrl: tab.favIconUrl || ''
    };
}

async function openAddPopup(logoMode = '') {
    const displays = await chrome.system.display.getInfo();
    const primaryDisplay = displays.find(d => d.isPrimary) || displays[0];
    const screenWidth = primaryDisplay?.workArea?.width || 1920;
    const screenHeight = primaryDisplay?.workArea?.height || 1080;

    const popupWidth = 420;
    const popupHeight = 560;
    const left = screenWidth - popupWidth - 20;
    const top = Math.round((screenHeight - popupHeight) / 2);
    const params = new URLSearchParams({ mode: 'contextMenu' });
    if (logoMode) {
        params.set('logoMode', logoMode);
    }

    chrome.windows.create({
        url: chrome.runtime.getURL(`popup.html?${params.toString()}`),
        type: 'popup',
        width: popupWidth,
        height: popupHeight,
        left,
        top,
        focused: true
    });
}

// 右键菜单点击处理
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!['add-to-nav', 'add-to-nav-default-icon'].includes(info.menuItemId)) {
        return;
    }

    const pendingSite = {
        ...siteFromContext(info, tab),
        timestamp: Date.now()
    };

    chrome.storage.local.set({ pendingSite }, () => {
        openAddPopup(info.menuItemId === 'add-to-nav-default-icon' ? 'default' : '');
    });
});

// 监听来自popup的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getCurrentTab') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                sendResponse({
                    url: tabs[0].url,
                    title: tabs[0].title,
                    favIconUrl: tabs[0].favIconUrl || ''
                });
            } else {
                sendResponse(null);
            }
        });
        return true; // 保持消息通道开放
    }
});
