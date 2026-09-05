// Who is in this household, what they may do, and how to turn the name a
// person (or the model) said into a member id.
//
// `resolveMemberByName` is a copy of the resolver in `lib/assistant/tools.ts`
// (`resolveMember`), not a move: that file is retargeted onto the services in
// a later item and editing it now would collide with the tool-registry work
// happening in parallel. The behaviour is deliberately identical — exact
// case-insensitive match first, then prefix, then substring — so that
// retargeting is a pure deletion there rather than a behaviour change.
//
// Age is derived, never stored: `family_members.birthday` is the fact, and
// `lib/members/age.ts ageOn` is the single implementation of "how old is this
// member today" shared with the client surfaces.
import 'server-only';
import { ageOn } from '@/lib/members/age';
import { isManager, type MemberRole } from '@/lib/constants/roles';
import type { Json, Tables } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { scopeNow } from '../scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type FamilyMember = {
  id: string;
  userId: string | null;
  displayName: string;
  role: MemberRole;
  birthday: string | null;
  /** Whole years old today in the family's zone; null when no birthday is on file. */
  age: number | null;
  isActive: boolean;
  /** True for parent/adult — the roles `public.can_manage_family` admits. */
  canManage: boolean;
  /** False for a managed profile (no login), which cannot be notified or assigned an account-scoped row. */
  hasLogin: boolean;
  color: string | null;
  avatarUrl: string | null;
};

function toMember(row: Tables<'family_members'>, today: Date): FamilyMember {
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role,
    birthday: row.birthday,
    age: ageOn(row.birthday, today),
    isActive: row.is_active,
    canManage: isManager(row.role),
    hasLogin: row.user_id !== null,
    color: row.color,
    avatarUrl: row.avatar_url,
  };
}

/**
 * The household roster. Inactive members are excluded by default because every
 * caller that assigns work wants people who are still in the family; the
 * admin surfaces that manage removals ask for them explicitly.
 */
export async function getMembers(
  scope: ServiceScope,
  opts?: { includeInactive?: boolean },
): Promise<ServiceResult<FamilyMember[]>> {
  let query = scope.db
    .from('family_members')
    .select('*')
    .eq('family_id', scope.familyId)
    .order('created_at', { ascending: true });
  if (!opts?.includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) {
    console.error('[service:family] member read failed', error);
    return fail(describeDbError(error, 'Could not load your family members.'), { code: SERVICE_CODES.db });
  }
  const today = scopeNow(scope);
  return ok((data ?? []).map((row) => toMember(row, today)));
}

/** One member by id, scoped to the family so an id from elsewhere cannot leak a row. */
export async function getMember(scope: ServiceScope, memberId: string): Promise<ServiceResult<FamilyMember>> {
  const { data, error } = await scope.db
    .from('family_members')
    .select('*')
    .eq('id', memberId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (error) {
    console.error('[service:family] member lookup failed', error);
    return fail(describeDbError(error, 'Could not load that family member.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That family member could not be found.', { code: SERVICE_CODES.notFound });
  return ok(toMember(data, scopeNow(scope)));
}

/**
 * Guard for a continuation: a run approved yesterday must not execute today
 * against a member who has since been removed, and the role must be re-read
 * rather than trusted from the stored request row.
 */
export async function assertActiveMember(scope: ServiceScope, memberId: string): Promise<ServiceResult<FamilyMember>> {
  const res = await getMember(scope, memberId);
  if (!res.ok) return res;
  if (!res.data.isActive) {
    return fail(`${res.data.displayName} is no longer an active member of this family.`, { code: SERVICE_CODES.denied });
  }
  return res;
}

/**
 * Pure name matcher, exported so the resolution rules are testable without a
 * database. Order matters: an exact match must beat a prefix match, or a
 * family with "Sam" and "Samantha" resolves "Sam" to the wrong person.
 */
export function matchMemberByName<T extends { id: string; displayName: string }>(members: T[], name: string): T | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const exact = members.find((m) => m.displayName.trim().toLowerCase() === q);
  if (exact) return exact;
  const prefix = members.find((m) => m.displayName.trim().toLowerCase().startsWith(q));
  if (prefix) return prefix;
  return members.find((m) => m.displayName.trim().toLowerCase().includes(q)) ?? null;
}

/**
 * Turn "mom" / "Ava" into a member id. Returns `ok(null)` for an unmatched
 * name rather than an error: "add a task for Ava" when there is no Ava is a
 * fact the caller reports back to the user, not a database failure.
 */
export async function resolveMemberByName(
  scope: ServiceScope,
  name: string | null | undefined,
): Promise<ServiceResult<FamilyMember | null>> {
  if (!name || !name.trim()) return ok(null);
  const members = await getMembers(scope);
  if (!members.ok) return members;
  return ok(matchMemberByName(members.data, name));
}

export type FamilyPreferences = {
  familyId: string;
  familyName: string;
  timezone: string;
  /** Per-user settings for the acting member; absent for cron/system scopes. */
  user: {
    theme: string;
    pushEnabled: boolean;
    emailEnabled: boolean;
    notificationPrefs: Record<string, Json | undefined>;
  } | null;
};

/**
 * Family-level settings plus the acting user's own preferences.
 *
 * `user_preferences` is own-row-only under RLS (0004), so a cron scope
 * (`userId: null`) legitimately gets `user: null` — that is a missing actor,
 * not a missing row, and callers treat it as "use the defaults".
 */
export async function getPreferences(scope: ServiceScope): Promise<ServiceResult<FamilyPreferences>> {
  const { data: family, error: familyError } = await scope.db
    .from('families')
    .select('id, name, timezone')
    .eq('id', scope.familyId)
    .maybeSingle();
  if (familyError) {
    console.error('[service:family] family read failed', familyError);
    return fail(describeDbError(familyError, 'Could not load your family settings.'), { code: SERVICE_CODES.db });
  }
  if (!family) return fail('That family could not be found.', { code: SERVICE_CODES.notFound });

  if (!scope.userId) {
    return ok({ familyId: family.id, familyName: family.name, timezone: family.timezone || scope.tz, user: null });
  }

  const { data: prefs, error: prefsError } = await scope.db
    .from('user_preferences')
    .select('theme, push_enabled, email_enabled, notification_prefs')
    .eq('user_id', scope.userId)
    .maybeSingle();
  if (prefsError) {
    console.error('[service:family] preference read failed', prefsError);
    return fail(describeDbError(prefsError, 'Could not load your preferences.'), { code: SERVICE_CODES.db });
  }

  return ok({
    familyId: family.id,
    familyName: family.name,
    timezone: family.timezone || scope.tz,
    user: {
      // A user who has never opened Settings has no row; 0002's column defaults
      // are the honest answer rather than a fabricated one.
      theme: prefs?.theme ?? 'dark',
      pushEnabled: prefs?.push_enabled ?? true,
      emailEnabled: prefs?.email_enabled ?? true,
      notificationPrefs: (prefs?.notification_prefs as Record<string, Json | undefined> | null) ?? {},
    },
  });
}
