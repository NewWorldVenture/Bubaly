import { at } from './helpers/source-order';
// The server half of "a failed read is not an empty one".
//
// Two pages read Supabase in a Server Component and let a failed read fall into
// the same branch as a genuinely empty one:
//
//   /marketplace/negotiations  the negotiations read is ALREADY guarded, with a
//                              comment saying exactly why — and the guard is
//                              defeated one line later. The listings read that
//                              follows it was unguarded, and every row is
//                              dropped by `if (!l) continue` when listingMap is
//                              empty, so a failed listings read renders the same
//                              false-empty offer inbox the guard exists to
//                              prevent, with the negotiations read succeeding.
//
//   /dashboard/independence    a failed family_members read renders the module
//                              with zero kids, whose empty state reads "Add a
//                              child or teen to the family to start their
//                              independence ladder." A parent with three
//                              children is told they have none, and every
//                              milestone they have recorded goes with them.
//
// These pages are async Server Components that call requireUserContext() and
// createServer(), so they are checked at the source rather than rendered: what
// matters is that the error is taken from each read and that it reaches a
// visible notice, and both halves are asserted.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';

const negotiations = readFileSync('app/(app)/marketplace/negotiations/page.tsx', 'utf8');
const independence = readFileSync('app/(app)/dashboard/independence/page.tsx', 'utf8');

describe('the offer inbox cannot be emptied by a read it did not guard', () => {
  it('takes the error from the listings read, not just the negotiations one', () => {
    expect(negotiations).toContain('const { data: negRows, error: negError }');
    expect(negotiations).toContain('const { data: listings, error: listingsError }');
  });

  it('guards the listings read before anything is filtered by it', () => {
    expect(negotiations).toContain('if (listingsError) {');
    expectSays(negotiations, 'negotiations.couldnTLoadYourOffers', 'Couldn’t load your offers. Refresh and try again.');
    // The guard has to come before the loop that drops rows missing a listing,
    // or it is decoration: by then the inbox already reads as empty.
    expect(negotiations.indexOf('if (listingsError) {'))
      .toBeLessThan(at(negotiations, 'if (!l) continue;'));
  });

  it('still returns an empty branch for a genuinely empty id list', () => {
    // listingIds.length === 0 short-circuits without a query; that path must
    // keep saying "no error" rather than becoming undefined and reading falsy
    // for the wrong reason.
    expect(negotiations).toContain('{ data: [], error: null }');
  });
});

describe('the independence ladder does not report a family with no children', () => {
  it('takes the error from the members read', () => {
    expect(independence).toContain('const { data: members, error: membersError }');
  });

  it('renders a named notice instead of the module', () => {
    expect(independence).toContain('if (membersError) {');
    expectSays(independence, 'independence.couldNotLoadYourFamily', 'Could not load your family. Refresh and try again.');
    expect(independence).toContain('<ErrorState message=');
    // The notice must short-circuit the module, not render alongside it.
    expect(independence.indexOf('if (membersError) {'))
      .toBeLessThan(at(independence, '<IndependenceModule'));
  });

  it('keeps the milestone read degrading on its own terms', () => {
    // An unapplied table is not a read failure to report at a parent: migration
    // 0175 may not have run in a given environment, and the ladder should still
    // render empty there.
    //
    // This used to assert the literal comment `/* table not applied yet */`,
    // which pinned the WORDING of a try/catch rather than the tolerance it was
    // there for — and that try/catch protected nothing, because supabase-js
    // RESOLVES with `{ data, error }` for a refused read and rejects only on a
    // transport failure. C1-S9-27 replaced it with a real check, which kept the
    // tolerance and dropped the comment, so this went red on an improvement.
    // It now asserts the tolerance itself.
    expect(independence).toContain('isMissingRelationError(milestones.error)');
    // And the tolerance must be exactly that — a missing relation, not any
    // error — or it would be the silent-empty defect wearing a new spelling.
    expect(independence).toMatch(/milestones\.error && !isMissingRelationError\(/);
  });
});
