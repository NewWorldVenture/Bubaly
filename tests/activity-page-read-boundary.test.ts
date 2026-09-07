import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/activity/page.tsx', 'utf8');

describe('activity page read boundary', () => {
  it('fails visibly when a source or enrichment read fails', () => {
    expect(page).toContain('const readError = [');
    expect(page).toContain('membersResult.error');
    expect(page).toContain('groceryResult.error');
    expect(page).toContain('if (choreResult.error)');
    expectSays(page, 'activity.couldNotLoadFamilyActivity', 'Could not load family activity from Supabase. Refresh and try again.');
    expect(page).toContain("return <ErrorState message={");
    expectSays(page, 'activity.couldNotLoadFamilyActivity', "Could not load family activity from Supabase. Refresh and try again.");
  });
});
