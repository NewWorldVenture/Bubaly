'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { REMOVED_MEMBER_PATCH, canRemoveMember } from '@/lib/constants/roles';
import { revokeRemovedChildLogin, type ChildLoginRevocation } from '@/lib/server/child-account';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';

type RemoveResult = { ok: true; loginRevocation: ChildLoginRevocation } | { ok: false; error: string };

/**
 * Remove (soft-delete) a member from one of the caller's families.
 *
 * This used to be a browser `.update` in family-module and settings-module,
 * which could not switch off a removed child's PIN login: that needs the
 * service role. The write itself still goes through the caller's own session,
 * so fm_update (manager-gated) stays the boundary, and RLS filtering it to zero
 * rows is still reported as not saved.
 */
export async function removeFamilyMemberAction(input: { memberId: string; familyId: string }): Promise<RemoveResult> {
  const t = await getTranslations();
  const notSaved = { ok: false as const, error: t('errors.thatChangeWasNotSaved') };
  const ctx = await requireUserContext();
  const actor = ctx.memberships.find((m) => m.familyId === input.familyId);
  if (!actor) return notSaved;

  const supabase = await createServer();
  const { data: target, error: readError } = await supabase.from('family_members')
    .select('id, family_id, role, user_id').eq('id', input.memberId).eq('family_id', input.familyId).maybeSingle();
  if (readError) return { ok: false, error: describeActionError(readError, t('errors.thatChangeWasNotSaved')) };
  // Only a parent may remove a parent (see canRemoveMember).
  if (!target || !canRemoveMember(actor.role, target.role)) return notSaved;

  const { data: rows, error } = await supabase.from('family_members')
    .update(REMOVED_MEMBER_PATCH).eq('id', target.id).eq('family_id', input.familyId).select('id');
  if (error) return { ok: false, error: describeActionError(error, t('errors.thatChangeWasNotSaved')) };
  if (wroteNoRows(rows)) return notSaved;

  // The removal stands whatever happens here; a failure is logged by the
  // helper and returned so the screen can say the login is still live.
  const loginRevocation = await revokeRemovedChildLogin(createServiceClient(), target);
  return { ok: true, loginRevocation };
}
