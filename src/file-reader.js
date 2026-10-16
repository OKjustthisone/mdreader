import { renderMarkdown } from './render.js';
import { renderDiagrams } from './diagrams.js';
import { coerceReadingStyle, applyReadingStyle } from './reading-style.js';

// 浏览器原生打开本地 Markdown（file:// 文本视图）时：
// 默认把这份文件交给墨读主界面打开——左侧边栏、批注、同步与最近阅读都是完整的；
// 想要只读的纯阅读模式，在地址后加上 ?plain。交接失败时回落到本页纯阅读，
// 两者都失败则保留浏览器的原文显示。原文件只读，任何模式都不会改动它。
// 与扩展页面的 20 MB 上限保持一致：更大的文件不交接，直接纯阅读。
// 注意：声明必须在下方触发之前求值（构建后为 var 提升，先调用会读到 undefined）。
const MAX_HANDOFF = 20 * 1024 * 1024;

if (/\.(md|markdown|mdown)$/i.test(decodeURIComponent(location.pathname)) && !document.documentElement.dataset.inkstoneFile) {
  boot().catch(() => {
    // 渲染失败时保留浏览器的原文显示
    delete document.documentElement.dataset.inkstoneFile;
  });
}

async function boot() {
  document.documentElement.dataset.inkstoneFile = 'pending';
  const raw = document.querySelector('pre')?.textContent;
  if (typeof raw !== 'string' || !raw) return; // 不是文本视图，交回浏览器原样显示
  const plain = new URLSearchParams(location.search).has('plain');
  if (!plain && raw.length <= MAX_HANDOFF) {
    const name = decodeURIComponent(location.pathname.split('/').pop() || 'Markdown');
    const path = decodeURIComponent(location.pathname).replace(/^\//, '');
    showHandoff(name);
    // 后台会暂存这份文件，随后当前标签页导航进墨读主界面
    if (await sendHandoff({ name, path, content: raw })) return;
    // 交接失败（扩展刚更新、后台不可用）→ 回落到本页纯阅读
  }
  await renderPlain(raw);
}

// 交接进行中的占位：给出文件名与纯阅读逃生口，随后整个标签页交给墨读
function showHandoff(name) {
  document.title = `${name} · 墨读`;
  const main = document.createElement('main');
  main.className = 'main file-mode';
  main.innerHTML = '<div class="reading-layout"><div class="handoff-note"><strong class="handoff-name"></strong><span class="handoff-status">正在用墨读打开…</span><a href="?plain">改为纯阅读模式</a></div></div>';
  main.querySelector('.handoff-name').textContent = name;
  document.body.className = 'file-mode';
  document.body.replaceChildren(main);
}

// 扩展页纯阅读（?plain 或交接失败时）：先取本机阅读样式（与扩展页面同一份设置），再一次渲染，避免样式闪烁
async function renderPlain(raw) {
  const settings = coerceReadingStyle(await loadStyle());
  applyReadingStyle(document.documentElement, settings);
  const name = decodeURIComponent(location.pathname.split('/').pop() || 'Markdown');
  document.title = `${name} · 墨读`;
  const main = document.createElement('main');
  main.className = 'main file-mode';
  main.innerHTML = '<div class="reading-layout"><div class="reading-scroll" tabindex="0" aria-label="文档阅读区"><div class="document-wrap"><div class="document-eyebrow"><span class="document-badge">MARKDOWN</span><span class="document-meta"></span></div><article id="article" class="markdown-body" aria-label="Markdown 正文"></article></div></div></div>';
  main.querySelector('.document-meta').textContent = decodeURIComponent(location.pathname).replace(/^\//, '');
  document.body.className = 'file-mode';
  document.body.replaceChildren(main);
  const article = document.getElementById('article');
  renderMarkdown(raw, article, { fileMode: true });
  renderDiagrams(article);
  document.documentElement.dataset.inkstoneFile = 'ready';
}

// 把文件交给后台：写入待读记录并返回确认；超时或扩展异常时回落纯阅读
function sendHandoff(doc) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => done(false), 4000);
    try {
      chrome.runtime.sendMessage({ type: 'inkstone:open-in-app', doc }, response => {
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        done(!error && response?.ok === true);
      });
    } catch {
      clearTimeout(timer);
      done(false);
    }
  });
}

// 向后台线程询问当前阅读样式；扩展刚更新等异常场景回落到默认样式
function loadStyle() {
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => done(null), 1200);
    try {
      chrome.runtime.sendMessage({ type: 'inkstone:reading-style' }, response => {
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        done(error ? null : response?.settings ?? null);
      });
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}
