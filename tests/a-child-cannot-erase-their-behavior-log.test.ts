import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The behavior log is the chart a parent keeps. The module offered delete to
 * every member and the table was member-writable, so a child could delete the
 * hard day they had. 0351 makes editing and deleting an entry a manager's
 * (docs/audit/behavior-log-check.sql); this pins the delete control to
 * managers in the UI, and a refused delete to an error rather than "Deleted".
 */
describe('the behavior-log delete control', () => {
  const source = readFileSync('components/modules/behavior-module.tsx', 'utf8');

  it('is decided by the manager role', () => {
    expect(source).toMatch(/const canRemove = isManager\(role\);/);
  });

  it('is only rendered for a manager', () => {
    const at = source.indexOf("aria-label={tr('behavior.delete')}");
    expect(at, 'the delete control moved — did the module change?').toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, at - 200), at)).toMatch(/\{canRemove && <button/);
  });

  it('reports a delete that removed nothing as not saved', () => {
    expect(source).toMatch(/\.from\('behavior_logs'\)\.delete\(\)[^;]*\.select\('id'\)/);
    expect(source).toMatch(/!data\?\.length\) toastError\(tr\('errors\.thatChangeWasNotSaved'\)\)/);
  });
});
