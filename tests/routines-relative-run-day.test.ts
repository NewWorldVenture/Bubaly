import { describe, expect, it } from 'vitest';
import { nextRelativeRun } from '../lib/services/routines/schedule';

// A relative routine fires an offset from an anchor date, at the family's hour:
// "the night before the trip, at 22:00". Placing that hour used to measure the
// zone offset at the UTC instant `<key>T<atHour>:00Z` and subtract it — but that
// reads the offset on whichever local DAY that instant falls on, which is not
// always the target day. When it is not, the hour difference wraps and the
// correction moves a WHOLE DAY.
//
// Measured before the fix, all with offsetDays: 0 and a plain summer date, so
// none of this is a DST edge case — it is every day of the year:
//
//   America/New_York, 2026-06-15, atHour 1  -> 06-14 01:00   a day EARLY
//   America/New_York, 2026-06-15, atHour 2  -> 06-14 02:00   a day EARLY
//   Asia/Tokyo,       2026-06-15, atHour 22 -> 06-16 22:00   a day LATE
//   Asia/Tokyo,       2026-06-15, atHour 23 -> 06-16 23:00   a day LATE
//
// A zone behind UTC broke early-morning routines; a zone ahead of it broke
// late-evening ones.

const PAST = new Date('2020-01-01T00:00:00Z');
const rel = (offsetDays: number, atHour: number) => ({ kind: 'relative', offsetDays, atHour }) as never;
const localDay = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const localHour = (d: Date, tz: string) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(d));

describe('a relative routine lands on the day it was asked for', () => {
  const cases: [string, string, number][] = [
    ['America/New_York', '2026-06-15', 1],
    ['America/New_York', '2026-06-15', 2],
    ['America/New_York', '2026-06-15', 9],
    ['Asia/Tokyo', '2026-06-15', 22],
    ['Asia/Tokyo', '2026-06-15', 23],
    ['Asia/Tokyo', '2026-06-15', 9],
    ['Pacific/Auckland', '2026-06-15', 23],
    ['America/Los_Angeles', '2026-06-15', 0],
  ];

  for (const [tz, anchor, atHour] of cases) {
    it(`${tz} @${String(atHour).padStart(2, '0')}:00 fires on ${anchor}`, () => {
      const fires = nextRelativeRun(rel(0, atHour), anchor, PAST, tz)!;
      expect(fires, 'no run produced').toBeTruthy();
      expect(localDay(fires, tz), `${tz} @${atHour} landed on the wrong local day`).toBe(anchor);
      expect(localHour(fires, tz)).toBe(atHour);
    });
  }

  it('honours the offset, counting local days', () => {
    const tz = 'America/New_York';
    const before = nextRelativeRun(rel(-1, 1), '2026-06-15', PAST, tz)!;
    expect(localDay(before, tz)).toBe('2026-06-14');
    expect(localHour(before, tz)).toBe(1);

    const after = nextRelativeRun(rel(2, 23), '2026-06-15', PAST, tz)!;
    expect(localDay(after, tz)).toBe('2026-06-17');
    expect(localHour(after, tz)).toBe(23);
  });

  it('still lands correctly on both DST transition days', () => {
    const tz = 'America/New_York';
    // 2026-11-01 repeats 01:00; 2026-03-08 skips 02:00.
    const fallBack = nextRelativeRun(rel(0, 1), '2026-11-01', PAST, tz)!;
    expect(localDay(fallBack, tz)).toBe('2026-11-01');
    expect(localHour(fallBack, tz)).toBe(1);

    const springFwd = nextRelativeRun(rel(0, 9), '2026-03-08', PAST, tz)!;
    expect(localDay(springFwd, tz)).toBe('2026-03-08');
    expect(localHour(springFwd, tz)).toBe(9);
  });

  it('returns null for an instant that has already passed', () => {
    const tz = 'America/New_York';
    expect(nextRelativeRun(rel(0, 9), '2020-06-15', new Date('2026-01-01T00:00:00Z'), tz)).toBeNull();
  });
});
