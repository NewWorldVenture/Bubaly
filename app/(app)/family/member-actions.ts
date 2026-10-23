'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import {
  REMOVED_MEMBER_PATCH, ROLE_ORDER, assignableMemberRoles, canRemoveMember, isManager, rolesForAKidLogin, type MemberRole,
} from '@/lib/constants/roles';
import { memberHasAKidLogin, revokeRemovedChildLogin, type ChildLoginRevocation } from '@/lib/server/child-account';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { forgetMemberLocation } from '@/lib/location/retention';
import { closePendingInvitesFor, revokeInvitesIssuedBy } from '@/lib/server/member-invites';
import { recordTrustChange } from '@/lib/trust/ledger';
import { logAudit } from '@/lib/server/audit';

type RemoveResult =
  /** `locationForgotten` false: the removal stands, but the member's last position could not be cleared and may still show on the family map. */
  /** `invitesRevoked` false: the removal stands, but a pending invite to them may still let them back in, or one they sent may still enrol its invitee. */
  | { ok: true; loginRevocation: ChildLoginRevocation; locationForgotten: boolean; invitesRevoked: boolean }
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
    .select('id, family_id, role, user_id, email').eq('id', input.memberId).eq('family_id', familyId).maybeSingle();
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
  // the screen toasted "Member removed"). Nothing repairs it on a schedule:
  // the retention sweep that would blank the live row of any member no longer
  // active is held, and runs nowhere, until the owner's retention decision
  // (lib/location/retention.ts), so saying so is the whole of the answer.
  const forgotten = await forgetMemberLocation(service, familyId, target.id);
  if (!forgotten.ok) console.error('[family] removed member location was not cleared', { familyId, memberId: target.id, failures: forgotten.failures });
  // And every pending invite to them is revoked, or any second invite they
  // still hold brings them straight back (accept_invite reactivates the row).
  // The removal stands if this fails; the failure is logged and returned.
  const invitesToThemClosed = await closePendingInvitesFor(service, familyId, target, 'revoked');
  // So are the pending invites THEY issued: accept_invite never asks whether
  // the inviter is still an active manager, so a removed parent's invite kept
  // enrolling its invitee at the role that parent chose. Both outcomes fold
  // into the one answer the screen already reports.
  const invitesByThemRevoked = await revokeInvitesIssuedBy(service, familyId, target.user_id);
  const invitesRevoked = invitesToThemClosed && invitesByThemRevoked;
  // The household's record of the removal: who removed whom, and whether each
  // follow-up landed. The admin console's removal writes one; this path wrote
  // none, so a partially failed removal survived only as a toast. Best-effort,
  // after the fact: the removal has already happened.
  await logAudit(service, {
    familyId, actorId: ctx.user.id, action: 'update', resource: 'family_members', resourceId: target.id,
    metadata: {
      removed: true, previous_role: target.role, login_revocation: loginRevocation,
      location_forgotten: forgotten.ok, invites_revoked: invitesRevoked, invites_they_issued_revoked: invitesByThemRevoked,
    },
  });
  return { ok: true, loginRevocation, locationForgotten: forgotten.ok, invitesRevoked };
}

/** The columns a roster editor may change on a member row. */
export type MemberEdit = {
  display_name?: string;
  role?: MemberRole;
  birthday?: string | null;
  email?: string | null;
  phone?: string | null;
};

const EDITABLE: readonly (keyof MemberEdit)[] = ['display_name', 'role', 'birthday', 'email', 'phone'];

/**
 * Edit a member row from either roster editor (the family page and Settings).
 *
 * Both used to write the whole form straight to family_members from the
 * browser, which went wrong three ways:
 *   • Settings offered Parent and Adult for a member who signs in with a kid
 *     PIN (the family editor did not), so a 4-digit PIN ended up guarding a
 *     manager's account. The roles are now decided here, from the member's
 *     kid login and the actor's own rank, whichever screen asked.
 *   • The write named no `is_active`, so a manager whose tab still listed a
 *     member another manager had removed wrote the old role back over
 *     REMOVED_MEMBER_PATCH, and the next accepted invite brought them back with
 *     it. A removed member is refused.
 *   • It sent every column from a copy loaded once, so it also put back
 *     whatever another manager had changed since. Only the columns that differ
 *     from the row are written, and only while the row is the one the editor
 *     opened (`expectedUpdatedAt`, bumped by trg_set_updated_at on every write).
 *
 * The write goes through the caller's own session, so fm_update (manager-gated)
 * and 0482's parent boundary stay the database's word on it.
 */
export async function updateFamilyMemberAction(input: {
  memberId: string;
  expectedUpdatedAt?: string | null;
  changes: MemberEdit;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = await getTranslations();
  const notSaved = { ok: false as const, error: t('errors.thatChangeWasNotSaved') };
  const ctx = await requireUserContext();
  const actor = ctx.active;
  const familyId = actor.familyId;
  if (!isManager(actor.role)) return notSaved;

  const supabase = await createServer();
  const { data: target, error: readError } = await supabase.from('family_members')
    .select('id, family_id, role, user_id, is_active, display_name, birthday, email, phone, updated_at')
    .eq('id', input.memberId).eq('family_id', familyId).maybeSingle();
  if (readError) return { ok: false, error: describeActionError(readError, t('errors.thatChangeWasNotSaved')) };
  if (!target) return notSaved;
  if (!target.is_active) return { ok: false, error: t('familyModule.thatMemberWasRemoved') };
  if (input.expectedUpdatedAt && target.updated_at !== input.expectedUpdatedAt) {
    return { ok: false, error: t('familyModule.thatMemberChangedMeanwhile') };
  }

  const patch: MemberEdit = {};
  for (const key of EDITABLE) {
    if (!(key in input.changes)) continue;
    const next = input.changes[key];
    const current = (target as Record<string, unknown>)[key] ?? null;
    if ((next ?? null) !== current) Object.assign(patch, { [key]: next ?? null });
  }
  if (patch.display_name !== undefined && !String(patch.display_name ?? '').trim()) return notSaved;

  if (patch.role !== undefined) {
    if (!ROLE_ORDER.includes(patch.role)) return notSaved;
    // An adult may not grant `parent` or change a parent's role.
    let allowed = assignableMemberRoles(actor.role, target.role);
    if (isManager(patch.role)) {
      // Never a manager behind a kid PIN (the held 0512): a child_logins row,
      // or an account that is itself a kid login. A lookup that cannot answer
      // refuses the promotion rather than allowing it.
      const kidLogin = await memberHasAKidLogin(createServiceClient(), { id: target.id, family_id: familyId, user_id: target.user_id });
      if (kidLogin) allowed = rolesForAKidLogin(allowed, target.role);
      if (!allowed.includes(patch.role)) {
        return kidLogin
          ? { ok: false, error: t('familyModule.aKidLoginCannotBeAManager', { name: target.display_name }) }
          : notSaved;
      }
    }
    if (!allowed.includes(patch.role)) return notSaved;
  }

  if (Object.keys(patch).length === 0) return { ok: true };

  const { data: rows, error } = await supabase.from('family_members').update(patch)
    .eq('id', target.id).eq('family_id', familyId).eq('is_active', true).eq('updated_at', target.updated_at)
    .select('id');
  if (error) return { ok: false, error: describeActionError(error, t('errors.thatChangeWasNotSaved')) };
  // Zero rows: RLS refused it, or the row was removed or changed between the
  // read above and this write. Either way nothing was saved.
  if (wroteNoRows(rows)) return { ok: false, error: t('familyModule.thatMemberChangedMeanwhile') };
  // A role is a permission. With the write on the server now, it is recorded
  // in the trust ledger beside the other changes to who may do what.
  if (patch.role !== undefined) {
    await recordTrustChange(supabase, {
      familyId, actorMemberId: actor.member?.id ?? null, decision: 'role_changed',
      reason: `Changed ${target.display_name}'s role from ${target.role} to ${patch.role}`,
      context: { memberId: target.id, from: target.role, to: patch.role },
    });
  }
  return { ok: true };
}
