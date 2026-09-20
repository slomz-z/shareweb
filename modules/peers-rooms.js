// ShareWeb Same-Network Peer Discovery & Room Swarms
import { state } from './state.js';
import { $, esc, avatarEl, toast } from './utils.js';
import { t } from './i18n.js';
import { wsSend } from './websocket.js';
import { sendToPeer, sendToRoomSwarm } from './webrtc-sender.js';

export function renderPeople() {
  const list = $('#people-list');
  const q = $('#search').value.trim().toLowerCase();
  const filtered = state.peers.filter(
    (p) => p.sameNetwork && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q))
  );

  list.innerHTML = '';
  $('#people-empty').classList.toggle('hidden', filtered.length > 0);

  for (const p of filtered) {
    const li = document.createElement('li');
    li.className = 'person' + (state.selected && state.selected.email === p.email ? ' selected' : '');
    const avatar = avatarEl(p.picture, p.name, 'avatar');
    li.appendChild(avatar);
    const info = document.createElement('div');
    info.className = 'person-info';
    info.innerHTML = `
        <div class="person-name"></div>`;
    info.querySelector('.person-name').textContent = p.name;
    li.appendChild(info);
    li.addEventListener('click', () => selectPerson(p));
    list.appendChild(li);
  }
}

export function selectPerson(p) {
  state.selected = p;
  renderPeople();
  renderRoom();
  const el = $('#selected-peer');
  el.classList.remove('empty', 'same', 'server', 'swarm');
  if (p.isRoomBroadcast) {
    el.classList.add('swarm');
    el.textContent = `👥 ${p.name}`;
  } else {
    el.classList.add(p.sameNetwork ? 'same' : 'server');
    el.textContent = p.name;
  }
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
  const sendBtn = $('#send-btn');
  if (sendBtn) {
    sendBtn.disabled = state.files.length === 0 || state.scanning.size > 0;
    sendBtn.textContent = p.isRoomBroadcast ? t('sendToAll', 'Send to all') : t('send', 'Send');
  }
  window.ShareWebSound?.playChime('peer-found');
  if (p.isRoomBroadcast) {
    const count = (p.members && p.members.length) || state.roomMembers.length;
    toast(t('toastSharingWithRoom', 'Sharing with everyone in room ({count} people) — drop files to send.').replace('{count}', count), 'info', 2800);
  } else {
    toast(t('toastSharingWith', 'Sharing with <b>{name}</b> — drop files to send.').replace('{name}', esc(p.name)), 'info', 2600);
  }
}

$('#search')?.addEventListener('input', renderPeople);

export function renderRoom() {
  $('#room-controls')?.classList.toggle('hidden', !!state.room);
  $('#room-current')?.classList.toggle('hidden', !state.room);
  const list = $('#room-list');
  if (list) list.innerHTML = '';
  if (!state.room) {
    $('#room-empty')?.classList.remove('hidden');
    return;
  }
  const codeEl = $('#room-code');
  if (codeEl) codeEl.textContent = state.room;
  $('#room-link-box')?.classList.toggle('hidden', !state.roomLinkToken);
  if (state.roomLinkToken) {
    const linkInput = $('#room-link');
    if (linkInput) linkInput.value = `${location.origin}/Room/${state.room}/${state.roomLinkToken}`;
  }
  $('#room-empty')?.classList.toggle('hidden', state.roomMembers.length > 0);
  if (list) {
    if (state.roomMembers.length > 0) {
      const isBroadcast = !!(state.selected && state.selected.isRoomBroadcast);
      const bLi = document.createElement('li');
      bLi.className = 'person room-broadcast-item' + (isBroadcast ? ' selected' : '');
      bLi.innerHTML = `
        <div class="avatar room-broadcast-avatar">👥</div>
        <div class="person-info">
          <div class="person-name">${esc(t('everyoneInRoom', 'Everyone in room'))}</div>
          <div class="person-sub">${state.roomMembers.length} ${state.roomMembers.length === 1 ? 'member' : 'members'}</div>
        </div>`;
      bLi.addEventListener('click', () => {
        selectPerson({
          isRoomBroadcast: true,
          name: `${t('everyoneInRoom', 'Everyone in room')} (${state.roomMembers.length})`,
          email: '__room_broadcast__',
          members: [...state.roomMembers],
          sameNetwork: false,
        });
      });
      list.appendChild(bLi);
    }
    for (const m of state.roomMembers) {
      const li = document.createElement('li');
      li.className = 'person' + (state.selected && !state.selected.isRoomBroadcast && state.selected.email === m.email ? ' selected' : '');
      const avatar = avatarEl(m.picture, m.name, 'avatar');
      li.appendChild(avatar);
      const info = document.createElement('div');
      info.className = 'person-info';
      info.innerHTML = `<div class="person-name"></div><div class="person-sub">${esc(t('inThisRoom', 'In this room'))}</div>`;
      info.querySelector('.person-name').textContent = m.name;
      li.appendChild(info);
      li.addEventListener('click', () => selectPerson({ ...m, sameNetwork: false }));
      list.appendChild(li);
    }
  }
}

export function joinRoom(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(c)) return toast(t('toastEnterRoomCode', 'Enter the 6-character room code.'), 'error');
  if (state.ws && state.wsReady) {
    wsSend({ type: 'join-room', room: c });
  } else {
    toast(t('toastNotConnected', 'You are not connected yet. Wait a moment and try again.'), 'error');
  }
}

export function leaveRoom() {
  wsSend({ type: 'leave-room' });
  state.room = null;
  state.roomMembers = [];
  state.roomCreated = false;
  state.roomLinkToken = null;
  try {
    localStorage.removeItem('ds-room');
  } catch {}
  toast(t('toastLeftRoom', 'Left the room.'), 'info');
  renderRoom();
}

export function initPeersRoomsUI() {
  // Room actions require a live signaling connection. Refuse with feedback
  // instead of silently dropping the message, so buttons never appear dead.
  const requireWs = () => {
    if (state.ws && state.wsReady) return true;
    toast(t('toastNotConnected', 'You are not connected yet. Wait a moment and try again.'), 'error');
    return false;
  };

  $('#room-create')?.addEventListener('click', () => {
    if (!requireWs()) return;
    state.roomCreated = true;
    wsSend({ type: 'create-room' });
  });
  $('#room-join')?.addEventListener('click', () => joinRoom($('#room-input')?.value));
  $('#room-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom($('#room-input')?.value);
  });
  $('#room-join-btn')?.addEventListener('click', () => {
    const code = ($('#room-code-input')?.value || '').trim();
    if (code) joinRoom(code);
  });
  $('#room-leave-btn')?.addEventListener('click', leaveRoom);
  $('#room-leave')?.addEventListener('click', leaveRoom);

  $('#room-copy')?.addEventListener('click', async () => {
    if (!state.room) return;
    try {
      await navigator.clipboard.writeText(state.room);
      toast(t('toastRoomCodeCopied', 'Room code copied — share it with someone.'), 'success');
    } catch {
      toast(t('toastCopyCodeFail', 'Could not copy the room code.'), 'error');
    }
  });

  $('#room-link-copy')?.addEventListener('click', async () => {
    const el = $('#room-link');
    if (!el || !el.value) return;
    try {
      await navigator.clipboard.writeText(el.value);
      toast(t('toastInviteLinkCopied', 'Invite link copied — share it with someone.'), 'success');
    } catch {
      toast(t('toastCopyInviteLinkFail', 'Could not copy the invite link.'), 'error');
    }
  });

  $('#room-qr-btn')?.addEventListener('click', () => {
    if (!state.room) {
      toast(t('joinRoomFirst', 'Please create or join a room first.'), 'info');
      return;
    }
    const roomUrl = $('#room-link')?.value || (window.location.origin + '/?room=' + encodeURIComponent(state.room));
    if (window.ShareWebQR) {
      window.ShareWebQR.showModal(t('scanToConnect', 'Scan to Connect'), roomUrl, roomUrl);
    }
  });

  $('#qr-close-btn')?.addEventListener('click', () => {
    if (window.ShareWebQR) window.ShareWebQR.hideModal();
  });

  $('#modal-qr')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget && window.ShareWebQR) window.ShareWebQR.hideModal();
  });

  $('#qr-copy-btn')?.addEventListener('click', async () => {
    const el = document.getElementById('qr-link-input');
    if (!el || !el.value) return;
    try {
      await navigator.clipboard.writeText(el.value);
      toast(t('toastInviteLinkCopied', 'Invite link copied — share it with someone.'), 'success');
    } catch {
      toast(t('toastCopyInviteLinkFail', 'Could not copy the invite link.'), 'error');
    }
  });
}
