'use server';

// Parent-side management of child logins (username + PIN, no email). All writes
// go through the service-role client (child auth users + the child_logins map),
// but every action first asserts the caller is a MANAGER of the target member's
// family via requireUserContext, so RLS + this guard both hold.

import { requireUserContext } from '@/lib/supabase/auth';
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
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent or guardian can create a child login.' };
  const sec = secret();
  if (!sec) return { ok: false, error: 'Child logins aren’t configured on the server yet (set CHILD_LOGIN_SECRET).' };

  const username = normalizeUsername(input.username);
  if (!isValidUsername(username)) return { ok: false, error: 'Username must be 3–24 letters or numbers.' };
  if (!isValidPin(input.pin)) return { ok: false, error: 'PIN must be 4 digits.' };

  const admin = createServiceClient();

  const { data: member } = await admin.from('family_members')
    .select('id, family_id, display_name, user_id')
    .eq('id', input.memberId).maybeSingle();
  if (!member || member.family_id !== ctx.active.familyId) return { ok: false, error: 'Member not found in your family.' };
  if (member.user_id) return { ok: false, error: 'This member already has a login.' };

  const { data: taken } = await admin.from('child_logins').select('id').ilike('username', username).limit(1);
  if (taken && taken.length > 0) return { ok: false, error: 'That username is taken — try another.' };

  const email = syntheticChildEmail(username);
  const password = deriveChildPassword(sec, username, input.pin);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { child: true, family_id: member.family_id, member_id: member.id, username, display_name: member.display_name },
  });
  if (createErr || !created?.user) return { ok: false, error: 'Could not create the login. The username may already be in use.' };
  const childUserId = created.user.id;

  // Link the member to the new auth user so they ARE this member on sign-in.
  const { error: linkErr } = await admin.from('family_members')
    .update({ user_id: childUserId, is_active: true }).eq('id', member.id);
  if (linkErr) { await admin.auth.admin.deleteUser(childUserId); return { ok: false, error: 'Could not link the login.' }; }

  const { error: rowErr } = await admin.from('child_logins').insert({
    family_id: member.family_id, member_id: member.id, user_id: childUserId, username, created_by: ctx.user.id,
  });
  if (rowErr) {
    await admin.from('family_members').update({ user_id: null }).eq('id', member.id);
    await admin.auth.admin.deleteUser(childUserId);
    return { ok: false, error: 'Could not save the login.' };
  }

  // Set the child's active family so their context resolves on first sign-in.
  await admin.from('user_preferences').upsert(
    { user_id: childUserId, active_family_id: member.family_id }, { onConflict: 'user_id' });

  await logAudit(admin, {
    familyId: member.family_id, actorId: ctx.user.id, action: 'create',
    resource: 'child_logins', resourceId: member.id, metadata: { username },
  });
  return { ok: true, data: { username } };
}

/** Reset a child's PIN. Manager only. */
export async function resetChildPinAction(input: { memberId: string; pin: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent or guardian can reset a PIN.' };
  const sec = secret();
  if (!sec) return { ok: false, error: 'Child logins aren’t configured on the server yet.' };
  if (!isValidPin(input.pin)) return { ok: false, error: 'PIN must be 4 digits.' };

  const admin = createServiceClient();
  const { data: row } = await admin.from('child_logins')
    .select('user_id, username, family_id').eq('member_id', input.memberId).maybeSingle();
  if (!row || row.family_id !== ctx.active.familyId) return { ok: false, error: 'Login not found.' };

  const password = deriveChildPassword(sec, row.username, input.pin);
  const { error } = await admin.auth.admin.updateUserById(row.user_id, { password });
  if (error) return { ok: false, error: 'Could not reset the PIN.' };

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
