import { describe, it, expect } from 'vitest';
import { daysUntilNext, upcomingCelebrations, countdownLabel } from '@/lib/celebrations/dates';

const now = new Date(2026, 5, 22); // 2026-06-22 (local)

describe('daysUntilNext', () => {
  it('returns 0 for today and rolls to next year for past dates', () => {
    expect(daysUntilNext('2000-06-22', now)).toBe(0);
    expect(daysUntilNext('06-23', now)).toBe(1);
    expect(daysUntilNext('06-21', now)).toBe(364); // already passed → next year
  });
  it('handles MM-DD and full dates, rejects junk', () => {
    expect(daysUntilNext('07-22', now)).toBe(30);
    expect(daysUntilNext('not-a-date', now)).toBeNull();
  });
});

describe('upcomingCelebrations', () => {
  it('filters to window, sorts soonest-first, computes turning age', () => {
    const out = upcomingCelebrations([
      { id: 'a', kind: 'birthday', title: 'Kid', date: '2016-06-25' },
      { id: 'b', kind: 'anniversary', title: 'Anniv', date: '2010-12-01' }, // far away
      { id: 'c', kind: 'birthday', title: 'Today', date: '1990-06-22' },
    ], 30, now);
    expect(out.map((c) => c.id)).toEqual(['c', 'a']); // b out of 30-day window
    expect(out[0].daysUntil).toBe(0);
    expect(out[1].turning).toBe(10); // 2026 - 2016
  });
});

describe('countdownLabel', () => {
  it('formats human countdowns', () => {
    expect(countdownLabel(0)).toBe('Today');
    expect(countdownLabel(1)).toBe('Tomorrow');
    expect(countdownLabel(5)).toBe('in 5 days');
    expect(countdownLabel(21)).toBe('in 3 weeks');
  });
});
