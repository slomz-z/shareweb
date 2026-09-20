// ShareWeb Authentication, Account Sessions & Login Step Coordinators
import { state } from './state.js';
import { $, esc, avatarEl, swapToInitials, toast, initials, reportTimezone } from './utils.js';
import { t, initLanguage, applyLanguage } from './i18n.js';
import { initTheme, setTheme } from './theme.js';
import { connectWS, showRestarting } from './websocket.js';
import { openKeyDB, masterCacheGet, masterCacheSet, masterCacheClear, ensureCrypto, setupFromPassword } from './crypto-e2ee.js';
import { checkNotificationBanner } from './notifications.js';
import { loadHistory } from './history.js';
import { resumeOutbox } from './outbox.js';
import { registerSW } from './pwa.js';
import { isPasskeySupported, registerPasskey, authenticatePasskey } from './passkeys.js';
const CRYPTO = (typeof window !== 'undefined' && window.CRYPTO) ? window.CRYPTO : null;

export async function checkPendingGoogleAuth() {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token') || '';
  const pendingUrl = '/api/auth/google/pending' + (urlToken ? '?token=' + encodeURIComponent(urlToken) : '');
  const pendingRes = await fetch(pendingUrl).catch(() => null);
  const pendingData = pendingRes && pendingRes.ok ? await pendingRes.json() : null;

  if (pendingData && pendingData.pending && pendingData.email) {
    ea.email = pendingData.email;
    ea.isGoogle = true;
    ea.googleToken = urlToken || pendingData.token || '';
    ea.user = pendingData;

    $('#login-features')?.classList.add('hidden');
    $('#btn-google-oauth')?.classList.add('hidden');
    $('#login-divider')?.classList.add('hidden');
    $('#ea-tabs')?.classList.add('hidden');

    if (pendingData.needsPassword) {
      const badge = $('#ea-newpass-user-badge');
      if (badge) {
        badge.classList.remove('hidden');
        if (pendingData.picture) $('#ea-newpass-user-avatar').src = pendingData.picture;
        $('#ea-newpass-user-name').textContent = pendingData.name || pendingData.email.split('@')[0];
        $('#ea-newpass-user-email').textContent = pendingData.email;
      }
      const nEmail = $('#ea-newpass-email');
      if (nEmail) nEmail.textContent = pendingData.email;
      eaClear('ea-newpass-error');
      const nInp = $('#ea-newpass');
      if (nInp) nInp.value = '';
      eaShow('step-newpass');
      return true;
    } else if (pendingData.hasPasskey) {
      const badge = $('#ea-passkey-user-badge');
      if (badge) {
        badge.classList.remove('hidden');
        if (pendingData.picture) $('#ea-passkey-user-avatar').src = pendingData.picture;
        $('#ea-passkey-user-name').textContent = pendingData.name || pendingData.email.split('@')[0];
        $('#ea-passkey-user-email').textContent = pendingData.email;
      }
      eaClear('ea-passkey-error');
      eaShow('step-passkey');
      return true;
    } else {
      const badge = $('#ea-pw-user-badge');
      if (badge) {
        badge.classList.remove('hidden');
        if (pendingData.picture) $('#ea-pw-user-avatar').src = pendingData.picture;
        $('#ea-pw-user-name').textContent = pendingData.name || pendingData.email.split('@')[0];
        $('#ea-pw-user-email').textContent = pendingData.email;
      }
      const pwTarget = $('#ea-pw-target');
      if (pwTarget) {
        pwTarget.textContent = '';
        pwTarget.classList.add('hidden');
      }
      eaClear('ea-pw-error');
      const pwInp = $('#ea-password');
      if (pwInp) pwInp.value = '';
      eaShow('step-password');
      return true;
    }
  }
  return false;
}

export async function boot() {
  initTheme();
  initLanguage();
  registerSW();
  parseRoomLink();

  // Check URL query parameters for errors / notifications early
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('auth')) {
    toast(t('toastGoogleAuthFailed', 'Google sign-in was cancelled or failed. Please try again.'), 'error', 6000);
    history.replaceState(null, '', location.pathname);
  }
  if (urlParams.has('cooldown')) {
    const days = urlParams.get('days') || '7';
    toast(`This account was recently deleted. Please wait ${days} days before registering again.`, 'error', 6000);
    history.replaceState(null, '', location.pathname);
  }
  if (urlParams.has('suspended')) {
    toast('This account has been suspended. Please contact support.', 'error', 6000);
    history.replaceState(null, '', location.pathname);
  }

  try {
    const isLoginPage = window.location.pathname === '/login' ||
                        window.location.pathname === '/login.html' ||
                        window.location.pathname.startsWith('/login');

    if (isLoginPage) {
      const params = new URLSearchParams(window.location.search);
      let returnTo = params.get('returnTo') || '/app';
      if (returnTo === '/' || !returnTo.startsWith('/')) returnTo = '/app';

      // 1. Check if user is ALREADY fully logged in with password
      const res = await fetch('/api/me').catch(() => null);
      if (res && res.ok) {
        const me = await res.json();
        if (me && me.email && me.hasPassword) {
          window.location.replace(returnTo);
          return;
        }
      }

      // 2. Check if user is in pending Google authentication state
      const hasPending = await checkPendingGoogleAuth();
      if (hasPending) {
        const avatarImgs = [
          document.getElementById('ea-pw-user-avatar'),
          document.getElementById('ea-newpass-user-avatar')
        ].filter(Boolean);
        if (window.ShareWebLoader && typeof window.ShareWebLoader.whenReady === 'function') {
          window.ShareWebLoader.whenReady({
            waitForFonts: true,
            waitForLanguage: true,
            images: avatarImgs
          });
        } else if (window.hidePageLoader) {
          window.hidePageLoader();
        }
        return;
      }

      // 3. Regular unauthenticated login page
      const loginImgs = Array.from(document.querySelectorAll('#view-login img') || []);
      if (window.ShareWebLoader && typeof window.ShareWebLoader.whenReady === 'function') {
        window.ShareWebLoader.whenReady({
          waitForFonts: true,
          waitForLanguage: true,
          images: loginImgs
        });
      } else if (window.hidePageLoader) {
        window.hidePageLoader();
      }
      return;
    }

    const res = await fetch('/api/me');
    if (res.ok) {
      const me = await res.json();
      startSession(me);
    } else if (res.status === 401) {
      // A transient session read (another tab/refresh touching the session
      // file) can 401 once — retry before falling back to login.
      await new Promise((r) => setTimeout(r, 600));
      const retry = await fetch('/api/me').catch(() => null);
      if (retry && retry.ok) {
        const me = await retry.json();
        if (!me.hasPassword) {
          try { localStorage.removeItem('sw_session_token'); } catch (_) {}
          showLoginOrRedirect();
        } else {
          startSession(me);
        }
      } else {
        try { localStorage.removeItem('sw_session_token'); } catch (_) {}
        showLoginOrRedirect();
      }
    } else if (res.status >= 500) {
      // The server is up but this session/account is broken (e.g. a very old
      // cookie). Retry once, then go to the login screen — a fresh sign-in
      // replaces the bad cookie.
      await new Promise((r) => setTimeout(r, 800));
      const retry = await fetch('/api/me').catch(() => null);
      if (retry && retry.ok) {
        const me = await retry.json();
        if (!me.hasPassword) {
          try { localStorage.removeItem('sw_session_token'); } catch (_) {}
          showLoginOrRedirect();
        } else {
          startSession(me);
        }
      } else {
        try { localStorage.removeItem('sw_session_token'); } catch (_) {}
        showLoginOrRedirect();
      }
    } else {
      showLoginOrRedirect();
    }
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('Failed to fetch')) {
      showRestarting();
    }
  }
  if (new URLSearchParams(location.search).has('auth')) {
    toast(t('toastGoogleAuthFailed', 'Google sign-in was cancelled or failed. Please try again.'), 'error');
    history.replaceState(null, '', location.pathname);
  }
  if (new URLSearchParams(location.search).has('cooldown')) {
    const days = new URLSearchParams(location.search).get('days') || '7';
    toast(`This account was recently deleted. Please wait ${days} days before registering again.`, 'error', 6000);
    history.replaceState(null, '', location.pathname);
  }
}

export async function startSession(me) {
  state.me = me;
  if (me.settings) {
    state.settings = {
      theme: me.settings.theme || 'system',
      language: me.settings.language || 'auto',
    };
    setTheme(state.settings.theme, false);
    applyLanguage(state.settings.language, false);
  }
  await showApp();
  reportTimezone();
  checkSupportNotifications();
  checkTemporaryTestMode(me);
  checkIncomingPwaShare();
  (async () => {
    ensureCrypto().then(() => {
      if (state.cryptoReady) {
        loadHistory();
        resumeOutbox();
      }
    });
  })();
}

async function checkIncomingPwaShare() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('shared') && !window.location.hash.includes('shared')) return;
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open('shareweb-incoming-share');
    const metaRes = await cache.match('/shared-meta');
    if (metaRes) {
      const meta = await metaRes.json();
      const files = [];
      if (meta.files && meta.files.length) {
        for (const item of meta.files) {
          const fileRes = await cache.match(item.key);
          if (fileRes) {
            const blob = await fileRes.blob();
            const file = new File([blob], item.name, { type: item.type || blob.type || 'application/octet-stream', lastModified: Date.now() });
            files.push(file);
          }
        }
      }
      const keys = await cache.keys();
      for (const k of keys) await cache.delete(k);

      if (files.length > 0) {
        addFiles(files);
        toast(t('toastSharedFilesAdded', `Added ${files.length} file(s) from share sheet.`), 'success', 4000);
      }
    }
  } catch (err) {
    console.error('Error reading shared files from PWA cache:', err);
  } finally {
    const url = new URL(window.location.href);
    url.searchParams.delete('shared');
    window.history.replaceState({}, '', url.pathname + (url.search ? url.search : '') + url.hash);
  }
}


export function checkTemporaryTestMode() {}

async function checkSupportNotifications() {
  try {
    const res = await fetch('/api/support/unread-notifications');
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok && data.unreadCount > 0 && data.notifications.length > 0) {
      const notif = data.notifications[0];
      const banner = document.getElementById('support-toast-banner');
      const textEl = document.getElementById('st-banner-text');
      const badgeEl = document.getElementById('menu-support-badge');

      if (badgeEl) {
        badgeEl.textContent = data.unreadCount;
        badgeEl.classList.remove('hidden');
      }

      if (banner && textEl) {
        const sender = notif.lastReply?.senderName || 'Staff';
        const msgText = notif.lastReply?.text || '';
        textEl.textContent = `${sender}: "${msgText.slice(0, 70)}${msgText.length > 70 ? '...' : ''}" (${notif.subject})`;
        banner.classList.remove('hidden');

        SOUNDS.playChime();
        SOUNDS.vibrate([40, 50, 40]);

        NotificationManager.notify({
          title: t('notifSupportReplyTitle', 'Support update'),
          body: msgText ? `${sender}: "${msgText.slice(0, 70)}${msgText.length > 70 ? '...' : ''}"` : t('notifSupportReplyBody', 'You have a new reply from support'),
          tag: 'support-' + (notif.id || Date.now()),
          data: { url: '/support' }
        });
      }
    }
  } catch {}
}

document.getElementById('st-dismiss-btn')?.addEventListener('click', () => {
  document.getElementById('support-toast-banner')?.classList.add('hidden');
});

export async function showLoginOrRedirect() {
  if (location.pathname === '/app' || location.pathname.startsWith('/Room/')) {
    const res = await fetch('/api/me').catch(() => null);
    if (res && res.ok) {
      const me = await res.json();
      if (me && me.hasPassword) {
        await startSession(me);
        return;
      }
    }
    const target = '/login?returnTo=' + encodeURIComponent(location.pathname + location.search);
    if (window.self !== window.top) {
      try {
        window.parent.postMessage({ type: 'sw-navigate', path: target }, '*');
      } catch (_) {}
    }
    location.href = target;
    return;
  }
  const hasPending = await checkPendingGoogleAuth();
  if (!hasPending) {
    showLogin();
  } else {
    const avatarImgs = [
      document.getElementById('ea-pw-user-avatar'),
      document.getElementById('ea-newpass-user-avatar')
    ].filter(Boolean);
    if (window.ShareWebLoader && typeof window.ShareWebLoader.whenReady === 'function') {
      window.ShareWebLoader.whenReady({
        waitForFonts: true,
        waitForLanguage: true,
        images: avatarImgs
      });
    } else if (window.hidePageLoader) {
      window.hidePageLoader();
    }
  }
}

export function parseRoomLink() {
  const m = location.pathname.match(/^\/Room\/([A-Z0-9]{6})\/([A-Za-z0-9_-]+)\/?$/);
  if (!m) return;
  const [, code, token] = m;
  state.pendingRoom = { room: code, password: token };
  try {
    localStorage.setItem('ds-room', code);
    localStorage.setItem(`ds-room-link-${code}`, token);
  } catch {}
  history.replaceState(null, '', '/');
}


export function showLogin() {
  $('#view-history')?.classList.add('hidden');
  $('#view-app')?.classList.remove('hidden');
  $('#view-login')?.classList.remove('hidden');
  const loginImgs = Array.from(document.querySelectorAll('#view-login img') || []);
  if (window.ShareWebLoader && typeof window.ShareWebLoader.whenReady === 'function') {
    window.ShareWebLoader.whenReady({
      waitForFonts: true,
      waitForLanguage: true,
      images: loginImgs
    });
  } else if (window.hidePageLoader) {
    window.hidePageLoader();
  }
}


export function requireLogin(reason) {
  if (reason) toast(reason, 'info', 4000);
  showLogin();
}

$('#login-back')?.addEventListener('click', () => {
  const appView = $('#view-app');
  if (appView) {
    $('#view-login')?.classList.add('hidden');
    appView.classList.remove('hidden');
  } else {
    location.href = '/';
  }
});

export async function showApp() {
  $('#view-login')?.classList.add('hidden');
  $('#view-history')?.classList.add('hidden');
  $('#view-app')?.classList.remove('hidden');
  renderUserHeader();
  rememberAccount();
  if (!state.restarting) {
    connectWS();
    loadHistory();
  }
  refreshSparkStatus();
  checkNotificationBanner();

  // Coordinate avatar images, buttons, and translations
  const avatarImages = [];
  const meWrap = document.getElementById('me-avatar-wrap');
  const menuWrap = document.getElementById('menu-avatar');
  if (meWrap) avatarImages.push(...meWrap.querySelectorAll('img'));
  if (menuWrap) avatarImages.push(...menuWrap.querySelectorAll('img'));

  if (window.ShareWebLoader && typeof window.ShareWebLoader.whenReady === 'function') {
    await window.ShareWebLoader.whenReady({
      waitForFonts: true,
      waitForLanguage: true,
      images: avatarImages
    });
    window.hidePageLoader();
  } else if (window.hidePageLoader) {
    window.hidePageLoader();
  }
}

export function refreshSparkStatus() {
  if (state.restarting) return;
  fetch('/api/mcp/status', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const connected = !!(d && d.connected);
      const label = $('#mcp-label');
      if (label) label.textContent = connected ? 'Spark is connected' : 'Connect to Spark';
      $('#menu-mcp')?.classList.toggle('connected', connected);
      const statusBadge = document.getElementById('settings-spark-status');
      const statusText = document.getElementById('stg-spark-status-text');
      if (statusBadge) statusBadge.classList.toggle('connected', connected);
      if (statusText) statusText.textContent = connected ? t('connected', 'Connected') : t('disconnected', 'Ready to Connect');
    })
    .catch(() => {});
}

setInterval(refreshSparkStatus, 15000);

export function rememberAccount() {
  const m = state.me;
  if (!m || !m.email) return;
  if (/@(offline\.local|shareweb\.local)$/i.test(m.email)) return;
  try {
    localStorage.setItem('ds-last-account', JSON.stringify({ email: m.email, name: m.name, auth: m.auth || '' }));
  } catch {}
}

export function getLastAccount() {
  try {
    const a = JSON.parse(localStorage.getItem('ds-last-account') || 'null');
    return a && a.email ? a : null;
  } catch {
    return null;
  }
}

export function renderUserHeader() {
  if (!state.me) return;
  const name = state.me.name || (state.me.email ? state.me.email.split('@')[0] : '—');
  const email = state.me.email || '—';

  const meName = $('#me-name');
  if (meName) meName.textContent = name;
  const meEmail = $('#me-email');
  if (meEmail) meEmail.textContent = email;
  const meAvatar = $('#me-avatar-wrap');
  if (meAvatar) meAvatar.replaceChildren(avatarEl(state.me.picture, name, 'avatar'));

  const menuName = $('#menu-name');
  if (menuName) menuName.textContent = name;
  const menuEmail = $('#menu-email');
  if (menuEmail) menuEmail.textContent = email;
  const menuAvatar = $('#menu-avatar');
  if (menuAvatar) menuAvatar.replaceChildren(avatarEl(state.me.picture, name, 'avatar'));
}

export function renderMenuAvatar() {
  renderUserHeader();
}


export function openHistoryPage() {
  closeMenu();
  if (state.restarting) {
    return;
  }
  $('#view-app')?.classList.add('hidden');
  $('#view-history')?.classList.remove('hidden');
  loadHistory();
}

export function closeMenu() {
  $('#user-menu')?.classList.add('hidden');
}

export const ea = { email: '', mode: 'login', tab: 'login', token: '', photo: '' };

export function eaSetTab(tab) {
  ea.tab = tab;
  $('#ea-tabs')?.querySelectorAll('.ea-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.eaTab === tab);
  });
  const hint = $('#ea-email-hint');
  if (hint) {
    hint.textContent =
      tab === 'login'
        ? 'Enter the email you signed up with.'
        : 'New here? Enter your email and we\'ll create your account.';
  }
  eaClear('ea-email-error');
}

export function eaShow(stepId) {
  document.querySelectorAll('.ea-step').forEach((s) => s.classList.add('hidden'));
  $('#' + stepId).classList.remove('hidden');
  $('#ea-tabs').classList.toggle('hidden', stepId !== 'step-email');
  const inp = $('#' + stepId + ' .ea-input');
  if (inp) inp.focus();
}

export function eaErr(id, msg, inputId) {
  const el = $('#' + id);
  if (el) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  if (inputId) {
    const inp = $('#' + inputId);
    if (inp) {
      inp.classList.add('input-error');
      inp.focus();
    }
  }
}

export function eaClear(id, inputId) {
  const el = $('#' + id);
  if (el) el.classList.add('hidden');
  if (inputId) {
    const inp = $('#' + inputId);
    if (inp) inp.classList.remove('input-error');
  }
}

export function eaResetToEmail() {
  ea.token = '';
  ea.photo = '';
  ea.isGoogle = false;
  ea.googleToken = '';
  $('#login-features')?.classList.remove('hidden');
  $('#btn-google-oauth')?.classList.remove('hidden');
  $('#login-divider')?.classList.remove('hidden');
  $('#ea-tabs')?.classList.remove('hidden');
  $('#ea-pw-user-badge')?.classList.add('hidden');
  $('#ea-newpass-user-badge')?.classList.add('hidden');
  $('#ea-pw-target')?.classList.remove('hidden');
  const pw = $('#ea-password');
  if (pw) pw.value = '';
  const em = $('#ea-email');
  if (em) em.value = ea.email || '';
  eaShow('step-email');
}

async function sendCodeAndShow(email, purpose) {
  $('#ea-code-email').textContent = email;
  eaClear('ea-code-error');
  const res = await fetch('/api/auth/email/send-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, purpose }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || 'Could not send the code. Try again.';
    if (purpose === 'signup') eaErr('ea-email-error', msg);
    else eaErr('ea-code-error', msg);
    return;
  }
  if (data.devCode) toast(t('toastTestModeCode', 'Test mode — your code is <b>{code}</b>').replace('{code}', esc(data.devCode)), 'info', 9000);
  $('#ea-code').value = '';
  eaShow('step-code');
}


$('#step-email')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#ea-email')?.value?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return eaErr('ea-email-error', t('eaValidEmail', 'Enter a valid email address.'));
  eaClear('ea-email-error');
  const res = await fetch('/api/auth/email/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return eaErr('ea-email-error', data.error || t('somethingWrong', 'Something went wrong. Try again.'));
  ea.email = email;
  if (data.exists) {
    if (ea.tab === 'signup') {
      return eaErr('ea-email-error', t('eaAccountExists', 'An account with this email already exists. Log in instead.'));
    }
    ea.mode = 'login';
    if (data.hasPasskey) {
      const badge = $('#ea-passkey-user-badge');
      if (badge) {
        badge.classList.remove('hidden');
        if (data.picture) $('#ea-passkey-user-avatar').src = data.picture;
        $('#ea-passkey-user-name').textContent = data.name || email.split('@')[0];
        $('#ea-passkey-user-email').textContent = email;
      }
      eaClear('ea-passkey-error');
      eaShow('step-passkey');
      return;
    }
    const pwTarget = $('#ea-pw-target');
    if (pwTarget) {
      pwTarget.textContent = email;
      pwTarget.classList.remove('hidden');
    }
    eaClear('ea-pw-error');
    const pwInp = $('#ea-password');
    if (pwInp) pwInp.value = '';
    eaShow('step-password');
  } else {
    if (ea.tab === 'login') {
      return eaErr('ea-email-error', t('eaNoAccount', 'No account found with this email. Create an account instead.'));
    }
    ea.mode = 'signup';
    await sendCodeAndShow(email, 'signup');
  }
});

$('#step-password')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#ea-password')?.value || '';
  eaClear('ea-pw-error');

  if (ea.isGoogle) {
    const res = await fetch('/api/auth/google/verify-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, token: ea.googleToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      if (data.sessionToken) {
        try { localStorage.setItem('sw_session_token', data.sessionToken); } catch (_) {}
      }
      try {
        const master = await CRYPTO.pbkdf2Master(password, data.encSalt);
        await masterCacheSet(data.email, master);
        const identity = await CRYPTO.deriveIdentity(master);
        await fetch('/api/user/pubkey', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pub: identity.pub }),
        }).catch(() => {});
      } catch (err) {
        console.warn('Post-login identity setup warning:', err);
      }
      const params = new URLSearchParams(window.location.search);
      let returnTo = params.get('returnTo') || '/app';
      if (returnTo === '/' || !returnTo.startsWith('/')) returnTo = '/app';
      const targetUrl = returnTo + (returnTo.includes('?') ? '&' : '?') + (data.sessionToken ? 'sid=' + encodeURIComponent(data.sessionToken) : '');
      
      const passkeySupported = await isPasskeySupported();
      if (!data.hasPasskey && passkeySupported) {
        ea.postLoginRedirect = targetUrl;
        eaClear('ea-create-passkey-error');
        eaShow('step-create-passkey');
        return;
      }

      if (window.self !== window.top) {
        try {
          window.parent.postMessage({ type: 'sw-navigate', path: returnTo }, '*');
        } catch (_) {}
      }
      window.location.href = targetUrl;
      return;
    }
    const msg = data.error || t('incorrectPassword', 'Incorrect password. Please try again.');
    return eaErr('ea-pw-error', msg, 'ea-password');
  }

  const res = await fetch('/api/auth/email/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ea.email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    if (data.sessionToken) {
      try { localStorage.setItem('sw_session_token', data.sessionToken); } catch (_) {}
    }
    // Set up encryption silently from this password (never stored) before reloading.
    await setupFromPassword(ea.email, password);
    const params = new URLSearchParams(window.location.search);
    let returnTo = params.get('returnTo') || '/app';
    if (returnTo === '/' || !returnTo.startsWith('/')) returnTo = '/app';
    const targetUrl = returnTo + (returnTo.includes('?') ? '&' : '?') + (data.sessionToken ? 'sid=' + encodeURIComponent(data.sessionToken) : '');
    
    const passkeySupported = await isPasskeySupported();
    if (!data.hasPasskey && passkeySupported) {
      ea.postLoginRedirect = targetUrl;
      eaClear('ea-create-passkey-error');
      eaShow('step-create-passkey');
      return;
    }

    if (window.self !== window.top) {
      try {
        window.parent.postMessage({ type: 'sw-navigate', path: returnTo }, '*');
      } catch (_) {}
    }
    window.location.href = targetUrl;
    return;
  }
  const msg = (data.error || 'Wrong password.') + (data.triesLeft ? ` ${data.triesLeft} attempts left.` : '');
  eaErr('ea-pw-error', msg, 'ea-password');
});

$('#ea-forgot')?.addEventListener('click', () => {
  ea.mode = 'reset';
  sendCodeAndShow(ea.email, 'reset');
});
$('#ea-back-email')?.addEventListener('click', async () => {
  if (ea.isGoogle) {
    try {
      sessionStorage.clear();
      await fetch('/api/auth/google/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: ea.googleToken }),
      });
      await fetch('/auth/logout', { method: 'POST', headers: { 'Accept': 'application/json' } });
    } catch {}
    window.location.replace('/login');
    return;
  }
  eaResetToEmail();
});

$('#ea-btn-passkey')?.addEventListener('click', async () => {
  eaClear('ea-passkey-error');
  const btn = $('#ea-btn-passkey');
  if (btn) btn.disabled = true;
  try {
    const data = await authenticatePasskey(ea.email, ea.isGoogle ? ea.googleToken : '');
    if (data.sessionToken) {
      try { localStorage.setItem('sw_session_token', data.sessionToken); } catch (_) {}
    }
    // Set up master key from cache if present on this device
    try {
      const master = await masterCacheGet(data.email || ea.email);
      if (master) {
        state.masterKey = master;
        state.identity = await CRYPTO.deriveIdentity(master);
        await fetch('/api/user/pubkey', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pub: state.identity.pub }),
        }).catch(() => {});
      }
    } catch (_) {}

    const params = new URLSearchParams(window.location.search);
    let returnTo = params.get('returnTo') || data.redirect || '/app';
    if (returnTo === '/' || !returnTo.startsWith('/')) returnTo = '/app';
    const targetUrl = returnTo + (returnTo.includes('?') ? '&' : '?') + (data.sessionToken ? 'sid=' + encodeURIComponent(data.sessionToken) : '');
    if (window.self !== window.top) {
      try {
        window.parent.postMessage({ type: 'sw-navigate', path: returnTo }, '*');
      } catch (_) {}
    }
    window.location.href = targetUrl;
  } catch (err) {
    console.warn('Passkey authentication error:', err);
    const msg = err.name === 'NotAllowedError' || err.message?.includes('cancelled')
      ? t('passkeyCancelled', 'Passkey verification was cancelled. Try again or use password.')
      : (err.message || t('passkeyError', 'Passkey authentication failed.'));
    eaErr('ea-passkey-error', msg);
  } finally {
    if (btn) btn.disabled = false;
  }
});

$('#ea-passkey-use-pw')?.addEventListener('click', () => {
  if (ea.isGoogle) {
    const badge = $('#ea-pw-user-badge');
    if (badge && ea.user) {
      badge.classList.remove('hidden');
      if (ea.user.picture) $('#ea-pw-user-avatar').src = ea.user.picture;
      $('#ea-pw-user-name').textContent = ea.user.name || ea.user.email.split('@')[0];
      $('#ea-pw-user-email').textContent = ea.user.email;
    }
    const pwTarget = $('#ea-pw-target');
    if (pwTarget) {
      pwTarget.textContent = '';
      pwTarget.classList.add('hidden');
    }
    eaClear('ea-pw-error');
    const pwInp = $('#ea-password');
    if (pwInp) pwInp.value = '';
    eaShow('step-password');
    return;
  }
  const pwTarget = $('#ea-pw-target');
  if (pwTarget) {
    pwTarget.textContent = ea.email;
    pwTarget.classList.remove('hidden');
  }
  eaClear('ea-pw-error');
  const pwInp = $('#ea-password');
  if (pwInp) pwInp.value = '';
  eaShow('step-password');
});

$('#ea-passkey-back')?.addEventListener('click', async () => {
  if (ea.isGoogle) {
    try {
      sessionStorage.clear();
      await fetch('/api/auth/google/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: ea.googleToken }),
      });
      await fetch('/auth/logout', { method: 'POST', headers: { 'Accept': 'application/json' } });
    } catch {}
    window.location.replace('/login');
    return;
  }
  eaResetToEmail();
});

$('#ea-btn-create-passkey')?.addEventListener('click', async () => {
  eaClear('ea-create-passkey-error');
  const btn = $('#ea-btn-create-passkey');
  if (btn) btn.disabled = true;
  try {
    await registerPasskey();
    toast(t('passkeyCreatedSuccess', 'Passkey created successfully!'), 'success', 4000);
    const target = ea.postLoginRedirect || '/app';
    window.location.href = target;
  } catch (err) {
    console.warn('Passkey registration error:', err);
    const msg = err.name === 'NotAllowedError' || err.message?.includes('cancelled')
      ? t('passkeyCreateCancelled', 'Passkey creation was cancelled. You can try again or skip.')
      : (err.message || t('passkeyCreateFailed', 'Could not create passkey on this device.'));
    eaErr('ea-create-passkey-error', msg);
  } finally {
    if (btn) btn.disabled = false;
  }
});

$('#ea-btn-skip-passkey')?.addEventListener('click', () => {
  const target = ea.postLoginRedirect || '/app';
  window.location.href = target;
});

$('#step-code')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#ea-code')?.value?.trim() || '';
  if (code.length !== 6) return eaErr('ea-code-error', t('eaEnter6Digit', 'Enter the 6-digit code.'));
  eaClear('ea-code-error');
  const res = await fetch('/api/auth/email/verify-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ea.email, code, purpose: ea.mode === 'reset' ? 'reset' : 'signup' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return eaErr('ea-code-error', data.error || t('eaIncorrectCode', 'Incorrect code.'));
  ea.token = data.token;
  if (ea.mode === 'reset') {
    const rEmail = $('#ea-resetpass-email');
    if (rEmail) rEmail.textContent = ea.email;
    eaClear('ea-resetpass-error');
    const rInp = $('#ea-resetpass');
    if (rInp) rInp.value = '';
    eaShow('step-resetpass');
  } else {
    const nEmail = $('#ea-newpass-email');
    if (nEmail) nEmail.textContent = ea.email;
    eaClear('ea-newpass-error');
    const nInp = $('#ea-newpass');
    if (nInp) nInp.value = '';
    eaShow('step-newpass');
  }
});
$('#ea-resend')?.addEventListener('click', () => sendCodeAndShow(ea.email, ea.mode === 'reset' ? 'reset' : 'signup'));
$('#ea-code-back')?.addEventListener('click', eaResetToEmail);


export function validatePasswordClient(pw) {
  if (!pw || pw.length < 8) {
    return t('pwLenErr', 'Use 8 characters or more for your password.');
  }
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    return t('pwMixErr', 'Choose a stronger password. Try a mix of letters and numbers.');
  }
  if (!/[A-Z]/.test(pw) || !/[a-z]/.test(pw)) {
    return t('pwCaseErr', 'Choose a stronger password. Include both uppercase and lowercase letters and numbers.');
  }
  return null;
}


export function bindPasswordRequirements(inputId, containerId, errorId) {
  const input = document.getElementById(inputId);
  const container = document.getElementById(containerId);
  if (!input || !container) return;

  function update() {
    const pw = input.value || '';
    const lenMet = pw.length >= 8;
    const caseMet = /[A-Z]/.test(pw) && /[a-z]/.test(pw);
    const numMet = /[0-9]/.test(pw);

    const setReq = (name, met) => {
      const el = container.querySelector(`[data-req="${name}"]`);
      if (!el) return;
      el.className = met ? 'pw-req met' : 'pw-req unmet';
      const icon = el.querySelector('.req-icon');
      if (icon) icon.textContent = met ? '✓' : '○';
    };

    setReq('len', lenMet);
    setReq('case', caseMet);
    setReq('num', numMet);

    if (lenMet && caseMet && numMet) {
      input.classList.remove('input-error');
      if (errorId) eaClear(errorId);
    }
  }

  input.addEventListener('input', update);
}

bindPasswordRequirements('ea-newpass', 'ea-newpass-reqs', 'ea-newpass-error');

export function initAuthUI() {
  $('#history-back')?.addEventListener('click', () => {
    $('#view-history')?.classList.add('hidden');
    $('#view-app')?.classList.remove('hidden');
  });

$('#menu-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('#user-menu');
  if (m) {
    m.classList.toggle('hidden');
    e.currentTarget.classList.toggle('open', m.classList.contains('hidden') === false);
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-wrap')) closeMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

  $('#ea-tabs')?.querySelectorAll('.ea-tab').forEach((b) => {
    b.addEventListener('click', () => eaSetTab(b.dataset.eaTab));
  });

bindPasswordRequirements('ea-resetpass', 'ea-resetpass-reqs', 'ea-resetpass-error');

// Remove error styling on any input when user types
document.querySelectorAll('.ea-input').forEach(inp => {
  inp.addEventListener('input', () => inp.classList.remove('input-error'));
});

// Show/hide password toggles
document.querySelectorAll('.btn-toggle-eye').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const targetId = btn.getAttribute('data-target');
    const input = targetId ? document.getElementById(targetId) : btn.parentElement?.querySelector('input');
    if (!input) return;

    const isPw = input.type === 'password';
    input.type = isPw ? 'text' : 'password';

    const openIcon = btn.querySelector('.eye-open-icon');
    const offIcon = btn.querySelector('.eye-off-icon');

    if (openIcon && offIcon) {
      if (isPw) {
        openIcon.classList.add('hidden');
        offIcon.classList.remove('hidden');
        btn.setAttribute('title', t('hidePassword', 'Hide password'));
        btn.setAttribute('aria-label', t('hidePassword', 'Hide password'));
      } else {
        openIcon.classList.remove('hidden');
        offIcon.classList.add('hidden');
        btn.setAttribute('title', t('showPassword', 'Show password'));
        btn.setAttribute('aria-label', t('showPassword', 'Show password'));
      }
    }
    input.focus();
  });
});

$('#ea-newpass-cancel')?.addEventListener('click', async () => {
  try {
    localStorage.removeItem('ds-last-account');
    localStorage.removeItem('ds-room');
    sessionStorage.clear();
    if (ea.isGoogle) {
      await fetch('/api/auth/google/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: ea.googleToken }),
      });
    }
    await fetch('/auth/logout', { method: 'POST', headers: { 'Accept': 'application/json' } });
  } catch {}
  window.location.replace('/login');
});

$('#step-newpass')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#ea-newpass')?.value || '';
  eaClear('ea-newpass-error', 'ea-newpass');
  const clientErr = validatePasswordClient(password);
  if (clientErr) return eaErr('ea-newpass-error', clientErr, 'ea-newpass');

  if (ea.isGoogle) {
    const res = await fetch('/api/auth/google/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, token: ea.googleToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return eaErr('ea-newpass-error', data.error || 'Could not set that password.', 'ea-newpass');

    if (data.sessionToken) {
      try { localStorage.setItem('sw_session_token', data.sessionToken); } catch (_) {}
    }

    try {
      // 1. Derive master key from password + encSalt
      const master = await CRYPTO.pbkdf2Master(password, data.encSalt);
      // 2. Cache master key in IndexedDB
      await masterCacheSet(data.email, master);
      // 3. Derive ECDH identity & register public key
      const identity = await CRYPTO.deriveIdentity(master);
      await fetch('/api/user/pubkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pub: identity.pub }),
      }).catch(() => {});

      // 4. Encrypt user's display name if present
      if (ea.user && ea.user.name) {
        try {
          const encName = await CRYPTO.encryptBytes(master, new TextEncoder().encode(ea.user.name));
          await fetch('/api/user/enc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ encSalt: data.encSalt, needsPassphrase: false, encName }),
          }).catch(() => {});
        } catch {}
      }
    } catch (err) {
      console.warn('Set-password identity setup warning:', err);
    }

    const params = new URLSearchParams(window.location.search);
    let returnTo = params.get('returnTo') || '/app';
    if (returnTo === '/' || !returnTo.startsWith('/')) returnTo = '/app';
    const targetUrl = returnTo + (returnTo.includes('?') ? '&' : '?') + (data.sessionToken ? 'sid=' + encodeURIComponent(data.sessionToken) : '');
    
    const passkeySupported = await isPasskeySupported();
    if (!data.hasPasskey && passkeySupported) {
      ea.postLoginRedirect = targetUrl;
      eaClear('ea-create-passkey-error');
      eaShow('step-create-passkey');
      return;
    }

    if (window.self !== window.top) {
      try {
        window.parent.postMessage({ type: 'sw-navigate', path: returnTo }, '*');
      } catch (_) {}
    }
    window.location.href = targetUrl;
    return;
  }

  const res = await fetch('/api/auth/email/set-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: ea.token, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return eaErr('ea-newpass-error', data.error || 'Could not set that password.', 'ea-newpass');
  const nameInp = $('#ea-name');
  if (nameInp) nameInp.value = '';
  eaShow('step-name');
});

$('#step-name')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#ea-name')?.value?.trim() || '';
  const res = await fetch('/api/auth/email/set-name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: ea.token, name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(data.error || t('toastSaveNameFail', 'Could not save your name.'), 'error');
  ea.photo = '';
  const photoInp = $('#ea-photo');
  if (photoInp) photoInp.value = '';
  $('#ea-photo-preview')?.replaceChildren();
  eaShow('step-photo');
});

$('#ea-photo')?.addEventListener('change', () => {
  const photoInp = $('#ea-photo');
  const f = photoInp?.files?.[0];
  if (!f) return $('#ea-photo-preview')?.replaceChildren();
  if (!/^image\//.test(f.type)) {
    toast(t('toastNotAPhoto', 'That file is not a photo.'), 'error');
    if (photoInp) photoInp.value = '';
    return;
  }
  if (f.size > 2 * 1024 * 1024) {
    toast(t('toastPhotoTooLarge', 'That photo is too large. Pick one under 2 MB.'), 'error');
    if (photoInp) photoInp.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    ea.photo = reader.result;
    const img = document.createElement('img');
    img.src = reader.result;
    img.alt = '';
    $('#ea-photo-preview')?.replaceChildren(img);
  };
  reader.readAsDataURL(f);
});

async function finishSignup() {
  const res = await fetch('/api/auth/email/set-photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: ea.token, photo: ea.photo }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(data.error || t('toastSavePhotoFail', 'Could not save your photo.'), 'error');
  const done = await fetch('/api/auth/email/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: ea.token }),
  });
  const doneData = await done.json().catch(() => ({}));
  if (!done.ok) return toast(doneData.error || t('toastCreateAccountFail', 'Could not create the account.'), 'error');
  toast(t('toastAccountCreated', 'Account created! Log in with your password.'), 'success', 5000);
  eaResetToEmail();
}

$('#step-photo')?.addEventListener('submit', (e) => {
  e.preventDefault();
  finishSignup();
});
$('#ea-photo-skip')?.addEventListener('click', () => {
  ea.photo = '';
  finishSignup();
});

$('#step-resetpass')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#ea-resetpass')?.value || '';
  eaClear('ea-resetpass-error', 'ea-resetpass');
  const clientErr = validatePasswordClient(password);
  if (clientErr) return eaErr('ea-resetpass-error', clientErr, 'ea-resetpass');

  const res = await fetch('/api/auth/email/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: ea.token, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return eaErr('ea-resetpass-error', data.error || 'Could not set that password.', 'ea-resetpass');
  toast(t('toastPasswordUpdated', 'Password updated — log in with your new password.'), 'success', 5000);
  eaResetToEmail();
});
}
