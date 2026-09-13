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
/* Episodes a family explicitly downloaded. Separate from the app-shell cache
   and NOT version-bumped, because its contents are theirs rather than ours:
   the activate sweep below used to delete it along with every other unknown
   cache, so every download in the house was destroyed by the next deploy that
   touched this file. It holds publisher audio fetched through /library/media,
   never authenticated HTML, so it is outside the M-023 invariant rather than an
   exception to it. Kept in step with LIBRARY_CACHE in lib/library/progress.ts,
   which a worker cannot import. */
const LIBRARY_CACHE = 'bubaly-library-v1';
const KEEP = new Set([CACHE, LIBRARY_CACHE]);
const APP_SHELL = ['/', '/offline'];
const CACHEABLE_NAV = new Set(APP_SHELL);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))),
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
  const target = event.notification.data || '/dashboard';
  // Focus an already-open app window and navigate it, instead of stacking a new
  // instance/tab on every push tap (M-026). Fall back to opening one.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => 'focus' in w);
      if (win) {
        return win.focus().then((focused) =>
          'navigate' in focused ? focused.navigate(target).catch(() => focused) : focused,
        );
      }
      return self.clients.openWindow(target);
    }),
  );
});
