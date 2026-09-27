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

    // This used to pin the child's uuid as a LITERAL, and that made the case
    // brittle about the wrong thing. The probe's ids had to change — it shared
    // `…0000000000c8` with child-login-mapping-is-managers-only-check.sql,
    // which commits its seed, so a SECOND run of the suite against one database
    // failed on a foreign key (see tests/boundary-probes-are-rerunnable.test.ts
    // for the whole shape). A rename that is correct should not fail a case
    // whose subject is "RLS is the gate, not the application".
    //
    // So assert the PROPERTY instead: the probe declares a child via `\set KID`,
    // seeds that id as a `child` family member, and hands the SAME id to
    // `request.jwt.claim.sub`. A probe that seeds one child and impersonates a
    // different uuid would prove nothing, and that is what this now catches.
    const kid = /^\\set KID '([0-9a-f-]{36})'/m.exec(sql);
    expect(kid, 'the probe no longer declares its child with \\set KID').not.toBeNull();
    expect(sql, 'the child id must be seeded as a `child` family member')
      .toContain(`:'KID', 'child'`);
    expect(sql, 'the session must be opened AS the child the probe seeded')
      .toContain(`set_config('request.jwt.claim.sub','${kid![1]}', true)`);

    // And EVERY identity it assumes must be one it seeded. `toContain` above is
    // satisfied by a single matching occurrence, and this probe opens a session
    // five times — so on its own it would pass a file that impersonates the
    // seeded child once and an unseeded uuid everywhere else. That is not a
    // hypothetical: planting exactly that left the case green, which is how
    // this second half came to exist.
    const declared = new Set(
      [...sql.matchAll(/^\\set [A-Z_]+ '([0-9a-f-]{36})'/gm)].map((m) => m[1]),
    );
    expect(declared.size, 'no \\set ids were parsed').toBeGreaterThan(1);
    const assumed = [...sql.matchAll(/request\.jwt\.claim\.sub'\s*,\s*'([0-9a-f-]{36})'/g)]
      .map((m) => m[1]);
    expect(assumed.length, 'the probe assumes no identity at all').toBeGreaterThan(1);
    expect(
      [...new Set(assumed)].filter((id) => !declared.has(id)),
      'the probe opens a session as a uuid it never declared with \\set, so nothing '
        + 'establishes that identity is a member of the family under test',
    ).toEqual([]);
  });
});
