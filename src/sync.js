import * as db from './db.js';

// 跨浏览器共享同步：把资料库、收藏、最近阅读、高亮与评论、阅读设置序列化成
// 共享文件夹里的 JSON。每个浏览器各授权一次该文件夹，之后启动时与定时轮询
// 双向读写合并，同一台设备上的不同浏览器就能共用同一份数据。
//
// 约定：
// - inkstone-meta.json 最后写入；rev 变化表示另一端已写完整批数据，读者再整批重读。
// - 文档/批注/文件夹逐条合并：updatedAt 决定整体胜负，收藏(starredAt)与阅读进度
//   (progressAt) 各有自己的时钟；删除通过 state.__tombstones 墓碑传播。
// - state 按键合并：__times 记录每个键的写入时间，新者胜；history 取并集，
//   __tombstones 取并集（否则一端的删除会被另一端复活）。
// - 文件句柄无法跨浏览器序列化，推送前剥掉 handle；合并时保留本机的 handle。
// - 所有读写都排进同一个串行队列，推送与拉取不会交叠写坏文件。
const FILES = {
  meta: 'inkstone-meta.json',
  documents: 'inkstone-documents.json',
  annotations: 'inkstone-annotations.json',
  folders: 'inkstone-folders.json',
  state: 'inkstone-state.json',
};
const SCHEMA = 1;
const POLL_MS = 3000;
const PUSH_DELAY = 1500;
const PUSH_MIN_INTERVAL = 3000;
// 只属于本浏览器的 state 键：句柄无法序列化，也绝不接受对端的值。
const LOCAL_ONLY_STATE = new Set(['__sync-handle', '__device', 'pending-file-open']);

let directory = null;
let initPromise = null;
let pollTimer = null;
let pushTimer = null;
let lastPushedAt = 0;
let lastPushedJson = null;
let lastSeenRev = null;
let queue = Promise.resolve();
let statusListener = null;
let status = { state: 'off', lastSyncAt: null, message: '' };

// 序列化时固定键顺序：两端对同一份数据必须得到同一个字符串，
// 否则键顺序不同会被误判成“有改动”而互相推拉不停。
export function canonical(value) {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function setStatus(patch) {
  const next = { ...status, ...patch };
  const changed = ['state', 'lastSyncAt', 'message'].some(key => next[key] !== status[key]);
  status = next;
  if (changed && statusListener) statusListener(getStatus());
}
export function getStatus() {
  return { ...status, folder: directory?.name || null };
}
export function subscribe(callback) {
  statusListener = callback;
  callback(getStatus());
}
function schedule(task) {
  queue = queue.then(() => task()).catch(error => {
    if (error?.name === 'AbortError') return;
    setStatus({ state: 'error', message: String(error?.message || error).slice(0, 60) });
  });
  return queue;
}
function schedulePush() {
  if (!directory) return;
  clearTimeout(pushTimer);
  const wait = Math.max(PUSH_DELAY, lastPushedAt + PUSH_MIN_INTERVAL - Date.now());
  pushTimer = setTimeout(() => schedule(push), wait);
}
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => schedule(poll), POLL_MS);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function ensurePermission(request = false) {
  if (!directory) return 'denied';
  if (typeof directory.queryPermission !== 'function') return 'granted';
  let state = await Promise.resolve(directory.queryPermission({ mode: 'readwrite' })).catch(() => 'granted');
  if (state !== 'granted' && request && typeof directory.requestPermission === 'function') {
    state = await Promise.resolve(directory.requestPermission({ mode: 'readwrite' })).catch(() => state);
  }
  return state;
}
async function readJson(name, attempts = 2) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const handle = await directory.getFileHandle(name);
      const text = await (await handle.getFile()).text();
      if (text) return JSON.parse(text);
      return null;
    } catch {
      if (attempt === attempts - 1) return null;
      await new Promise(resolve => setTimeout(resolve, 120));
    }
  }
  return null;
}
async function writeJson(name, value) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(value));
  await writable.close();
}

// ---------- 合并规则（纯函数，供单元测试直接调用） ----------
const stampOf = record => Math.max(record?.updatedAt || 0, record?.createdAt || 0);
function lww(local, remote) {
  const newer = (local.updatedAt || 0) >= (remote.updatedAt || 0) ? local : remote;
  const older = newer === local ? remote : local;
  const merged = { ...older, ...newer };
  const stamp = Math.max(local.updatedAt || 0, remote.updatedAt || 0);
  if (stamp) merged.updatedAt = stamp;
  return { merged, older };
}
// 文件句柄只属于本浏览器：远程记录没有 handle，展开顺序天然保留本机的那份。
export function mergeDoc(local, remote) {
  const { merged, older } = lww(local, remote);
  if ((local.starredAt || 0) !== (remote.starredAt || 0)) {
    const win = (local.starredAt || 0) > (remote.starredAt || 0) ? local : remote;
    merged.starred = win.starred;
    if (win.starredAt) merged.starredAt = win.starredAt;
  }
  if ((local.progressAt || 0) !== (remote.progressAt || 0)) {
    const win = (local.progressAt || 0) > (remote.progressAt || 0) ? local : remote;
    if (typeof win.progress === 'number') {
      merged.progress = win.progress;
      if (win.progressAt) merged.progressAt = win.progressAt;
    }
  }
  // 新的一侧只是扫描出的句柄记录时，别把另一端保存的内容快照弄丢。
  if (typeof merged.content !== 'string' && typeof older.content === 'string') merged.content = older.content;
  return merged;
}
export function mergeNote(local, remote) {
  const { merged } = lww(local, remote);
  const created = Math.min(local.createdAt || stampOf(remote), remote.createdAt || stampOf(local));
  if (created) merged.createdAt = created;
  return merged;
}
export function mergeFolder(local, remote) {
  return lww(local, remote).merged;
}
export function mergeHistory(local = [], remote = [], localTime = 0, remoteTime = 0) {
  if (!local.length && localTime > remoteTime) return local;   // 本机清空得更晚
  if (!remote.length && remoteTime > localTime) return remote; // 对端清空得更晚
  const newer = localTime >= remoteTime ? local : remote;
  const older = newer === local ? remote : local;
  return [...newer, ...older.filter(id => !newer.includes(id))];
}
export function mergeTombstones(local = {}, remote = {}) {
  const out = {};
  for (const store of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    out[store] = { ...local[store] };
    for (const [id, time] of Object.entries(remote[store] || {})) out[store][id] = Math.max(out[store][id] || 0, time);
    const ids = Object.keys(out[store]).sort((a, b) => out[store][b] - out[store][a]);
    for (const id of ids.slice(500)) delete out[store][id];   // 与 db.js 的墓碑上限一致
  }
  return out;
}

// ---------- 从本机 IndexedDB 组装推送载荷 ----------
export async function buildPayload() {
  const [documents, annotations, folders, state] = await Promise.all([
    db.all('documents'), db.all('annotations'), db.all('folders'), db.allState(),
  ]);
  const values = {};
  for (const [key, value] of Object.entries(state)) {
    if (key === '__times' || LOCAL_ONLY_STATE.has(key)) continue;
    values[key] = value;
  }
  const strip = records => records.filter(Boolean).map(record => {
    const { handle, ...rest } = record;
    return rest;
  }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {
    documents: { records: strip(documents) },
    annotations: { records: strip(annotations) },
    folders: { records: strip(folders) },
    state: { values, times: state.__times || {} },
  };
}

async function push() {
  if (!directory) return;
  if (await ensurePermission() !== 'granted') { setStatus({ state: 'need-permission' }); return; }
  const payload = await buildPayload();
  const json = canonical(payload);
  if (json === lastPushedJson) {
    if (status.state === 'error') setStatus({ state: 'ok' });
    return;
  }
  setStatus({ state: 'syncing' });
  await writeJson(FILES.documents, payload.documents);
  await writeJson(FILES.annotations, payload.annotations);
  await writeJson(FILES.folders, payload.folders);
  await writeJson(FILES.state, payload.state);
  // meta 最后写入：对端看到 rev 变化时，整批数据一定已经是完整的。
  const rev = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeJson(FILES.meta, { schema: SCHEMA, rev, updatedAt: Date.now() });
  lastSeenRev = rev;
  lastPushedJson = json;
  lastPushedAt = Date.now();
  setStatus({ state: 'ok', lastSyncAt: lastPushedAt });
}

export async function applyRemote(payload) {
  const changed = new Set();
  const [localDocs, localNotes, localFolders, localState] = await Promise.all([
    db.all('documents'), db.all('annotations'), db.all('folders'), db.allState(),
  ]);
  const localTimes = localState.__times || {};
  const remoteValues = payload.state?.values || {};
  const remoteTimes = payload.state?.times || {};
  const tombstones = mergeTombstones(localState.__tombstones || {}, remoteValues.__tombstones || {});
  const ops = { documents: [], annotations: [], folders: [] };

  const mergeInto = (storeName, localList, remoteRecords, merge) => {
    const localMap = new Map(localList.map(record => [record.id, record]));
    const tombstoneMap = tombstones[storeName] || {};
    for (const raw of Array.isArray(remoteRecords) ? remoteRecords : []) {
      if (!raw || raw.id === undefined || raw.id === null) continue;
      const { handle, ...remote } = raw;
      const local = localMap.get(remote.id);
      const tomb = tombstoneMap[remote.id] || 0;
      if (tomb > (remote.updatedAt || 0)) {            // 本机删除得更晚，别复活
        if (local) { ops[storeName].push({ id: local.id, remove: true }); localMap.delete(local.id); changed.add(storeName); }
        continue;
      }
      if (!local) { ops[storeName].push({ value: remote }); localMap.set(remote.id, remote); changed.add(storeName); continue; }
      const merged = merge(local, remote);
      if (canonical(merged) !== canonical(local)) { ops[storeName].push({ value: merged }); localMap.set(remote.id, merged); changed.add(storeName); }
    }
    for (const local of [...localMap.values()]) {        // 对端删除（墓碑晚于本机最后修改）
      if ((tombstoneMap[local.id] || 0) > (local.updatedAt || 0)) { ops[storeName].push({ id: local.id, remove: true }); changed.add(storeName); }
    }
  };
  mergeInto('documents', localDocs, payload.documents?.records, mergeDoc);
  mergeInto('annotations', localNotes, payload.annotations?.records, mergeNote);
  mergeInto('folders', localFolders, payload.folders?.records, mergeFolder);

  const stateOps = [];
  const mergedTimes = { ...localTimes };
  const remoteKeys = new Set([...Object.keys(remoteValues), ...Object.keys(remoteTimes)]);
  for (const key of remoteKeys) {
    if (key === '__times' || LOCAL_ONLY_STATE.has(key)) continue;
    const localTime = localTimes[key] || 0;
    const remoteTime = remoteTimes[key] || 0;
    const hasLocal = Object.hasOwn(localState, key);
    if (!Object.hasOwn(remoteValues, key)) continue;     // 本机新增的键，稍后随推送出去
    if (!hasLocal) {
      stateOps.push({ key, value: remoteValues[key] });
      if (remoteTime) mergedTimes[key] = remoteTime;
      changed.add('state');
      continue;
    }
    if (key === '__tombstones') {                        // 并集，避免删除被对方复活
      const merged = mergeTombstones(localState.__tombstones || {}, remoteValues.__tombstones || {});
      if (canonical(merged) !== canonical(localState.__tombstones || {})) { stateOps.push({ key, value: merged }); changed.add('state'); }
      continue;
    }
    if (key === 'history') {                            // 并集，保留双方最近阅读
      const merged = mergeHistory(localState.history || [], remoteValues.history || [], localTime, remoteTime);
      if (canonical(merged) !== canonical(localState.history || [])) { stateOps.push({ key, value: merged }); changed.add('state'); }
      const time = Math.max(localTime, remoteTime);
      if (time) mergedTimes[key] = time;
      continue;
    }
    if (remoteTime > localTime) {
      stateOps.push({ key, value: remoteValues[key] });
      mergedTimes[key] = remoteTime;
      changed.add('state');
    } else if (remoteTime === localTime && canonical(remoteValues[key]) !== canonical(localState[key])) {
      // 时间戳相同（例如升级前的老数据）：两侧用同一条确定性规则取值，避免来回覆盖
      if (canonical(remoteValues[key]) < canonical(localState[key])) { stateOps.push({ key, value: remoteValues[key] }); changed.add('state'); }
    }
  }

  const timesChanged = canonical(mergedTimes) !== canonical(localTimes);
  if (!changed.size && !stateOps.length && !timesChanged) return [];
  const database = await db.database();
  await new Promise((resolve, reject) => {
    const tx = database.transaction(['documents', 'annotations', 'folders', 'state'], 'readwrite');
    for (const [storeName, list] of Object.entries(ops)) {
      const store = tx.objectStore(storeName);
      for (const op of list) { if (op.remove) store.delete(op.id); else store.put(op.value); }
    }
    const stateStore = tx.objectStore('state');
    for (const op of stateOps) stateStore.put(op.value, op.key);
    if (stateOps.length || timesChanged) stateStore.put(mergedTimes, '__times');
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('同步写入失败'));
  });
  return [...changed];
}

async function pull(meta) {
  setStatus({ state: 'syncing' });
  const files = {
    documents: await readJson(FILES.documents),
    annotations: await readJson(FILES.annotations),
    folders: await readJson(FILES.folders),
    state: await readJson(FILES.state),
  };
  if (Object.values(files).some(value => value === null)) {
    // 文件缺失或损坏：先完整重建本机这一份，对端的记录仍在它自己的库里，之后会再合并回来
    lastPushedJson = null;
    setStatus({ state: 'error', message: '同步文件不完整，正在重建' });
    schedulePush();
    return;
  }
  const changed = await applyRemote(files);
  lastSeenRev = meta.rev;
  if (changed.length) { db.notifyChange(changed); db.broadcast(changed); }
  else db.notifyChange(['documents']);   // 数据可能已被本浏览器的其他标签页应用，刷新本页视图
  setStatus({ state: 'ok', lastSyncAt: Date.now() });
  schedulePush();                          // 把本机独有的改动补推回去
}

async function poll() {
  if (!directory) return;
  if (await ensurePermission() !== 'granted') { setStatus({ state: 'need-permission' }); return; }
  const meta = await readJson(FILES.meta);
  if (!meta) { lastPushedJson = null; await push(); return; }   // 第一次：用本机数据初始化文件夹
  if (meta.schema > SCHEMA) { setStatus({ state: 'error', message: '同步数据由更新版本的墨读写入，请升级后使用' }); return; }
  if (meta.rev === lastSeenRev) { setStatus({ state: 'ok' }); return; }
  await pull(meta);
}

export function initSync() {
  if (!initPromise) initPromise = (async () => {
    db.onLocalWrite(() => schedulePush());
    directory = (await db.get('state', '__sync-handle')) || null;
    if (!directory) { setStatus({ state: 'off' }); return; }
    startPolling();
    await schedule(poll);
  })().catch(error => setStatus({ state: 'error', message: String(error?.message || error).slice(0, 60) }));
  return initPromise;
}
export async function setDirectory(handle) {
  await initSync();
  clearTimeout(pushTimer);
  await db.put('state', handle || undefined, '__sync-handle');   // 传 undefined 即删除该键
  directory = handle || null;
  lastSeenRev = null;
  lastPushedJson = null;
  if (!directory) {
    stopPolling();
    setStatus({ state: 'off', lastSyncAt: null, message: '' });
    return;
  }
  startPolling();
  setStatus({ state: 'syncing', message: '' });
  await schedule(poll);
}
export async function pickDirectory() {
  if (!globalThis.showDirectoryPicker) throw new Error('当前浏览器不支持选择同步文件夹');
  let handle;
  try {
    handle = await globalThis.showDirectoryPicker({ id: 'inkstone-sync', mode: 'readwrite' });
  } catch (error) {
    if (error?.name === 'AbortError') return;   // 用户取消选择
    throw error;
  }
  await setDirectory(handle);
}
export const stopSync = () => setDirectory(null);
export async function reauthorize() {
  if (!directory) return;
  if (await ensurePermission(true) === 'granted') await schedule(poll);
  else setStatus({ state: 'need-permission' });
}
export const forcePoll = () => schedule(poll);

// 仅在带 ?test 参数打开时暴露：浏览器验收用它注入目录句柄（系统选择器无法自动化）。
if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('test')) {
  globalThis.__inkstoneSyncTest = {
    setDirectory: handle => setDirectory(handle || null),
    status: () => getStatus(),
    push: () => schedule(push),
    poll: () => schedule(poll),
    stop: () => setDirectory(null),
  };
}
