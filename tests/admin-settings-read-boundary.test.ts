import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/settings/page.tsx', 'utf8');

describe('admin settings read boundary', () => {
  it('fails visibly when administrator settings cannot be read', () => {
    expect(page).toContain("const { count: superAdmins, error } = await supabase");
    expect(page).toContain('if (error) {');
    expect(page).toContain('Could not load administrator settings from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
