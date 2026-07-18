import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/grandparent-portal/page.tsx', 'utf8');

// PLA-0781: the Grandparent Portal's member roster is its spine — the family
// grid, milestone/announcement author names, and birthday celebrations all
// build off it. If the roster read fails, the page must fail closed rather than
// render an empty portal for a grandparent. The family name + photo/milestone/
// announcement/date enrichment reads intentionally stay best-effort.
describe('grandparent-portal read boundary', () => {
  it('captures the roster read result rather than dropping its error', () => {
    expect(page).toContain('membersRes,');
    expect(page).toContain("supabase.from('family_members').select('id, display_name, birthday, color, role')");
  });

  it('logs and returns an ErrorState on a roster read failure', () => {
    expect(page).toContain('if (membersRes.error) {');
    expect(page).toContain("console.error('[dashboard/grandparent-portal] member roster read failed', membersRes.error);");
    expect(page).toContain('return <ErrorState message="Could not load your family portal from Supabase. Refresh and try again." />;');
  });

  it('derives members only after the fail-closed guard', () => {
    const guardIdx = page.indexOf('if (membersRes.error) {');
    const deriveIdx = page.indexOf('const members = membersRes.data;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(guardIdx);
  });
});
