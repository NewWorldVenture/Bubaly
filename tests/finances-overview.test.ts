import { describe, it, expect } from 'vitest';
import {
  computeTotals, categorySpend, accountMonthlyChange, budgetProgress, budgetTotals,
  spendingByPerson, moneyTip, inMonth, type TxLike, type MemberLike,
} from '@/lib/finances/overview';

const NOW = new Date('2026-05-15T12:00:00');
function tx(o: Partial<TxLike>): TxLike {
  return { account_id: null, member_id: null, amount: 0, category: null, date: '2026-05-10', type: 'expense', ...o };
}

describe('inMonth', () => {
  it('matches month + year', () => {
    expect(inMonth('2026-05-01', 4, 2026)).toBe(true);
    expect(inMonth('2026-04-30', 4, 2026)).toBe(false);
  });
});

describe('computeTotals', () => {
  const accounts = [{ id: 'a', balance: 1000 }, { id: 'b', balance: 500.5 }];
  const rows = [
    tx({ type: 'income', amount: 4000, date: '2026-05-02' }),
    tx({ type: 'expense', amount: 1500, date: '2026-05-03' }),
    tx({ type: 'expense', amount: 500, date: '2026-05-04' }),
    tx({ type: 'income', amount: 3000, date: '2026-04-02' }),   // last month
    tx({ type: 'expense', amount: 2500, date: '2026-04-03' }),  // last month
  ];
  it('computes balance/income/expenses/savings + deltas', () => {
    const t = computeTotals(accounts, rows, NOW);
    expect(t.totalBalance).toBe(1500.5);
    expect(t.income).toBe(4000);
    expect(t.expenses).toBe(2000);
    expect(t.savings).toBe(2000);
    expect(t.incomeDelta).toBe(1000);   // 4000 - 3000
    expect(t.expensesDelta).toBe(-500); // 2000 - 2500
  });
});

describe('categorySpend', () => {
  it('groups + sorts + percentages, ignoring income', () => {
    const rows = [
      tx({ category: 'Housing', amount: 1650 }),
      tx({ category: 'Groceries', amount: 840 }),
      tx({ category: 'Groceries', amount: 160 }),
      tx({ type: 'income', category: 'Salary', amount: 5000 }),
    ];
    const slices = categorySpend(rows);
    expect(slices[0]).toMatchObject({ label: 'Housing', amount: 1650 });
    expect(slices[1]).toMatchObject({ label: 'Groceries', amount: 1000 });
    const totalPct = slices.reduce((s, x) => s + x.pct, 0);
    expect(totalPct).toBeGreaterThanOrEqual(99);
    expect(slices[0].emoji).toBe('🏠');
  });
  it('collapses the tail into Other', () => {
    const rows = Array.from({ length: 10 }, (_, i) => tx({ category: `C${i}`, amount: 100 - i }));
    const slices = categorySpend(rows, 3);
    expect(slices.some((s) => s.label === 'Other')).toBe(true);
    expect(slices.length).toBeLessThanOrEqual(4);
  });
  it('returns [] with no expenses', () => {
    expect(categorySpend([tx({ type: 'income', amount: 5 })])).toEqual([]);
  });
});

describe('accountMonthlyChange', () => {
  it('nets income minus expenses for one account this month', () => {
    const rows = [
      tx({ account_id: 'x', type: 'income', amount: 500, date: '2026-05-01' }),
      tx({ account_id: 'x', type: 'expense', amount: 200, date: '2026-05-02' }),
      tx({ account_id: 'y', type: 'expense', amount: 999, date: '2026-05-02' }),
      tx({ account_id: 'x', type: 'expense', amount: 999, date: '2026-04-02' }), // last month
    ];
    expect(accountMonthlyChange('x', rows, NOW)).toBe(300);
  });
});

describe('budgetProgress + budgetTotals', () => {
  const budgets = [{ id: 'h', category: 'Housing', amount: 2000 }, { id: 'g', category: 'Groceries', amount: 500 }];
  const rows = [tx({ category: 'Housing', amount: 1650 }), tx({ category: 'Groceries', amount: 600 })];
  it('per-budget progress + over flag', () => {
    const p = budgetProgress(budgets, rows);
    expect(p[0]).toMatchObject({ spent: 1650, over: false });
    expect(p[1]).toMatchObject({ spent: 600, over: true, pct: 100 });
  });
  it('totals', () => {
    expect(budgetTotals(budgets, rows)).toEqual({ spent: 2250, total: 2500, pct: 90 });
  });
});

describe('spendingByPerson', () => {
  const members: MemberLike[] = [
    { id: 'm1', display_name: 'Jordan', color: '#7c5dff' },
    { id: 'm2', display_name: 'Sarah', color: '#f472b6' },
    { id: 'm3', display_name: 'Liam', color: '#34d399' },
  ];
  it('attributes expenses to members, sorted desc, dropping zero + null', () => {
    const rows = [
      tx({ member_id: 'm1', amount: 1850 }),
      tx({ member_id: 'm2', amount: 1320 }),
      tx({ member_id: null, amount: 9999 }),           // unattributed → ignored
      tx({ member_id: 'm1', type: 'income', amount: 5000 }), // income → ignored
    ];
    const r = spendingByPerson(rows, members);
    expect(r.map((x) => x.member.id)).toEqual(['m1', 'm2']);
    expect(r[0].amount).toBe(1850);
    expect(r[0].pct + r[1].pct).toBeGreaterThanOrEqual(99);
  });
  it('returns [] when nothing attributed', () => {
    expect(spendingByPerson([tx({ member_id: null, amount: 5 })], members)).toEqual([]);
  });
});

describe('moneyTip', () => {
  it('celebrates a dining-out reduction', () => {
    const rows = [
      tx({ category: 'Dining Out', amount: 400, date: '2026-05-03' }),
      tx({ category: 'Dining Out', amount: 500, date: '2026-04-03' }),
    ];
    expect(moneyTip(rows, NOW)).toContain('less on dining out');
  });
  it('returns null without a prior month baseline', () => {
    expect(moneyTip([tx({ category: 'Dining Out', amount: 400, date: '2026-05-03' })], NOW)).toBeNull();
  });
});
