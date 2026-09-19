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
