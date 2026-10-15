import * as db from './db.js';
import { icon, hydrateIcons } from './icons.js';
import { HIGHLIGHT_COLORS, captureSelection, applyAnnotations } from './annotations.js';
import { renderMarkdown } from './render.js';
import { renderDiagrams } from './diagrams.js';
import { welcome } from './welcome.js';

const $ = selector => document.querySelector(selector);
const article = $('#article');
const scroller = $('#reading-scroll');
const defaults = { theme: 'paper', background: '#fbfaf7', font: 'system', fontSize: 17, width: 760, lineHeight: 1.9 };
const themes = { paper: '#fbfaf7', white: '#ffffff', sage: '#eef3eb', night: '#202624' };
const fonts = {
  system: 'ReaderSystem, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
  song: '"Songti SC", "Noto Serif CJK SC", SimSun, serif',
  serif: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif',
  mono: '"SFMono-Regular", Menlo, Consolas, "PingFang SC", monospace',
};
const app = { documents: [], folders: [], history: [], view: 'files', current: welcome, notes: [], outline: [], orphanIds: [], settings: { ...defaults }, selected: null, editingNote: null, panel: 'outline', folderId: null, recursive: true, renderVersion: 0 };
let toastTimer, settingsTimer, positionTimer, diagramTimer, outlineObserver, selectedNoteId;
let blobUrls = [];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function toast(message, duration = 3300) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, duration);
}
function saved(message = '已保存到本机') {
  document.body.classList.remove('storage-error');
  $('#save-status').textContent = message;
}
function report(error) {
  if (error?.name === 'AbortError') return;
  console.error(error);
  const message = error?.name === 'QuotaExceededError' ? '本地空间不足，未能保存。请释放浏览器存储空间后重试。' : error?.message || '操作未完成，请重试';
  toast(message, 6000);
  $('#save-status').textContent = '操作未完成';
  document.body.classList.add('storage-error');
}
function run(action) { return Promise.resolve().then(action).catch(report); }
function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value || Date.now());
}
function relativeDate(value) {
  if (!value) return '';
  const now = new Date(), date = new Date(value);
  if (now.toDateString() === date.toDateString()) return `今天 ${date.toTimeString().slice(0, 5)}`;
  return formatDate(value);
}
function folderLabel(doc) { return app.folders.find(folder => folder.id === doc.folderId)?.name || '单独打开'; }
function fileName(doc) { return doc.name.replace(/\.(md|markdown|mdown)$/i, ''); }

async function loadLibrary() {
  [app.documents, app.folders, app.history] = await Promise.all([db.all('documents'), db.all('folders'), db.get('state', 'history')]);
  app.history ||= [];
  renderLibrary();
}
function renderLibrary() {
  const docs = app.documents;
  $('#files-count').textContent = docs.length;
  $('#favorites-count').textContent = docs.filter(doc => doc.starred).length;
  $('#history-count').textContent = app.history.length;
  for (const el of document.querySelectorAll('[data-view]')) {
    el.classList.toggle('active', el.dataset.view === app.view);
    if (el.dataset.view === app.view) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
  const activeFolder = app.folders.find(folder => folder.id === app.folderId);
  $('#library-title').textContent = { files: '全部文档', favorites: '我的收藏', history: '最近 20 条' }[app.view];
  $('#refresh-folder').hidden = app.view !== 'files' || !activeFolder?.handle;
  $('#refresh-folder').title = `重新扫描 ${activeFolder?.name || '当前文件夹'}`;
  $('#folder-options').hidden = app.view !== 'files' || !activeFolder;
  $('#folder-scan-status').textContent = activeFolder ? activeFolder.name : '';
  $('#recursive').checked = app.recursive;
  const query = $('#library-search').value.trim().toLocaleLowerCase();
  let visible;
  if (app.view === 'history') visible = app.history.map(id => docs.find(doc => doc.id === id) || (id === 'welcome' ? { ...welcome, viewedAt: 0 } : null)).filter(Boolean);
  else visible = docs.filter(doc => app.view !== 'favorites' || doc.starred).sort((a, b) => (a.folderId || '').localeCompare(b.folderId || '') || a.path.localeCompare(b.path, 'zh-CN', { numeric: true }));
  visible = visible.filter(doc => (app.recursive || !doc.folderId || !doc.path.includes('/')) || app.view !== 'files');
  if (query) visible = visible.filter(doc => `${doc.name} ${doc.path} ${folderLabel(doc)}`.toLocaleLowerCase().includes(query));
  if (!visible.length) {
    const empty = query ? ['search', '没有找到文档', '换个关键词，再找找看。'] : {
      files: ['folderOpen', '你的阅读，从这里开始', '打开一份 Markdown，<br>或将整个笔记文件夹带进来。'],
      favorites: ['star', '把喜欢的文字留下', '点击阅读区顶部的星标，<br>收藏会在这里等你。'],
      history: ['history', '还没有阅读记录', '打开文档后，<br>这里会记住最近的 20 份。'],
    }[app.view];
    $('#file-list').innerHTML = `<div class="empty-library"><div class="empty-icon">${icon(empty[0])}</div><h3>${empty[1]}</h3><p>${empty[2]}</p>${!query && app.view === 'files' ? `<button data-action="open-file">打开第一份文档 ${icon('arrow')}</button>` : ''}</div>`;
    return;
  }
  let lastGroup;
  $('#file-list').innerHTML = visible.map(doc => {
    let group = '';
    const groupId = doc.folderId || 'individual';
    if (app.view === 'files' && groupId !== lastGroup) {
      lastGroup = groupId;
      group = `<div class="folder-group">${icon(doc.folderId ? 'folder' : 'file')}<span title="${escapeHtml(folderLabel(doc))}">${escapeHtml(folderLabel(doc))}</span><small>${visible.filter(item => (item.folderId || 'individual') === groupId).length}</small></div>`;
    }
    const subtitle = doc.available === false ? '原文件已移除 · 保留的副本' : app.view === 'history' ? relativeDate(doc.viewedAt) || '阅读指南' : doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : (doc.folderId ? '' : 'Markdown');
    return `${group}<button role="listitem" class="file-row ${doc.id === app.current?.id ? 'active' : ''}" data-document="${escapeHtml(doc.id)}" title="${escapeHtml(doc.path)}" ${doc.id === app.current?.id ? 'aria-current="true"' : ''}><span class="file-icon">${icon('file')}</span><span class="file-info"><span class="file-name">${escapeHtml(doc.name)}</span>${subtitle ? `<span class="file-path">${escapeHtml(subtitle)}</span>` : ''}</span>${doc.starred ? `<span class="star-indicator">${icon('star')}</span>` : ''}</button>`;
  }).join('');
}

function clamp(value, min, max, fallback) { return Number.isFinite(+value) ? Math.min(max, Math.max(min, +value)) : fallback; }
function normalizeSettings(settings) {
  const source = { ...defaults, ...settings };
  return {
    theme: Object.hasOwn(themes, source.theme) || source.theme === 'custom' ? source.theme : 'paper',
    background: /^#[0-9a-f]{6}$/i.test(source.background) ? source.background : defaults.background,
    font: Object.hasOwn(fonts, source.font) ? source.font : defaults.font,
    fontSize: clamp(source.fontSize, 12, 32, 17), width: clamp(source.width, 460, 1200, 760), lineHeight: clamp(source.lineHeight, 1.3, 2.6, 1.9),
  };
}
function applySettings() {
  const settings = app.settings = normalizeSettings(app.settings);
  const style = document.documentElement.style;
  const rgb = settings.background.slice(1).match(/../g).map(value => parseInt(value, 16));
  const dark = (rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114) < 140;
  document.documentElement.dataset.ui = dark ? 'dark' : 'light';
  const color = dark ? ['#dce3d7', '#95a18f', '#465042', 'rgba(197,216,180,.055)'] : ['#353a32', '#858a7f', 'rgba(80,96,66,.14)', 'rgba(92,106,75,.065)'];
  for (const [key, value] of Object.entries({ '--page': settings.background, '--page-ink': color[0], '--page-muted': color[1], '--page-rule': color[2], '--code-bg': color[3], '--reader-font': fonts[settings.font], '--font-size': `${settings.fontSize}px`, '--text-width': `${settings.width}px`, '--line-height': settings.lineHeight })) style.setProperty(key, value);
  $('#font-family').value = settings.font;
  $('#font-size').value = settings.fontSize;
  $('#font-size-value').textContent = `${settings.fontSize} px`;
  $('#text-width').value = settings.width;
  $('#text-width-value').textContent = `${settings.width} px`;
  $('#line-height').value = settings.lineHeight;
  $('#line-height-value').textContent = `${settings.lineHeight.toFixed(1)} 倍`;
  $('#custom-color').value = settings.background;
  document.querySelectorAll('[data-theme]').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === settings.theme);
    el.setAttribute('aria-pressed', String(el.dataset.theme === settings.theme));
  });
  $('.custom-theme').classList.toggle('active', settings.theme === 'custom');
  clearTimeout(diagramTimer);
  const version = app.renderVersion;
  diagramTimer = setTimeout(() => run(() => renderDiagrams(article, () => version === app.renderVersion)), 100);
}
function saveSettings() {
  applySettings();
  const snapshot = { ...app.settings };
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => run(async () => { await db.put('state', snapshot, 'settings'); saved(); }), 180);
}
function togglePopover(id, visible) {
  const popover = $(`#${id}`);
  popover.hidden = visible === undefined ? !popover.hidden : !visible;
  if (id === 'settings-popover') $('#style-button').setAttribute('aria-expanded', String(!popover.hidden));
  if (id === 'more-menu') $('#more-button').setAttribute('aria-expanded', String(!popover.hidden));
}

function setSourceNotice(message, action) {
  const notice = $('#source-notice');
  notice.replaceChildren();
  notice.hidden = !message;
  if (!message) return;
  notice.append(message);
  if (action) {
    const button = document.createElement('button');
    button.textContent = action.label;
    button.addEventListener('click', () => run(action.callback));
    notice.append(button);
  }
}
function snapshotNotice() {
  setSourceNotice('正在阅读本地保存的副本。重新授权后可读取原文件的最新内容。', { label: '重新连接原文件', callback: () => openDocument(app.current, { prompt: true }) });
}
async function savePosition(doc = app.current) {
  clearTimeout(positionTimer);
  if (!doc?.id) return;
  const max = scroller.scrollHeight - scroller.clientHeight;
  const progress = max > 0 ? scroller.scrollTop / max : 0;
  doc.progress = progress;
  const cached = app.documents.find(item => item.id === doc.id);
  if (cached) cached.progress = progress;
  if (doc.id === 'welcome') await db.put('state', progress, 'welcome-progress');
  else await db.mutate('documents', doc.id, old => old ? { ...old, progress } : old);
}
function updateProgress() {
  const max = scroller.scrollHeight - scroller.clientHeight;
  const progress = max > 0 ? Math.max(0, Math.min(1, scroller.scrollTop / max)) : 0;
  $('#reading-progress').textContent = `${Math.round(progress * 100)}%`;
  $('#progress-fill').style.width = `${progress * 100}%`;
}
function renderOutline() {
  $('#outline-list').innerHTML = app.outline.length ? app.outline.map(heading => `<button class="outline-link level-${heading.level}" data-heading="${heading.id}" title="${escapeHtml(heading.text)}">${escapeHtml(heading.text)}</button>`).join('') : '<div class="panel-empty">这篇文档没有标题<br>静静读下去吧。</div>';
  outlineObserver?.disconnect();
  outlineObserver = new IntersectionObserver(() => {
    const top = scroller.getBoundingClientRect().top + 60;
    let active = app.outline[0]?.id;
    for (const heading of app.outline) {
      if (document.getElementById(heading.id)?.getBoundingClientRect().top <= top) active = heading.id;
    }
    for (const button of document.querySelectorAll('[data-heading]')) button.classList.toggle('current', button.dataset.heading === active);
  }, { root: scroller, rootMargin: '0px 0px -75% 0px', threshold: [0, 1] });
  article.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(el => outlineObserver.observe(el));
}
function renderNotes() {
  $('#notes-count').textContent = app.notes.length;
  $('#notes-list').innerHTML = app.notes.length ? app.notes.map(note => `<div class="note-card ${note.id === selectedNoteId ? 'selected' : ''}" data-note-card="${escapeHtml(note.id)}" style="--note-color:${HIGHLIGHT_COLORS[note.color]?.value || HIGHLIGHT_COLORS.yellow.value}"><button class="note-quote" data-locate-note="${escapeHtml(note.id)}" title="定位到原文">${escapeHtml(note.quote)}</button>${note.comment ? `<p class="note-comment">${escapeHtml(note.comment)}</p>` : ''}${app.orphanIds.includes(note.id) ? '<div class="note-orphan">原文已变动，暂时无法定位；批注仍已保留。</div>' : ''}<div class="note-footer"><time>${formatDate(note.createdAt)}</time><div class="note-controls"><button class="icon-button small" data-edit-note="${escapeHtml(note.id)}" title="${note.comment ? '编辑评论' : '添加评论'}" aria-label="${note.comment ? '编辑评论' : '添加评论'}">${icon('edit')}</button><button class="icon-button small" data-delete-note="${escapeHtml(note.id)}" title="删除批注" aria-label="删除批注">${icon('trash')}</button></div></div></div>`).join('') : `<div class="panel-empty">${icon('highlight')}还没有批注<br>选中文字，即可高亮或添加评论。</div>`;
}
function showPanel(panel = app.panel) {
  app.panel = panel;
  $('#right-panel').hidden = false;
  $('#panel-toggle').setAttribute('aria-pressed', 'true');
  for (const tab of document.querySelectorAll('[data-panel]')) {
    const selected = tab.dataset.panel === panel;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  }
  $('#outline-list').hidden = panel !== 'outline';
  $('#notes-list').hidden = panel !== 'notes';
}
function togglePanel() {
  $('#right-panel').hidden = !$('#right-panel').hidden;
  $('#panel-toggle').setAttribute('aria-pressed', String(!$('#right-panel').hidden));
}
function refreshFavorite() {
  const starred = !!app.current?.starred;
  $('#favorite-button').classList.toggle('favorite-active', starred);
  $('#favorite-button').title = starred ? '取消收藏' : '收藏文档';
  $('#favorite-button').setAttribute('aria-label', starred ? '取消收藏' : '收藏文档');
  $('#favorite-button').setAttribute('aria-pressed', String(starred));
}
async function refreshNotes(documentId = app.current.id) {
  const notes = await db.notesFor(documentId);
  if (documentId !== app.current.id) return;
  app.notes = notes;
  app.orphanIds = applyAnnotations(article, notes);
  renderNotes();
}
function renderDocument(progress = 0) {
  blobUrls.forEach(url => URL.revokeObjectURL(url));
  blobUrls = [];
  app.renderVersion++;
  $('#selection-toolbar').hidden = true;
  app.selected = null;
  app.outline = renderMarkdown(app.current.content || '', article);
  app.orphanIds = applyAnnotations(article, app.notes);
  $('#breadcrumb-file').textContent = app.current.name;
  $('#breadcrumb-folder').textContent = app.current.folderId ? folderLabel(app.current) : '阅读空间';
  $('#document-meta').textContent = app.current.id === 'welcome' ? '为阅读留一点空间' : app.current.folderId ? `${folderLabel(app.current)} / ${app.current.path}` : '本地文档 · 只读';
  $('#reload-document').hidden = !app.current.handle;
  document.title = `${fileName(app.current)} · 墨读`;
  const content = article.textContent;
  const chars = content.replace(/\s/g, '').length;
  const chinese = (content.match(/[\u3400-\u9fff]/g) || []).length;
  const english = (content.replace(/[\u3400-\u9fff]/g, '').match(/\b[\p{L}\p{N}]+\b/gu) || []).length;
  $('#word-count').textContent = `${chars.toLocaleString('zh-CN')} 字`;
  $('#read-time').textContent = `约 ${Math.max(1, Math.ceil(chinese / 400 + english / 220))} 分钟`;
  refreshFavorite(); renderLibrary(); renderOutline(); renderNotes();
  const version = app.renderVersion;
  let restoredTop;
  requestAnimationFrame(() => {
    scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight) * (progress || 0);
    restoredTop = scroller.scrollTop;
    updateProgress();
  });
  run(async () => {
    await renderDiagrams(article, () => version === app.renderVersion);
    if (version === app.renderVersion && restoredTop !== undefined && Math.abs(scroller.scrollTop - restoredTop) < 2) {
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight) * (progress || 0);
      updateProgress();
    }
  });
  run(() => resolveLocalImages(app.current, version));
}
let openingToken = 0;
async function openDocument(input, { prompt = false, record = true, initial = false } = {}) {
  const token = ++openingToken;
  let doc = input.id === 'welcome' ? { ...welcome, ...app.documents.find(item => item.id === 'welcome') } : { ...input };
  let sourceState = 'live';
  if (doc.handle) {
    let permission = await doc.handle.queryPermission({ mode: 'read' });
    if (permission !== 'granted' && prompt) permission = await doc.handle.requestPermission({ mode: 'read' });
    if (permission === 'granted') {
      try {
        const file = await doc.handle.getFile();
        assertSize(file);
        doc.content = await file.text();
        doc.modifiedAt = file.lastModified;
      } catch (error) {
        if (typeof doc.content !== 'string') throw new Error(`无法读取「${doc.name}」，文件可能已移动或删除。请重新打开文件或扫描文件夹。`);
        sourceState = 'missing';
      }
    } else sourceState = 'snapshot';
  }
  if (typeof doc.content !== 'string') {
    setSourceNotice(`需要重新授权才能打开「${doc.name}」。`, { label: '授权并打开', callback: () => openDocument(doc, { prompt: true }) });
    toast('尚未获得文件读取权限，请点击“授权并打开”。');
    return;
  }
  if (token !== openingToken) return;
  if (!initial) {
    await savePosition();
    if (doc.id === app.current.id) doc.progress = app.current.progress;
  }
  if (token !== openingToken) return;
  if (record) {
    doc.viewedAt = Date.now();
    if (doc.id !== 'welcome' || app.documents.some(item => item.id === 'welcome')) doc = await db.mergeDocument(doc);
    await db.recordVisit(doc.id);
    await db.put('state', doc.id, 'active-document');
  } else if (doc.id !== 'welcome' && doc.handle && sourceState === 'live') {
    // Refreshing the reader can discover externally edited content. Keep that
    // latest content as the offline snapshot without adding another history visit.
    doc = await db.mergeDocument(doc);
  }
  const notes = await db.notesFor(doc.id);
  if (token !== openingToken) return;
  app.current = doc;
  app.notes = notes;
  selectedNoteId = null;
  if (doc.folderId && doc.folderId !== app.folderId) {
    app.folderId = doc.folderId;
    await db.put('state', doc.folderId, 'active-folder');
  }
  await loadLibrary();
  if (token !== openingToken) return;
  const progress = doc.id === 'welcome' ? await db.get('state', 'welcome-progress') : doc.progress;
  renderDocument(progress);
  if (sourceState === 'snapshot') snapshotNotice();
  else if (sourceState === 'missing') setSourceNotice('原文件可能已移动或删除，正在显示上次保存的副本。', { label: '重新打开文件', callback: pickFiles });
  else setSourceNotice('');
  saved(doc.source === 'welcome' ? '阅读指南' : '文档已保存到本机');
  if (matchMedia('(max-width:650px)').matches) document.body.classList.add('sidebar-collapsed');
}

function assertSize(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error(`「${file.name}」超过 20 MB，请使用更小的 Markdown 文件。`);
}
async function sameFile(handle, name) {
  if (!handle) return null;
  for (const doc of app.documents.filter(item => item.handle && item.name === name)) {
    if (await handle.isSameEntry(doc.handle).catch(() => false)) return doc;
  }
  return null;
}
async function hash(value) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function importFiles(entries) {
  const imported = [];
  for (const entry of entries) {
    const file = entry.handle ? await entry.handle.getFile() : entry.file;
    if (!db.markdownFile(file.name)) continue;
    assertSize(file);
    const content = await file.text();
    let existing = await sameFile(entry.handle, file.name);
    if (!existing && entry.handle) {
      for (const folder of app.folders.filter(item => item.handle)) {
        const path = await folder.handle.resolve(entry.handle).catch(() => null);
        if (path) { existing = { id: `${folder.id}:${path.join('/')}`, folderId: folder.id, path: path.join('/') }; break; }
      }
    }
    const doc = await db.mergeDocument({
      id: existing?.id || (entry.handle ? crypto.randomUUID() : `import-${await hash(file.name + '\0' + content)}`),
      name: file.name, path: existing?.path || file.name, folderId: existing?.folderId || null,
      source: entry.handle ? 'file' : 'import', handle: entry.handle || null,
      content, modifiedAt: file.lastModified, importedAt: Date.now(),
    });
    imported.push(doc);
    const index = app.documents.findIndex(item => item.id === doc.id);
    if (index >= 0) app.documents[index] = doc; else app.documents.push(doc);
  }
  if (!imported.length) { toast('请选择 .md、.markdown 或 .mdown 文件'); return; }
  await openDocument(imported[0]);
  if (imported.length > 1) toast(`已添加 ${imported.length} 份 Markdown 文档`);
}
async function pickFiles() {
  togglePopover('more-menu', false);
  if (!window.showOpenFilePicker) { $('#file-input').click(); return; }
  const handles = await window.showOpenFilePicker({ id: 'inkstone-files', multiple: true, types: [{ description: 'Markdown 文档', accept: { 'text/markdown': ['.md', '.markdown', '.mdown'] } }] });
  await importFiles(handles.map(handle => ({ handle })));
}
async function findFolder(handle) {
  for (const folder of app.folders.filter(item => item.handle)) if (await folder.handle.isSameEntry(handle).catch(() => false)) return folder;
  return null;
}
async function pickFolder() {
  if (!window.showDirectoryPicker) { $('#folder-input').click(); return; }
  const handle = await window.showDirectoryPicker({ id: 'inkstone-folder', mode: 'read' });
  const old = await findFolder(handle);
  const folder = { id: old?.id || crypto.randomUUID(), name: handle.name, handle, importedAt: Date.now() };
  await db.put('folders', folder);
  await scanFolder(folder);
}
let scanning = false;
async function scanFolder(folder) {
  if (scanning) { toast('正在扫描文件夹，请稍候'); return; }
  let permission = await folder.handle.queryPermission({ mode: 'read' });
  if (permission !== 'granted') permission = await folder.handle.requestPermission({ mode: 'read' });
  if (permission !== 'granted') { toast('未获得文件夹读取权限'); return; }
  scanning = true;
  $('#refresh-folder').disabled = true;
  document.body.classList.add('busy');
  $('#save-status').textContent = `扫描 ${folder.name}…`;
  const docs = [];
  try {
    async function walk(handle, prefix = '') {
      for await (const [name, entry] of handle.entries()) {
        if (entry.kind === 'directory') {
          if (name !== '.git') await walk(entry, `${prefix}${name}/`);
        } else if (db.markdownFile(name)) {
          const path = `${prefix}${name}`;
          docs.push({ id: `${folder.id}:${path}`, folderId: folder.id, name, path, source: 'folder', handle: entry, available: true });
        }
      }
    }
    await walk(folder.handle);
    await db.putDocuments(docs);
    const seen = new Set(docs.map(doc => doc.id));
    // Retain snapshots, favorites and notes when a file is removed externally.
    for (const old of app.documents.filter(doc => doc.folderId === folder.id && !seen.has(doc.id))) await db.mutate('documents', old.id, item => item && (typeof item.content === 'string' || item.starred) ? { ...item, available: false } : undefined);
    await db.put('folders', { ...folder, scannedAt: Date.now() });
    app.folderId = folder.id;
    await db.put('state', folder.id, 'active-folder');
    app.view = 'files';
    $('#library-search').value = '';
    await loadLibrary();
    toast(`「${folder.name}」中找到 ${docs.length} 份 Markdown 文档`);
    if (docs.length && app.current.id === 'welcome') await openDocument(app.documents.find(doc => doc.id === docs.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }))[0].id));
    saved();
  } finally {
    scanning = false;
    $('#refresh-folder').disabled = false;
    document.body.classList.remove('busy');
  }
}
async function importFolderFallback(files) {
  const root = files[0]?.webkitRelativePath.split('/')[0];
  if (!root) return;
  const folder = { id: `imported-folder-${await hash(root)}`, name: root, importedAt: Date.now() };
  await db.put('folders', folder);
  let first;
  const docs = [];
  for (const file of files) {
    if (!db.markdownFile(file.name)) continue;
    assertSize(file);
    const path = file.webkitRelativePath.split('/').slice(1).join('/');
    const doc = { id: `${folder.id}:${path}`, name: file.name, path, folderId: folder.id, content: await file.text(), modifiedAt: file.lastModified, source: 'import', importedAt: Date.now() };
    docs.push(doc); first ||= doc;
  }
  await db.putDocuments(docs);
  app.folderId = folder.id;
  await db.put('state', folder.id, 'active-folder');
  app.view = 'files';
  await loadLibrary();
  if (first) await openDocument(first);
  toast(`已导入 ${docs.length} 份 Markdown 副本。重新选择文件夹可更新内容。`, 4500);
}
async function resolveLocalImages(doc, version) {
  const folder = app.folders.find(item => item.id === doc.folderId);
  if (!folder?.handle || await folder.handle.queryPermission({ mode: 'read' }) !== 'granted') return;
  await Promise.allSettled([...article.querySelectorAll('img[data-local-path]')].map(async img => {
    const relative = img.dataset.localPath;
    if (!relative || /^[a-z][a-z\d+.-]*:/i.test(relative) || relative.startsWith('//') || relative.startsWith('/')) return;
    let decoded;
    try { decoded = decodeURIComponent(relative.split(/[?#]/)[0]); } catch { return; }
    const path = db.normalizePath(doc.path, decoded);
    if (!path || !/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path)) return;
    const parts = path.split('/');
    let directory = folder.handle;
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    const file = await (await directory.getFileHandle(parts.at(-1))).getFile();
    if (file.size > 20 * 1024 * 1024 || version !== app.renderVersion) return;
    const url = URL.createObjectURL(file);
    blobUrls.push(url); img.src = url;
  }));
}

function captureAndShow() {
  if ($('#comment-dialog').open) return;
  const selected = captureSelection(article);
  if (!selected) { $('#selection-toolbar').hidden = true; return; }
  app.selected = selected;
  const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
  const toolbar = $('#selection-toolbar');
  toolbar.hidden = false;
  const width = toolbar.offsetWidth, height = toolbar.offsetHeight;
  toolbar.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.left + rect.width / 2 - width / 2))}px`;
  const above = rect.top - height - 10;
  toolbar.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, above > 65 ? above : rect.bottom + 10))}px`;
}
async function saveAnnotation(color = 'yellow', comment = '') {
  const selected = app.selected;
  if (!selected) return;
  const documentId = app.current.id;
  const note = { ...selected, id: crypto.randomUUID(), documentId, color, comment, createdAt: Date.now(), updatedAt: Date.now() };
  $('#selection-toolbar').hidden = true;
  // Every note is a separate record. A second highlight cannot replace the first.
  await db.put('annotations', note);
  if (documentId === app.current.id) {
    window.getSelection()?.removeAllRanges();
    app.selected = null;
    selectedNoteId = note.id;
    await refreshNotes(documentId);
    if (comment) showPanel('notes');
  }
  saved();
  toast(comment ? '评论已保存' : '高亮已保存', 1700);
}
function openComment(note = null) {
  if (!note && !app.selected) return;
  app.editingNote = note;
  $('#comment-heading').textContent = note?.comment ? '编辑你的评论' : '记下你的想法';
  $('#comment-quote').textContent = (note || app.selected).quote;
  $('#comment-input').value = note?.comment || '';
  $('#selection-toolbar').hidden = true;
  $('#comment-dialog').showModal();
  $('#comment-input').focus();
}
function locateNote(id) {
  selectedNoteId = id;
  showPanel('notes'); renderNotes();
  const mark = [...article.querySelectorAll('mark[data-annotations]')].find(el => el.dataset.annotations.split(' ').includes(id));
  if (!mark) { toast('原文已变动，暂时无法定位这条批注'); return; }
  mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
  mark.classList.remove('flash'); void mark.offsetWidth; mark.classList.add('flash');
  $(`[data-note-card="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
async function toggleFavorite() {
  if (app.current.id === 'welcome' && !app.documents.some(doc => doc.id === 'welcome')) await db.mergeDocument(welcome);
  const id = app.current.id;
  const updated = await db.mutate('documents', id, old => old ? { ...old, starred: !old.starred, starredAt: Date.now() } : old);
  if (app.current.id === id) { app.current.starred = updated.starred; refreshFavorite(); }
  await loadLibrary(); saved();
  toast(updated.starred ? '已加入我的收藏' : '已取消收藏', 1800);
}
function download(content, name, mime = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
function exportNotes() {
  if (!app.notes.length) { toast('这篇文档还没有批注'); return; }
  const lines = [`# ${app.current.name} · 阅读批注`, '', `导出时间：${new Date().toLocaleString('zh-CN')}`, ''];
  app.notes.forEach((note, i) => {
    lines.push(`## 批注 ${i + 1} · ${HIGHLIGHT_COLORS[note.color]?.label || '暖黄'}`, '', ...note.quote.split('\n').map(line => `> ${line}`), '', note.comment || '*仅高亮*', '', `记录时间：${formatDate(note.createdAt)}`, '');
  });
  download(lines.join('\n'), `${fileName(app.current)}-批注.md`);
}
async function handleArticleLink(event) {
  const a = event.target.closest('a[href]');
  if (!a || !article.contains(a)) return;
  event.preventDefault();
  const href = a.getAttribute('href').trim();
  if (/^(https?:|mailto:)/i.test(href)) { window.open(href, '_blank', 'noopener,noreferrer'); return; }
  const [rawPath, hash = ''] = href.split('#');
  let anchor = '';
  try { anchor = decodeURIComponent(hash); } catch { /* Leave invalid fragments unresolved. */ }
  const jump = () => {
    const text = anchor.replace(/-/g, ' ').toLocaleLowerCase();
    const target = app.outline.find(item => item.text.toLocaleLowerCase() === text || item.id === anchor || item.text.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') === anchor.toLocaleLowerCase());
    if (target) document.getElementById(target.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (anchor) toast('没有找到链接指向的标题');
  };
  if (!rawPath) { jump(); return; }
  let path;
  try { path = db.normalizePath(app.current.path, decodeURIComponent(rawPath)); } catch { return; }
  const doc = app.documents.find(item => item.folderId === app.current.folderId && item.path === path);
  if (doc) { await openDocument(doc, { prompt: true }); if (anchor) requestAnimationFrame(jump); }
  else toast('请先打开链接目标所在的文件夹，再访问相对文档链接');
}

const actions = {
  'open-file': pickFiles,
  'open-folder': pickFolder,
  'welcome': () => openDocument(welcome),
  'toggle-sidebar': () => document.body.classList.toggle('sidebar-collapsed'),
  'toggle-panel': togglePanel,
  'toggle-focus': () => {
    const focused = document.body.classList.toggle('focus-mode');
    $('#focus-button').setAttribute('aria-pressed', String(focused));
    if (focused) toast('已进入专注阅读，按 Esc 退出', 1800);
  },
  'toggle-settings': () => { togglePopover('settings-popover'); togglePopover('more-menu', false); },
  'close-settings': () => togglePopover('settings-popover', false),
  'toggle-more': () => { togglePopover('more-menu'); togglePopover('settings-popover', false); },
  'reset-settings': () => { app.settings = { ...defaults }; saveSettings(); },
  'toggle-favorite': toggleFavorite,
  'comment-selection': () => openComment(),
  'close-comment': () => $('#comment-dialog').close(),
  'reload-document': () => openDocument(app.current, { prompt: true }),
  'refresh-folder': () => { const folder = app.folders.find(item => item.id === app.folderId); if (folder?.handle) return scanFolder(folder); },
  'export-notes': exportNotes,
  'download-markdown': () => download(app.current.content || '', app.current.name),
  'clear-history': async () => { await db.put('state', [], 'history'); await loadLibrary(); toast('最近阅读已清空'); saved(); },
};

function bindEvents() {
  document.addEventListener('click', event => {
    const action = event.target.closest('[data-action]');
    if (action && actions[action.dataset.action]) {
      const name = action.dataset.action;
      // Pickers must run directly inside the click gesture, before any async work.
      try { Promise.resolve(actions[name]()).catch(report); } catch (error) { report(error); }
      if (name !== 'toggle-more') togglePopover('more-menu', false);
    }
    const view = event.target.closest('[data-view]');
    if (view) { app.view = view.dataset.view; $('#library-search').value = ''; renderLibrary(); }
    const doc = event.target.closest('[data-document]');
    if (doc) {
      const target = app.documents.find(item => item.id === doc.dataset.document) || (doc.dataset.document === 'welcome' ? welcome : null);
      if (target) run(() => openDocument(target, { prompt: true }));
    }
    const theme = event.target.closest('[data-theme]');
    if (theme) { app.settings.theme = theme.dataset.theme; app.settings.background = themes[theme.dataset.theme]; saveSettings(); }
    const tab = event.target.closest('[data-panel]');
    if (tab) showPanel(tab.dataset.panel);
    const heading = event.target.closest('[data-heading]');
    if (heading) document.getElementById(heading.dataset.heading)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const color = event.target.closest('[data-highlight]');
    if (color) run(() => saveAnnotation(color.dataset.highlight));
    const locate = event.target.closest('[data-locate-note]');
    if (locate) locateNote(locate.dataset.locateNote);
    const edit = event.target.closest('[data-edit-note]');
    if (edit) openComment(app.notes.find(note => note.id === edit.dataset.editNote));
    const remove = event.target.closest('[data-delete-note]');
    if (remove) run(async () => {
      const id = remove.dataset.deleteNote, docId = app.current.id;
      const note = app.notes.find(item => item.id === id);
      await db.mutate('annotations', id, () => undefined);
      await refreshNotes(docId); saved();
      toast('批注已删除');
      // Deletion is limited to the explicitly selected annotation.
      if (app.editingNote?.id === note?.id) $('#comment-dialog').close();
    });
    const mark = event.target.closest('mark[data-annotations]');
    if (mark && window.getSelection()?.isCollapsed) locateNote(mark.dataset.annotations.split(' ').at(-1));
    if (event.target.closest('#more-menu') && !action) togglePopover('more-menu', false);
    if (!event.target.closest('#settings-popover, #style-button')) togglePopover('settings-popover', false);
    if (!event.target.closest('#more-menu, #more-button')) togglePopover('more-menu', false);
  });
  $('#selection-toolbar').addEventListener('pointerdown', event => event.preventDefault());
  article.addEventListener('pointerup', () => requestAnimationFrame(captureAndShow));
  article.addEventListener('keyup', captureAndShow);
  document.addEventListener('selectionchange', () => {
    if (window.getSelection()?.isCollapsed) $('#selection-toolbar').hidden = true;
  });
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('#selection-toolbar, #article, #comment-dialog')) $('#selection-toolbar').hidden = true;
  });
  article.addEventListener('click', event => run(() => handleArticleLink(event)));
  $('#library-search').addEventListener('input', renderLibrary);
  $('#recursive').addEventListener('change', () => {
    app.recursive = $('#recursive').checked;
    run(() => db.put('state', app.recursive, 'recursive')); renderLibrary();
  });
  $('#file-input').addEventListener('change', event => {
    const entries = [...event.target.files].map(file => ({ file }));
    event.target.value = '';
    run(() => importFiles(entries));
  });
  $('#folder-input').addEventListener('change', event => {
    const files = [...event.target.files];
    event.target.value = '';
    run(() => importFolderFallback(files));
  });
  const settingsInputs = { 'font-family': ['font', String], 'font-size': ['fontSize', Number], 'text-width': ['width', Number], 'line-height': ['lineHeight', Number] };
  for (const [id, [key, convert]] of Object.entries(settingsInputs)) $(`#${id}`).addEventListener('input', event => { app.settings[key] = convert(event.target.value); saveSettings(); });
  $('#custom-color').addEventListener('input', event => { app.settings.background = event.target.value; app.settings.theme = 'custom'; saveSettings(); });
  $('#comment-form').addEventListener('submit', event => {
    event.preventDefault();
    const comment = $('#comment-input').value.trim();
    if (!comment) { $('#comment-input').focus(); return; }
    const button = $('#comment-form button[type=submit]');
    button.disabled = true;
    run(async () => {
      try {
        if (app.editingNote) {
          const documentId = app.editingNote.documentId;
          await db.mutate('annotations', app.editingNote.id, old => old ? { ...old, comment, updatedAt: Date.now() } : old);
          await refreshNotes(documentId); showPanel('notes'); saved();
        } else await saveAnnotation('yellow', comment);
        $('#comment-dialog').close(); app.editingNote = null;
      } finally { button.disabled = false; }
    });
  });
  $('#comment-dialog').addEventListener('click', event => {
    if (event.target !== $('#comment-dialog')) return;
    const rect = $('#comment-dialog').getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('#comment-dialog').close();
  });
  scroller.addEventListener('scroll', () => {
    updateProgress();
    $('#selection-toolbar').hidden = true;
    clearTimeout(positionTimer);
    positionTimer = setTimeout(() => run(() => savePosition()), 350);
  }, { passive: true });
  new ResizeObserver(updateProgress).observe(article);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      run(() => savePosition());
      clearTimeout(settingsTimer);
      run(() => db.put('state', { ...app.settings }, 'settings'));
    }
  });
  document.addEventListener('keydown', event => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o' && !typing) {
      event.preventDefault();
      Promise.resolve(event.shiftKey ? pickFolder() : pickFiles()).catch(report);
    }
    if (event.key === '/' && !typing && !$('#comment-dialog').open) { event.preventDefault(); document.body.classList.remove('sidebar-collapsed'); $('#library-search').focus(); }
    if (event.key === 'Escape') {
      document.body.classList.remove('focus-mode');
      $('#focus-button').setAttribute('aria-pressed', 'false');
      togglePopover('settings-popover', false); togglePopover('more-menu', false);
      $('#selection-toolbar').hidden = true;
    }
  });
  let dragDepth = 0;
  document.addEventListener('dragenter', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false;
  });
  document.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
  document.addEventListener('drop', event => {
    event.preventDefault(); dragDepth = 0; $('#drop-overlay').hidden = true;
    const items = [...(event.dataTransfer.items || [])].filter(item => item.kind === 'file');
    // Acquire promises while the DataTransfer store is still accessible.
    const handles = items.map(item => item.getAsFileSystemHandle?.());
    const files = [...event.dataTransfer.files];
    run(async () => {
      const entries = (await Promise.all(handles)).filter(Boolean);
      if (entries.length) {
        const directories = entries.filter(entry => entry.kind === 'directory');
        for (const handle of directories) {
          const old = await findFolder(handle);
          const folder = { id: old?.id || crypto.randomUUID(), name: handle.name, handle, importedAt: Date.now() };
          await db.put('folders', folder); await scanFolder(folder);
        }
        const fileHandles = entries.filter(entry => entry.kind === 'file');
        if (fileHandles.length) await importFiles(fileHandles.map(handle => ({ handle })));
      } else await importFiles(files.map(file => ({ file })));
    });
  });
  db.onChange(() => run(async () => {
    await loadLibrary();
    const latest = app.documents.find(doc => doc.id === app.current.id);
    if (latest) app.current.starred = latest.starred;
    refreshFavorite(); await refreshNotes();
  }));
}

async function boot() {
  hydrateIcons();
  $('#highlight-options').innerHTML = Object.entries(HIGHLIGHT_COLORS).map(([key, color]) => `<button class="color-dot" data-highlight="${key}" style="--highlight:${color.value}" title="${color.label}高亮" aria-label="${color.label}高亮"></button>`).join('');
  if (navigator.platform.toLowerCase().includes('win') || navigator.platform.toLowerCase().includes('linux')) $('.open-actions kbd').textContent = 'Ctrl O';
  const [settings, active, folderId, recursive] = await Promise.all([db.get('state', 'settings'), db.get('state', 'active-document'), db.get('state', 'active-folder'), db.get('state', 'recursive')]);
  app.settings = normalizeSettings(settings);
  app.folderId = folderId; app.recursive = recursive ?? true;
  applySettings();
  await loadLibrary();
  bindEvents();
  if (innerWidth < 900) { $('#right-panel').hidden = true; $('#panel-toggle').setAttribute('aria-pressed', 'false'); }
  if (innerWidth < 650) document.body.classList.add('sidebar-collapsed');
  await openDocument(app.documents.find(doc => doc.id === active) || welcome, { record: false, initial: true });
  document.documentElement.dataset.ready = 'true';
}
run(boot);
