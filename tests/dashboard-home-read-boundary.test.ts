import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/page.tsx', 'utf8');

describe('dashboard home read boundary', () => {
  it('fails visibly when the saved dashboard preference cannot be read', () => {
    expect(page).toContain('const { data: prefs, error: prefsError }');
    expect(page).toContain('if (prefsError)');
    expect(page).toContain('Could not load your dashboard preference from Supabase. Refresh and try again.');
    expect(page).toContain('return <ReadFailure />;');
  });
});
