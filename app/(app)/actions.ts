'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { isDashboardView, type DashboardView } from '@/lib/constants/dashboards';
import { profileUpdateSchema } from '@/lib/validation';
import { saveUserProfile } from '@/lib/server/profiles';
import { describeActionError } from '@/lib/supabase/errors';

function actionFailure(operation: string, message: string, error: unknown): { ok: false; error: string } {
  console.error(`[account-action] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, message) };
}

/** Updates the signed-in user's account profile (name + contact phone). Keeps
 *  their family_members display name in sync with the first name. */
export async function updateMyProfileAction(input: {
  firstName: string; lastName: string; phone: string; avatarUrl?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations();
  const parsed = profileUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid details' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: t('actions.notSignedIn') };

  const res = await saveUserProfile(auth.user.id, parsed.data);
  if (!res.ok) return res;

  revalidatePath('/dashboard', 'layout');
  return { ok: true };
}

/** Switches the user's active family (used by the family switcher). */
export async function setActiveFamilyAction(familyId: string): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations();
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: t('actions.notSignedIn') };

  // Verify membership before switching (defense in depth; RLS also guards reads).
  const { data: member, error: memberError } = await supabase
    .from('family_members')
    .select('id')
    .eq('family_id', familyId)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (memberError) return actionFailure('verify family membership', t('App.couldNotVerifyFamilyMembership'), memberError);
  if (!member) return { ok: false, error: t('actions.notAMemberOfThat') };

  const { error } = await supabase
    .from('user_preferences')
    .upsert({ user_id: auth.user.id, active_family_id: familyId }, { onConflict: 'user_id' });
  if (error) return actionFailure('switch active family', t('App.couldNotSwitchActiveFamily'), error);

  revalidatePath('/dashboard', 'layout');
  return { ok: true };
}

/** Sets the user's default dashboard view (personal vs. family Command Center). */
export async function setDefaultDashboardAction(
  view: DashboardView,
): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations();
  if (!isDashboardView(view)) return { ok: false, error: t('actions.invalidDashboard') };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: t('actions.notSignedIn') };

  const { error } = await supabase
    .from('user_preferences')
    .upsert({ user_id: auth.user.id, default_dashboard: view }, { onConflict: 'user_id' });
  if (error) return actionFailure('set the default dashboard', t('App.couldNotSetTheDefaultDashboard'), error);

  revalidatePath('/dashboard', 'layout');
  return { ok: true };
}
