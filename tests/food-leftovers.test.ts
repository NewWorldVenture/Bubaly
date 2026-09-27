import { describe, it, expect } from 'vitest';
import {
  leftoverUrgency, activeLeftovers, leftoverNudge, urgentLeftoverCount, type LeftoverLike,
} from '@/lib/food/leftovers';
import { dayKeyIn } from '@/lib/time/zoned';

// A day KEY. The old fixture built dates with `new Date('...T12:00:00')` (no Z)
// and `setDate` + `toISOString`, so what these assertions meant depended on the
// TZ the suite happened to run under — which is why CI runs it under two.
const TODAY = '2026-06-27';
const day = (offset: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);

describe('leftoverUrgency', () => {
  it('flags past use-by as expired', () => {
    expect(leftoverUrgency(day(-2), TODAY).suggestion).toBe('expired');
  });
  it('says eat today / tomorrow / soon', () => {
    expect(leftoverUrgency(day(0), TODAY).suggestion).toBe('eat_now');
    expect(leftoverUrgency(day(1), TODAY).suggestion).toBe('eat_soon');
    expect(leftoverUrgency(day(2), TODAY).suggestion).toBe('eat_soon');
  });
  it('suggests freezing in the 3-4 day window', () => {
    expect(leftoverUrgency(day(4), TODAY).suggestion).toBe('freeze');
  });
  it('is ok when there is plenty of time or no date', () => {
    expect(leftoverUrgency(day(10), TODAY).suggestion).toBe('ok');
    expect(leftoverUrgency(null, TODAY).suggestion).toBe('ok');
  });
});

describe('activeLeftovers', () => {
  const items: LeftoverLike[] = [
    { name: 'rice', use_by: day(5), status: 'fresh' },
    { name: 'chicken', use_by: day(0), status: 'fresh' },
    { name: 'soup', use_by: day(2), status: 'fresh' },
    { name: 'old pasta', use_by: day(-3), status: 'eaten' }, // excluded (not fresh)
  ];
  it('returns only fresh, most-urgent first', () => {
    const a = activeLeftovers(items, TODAY);
    expect(a.map((x) => x.name)).toEqual(['chicken', 'soup', 'rice']);
  });
});

describe('leftoverNudge', () => {
  it('nudges to eat the most urgent first', () => {
    const nudge = leftoverNudge([{ source_meal: 'roast chicken', use_by: day(0), status: 'fresh' }], TODAY);
    expect(nudge).toContain('roast chicken');
    expect(nudge).toContain('today');
  });
  it('returns null with no active leftovers', () => {
    expect(leftoverNudge([{ name: 'x', status: 'eaten', use_by: day(1) }], TODAY)).toBeNull();
  });
});

describe('urgentLeftoverCount', () => {
  it('counts eat-now/soon/expired fresh items', () => {
    const items: LeftoverLike[] = [
      { name: 'a', use_by: day(0), status: 'fresh' },   // eat_now
      { name: 'b', use_by: day(1), status: 'fresh' },   // eat_soon
      { name: 'c', use_by: day(10), status: 'fresh' },  // ok
      { name: 'd', use_by: day(-1), status: 'fresh' },  // expired
    ];
    expect(urgentLeftoverCount(items, TODAY)).toBe(3);
  });
});

/**
 * Dinner is the evening. This module's whole subject is what to eat TONIGHT, so
 * the one instant at which it is most often consulted is exactly the one where
 * the host's day and the family's day disagree — and every assertion above is
 * written at a time where they agree, so none of them can see it.
 */
describe('leftovers due tomorrow are not urgent at dinner tonight', () => {
  // 2026-06-27T19:00 in Los Angeles === 2026-06-28T02:00Z.
  const DINNERTIME_IN_LA = new Date('2026-06-28T02:00:00Z');
  const todayKey = dayKeyIn(DINNERTIME_IN_LA, 'America/Los_Angeles');

  it('is still the 27th for the family sitting down to eat', () => {
    expect(todayKey).toBe('2026-06-27');
    expect(DINNERTIME_IN_LA.toISOString().slice(0, 10)).toBe('2026-06-28');
  });

  it('does not tell the family to eat the 28th’s food tonight', () => {
    expect(leftoverUrgency('2026-06-28', todayKey).suggestion).toBe('eat_soon');
    expect(leftoverUrgency('2026-06-28', todayKey).label).toBe('Eat tomorrow');
  });

  it('does not declare tonight’s food already past its use-by', () => {
    const u = leftoverUrgency('2026-06-27', todayKey);
    expect(u.suggestion).toBe('eat_now');
    expect(u.label).toBe('Eat today');
  });

  it('nudges about the right dish', () => {
    const nudge = leftoverNudge([
      { source_meal: 'lasagne', use_by: '2026-06-27', status: 'fresh' },
      { source_meal: 'chilli', use_by: '2026-06-28', status: 'fresh' },
    ], todayKey);
    expect(nudge).toBe('Eat lasagne today before it goes bad.');
  });
});
