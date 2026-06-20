'use server';

import { revalidatePath } from 'next/cache';
import { createServiceClient } from '@/lib/supabase/server';
import { isSuperAdmin } from '@/lib/supabase/auth';

async function guard() {
  if (!(await isSuperAdmin())) throw new Error('Unauthorized');
  return createServiceClient();
}

export async function deactivateAdminAction(adminId: string) {
  const supabase = await guard();
  await supabase.from('admin_users').update({ status: 'inactive' }).eq('id', adminId);
  revalidatePath('/admin/admins');
}

export async function activateAdminAction(adminId: string) {
  const supabase = await guard();
  await supabase
    .from('admin_users')
    .update({ status: 'active', last_active_at: new Date().toISOString() })
    .eq('id', adminId);
  revalidatePath('/admin/admins');
}

export async function revokeAdminAction(adminId: string) {
  const supabase = await guard();
  await supabase.from('admin_users').delete().eq('id', adminId);
  revalidatePath('/admin/admins');
}

export async function inviteAdminAction(formData: FormData) {
  const supabase = await guard();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const full_name = String(formData.get('full_name') ?? '').trim() || null;
  const admin_role = String(formData.get('admin_role') ?? 'administrator');
  const permMap: Record<string, string[]> = {
    super_administrator: ['All Access'],
    administrator: ['User', 'Content', 'Reports', 'Billing'],
    content_manager: ['Content Management'],
    billing_manager: ['Billing', 'Payments', 'Reports'],
    moderator: ['Support', 'User Management'],
    viewer: ['Reports (View Only)'],
  };
  const permissions = permMap[admin_role] ?? [];

  if (!email) return;

  await supabase.from('admin_users').upsert(
    { email, full_name, admin_role, permissions, status: 'pending' },
    { onConflict: 'email' },
  );
  revalidatePath('/admin/admins');
}
