// The briefing's recap must be TODAY's, and a failed read must stay visible.
//
// This file used to pin the page's own hand-rolled read — including the literal
// `const { data: foiSnaps, error: foiError }` — which is how the staleness
// survived: the assertions described the shape of the code rather than what a
// family gets, so the code and the test agreed with each other and both were
// wrong. `family_operating_index` is written LAZILY (by `loadOperatingIndex`'s
// upsert), so on a morning when nobody has opened the Command Center or the
// Operating Index page there is no row for today, and reading "the two most
// recent rows" diffed YESTERDAY against THE DAY BEFORE under the title "Since
// yesterday".
//
// The anchor that makes it correct is asserted behaviourally, against the real
// function, in tests/operating-index-today-anchor.test.ts. What is checked here
// is that the page delegates to it instead of growing a second copy.
import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/briefing/page.tsx', 'utf8');

describe('briefing read boundary', () => {
  it('takes its recap from the shared loader, not from a private snapshot read', () => {
    expect(page).toContain('loadOperatingIndex(supabase, ctx.active.familyId)');
    expect(page).toContain('const { change } = indexResult.value;');
  });

  it('never diffs two arbitrary snapshots again', () => {
    // The exact shape that made the card a day stale. Named rather than merely
    // absent-by-accident, so reintroducing it fails here.
    // Targets the QUERY, not the word: the comment above the fix explains the
    // `as_of_date` anchor, and a test that forbade the word would punish
    // documenting the very thing it protects.
    expect(page).not.toContain("from('family_operating_index')");
    expect(page).not.toMatch(/\.order\(\s*'as_of_date'/);
    expect(page).not.toContain('summarizeChange');
    expect(page).not.toContain('foiSnaps');
  });

  it('fails visibly when the operating index cannot be read', () => {
    expect(page).toContain("if (indexResult.status === 'rejected')");
    expect(page).toContain("console.error('[dashboard/briefing] operating index read failed'");
    expect(page).toContain("return <ErrorState message={");
    expectSays(page, 'briefing.couldNotLoadYourDaily', "Could not load your daily briefing from Supabase. Refresh and try again.");
  });

  it('reads the index and the reasoning context together, not one after the other', () => {
    // The page awaited one then the other, so it paid both latencies in series.
    // `allSettled` keeps them parallel AND keeps the two failures distinguishable
    // — `all` would collapse them into whichever rejected first, and a family
    // would be told the wrong thing about what went wrong.
    expect(page).toContain('await Promise.allSettled([');
    expect(page).not.toContain('await Promise.all([');
  });
});
