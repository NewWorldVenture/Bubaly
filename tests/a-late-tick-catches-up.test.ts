import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEDULES, TICK_MINUTES, dueRoutes, isSubDaily, matchesAt } from '../scripts/cron-dispatch.mjs';

const ROOT = join(__dirname, '..');
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as {
  crons: { path: string; schedule: string }[];
};

/**
 * The dispatcher's window used to be anchored to when it RAN, not to when it
 * was due:
 *
 *   for (let back = 0; back < tickMinutes; back += 1) {
 *     const t = new Date(now.getTime() - back * 60_000);
 *     if (matchesAt(parsed, t)) { due.push(route); break; }
 *   }
 *
 * GitHub's scheduled workflows are best-effort and routinely late. A tick due at
 * 09:00 that actually started at 09:07 searched (09:02, 09:07] — and a route
 * scheduled for 09:00 was simply not in it. Nothing errored and nothing retried:
 * the next tick's window started later still, so that firing was gone for good.
 * This file was `a-late-tick-drops-a-cron` and pinned exactly that.
 *
 * HOW LATE. Over the dispatcher's first fortnight — runs #1..#95, 2026-09-05 to
 * 2026-09-18, run numbers contiguous so nothing was retention-pruned — GitHub
 * delivered 95 of 3,922 requested ticks. The MINIMUM gap between consecutive
 * runs was 104 minutes; the median was 209; the maximum 396. Not one of 83
 * consecutive pairs came in at the five minutes the workflow asks for. So
 * "late" is the wrong word: the tick is usually simply absent, and a window
 * anchored to the run was not seven minutes behind, it was hours. A frequent
 * route did not self-heal in minutes — it lost ~98% of its firings and waited
 * hours for the next tick — while the DAILY routes were the protected ones,
 * because `vercel.json` mirrors every one of them at the same minute and
 * Vercel's scheduler does fire. The eighteen routes with no Vercel equivalent
 * for their cadence are measured one by one in
 * `a-cron-cadence-is-a-promise-nothing-keeps`.
 *
 * THE FIX (2026-10-03). The workflow reads the start of its previous successful
 * scheduled run from the Actions API and passes it as CRON_SINCE; `dueRoutes`
 * evaluates every minute in (since, now] for the sub-daily routes and calls each
 * route that was due AT MOST ONCE, however many of its minutes fell in the gap.
 * The daily routes are deliberately NOT caught up: Vercel fired them on time, so
 * a catch-up hours later would be a second daily run on top of Vercel's — for
 * `admin-digest`, once, a second email (`a-mirrored-cron-must-be-idempotent`).
 * They keep the five-minute window exactly as before. The one exception is
 * admitted by name (OCCURRENCE_SAFE_DAILY): admin-digest now resolves every
 * call to its slot and sends under one key per occurrence, so a second call
 * within the occurrence sends nothing more, and the catch-up is how a tick whose
 * digest failed gets it delivered (tests/cron-dispatch.test.ts).
 *
 * WHAT CHANGES AND WHAT DOES NOT. A firing is no longer lost: the next tick,
 * whenever it comes, calls the route once. The RATE is unchanged — a route asked
 * for every five minutes, 288 times a day, still runs once per tick, about seven
 * times a day,
 * and `a-cron-cadence-is-a-promise-nothing-keeps` still pins that deficit. A
 * tick with no boundary (the first run, or a failed API lookup) behaves exactly
 * as before, and the first test below keeps that mechanism visible rather than
 * pretending it was never there.
 */

/** Minutes-of-day a 5-field UTC expression fires on a Monday. */
function minutesOfDay(expr: string): Set<number> {
  const [m, h, , , dow] = expr.split(' ');
  const vals = (f: string, lo: number, hi: number): Set<number> => {
    const out = new Set<number>();
    for (const part of f.split(',')) {
      if (part === '*') for (let x = lo; x <= hi; x += 1) out.add(x);
      else if (part.startsWith('*/')) { const n = Number(part.slice(2)); for (let x = lo; x <= hi; x += 1) if (x % n === 0) out.add(x); }
      else if (part.includes('-')) { const [a, b] = part.split('-').map(Number); for (let x = a; x <= b; x += 1) out.add(x); }
      else out.add(Number(part));
    }
    return out;
  };
  if (dow !== '*' && !vals(dow, 0, 6).has(1)) return new Set();
  const out = new Set<number>();
  for (const hh of vals(h, 0, 23)) for (const mm of vals(m, 0, 59)) out.add(hh * 60 + mm);
  return out;
}

/** Every whole minute in (since, until]. */
function minutesBetween(since: string, until: Date): Date[] {
  const out: Date[] = [];
  for (let t = new Date(since).getTime() + 60_000; t <= until.getTime(); t += 60_000) out.push(new Date(t));
  return out;
}

describe('a late tick catches up', () => {
  // Monday 09:00 is due for journey-recovery ('0 9,15,21'); the tick arrives at 09:07.
  const DUE = new Date('2026-09-07T09:00:00Z');
  const LATE = new Date('2026-09-07T09:07:00Z');

  it('without a boundary, a seven-minute delay still drops routes that were due (the mechanism, kept visible)', () => {
    const onTime = dueRoutes(DUE);
    const late = dueRoutes(LATE);
    const dropped = onTime.filter((r) => !late.includes(r));

    expect(onTime.length).toBeGreaterThan(late.length);
    expect(dropped).toContain('/api/cron/journey-recovery');
    // Nothing anywhere records the drop — it is not an error path, it is an
    // empty window. That is why the boundary has to come from outside.
    expect(TICK_MINUTES).toBe(5);
  });

  it('given the previous tick’s start, the late tick fires everything the on-time tick would have', () => {
    const onTime = dueRoutes(DUE);
    const caughtUp = dueRoutes(LATE, SCHEDULES, TICK_MINUTES, '2026-09-07T08:55:00Z');
    for (const r of onTime) expect(caughtUp, `${r} still lost`).toContain(r);
    expect(caughtUp).toContain('/api/cron/journey-recovery');
    expect(new Set(caughtUp).size).toBe(caughtUp.length);
  });

  it('a delay shorter than the window drops nothing, boundary or not', () => {
    // The boundary matters only once the delay exceeds the window; inside it,
    // the fixed look-back was always enough.
    const onTime = dueRoutes(DUE);
    const slightlyLate = new Date('2026-09-07T09:04:00Z');
    for (const r of onTime) {
      expect(dueRoutes(slightlyLate), `${r} lost inside the window`).toContain(r);
      expect(dueRoutes(slightlyLate, SCHEDULES, TICK_MINUTES, '2026-09-07T08:59:00Z'), `${r} lost with a boundary`).toContain(r);
    }
  });

  it('a gap of hours catches up every GitHub-only route exactly once, and no daily one', () => {
    // 03:00 → 09:07 on a Monday, a little longer than the median gap measured above.
    const since = '2026-09-07T03:00:00Z';
    const due = dueRoutes(LATE, SCHEDULES, TICK_MINUTES, since);
    const subDaily = Object.entries(SCHEDULES).filter(([, expr]) => isSubDaily(expr)).map(([route]) => route);
    expect(subDaily).toHaveLength(18);
    expect([...due].sort(), 'every sub-daily route, and no daily one: admin-digest\'s 12:30 is outside this gap').toEqual([...subDaily].sort());
    expect(new Set(due).size).toBe(due.length);

    // Non-vacuity: daily routes WERE due in the gap. They were left to Vercel,
    // whose schedule for each is the dispatcher's own, so nothing is lost by it.
    const gap = minutesBetween(since, LATE);
    const byPath = new Map(vercel.crons.map((c) => [c.path, c.schedule]));
    const dailyDueInGap = Object.entries(SCHEDULES)
      .filter(([, expr]) => !isSubDaily(expr) && gap.some((m) => matchesAt(expr, m)))
      .map(([route]) => route);
    expect(dailyDueInGap).toEqual(expect.arrayContaining([
      '/api/cron/calendar-feeds', '/api/cron/wallet-allowance', '/api/cron/return-reminders', '/api/cron/weekly-digest',
    ]));
    for (const route of dailyDueInGap) {
      expect(due).not.toContain(route);
      expect(byPath.get(route), `${route} is left to Vercel but Vercel fires it at a different minute`).toBe((SCHEDULES as Record<string, string>)[route]);
    }
    // The one daily route the catch-up calls again (OCCURRENCE_SAFE_DAILY) was
    // not due in this gap, so this gap says nothing about it; the window that
    // holds its slot is pinned in tests/cron-dispatch.test.ts.
    expect(dailyDueInGap).not.toContain('/api/cron/admin-digest');
  });

  it('recovers the firing, not the rate', () => {
    // close-auctions is '*/5': the 03:00 → 09:07 gap held 73 of its minutes and
    // the catch-up makes ONE call, because the route is a sweep that settles
    // every auction that has ended, not a replay of each slot. The deficit in
    // a-cron-cadence-is-a-promise-nothing-keeps is therefore untouched.
    const since = '2026-09-07T03:00:00Z';
    const matching = minutesBetween(since, LATE).filter((m) => matchesAt((SCHEDULES as Record<string, string>)['/api/cron/close-auctions'], m));
    expect(matching).toHaveLength(73);
    const due = dueRoutes(LATE, SCHEDULES, TICK_MINUTES, since);
    expect(due.filter((r) => r === '/api/cron/close-auctions')).toHaveLength(1);
  });

  it('names the sparse routes the catch-up exists for, and keeps the list honest', () => {
    // A firing is exposed when Vercel has no schedule for that minute. These
    // seven are the sparse ones, where one exposed firing used to be a whole
    // four-, six- or twelve-hourly slot gone; each now comes back on the next
    // tick, however late.
    //
    // The frequent routes are excluded from THIS list because their exposure is
    // better counted as a rate than as named slots — not, as this file once
    // claimed, because they "self-heal in minutes". See the header.
    const SPARSE_AND_GITHUB_ONLY = [
      '/api/cron/checkout-abandoned',
      '/api/cron/library-feeds',
      '/api/cron/marketing-providers',
      '/api/cron/provider-sync',
      '/api/cron/journey-recovery',
      '/api/cron/autopilot-scan',
      '/api/cron/model-refresh',
    ];
    const byPath = new Map(vercel.crons.map((c) => [c.path, c.schedule]));
    // A tick a day late — the clamp's whole window — sees every one of them.
    const dayLate = dueRoutes(LATE, SCHEDULES, TICK_MINUTES, '2026-09-06T09:07:00Z');

    for (const path of SPARSE_AND_GITHUB_ONLY) {
      const gh = minutesOfDay((SCHEDULES as Record<string, string>)[path]);
      const vc = byPath.has(path) ? minutesOfDay(byPath.get(path) as string) : new Set<number>();
      const orphaned = [...gh].filter((x) => !vc.has(x));
      expect(orphaned.length, `${path} now has every firing covered by Vercel; remove it`).toBeGreaterThan(0);
      // Sparse means a dropped firing used to wait hours, not minutes.
      expect(gh.size, `${path} fires ${gh.size}×/day — too often to belong on this list`).toBeLessThanOrEqual(12);
      expect(dayLate, `${path} is not caught up`).toContain(path);
    }
  });

  it('the frequent routes have a next occurrence — which is still not the same as running on time', () => {
    // This measures the TABLE, not what runs: a route can have 288 scheduled
    // firings a day and still be called seven times, because the catch-up is one
    // call per tick and the tick is what GitHub does not deliver. Kept because
    // the fact is load-bearing — it is why these routes recover the moment a
    // tick does arrive — and stated as what it is.
    for (const path of ['/api/cron/ai-runs', '/api/cron/close-auctions', '/api/cron/marketing']) {
      const gh = minutesOfDay((SCHEDULES as Record<string, string>)[path]);
      expect(gh.size, `${path} is no longer a frequent route`).toBeGreaterThan(100);
      // And the correction: nothing in vercel.json keeps that cadence.
      const vc = vercel.crons.find((c) => c.path === path);
      expect(minutesOfDay(vc?.schedule ?? '').size, `${path} gained a sub-daily guarantee`).toBeLessThanOrEqual(1);
    }
  });
});
