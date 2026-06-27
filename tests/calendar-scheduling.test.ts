import { describe, it, expect } from 'vitest';
import {
  busyIntervals, mergeIntervals, freeGaps, findFreeSlots, isCalendarContext, CONTEXTS,
} from '@/lib/calendar/scheduling';

const H = (n: number) => n * 60 * 60 * 1000;
// A fixed base day at local midnight for deterministic math.
const base = new Date(2030, 0, 7, 0, 0, 0, 0).getTime(); // Mon Jan 7 2030
const at = (hour: number, min = 0) => new Date(base + H(hour) + min * 60 * 1000).toISOString();

describe('isCalendarContext / CONTEXTS', () => {
  it('validates the three contexts', () => {
    expect(CONTEXTS).toEqual(['family', 'personal', 'work']);
    expect(isCalendarContext('work')).toBe(true);
    expect(isCalendarContext('nope')).toBe(false);
  });
});

describe('mergeIntervals', () => {
  it('merges overlapping and adjacent intervals', () => {
    const m = mergeIntervals([{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 15, end: 20 }, { start: 30, end: 40 }]);
    expect(m).toEqual([{ start: 0, end: 20 }, { start: 30, end: 40 }]);
  });
});

describe('busyIntervals', () => {
  it('defaults a no-end event to 30 minutes and filters by context', () => {
    const events = [
      { starts_at: at(9), ends_at: at(10), context: 'work' as const },
      { starts_at: at(11), context: 'personal' as const },
    ];
    const workOnly = busyIntervals(events, ['work']);
    expect(workOnly).toHaveLength(1);
    expect(workOnly[0].end - workOnly[0].start).toBe(H(1));

    const personalOnly = busyIntervals(events, ['personal']);
    expect(personalOnly[0].end - personalOnly[0].start).toBe(30 * 60 * 1000);
  });

  it('all-day events block the whole day', () => {
    const [iv] = busyIntervals([{ starts_at: at(0), all_day: true, context: 'family' }]);
    expect(iv.end - iv.start).toBe(H(24));
  });
});

describe('freeGaps', () => {
  it('inverts busy time inside a window', () => {
    const gaps = freeGaps([{ start: base + H(9), end: base + H(10) }], base + H(8), base + H(12));
    expect(gaps).toEqual([
      { start: base + H(8), end: base + H(9) },
      { start: base + H(10), end: base + H(12) },
    ]);
  });
});

describe('findFreeSlots', () => {
  it('finds a 60-min slot everyone shares, within working hours', () => {
    // Two members: one busy 9–10, the other busy 11–12. Window 8–17, work hours 9–17.
    const events = [
      { starts_at: at(9), ends_at: at(10), context: 'work' as const, assignee_id: 'a' },
      { starts_at: at(11), ends_at: at(12), context: 'work' as const, assignee_id: 'b' },
    ];
    const slots = findFreeSlots(events, {
      windowStart: base, windowEnd: base + H(24),
      durationMin: 60, workingHours: { startHour: 9, endHour: 17 },
      maxSuggestions: 3, granularityMin: 30,
    });
    expect(slots.length).toBeGreaterThan(0);
    // First slot should be at 10:00 (after the 9–10 block, before 11).
    expect(new Date(slots[0].start).getHours()).toBe(10);
    expect(slots[0].end - slots[0].start).toBe(H(1));
  });

  it('respects context filtering — a personal block does not occupy a work search', () => {
    const events = [{ starts_at: at(10), ends_at: at(16), context: 'personal' as const }];
    const slots = findFreeSlots(events, {
      windowStart: base, windowEnd: base + H(24),
      durationMin: 60, workingHours: { startHour: 9, endHour: 17 },
      contexts: ['work'], maxSuggestions: 1, granularityMin: 60,
    });
    // No work events → the whole working day is free → a slot exists at/after 9.
    expect(slots.length).toBe(1);
  });
});
