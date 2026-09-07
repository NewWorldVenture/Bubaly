// scripts/cron-dispatch.mjs — GitHub Actions cron dispatcher for the app's
// /api/cron/* routes.
//
// WHY: Vercel's Hobby plan only allows cron jobs that run once per day and
// fails the whole deployment when vercel.json schedules anything more
// frequent ("Hobby accounts are limited to daily cron jobs"). vercel.json now
// carries daily-safe schedules so production deploys on any plan; the real
// cadences live here and are driven by .github/workflows/cron-dispatch.yml,
// which ticks every five minutes and calls every route whose schedule fell
// due since the previous tick. The routes are idempotent and CRON_SECRET-gated
// (lib/server/cron-auth.ts), so a Vercel daily run and a GitHub run of the
// same route never conflict.
//
// On Vercel Pro the original per-minute schedules can go back into
// vercel.json (copy SCHEDULES below) and this workflow can be disabled.
//
// Usage (CI): CRON_SECRET=… CRON_BASE_URL=https://www.bubaly.com node scripts/cron-dispatch.mjs
// Dry run:    node scripts/cron-dispatch.mjs --dry-run --at 2026-09-05T03:05:00Z
// Exports are pure so tests/cron-dispatch.test.ts can pin the matcher and the table.

/** Route → real cadence (5-field cron, UTC). Keep in sync with the comment block in vercel.json. */
export const SCHEDULES = {
  '/api/cron/feedback-github-sync': '15 * * * *',
  '/api/cron/chore-reminders': '0 18 * * 0',
  '/api/cron/weekly-digest': '0 8 * * 1',
  '/api/cron/notifications': '0 11 * * *',
  '/api/cron/push-scan': '0 */2 * * *',
  '/api/cron/calendar-feeds': '0 5 * * *',
  '/api/cron/automations': '0 13 * * *',
  '/api/cron/marketing': '*/5 * * * *',
  '/api/cron/marketing-providers': '15 */6 * * *',
  '/api/cron/checkout-abandoned': '0 */6 * * *',
  '/api/cron/autopilot-scan': '30 6,18 * * *',
  '/api/cron/wallet-allowance': '0 7 * * *',
  '/api/cron/model-refresh': '0 4,16 * * *',
  '/api/cron/network-aggregate': '0 3 * * *',
  '/api/cron/guardian-learning': '0 2 * * *',
  '/api/cron/provider-sync': '15 */4 * * *',
  '/api/cron/journey-recovery': '0 9,15,21 * * *',
  '/api/cron/close-auctions': '*/5 * * * *',
  '/api/cron/return-reminders': '0 8 * * *',
  '/api/cron/admin-digest': '30 12 * * *',
  // AI run continuation: the executor resumes runs parked on a time budget,
  // released by an approval, or abandoned by a dead worker. Five minutes is
  // the shortest the dispatcher ticks, and /api/cron/ai-runs boxes its own
  // work at 85 s so it never trips the dispatcher's 120 s abort.
  '/api/cron/ai-runs': '*/5 * * * *',
  // Routines fire on the family's own clock ("every Sunday at 5pm"), so the
  // worker has to be asked often enough that a 17:00 schedule fires at 17:00
  // and not at whatever hour a daily tick happens to land on. Fifteen minutes
  // is the coarsest cadence that still keeps a minute-precise schedule inside
  // its own quarter hour, and the worker files requests rather than executing
  // them, so a tick is cheap.
  '/api/cron/family-routines': '*/15 * * * *',
};

/** The workflow ticks on this cadence; a route is due if any minute in (prev tick, now] matches. */
export const TICK_MINUTES = 5;

function parseField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${field}"`);
    let lo;
    let hi;
    if (rangePart === '*') { lo = min; hi = max; }
    else if (rangePart.includes('-')) { const [a, b] = rangePart.split('-').map(Number); lo = a; hi = b; }
    else { lo = Number(rangePart); hi = stepPart ? max : lo; }
    if (![lo, hi].every((n) => Number.isInteger(n)) || lo < min || hi > max || lo > hi) throw new Error(`bad range in "${field}"`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** Parse a 5-field cron expression into matchers (minute, hour, day-of-month, month, day-of-week; 0 and 7 = Sunday). */
export function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`expected 5 fields in "${expr}"`);
  const dow = parseField(parts[4], 0, 7);
  if (dow.has(7)) dow.add(0);
  return {
    minute: parseField(parts[0], 0, 59), hour: parseField(parts[1], 0, 23), dom: parseField(parts[2], 1, 31), month: parseField(parts[3], 1, 12), dow,
    domWildcard: parts[2] === '*', dowWildcard: parts[4] === '*',
  };
}

/** Does the expression fire at this UTC minute? (Standard cron: dom/dow are OR-ed unless one is a wildcard.) */
export function matchesAt(expr, date) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const minute = date.getUTCMinutes(), hour = date.getUTCHours(), dom = date.getUTCDate(), month = date.getUTCMonth() + 1, dow = date.getUTCDay();
  if (!c.minute.has(minute) || !c.hour.has(hour) || !c.month.has(month)) return false;
  const domOk = c.dom.has(dom), dowOk = c.dow.has(dow);
  if (c.domWildcard && c.dowWildcard) return true;
  if (c.domWildcard) return dowOk;
  if (c.dowWildcard) return domOk;
  return domOk || dowOk;
}

/** Routes whose schedule fired in the window (now - tickMinutes, now], evaluated per minute. */
export function dueRoutes(now, schedules = SCHEDULES, tickMinutes = TICK_MINUTES) {
  const due = [];
  for (const [route, expr] of Object.entries(schedules)) {
    const parsed = parseCron(expr);
    for (let back = 0; back < tickMinutes; back += 1) {
      const t = new Date(now.getTime() - back * 60_000);
      t.setUTCSeconds(0, 0);
      if (matchesAt(parsed, t)) { due.push(route); break; }
    }
  }
  return due;
}

async function callRoute(baseUrl, route, secret, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetchImpl(`${baseUrl}${route}`, { headers: { Authorization: `Bearer ${secret}`, 'User-Agent': 'bubaly-cron-dispatch' }, signal: controller.signal });
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
    return { route, status: res.status, ok: res.ok, body };
  } catch (error) {
    return { route, status: 0, ok: false, body: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const atIndex = args.indexOf('--at');
  const now = atIndex >= 0 ? new Date(args[atIndex + 1]) : new Date();
  if (Number.isNaN(now.getTime())) { console.error('Invalid --at timestamp'); process.exit(2); }
  const only = args.includes('--route') ? args[args.indexOf('--route') + 1] : null;
  const routes = only ? [only] : dueRoutes(now);
  console.log(`cron-dispatch at ${now.toISOString()} (window ${TICK_MINUTES} min): ${routes.length ? routes.join(', ') : 'nothing due'}`);
  if (dryRun || routes.length === 0) return;
  const secret = process.env.CRON_SECRET;
  const baseUrl = (process.env.CRON_BASE_URL || 'https://www.bubaly.com').replace(/\/$/, '');
  if (!secret) { console.log('CRON_SECRET is not set — skipping (add it under Settings → Secrets → Actions).'); return; }
  const results = await Promise.all(routes.map((route) => callRoute(baseUrl, route, secret)));
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.status} ${r.route} ${r.body}`);
    if (!r.ok) failed += 1;
  }
  if (failed) { console.error(`${failed} of ${results.length} cron route(s) failed.`); process.exit(1); }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
