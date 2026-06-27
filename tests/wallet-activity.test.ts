import { describe, expect, it } from 'vitest';
import { txnTypeLabel, signedAmountCents, filterTxns, groupByDay, netCents, type ActivityTxn } from '@/lib/wallet/activity';

const t = (over: Partial<ActivityTxn>): ActivityTxn => ({
  id: Math.random().toString(36).slice(2), child_wallet_id: 'c1', type: 'parent_top_up', status: 'completed',
  direction: 'credit', amount_cents: 1000, description: null, created_at: '2026-06-24T10:00:00Z', ...over,
});

describe('txnTypeLabel', () => {
  it('maps known + falls back', () => {
    expect(txnTypeLabel('chore_reward')).toBe('Chore reward');
    expect(txnTypeLabel('gift_received')).toBe('Gift');
    expect(txnTypeLabel('mystery_type')).toBe('mystery type');
  });
});

describe('signedAmountCents', () => {
  it('credit +, debit -', () => {
    expect(signedAmountCents({ direction: 'credit', amount_cents: 500 })).toBe(500);
    expect(signedAmountCents({ direction: 'debit', amount_cents: 500 })).toBe(-500);
  });
});

describe('filterTxns', () => {
  const rows = [t({ child_wallet_id: 'c1', type: 'allowance', direction: 'credit' }), t({ child_wallet_id: 'c2', type: 'goal_transfer', direction: 'debit' })];
  it('filters by child/type/direction', () => {
    expect(filterTxns(rows, { childWalletId: 'c2' })).toHaveLength(1);
    expect(filterTxns(rows, { type: 'allowance' })[0].child_wallet_id).toBe('c1');
    expect(filterTxns(rows, { direction: 'debit' })[0].child_wallet_id).toBe('c2');
    expect(filterTxns(rows, {})).toHaveLength(2);
  });
});

describe('groupByDay', () => {
  it('groups newest day first', () => {
    const g = groupByDay([t({ created_at: '2026-06-20T09:00:00Z' }), t({ created_at: '2026-06-24T09:00:00Z' }), t({ created_at: '2026-06-24T08:00:00Z' })]);
    expect(g.map((x) => x.date)).toEqual(['2026-06-24', '2026-06-20']);
    expect(g[0].txns).toHaveLength(2);
  });
});

describe('netCents', () => {
  it('credits minus debits, completed only', () => {
    expect(netCents([t({ amount_cents: 1000, direction: 'credit' }), t({ amount_cents: 300, direction: 'debit' }), t({ amount_cents: 999, status: 'pending' })])).toBe(700);
  });
});
