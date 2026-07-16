import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const signals = fs.readFileSync('lib/family/signals.ts', 'utf8');
const page = fs.readFileSync('app/(app)/dashboard/autonomous-family-management/page.tsx', 'utf8');

describe('autonomous family management read boundary', () => {
  it('preserves required signal and automation read failures before rendering controls', () => {
    expect(signals).toContain('export async function gatherSignalsResult');
    expect(signals).toContain(".find((result) => result.error)?.error");
    expect(page).toContain('const readError = signals.error ?? recs.error ?? rules.error ?? pendingRuns.error ?? doneRuns.error;');
    expect(page).toContain('Could not load autonomous family management data from Supabase. Refresh and try again.');
    expect(page).toContain('return <ReadFailure />;');
  });
});
