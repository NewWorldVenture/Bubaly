// `meal_vote_ballots` has two writers with different models, and the family
// vote panel only understood one of them.
//
//   * the recipes page (castBallot) UPSERTS one ballot PER OPTION carrying
//     choice 'yes' | 'no' | 'maybe', keyed (option_id, member_id). Holding a
//     ballot on every option is the point — that is what "maybe" is for.
//   * the meals module (castVote) clears and inserts a single 'yes'.
//
// The panel counted rows and never read `choice`, so ballots the recipes page
// wrote were misread three ways at once. These cases use ballots in exactly
// the shape castBallot writes.
import { describe, expect, it } from 'vitest';
import { panelTallies, panelVoterCount, panelMyPick } from '@/lib/meals/vote-panel';

const OPTIONS = ['curry', 'pasta', 'tacos'];

/** One parent rating every option through the recipes page: the normal case there. */
const MUM_RATED_EVERYTHING = [
  { option_id: 'curry', member_id: 'mum', choice: 'yes' },
  { option_id: 'pasta', member_id: 'mum', choice: 'no' },
  { option_id: 'tacos', member_id: 'mum', choice: 'maybe' },
];

describe('the family vote panel reads the choice on a ballot', () => {
  it('does not count a "no" as a vote for the thing it is against', () => {
    const t = panelTallies(OPTIONS, MUM_RATED_EVERYTHING);
    expect(t.get('curry')).toBe(1);
    expect(t.get('pasta'), 'a "no" was counted as a vote for pasta').toBe(0);
    expect(t.get('tacos'), 'a "maybe" was counted as a vote for tacos').toBe(0);
  });

  it('counts people, not rows, in the denominator', () => {
    // One member rating three options is one voter. Counting rows made the
    // bars divide by three and understated everyone's share.
    expect(panelVoterCount(MUM_RATED_EVERYTHING)).toBe(1);
    expect(panelVoterCount([...MUM_RATED_EVERYTHING,
      { option_id: 'pasta', member_id: 'dad', choice: 'yes' }])).toBe(2);
  });

  it('shows as my pick the option I am for, not the first row I wrote', () => {
    // The old code took the first ballot found for the member. With the rows
    // above that is curry only by luck of ordering; reverse them and the panel
    // put a filled thumbs-up on the meal Mum voted against.
    expect(panelMyPick(MUM_RATED_EVERYTHING, 'mum')).toBe('curry');
    expect(panelMyPick([...MUM_RATED_EVERYTHING].reverse(), 'mum')).toBe('curry');
    expect(panelMyPick(MUM_RATED_EVERYTHING, 'dad')).toBe(null);
    expect(panelMyPick(MUM_RATED_EVERYTHING, null)).toBe(null);
  });

  it('still reads a ballot the meals module wrote', () => {
    // The positive control. The module inserts a single row with choice 'yes',
    // and that path must keep working exactly as before.
    const moduleStyle = [{ option_id: 'pasta', member_id: 'dad', choice: 'yes' }];
    expect(panelTallies(OPTIONS, moduleStyle).get('pasta')).toBe(1);
    expect(panelVoterCount(moduleStyle)).toBe(1);
    expect(panelMyPick(moduleStyle, 'dad')).toBe('pasta');
  });

  it('treats a missing choice as a yes, the way the column default does', () => {
    // `choice` defaults to 'yes' in the schema, so a row written without one
    // is a vote for. Dropping it would silently zero those tallies.
    const noChoice = [{ option_id: 'curry', member_id: 'kid', choice: null }];
    expect(panelTallies(OPTIONS, noChoice).get('curry')).toBe(1);
    expect(panelMyPick(noChoice, 'kid')).toBe('curry');
  });

  it('never divides by zero', () => {
    expect(panelVoterCount([])).toBe(1);
  });
});
