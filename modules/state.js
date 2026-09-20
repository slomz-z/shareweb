/* ---------------- State ---------------- */
export const state = {
  me: null,
  ws: null,
  wsReady: false,
  peers: [],
  room: null,
  roomMembers: [],
  roomCreated: false,
  roomLinkToken: null,
  pendingRoom: null,
  selected: null,
  files: [],
  scanning: new Set(),   // files currently being checked by the content checker
  blockedCount: 0,
  stun: [{ urls: 'stun:stun.l.google.com:19302' }],
  pending: new Map(),   // transferId -> {peer, files, totalSize}
  rtc: new Map(),       // transferId -> active rtc state
  tab: 'all',
  history: [],
  restarting: false,
  masterKey: null,      // Uint8Array derived from the account
  identity: null,       // { priv, pub } ECDH keypair
  cryptoReady: false,   // true when this browser can encrypt/decrypt
  googleGid: null,      // Google account id (transient, from the login bootstrap)
  autoLang: null,
  autoCountry: null,
  autoLangNative: null,
  autoLangName: null,
  settings: { theme: 'system', language: 'auto' },
};;
