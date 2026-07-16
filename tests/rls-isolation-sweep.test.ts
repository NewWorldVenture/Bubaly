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

  it('is wired to the shared harness runner', () => {
    const harness = readFileSync('docs/audit/verify-pg.sh', 'utf8');
    expect(harness).toContain('authenticated');
    expect(harness).toContain('SEED_ALL.sql');
  });
});
