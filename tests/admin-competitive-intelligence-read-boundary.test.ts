import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/marketing/competitive/page.tsx', 'utf8');

describe('competitive intelligence read boundary', () => {
  it('fails visibly when any CRUD source table cannot be read', () => {
    expect(page).toContain('if (results.some((result) => result.error)) return <ReadFailure />;');
    expectSays(page, 'competitive.couldNotLoadCompetitiveIntelligence', 'Could not load competitive intelligence from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
