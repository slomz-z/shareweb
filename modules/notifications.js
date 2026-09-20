// ShareWeb Desktop (macOS/Windows/Linux) & Mobile Push Notifications
import { state } from './state.js';
import { $, toast } from './utils.js';
import { t } from './i18n.js';

export const NotificationManager = {
  get isSupported() {
    return typeof window !== 'undefined' && 'Notification' in window;
  },
  get permission() {
    return this.isSupported ? Notification.permission : 'denied';
  },
  get isEnabled() {
    if (!this.isSupported) return false;
    if (Notification.permission !== 'granted') return false;
    try {
      const pref = localStorage.getItem('shareweb-notifications');
      return pref !== 'false';
    } catch {
      return true;
    }
  },
  setEnabled(val) {
    try {
      localStorage.setItem('shareweb-notifications', val ? 'true' : 'false');
    } catch {}
  },
  async requestPermission() {
    if (!this.isSupported) return false;
    try {
      const res = await Notification.requestPermission();
      if (res === 'granted') {
        this.setEnabled(true);
        $('#notif-permission-banner')?.classList.add('hidden');
        return true;
      } else {
        this.setEnabled(false);
        return false;
      }
    } catch {
      return false;
    }
  },
  async notify(arg1, arg2) {
    if (!this.isEnabled) return null;
    let title = '';
    let opts = {};
    if (typeof arg1 === 'string') {
      title = arg1;
      opts = arg2 || {};
    } else if (arg1 && typeof arg1 === 'object') {
      title = arg1.title || '';
      opts = arg1;
    }
    const options = {
      body: opts.body || '',
      icon: opts.icon || '/icons/icon-192.png',
      badge: opts.badge || '/icons/favicon-32.png',
      tag: opts.tag || `shareweb-${Date.now()}`,
      data: opts.data || { url: '/app' },
      vibrate: opts.vibrate || [150, 50, 150],
      renotify: opts.renotify !== undefined ? opts.renotify : true,
    };

    if (typeof document !== 'undefined' && document.hidden && 'setAppBadge' in navigator) {
      state.unreadBadgeCount = (state.unreadBadgeCount || 0) + 1;
      navigator.setAppBadge(state.unreadBadgeCount).catch(() => {});
    }

    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready.catch(() => null);
        if (reg && typeof reg.showNotification === 'function') {
          return await reg.showNotification(title, options);
        }
      }
    } catch {}

    try {
      const notif = new Notification(title, options);
      notif.onclick = () => {
        window.focus();
        notif.close();
      };
      return notif;
    } catch {
      return null;
    }
  },
  clearBadge() {
    if ('clearAppBadge' in navigator) {
      navigator.clearAppBadge().catch(() => {});
    }
    state.unreadBadgeCount = 0;
  }
};

window.addEventListener('focus', () => {
  if ('clearAppBadge' in navigator) {
    navigator.clearAppBadge().catch(() => {});
  }
  state.unreadBadgeCount = 0;
});

export function checkNotificationBanner() {
  if (!NotificationManager.isSupported) return;
  if (Notification.permission === 'default') {
    try {
      if (sessionStorage.getItem('ds-notif-dismissed') === 'true') return;
    } catch {}
    $('#notif-permission-banner')?.classList.remove('hidden');
  } else {
    $('#notif-permission-banner')?.classList.add('hidden');
  }
}

export function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function initNotificationsUI() {
  $('#stg-notifications-toggle')?.addEventListener('change', async (e) => {
    if (e.target.checked) {
      const granted = await NotificationManager.requestPermission();
      if (granted) {
        toast(t('notificationsEnabled', 'Notifications enabled'), 'success');
        NotificationManager.notify({
          title: 'ShareWeb',
          body: t('notificationsEnabled', 'Notifications enabled'),
          tag: 'shareweb-enabled'
        });
      } else {
        e.target.checked = false;
        if (Notification.permission === 'denied') {
          toast(t('notificationsBlocked', 'Notifications are blocked in your browser settings'), 'error');
        }
      }
    } else {
      NotificationManager.setEnabled(false);
    }
  });

  $('#notif-perm-enable-btn')?.addEventListener('click', async () => {
    $('#notif-permission-banner')?.classList.add('hidden');
    const granted = await NotificationManager.requestPermission();
    if (granted) {
      toast(t('notificationsEnabled', 'Notifications enabled'), 'success');
      NotificationManager.notify({
        title: 'ShareWeb',
        body: t('notificationsEnabled', 'Notifications enabled'),
        tag: 'shareweb-enabled'
      });
    } else if (Notification.permission === 'denied') {
      toast(t('notificationsBlocked', 'Notifications are blocked in your browser settings'), 'error');
    }
    checkNotificationBanner();
  });

  $('#notif-perm-dismiss-btn')?.addEventListener('click', () => {
    $('#notif-permission-banner')?.classList.add('hidden');
    try { sessionStorage.setItem('ds-notif-dismissed', 'true'); } catch {}
    NotificationManager.setEnabled(false);
    checkNotificationBanner();
  });

  window.addEventListener('focus', () => NotificationManager.clearBadge());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) NotificationManager.clearBadge();
  });
}
