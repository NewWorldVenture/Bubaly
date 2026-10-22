import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { isChildLoginEmail } from '@/lib/onboarding/child-login';

/**
 * Whether this auth user is a parent-issued child login (username + PIN).
 *
 * Such an account exists only as a member of the family that created it. When
 * that family removes the member (a soft `is_active = false`), the account has
 * no family — and every "no family yet" path (ensureActiveFamily, onboarding's
 * family claim) used to give it a brand-new household with the child as its
 * PARENT, outside every parental control. Those paths ask this first.
 *
 * Fails CLOSED: a lookup that cannot be answered counts as a child account, so
 * the cost of an outage is a delayed provision, never an unsupervised admin.
 */
export async function isChildLoginAccount(
  admin: SupabaseClient<Database>,
  user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> | null },
): Promise<boolean> {
  if (user.user_metadata?.child === true) return true;
  // The synthetic kids-domain address is issued only to child logins, and is
  // still the account's once its child_logins row is gone: every caller —
  // requireUserContext, the AI routes' authenticateAI and /api/ai — refuses it
  // a household of its own, not the page path alone.
  if (isChildLoginEmail(user.email)) return true;
  const { data, error } = await admin.from('child_logins').select('id').eq('user_id', user.id).limit(1);
  if (error) {
    console.error('[child-account] child login lookup failed; treating as a child account', error);
    return true;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Whether this family member signs in with a kid PIN: a child_logins row for
 * the member, or a linked account that is itself a kid login. Such a member is
 * never made a parent or an adult (the held 0512): a 4-digit PIN must not
 * guard a manager's account. Every role editor asks this, the household's
 * (updateFamilyMemberAction) and the admin console's.
 *
 * Fails CLOSED, like isChildLoginAccount: a lookup that cannot be answered
 * counts as a kid login, so an outage refuses a promotion rather than allowing
 * one.
 */
export async function memberHasAKidLogin(
  admin: SupabaseClient<Database>,
  member: { id: string; family_id: string; user_id: string | null },
): Promise<boolean> {
  const { data: logins, error: loginError } = await admin.from('child_logins')
    .select('id').eq('member_id', member.id).eq('family_id', member.family_id).limit(1);
  if (loginError || (logins?.length ?? 0) > 0) return true;
  if (!member.user_id) return false;
  const { data: account, error: accountError } = await admin.auth.admin.getUserById(member.user_id);
  if (accountError || !account?.user) return true;
  return isChildLoginAccount(admin, { id: member.user_id, email: account.user.email, user_metadata: account.user.user_metadata });
}

/** What removing a member did to their child login, if they had one. */
export type ChildLoginRevocation = 'none' | 'revoked' | 'failed';

/** Effectively indefinite, and reversible with `ban_duration: 'none'` (as adminSetUserBanAction does). */
const REMOVED_CHILD_BAN_DURATION = '876000h';

/**
 * Set in the auth user's app_metadata (which only the service role can write)
 * when THIS removal path bans an account, so liftRemovedChildBan lifts only
 * those bans and never one a super-admin placed. adminSetUserBanAction clears
 * it whenever it bans or unbans, so an admin decision always owns the ban.
 */
export const REMOVED_CHILD_BAN_MARKER = 'removed_child_ban';

const bannedNow = (bannedUntil: string | null | undefined) =>
  !!bannedUntil && Number.isFinite(Date.parse(bannedUntil)) && Date.parse(bannedUntil) > Date.now();

/**
 * After a member is removed, switch off their child login if they have one.
 *
 * Removal is a soft `is_active = false` and leaves the auth user in place. The
 * sign-in action refuses an inactive linked member, but a child who is ALREADY
 * signed in keeps a valid session — enough to POST /rest/v1/families directly
 * and become a parent through handle_new_family. So the account is banned with
 * the service role: GoTrue refuses a banned user's refresh-token grant and
 * every new sign-in, which ends the session.
 *
 * Unlike isChildLoginAccount this does NOT fail closed. A ban is global, so a
 * lookup that cannot be answered must not lock an adult out of every other
 * household they belong to; it is reported as 'failed' instead, which the
 * caller surfaces. The member stays removed either way.
 */
export async function revokeRemovedChildLogin(
  admin: SupabaseClient<Database>,
  member: { id: string; family_id: string; user_id: string | null },
): Promise<ChildLoginRevocation> {
  if (!member.user_id) return 'none';
  const userId = member.user_id;
  try {
    const [{ data: logins, error: loginError }, { data: authUser, error: userError }] = await Promise.all([
      admin.from('child_logins').select('id').eq('family_id', member.family_id).eq('member_id', member.id).eq('user_id', userId).limit(1),
      admin.auth.admin.getUserById(userId),
    ]);
    if (loginError || userError) {
      console.error('[child-account] could not tell whether a removed member has a child login', {
        memberId: member.id, error: (loginError ?? userError)?.message,
      });
      return 'failed';
    }
    const isChild = (logins?.length ?? 0) > 0 || authUser?.user?.user_metadata?.child === true;
    if (!isChild) return 'none';
    // Already banned by someone else (an admin): leave that ban, and its lack
    // of a marker, exactly as it is, so re-adding the child cannot lift it.
    if (bannedNow(authUser?.user?.banned_until) && authUser?.user?.app_metadata?.[REMOVED_CHILD_BAN_MARKER] !== true) return 'revoked';
    const { error: banError } = await admin.auth.admin.updateUserById(userId, {
      ban_duration: REMOVED_CHILD_BAN_DURATION, app_metadata: { [REMOVED_CHILD_BAN_MARKER]: true },
    });
    if (banError) {
      console.error('[child-account] could not sign out a removed child login', { memberId: member.id, error: banError.message });
      return 'failed';
    }
    return 'revoked';
  } catch (error) {
    console.error('[child-account] could not sign out a removed child login', { memberId: member.id, error });
    return 'failed';
  }
}

/** What re-adding a member did to a removal ban: lifted it, found none of ours, or could not tell. */
export type ChildBanLift = 'lifted' | 'none' | 'failed';

/**
 * Lift the ban revokeRemovedChildLogin placed, when a removed child-login
 * member is re-added. Only for an account that IS this member's child login
 * (a child_logins row for this family, member and user) and only when the ban
 * carries REMOVED_CHILD_BAN_MARKER — an admin's ban is never lifted here.
 */
export async function liftRemovedChildBan(
  admin: SupabaseClient<Database>,
  member: { id: string; family_id: string; user_id: string | null },
): Promise<ChildBanLift> {
  if (!member.user_id) return 'none';
  const userId = member.user_id;
  try {
    const [{ data: logins, error: loginError }, { data: authUser, error: userError }] = await Promise.all([
      admin.from('child_logins').select('id').eq('family_id', member.family_id).eq('member_id', member.id).eq('user_id', userId).limit(1),
      admin.auth.admin.getUserById(userId),
    ]);
    if (loginError || userError) {
      console.error('[child-account] could not check a re-added member\'s removal ban', {
        memberId: member.id, error: (loginError ?? userError)?.message,
      });
      return 'failed';
    }
    if (!logins?.length || authUser?.user?.app_metadata?.[REMOVED_CHILD_BAN_MARKER] !== true) return 'none';
    const { error } = await admin.auth.admin.updateUserById(userId, {
      ban_duration: 'none', app_metadata: { [REMOVED_CHILD_BAN_MARKER]: false },
    });
    if (error) {
      console.error('[child-account] could not lift a re-added child\'s removal ban', { memberId: member.id, error: error.message });
      return 'failed';
    }
    return 'lifted';
  } catch (error) {
    console.error('[child-account] could not lift a re-added child\'s removal ban', { memberId: member.id, error });
    return 'failed';
  }
}
