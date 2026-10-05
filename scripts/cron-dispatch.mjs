// scripts/cron-dispatch.mjs — GitHub Actions cron dispatcher for the app's
// /api/cron/* routes.
//
// WHY: Vercel's Hobby plan only allows cron jobs that run once per day and
// fails the whole deployment when vercel.json schedules anything more
// frequent ("Hobby accounts are limited to daily cron jobs"). vercel.json now
// carries daily-safe schedules so production deploys on any plan; the
// INTENDED cadences live here and are driven by
// .github/workflows/cron-dispatch.yml, which asks to tick every five minutes
// and calls every route whose schedule fell due since the previous successful
// tick — never less than the preceding five minutes (see tickWindow below).
// The routes are idempotent and CRON_SECRET-gated (lib/server/cron-auth.ts),
// so a Vercel daily run and a GitHub run of the same route never conflict.
//
// READ THE TABLE BELOW AS INTENTIONS, NOT GUARANTEES. GitHub does not deliver
// this schedule: across the workflow's first 95 runs (2026-09-05 to
// 2026-09-18, run numbers contiguous) it fired 95 times against 3,922
// requested ticks, with a minimum gap of 104 minutes and a median of 209 — so
// every route below runs at roughly 2% of the rate it names, plus whatever
// vercel.json guarantees. For the seventeen routes whose cadence here is
// sub-daily, vercel.json guarantees only a single daily firing, and the
// shortfall runs from 2x to 288x. Measured per route in
// tests/a-cron-cadence-is-a-promise-nothing-keeps.test.ts.
//
// A late tick used to LOSE every firing between the previous tick and its own
// five-minute window. Since 2026-10-03 it catches them up: the workflow passes
// the previous successful scheduled run's start as CRON_SINCE and every
// sub-daily route with a due minute in (since, now] is called once (daily
// routes are left to Vercel, which fires them on time). That recovers the
// firing, not the rate — a '*/5' route still runs once per tick however many
// of its minutes the tick covers. tests/a-late-tick-catches-up.test.ts.
//
// On Vercel Pro the original per-minute schedules can go back into
// vercel.json (copy SCHEDULES below) and this workflow can be disabled.
//
// Usage (CI): CRON_SECRET=… CRON_BASE_URL=https://www.bubaly.com CRON_SINCE=<previous tick start, ISO 8601> node scripts/cron-dispatch.mjs
// Dry run:    node scripts/cron-dispatch.mjs --dry-run --at 2026-09-05T03:05:00Z
//             CRON_SINCE=2026-09-05T00:00:00Z node scripts/cron-dispatch.mjs --dry-run --at 2026-09-05T03:05:00Z
// Exports are pure so tests/cron-dispatch.test.ts can pin the matcher, the window and the table.

import { pathToFileURL } from 'node:url';

/** Route → real cadence (5-field cron, UTC). Keep in sync with the comment block in vercel.json. */
export const SCHEDULES = {
  '/api/cron/social-publish': '*/5 * * * *',
  '/api/cron/contact-center-urgent': '*/5 * * * *',
  '/api/cron/guardian-sms-recovery': '*/5 * * * *',
  '/api/cron/feedback-github-sync': '15 * * * *',
  '/api/cron/chore-reminders': '0 18 * * 0',
  '/api/cron/weekly-digest': '0 8 * * 1',
  '/api/cron/notifications': '0 11 * * *',
  '/api/cron/push-scan': '0 */2 * * *',
  '/api/cron/calendar-feeds': '0 5 * * *',
  '/api/cron/automations': '0 13 * * *',
  // Podcasts publish on their own schedule and a family expects new episodes to
  // be there, not to have to ask for them. Six-hourly is often enough that a
  // morning show is waiting by the morning and rare enough that four requests a
  // day per feed is a courteous thing to send a publisher.
  '/api/cron/library-feeds': '0 */6 * * *',
  '/api/cron/marketing': '*/5 * * * *',
  // Recurring social ads post on local wall-clock times, so the dispatcher has
  // to tick finer than the schedules it serves: 15 minutes is the granularity
  // an operator gets when they pick "09:00".
  '/api/cron/marketing-social': '*/15 * * * *',
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
  // Shared fleet tick for fixed read-only workers, or organization-only preflight.
  // Worker dispatch requires both server execution and paid-probe approval gates.
  '/api/cron/claude-fleet': '0 * * * *',
  // Routines fire on the family's own clock ("every Sunday at 5pm"), so the
  // worker has to be asked often enough that a 17:00 schedule fires at 17:00
  // and not at whatever hour a daily tick happens to land on. Fifteen minutes
  // is the coarsest cadence that still keeps a minute-precise schedule inside
  // its own quarter hour, and the worker files requests rather than executing
  // them, so a tick is cheap.
  '/api/cron/family-routines': '*/15 * * * *',
};

/** The workflow asks for this cadence; a tick with no known previous run looks back exactly this far. */
export const TICK_MINUTES = 5;

/**
 * Daily routes the catch-up may call again within their occurrence.
 *
 * The catch-up leaves daily routes to Vercel (isSubDaily) because, for most of
 * them, a call hours after the slot is a SECOND daily run on top of Vercel's. A
 * route belongs here only when a second call for the same slot provably does
 * nothing more than the first: it derives its occurrence from the SLOT — the
 * most recent of its minutes at or before the call — not from the clock, and
 * every send it makes carries that occurrence in an idempotency key the
 * provider holds for longer than the occurrence lives. admin-digest reads the
 * 24 h ending at the latest 12:30 UTC slot, renders the same bytes on every
 * call, and sends each admin under `admin-digest/sha256(occurrence|to)`, which
 * Resend folds for 24 h (app/api/cron/admin-digest/route.ts,
 * tests/admin-digest-replay-contract.test.ts).
 *
 * What it buys: the route's own recovery. Its sends can fail after the first
 * request outlived the keyed wait; the route answers 502, this script exits
 * non-zero, a failed run is not a catch-up boundary (cron-run-history.mjs), so
 * the NEXT tick's window reaches back over 12:30 and — with the route in this
 * set — calls it again, under the same key, for the same occurrence. Without
 * this set that tick evaluated the route over the fixed five minutes only and
 * never called it (review 5979998496 on #946: `--dry-run --at 12:35` omitted it).
 *
 * What it does not buy, stated: a slot is caught up only while its occurrence is
 * live. A window that reaches back over TWO of a route's slots calls the route
 * once (dueRoutes), and the route resolves that call to the LATER slot; the
 * earlier occurrence is not recovered, exactly as before. The cap
 * (CATCH_UP_MAX_MINUTES, 24 h) keeps that to one missed occurrence at most.
 * The durable per-recipient record is the delivery engine behind its flag.
 */
export const OCCURRENCE_SAFE_DAILY = new Set(['/api/cron/admin-digest']);

/**
 * How far back a tick may look for firings it missed — the catch-up window.
 *
 * The workflow hands the dispatcher the start of its previous successful
 * scheduled run (CRON_SINCE), and a sub-daily route is called when any of its
 * minutes fell in (since, now] — once, however many did, because the routes are
 * sweeps that pick up everything pending, not replays of one slot.
 *
 * Why a cap: every route the catch-up serves fires more than once a day (that
 * is the rule that admits it, isSubDaily), so it has a due minute in any
 * 24-hour window and a wider one cannot add a route — it only adds minutes to
 * scan. Why a boundary beyond the cap is CLAMPED to it rather than ignored:
 * the gaps this exists for are the long ones (the measured maximum was 396
 * minutes, and a workflow re-enabled after weeks disabled has the same shape),
 * and ignoring the boundary there would drop the catch-up exactly when it has
 * the most to recover. The clamp costs at most one call per sub-daily route.
 * tests/cron-dispatch.test.ts checks the cap against the longest gap in the
 * table, so a route that fires less often than this cannot be added silently.
 */
export const CATCH_UP_MAX_MINUTES = 24 * 60;

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

/**
 * Can the expression fire more than once per calendar day? Only such routes are
 * caught up. The others — one fixed minute of one fixed hour — are exactly the
 * schedules Vercel Hobby accepts, so vercel.json mirrors each of them at the
 * same minute (pinned in tests/cron-dispatch.test.ts) and Vercel does fire them.
 * Catching one up hours later would be a second daily run on top of the one
 * Vercel sent: a wasted call for most routes — and, until #946, a second email
 * for admin-digest (tests/a-mirrored-cron-must-be-idempotent.test.ts). A daily
 * route a second call cannot double is admitted by name instead
 * (OCCURRENCE_SAFE_DAILY). Inside the fixed TICK_MINUTES window every daily
 * route is evaluated exactly as before.
 * @param {string | ReturnType<typeof parseCron>} expr
 */
export function isSubDaily(expr) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  return !(c.minute.size === 1 && c.hour.size === 1);
}

/**
 * The window a tick evaluates, (start, now], counted in whole minutes.
 *
 * `since` is the previous successful tick's start (CRON_SINCE; a Date or an
 * ISO string). The start is never later than the fixed window's — a boundary
 * two minutes ago must not narrow the tick below TICK_MINUTES, or a quick pair
 * of runs would lose the minutes between them — and never earlier than
 * CATCH_UP_MAX_MINUTES ago. A missing, unparseable or future boundary leaves
 * the fixed window alone; `note` says why, for the log.
 * @param {Date} now
 * @param {Date | string | null | undefined} since
 * @param {number} [tickMinutes]
 * @param {number} [capMinutes]
 */
export function tickWindow(now, since, tickMinutes = TICK_MINUTES, capMinutes = CATCH_UP_MAX_MINUTES) {
  const fixedStart = new Date(now.getTime() - tickMinutes * 60_000);
  const minutes = (/** @type {Date} */ start) => Math.floor(now.getTime() / 60_000) - Math.floor(start.getTime() / 60_000);
  const fixed = (/** @type {string | null} */ note) => ({ start: fixedStart, minutes: minutes(fixedStart), since: null, note });
  const boundary = since instanceof Date ? since : typeof since === 'string' && since.trim() ? new Date(since.trim()) : null;
  if (boundary === null) return fixed(null);
  if (Number.isNaN(boundary.getTime())) return fixed('CRON_SINCE ignored: not a timestamp');
  if (boundary.getTime() > now.getTime()) return fixed('CRON_SINCE ignored: in the future');
  const floor = new Date(now.getTime() - capMinutes * 60_000);
  const start = new Date(Math.max(Math.min(boundary.getTime(), fixedStart.getTime()), floor.getTime()));
  const note = boundary.getTime() < floor.getTime() ? `catch-up capped at ${capMinutes} min (CRON_SINCE ${boundary.toISOString()})` : null;
  return { start, minutes: minutes(start), since: boundary, note };
}

/**
 * Routes whose schedule fired in the tick's window, each at most once.
 * Sub-daily routes are evaluated over the catch-up window (tickWindow); routes
 * that fire at most daily only over the fixed (now - tickMinutes, now], because
 * Vercel already fired them (isSubDaily) — except the ones a second call within
 * the occurrence cannot double (OCCURRENCE_SAFE_DAILY), which are caught up too.
 * @param {Date} now
 * @param {Record<string, string>} [schedules]
 * @param {number} [tickMinutes]
 * @param {Date | string | null} [since]
 * @param {Set<string>} [occurrenceSafe]
 */
export function dueRoutes(now, schedules = SCHEDULES, tickMinutes = TICK_MINUTES, since = null, occurrenceSafe = OCCURRENCE_SAFE_DAILY) {
  const fixedStart = now.getTime() - tickMinutes * 60_000;
  const catchUpStart = tickWindow(now, since, tickMinutes).start.getTime();
  const latest = new Date(now.getTime());
  latest.setUTCSeconds(0, 0);
  const due = [];
  for (const [route, expr] of Object.entries(schedules)) {
    const parsed = parseCron(expr);
    const start = isSubDaily(parsed) || occurrenceSafe.has(route) ? catchUpStart : fixedStart;
    for (let t = latest.getTime(); t > start; t -= 60_000) {
      if (matchesAt(parsed, new Date(t))) { due.push(route); break; }
    }
  }
  return due;
}

/** Read only enough response bytes for a diagnostic, never an unbounded body. */
async function responsePreview(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remaining = 4_096;
  let text = '';
  try {
    while (remaining > 0) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = chunk.value.subarray(0, remaining);
      text += decoder.decode(bytes, { stream: true });
      remaining -= bytes.byteLength;
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function safeDiagnostic(value, secret) {
  return String(value).split(secret).join('[redacted]').replace(/\s+/g, ' ').slice(0, 200);
}

async function callRoute(baseUrl, route, secret, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetchImpl(`${baseUrl}${route}`, { headers: { Authorization: `Bearer ${secret}`, 'User-Agent': 'bubaly-cron-dispatch' }, signal: controller.signal, redirect: 'manual' });
    const body = safeDiagnostic(await responsePreview(res), secret);
    return { route, status: res.status, ok: res.ok, body };
  } catch (error) {
    return { route, status: 0, ok: false, body: safeDiagnostic(error instanceof Error ? error.message : String(error), secret) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const atIndex = args.indexOf('--at');
  const now = atIndex >= 0 ? new Date(args[atIndex + 1]) : new Date();
  if (Number.isNaN(now.getTime())) { console.error('Invalid --at timestamp'); process.exitCode = 2; return; }
  const routeIndex = args.indexOf('--route');
  const only = routeIndex >= 0 ? args[routeIndex + 1] : null;
  if (routeIndex >= 0 && (!only || !Object.hasOwn(SCHEDULES, only))) {
    console.error('Invalid --route: choose a registered /api/cron route from SCHEDULES.');
    process.exitCode = 2;
    return;
  }
  const window = tickWindow(now, only ? null : process.env.CRON_SINCE);
  const routes = only ? [only] : dueRoutes(now, SCHEDULES, TICK_MINUTES, window.start);
  const windowText = `window ${window.minutes} min${window.since ? ` from ${window.start.toISOString()}` : ''}${window.note ? `; ${window.note}` : ''}`;
  console.log(`cron-dispatch at ${now.toISOString()} (${windowText}): ${routes.length ? routes.join(', ') : 'nothing due'}`);
  if (dryRun) return;
  const secret = process.env.CRON_SECRET;
  if (!secret?.trim()) {
    console.error('CRON_SECRET is required for dispatch. Add the matching application secret under Settings → Secrets → Actions.');
    process.exitCode = 1;
    return;
  }
  if (/[\r\n]/.test(secret)) {
    console.error('Invalid CRON_SECRET: configure a single-line value.');
    process.exitCode = 2;
    return;
  }
  let baseUrl;
  try {
    const url = new URL(process.env.CRON_BASE_URL?.trim() || 'https://www.bubaly.com');
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid origin');
    baseUrl = url.origin;
  } catch {
    console.error('Invalid CRON_BASE_URL: configure an HTTPS origin or HTTP loopback origin without credentials, path, query or fragment.');
    process.exitCode = 2;
    return;
  }
  if (routes.length === 0) return;
  const results = await Promise.all(routes.map((route) => callRoute(baseUrl, route, secret)));
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.status} ${r.route} ${r.body}`);
    if (!r.ok) failed += 1;
  }
  if (failed) { console.error(`${failed} of ${results.length} cron route(s) failed.`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
