// lib/voting/polls.ts — pure helpers for Group Voting (collaborative decisions).
// Vote tallying, winner detection and per-member selection. No Supabase/React.

export type OptionLike = { id: string; label: string; sort?: number };
export type VoteLike = { option_id: string; member_id: string };

export type Tally = {
  optionId: string;
  label: string;
  count: number;
  pct: number;
  leading: boolean;
};

/** Per-option vote counts + percentages (of total votes cast), leader flagged.
 *  Ties: every option at the max count is flagged leading. */
export function tallyPoll(options: OptionLike[], votes: VoteLike[]): Tally[] {
  const counts = new Map<string, number>();
  for (const v of votes) counts.set(v.option_id, (counts.get(v.option_id) ?? 0) + 1);
  const total = votes.length;
  const max = Math.max(0, ...options.map((o) => counts.get(o.id) ?? 0));
  return [...options]
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .map((o) => {
      const count = counts.get(o.id) ?? 0;
      return { optionId: o.id, label: o.label, count, pct: total ? Math.round((count / total) * 100) : 0, leading: count > 0 && count === max };
    });
}

/** Distinct members who have cast at least one vote in this poll. */
export function voterCount(votes: VoteLike[]): number {
  return new Set(votes.map((v) => v.member_id)).size;
}

/** Option ids a given member has selected. */
export function memberSelections(votes: VoteLike[], memberId: string): Set<string> {
  return new Set(votes.filter((v) => v.member_id === memberId).map((v) => v.option_id));
}

/** Winning option label(s) once enough votes exist (null if no votes). */
export function winningLabels(tally: Tally[]): string[] {
  return tally.filter((t) => t.leading).map((t) => t.label);
}

/** A poll is effectively closed if explicitly closed or past its deadline. */
export function isPollClosed(status: string, closesAt: string | null | undefined, now = new Date()): boolean {
  if (status === 'closed') return true;
  if (closesAt) return new Date(closesAt).getTime() <= now.getTime();
  return false;
}
