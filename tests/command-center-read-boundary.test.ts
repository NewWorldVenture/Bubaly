import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/command-center/page.tsx', 'utf8');

describe('command center read boundary', () => {
  it('fails visibly when family or operating-index reads fail', () => {
    expect(page).toContain('const readError = [');
    expect(page).toContain('expiringDocsResult.error');
    expect(page).toContain('try {');
    expect(page).toContain('loadOperatingIndex(supabase, familyId, now)');
    expect(page).toContain('Could not load your family command center from Supabase. Refresh and try again.');
    expect(page).toContain('return <ErrorState message="Could not load your family command center from Supabase. Refresh and try again." />;');
  });
});
