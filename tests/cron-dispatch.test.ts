import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CATCH_UP_MAX_MINUTES, OCCURRENCE_SAFE_DAILY, SCHEDULES, TICK_MINUTES, parseCron, matchesAt, dueRoutes, isSubDaily, tickWindow } from '../scripts/cron-dispatch.mjs';

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
      '/api/cron/autopilot-scan', '/api/cron/checkout-abandoned', '/api/cron/claude-fleet', '/api/cron/close-auctions', '/api/cron/contact-center-urgent', '/api/cron/family-routines',
      '/api/cron/feedback-github-sync',
      '/api/cron/guardian-sms-recovery',
      '/api/cron/journey-recovery', '/api/cron/library-feeds', '/api/cron/marketing', '/api/cron/marketing-providers', '/api/cron/marketing-social', '/api/cron/model-refresh', '/api/cron/provider-sync', '/api/cron/push-scan',
      '/api/cron/social-publish',
    ]);
    for (const path of slowed) expect(runsAtMostDaily(SCHEDULES[path as keyof typeof SCHEDULES]), path).toBe(false);
  });
});

describe('the tick window', () => {
  const NOW = new Date('2026-09-12T12:05:00Z');
  const FIXED_START = new Date('2026-09-12T12:00:00Z');

  it('is the fixed five minutes when no boundary is given', () => {
    for (const since of [undefined, null, '', '   ']) {
      const w = tickWindow(NOW, since);
      expect(w.start).toEqual(FIXED_START);
      expect(w.minutes).toBe(TICK_MINUTES);
      expect(w.since).toBeNull();
      expect(w.note).toBeNull();
    }
  });

  it('ignores an unparseable or future boundary, keeps the fixed window and says why', () => {
    const bad = tickWindow(NOW, 'not-a-timestamp');
    expect(bad.start).toEqual(FIXED_START);
    expect(bad.minutes).toBe(TICK_MINUTES);
    expect(bad.since).toBeNull();
    expect(bad.note).toContain('not a timestamp');
    const future = tickWindow(NOW, '2026-09-12T12:06:00Z');
    expect(future.start).toEqual(FIXED_START);
    expect(future.minutes).toBe(TICK_MINUTES);
    expect(future.since).toBeNull();
    expect(future.note).toContain('in the future');
  });

  it('never narrows below the fixed window: a boundary two minutes ago is a floor, not a cut', () => {
    // Two scheduled runs five minutes apart, or a manual run between ticks, must
    // not cost the minutes between them.
    const w = tickWindow(NOW, '2026-09-12T12:03:00Z');
    expect(w.start).toEqual(FIXED_START);
    expect(w.minutes).toBe(TICK_MINUTES);
    expect(w.since).toEqual(new Date('2026-09-12T12:03:00Z'));
    expect(w.note).toBeNull();
  });

  it('widens to the boundary and counts the whole minutes in (since, now]', () => {
    // 08:58:00 → the first minute considered is 08:59, the last 12:05: 187 of them.
    const w = tickWindow(NOW, '2026-09-12T08:58:00Z');
    expect(w.start).toEqual(new Date('2026-09-12T08:58:00Z'));
    expect(w.minutes).toBe(187);
    expect(w.since).toEqual(new Date('2026-09-12T08:58:00Z'));
    expect(w.note).toBeNull();
    // A boundary inside a minute excludes that minute (08:58 is not after 08:58:30) and nothing else;
    // seconds on `now` do not add a minute either.
    expect(tickWindow(NOW, '2026-09-12T08:58:30Z').minutes).toBe(187);
    expect(tickWindow(new Date('2026-09-12T12:05:45Z'), '2026-09-12T08:58:00Z').minutes).toBe(187);
    expect(tickWindow(NOW, new Date('2026-09-12T08:58:00Z')).minutes).toBe(187); // a Date works like its ISO string
  });

  it('clamps a boundary older than the cap to the cap instead of discarding it', () => {
    expect(CATCH_UP_MAX_MINUTES).toBe(24 * 60);
    const w = tickWindow(NOW, '2026-09-01T00:00:00Z');
    expect(w.start).toEqual(new Date('2026-09-11T12:05:00Z'));
    expect(w.minutes).toBe(CATCH_UP_MAX_MINUTES);
    expect(w.since).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(w.note).toContain(`capped at ${CATCH_UP_MAX_MINUTES} min`);
    // Exactly at the cap is not clamped.
    expect(tickWindow(NOW, '2026-09-11T12:05:00Z').note).toBeNull();
    expect(tickWindow(NOW, '2026-09-11T12:05:00Z').minutes).toBe(CATCH_UP_MAX_MINUTES);
  });

  it('the cap is at least the longest gap of every route it serves, so a clamped window still fires each of them', () => {
    // If a route were added that fires, say, every 36 hours, isSubDaily would
    // admit it to the catch-up and a 24-hour clamp could hide its one missed
    // firing. This keeps the constant honest against the table.
    const WEEK = 7 * 24 * 60;
    for (const [route, expr] of Object.entries(SCHEDULES)) {
      if (!isSubDaily(expr)) continue;
      const parsed = parseCron(expr);
      let longest = 0;
      let last: number | null = null;
      // Monday 00:00 through the following Monday 23:59, so a weekly wrap is seen.
      for (let i = 0; i < WEEK + 24 * 60; i += 1) {
        if (!matchesAt(parsed, new Date(Date.UTC(2026, 8, 7, 0, i)))) continue;
        if (last !== null) longest = Math.max(longest, i - last);
        last = i;
      }
      expect(last, `${route} never fires`).not.toBeNull();
      expect(longest, `${route} (${expr}) can go ${longest} min between firings, longer than CATCH_UP_MAX_MINUTES`).toBeLessThanOrEqual(CATCH_UP_MAX_MINUTES);
    }
  });
});

describe('catch-up: dueRoutes with a boundary', () => {
  // Saturday 12:05, with the previous successful tick at 08:58 — about the
  // median gap GitHub actually delivers (209 minutes).
  const NOW = new Date('2026-09-12T12:05:00Z');
  const SINCE = '2026-09-12T08:58:00Z';

  it('fires a route whose minute fell in (since, now] but outside the five-minute window', () => {
    const fixed = dueRoutes(NOW);
    const caughtUp = dueRoutes(NOW, SCHEDULES, TICK_MINUTES, SINCE);
    for (const r of fixed) expect(caughtUp).toContain(r);
    // 09:00; 09:15, 10:15, 11:15; 10:00, 12:00; 12:00; 12:00 — none inside (12:00, 12:05].
    for (const r of ['/api/cron/journey-recovery', '/api/cron/feedback-github-sync', '/api/cron/push-scan', '/api/cron/library-feeds', '/api/cron/checkout-abandoned']) {
      expect(fixed).not.toContain(r);
      expect(caughtUp).toContain(r);
    }
    // A sub-daily route with no minute in the gap is still not due: '15 */4' is 08:15 and 12:15.
    expect(caughtUp).not.toContain('/api/cron/provider-sync');
  });

  it('fires a route once however many of its minutes fell in the window', () => {
    const caughtUp = dueRoutes(NOW, SCHEDULES, TICK_MINUTES, SINCE);
    expect(new Set(caughtUp).size).toBe(caughtUp.length);
    expect(caughtUp.filter((r) => r === '/api/cron/push-scan')).toHaveLength(1); // 10:00 and 12:00
    // Thirty-eight matching minutes (09:00 … 12:05), one call.
    expect(dueRoutes(NOW, { '/x': '*/5 * * * *' }, TICK_MINUTES, SINCE)).toEqual(['/x']);
  });

  it('does not catch up a route that fires at most daily — Vercel already did', () => {
    // 11:00 is in (08:58, 12:05] and notifications is '0 11 * * *'.
    expect(dueRoutes(NOW, SCHEDULES, TICK_MINUTES, SINCE)).not.toContain('/api/cron/notifications');
    // Its fixed window is untouched: a tick at 11:03 still fires it, boundary or not.
    expect(dueRoutes(new Date('2026-09-12T11:03:00Z'))).toContain('/api/cron/notifications');
    expect(dueRoutes(new Date('2026-09-12T11:03:00Z'), SCHEDULES, TICK_MINUTES, SINCE)).toContain('/api/cron/notifications');
    // Weekly is "at most daily" too: chore-reminders, Sunday 18:00.
    expect(dueRoutes(new Date('2026-09-06T20:00:00Z'), SCHEDULES, TICK_MINUTES, '2026-09-06T17:00:00Z')).not.toContain('/api/cron/chore-reminders');
    expect(dueRoutes(new Date('2026-09-06T18:02:00Z'))).toContain('/api/cron/chore-reminders');
    // admin-digest is the one daily route the catch-up DOES call again — by name,
    // because a second call within its occurrence sends nothing more (below).
    // Taken out of that set, it is left to Vercel like every other daily route.
    expect(dueRoutes(new Date('2026-09-12T15:00:00Z'), SCHEDULES, TICK_MINUTES, '2026-09-12T12:00:00Z', new Set())).not.toContain('/api/cron/admin-digest');
  });

  it('a daily route a second call cannot double is caught up within its occurrence (review 5979998496 on #946)', () => {
    expect([...OCCURRENCE_SAFE_DAILY]).toEqual(['/api/cron/admin-digest']);
    // The owner's reproduction: `--dry-run --at 2026-10-03T12:35:00Z` with no boundary
    // evaluates the fixed five minutes, (12:30, 12:35], and 12:30 is not in it.
    expect(dueRoutes(new Date('2026-10-03T12:35:00Z'))).not.toContain('/api/cron/admin-digest');
    // The dispatcher's real tick carries the previous SUCCESSFUL run's start. A run
    // in which the digest answered 502 failed, so that boundary predates 12:30 —
    // and the route is called again, for the same occurrence (the latest 12:30).
    expect(dueRoutes(new Date('2026-10-03T12:35:00Z'), SCHEDULES, TICK_MINUTES, '2026-10-03T12:00:00Z')).toContain('/api/cron/admin-digest');
    expect(dueRoutes(new Date('2026-10-03T15:00:00Z'), SCHEDULES, TICK_MINUTES, '2026-10-03T12:00:00Z')).toContain('/api/cron/admin-digest');
    // Once, however many of its minutes the window holds — two slots in one window
    // are one call, which the route resolves to the later slot (the residual).
    expect(dueRoutes(new Date('2026-10-04T13:00:00Z'), SCHEDULES, TICK_MINUTES, '2026-10-03T12:00:00Z').filter((r) => r === '/api/cron/admin-digest')).toHaveLength(1);
    // The other daily routes are not admitted by association.
    const caughtUp = dueRoutes(new Date('2026-10-03T15:00:00Z'), SCHEDULES, TICK_MINUTES, '2026-10-03T10:00:00Z');
    expect(caughtUp).toContain('/api/cron/admin-digest');
    expect(caughtUp).not.toContain('/api/cron/notifications'); // 11:00 is in the window and it is daily
    expect(caughtUp).not.toContain('/api/cron/automations');   // 13:00 too
  });

  it('the rule that keeps a route out of catch-up is the rule vercel.json mirrors it by', () => {
    // isSubDaily is the negation of Vercel Hobby's "at most once a day", so the
    // routes left to Vercel are exactly the ones Vercel fires at the dispatcher's
    // own minute — excluding them loses nothing — and the routes caught up are
    // exactly the ones Vercel had to slow down.
    const byPath = new Map(vercel.crons.map((c) => [c.path, c.schedule]));
    let leftToVercel = 0;
    for (const [route, expr] of Object.entries(SCHEDULES)) {
      expect(isSubDaily(expr), `${route} ${expr}`).toBe(!runsAtMostDaily(expr));
      if (isSubDaily(expr)) {
        expect(byPath.get(route), `${route} is caught up but vercel.json keeps its full cadence`).not.toBe(expr);
      } else {
        expect(byPath.get(route), `${route} is left to Vercel but vercel.json fires it at a different minute`).toBe(expr);
        leftToVercel += 1;
      }
    }
    expect(leftToVercel).toBeGreaterThanOrEqual(10);
  });

  it('a boundary older than the cap fires what was due inside the cap, not what was due only before it', () => {
    // Saturday 12:05, boundary Thursday 12:05 (48 h). '/in' fired Fri 15:00 and
    // Sat 03:00; '/before' (Thursdays only) fired Thu 15:00 — inside (since, now]
    // but 45 hours ago, beyond the 24-hour cap.
    const due = dueRoutes(NOW, { '/in': '0 3,15 * * *', '/before': '0 3,15 * * 4' }, TICK_MINUTES, '2026-09-10T12:05:00Z');
    expect(due).toEqual(['/in']);
  });

  it('a bad or future boundary evaluates exactly the fixed window', () => {
    expect(dueRoutes(NOW, SCHEDULES, TICK_MINUTES, 'not-a-timestamp')).toEqual(dueRoutes(NOW));
    expect(dueRoutes(NOW, SCHEDULES, TICK_MINUTES, '2026-09-12T12:06:00Z')).toEqual(dueRoutes(NOW));
  });
});
