'use server';

import * as React from 'react';
import { revalidatePath } from 'next/cache';
import { isSuperAdmin, getUser } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';
import { sendReactEmail, APP_URL } from '@/lib/email';
import { InviteEmail } from '@/lib/emails/invite';
import { emailSchema } from '@/lib/validation';
import { getStripeSettings, effectiveSecretKey } from '@/lib/stripe/settings';
import { stripeFromKey } from '@/lib/stripe';
import type { MemberRole } from '@/lib/constants/roles';
import type { PlanId } from '@/lib/constants/plans';
import { isSuperAdminEmail } from '@/lib/constants/super-admins';
import { describeActionError } from '@/lib/supabase/errors';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

function actionFailure(error: unknown, fallback = 'Could not complete that admin action.'): Result {
  console.error('[admin-action] failed:', error);
  return { ok: false, error: describeActionError(error, fallback) };
}

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
  if (error || !data.user) return error ? actionFailure(error, 'Could not create user.') : { ok: false, error: 'Could not create user.' };

  if (input.familyId) {
    const { error: memberError } = await supabase.from('family_members').insert({
      family_id: input.familyId,
      user_id: data.user.id,
      role: input.role ?? 'adult',
      display_name: parsedEmail.data.split('@')[0],
    });
    if (memberError) return actionFailure(memberError, 'User created, but joining the family failed.');
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
  if (error) return actionFailure(error, 'Could not create the family.');

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
  if (error) return actionFailure(error, 'Could not remove that member.');

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
  if (error) return actionFailure(error, 'Could not update that member.');

  await adminAuditLog({ familyId: member.family_id, action: 'update', resource: 'family_members', resourceId: memberId, metadata: { display_name: displayName, role: input.role } });
  revalidatePath('/admin/users');
  return { ok: true };
}

/** Plans a super-admin can assign from the console (free + the paid tiers). */
const ASSIGNABLE_PLANS = new Set<PlanId>(['free', 'basic', 'basic_annual', 'plus', 'plus_annual']);

/**
 * Set a family's subscription plan directly (e.g. comp a family, or downgrade to
 * Free). Updates the family's active/trialing subscription, or creates one if
 * none exists. 'free' yields planLevel 0. Super-admin only, audited.
 */
export async function adminSetFamilyPlanAction(input: { familyId: string; plan: string }): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const plan = input.plan as PlanId;
  if (!ASSIGNABLE_PLANS.has(plan)) return { ok: false, error: 'Unknown plan' };
  if (!input.familyId) return { ok: false, error: 'A family is required' };

  const supabase = createServiceClient();
  // Update the family's current active/trialing subscription if it has one;
  // otherwise create one. Keeps a single source of truth for the plan.
  const { data: existing } = await supabase.from('subscriptions')
    .select('id, plan').eq('family_id', input.familyId)
    .in('status', ['active', 'trialing']).order('created_at', { ascending: false }).limit(1).maybeSingle();

  const previousPlan = existing?.plan ?? null;
  if (existing) {
    const { error } = await supabase.from('subscriptions')
      .update({ plan, status: 'active' }).eq('id', existing.id);
    if (error) return actionFailure(error, 'Could not update the family plan.');
  } else {
    const { error } = await supabase.from('subscriptions')
      .insert({ family_id: input.familyId, plan, status: 'active', seats: 1 });
    if (error) return actionFailure(error, 'Could not create the family plan.');
  }

  await adminAuditLog({
    familyId: input.familyId, action: 'update', resource: 'subscriptions',
    resourceId: input.familyId, metadata: { plan, previous_plan: previousPlan },
  });
  revalidatePath('/admin/subscriptions');
  revalidatePath('/admin/users');
  return { ok: true };
}

/**
 * Grant or revoke site super-admin via the `super_admins` table (the DB-backed
 * source for `is_super_admin()`). Built-in/env admins are immutable here, and an
 * admin can't remove their own access (no self-lockout). Super-admin only, audited.
 */
export async function adminSetSuperAdminAction(input: { email: string; makeAdmin: boolean }): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const parsed = emailSchema.safeParse(input.email.trim().toLowerCase());
  if (!parsed.success) return { ok: false, error: 'Enter a valid email address' };
  const email = parsed.data;

  const me = await getUser();
  if (!input.makeAdmin && me?.email && me.email.toLowerCase() === email) {
    return { ok: false, error: 'You can’t remove your own super-admin access.' };
  }
  if (!input.makeAdmin && isSuperAdminEmail(email)) {
    return { ok: false, error: 'This admin is set via code/env and can’t be removed here.' };
  }

  const supabase = createServiceClient();
  if (input.makeAdmin) {
    const { error } = await supabase.from('super_admins').upsert({ email }, { onConflict: 'email' });
    if (error) return actionFailure(error, 'Could not update super-admin access.');
  } else {
    const { error } = await supabase.from('super_admins').delete().eq('email', email);
    if (error) return actionFailure(error, 'Could not update super-admin access.');
  }

  await adminAuditLog({
    familyId: null, action: input.makeAdmin ? 'grant' : 'revoke', resource: 'super_admins',
    resourceId: email, metadata: { email },
  });
  revalidatePath('/admin/users');
  return { ok: true };
}

/** Saves the Bubaly Stripe configuration (Super Admin → Stripe Setup). */
export async function saveStripeSettingsAction(input: {
  enabled: boolean;
  publishableKey: string | null;
  secretKey: string | null;
  webhookSecret: string | null;
  connectAccountId: string | null;
  serviceFeeCents: number;
  serviceFeePriceId: string | null;
}): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const feeCents = Number.isFinite(input.serviceFeeCents) && input.serviceFeeCents >= 0 ? Math.trunc(input.serviceFeeCents) : 90;
  const user = await getUser();
  const supabase = createServiceClient();
  const clean = (v: string | null) => (v && v.trim() ? v.trim() : null);

  // Secrets: a blank field means "keep the existing value" so the admin can
  // tweak the fee without re-pasting keys.
  const { data: current } = await supabase.from('stripe_settings').select('secret_key, webhook_secret').eq('id', 'singleton').maybeSingle();
  const keepOr = (next: string | null, prev: string | null | undefined) => clean(next) ?? prev ?? null;

  const { error } = await supabase.from('stripe_settings').upsert({
    id: 'singleton',
    enabled: input.enabled,
    publishable_key: clean(input.publishableKey),
    secret_key: keepOr(input.secretKey, current?.secret_key),
    webhook_secret: keepOr(input.webhookSecret, current?.webhook_secret),
    connect_account_id: clean(input.connectAccountId),
    service_fee_cents: feeCents,
    service_fee_price_id: clean(input.serviceFeePriceId),
    updated_by: user?.id ?? null,
  }, { onConflict: 'id' });
  if (error) return actionFailure(error, 'Could not save Stripe settings.');

  // Audit without leaking secret values.
  await adminAuditLog({ familyId: null, action: 'update', resource: 'stripe_settings', resourceId: 'singleton', metadata: { enabled: input.enabled, service_fee_cents: feeCents, has_secret: Boolean(clean(input.secretKey)) } });
  revalidatePath('/admin/stripe');
  return { ok: true };
}

/** Verifies the configured Stripe secret key by retrieving the account. */
export async function testStripeConnectionAction(): Promise<Result<{ livemode: boolean; currencies: number }>> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;
  try {
    const settings = await getStripeSettings();
    const key = effectiveSecretKey(settings);
    if (!key) return { ok: false, error: 'No Stripe secret key configured.' };
    // balance.retrieve needs no id and fails fast on a bad/expired key.
    const balance = await stripeFromKey(key).balance.retrieve();
    return { ok: true, data: { livemode: balance.livemode, currencies: balance.available.length } };
  } catch (e) {
    return actionFailure(e, 'Could not connect to Stripe.');
  }
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
  if (error) return actionFailure(error, 'Could not revoke that invite.');

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
  if (error || !data) return error ? actionFailure(error, 'Could not create a document link.') : { ok: false, error: 'Could not create a document link.' };
  return { ok: true, data: { url: data.signedUrl } };
}

/** Deletes a document's storage object and database row. Not reversible — confirmed client-side first. */
export async function adminDeleteDocumentAction(documentId: string, _storagePath: string): Promise<Result> {
  const guard = await assertSuperAdmin();
  if (!guard.ok) return guard;

  const supabase = createServiceClient();
  // Resolve the canonical path from the row instead of trusting a stale or
  // client-supplied path. Keep the database row when storage removal fails so
  // the operator can retry rather than silently orphaning the object.
  const { data: doc, error: docError } = await supabase
    .from('documents').select('family_id, title, storage_path').eq('id', documentId).maybeSingle();
  if (docError) return actionFailure(docError, 'Could not load that document.');
  if (!doc) return { ok: false, error: 'Document not found.' };

  const { error: storageError } = await supabase.storage.from('documents').remove([doc.storage_path]);
  if (storageError) return actionFailure(storageError, 'Could not remove the document from storage.');

  const { data: deleted, error } = await supabase
    .from('documents').delete().eq('id', documentId).select('id').maybeSingle();
  if (error) return actionFailure(error, 'Could not delete that document.');
  if (!deleted) return { ok: false, error: 'Document was not deleted.' };

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
  if (error) return actionFailure(error, 'Could not update that user.');

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
  if (error) return actionFailure(error, 'Could not send the password reset.');

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
  if (error) return actionFailure(error, 'Could not update that support ticket.');

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
  if (error) return actionFailure(error, 'Could not update that feature flag.');

  await adminAuditLog({ familyId: null, action: 'update', resource: 'feature_flags', resourceId: key, metadata: { enabled } });
  revalidatePath('/admin/wallet');
  return { ok: true };
}
