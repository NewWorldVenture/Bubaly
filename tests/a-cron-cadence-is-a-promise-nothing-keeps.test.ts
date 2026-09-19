import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEDULES } from '../scripts/cron-dispatch.mjs';

const ROOT = join(__dirname, '..');
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as {
  crons: { path: string; schedule: string }[];
};

/**
 * TWO TABLES, AND ONLY ONE OF THEM IS A PROMISE.
 *
 * `scripts/cron-dispatch.mjs` SCHEDULES reads like the system's real cadences —
 * its own header says so: "vercel.json now carries daily-safe schedules so
 * production deploys on any plan; the real cadences live here". `vercel.json`
 * reads like a degraded copy kept only to satisfy Vercel Hobby.
 *
 * It is the other way round. vercel.json is the only table with a scheduler
 * behind it that actually fires. SCHEDULES is driven by
 * `.github/workflows/cron-dispatch.yml`, whose every-five-minutes schedule GitHub
 * delivers at a small fraction of the requested rate — measured over the workflow's entire
 * life (runs #1..#95, 2026-09-05 → 2026-09-18, contiguous run numbers so
 * nothing was retention-pruned): 95 runs against 3,922 requested ticks, a
 * MINIMUM observed gap of 104 minutes and a median of 209. Not one gap in 83
 * consecutive pairs was the 5 minutes the workflow asks for.
 *
 * So for the fourteen routes below, the cadence in SCHEDULES is an intention
 * and the cadence in vercel.json is the guarantee, and they differ by 2× to
 * 288×. `/api/cron/close-auctions` asks for every five minutes and is guaranteed `0 10`:
 * an auction that ends at 10:05 can stay open almost a full day. This is not a
 * bug in either table — it is the absence of a scheduler that keeps the first
 * one. The fix is a product decision (Vercel Pro's native sub-daily crons, or
 * persisted catch-up state), which is why this file pins the deficit rather
 * than asserting it away.
 *
 * What it DOES enforce: the list may not grow in the dark. Adding a route that
 * needs sub-daily cadence, without giving it a scheduler that delivers one,
 * fails here with the deficit named.
 *
 * Companion: `a-late-tick-drops-a-cron` covers the mechanism (a fixed 5-minute
 * look-back anchored to when the dispatcher ran). This file covers the size.
 */

/** Firings per week for a 5-field UTC cron expression. */
function firingsPerWeek(expr: string): number {
  const field = (f: string, lo: number, hi: number): Set<number> => {
    const out = new Set<number>();
    for (const part of f.split(',')) {
      const [rangePart, stepPart] = part.split('/');
      const step = stepPart ? Number(stepPart) : 1;
      let a: number;
      let b: number;
      if (rangePart === '*') { a = lo; b = hi; }
      else if (rangePart.includes('-')) { [a, b] = rangePart.split('-').map(Number); }
      else { a = Number(rangePart); b = stepPart ? hi : a; }
      for (let v = a; v <= b; v += step) out.add(v);
    }
    return out;
  };
  const [m, h, , , dow] = expr.trim().split(/\s+/);
  const days = dow === '*' ? 7 : field(dow, 0, 6).size;
  return field(m, 0, 59).size * field(h, 0, 23).size * days;
}

const guaranteed = new Map(vercel.crons.map((c) => [c.path, firingsPerWeek(c.schedule)]));

/** route -> how many times more often SCHEDULES asks for it than vercel.json guarantees. */
const deficit = new Map(
  Object.entries(SCHEDULES as Record<string, string>).map(([route, expr]) => {
    const want = firingsPerWeek(expr);
    const have = guaranteed.get(route) ?? 0;
    return [route, have === 0 ? Infinity : want / have] as const;
  }),
);

/**
 * Every route whose advertised cadence exceeds its guaranteed one, with the
 * factor. Computed above, transcribed here: if either table moves, they part.
 */
const DISPATCHER_DEPENDENT: Record<string, number> = {
  '/api/cron/marketing': 288,
  '/api/cron/close-auctions': 288,
  '/api/cron/ai-runs': 288,
  '/api/cron/marketing-social': 96,
  '/api/cron/family-routines': 96,
  '/api/cron/feedback-github-sync': 24,
  '/api/cron/push-scan': 12,
  '/api/cron/provider-sync': 6,
  '/api/cron/marketing-providers': 4,
  '/api/cron/library-feeds': 4,
  '/api/cron/checkout-abandoned': 4,
  '/api/cron/journey-recovery': 3,
  '/api/cron/model-refresh': 2,
  '/api/cron/autopilot-scan': 2,
};

describe('a cron cadence is a promise nothing keeps', () => {
  it('names every route whose advertised cadence outruns its guarantee', () => {
    const actual = [...deficit.entries()].filter(([, d]) => d > 1).map(([r]) => r).sort();
    expect(
      actual,
      'a route gained or lost a cadence deficit — update DISPATCHER_DEPENDENT and say which scheduler changed',
    ).toEqual(Object.keys(DISPATCHER_DEPENDENT).sort());
  });

  it('pins the size of each deficit, not merely its existence', () => {
    // The difference between 2× and 288× is the difference between "a bit
    // stale" and "this feature does not work". A route sliding from one to the
    // other must not pass silently.
    for (const [route, expected] of Object.entries(DISPATCHER_DEPENDENT)) {
      expect(deficit.get(route), `${route} deficit changed`).toBe(expected);
    }
  });

  it('every other route is fully covered by the scheduler that fires', () => {
    // Non-vacuity from the other side: the complement is not empty and is not
    // itself in deficit, so the list above is a real partition rather than a
    // list that happens to match.
    const covered = [...deficit.entries()].filter(([, d]) => d <= 1).map(([r]) => r);
    expect(covered.length).toBeGreaterThanOrEqual(10);
    for (const route of covered) expect(deficit.get(route), route).toBe(1);
  });

  it('states the worst case each dependent route actually guarantees', () => {
    // Read plainly: if GitHub delivers nothing at all — which for any given
    // firing is the ~98% case — this is how long a family waits.
    for (const route of Object.keys(DISPATCHER_DEPENDENT)) {
      const perWeek = guaranteed.get(route) as number;
      const worstCaseHours = (7 * 24) / perWeek;
      expect(worstCaseHours, `${route} is guaranteed better than daily now; re-check its deficit`).toBeGreaterThanOrEqual(24);
    }
  });

  it('the three worst are the ones whose own comments promise minutes', () => {
    // close-auctions, marketing and ai-runs are written '*/5'. Each is
    // guaranteed once a day. Pinned separately because these are the cases
    // where the gap between what the source says and what runs is largest.
    for (const route of ['/api/cron/close-auctions', '/api/cron/marketing', '/api/cron/ai-runs']) {
      expect((SCHEDULES as Record<string, string>)[route]).toBe('*/5 * * * *');
      expect(guaranteed.get(route), `${route} is no longer daily-only in vercel.json`).toBe(7);
    }
  });
});
