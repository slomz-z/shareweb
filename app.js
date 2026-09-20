// ShareWeb Client — Clean Modular ES Module Entry Point
import { $, uid, fmtSize, fmtSpeed, fmtDate, initials, deviceTZ, reportTimezone, cipherToPlain, avatarEl, swapToInitials, esc, escapeHtml, toast, showAppConfirm, sleep, enc64, dec64, resType, SOUNDS } from './modules/utils.js';
import { state } from './modules/state.js';
import { TRANSLATIONS } from './modules/translations.js';
import { WORLD_LANGUAGES, getEffectiveLangCode, t, initLanguage, applyLanguage } from './modules/i18n.js';
import { openKeyDB, masterCacheGet, masterCacheSet, masterCacheClear, ownX, selfKey, selfWrap, selfUnwrap, peerWrap, peerUnwrap, createEnvelope, getPeerPub } from './modules/crypto-e2ee.js';
import { Sha256Hasher } from './modules/hasher.js';
import { TarPackage, writeToDirectory } from './modules/tar.js';
import { initTheme, setTheme } from './modules/theme.js';
import { initSettingsModal, closeSettingsModal, saveUserSettingsToServer, detectLanguageByIp, updateAutoOptionLabel, wipeAllCookiesSecretly } from './modules/settings.js';
import { NotificationManager, checkNotificationBanner, isIOS, initNotificationsUI } from './modules/notifications.js';
import { registerSW, initPWA } from './modules/pwa.js';
import { openQuickLook, closeQuickLook, initQuickLook } from './modules/lightbox.js';
import { addTransferCard, updateCardPauseUI, setCardVerified, setCardConnectionType, setCardWho, setCardStatus, setCardCurrent, updateCardProgress } from './modules/transfer-cards.js';
import { MOD } from './modules/content-checker.js';
import { addFiles, renderPicked, initFilePicker, extractFilesFromDataTransfer } from './modules/file-picker.js';
import { openOutboxDB, obPut, obAll, obDelete, dlSeq, openDownloadDB, dlPut, dlGet, dlAll, dlDelete, dlClearKey } from './modules/outbox.js';
import { handleSignal } from './modules/signaling.js';
import { connectWS, wsSend, handleWS, showRestarting, startRestartingPoller } from './modules/websocket.js';
import { renderPeople, selectPerson, renderRoom, joinRoom, leaveRoom, initPeersRoomsUI } from './modules/peers-rooms.js';
import { PermanentError, ResyncError, retryNetwork, UPLOAD_CHUNK, resumeUpload, relayTransfer, streamBytes, downloadViaServer, downloadEncrypted, handleIncomingFile } from './modules/relay-transfer.js';
import { isRealAccount, sendToPeer, sendToRoomSwarm, handleAccept, handleDecline, startRTCSender, CHUNK, HIGH_WATER, sendChunk, initSenderUI } from './modules/webrtc-sender.js';
import { handleOfferRequest, bindReceiverChannel, downloadBlob } from './modules/webrtc-receiver.js';
import { hiddenFiles, hideFile, loadHistory, renderHistory, initHistoryUI } from './modules/history.js';
import { initGlidingCaret } from './modules/caret.js';
import { ea, eaSetTab, eaShow, eaErr, eaClear, eaResetToEmail, validatePasswordClient, bindPasswordRequirements, checkPendingGoogleAuth, startSession, checkTemporaryTestMode, parseRoomLink, showLogin, showLoginOrRedirect, requireLogin, showApp, refreshSparkStatus, rememberAccount, getLastAccount, renderUserHeader, renderMenuAvatar, openHistoryPage, closeMenu, initAuthUI, boot } from './modules/auth.js';
import { isPasskeySupported, registerPasskey, authenticatePasskey, getAccountPasskeys, deleteAccountPasskey } from './modules/passkeys.js';

// Export all modules and singletons for ES import consumers
export {
  $, uid, fmtSize, fmtSpeed, fmtDate, initials, deviceTZ, reportTimezone, cipherToPlain, avatarEl, swapToInitials, esc, escapeHtml, toast, showAppConfirm, sleep, enc64, dec64, resType, SOUNDS,
  state,
  TRANSLATIONS,
  WORLD_LANGUAGES, getEffectiveLangCode, t, initLanguage, applyLanguage,
  openKeyDB, masterCacheGet, masterCacheSet, masterCacheClear, ownX, selfKey, selfWrap, selfUnwrap, peerWrap, peerUnwrap, createEnvelope, getPeerPub,
  Sha256Hasher,
  TarPackage, writeToDirectory,
  initTheme, setTheme,
  initSettingsModal, closeSettingsModal, saveUserSettingsToServer, detectLanguageByIp, updateAutoOptionLabel, wipeAllCookiesSecretly,
  NotificationManager, checkNotificationBanner, isIOS, initNotificationsUI,
  registerSW, initPWA,
  openQuickLook, closeQuickLook, initQuickLook,
  addTransferCard, updateCardPauseUI, setCardVerified, setCardConnectionType, setCardWho, setCardStatus, setCardCurrent, updateCardProgress,
  MOD,
  addFiles, renderPicked, initFilePicker, extractFilesFromDataTransfer,
  openOutboxDB, obPut, obAll, obDelete, dlSeq, openDownloadDB, dlPut, dlGet, dlAll, dlDelete, dlClearKey,
  handleSignal,
  connectWS, wsSend, handleWS, showRestarting, startRestartingPoller,
  renderPeople, selectPerson, renderRoom, joinRoom, leaveRoom, initPeersRoomsUI,
  PermanentError, ResyncError, retryNetwork, UPLOAD_CHUNK, resumeUpload, relayTransfer, streamBytes, downloadViaServer, downloadEncrypted, handleIncomingFile,
  isRealAccount, sendToPeer, sendToRoomSwarm, handleAccept, handleDecline, startRTCSender, CHUNK, HIGH_WATER, sendChunk, initSenderUI,
  handleOfferRequest, bindReceiverChannel, downloadBlob,
  hiddenFiles, hideFile, loadHistory, renderHistory, initHistoryUI,
  initGlidingCaret,
  ea, eaSetTab, eaShow, eaErr, eaClear, eaResetToEmail, validatePasswordClient, bindPasswordRequirements, checkPendingGoogleAuth, startSession, checkTemporaryTestMode, parseRoomLink, showLogin, showLoginOrRedirect, requireLogin, showApp, refreshSparkStatus, rememberAccount, getLastAccount, renderUserHeader, renderMenuAvatar, openHistoryPage, closeMenu, initAuthUI, boot,
  isPasskeySupported, registerPasskey, authenticatePasskey, getAccountPasskeys, deleteAccountPasskey
};

// Expose key singletons on window for backwards compatibility with tests and scripts
if (typeof window !== 'undefined') {
  window.NotificationManager = NotificationManager;
  window.Sha256Hasher = Sha256Hasher;
  window.TarPackage = TarPackage;
  window.state = state;
  window.t = t;
  window.toast = toast;
  window.addFiles = addFiles;
  window.boot = boot;
  window.isPasskeySupported = isPasskeySupported;
  window.registerPasskey = registerPasskey;
  window.authenticatePasskey = authenticatePasskey;
  window.getAccountPasskeys = getAccountPasskeys;
  window.deleteAccountPasskey = deleteAccountPasskey;
}

// Coordinate UI initialization and boot. Each init is isolated in its own
// try/catch so a failure in one module (e.g. a feature that is missing an
// element or a platform API) can never prevent the rest of the app — room
// controls, sender UI, auth — from being wired up.
function initApp() {
  [
    initGlidingCaret,
    initPWA,
    initNotificationsUI,
    initSettingsModal,
    initQuickLook,
    initFilePicker,
    initSenderUI,
    initPeersRoomsUI,
    initHistoryUI,
    initAuthUI,
  ].forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.error('[shareweb] init failed for', fn?.name, err);
    }
  });
  boot();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
}
