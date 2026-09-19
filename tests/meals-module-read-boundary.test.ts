import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// A-10 — the Meals module's secondary/enhancement client reads (the "add from
// your meals" library and the weekly dinner-vote panel) must not swallow a read
// failure into a silent empty list. The primary meal_plans read already fails
// visibly via useRealtimeQuery → <ErrorState>; these guards keep the two
// secondary reads from regressing back to a silent `data ?? []`.
const src = readFileSync('components/modules/meals-module.tsx', 'utf8');

describe('meals-module secondary reads log on failure', () => {
  it('the meal-library read checks + logs its error', () => {
    expect(src).toContain("console.error('[meals] library read failed'");
  });

  it('the weekly vote read checks + logs its error', () => {
    expect(src).toContain("console.error('[meals] vote read failed'");
    expect(src).toContain("console.error('[meals] vote detail read failed'");
  });

  it('no longer destructures only `data` from the library read (the silent pattern)', () => {
    expect(src).not.toContain('.then(({ data }) => setLibrary(data ?? []))');
  });
});

// The write side of the same panel, and a stronger claim than the reads above:
// here a discarded error does not hide data, it CORRUPTS a tally.
//
// `castVote` clears the member's prior pick and then inserts the new one. The
// comment says "one ballot per member", but the database says something else —
// `meal_vote_ballots_once` is UNIQUE (option_id, member_id), i.e. one ballot per
// member per OPTION. A member switching from option A to option B therefore
// inserts a DIFFERENT key, and the constraint never fires.
//
// So with the delete's error discarded, a failed clear plus a successful insert
// left that member holding ballots on both options while the toast said "Vote
// recorded". The panel's tally is
//     tally(opt) = ballots.filter(b => b.option_id === opt).length
//     total      = ballots.length
// so the doubled member adds one to each of two meals AND two to the
// denominator: one person deciding a family's dinner twice, for two dinners.
describe('castVote does not leave a member holding two ballots', () => {
  const castVote = src.slice(src.indexOf('async function castVote'), src.indexOf('async function castVote') + 1400);

  it('checks the error from the clear before inserting the new ballot', () => {
    expect(castVote).toMatch(/const\s*\{\s*error:\s*clearError\s*\}\s*=\s*await[\s\S]*?\.delete\(\)/);
    expect(castVote).toContain('if (clearError) return toastError(describeDbError(clearError));');
  });

  it('does not clear in statement position (the shape that discarded it)', () => {
    // `await sb.from(...).delete()` as a bare statement is the original defect.
    expect(castVote).not.toMatch(/^\s*await\s+sb\.from\('meal_vote_ballots'\)\s*\.delete\(\)/m);
  });

  it('still reports the insert failure it always did', () => {
    expect(castVote).toContain('if (error) return toastError(describeDbError(error));');
  });
});
