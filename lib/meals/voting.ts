// lib/meals/voting.ts — pure helpers for Family Meal Voting (meal_polls).
// A poll's options + the members who voted live in one jsonb array on the row.

export interface PollOption {
  id: string;
  label: string;
  emoji?: string | null;
  meal_id?: string | null;
  recipe_id?: string | null;
  voter_ids: string[];
}

/** Coerce arbitrary jsonb into a clean, well-typed option list. */
export function normalizeOptions(raw: unknown): PollOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
    .map((o) => ({
      id: String(o.id ?? cryptoRandomish(o)),
      label: String(o.label ?? '').trim(),
      emoji: typeof o.emoji === 'string' ? o.emoji : null,
      meal_id: typeof o.meal_id === 'string' ? o.meal_id : null,
      recipe_id: typeof o.recipe_id === 'string' ? o.recipe_id : null,
      voter_ids: Array.isArray(o.voter_ids) ? o.voter_ids.filter((x): x is string => typeof x === 'string') : [],
    }))
    .filter((o) => o.label.length > 0);
}

// Deterministic-ish fallback id when an option arrives without one (label-based).
function cryptoRandomish(o: Record<string, unknown>): string {
  const base = String(o.label ?? 'option');
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) | 0;
  return `opt_${(h >>> 0).toString(36)}`;
}

/**
 * Toggle a single-choice vote for `memberId` onto `optionId`. The member is
 * removed from every other option first (one vote per member), and clicking
 * their current choice again clears it. Returns a NEW options array.
 */
export function castVote(options: PollOption[], optionId: string, memberId: string): PollOption[] {
  const already = options.find((o) => o.id === optionId)?.voter_ids.includes(memberId);
  return options.map((o) => {
    const without = o.voter_ids.filter((v) => v !== memberId);
    if (o.id === optionId && !already) return { ...o, voter_ids: [...without, memberId] };
    return { ...o, voter_ids: without };
  });
}

export function totalVotes(options: PollOption[]): number {
  return options.reduce((sum, o) => sum + o.voter_ids.length, 0);
}

/** Which option a member currently backs (or null). */
export function memberVote(options: PollOption[], memberId: string): string | null {
  return options.find((o) => o.voter_ids.includes(memberId))?.id ?? null;
}

/** Percentage share of the total vote for an option (0 when no votes yet). */
export function votePercent(options: PollOption[], optionId: string): number {
  const total = totalVotes(options);
  if (total === 0) return 0;
  const n = options.find((o) => o.id === optionId)?.voter_ids.length ?? 0;
  return Math.round((n / total) * 100);
}

/** The leading option(s). Returns all options tied for the most votes, or [] if
 *  nobody has voted. Useful for declaring a winner / highlighting the front-runner. */
export function leadingOptions(options: PollOption[]): PollOption[] {
  const max = Math.max(0, ...options.map((o) => o.voter_ids.length));
  if (max === 0) return [];
  return options.filter((o) => o.voter_ids.length === max);
}

/** A poll is decided when exactly one option leads with at least one vote. */
export function winnerLabel(options: PollOption[]): string | null {
  const leaders = leadingOptions(options);
  return leaders.length === 1 ? leaders[0].label : null;
}
