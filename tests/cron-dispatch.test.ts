import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SCHEDULES, TICK_MINUTES, parseCron, matchesAt, dueRoutes } from '../scripts/cron-dispatch.mjs';

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] };

/** True when the expression can fire at most once per calendar day (Vercel Hobby rule). */
function runsAtMostDaily(expr: string): boolean {
  const c = parseCron(expr);
  return c.minute.size === 1 && c.hour.size === 1;
}

describe('cron matcher', () => {
  it('handles steps, lists, wildcards and day-of-week', () => {
    expect(matchesAt('*/5 * * * *', new Date('2026-09-05T03:05:00Z'))).toBe(true);
    expect(matchesAt('*/5 * * * *', new Date('2026-09-05T03:07:00Z'))).toBe(false);
    expect(matchesAt('15 */6 * * *', new Date('2026-09-05T18:15:00Z'))).toBe(true);
    expect(matchesAt('15 */6 * * *', new Date('2026-09-05T19:15:00Z'))).toBe(false);
    expect(matchesAt('30 6,18 * * *', new Date('2026-09-05T18:30:00Z'))).toBe(true);
    expect(matchesAt('0 18 * * 0', new Date('2026-09-06T18:00:00Z'))).toBe(true); // Sunday
    expect(matchesAt('0 18 * * 0', new Date('2026-09-05T18:00:00Z'))).toBe(false); // Saturday
    expect(matchesAt('0 8 * * 1', new Date('2026-09-07T08:00:00Z'))).toBe(true); // Monday
    expect(() => parseCron('0 8 * *')).toThrow();
    expect(() => parseCron('61 8 * * *')).toThrow();
  });
  it('finds everything due inside the tick window, once', () => {
    const due = dueRoutes(new Date('2026-09-05T03:05:30Z'));
    expect(due).toContain('/api/cron/marketing');
    expect(due).toContain('/api/cron/close-auctions');
    expect(due).not.toContain('/api/cron/notifications');
    expect(new Set(due).size).toBe(due.length);
    expect(dueRoutes(new Date('2026-09-05T11:03:00Z'))).toContain('/api/cron/notifications'); // 11:00 fell in (10:58, 11:03]
    expect(dueRoutes(new Date('2026-09-05T11:08:00Z'))).not.toContain('/api/cron/notifications');
    expect(TICK_MINUTES).toBe(5);
  });
});

describe('vercel.json ↔ dispatcher table', () => {
  it('every Vercel cron route is in the dispatcher and vice versa', () => {
    expect(vercel.crons.map((c) => c.path).sort()).toEqual(Object.keys(SCHEDULES).sort());
  });
  it('vercel.json only carries schedules Vercel Hobby accepts (at most once a day)', () => {
    for (const c of vercel.crons) expect(runsAtMostDaily(c.schedule), `${c.path} ${c.schedule}`).toBe(true);
  });
  it('the dispatcher keeps the real cadences for every route Vercel had to slow down', () => {
    const slowed = vercel.crons.filter((c) => c.schedule !== SCHEDULES[c.path as keyof typeof SCHEDULES]).map((c) => c.path);
    expect(slowed.sort()).toEqual([
      '/api/cron/ai-runs',
      '/api/cron/autopilot-scan', '/api/cron/checkout-abandoned', '/api/cron/close-auctions', '/api/cron/family-routines',
      '/api/cron/feedback-github-sync',
      '/api/cron/journey-recovery', '/api/cron/library-feeds', '/api/cron/marketing', '/api/cron/marketing-providers', '/api/cron/marketing-social', '/api/cron/model-refresh', '/api/cron/provider-sync', '/api/cron/push-scan',
    ]);
    for (const path of slowed) expect(runsAtMostDaily(SCHEDULES[path as keyof typeof SCHEDULES]), path).toBe(false);
  });
});
