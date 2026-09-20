// ShareWeb PWA Service Worker Registration & Install Prompts
import { $, toast } from './utils.js';
import { t } from './i18n.js';
import { checkNotificationBanner } from './notifications.js';

let deferredPrompt = null;

export function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then(() => {
    checkNotificationBanner();
  }).catch(() => {});
}


export function initPWA() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = $('#btn-install-pwa');
    if (btn) btn.classList.remove('hidden');
    const mi = $('#menu-install');
    if (mi) mi.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    $('#btn-install-pwa')?.classList.add('hidden');
    $('#menu-install')?.classList.add('hidden');
    toast(t('appInstalled', 'App installed successfully!'), 'success');
  });

  const installAction = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      deferredPrompt = null;
      $('#btn-install-pwa')?.classList.add('hidden');
      $('#menu-install')?.classList.add('hidden');
    }
  };

  $('#btn-install-pwa')?.addEventListener('click', installAction);
  $('#menu-install')?.addEventListener('click', installAction);
}
