import type { Db } from './db';
import { chooseActiveMembership } from '../../../shared/auth/active-membership';

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

/**
 * The server's rule, not a copy of it: the preferred family if still a member,
 * else the EARLIEST membership. The phone sends this choice as
 * X-Bubaly-Family-Id and the bearer context answers 409 when it picked another,
 * so row 0 of an unordered query (heap order, which a display-name edit
 * reshuffles) left multi-family accounts unable to use the assistant or calendar.
 */
export function pickActiveFamily(rows: MembershipRow[], activeFamilyId: string | null | undefined): ActiveFamily | null {
  const usable = rows.filter((r): r is MembershipRow & { families: NonNullable<MembershipRow['families']> } => Boolean(r.families));
  const chosen = chooseActiveMembership(usable, activeFamilyId);
  if (!chosen) return null;
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
    // created_at is what the earliest-membership fallback orders by.
    supabase.from('family_members').select('id, family_id, role, display_name, created_at, families(name, timezone)').eq('user_id', userId).eq('is_active', true),
    supabase.from('user_preferences').select('active_family_id').eq('user_id', userId).maybeSingle(),
  ]);
  if (error) throw error;
  if (prefsError) throw prefsError;
  return pickActiveFamily((rows ?? []) as unknown as MembershipRow[], prefs?.active_family_id);
}
