// ShareWeb WebRTC P2P Receiver & Tarball Extractor
import { state } from './state.js';
import { $, esc, avatarEl, fmtSize, toast, SOUNDS } from './utils.js';
import { t } from './i18n.js';
import { Sha256Hasher } from './hasher.js';
import { TarPackage, writeToDirectory } from './tar.js';
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
import { peerUnwrap } from './crypto-e2ee.js';
import { dlPut } from './outbox.js';
import { loadHistory } from './history.js';

export function handleOfferRequest(msg) {
  const pc = new RTCPeerConnection({
    iceServers: state.stun,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  });
  const transferId = msg.transferId;
  const peer = state.peers.get(msg.from);
  const senderName = (peer && peer.name) || msg.name || 'Someone';
  NotificationManager.notify(t('notifIncomingFileTitle', 'Incoming file'), {
    body: t('notifIncomingFileBody', '{name} is sending you files', { name: senderName }),
    tag: 'incoming-' + transferId
  });
  const card = addTransferCard(transferId, {
    who: (peer && peer.name) || '…',
    role: 'receive',
    status: 'Incoming…',
    progress: 0,
    total: msg.totalSize || 0,
    current: '',
  });
  setCardConnectionType(card, 'p2p');

  const st = {
    role: 'receiver',
    transferId,
    from: msg.from,
    pc,
    card,
    parts: [],
    current: null,
    fileBytes: 0,
    received: 0,
    total: msg.totalSize || 0,
    sender: null,
    done: false,
  };
  state.rtc.set(transferId, st);

  pc.ondatachannel = (e) => {
    st.dc = e.channel;
    bindReceiverChannel(st);
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'signal', to: msg.from, data: { transferId, kind: 'candidate', candidate: e.candidate.toJSON() } });
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'connected') setCardStatus(card, '', t('statusDirectConnected', 'Direct connection established (Local/Direct P2P)'));
  };

  wsSend({ type: 'rtc-accept', to: msg.from, transferId });

  setTimeout(() => {
    if (!st.done && !st.dc) {
      setCardStatus(card, 'err', t('statusConnFailed', 'Connection failed'));
      try {
        pc.close();
      } catch {}
      state.rtc.delete(transferId);
    }
  }, 15000);
}

export function bindReceiverChannel(st) {
  if (st.card && st.card._ctrl) {
    st.card._ctrl.onPause = () => {
      st.paused = true;
      if (st.dc && st.dc.readyState === 'open') {
        try { st.dc.send(JSON.stringify({ t: 'pause', transferId: st.transferId })); } catch {}
      }
    };
    st.card._ctrl.onResume = () => {
      st.paused = false;
      if (st.dc && st.dc.readyState === 'open') {
        try { st.dc.send(JSON.stringify({ t: 'resume', transferId: st.transferId })); } catch {}
      }
    };
  }

  st.dc.binaryType = 'arraybuffer';
  st.dc.onmessage = async (e) => {
    if (typeof e.data === 'string') {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'pause') {
        st.paused = true;
        updateCardPauseUI(st.card, true);
        setCardStatus(st.card, 'warn', t('statusPausedRemote', 'Paused by peer'));
      } else if (m.t === 'resume') {
        st.paused = false;
        updateCardPauseUI(st.card, false);
        const curName = st.current ? st.current.name : '';
        if (curName) {
          setCardStatus(st.card, '', t('statusReceivingFile', 'Receiving <b>{name}</b>…').replace('{name}', esc(curName)));
        }
      } else if (m.t === 'file_done') {
        const computed = st.hasher ? st.hasher.digestHex() : '';
        if (computed && computed === m.sha256) {
          setCardVerified(st.card, computed);
          if (st.dc && st.dc.readyState === 'open') {
            try {
              st.dc.send(JSON.stringify({ t: 'verified_ack', transferId: st.transferId, sha256: computed }));
            } catch {}
          }
        }
      } else if (m.t === 'meta') {
        // A new file is starting: save the previous one first.
        if (st.current) await finalizeReceivedFile(st);
        st.hasher = new Sha256Hasher();
        st.sender = m.sender;
        const isFolder = !!(m.file.name && m.file.name.includes('/'));
        if (isFolder) {
          st.isFolder = true;
          if (!st.folderTar) {
            const rootName = m.file.name.split('/')[0] || 'folder';
            st.folderTar = new TarPackage(rootName);
          }
        }
        st.current = { name: m.file.name, size: m.file.size, mime: m.file.type, chunks: [], isFolder };
        st.fileBytes = 0;
        const who = st.sender ? st.sender.name : st.from;
        setCardWho(st.card, who);
        setCardStatus(st.card, '', t('statusReceivingFile', 'Receiving <b>{name}</b>…').replace('{name}', esc(m.file.name)));
        setCardCurrent(st.card, m.file.name);
      } else if (m.t === 'end') {
        if (st.current) {
          await finalizeReceivedFile(st);
        }
        st.completed = true;
        if (st.isFolder && st.folderTar) {
          if (!st.dirHandle) {
            const tarBlob = st.folderTar.buildBlob();
            downloadBlob(tarBlob, `${st.folderTar.rootName}.tar`);
          }
          setCardStatus(st.card, 'ok', t('statusFolderSaved', 'Folder package saved'));
          setCardCurrent(st.card, `${st.folderTar.rootName} (${st.folderTar.files.length} files)`);
          NotificationManager.notify(t('notifFileReceivedTitle', 'File received'), {
            body: t('notifFileReceivedBody', 'Received {filename} from {name}', {
              filename: `${st.folderTar.rootName}.tar`,
              name: (st.sender && st.sender.name) || st.from || 'Someone'
            }),
            tag: 'received-folder-' + st.transferId
          });
        } else {
          setCardStatus(st.card, 'ok', t('statusReceived', 'Received'));
        }
        toast(t('toastFilesReceived', 'Received files from <b>{name}</b>.').replace('{name}', esc(st.sender ? st.sender.name : st.from)), 'success', 3000);
      }
    } else if (st.current) {
      if (st.hasher) st.hasher.update(e.data);
      st.current.chunks.push(e.data);
      st.fileBytes += e.data.byteLength;
      st.received += e.data.byteLength;
      updateCardProgress(st.card, st.received, st.total);
    }
  };
  st.dc.onclose = () => {
    if (st.done) return;
    st.done = true;
    if (!st.completed) {
      // Connection dropped before the file finished: never save a partial file.
      // The sender keeps the send saved and will finish it through the server.
      setCardStatus(st.card, 'err', t('statusConnLostResend', 'Connection lost — will be resent'));
      st.current = null;
      toast(t('toastConnLost', 'Connection lost. The sender will finish sending.'), 'info');
    }
    try {
      st.pc.close();
    } catch {}
    state.rtc.delete(st.transferId);
    loadHistory();
  };
}

async function finalizeReceivedFile(st) {
  const cur = st.current;
  st.current = null;
  const blob = new Blob(cur.chunks, { type: cur.mime || 'application/octet-stream' });
  if (cur.isFolder && st.folderTar) {
    const u8 = new Uint8Array(await blob.arrayBuffer());
    st.folderTar.addFile(cur.name, u8);
    if (st.dirHandle) {
      try {
        await saveToDirectoryHandle(st.dirHandle, cur.name, blob);
      } catch (err) {
        console.warn('Direct directory write error:', err);
      }
    }
  } else {
    downloadBlob(blob, cur.name);
  }
  SOUNDS.playChime(true);
  SOUNDS.vibrate([30, 40, 30]);

  if (!cur.isFolder) {
    const senderDisplayName = (st.sender && st.sender.name) || st.from || 'Someone';
    NotificationManager.notify(t('notifFileReceivedTitle', 'File received'), {
      body: t('notifFileReceivedBody', 'Received {filename} from {name}', {
        filename: cur.name,
        name: senderDisplayName
      }),
      tag: 'received-' + (cur.name || 'file')
    });
  }

  const fromEmail = st.sender ? st.sender.email : st.from;
  const fromName = st.sender ? st.sender.name : '';
  try {
    const fd = new FormData();
    fd.append('from', fromEmail);
    fd.append('senderName', fromName);
    fd.append('file', blob, cur.name);
    fd.append('relativePath', cur.name);
    const res = await fetch('/api/files/archive', { method: 'POST', body: fd });
    if (res.ok) {
      setCardStatus(st.card, '', t('statusSavedArchived', 'Saved {name} — archived to your history').replace('{name}', esc(cur.name)));
      return;
    }
  } catch {}

  // Always record the direct transfer metadata in history
  recordDirectTransfer('receiver', fromEmail, fromName, [{ name: cur.name, size: cur.size, mime: cur.mime, relativePath: cur.name }]);

  // Server unreachable or rejected the archive: file is already downloaded to device.
  setCardStatus(st.card, '', t('statusSavedDevice', 'Saved {name} to your device').replace('{name}', esc(cur.name)));
}

async function recordDirectTransfer(role, partnerEmail, partnerName, files) {
  if (!files || !files.length || !partnerEmail) return;
  try {
    for (const f of files) {
      await fetch('/api/files/record-direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role,
          partnerEmail,
          partnerName,
          filename: f.name || f.filename,
          relativePath: f.relativePath || f.name || f.filename,
          size: f.size || 0,
          mime: f.mime || f.type || 'application/octet-stream',
        }),
      });
    }
    loadHistory();
  } catch {}
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
