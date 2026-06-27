import { describe, it, expect } from 'vitest';
import {
  leftoverUrgency, activeLeftovers, leftoverNudge, urgentLeftoverCount, type LeftoverLike,
} from '@/lib/food/leftovers';

const NOW = new Date('2026-06-27T12:00:00').getTime();
const day = (offset: number) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

describe('leftoverUrgency', () => {
  it('flags past use-by as expired', () => {
    expect(leftoverUrgency(day(-2), NOW).suggestion).toBe('expired');
  });
  it('says eat today / tomorrow / soon', () => {
    expect(leftoverUrgency(day(0), NOW).suggestion).toBe('eat_now');
    expect(leftoverUrgency(day(1), NOW).suggestion).toBe('eat_soon');
    expect(leftoverUrgency(day(2), NOW).suggestion).toBe('eat_soon');
  });
  it('suggests freezing in the 3-4 day window', () => {
    expect(leftoverUrgency(day(4), NOW).suggestion).toBe('freeze');
  });
  it('is ok when there is plenty of time or no date', () => {
    expect(leftoverUrgency(day(10), NOW).suggestion).toBe('ok');
    expect(leftoverUrgency(null, NOW).suggestion).toBe('ok');
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
    const a = activeLeftovers(items, NOW);
    expect(a.map((x) => x.name)).toEqual(['chicken', 'soup', 'rice']);
  });
});

describe('leftoverNudge', () => {
  it('nudges to eat the most urgent first', () => {
    const nudge = leftoverNudge([{ source_meal: 'roast chicken', use_by: day(0), status: 'fresh' }], NOW);
    expect(nudge).toContain('roast chicken');
    expect(nudge).toContain('today');
  });
  it('returns null with no active leftovers', () => {
    expect(leftoverNudge([{ name: 'x', status: 'eaten', use_by: day(1) }], NOW)).toBeNull();
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
    expect(urgentLeftoverCount(items, NOW)).toBe(3);
  });
});
