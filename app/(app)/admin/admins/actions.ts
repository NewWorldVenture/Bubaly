'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { isSuperAdmin } from '@/lib/supabase/auth';
import { describeActionError } from '@/lib/supabase/errors';
import { emailSchema } from '@/lib/validation';

type ActionResult = { ok: true } | { ok: false; error: string };
type AdminClient = ReturnType<typeof createServiceClient>;
type GuardResult = { supabase: AdminClient } | { ok: false; error: string };

function actionFailure(operation: string, error: unknown): ActionResult {
  console.error(`[admin-management] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, `Could not ${operation}.`) };
}

async function guard(): Promise<GuardResult> {
  const t = await getTranslations();
  if (!(await isSuperAdmin())) return { ok: false, error: t('actions.notAuthorized') };
  return { supabase: createServiceClient() };
}

export async function deactivateAdminAction(adminId: string): Promise<ActionResult> {
  const t = await getTranslations();
  const guarded = await guard();
  if (!('supabase' in guarded)) return guarded;
  if (!adminId.trim()) return { ok: false, error: t('actions.anAdminRecordIsRequired') };
  const { data, error } = await guarded.supabase.from('admin_users').update({ status: 'inactive' })
    .eq('id', adminId).select('id').maybeSingle();
  if (error) return actionFailure('deactivate that admin', error);
  if (!data) return { ok: false, error: t('actions.adminRecordNotFound') };
  revalidatePath('/admin/admins');
  return { ok: true };
}

export async function activateAdminAction(adminId: string): Promise<ActionResult> {
  const t = await getTranslations();
  const guarded = await guard();
  if (!('supabase' in guarded)) return guarded;
  if (!adminId.trim()) return { ok: false, error: t('actions.anAdminRecordIsRequired') };
  const { data, error } = await guarded.supabase
    .from('admin_users')
    .update({ status: 'active', last_active_at: new Date().toISOString() })
    .eq('id', adminId).select('id').maybeSingle();
  if (error) return actionFailure('activate that admin', error);
  if (!data) return { ok: false, error: t('actions.adminRecordNotFound') };
  revalidatePath('/admin/admins');
  return { ok: true };
}

export async function revokeAdminAction(adminId: string): Promise<ActionResult> {
  const t = await getTranslations();
  const guarded = await guard();
  if (!('supabase' in guarded)) return guarded;
  if (!adminId.trim()) return { ok: false, error: t('actions.anAdminRecordIsRequired') };
  const { data, error } = await guarded.supabase.from('admin_users').delete()
    .eq('id', adminId).select('id').maybeSingle();
  if (error) return actionFailure('revoke that admin', error);
  if (!data) return { ok: false, error: t('actions.adminRecordNotFound') };
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

  const { error } = await guarded.supabase.from('admin_users').upsert(
    { email, full_name, admin_role, permissions, status: 'pending' },
    { onConflict: 'email' },
  );
  if (error) return actionFailure('invite that admin', error);
  revalidatePath('/admin/admins');
  return { ok: true };
}
