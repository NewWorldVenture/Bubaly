'use server';

import * as React from 'react';
import { revalidatePath } from 'next/cache';
import { isSuperAdmin, getUser } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';
import { sendReactEmail, APP_URL } from '@/lib/email';
import { InviteEmail } from '@/lib/emails/invite';
import { emailSchema } from '@/lib/validation';
import type { MemberRole } from '@/lib/constants/roles';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

async function assertSuperAdmin(): Promise<Result> {
  if (!(await isSuperAdmin())) return { ok: false, error: 'Not authorized' };
  return { ok: true };
}

/** Every admin action logs under this actor, tagged so it's distinguishable from in-family activity. */
async function adminAuditLog(entry: {
  familyId: string | null;
  action: string;
  resource: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  const supabase = createServiceClient();
  const user = await getUser();
  await logAudit(supabase, { ...entry, actorId: user?.id ?? null, metadata: { ...entry.metadata, via: 'site_admin' } });
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

  await adminAuditLog({
    familyId: input.familyId ?? null, action: 'create', resource: 'users',
    resourceId: data.user.id, metadata: { email: parsedEmail.data },
  });
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

  const { data: family, error } = await supabase.from('families').insert({
    name, timezone: input.timezone || 'UTC', created_by: owner.id,
  }).select('id').single();
  if (error) return { ok: false, error: error.message };

  await adminAuditLog({ familyId: family.id, action: 'create', resource: 'families', resourceId: family.id, metadata: { name, owner_email: parsedEmail.data } });
  revalidatePath('/admin/users');
  return { ok: true };
}

/** Removes a member from a family (reversible — they can be re-added or re-invited). */
export async function adminRemoveMemberAction(memberId: string): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const supabase = createServiceClient();
  const { data: member, error } = await supabase.from('family_members')
    .update({ is_active: false }).eq('id', memberId).select('family_id, display_name').single();
  if (error) return { ok: false, error: error.message };

  await adminAuditLog({ familyId: member.family_id, action: 'remove', resource: 'family_members', resourceId: memberId, metadata: { display_name: member.display_name } });
  revalidatePath('/admin/users');
  return { ok: true };
}

/** Updates a member's display name and role. */
export async function adminUpdateMemberAction(memberId: string, input: { displayName: string; role: MemberRole }): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const displayName = input.displayName.trim();
  if (!displayName) return { ok: false, error: 'Name is required' };

  const supabase = createServiceClient();
  const { data: member, error } = await supabase.from('family_members')
    .update({ display_name: displayName, role: input.role }).eq('id', memberId).select('family_id').single();
  if (error) return { ok: false, error: error.message };

  await adminAuditLog({ familyId: member.family_id, action: 'update', resource: 'family_members', resourceId: memberId, metadata: { display_name: displayName, role: input.role } });
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

  const { ok } = await sendReactEmail({
    to: invite.email,
    subject: `Reminder: you’re invited to join ${family?.name ?? 'a family'} on Bubaly`,
    react: React.createElement(InviteEmail, {
      familyName: family?.name ?? 'a family',
      inviterName: inviterName?.full_name || inviterName?.email || 'A family admin',
      token: invite.token,
      role: invite.role,
    }),
  });
  if (!ok) return { ok: false, error: 'Could not send the invite email' };

  await adminAuditLog({ familyId: invite.family_id, action: 'resend', resource: 'invites', resourceId: inviteId, metadata: { email: invite.email } });
  revalidatePath('/admin/users');
  return { ok: true };
}

/** Revokes a pending invite so the link no longer works. */
export async function adminRevokeInviteAction(inviteId: string): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const supabase = createServiceClient();
  const { data: invite, error } = await supabase.from('invites')
    .update({ status: 'revoked' }).eq('id', inviteId).select('family_id, email').single();
  if (error) return { ok: false, error: error.message };

  await adminAuditLog({ familyId: invite.family_id, action: 'revoke', resource: 'invites', resourceId: inviteId, metadata: { email: invite.email } });
  revalidatePath('/admin/users');
  return { ok: true };
}

/**
 * Signed URL for any family's document, via the service role. The browser's
 * anon-key client can't do this for the super admin — Storage RLS only grants
 * access to actual family members, and the admin isn't a member of every family.
 */
export async function adminGetDocumentUrlAction(storagePath: string): Promise<Result<{ url: string }>> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const supabase = createServiceClient();
  const { data, error } = await supabase.storage.from('documents').createSignedUrl(storagePath, 120);
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not create a link' };
  return { ok: true, data: { url: data.signedUrl } };
}

/** Deletes a document's storage object and database row. Not reversible — confirmed client-side first. */
export async function adminDeleteDocumentAction(documentId: string, storagePath: string): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const supabase = createServiceClient();
  const { data: doc } = await supabase.from('documents').select('family_id, title').eq('id', documentId).maybeSingle();
  await supabase.storage.from('documents').remove([storagePath]);
  const { error } = await supabase.from('documents').delete().eq('id', documentId);
  if (error) return { ok: false, error: error.message };

  await adminAuditLog({ familyId: doc?.family_id ?? null, action: 'delete', resource: 'documents', resourceId: documentId, metadata: { title: doc?.title } });
  revalidatePath('/admin/content');
  return { ok: true };
}

/** Bans or unbans an auth account. Banning blocks sign-in until reversed; you can't ban yourself. */
export async function adminSetUserBanAction(userId: string, banned: boolean): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const me = await getUser();
  if (me?.id === userId) return { ok: false, error: 'You can’t ban your own account' };

  const supabase = createServiceClient();
  // 'none' lifts a ban; a long duration is an effectively-indefinite ban (reversible).
  const { error } = await supabase.auth.admin.updateUserById(userId, { ban_duration: banned ? '876000h' : 'none' });
  if (error) return { ok: false, error: error.message };

  await adminAuditLog({ familyId: null, action: banned ? 'ban' : 'unban', resource: 'users', resourceId: userId });
  revalidatePath('/admin/security');
  return { ok: true };
}

/** Sends a password-reset email to an existing account (e.g. to help a locked-out user). */
export async function adminSendPasswordResetAction(email: string): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const parsedEmail = emailSchema.safeParse(email);
  if (!parsedEmail.success) return { ok: false, error: 'Enter a valid email address' };

  const supabase = createServiceClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsedEmail.data, {
    redirectTo: `${APP_URL}/login`,
  });
  if (error) return { ok: false, error: error.message };

  await adminAuditLog({ familyId: null, action: 'password_reset', resource: 'users', metadata: { email: parsedEmail.data } });
  return { ok: true };
}

const TICKET_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Moves a support ticket through its lifecycle (open → pending → resolved/closed). */
export async function adminUpdateTicketStatusAction(ticketId: string, status: TicketStatus): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;
  if (!TICKET_STATUSES.includes(status)) return { ok: false, error: 'Invalid status' };

  const supabase = createServiceClient();
  const { error } = await supabase.from('support_tickets').update({ status }).eq('id', ticketId);
  if (error) return { ok: false, error: error.message };

  await adminAuditLog({ familyId: null, action: 'update', resource: 'support_tickets', resourceId: ticketId, metadata: { status } });
  revalidatePath('/admin/support');
  return { ok: true };
}

/** Toggle a global feature flag (e.g. wallet_virtual_ledger_enabled, stripe_*).
 *  Super-admin only; the single source of truth for what the wallet exposes. */
export async function adminToggleFeatureFlagAction(key: string, enabled: boolean): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;
  if (!key || key.length > 100) return { ok: false, error: 'Invalid flag key' };

  const supabase = createServiceClient();
  const { error } = await supabase.from('feature_flags').update({ enabled }).eq('key', key);
  if (error) return { ok: false, error: error.message };

  await adminAuditLog({ familyId: null, action: 'update', resource: 'feature_flags', resourceId: key, metadata: { enabled } });
  revalidatePath('/admin/wallet');
  return { ok: true };
}
