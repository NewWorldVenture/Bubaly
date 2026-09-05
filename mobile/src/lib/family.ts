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
  families: { name: string; timezone: string | null } | null;
};

/** Same rule as the web: the preferred family if still a member, else the first. */
export function pickActiveFamily(rows: MembershipRow[], activeFamilyId: string | null | undefined): ActiveFamily | null {
  const usable = rows.filter((r): r is MembershipRow & { families: NonNullable<MembershipRow['families']> } => Boolean(r.families));
  if (usable.length === 0) return null;
  const chosen = usable.find((r) => r.family_id === activeFamilyId) ?? usable[0];
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
    supabase.from('family_members').select('id, family_id, role, display_name, families(name, timezone)').eq('user_id', userId).eq('is_active', true),
    supabase.from('user_preferences').select('active_family_id').eq('user_id', userId).maybeSingle(),
  ]);
  if (error) throw error;
  if (prefsError) throw prefsError;
  return pickActiveFamily((rows ?? []) as unknown as MembershipRow[], prefs?.active_family_id);
}
