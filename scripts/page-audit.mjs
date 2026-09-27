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
//   submissions   with --submit (batch B6b): every form in <main>, and every
//                 form a dialog opens when an "Add / New / Create …" button
//                 in <main> is clicked (up to 6 openers), is filled with valid
//                 synthetic values (only fields that are empty) and submitted
//                 by its own submit button — never one labelled like a delete,
//                 payment, send or publish. Each submit records what it did:
//                 an uncaught error, a console error, a failed or >= 400
//                 request, an error boundary, an error toast or alert
//                 ("error"); fields the browser refused ("invalid", with their
//                 names — a gap in the filler, not the page); or nothing wrong
//                 ("ok", with any success message). Local stack only.
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
const submit = flag('submit');
if ((interact || submit) && /bubaly\.com$/.test(new URL(base).hostname)) {
  console.error('--interact and --submit write data; point them at a local stack, not production');
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

// --submit (B6b). The buttons that open a form, and the synthetic values a
// form is filled with. Only empty fields are filled, so a form's own defaults
// (a pre-selected member, today's date) stay what a person would submit.
const OPENERS = /^(\+\s*)?(add|new|create|log|record|plan|schedule|track|start|write|upload|set ?up)\b/i;
const FAILURE_TEXT = /could ?n[o']t|couldn’t|failed|went wrong|unable to|error|not allowed|try again|refresh and/i;

async function fillAndSubmit(page, formSel) {
  const plan = await page.evaluate(([sel, never]) => {
    const form = document.querySelector(sel);
    if (!form) return { skipped: 'gone' };
    const tomorrow = new Date(Date.now() + 86_400_000);
    const ymd = tomorrow.toISOString().slice(0, 10);
    const setValue = (el, value) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    let n = 0;
    const filled = [];
    for (const el of form.querySelectorAll('input,select,textarea')) {
      if (el.disabled || el.readOnly || !visible(el)) continue;
      const name = el.name || el.id || el.getAttribute('aria-label') || el.type;
      if (el instanceof HTMLSelectElement) {
        if (!el.value) { const o = [...el.options].find((x) => x.value && !x.disabled); if (o) { setValue(el, o.value); filled.push(name); } }
        continue;
      }
      if (el.value) continue;
      const t = (el.type || 'text').toLowerCase();
      n += 1;
      const v = t === 'email' ? `audit+${n}@local.test`
        : t === 'tel' ? '+15555550123'
        : t === 'url' ? 'https://example.com'
        : t === 'number' || t === 'range' ? String(el.min && Number(el.min) > 0 ? el.min : 1)
        : t === 'date' ? ymd
        : t === 'datetime-local' ? `${ymd}T${/end|until|to$|finish/i.test(name) ? '11' : '10'}:00`
        : t === 'time' ? (/end|until|to$|finish/i.test(name) ? '11:00' : '10:00')
        : t === 'month' ? ymd.slice(0, 7)
        : t === 'password' ? 'Audit-pass-1234!'
        : ['checkbox', 'radio', 'file', 'hidden', 'submit', 'button', 'image', 'reset', 'color', 'week'].includes(t) ? null
        : el instanceof HTMLTextAreaElement ? 'Audit note, safe to delete.'
        : `Audit ${n}`;
      if (v === null) {
        if (t === 'radio' && el.required && !form.querySelector(`input[type=radio][name="${el.name}"]:checked`)) { el.click(); filled.push(name); }
        continue;
      }
      setValue(el, v);
      filled.push(name);
    }
    const buttons = [...form.querySelectorAll('button,input[type=submit]')].filter((b) => visible(b) && !b.disabled
      && (b.type === 'submit' || (b.tagName === 'BUTTON' && !b.getAttribute('type'))));
    const btn = buttons[buttons.length - 1];
    if (!btn) return { skipped: 'no submit button', filled };
    const label = (btn.getAttribute('aria-label') || btn.textContent || btn.value || '').replace(/\s+/g, ' ').trim();
    if (new RegExp(never, 'i').test(label)) return { skipped: `submit is "${label.slice(0, 40)}"`, filled };
    // Checked BEFORE the click: a form that saved resets, and its required
    // fields then read as :invalid, which would look like a refusal.
    const invalid = [...form.querySelectorAll(':invalid')].filter((el) => el.matches('input,select,textarea'))
      .map((el) => el.name || el.id || el.getAttribute('aria-label') || el.type);
    if (invalid.length) return { label: label.slice(0, 60), filled, invalid, skipped: undefined, blocked: true };
    for (const el of document.querySelectorAll('[data-audit-submit]')) el.removeAttribute('data-audit-submit');
    btn.setAttribute('data-audit-submit', '1');
    return { label: label.slice(0, 60), filled };
  }, [formSel, NEVER.source]);
  if (plan.skipped || plan.blocked) return plan;
  // A sticky bar or an open popover can cover the button; submitting the form
  // through it is what a keyboard user's Enter does, so fall back to that.
  await page.locator('[data-audit-submit="1"]').click({ timeout: 3_000 }).catch(async () => {
    plan.via_requestSubmit = true;
    await page.evaluate(() => { const b = document.querySelector('[data-audit-submit="1"]'); b?.form?.requestSubmit(b); })
      .catch((e) => { plan.clickError = String(e.message).split('\n')[0].slice(0, 120); });
  });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(700);
  const after = await page.evaluate((sel) => {
    const form = document.querySelector(sel);
    const messages = [...document.querySelectorAll('[role="alert"],[role="status"]')]
      .map((el) => ({ role: el.getAttribute('role'), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) }))
      .filter((m) => m.text);
    const boundary = /Something went wrong|This page hit a snag|Application error/i.test(document.body?.innerText ?? '');
    return { messages, boundary, formStillThere: !!form };
  }, formSel);
  return { ...plan, ...after };
}

async function submitForms(page, path, seen) {
  const results = [];
  const snapshot = () => [seen.pageErrors.length, seen.consoleErrors.length, seen.badRequests.length];
  const judge = (r, before) => {
    r.threw = seen.pageErrors.slice(before[0]);
    r.logged = seen.consoleErrors.slice(before[1]);
    r.requests = seen.badRequests.slice(before[2]);
    const alerts = (r.messages ?? []).filter((m) => m.role === 'alert' && FAILURE_TEXT.test(m.text));
    r.outcome = r.skipped ? 'skipped'
      : (r.boundary || r.threw.length || r.logged.length || r.requests.length || alerts.length || r.clickError) ? 'error'
      : r.invalid?.length ? 'invalid' : 'ok';
    return r;
  };
  // Forms already on the page.
  const onPage = await page.evaluate(() => {
    const main = document.querySelector('main') ?? document.body;
    let i = 0;
    for (const f of main.querySelectorAll('form')) {
      const r = f.getBoundingClientRect();
      if (!r.width || !r.height || f.closest('nav,header,footer,[data-sidebar],[role="search"]')) continue;
      f.setAttribute('data-audit-form', `p${i++}`);
    }
    return i;
  });
  for (let i = 0; i < Math.min(onPage, 6); i++) {
    const before = snapshot();
    const r = await fillAndSubmit(page, `[data-audit-form="p${i}"]`);
    results.push(judge({ via: `form ${i + 1} on the page`, ...r }, before));
    await page.goto(base + path, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
    await page.evaluate(() => { const main = document.querySelector('main') ?? document.body; let j = 0;
      for (const f of main.querySelectorAll('form')) { const r = f.getBoundingClientRect(); if (!r.width || !r.height || f.closest('nav,header,footer,[data-sidebar],[role="search"]')) continue; f.setAttribute('data-audit-form', `p${j++}`); } });
  }
  // Forms a dialog opens.
  const openers = await page.evaluate(([openers, never]) => {
    const main = document.querySelector('main') ?? document.body;
    const labels = [];
    for (const el of main.querySelectorAll('button,a[role="button"]')) {
      const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || el.disabled || el.closest('form,nav,header,footer,[data-sidebar]')) continue;
      if (!new RegExp(openers, 'i').test(label) || new RegExp(never, 'i').test(label)) continue;
      if (!labels.includes(label)) labels.push(label);
    }
    return labels.slice(0, 6);
  }, [OPENERS.source, NEVER.source]);
  for (const label of openers) {
    const before = snapshot();
    const opener = page.locator('main button, main a[role="button"]').filter({ hasText: label }).first();
    const alt = page.locator(`main [aria-label="${label.replace(/"/g, '\\"')}"]`).first();
    const target = (await opener.count()) ? opener : alt;
    try { await target.click({ timeout: 3_000 }); } catch { continue; }
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    const here = new URL(page.url()).pathname;
    const found = await page.evaluate(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].pop();
      const scope = dialog ?? document.querySelector('main') ?? document.body;
      const form = [...scope.querySelectorAll('form')].find((f) => f.getBoundingClientRect().height > 0 && !f.hasAttribute('data-audit-form'));
      if (!form) return false;
      form.setAttribute('data-audit-form', 'd');
      return true;
    });
    if (!found) {
      if (here !== path) await page.goto(base + path, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
      else await page.keyboard.press('Escape').catch(() => {});
      continue;
    }
    const r = await fillAndSubmit(page, '[data-audit-form="d"]');
    results.push(judge({ via: `"${label.slice(0, 40)}"${here !== path ? ` → ${here}` : ''}`, ...r }, before));
    await page.goto(base + path, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
  }
  return results;
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
    if (submit && !row.error) row.submissions = await submitForms(page, path, { pageErrors, consoleErrors, badRequests });
  } catch (e) {
    row.error = String(e.message).split('\n')[0].slice(0, 300);
  }
  row.pageErrors = pageErrors;
  row.consoleErrors = consoleErrors;
  row.badRequests = [...new Set(badRequests)];
  const clean = !row.error && row.status != null && row.status < 400
    && !pageErrors.length && !consoleErrors.length && !row.badRequests.length
    && !(row.smells?.length) && !(row.overflow > 1) && !(row.interactions?.failed.length)
    && !(row.submissions?.some((r) => r.outcome === 'error'));
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
