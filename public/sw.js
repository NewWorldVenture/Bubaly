/* Bubaly service worker — app-shell caching for offline-friendly PWA behavior.
   Network-first for navigation/API (always fresh family data when online),
   cache-first for static assets.

   PRIVACY INVARIANT (M-023): authenticated HTML is NEVER written to Cache
   Storage. Cached pages persist unencrypted after logout and would be served
   offline to whoever next opens the app on a shared/family device — so only the
   public app shell below is ever cached for navigations; every other page is
   network-only with the /offline fallback. (The v3→v4 bump purges any HTML the
   previous worker cached, via the activate-time cleanup.) */
const CACHE = 'bubaly-v4';
const APP_SHELL = ['/', '/offline'];
const CACHEABLE_NAV = new Set(APP_SHELL);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache Supabase auth or API calls.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/auth')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          // Only the public app shell may be cached (see PRIVACY INVARIANT).
          if (CACHEABLE_NAV.has(url.pathname)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('/offline'))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((res) => {
          if (res.ok && (request.destination === 'style' || request.destination === 'script' || request.destination === 'image')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        }),
    ),
  );
});

// Push notifications (Phase 10 dispatch sends Web Push payloads here).
self.addEventListener('push', (event) => {
  let data = { title: 'Bubaly', body: 'You have a new notification' };
  try { data = event.data.json(); } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      data: data.url || '/dashboard',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data || '/dashboard'));
});
