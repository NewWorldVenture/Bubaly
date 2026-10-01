// B14 companion to scripts/axe-audit.mjs (which is unchanged): for each route it
// records what actually rendered, and exercises every overlay it can open
// without mutating data, by keyboard only.
// Usage: node b14-verify.mjs <base> <paths.txt> <state.json> <width> <out.jsonl> <expect.json>
// expect.json: { "<path>": ["text the seeded record must show", ...], "redact": ["names"] }
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const [base, pathsFile, state, width, out, expectFile] = process.argv.slice(2);
const paths = readFileSync(pathsFile, 'utf8').split('\n').filter(Boolean);
const expect = JSON.parse(readFileSync(expectFile, 'utf8'));
const redact = s => (expect.redact ?? []).reduce((t, n) => t.split(n).join('<name>'), s ?? '')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');
const MUTATING = /delete|remove|approve|reject|submit|save|follow|unfollow|buy|sign ?out|log ?out|send|pay|confirm|mark|complete|claim|redeem|bid|offer|archive|accept|decline|upload|publish|post|refund|suspend|ban|reset|revoke|invite|create|add|new|start|stop|run|sync|generate|report|block|mute|like|react|vote|join|leave|transfer|withdraw|deposit/i;
const OVERLAY = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';

const browser = await chromium.launch({ executablePath: process.env.PAGE_AUDIT_CHROMIUM || undefined });
const context = await browser.newContext({ storageState: state, viewport: { width: Number(width), height: 900 } });
writeFileSync(out, '');
for (const path of paths) {
  const page = await context.newPage();
  const row = { path: redact(path), width: Number(width) };
  try {
    const res = await page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(500);
    row.status = res?.status();
    row.finalPath = redact(new URL(page.url()).pathname);
    row.redirected = new URL(page.url()).pathname !== path;
    row.h1 = redact((await page.locator('h1').first().innerText().catch(() => '')).trim().slice(0, 80));
    const main = await page.locator('main').first().innerText().catch(() => '');
    row.mainTextLength = main.length;
    row.notFound = /We couldn.t find that|page could not be found|404/i.test(main);
    row.errorBoundary = /something went wrong|couldn.t load|try again/i.test(row.h1);
    const want = expect[path] ?? [];
    row.seededRecordShown = want.length ? want.every(t => main.includes(t)) : null;
    // Overlays: triggers that declare a popup, plus buttons that open one when
    // activated; names that suggest a data change are never activated.
    const triggers = await page.evaluate(({ MUTATING_SRC }) => {
      const mut = new RegExp(MUTATING_SRC, 'i');
      const seen = new Set(); const list = [];
      for (const el of document.querySelectorAll('button, [role="button"], [aria-haspopup]')) {
        const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
        if (el.closest('[aria-hidden="true"], [inert]') || el.disabled || el.getAttribute('type') === 'submit') continue;
        const name = (el.getAttribute('aria-label') || el.innerText || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        if (!name || mut.test(name)) continue;
        const scope = el.closest('main') ? 'page' : 'shell';
        const key = scope + '|' + name; if (seen.has(key)) continue; seen.add(key);
        el.setAttribute('data-b14-trigger', String(list.length));
        list.push({ i: list.length, name, scope, haspopup: el.getAttribute('aria-haspopup'), expanded: el.getAttribute('aria-expanded') });
      }
      return list.slice(0, 40);
    }, { MUTATING_SRC: MUTATING.source });
    row.overlays = [];
    for (const t of triggers) {
      const trigger = page.locator(`[data-b14-trigger="${t.i}"]`);
      if (!(await trigger.isVisible().catch(() => false))) continue;
      const before = await page.locator(OVERLAY).count();
      const url0 = page.url();
      await trigger.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(450);
      if (page.url() !== url0) { await page.goBack().catch(() => {}); await page.waitForTimeout(600); break; }
      const opened = page.locator(`${OVERLAY}`).filter({ visible: true });
      if ((await opened.count()) <= before) continue; // not an overlay trigger
      const o = opened.last();
      const kind = await o.getAttribute('role');
      const modal = (await o.getAttribute('aria-modal')) === 'true' || kind === 'alertdialog';
      const focusInside = await o.evaluate(n => n.contains(document.activeElement));
      let trapped = null;
      if (modal) {
        trapped = true;
        for (let k = 0; k < 12; k++) { await page.keyboard.press('Tab'); if (!(await o.evaluate(n => n.contains(document.activeElement)).catch(() => false))) { trapped = false; break; } }
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const closed = !(await o.isVisible().catch(() => false));
      const focusReturned = await page.evaluate(i => document.activeElement?.getAttribute('data-b14-trigger') === String(i), t.i);
      row.overlays.push({ trigger: redact(t.name), scope: t.scope, haspopup: t.haspopup, kind, modal, openedByEnter: true, focusInside, tabTrapped: trapped, escapeCloses: closed, focusReturned });
      if (!closed) { await page.keyboard.press('Escape'); await page.mouse.click(2, 2).catch(() => {}); }
    }
  } catch (error) { row.error = redact(String(error).split('\n')[0].slice(0, 160)); }
  appendFileSync(out, JSON.stringify(row) + '\n');
  await page.close();
}
await browser.close();
