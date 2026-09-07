import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/family-signals/page.tsx', 'utf8');

describe('family signals read boundary', () => {
  it('fails visibly when family signals cannot be read', () => {
    expect(page).toContain('const { data, error } = await supabase');
    expect(page).toContain('if (error) {');
    expectSays(page, 'familySignals.couldNotLoadFamilyIntelligence', 'Could not load family intelligence from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
