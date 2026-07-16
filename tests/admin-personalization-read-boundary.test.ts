import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/marketing/personalization/page.tsx', 'utf8');

describe('personalization read boundary', () => {
  it('fails visibly when rules cannot be read', () => {
    expect(page).toContain('const { data, error } = await supabase');
    expect(page).toContain('if (error) {');
    expect(page).toContain('Could not load personalization rules from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
