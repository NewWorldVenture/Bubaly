import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEDULES, TICK_MINUTES, dueRoutes } from '../scripts/cron-dispatch.mjs';

const ROOT = join(__dirname, '..');
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as {
  crons: { path: string; schedule: string }[];
};

/**
 * The dispatcher's window is anchored to when it RAN, not to when it was due.
 *
 *   for (let back = 0; back < tickMinutes; back += 1) {
 *     const t = new Date(now.getTime() - back * 60_000);
 *     if (matchesAt(parsed, t)) { due.push(route); break; }
 *   }
 *
 * GitHub's scheduled workflows are best-effort and routinely late. A tick due at
 * 09:00 that actually starts at 09:07 searches (09:02, 09:07] — and a route
 * scheduled for 09:00 is simply not in it. Nothing errors and nothing retries:
 * the next tick's window starts later still, so that firing is gone for good.
 *
 * WHEN I FIRST WROTE THIS I MODELLED A SEVEN-MINUTE DELAY, AND THE SEVERITY I
 * DREW FROM IT WAS WRONG. The paragraph that stood here said most routes do not
 * care, because a route firing every five or fifteen minutes has another
 * occurrence inside the late window and so "the lost slot costs minutes"; and
 * that the ones that matter are the SPARSE ones. Both halves are backwards, and
 * measuring the workflow rather than reasoning about it is what showed it.
 *
 * Over the dispatcher's entire life — runs #1..#95, 2026-09-05 to 2026-09-18,
 * run numbers contiguous so nothing was retention-pruned — GitHub delivered 95
 * of 3,922 requested ticks. The MINIMUM gap between consecutive runs was 104
 * minutes; the median was 209; the maximum 396. Not one of 83 consecutive pairs
 * came in at the five minutes the workflow asks for. So "late" is the wrong
 * word: the tick is usually simply absent, and the window is not seven minutes
 * behind, it is hours.
 *
 * That inverts the conclusion. A frequent route does not self-heal in minutes —
 * it loses ~98% of its firings and waits hours for the next tick. And the
 * sparse DAILY routes are the protected ones, because vercel.json mirrors them
 * and Vercel's scheduler does fire. The routes that actually suffer are the
 * fourteen whose real cadence is sub-daily and therefore has no Vercel
 * equivalent — measured route by route in
 * `a-cron-cadence-is-a-promise-nothing-keeps`, where the deficit runs 2× to
 * 288×.
 *
 * And most of the DAILY routes are covered from the other side: `vercel.json`
 * mirrors all 24 (see `a-mirrored-cron-must-be-idempotent`), and Vercel's own
 * scheduler fires at the right minute regardless of GitHub. The redundancy that
 * makes `admin-digest` double-send is the same redundancy that protects the
 * daily jobs from this. It does NOT protect a firing Vercel has no schedule for.
 *
 * This file pins the behaviour rather than asserting it away. There is no clean
 * stateless fix: widening the window makes a daily route fire several times per
 * day (and doubles down on the `admin-digest` duplicate), and anchoring to the
 * tick boundary still misses a tick that was dropped rather than delayed. The
 * real fixes are persisted catch-up state, or the end state the dispatcher's own
 * header already names — "On Vercel Pro the original per-minute schedules can go
 * back into vercel.json and this workflow can be disabled."
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

describe('a late tick drops a cron firing', () => {
  it('a seven-minute delay silently drops routes that were due', () => {
    // The demonstration, run through the dispatcher's own exported function
    // rather than described in prose.
    const onTime = dueRoutes(new Date('2026-09-07T09:00:00Z'));
    const late = dueRoutes(new Date('2026-09-07T09:07:00Z'));
    const dropped = onTime.filter((r: string) => !late.includes(r));

    expect(onTime.length).toBeGreaterThan(late.length);
    expect(dropped).toContain('/api/cron/journey-recovery');
    // Nothing anywhere records the drop — it is not an error path, it is an
    // empty window.
    expect(TICK_MINUTES).toBe(5);
  });

  it('a delay shorter than the window drops nothing', () => {
    // Non-vacuity, and the boundary: the mechanism is the window width, not
    // lateness as such.
    const onTime = dueRoutes(new Date('2026-09-07T09:00:00Z'));
    const slightlyLate = dueRoutes(new Date('2026-09-07T09:04:00Z'));
    for (const r of onTime) expect(slightlyLate, `${r} lost inside the window`).toContain(r);
  });

  it('names the routes a drop actually costs, and keeps the list honest', () => {
    // A firing is exposed when Vercel has no schedule for that minute. These
    // seven are the sparse ones, where a single exposed firing is a whole
    // four-, six- or twelve-hourly slot gone.
    //
    // The frequent routes are excluded from THIS list because their exposure is
    // better counted as a rate than as named slots — not, as the comment here
    // once claimed, because they "self-heal in minutes". See the correction in
    // this file's header.
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

    for (const path of SPARSE_AND_GITHUB_ONLY) {
      const gh = minutesOfDay((SCHEDULES as Record<string, string>)[path]);
      const vc = byPath.has(path) ? minutesOfDay(byPath.get(path) as string) : new Set<number>();
      const orphaned = [...gh].filter((x) => !vc.has(x));
      expect(orphaned.length, `${path} now has every firing covered by Vercel; remove it`).toBeGreaterThan(0);
      // Sparse means a dropped firing waits hours, not minutes.
      expect(gh.size, `${path} fires ${gh.size}×/day — too often to belong on this list`).toBeLessThanOrEqual(12);
    }
  });

  it('the frequent routes have a next occurrence — which is not the same as being safe', () => {
    // This assertion used to be titled "the frequent routes really do self-heal"
    // and was read as evidence that a dropped tick cost them minutes. It is
    // evidence of no such thing: it measures the TABLE, not what runs. A route
    // can have 288 scheduled firings a day and still fire seven times, because
    // the next occurrence only helps if a tick arrives to notice it.
    //
    // Kept, because the fact is still load-bearing — it is why these routes
    // recover immediately once a scheduler does fire — but stated as what it is.
    for (const path of ['/api/cron/ai-runs', '/api/cron/close-auctions', '/api/cron/marketing']) {
      const gh = minutesOfDay((SCHEDULES as Record<string, string>)[path]);
      expect(gh.size, `${path} is no longer a frequent route`).toBeGreaterThan(100);
      // And the correction: nothing in vercel.json keeps that cadence.
      const vc = vercel.crons.find((c) => c.path === path);
      expect(minutesOfDay(vc?.schedule ?? '').size, `${path} gained a sub-daily guarantee`).toBeLessThanOrEqual(1);
    }
  });
});
