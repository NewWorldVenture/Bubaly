import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/marketing/intelligence/page.tsx', 'utf8');

describe('customer intelligence read boundary', () => {
  it('fails visibly when any analytics query fails', () => {
    expect(page).toContain('if (results.some((result) => result.error)) return <ReadFailure />;');
    expect(page).toContain('Could not load customer intelligence from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
