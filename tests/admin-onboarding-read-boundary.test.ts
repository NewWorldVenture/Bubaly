import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/onboarding/page.tsx', 'utf8');

describe('onboarding audit read boundary', () => {
  it('fails visibly when onboarding progress cannot be read', () => {
    expect(page).toContain('if (progressResult.error) return <ReadFailure />;');
    expectSays(page, 'onboarding.couldNotLoadOnboardingAudit', 'Could not load onboarding audit data from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
