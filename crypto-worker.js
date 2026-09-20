/**
 * ShareWeb Background Cryptography Worker
 * Executes PBKDF2, AES-GCM, and ECDH off the main thread to ensure 60/120 FPS UI smoothness.
 */

const enc = new TextEncoder();
const b64 = (b) => {
  let s = '';
  const u = new Uint8Array(b);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};
const b64u = (b) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};

const PBKDF2_ITERS = 210000;
const IV_LEN = 12;

async function pbkdf2Master(secret, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltHex), iterations: PBKDF2_ITERS },
    key,
    256
  );
  return new Uint8Array(bits);
}

async function hkdf(ikm, saltStr, infoStr, bits) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(saltStr), info: enc.encode(infoStr) },
      key,
      bits
    )
  );
}

async function aesKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptBytes(raw, data) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const k = await aesKey(raw);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, data));
  return { iv: b64u(iv), ct: b64u(ct) };
}

async function decryptBytes(raw, wrap) {
  const k = await aesKey(raw);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(wrap.iv) }, k, unb64(wrap.ct));
  return new Uint8Array(pt);
}

self.onmessage = async (e) => {
  const { id, op, args } = e.data || {};
  try {
    let result;
    if (op === 'pbkdf2Master') {
      const bits = await pbkdf2Master(args.secret, args.saltHex);
      result = Array.from(bits);
    } else if (op === 'encryptBytes') {
      const raw = new Uint8Array(args.raw);
      const data = new Uint8Array(args.data);
      result = await encryptBytes(raw, data);
    } else if (op === 'decryptBytes') {
      const raw = new Uint8Array(args.raw);
      const pt = await decryptBytes(raw, args.wrap);
      result = Array.from(pt);
    } else {
      throw new Error(`Unknown crypto operation: ${op}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};
