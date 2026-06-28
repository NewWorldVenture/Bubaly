'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext, effectivePlanLevel } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { tierForPlanLevel } from '@/lib/dashboard/registry';
import { validateLayout } from '@/lib/dashboard/layout';
import { canCustomizeDashboard, normalizeSettings, type DashSettings } from '@/lib/dashboard/permissions';

async function familyDashSettings(supabase: Awaited<ReturnType<typeof createServer>>, familyId: string): Promise<DashSettings> {
  const { data } = await supabase.from('family_dashboard_settings')
    .select('allow_child_customization, lock_to_family_default').eq('family_id', familyId).maybeSingle();
  return normalizeSettings(data ? { allowChildCustomization: data.allow_child_customization, lockToFamilyDefault: data.lock_to_family_default } : null);
}

type Result = { ok: boolean; error?: string };
type Device = 'all' | 'mobile' | 'tablet' | 'desktop';
const DEVICES: Device[] = ['all', 'mobile', 'tablet', 'desktop'];
function asDevice(value: string | undefined): Device {
  return (DEVICES as string[]).includes(value ?? '') ? (value as Device) : 'all';
}

async function userTier(supabase: Awaited<ReturnType<typeof createServer>>, familyId: string) {
  return tierForPlanLevel(await effectivePlanLevel(await resolveFamilyPlanLevel(supabase, familyId)));
}

async function logEvent(supabase: Awaited<ReturnType<typeof createServer>>, familyId: string, userId: string, action: string, featureKey?: string | null, metadata: Record<string, unknown> = {}) {
  await supabase.from('dashboard_layout_events').insert({ family_id: familyId, user_id: userId, action, feature_key: featureKey ?? null, metadata: metadata as never });
}

/**
 * Save the signed-in user's personal customizable dashboard layout. Server-side
 * validated (tier entitlement, dedupe, max count, no fixed/locked injection).
 */
export async function saveDashboardLayoutAction(input: { featureKeys: string[]; deviceContext?: string }): Promise<Result> {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const userId = ctx.user.id;
  const supabase = await createServer();

  const [tier, settings] = await Promise.all([userTier(supabase, familyId), familyDashSettings(supabase, familyId)]);
  if (!canCustomizeDashboard(isManager(ctx.active.role), settings)) {
    return { ok: false, error: settings.lockToFamilyDefault ? 'Your family uses a shared dashboard set by a parent.' : 'A parent has turned off dashboard customization for children.' };
  }
  const v = validateLayout(input.featureKeys, tier);
  if (!v.ok) return { ok: false, error: v.error };

  const device = asDevice(input.deviceContext);
  const { error } = await supabase.from('dashboard_layouts').upsert(
    { family_id: familyId, user_id: userId, scope: 'user', device_context: device, feature_keys: v.keys, is_active: true, created_by: userId, updated_by: userId, deleted_at: null },
    { onConflict: 'family_id,user_id,device_context' },
  );
  if (error) return { ok: false, error: error.message };

  await logEvent(supabase, familyId, userId, 'customized', null, { count: v.keys.length });
  revalidatePath('/dashboard');
  return { ok: true };
}

/** Reset the user's personal layout back to the tier default (removes the row). */
export async function resetDashboardLayoutAction(input: { deviceContext?: string } = {}): Promise<Result> {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const userId = ctx.user.id;
  const supabase = await createServer();
  const device = asDevice(input.deviceContext);

  const { error } = await supabase.from('dashboard_layouts')
    .delete().eq('family_id', familyId).eq('user_id', userId).eq('scope', 'user').eq('device_context', device);
  if (error) return { ok: false, error: error.message };

  await logEvent(supabase, familyId, userId, 'reset');
  revalidatePath('/dashboard');
  return { ok: true };
}

/**
 * Set the FAMILY-DEFAULT layout (parent/admin only). New members and anyone
 * without a personal layout inherit this.
 */
export async function saveFamilyDefaultLayoutAction(input: { featureKeys: string[]; deviceContext?: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can set the family default.' };
  const familyId = ctx.active.familyId;
  const userId = ctx.user.id;
  const supabase = await createServer();

  const tier = await userTier(supabase, familyId);
  const v = validateLayout(input.featureKeys, tier);
  if (!v.ok) return { ok: false, error: v.error };

  const device = asDevice(input.deviceContext);
  const { error } = await supabase.from('dashboard_layouts').upsert(
    { family_id: familyId, user_id: null, scope: 'family', device_context: device, feature_keys: v.keys, is_active: true, created_by: userId, updated_by: userId, deleted_at: null },
    { onConflict: 'family_id,device_context' },
  );
  if (error) return { ok: false, error: error.message };

  await logEvent(supabase, familyId, userId, 'family_default_set', null, { count: v.keys.length });
  revalidatePath('/dashboard');
  return { ok: true };
}

/** Lightweight analytics ping (locked feature click, upgrade CTA, etc.). */
export async function logDashboardEventAction(input: { action: string; featureKey?: string | null }): Promise<{ ok: boolean }> {
  try {
    const ctx = await requireUserContext();
    const supabase = await createServer();
    await logEvent(supabase, ctx.active.familyId, ctx.user.id, input.action, input.featureKey ?? null);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** Save the family dashboard settings (parent/admin only). */
export async function saveDashboardSettingsAction(input: { allowChildCustomization: boolean; lockToFamilyDefault: boolean }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can change dashboard settings.' };
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const { error } = await supabase.from('family_dashboard_settings').upsert(
    { family_id: familyId, allow_child_customization: !!input.allowChildCustomization, lock_to_family_default: !!input.lockToFamilyDefault, updated_by: ctx.user.id },
    { onConflict: 'family_id' },
  );
  if (error) return { ok: false, error: error.message };
  await logEvent(supabase, familyId, ctx.user.id, 'settings_changed', null, { ...input });
  revalidatePath('/dashboard');
  return { ok: true };
}

/** Reset ALL members' personal layouts to the default (parent/admin only). */
export async function resetAllLayoutsAction(): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can reset everyone’s dashboard.' };
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const { error } = await supabase.from('dashboard_layouts').delete().eq('family_id', familyId).eq('scope', 'user');
  if (error) return { ok: false, error: error.message };
  await logEvent(supabase, familyId, ctx.user.id, 'reset_all');
  revalidatePath('/dashboard');
  return { ok: true };
}
