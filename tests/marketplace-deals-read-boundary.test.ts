import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/marketplace/deals/page.tsx', 'utf8');

describe('marketplace deals read boundary', () => {
  it('fails visibly when deal listings cannot be read', () => {
    expect(page).toContain('const { data, error } = await sb');
    expect(page).toContain('if (error) {');
    expectSays(page, 'deals.couldNotLoadMarketplaceDeals', 'Could not load marketplace deals from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
