// ShareWeb Utility Helpers & Base Infrastructure

(function initSessionInterceptor() {
  try {
    const params = new URLSearchParams(window.location.search);
    const sid = params.get('sid');
    if (sid) {
      try {
        localStorage.setItem('sw_session_token', sid);
      } catch (_) {}
      params.delete('sid');
      const cleanUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    }
  } catch (_) {}

  const origFetch = window.fetch;
  window.fetch = function (resource, init) {
    init = init || {};
    if (!init.credentials) {
      init.credentials = 'include';
    }
    try {
      const token = localStorage.getItem('sw_session_token');
      if (token) {
        if (typeof Request !== 'undefined' && resource instanceof Request) {
          try {
            if (!resource.headers.has('x-session-token')) {
              resource.headers.set('x-session-token', token);
            }
          } catch (_) {
            resource = new Request(resource, {
              headers: { 'x-session-token': token }
            });
          }
        }
        if (!init.headers) {
          init.headers = { 'x-session-token': token };
        } else if (typeof Headers !== 'undefined' && init.headers instanceof Headers) {
          if (!init.headers.has('x-session-token')) {
            init.headers.set('x-session-token', token);
          }
        } else if (Array.isArray(init.headers)) {
          let hasHeader = false;
          for (let i = 0; i < init.headers.length; i++) {
            if (init.headers[i][0].toLowerCase() === 'x-session-token') {
              hasHeader = true;
              break;
            }
          }
          if (!hasHeader) init.headers.push(['x-session-token', token]);
        } else if (typeof init.headers === 'object') {
          if (!init.headers['x-session-token'] && !init.headers['X-Session-Token']) {
            init.headers['x-session-token'] = token;
          }
        }
      }
    } catch (_) {}
    return origFetch.call(this, resource, init);
  };
})();

// Global Error & Promise Rejection Handlers for DevTools Debugging
window.addEventListener('error', (event) => {
  console.error('[ShareWeb Runtime Error]', {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    col: event.colno,
    error: event.error
  });
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[ShareWeb Unhandled Promise Rejection]', event.reason);
});

export function $(sel) {
  return document.querySelector(sel);
}
export function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function fmtSize(b) {
  if (!b && b !== 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}
export function fmtSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  if (bytesPerSec >= 1073741824) return `${(bytesPerSec / 1073741824).toFixed(1)} GB/s`;
  if (bytesPerSec >= 1048576) return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSec.toFixed(0)} B/s`;
}

export const SOUNDS = (() => {
  let audioCtx = null;
  function getCtx() {
    if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {}
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playChime(success = true) {
    try {
      if (window.ShareWebSound && !window.ShareWebSound.isSoundEnabled()) return;
      const ctx = getCtx();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const t = ctx.currentTime;
      if (success) {
        osc.frequency.setValueAtTime(784, t);
        osc.frequency.exponentialRampToValueAtTime(1046.5, t + 0.12);
        gain.gain.setValueAtTime(0.08, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      } else {
        osc.frequency.setValueAtTime(300, t);
        osc.frequency.exponentialRampToValueAtTime(150, t + 0.15);
        gain.gain.setValueAtTime(0.06, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      }
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + (success ? 0.36 : 0.26));
    } catch {}
  }

  function vibrate(pattern = [30, 40, 30]) {
    try {
      if (window.ShareWebSound && !window.ShareWebSound.isSoundEnabled()) return;
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch {}
  }

  return { playChime, vibrate };
})();

export const fmtDate = (iso) => {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
export const initials = (name) => (name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
export const deviceTZ = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
};
export function reportTimezone() {
  const tz = deviceTZ();
  if (!tz) return;
  fetch('/api/user/timezone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timezone: tz }),
  }).catch(() => {});
}

export function cipherToPlain(cipherReceived, plainSize) {
  const CHUNK = 1024 * 1024;
  let off = 0;
  let plainOff = 0;
  while (off < cipherReceived) {
    const plen = Math.min(CHUNK, plainSize - plainOff);
    if (plen <= 0) break;
    off += plen + 16;
    plainOff += plen;
  }
  return plainOff;
}
export function avatarEl(pic, name, cls = 'avatar') {
  const img = document.createElement('img');
  img.className = cls;
  img.alt = '';
  if (pic) {
    img.src = pic;
    img.onerror = () => swapToInitials(img, name);
  } else {
    swapToInitials(img, name);
  }
  return img;
}
export function swapToInitials(img, name) {
  const span = document.createElement('span');
  span.className = img.className + ' initials';
  span.textContent = initials(name);
  img.replaceWith(span);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const escapeHtml = esc;

export function toast(msg, kind = 'info', ms = 4200) {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

export function showAppConfirm({
  title = '',
  message = '',
  okText = '',
  cancelText = '',
  type = 'warn',
} = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-msg');
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');
    const iconWrap = document.getElementById('confirm-icon-wrap');

    if (!modal || !okBtn || !cancelBtn) {
      resolve(confirm(message || title));
      return;
    }

    titleEl.textContent = title || 'Confirm';
    msgEl.textContent = message || '';
    okBtn.textContent = okText || 'Confirm';
    cancelBtn.textContent = cancelText || 'Cancel';

    if (type === 'danger') {
      okBtn.className = 'btn-danger';
      if (iconWrap) iconWrap.className = 'confirm-icon-wrap danger';
    } else if (type === 'info') {
      okBtn.className = 'btn-primary';
      if (iconWrap) iconWrap.className = 'confirm-icon-wrap info';
    } else {
      okBtn.className = 'btn-primary';
      if (iconWrap) iconWrap.className = 'confirm-icon-wrap';
    }

    modal.classList.remove('hidden');

    function cleanup(result) {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }

    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onKey(e) {
      if (e.key === 'Escape') cleanup(false);
      else if (e.key === 'Enter') cleanup(true);
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function enc64(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
export function dec64(s) {
  const b = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4 ? '='.repeat(4 - (b.length % 4)) : '';
  return JSON.parse(decodeURIComponent(escape(atob(b + pad))));
}

export function resType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const m = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', mp4: 'video/mp4', mp3: 'audio/mpeg', zip: 'application/zip',
    txt: 'text/plain', json: 'application/json', html: 'text/html', csv: 'text/csv',
    dmg: 'application/x-apple-diskimage', app: 'application/octet-stream',
  };
  return m[ext] || 'application/octet-stream';
}
