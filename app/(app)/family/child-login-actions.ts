'use server';

// Parent-side management of child logins (username + PIN, no email). All writes
// go through the service-role client (child auth users + the child_logins map),
// but every action first asserts the caller is a MANAGER of the target member's
// family via requireUserContext, so RLS + this guard both hold.

import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { isValidPin } from '@/lib/onboarding/pin';
import { normalizeUsername, isValidUsername, syntheticChildEmail } from '@/lib/onboarding/child-login';
import { deriveChildPassword } from '@/lib/onboarding/child-password';
import { logAudit } from '@/lib/server/audit';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

const secret = () => process.env.CHILD_LOGIN_SECRET || null;

/** Give a child member a username + 4-digit PIN login. Manager only. */
export async function createChildLoginAction(input: {
  memberId: string; username: string; pin: string;
}): Promise<Result<{ username: string }>> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('childLoginActions.onlyAParentOrGuardian') };
  const sec = secret();
  if (!sec) return { ok: false, error: t('childLoginActions.childLoginsArenTConfigured') };

  const username = normalizeUsername(input.username);
  if (!isValidUsername(username)) return { ok: false, error: t('childLoginActions.usernameMustBe324') };
  if (!isValidPin(input.pin)) return { ok: false, error: t('childLoginActions.pinMustBe4Digits') };

  const admin = createServiceClient();

  const { data: member } = await admin.from('family_members')
    .select('id, family_id, display_name, user_id')
    .eq('id', input.memberId).maybeSingle();
  if (!member || member.family_id !== ctx.active.familyId) return { ok: false, error: t('childLoginActions.memberNotFoundInYour') };
  if (member.user_id) return { ok: false, error: t('childLoginActions.thisMemberAlreadyHasA') };

  // `eq` for the same reason the sign-in lookup uses it: `_` is a LIKE wildcard
  // and the username grammar allows it, so `ilike` made this check answer about
  // a DIFFERENT login than the one being created.
  const { data: taken } = await admin.from('child_logins').select('id').eq('username', username).limit(1);
  if (taken && taken.length > 0) return { ok: false, error: t('childLoginActions.thatUsernameIsTakenTry') };

  const email = syntheticChildEmail(username);
  const password = deriveChildPassword(sec, username, input.pin);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { child: true, family_id: member.family_id, member_id: member.id, username, display_name: member.display_name },
  });
  if (createErr || !created?.user) return { ok: false, error: t('childLoginActions.couldNotCreateTheLogin') };
  const childUserId = created.user.id;

  // Link the member to the new auth user so they ARE this member on sign-in.
  const { error: linkErr } = await admin.from('family_members')
    .update({ user_id: childUserId, is_active: true }).eq('id', member.id);
  if (linkErr) { await admin.auth.admin.deleteUser(childUserId); return { ok: false, error: t('childLoginActions.couldNotLinkTheLogin') }; }

  const { error: rowErr } = await admin.from('child_logins').insert({
    family_id: member.family_id, member_id: member.id, user_id: childUserId, username, created_by: ctx.user.id,
  });
  if (rowErr) {
    await admin.from('family_members').update({ user_id: null }).eq('id', member.id);
    await admin.auth.admin.deleteUser(childUserId);
    return { ok: false, error: t('childLoginActions.couldNotSaveTheLogin') };
  }

  // Set the child's active family so their context resolves on first sign-in.
  const { error: prefErr } = await admin.from('user_preferences').upsert(
    { user_id: childUserId, active_family_id: member.family_id }, { onConflict: 'user_id' });
  if (prefErr) {
    await admin.from('child_logins').delete().eq('user_id', childUserId);
    await admin.from('family_members').update({ user_id: null }).eq('id', member.id);
    await admin.auth.admin.deleteUser(childUserId);
    return { ok: false, error: t('childLoginActions.couldNotFinishSettingUp') };
  }

  // A username can be reused after an earlier child login was removed. Clear any
  // stale throttle row so the brand-new child doesn't inherit a leftover lockout
  // from whoever held this username before.
  await admin.from('child_login_throttle')
    .update({ fails: 0, locked_until: null, window_start: new Date().toISOString() })
    .eq('username', username);

  await logAudit(admin, {
    familyId: member.family_id, actorId: ctx.user.id, action: 'create',
    resource: 'child_logins', resourceId: member.id, metadata: { username },
  });
  return { ok: true, data: { username } };
}

/** Reset a child's PIN. Manager only. */
export async function resetChildPinAction(input: { memberId: string; pin: string }): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('childLoginActions.onlyAParentOrGuardian2') };
  const sec = secret();
  if (!sec) return { ok: false, error: t('childLoginActions.childLoginsArenTConfigured2') };
  if (!isValidPin(input.pin)) return { ok: false, error: t('childLoginActions.pinMustBe4Digits') };

  const admin = createServiceClient();
  const { data: row } = await admin.from('child_logins')
    .select('user_id, username, family_id').eq('member_id', input.memberId).maybeSingle();
  if (!row || row.family_id !== ctx.active.familyId) return { ok: false, error: t('childLoginActions.loginNotFound') };

  // WHOSE password this sets is decided by `family_members`, never by
  // `child_logins` — and the two have to agree.
  //
  // `child_logins`' write policy is named "Managers manage child_logins" and
  // predicated on `is_family_member(family_id)`, so until 0299 is applied EVERY
  // member of the household can UPDATE that table. This line used to read
  // `row.user_id` from it and hand that straight to
  // `admin.auth.admin.updateUserById` under the service role. So a child pointed
  // their own row's `user_id` at a PARENT's auth user, asked that parent to reset
  // their PIN — "I forgot it", an ordinary request — and the reset set the
  // PARENT's account password to deriveChildPassword(secret, childUsername, pin),
  // a value the child chose. Child to parent takeover, with the parent's own hand
  // on the button.
  //
  // `family_members` writes are already `can_manage_family`, so its `user_id` is
  // the trustworthy side of the mapping. Deliberately not "fall back to the
  // member row": a DISAGREEMENT is evidence of tampering, so it refuses and says
  // so. And a manager is refused outright — `createChildLoginAction` cannot give
  // a login to a member who already has a `user_id`, and a manager always has
  // one, so no legitimate reset is ever blocked by this.
  const { data: member, error: memberError } = await admin.from('family_members')
    .select('id, family_id, role, user_id').eq('id', input.memberId).maybeSingle();
  if (memberError) {
    console.error('[child-login] member lookup failed during PIN reset', memberError);
    return { ok: false, error: t('childLoginActions.couldNotResetThePin') };
  }
  if (!member || member.family_id !== ctx.active.familyId || !member.user_id) {
    return { ok: false, error: t('childLoginActions.loginNotFound') };
  }
  if (isManager(member.role) || member.user_id !== row.user_id) {
    console.error('[child-login] refusing a PIN reset whose target does not match the member row', {
      memberId: input.memberId, familyId: ctx.active.familyId,
      roleIsManager: isManager(member.role), userIdMatches: member.user_id === row.user_id,
    });
    return { ok: false, error: t('childLoginActions.couldNotResetThePin') };
  }

  const password = deriveChildPassword(sec, row.username, input.pin);
  const { error } = await admin.auth.admin.updateUserById(member.user_id, { password });
  if (error) return { ok: false, error: t('childLoginActions.couldNotResetThePin') };

  // A parent reset should also lift any brute-force lockout on that username, so
  // the child can sign in immediately with the new PIN.
  await admin.from('child_login_throttle')
    .update({ fails: 0, locked_until: null, window_start: new Date().toISOString() })
    .eq('username', normalizeUsername(row.username));

  await logAudit(admin, {
    familyId: row.family_id, actorId: ctx.user.id, action: 'update',
    resource: 'child_logins', resourceId: input.memberId, metadata: { reset_pin: true },
  });
  return { ok: true };
}
