import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/family-digital-twin/page.tsx', 'utf8');

// PLA-0774: the Family Digital Twin page must fail closed on its source-of-truth
// member roster read. The roster is the spine of the page — every member card,
// the decision simulator, and the activity projection hang off it. A dropped
// error would collapse to "No family members yet" for a populated family (a
// confidently-wrong empty state). The per-member enrichment reads (profiles,
// routines, classes, teams, goals, budgets) intentionally stay best-effort.
describe('family digital twin read boundary', () => {
  it('captures the member roster read result rather than dropping its error', () => {
    expect(page).toContain('const [membersRes,');
    expect(page).toContain("supabase.from('family_members').select('*')");
  });

  it('logs and returns an ErrorState on a roster read failure', () => {
    expect(page).toContain('if (membersRes.error) {');
    expect(page).toContain("console.error('[dashboard/family-digital-twin] member read failed', membersRes.error);");
    expect(page).toContain('return <ErrorState message="Could not load your family from Supabase. Refresh and try again." />;');
  });

  it('derives members only after the fail-closed guard', () => {
    const guardIdx = page.indexOf('if (membersRes.error) {');
    const deriveIdx = page.indexOf('const members = membersRes.data;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(guardIdx);
  });
});
