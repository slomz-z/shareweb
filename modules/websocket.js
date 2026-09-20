
// ShareWeb WebSocket Signaling Connection & Server Restart Handling
import { state } from './state.js';
import { $, esc, toast } from './utils.js';
import { t } from './i18n.js';
import { handleSignal } from './signaling.js';
import { renderPeople, renderRoom } from './peers-rooms.js';
import { handleOfferRequest } from './webrtc-receiver.js';
import { handleAccept, handleDecline } from './webrtc-sender.js';
import { handleIncomingFile } from './relay-transfer.js';
import { showApp } from './auth.js';

let retryDelay = 1000;
let manualClose = false;

const CONTRACT = JSON.stringify({ open: 1, msg: 'self|peers|room|signal|rtc-offer-request|rtc-accept|rtc-decline|incoming-file' });

export function connectWS() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return state.ws;
  if (manualClose) return null;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${location.host}/ws`;
  let url = base;
  try {
    const sid = localStorage.getItem('sw_session_token');
    if (sid) url += (url.includes('?') ? '&' : '?') + 'sid=' + encodeURIComponent(sid);
  } catch (_) {}
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
    retryDelay = 1000;
    state.wsReady = true;
    state.wsReadySeq = (state.wsReadySeq || 0) + 1;
    const saved = (() => { try { return localStorage.getItem('ds-room'); } catch { return null; } })();
    if (state.pendingRoom) {
      wsSend(state.pendingRoom);
      state.pendingRoom = null;
      return;
    }
    if (saved) wsSend({ type: 'join-room', room: saved, auto: true });
  };

  ws.onclose = () => {
    state.wsReady = false;
    if (manualClose) return;
    setTimeout(() => connectWS(), retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  };

  ws.onerror = (err) => { console.error("[ShareWeb WS error]", err); };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWS(msg);
  };
}

export function wsSend(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (state.ws && state.wsReady && state.ws.readyState === WebSocket.OPEN) {
    try {
      state.ws.send(JSON.stringify(obj));
      return true;
    } catch (_) { return false; }
  }
  state.pendingRoom = obj;
  return false;
}

export function handleWS(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'self':
      if (msg.stun && msg.stun.length) state.stun = msg.stun;
      break;
    case 'peers':
      state.peers = (msg.peers || []).filter((p) => p && p.email);
      renderPeople();
      break;
    case 'room':
      state.room = msg.room || null;
      state.roomMembers = msg.members || [];
      if (state.room && state.roomMembers.length && !state.roomToastShown) {
        state.roomToastShown = true;
        setTimeout(() => { state.roomToastShown = false; }, 5000);
      }
      renderRoom();
      break;
    case 'signal':
      handleSignal(msg.from, msg.data);
      break;
    case 'rtc-offer-request':
      handleOfferRequest(msg);
      break;
    case 'rtc-accept':
      handleAccept(msg);
      break;
    case 'rtc-decline':
      handleDecline(msg);
      break;
    case 'incoming-file':
      handleIncomingFile(msg);
      break;
    case 'pong':
      break;
    default:
      break;
  }
}

export function showRestarting() {
  state.restarting = true;
  startRestartingPoller();
  showApp();
}

export function startRestartingPoller() {
  if (state.restartingTimer) return;
  state.restartingTimer = setInterval(() => {
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d && d.ok) location.reload(); })
      .catch(() => {});
  }, 5000);
}
