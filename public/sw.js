/* Bubaly service worker — app-shell caching for offline-friendly PWA behavior.
   Network-first for navigation/API (always fresh family data when online),
   cache-first for static assets.

   PRIVACY INVARIANT (M-023): private pages and images must never be read from
   or written to Cache Storage. The v6 bump removes images saved by older
   workers; explicit request allowlists also exclude late writes from an old
   worker that finishes after activation. Logout does not clear Cache Storage.
   This extends the SEC-001 / Q58 / C1-K-18 optimizer write protection: both
   reads and writes require known public resources, including optimizer input.
   The previous v5 worker could still read arbitrary or stale cached entries. */
const CACHE = 'bubaly-v6';
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
// These are checked-in public files, not a directory or remote-host allowance.
// Keep optimized logos available offline without admitting private Next images.
const PUBLIC_IMAGES = new Set([
  '/brand/bubaly-logo.png', '/brand/bubaly-mark.png', '/images/family-ai-lifestyle.png',
  '/icons/icon-16.png', '/icons/icon-32.png', '/icons/icon-48.png', '/icons/icon-72.png',
  '/icons/icon-96.png', '/icons/icon-144.png', '/icons/icon-167.png', '/icons/icon-180.png',
  '/icons/icon-192.png', '/icons/icon-256.png', '/icons/icon-384.png', '/icons/icon-512.png',
  '/icons/icon-1024.png', '/icons/maskable-192.png', '/icons/maskable-512.png',
  '/launch/launch-750x1334.png', '/launch/launch-828x1792.png', '/launch/launch-1125x2436.png',
  '/launch/launch-1170x2532.png', '/launch/launch-1179x2556.png', '/launch/launch-1206x2622.png',
  '/launch/launch-1242x2208.png', '/launch/launch-1242x2688.png', '/launch/launch-1284x2778.png',
  '/launch/launch-1290x2796.png', '/launch/launch-1320x2868.png',
]);
// Default Next image/device widths; next.config.mjs does not override these.
const IMAGE_WIDTHS = new Set(['16', '32', '48', '64', '96', '128', '256', '384', '640', '750', '828', '1080', '1200', '1920', '2048', '3840']);
const LIBRARY_ITEM = /^\/library\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function publicShell(url, request) {
  return !url.search && !url.hash && CACHEABLE_NAV.has(url.pathname)
    && !['rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-router-segment-prefetch', 'next-action']
      .some(name => request.headers.has(name));
}

function publicResource(request, url) {
  if (url.hash) return null;
  if (request.destination === 'image') {
    if (!url.search && PUBLIC_IMAGES.has(url.pathname)) return 'image';
    if (url.pathname !== '/_next/image') return null;
    const pairs = [...url.searchParams];
    if (pairs.length !== 3 || ['url', 'w', 'q'].some(key => url.searchParams.getAll(key).length !== 1)) return null;
    return PUBLIC_IMAGES.has(url.searchParams.get('url')) && IMAGE_WIDTHS.has(url.searchParams.get('w'))
      && /^(?:[1-9][0-9]?|100)$/.test(url.searchParams.get('q')) ? 'image' : null;
  }
  if (request.destination !== 'script' && request.destination !== 'style') return null;
  if (url.search && (url.searchParams.size !== 1 || !/^dpl_[A-Za-z0-9]+$/.test(url.searchParams.get('dpl')))) return null;
  // Next route chunks may encode parentheses/brackets; separators and dot
  // segments must remain literal so a different route cannot match the prefix.
  if (/%(?:2f|5c|2e)/i.test(url.pathname)) return null;
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
  if (!pathname.startsWith('/_next/static/') || !pathname.split('/').slice(3).every(part =>
    part && part !== '.' && part !== '..' && /^[A-Za-z0-9_()[\].~-]+$/.test(part))) return null;
  return pathname.endsWith(request.destination === 'script' ? '.js' : '.css') ? request.destination : null;
}

function safeResponse(response, request, kind, publicInstall = false) {
  if (!response || response.status !== 200 || response.redirected || response.type === 'opaque' || response.type === 'opaqueredirect') return false;
  if (response.url && response.url !== request.url) return false;
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (kind === 'library') return /^(?:audio|video)\/[a-z0-9.+-]+$/.test(type) || type === 'application/octet-stream';
  if (!publicInstall && /(?:^|,)\s*(?:private|no-store)(?:\s*(?:=|,|$))/i.test(response.headers.get('cache-control') || '')) return false;
  if (kind === 'shell') return type === 'text/html';
  if (kind === 'image') return ['image/png', 'image/webp', 'image/avif'].includes(type);
  if (kind === 'style') return type === 'text/css';
  return ['application/javascript', 'text/javascript', 'application/x-javascript'].includes(type);
}

async function cachedResponse(name, request, kind) {
  try {
    const response = await (await caches.open(name)).match(request);
    // Public shell is installed with credentials omitted; framework no-store
    // headers on that generic HTML do not make it an authenticated response.
    return safeResponse(response, request, kind, kind === 'shell') ? response : undefined;
  } catch { return undefined; }
}

async function savePublic(request, response) {
  try { await (await caches.open(CACHE)).put(request, response); }
  catch { /* Storage denial must not discard a successful network response. */ }
}

function offlinePage() {
  return cachedResponse(CACHE, new Request(new URL('/offline', self.location.origin)), 'shell')
    .then(response => response || new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all(APP_SHELL.map(async path => {
    const request = new Request(new URL(path, self.location.origin), {
      credentials: 'omit', redirect: 'error', cache: 'reload', headers: { Accept: 'text/html' },
    });
    const response = await fetch(request);
    if (!safeResponse(response, request, 'shell', true)) throw new Error('Public offline shell is unavailable');
    await savePublic(request, response);
  })).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))),
    ).catch(() => {
      // A denied purge must not leave the old worker in charge. Named-cache
      // allowlists still exclude private entries when physical deletion fails.
    }).then(() => self.clients.claim()),
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
    event.respondWith(fetch(request).then(async response => {
      if (publicShell(url, request) && safeResponse(response, request, 'shell')) await savePublic(request, response.clone());
      return response;
    }).catch(async () => (publicShell(url, request) && await cachedResponse(CACHE, request, 'shell')) || offlinePage()));
    return;
  }

  // Only the player writes this cache after an explicit download. Keep those
  // publisher bytes available without using the library as a generic fallback.
  if (!url.search && !url.hash && LIBRARY_ITEM.test(url.pathname)
    && ['', 'audio', 'video'].includes(request.destination)) {
    event.respondWith(cachedResponse(LIBRARY_CACHE, request, 'library').then(response => response || fetch(request)));
    return;
  }

  const kind = publicResource(request, url);
  if (!kind) return;
  event.respondWith(cachedResponse(CACHE, request, kind).then(async cached => {
    if (cached) return cached;
    const response = await fetch(request);
    if (safeResponse(response, request, kind)) await savePublic(request, response.clone());
    return response;
  }));
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
