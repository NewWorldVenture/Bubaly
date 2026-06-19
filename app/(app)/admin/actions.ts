'use server';

import * as React from 'react';
import { revalidatePath } from 'next/cache';
import { isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { getResend, FROM_EMAIL, APP_URL } from '@/lib/email';
import { InviteEmail } from '@/lib/emails/invite';
import { emailSchema } from '@/lib/validation';
import type { MemberRole } from '@/lib/constants/roles';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

async function assertSuperAdmin(): Promise<Result> {
  if (!(await isSuperAdmin())) return { ok: false, error: 'Not authorized' };
  return { ok: true };
}

/** Creates a real auth.users account (Supabase-hosted invite email) and, optionally, drops them straight into a family. */
export async function adminCreateUserAction(input: {
  email: string;
  familyId?: string;
  role?: MemberRole;
}): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const parsedEmail = emailSchema.safeParse(input.email);
  if (!parsedEmail.success) return { ok: false, error: 'Enter a valid email address' };

  const supabase = createServiceClient();
  const { data, error } = await supabase.auth.admin.inviteUserByEmail(parsedEmail.data, {
    redirectTo: `${APP_URL}/onboarding`,
  });
  if (error || !data.user) return { ok: false, error: error?.message ?? 'Could not create user' };

  if (input.familyId) {
    const { error: memberError } = await supabase.from('family_members').insert({
      family_id: input.familyId,
      user_id: data.user.id,
      role: input.role ?? 'adult',
      display_name: parsedEmail.data.split('@')[0],
    });
    if (memberError) return { ok: false, error: `User created, but joining the family failed: ${memberError.message}` };
  }

  revalidatePath('/admin/users');
  return { ok: true };
}

/** Creates a family on behalf of an existing user (the trigger makes them its parent). */
export async function adminCreateFamilyAction(input: {
  name: string;
  timezone: string;
  ownerEmail: string;
}): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const name = input.name.trim();
  if (name.length < 2) return { ok: false, error: 'Give the family a name' };
  const parsedEmail = emailSchema.safeParse(input.ownerEmail);
  if (!parsedEmail.success) return { ok: false, error: 'Enter the owner’s email address' };

  const supabase = createServiceClient();
  const { data: owner } = await supabase.from('profiles').select('id').eq('email', parsedEmail.data).maybeSingle();
  if (!owner) return { ok: false, error: 'No account found with that email — create the user first' };

  const { error } = await supabase.from('families').insert({
    name, timezone: input.timezone || 'UTC', created_by: owner.id,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/admin/users');
  return { ok: true };
}

/** Removes a member from a family (reversible — they can be re-added or re-invited). */
export async function adminRemoveMemberAction(memberId: string): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const supabase = createServiceClient();
  const { error } = await supabase.from('family_members').update({ is_active: false }).eq('id', memberId);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/admin/users');
  return { ok: true };
}

/** Re-sends an existing pending invite's email. */
export async function adminResendInviteAction(inviteId: string): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const supabase = createServiceClient();
  const { data: invite } = await supabase.from('invites').select('*').eq('id', inviteId).maybeSingle();
  if (!invite || invite.status !== 'pending') return { ok: false, error: 'Invite is no longer pending' };

  const { data: family } = await supabase.from('families').select('name').eq('id', invite.family_id).maybeSingle();
  const inviterName = invite.invited_by
    ? (await supabase.from('profiles').select('full_name, email').eq('id', invite.invited_by).maybeSingle()).data
    : null;

  const resend = getResend();
  await resend.emails.send({
    from: FROM_EMAIL,
    to: invite.email,
    subject: `Reminder: you’re invited to join ${family?.name ?? 'a family'} on FamilyOS`,
    react: React.createElement(InviteEmail, {
      familyName: family?.name ?? 'a family',
      inviterName: inviterName?.full_name || inviterName?.email || 'A family admin',
      token: invite.token,
      role: invite.role,
    }),
  });

  revalidatePath('/admin/users');
  return { ok: true };
}

/** Revokes a pending invite so the link no longer works. */
export async function adminRevokeInviteAction(inviteId: string): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const supabase = createServiceClient();
  const { error } = await supabase.from('invites').update({ status: 'revoked' }).eq('id', inviteId);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/admin/users');
  return { ok: true };
}
