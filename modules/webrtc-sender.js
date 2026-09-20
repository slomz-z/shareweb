// ShareWeb WebRTC P2P Sender & Swarm Controller
import { state } from './state.js';
import { $, esc, toast, SOUNDS, sleep, uid } from './utils.js';
import { t } from './i18n.js';
import { Sha256Hasher } from './hasher.js';
import { TarPackage } from './tar.js';
import { NotificationManager } from './notifications.js';
import { wsSend } from './websocket.js';
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
import { relayTransfer } from './relay-transfer.js';
import { obPut, obDelete } from './outbox.js';
import { peerWrap, createEnvelope } from './crypto-e2ee.js';
import { loadHistory } from './history.js';

export function isRealAccount() {
  const email = state.me && state.me.email;
  return (
    !!email &&
    !/@(shareweb\.local|offline\.local)$/i.test(email) &&
    !state.restarting
  );
}

export function sendToPeer() {
  const target = state.selected;
  if (!target || state.files.length === 0 || state.scanning.size > 0) return;
  if (state.restarting) return;

  if (target.isRoomBroadcast) {
    const members = (target.members && target.members.length > 0) ? target.members : [...state.roomMembers];
    if (!members.length) {
      toast(t('toastJoinRoomFail', 'No other members in the room.'), 'error');
      return;
    }
    sendToRoomSwarm(members);
    return;
  }

  window.ShareWebSound?.playChime('send-start');
  const files = [...state.files];
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const transferId = uid();

  const card = addTransferCard(transferId, {
    who: target.name,
    role: 'send',
    status: 'Sending…',
    progress: 0,
    total: totalSize,
    current: '',
  });

  // Persist the send so it survives a page refresh (auto-resumed on next load).
  const outboxRec = {
    id: transferId,
    peer: { email: target.email, name: target.name },
    files: files.map((f) => ({ name: f.relativePath || f.name, size: f.size, mime: f.type || '', blob: f, uploadId: uid() })),
    addedAt: Date.now(),
  };
  obPut(outboxRec).catch(() => {});

  const p = { peer: target, files, totalSize, card, relayed: false, done: false, timer: null, outbox: outboxRec };
  state.pending.set(transferId, p);

  // Attempt direct P2P connection first
  wsSend({
    type: 'rtc-offer-request',
    to: target.email,
    transferId,
    fileCount: files.length,
    totalSize,
  });

  p.timer = setTimeout(() => {
    if (!p.done && !p.relayed && !state.rtc.has(transferId)) {
      relayTransfer(transferId, 'Sending…');
    }
  }, 3500);
}

export function sendToRoomSwarm(members) {
  window.ShareWebSound?.playChime('send-start');
  const files = [...state.files];
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const swarmTotalPeers = members.length;
  let completedCount = 0;

  toast(t('toastSharingWithRoom', 'Sharing with everyone in room ({count} people) — drop files to send.').replace('{count}', swarmTotalPeers), 'info', 3000);

  members.forEach((peer) => {
    const transferId = uid();
    const card = addTransferCard(transferId, {
      who: peer.name,
      role: 'send',
      status: t('statusSendingToAll', 'Sending to everyone…'),
      progress: 0,
      total: totalSize,
      current: '',
    });

    const outboxRec = {
      id: transferId,
      peer: { email: peer.email, name: peer.name },
      files: files.map((f) => ({ name: f.relativePath || f.name, size: f.size, mime: f.type || '', blob: f, uploadId: uid() })),
      addedAt: Date.now(),
    };
    obPut(outboxRec).catch(() => {});

    const p = {
      peer,
      files,
      totalSize,
      card,
      relayed: false,
      done: false,
      timer: null,
      outbox: outboxRec,
      silentToast: true,
      onComplete: () => {
        completedCount++;
        if (completedCount === swarmTotalPeers) {
          toast(t('toastFilesSentToAll', 'Files sent to all room members.'), 'success', 4000);
          window.ShareWebSound?.playChime('transfer-complete');
          window.ShareWebSound?.triggerHaptic([30, 40, 30]);
          NotificationManager.notify(t('notifTransferCompleteTitle', 'Transfer complete'), {
            body: t('statusSentToAll', 'Sent to all members'),
            tag: 'swarm-sent-' + Date.now()
          });
        }
      }
    };
    state.pending.set(transferId, p);

    // Request direct P2P connection to this peer
    wsSend({
      type: 'rtc-offer-request',
      to: peer.email,
      transferId,
      fileCount: files.length,
      totalSize
    });

    // Seamless fallback to server relay if direct P2P does not connect within 3.5s
    p.timer = setTimeout(() => {
      if (!p.done && !p.relayed && !state.rtc.has(transferId)) {
        relayTransfer(transferId, t('statusSendingToAll', 'Sending to everyone…'));
      }
    }, 3500);
  });
}

export function handleAccept(msg) {
  const p = state.pending.get(msg.transferId);
  if (!p || p.done) return;
  clearTimeout(p.timer);
  setCardStatus(p.card, '', t('statusDirectConnecting', 'Direct connection — connecting…'));
  startRTCSender(msg.transferId, p);
}

export function handleDecline(msg) {
  const p = state.pending.get(msg.transferId);
  if (!p || p.done) return;
  p.done = true;
  setCardStatus(p.card, 'err', t('statusDeclined', 'Declined by receiver'));
  obDelete(msg.transferId).catch(() => {});
  state.pending.delete(msg.transferId);
}

export function startRTCSender(transferId, p) {
  setCardConnectionType(p.card, 'p2p');
  const pc = new RTCPeerConnection({
    iceServers: state.stun,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  });
  const dc = pc.createDataChannel(`share-${transferId}`, { ordered: true });
  const st = {
    role: 'sender',
    transferId,
    peer: p.peer,
    files: p.files,
    pc,
    dc,
    card: p.card,
    currentIdx: 0,
    sentBytes: 0,
    totalSize: p.totalSize,
    aborted: false,
    paused: false,
    hasher: new Sha256Hasher(),
  };
  state.rtc.set(transferId, st);

  if (p.card && p.card._ctrl) {
    p.card._ctrl.onPause = () => {
      st.paused = true;
      if (dc && dc.readyState === 'open') {
        try { dc.send(JSON.stringify({ t: 'pause', transferId })); } catch {}
      }
    };
    p.card._ctrl.onResume = () => {
      st.paused = false;
      if (dc && dc.readyState === 'open') {
        try { dc.send(JSON.stringify({ t: 'resume', transferId })); } catch {}
      }
    };
  }

  let dcOpened = false;
  dc.onopen = () => {
    dcOpened = true;
    sendNextFile(st);
  };
  dc.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    try {
      const m = JSON.parse(e.data);
      if (m.t === 'pause') {
        st.paused = true;
        updateCardPauseUI(st.card, true);
        setCardStatus(st.card, 'warn', t('statusPausedRemote', 'Paused by peer'));
      } else if (m.t === 'resume') {
        st.paused = false;
        updateCardPauseUI(st.card, false);
      } else if (m.t === 'verified_ack') {
        setCardVerified(st.card, m.sha256);
      }
    } catch {}
  };
  dc.onclose = () => {
    if (st.aborted) return;
    if (!st.allSent) {
      // Direct connection dropped mid-transfer: keep the send going via the server.
      relayTransfer(transferId, 'Sending…');
      return;
    }
    p.done = true;
    state.pending.delete(transferId);
    state.rtc.delete(transferId);
    if (dcOpened) {
      setCardStatus(p.card, 'ok', t('statusSent', 'Sent'));
      if (st.hasher) {
        setCardVerified(p.card, st.hasher.digestHex());
      }
      SOUNDS.playChime(true);
      SOUNDS.vibrate([30, 40, 30]);
      obDelete(transferId).catch(() => {});
      recordDirectTransfer('sender', p.peer.email, p.peer.name, p.files);
      if (!p.silentToast) {
        const peerName = (p.peer && p.peer.name) || (p.peer && p.peer.email) || 'peer';
        NotificationManager.notify(t('notifTransferCompleteTitle', 'Transfer complete'), {
          body: t('notifTransferCompleteBody', 'Successfully sent files to {name}', { name: peerName }),
          tag: 'sent-' + transferId
        });
      }
      if (p.onComplete) p.onComplete();
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'signal', to: p.peer.email, data: { transferId, kind: 'candidate', candidate: e.candidate.toJSON() } });
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      if (!dcOpened && !st.aborted && !p.relayed) relayTransfer(transferId, 'Sending…');
    } else if (pc.iceConnectionState === 'connected') {
      setCardStatus(p.card, '', t('statusConnectedP2P', 'Connected (Local/Direct P2P)'));
    }
  };

  // dc open timeout
  setTimeout(() => {
    if (!dcOpened && !st.aborted && !p.relayed && pc.iceConnectionState !== 'connected') {
      relayTransfer(transferId, 'Sending…');
    }
  }, 12000);

  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => wsSend({ type: 'signal', to: p.peer.email, data: { transferId, kind: 'offer', sdp: pc.localDescription } }))
    .catch(() => {});
}

export const CHUNK = 128 * 1024;
export const HIGH_WATER = 4 * 1024 * 1024;

export function sendChunk(dc, buf) {
  if (dc.bufferedAmount > HIGH_WATER) {
    return new Promise((resolve) => {
      const on = () => {
        dc.removeEventListener('bufferedamountlow', on);
        resolve();
      };
      dc.addEventListener('bufferedamountlow', on);
      dc.send(buf);
    });
  }
  dc.send(buf);
  return Promise.resolve();
}

async function sendNextFile(st) {
  if (st.aborted || st.currentIdx >= st.files.length) return;
  const file = st.files[st.currentIdx];
  const fileName = file.relativePath || file.name;
  const meta = { t: 'meta', transferId: st.transferId, file: { name: fileName, size: file.size, mime: file.type }, sender: { email: state.me.email, name: state.me.name } };
  st.dc.send(JSON.stringify(meta));
  st.hasher = new Sha256Hasher();
  setCardCurrent(st.card, fileName);

  let offset = 0;
  while (offset < file.size) {
    if (st.aborted) return;
    while (st.paused && !st.aborted) {
      await sleep(150);
    }
    if (st.aborted) return;
    const end = Math.min(offset + CHUNK, file.size);
    const buf = await file.slice(offset, end).arrayBuffer();
    st.hasher.update(buf);
    await sendChunk(st.dc, buf);
    offset = end;
    const currentTotal = (st.completedBytes || 0) + offset;
    updateCardProgress(st.card, currentTotal, st.totalSize);
  }

  const fileSha256 = st.hasher.digestHex();
  try {
    st.dc.send(JSON.stringify({ t: 'file_done', transferId: st.transferId, name: fileName, sha256: fileSha256 }));
  } catch {}
  setCardVerified(st.card, fileSha256);
  st.completedBytes = (st.completedBytes || 0) + file.size;

  st.currentIdx += 1;
  if (st.currentIdx >= st.files.length) {
    st.dc.send(JSON.stringify({ t: 'end', transferId: st.transferId }));
    st.allSent = true;
    if (st.onDone) st.onDone();
  } else {
    sendNextFile(st);
  }
}

export function initSenderUI() {
  $('#send-btn')?.addEventListener('click', sendToPeer);
}
