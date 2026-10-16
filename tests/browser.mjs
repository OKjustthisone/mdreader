import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const profile = await mkdtemp(resolve(tmpdir(), 'inkstone-browser-'));
const dist = resolve(root, 'dist');
const artifacts = resolve(root, 'test-results');
await mkdir(artifacts, { recursive: true });
const launch = () => chromium.launchPersistentContext(profile, {
  headless: true,
  channel: 'chromium',
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let context, page;
const errors = [];
let passed = 0;
async function step(name, fn) {
  await fn(); passed++;
  console.log(`✓ ${name}`);
}
async function ready() { await page.waitForSelector('html[data-ready="true"]', { timeout: 10000 }); }
async function readDB(store, key) {
  return page.evaluate(async ({ store, key }) => {
    const db = await new Promise((res, rej) => { const req = indexedDB.open('inkstone-reader', 1); req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    const result = await new Promise((res, rej) => { const req = db.transaction(store).objectStore(store).get(key); req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    db.close();
    // FileSystemHandles cannot be sent over the Playwright protocol.
    return JSON.parse(JSON.stringify(result ?? null));
  }, { store, key });
}
async function selectText(quote) {
  await page.evaluate(quote => {
    const root = document.getElementById('article');
    const text = root.textContent;
    const start = text.indexOf(quote);
    if (start < 0) throw new Error(`找不到选区：${quote}`);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let offset = 0, first, last;
    while (walker.nextNode()) {
      const node = walker.currentNode, end = offset + node.length;
      if (!first && start >= offset && start < end) first = [node, start - offset];
      if (start + quote.length > offset && start + quote.length <= end) { last = [node, start + quote.length - offset]; break; }
      offset = end;
    }
    const range = document.createRange();
    range.setStart(...first); range.setEnd(...last);
    first[0].parentElement.scrollIntoView({ block: 'center', behavior: 'instant' });
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, quote);
  await expect(page.locator('#selection-toolbar')).toBeVisible();
}
const longText = Array.from({ length: 35 }, (_, i) => `### 章节 ${i + 1}\n\n让每一段文字都拥有合适的留白。阅读的意义，在于与自己的想法相遇。第 ${i + 1} 段保留足够的内容，验证长篇文档的阅读位置可以恢复。\n`).join('\n');
const sample = `# 阅读实验室\n\n第一段值得留下的文字。\n\n跨越 **粗体文字** 与普通文本的批注。\n\n评论让我记住此刻的想法。\n\n- [x] 已阅读\n- [ ] 待读\n\n| 主题 | 说明 |\n| --- | --- |\n| 阅读 | 有光也有留白 |\n\n\`\`\`javascript\nconst quiet = '阅读';\n\`\`\`\n\n${longText}`;
try {
  context = await launch();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).hostname;
  const url = `chrome-extension://${id}/index.html`;
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error('浏览器控制台：', message.text()); });
  page.on('requestfailed', request => console.error('请求失败：', request.url(), request.failure()?.errorText));
  await page.goto(url); await ready();
  await step('实际 Manifest V3 扩展加载与中文阅读界面', async () => {
    expect(await page.evaluate(() => chrome.runtime.getManifest().manifest_version)).toBe(3);
    await expect(page.locator('#article h1')).toHaveText('留一点空间，给阅读。');
    await expect(page.locator('#outline-list button')).toHaveCount(6);
    await page.screenshot({ path: resolve(artifacts, '01-welcome.png') });
  });
  await step('打开 Markdown 文件，渲染表格、代码和任务列表', async () => {
    await page.locator('#file-input').setInputFiles({ name: '阅读实验室.md', mimeType: 'text/markdown', buffer: Buffer.from(sample) });
    await expect(page.locator('#article h1')).toHaveText('阅读实验室');
    await expect(page.locator('#article table')).toHaveCount(1);
    await expect(page.locator('#article code .hljs-keyword')).toHaveText('const');
    await expect(page.locator('#article .task-checkbox')).toHaveCount(2);
    await expect(page.locator('#history-count')).toHaveText('1');
  });
  await step('两个独立高亮以及跨粗体选区同时存在', async () => {
    await selectText('第一段值得留下的文字');
    await page.getByRole('button', { name: '暖黄高亮', exact: true }).click();
    await expect(page.locator('#notes-count')).toHaveText('1');
    await selectText('跨越 粗体文字 与普通文本');
    await page.getByRole('button', { name: '浅绿高亮', exact: true }).click();
    await expect(page.locator('#notes-count')).toHaveText('2');
    await expect(page.locator('mark[data-color="yellow"]')).toHaveCount(1);
    await expect(page.locator('mark[data-color="green"]')).toHaveCount(3);
  });
  await step('添加评论并在页面刷新后恢复全部批注', async () => {
    await selectText('评论让我记住此刻的想法');
    await page.getByRole('button', { name: '添加评论', exact: true }).first().click();
    await page.locator('#comment-input').fill('刷新后仍然存在的阅读想法。');
    await page.getByRole('button', { name: '保存评论', exact: true }).click();
    await expect(page.locator('#notes-count')).toHaveText('3');
    await page.reload(); await ready();
    await expect(page.locator('#notes-count')).toHaveText('3');
    await page.locator('#notes-tab').click();
    await expect(page.locator('.note-comment')).toHaveText('刷新后仍然存在的阅读想法。');
    await expect(page.locator('mark.has-comment')).toHaveCount(1);
  });
  await step('编辑、定位、删除批注，其他记录保持完整', async () => {
    const card = page.locator('.note-card').filter({ hasText: '刷新后仍然存在的阅读想法。' });
    await card.getByRole('button', { name: '编辑评论' }).click();
    await page.locator('#comment-input').fill('修改后的评论。');
    await page.getByRole('button', { name: '保存评论', exact: true }).click();
    await expect(page.locator('.note-comment')).toHaveText('修改后的评论。');
    await page.locator('.note-card').first().locator('.note-quote').click();
    await expect(page.locator('mark.flash')).toHaveCount(1);
    await page.locator('.note-card').first().getByRole('button', { name: '删除批注' }).click();
    await expect(page.locator('#notes-count')).toHaveText('2');
    await expect(page.locator('.note-comment')).toHaveText('修改后的评论。');
  });
  await step('字号、字体、显示比例、行距和深色背景保存与恢复', async () => {
    await page.locator('#style-button').click();
    await page.locator('[data-theme="night"]').click();
    await page.locator('#font-family').selectOption('serif');
    await page.evaluate(() => {
      for (const [id, value] of [['font-size', '21'], ['text-width', '65'], ['line-height', '2.2']]) {
        const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await expect.poll(async () => (await readDB('state', 'settings'))?.fontSize).toBe(21);
    await page.reload(); await ready();
    expect(await page.locator('html').getAttribute('data-ui')).toBe('dark');
    expect(await page.locator('#article').evaluate(el => getComputedStyle(el).fontSize)).toBe('21px');
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--text-width'))).toBe('52%');
    const settings = await readDB('state', 'settings');
    expect(settings).toMatchObject({ font: 'serif', fontSize: 21, width: 65, lineHeight: 2.2 });
    await page.locator('#style-button').click();
    await page.screenshot({ path: resolve(artifacts, '02-reading-settings.png') });
    await page.locator('[data-action="reset-settings"]').click();
    await expect.poll(async () => (await readDB('state', 'settings'))?.fontSize).toBe(17);
    await page.locator('[data-action="close-settings"]').click();
  });
  await step('旧版像素宽度设置自动换算为显示比例并写回', async () => {
    await page.evaluate(async () => {
      const db = await new Promise((res, rej) => { const req = indexedDB.open('inkstone-reader', 1); req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
      await new Promise((res, rej) => {
        const tx = db.transaction('state', 'readwrite');
        tx.objectStore('state').put({ theme: 'paper', background: '#fbfaf7', font: 'system', fontSize: 17, width: 760, lineHeight: 1.9 }, 'settings');
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      db.close();
    });
    await page.reload(); await ready();
    // 启动时会把旧的像素值换算并写回，等待写回完成后再读取
    await expect.poll(async () => (await readDB('state', 'settings'))?.width).toBeLessThanOrEqual(100);
    const settings = await readDB('state', 'settings');
    expect(settings.width).toBeGreaterThanOrEqual(40);
    expect(settings.width % 5).toBe(0);
    // 换算按当前阅读区宽度进行，正文列宽应与旧的 760 px 基本一致
    const text = await page.locator('#article').evaluate(el => el.getBoundingClientRect().width);
    expect(Math.abs(text - 760)).toBeLessThan(30);
    expect(await page.locator('#text-width-value').textContent()).toBe(`${settings.width}%`);
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--text-width'))).toBe(`${settings.width * 4 / 5}%`);
  });
  await step('收藏快速打开与长文阅读位置恢复', async () => {
    await page.locator('#favorite-button').click();
    await expect(page.locator('#favorites-count')).toHaveText('1');
    await page.locator('[data-view="favorites"]').click();
    await expect(page.locator('.file-row')).toHaveCount(1);
    await page.locator('#reading-scroll').evaluate(el => { el.scrollTop = (el.scrollHeight - el.clientHeight) * .66; });
    const documentId = await readDB('state', 'active-document');
    await expect.poll(async () => (await readDB('documents', documentId))?.progress).toBeGreaterThan(.64);
    await page.reload(); await ready();
    await expect(page.locator('#favorite-button')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => parseInt(await page.locator('#reading-progress').textContent())).toBeGreaterThan(63);
  });
  await step('批注导出为可读取的 Markdown 文件', async () => {
    await page.locator('#more-button').click();
    const pending = page.waitForEvent('download');
    await page.locator('[data-action="export-notes"]').click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe('阅读实验室-批注.md');
    const content = await readFile(await download.path(), 'utf8');
    expect(content).toContain('修改后的评论。');
    expect(content).toContain('粗体文字');
  });
  await step('原生文件系统句柄扫描目录、子目录、图片与 Markdown 链接', async () => {
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('知识花园', { create: true });
      const sub = await folder.getDirectoryHandle('guides', { create: true });
      const assets = await folder.getDirectoryHandle('assets', { create: true });
      async function write(directory, name, content) {
        const handle = await directory.getFileHandle(name, { create: true });
        const writer = await handle.createWritable(); await writer.write(content); await writer.close();
      }
      await write(folder, 'README.md', '# 知识花园\n\n一段可以长久保存的文字。\n\n前往[细读](guides/细读.md#细读)\n\n![一颗像素](assets/pixel.png)\n\n- [x] 已完成');
      await write(sub, '细读.md', '# 细读\n\n读到这里，也看见自己的想法。\n\n[返回首页](../README.md)');
      await write(folder, '另一本笔记.MD', '# 另一本笔记\n\n全大写扩展名也能识别。');
      await write(folder, 'ignore.txt', '非 Markdown 不显示');
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      await write(assets, 'pixel.png', new Blob([bytes], { type: 'image/png' }));
      window.showDirectoryPicker = async () => folder;
      window.showOpenFilePicker = async () => [await folder.getFileHandle('README.md')];
    });
    await page.locator('[data-action="open-folder"]').click();
    await expect(page.locator('.file-row[title="README.md"]')).toHaveCount(1);
    await expect(page.locator('.file-row[title="guides/细读.md"]')).toHaveCount(1);
    await expect(page.locator('.file-row[title="ignore.txt"]')).toHaveCount(0);
    await page.locator('.file-row[title="README.md"]').click();
    await expect(page.locator('#article h1')).toHaveText('知识花园');
    await expect.poll(() => page.locator('#article img').evaluate(img => img.naturalWidth)).toBe(1);
    await page.getByRole('link', { name: '细读', exact: true }).click();
    await expect(page.locator('#article h1')).toHaveText('细读');
    await page.getByRole('link', { name: '返回首页', exact: true }).click();
    await expect(page.locator('#article h1')).toHaveText('知识花园');
    await page.locator('#recursive').uncheck();
    await expect(page.locator('.file-row[title="guides/细读.md"]')).toHaveCount(0);
    await page.locator('#recursive').check();
    await page.locator('#library-search').fill('细读');
    await expect(page.locator('.file-row')).toHaveCount(1);
    await page.locator('#library-search').fill('');
  });
  await step('原生打开文件去重、文件修改后重读与批注重新定位', async () => {
    await selectText('一段可以长久保存的文字');
    await page.getByRole('button', { name: '雾蓝高亮' }).click();
    await expect(page.locator('#notes-count')).toHaveText('1');
    const before = await page.locator('#files-count').textContent();
    await page.locator('.open-actions [data-action="open-file"]').click();
    await expect(page.locator('#files-count')).toHaveText(before);
    await page.evaluate(async () => {
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('知识花园');
      const handle = await folder.getFileHandle('README.md');
      const content = await (await handle.getFile()).text();
      const writer = await handle.createWritable(); await writer.write('# 更新的知识花园\n\n新增的一段前言。\n\n' + content); await writer.close();
    });
    await page.locator('#reload-document').click();
    await expect(page.locator('#article h1').first()).toHaveText('更新的知识花园');
    await expect(page.locator('mark[data-color="blue"]')).toHaveText('一段可以长久保存的文字');
    await expect(page.locator('#notes-count')).toHaveText('1');
    await page.locator('#favorite-button').click();
    await page.locator('#notes-tab').click();
    await page.screenshot({ path: resolve(artifacts, '03-folder-and-annotations.png') });
  });
  await step('浏览器上下文关闭重启后，原生句柄、批注与收藏仍保留', async () => {
    await context.close();
    context = await launch();
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await ready();
    await expect(page.locator('#article h1').first()).toHaveText('更新的知识花园');
    await expect(page.locator('#notes-count')).toHaveText('1');
    await expect(page.locator('#favorite-button')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('mark[data-color="blue"]')).toHaveCount(1);
    await page.locator('#refresh-folder').click();
    await expect(page.locator('#refresh-folder')).toBeEnabled();
    await expect(page.locator('#favorite-button')).toHaveAttribute('aria-pressed', 'true');
  });
  await step('刷新读取外部更新并保存新副本，权限过期后可继续阅读', async () => {
    await page.evaluate(async () => {
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('知识花园');
      const handle = await folder.getFileHandle('README.md');
      const content = await (await handle.getFile()).text();
      const writer = await handle.createWritable(); await writer.write(content + '\n\n最新增加的离线内容。'); await writer.close();
    });
    await page.reload(); await ready();
    await expect(page.locator('#article')).toContainText('最新增加的离线内容。');
    const id = await readDB('state', 'active-document');
    expect((await readDB('documents', id)).content).toContain('最新增加的离线内容。');
    const permissionScript = await page.addInitScript(() => { FileSystemFileHandle.prototype.queryPermission = async () => 'prompt'; });
    await page.reload(); await ready();
    await expect(page.locator('#source-notice')).toContainText('本地保存的副本');
    await expect(page.locator('#article')).toContainText('最新增加的离线内容。');
    await expect(page.locator('#notes-count')).toHaveText('1');
    await expect(page.locator('#favorite-button')).toHaveAttribute('aria-pressed', 'true');
    // This controlled permission simulation remains scoped to this test profile.
  });
  await step('HTML 清理阻止脚本、事件处理器、伪造操作按钮与危险链接', async () => {
    const attack = '# 安全阅读\n\n<script>window.inkstonePwned=1</script>\n<img src=x onerror="window.inkstonePwned=2">\n<a href="javascript:window.inkstonePwned=3">危险链接</a>\n<button data-action="clear-history">伪造按钮</button>\n<div style="position:fixed;inset:0" data-action="clear-history" id="sidebar">内容</div>';
    await page.locator('#file-input').setInputFiles({ name: '安全测试.md', mimeType: 'text/markdown', buffer: Buffer.from(attack) });
    await expect(page.locator('#article h1').first()).toHaveText('安全阅读');
    expect(await page.evaluate(() => window.inkstonePwned)).toBeUndefined();
    await expect(page.locator('#article script,#article button,#article [onerror],#article [data-action],#article [style]')).toHaveCount(0);
    await expect(page.locator('#article a[href^="javascript:"]')).toHaveCount(0);
    await expect(page.locator('#sidebar')).toHaveCount(1);
  });
  await step('25 份真实打开记录仅保留最近 20 条，重复打开不增加条数', async () => {
    const files = Array.from({ length: 25 }, (_, i) => ({ name: `历史-${String(i).padStart(2, '0')}.md`, mimeType: 'text/markdown', buffer: Buffer.from(`# 历史 ${i}\n\n第 ${i} 份阅读记录。`) }));
    await page.locator('#file-input').setInputFiles(files);
    await expect(page.locator('#article h1')).toHaveText('历史 0');
    await page.locator('[data-view="files"]').click();
    for (let i = 1; i < 25; i++) {
      await page.locator(`.file-row[title="历史-${String(i).padStart(2, '0')}.md"]`).click();
      await expect(page.locator('#article h1')).toHaveText(`历史 ${i}`);
    }
    await page.locator('[data-view="history"]').click();
    await expect(page.locator('#history-count')).toHaveText('20');
    await expect(page.locator('.file-row')).toHaveCount(20);
    expect(await page.locator('.file-row').first().getAttribute('title')).toBe('历史-24.md');
    expect(await page.locator('.file-row').last().getAttribute('title')).toBe('历史-05.md');
    await page.locator('.file-row[title="历史-10.md"]').click();
    await expect(page.locator('.file-row').first()).toHaveAttribute('title', '历史-10.md');
    await expect(page.locator('.file-row')).toHaveCount(20);
  });
  await step('窄窗口阅读与专注模式无横向页面溢出', async () => {
    await page.setViewportSize({ width: 620, height: 850 });
    await page.reload(); await ready();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#sidebar')).toBeHidden();
    await page.locator('#focus-button').click();
    await expect(page.locator('body')).toHaveClass(/focus-mode/);
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
    await page.screenshot({ path: resolve(artifacts, '04-narrow-window.png') });
  });
  const diagramExample = await readFile(resolve(root, 'examples/mermaid-flowchart.md'), 'utf8');
  const diagramSource = diagramExample.match(/~~~mermaid\r?\n([\s\S]*?)\r?\n~~~/)[1];
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.reload(); await ready();
  await context.setOffline(true);
  await page.evaluate(() => {
    window.diagramCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.diagramCspViolations.push(event.violatedDirective));
  });
  await step('离线 MV3 扩展渲染用户原始中文流程图，12 个节点和 11 条连线完整', async () => {
    await page.locator('#file-input').setInputFiles({ name: 'Mermaid流程图.md', mimeType: 'text/markdown', buffer: Buffer.from(diagramExample) });
    const host = page.locator('.mermaid-block');
    await expect(host).toHaveAttribute('data-diagram-state', 'ready', { timeout: 20000 });
    await expect(host.locator('svg .node')).toHaveCount(12);
    await expect(host.locator('svg .edgePaths path')).toHaveCount(11);
    const labels = (await host.locator('svg .node text').allTextContents()).join('').replace(/\s/g, '');
    expect(labels).toContain('人TCR/CD3信号');
    expect(labels).toContain('xGVHD');
    const text = await page.locator('#article').textContent();
    await host.getByRole('button', { name: '查看源码', exact: true }).click();
    expect(await page.locator('#article').textContent()).toBe(text);
    await host.getByRole('button', { name: '收起源码', exact: true }).click();
    const width = await host.locator('svg').evaluate(svg => svg.getBoundingClientRect().width);
    await host.getByRole('button', { name: '放大图表', exact: true }).click();
    expect(await host.locator('svg').evaluate(svg => svg.getBoundingClientRect().width)).toBeGreaterThan(width);
    await host.getByRole('button', { name: '适应', exact: true }).click();
    expect(await page.evaluate(() => window.diagramCspViolations)).toEqual([]);
    await page.screenshot({ path: resolve(artifacts, '05-mermaid-flowchart.png') });
  });
  await step('图表异步渲染、切换深色与刷新后，图后正文批注位置保持正确', async () => {
    const host = page.locator('.mermaid-block');
    await selectText('图后这段文字用于记录阅读思考');
    await page.getByRole('button', { name: '柔粉高亮', exact: true }).click();
    await expect(page.locator('#notes-count')).toHaveText('1');
    const before = await host.locator('svg').getAttribute('id');
    const text = await page.locator('#article').textContent();
    await page.locator('#style-button').click();
    await page.locator('[data-theme="night"]').click();
    await expect.poll(() => host.locator('svg').getAttribute('id')).not.toBe(before);
    expect(await page.locator('#article').textContent()).toBe(text);
    await expect(page.locator('mark[data-color="pink"]')).toHaveText('图后这段文字用于记录阅读思考');
    await expect.poll(async () => (await readDB('state', 'settings'))?.theme).toBe('night');
    await page.reload(); await ready();
    await expect(host).toHaveAttribute('data-diagram-state', 'ready', { timeout: 20000 });
    await expect(page.locator('mark[data-color="pink"]')).toHaveText('图后这段文字用于记录阅读思考');
    await expect(page.locator('#notes-count')).toHaveText('1');
    await page.locator('#style-button').click();
    await page.locator('[data-action="reset-settings"]').click();
    await page.locator('[data-action="close-settings"]').click();
  });
  await step('直接以 flowchart TD 开头的文件以及未标注语言的图表代码块均可渲染', async () => {
    await page.locator('#file-input').setInputFiles({ name: '独立流程图.md', mimeType: 'text/markdown', buffer: Buffer.from(diagramSource) });
    await expect(page.locator('.mermaid-block')).toHaveAttribute('data-diagram-state', 'ready', { timeout: 20000 });
    await expect(page.locator('.mermaid-block svg .node')).toHaveCount(12);
    const unnamed = ['# 未标注语言', '', '~~~', 'flowchart LR', 'A[起点] --> B[终点]', '~~~'].join('\n');
    await page.locator('#file-input').setInputFiles({ name: '未标注语言.md', mimeType: 'text/markdown', buffer: Buffer.from(unnamed) });
    await expect(page.locator('#article h1')).toHaveText('未标注语言');
    await expect(page.locator('.mermaid-block')).toHaveAttribute('data-diagram-state', 'ready', { timeout: 20000 });
    await expect(page.locator('.mermaid-block svg .node')).toHaveCount(2);
  });
  await step('错误图表保留源码，后续时序图继续渲染，图表配置无法覆盖扩展安全设置', async () => {
    const definitions = ['# 图表容错', '', '~~~mermaid', 'flowchart TD', 'A[未闭合 --> B', '~~~', '', '~~~mermaid', 'sequenceDiagram', '读者->>墨读: 打开文档', '墨读-->>读者: 显示图表', '~~~', '', '~~~mermaid', '%%{init: {"securityLevel":"loose","themeCSS":"body { display:none }","htmlLabels":true}}%%', 'flowchart LR', 'A[开始] --> B[结束]', 'click A "javascript:window.diagramPwned=1"', '~~~'].join('\n');
    await page.locator('#file-input').setInputFiles({ name: '图表容错.md', mimeType: 'text/markdown', buffer: Buffer.from(definitions) });
    await expect(page.locator('#article h1')).toHaveText('图表容错');
    await expect(page.locator('.mermaid-block[data-diagram-state="error"]')).toHaveCount(1, { timeout: 20000 });
    await expect(page.locator('.mermaid-block[data-diagram-state="ready"]')).toHaveCount(2, { timeout: 20000 });
    await expect(page.locator('.mermaid-block').first().locator('.message')).toContainText('源码已保留');
    await expect(page.locator('.mermaid-block').first().locator('pre')).toBeVisible();
    await expect(page.locator('.mermaid-block svg foreignObject,.mermaid-block svg a,.mermaid-block svg script')).toHaveCount(0);
    await expect(page.locator('body')).toBeVisible();
    expect(await page.evaluate(() => window.diagramPwned)).toBeUndefined();
    expect(await page.evaluate(() => window.diagramCspViolations || [])).toEqual([]);
    await expect(page.locator('.mermaid-measure')).toHaveCount(0);
  });
  expect(errors).toEqual([]);
  console.log(`\n${passed} 组浏览器验收通过；无未捕获页面错误。截图：${artifacts}`);
} catch (error) {
  console.error('页面错误：', errors);
  if (page && !page.isClosed()) console.error('页面状态：', await page.locator('#toast').textContent().catch(() => ''));
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(artifacts, 'failure.png') }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
