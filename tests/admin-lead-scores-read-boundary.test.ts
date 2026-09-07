import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/marketing/lead-scores/page.tsx', 'utf8');

describe('lead scores read boundary', () => {
  it('fails visibly when score or contact reads fail', () => {
    expect(page).toContain('if (scoresResult.error) return <ReadFailure />;');
    expect(page).toContain('if (contactsResult.error) return <ReadFailure />;');
    expectSays(page, 'leadScores.couldNotLoadLeadScores', 'Could not load lead scores from Supabase. Refresh and try again.');
  });
});
