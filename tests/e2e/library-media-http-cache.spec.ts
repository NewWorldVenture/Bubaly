import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { LIBRARY_MEDIA_CACHE_CONTROL } from '../../lib/library/progress';

// AUD-1040-LIBRARY-BOUNDARIES, the browser's HTTP cache. /library/media used to
// answer `private, max-age=3600`, so Chromium kept each episode for an hour
// under its URL alone, and the next reader on the browser got it without the
// route deciding for them: an adult's video, handed to a child.
//
// Real Chromium HTTP cache, a real local server and the production worker
// (public/sw.js), registered natively. NO request interception: Playwright's
// routing switches the HTTP cache off, which is the one thing this must not do.
// The reader is a cookie, as the session is; the URL never changes.

const EPISODE = '/library/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEGACY_CACHE_CONTROL = 'private, max-age=3600';
const worker = fs.readFileSync('public/sw.js', 'utf8');

type Fixture = { origin: string; hits: string[]; cacheControl: string; close: () => Promise<void> };

async function serve(): Promise<Fixture> {
  const fixture = { hits: [] as string[], cacheControl: LIBRARY_MEDIA_CACHE_CONTROL } as Fixture;
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://fixture.invalid');
    if (pathname === '/' || pathname === '/offline') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Library fixture</title><main>Library fixture</main>');
      return;
    }
    if (pathname === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
      res.end(worker);
      return;
    }
    if (pathname === EPISODE) {
      const reader = /(?:^|;\s*)reader=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? 'nobody';
      fixture.hits.push(reader);
      res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': fixture.cacheControl, 'x-content-type-options': 'nosniff' });
      res.end(`video-for-${reader}`);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fixture.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return fixture;
}

let fixture: Fixture;
test.use({ serviceWorkers: 'allow', trace: 'off', screenshot: 'off', video: 'off' });
test.beforeEach(async () => { fixture = await serve(); });
test.afterEach(async () => { await fixture.close(); });

/** The session changes; the episode's URL does not. */
const signInAs = (page: Page, reader: string) =>
  page.evaluate((who) => { document.cookie = `reader=${who}; path=/`; }, reader);
/** What the page is handed for the episode, as a player's request is (destination ''). */
const play = (page: Page) => page.evaluate(async (episode) => (await fetch(episode)).text(), EPISODE);
async function underTheWorker(page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

test('the HTTP cache this checks is real: an older answer is handed to the next reader without the server', async ({ page }) => {
  // The control: without it, a pass below could be a cache that never stored anything.
  fixture.cacheControl = LEGACY_CACHE_CONTROL;
  await page.goto(fixture.origin);
  await signInAs(page, 'adult');
  expect(await play(page)).toBe('video-for-adult');
  await signInAs(page, 'child');
  expect(await play(page)).toBe('video-for-adult');
  expect(fixture.hits).toEqual(['adult']);
});

test('an episode answered as the route answers now is asked for again for the next reader', async ({ page }) => {
  await page.goto(fixture.origin);
  await signInAs(page, 'adult');
  expect(await play(page)).toBe('video-for-adult');
  await signInAs(page, 'child');
  expect(await play(page)).toBe('video-for-child');
  expect(fixture.hits).toEqual(['adult', 'child']);
});

test('an older answer already fresh in the HTTP cache is not handed to the next reader once the worker runs', async ({ page }) => {
  fixture.cacheControl = LEGACY_CACHE_CONTROL;
  await page.goto(fixture.origin);
  await signInAs(page, 'adult');
  // Filled before this change: no worker of this version, the old header.
  expect(await play(page)).toBe('video-for-adult');

  await underTheWorker(page);
  await signInAs(page, 'child');
  expect(await play(page)).toBe('video-for-child');
  expect(fixture.hits).toEqual(['adult', 'child']);
});

test('opening the episode itself under the worker goes past an older fresh answer too', async ({ page }) => {
  fixture.cacheControl = LEGACY_CACHE_CONTROL;
  await page.goto(fixture.origin);
  await signInAs(page, 'adult');
  expect(await play(page)).toBe('video-for-adult');

  await underTheWorker(page);
  await signInAs(page, 'child');
  await page.goto(fixture.origin + EPISODE, { waitUntil: 'commit' });
  await expect.poll(() => fixture.hits).toEqual(['adult', 'child']);
});
