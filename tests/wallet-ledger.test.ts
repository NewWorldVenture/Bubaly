import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SPLIT, isValidSplit, normalizeSplit, allocate, signedValue,
  balanceFromLedger, bucketBalances, reversalOf, goalProgress, weeksToGoal, formatCents,
  type LedgerEntry, type Split,
} from '@/lib/wallet/ledger';

describe('isValidSplit / normalizeSplit', () => {
  it('accepts splits summing to 100', () => {
    expect(isValidSplit({ spend: 30, save: 50, give: 10, invest: 10 })).toBe(true);
  });
  it('rejects non-100, negative, or malformed splits', () => {
    expect(isValidSplit({ spend: 30, save: 50, give: 10, invest: 5 })).toBe(false);
    expect(isValidSplit({ spend: -10, save: 100, give: 0, invest: 10 })).toBe(false);
    expect(isValidSplit(null)).toBe(false);
    expect(isValidSplit({ spend: 100 } as Partial<Split>)).toBe(false);
  });
  it('normalizes invalid splits to the default', () => {
    expect(normalizeSplit(null)).toEqual(DEFAULT_SPLIT);
    expect(normalizeSplit({ spend: 1 })).toEqual(DEFAULT_SPLIT);
  });
});

describe('allocate — conserves every cent', () => {
  it('splits a clean amount by percentage', () => {
    // Grandma sends $50 with 50/30/10/10 (save/spend/give/invest)
    const a = allocate(5000, { spend: 30, save: 50, give: 10, invest: 10 });
    expect(a).toEqual({ spend: 1500, save: 2500, give: 500, invest: 500 });
    expect(a.spend + a.save + a.give + a.invest).toBe(5000);
  });
  it('distributes rounding remainder so parts always sum to the whole', () => {
    // 100 cents at 1/3-ish split → must still total exactly 100
    const a = allocate(100, { spend: 33, save: 33, give: 17, invest: 17 });
    expect(a.spend + a.save + a.give + a.invest).toBe(100);
  });
  it('never funds a 0% bucket', () => {
    const a = allocate(999, { spend: 100, save: 0, give: 0, invest: 0 });
    expect(a).toEqual({ spend: 999, save: 0, give: 0, invest: 0 });
  });
  it('handles zero and negative amounts safely', () => {
    expect(allocate(0)).toEqual({ spend: 0, save: 0, give: 0, invest: 0 });
    expect(allocate(-500)).toEqual({ spend: 0, save: 0, give: 0, invest: 0 });
  });
  it('is exhaustively cent-conserving across many amounts', () => {
    const split = { spend: 40, save: 40, give: 10, invest: 10 };
    for (let amt = 0; amt <= 1234; amt++) {
      const a = allocate(amt, split);
      expect(a.spend + a.save + a.give + a.invest).toBe(amt);
    }
  });
});

describe('signedValue / balanceFromLedger', () => {
  const e = (direction: 'credit' | 'debit', amount_cents: number, status = 'completed', bucket_kind?: LedgerEntry['bucket_kind']): LedgerEntry =>
    ({ direction, amount_cents, status, bucket_kind });

  it('credits add and debits subtract, only when completed', () => {
    expect(signedValue(e('credit', 1000))).toBe(1000);
    expect(signedValue(e('debit', 400))).toBe(-400);
    expect(signedValue(e('credit', 1000, 'pending'))).toBe(0);
    expect(signedValue(e('credit', 1000, 'requires_parent_approval'))).toBe(0);
  });
  it('derives the total balance from the ledger', () => {
    const ledger = [e('credit', 5000), e('debit', 1200), e('credit', 1000, 'pending'), e('credit', 300)];
    expect(balanceFromLedger(ledger)).toBe(4100); // pending excluded
  });
});

describe('bucketBalances', () => {
  it('sums per bucket; bucketless entries fall under spend', () => {
    const ledger: LedgerEntry[] = [
      { direction: 'credit', amount_cents: 2500, status: 'completed', bucket_kind: 'save' },
      { direction: 'credit', amount_cents: 1500, status: 'completed', bucket_kind: 'spend' },
      { direction: 'debit', amount_cents: 500, status: 'completed', bucket_kind: 'spend' },
      { direction: 'credit', amount_cents: 500, status: 'completed', bucket_kind: 'give' },
      { direction: 'credit', amount_cents: 999, status: 'completed' }, // no bucket → spend
    ];
    expect(bucketBalances(ledger)).toEqual({ spend: 1999, save: 2500, give: 500, invest: 0, goal: 0 });
  });
});

describe('reversalOf', () => {
  it('flips direction and points back at the original', () => {
    const r = reversalOf({ id: 'tx1', direction: 'credit', amount_cents: 1000, bucket_id: 'b1' });
    expect(r).toEqual({ reverses_id: 'tx1', direction: 'debit', amount_cents: 1000, type: 'reversal', status: 'completed', bucket_id: 'b1' });
  });
  it('a transaction plus its reversal nets to zero', () => {
    const original = { id: 'tx1', direction: 'credit' as const, amount_cents: 1000, bucket_id: null };
    const r = reversalOf(original);
    const net = balanceFromLedger([
      { direction: original.direction, amount_cents: original.amount_cents, status: 'completed' },
      { direction: r.direction, amount_cents: r.amount_cents, status: 'completed' },
    ]);
    expect(net).toBe(0);
  });
});

describe('goal math', () => {
  it('goalProgress is a clamped fraction', () => {
    expect(goalProgress(2500, 10000)).toBe(0.25);
    expect(goalProgress(15000, 10000)).toBe(1);
    expect(goalProgress(100, 0)).toBe(1);
  });
  it('weeksToGoal forecasts at a weekly rate', () => {
    // Liam is $42 from his bike goal, saving ~$14/wk → 3 weeks
    expect(weeksToGoal(5800, 10000, 1400)).toBe(3);
    expect(weeksToGoal(10000, 10000, 1400)).toBe(0); // already there
    expect(weeksToGoal(5000, 10000, 0)).toBeNull();   // never at $0/wk
  });
});

describe('formatCents', () => {
  it('shows whole dollars, and cents only when needed', () => {
    expect(formatCents(5000)).toBe('$50');
    expect(formatCents(4250)).toBe('$42.50');
    expect(formatCents(0)).toBe('$0');
  });
});
