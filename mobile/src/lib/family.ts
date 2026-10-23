import type { Db } from './db';

export type ActiveFamily = {
  familyId: string;
  familyName: string;
  timezone: string;
  memberId: string;
  role: string;
  displayName: string;
};

export type MembershipRow = {
  id: string;
  family_id: string;
  role: string;
  display_name: string;
  created_at?: string | null;
  families: { name: string; timezone: string | null } | null;
};

// The server's rule, mirrored: the preferred family if still a member, else the
// EARLIEST membership, ties on the family id (lib/auth/active-membership.ts,
// `chooseActiveMembership`). Duplicated rather than imported for the reason
// auth-core.ts gives for isRetryableAuthError — Metro bundles only this
// project, ../design and ../shared — and the root suite asserts parity
// (tests/mobile-family-pick-parity.test.ts).
//
// Row 0 of an unordered scan is NOT a rule. Postgres returns heap order, and an
// UPDATE writes the row's new version at the end of the heap, so a user in two
// families with no stored preference (or one naming a family they left) saw
// the phone's household flip after a member rename — while every bearer route
// (lib/supabase/bearer.ts) kept the server's answer, and each assistant turn,
// transcription and calendar read came back 409 family_changed / context_changed
// for as long as the two disagreed.
function millis(row: MembershipRow): number {
  const ms = row.created_at ? Date.parse(row.created_at) : Number.NaN;
  // A row without a readable timestamp sorts last, so a partial select can
  // never outrank a membership whose age is known.
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}
function earliestFirst(a: MembershipRow, b: MembershipRow): number {
  const at = millis(a);
  const bt = millis(b);
  if (at !== bt) return at < bt ? -1 : 1;
  return a.family_id < b.family_id ? -1 : a.family_id > b.family_id ? 1 : 0;
}

/** Same rule as the web: the preferred family if still a member, else the earliest. */
export function pickActiveFamily(rows: MembershipRow[], activeFamilyId: string | null | undefined): ActiveFamily | null {
  const usable = rows.filter((r): r is MembershipRow & { families: NonNullable<MembershipRow['families']> } => Boolean(r.families));
  if (usable.length === 0) return null;
  const chosen = (activeFamilyId ? usable.find((r) => r.family_id === activeFamilyId) : undefined) ?? [...usable].sort(earliestFirst)[0];
  return {
    familyId: chosen.family_id,
    familyName: chosen.families.name,
    timezone: chosen.families.timezone || 'UTC',
    memberId: chosen.id,
    role: chosen.role,
    displayName: chosen.display_name,
  };
}

export async function resolveActiveFamily(supabase: Db, userId: string): Promise<ActiveFamily | null> {
  const [{ data: rows, error }, { data: prefs, error: prefsError }] = await Promise.all([
    supabase.from('family_members').select('id, family_id, role, display_name, created_at, families(name, timezone)').eq('user_id', userId).eq('is_active', true),
    supabase.from('user_preferences').select('active_family_id').eq('user_id', userId).maybeSingle(),
  ]);
  if (error) throw error;
  if (prefsError) throw prefsError;
  return pickActiveFamily((rows ?? []) as unknown as MembershipRow[], prefs?.active_family_id);
}
