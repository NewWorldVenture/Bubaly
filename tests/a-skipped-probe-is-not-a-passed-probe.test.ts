import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// `docs/audit/run-probes.sh` used to print "64/64 passed" over a run in which
// the wallet concurrency invariant was never exercised. The probe itself was
// honest — it said `A-15 SKIP: … concurrency was NOT exercised`, one line under
// a PASS — but a probe exits zero whether it ran its invariant or declined to,
// so the runner counted the decline as a pass and the total was the only thing
// anyone read. That is AUDIT-005.
//
// The repair has two halves, and BOTH are easy to undo by accident, which is
// what this file is for:
//
//  1. the runner classifies a skip separately, names it, and (absent an explicit
//     PROBES_ALLOW_SKIP=1) exits non-zero;
//  2. it detects one CASE-SENSITIVELY.
//
// The second half is not a detail. The first attempt matched /skip/i and turned
// three healthy probes red, because Postgres narrates its own routine work in
// lowercase — `extension "dblink" already exists, skipping`, `policy "…" does
// not exist, skipping` — and `family-self-read-check.sql` reports success as
// "197 empty, skipped". A probe's verdict about ITSELF is uppercase `SKIP:` or
// `SKIPPED`. Reading the engine's words as the probe's verdict is the same
// error as a source-shape guard that scans its own comments.

const AUDIT = join(process.cwd(), 'docs', 'audit');
const RUNNER = readFileSync(join(AUDIT, 'run-probes.sh'), 'utf8');
const probeNames = readdirSync(AUDIT).filter((f) => f.endsWith('-check.sql'));

/** A `raise notice` body, with SQL line comments removed. */
const noticesIn = (sql: string): string[] =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .match(/raise\s+notice\s+'([^']*)'/gi)
    ?.map((m) => m.replace(/^raise\s+notice\s+'/i, '').replace(/'$/, '')) ?? [];

describe('a skipped probe is not a passed probe', () => {
  it('the runner classifies skips apart from passes and names them', () => {
    expect(RUNNER).toMatch(/skipped\+=/);
    expect(RUNNER).toMatch(/SKIPPED PROBES/);
    // The count must subtract skips, not fold them into the passes.
    expect(RUNNER).toMatch(/\$\{#probes\[@\]\}\s*-\s*\$\{#failed\[@\]\}\s*-\s*\$\{#skipped\[@\]\}/);
  });

  it('a skip fails the run unless it is deliberately allowed', () => {
    expect(RUNNER).toMatch(/PROBES_ALLOW_SKIP/);
    const gate = RUNNER.slice(RUNNER.indexOf('PROBES_ALLOW_SKIP'));
    expect(gate, 'the skip gate must exit non-zero').toMatch(/exit 1/);
  });

  it('detects a skip case-sensitively, so the engine\'s own chatter is not a verdict', () => {
    const detectors = RUNNER.split('\n').filter(
      (l) => /grep/.test(l) && /SKIP/.test(l) && !l.trim().startsWith('#'),
    );
    expect(detectors.length, 'the runner must still grep for SKIP').toBeGreaterThan(0);
    for (const line of detectors) {
      // `-i` here is exactly the regression: it matches "skipping" and "skipped".
      expect(line, `case-insensitive skip detection: ${line.trim()}`).not.toMatch(
        /grep\s+-[a-zA-Z]*i[a-zA-Z]*\s/,
      );
    }
  });

  it('every probe that declines to run says so in the uppercase convention', () => {
    // Non-vacuity: at least one probe must actually declare a skip, or the rule
    // above is guarding nothing.
    let declared = 0;
    for (const name of probeNames) {
      for (const notice of noticesIn(readFileSync(join(AUDIT, name), 'utf8'))) {
        if (!/\bskip/i.test(notice)) continue;
        if (/\bSKIP(PED)?\b/.test(notice)) { declared++; continue; }
        // A lowercase "skipped" inside a success line is fine — that is prose
        // about the probe's own work, not a verdict on whether it ran.
        expect(notice, `lowercase skip wording in a verdict: ${name}: ${notice}`).toMatch(
          /\bOK\b|\bPASSED\b/,
        );
      }
    }
    expect(declared, 'no probe declares a skip — this guard would be vacuous').toBeGreaterThanOrEqual(3);
  });

  it('the wallet concurrency probe proves its own guard is load-bearing', () => {
    const a15 = readFileSync(join(AUDIT, 'wallet-concurrency-check.sql'), 'utf8');
    // It must contend on the row the RPC locks, not merely hope two clock spans
    // intersect — the old version overlapped 8/8 idle and 16/20 under load.
    expect(a15).toMatch(/for update/i);
    expect(a15).toMatch(/pg_locks/);
    expect(a15).toMatch(/application_name\s*=\s*'a15_racer'/);
    // And it must carry a negative control that reproduces the overdraft.
    expect(a15).toMatch(/decoration, not a boundary/);
    expect(a15).toMatch(/1600/); // the $16.00 held against $10.00
    // The real function must be restored by a statement that cannot be jumped
    // over: the race records its verdict instead of raising.
    expect(a15).toMatch(/a15_saved_fn/);
    expect(a15).toMatch(/pg_get_functiondef/);
  });
});
