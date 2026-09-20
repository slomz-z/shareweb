// ShareWeb Resumable Chunked Server Relay Upload & Download
import { state } from './state.js';
import { $, esc, toast, SOUNDS, sleep, resType, deviceTZ, uid } from './utils.js';
import { t } from './i18n.js';
import { Sha256Hasher } from './hasher.js';
import { NotificationManager } from './notifications.js';
import {
  addTransferCard,
  setCardStatus,
  updateCardProgress,
  setCardVerified,
  setCardConnectionType,
  setCardWho,
  setCardCurrent,
  updateCardPauseUI
} from './transfer-cards.js';
import {
  selfWrap,
  selfUnwrap,
  peerWrap,
  peerUnwrap,
  createEnvelope,
  getPeerPub
} from './crypto-e2ee.js';
import { isRealAccount } from './webrtc-sender.js';
import { obPut, obDelete, dlPut, dlGet, dlAll, dlDelete, dlClearKey } from './outbox.js';
import { loadHistory } from './history.js';
import { downloadBlob } from './webrtc-receiver.js';
const CRYPTO = (typeof window !== 'undefined' && window.CRYPTO) ? window.CRYPTO : null;

export class PermanentError extends Error {}
export class ResyncError extends Error {
  constructor(received) {
    super('offset resync');
    this.received = received;
  }
}

export async function retryNetwork(work) {
  for (;;) {
    try {
      return await work();
    } catch (err) {
      if (err instanceof PermanentError || err instanceof ResyncError) throw err;
      await sleep(4000);
    }
  }
}

export const UPLOAD_CHUNK = 1024 * 1024; // 1 MB per chunk

export async function resumeUpload(p, file, onProgress, preId) {
  if (p.card && p.card._ctrl) {
    p.card._ctrl.onPause = () => { p.paused = true; };
    p.card._ctrl.onResume = () => { p.paused = false; };
  }
  const plainHasher = new Sha256Hasher();

  const env = file._env;
  if (env && state.cryptoReady) {
    const uploadId = env.uploadId;
    const plainSize = env.plainSize;
    const cipherSize = env.cipherSize;
    const K = CRYPTO.unb64(env.K);
    const ivSalt = CRYPTO.unb64(env.ivSalt);
    let meta = await retryNetwork(async () => {
      const res = await fetch('/api/files/upload/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Timezone': deviceTZ() },
        body: JSON.stringify({
          uploadId,
          to: p.peer.email,
          size: cipherSize,
          enc: true,
          encMeta: env.encMeta,
          wrapSelf: env.wrapSelf,
          wrapPeer: env.wrapPeer,
          senderPub: env.senderPub,
        }),
      });
      if (res.status === 403) {
        // Receiver just disconnected (e.g. refreshed) — wait for them to come back.
        throw new Error('waiting for receiver');
      }
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new PermanentError(e.error || 'Send failed');
      }
      return res.json();
    });

    let off = Number(meta.received) || 0;
    if (off > 0) {
      const plainPrior = cipherToPlain(off, plainSize);
      if (plainPrior > 0) {
        const priorBuf = await file.slice(0, plainPrior).arrayBuffer();
        plainHasher.update(priorBuf);
      }
    }
    while (off < cipherSize) {
      if (p.aborted) return;
      while (p.paused && !p.aborted) {
        await sleep(150);
      }
      if (p.aborted) return;
      const plainOff = cipherToPlain(off, plainSize);
      const chunk = await file.slice(plainOff, Math.min(plainOff + CRYPTO.CHUNK, file.size)).arrayBuffer();
      plainHasher.update(chunk);
      const index = Math.floor(plainOff / CRYPTO.CHUNK);
      const ct = await CRYPTO.encryptChunk(K, ivSalt, index, new Uint8Array(chunk));
      try {
        off = await retryNetwork(async () => {
          const res = await fetch(`/api/files/upload/${encodeURIComponent(uploadId)}`, {
            method: 'POST',
            headers: { 'Upload-Offset': String(off), 'Content-Type': 'application/octet-stream' },
            body: ct,
          });
          if (res.status === 409) {
            const d = await res.json().catch(() => ({}));
            throw new ResyncError(Number(d.received) || 0);
          }
          if (!res.ok) {
            const e = await res.json().catch(() => ({}));
            throw new PermanentError(e.error || 'Upload failed');
          }
          const d = await res.json();
          return Number(d.received);
        });
      } catch (err) {
        if (err instanceof ResyncError) {
          off = err.received;
          continue;
        }
        throw err;
      }
      if (onProgress) onProgress(plainOff + chunk.byteLength);
    }

    await retryNetwork(async () => {
      const res = await fetch(`/api/files/upload/${encodeURIComponent(uploadId)}/finalize`, { method: 'POST' });
      if (res.status === 404) return; // already finalized on a previous run
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new PermanentError(e.error || 'Send failed');
      }
    });
    const uploadSha256 = plainHasher.digestHex();
    setCardVerified(p.card, uploadSha256);
    return plainSize;
  }

  const uploadId = preId || uid();
  let meta = await retryNetwork(async () => {
    const res = await fetch('/api/files/upload/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Timezone': deviceTZ() },
      body: JSON.stringify({
        uploadId,
        to: p.peer.email,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
      }),
    });
    if (res.status === 403) {
      // Receiver just disconnected (e.g. refreshed) — wait for them to come back.
      throw new Error('waiting for receiver');
    }
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new PermanentError(e.error || 'Send failed');
    }
    return res.json();
  });

  let offset = Number(meta.received) || 0;
  if (offset > 0) {
    const priorBuf = await file.slice(0, offset).arrayBuffer();
    plainHasher.update(priorBuf);
  }
  while (offset < file.size) {
    if (p.aborted) return;
    while (p.paused && !p.aborted) {
      await sleep(150);
    }
    if (p.aborted) return;
    const chunk = file.slice(offset, Math.min(offset + UPLOAD_CHUNK, file.size));
    const chunkBuf = await chunk.arrayBuffer();
    plainHasher.update(chunkBuf);
    try {
      offset = await retryNetwork(async () => {
        const res = await fetch(`/api/files/upload/${encodeURIComponent(uploadId)}`, {
          method: 'POST',
          headers: { 'Upload-Offset': String(offset), 'Content-Type': 'application/octet-stream' },
          body: chunk,
        });
        if (res.status === 409) {
          const d = await res.json().catch(() => ({}));
          throw new ResyncError(Number(d.received) || 0);
        }
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new PermanentError(e.error || 'Upload failed');
        }
        const d = await res.json();
        return Number(d.received);
      });
    } catch (err) {
      if (err instanceof ResyncError) {
        offset = err.received;
        continue;
      }
      throw err;
    }
    if (onProgress) onProgress(offset);
  }

  await retryNetwork(async () => {
    const res = await fetch(`/api/files/upload/${encodeURIComponent(uploadId)}/finalize`, { method: 'POST' });
    if (res.status === 404) return; // already finalized on a previous run
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new PermanentError(e.error || 'Send failed');
    }
  });
  const uploadSha256 = plainHasher.digestHex();
  setCardVerified(p.card, uploadSha256);
  return file.size;
}

export async function relayTransfer(transferId, reason) {
  const p = state.pending.get(transferId);
  if (!p || p.relayed || p.done) return;
  p.relayed = true;
  setCardConnectionType(p.card, 'relay');

  // Real accounts never send unprotected files: if the account key isn't ready,
  // stop here instead of silently uploading plaintext.
  if (isRealAccount() && !state.cryptoReady) {
    setCardStatus(p.card, 'err', t('statusReconnectAccount', 'Reconnect your account, then send again.'));
    p.done = true;
    state.pending.delete(transferId);
    return;
  }

  const st = state.rtc.get(transferId);
  if (st) {
    st.aborted = true;
    try {
      st.dc.close();
      st.pc.close();
    } catch {}
    state.rtc.delete(transferId);
  }

  setCardStatus(p.card, '', reason);

  const totalSize = p.files.reduce((s, f) => s + f.size, 0);
  let uploaded = 0;
  try {
    if (state.cryptoReady) {
      const peerPub = await retryNetwork(() => getPeerPub(p.peer.email));
      for (let i = 0; i < p.files.length; i++) {
        const f = p.files[i];
        if (!f._env) {
          const preId = p.outbox && p.outbox.files[i] && p.outbox.files[i].uploadId;
          f._env = await createEnvelope(f, peerPub, preId);
          if (p.outbox && p.outbox.files[i]) {
            p.outbox.files[i].uploadId = f._env.uploadId;
            p.outbox.files[i].env = f._env;
            obPut(p.outbox).catch(() => {});
          }
        }
      }
    }
    for (let i = 0; i < p.files.length; i++) {
      const f = p.files[i];
      setCardCurrent(p.card, f.relativePath || f.name);
      const preId = p.outbox && p.outbox.files[i] && p.outbox.files[i].uploadId;
      const sent = await resumeUpload(p, f, (n) => {
        updateCardProgress(p.card, uploaded + n, totalSize);
      }, preId);
      uploaded += sent;
    }
    p.done = true;
    setCardStatus(p.card, 'ok', t('statusSent', 'Sent'));
    if (!p.silentToast) {
      toast(t('toastFilesSent', 'Files sent to <b>{name}</b>.').replace('{name}', esc(p.peer.name)), 'success');
      const peerName = (p.peer && p.peer.name) || (p.peer && p.peer.email) || 'peer';
      NotificationManager.notify(t('notifTransferCompleteTitle', 'Transfer complete'), {
        body: t('notifTransferCompleteBody', 'Successfully sent files to {name}', { name: peerName }),
        tag: 'sent-' + transferId
      });
    }
    if (p.onComplete) p.onComplete();
    loadHistory();
  } catch (err) {
    if (err instanceof PermanentError) {
      setCardStatus(p.card, 'err', err.message);
    } else {
      setCardStatus(p.card, '', t('statusWaitingResume', 'Waiting to resume…'));
    }
  }
  if (p.outbox) obDelete(p.outbox.id).catch(() => {});
  state.pending.delete(transferId);
}

export async function streamBytes(url, key, size, onProgress, ctrl) {
  const meta = await dlGet('meta', key);
  let received = meta ? meta.received : 0;
  let total = size || 0;
  if (received > 0) {
    if (total) onProgress(received, total);
  }
  for (;;) {
    while (ctrl && ctrl.paused && !ctrl.aborted) {
      await sleep(150);
    }
    const res = await retryNetwork(async () => {
      const r = await fetch(url, { headers: received ? { Range: `bytes=${received}-` } : {} });
      if (r.status === 206 || r.status === 200) return r;
      if (r.status === 416) return null;
      if (r.status >= 500) throw new Error('http ' + r.status);
      const e = await r.json().catch(() => ({}));
      throw new PermanentError(e.error || 'Download failed');
    });
    if (res === null) break;

    const cr = res.headers.get('content-range');
    const m = cr && /^\s*bytes\s+\d+-\d+\/(\d+)\s*$/.exec(cr);
    if (m) total = Number(m[1]) || total;
    if (!total) total = Number(res.headers.get('content-length')) || 0;

    if (received > 0 && res.status === 200) {
      await dlClearKey('parts', key);
      received = 0;
    }
    if (total) onProgress(received, total);

    const reader = res.body.getReader();
    let seq = received;
    try {
      for (;;) {
        while (ctrl && ctrl.paused && !ctrl.aborted) {
          await sleep(150);
        }
        const { done, value } = await reader.read();
        if (done) break;
        await dlPut('parts', { id: `${key}:${seq}`, key, seq, blob: new Blob([value]) });
        seq += value.length;
        if (total) onProgress(seq, total);
      }
    } catch {
      if (seq > 0) {
        await dlPut('meta', { id: key, key, received: seq, total });
        received = seq;
      }
      continue;
    }
    received = seq;
    await dlPut('meta', { id: key, key, received, total });
    if (total && received >= total) break;
    if (!total) break;
  }
  const parts = await dlAll('parts', key);
  if (!parts.length) {
    if (total === 0) {
      await dlClearKey('parts', key);
      await dlDelete('meta', key);
      return { blob: new Blob([], { type: 'application/octet-stream' }), total: 0 };
    }
    throw new PermanentError('Download failed');
  }
  const blob = new Blob(parts.map((pt) => pt.blob));
  await dlClearKey('parts', key);
  await dlDelete('meta', key);
  return { blob, total };
}

export async function downloadViaServer(url, filename, who, size) {
  const card = addTransferCard(`dl-${Date.now()}-${++dlSeq}`, {
    who: who || 'You',
    role: 'recv',
    status: 'Downloading…',
    total: size || 0,
    current: filename,
  });
  setCardConnectionType(card, 'relay');
  const key = 'dl:' + url;
  try {
    const upd = (a, b) => updateCardProgress(card, a, b);
    const { blob } = await streamBytes(url, key, size, upd, card._ctrl);
    const finalBlob = new Blob([blob], { type: resType(filename) });
    const buf = await finalBlob.arrayBuffer();
    const hash = new Sha256Hasher().update(buf).digestHex();
    setCardVerified(card, hash);
    downloadBlob(finalBlob, filename);
    setCardStatus(card, 'ok', t('statusSaved', 'Saved'));
    setCardCurrent(card, filename);
    NotificationManager.notify(t('notifFileReceivedTitle', 'File received'), {
      body: t('notifFileReceivedBody', 'Received {filename} from {name}', {
        filename: filename,
        name: who || 'Someone'
      }),
      tag: 'received-' + filename
    });
  } catch (err) {
    if (err instanceof PermanentError) {
      setCardStatus(card, 'err', err.message);
    } else {
      setCardStatus(card, '', t('statusWaitingResume', 'Waiting to resume…'));
    }
  }
}

export async function downloadEncrypted(type, id, who, size) {
  const card = addTransferCard(`dl-${Date.now()}-${++dlSeq}`, {
    who: who || '…',
    role: 'recv',
    status: 'Downloading…',
    total: size || 0,
    current: id,
  });
  setCardConnectionType(card, 'relay');
  const key = 'dl:enc:' + type + ':' + id;
  try {
    while (!state.cryptoReady) await sleep(1000);
    const meta = await retryNetwork(async () => {
      const r = await fetch(`/api/files/${type}/${id}/meta`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new PermanentError(e.error || 'Download failed');
      }
      return r.json();
    });
    let K;
    if (type === 'sent') {
      K = await selfUnwrap(state.masterKey, meta.wrap);
    } else {
      K = await peerUnwrap(state.identity.priv, meta.senderPub, meta.wrap);
    }
    const plain = JSON.parse(new TextDecoder().decode(await CRYPTO.decryptBytes(K, meta.encMeta)));
    const filename = plain.filename || id;
    const ivSalt = CRYPTO.unb64(plain.ivSalt || '');
    if (plain.senderName) setCardWho(card, plain.senderName);
    setCardCurrent(card, filename);
    const upd = (a, b) => updateCardProgress(card, a, b);
    const { blob } = await streamBytes(`/api/files/${type}/${id}/data`, key, meta.size, upd, card._ctrl);
    const cipher = new Uint8Array(await blob.arrayBuffer());
    const pt = await CRYPTO.decryptWhole(cipher, K, ivSalt, plain.size);
    const hash = new Sha256Hasher().update(pt).digestHex();
    setCardVerified(card, hash);
    downloadBlob(new Blob([pt], { type: resType(filename) }), filename);
    setCardStatus(card, 'ok', t('statusSaved', 'Saved'));
    const senderName = plain.senderName || who || 'Someone';
    NotificationManager.notify(t('notifFileReceivedTitle', 'File received'), {
      body: t('notifFileReceivedBody', 'Received {filename} from {name}', {
        filename: filename,
        name: senderName
      }),
      tag: 'received-' + filename
    });
  } catch (err) {
    if (err instanceof PermanentError) {
      setCardStatus(card, 'err', err.message);
    } else {
      setCardStatus(card, '', t('statusWaitingResume', 'Waiting to resume…'));
    }
  }
}

export function handleIncomingFile(msg) {
  // The resumed send supersedes any stale interrupted cards from this sender.
  document.querySelectorAll('.t-card').forEach((c) => {
    const stat = c.querySelector('.stat');
    const who = c.querySelector('.who');
    if (stat && /Connection lost/.test(stat.textContent) && who && who.textContent.includes(msg.sender.name)) {
      c.remove();
    }
  });
  // Download starts automatically once the sender has finished uploading.
  // Each file gets its own progress card (%). Downloads are resumable.
  const who = (msg.sender && msg.sender.name) || 'You';
  NotificationManager.notify(t('notifIncomingFileTitle', 'Incoming file'), {
    body: t('notifIncomingFileBody', '{name} is sending you files', { name: who }),
    tag: 'incoming-relay-' + Date.now()
  });
  for (const f of msg.files || []) {
    if (msg.enc) {
      downloadEncrypted('received', f.id, (msg.sender && msg.sender.email) || who, f.size);
    } else {
      downloadViaServer('/api/files/receive/' + encodeURIComponent(f.name), f.name, who, f.size);
    }
  }
  toast(t('toastDownloadingFiles', 'New file(s) from <b>{name}</b> — downloading.').replace('{name}', esc(who)), 'info', 4000);
  loadHistory();
}

