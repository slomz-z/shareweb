/* Client-side encryption for ShareWeb.
 * Files and their metadata are encrypted in the browser before they reach the
 * server. The server only ever sees ciphertext and public keys; the decryption
 * key is derived from the user's own account, so only the user can unlock it. */

const CRYPTO = (() => {
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
  const CHUNK = 1024 * 1024;
  const IV_SALT = 8;
  const IV_LEN = 12;

  let worker = null;
  let reqId = 0;
  const pendingRequests = new Map();

  function getWorker() {
    if (typeof Worker === 'undefined') return null;
    if (!worker) {
      try {
        worker = new Worker('/crypto-worker.js');
        worker.onmessage = (e) => {
          const { id, ok, result, error } = e.data || {};
          const p = pendingRequests.get(id);
          if (p) {
            pendingRequests.delete(id);
            if (ok) p.resolve(result);
            else p.reject(new Error(error));
          }
        };
        worker.onerror = () => { worker = null; };
      } catch {
        worker = null;
      }
    }
    return worker;
  }

  function callWorker(op, args) {
    const w = getWorker();
    if (!w) return null;
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      pendingRequests.set(id, { resolve, reject });
      w.postMessage({ id, op, args });
    });
  }

  async function pbkdf2Master(secret, saltHex) {
    try {
      const res = await callWorker('pbkdf2Master', { secret, saltHex });
      if (res) return new Uint8Array(res);
    } catch {}
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltHex), iterations: PBKDF2_ITERS }, key, 256);
    return new Uint8Array(bits);
  }

  async function hkdf(ikm, saltStr, infoStr, bits) {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(saltStr), info: enc.encode(infoStr) }, key, bits));
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

  function derLen(n) {
    if (n < 0x80) return [n];
    const b = [];
    while (n > 0) {
      b.unshift(n & 0xff);
      n >>>= 8;
    }
    return [0x80 | b.length, ...b];
  }
  function tlv(tag, body) {
    return [tag, ...derLen(body.length), ...body];
  }
  // P-256 (secp256r1) curve constants for universal EC key derivation
  const EC_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  const EC_A = EC_P - 3n;
  const EC_Gx = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
  const EC_Gy = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;
  const EC_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

  function ecMod(n, m = EC_P) {
    const r = n % m;
    return r >= 0n ? r : r + m;
  }

  function ecModInverse(k, m = EC_P) {
    let [a, b] = [ecMod(k, m), m];
    let [x0, x1] = [0n, 1n];
    while (a > 1n) {
      const q = a / b;
      [a, b] = [b, a % b];
      [x0, x1] = [x1 - q * x0, x0];
    }
    return ecMod(x1, m);
  }

  function ecPointAdd(p1, p2) {
    if (!p1) return p2;
    if (!p2) return p1;
    const [x1, y1] = p1;
    const [x2, y2] = p2;
    if (x1 === x2) {
      if (y1 !== y2) return null;
      const m = ecMod(3n * x1 * x1 + EC_A) * ecModInverse(2n * y1);
      const x3 = ecMod(m * m - 2n * x1);
      const y3 = ecMod(m * (x1 - x3) - y1);
      return [x3, y3];
    }
    const m = ecMod(y2 - y1) * ecModInverse(x2 - x1);
    const x3 = ecMod(m * m - x1 - x2);
    const y3 = ecMod(m * (x1 - x3) - y1);
    return [x3, y3];
  }

  function ecPointMultiply(k, p = [EC_Gx, EC_Gy]) {
    let curr = p;
    let res = null;
    let d = ecMod(k, EC_N);
    while (d > 0n) {
      if (d & 1n) res = ecPointAdd(res, curr);
      curr = ecPointAdd(curr, curr);
      d >>= 1n;
    }
    return res;
  }

  function bigIntToBytes(bn, len = 32) {
    const hex = bn.toString(16).padStart(len * 2, '0');
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  async function deriveIdentity(master) {
    const seed = await hkdf(master, 'shareweb-id', 'shareweb-ecdh', 256);
    let d = 0n;
    for (const b of seed) d = (d << 8n) | BigInt(b);
    d = (d % (EC_N - 1n)) + 1n;
    const dBytes = bigIntToBytes(d);
    const [x, y] = ecPointMultiply(d);
    const xBytes = bigIntToBytes(x);
    const yBytes = bigIntToBytes(y);

    const jwk = {
      kty: 'EC',
      crv: 'P-256',
      d: b64u(dBytes),
      x: b64u(xBytes),
      y: b64u(yBytes),
      ext: true,
      key_ops: ['deriveBits']
    };
    const priv = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    return { priv, pub: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
  }

  async function sharedWrapKey(ownPriv, peerPub, ownX, peerX) {
    const pub = await crypto.subtle.importKey('jwk', peerPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, ownPriv, 256);
    const role = [ownX, peerX].sort().join('|');
    return hkdf(new Uint8Array(shared), 'shareweb-wrap', 'shareweb-wrap:' + role, 256);
  }

  function chunkIv(ivSalt, index) {
    const iv = new Uint8Array(IV_LEN);
    iv.set(ivSalt, 0);
    new DataView(iv.buffer).setUint32(IV_SALT, index >>> 0);
    return iv;
  }

  async function encryptChunk(raw, ivSalt, index, data) {
    const k = await aesKey(raw);
    return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: chunkIv(ivSalt, index) }, k, data));
  }

  async function decryptChunk(raw, ivSalt, index, data) {
    const k = await aesKey(raw);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: chunkIv(ivSalt, index) }, k, data));
  }

  const cipherChunkLen = (plainLen) => (plainLen || 0) + 16;
  const numChunks = (plainSize) => Math.max(1, Math.ceil((plainSize || 0) / CHUNK));
  const cipherSize = (plainSize) => (plainSize || 0) + 16 * numChunks(plainSize);

  function* cipherSlices(cipherBytes, plainSize) {
    let off = 0;
    let i = 0;
    while (off < cipherBytes.length) {
      const plen = Math.min(CHUNK, plainSize - i * CHUNK);
      const clen = cipherChunkLen(plen);
      if (clen <= 0 || off + clen > cipherBytes.length) throw new Error('corrupt ciphertext');
      yield { i, slice: cipherBytes.slice(off, off + clen) };
      off += clen;
      i++;
    }
  }

  async function decryptWhole(cipherBytes, raw, ivSalt, plainSize) {
    const out = new Uint8Array(plainSize);
    let at = 0;
    for (const { i, slice } of cipherSlices(cipherBytes, plainSize)) {
      const pt = await decryptChunk(raw, ivSalt, i, slice);
      out.set(pt, at);
      at += pt.length;
    }
    return out;
  }

  const CRYPTO = {
    pbkdf2Master,
    hkdf,
    encryptBytes,
    decryptBytes,
    deriveIdentity,
    sharedWrapKey,
    encryptChunk,
    decryptChunk,
    decryptWhole,
    cipherSize,
    numChunks,
    cipherChunkLen,
    b64u,
    unb64,
    CHUNK,
  };
  if (typeof window !== 'undefined') window.CRYPTO = CRYPTO;
  return CRYPTO;
})();