import { describe, expect, it } from 'vitest';
import { txnTypeLabel, signedAmountCents, filterTxns, groupByDay, netCents, toStatementCsv, statementFilename, type ActivityTxn } from '@/lib/wallet/activity';

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

describe('toStatementCsv', () => {
  const rows = [
    // newest-first
    { ...t({ id: 'n', amount_cents: 300, direction: 'debit', type: 'card_spend', description: 'Snacks', created_at: '2026-06-25T14:30:00Z' }), childName: 'Mia' },
    { ...t({ id: 'o', amount_cents: 1000, direction: 'credit', type: 'allowance', description: null, created_at: '2026-06-24T09:00:00Z' }), childName: 'Mia' },
  ];

  it('emits a header + one row per txn, CRLF-joined', () => {
    const lines = toStatementCsv(rows).split('\r\n');
    expect(lines[0]).toBe('Date,Time,Type,Description,Child,Direction,Amount,Status,Balance');
    expect(lines).toHaveLength(3);
  });

  it('runs the balance oldest→newest so the newest row shows the current total', () => {
    const lines = toStatementCsv(rows).split('\r\n');
    // oldest (+10.00) → balance 10.00; newest (−3.00) → balance 7.00
    expect(lines[1]).toBe('2026-06-25,14:30:00,Card spend,Snacks,Mia,out,-3.00,completed,7.00');
    expect(lines[2]).toBe('2026-06-24,09:00:00,Allowance,,Mia,in,10.00,completed,10.00');
  });

  it('excludes non-completed rows from the running balance', () => {
    const withPending = [
      { ...t({ id: 'p', amount_cents: 5000, direction: 'credit', status: 'pending', created_at: '2026-06-26T10:00:00Z' }), childName: null },
      ...rows,
    ];
    const lines = toStatementCsv(withPending).split('\r\n');
    // pending row keeps the prior balance (7.00), not 57.00
    expect(lines[1].endsWith(',pending,7.00')).toBe(true);
  });

  it('escapes commas and quotes per RFC 4180', () => {
    const csv = toStatementCsv([{ ...t({ id: 'x', description: 'Lunch, "the good" one' }), childName: null }]);
    expect(csv.split('\r\n')[1]).toContain('"Lunch, ""the good"" one"');
  });
});

describe('statementFilename', () => {
  it('is date-stamped', () => {
    expect(statementFilename(new Date('2026-07-03T12:00:00Z'))).toBe('bubaly-wallet-statement-2026-07-03.csv');
  });
});
