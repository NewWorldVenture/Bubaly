import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { firesOncePerDay, nextCronRun, sameLocalMinute } from '../lib/services/routines/schedule';

// The autumn DST transition repeats an hour, so a once-a-day routine's wall
// clock arrives twice. The scheduler fires whatever `next_run_at <= now`, then
// recomputes from `now` — which lands on the second arrival. The occurrence key
// is (rule_id, due_at) and those are two DIFFERENT instants, so the reservation
// does not stop it: the family gets the routine twice that night.
//
// Measured rather than reasoned about, on the real Intl data.

const NY = 'America/New_York';
const at = (d: Date) => d.toLocaleString('en-US', { timeZone: NY, hour12: false });

describe('the repeated hour is real', () => {
  it('a once-a-day 01:30 matches twice on the fall-back night', () => {
    // 2026-11-01: 02:00 EDT -> 01:00 EST.
    const first = nextCronRun('30 1 * * *', new Date('2026-11-01T04:00:00Z'), NY)!;
    const second = nextCronRun('30 1 * * *', first, NY)!;
    expect(first.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(second.toISOString()).toBe('2026-11-01T06:30:00.000Z');
    // One hour apart, and indistinguishable to the family.
    expect(second.getTime() - first.getTime()).toBe(3_600_000);
    expect(at(first)).toBe(at(second));
    expect(sameLocalMinute(first, second, NY)).toBe(true);
  });

  it('the scheduler, following its own reschedule rule, would fire twice', () => {
    // Exactly what app/api/cron/family-routines/route.ts does: fire the due
    // occurrence, then recompute the next one from `now`.
    const expr = '30 1 * * *';
    const dueAt = nextCronRun(expr, new Date('2026-11-01T04:00:00Z'), NY)!;
    const naive = nextCronRun(expr, dueAt, NY)!;
    expect(sameLocalMinute(naive, dueAt, NY)).toBe(true); // the double fire

    // With the guard the route now applies, the repeat is skipped.
    const guarded = firesOncePerDay(expr) && sameLocalMinute(naive, dueAt, NY)
      ? nextCronRun(expr, naive, NY)!
      : naive;
    expect(sameLocalMinute(guarded, dueAt, NY)).toBe(false);
    expect(guarded.toISOString()).toBe('2026-11-02T06:30:00.000Z'); // next day, 01:30 EST
  });
});

describe('the guard is narrow enough to be correct', () => {
  it('an hourly rule still runs in BOTH halves of the repeated hour', () => {
    // Two real hours pass. The family asked for every hour, not for a time of
    // day, so skipping one would drop a genuine run.
    expect(firesOncePerDay('0 * * * *')).toBe(false);
    const first = nextCronRun('0 * * * *', new Date('2026-11-01T04:30:00Z'), NY)!;
    const second = nextCronRun('0 * * * *', first, NY)!;
    expect(second.getTime() - first.getTime()).toBe(3_600_000);
  });

  it('recognises a fixed hour, and only a fixed hour', () => {
    expect(firesOncePerDay('30 1 * * *')).toBe(true);
    expect(firesOncePerDay('0 7 * * 1')).toBe(true);
    expect(firesOncePerDay('0 * * * *')).toBe(false);
    expect(firesOncePerDay('0 1,13 * * *')).toBe(false);
    expect(firesOncePerDay('0 */4 * * *')).toBe(false);
  });

  it('leaves an ordinary night alone', () => {
    const a = nextCronRun('30 1 * * *', new Date('2026-06-01T00:00:00Z'), NY)!;
    const b = nextCronRun('30 1 * * *', a, NY)!;
    expect(sameLocalMinute(a, b, NY)).toBe(false);
    expect(b.getTime() - a.getTime()).toBe(86_400_000);
  });
});

describe('the route applies it', () => {
  const route = readFileSync('app/api/cron/family-routines/route.ts', 'utf8');
  it('guards the reschedule, gated on a fixed hour', () => {
    expect(route).toContain('firesOncePerDay(schedule.expr)');
    expect(route).toContain('sameLocalMinute(next, new Date(dueAt), tz)');
    expect(route).toMatch(/next = nextCronRun\(schedule\.expr, next, tz\)/);
  });
});
