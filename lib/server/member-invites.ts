import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { literalCaseInsensitivePattern } from '@/lib/supabase/escape-like';

type DB = SupabaseClient<Database>;

/**
 * The addresses an invite to this member could carry: their account's, as
 * GoTrue holds it, and the one on their roster row. Null when the account
 * could not be read, which is not the same as "no address".
 */
async function inviteAddresses(
  service: DB,
  member: { user_id: string | null; email?: string | null },
): Promise<string[] | null> {
  const emails = new Set<string>();
  const rosterEmail = member.email?.trim().toLowerCase();
  if (rosterEmail) emails.add(rosterEmail);
  if (member.user_id) {
    try {
      const { data, error } = await service.auth.admin.getUserById(member.user_id);
      if (error) return null;
      const accountEmail = data?.user?.email?.trim().toLowerCase();
      if (accountEmail) emails.add(accountEmail);
    } catch {
      return null;
    }
  }
  return [...emails];
}

/**
 * Close this family's PENDING invites addressed to a member, by address and
 * case-insensitively, as accept_invite compares them.
 *
 * Removing a member used to leave every other invite they held standing.
 * accept_invite (0136) reactivates an existing row with `on conflict do update
 * set is_active = true`, so a removed member who still had a second invite —
 * a resubmitted settings invite after a failed email, or an onboarding invite
 * plus a later one — opened that link and was an active member again. Service
 * role, so the rows of an invite the remover did not issue are closed too.
 *
 * `status` is the state the invite is left in: 'revoked' when a manager
 * removed the member, 'expired' when the member joined through another one.
 * Returns false when the addresses or the update could not be read or made;
 * the caller reports it the way it reports a login it could not sign out.
 */
export async function closePendingInvitesFor(
  service: DB,
  familyId: string,
  member: { user_id: string | null; email?: string | null },
  status: 'revoked' | 'expired',
): Promise<boolean> {
  const emails = await inviteAddresses(service, member);
  if (emails === null) {
    console.error('[member-invites] could not read the member\'s address; their pending invites stand', { familyId, userId: member.user_id });
    return false;
  }
  for (const email of emails) {
    // Zero rows is the ordinary answer (nobody invited them twice), so the
    // selection is read for errors only.
    const { error } = await service.from('invites')
      .update({ status })
      .eq('family_id', familyId)
      .eq('status', 'pending')
      .filter('email', 'imatch', literalCaseInsensitivePattern(email))
      .select('id');
    if (error) {
      console.error('[member-invites] pending invites were not closed', { familyId, status, error });
      return false;
    }
  }
  return true;
}
