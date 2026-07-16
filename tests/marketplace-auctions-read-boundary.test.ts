import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/marketplace/auctions/page.tsx', 'utf8');

describe('marketplace auctions read boundary', () => {
  it('fails visibly when auction listings cannot be read', () => {
    expect(page).toContain('const { data, error } = await sb');
    expect(page).toContain('if (error) {');
    expect(page).toContain('Could not load live auctions from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
