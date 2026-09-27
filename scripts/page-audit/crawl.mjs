// Page audit crawler — the production half of the page audit in finalaudit.md.
//
//   node scripts/page-audit/crawl.mjs <paths.txt> <out.jsonl> [concurrency]
//
// Opens each path on BASE (default https://www.bubaly.com) at phone (375x812)
// and desktop (1280x800) widths, signed out, and records per visit: status,
// redirect chain, final URL, title/description/canonical/robots, h1s, console
// and uncaught errors, failed or 4xx/5xx subresources, horizontal overflow,
// every link on the page, and axe WCAG 2.1 A/AA serious+critical violations.
// GET navigation only: nothing is clicked and no form is submitted.
//
// `node scripts/page-audit/routes.mjs > paths.txt` lists every app/**/page.tsx
// route with dynamic segments filled by an id that matches nothing.
// Summarise with `python3 scripts/page-audit/summarize.py out.jsonl`.
//
// Env: BASE, VIEWPORTS=phone,desktop, NO_AXE=1, APPEND=1, STORAGE_STATE (a
// Playwright storage-state file, for a signed-in crawl of a local stack),
// PW_CHROMIUM_PATH (a system Chromium), CHROMIUM_ARGS (space-separated extra
// launch flags, e.g. a proxy CA pin in a sandbox).
import { createRequire } from 'node:module';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const BASE = process.env.BASE ?? 'https://www.bubaly.com';
const [, , listFile, outFile, conc = '4'] = process.argv;
const paths = readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const VIEWPORTS = (process.env.VIEWPORTS ?? 'phone,desktop').split(',');
const SIZES = { phone: { width: 375, height: 812, isMobile: true, hasTouch: true }, desktop: { width: 1280, height: 800 } };
if (!process.env.APPEND) writeFileSync(outFile, '');

const browser = await chromium.launch({
  ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
  args: (process.env.CHROMIUM_ARGS ?? '').split(' ').filter(Boolean),
});
const queue = [];
for (const p of paths) for (const v of VIEWPORTS) queue.push({ path: p, vp: v });

async function audit({ path, vp }) {
  const sz = SIZES[vp];
  const ctx = await browser.newContext({
    viewport: { width: sz.width, height: sz.height }, isMobile: !!sz.isMobile, hasTouch: !!sz.hasTouch, ignoreHTTPSErrors: false,
    // A signed-in crawl (of a LOCAL stack): a Playwright storage state file.
    ...(process.env.STORAGE_STATE ? { storageState: process.env.STORAGE_STATE } : {}),
  });
  const page = await ctx.newPage();
  const consoleErrors = [], pageErrors = [], failed = [], badResponses = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => pageErrors.push(String(e.message ?? e).slice(0, 300)));
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText ?? '';
    if (/ERR_ABORTED/.test(f)) return; // navigation-cancelled prefetches
    failed.push(`${r.method()} ${r.url().slice(0, 160)} ${f}`);
  });
  page.on('response', (r) => {
    const u = r.url();
    if (r.status() >= 400 && u !== BASE + path) badResponses.push(`${r.status()} ${r.request().method()} ${u.slice(0, 160)}`);
  });
  const rec = { path, vp, at: new Date().toISOString() };
  const t0 = Date.now();
  try {
    const resp = await page.goto(BASE + path, { waitUntil: 'load', timeout: 45000 });
    rec.status = resp?.status() ?? null;
    const chain = [];
    let req = resp?.request().redirectedFrom();
    while (req) { chain.unshift(req.url().replace(BASE, '')); req = req.redirectedFrom(); }
    rec.redirects = chain;
    rec.final = page.url().replace(BASE, '');
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { rec.networkidleTimeout = true; });
    rec.ms = Date.now() - t0;
    Object.assign(rec, await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const vw = window.innerWidth;
      const over = [];
      if (document.documentElement.scrollWidth > vw + 1) {
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.right > vw + 1 && r.width > 0 && getComputedStyle(el).position !== 'fixed') {
            over.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').slice(0, 3).join('.') : ''} right=${Math.round(r.right)}`);
            if (over.length >= 3) break;
          }
        }
      }
      const links = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter(Boolean);
      const bodyText = document.body?.innerText ?? '';
      return {
        title: document.title,
        description: q('meta[name="description"]')?.getAttribute('content') ?? null,
        canonical: q('link[rel="canonical"]')?.getAttribute('href') ?? null,
        robots: q('meta[name="robots"]')?.getAttribute('content') ?? null,
        h1: [...document.querySelectorAll('h1')].map((h) => h.innerText.trim().slice(0, 80)),
        lang: document.documentElement.lang,
        scrollWidth: document.documentElement.scrollWidth, innerWidth: vw,
        overflow: over,
        links: [...new Set(links)],
        textLen: bodyText.length,
        errorText: /something went wrong|application error|unexpected error|500|this page could not be found|404/i.test(bodyText.slice(0, 2000)) ? bodyText.slice(0, 200) : null,
        rawKeys: (bodyText.match(/\b[a-z][a-zA-Z0-9]+\.[a-z][a-zA-Z0-9]{3,}(?:\.[a-zA-Z0-9]+)*\b/g) ?? []).filter((k) => !/\.(com|org|net|io|ai|app|js|ts|css|png|jpg|svg|html|co|uk|de|fr|es|it|nl|pt)$/i.test(k)).slice(0, 10),
      };
    }));
    if (!process.env.NO_AXE) {
      await page.addScriptTag({ content: AXE });
      rec.axe = await page.evaluate(async () => {
        const r = await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
        return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }));
      }).catch((e) => [{ id: 'axe-failed', impact: 'n/a', n: 0, sample: String(e).slice(0, 120) }]);
    }
  } catch (e) {
    rec.error = String(e.message ?? e).slice(0, 300);
    rec.ms = Date.now() - t0;
  }
  rec.consoleErrors = consoleErrors; rec.pageErrors = pageErrors; rec.failed = failed; rec.badResponses = badResponses;
  await ctx.close();
  appendFileSync(outFile, JSON.stringify(rec) + '\n');
}

let done = 0;
async function worker() {
  while (queue.length) {
    const item = queue.shift();
    await audit(item);
    done++;
    if (done % 25 === 0) console.error(`${done} done, ${queue.length} left`);
  }
}
await Promise.all(Array.from({ length: Number(conc) }, worker));
await browser.close();
console.error('finished', done);
