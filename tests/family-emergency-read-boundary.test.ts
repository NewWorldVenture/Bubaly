import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/family-emergency/page.tsx', 'utf8');

// PLA-0778: the Family Emergency Hub is the crisis surface. If any of its reads
// (members, emergency contacts, emergency plans, medical profiles) fails, it
// must fail closed — never render "No emergency contacts on file" or "No
// medical profiles recorded" (hiding blood type, allergies, and the ICE contact
// from a first responder) from a partially-failed read. A genuinely missing
// table (unapplied migration) is still tolerated as empty.
describe('family-emergency page read boundary', () => {
  it('collects the four emergency read errors with a missing-table filter', () => {
    expect(page).toContain('const emergencyError = [membersRes.error, contactsRes.error, plansRes.error, profilesRes.error]');
    expect(page).toContain('.find((e) => e && !isMissingTableError(e));');
  });

  it('logs and returns an ErrorState on an emergency read failure', () => {
    expect(page).toContain('if (emergencyError) {');
    expect(page).toContain("console.error('[dashboard/family-emergency] emergency read failed', emergencyError);");
    expect(page).toContain('return <ErrorState message="Could not load your family emergency hub from Supabase. Refresh and try again." />;');
  });

  it('keeps the manager-gated medical_profiles branch error-shaped', () => {
    expect(page).toContain('Promise.resolve({ data: [], error: null })');
  });

  it('derives the emergency data only after the fail-closed guard', () => {
    const guardIdx = page.indexOf('if (emergencyError) {');
    const deriveIdx = page.indexOf('const members = membersRes.data;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(guardIdx);
  });
});
