'use server';

// Family App Store install lifecycle. Family-scoped via RLS — an install always
// carries the caller's family + acting member.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

type Result = { ok: true } | { ok: false; error: string };
const PATH = '/dashboard/app-store';

export async function installAppAction(appId: string): Promise<Result> {
  if (!appId) return { ok: false, error: 'Invalid app' };
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { error } = await sb.from('family_app_installs').upsert({
    family_id: ctx.active.familyId, app_id: appId, installed_by: ctx.active.member.id,
    enabled: true, created_by: ctx.user.id,
  }, { onConflict: 'family_id,app_id' });
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

export async function uninstallAppAction(appId: string): Promise<Result> {
  if (!appId) return { ok: false, error: 'Invalid app' };
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { error } = await sb.from('family_app_installs').delete()
    .eq('family_id', ctx.active.familyId).eq('app_id', appId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

export async function toggleAppAction(appId: string, enabled: boolean): Promise<Result> {
  if (!appId) return { ok: false, error: 'Invalid app' };
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { error } = await sb.from('family_app_installs').update({ enabled })
    .eq('family_id', ctx.active.familyId).eq('app_id', appId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}
