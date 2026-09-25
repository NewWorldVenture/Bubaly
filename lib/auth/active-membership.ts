/**
 * Which of a user's families is active.
 *
 * A stored preference wins when it names one of their current families. When
 * it does not (none stored, or it names a family they have since left), the
 * earliest membership is used: for someone who made a family and later joined
 * another, that is the one they made.
 *
 * Four resolvers ask this question — the cookie context, the bearer context,
 * the billing gate and the document-link check, which compares its answer to
 * the cookie context's — and each used to take row 0 of an unordered query.
 * Postgres returns an unordered scan in heap order, and an UPDATE writes the
 * row's new version at the end of the heap, so renaming a member in one family
 * moved which family they landed in (measured: Home,Second -> Second,Home after
 * a display-name edit). One ordering, here, keeps the four in agreement and the
 * answer stable across edits. Ties on the timestamp break on the family id.
 */
export interface MembershipRow {
  family_id: string;
  created_at?: string | null;
}

// A row without a readable timestamp sorts last rather than first, so a
// partial select can never outrank a membership whose age is known.
function millis(row: MembershipRow): number {
  const ms = row.created_at ? Date.parse(row.created_at) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function earliestFirst(a: MembershipRow, b: MembershipRow): number {
  const at = millis(a);
  const bt = millis(b);
  if (at !== bt) return at < bt ? -1 : 1;
  return a.family_id < b.family_id ? -1 : a.family_id > b.family_id ? 1 : 0;
}

export function chooseActiveMembership<T extends MembershipRow>(
  rows: readonly T[],
  preferredFamilyId: string | null | undefined,
): T | undefined {
  const preferred = preferredFamilyId ? rows.find((row) => row.family_id === preferredFamilyId) : undefined;
  return preferred ?? [...rows].sort(earliestFirst)[0];
}
