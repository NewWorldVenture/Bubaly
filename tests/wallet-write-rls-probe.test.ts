import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-08 money-integrity guard. The live proof runs docs/audit/wallet-write-rls-check.sql
// against the PG16 harness: acting AS a child member of the anchor family, it asserts
// (via RAISE EXCEPTION) that a COMPLETE valid credit into wallet_transactions is
// RLS-rejected (0217 mint-lock, sqlstate 42501), the sibling wallet_* tables reject a
// child INSERT, wallet_audit_logs UPDATE/DELETE affect 0 rows while INSERT (append) is
// allowed (0224 append-only), and a manager write still succeeds (positive control).
// This static test guards that probe (so it can't be deleted/gutted) and backs the
// LB-010 exit criterion. Proven live on the harness: ALL INVARIANTS PASSED.
describe('A-08 wallet write-RLS probe is present and encodes its invariants', () => {
  const sql = readFileSync('docs/audit/wallet-write-rls-check.sql', 'utf8');

  it('proves the mint-lock with a complete, valid credit (only RLS can block it)', () => {
    expect(sql).toContain("'parent_top_up','completed','credit'");
    expect(sql).toContain('child MINTED a completed $9,999.99 credit into wallet_transactions');
  });

  it('covers the sibling money-ledger tables', () => {
    expect(sql).toContain("array['child_wallets','wallet_buckets','wallet_rules','family_wallets']");
  });

  it('asserts wallet_audit_logs is append-only (UPDATE/DELETE affect 0 rows, INSERT allowed)', () => {
    expect(sql).toContain('child UPDATEd % money-audit rows');
    expect(sql).toContain('child DELETEd % money-audit rows');
    expect(sql).toContain('child could not APPEND an audit row');
  });

  it('includes a manager positive control (the lockdown gates on role, not everyone)', () => {
    expect(sql).toContain('manager audit append was blocked (lockdown too strict)');
  });

  it('acts as an authenticated child via role + jwt claim (RLS is the gate)', () => {
    expect(sql).toContain("set_config('role','authenticated', true)");
    expect(sql).toContain("set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c8', true)");
  });
});
