import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { locateAnchor } from '../src/annotations.js';
import * as db from '../src/db.js';
import * as sync from '../src/sync.js';
import { isDiagramSource } from '../src/diagram-source.js';
import { coerceReadingStyle, defaults } from '../src/reading-style.js';

test('最近阅读仅保留 20 条，不重复，重开后移动到首位', async () => {
  for (let i = 0; i < 25; i++) await db.recordVisit(`doc-${i}`);
  let history = await db.get('state', 'history');
  assert.equal(history.length, 20);
  assert.equal(history[0], 'doc-24');
  assert.equal(history.at(-1), 'doc-5');
  await db.recordVisit('doc-10');
  history = await db.get('state', 'history');
  assert.equal(history[0], 'doc-10');
  assert.equal(history.length, 20);
  assert.equal(new Set(history).size, 20);
});
test('并发独立高亮和评论持久保存，同一文档互不覆盖', async () => {
  await Promise.all(Array.from({ length: 25 }, (_, i) => db.put('annotations', { id: `note-${i}`, documentId: 'test', start: i, quote: `摘录${i}`, comment: i % 2 ? '评论' : '' })));
  let notes = await db.notesFor('test');
  assert.equal(notes.length, 25);
  await db.mutate('annotations', 'note-3', old => ({ ...old, comment: '修改的评论' }));
  await db.mutate('annotations', 'note-4', () => undefined);
  notes = await db.notesFor('test');
  assert.equal(notes.length, 24);
  assert.equal(notes.find(note => note.id === 'note-3').comment, '修改的评论');
  assert.equal(notes.find(note => note.id === 'note-5').comment, '评论');
});
test('重新扫描保留文档内容、阅读位置和收藏状态', async () => {
  await db.mergeDocument({ id: 'folder:a.md', content: '内容', progress: .6, starred: true });
  await db.putDocuments([{ id: 'folder:a.md', name: 'a.md', path: 'a.md' }]);
  let doc = await db.get('documents', 'folder:a.md');
  assert.equal(doc.starred, true); assert.equal(doc.content, '内容'); assert.equal(doc.progress, .6);
  await db.mergeDocument({ id: doc.id, content: '更新的内容' });
  doc = await db.get('documents', doc.id);
  assert.equal(doc.starred, true); assert.equal(doc.content, '更新的内容');
});
test('同一记录的并发更改通过事务串行，保留全部更新', async () => {
  await db.put('documents', { id: 'concurrent', count: 0 });
  await Promise.all(Array.from({ length: 30 }, () => db.mutate('documents', 'concurrent', old => ({ ...old, count: old.count + 1 }))));
  assert.equal((await db.get('documents', 'concurrent')).count, 30);
});
test('文件变动后根据文本及上下文恢复批注，歧义时保留未定位状态', () => {
  const note = { start: 3, end: 6, quote: '高亮句', prefix: '前文 ', suffix: ' 后文' };
  assert.equal(locateAnchor('新增文字 前文 高亮句 后文', note).start, 8);
  assert.equal(locateAnchor('第一处高亮句 第二处高亮句', { ...note, prefix: '', suffix: '' }), null);
  assert.equal(locateAnchor('文字已完全修改', note), null);
  assert.deepEqual(locateAnchor('abc高亮句def', note), { start: 3, end: 6 });
});
test('识别 Markdown 扩展名并规范化相对文档、图片路径', () => {
  assert.equal(db.markdownFile('README.MD'), true);
  assert.equal(db.markdownFile('test.markdown'), true);
  assert.equal(db.markdownFile('a.md.exe'), false);
  assert.equal(db.normalizePath('docs/a.md', '../images/a.png'), 'images/a.png');
  assert.equal(db.normalizePath('a.md', '../../secret.txt'), null);
});
test('识别独立 Mermaid 定义，保留普通文字和有标题的 Markdown', () => {
  assert.equal(isDiagramSource('  flowchart TD\nA[中文] --> B[分支]'), true);
  assert.equal(isDiagramSource('graph LR; A --> B'), true);
  assert.equal(isDiagramSource('sequenceDiagram\nA->>B: 你好'), true);
  assert.equal(isDiagramSource('这是 flowchart TD 的说明'), false);
  assert.equal(isDiagramSource('# 标题\n\nflowchart TD\nA --> B'), false);
  assert.equal(isDiagramSource('const flowchart = 1;'), false);
});
test('本地写入带同步时间戳，删除留下墓碑，state 按键记录时间', async () => {
  await db.put('documents', { id: 'stamp-doc', content: 'x' });
  assert.ok((await db.get('documents', 'stamp-doc')).updatedAt > 0);
  await db.put('state', { fontSize: 18 }, 'settings');
  assert.ok((await db.allState()).__times.settings > 0);
  await db.mutate('annotations', 'note-0', () => undefined);          // 删除已有批注 → 墓碑
  const tombstones = await db.get('state', '__tombstones');
  assert.ok(tombstones.annotations['note-0'] > 0);
  await db.mutate('documents', 'stamp-doc', () => undefined);          // 删除文档 → 墓碑
  assert.ok((await db.get('state', '__tombstones')).documents['stamp-doc'] > 0);
  assert.equal(await db.get('documents', 'stamp-doc'), undefined);
});
test('合并规则：整条按时间胜负，收藏与进度按各自时钟，句柄留在本机', () => {
  const local = { id: 'd', name: 'a.md', content: '旧内容', starred: false, starredAt: 0, progress: .2, progressAt: 100, updatedAt: 100, handle: '本机句柄' };
  const remote = { id: 'd', name: 'a.md', content: '新内容', starred: true, starredAt: 90, progress: .7, progressAt: 50, updatedAt: 200 };
  const merged = sync.mergeDoc(local, remote);
  assert.equal(merged.content, '新内容');        // 对端较新 → 用对端
  assert.equal(merged.starred, true);            // 收藏按 starredAt：对端较新
  assert.equal(merged.progress, .2);             // 进度按 progressAt：本机较新
  assert.equal(merged.handle, '本机句柄');        // 文件句柄永不跨浏览器
  assert.equal(merged.updatedAt, 200);
  // 对端只有扫出来的句柄记录时，本机保存的离线内容不能丢
  const scanned = sync.mergeDoc({ id: 'd', content: '离线副本', updatedAt: 50 }, { id: 'd', available: true, updatedAt: 60 });
  assert.equal(scanned.content, '离线副本');
});
test('最近阅读取并集、清空以较晚者为准；删除墓碑取并集', () => {
  assert.deepEqual(sync.mergeHistory(['a'], ['b'], 5, 3), ['a', 'b']);
  assert.deepEqual(sync.mergeHistory(['a'], ['b'], 3, 5), ['b', 'a']);
  assert.deepEqual(sync.mergeHistory([], ['b'], 9, 3), []);
  assert.deepEqual(sync.mergeHistory(['a'], [], 3, 9), []);
  assert.deepEqual(sync.mergeHistory(['a'], ['b', 'a'], 3, 5), ['b', 'a']);
  const merged = sync.mergeTombstones({ annotations: { x: 10 } }, { annotations: { y: 20 }, documents: { z: 5 } });
  assert.deepEqual(merged.annotations, { x: 10, y: 20 });
  assert.deepEqual(merged.documents, { z: 5 });
});
test('序列化与键顺序无关，避免两端误判成“有改动”', () => {
  assert.equal(sync.canonical({ b: 1, a: [2, { d: 4, c: 3 }] }), sync.canonical({ a: [2, { c: 3, d: 4 }], b: 1 }));
  assert.notEqual(sync.canonical({ a: 1 }), sync.canonical({ a: 2 }));
  assert.equal(sync.canonical(undefined), 'null');
});
test('拉取远端数据：新增与更新生效，对端删除不复活，设置按键取新', async () => {
  const future = Date.now() + 60000;
  await db.put('annotations', { id: 'keep-note', documentId: 'doc-1', start: 0, quote: '保留', comment: '', createdAt: 1, updatedAt: 1 });
  await db.put('annotations', { id: 'doomed-note', documentId: 'doc-1', start: 1, quote: '将被删除', createdAt: 1, updatedAt: 1 });
  const changed = await sync.applyRemote({
    documents: { records: [] },
    annotations: { records: [
      { id: 'remote-note', documentId: 'doc-2', start: 1, quote: '远端批注', comment: '来自另一个浏览器', createdAt: 2, updatedAt: 2 },
      { id: 'keep-note', documentId: 'doc-1', start: 0, quote: '保留', comment: '远端评论', createdAt: 1, updatedAt: future },
    ] },
    folders: { records: [] },
    state: {
      values: { settings: { fontSize: 21 }, history: ['doc-remote'], __tombstones: { annotations: { 'doomed-note': future } } },
      times: { settings: future, history: future },
    },
  });
  assert.ok(changed.includes('annotations'));
  assert.ok(changed.includes('state'));
  const notes = await db.notesFor('doc-1');
  assert.ok(notes.some(note => note.id === 'remote-note') === false);     // remote-note 属于 doc-2
  assert.equal(notes.find(note => note.id === 'keep-note').comment, '远端评论');
  assert.ok(!notes.some(note => note.id === 'doomed-note'));              // 对端删除生效
  assert.ok((await db.all('annotations')).some(note => note.id === 'remote-note'));
  assert.equal((await db.get('state', 'settings')).fontSize, 21);         // 设置按键：对端更新
  const history = await db.get('state', 'history');
  assert.equal(history[0], 'doc-remote');                                 // 并集：对端最近阅读在首位
  assert.equal(history.length, 21);
  const tombstones = await db.get('state', '__tombstones');
  assert.ok(tombstones.annotations['note-0']);                            // 本机墓碑被并集保留
  assert.ok(tombstones.annotations['doomed-note']);
});
test('推送载荷剥掉文件句柄，本机专属键不外传', async () => {
  await db.put('folders', { id: 'folder-x', name: '笔记', handle: { kind: 'directory' }, importedAt: 1 });
  await db.put('state', { fake: 'handle' }, '__sync-handle');
  await db.put('state', { name: 'a.md', path: 'C:/a.md', content: '# a' }, 'pending-file-open');
  const payload = await sync.buildPayload();
  const folder = payload.folders.records.find(item => item.id === 'folder-x');
  assert.ok(folder);
  assert.ok(!('handle' in folder));                       // 句柄无法跨浏览器
  assert.ok(payload.state.times);                         // __times 作为 times 单独随行
  assert.ok(!('__times' in payload.state.values));
  assert.ok(!('__sync-handle' in payload.state.values));  // 同步句柄只属于本浏览器
  assert.ok(!('pending-file-open' in payload.state.values)); // 双击文件的交接只属于本标签页
  assert.ok(payload.state.values.__tombstones);           // 删除要传给对端
});
test('阅读样式宽容整理：非法值回落默认，越界值收敛到滑块范围', () => {
  assert.deepEqual(coerceReadingStyle(undefined), defaults);
  const coerced = coerceReadingStyle({ theme: 'nope', background: 'red', font: 'comic', fontSize: 99, width: 760, lineHeight: 'x', outlineSize: 2 });
  assert.equal(coerced.theme, 'paper');
  assert.equal(coerced.background, defaults.background);
  assert.equal(coerced.font, 'system');
  assert.equal(coerced.fontSize, 32);
  assert.equal(coerced.width, 100);              // 旧像素宽度不在此迁移，先收敛到最大比例
  assert.equal(coerced.lineHeight, 1.9);
  assert.equal(coerced.outlineSize, 10);
  const valid = coerceReadingStyle({ theme: 'custom', background: '#ABCDEF', font: 'serif', fontSize: 21, width: 65, lineHeight: 2.2, outlineSize: 15 });
  assert.deepEqual(valid, { theme: 'custom', background: '#ABCDEF', font: 'serif', fontSize: 21, width: 65, lineHeight: 2.2, outlineSize: 15 });
});
test.after(async () => { (await db.database()).close(); db.closeChannel(); });
