import { describe, expect, it } from 'vitest';
import { addDaysToDayKey, dayKeyInTz, weekStartDayKey } from '@/lib/services/scope';

// A family's "today" is the day on their kitchen wall, not the day at
// Greenwich. `new Date().toISOString().slice(0, 10)` answers the second one,
// and the difference is not an edge case — measured across a full day:
//
//     America/Los_Angeles   420 min/day wrong  (29.2%)
//     Asia/Tokyo            540 min/day wrong  (37.5%)
//     Australia/Sydney      600 min/day wrong  (41.7%)
//
// which is every evening after 5pm for a Californian household.
describe('the family calendar day', () => {
  // 18:30 on Sunday in Los Angeles — an ordinary dinner time.
  const sundayDinner = new Date('2026-09-14T01:30:00Z');

  it('is the day on the wall, not the day at Greenwich', () => {
    expect(dayKeyInTz(sundayDinner, 'America/Los_Angeles')).toBe('2026-09-13');
    // What the UTC idiom answers, and why a meal-plan read returns tomorrow's
    // dinner while the family is eating tonight's.
    expect(sundayDinner.toISOString().slice(0, 10)).toBe('2026-09-14');
  });

  it('is ahead of Greenwich east of it, too', () => {
    const tokyoMorning = new Date('2026-09-13T22:00:00Z'); // 07:00 Monday in Tokyo
    expect(dayKeyInTz(tokyoMorning, 'Asia/Tokyo')).toBe('2026-09-14');
    expect(tokyoMorning.toISOString().slice(0, 10)).toBe('2026-09-13');
  });

  it('falls back to the UTC day rather than throwing on a bad zone', () => {
    expect(dayKeyInTz(sundayDinner, 'Not/AZone')).toBe('2026-09-14');
  });
});

describe('day-key arithmetic survives DST', () => {
  // US clocks go back on 01 November 2026, so that week is 169 hours. Adding
  // seven FIXED days therefore arrives an hour EARLY in local wall-clock —
  // 00:00 becomes 23:00 the previous evening, which formats as the day before.
  it('adds whole calendar days, not fixed milliseconds', () => {
    expect(addDaysToDayKey('2026-10-26', 7)).toBe('2026-11-02');

    // Measured, not assumed: from local midnight on 26 Oct, seven fixed days
    // land at 23:00 on 1 Nov — one day short of the calendar answer. The window
    // where this bites runs 26-31 Oct; a start outside it is unaffected, which
    // is exactly what makes the bug easy to miss when spot-checking one date.
    const byMillis = new Date(new Date('2026-10-26T00:00:00-07:00').getTime() + 7 * 86_400_000);
    expect(dayKeyInTz(byMillis, 'America/Los_Angeles')).toBe('2026-11-01');
  });

  // The spring transition moves the error the other way: a 167-hour week means
  // seven fixed days land an hour LATE, which stays inside the right day. Worth
  // pinning so the guard above is not mistaken for "DST always breaks it".
  it('is unharmed by the spring transition, which errs the other way', () => {
    expect(addDaysToDayKey('2026-03-05', 7)).toBe('2026-03-12');
    const byMillis = new Date(new Date('2026-03-05T00:00:00-08:00').getTime() + 7 * 86_400_000);
    expect(dayKeyInTz(byMillis, 'America/Los_Angeles')).toBe('2026-03-12');
  });

  it('moves backwards, and across month and year ends', () => {
    expect(addDaysToDayKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysToDayKey('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDaysToDayKey('2028-02-28', 1)).toBe('2028-02-29'); // leap year
  });

  it('leaves an unparseable key alone rather than inventing a date', () => {
    expect(addDaysToDayKey('not-a-day', 1)).toBe('not-a-day');
  });
});

describe('the week starts on Monday', () => {
  it('resolves each day of a week to the same Monday', () => {
    // 2026-09-14 is a Monday.
    for (const [day, expected] of [
      ['2026-09-14', '2026-09-14'], ['2026-09-15', '2026-09-14'],
      ['2026-09-18', '2026-09-14'], ['2026-09-20', '2026-09-14'], // Sunday
      ['2026-09-21', '2026-09-21'], // the next Monday
    ] as const) {
      expect(weekStartDayKey(day), day).toBe(expected);
    }
  });

  it('does not roll a Sunday evening into next week', () => {
    // The bug this guards: a UTC day key turns Sunday 18:30 in Los Angeles into
    // Monday, so "this week" silently became next week every Sunday evening.
    const sundayEvening = new Date('2026-09-14T01:30:00Z');
    expect(weekStartDayKey(dayKeyInTz(sundayEvening, 'America/Los_Angeles'))).toBe('2026-09-07');
    expect(weekStartDayKey(sundayEvening.toISOString().slice(0, 10))).toBe('2026-09-14');
  });
});
