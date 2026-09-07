import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/marketing/personalization/page.tsx', 'utf8');

describe('personalization read boundary', () => {
  it('fails visibly when rules cannot be read', () => {
    expect(page).toContain('const { data, error } = await supabase');
    expect(page).toContain('if (error) {');
    expectSays(page, 'personalization.couldNotLoadPersonalizationRules', 'Could not load personalization rules from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
