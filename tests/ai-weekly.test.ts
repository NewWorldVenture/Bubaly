import { describe, it, expect } from 'vitest';
import {
  weekWindow, dayKey, choreCompletionRate, bucketByDay, dayLoad, weekRangeLabel,
} from '@/lib/ai/weekly';

describe('weekWindow', () => {
  const now = new Date('2026-06-20T14:30:00Z'); // a Saturday afternoon
  const w = weekWindow(now, 'UTC');

  it('starts the look-ahead at the beginning of today in the zone it was given', () => {
    expect(w.todayKey).toBe('2026-06-20');
    expect(w.aheadStart).toBe('2026-06-20T00:00:00.000Z');
  });

  it('produces seven consecutive upcoming day-keys, today first', () => {
    expect(w.days).toEqual([
      '2026-06-20', '2026-06-21', '2026-06-22', '2026-06-23',
      '2026-06-24', '2026-06-25', '2026-06-26',
    ]);
  });

  it('ends the look-ahead at the end of today+6', () => {
    expect(w.aheadEnd).toBe('2026-06-26T23:59:59.999Z');
  });

  it('recap window is the previous seven days, ending yesterday', () => {
    expect(w.recapStart).toBe('2026-06-13T00:00:00.000Z');
    expect(w.recapEnd).toBe('2026-06-19T23:59:59.999Z');
  });

  it('look-ahead and recap windows do not overlap', () => {
    expect(new Date(w.recapEnd).getTime()).toBeLessThan(new Date(w.aheadStart).getTime());
  });
});

describe('dayKey', () => {
  it('formats a UTC date as YYYY-MM-DD', () => {
    expect(dayKey(new Date('2026-01-05T23:59:00Z'))).toBe('2026-01-05');
  });
});

describe('choreCompletionRate', () => {
  it('returns 0 for an empty set', () => {
    expect(choreCompletionRate([])).toBe(0);
  });

  it('counts done/approved/completed as complete', () => {
    const rate = choreCompletionRate([
      { status: 'done' }, { status: 'approved' }, { status: 'completed' },
      { status: 'todo' }, { status: 'in_progress' },
    ]);
    expect(rate).toBe(60);
  });

  it('rounds to the nearest percent', () => {
    expect(choreCompletionRate([{ status: 'done' }, { status: 'todo' }, { status: 'todo' }])).toBe(33);
  });
});

describe('bucketByDay', () => {
  const days = ['2026-06-20', '2026-06-21', '2026-06-22'];
  const events = [
    { starts_at: '2026-06-20T09:00:00Z', title: 'A' },
    { starts_at: '2026-06-20T18:00:00Z', title: 'B' },
    { starts_at: '2026-06-22T08:00:00Z', title: 'C' },
    { starts_at: '2026-07-01T08:00:00Z', title: 'OutOfRange' },
  ];
  const buckets = bucketByDay(events, (e) => e.starts_at, days, 'UTC');

  it('includes every requested day, even empty ones', () => {
    expect(Object.keys(buckets).sort()).toEqual(days);
    expect(buckets['2026-06-21']).toEqual([]);
  });

  it('groups items into the right day and drops out-of-range items', () => {
    expect(buckets['2026-06-20'].map((e) => e.title)).toEqual(['A', 'B']);
    expect(buckets['2026-06-22'].map((e) => e.title)).toEqual(['C']);
    const total = Object.values(buckets).flat().length;
    expect(total).toBe(3); // OutOfRange dropped
  });

  it('ignores items with a missing date key', () => {
    const b = bucketByDay([{ d: null }, { d: '2026-06-20T00:00:00Z' }], (x) => x.d, days, 'UTC');
    expect(b['2026-06-20'].length).toBe(1);
  });
});

describe('dayLoad', () => {
  it('labels by event count', () => {
    expect(dayLoad(0)).toBe('light');
    expect(dayLoad(1)).toBe('light');
    expect(dayLoad(2)).toBe('moderate');
    expect(dayLoad(4)).toBe('moderate');
    expect(dayLoad(5)).toBe('heavy');
  });
});

// The reason this module took a `tz` at all. Its header used to say every date
// was a UTC day-key "matching the convention used by the daily-briefing route",
// and that route moved to the family's zone seven weeks later without this one
// following. These are the two ways a family in Los Angeles saw the difference.
describe('the week is the family\u2019s week, not Greenwich\u2019s', () => {
  const LA = 'America/Los_Angeles';
  // 17:30 on Saturday 20 June in Los Angeles — already Sunday the 21st at
  // Greenwich, which is the window in which the whole grid slipped a day.
  const saturdayEvening = new Date('2026-06-21T00:30:00Z');

  it('is still Saturday for the family when Greenwich has rolled over', () => {
    expect(weekWindow(saturdayEvening, LA).todayKey).toBe('2026-06-20');
    expect(weekWindow(saturdayEvening, 'UTC').todayKey).toBe('2026-06-21');
  });

  it('opens the window at the family\u2019s midnight, not at 17:00 the day before', () => {
    // Midnight on 20 June in Los Angeles is 07:00 UTC.
    expect(weekWindow(saturdayEvening, LA).aheadStart).toBe('2026-06-20T07:00:00.000Z');
  });

  it('puts a 21:00 Saturday game under Saturday', () => {
    const days = ['2026-06-20', '2026-06-21'];
    // 21:00 Saturday in Los Angeles is 04:00 Sunday at Greenwich.
    const game = [{ starts_at: '2026-06-21T04:00:00Z', title: 'Soccer' }];
    expect(bucketByDay(game, (e) => e.starts_at, days, LA)['2026-06-20']).toHaveLength(1);
    // And this is what it did before, kept as an assertion so the two cannot
    // quietly become the same answer.
    expect(bucketByDay(game, (e) => e.starts_at, days, 'UTC')['2026-06-21']).toHaveLength(1);
  });

  // A seven-day week that crosses a DST boundary still has seven distinct days.
  // A `+ 86_400_000` step repeats one in a 25-hour week and skips one in a
  // 23-hour week; advancing the day KEY cannot.
  it.each([
    ['spring forward', '2026-03-06T18:00:00Z', '2026-03-06'],
    ['fall back', '2026-10-30T18:00:00Z', '2026-10-30'],
  ])('crosses a DST boundary with seven distinct days (%s)', (_label, iso, firstKey) => {
    const w = weekWindow(new Date(iso), 'America/New_York');
    expect(w.days[0]).toBe(firstKey);
    expect(new Set(w.days).size).toBe(7);
    // Consecutive, by calendar rather than by arithmetic on instants.
    for (let i = 1; i < w.days.length; i += 1) {
      const prev = new Date(`${w.days[i - 1]}T00:00:00Z`);
      prev.setUTCDate(prev.getUTCDate() + 1);
      expect(w.days[i]).toBe(prev.toISOString().slice(0, 10));
    }
  });

  // Non-vacuity floor: every case above compares a zoned answer against a UTC
  // one, and all of them pass trivially if `tz` is ignored and both collapse.
  it('the zone changes the answer at all, or none of the above is a test', () => {
    expect(weekWindow(saturdayEvening, LA).todayKey)
      .not.toBe(weekWindow(saturdayEvening, 'UTC').todayKey);
    expect(weekWindow(saturdayEvening, LA).aheadStart)
      .not.toBe(weekWindow(saturdayEvening, 'UTC').aheadStart);
  });
});

describe('weekRangeLabel', () => {
  it('renders a "Mon D – Mon D" range from the window days', () => {
    const w = weekWindow(new Date('2026-06-20T14:30:00Z'), 'UTC');
    expect(weekRangeLabel(w)).toBe('Jun 20 – Jun 26');
  });
});
