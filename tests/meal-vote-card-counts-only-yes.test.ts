import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { panelMyPick, panelTallies, panelVoterCount } from '@/lib/meals/vote-panel';

// MAIN-F-J08, the part that is a defect under either voting model. The meals
// planner's vote card and /dashboard/recipes/vote read the same ballots, but
// the recipes page lets a member rate each option yes/maybe/no. The card
// counted every ballot as support, so a 👎 on Tacos there raised Tacos' bar
// here, and the card's thumbs-up marked Tacos as the viewer's pick.
//
// Main fixed the card with lib/meals/vote-panel.ts; these pin that fix against
// the ballots the two surfaces actually write.

const opts = ['tacos', 'pasta', 'soup'];

describe('the planner vote card counts support, not ballots', () => {
  it("gives the old numbers on the planner's own single-choice ballots", () => {
    const ballots = [
      { option_id: 'tacos', member_id: 'a', choice: 'yes' },
      { option_id: 'tacos', member_id: 'b', choice: 'yes' },
      { option_id: 'pasta', member_id: 'c', choice: 'yes' },
    ];
    expect([...panelTallies(opts, ballots)]).toEqual([['tacos', 2], ['pasta', 1], ['soup', 0]]);
    expect(panelVoterCount(ballots)).toBe(3);
    expect(panelMyPick(ballots, 'c')).toBe('pasta');
  });

  it('does not count a "no" or a "maybe" from the ratings page as a vote for', () => {
    const ballots = [
      { option_id: 'tacos', member_id: 'a', choice: 'no' },
      { option_id: 'pasta', member_id: 'a', choice: 'yes' },
      { option_id: 'soup', member_id: 'b', choice: 'maybe' },
    ];
    const tallies = panelTallies(opts, ballots);
    expect(tallies.get('tacos')).toBe(0);
    expect(tallies.get('soup')).toBe(0);
    expect(tallies.get('pasta')).toBe(1);
    expect(panelMyPick(ballots, 'a'), 'the thumbs-up follows the yes, not the first ballot').toBe('pasta');
    expect(panelMyPick(ballots, 'b'), 'a maybe is not a pick').toBeNull();
  });

  it('counts a member once in the denominator however many options they rate', () => {
    const ballots = [
      { option_id: 'tacos', member_id: 'a', choice: 'yes' },
      { option_id: 'pasta', member_id: 'a', choice: 'yes' },
    ];
    expect(panelVoterCount(ballots)).toBe(1);
    expect(panelMyPick(ballots, null)).toBeNull();
  });

  it('the card uses them, and no longer counts rows', () => {
    const src = readFileSync('components/modules/meals-module.tsx', 'utf8');
    expect(src).toContain('panelTallies(data.options.map((o) => o.id), data.ballots)');
    expect(src).toContain('panelVoterCount(data.ballots)');
    expect(src).toContain('panelMyPick(data.ballots, selfId)');
    expect(src).not.toContain('data.ballots.filter((b) => b.option_id === optId).length');
  });
});
