import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The driving-safety log is what a parent reviews: max speed, hard brakes,
 * phone use. The view offered delete to every member and the table was
 * member-writable, so a teen could erase the trip where they hit 90 mph.
 * 0339 makes editing and deleting a trip a manager's
 * (docs/audit/driving-record-check.sql); this pins the delete control to
 * managers in the UI, and a refused delete to an error rather than "Deleted".
 */
describe('the driving-trip delete control', () => {
  const source = readFileSync('components/family/driving-safety-view.tsx', 'utf8');

  it('is decided by the manager role', () => {
    expect(source).toMatch(/const canDelete = isManager\(role\);/);
  });

  it('is only rendered for a manager', () => {
    const at = source.indexOf("aria-label={tr('drivingSafetyView.delete')}");
    expect(at, 'the delete control moved — did the view change?').toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, at - 260), at)).toMatch(/\{canDelete && <button/);
  });

  it('reports a delete that removed nothing as not saved', () => {
    expect(source).toMatch(/\.from\('driving_trips'\)\.delete\(\)[^;]*\.select\('id'\)/);
    expect(source).toMatch(/!data\?\.length\) toastError\(tr\('errors\.thatChangeWasNotSaved'\)\)/);
  });
});
