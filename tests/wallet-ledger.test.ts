import { describe, it, expect } from 'vitest';
import {
  splitTotal,
  totalBalance,
  bucketBalance,
  weeksToGoal,
  weeklyRate,
  rulesValid,
  walletSummary,
  fmtMoney,
  bucketLabel,
  bucketEmoji,
  DEFAULT_SPLIT,
} from '../lib/wallet/ledger';

const rules = (obj: Record<string, number>) =>
  Object.entries(obj).map(([bucket, pct]) => ({ bucket, pct }));

describe('splitTotal', () => {
  it('splits by default 50/30/10/10 allocation', () => {
    const result = splitTotal(10000, rules(DEFAULT_SPLIT));
    expect(result.get('save')).toBe(5000);
    expect(result.get('spend')).toBe(3000);
    expect(result.get('give')).toBe(1000);
    expect(result.get('invest')).toBe(1000);
  });

  it('handles rounding — all shares sum to total', () => {
    const result = splitTotal(333, rules({ save: 33, spend: 33, give: 34 }));
    const sum = [...result.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(333);
  });

  it('returns empty map for zero amount', () => {
    expect(splitTotal(0, rules(DEFAULT_SPLIT)).size).toBe(0);
  });

  it('returns empty map for empty rules', () => {
    expect(splitTotal(1000, []).size).toBe(0);
  });
});

describe('totalBalance', () => {
  const buckets = [
    { member_id: 'm1', bucket: 'save', balance_cents: 500, target_cents: null },
    { member_id: 'm1', bucket: 'spend', balance_cents: 300, target_cents: null },
    { member_id: 'm2', bucket: 'save', balance_cents: 200, target_cents: null },
  ];

  it('returns total for a specific member', () => {
    expect(totalBalance(buckets, 'm1')).toBe(800);
  });

  it('returns grand total when no member specified', () => {
    expect(totalBalance(buckets)).toBe(1000);
  });
});

describe('bucketBalance', () => {
  it('returns the balance for a specific bucket', () => {
    const buckets = [{ member_id: 'm1', bucket: 'save', balance_cents: 1234, target_cents: null }];
    expect(bucketBalance(buckets, 'm1', 'save')).toBe(1234);
  });

  it('returns 0 for missing bucket', () => {
    expect(bucketBalance([], 'm1', 'save')).toBe(0);
  });
});

describe('weeksToGoal', () => {
  it('calculates weeks remaining', () => {
    expect(weeksToGoal(5000, 10000, 1000)).toBe(5);
  });

  it('returns 0 when goal already reached', () => {
    expect(weeksToGoal(10000, 10000, 1000)).toBe(0);
  });

  it('returns null when rate is zero', () => {
    expect(weeksToGoal(5000, 10000, 0)).toBeNull();
  });

  it('rounds up partial weeks', () => {
    expect(weeksToGoal(0, 1001, 500)).toBe(3);
  });
});

describe('weeklyRate', () => {
  it('calculates average weekly credits', () => {
    const now = new Date();
    const txns = [
      { member_id: 'm1', bucket: 'save', amount_cents: 2000, kind: 'deposit', created_at: now.toISOString() },
      { member_id: 'm1', bucket: 'save', amount_cents: 2000, kind: 'deposit', created_at: now.toISOString() },
    ];
    expect(weeklyRate(txns, 'm1', 'save', 4)).toBe(1000);
  });

  it('ignores debits', () => {
    const now = new Date();
    const txns = [
      { member_id: 'm1', bucket: 'save', amount_cents: -500, kind: 'withdrawal', created_at: now.toISOString() },
    ];
    expect(weeklyRate(txns, 'm1', 'save', 4)).toBe(0);
  });
});

describe('rulesValid', () => {
  it('validates rules summing to 100', () => {
    expect(rulesValid(rules(DEFAULT_SPLIT))).toBe(true);
  });

  it('rejects rules not summing to 100', () => {
    expect(rulesValid(rules({ save: 50, spend: 30 }))).toBe(false);
  });

  it('rejects negative percentages', () => {
    expect(rulesValid([{ bucket: 'save', pct: -10 }, { bucket: 'spend', pct: 110 }])).toBe(false);
  });
});

describe('walletSummary', () => {
  it('produces a summary with goal progress', () => {
    const buckets = [
      { member_id: 'm1', bucket: 'save', balance_cents: 5000, target_cents: 10000 },
      { member_id: 'm1', bucket: 'spend', balance_cents: 3000, target_cents: null },
    ];
    const s = walletSummary(buckets, 'm1');
    expect(s.totalCents).toBe(8000);
    expect(s.topBucket).toBe('save');
    expect(s.goalProgress).toHaveLength(1);
    expect(s.goalProgress[0].pct).toBe(50);
  });
});

describe('helpers', () => {
  it('fmtMoney formats cents as USD', () => {
    expect(fmtMoney(12345)).toBe('$123.45');
  });

  it('bucketLabel returns label for known buckets', () => {
    expect(bucketLabel('save')).toBe('Save');
    expect(bucketLabel('custom')).toBe('Custom');
  });

  it('bucketEmoji returns emoji for known buckets', () => {
    expect(bucketEmoji('give')).toBe('💝');
    expect(bucketEmoji('custom')).toBe('💰');
  });
});
