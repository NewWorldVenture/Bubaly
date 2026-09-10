import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/grandparent-portal/page.tsx', 'utf8');

// PLA-0781: the Grandparent Portal's member roster is its spine — the family
// grid, milestone/announcement author names, and birthday celebrations all
// build off it. If the roster read fails, the page must fail closed rather than
// render an empty portal for a grandparent. Photo/milestone/announcement/date
// failures must also fail that household's card closed; runtime cases for each
// source and transport failures live in grandparent-multi-household.test.ts.
describe('grandparent-portal read boundary', () => {
  it('captures the roster read result rather than dropping its error', () => {
    expect(page).toContain('membersRes,');
    expect(page).toContain("supabase.from('family_members').select('id, display_name, birthday, color, role')");
  });

  it('logs and returns an ErrorState on a roster read failure', () => {
    expect(page).toContain('if (membersRes.error) {');
    expect(page).toContain("console.error('[dashboard/grandparent-portal] member roster read failed', membersRes.error);");
    expect(page).toContain("return <ErrorState message={");
    expectSays(page, 'grandparentPortal.couldNotLoadYourFamily', "Could not load your family portal from Supabase. Refresh and try again.");
  });

  it('derives members only after the fail-closed guard', () => {
    const guardIdx = page.indexOf('if (membersRes.error) {');
    const deriveIdx = page.indexOf('const members = membersRes.data;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(guardIdx);
  });

  // M28 made the portal cross-household: a grandparent invited into two of
  // their children's families sees both. The fail-closed rule above did not
  // change — it moved INSIDE the per-household body, so one family's outage
  // costs that family's card and nothing else. A guard hoisted back up to the
  // page would blank every household over one failure, which is the reassuring
  // half-truth this file exists to prevent.
  it('reads every household the member belongs to, one at a time', () => {
    expect(page).toContain('ctx.memberships.map((m) => ({ familyId: m.familyId, familyName: m.family.name }))');
    expect(page).toContain('async function householdBody(supabase: Supabase, t: Translate, household: HouseholdRef)');
    expect(page).toContain('const familyId = household.familyId;');
  });

  it('scopes the fail-closed guard to the household that failed', () => {
    const bodyIdx = page.indexOf('async function householdBody');
    const guardIdx = page.indexOf('if (membersRes.error) {');
    expect(bodyIdx).toBeGreaterThan(-1);
    // The guard is inside the per-household function, not in the page above it.
    expect(guardIdx).toBeGreaterThan(bodyIdx);
    // Every household is rendered, so a failing one renders its own notice
    // beside the others rather than replacing them.
    expect(page).toContain('body: await householdBody(supabase, t, household),');
    expect(page).toContain('{sections.map(({ household, body }) => (');
  });
});
