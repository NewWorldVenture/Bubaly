#!/usr/bin/env node
// Page audit crawl — visit every page route and record what a reader would hit.
//
// Drives a real browser (Playwright/Chromium) against a running build and, per
// route, records: the document's HTTP status and where it ended up, console
// errors, uncaught page errors (hydration failures surface here), same-origin
// requests that failed or answered >= 400, catalogue keys rendered raw instead
// of their copy, the app's error boundary, and horizontal overflow at a phone
// width. It does NOT decide PASS: a clean crawl is evidence for a row, not a
// verdict (docs/audit/pages/README.md, "What audited means").
//
//   node scripts/page-audit-crawl.mjs --base http://localhost:3107 \
//     [--state storage.json] [--label parent] [--lane HOME] [--only /dashboard] \
//     [--params params.json] --out results.json
//
// --state  a Playwright storageState to crawl as a signed-in user
// --params JSON map of "[param]" or "/route/[param]" → value, so dynamic routes
//          are visited with a real id; unmapped ones use a well-formed
//          placeholder and are marked `placeholder: true` in the result.

import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { build } from './page-audit-register.mjs';

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

const catalogue = JSON.parse(readFileSync(new URL('../lib/i18n/messages/en-US.json', import.meta.url), 'utf8'));
// Keys long enough that seeing one verbatim in page text is a leak, not a
// coincidence ("ai.x" could be prose; "home.whatsForDinner" cannot).
const KEYS = Object.keys(catalogue).filter((k) => /^[a-zA-Z]+\.[a-zA-Z0-9]{6,}$/.test(k));
const ERROR_COPY = [catalogue['error.weHitAnUnexpectedError'], 'Application error: a server-side exception', 'Application error: a client-side exception'].filter(Boolean);
const NOT_FOUND_COPY = catalogue['notFound.pageNotFound'];

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
  const result = { route, path, label, placeholder, status: 0, finalPath: '', title: '', consoleErrors, pageErrors, failed, rawKeys: [], errorBoundary: false, notFound: false, overflowPx: 0, ms: 0 };
  const t0 = Date.now();
  try {
    const res = await page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    result.status = res?.status() ?? 0;
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
    const u = new URL(page.url());
    result.finalPath = u.pathname + u.search;
    result.title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    result.rawKeys = KEYS.filter((k) => text.includes(k)).slice(0, 10);
    result.errorBoundary = ERROR_COPY.some((c) => text.includes(c));
    result.notFound = !!NOT_FOUND_COPY && text.includes(NOT_FOUND_COPY);
    result.overflowPx = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  } catch (e) {
    result.pageErrors.push(`navigation: ${String(e.message ?? e).split('\n')[0]}`);
  }
  result.ms = Date.now() - t0;
  await page.close();
  return result;
}

export function verdict(r) {
  const problems = [];
  if (r.status >= 500 || r.status === 0) problems.push(`status ${r.status}`);
  if (r.errorBoundary) problems.push('error boundary');
  if (r.pageErrors.length) problems.push(`${r.pageErrors.length} page error(s)`);
  if (r.consoleErrors.length) problems.push(`${r.consoleErrors.length} console error(s)`);
  if (r.failed.length) problems.push(`${r.failed.length} failed request(s)`);
  if (r.rawKeys.length) problems.push(`raw keys: ${r.rawKeys.join(', ')}`);
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
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    ...(arg('state') ? { storageState: arg('state') } : {}),
  });
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

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
