import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/calm/page.tsx', 'utf8');

describe('Calm dashboard read boundary', () => {
  it('preserves inbox and reasoning failures before building the inbox', () => {
    expect(page).toContain('type ReadResult<T> = { data: T[]; error: unknown | null };');
    expect(page).toContain('const readError = [agentResult.error, autopilotResult.error, foiResult.error, approvalResult.error, reminderResult.error]');
    expect(page).toContain("console.error('[dashboard-calm] inbox read failed'");
    expect(page).toContain("console.error('[dashboard-calm] reasoning context read failed'");
    expectSays(page, 'calm.couldNotLoadYourCalm', 'Could not load your Calm inbox from Supabase. Refresh and try again.');
    expect(page).toContain("return <ErrorState message={");
    expectSays(page, 'calm.couldNotLoadYourCalm', "Could not load your Calm inbox from Supabase. Refresh and try again.");
  });
});
