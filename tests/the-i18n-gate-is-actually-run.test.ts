// A gate nobody runs is a promise nobody keeps.
//
// `scripts/i18n-gate.mjs` opens with "Runs every entry in GATED_SURFACES and
// fails if any of them has regained a hardcoded string… Nothing else in the
// build would notice, so this does." It was never wired into the workflow, so
// for every surface it declared translated the promise was checked by nobody —
// the same defect this audit keeps finding in other forms: a control that
// documents a guarantee it does not hold.
//
// These cases assert the halves that make the gate real: CI invokes it, every
// declared surface is actually clean, and the scanner still reports a hardcoded
// label put back into a gated map.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GATED_SURFACES, scanPaths, scanFile } from '../scripts/i18n-scan.mjs';

describe('the i18n gate is actually run', () => {
  it('CI invokes it', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toMatch(/npm run i18n:gate|scripts\/i18n-gate\.mjs/);
  });

  it('every declared surface scans clean, which is what declaring one promises', () => {
    const dirty: string[] = [];
    for (const [surface, paths] of Object.entries(GATED_SURFACES)) {
      const found = scanPaths(paths).reduce((n, r) => n + r.findings.length, 0);
      if (found) dirty.push(`${surface}: ${found}`);
    }
    expect(dirty, 'a gated surface has regained hardcoded copy').toEqual([]);
  });

  it('covers the Guardian safety vocabulary', () => {
    // The trust tiers, the six routing modes and the fourteen scam types: five
    // client components render these, and a Dutch family reading why a call was
    // blocked used to get the reason in English on an otherwise translated page.
    expect(Object.keys(GATED_SURFACES)).toContain('guardian-copy');
    expect(GATED_SURFACES['guardian-copy']).toEqual([
      'lib/guardian/trust.ts',
      'lib/guardian/pipeline.ts',
      'lib/guardian/scam.ts',
    ]);
  });

  it('still sees a hardcoded label put back into a gated map', () => {
    // The not-blind control, planted rather than assumed — and deliberately in
    // THE SHAPE THE DEFECT TOOK, a label sitting in a Record<> under lib/,
    // because that is what the gate has to keep catching. Note what it does NOT
    // catch: a bare top-level `export const X = 'Some words'`. The scanner reads
    // copy parked in data structures and in markup, not every string literal.
    const real = readFileSync('lib/guardian/trust.ts', 'utf8');
    expect(real).toContain("blocked: 'guardian.trustBlocked',");
    const dir = mkdtempSync(join(tmpdir(), 'i18n-gate-'));
    try {
      const planted = join(dir, 'trust.ts');
      writeFileSync(planted, real.replace("blocked: 'guardian.trustBlocked',", "blocked: 'Blocked outright',"));
      expect(scanFile(planted).map((f: { text: string }) => f.text)).toContain('Blocked outright');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
