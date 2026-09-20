// ShareWeb P2P Signaling Router (WebRTC Offers, Answers, ICE Candidates)
import { state } from './state.js';
import { wsSend } from './websocket.js';

export function handleSignal(from, data) {
  const st = state.rtc.get(data.transferId);
  if (!st) return;
  const pc = st.pc;
  switch (data.kind) {
    case 'offer':
      pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
        .then(() => pc.createAnswer())
        .then((answer) => pc.setLocalDescription(answer))
        .then(() => wsSend({ type: 'signal', to: from, data: { transferId: data.transferId, kind: 'answer', sdp: pc.localDescription } }))
        .catch(() => {});
      break;
    case 'answer':
      pc.setRemoteDescription(new RTCSessionDescription(data.sdp)).catch(() => {});
      break;
    case 'candidate':
      if (data.candidate) pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
      break;
    default:
      break;
  }
}
