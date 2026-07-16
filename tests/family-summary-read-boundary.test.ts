import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const operations = fs.readFileSync('app/(app)/dashboard/family-operations/page.tsx', 'utf8');
const reports = fs.readFileSync('app/(app)/family/reports/page.tsx', 'utf8');

describe('family summary read boundaries', () => {
  it('fails visibly before rendering operations or reports after signal-read failure', () => {
    expect(operations).toContain('const result = await gatherSignalsResult');
    expect(operations).toContain('Could not load family operations data from Supabase. Refresh and try again.');
    expect(reports).toContain('const result = await gatherSignalsResult');
    expect(reports).toContain('Could not load family reports from Supabase. Refresh and try again.');
    expect(operations).toContain('return <ReadFailure />;');
    expect(reports).toContain('return <ReadFailure />;');
  });
});
