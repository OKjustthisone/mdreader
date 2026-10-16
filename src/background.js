import { get, mutate } from './db.js';

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('index.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

// file:// 原生阅读页无法直接读取扩展的 IndexedDB，由后台把阅读样式带过去
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'inkstone:reading-style') {
    get('state', 'settings')
      .then(settings => sendResponse({ settings }))
      .catch(() => sendResponse({ settings: null }));
    return true;
  }
  // 双击打开的文件交给墨读主界面：先暂存待读交接，再把当前标签页导航进阅读器
  if (message?.type === 'inkstone:open-in-app') {
    (async () => {
      try {
        const doc = message.doc || {};
        if (typeof doc.content !== 'string' || typeof doc.path !== 'string' || !doc.path) throw new Error('交接内容不完整');
        await mutate('state', 'pending-file-open', () => ({ name: doc.name, path: doc.path, content: doc.content, receivedAt: Date.now() }));
        if (!sender.tab?.id) throw new Error('缺少来源标签页');
        sendResponse({ ok: true });
        chrome.tabs.update(sender.tab.id, { url: chrome.runtime.getURL('index.html') })
          .catch(() => mutate('state', 'pending-file-open', () => undefined).catch(() => {}));
      } catch {
        // 交接失败时清掉暂存，让内容脚本回落到本页纯阅读
        await mutate('state', 'pending-file-open', () => undefined).catch(() => {});
        sendResponse({ ok: false });
      }
    })();
    return true;
  }
  return undefined;
});
