import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/family-automation/page.tsx', 'utf8');

describe('family automation read boundary', () => {
  it('fails visibly when rules or automation run feeds fail', () => {
    expect(page).toContain('const [rulesResult, pendingResult, recentResult]');
    expect(page).toContain('const readError = rulesResult.error ?? pendingResult.error ?? recentResult.error;');
    expectSays(page, 'familyAutomation.couldNotLoadFamilyAutomation', 'Could not load family automation data from Supabase. Refresh and try again.');
    expect(page).toContain('return <ReadFailure />;');
  });
});
