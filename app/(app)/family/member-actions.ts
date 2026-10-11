'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { REMOVED_MEMBER_PATCH, canRemoveMember } from '@/lib/constants/roles';
import { revokeRemovedChildLogin, type ChildLoginRevocation } from '@/lib/server/child-account';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { forgetMemberLocation } from '@/lib/location/retention';

type RemoveResult =
  /** `locationForgotten` false: the removal stands, but the member's last position could not be cleared and may still show on the family map. */
  | { ok: true; loginRevocation: ChildLoginRevocation; locationForgotten: boolean }
  | { ok: false; error: string };

/**
 * Remove (soft-delete) a member from one of the caller's families.
 *
 * This used to be a browser `.update` in family-module and settings-module,
 * which could not switch off a removed child's PIN login, nor clear the
 * member's location trail: both need the service role. The write itself still
 * goes through the caller's own session, so fm_update (manager-gated) stays the
 * boundary, and RLS filtering it to zero rows is still reported as not saved.
 *
 * Every in-app removal goes through here, so every removed member also takes
 * their position with them (forgetMemberLocation), as the admin console's
 * removal does.
 */
export async function removeFamilyMemberAction(input: { memberId: string }): Promise<RemoveResult> {
  const t = await getTranslations();
  const notSaved = { ok: false as const, error: t('errors.thatChangeWasNotSaved') };
  // The family comes from the authenticated context, never from the caller.
  const ctx = await requireUserContext();
  const actor = ctx.active;
  const familyId = actor.familyId;

  const supabase = await createServer();
  const { data: target, error: readError } = await supabase.from('family_members')
    .select('id, family_id, role, user_id').eq('id', input.memberId).eq('family_id', familyId).maybeSingle();
  if (readError) return { ok: false, error: describeActionError(readError, t('errors.thatChangeWasNotSaved')) };
  // Only a parent may remove a parent (see canRemoveMember).
  if (!target || !canRemoveMember(actor.role, target.role)) return notSaved;

  const { data: rows, error } = await supabase.from('family_members')
    .update(REMOVED_MEMBER_PATCH).eq('id', target.id).eq('family_id', familyId).select('id');
  if (error) return { ok: false, error: describeActionError(error, t('errors.thatChangeWasNotSaved')) };
  if (wroteNoRows(rows)) return notSaved;

  // The removal stands whatever happens here; a failure is logged by the
  // helper and returned so the screen can say the login is still live.
  const service = createServiceClient();
  const loginRevocation = await revokeRemovedChildLogin(service, target);
  // Their last position and location history leave with them: the live
  // member_locations row is blanked and the coordinates on their
  // location_events and safety_check_ins cleared. Service role, because
  // location_events is append-only for clients (0335). The removal stands if
  // this fails; the failure is logged AND returned, so the screen can say the
  // position may still be on the family map (it used to be logged only, and
  // the screen toasted "Member removed"). The daily retention sweep repairs
  // the live row of any member no longer active, so the failure is not for good.
  const forgotten = await forgetMemberLocation(service, familyId, target.id);
  if (!forgotten.ok) console.error('[family] removed member location was not cleared', { familyId, memberId: target.id, failures: forgotten.failures });
  return { ok: true, loginRevocation, locationForgotten: forgotten.ok };
}
