import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/social/audit/page.tsx', 'utf8');

describe('social audit read boundary', () => {
  it('fails visibly when audit entries cannot be read', () => {
    expect(page).toContain('const { data: logs, error } = await supabase');
    expect(page).toContain('if (error) {');
    expect(page).toContain('Could not load social audit entries from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
