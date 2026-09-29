#!/usr/bin/env node
// Workflow audit — drives each UI-FLOW workflow's main pages in a real browser,
// signed in as a parent, against a LOCAL build and a LOCAL Supabase only.
//
// For every route it records what a person would meet: a page error, a console
// error, raw error text or an untranslated key on screen. Where the page has a
// primary "Add / New / Create" control, it opens it, fills the form with a
// unique token, submits, reloads, and reports whether the token is still there
// (the write persisted) or an error was shown.
//
//   node scripts/workflow-audit.mjs --base http://localhost:3107 --state parent.json --out wf.json [--only UI-WF-008]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
const base = arg('base', 'http://localhost:3107');
const state = arg('state', 'page-audit-parent.json');
const out = arg('out', 'workflow-audit.json');
const only = arg('only', null);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(base)) {
  console.error(`Refusing: --base (${base}) is not a local server.`);
  process.exit(1);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')) {
  console.error('Refusing: NEXT_PUBLIC_SUPABASE_URL is not a local Supabase.');
  process.exit(1);
}

export const WORKFLOWS = {
  'UI-WF-002': ['/dashboard/setup', '/family/members', '/family/settings'],
  'UI-WF-003': ['/services', '/dashboard/search?q=milk', '/capture'],
  'UI-WF-004': ['/dashboard', '/dashboard?view=family', '/dashboard/knowledge', '/dashboard/decisions', '/dashboard/intelligence'],
  'UI-WF-005': ['/dashboard/assistant', '/dashboard/concierge', '/dashboard/concierge/runs'],
  'UI-WF-006': ['/dashboard/calendar', '/dashboard/conflicts', '/dashboard/timetable', '/dashboard/rides', '/dashboard/signups'],
  'UI-WF-007': ['/dashboard/todos', '/dashboard/chores', '/missions', '/dashboard/rewards', '/dashboard/behavior', '/dashboard/habits'],
  'UI-WF-008': ['/dashboard/grocery', '/dashboard/kitchen', '/dashboard/meals', '/dashboard/recipes', '/dashboard/pantry', '/dashboard/nutrition'],
  'UI-WF-009': ['/family/members', '/family/permissions', '/family/reports', '/dashboard/care', '/dashboard/family-access'],
  'UI-WF-010': ['/dashboard/trust', '/dashboard/security', '/dashboard/family-emergency'],
  'UI-WF-011': ['/dashboard/messages', '/dashboard/announcements', '/dashboard/contact-center', '/dashboard/inbox', '/dashboard/contacts'],
  'UI-WF-012': ['/guardian', '/guardian/contacts', '/guardian/rules', '/guardian/history', '/guardian/settings'],
  'UI-WF-013': ['/dashboard/bills', '/dashboard/budgets', '/dashboard/savings', '/dashboard/subscriptions', '/dashboard/expenses'],
  'UI-WF-014': ['/wallet', '/wallet/cards', '/wallet/activity', '/wallet/allowance', '/wallet/gift', '/wallet/goals'],
  'UI-WF-015': ['/dashboard/billing', '/dashboard/settings'],
  'UI-WF-016': ['/dashboard/files/vault', '/dashboard/documents', '/dashboard/binder', '/dashboard/paperwork', '/capture'],
  'UI-WF-017': ['/dashboard/health', '/dashboard/medical', '/dashboard/dental', '/dashboard/medications', '/dashboard/sleep'],
  'UI-WF-018': ['/dashboard/home', '/dashboard/home/maintenance', '/dashboard/home/service', '/dashboard/home/pros', '/dashboard/home/warranties', '/dashboard/moving'],
  'UI-WF-019': ['/dashboard/auto', '/dashboard/auto/vehicles', '/dashboard/auto/insurance', '/dashboard/auto/service', '/dashboard/auto/licenses', '/dashboard/auto/rentals', '/dashboard/auto/accident'],
  'UI-WF-020': ['/dashboard/vacations', '/dashboard/vacations/new', '/dashboard/trips'],
  'UI-WF-021': ['/dashboard/goals', '/dashboard/pets', '/dashboard/school', '/dashboard/sports', '/dashboard/celebrations', '/dashboard/journal'],
  'UI-WF-022': ['/dashboard/social', '/dashboard/social/content-studio', '/dashboard/social/calendar', '/dashboard/social/feed', '/dashboard/social/analytics'],
  'UI-WF-023': ['/dashboard/sync', '/dashboard/sync/accounts', '/dashboard/sync/history', '/dashboard/sync/conflicts'],
  'UI-WF-024': ['/display/setup'],
  'UI-WF-025': ['/feedback', '/referrals', '/marketplace/reviews'],
  'UI-WF-026': ['/marketplace', '/marketplace/browse', '/marketplace/store', '/marketplace/selling', '/marketplace/saved'],
  'UI-WF-030': ['/dashboard/profile', '/dashboard/settings', '/family/settings'],
};

const RAW_ERROR = /(violates (row-level|foreign key|check|not-null)|PGRST\d+|duplicate key value|TypeError:|ReferenceError:|\[object Object\]|\bNaN\b|undefined is not|Cannot read properties|invalid input syntax|permission denied for)/;
const RAW_KEY = /\b[a-z][a-zA-Z]+\.[a-z][a-zA-Z0-9]{3,}\b/g;
const CREATE = /^\s*(\+\s*)?(add|new|create|log|track|record)\b/i;
const SUBMIT = /^(save|add|create|submit|log|record|done|continue|next)\b/i;

async function probe(page, route, token) {
  const r = { route, errors: [], console: [], raw: [], keys: [], create: 'none' };
  const onErr = (e) => r.errors.push(String(e.message ?? e).slice(0, 200));
  const onCon = (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR_ABORTED|hydrat/i.test(m.text())) r.console.push(m.text().slice(0, 200)); };
  page.on('pageerror', onErr); page.on('console', onCon);
  try {
    const res = await page.goto(base + route, { waitUntil: 'networkidle', timeout: 45_000 });
    r.status = res?.status() ?? 0;
    r.final = new URL(page.url()).pathname;
    const text = await page.locator('main').first().innerText({ timeout: 5_000 }).catch(() => page.locator('body').innerText());
    const raw = text.match(RAW_ERROR); if (raw) r.raw.push(raw[0]);
    r.keys = [...new Set((text.match(RAW_KEY) ?? []).filter((k) => !/\.(com|org|net|io|app|test|ics|pdf|png|jpg|json|ts|js|md)$/i.test(k) && !/^e\.g$/i.test(k)))].slice(0, 5);
    const buttons = page.locator('main button:visible, main a[role=button]:visible');
    const n = await buttons.count();
    let opener = null;
    for (let i = 0; i < n; i += 1) {
      const b = buttons.nth(i);
      const label = ((await b.innerText().catch(() => '')) || (await b.getAttribute('aria-label')) || '').trim();
      if (CREATE.test(label) && !(await b.isDisabled())) { opener = b; r.opener = label.slice(0, 40); break; }
    }
    if (opener) {
      await opener.click({ timeout: 5_000 });
      await page.waitForTimeout(700);
      const scope = page.locator('[role=dialog]:visible').last();
      const root = (await scope.count()) ? scope : page.locator('main');
      const text1 = root.locator('input[type=text]:visible, input:not([type]):visible, textarea:visible').first();
      if (await text1.count()) {
        await text1.fill(token);
        for (const d of await root.locator('input[type=date]:visible').all()) if (!(await d.inputValue())) await d.fill('2026-12-01');
        for (const t of await root.locator('input[type=datetime-local]:visible').all()) if (!(await t.inputValue())) await t.fill('2026-12-01T10:00');
        for (const num of await root.locator('input[type=number]:visible').all()) if (!(await num.inputValue())) await num.fill('12');
        const sub = root.locator('button[type=submit]:visible').last();
        let submitted = false;
        if (await sub.count()) { await sub.click({ timeout: 5_000 }).catch(() => {}); submitted = true; }
        else {
          const all = root.locator('button:visible'); const m = await all.count();
          for (let i = m - 1; i >= 0; i -= 1) { const lb = (await all.nth(i).innerText().catch(() => '')).trim(); if (SUBMIT.test(lb)) { await all.nth(i).click().catch(() => {}); submitted = true; break; } }
        }
        if (!submitted) r.create = 'no-submit';
        else {
          await page.waitForTimeout(1_500);
          const alerts = await page.locator('[role=alert]:visible, [data-sonner-toast][data-type=error]:visible').allInnerTexts().catch(() => []);
          r.alerts = alerts.map((a) => a.slice(0, 160)).filter(Boolean);
          await page.reload({ waitUntil: 'networkidle' });
          const after = await page.locator('body').innerText();
          r.create = after.includes(token) ? 'persisted' : (r.alerts.length ? 'refused' : 'not-visible');
        }
      } else r.create = 'no-text-field';
    }
  } catch (e) { r.errors.push(`probe: ${String(e.message ?? e).slice(0, 160)}`); }
  page.off('pageerror', onErr); page.off('console', onCon);
  return r;
}

const browser = await chromium.launch(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
const ctx = await browser.newContext({ storageState: JSON.parse(readFileSync(state, 'utf8')), viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const results = {};
let k = 0;
for (const [wf, routes] of Object.entries(WORKFLOWS)) {
  if (only && wf !== only) continue;
  results[wf] = [];
  for (const route of routes) {
    k += 1;
    const r = await probe(page, route, `WF${k}-${Date.now().toString(36)}`);
    results[wf].push(r);
    const flag = [r.errors.length && 'ERR', r.console.length && 'CON', r.raw.length && 'RAW', r.keys.length && 'KEY'].filter(Boolean).join(',') || 'ok';
    console.log(`${wf} ${route} -> ${r.status} ${r.final} [${flag}] create=${r.create}${r.opener ? ` (${r.opener})` : ''}${r.alerts?.length ? ` alerts=${JSON.stringify(r.alerts)}` : ''}${r.keys.length ? ` keys=${r.keys}` : ''}${r.raw.length ? ` raw=${r.raw}` : ''}${r.errors.length ? ` errors=${JSON.stringify(r.errors)}` : ''}`);
  }
}
writeFileSync(out, JSON.stringify(results, null, 2));
await browser.close();
