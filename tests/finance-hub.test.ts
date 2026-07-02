import { describe, it, expect } from 'vitest';
import { usd, billDueStatus, periodStart, budgetSpent, pct } from '@/lib/finance/hub';

describe('usd', () => {
  it('formats dollars', () => { expect(usd(1234.5)).toBe('$1,234.50'); });
});

describe('billDueStatus', () => {
  const now = new Date('2025-06-10T12:00:00');
  it('paid wins', () => { expect(billDueStatus({ due_date: '2025-06-01', status: 'paid' }, now)).toBe('paid'); });
  it('overdue when past', () => { expect(billDueStatus({ due_date: '2025-06-05', status: 'upcoming' }, now)).toBe('overdue'); });
  it('due soon within 7 days', () => { expect(billDueStatus({ due_date: '2025-06-15', status: 'upcoming' }, now)).toBe('due_soon'); });
  it('upcoming beyond 7 days', () => { expect(billDueStatus({ due_date: '2025-07-01', status: 'upcoming' }, now)).toBe('upcoming'); });
});

describe('periodStart', () => {
  const now = new Date('2025-06-10T12:00:00'); // Tuesday
  it('monthly → 1st', () => { expect(periodStart('monthly', now)).toBe('2025-06-01'); });
  it('yearly → Jan 1', () => { expect(periodStart('yearly', now)).toBe('2025-01-01'); });
  it('weekly → Sunday', () => { expect(periodStart('weekly', now)).toBe('2025-06-08'); });
});

describe('budgetSpent', () => {
  const now = new Date('2025-06-10T12:00:00');
  const txns = [
    { type: 'expense', category: 'Groceries', amount: 45.5, date: '2025-06-02' },
    { type: 'expense', category: 'groceries', amount: 30, date: '2025-06-09' }, // case-insensitive
    { type: 'expense', category: 'Groceries', amount: 99, date: '2025-05-20' },  // last month → excluded
    { type: 'income', category: 'Groceries', amount: 100, date: '2025-06-05' },  // not expense
    { type: 'expense', category: 'Dining', amount: 20, date: '2025-06-05' },     // other cat
  ];
  it('sums current-period expenses for the category', () => {
    expect(budgetSpent(txns, 'Groceries', 'monthly', now)).toBe(75.5);
  });
});

describe('pct', () => {
  it('clamps 0..100', () => {
    expect(pct(50, 200)).toBe(25);
    expect(pct(300, 200)).toBe(100);
    expect(pct(1, 0)).toBe(0);
  });
});
