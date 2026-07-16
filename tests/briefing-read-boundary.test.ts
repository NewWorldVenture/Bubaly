import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/briefing/page.tsx', 'utf8');

describe('briefing read boundary', () => {
  it('fails visibly when the persisted operating index cannot be read', () => {
    expect(page).toContain('const { data: foiSnaps, error: foiError }');
    expect(page).toContain('if (foiError)');
    expect(page).toContain('Could not load your daily briefing from Supabase. Refresh and try again.');
    expect(page).toContain('return <ErrorState message="Could not load your daily briefing from Supabase. Refresh and try again." />;');
  });
});
