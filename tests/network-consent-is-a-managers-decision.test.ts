import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Joining the insights network shares the family's (anonymised) data. The
 * intelligence module offered the consent toggles to every member, and the
 * table was member-writable, so a child could opt the household in — and a
 * minor's toggle is not consent. 0327 makes the table manager-write
 * (docs/audit/consent-and-commission-check.sql); this pins the toggles to
 * managers, shown read-only to everyone else.
 */
describe('network consent toggles', () => {
  const source = readFileSync('components/modules/intelligence-module.tsx', 'utf8');

  it('are decided by the manager role', () => {
    expect(source).toMatch(/const canConsent = isManager\(role\);/);
  });

  it('are disabled for anyone else — both the master switch and every scope', () => {
    const toggles = source.match(/<Toggle [^>]*onClick=\{(?:toggleMaster|\(\) => toggleScope\([^)]*\))\}[^>]*\/>/g) ?? [];
    expect(toggles.length).toBe(2);
    for (const toggle of toggles) expect(toggle).toContain('disabled={saving || !canConsent}');
  });
});
