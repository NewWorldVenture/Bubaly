// scripts/audit-live-pages.mjs
//
// Loads every page of a deployed Bubaly in a real browser and reports what a
// visitor would have hit: the HTTP status, where it ended up, a title and an
// <h1>, console errors, uncaught exceptions, same-site requests that failed,
// and whether the page scrolls sideways on a phone.
//
// It is the live counterpart of scripts/crawl-authenticated-routes.mjs, which
// renders the signed-in routes against a local server with a session. This one
// has no session, on purpose: it audits what the public actually receives.
//
//   * PUBLIC pages come from three places, so a page missing from one is still
//     found: every static route under app/ outside the signed-in group, every
//     <loc> in /sitemap.xml, and every same-site link followed from those pages.
//   * SIGNED-IN pages (app/(app)/**) are each requested WITHOUT a session. The
//     only correct answer is the sign-in page; a 5xx, an error boundary, or the
//     page itself rendering for nobody are all failures.
//
//   BASE_URL=https://www.bubaly.com node scripts/audit-live-pages.mjs \
//     [--json out.json] [--jsonl progress.jsonl] [--max 3000] [--concurrency 6]
//     [--only public|app] [--filter /blog] [--axe] [--paths list.txt]
//     [--cookies cookies.json]   (signed-in audit, e.g. against a local stack)
//
// Through an HTTPS proxy, Chromium is pointed at HTTPS_PROXY and verifies TLS
// against the system NSS store; nothing here turns certificate checks off.

import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = join(ROOT, 'app');
const BASE = new URL(process.env.BASE_URL ?? 'https://www.bubaly.com');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const MAX = Number(arg('max', '3000'));
const CONCURRENCY = Number(arg('concurrency', '6'));
const ONLY = arg('only', 'all');
const FILTER = arg('filter', '');
const JSON_OUT = arg('json', '');
// A file of paths, one per line, audited exactly (no seeds, no link-following):
// how a flaky result is re-checked on its own, quietly, before it is believed.
const PATHS = arg('paths', '');
// A cookie file from scripts/crawl-login.mjs. With it, the signed-in routes are
// audited AS that member — each must render for them, not bounce to /login —
// with the same console, request, text and --axe checks the public pages get.
const COOKIES = arg('cookies', '');
// One JSON object per line as each page finishes, so a long run can be read
// (or resumed from) before it ends.
const JSONL_OUT = arg('jsonl', '');
// WCAG 2.x A/AA, the tags tests/e2e/accessibility.spec.ts holds the app to;
// serious and critical violations are recorded as problems.
const AXE = argv.includes('--axe');
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const isGroup = (s) => /^\(.*\)$/.test(s);
const isDynamic = (s) => /^\[.*\]$/.test(s);
// A signed-in page must never render its own content for nobody. These are the
// shapes an error surfaces in with a 200.
const ERROR_MARKERS = ['Application error', 'This page hit a snag', 'Internal Server Error', 'Unhandled Runtime Error'];
const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';
// Text a visitor should never read: the database seeder's placeholders, a
// value that rendered as `undefined`/`NaN`/`[object Object]`, an unfilled
// template, and a translation KEY shown in place of its sentence
// (`pricing.cardTitle` — lowerCamel, a dot, lowerCamel with a capital).
const PLACEHOLDER_TEXT = [
  [/content generated for testing purposes/i, 'seeder placeholder text'],
  [/\bImportant task #\d+\b/, 'seeder placeholder text'],
  [/\bSeed [A-Z][a-z]+(?: [A-Z][a-z]+)* #\d+/, 'seeder placeholder record'],
  [/\blorem ipsum\b/i, 'lorem ipsum'],
  [/\b(?:undefined|NaN)\b|\[object Object\]/, 'a value rendered as undefined/NaN/[object Object]'],
  [/\{\{\s*\w+\s*\}\}/, 'an unfilled {{template}}'],
  [/(?<![\w@/.-])[a-z][a-zA-Z]{2,}\.[a-z]+[A-Z][a-zA-Z0-9]*\b(?![\w/-]*\.(?:com|app|io|org))/, 'a raw translation key'],
];

/** Every page route under app/ as { pattern, group, file }. */
function routes() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry === 'page.tsx') {
        const segments = relative(APP_DIR, dir).split('/').filter(Boolean);
        const group = segments.find(isGroup) ?? '';
        const url = '/' + segments.filter((s) => !isGroup(s) && !s.startsWith('@')).join('/');
        out.push({ pattern: url === '/' ? '/' : url.replace(/\/$/, ''), group, file: relative(ROOT, path) });
      }
    }
  };
  walk(APP_DIR);
  return out;
}

async function sitemapUrls() {
  try {
    const res = await fetch(new URL('/sitemap.xml', BASE));
    const xml = await res.text();
    return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  } catch (error) {
    console.error('[audit] sitemap unreadable:', error?.message ?? error);
    return [];
  }
}

function sameSite(href) {
  try {
    const u = new URL(href, BASE);
    if (u.host !== BASE.host) return null;
    if (/\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|xml|txt|json|webmanifest|js|css|mp4|woff2?)$/i.test(u.pathname)) return null;
    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/_next/')) return null;
    u.hash = '';
    u.search = '';
    return u.pathname.replace(/\/$/, '') || '/';
  } catch {
    return null;
  }
}

async function audit(context, path, kind) {
  const page = await context.newPage();
  const result = { path, kind, status: null, finalPath: null, title: '', h1: 0, consoleErrors: [], pageErrors: [], failedRequests: [], overflowPx: 0, markers: [], ms: 0, links: [] };
  page.on('console', (m) => { if (m.type() === 'error') result.consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => result.pageErrors.push(String(e?.message ?? e).slice(0, 300)));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.host === BASE.host && r.status() >= 400 && r.request().resourceType() !== 'document') {
      result.failedRequests.push(`${r.status()} ${u.pathname}`);
    }
  });
  page.on('requestfailed', (r) => {
    const u = new URL(r.url());
    const reason = r.failure()?.errorText ?? '';
    // A prefetch the router cancels on navigation is not a failure.
    if (u.host === BASE.host && !/ERR_ABORTED/.test(reason)) result.failedRequests.push(`FAILED ${u.pathname} ${reason}`);
  });
  const started = Date.now();
  try {
    const response = await page.goto(new URL(path, BASE).toString(), { waitUntil: 'load', timeout: 45000 });
    // Settle, bounded: a page that polls never goes network-idle, and waiting
    // for it would measure the poll interval rather than the page.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    result.status = response?.status() ?? null;
    result.finalPath = new URL(page.url()).pathname;
    result.title = await page.title();
    result.h1 = await page.locator('h1').count();
    const body = await page.locator('body').innerText().catch(() => '');
    result.markers = ERROR_MARKERS.filter((m) => body.includes(m));
    for (const [pattern, what] of PLACEHOLDER_TEXT) {
      const hit = pattern.exec(body);
      if (hit) result.markers.push(`${what}: "${body.slice(Math.max(0, hit.index - 30), hit.index + hit[0].length + 30).replace(/\s+/g, ' ')}"`);
    }
    if ((kind === 'public' || COOKIES) && AXE) {
      const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      result.a11y = axe.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target?.join(' ') ?? ''}`.slice(0, 200));
    }
    if (kind === 'public') {
      result.links = (await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')))).map(sameSite).filter(Boolean);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(250);
      result.overflowPx = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
    }
  } catch (error) {
    result.pageErrors.push(`NAVIGATION: ${String(error?.message ?? error).split('\n')[0]}`);
  } finally {
    result.ms = Date.now() - started;
    await page.close().catch(() => {});
  }
  return result;
}

/** What makes a result a failure, as sentences. Empty means it passed. */
function problems(r) {
  const out = [];
  if (r.kind === 'app' && COOKIES) {
    if (r.status === null || r.status >= 400) out.push(`status ${r.status}`);
    if (r.finalPath === '/login') out.push('a signed-in member was sent to /login');
    if (!r.title) out.push('no <title>');
  } else if (r.kind === 'app') {
    if (r.status === null || r.status >= 500) out.push(`status ${r.status}`);
    if (r.finalPath !== '/login') out.push(`signed-out visitor ended on ${r.finalPath}, not /login`);
  } else {
    if (r.status === null || r.status >= 400) out.push(`status ${r.status}`);
    if (!r.title) out.push('no <title>');
    if (r.h1 !== 1 && r.finalPath === r.path) out.push(`${r.h1} <h1>`);
    if (r.overflowPx > 1) out.push(`scrolls sideways by ${r.overflowPx}px on a 390px phone`);
  }
  if (r.a11y?.length) out.push(`a11y: ${r.a11y.slice(0, 3).join('; ')}`);
  if (r.markers.length) out.push(`error text on page: ${r.markers.join(', ')}`);
  if (r.pageErrors.length) out.push(`uncaught: ${r.pageErrors[0]}`);
  if (r.consoleErrors.length) out.push(`console: ${r.consoleErrors[0]}`);
  if (r.failedRequests.length) out.push(`requests: ${[...new Set(r.failedRequests)].slice(0, 3).join('; ')}`);
  return out;
}

const all = routes();
const skippedDynamic = [];
const queue = [];
const seen = new Set();
const enqueue = (path, kind) => {
  if (!path || seen.has(path) || (FILTER && !path.startsWith(FILTER))) return;
  seen.add(path);
  queue.push({ path, kind });
};

if (PATHS) {
  for (const line of readFileSync(PATHS, 'utf8').split('\n')) {
    const path = line.trim();
    if (path) enqueue(path.replace(/^app:/, ''), path.startsWith('app:') ? 'app' : 'public');
  }
} else if (ONLY !== 'app') {
  for (const r of all) {
    if (r.group === '(app)') continue;
    if (!r.pattern.split('/').some(isDynamic)) enqueue(r.pattern, 'public');
  }
  for (const loc of await sitemapUrls()) enqueue(sameSite(loc), 'public');
}
if (!PATHS && ONLY !== 'public') {
  for (const r of all) {
    if (r.group !== '(app)') continue;
    // Signed in, a made-up id is a real 404 for a real member; those routes need
    // seeded ids (crawl-authenticated-routes --ids) and are counted, not guessed.
    if (COOKIES && r.pattern.split('/').some(isDynamic)) { skippedDynamic.push(r.pattern); continue; }
    enqueue(r.pattern.split('/').map((s) => (isDynamic(s) ? PLACEHOLDER_ID : s)).join('/') || '/', 'app');
  }
}

// A local target is reached directly; only a remote one goes through the proxy.
const local = ['localhost', '127.0.0.1'].includes(BASE.hostname);
const proxy = process.env.HTTPS_PROXY && !local ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined, proxy });
const results = [];
let done = 0;
async function worker() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (COOKIES) await context.addCookies(JSON.parse(readFileSync(COOKIES, 'utf8')));
  while (queue.length && results.length < MAX) {
    const job = queue.shift();
    const r = await audit(context, job.path, job.kind);
    // Follow what a visitor can click to, so a page no sitemap lists is still seen.
    if (job.kind === 'public' && ONLY !== 'app' && !PATHS) for (const link of r.links) enqueue(link, 'public');
    delete r.links;
    r.problems = problems(r);
    results.push(r);
    if (JSONL_OUT) appendFileSync(JSONL_OUT, JSON.stringify(r) + '\n');
    done++;
    if (done % 50 === 0) console.error(`[audit] ${done} audited, ${queue.length} queued`);
  }
  await context.close();
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await browser.close();

results.sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path));
const failing = results.filter((r) => r.problems.length);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ base: BASE.origin, at: new Date().toISOString(), results }, null, 2));
console.log(`${results.length} pages audited on ${BASE.origin}: ${results.length - failing.length} clean, ${failing.length} with problems`);
if (skippedDynamic.length) console.log(`  ${skippedDynamic.length} signed-in routes with an id segment skipped (no seeded id)`);
for (const r of failing) console.log(`  ${r.kind.padEnd(6)} ${r.path}  —  ${r.problems.join(' | ')}`);
process.exitCode = failing.length ? 1 : 0;
