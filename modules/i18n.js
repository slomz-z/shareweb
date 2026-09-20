// ShareWeb Internationalization & Translation Coordinator
import { state } from './state.js';
import { TRANSLATIONS } from './translations.js';
import { saveUserSettingsToServer, detectLanguageByIp, updateAutoOptionLabel } from './settings.js';

export const WORLD_LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', dir: 'ltr' },
  { code: 'ar', name: 'Arabic', native: 'العربية', dir: 'rtl' },
  { code: 'es', name: 'Spanish', native: 'Español', dir: 'ltr' },
  { code: 'fr', name: 'French', native: 'Français', dir: 'ltr' },
  { code: 'de', name: 'German', native: 'Deutsch', dir: 'ltr' },
  { code: 'zh', name: 'Chinese (Simplified)', native: '简体中文', dir: 'ltr' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', native: '繁體中文', dir: 'ltr' },
  { code: 'ja', name: 'Japanese', native: '日本語', dir: 'ltr' },
  { code: 'ko', name: 'Korean', native: '한국어', dir: 'ltr' },
  { code: 'ru', name: 'Russian', native: 'Русский', dir: 'ltr' },
  { code: 'pt', name: 'Portuguese', native: 'Português', dir: 'ltr' },
  { code: 'it', name: 'Italian', native: 'Italiano', dir: 'ltr' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe', dir: 'ltr' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', dir: 'ltr' },
  { code: 'fa', name: 'Persian', native: 'فارسی', dir: 'rtl' },
  { code: 'ur', name: 'Urdu', native: 'اردو', dir: 'rtl' },
  { code: 'he', name: 'Hebrew', native: 'עברית', dir: 'rtl' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands', dir: 'ltr' },
  { code: 'pl', name: 'Polish', native: 'Polski', dir: 'ltr' },
  { code: 'sv', name: 'Swedish', native: 'Svenska', dir: 'ltr' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia', dir: 'ltr' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt', dir: 'ltr' },
  { code: 'th', name: 'Thai', native: 'ไทย', dir: 'ltr' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська', dir: 'ltr' },
  { code: 'cs', name: 'Czech', native: 'Čeština', dir: 'ltr' },
  { code: 'el', name: 'Greek', native: 'Ελληνικά', dir: 'ltr' },
  { code: 'ro', name: 'Romanian', native: 'Română', dir: 'ltr' },
  { code: 'hu', name: 'Hungarian', native: 'Magyar', dir: 'ltr' },
  { code: 'da', name: 'Danish', native: 'Dansk', dir: 'ltr' },
  { code: 'fi', name: 'Finnish', native: 'Suomi', dir: 'ltr' },
  { code: 'no', name: 'Norwegian', native: 'Norsk', dir: 'ltr' },
  { code: 'ms', name: 'Malay', native: 'Bahasa Melayu', dir: 'ltr' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা', dir: 'ltr' },
  { code: 'fil', name: 'Filipino', native: 'Filipino', dir: 'ltr' },
  { code: 'sw', name: 'Swahili', native: 'Kiswahili', dir: 'ltr' },
  { code: 'bg', name: 'Bulgarian', native: 'Български', dir: 'ltr' },
  { code: 'hr', name: 'Croatian', native: 'Hrvatski', dir: 'ltr' },
  { code: 'sr', name: 'Serbian', native: 'Српски', dir: 'ltr' },
  { code: 'sk', name: 'Slovak', native: 'Slovenčina', dir: 'ltr' },
  { code: 'lt', name: 'Lithuanian', native: 'Lietuvių', dir: 'ltr' },
  { code: 'lv', name: 'Latvian', native: 'Latviešu', dir: 'ltr' },
  { code: 'et', name: 'Estonian', native: 'Eesti', dir: 'ltr' },
  { code: 'sl', name: 'Slovenian', native: 'Slovenščina', dir: 'ltr' },
  { code: 'ca', name: 'Catalan', native: 'Català', dir: 'ltr' },
];

export function getEffectiveLangCode() {
  const pref = state.settings?.language || 'auto';
  if (pref === 'auto') {
    return state.autoLang || (typeof navigator !== 'undefined' && navigator.language ? navigator.language.split('-')[0] : 'en');
  }
  return pref || 'en';
}

export function t(k, fallback = '', vars = null) {
  const code = getEffectiveLangCode();
  const dict = TRANSLATIONS[code] || TRANSLATIONS['en'] || {};
  let str = dict[k] || (TRANSLATIONS['en'] && TRANSLATIONS['en'][k]) || fallback;
  if (vars && typeof vars === 'object') {
    for (const [vKey, vVal] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${vKey}\\}`, 'g'), vVal);
    }
  }
  return str;
}

export function initLanguage() {
  try {
    localStorage.removeItem('shareweb-lang');
    localStorage.removeItem('shareweb-auto-detected-lang');
    localStorage.removeItem('shareweb-auto-detected-country');
  } catch {}

  const langSelect = document.getElementById('lang-select');
  if (langSelect) {
    const autoOption = `<option value="auto">🌐 Automatic</option>`;
    const langOptions = WORLD_LANGUAGES.map(l => {
      return `<option value="${l.code}">${l.native} (${l.name})</option>`;
    }).join('');
    langSelect.innerHTML = autoOption + langOptions;
  }

  const currentPref = state.settings?.language || 'auto';
  if (langSelect) langSelect.value = currentPref;
  applyLanguage(currentPref, false);

  // Detect language by public IP
  detectLanguageByIp(currentPref === 'auto');

  langSelect?.addEventListener('change', (e) => {
    const val = e.target.value;
    applyLanguage(val, true);
    if (val === 'auto') {
      detectLanguageByIp(true);
    }
  });
}

export function applyLanguage(code, save = true) {
  state.settings = state.settings || {};
  state.settings.language = code;
  if (save) {
    saveUserSettingsToServer({ language: code });
  }

  let effectiveCode = code;
  if (code === 'auto') {
    effectiveCode = state.autoLang || (typeof navigator !== 'undefined' && navigator.language ? navigator.language.split('-')[0] : 'en');
  }

  const langObj = WORLD_LANGUAGES.find(l => l.code === effectiveCode) || WORLD_LANGUAGES[0];
  document.documentElement?.setAttribute('lang', effectiveCode);
  document.documentElement?.setAttribute('dir', langObj.dir || 'ltr');

  const dict = TRANSLATIONS[effectiveCode] || TRANSLATIONS['en'] || {};
  const tr = (k, fallback) => dict[k] || (TRANSLATIONS['en'] && TRANSLATIONS['en'][k]) || fallback;

  // Apply to UI elements
  const el = (id, text) => { const node = document.getElementById(id); if (node && text) node.textContent = text; };
  const ph = (id, text) => { const node = document.getElementById(id); if (node && text) node.placeholder = text; };

  // Topbar & Menu
  el('menu-history-label', tr('history', 'History'));
  el('menu-support-label', tr('support', 'Support & Help Desk'));
  el('menu-settings-label', tr('settings', 'Settings'));
  el('menu-return-main-label', tr('returnMain', 'Return to Main Account'));
  el('menu-install-label', tr('installApp', 'Install app'));
  el('menu-logout-label', tr('logout', 'Log out'));

  // Left column panels
  el('nearby-title', tr('nearbyTitle', 'Nearby Devices'));
  el('nearby-hint', tr('nearbyHint', 'On your network'));
  ph('search', tr('nearbySearch', 'Search devices...'));
  el('people-empty', tr('noNearby', 'No nearby devices are online right now.'));

  el('rooms-title', tr('roomsTitle', 'Rooms'));
  el('rooms-hint', tr('roomsHint', 'Share with people on other networks'));
  el('room-create', tr('createRoom', 'Create room'));
  ph('room-input', tr('roomCode', 'Room code'));
  el('room-join', tr('join', 'Join'));
  el('room-code-label', tr('yourRoomCode', 'Your room code'));
  el('room-link-label', tr('inviteLink', 'Invite link'));
  el('room-link-copy', tr('copy', 'Copy'));
  el('room-copy', tr('copyCode', 'Copy code'));
  el('room-qr-btn', tr('showQrCode', 'Show QR code'));
  el('room-leave', tr('leaveRoom', 'Leave room'));
  el('room-empty', tr('noRoomMembers', 'No one else in this room yet.'));

  // Share panel
  el('share-title', tr('shareTitle', 'Share files'));
  el('selected-peer', tr('selectPeerPrompt', 'Select a person on the left to start sharing'));
  el('dz-drop-text', tr('dropFiles', 'Drop files here'));
  el('dz-or-text', tr('or', 'or'));
  el('dz-browse-text', tr('browse', 'browse'));
  el('send-btn', tr('send', 'Send'));
  el('clear-btn', tr('clear', 'Clear'));

  // History page
  el('history-title', tr('historyTitle', 'History'));
  el('history-sub', tr('historySub', 'Everything you sent and received in the last 30 days'));
  el('tab-all', tr('tabAll', 'All'));
  el('tab-sent', tr('tabSent', 'Sent'));
  el('tab-received', tr('tabReceived', 'Received'));
  el('history-empty', tr('nothingHere', 'Nothing here yet.'));

  // Settings modal
  el('stg-lbl-appearance', tr('stgAppearance', 'Appearance'));
  el('stg-sub-appearance', tr('stgAppearanceSub', 'Choose your visual theme'));
  el('stg-theme-light', tr('stgLight', 'Light'));
  el('stg-theme-dark', tr('stgDark', 'Dark'));
  el('stg-theme-system', tr('stgSystem', 'System'));

  el('stg-lbl-language', tr('stgLanguage', 'Language'));
  el('stg-sub-language', tr('stgLanguageSub', 'Select your preferred language'));

  el('stg-lbl-sound', tr('stgSound', 'Sound & Haptics'));
  el('stg-sub-sound', tr('stgSoundSub', 'AirDrop-style audio chimes and vibrations'));

  el('stg-lbl-spark', tr('stgSpark', 'Connect to Spark'));
  el('stg-sub-spark', tr('stgSparkSub', 'Custom app link for Gemini & AI agents'));
  el('stg-spark-warn', tr('stgSparkWarn', "Only add this link inside Spark. Don't share it with anyone else — whoever has it can view your files."));
  el('stg-mcp-reset', tr('stgSparkReset', 'Reset Spark link'));
  el('stg-mcp-copy', tr('copy', 'Copy'));
  const statusBadge = document.getElementById('settings-spark-status');
  const isConnected = statusBadge ? statusBadge.classList.contains('connected') : false;
  el('stg-spark-status-text', isConnected ? tr('connected', 'Connected') : tr('disconnected', 'Ready to Connect'));
  el('settings-done-btn', tr('done', 'Done'));
  el('settings-title', tr('settings', 'Settings'));

  // Support moderator notification banner & alerts
  el('st-title', tr('supportModTitle', 'Support Message from Moderator'));
  el('st-banner-text', tr('supportModText', 'Staff replied to your inquiry.'));
  el('st-view-btn', tr('viewReply', 'View Reply'));
  el('restarting-text', tr('serverRestarting', 'Server is restarting, it may take several minutes'));
  el('drag-title', tr('dropToShare', 'Drop files to share'));
  el('drag-sub', tr('p2pStreaming', 'Instant P2P streaming to selected recipient'));

  // Login view elements
  el('login-tagline', tr('tagline', 'Share files instantly with people you know.'));
  el('feat-1', tr('feat1', 'Automatically finds nearby devices'));
  el('feat-2', tr('feat2', 'No file size limits and completely free'));
  el('feat-3', tr('feat3', '30-day history of everything you send and receive'));
  el('btn-google-text', tr('signInGoogle', 'Sign in with Google'));
  el('divider-email-text', tr('orWithEmail', 'or with email'));
  el('ea-tab-login', tr('tabLogin', 'Log in'));
  el('ea-tab-signup', tr('tabSignup', 'Create account'));
  ph('ea-email', tr('emailAddress', 'Email address'));
  el('ea-btn-email', tr('continue', 'Continue'));
  el('ea-email-hint', tr('emailHint', 'Enter the email you signed up with.'));
  ph('ea-password', tr('password', 'Password'));
  el('ea-btn-password', tr('tabLogin', 'Log in'));
  el('ea-forgot', tr('forgotPassword', 'Forgot password?'));
  el('ea-back-email', tr('differentEmail', 'Use a different email'));
  el('ea-code-hint', tr('digitCode', 'We emailed a 6-digit code.'));
  ph('ea-code', tr('digitCode', '6-digit code'));
  el('ea-btn-code', tr('verify', 'Verify'));
  el('ea-resend', tr('resendCode', 'Resend code'));
  el('ea-code-back', tr('back', 'Back'));
  ph('ea-newpass', tr('newPassword', 'New password'));
  el('ea-newpass-rule', tr('pwRule', 'At least 6 characters, one capital letter, and one number.'));
  el('ea-btn-newpass', tr('continue', 'Continue'));
  el('ea-name-hint', tr('nameHint', 'What should people call you?'));
  ph('ea-name', tr('yourName', 'Your name'));
  el('ea-btn-name', tr('continue', 'Continue'));
  el('ea-photo-hint', tr('photoHint', 'Add a profile photo (optional)'));
  el('ea-btn-photo', tr('finish', 'Finish'));
  el('ea-photo-skip', tr('skipForNow', 'Skip for now'));
  ph('ea-resetpass', tr('newPassword', 'New password'));
  el('ea-resetpass-rule', tr('pwRule', 'At least 6 characters, one capital letter, and one number.'));
  el('ea-btn-resetpass', tr('setPassword', 'Set password'));
  el('login-back-text', tr('btnBackHome', tr('notNow', 'Back to home')));
  el('legal-id-text', tr('legalId', 'Your email, name and photo are used only to identify you.'));
  el('privacy-link', tr('privacyPolicy', 'Privacy Policy'));
  el('terms-link', tr('termsOfService', 'Terms of Service'));
  el('support-link', tr('supportAppeals', tr('support', 'Support & Appeals')));

  // Translate all data-i18n, data-i18n-ph, and data-i18n-title elements in DOM
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const k = node.getAttribute('data-i18n');
    if (k && (dict[k] || (TRANSLATIONS['en'] && TRANSLATIONS['en'][k]))) {
      node.textContent = dict[k] || TRANSLATIONS['en'][k];
    }
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((node) => {
    const k = node.getAttribute('data-i18n-ph');
    if (k && (dict[k] || (TRANSLATIONS['en'] && TRANSLATIONS['en'][k]))) {
      node.placeholder = dict[k] || TRANSLATIONS['en'][k];
    }
  });
  document.querySelectorAll('[data-i18n-title]').forEach((node) => {
    const k = node.getAttribute('data-i18n-title');
    if (k && (dict[k] || (TRANSLATIONS['en'] && TRANSLATIONS['en'][k]))) {
      node.title = dict[k] || TRANSLATIONS['en'][k];
    }
  });

  const langSelect = document.getElementById('lang-select');
  if (langSelect && code) langSelect.value = code;
  updateAutoOptionLabel();
}
