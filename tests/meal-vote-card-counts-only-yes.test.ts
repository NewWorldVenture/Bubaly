import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { yesShares } from '@/lib/recipes/voting';

// MAIN-F-J08, the part that is a defect under either voting model. The meals
// planner's vote card and /dashboard/recipes/vote read the same ballots, but
// the recipes page lets a member rate each option yes/maybe/no. The card
// counted every ballot as support, so a 👎 on Tacos there raised Tacos' bar
// here, and the card's thumbs-up marked Tacos as the viewer's pick.

const opts = ['tacos', 'pasta', 'soup'];

describe('the planner vote card counts support, not ballots', () => {
  it('gives the old numbers on the planner\'s own single-choice ballots', () => {
    const r = yesShares(opts, [
      { option_id: 'tacos', member_id: 'a', choice: 'yes' },
      { option_id: 'tacos', member_id: 'b', choice: 'yes' },
      { option_id: 'pasta', member_id: 'c', choice: 'yes' },
    ], 'c');
    expect([...r.yes]).toEqual([['tacos', 2], ['pasta', 1], ['soup', 0]]);
    expect(r.voters).toBe(3); // == ballots.length, the old denominator
    expect(r.mine).toBe('pasta');
  });

  it('does not count a "no" or a "maybe" from the ratings page as a vote for', () => {
    const r = yesShares(opts, [
      { option_id: 'tacos', member_id: 'a', choice: 'no' },
      { option_id: 'pasta', member_id: 'a', choice: 'yes' },
      { option_id: 'soup', member_id: 'b', choice: 'maybe' },
    ], 'a');
    expect(r.yes.get('tacos')).toBe(0);
    expect(r.yes.get('soup')).toBe(0);
    expect(r.voters).toBe(1);
    expect(r.mine, 'the thumbs-up follows the yes, not the first ballot').toBe('pasta');
  });

  it('counts a member once in the denominator however many options they approve', () => {
    const r = yesShares(opts, [
      { option_id: 'tacos', member_id: 'a', choice: 'yes' },
      { option_id: 'pasta', member_id: 'a', choice: 'yes' },
    ], null);
    expect(r.voters).toBe(1);
    expect(r.mine).toBeNull();
  });

  it('ignores a ballot for an option that is not on this vote', () => {
    expect(yesShares(opts, [{ option_id: 'gone', member_id: 'a', choice: 'yes' }], 'a')).toMatchObject({ voters: 0, mine: null });
  });

  it('the card uses it', () => {
    const src = readFileSync('components/modules/meals-module.tsx', 'utf8');
    expect(src).toContain('yesShares(data.options.map((o) => o.id), data.ballots, selfId)');
    expect(src).not.toContain('data.ballots.filter((b) => b.option_id === optId).length');
  });
});
