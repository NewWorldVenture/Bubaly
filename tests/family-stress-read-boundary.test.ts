import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/family-stress/page.tsx', 'utf8');

describe('family stress read boundary', () => {
  it('fails visibly when stress, member, or logged-signal reads fail', () => {
    expect(page).toContain('const [signalsResult, membersResult, loggedSignalsResult]');
    expect(page).toContain('const readError = signalsResult.error ?? membersResult.error ?? loggedSignalsResult.error;');
    expect(page).toContain('Could not load family stress data from Supabase. Refresh and try again.');
    expect(page).toContain('return <ReadFailure />;');
  });
});
