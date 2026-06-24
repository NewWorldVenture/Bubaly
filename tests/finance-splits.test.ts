import { describe, expect, it } from 'vitest';
import {
  usd, splitEvenly, memberBalances, settlementSuggestions, owedByMember, summarizeSplits,
  type SplitLike, type ShareLike,
} from '@/lib/finance/splits';

describe('usd / splitEvenly', () => {
  it('formats cents', () => {
    expect(usd(1234)).toBe('$12.34');
  });
  it('splits with cent-accurate remainder', () => {
    const m = splitEvenly(1000, ['a', 'b', 'c']); // 10.00 / 3
    expect([...m.values()].reduce((s, x) => s + x, 0)).toBe(1000);
    expect(m.get('a')).toBe(334);
    expect(m.get('b')).toBe(333);
    expect(m.get('c')).toBe(333);
  });
  it('handles empty', () => {
    expect(splitEvenly(100, []).size).toBe(0);
  });
});

const splits: SplitLike[] = [
  { id: 's1', total_cents: 3000, paid_by: 'a' }, // a paid 30.00, split a/b/c = 1000 each
];
const shares: ShareLike[] = [
  { split_id: 's1', member_id: 'a', share_cents: 1000, settled: false },
  { split_id: 's1', member_id: 'b', share_cents: 1000, settled: false },
  { split_id: 's1', member_id: 'c', share_cents: 1000, settled: false },
];

describe('memberBalances', () => {
  it('payer is owed others shares, own share excluded', () => {
    const net = memberBalances(splits, shares);
    expect(net.get('a')).toBe(2000);  // owed by b + c
    expect(net.get('b')).toBe(-1000);
    expect(net.get('c')).toBe(-1000);
  });
  it('settled shares drop out', () => {
    const net = memberBalances(splits, shares.map((s) => s.member_id === 'b' ? { ...s, settled: true } : s));
    expect(net.get('a')).toBe(1000);
    expect(net.get('b') ?? 0).toBe(0);
  });
});

describe('settlementSuggestions / owedByMember', () => {
  it('produces minimal transfers to creditors', () => {
    const net = memberBalances(splits, shares);
    const t = settlementSuggestions(net);
    expect(t).toHaveLength(2);
    expect(t.every((x) => x.to === 'a')).toBe(true);
    expect(t.reduce((s, x) => s + x.cents, 0)).toBe(2000);
  });
  it('owedByMember', () => {
    const net = memberBalances(splits, shares);
    expect(owedByMember('b', net)).toBe(1000);
    expect(owedByMember('a', net)).toBe(0);
  });
});

describe('summarizeSplits', () => {
  it('totals + unsettled', () => {
    expect(summarizeSplits(splits, shares)).toEqual({ count: 1, totalCents: 3000, unsettledCents: 3000 });
  });
});
