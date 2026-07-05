import { describe, it, expect } from 'vitest';
import { periodWindowStart, countOverspentBudgets, earliestWindowStart } from '@/lib/operating-index/inputs';

const now = new Date('2026-07-15T12:00:00Z'); // Wed 15 Jul 2026

describe('periodWindowStart', () => {
  it('monthly → first of month, yearly → Jan 1', () => {
    expect(periodWindowStart('monthly', now)).toBe('2026-07-01');
    expect(periodWindowStart('yearly', now)).toBe('2026-01-01');
  });
  it('weekly → Monday of the current week', () => {
    expect(periodWindowStart('weekly', now)).toBe('2026-07-13'); // Mon 13 Jul
  });
});

describe('countOverspentBudgets', () => {
  const budgets = [
    { category: 'Groceries', amount: 500, period: 'monthly' as const },
    { category: 'Dining', amount: 150, period: 'monthly' as const },
  ];
  it('counts only categories over cap in the current window', () => {
    const expenses = [
      { category: 'Groceries', amount: 300, date: '2026-07-05' },
      { category: 'groceries', amount: 260, date: '2026-07-12' }, // case-insensitive → 560 > 500
      { category: 'Dining', amount: 40, date: '2026-07-10' },     // 40 < 150
      { category: 'Groceries', amount: 999, date: '2026-06-30' }, // prior month → excluded
    ];
    expect(countOverspentBudgets(budgets, expenses, now)).toBe(1);
  });
  it('is 0 when nothing is over', () => {
    expect(countOverspentBudgets(budgets, [{ category: 'Dining', amount: 10, date: '2026-07-14' }], now)).toBe(0);
  });
  it('ignores budgets with a non-positive cap', () => {
    expect(countOverspentBudgets([{ category: 'x', amount: 0, period: 'monthly' }], [{ category: 'x', amount: 5, date: '2026-07-14' }], now)).toBe(0);
  });
});

describe('earliestWindowStart', () => {
  it('returns the earliest of mixed periods (yearly wins)', () => {
    expect(earliestWindowStart([
      { category: 'a', amount: 1, period: 'monthly' },
      { category: 'b', amount: 1, period: 'yearly' },
    ], now)).toBe('2026-01-01');
  });
  it('null when empty', () => {
    expect(earliestWindowStart([], now)).toBeNull();
  });
});
