import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GUARDED_TABLES } from './a-refused-write-is-not-a-success.test';

// SEC-017. `wallet_approve_gift` credits the wallet and amount a pending
// gift_payments row names at the moment a parent approves it — and any family
// member could rewrite that row. Measured with real sessions: Grandma's $50 for
// Sister became $500 for Brother, an invented $20,000 gift was credited beside
// it, and after the parent approved the queue Sister had $0.00 and Brother
// $20,500.00. The same gap let a child repoint a gift link or a Pay-ID and forge
// a savings goal as reached with no ledger behind it.
//
// The database half — the four breaches, every parent and public path as a
// control, and the general rule that nothing a money function reads may be
// rewritten by a non-manager — lives in docs/audit/money-decision-rows-check.sql
// and runs on every PR. This file pins the parts that could shrink quietly.

const TABLES = ['gift_links', 'gift_payments', 'pay_handles', 'wallet_goals'];
const migration = readFileSync('supabase/migrations/0329_the_rows_a_parents_money_decision_trusts.sql', 'utf8');
const probe = readFileSync('docs/audit/money-decision-rows-check.sql', 'utf8');

describe('a money decision row is parent-written (SEC-017)', () => {
  it('the migration guards all four tables, restrictively', () => {
    expect(migration).toContain(`array['gift_links', 'gift_payments', 'pay_handles', 'wallet_goals']`);
    expect(migration).toMatch(/as restrictive for insert to authenticated with check \(public\.can_manage_family\(family_id\)\)/);
    expect(migration).toMatch(/as restrictive for update to authenticated using \(public\.can_manage_family\(family_id\)\) with check/);
    expect(migration).toMatch(/as restrictive for delete to authenticated using \(public\.can_manage_family\(family_id\)\)/);
    expect(migration).toContain('if n <> 12 then');
  });

  it('does not take reading away from children', () => {
    // SELECT policies are not touched: a child sees the gift sent to them.
    expect(migration).not.toMatch(/for select/i);
  });

  it('the probe holds each table and the general rule', () => {
    for (const phrase of [
      "BREACH: a child rewrote a pending gift''s amount and recipient",
      'BREACH: a child invented a $20,000 gift to themselves',
      "BREACH: a child repointed a sibling''s gift link at themselves",
      "BREACH: a child repointed a sibling''s Pay-ID at their own wallet",
      'BREACH: a child marked a $300 goal saved and reached with no ledger behind it',
      'BREACH: a money function reads rows a non-manager can rewrite',
    ]) {
      expect(probe, phrase).toContain(phrase);
    }
    // …and the controls that stop the fix becoming an over-correction.
    for (const phrase of [
      'CONTROL FAILED: a parent could not create a gift link',
      'CONTROL FAILED: the parent could not approve the gift',
      'CONTROL FAILED: the child cannot see the gift that was credited to her',
      'CONTROL FAILED: a parent could not create a goal or claim a Pay-ID',
    ]) {
      expect(probe, phrase).toContain(phrase);
    }
  });

  it('the refused-write guards know these tables are manager-written', () => {
    for (const table of TABLES) expect(GUARDED_TABLES.has(table), table).toBe(true);
  });
});
