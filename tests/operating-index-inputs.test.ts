import { describe, it, expect } from 'vitest';
import { budgetWindowSpan, countOverspentBudgets, type BudgetRow } from '@/lib/operating-index/inputs';

const today = '2026-07-15'; // Wed 15 Jul 2026, the family's day

let seq = 0;
const budget = (category: string, amount: number, period: BudgetRow['period'], created_at = '2026-01-01T00:00:00Z'): BudgetRow =>
  ({ id: `b-${++seq}`, category, amount, period, created_at });

describe('budgetWindowSpan', () => {
  it('is the year when every period sits inside it', () => {
    expect(budgetWindowSpan(today)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
  it('reaches back to the Sunday a week began in December', () => {
    // Fri 1 Jan 2027: its week began on Sunday 27 December.
    expect(budgetWindowSpan('2027-01-01')).toEqual({ from: '2026-12-27', to: '2027-12-31' });
  });
  it('reaches on to the Saturday a week ends in January', () => {
    // Thu 31 Dec 2026: its week ends on Saturday 2 January.
    expect(budgetWindowSpan('2026-12-31')).toEqual({ from: '2026-01-01', to: '2027-01-02' });
  });
});

describe('countOverspentBudgets', () => {
  const budgets = [
    budget('Groceries', 500, 'monthly'),
    budget('Dining', 150, 'monthly'),
  ];
  it('counts only categories over cap in the current window', () => {
    const expenses = [
      { category: 'Groceries', amount: 300, date: '2026-07-05' },
      { category: 'groceries', amount: 260, date: '2026-07-12' }, // case-insensitive → 560 > 500
      { category: 'Dining', amount: 40, date: '2026-07-10' },     // 40 < 150
      { category: 'Groceries', amount: 999, date: '2026-06-30' }, // prior month → excluded
    ];
    expect(countOverspentBudgets(budgets, expenses, today)).toBe(1);
  });
  it('is 0 when nothing is over', () => {
    expect(countOverspentBudgets(budgets, [{ category: 'Dining', amount: 10, date: '2026-07-14' }], today)).toBe(0);
  });
  it('ignores budgets with a non-positive cap', () => {
    expect(countOverspentBudgets([budget('x', 0, 'monthly')], [{ category: 'x', amount: 5, date: '2026-07-14' }], today)).toBe(0);
  });
  it('stops at the end of the period: next month\'s scheduled rent is not this month\'s', () => {
    const housing = [budget('Housing', 2000, 'monthly')];
    expect(countOverspentBudgets(housing, [
      { category: 'Housing', amount: 2000, date: '2026-07-01' },
      { category: 'Housing', amount: 2000, date: '2026-08-01' },
    ], today)).toBe(0);
  });
  it('a week is Sunday to Saturday', () => {
    // Sunday 12 July is this week's; Saturday 11 July was last week's.
    const weekly = [budget('Fun', 100, 'weekly')];
    expect(countOverspentBudgets(weekly, [{ category: 'Fun', amount: 150, date: '2026-07-12' }], today)).toBe(1);
    expect(countOverspentBudgets(weekly, [{ category: 'Fun', amount: 150, date: '2026-07-11' }], today)).toBe(0);
  });
  it('judges one budget per category, the oldest, not a later duplicate', () => {
    const withDuplicate = [budget('Housing', 2500, 'monthly'), budget('housing', 100, 'monthly', '2026-06-01T00:00:00Z')];
    expect(countOverspentBudgets(withDuplicate, [{ category: 'Housing', amount: 2000, date: '2026-07-01' }], today)).toBe(0);
    expect(countOverspentBudgets(withDuplicate, [{ category: 'Housing', amount: 2600, date: '2026-07-01' }], today)).toBe(1);
  });
});
