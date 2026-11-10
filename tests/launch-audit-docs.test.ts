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

  it('keeps every required audit document a titled, non-empty markdown file', () => {
    // A file truncated by an interrupted writer still exists.
    expect(requiredDocs.length).toBe(7);
    for (const path of requiredDocs) {
      const text = readFileSync(path, 'utf8');
      expect(text.startsWith('# '), `${path} must open with its title`).toBe(true);
      expect(text.trim().split('\n').length, `${path} has no body`).toBeGreaterThan(1);
    }
  });

  it('uses the weighted verified-completion calculation', () => {
    const progress = readFileSync('docs/AUDIT_PROGRESS.md', 'utf8');
    expect(progress).toContain('Formula: `verified completed weight / total audit weight * 100`');
    expect(progress).toContain('Current calculation: `10 / 100 * 100 = 10.0%`');
    expect(progress).toContain('|  | **Total** | **100**');
  });

  it('states a calculation that is the weighted sum of the inventory it sits above', () => {
    // The stated figures are prose: they are only the weighted calculation
    // while they equal what the inventory rows add up to.
    const progress = readFileSync('docs/AUDIT_PROGRESS.md', 'utf8');
    const units = progress.split('\n')
      .map((line) => line.split('|').map((cell) => cell.trim()))
      .filter((cells) => /^A-\d+$/.test(cells[1] ?? ''))
      .map((cells) => ({ id: cells[1], weight: Number(cells[3]), status: cells[4] }));
    expect(units.length).toBeGreaterThan(0);
    expect(new Set(units.map((u) => u.id)).size).toBe(units.length);
    for (const u of units) {
      expect(Number.isInteger(u.weight) && u.weight > 0, `${u.id} weight`).toBe(true);
      expect(['Verified', 'In progress', 'Not started', 'Blocked'], `${u.id} status`).toContain(u.status);
    }
    const total = units.reduce((sum, u) => sum + u.weight, 0);
    const verified = units.filter((u) => u.status === 'Verified').reduce((sum, u) => sum + u.weight, 0);
    expect(progress).toContain(`|  | **Total** | **${total}** |  | **Verified: ${verified}** |`);
    expect(progress).toContain(
      `Current calculation: \`${verified} / ${total} * 100 = ${((verified / total) * 100).toFixed(1)}%\``,
    );
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

  it('keeps the commit and validation evidence inside the issue record they belong to', () => {
    // The commit hash anywhere in a 400 KB ledger is not evidence for this
    // record: read the record's own section, up to the next heading.
    const audit = readFileSync('docs/PRODUCT_LAUNCH_AUDIT.md', 'utf8');
    const heading = '### PLA-0281 - Goal funding could debit without updating goal progress\n';
    const start = audit.indexOf(heading);
    expect(start).toBeGreaterThan(-1);
    expect(audit.indexOf(heading, start + 1)).toBe(-1);
    const rest = audit.slice(start + heading.length);
    const next = rest.search(/^#{1,3} /m);
    const record = next === -1 ? rest : rest.slice(0, next);
    expect(record).toContain('- Commit: `7a20e160`');
    expect(record).toContain('- Validation evidence: `tests/wallet-goal-persistence.test.ts`');
    expect(existsSync('tests/wallet-goal-persistence.test.ts')).toBe(true);
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
