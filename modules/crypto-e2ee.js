// ShareWeb Account End-to-End Encryption & Key Management
import { state } from './state.js';
import { uid } from './utils.js';
const CRYPTO = (typeof window !== 'undefined' && window.CRYPTO) ? window.CRYPTO : null;

let keyDB = null;
export function openKeyDB() {
  return new Promise((resolve, reject) => {
    if (keyDB) return resolve(keyDB);
    const req = indexedDB.open('shareweb-keys', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys', { keyPath: 'email' });
    };
    req.onsuccess = () => {
      keyDB = req.result;
      resolve(keyDB);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function masterCacheGet(email) {
  try {
    const db = await openKeyDB();
    const r = await new Promise((resolve, reject) => {
      const tx = db.transaction('keys', 'readonly');
      const req = tx.objectStore('keys').get(email);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    return r ? CRYPTO.unb64(r.masterB64) : null;
  } catch {
    return null;
  }
}

export async function masterCacheSet(email, master) {
  try {
    const db = await openKeyDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite');
      tx.objectStore('keys').put({ email, masterB64: CRYPTO.b64u(master), savedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

export async function masterCacheClear(email) {
  try {
    const db = await openKeyDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite');
      if (email) {
        tx.objectStore('keys').delete(email);
      } else {
        tx.objectStore('keys').clear();
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

/** Set up encryption silently from an account password right after login.
 *  The password is never stored; only the derived key is cached in this browser. */
export async function setupFromPassword(email, password) {
  if (!password) return;
  try {
    const enc = await (await fetch('/api/user/enc')).json();
    if (!enc.encSalt) {
      const salt = CRYPTO.b64u(crypto.getRandomValues(new Uint8Array(16)));
      const master = await CRYPTO.pbkdf2Master(password, salt);
      await masterCacheSet(email, master);
      let encName = null;
      const meRes = await fetch('/api/me');
      if (meRes.ok) {
        const me = await meRes.json();
        if (me.name) {
          encName = await CRYPTO.encryptBytes(master, new TextEncoder().encode(me.name));
        }
      }
      await fetch('/api/user/enc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encSalt: salt, needsPassphrase: false, encName }),
      });
    } else {
      const master = await CRYPTO.pbkdf2Master(password, enc.encSalt);
      await masterCacheSet(email, master);
    }
  } catch {}
}

/** Make sure this browser can encrypt/decrypt for the current account.
 *  Master key is always derived from: PBKDF2(Password, encSalt).
 *  If no master key is cached in this browser's IndexedDB, redirects to /google-setup-password to unlock or set up. */
export async function ensureCrypto() {
  const me = state.me;
  if (!me || !me.email) return false;
  if (/@(shareweb\.local|offline\.local)$/i.test(me.email)) {
    return true;
  }
  try {
    const enc = await (await fetch('/api/user/enc')).json();
    let master = enc.encSalt ? await masterCacheGet(me.email) : null;
    if (!master) {
      // No cached master key on this device: redirect to login to unlock password
      const currentPath = window.location.pathname + window.location.search;
      window.location.replace(`/login?returnTo=${encodeURIComponent(currentPath)}`);
      state.cryptoReady = false;
      return false;
    }
    if (me.encName) {
      // The stored name is ciphertext — decrypt it to display.
      try {
        const nameBytes = await CRYPTO.decryptBytes(master, me.encName);
        const decName = new TextDecoder().decode(nameBytes);
        if (decName) {
          state.me.name = decName;
          if (typeof renderUserHeader === 'function') renderUserHeader();
        }
      } catch {}
    }
    state.masterKey = master;
    state.identity = await CRYPTO.deriveIdentity(master);
    await fetch('/api/user/pubkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pub: state.identity.pub }),
    }).catch(() => {});
    state.cryptoReady = true;
    return true;
  } catch {
    return false;
  }
}

export async function getPeerPub(email) {
  const r = await fetch('/api/user/pubkey/' + encodeURIComponent(email));
  if (r.status === 404) {
    throw new Error(
      "This contact isn't set up for protected files yet. They need to sign in once, then you can send."
    );
  }
  if (!r.ok) throw new Error('peer has no public key');
  return (await r.json()).pub;
}

export const ownX = () => (state.identity ? state.identity.pub.x : '');
export const selfKey = async (master) => CRYPTO.hkdf(master, 'shareweb-self', 'shareweb-self', 256);
export const selfWrap = async (master, K) => CRYPTO.encryptBytes(await selfKey(master), K);
export const selfUnwrap = async (master, wrap) => CRYPTO.decryptBytes(await selfKey(master), wrap);
export const peerWrap = async (ownPriv, peerPub, K) =>
  CRYPTO.encryptBytes(await CRYPTO.sharedWrapKey(ownPriv, peerPub, ownX(), peerPub.x), K);
export const peerUnwrap = async (ownPriv, peerPub, wrap) =>
  CRYPTO.decryptBytes(await CRYPTO.sharedWrapKey(ownPriv, peerPub, ownX(), peerPub.x), wrap);

export async function createEnvelope(file, peerPub, uploadId) {
  const K = crypto.getRandomValues(new Uint8Array(32));
  const ivSalt = crypto.getRandomValues(new Uint8Array(8));
  const meta = {
    filename: file.relativePath || file.name,
    size: file.size,
    mime: file.type || '',
    ts: new Date().toISOString(),
    senderName: state.me.name || '',
    senderEmail: state.me.email,
    ivSalt: CRYPTO.b64u(ivSalt),
  };
  const encMeta = await CRYPTO.encryptBytes(K, new TextEncoder().encode(JSON.stringify(meta)));
  const wrapSelf = await selfWrap(state.masterKey, K);
  const wrapPeer = await peerWrap(state.identity.priv, peerPub, K);
  return {
    uploadId: uploadId || uid(),
    K: CRYPTO.b64u(K),
    ivSalt: CRYPTO.b64u(ivSalt),
    encMeta,
    wrapSelf,
    wrapPeer,
    senderPub: state.identity.pub,
    cipherSize: CRYPTO.cipherSize(file.size),
    plainSize: file.size,
  };
}
