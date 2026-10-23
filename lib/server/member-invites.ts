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

/**
 * Revoke this family's PENDING invites the removed member ISSUED.
 *
 * `closePendingInvitesFor` closes the invites addressed TO a removed member;
 * the ones they sent stood. accept_invite (0136) checks the token, status,
 * expiry and address, never whether `invited_by` is still an active manager,
 * so an invite a removed parent sent kept enrolling its invitee at the role
 * that parent chose — 'parent' included — for up to 14 days (0482's clamp).
 * The SQL re-check in accept_invite is the recorded owner action (AUD16-O02);
 * this closes the rows the moment the member is removed. A member with no
 * account (`user_id` null) issued nothing, so there is nothing to revoke.
 * Returns false when the update failed; the caller folds it into the same
 * `invitesRevoked` the screen already reports.
 */
export async function revokeInvitesIssuedBy(service: DB, familyId: string, issuerUserId: string | null): Promise<boolean> {
  if (!issuerUserId) return true;
  // Zero rows is the ordinary answer (they invited nobody), so the selection
  // is read for errors only.
  const { error } = await service.from('invites')
    .update({ status: 'revoked' })
    .eq('family_id', familyId)
    .eq('status', 'pending')
    .eq('invited_by', issuerUserId)
    .select('id');
  if (error) {
    console.error('[member-invites] the invites the removed member issued were not revoked', { familyId, issuerUserId, error });
    return false;
  }
  return true;
}
