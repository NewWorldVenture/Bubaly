import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/marketplace/selling/page.tsx', 'utf8');

describe('marketplace selling read boundary', () => {
  it('fails visibly when listings or seller signals cannot be read', () => {
    expect(page).toContain('const { data: listings, error: listingsError } = await sb');
    expect(page).toContain('const signalError = signalResults.find((result) => result.error)?.error;');
    expect(page).toContain('if (listingsError || signalError) {');
    expect(page).toContain('Could not load seller activity from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
