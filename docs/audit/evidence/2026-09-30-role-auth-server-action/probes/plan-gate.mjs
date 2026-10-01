// Integrated retest for MAIN-F16/F17/F18/F15: a family below a feature's plan is
// refused by the page (redirect to the plan) and by the endpoint behind it.
import { chromium } from '/home/user/Bubaly/node_modules/playwright/index.mjs';
import { execFileSync } from 'node:child_process';
const BASE = 'http://127.0.0.1:3107';
const FAM = '0dd41445-fc5f-4a45-b8dd-5bdf7daa99d9';
const psql = (sql) => execFileSync('docker', ['exec', '-i', 'supabase_db_bubaly', 'psql', '-U', 'postgres', '-d', 'postgres', '-Atc', sql]).toString().trim();
const TRIAL = psql(`select trial_ends_at from families where id='${FAM}'`);
const setPlan = (p) => { psql(`update families set trial_ends_at=${p === 'free' ? 'null' : `'${TRIAL}'`} where id='${FAM}'`); return psql(`update subscriptions set plan='${p}' where family_id='${FAM}' returning plan`); };
const PAGES = { '/dashboard/autopilot': 2, '/missions': 2, '/dashboard/home': 2, '/dashboard/weekend': 1 };
const APIS = [['/api/autopilot/scan', 2], ['/api/ai/home/diagnose', 2], ['/api/weekend/discover', 1]];
const browser = await chromium.launch({ executablePath: process.env.PAGE_AUDIT_CHROMIUM });
const ctx = await browser.newContext({ storageState: process.argv[2] });
const page = await ctx.newPage();
const out = [];
try {
  for (const plan of ['free', 'basic', 'plus']) {
    setPlan(plan);
    const level = { free: 0, basic: 1, plus: 2 }[plan];
    for (const [path, need] of Object.entries(PAGES)) {
      const resp = await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(/\/dashboard\/billing/, { timeout: 8_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
      const u = new URL(page.url());
      const gated = u.pathname === '/dashboard/billing' && u.searchParams.get('upgrade') === '1';
      const expectGate = level < need;
      out.push({ plan, kind: 'page', path, firstStatus: resp?.status(), landed: u.pathname + u.search, need: u.searchParams.get('need'), ok: gated === expectGate && (!gated || Number(u.searchParams.get('need')) === need) });
    }
    for (const [path, need] of APIS) {
      const r = await page.request.post(BASE + path, { data: path.includes('weekend') ? { zip: '94110' } : path.includes('diagnose') ? { problem: 'The kitchen sink drains slowly.' } : {}, headers: { origin: BASE } });
      let body = ''; try { body = (await r.text()).slice(0, 160); } catch {}
      const refused = r.status() === 403;
      const expectRefuse = level < need;
      out.push({ plan, kind: 'api', path, status: r.status(), body, ok: expectRefuse ? refused : !refused });
    }
  }
} finally {
  setPlan('plus');
  await browser.close();
}
for (const o of out) console.log(JSON.stringify(o));
console.log('ALL OK:', out.every((o) => o.ok), `${out.filter((o) => o.ok).length}/${out.length}`);
