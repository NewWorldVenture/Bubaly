import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// docs/audit/run-probes.sh runs every docs/audit/*-check.sql and says of them:
// "Each ... asserts its invariants with RAISE EXCEPTION". Two ways that sentence
// can quietly stop being true, neither of which anything checked:
//
//   1. A new *-check.sql that SELECTs and reports but never raises. It passes,
//      the run stays green, and the count goes up — a probe that cannot fail.
//   2. An assertion written into a file the glob does not match. The four
//      -state / -diagnostic / -teardown files are deliberately report-only; a
//      raise parked in one of those would never run.
//
// The runner already refuses the third case — an empty glob exits 1 with "the
// boundary proofs have been deleted" — which is why these two are worth closing
// too rather than assumed.

const DIR = 'docs/audit';
const sql = readdirSync(DIR).filter((f) => f.endsWith('.sql'));
const checks = sql.filter((f) => f.endsWith('-check.sql'));
const reportOnly = sql.filter((f) => !f.endsWith('-check.sql'));
const body = (f: string) => readFileSync(join(DIR, f), 'utf8');
const assertions = (f: string) => (body(f).match(/raise exception/gi) ?? []).length;

describe('the boundary probes can actually fail', () => {
  it('finds probes at all (guards the guard)', () => {
    expect(checks.length).toBeGreaterThan(10);
  });

  it('every *-check.sql raises at least once', () => {
    for (const f of checks) {
      expect(assertions(f), `${f} runs in CI but asserts nothing — it can only ever pass`).toBeGreaterThan(0);
    }
  });

  it('no assertion is parked in a file the runner never globs', () => {
    for (const f of reportOnly) {
      expect(
        assertions(f),
        `${f} contains a raise exception but does not end in -check.sql, so run-probes.sh never executes it`,
      ).toBe(0);
    }
  });

  it('the runner still refuses to pass with zero probes', () => {
    // Without this branch an empty glob would report "0/0 passed" and exit 0.
    const runner = readFileSync(join(DIR, 'run-probes.sh'), 'utf8');
    expect(runner).toContain('${#probes[@]} -eq 0');
    expect(runner).toMatch(/no probes found[\s\S]*exit 1/);
  });
});

describe('a refusal counts only when it is the refusal being tested (MAIN-G1, MAIN-F-003)', () => {
  // Three boundary probes once caught `when others` and called any error "the
  // boundary held", so a renamed column (42703) or a missing table (42P01)
  // read as a pass. The fix is in the probes; nothing stopped it coming back.
  const code = (f: string) => body(f).split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

  it.each(['document-vault-boundary-check.sql', 'money-write-boundary-check.sql'])(
    '%s records a refusal only for insufficient_privilege',
    (f) => {
      const src = code(f);
      const refusals = [...src.matchAll(/exception\s+when\s+(\w+)\s+then\s+(?:refused|blocked)\s*:=\s*true/gi)].map((m) => m[1].toLowerCase());
      expect(refusals.length, `${f} no longer records any refusal`).toBeGreaterThan(0);
      expect(refusals.every((w) => w === 'insufficient_privilege'), `${f}: ${refusals.join(', ')}`).toBe(true);
    },
  );

  it('the child-mint proof in wallet-write-rls-check.sql insists the refusal was RLS (42501)', () => {
    const src = code('wallet-write-rls-check.sql');
    expect(src).toMatch(/if sqlst is distinct from '42501' then\s+raise exception 'A-08 FAIL/);
  });

  it('the anon-grant check covers every table and verb 0290 revokes', () => {
    const src = code('wallet-write-rls-check.sql');
    const migration = readFileSync('supabase/migrations/0290_money_anon_write_grants.sql', 'utf8');
    const revoked = [...migration.matchAll(/^revoke insert, update, delete, truncate on public\.(\w+)\s+from anon;/gm)].map((m) => m[1]);
    expect(revoked).toHaveLength(5);
    for (const table of revoked) expect(src, table).toContain(`'${table}'`);
    expect(src).toContain("array['INSERT','UPDATE','DELETE','TRUNCATE']");
    expect(src).toMatch(/has_table_privilege\('anon', 'public\.' \|\| t, v\)/);
  });
});
