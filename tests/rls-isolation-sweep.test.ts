import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-03 (tenant isolation) guard. The live cross-family proof runs against the
// PG16 harness (docs/audit/verify-pg.sh) via docs/audit/rls-isolation-check.sql;
// that SQL asserts, under RAISE EXCEPTION, that (1) every family-scoped table has
// RLS enabled, (2) a member of family B can read 0 rows of family A, and (3) B
// cannot insert/update/delete family A's rows. This static test guards the probe
// so it cannot be silently deleted or gutted, and documents the invariant in CI.
describe('A-03 tenant-isolation RLS probe is present and encodes its invariants', () => {
  const sql = readFileSync('docs/audit/rls-isolation-check.sql', 'utf8');

  it('sweeps for family-scoped tables with RLS disabled and fails if any exist', () => {
    expect(sql).toContain("c.relrowsecurity = false");
    expect(sql).toContain('family-scoped table(s) have RLS DISABLED');
  });

  it('asserts a second-tenant member reads zero rows of the anchor family', () => {
    expect(sql).toContain('user B read % rows from family A table');
    // The read probe must cover the highest-risk tenant tables.
    for (const t of ['family_members', 'wallet_transactions', 'calendar_events', 'documents']) {
      expect(sql).toContain(`'${t}'`);
    }
  });

  it('asserts cross-tenant insert/update/delete are all blocked', () => {
    expect(sql).toContain('user B INSERTed into family A');
    expect(sql).toContain('user B UPDATEd');
    expect(sql).toContain('user B DELETEd');
  });

  it('asserts SECURITY DEFINER RPCs reject cross-family callers', () => {
    expect(sql).toContain('marketplace_create_circle');
    expect(sql).toContain('cross-family caller');
  });

  it('asserts provisioning RPCs reject cross-user callers', () => {
    expect(sql).toContain('ensure_family_for_user');
    expect(sql).toContain('onboarding_claim_family');
    expect(sql).toContain('cross-user caller');
  });

  it('is wired to the shared harness runner', () => {
    // The shim + migrate + seed logic moved into pg-bootstrap.sh so CI and the
    // by-hand harness bootstrap from one definition; verify-pg.sh now starts a
    // local server and delegates. The probe still needs a seeded database with
    // the `authenticated` role, so assert that wherever it is built.
    const harness = readFileSync('docs/audit/verify-pg.sh', 'utf8');
    const bootstrap = readFileSync('docs/audit/pg-bootstrap.sh', 'utf8');
    expect(harness).toContain('docs/audit/pg-bootstrap.sh');
    expect(bootstrap).toContain('authenticated');
    expect(bootstrap).toContain('SEED_ALL.sql');
  });
});

describe('A-03 read probe cannot pass on an empty table', () => {
  const sql = readFileSync('docs/audit/rls-isolation-check.sql', 'utf8');

  it('requires family A to actually hold rows in every table it names', () => {
    // Found by asking what else could make the count zero: SEED_ALL leaves
    // `wallet_transactions` empty for the anchor family, so for the highest-risk
    // money table on the list — one this file explicitly requires be covered —
    // the probe reported isolation it had never tested. It read 0 because there
    // was nothing to read.
    expect(sql).toContain('so this probe cannot prove B is blocked from reading it');
    expect(sql).toMatch(/baseline = 0[\s\S]{0,200}raise exception/);
  });

  it('gives the money table something to fail on', () => {
    expect(sql).toContain('A-03 isolation fixture');
    expect(sql).toContain('insert into public.wallet_transactions');
  });
});
