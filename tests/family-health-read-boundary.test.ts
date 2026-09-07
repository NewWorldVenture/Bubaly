import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/family-health/page.tsx', 'utf8');

// PLA-0777: the Family Health summary is safety-critical. If any of its reads
// (members, appointments, medications, medical profiles, providers) fails, it
// must fail closed — never render "No allergies or conditions recorded" (when a
// child has a life-threatening allergy), "No active medications", or "No
// upcoming appointments" from a partially-failed read. A genuinely missing
// table (unapplied migration) is still tolerated as empty.
describe('family-health page read boundary', () => {
  it('collects the five health read errors with a missing-table filter', () => {
    expect(page).toContain('const healthError = [membersRes.error, apptsRes.error, medsRes.error, profilesRes.error, providersRes.error]');
    expect(page).toContain('.find((e) => e && !isMissingTableError(e));');
  });

  it('logs and returns an ErrorState on a health read failure', () => {
    expect(page).toContain('if (healthError) {');
    expect(page).toContain("console.error('[dashboard/family-health] health read failed', healthError);");
    expect(page).toContain("return <ErrorState message={");
    expectSays(page, 'familyHealth.couldNotLoadYourFamily', "Could not load your family health summary from Supabase. Refresh and try again.");
  });

  it('keeps the manager-gated medical_profiles branch error-shaped', () => {
    // The non-manager branch must carry an `error` field so the guard's
    // profilesRes.error access is always well-defined (never undefined-throws).
    expect(page).toContain('Promise.resolve({ data: [], error: null })');
  });

  it('derives the health data only after the fail-closed guard', () => {
    const guardIdx = page.indexOf('if (healthError) {');
    const deriveIdx = page.indexOf('const members = membersRes.data;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(guardIdx);
  });
});
