import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/recipes/vote/page.tsx', 'utf8');

// PLA-0808: the meal-voting page's votes, options, ballots, and recipe picker
// are source-of-truth. If any read fails, it must fail closed rather than render
// an empty voting page — a family would miss an active meal vote or be unable to
// start one. A genuinely missing table (unapplied migration) is still tolerated
// as empty.
describe('recipes/vote page read boundary', () => {
  it('collects the four read errors with a missing-table filter', () => {
    expect(page).toContain('const voteError = [votesRes.error, optionsRes.error, ballotsRes.error, recipesRes.error]');
    expect(page).toContain('.find((e) => e && !isMissingTableError(e));');
  });

  it('logs and returns an ErrorState on a read failure', () => {
    expect(page).toContain('if (voteError) {');
    expect(page).toContain("console.error('[dashboard/recipes/vote] meal vote read failed', voteError);");
    expect(page).toContain("return <ErrorState message={");
    expectSays(page, 'vote.couldNotLoadMealVoting', "Could not load meal voting from Supabase. Refresh and try again.");
  });

  it('derives the vote data only after the fail-closed guard', () => {
    const guardIdx = page.indexOf('if (voteError) {');
    const deriveIdx = page.indexOf('const votes = votesRes.data;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(guardIdx);
  });
});
