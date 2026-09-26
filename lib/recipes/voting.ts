// Pure meal-vote tallying — unit tested, no deps.
// Score = yes (+1) + maybe (+0.5) − no (−0.5). Winner = highest score, ties
// broken by most "yes", then earliest option order (stable input order).

export type Ballot = { option_id: string; choice: 'yes' | 'no' | 'maybe' | string };

export type OptionTally = {
  optionId: string;
  yes: number;
  no: number;
  maybe: number;
  score: number;
};

export function tallyVotes(optionIds: string[], ballots: Ballot[]): OptionTally[] {
  const map = new Map<string, OptionTally>();
  for (const id of optionIds) map.set(id, { optionId: id, yes: 0, no: 0, maybe: 0, score: 0 });
  for (const b of ballots) {
    const t = map.get(b.option_id);
    if (!t) continue;
    if (b.choice === 'yes') t.yes++;
    else if (b.choice === 'no') t.no++;
    else if (b.choice === 'maybe') t.maybe++;
  }
  for (const t of map.values()) t.score = t.yes + t.maybe * 0.5 - t.no * 0.5;
  // Preserve input order so ties resolve deterministically.
  return optionIds.map((id) => map.get(id)!);
}

/** The winning option id, or null if there are no votes at all. */
export function winningOption(tallies: OptionTally[]): string | null {
  const voted = tallies.filter((t) => t.yes + t.no + t.maybe > 0);
  if (voted.length === 0) return null;
  let best = tallies[0];
  for (const t of tallies) {
    if (t.score > best.score || (t.score === best.score && t.yes > best.yes)) best = t;
  }
  return (best.yes + best.no + best.maybe) > 0 ? best.optionId : null;
}

export type VoteSummary = { totalBallots: number; voters: number };
export function summarizeBallots(ballots: { member_id: string }[]): VoteSummary {
  return { totalBallots: ballots.length, voters: new Set(ballots.map((b) => b.member_id)).size };
}

/**
 * The meals planner's vote card: for each option, how many members said YES,
 * as a share of the members who said yes to anything, and which option the
 * viewer said yes to.
 *
 * The card used to count every ballot on an option as support. Ballots are
 * shared with /dashboard/recipes/vote, where a member rates each option
 * yes/maybe/no, so a 👎 cast there raised that meal's bar here. Counting only
 * `yes` over distinct members gives exactly the old numbers on the planner's
 * own ballots (one `yes` per member) and stops a "no" reading as a vote for.
 */
export function yesShares(
  optionIds: string[],
  ballots: (Ballot & { member_id: string })[],
  selfId: string | null,
): { yes: Map<string, number>; voters: number; mine: string | null } {
  const yes = new Map(optionIds.map((id) => [id, 0]));
  const voters = new Set<string>();
  let mine: string | null = null;
  for (const b of ballots) {
    if (b.choice !== 'yes' || !yes.has(b.option_id)) continue;
    yes.set(b.option_id, (yes.get(b.option_id) ?? 0) + 1);
    voters.add(b.member_id);
    if (mine === null && b.member_id === selfId) mine = b.option_id;
  }
  return { yes, voters: voters.size, mine };
}
