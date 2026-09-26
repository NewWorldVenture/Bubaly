// What the family-vote panel shows, derived the same way the recipes page
// derives it.
//
// `meal_vote_ballots` is written by TWO surfaces with different models:
//
//   * app/(app)/dashboard/recipes/vote/actions.ts — castBallot() UPSERTS one
//     ballot PER OPTION with choice 'yes' | 'no' | 'maybe', keyed on
//     (option_id, member_id). A member is expected to hold a ballot on every
//     option: that is the whole point of "maybe".
//
//   * components/modules/meals-module.tsx — castVote() clears the member's
//     ballots for the vote and inserts a single one with choice 'yes'.
//
// The panel used to count rows and ignore `choice` entirely:
//
//     const tally = (optId) => data.ballots.filter(b => b.option_id === optId).length;
//     const total = data.ballots.length || 1;
//     const myPick = data.ballots.find(b => b.member_id === selfId)?.option_id;
//
// so a ballot the recipes page recorded as 'no' was counted as a vote FOR that
// option, `total` counted one member's three opinions as three voters, and
// `myPick` could show, with a filled thumbs-up, the option you voted against.
//
// The correct tally already existed — `tallyVotes` in lib/recipes/voting.ts —
// and had not reached this call site. These helpers are that function, asked
// the three questions the panel asks.
import { tallyVotes } from '@/lib/recipes/voting';

export type PanelBallot = { option_id: string; member_id: string; choice: string | null };

/** Votes FOR each option. A 'no' is not a vote for the thing it is against. */
export function panelTallies(optionIds: string[], ballots: PanelBallot[]): Map<string, number> {
  const scored = tallyVotes(optionIds, ballots.map((b) => ({ option_id: b.option_id, choice: b.choice ?? 'yes' })));
  return new Map(scored.map((t) => [t.optionId, t.yes]));
}

/**
 * The denominator: how many PEOPLE have voted, not how many rows they wrote.
 * Never zero, so the bar percentages stay finite.
 */
export function panelVoterCount(ballots: PanelBallot[]): number {
  return new Set(ballots.map((b) => b.member_id)).size || 1;
}

/** The option this member is FOR, if any. A 'no' or 'maybe' is not a pick. */
export function panelMyPick(ballots: PanelBallot[], memberId: string | null): string | null {
  if (!memberId) return null;
  return ballots.find((b) => b.member_id === memberId && (b.choice ?? 'yes') === 'yes')?.option_id ?? null;
}
