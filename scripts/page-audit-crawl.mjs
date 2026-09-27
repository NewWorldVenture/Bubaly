#!/usr/bin/env node
// Page audit crawl — visit every page route and record what a reader would hit.
//
// Drives a real browser (Playwright/Chromium) against a running build and, per
// route, records: the document's HTTP status and where it ended up, console
// errors, uncaught page errors (hydration failures surface here), same-origin
// requests that failed or answered >= 400, catalogue keys rendered raw instead
// of their copy, the app's error boundary, and horizontal overflow at a phone
// width. It does NOT decide PASS: a clean crawl is evidence for a row, not a
// verdict (finalaudit.md § Page Audit — every page on www.bubaly.com).
//
//   node scripts/page-audit-crawl.mjs --base http://localhost:3107 \
//     [--state storage.json] [--label parent] [--lane HOME] [--only /dashboard] \
//     [--params params.json] --out results.json
//
// --state  a Playwright storageState to crawl as a signed-in user
// --params JSON map of "[param]" or "/route/[param]" → value, so dynamic routes
//          are visited with a real id; unmapped ones use a well-formed
//          placeholder and are marked `placeholder: true` in the result.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from './page-audit-register.mjs';

/**
 * Playwright pins a browser build; a container may ship a different one. Point
 * at PLAYWRIGHT_CHROMIUM (or the preinstalled /opt/pw-browsers/chromium) when
 * the pinned build is absent rather than downloading one.
 */
function launchOptions() {
  const exe = process.env.PLAYWRIGHT_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  return exe ? { executablePath: exe } : {};
}

const arg = (name, fallback = undefined) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const base = arg('base', 'http://localhost:3107');
const out = arg('out', 'page-audit-results.json');
const label = arg('label', 'anon');
const laneFilter = arg('lane');
const only = arg('only');
const params = arg('params') ? JSON.parse(readFileSync(arg('params'), 'utf8')) : {};
const concurrency = Number(arg('concurrency', '3'));
// --locale de-DE: crawl in another language and report text nodes that read
// as English prose. The i18n scanner reads source by pattern and misses copy
// in a ternary or a setter argument; this reads what a German reader sees.
const locale = arg('locale');

const catalogue = JSON.parse(readFileSync(new URL('../lib/i18n/messages/en-US.json', import.meta.url), 'utf8'));
// Keys long enough that seeing one verbatim in page text is a leak, not a
// coincidence ("ai.x" could be prose; "home.whatsForDinner" cannot).
const KEYS = Object.keys(catalogue).filter((k) => /^[a-zA-Z]+\.[a-zA-Z0-9]{6,}$/.test(k));
const ERROR_COPY = [catalogue['error.weHitAnUnexpectedError'], 'Application error: a server-side exception', 'Application error: a client-side exception'].filter(Boolean);
// The site's 404 and the signed-in app's own not-found (AppNotFound) word it
// differently; either one on a route crawled with a real id is a finding.
const NOT_FOUND_COPY = [catalogue['notFound.pageNotFound'], catalogue['appNotFound.title']].filter(Boolean);

const PLACEHOLDER = {
  uuid: '00000000-0000-4000-8000-00000000abcd',
  slug: 'page-audit-placeholder',
};

function resolve(route) {
  let placeholder = false;
  const path = route.replace(/\[\[?\.{0,3}([^\]]+)\]?\]/g, (seg, name) => {
    const exact = params[`${route}`]?.[name] ?? params[route.replace(/\/[^/]*$/, '') + `/[${name}]`];
    const byName = params[`[${name}]`];
    const value = exact ?? byName;
    if (value) return encodeURIComponent(value);
    placeholder = true;
    return /slug|token|code|key/i.test(name) ? PLACEHOLDER.slug : PLACEHOLDER.uuid;
  });
  return { path, placeholder };
}

async function visit(context, route) {
  const { path, placeholder } = resolve(route);
  const page = await context.newPage();
  const origin = new URL(base).origin;
  const consoleErrors = [];
  const pageErrors = [];
  const failed = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => pageErrors.push(String(e.message ?? e).slice(0, 300)));
  page.on('requestfailed', (r) => {
    if (!r.url().startsWith(origin)) return;
    const why = r.failure()?.errorText ?? '';
    // A navigation aborted by the next navigation is the browser, not the page.
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(why)) return;
    failed.push(`${r.method()} ${r.url().replace(origin, '')} ${why}`);
  });
  page.on('response', (r) => {
    if (!r.url().startsWith(origin) || r.status() < 400) return;
    if (r.request().resourceType() === 'document') return; // recorded as `status`
    failed.push(`${r.request().method()} ${r.url().replace(origin, '')} ${r.status()}`);
  });
  const result = { route, path, label, placeholder, status: 0, finalPath: '', title: '', consoleErrors, pageErrors, failed, rawKeys: [], englishText: [], errorBoundary: false, notFound: false, overflowPx: 0, ms: 0 };
  const t0 = Date.now();
  try {
    const res = await page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    result.status = res?.status() ?? 0;
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
    const u = new URL(page.url());
    result.finalPath = u.pathname + u.search;
    result.title = await page.title();
    const { text, code } = await page.evaluate(() => ({
      text: document.body?.innerText ?? '',
      // Identifiers a page shows AS code (an OAuth scope such as video.publish)
      // can share a catalogue key's spelling without being one.
      code: [...document.querySelectorAll('code, pre, kbd, samp')].map((e) => e.textContent ?? ''),
    }));
    result.rawKeys = KEYS.filter((k) => text.includes(k) && !code.some((c) => c.includes(k))).slice(0, 10);
    result.errorBoundary = ERROR_COPY.some((c) => text.includes(c));
    result.notFound = NOT_FOUND_COPY.some((c) => text.includes(c));
    if (locale && !locale.startsWith('en')) {
      result.englishText = await page.evaluate(() => {
        // Two or more English function words in a run of three-plus words, in
        // a visible text node outside code. Names and brands carry none.
        const EN = /\b(the|your|you|and|with|this|that|for|are|not|from|have|will|can't|couldn't|isn't)\b/gi;
        const out = new Set();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const el = n.parentElement;
          if (!el || el.closest('code,pre,kbd,samp,script,style,noscript,[aria-hidden="true"]')) continue;
          const text = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (text.split(' ').length < 3) continue;
          if ((text.match(EN) ?? []).length < 2) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          out.add(text.slice(0, 120));
        }
        for (const el of document.querySelectorAll('[aria-label],[placeholder],[title]')) {
          for (const a of ['aria-label', 'placeholder', 'title']) {
            const v = el.getAttribute(a);
            if (v && v.split(' ').length >= 3 && (v.match(EN) ?? []).length >= 2) out.add(`[${a}] ${v.slice(0, 100)}`);
          }
        }
        return [...out].slice(0, 15);
      });
    }
    result.overflowPx = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  } catch (e) {
    result.pageErrors.push(`navigation: ${String(e.message ?? e).split('\n')[0]}`);
  }
  result.ms = Date.now() - t0;
  await page.close();
  return result;
}

/**
 * Failures that are this machine's network, not the page: the image optimiser
 * fetching an external origin the sandbox cannot reach answers 403/5xx, and
 * the browser logs one "Failed to load resource" per image. They are kept on
 * the result as `environmental`, and left out of the verdict, so a sandboxed
 * crawl does not report every photo on the blog as a defect.
 */
// Beacons that rate-limit by IP by design: a crawl sends hundreds of page views
// from one address in a minute, which a visitor never does. A 429 from them is
// the limiter working, not the page failing.
const RATE_LIMITED_BEACONS = /^POST \/api\/(mkt\/track|exit-intent\/resolve)\S* 429$/;

function splitEnvironmental(r) {
  const env = r.failed.filter((f) => /\/_next\/image\?url=https?%3A%2F%2F/.test(f) || RATE_LIMITED_BEACONS.test(f));
  let owed = env.length;
  r.failed = r.failed.filter((f) => !env.includes(f));
  r.consoleErrors = r.consoleErrors.filter((c) => {
    if (owed > 0 && /Failed to load resource: the server responded with a status of (403|429|5\d\d)/.test(c)) { owed--; return false; }
    return true;
  });
  // A route crawled with a placeholder id SHOULD answer 404; the browser's
  // own log line for that document is the expected outcome, not an error.
  if (r.placeholder && r.status === 404) {
    r.consoleErrors = r.consoleErrors.filter((c) => !/status of 404 \(Not Found\)/.test(c));
  }
  r.environmental = env;
}

export function verdict(r) {
  splitEnvironmental(r);
  const problems = [];
  if (r.status >= 500 || r.status === 0) problems.push(`status ${r.status}`);
  if (r.errorBoundary) problems.push('error boundary');
  if (r.pageErrors.length) problems.push(`${r.pageErrors.length} page error(s)`);
  if (r.consoleErrors.length) problems.push(`${r.consoleErrors.length} console error(s)`);
  if (r.failed.length) problems.push(`${r.failed.length} failed request(s)`);
  if (r.rawKeys.length) problems.push(`raw keys: ${r.rawKeys.join(', ')}`);
  if (r.englishText?.length) problems.push(`english: ${r.englishText.length}`);
  if (r.overflowPx > 1) problems.push(`overflow ${r.overflowPx}px`);
  if (r.notFound && !r.placeholder) problems.push('not found');
  return problems;
}

async function main() {
  const { lanes } = build();
  let routes = lanes
    .filter((l) => !laneFilter || l.lane.id === laneFilter)
    .flatMap((l) => l.rows.map((r) => ({ route: r.route, lane: l.lane.id })));
  if (only) routes = routes.filter((r) => r.route.startsWith(only));
  // --urls: a file of concrete paths (e.g. every <loc> in /sitemap.xml), each
  // visited as-is — the literal "every page the site advertises" crawl.
  if (arg('urls')) {
    routes = readFileSync(arg('urls'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
      .map((u) => ({ route: u.replace(/^https?:\/\/[^/]+/, '') || '/', lane: 'SITEMAP' }));
  }
  const browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    ...(arg('state') ? { storageState: arg('state') } : {}),
  });
  if (locale) await context.addCookies([{ name: 'bubaly-locale', value: locale, url: base }]);
  const results = [];
  let next = 0;
  async function worker() {
    while (next < routes.length) {
      const item = routes[next++];
      const r = await visit(context, item.route);
      r.lane = item.lane;
      r.problems = verdict(r);
      results.push(r);
      console.log(`${r.problems.length ? 'ISSUE' : 'ok   '} ${String(r.status).padEnd(3)} ${r.route}${r.finalPath && r.finalPath !== r.path ? ` → ${r.finalPath}` : ''}${r.problems.length ? `  [${r.problems.join('; ')}]` : ''}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  await browser.close();
  results.sort((a, b) => a.route.localeCompare(b.route));
  writeFileSync(out, JSON.stringify(results, null, 2));
  const bad = results.filter((r) => r.problems.length);
  console.log(`\n${results.length} routes crawled as ${label}; ${bad.length} with problems → ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
