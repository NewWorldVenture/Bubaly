import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/marketing/campaigns/new/page.tsx', 'utf8');

describe('new campaign read boundary', () => {
  it('fails visibly when campaign segments cannot be read', () => {
    expect(page).toContain('const { data: segments, error } = await supabase');
    expect(page).toContain('if (error) {');
    expectSays(page, 'new.couldNotLoadCampaignSegments', 'Could not load campaign segments from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
