import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/social/usage/page.tsx', 'utf8');

describe('social usage read boundary', () => {
  it('fails visibly when usage events cannot be read', () => {
    expect(page).toContain('const { data: events, error } = await supabase');
    expect(page).toContain('if (error) {');
    expectSays(page, 'usage.couldNotLoadSocialUsage', 'Could not load social usage events from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
