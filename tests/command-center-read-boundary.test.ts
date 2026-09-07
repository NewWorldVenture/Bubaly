import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/command-center/page.tsx', 'utf8');

describe('command center read boundary', () => {
  it('fails visibly when family or operating-index reads fail', () => {
    expect(page).toContain('const readError = [');
    expect(page).toContain('expiringDocsResult.error');
    expect(page).toContain('try {');
    expect(page).toContain('loadOperatingIndex(supabase, familyId, now)');
    expectSays(page, 'commandCenter.couldNotLoadYourFamily', 'Could not load your family command center from Supabase. Refresh and try again.');
    expect(page).toContain("return <ErrorState message={");
    expectSays(page, 'commandCenter.couldNotLoadYourFamily', "Could not load your family command center from Supabase. Refresh and try again.");
  });
});
