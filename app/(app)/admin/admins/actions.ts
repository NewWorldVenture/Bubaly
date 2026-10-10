'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { describeActionError } from '@/lib/supabase/errors';
import { emailSchema } from '@/lib/validation';
import { logAudit } from '@/lib/server/audit';
import { isSuperAdminEmail } from '@/lib/constants/super-admins';
import { superAdminAssurance } from '@/lib/auth/super-admin-assurance';

// The roster in public.admin_users is NOT what grants console access: that is
// the code/env allowlist plus public.super_admins (isSuperAdmin). Revoking or
// deactivating someone here used to change only the roster, report success,
// and leave them with full access. So both now also remove the person's
// super_admins grant, under the same rules adminSetSuperAdminAction keeps (a
// built-in/env admin cannot be removed here; nobody removes their own access),
// and every roster change is written to audit_logs. Activating a
// super_administrator entry puts the grant back (the grant adminSetSuperAdmin-
// Action would make), so deactivate-then-activate is a round trip rather than
// an "active" admin with no access.

type ActionResult = { ok: true } | { ok: false; error: string };
type AdminClient = ReturnType<typeof createServiceClient>;
type Actor = { id: string | null; email: string | null };
type GuardResult = { supabase: AdminClient; actor: Actor } | { ok: false; error: string };

function actionFailure(operation: string, message: string, error: unknown): ActionResult {
  console.error(`[admin-management] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, message) };
}

async function guard(): Promise<GuardResult> {
  const t = await getTranslations();
  if (!(await isSuperAdmin())) return { ok: false, error: t('actions.notAuthorized') };
  if (!(await superAdminAssurance()).ok) return { ok: false, error: t('actions.adminConsoleNeedsYourCode') };
  const user = await getUser();
  return { supabase: createServiceClient(), actor: { id: user?.id ?? null, email: user?.email?.trim().toLowerCase() ?? null } };
}

async function auditRoster(
  guarded: { supabase: AdminClient; actor: Actor },
  action: string,
  resource: 'admin_users' | 'super_admins',
  // audit_logs.resource_id is a uuid: a roster row id, or null (the email
  // goes in metadata) for the super_admins grant, which is keyed by email.
  resourceId: string | null,
  metadata: Record<string, unknown>,
) {
  await logAudit(guarded.supabase, {
    familyId: null, actorId: guarded.actor.id, action, resource, resourceId,
    metadata: { ...metadata, via: 'site_admin' },
  });
}

type RosterRow = { id: string; email: string; admin_role: string | null };

/** The roster row, or the answer to return instead. */
async function readRosterRow(
  guarded: { supabase: AdminClient; actor: Actor },
  adminId: string,
  failure: string,
  notFound: string,
): Promise<RosterRow | ActionResult> {
  const { data, error } = await guarded.supabase.from('admin_users')
    .select('id, email, admin_role').eq('id', adminId).maybeSingle();
  if (error) return actionFailure('read that admin', failure, error);
  if (!data) return { ok: false, error: notFound };
  return data as RosterRow;
}

/**
 * Removes the person's real console access (their super_admins row), refusing
 * the two cases adminSetSuperAdminAction refuses. Zero rows is fine: a roster
 * entry need not have a grant. Returns an answer only when it refused or failed.
 */
async function removeSuperAdminGrant(
  guarded: { supabase: AdminClient; actor: Actor },
  rawEmail: string,
  messages: { self: string; builtIn: string; failure: string },
): Promise<ActionResult | null> {
  const email = rawEmail.trim().toLowerCase();
  if (guarded.actor.email && guarded.actor.email === email) return { ok: false, error: messages.self };
  if (isSuperAdminEmail(email)) return { ok: false, error: messages.builtIn };
  const { data, error } = await guarded.supabase.from('super_admins').delete().eq('email', email).select('email');
  if (error) return actionFailure('revoke super-admin access', messages.failure, error);
  if ((data ?? []).length > 0) await auditRoster(guarded, 'revoke', 'super_admins', null, { email, source: 'admin_roster' });
  return null;
}

/**
 * Puts back the super_admins grant for a super_administrator roster entry, as
 * adminSetSuperAdminAction's grant does (an idempotent upsert by email). A
 * built-in/env admin already has access and is left alone; other roles carry
 * no console access, so nothing is granted for them.
 */
async function restoreSuperAdminGrant(
  guarded: { supabase: AdminClient; actor: Actor },
  row: RosterRow,
  failure: string,
): Promise<ActionResult | null> {
  if (row.admin_role !== 'super_administrator') return null;
  const parsed = emailSchema.safeParse(row.email.trim().toLowerCase());
  if (!parsed.success) return null;
  const email = parsed.data;
  if (isSuperAdminEmail(email)) return null;
  const { error } = await guarded.supabase.from('super_admins').upsert({ email }, { onConflict: 'email' });
  if (error) return actionFailure('restore super-admin access', failure, error);
  await auditRoster(guarded, 'grant', 'super_admins', null, { email, source: 'admin_roster' });
  return null;
}

export async function deactivateAdminAction(adminId: string): Promise<ActionResult> {
  const t = await getTranslations();
  const guarded = await guard();
  if (!('supabase' in guarded)) return guarded;
  if (!adminId.trim()) return { ok: false, error: t('actions.anAdminRecordIsRequired') };
  const row = await readRosterRow(guarded, adminId, t('admins.couldNotDeactivateThatAdmin'), t('actions.adminRecordNotFound'));
  if ('ok' in row) return row;
  const refused = await removeSuperAdminGrant(guarded, row.email, {
    self: t('actions.youCanTRemoveYour'), builtIn: t('actions.thisAdminIsSetVia'), failure: t('admins.couldNotDeactivateThatAdmin'),
  });
  if (refused) return refused;
  const { data, error } = await guarded.supabase.from('admin_users').update({ status: 'inactive' })
    .eq('id', adminId).select('id').maybeSingle();
  if (error) return actionFailure('deactivate that admin', t('admins.couldNotDeactivateThatAdmin'), error);
  if (!data) return { ok: false, error: t('actions.adminRecordNotFound') };
  await auditRoster(guarded, 'deactivate', 'admin_users', adminId, { email: row.email, admin_role: row.admin_role });
  revalidatePath('/admin/admins');
  return { ok: true };
}

export async function activateAdminAction(adminId: string): Promise<ActionResult> {
  const t = await getTranslations();
  const guarded = await guard();
  if (!('supabase' in guarded)) return guarded;
  if (!adminId.trim()) return { ok: false, error: t('actions.anAdminRecordIsRequired') };
  const row = await readRosterRow(guarded, adminId, t('admins.couldNotActivateThatAdmin'), t('actions.adminRecordNotFound'));
  if ('ok' in row) return row;
  const { data, error } = await guarded.supabase
    .from('admin_users')
    .update({ status: 'active', last_active_at: new Date().toISOString() })
    .eq('id', adminId).select('id').maybeSingle();
  if (error) return actionFailure('activate that admin', t('admins.couldNotActivateThatAdmin'), error);
  if (!data) return { ok: false, error: t('actions.adminRecordNotFound') };
  await auditRoster(guarded, 'activate', 'admin_users', adminId, { email: row.email, admin_role: row.admin_role });
  // After the roster write, so a failure here errs toward less access (the
  // order deactivate keeps the other way round). Re-running activate retries.
  const failed = await restoreSuperAdminGrant(guarded, row, t('admins.couldNotActivateThatAdmin'));
  if (failed) return failed;
  revalidatePath('/admin/admins');
  return { ok: true };
}

export async function revokeAdminAction(adminId: string): Promise<ActionResult> {
  const t = await getTranslations();
  const guarded = await guard();
  if (!('supabase' in guarded)) return guarded;
  if (!adminId.trim()) return { ok: false, error: t('actions.anAdminRecordIsRequired') };
  const row = await readRosterRow(guarded, adminId, t('admins.couldNotRevokeThatAdmin'), t('actions.adminRecordNotFound'));
  if ('ok' in row) return row;
  const refused = await removeSuperAdminGrant(guarded, row.email, {
    self: t('actions.youCanTRemoveYour'), builtIn: t('actions.thisAdminIsSetVia'), failure: t('admins.couldNotRevokeThatAdmin'),
  });
  if (refused) return refused;
  const { data, error } = await guarded.supabase.from('admin_users').delete()
    .eq('id', adminId).select('id').maybeSingle();
  if (error) return actionFailure('revoke that admin', t('admins.couldNotRevokeThatAdmin'), error);
  if (!data) return { ok: false, error: t('actions.adminRecordNotFound') };
  await auditRoster(guarded, 'revoke', 'admin_users', adminId, { email: row.email, admin_role: row.admin_role });
  revalidatePath('/admin/admins');
  return { ok: true };
}

export async function inviteAdminAction(formData: FormData): Promise<ActionResult> {
  const t = await getTranslations();
  const guarded = await guard();
  if (!('supabase' in guarded)) return guarded;
  const parsedEmail = emailSchema.safeParse(String(formData.get('email') ?? ''));
  if (!parsedEmail.success) return { ok: false, error: t('actions.enterAValidEmailAddress') };
  const email = parsedEmail.data;
  const full_name = String(formData.get('full_name') ?? '').trim().slice(0, 120) || null;
  const requestedRole = String(formData.get('admin_role') ?? 'administrator');
  const permMap: Record<string, string[]> = {
    super_administrator: ['All Access'],
    administrator: ['User', 'Content', 'Reports', 'Billing'],
    content_manager: ['Content Management'],
    billing_manager: ['Billing', 'Payments', 'Reports'],
    moderator: ['Support', 'User Management'],
    viewer: ['Reports (View Only)'],
  };
  const admin_role = Object.prototype.hasOwnProperty.call(permMap, requestedRole) ? requestedRole : 'administrator';
  const permissions = permMap[admin_role] ?? [];

  const { data: invited, error } = await guarded.supabase.from('admin_users').upsert(
    { email, full_name, admin_role, permissions, status: 'pending' },
    { onConflict: 'email' },
  ).select('id').maybeSingle();
  if (error) return actionFailure('invite that admin', t('admins.couldNotInviteThatAdmin'), error);
  await auditRoster(guarded, 'invite', 'admin_users', (invited as { id: string } | null)?.id ?? null, { email, admin_role, permissions });
  revalidatePath('/admin/admins');
  return { ok: true };
}
