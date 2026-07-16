import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/admins/page.tsx', 'utf8');

describe('admin management read boundary', () => {
  it('fails visibly when administrators cannot be read', () => {
    expect(page).toContain('const { data: allAdmins, error } = await supabase');
    expect(page).toContain('if (error) {');
    expect(page).toContain('Could not load administrators from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
