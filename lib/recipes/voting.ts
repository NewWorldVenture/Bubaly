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
