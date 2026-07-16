import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-08 money-safety guard. The live proof runs docs/audit/wallet-overspend-check.sql
// against the PG16 harness: it funds a $10 spend bucket and asserts (via RAISE
// EXCEPTION) that wallet_reserve_card_auth cannot approve past the balance, counts
// a pending hold against the balance, and is idempotent per authorization id. This
// static test guards that probe (so it can't be deleted/gutted) and documents the
// invariant in CI alongside the pure-ledger conservation tests (wallet-ledger.test).
describe('A-08 wallet overspend probe is present and encodes its invariants', () => {
  const sql = readFileSync('docs/audit/wallet-overspend-check.sql', 'utf8');

  it('targets the atomic reserve RPC', () => {
    expect(sql).toContain('wallet_reserve_card_auth');
  });

  it('asserts overspend is prevented (a second hold past the balance is declined)', () => {
    expect(sql).toContain('overspend — second $8 approved with only $2 left');
    expect(sql).toContain('overspend — approved a hold against a $0 balance');
  });

  it('asserts idempotency per authorization id (no double hold on replay)', () => {
    expect(sql).toContain('idempotent replay of a hold was declined');
    expect(sql).toContain('expected 2 holds');
  });

  it('cleans up after itself (leaves no residue in the shared harness)', () => {
    expect(sql).toContain('delete from public.child_wallets where id = v_wallet');
    expect(sql).toContain('delete from public.family_members where id = v_member');
  });
});
