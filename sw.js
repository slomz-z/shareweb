const CACHE = 'shareweb-v145';
const APP_SHELL = [
  '/',
  '/login',
  '/login.html',
  '/index.html',
  '/account.html',
  '/account.js',
  '/style.css',
  '/lock-frame.js',
  '/page-i18n.js',
  '/qr-code.js',
  '/sound-effects.js',
  '/app.js',
  '/modules/utils.js',
  '/modules/state.js',
  '/modules/translations.js',
  '/modules/i18n.js',
  '/modules/crypto-e2ee.js',
  '/modules/hasher.js',
  '/modules/tar.js',
  '/modules/theme.js',
  '/modules/settings.js',
  '/modules/notifications.js',
  '/modules/pwa.js',
  '/modules/lightbox.js',
  '/modules/transfer-cards.js',
  '/modules/content-checker.js',
  '/modules/file-picker.js',
  '/modules/outbox.js',
  '/modules/signaling.js',
  '/modules/websocket.js',
  '/modules/peers-rooms.js',
  '/modules/relay-transfer.js',
  '/modules/webrtc-sender.js',
  '/modules/webrtc-receiver.js',
  '/modules/history.js',
  '/modules/caret.js',
  '/modules/auth.js',
  '/modules/passkeys.js',
  '/crypto.js',
  '/crypto-worker.js',
  '/support.html',
  '/support.js',
  '/terms.html',
  '/privacy.html',
  '/manage-login.html',
  '/manage-forbidden.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/icons/favicon-16.png',
  '/vendor/nsfwjs.min.js',
  '/vendor/nsfw-model/model.json',
  '/vendor/nsfw-model/group1-shard1of1',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Handle PWA Web Share Target
  if (url.pathname === '/share-target' && request.method === 'POST') {
    event.respondWith((async () => {
      try {
        const formData = await request.formData();
        const files = formData.getAll('files');
        const title = formData.get('title') || '';
        const text = formData.get('text') || '';
        const link = formData.get('url') || '';

        const cache = await caches.open('shareweb-incoming-share');
        const fileDataList = [];
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (file && file.name) {
            const buf = await file.arrayBuffer();
            const key = `/shared-file-${Date.now()}-${i}`;
            await cache.put(key, new Response(buf, {
              headers: {
                'X-Filename': encodeURIComponent(file.name),
                'Content-Type': file.type || 'application/octet-stream',
                'Content-Length': String(file.size),
              }
            }));
            fileDataList.push({ key, name: file.name, size: file.size, type: file.type });
          }
        }
        await cache.put('/shared-meta', new Response(JSON.stringify({ title, text, link, files: fileDataList, time: Date.now() }), {
          headers: { 'Content-Type': 'application/json' }
        }));
      } catch (err) {
        console.error('Failed to handle share-target in SW:', err);
      }
      return Response.redirect('/app?shared=1', 303);
    })());
    return;
  }

  if (request.method !== 'GET') return;

  if (url.origin !== self.location.origin) return;

  // Never cache dynamic/API traffic.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname === '/ws') {
    return;
  }

  // Navigation: network-first, fall back to cached shell (works offline).
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          return res;
        })
        .catch(() => {
          return caches.match(url.pathname).then((matched) => {
            return matched || caches.match('/index.html');
          });
        })
    );
    return;
  }

  // Static assets: cache-first with network fallback + revalidation in background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

/* ---------------- Native Push & Notification Event Handlers ---------------- */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'ShareWeb', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'ShareWeb';
  const options = {
    body: data.body || 'New file activity in ShareWeb',
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/favicon-32.png',
    tag: data.tag || `shareweb-${Date.now()}`,
    data: data.data || { url: '/app' },
    vibrate: [150, 50, 150],
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(urlToOpen);
      }
    })
  );
});