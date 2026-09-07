import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/social/settings/page.tsx', 'utf8');

// PLA-0809: the social workspace settings page must fail closed. A dropped
// social_settings read error would render the form with DEFAULT values and a
// subsequent save would overwrite the family's real settings — a data-loss
// trap. members/perms errors would hide access config. A genuinely missing
// table (unapplied migration) is still tolerated as empty.
describe('social/settings page read boundary', () => {
  it('collects the three read errors with a missing-table filter', () => {
    expect(page).toContain('const socialError = [settingsRes.error, membersRes.error, permsRes.error]');
    expect(page).toContain('.find((e) => e && !isMissingTableError(e));');
  });

  it('logs and returns an ErrorState on a read failure', () => {
    expect(page).toContain('if (socialError) {');
    expect(page).toContain("console.error('[dashboard/social/settings] social settings read failed', socialError);");
    expect(page).toContain("return <ErrorState message={");
    expectSays(page, 'settings.couldNotLoadYourSocial', "Could not load your social workspace settings from Supabase. Refresh and try again.");
  });

  it('derives settings only after the fail-closed guard (no default-overwrite trap)', () => {
    const guardIdx = page.indexOf('if (socialError) {');
    const deriveIdx = page.indexOf('const settings = settingsRes.data;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(guardIdx);
  });
});
