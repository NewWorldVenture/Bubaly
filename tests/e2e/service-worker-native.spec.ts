import { expect, test, type Page } from '@playwright/test';

// Native Chromium registration against the Next server already owned by the
// E2E runner. Only the empty control document is synthetic: /sw.js, both install
// documents and the public icon reach that server without a fulfilled response.
// No accounts, provider requests or authenticated data are involved.
const FIXTURE = '/__sw_native_fixture';
const CURRENT = 'bubaly-v6';
const LIBRARY = 'bubaly-library-v1';
const PRIVATE_IMAGE = '/_next/image?url=%2Fsynthetic-private-family-image.png&w=256&q=75';
const PRIVATE_PAGE = '/__sw_native_private_page';
const EPISODE = '/library/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PUBLIC_IMAGE = '/icons/icon-192.png';
const PRIVATE_MARKER = 'synthetic-private-family-content';
const AUDIO_MARKER = 'synthetic-explicit-publisher-download';
// A decodable image is essential: bad bytes could fail to display even if the
// worker incorrectly returned the private cache entry.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=';

function localOrigin(value: string | undefined) {
  const url = new URL(value ?? '');
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Native service-worker acceptance requires the existing local E2E server.');
  }
  return url.origin;
}

async function loadImage(page: Page, url: string) {
  return page.evaluate(address => new Promise<{ loaded: boolean; width: number }>(resolve => {
    const image = new Image();
    const finish = (loaded: boolean) => {
      image.onload = null; image.onerror = null;
      resolve({ loaded, width: image.naturalWidth });
    };
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = address;
  }), url);
}

test.use({ serviceWorkers: 'allow', locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off' });

test('native worker installs the public shell and excludes private caches while preserving public offline resources', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const origin = localOrigin(baseURL);
  let offline = false;
  const blocked: string[] = [], pageErrors: string[] = [];
  const onlineFailures: string[] = [], offlineFailures: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.name));
  context.on('requestfailed', request => {
    const pathname = new URL(request.url()).pathname;
    (offline ? offlineFailures : onlineFailures).push(pathname);
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())
      || url.pathname.startsWith('/api') || url.pathname.startsWith('/auth')) {
      blocked.push(`${request.method()} ${url.origin === origin ? url.pathname : 'external-origin'}`);
      await route.abort('blockedbyclient'); return;
    }
    if (!offline && url.pathname === FIXTURE && !url.search && request.method() === 'GET') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Native worker fixture</title><link rel="icon" href="data:,"></head><body>Native worker fixture</body></html>' });
      return;
    }
    // The browser is also set offline. This explicit transport denial covers
    // worker-owned network requests consistently, while native cache replies
    // never reach this handler. Record them separately from online failures.
    if (offline) { await route.abort('internetdisconnected'); return; }
    await route.continue();
  });
  await page.goto(origin + FIXTURE);
  expect(context.serviceWorkers()).toHaveLength(0);
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(items => items.length))).toBe(0);

  await page.evaluate(async ({ CURRENT, LIBRARY, PRIVATE_IMAGE, PRIVATE_PAGE, EPISODE, PRIVATE_MARKER, AUDIO_MARKER, PIXEL }) => {
    document.cookie = 'sw-native-fixture-owner=synthetic; Path=/; SameSite=Lax';
    const bytes = Uint8Array.from(atob(PIXEL), character => character.charCodeAt(0));
    for (const name of ['bubaly-v4', 'bubaly-v5', CURRENT]) {
      const cache = await caches.open(name);
      await cache.put(PRIVATE_IMAGE, new Response(bytes, { headers: { 'content-type': 'image/png' } }));
      await cache.put(PRIVATE_PAGE, new Response(PRIVATE_MARKER, { headers: { 'content-type': 'text/html' } }));
    }
    await (await caches.open(LIBRARY)).put(EPISODE, new Response(AUDIO_MARKER, { headers: { 'content-type': 'audio/mpeg' } }));
  }, { CURRENT, LIBRARY, PRIVATE_IMAGE, PRIVATE_PAGE, EPISODE, PRIVATE_MARKER, AUDIO_MARKER, PIXEL });
  // Prove that our negative image control contains a valid image before asking
  // the worker to reject it. This data URL cannot contact a network or cache.
  expect(await loadImage(page, `data:image/png;base64,${PIXEL}`)).toEqual({ loaded: true, width: 1 });

  const installRoot = context.waitForEvent('response', response => response.url() === origin + '/'
    && response.request().serviceWorker() !== null);
  const installOffline = context.waitForEvent('response', response => response.url() === origin + '/offline'
    && response.request().serviceWorker() !== null);
  const registration = await page.evaluate(() => navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .then(value => ({ scope: value.scope })));
  expect(registration.scope).toBe(origin + '/');
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state), { timeout: 30_000 }).toBe('activated');
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(origin + '/sw.js');
  for (const response of await Promise.all([installRoot, installOffline])) {
    expect(response.status()).toBe(200);
    expect(response.fromServiceWorker()).toBe(false);
    expect(response.headers()['content-type']).toContain('text/html');
    expect((await response.request().allHeaders()).cookie).toBeUndefined();
  }
  expect(await page.evaluate(() => caches.keys())).toEqual(expect.arrayContaining([CURRENT, LIBRARY]));
  expect(await page.evaluate(() => caches.keys())).not.toEqual(expect.arrayContaining(['bubaly-v4']));
  expect(await page.evaluate(() => caches.keys())).not.toEqual(expect.arrayContaining(['bubaly-v5']));
  const shell = await page.evaluate(async CURRENT => {
    const response = await (await caches.open(CURRENT)).match('/offline');
    return response ? { status: response.status, body: await response.text() } : null;
  }, CURRENT);
  expect(shell?.status).toBe(200);
  expect(shell?.body).toContain('<h1');
  expect(shell?.body).not.toContain(PRIVATE_MARKER);

  const onlineIcon = page.waitForResponse(response => response.url() === origin + PUBLIC_IMAGE && response.fromServiceWorker());
  expect((await loadImage(page, PUBLIC_IMAGE)).loaded).toBe(true);
  expect((await onlineIcon).status()).toBe(200);
  await expect.poll(() => page.evaluate(async ({ CURRENT, PUBLIC_IMAGE }) =>
    Boolean(await (await caches.open(CURRENT)).match(PUBLIC_IMAGE)), { CURRENT, PUBLIC_IMAGE })).toBe(true);
  expect(onlineFailures).toEqual([]);

  // An old worker can finish a delayed write after activation has purged its
  // cache. Recreate that cache, retaining the current cache's private entry too.
  await page.evaluate(async ({ PRIVATE_IMAGE, PRIVATE_PAGE, PRIVATE_MARKER, PIXEL }) => {
    const old = await caches.open('bubaly-v5');
    await old.put(PRIVATE_IMAGE, new Response(Uint8Array.from(atob(PIXEL), character => character.charCodeAt(0)), { headers: { 'content-type': 'image/png' } }));
    await old.put(PRIVATE_PAGE, new Response(PRIVATE_MARKER, { headers: { 'content-type': 'text/html' } }));
  }, { PRIVATE_IMAGE, PRIVATE_PAGE, PRIVATE_MARKER, PIXEL });
  offline = true;
  await context.setOffline(true);
  expect(await loadImage(page, PRIVATE_IMAGE)).toEqual({ loaded: false, width: 0 });

  const offlineIcon = page.waitForResponse(response => response.url() === origin + PUBLIC_IMAGE && response.fromServiceWorker());
  expect((await loadImage(page, PUBLIC_IMAGE)).loaded).toBe(true);
  expect((await offlineIcon).status()).toBe(200);
  const audioResponse = page.waitForResponse(response => response.url() === origin + EPISODE && response.fromServiceWorker());
  expect(await page.evaluate(address => fetch(address).then(response => response.text()), EPISODE)).toBe(AUDIO_MARKER);
  expect((await audioResponse).status()).toBe(200);

  // Navigate the top-level page: an opaque iframe bypasses the worker, while
  // a same-origin iframe is correctly refused by the real shell's anti-framing
  // headers. Disable scripts in this page target so cached Next/analytics code
  // stays inert; the separate native worker still handles the navigation.
  const pageSession = await context.newCDPSession(page);
  await pageSession.send('Emulation.setScriptExecutionDisabled', { value: true });
  const fallback = await page.goto(origin + PRIVATE_PAGE, { waitUntil: 'domcontentloaded' });
  expect(fallback).not.toBeNull();
  expect(fallback!.fromServiceWorker()).toBe(true);
  expect(fallback!.status()).toBe(200);
  expect(await fallback!.text()).toBe(shell?.body);
  expect(await fallback!.text()).not.toContain(PRIVATE_MARKER);
  expect(offlineFailures).toContain('/_next/image');
  expect(blocked).toEqual([]);
  expect(pageErrors).toEqual([]);
  await testInfo.attach('native-worker-acceptance', { contentType: 'application/json', body: JSON.stringify({
    worker: '/sw.js', cache: CURRENT, nativeActivation: true, installDocuments: ['/', '/offline'],
    onlineFailures, expectedOfflineFailures: offlineFailures, blockedRequests: blocked, pageErrors,
    privateImageRejected: true, privateNavigationUsedPublicOfflineShell: true,
    scriptsDisabledForFallback: true,
    publicImageFromWorker: true, explicitPublisherDownloadFromWorker: true,
  }) });
});
