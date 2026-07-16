import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/onboarding/page.tsx', 'utf8');

describe('onboarding audit read boundary', () => {
  it('fails visibly when onboarding progress cannot be read', () => {
    expect(page).toContain('if (progressResult.error) return <ReadFailure />;');
    expect(page).toContain('Could not load onboarding audit data from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
