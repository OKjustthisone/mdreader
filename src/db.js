const DB_NAME = 'inkstone-reader';
let dbPromise;
const events = typeof BroadcastChannel === 'function' ? new BroadcastChannel('inkstone-changes') : null;
const listeners = [];
let writeListener;
// onChange: other tabs (BroadcastChannel) or an explicit notifyChange() after a sync pull.
export const onChange = callback => {
  listeners.push(callback);
  if (events && !events.onmessage) events.onmessage = event => listeners.forEach(listener => listener(event.data));
};
export const notifyChange = type => listeners.forEach(listener => listener(type));
export const broadcast = type => { events?.postMessage(type); };
// onLocalWrite: fired for every write made by this tab, used to schedule a sync push.
export const onLocalWrite = callback => { writeListener = callback; };
export function closeChannel() { events?.close(); }
function announce(type) {
  events?.postMessage(type);
  writeListener?.(type);
}
// Records in these stores are merged record-by-record across browsers, so every write
// carries its own clock. Deleted ids stay behind as tombstones so the other side learns
// about the removal instead of resurrecting the record.
const TOMBSTONE_STORES = { documents: true, annotations: true, folders: true };
// Per-browser or non-serializable state keys that never travel to the shared folder.
const RESERVED_STATE_KEYS = new Set(['__times', '__tombstones', '__sync-handle', '__device']);
function stampStateTime(tx, key) {
  const store = tx.objectStore('state');
  const request = store.get('__times');
  request.onsuccess = () => store.put({ ...(request.result || {}), [key]: Date.now() }, '__times');
}
function recordTombstone(tx, storeName, key) {
  const store = tx.objectStore('state');
  const request = store.get('__tombstones');
  request.onsuccess = () => {
    const map = { ...(request.result || {}) };
    const bucket = { ...(map[storeName] || {}), [key]: Date.now() };
    const ids = Object.keys(bucket).sort((a, b) => bucket[a] - bucket[b]);
    for (const id of ids.slice(0, Math.max(0, ids.length - 500))) delete bucket[id];
    map[storeName] = bucket;
    store.put(map, '__tombstones');
  };
}
export function database() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('documents', { keyPath: 'id' });
      db.createObjectStore('folders', { keyPath: 'id' });
      const notes = db.createObjectStore('annotations', { keyPath: 'id' });
      notes.createIndex('documentId', 'documentId');
      db.createObjectStore('state');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}
function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function get(store, key) {
  return requestValue((await database()).transaction(store).objectStore(store).get(key));
}
export async function all(store) {
  return requestValue((await database()).transaction(store).objectStore(store).getAll());
}
// The `state` store has no key path, so values need their keys read alongside them.
export async function allState() {
  const store = (await database()).transaction('state').objectStore('state');
  const [keys, values] = await Promise.all([requestValue(store.getAllKeys()), requestValue(store.getAll())]);
  const map = {};
  keys.forEach((key, index) => { map[key] = values[index]; });
  return map;
}
// Read and write in one transaction: concurrent annotation/settings updates never
// overwrite a stale copy of the entire library.
export async function mutate(storeName, key, update) {
  const db = await database();
  return new Promise((resolve, reject) => {
    // Deletions in mergeable stores also need to touch `state.__tombstones`.
    const tx = db.transaction(storeName === 'state' ? [storeName] : [storeName, 'state'], 'readwrite');
    const store = tx.objectStore(storeName);
    let result;
    const read = store.get(key);
    read.onsuccess = () => {
      try {
        result = update(read.result);
        if (result === undefined) {
          store.delete(key);
          if (TOMBSTONE_STORES[storeName]) recordTombstone(tx, storeName, key);
        } else if (storeName === 'state') {
          if (!RESERVED_STATE_KEYS.has(key)) stampStateTime(tx, key);
          store.put(result, key);
        } else {
          if (result && typeof result === 'object') result.updatedAt = Date.now();
          store.put(result);
        }
      } catch (error) { tx.abort(); reject(error); }
    };
    tx.oncomplete = () => { announce(storeName); resolve(result); };
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('本地存储未完成，请重试'));
  });
}
export const put = (store, value, key = value.id) => mutate(store, key, () => value);
export async function mergeDocument(doc) {
  return mutate('documents', doc.id, old => ({ ...old, ...doc, starred: old?.starred ?? doc.starred ?? false }));
}
export async function recordVisit(id) {
  return mutate('state', 'history', old => [id, ...(old || []).filter(item => item !== id)].slice(0, 20));
}
export async function notesFor(documentId) {
  const db = await database();
  const request = db.transaction('annotations').objectStore('annotations').index('documentId').getAll(documentId);
  return (await requestValue(request)).sort((a, b) => a.start - b.start || a.createdAt - b.createdAt);
}
export async function putDocuments(docs) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('documents', 'readwrite');
    const store = tx.objectStore('documents');
    for (const doc of docs) {
      const request = store.get(doc.id);
      request.onsuccess = () => store.put({ ...request.result, ...doc, starred: request.result?.starred || false, updatedAt: Date.now() });
    }
    tx.oncomplete = () => { announce('documents'); resolve(); };
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
export function markdownFile(name) { return /\.(md|markdown|mdown)$/i.test(name); }
export function normalizePath(base, relative) {
  const parts = base.split('/').slice(0, -1);
  for (const part of relative.split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
