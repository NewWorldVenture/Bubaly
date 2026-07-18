import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/family-school/page.tsx', 'utf8');

// PLA-0803: the Family School Hub's classes, grades, and school events are
// source-of-truth. If any read fails, the page must fail closed rather than
// render "No classes added yet" / "No grades recorded yet" / "No school events"
// for a family that has them. A genuinely missing table (unapplied migration)
// is still tolerated as empty.
describe('family-school page read boundary', () => {
  it('collects the four school read errors with a missing-table filter', () => {
    expect(page).toContain('const schoolError = [membersRes.error, classesRes.error, gradesRes.error, eventsRes.error]');
    expect(page).toContain('.find((e) => e && !isMissingTableError(e));');
  });

  it('logs and returns an ErrorState on a school read failure', () => {
    expect(page).toContain('if (schoolError) {');
    expect(page).toContain("console.error('[dashboard/family-school] school read failed', schoolError);");
    expect(page).toContain('return <ErrorState message="Could not load your family school hub from Supabase. Refresh and try again." />;');
  });

  it('derives the school data only after the fail-closed guard', () => {
    const guardIdx = page.indexOf('if (schoolError) {');
    const deriveIdx = page.indexOf('const classes = classesRes.data;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(guardIdx);
  });
});
