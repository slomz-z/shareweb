// ShareWeb Settings, Debounced Sync & Network Options
import { state } from './state.js';
import { $, toast, showAppConfirm } from './utils.js';
import { TRANSLATIONS } from './translations.js';
import { t, applyLanguage, WORLD_LANGUAGES, getEffectiveLangCode } from './i18n.js';
import { setTheme } from './theme.js';
import { NotificationManager } from './notifications.js';
import { closeMenu, openHistoryPage } from './auth.js';
import { masterCacheClear } from './crypto-e2ee.js';

let saveSettingsTimer = null;
let pendingSettingsPatch = {};

export async function saveUserSettingsToServer(patch) {
  if (!state.me) return;
  Object.assign(pendingSettingsPatch, patch);
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(async () => {
    const body = { ...pendingSettingsPatch };
    pendingSettingsPatch = {};
    try {
      const res = await fetch('/api/user/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const d = await res.json();
        if (d && d.settings) {
          state.settings = { ...state.settings, ...d.settings };
          if (state.me) state.me.settings = { ...state.settings };
        }
      }
    } catch {}
  }, 50);
}


let detectIpPromise = null;
export async function detectLanguageByIp(forceApply = false) {
  if (detectIpPromise) return detectIpPromise;
  detectIpPromise = (async () => {
    try {
      const res = await fetch('/api/detect-language');
      if (!res.ok) throw new Error('detect failed');
      const data = await res.json();
      if (data && data.ok && data.language) {
        state.autoLang = data.language;
        state.autoCountry = data.country;
        state.autoLangNative = data.langNative;
        state.autoLangName = data.langName;

        updateAutoOptionLabel();

        const currentPref = state.settings?.language || 'auto';
        if (currentPref === 'auto') {
          applyLanguage('auto', false);
        }
      }
    } catch {}
  })().finally(() => {
    detectIpPromise = null;
  });
  return detectIpPromise;
}


export function updateAutoOptionLabel() {
  const autoOpt = document.querySelector('#lang-select option[value="auto"]');
  if (!autoOpt) return;
  const effectiveCode = getEffectiveLangCode();
  const dict = TRANSLATIONS[effectiveCode] || TRANSLATIONS['en'] || {};
  const autoWord = dict.stgAutomatic || 'Automatic';
  const detectedWord = dict.stgAutoDetected || 'Detected';
  
  let detectedNative = state.autoLangNative;
  if (!detectedNative && state.autoLang) {
    const found = WORLD_LANGUAGES.find(l => l.code === state.autoLang);
    if (found) detectedNative = found.native;
  }

  if (detectedNative) {
    autoOpt.textContent = `🌐 ${autoWord} (${detectedWord}: ${detectedNative})`;
  } else {
    autoOpt.textContent = `🌐 ${autoWord}`;
  }
}


export async function openSettingsModal() {
  closeMenu();
  const modal = document.getElementById('settings-modal');
  if (modal) modal.classList.remove('hidden');

  // Load current theme & language selection state from account state
  const curTheme = state.settings?.theme || 'system';
  setTheme(curTheme, false);
  const curLang = state.settings?.language || 'auto';
  const langSelect = document.getElementById('lang-select');
  if (langSelect) langSelect.value = curLang;
  updateAutoOptionLabel();

  // Sync sound toggle
  const soundToggle = document.getElementById('stg-sound-toggle');
  if (soundToggle && window.ShareWebSound) {
    soundToggle.checked = window.ShareWebSound.isSoundEnabled();
  }

  // Sync notifications toggle
  const notifToggle = document.getElementById('stg-notifications-toggle');
  if (notifToggle) {
    notifToggle.checked = NotificationManager.isEnabled;
  }

  // Load live Spark URL & status
  try {
    const res = await fetch('/api/mcp/config');
    if (res.ok) {
      const d = await res.json();
      const input = document.getElementById('stg-mcp-url');
      if (input) input.value = d.url || '';
      const statusBadge = document.getElementById('settings-spark-status');
      const statusText = document.getElementById('stg-spark-status-text');
      const isConnected = Boolean(state.mcpClients && state.mcpClients.length > 0);
      if (statusBadge) statusBadge.classList.toggle('connected', isConnected);
      if (statusText) statusText.textContent = isConnected ? t('connected', 'Connected') : t('disconnected', 'Ready to Connect');
    }
  } catch {}
}

export function closeSettingsModal() {
  document.getElementById('settings-modal')?.classList.add('hidden');
}

export function wipeAllCookiesSecretly() {
  try {
    localStorage.removeItem('sw_session_token');
    const cookies = document.cookie ? document.cookie.split(';') : [];
    for (const c of cookies) {
      const eqPos = c.indexOf('=');
      const name = (eqPos > -1 ? c.substring(0, eqPos) : c).trim();
      if (!name) continue;
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;max-age=0`;
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=${window.location.hostname};max-age=0`;
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;max-age=0`;
      if (window.location.hostname.includes('.')) {
        const parts = window.location.hostname.split('.');
        while (parts.length > 1) {
          const dom = '.' + parts.join('.');
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=${dom};max-age=0`;
          parts.shift();
        }
      }
    }
  } catch {}
}

export function initSettingsModal() {
  $('#menu-settings')?.addEventListener('click', openSettingsModal);
  $('#settings-close-btn')?.addEventListener('click', closeSettingsModal);
  $('#settings-done-btn')?.addEventListener('click', closeSettingsModal);
  $('#settings-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal') closeSettingsModal();
  });

  $('#theme-btn-light')?.addEventListener('click', () => setTheme('light'));
  $('#theme-btn-dark')?.addEventListener('click', () => setTheme('dark'));
  $('#theme-btn-system')?.addEventListener('click', () => setTheme('system'));

  $('#stg-sound-toggle')?.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    state.settings = state.settings || {};
    state.settings.sound = enabled;
    saveUserSettingsToServer({ sound: enabled });
    if (window.ShareWebSound) window.ShareWebSound.enabled = enabled;
  });

  $('#stg-mcp-copy')?.addEventListener('click', async () => {
    const code = document.getElementById('stg-mcp-config-code')?.textContent || '';
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast(t('copied', 'Copied to clipboard!'), 'success');
    } catch {
      toast(t('copyFailed', 'Failed to copy to clipboard'), 'error');
    }
  });

  $('#stg-mcp-reset')?.addEventListener('click', async () => {
    const ok = await showAppConfirm({
      title: t('resetKey', 'Reset Key?'),
      message: t('resetKeyConfirm', 'Resetting will disconnect all active assistants.'),
      okText: t('reset', 'Reset'),
      cancelText: t('cancel', 'Cancel'),
      type: 'danger'
    });
    if (!ok) return;
    try {
      const res = await fetch('/api/mcp/key', { method: 'POST' });
      if (res.ok) {
        toast(t('mcpKeyReset', 'MCP API key regenerated.'), 'success');
        openSettingsModal();
      }
    } catch {
      toast(t('mcpKeyResetFailed', 'Failed to regenerate MCP key.'), 'error');
    }
  });

  $('#menu-history')?.addEventListener('click', openHistoryPage);

  $('#menu-logout')?.addEventListener('click', async () => {
    const ok = await showAppConfirm({
      title: t('signOut', 'Sign Out'),
      message: t('confirmSignOut', 'Are you sure you want to sign out? Your encryption keys will be securely cleared from this browser.'),
      okText: t('signOut', 'Sign Out'),
      cancelText: t('cancel', 'Cancel'),
      type: 'warn'
    });
    if (!ok) return;
    try {
      wipeAllCookiesSecretly();
    } catch {}
    try {
      await masterCacheClear();
    } catch {}
    try {
      localStorage.removeItem('ds-last-account');
      localStorage.removeItem('ds-room');
      sessionStorage.clear();
      await fetch('/auth/logout', { method: 'POST', headers: { 'Accept': 'application/json' } });
    } catch {}
    window.location.replace('/login');
  });
}
