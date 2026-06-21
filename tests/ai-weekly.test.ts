import { describe, it, expect } from 'vitest';
import {
  weekWindow, dayKey, choreCompletionRate, bucketByDay, dayLoad, weekRangeLabel,
} from '@/lib/ai/weekly';

describe('weekWindow', () => {
  const now = new Date('2026-06-20T14:30:00Z'); // a Saturday afternoon
  const w = weekWindow(now);

  it('starts the look-ahead at the beginning of today (UTC)', () => {
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
  const buckets = bucketByDay(events, (e) => e.starts_at, days);

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
    const b = bucketByDay([{ d: null }, { d: '2026-06-20T00:00:00Z' }], (x) => x.d, days);
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

describe('weekRangeLabel', () => {
  it('renders a "Mon D – Mon D" range from the window days', () => {
    const w = weekWindow(new Date('2026-06-20T14:30:00Z'));
    expect(weekRangeLabel(w)).toBe('Jun 20 – Jun 26');
  });
});
