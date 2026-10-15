import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { locateAnchor } from '../src/annotations.js';
import * as db from '../src/db.js';

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
test.after(async () => { (await db.database()).close(); db.closeChannel(); });
