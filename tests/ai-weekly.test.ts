import { describe, it, expect } from 'vitest';
import {
  weekWindow, choreCompletionRate, bucketByDay, dayLoad, weekRangeLabel,
} from '@/lib/ai/weekly';

// Every day in this module is the FAMILY's day. It used to be UTC's — the
// window was built from getUTCFullYear/Month/Date and events were bucketed by
// `starts_at.slice(0, 10)` — so a household in Los Angeles asking for the week
// ahead at 6pm was told "today" is tomorrow, and every evening event in the
// Americas appeared on the wrong day. The zone is now required rather than
// defaulted, because a default is how it was wrong invisibly.
const LA = 'America/Los_Angeles';

describe('weekWindow', () => {
  const now = new Date('2026-06-20T14:30:00Z'); // a Saturday afternoon
  const w = weekWindow(now, 'UTC');

  it('starts the look-ahead at the beginning of today', () => {
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

describe('weekWindow means the family\u2019s day, not the host\u2019s', () => {
  // 6pm Saturday in Los Angeles is already Sunday in UTC. This is the instant
  // the old implementation got wrong, and it is the ordinary case: an evening,
  // which is when somebody plans their week.
  const saturdayEvening = new Date('2026-06-21T01:00:00Z');

  it('is still Saturday for a family in Los Angeles', () => {
    expect(weekWindow(saturdayEvening, LA).todayKey).toBe('2026-06-20');
  });

  it('and Sunday for a family in UTC, from the same instant', () => {
    expect(weekWindow(saturdayEvening, 'UTC').todayKey).toBe('2026-06-21');
  });

  it('opens the look-ahead at the family\u2019s midnight', () => {
    // 2026-06-20T00:00 Pacific is 07:00Z (PDT, UTC-7).
    expect(weekWindow(saturdayEvening, LA).aheadStart).toBe('2026-06-20T07:00:00.000Z');
  });

  it('keeps seven days across a spring-forward, rather than seven times 24 hours', () => {
    // US DST begins Sunday 2026-03-08. A window opened on the 5th spans it.
    const w = weekWindow(new Date('2026-03-05T20:00:00Z'), LA);
    expect(w.days).toEqual([
      '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08',
      '2026-03-09', '2026-03-10', '2026-03-11',
    ]);
    // The last day ends at a real local midnight (PDT, UTC-7) — not at the
    // PST-derived instant a fixed 7 x 86,400,000 would have produced.
    expect(w.aheadEnd).toBe('2026-03-12T06:59:59.999Z');
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

  it('puts an evening event on the evening\u2019s day, not the next UTC one', () => {
    // 7pm Pacific on the 20th is 2026-06-21T02:00Z. `.slice(0, 10)` called that
    // the 21st, which is how every evening commitment in the Americas landed a
    // day late in the briefing.
    const b = bucketByDay(
      [{ starts_at: '2026-06-21T02:00:00Z', title: 'Dinner' }],
      (e) => e.starts_at, days, LA,
    );
    expect(b['2026-06-20'].map((e) => e.title)).toEqual(['Dinner']);
    expect(b['2026-06-21']).toEqual([]);
  });

  it('leaves a date-only key alone, because it is already a calendar day', () => {
    // A `date` column has no instant to convert. Pushing '2026-06-21' through a
    // zone would shift it to the 20th — the same defect pointed backwards.
    const b = bucketByDay([{ d: '2026-06-21' }], (x) => x.d, days, LA);
    expect(b['2026-06-21'].length).toBe(1);
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

describe('weekRangeLabel', () => {
  it('renders a "Mon D – Mon D" range from the window days', () => {
    const w = weekWindow(new Date('2026-06-20T14:30:00Z'), 'UTC');
    expect(weekRangeLabel(w)).toBe('Jun 20 – Jun 26');
  });
});
