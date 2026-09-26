import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A daily screen-time limit is a parental control. The module showed "set
 * daily limit" to every member and the table was member-writable, so a child
 * could raise their own limit to 24 hours from the app itself. 0325 makes the
 * table manager-write (docs/audit/screen-time-limit-check.sql); this pins the
 * control to managers in the UI, so a child is not offered a button the
 * database will refuse.
 */
describe('the screen-time limit control', () => {
  const source = readFileSync('components/modules/screen-time-module.tsx', 'utf8');

  it('is decided by the manager role', () => {
    expect(source).toMatch(/const canSetLimits = isManager\(role\);/);
  });

  it('is only rendered for a manager', () => {
    const at = source.indexOf("title={t('screenTime.setDailyLimit')}");
    expect(at, 'the set-limit control moved — did the module change?').toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, at - 260), at)).toMatch(/\{canSetLimits && \(/);
  });

  it('offers deleting a logged entry only to a manager (0340)', () => {
    const at = source.indexOf("aria-label={t('screenTime.delete')}");
    expect(at, 'the delete control moved — did the module change?').toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, at - 200), at)).toMatch(/\{canSetLimits && <button/);
    expect(source).toMatch(/\.from\('screen_time_entries'\)\.delete\(\)[^;]*\.select\('id'\)/);
  });
});
