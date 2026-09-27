'use server';

// Family App Store install lifecycle. Family-scoped via RLS — an install always
// carries the caller's family + acting member.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { wroteNoRows } from '@/lib/supabase/errors';

type Result = { ok: true } | { ok: false; error: string };
const PATH = '/dashboard/app-store';

export async function installAppAction(appId: string): Promise<Result> {
  const t = await getTranslations();
  if (!appId) return { ok: false, error: t('actions.invalidApp') };
  const ctx = await requireUserContext();
  const sb = await createServer();
  // PostgREST returns affected rows only when asked, so without `.select()`
  // `data` is null whether one row was written or none was. `InstallButton`
  // holds its state in `useState(initial)`, which is read once at mount and
  // ignores the re-rendered server props that `revalidatePath` produces — so it
  // rolls back ONLY on `ok: false`. A silent no-op therefore leaves the button
  // permanently disagreeing with the database until a full page reload.
  // Audit C1-S9-33.
  const { data: installed, error } = await sb.from('family_app_installs').upsert({
    family_id: ctx.active.familyId, app_id: appId, installed_by: ctx.active.member.id,
    enabled: true, created_by: ctx.user.id,
  }, { onConflict: 'family_id,app_id' }).select('app_id');
  if (error) return { ok: false, error: error.message };
  if (wroteNoRows(installed)) return { ok: false, error: t('actions.couldNotInstallThatApp') };
  revalidatePath(PATH);
  return { ok: true };
}

export async function uninstallAppAction(appId: string): Promise<Result> {
  const t = await getTranslations();
  if (!appId) return { ok: false, error: t('actions.invalidApp') };
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { data: removed, error } = await sb.from('family_app_installs').delete()
    .eq('family_id', ctx.active.familyId).eq('app_id', appId).select('app_id');
  if (error) return { ok: false, error: error.message };
  if (wroteNoRows(removed)) return { ok: false, error: t('actions.couldNotRemoveThatApp') };
  revalidatePath(PATH);
  return { ok: true };
}

export async function toggleAppAction(appId: string, enabled: boolean): Promise<Result> {
  const t = await getTranslations();
  if (!appId) return { ok: false, error: t('actions.invalidApp') };
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { data: toggled, error } = await sb.from('family_app_installs').update({ enabled })
    .eq('family_id', ctx.active.familyId).eq('app_id', appId).select('app_id');
  if (error) return { ok: false, error: error.message };
  if (wroteNoRows(toggled)) return { ok: false, error: t('actions.couldNotUpdateThatApp') };
  revalidatePath(PATH);
  return { ok: true };
}
