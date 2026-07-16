import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const requiredDocs = [
  'docs/PRODUCT_LAUNCH_AUDIT.md',
  'docs/SERVICE_TEST_MATRIX.md',
  'docs/SUPABASE_WIRING_MATRIX.md',
  'docs/LAUNCH_BLOCKERS.md',
  'docs/AUDIT_PROGRESS.md',
  'docs/PRODUCTION_READINESS_REPORT.md',
  'docs/progress/2026-07-15-0749.md',
];

describe('launch audit control plane', () => {
  it('keeps the required audit documents and progress artifact present', () => {
    for (const path of requiredDocs) expect(existsSync(path), path).toBe(true);
  });

  it('uses the weighted verified-completion calculation', () => {
    const progress = readFileSync('docs/AUDIT_PROGRESS.md', 'utf8');
    expect(progress).toContain('Formula: `verified completed weight / total audit weight * 100`');
    expect(progress).toContain('Current calculation: `10 / 100 * 100 = 10.0%`');
    expect(progress).toContain('|  | **Total** | **100**');
  });

  it('keeps launch blockers and issue records tied to evidence', () => {
    const audit = readFileSync('docs/PRODUCT_LAUNCH_AUDIT.md', 'utf8');
    const blockers = readFileSync('docs/LAUNCH_BLOCKERS.md', 'utf8');
    expect(audit).toContain('### PLA-0281 - Goal funding could debit without updating goal progress');
    expect(audit).toContain('Commit: `7a20e160`');
    expect(blockers).toContain('| LB-001 | P0 |');
    expect(blockers).toContain('| LB-002 | P0 |');
    expect(blockers).toContain('The repository is currently NO-GO.');
  });

  // PLA-0405 regression: an interrupted/concurrent writer once embedded stray
  // control bytes (NUL + 0x01–0x1f) into the audit docs and a sync source file,
  // corrupting the ledger and silently altering the Google content-hash
  // separator. Guard the control-plane docs against any non-text control byte.
  it('keeps the audit control-plane documents free of control-byte corruption', () => {
    const controlByte = new RegExp('[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]'); // allow tab/LF/CR
    for (const path of requiredDocs) {
      const text = readFileSync(path, 'utf8');
      expect(controlByte.test(text), `${path} contains a stray control byte`).toBe(false);
    }
  });
});
