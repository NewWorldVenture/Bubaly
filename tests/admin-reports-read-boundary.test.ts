import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/admin/reports/page.tsx', 'utf8');

describe('admin reports read boundary', () => {
  it('does not turn any analytics query failure into zero-valued reports', () => {
    expect(source).toContain('familyCountResult.error');
    expect(source).toContain('activityResult.error');
    expect(source).toContain('const readError = [');
    expectSays(source, 'reports.couldNotLoadReportsFrom', 'Could not load reports from Supabase. Refresh and try again.');
  });
});
