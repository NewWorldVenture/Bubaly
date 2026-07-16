import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/social/providers/page.tsx', 'utf8');

describe('social providers read boundary', () => {
  it('fails visibly when the provider catalog cannot be read', () => {
    expect(page).toContain('const { data: rows, error } = await supabase');
    expect(page).toContain('if (error) {');
    expect(page).toContain('Could not load social providers from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
