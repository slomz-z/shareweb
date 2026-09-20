import { state } from './state.js';
import { $, esc, fmtSize, fmtDate, toast, resType } from './utils.js';
import { t } from './i18n.js';
import { openQuickLook } from './lightbox.js';
import { downloadViaServer, downloadEncrypted } from './relay-transfer.js';
import { selfUnwrap, peerUnwrap } from './crypto-e2ee.js';

const CRYPTO = (typeof window !== 'undefined' && window.CRYPTO) ? window.CRYPTO : null;

const unlockFailed = new Set();

export function hiddenFiles() {
  try {
    return JSON.parse(localStorage.getItem('ds-hidden-history') || '[]');
  } catch {
    return [];
  }
}

export function hideFile(id) {
  if (!id) return;
  try {
    const set = new Set(hiddenFiles());
    set.add(id);
    localStorage.setItem('ds-hidden-history', JSON.stringify([...set]));
  } catch {}
}

export async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    if (!res.ok) return;
    const data = await res.json();
    const hidden = new Set(hiddenFiles());
    state.history = (data.items || []).filter((it) => !hidden.has(it.id));
    renderHistory();
  } catch {}
}

function renderEncryptedName(nameEl, filename) {
  if (!nameEl) return;
  const parts = String(filename || '').split('/').filter(Boolean);
  if (parts.length > 1) {
    const path = parts.slice(0, -1).join('/') + '/';
    nameEl.innerHTML = `<span class="tree-path">${esc(path)}</span>${esc(parts[parts.length - 1])}`;
  } else {
    nameEl.textContent = filename || t('encryptedFile', 'Encrypted file');
  }
  nameEl.title = filename || '';
}

async function readEncryptedMetadata(it) {
  const res = await fetch(`/api/files/${it.type}/${it.id}/meta`);
  if (!res.ok) throw new Error('Unable to read file details');
  const meta = await res.json();
  let key;
  if (it.type === 'sent') {
    key = await selfUnwrap(state.masterKey, meta.wrap);
  } else {
    key = await peerUnwrap(state.identity.priv, meta.senderPub, meta.wrap);
  }
  const bytes = await CRYPTO.decryptBytes(key, meta.encMeta);
  return { plain: JSON.parse(new TextDecoder().decode(bytes)), key };
}

function updateEncryptedItem(li, it, plain) {
  if (!li.isConnected) return;
  const filename = plain.filename || t('encryptedFile', 'Encrypted file');
  renderEncryptedName(li.querySelector('.h-fname'), filename);

  const sub = li.querySelector('.h-sub');
  if (sub) {
    const partner = it.type === 'sent'
      ? (plain.receiverEmail || it.receiverEmail || t('unknown', 'Unknown'))
      : (plain.senderName || plain.senderEmail || it.senderEmail || t('unknown', 'Unknown'));
    const direction = it.type === 'sent' ? t('to', 'To') : t('from', 'From');
    sub.textContent = `${direction} ${partner} · ${fmtSize(plain.size || it.size)}`;
  }

  const date = li.querySelector('.h-date');
  if (date) date.textContent = fmtDate(plain.ts || it.createdAt || Date.now());
}

export async function renderEncHistory(li, it) {
  if (!state.cryptoReady || !CRYPTO || !li || !li.isConnected) return;
  try {
    const { plain } = await readEncryptedMetadata(it);
    unlockFailed.delete(it.id);
    updateEncryptedItem(li, it, plain);
  } catch {
    unlockFailed.add(it.id);
    renderEncryptedName(li.querySelector('.h-fname'), `${t('cannotUnlock', 'Can’t unlock')} — ${t('encryptedFile', 'Encrypted file')}`);
    const sub = li.querySelector('.h-sub');
    if (sub) sub.textContent = t('cannotUnlockHint', 'Encrypted with an older key on this account');
  }
}

async function previewEncryptedWithKey(it, key, plain) {
  try {
    const ivSalt = CRYPTO.unb64(plain.ivSalt || '');
    const dataRes = await fetch(`/api/files/${it.type}/${it.id}/data`);
    if (!dataRes.ok) throw new Error('Unable to open this file');
    const cipher = new Uint8Array(await dataRes.arrayBuffer());
    const decrypted = await CRYPTO.decryptWhole(cipher, key, ivSalt, plain.size);
    const filename = plain.filename || it.id;
    openQuickLook({
      blob: new Blob([decrypted], { type: resType(filename) }),
      filename,
      size: plain.size || it.size,
      mime: resType(filename)
    });
  } catch (err) {
    toast(`Preview error: ${err.message || 'Unable to preview this file'}`, 'error');
  }
}

export function renderHistory() {
  const list = $('#history-list');
  if (!list) return;
  const empty = $('#history-empty');
  if (empty) empty.classList.toggle('hidden', false);
  list.innerHTML = '';

  const items = state.history.filter((it) => state.tab === 'all' || it.type === state.tab);
  if (empty) empty.classList.toggle('hidden', items.length > 0);

  for (const it of items) {
    const li = document.createElement('li');
    li.className = `h-item ${it.type === 'received' ? 'received' : 'sent'}`;
    const dl = it.type === 'sent' ? '/api/files/send/' : '/api/files/receive/';
    const direction = it.type === 'sent' ? t('to', 'To') : t('from', 'From');
    const dlTitle = t('download', 'Download');
    const delTitle = t('removeFromHistory', 'Remove from history');

    if (it.enc) {
      const filename = t('encryptedFile', 'Encrypted file');
      const partner = it.type === 'sent' ? (it.receiverEmail || '...') : (it.senderEmail || '...');
      li.innerHTML = `
        <div class="h-icon">${it.type === 'sent' ? '↑' : '↓'}</div>
        <div class="h-info">
          <div class="h-fname">${esc(filename)}</div>
          <div class="h-sub">${direction} ${esc(partner)} · ${fmtSize(it.size)}</div>
        </div>
        <div class="h-date">${fmtDate(it.createdAt || Date.now())}</div>
        <button class="h-preview-btn" type="button" title="${esc(t('quicklook', 'QuickLook'))}" aria-label="${esc(t('quicklook', 'QuickLook'))}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="h-dl" type="button" title="${esc(dlTitle)}" aria-label="${esc(dlTitle)}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button class="h-del" type="button" title="${esc(delTitle)}" aria-label="${esc(delTitle)}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>`;

      li.querySelector('.h-preview-btn').addEventListener('click', async () => {
        if (!state.cryptoReady || !CRYPTO) {
          toast(t('unlockNeeded', 'Unlock your account to open protected files.'), 'info');
          return;
        }
        if (unlockFailed.has(it.id)) {
          toast(t('cannotUnlockHint', 'Encrypted with an older key on this account'), 'error');
          return;
        }
        try {
          const { plain, key } = await readEncryptedMetadata(it);
          previewEncryptedWithKey(it, key, plain);
        } catch (err) {
          toast(`Preview error: ${err.message || 'Unable to preview this file'}`, 'error');
        }
      });
      li.querySelector('.h-dl').addEventListener('click', () => {
        if (!state.cryptoReady || !CRYPTO) {
          toast(t('unlockNeeded', 'Unlock your account to download protected files.'), 'info');
          return;
        }
        if (unlockFailed.has(it.id)) {
          toast(t('cannotUnlockHint', 'Encrypted with an older key on this account'), 'error');
          return;
        }
        downloadEncrypted(it.type, it.id, it.receiverEmail || it.senderEmail || '…', it.size);
      });
      li.querySelector('.h-del').addEventListener('click', () => {
        hideFile(it.id);
        toast(t('removedFromHistory', 'Removed this file from your history.'), 'info', 3000);
        renderHistory();
      });
      renderEncHistory(li, it);
    } else {
      const partner = it.partner && (it.partner.name || it.partner.email) ? (it.partner.name || it.partner.email) : t('unknown', 'Unknown');
      const displayName = it.relativePath || it.filename || it.id || t('unknown', 'Unknown');
      const isFolder = displayName.includes('/');
      const fnHtml = isFolder
        ? `<span class="tree-path">${esc(displayName.slice(0, displayName.lastIndexOf('/') + 1))}</span>${esc(displayName.slice(displayName.lastIndexOf('/') + 1))}`
        : esc(displayName);
      li.innerHTML = `
        <div class="h-icon">${it.type === 'sent' ? '↑' : '↓'}</div>
        <div class="h-info">
          <div class="h-fname" title="${esc(displayName)}">${fnHtml}</div>
          <div class="h-sub">${direction} ${esc(partner)} · ${fmtSize(it.size)}</div>
        </div>
        <div class="h-date">${fmtDate(it.timestamp || it.createdAt || Date.now())}</div>
        <button class="h-preview-btn" type="button" title="${esc(t('quicklook', 'QuickLook'))}" aria-label="${esc(t('quicklook', 'QuickLook'))}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="h-dl" type="button" title="${esc(dlTitle)}" aria-label="${esc(dlTitle)}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button class="h-del" type="button" title="${esc(delTitle)}" aria-label="${esc(delTitle)}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>`;
      li.querySelector('.h-preview-btn').addEventListener('click', () => {
        openQuickLook({
          url: dl + encodeURIComponent(displayName),
          filename: displayName,
          size: it.size,
          mime: resType(displayName)
        });
      });
      li.querySelector('.h-dl').addEventListener('click', () => {
        downloadViaServer(dl + encodeURIComponent(displayName), displayName, partner, it.size);
      });
      li.querySelector('.h-del').addEventListener('click', () => {
        hideFile(it.id);
        toast(t('toastRemovedFromHistory', 'Removed <b>{name}</b> from your history.').replace('{name}', esc(displayName)), 'info', 3000);
        renderHistory();
      });
    }
    list.appendChild(li);
  }
}

export function initHistoryUI() {
  document.querySelectorAll('.tabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs .tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.tab = btn.dataset.tab;
      renderHistory();
    });
  });
}
