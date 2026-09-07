import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const operations = fs.readFileSync('app/(app)/dashboard/family-operations/page.tsx', 'utf8');
const reports = fs.readFileSync('app/(app)/family/reports/page.tsx', 'utf8');

describe('family summary read boundaries', () => {
  it('fails visibly before rendering operations or reports after signal-read failure', () => {
    expect(operations).toContain('const result = await gatherSignalsResult');
    expectSays(operations, 'familyOperations.couldNotLoadFamilyOperations', 'Could not load family operations data from Supabase. Refresh and try again.');
    expect(reports).toContain('const result = await gatherSignalsResult');
    expectSays(reports, 'reports.couldNotLoadFamilyReports', 'Could not load family reports from Supabase. Refresh and try again.');
    expect(operations).toContain('return <ReadFailure />;');
    expect(reports).toContain('return <ReadFailure />;');
  });
});
