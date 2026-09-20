// ShareWeb IndexedDB Outbox & Download Persistence Manager
import { state } from './state.js';

let outboxDB = null;
export function openOutboxDB() {
  return new Promise((resolve, reject) => {
    if (outboxDB) return resolve(outboxDB);
    const req = indexedDB.open('shareweb-outbox', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      outboxDB = req.result;
      resolve(outboxDB);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function obPut(rec) {
  const db = await openOutboxDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').put(rec);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function obAll() {
  try {
    const db = await openOutboxDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly');
      const req = tx.objectStore('outbox').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function obDelete(id) {
  try {
    const db = await openOutboxDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

/** Resume any sends that were interrupted by a page refresh. */
export async function resumeOutbox(addTransferCard, relayTransfer) {
  const recs = await obAll();
  for (const rec of recs) {
    if (state.pending.has(rec.id)) continue;
    const files = rec.files.map((f) => {
      const file = new File([f.blob], f.name, { type: f.mime || '', lastModified: Date.now() });
      if (f.env) file._env = f.env;
      return file;
    });
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    const card = addTransferCard ? addTransferCard(rec.id, {
      who: (rec.peer && rec.peer.name) || 'Peer',
      role: 'send',
      status: 'Sending…',
      progress: 0,
      total: totalSize,
      current: '',
    }) : null;
    const p = {
      peer: { email: rec.peer.email, name: rec.peer.name },
      files,
      totalSize,
      card,
      relayed: false,
      done: false,
      timer: null,
      outbox: rec,
    };
    state.pending.set(rec.id, p);
    if (typeof relayTransfer === 'function') {
      relayTransfer(rec.id, 'Sending…');
    }
  }
}

export let dlSeq = 0;
let downloadDB = null;
export function openDownloadDB() {
  return new Promise((resolve, reject) => {
    if (downloadDB) return resolve(downloadDB);
    const req = indexedDB.open('shareweb-downloads', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('parts')) db.createObjectStore('parts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      downloadDB = req.result;
      resolve(downloadDB);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function dlPut(store, rec) {
  const db = await openDownloadDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(rec);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function dlGet(store, id) {
  const db = await openDownloadDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function dlAll(store, key) {
  const db = await openDownloadDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve((req.result || []).filter((r) => r.key === key).sort((a, b) => a.seq - b.seq));
    req.onerror = () => reject(req.error);
  });
}

export async function dlDelete(store, id) {
  const db = await openDownloadDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function dlClearKey(store, key) {
  const db = await openDownloadDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const req = os.getAll();
    req.onsuccess = () => {
      for (const r of req.result || []) if (r.key === key) os.delete(r.id);
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
