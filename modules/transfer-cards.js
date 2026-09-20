// ShareWeb Transfer Card UI Controller
import { state } from './state.js';
import { $, esc, fmtSize, fmtSpeed, avatarEl } from './utils.js';
import { t } from './i18n.js';
import { openQuickLook } from './lightbox.js';

export function addTransferCard(transferId, { who, role, status, progress, total, current }) {
  const box = $('#transfers');
  const card = document.createElement('div');
  card.className = 't-card';
  card.dataset.tid = transferId;
  card.innerHTML = `
    <div class="t-head">
      <div style="display:flex; align-items:center; gap:8px; min-width:0; overflow:hidden;">
        <span class="who"></span>
        <span class="conn-badge hidden"></span>
        <span class="t-verified-badge hidden" title="${t('verifiedIntegrity', 'Integrity verified')}">✓ ${t('verifiedChecksum', 'Verified')}</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px; flex:none;">
        <button class="t-btn-pause" type="button" title="${t('pauseTransfer', 'Pause transfer')}" aria-label="${t('pauseTransfer', 'Pause transfer')}">⏸</button>
        <span class="stat"></span>
      </div>
    </div>
    <div class="pbar"><div></div></div>
    <div class="t-meta">
      <span class="cur"></span>
      <div style="display:flex; align-items:center; gap:6px; flex:none;">
        <span class="speed-meter hidden"></span>
        <span class="eta-tag hidden"></span>
        <span class="pct">0%</span>
      </div>
    </div>`;

  const ctrl = {
    transferId,
    role,
    card,
    paused: false,
    onPause: null,
    onResume: null,
    pause() {
      if (this.paused) return;
      this.paused = true;
      updateCardPauseUI(card, true);
      const p = state.pending && state.pending.get(transferId);
      if (p) p.paused = true;
      const st = state.rtc && state.rtc.get(transferId);
      if (st) st.paused = true;
      if (this.onPause) this.onPause();
    },
    resume() {
      if (!this.paused) return;
      this.paused = false;
      updateCardPauseUI(card, false);
      const p = state.pending && state.pending.get(transferId);
      if (p) p.paused = false;
      const st = state.rtc && state.rtc.get(transferId);
      if (st) st.paused = false;
      if (this.onResume) this.onResume();
    },
    setVerified(sha256Hex) {
      setCardVerified(card, sha256Hex);
    }
  };
  card._ctrl = ctrl;
  if (!state.transfers) state.transfers = new Map();
  state.transfers.set(transferId, ctrl);

  const pauseBtn = card.querySelector('.t-btn-pause');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (ctrl.paused) {
        ctrl.resume();
      } else {
        ctrl.pause();
      }
    });
  }

  const whoEl = card.querySelector('.who');
  whoEl.textContent = `${role === 'send' ? '→' : '←'} ${who}`;
  card.querySelector('.stat').textContent = status;
  card.querySelector('.cur').textContent = current || '';
  box.appendChild(card);
  return card;
}

export function updateCardPauseUI(card, isPaused) {
  if (!card) return;
  const btn = card.querySelector('.t-btn-pause');
  const bar = card.querySelector('.pbar');
  const statEl = card.querySelector('.stat');
  if (isPaused) {
    if (btn) {
      btn.classList.add('is-paused');
      btn.textContent = '▶';
      btn.title = t('resumeTransfer', 'Resume transfer');
      btn.setAttribute('aria-label', t('resumeTransfer', 'Resume transfer'));
    }
    if (bar) bar.classList.add('paused');
    if (statEl) {
      if (!card._prePauseStatus && !statEl.textContent.includes(t('statusPaused', 'Paused'))) {
        card._prePauseStatus = statEl.innerHTML;
        card._prePauseClass = statEl.className;
      }
      statEl.className = 'stat warn';
      statEl.textContent = t('statusPaused', 'Paused');
    }
  } else {
    if (btn) {
      btn.classList.remove('is-paused');
      btn.textContent = '⏸';
      btn.title = t('pauseTransfer', 'Pause transfer');
      btn.setAttribute('aria-label', t('pauseTransfer', 'Pause transfer'));
    }
    if (bar) bar.classList.remove('paused');
    if (statEl && card._prePauseStatus) {
      statEl.className = card._prePauseClass || 'stat';
      statEl.innerHTML = card._prePauseStatus;
      card._prePauseStatus = null;
    }
  }
}

export function setCardVerified(card, sha256Hex) {
  if (!card) return;
  const badge = card.querySelector('.t-verified-badge');
  if (!badge) return;
  badge.classList.remove('hidden');
  if (sha256Hex) {
    badge.title = `${t('verifiedChecksum', 'Verified')} (SHA-256: ${sha256Hex.slice(0, 16)}…)`;
  }
}

export function setCardConnectionType(card, type) {
  if (!card) return;
  const badge = card.querySelector('.conn-badge');
  if (!badge) return;
  badge.classList.remove('hidden', 'p2p', 'relay');
  if (type === 'p2p') {
    badge.classList.add('p2p');
    badge.textContent = '🟢 Direct P2P';
    badge.title = 'Direct Peer-to-Peer LAN Connection';
  } else if (type === 'relay') {
    badge.classList.add('relay');
    badge.textContent = '🔵 Server Relay';
    badge.title = 'End-to-End encrypted relay via server';
  }
}

export function setCardWho(card, who) {
  card.querySelector('.who').textContent = who;
}

export function setCardStatus(card, kind, text) {
  const s = card.querySelector('.stat');
  if (s) {
    s.className = 'stat ' + (kind || '');
    s.innerHTML = text || '';
  }
  if (kind === 'ok') {
    window.ShareWebSound?.playChime('transfer-complete');
    const btn = card.querySelector('.t-btn-pause');
    if (btn) btn.remove();
    const bar = card.querySelector('.pbar');
    if (bar) bar.classList.remove('paused');
  } else if (kind === 'err') {
    window.ShareWebSound?.playChime('error');
    const btn = card.querySelector('.t-btn-pause');
    if (btn) btn.remove();
    const bar = card.querySelector('.pbar');
    if (bar) bar.classList.remove('paused');
  }
}

export function setCardCurrent(card, cur) {
  card.querySelector('.cur').textContent = cur || '';
}

export function updateCardProgress(card, bytes, total) {
  const pct = total ? Math.min(100, Math.round((bytes / total) * 100)) : 0;
  const bar = card.querySelector('.pbar > div');
  if (bar) bar.style.width = pct + '%';

  const pctEl = card.querySelector('.pct');
  const speedEl = card.querySelector('.speed-meter');
  const etaEl = card.querySelector('.eta-tag');
  const now = performance.now();
  if (!card._speedTracker) {
    card._speedTracker = { lastBytes: bytes, lastTime: now, emaSpeed: 0 };
  }
  const st = card._speedTracker;
  const dt = (now - st.lastTime) / 1000;
  if (dt >= 0.25) {
    const dBytes = bytes - st.lastBytes;
    const instantSpeed = dBytes / dt;
    st.emaSpeed = st.emaSpeed === 0 ? instantSpeed : 0.7 * st.emaSpeed + 0.3 * instantSpeed;
    st.lastBytes = bytes;
    st.lastTime = now;
  }

  if (pctEl) pctEl.textContent = `${pct}%`;

  if (st.emaSpeed > 1024) {
    if (speedEl) {
      speedEl.textContent = `⚡ ${fmtSpeed(st.emaSpeed)}`;
      speedEl.classList.remove('hidden');
    }
    const remaining = total - bytes;
    if (remaining > 0 && st.emaSpeed > 0 && etaEl) {
      const sec = Math.ceil(remaining / st.emaSpeed);
      if (sec < 60) etaEl.textContent = `⏱️ ~${sec}s`;
      else if (sec < 3600) etaEl.textContent = `⏱️ ~${Math.ceil(sec / 60)}m`;
      else etaEl.textContent = `⏱️ >1h`;
      etaEl.classList.remove('hidden');
    } else if (etaEl) {
      etaEl.classList.add('hidden');
    }
  }
}

