'use server';

import { revalidatePath } from 'next/cache';
import { createServer } from '@/lib/supabase/server';
import { isDashboardView, type DashboardView } from '@/lib/constants/dashboards';
import { profileUpdateSchema } from '@/lib/validation';
import { saveUserProfile } from '@/lib/server/profiles';

/** Updates the signed-in user's account profile (name + contact phone). Keeps
 *  their family_members display name in sync with the first name. */
export async function updateMyProfileAction(input: {
  firstName: string; lastName: string; phone: string;
}): Promise<{ ok: boolean; error?: string }> {
  const parsed = profileUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid details' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  const res = await saveUserProfile(auth.user.id, parsed.data);
  if (!res.ok) return res;

  revalidatePath('/dashboard', 'layout');
  return { ok: true };
}

/** Switches the user's active family (used by the family switcher). */
export async function setActiveFamilyAction(familyId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  // Verify membership before switching (defense in depth; RLS also guards reads).
  const { data: member } = await supabase
    .from('family_members')
    .select('id')
    .eq('family_id', familyId)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!member) return { ok: false, error: 'Not a member of that family' };

  await supabase
    .from('user_preferences')
    .upsert({ user_id: auth.user.id, active_family_id: familyId }, { onConflict: 'user_id' });

  revalidatePath('/dashboard', 'layout');
  return { ok: true };
}

/** Sets the user's default dashboard view (personal vs. family Command Center). */
export async function setDefaultDashboardAction(
  view: DashboardView,
): Promise<{ ok: boolean; error?: string }> {
  if (!isDashboardView(view)) return { ok: false, error: 'Invalid dashboard' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  const { error } = await supabase
    .from('user_preferences')
    .upsert({ user_id: auth.user.id, default_dashboard: view }, { onConflict: 'user_id' });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/dashboard', 'layout');
  return { ok: true };
}
