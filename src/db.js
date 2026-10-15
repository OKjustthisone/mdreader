const DB_NAME = 'inkstone-reader';
let dbPromise;
const events = typeof BroadcastChannel === 'function' ? new BroadcastChannel('inkstone-changes') : null;
export const onChange = callback => { if (events) events.onmessage = callback; };
export function closeChannel() { events?.close(); }
function announce(type) { events?.postMessage(type); }
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
// Read and write in one transaction: concurrent annotation/settings updates never
// overwrite a stale copy of the entire library.
export async function mutate(storeName, key, update) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    let result;
    const read = store.get(key);
    read.onsuccess = () => {
      try {
        result = update(read.result);
        if (result === undefined) store.delete(key);
        else if (storeName === 'state') store.put(result, key);
        else store.put(result);
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
      request.onsuccess = () => store.put({ ...request.result, ...doc, starred: request.result?.starred || false });
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
