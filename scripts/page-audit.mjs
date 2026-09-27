#!/usr/bin/env node
// Per-page audit crawler for the "every page on bubaly.com" pass in
// finalaudit.md ("Page audit — every page"). Any bot can run it; it only reads.
//
//   node scripts/page-audit.mjs --base https://www.bubaly.com --sitemap \
//     --out /tmp/pages.jsonl [--paths file.txt] [--storage state.json] \
//     [--concurrency 4] [--mobile] [--locale fr-FR] [--interact]
//
// For each path it loads the page in Chromium and records, as one JSON line:
//   status        the document's HTTP status (after redirects)
//   finalPath     where it ended up (a login redirect is data, not a failure)
//   pageErrors    uncaught exceptions thrown in the page
//   consoleErrors console.error messages
//   badRequests   same-origin subresources that answered >= 400 or failed
//   h1            number of <h1> elements
//   title         document.title
//   overflow      horizontal overflow in px at the viewport width
//   smells        visible text that should never render: "undefined", "NaN",
//                 "[object Object]", an error boundary, or a raw i18n key
//   links         same-origin hrefs found on the page (for the link pass)
//   interactions  with --interact: every tab, <summary> and button in <main>
//                 (up to 40) is clicked in turn — never one that submits a form
//                 and never one labelled like a delete, payment or send — and
//                 each click that threw, logged an error, failed a request or
//                 showed an error boundary is listed with what it did. This
//                 one writes (to whatever `--base` is), so it is for a local
//                 stack, not production.
//
// It judges nothing itself; `verdict` is a mechanical summary (PASS when the
// document answered < 400 and none of the lists above has an entry), and a
// human or bot records the real status in finalaudit.md after looking.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const base = (opt('base', 'https://www.bubaly.com')).replace(/\/$/, '');
const out = opt('out', 'page-audit.jsonl');
const concurrency = Number(opt('concurrency', '4'));
const storage = opt('storage', undefined);
const mobile = flag('mobile');
// The browser's language: the site picks its locale from the NEXT_LOCALE
// cookie or, failing that, Accept-Language, which this sets.
const locale = opt('locale', 'en-US');
const origin = new URL(base).origin;
const interact = flag('interact');
if (interact && /bubaly\.com$/.test(new URL(base).hostname)) {
  console.error('--interact clicks controls that can write; point it at a local stack, not production');
  process.exit(2);
}

async function loadPaths() {
  const paths = new Set();
  const file = opt('paths', undefined);
  if (file) for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) paths.add(line.trim());
  if (flag('sitemap')) {
    const xml = await (await fetch(`${base}/sitemap.xml`)).text();
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const u = new URL(m[1]);
      paths.add(u.pathname + u.search);
    }
  }
  return [...paths];
}

const SMELLS = [
  [/\bundefined\b/, 'undefined'],
  [/\bNaN\b/, 'NaN'],
  [/\[object Object\]/, '[object Object]'],
  [/Something went wrong|Application error|Unhandled Runtime Error/i, 'error boundary'],
  // A catalogue key that was rendered instead of translated: dotted camelCase
  // with no spaces, e.g. "billing.couldNotLoadPlans".
  [/(?:^|\s)([a-z][a-zA-Z0-9]+\.[a-z][a-zA-Z0-9]{3,}(?:\.[a-zA-Z0-9]+)*)(?=\s|$)/, 'raw i18n key'],
];

// The controls --interact clicks, tagged in document order so the Nth one can
// be found again after a click re-rendered the page.
const CONTROLS = '[role="tab"],[aria-haspopup]:not([aria-haspopup="false"]),button[aria-expanded],summary,button,a[role="button"]';
const NEVER = /delete|remove|sign ?out|log ?out|cancel|reset|archive|revoke|disconnect|leave|pay|send|buy|purchase|approve|decline|deny|reject|confirm|publish|charge|call|dial|refund|transfer|withdraw|unsubscribe|block|lock|emergency|sos|panic/i;

async function tagControls(page) {
  return page.evaluate(([sel, never]) => {
    const neverRe = new RegExp(never, 'i');
    const main = document.querySelector('main') ?? document.body;
    let n = 0;
    for (const el of document.querySelectorAll('[data-audit-i]')) el.removeAttribute('data-audit-i');
    for (const el of main.querySelectorAll(sel)) {
      const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || el.closest('[aria-hidden="true"],[inert]') || el.disabled) continue;
      // A button with no type submits the form it sits in; outside a form it
      // is an ordinary button.
      if (el.tagName === 'BUTTON' && el.type === 'submit' && el.form) continue;
      if (el.closest('nav,header,footer,[data-sidebar]')) continue;
      if (!label || neverRe.test(label)) continue;
      el.setAttribute('data-audit-i', String(n++));
    }
    return n;
  }, [CONTROLS, NEVER.source]);
}

async function clickThrough(page, path, seen) {
  const failed = [];
  let clicked = 0;
  const count = Math.min(await tagControls(page), 40);
  for (let i = 0; i < count; i++) {
    const before = [seen.pageErrors.length, seen.consoleErrors.length, seen.badRequests.length];
    const el = page.locator(`[data-audit-i="${i}"]`).first();
    const label = ((await el.getAttribute('aria-label').catch(() => null)) || (await el.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    try {
      await el.click({ timeout: 3_000 });
      clicked += 1;
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    } catch {
      continue; // covered or detached by the last click: not this control's defect
    }
    const boundary = await page.evaluate(() => /Something went wrong|This page hit a snag|Application error/i.test(document.body?.innerText ?? ''));
    const threw = seen.pageErrors.slice(before[0]);
    const logged = seen.consoleErrors.slice(before[1]);
    const requests = seen.badRequests.slice(before[2]);
    if (boundary || threw.length || logged.length || requests.length) failed.push({ label, boundary, threw, logged, requests });
    // Put the page back: close what opened, or reload if the click navigated.
    await page.keyboard.press('Escape').catch(() => {});
    const here = new URL(page.url()).pathname + new URL(page.url()).search;
    if (here !== path || boundary) {
      await page.goto(base + path, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
    }
    await tagControls(page);
  }
  return { controls: count, clicked, failed };
}

async function auditOne(context, path) {
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const badRequests = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // "Failed to load resource" names no URL in its text; its location does.
    const where = /^Failed to load resource/.test(m.text()) && m.location()?.url ? ` <${m.location().url.replace(origin, '')}>` : '';
    consoleErrors.push(m.text().slice(0, 300) + where);
  });
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText ?? '';
    if (r.url().startsWith(origin) && !/ERR_ABORTED|NS_BINDING_ABORTED/.test(f)) badRequests.push(`${f} ${r.url().replace(origin, '')}`);
  });
  page.on('response', (r) => {
    if (r.url().startsWith(origin) && r.status() >= 400 && r.request().resourceType() !== 'document') {
      // Who answered a 5xx matters: a sandbox egress proxy's 502 carries no
      // `server: Vercel`/`x-vercel-id`, and is not the site's defect.
      const h = r.headers();
      const via = r.status() >= 500 ? ` [server=${h.server ?? '-'}${h['x-vercel-id'] ? ' vercel' : ''}]` : '';
      badRequests.push(`${r.status()} ${r.url().replace(origin, '')}${via}`);
    }
  });
  const row = { path, base, mobile, locale, at: new Date().toISOString() };
  try {
    const res = await page.goto(base + path, { waitUntil: 'networkidle', timeout: 45_000 });
    row.status = res?.status() ?? null;
    if (res && res.status() >= 500) row.server = `${res.headers().server ?? '-'}${res.headers()['x-vercel-id'] ? ' vercel' : ''}`;
    row.finalPath = new URL(page.url()).pathname + new URL(page.url()).search;
    // Many signed-in pages paint a skeleton, then their heading once the
    // client-side read lands, after the network went idle. Give the heading a
    // moment before counting it, or the count measures the skeleton.
    await page.waitForSelector('h1', { timeout: 3_000 }).catch(() => {});
    const probe = await page.evaluate(() => {
      const text = document.body?.innerText ?? '';
      const links = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
      return {
        h1: document.querySelectorAll('h1').length,
        title: document.title,
        overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        text,
        links,
      };
    });
    row.h1 = probe.h1;
    row.title = probe.title;
    row.overflow = probe.overflow;
    row.smells = [];
    for (const [re, name] of SMELLS) {
      const m = probe.text.match(re);
      if (m) row.smells.push(`${name}: ${(m[1] ?? m[0]).slice(0, 80)}`);
    }
    row.links = [...new Set(probe.links
      .filter((h) => h && (h.startsWith('/') || h.startsWith(origin)) && !h.startsWith('//'))
      .map((h) => (h.startsWith(origin) ? h.slice(origin.length) : h).split('#')[0])
      .filter(Boolean))];
    if (interact && !row.error) row.interactions = await clickThrough(page, path, { pageErrors, consoleErrors, badRequests });
  } catch (e) {
    row.error = String(e.message).split('\n')[0].slice(0, 300);
  }
  row.pageErrors = pageErrors;
  row.consoleErrors = consoleErrors;
  row.badRequests = [...new Set(badRequests)];
  const clean = !row.error && row.status != null && row.status < 400
    && !pageErrors.length && !consoleErrors.length && !row.badRequests.length
    && !(row.smells?.length) && !(row.overflow > 1) && !(row.interactions?.failed.length);
  row.verdict = clean ? 'PASS' : 'CHECK';
  await page.close();
  return row;
}

const paths = await loadPaths();
writeFileSync(out, '');
// A host whose preinstalled Chromium does not match this Playwright build
// (a cloud sandbox, say) points at it with PAGE_AUDIT_CHROMIUM.
const browser = await chromium.launch(process.env.PAGE_AUDIT_CHROMIUM ? { executablePath: process.env.PAGE_AUDIT_CHROMIUM } : {});
const context = await browser.newContext({
  storageState: storage,
  locale,
  viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
  isMobile: mobile,
  hasTouch: mobile,
});
let next = 0;
let done = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < paths.length) {
    const path = paths[next++];
    const row = await auditOne(context, path);
    appendFileSync(out, JSON.stringify(row) + '\n');
    done += 1;
    if (row.verdict !== 'PASS') console.log(`${row.verdict} ${path} ${row.status ?? row.error ?? ''}`);
    if (done % 50 === 0) console.log(`… ${done}/${paths.length}`);
  }
}));
await browser.close();
console.log(`done ${done} pages → ${out}`);
