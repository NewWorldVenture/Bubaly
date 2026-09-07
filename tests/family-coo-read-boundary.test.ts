import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/family-coo/page.tsx', 'utf8');

// PLA-0805: the Family COO dashboard's open tasks, this-week events, shopping
// list, routines, and maintenance are source-of-truth for "run the household".
// If any read fails, the page must fail closed rather than render "No open
// tasks — nicely done." (chores are actually pending), "Nothing scheduled this
// week", and empty lists. A genuinely missing table (unapplied migration) is
// still tolerated as empty.
describe('family-coo page read boundary', () => {
  it('collects the six household read errors with a missing-table filter', () => {
    expect(page).toContain('const cooError = [membersRes.error, openChoresRes.error, eventsRes.error, groceryRes.error, routinesRes.error, maintRes.error]');
    expect(page).toContain('.find((e) => e && !isMissingTableError(e));');
  });

  it('logs and returns an ErrorState on a household read failure', () => {
    expect(page).toContain('if (cooError) {');
    expect(page).toContain("console.error('[dashboard/family-coo] household read failed', cooError);");
    expect(page).toContain("return <ErrorState message={");
    expectSays(page, 'familyCoo.couldNotLoadYourHousehold', "Could not load your household from Supabase. Refresh and try again.");
  });

  it('derives the household data only after the fail-closed guard', () => {
    const guardIdx = page.indexOf('if (cooError) {');
    const deriveIdx = page.indexOf('const openChores = openChoresRes.data;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(guardIdx);
  });
});
